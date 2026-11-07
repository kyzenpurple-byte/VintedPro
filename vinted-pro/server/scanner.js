'use strict';
// Détecteur autonome de pépites. Toutes les N minutes, le serveur (sans que personne ne lui demande rien) :
//  1. interroge la source d'annonces configurée pour quelques marques de la liste de surveillance ;
//  2. analyse le marché avec les annonces réellement récupérées (analysis.js) ;
//  3. garde celles qui dépassent les seuils de bénéfice et de score ;
//  4. demande (si une clé IA existe) un avis à l'IA, qui ne peut citer que des annonces de la liste ;
//  5. re-contrôle les annonces déjà détectées : non revues -> signalées « à vérifier », puis retirées.
// Rien n'est simulé : sans source configurée, le balayage ne fait rien et le dit.
const fs = require('node:fs');
const path = require('node:path');
const { rank } = require('./analysis');
const { defaultCallModel } = require('./agent');

const REVIEW_SYSTEM = `Tu es un revendeur Vinted expérimenté. On te donne des annonces RÉELLES déjà analysées par du code (prix observé, médiane des annonces comparables en ligne, bénéfice prudent estimé, indice de demande).
Pour chaque annonce, rends un avis court en français. Règles strictes :
- Utilise uniquement les chiffres fournis. N'invente aucun prix, aucune vente, aucune tendance de marché que tu ne vois pas dans les données.
- Les prix de revente sont des estimations issues d'annonces en ligne, pas des ventes conclues : ne les présente jamais comme une certitude.
- verdict : "a_saisir" (écart de prix net, demande correcte, données fiables), "a_surveiller" (intéressant mais incertain), "a_eviter" (risque, peu de données, faible demande).
- risks : ce que l'acheteur doit vérifier (authenticité, état, taille, nombre de comparables faible...).
Réponds UNIQUEMENT par un tableau JSON : [{"id":"...","verdict":"...","rationale":"1 à 2 phrases","risks":"1 phrase"}]`;

const eur = (n) => `${(Math.round(n * 100) / 100).toFixed(2).replace('.', ',')} €`;

function explain(l, a) {
  const e = a.estimate;
  const parts = [`Annoncé ${eur(l.price)} pour une médiane de ${eur(a.market.median)} sur ${a.market.n} annonces comparables en ligne (${e.discountPct} % sous ce prix).`];
  parts.push(`Bénéfice prudent estimé ${eur(e.prudent.profit)} (frais de protection inclus).`);
  if (a.demand && a.demand.level !== 'inconnue') parts.push(`Intérêt ${a.demand.level} (${a.demand.basis}).`);
  else parts.push('Demande non mesurable : la source ne fournit pas les favoris.');
  return parts.join(' ');
}

function createScanner({ cfg, provider, callModel, now = Date.now }) {
  const sc = cfg.scan;
  const file = path.join(sc.dataDir, 'feed.json');
  const items = new Map();
  const scan = { running: false, lastRunAt: null, lastError: null, cursor: 0, runs: 0, lastStats: null };
  let timer = null;

  function load() {
    try {
      const j = JSON.parse(fs.readFileSync(file, 'utf8'));
      for (const it of j.items || []) if (it && it.listing && it.listing.id) items.set(it.listing.id, it);
      Object.assign(scan, { lastRunAt: j.scan?.lastRunAt || null, cursor: j.scan?.cursor || 0, runs: j.scan?.runs || 0, lastStats: j.scan?.lastStats || null });
    } catch (_) { /* premier démarrage ou fichier illisible : on repart d'une liste vide */ }
  }

  function save() {
    try {
      fs.mkdirSync(sc.dataDir, { recursive: true });
      const tmp = file + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify({ items: [...items.values()], scan: { lastRunAt: scan.lastRunAt, cursor: scan.cursor, runs: scan.runs, lastStats: scan.lastStats } }));
      fs.renameSync(tmp, file);
    } catch (e) { console.error('[balayage] sauvegarde impossible :', e.message); }
  }

  async function review(fresh) {
    const hasAi = callModel || cfg.ai.apiKey;
    if (!sc.aiReview || !hasAi || !fresh.length) return 'ignoré';
    const batch = fresh.slice(0, 10);
    const payload = batch.map((it) => ({
      id: it.listing.id, titre: it.listing.title, marque: it.listing.brand, taille: it.listing.size, etat: it.listing.condition,
      prix_observe_eur: it.listing.price, mediane_comparables_eur: it.analysis.market.median, nb_comparables: it.analysis.market.n,
      benefice_prudent_estime_eur: it.analysis.estimate.prudent.profit, ecart_prix_pct: it.analysis.estimate.discountPct,
      demande: it.analysis.demand.level, favoris: it.listing.favourites,
    }));
    try {
      const resp = await (callModel || ((b) => defaultCallModel(cfg, b)))({ system: REVIEW_SYSTEM, tools: [], messages: [{ role: 'user', content: JSON.stringify(payload) }] });
      const text = (resp.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
      const m = text.match(/\[[\s\S]*\]/);
      const arr = JSON.parse(m ? m[0] : text);
      const ids = new Set(batch.map((it) => it.listing.id));
      let n = 0;
      for (const r of Array.isArray(arr) ? arr : []) {
        if (!r || !ids.has(String(r.id)) || !['a_saisir', 'a_surveiller', 'a_eviter'].includes(r.verdict)) continue; // id inconnu : écarté
        items.get(String(r.id)).ai = { verdict: r.verdict, rationale: String(r.rationale || '').slice(0, 400), risks: String(r.risks || '').slice(0, 300) };
        n++;
      }
      return `${n} avis`;
    } catch (e) {
      return `avis IA indisponible (${e.code || e.message})`;
    }
  }

  async function runOnce() {
    if (scan.running) return { skipped: 'déjà en cours' };
    const st = provider.status();
    if (!st.configured) {
      scan.lastError = `Source d'annonces non configurée (manque : ${st.missing.join(', ')}). Aucun balayage possible.`;
      return { skipped: 'non configuré' };
    }
    scan.running = true; scan.lastError = null;
    const t = now();
    const stats = { queries: [], fetched: 0, added: 0, updated: 0, removed: 0, errors: [], review: '' };
    try {
      const qs = sc.queries;
      const n = Math.min(sc.batch, qs.length);
      const chosen = Array.from({ length: n }, (_, i) => qs[(scan.cursor + i) % qs.length]);
      scan.cursor = (scan.cursor + n) % Math.max(1, qs.length);
      const fresh = [];
      for (const q of chosen) {
        let r;
        try { r = await provider.search({ query: q, maxPrice: sc.maxPrice }); }
        catch (e) { stats.errors.push(`${q} : ${e.message}`); continue; }
        stats.queries.push(q); stats.fetched += r.listings.length;
        const returned = new Set(r.listings.map((l) => l.id));
        const ranked = rank(r.listings, r.pool, {});
        for (const x of ranked) {
          const a = x.analysis;
          const good = a.estimate && a.estimate.prudent.profit >= sc.minProfit && a.score >= sc.minScore
            && !(a.demand.level === 'faible' && a.market.n >= 6);
          const old = items.get(x.listing.id);
          if (old) { Object.assign(old, { listing: x.listing, analysis: a, explanation: a.estimate ? explain(x.listing, a) : old.explanation, lastSeen: t, misses: 0, status: 'active' }); stats.updated++; continue; }
          if (!good) continue;
          const it = { listing: x.listing, analysis: a, ai: null, explanation: explain(x.listing, a), query: q, firstSeen: t, lastSeen: t, misses: 0, status: 'active' };
          items.set(x.listing.id, it); fresh.push(it); stats.added++;
        }
        // annonces déjà détectées via cette recherche et absentes cette fois : à vérifier, puis retirées
        for (const it of items.values()) {
          if (it.query === q && !returned.has(it.listing.id) && it.lastSeen !== t) {
            it.misses = (it.misses || 0) + 1;
            if (it.misses >= 1) it.status = 'unverified';
          }
        }
      }
      for (const [id, it] of items) {
        if ((it.misses || 0) >= 4 || t - it.lastSeen > 72 * 3600 * 1000) { items.delete(id); stats.removed++; }
      }
      if (items.size > 150) {
        [...items.values()].sort((a, b) => (a.analysis.score ?? 0) - (b.analysis.score ?? 0)).slice(0, items.size - 150).forEach((it) => items.delete(it.listing.id));
      }
      stats.review = await review(fresh);
      scan.lastRunAt = t; scan.runs++; scan.lastStats = stats;
      if (!stats.queries.length && stats.errors.length) scan.lastError = stats.errors[0];
      save();
      return stats;
    } catch (e) {
      scan.lastError = e.message || 'Erreur inattendue';
      return { error: scan.lastError };
    } finally {
      scan.running = false;
    }
  }

  function view() {
    const order = { active: 0, unverified: 1 };
    const list = [...items.values()].sort((a, b) => (order[a.status] - order[b.status]) || ((b.analysis.score ?? 0) - (a.analysis.score ?? 0)));
    return {
      items: list,
      scan: {
        enabled: sc.intervalMinutes > 0,
        intervalMinutes: sc.intervalMinutes,
        running: scan.running,
        lastRunAt: scan.lastRunAt,
        nextRunAt: sc.intervalMinutes > 0 && scan.lastRunAt ? scan.lastRunAt + sc.intervalMinutes * 60000 : null,
        lastError: scan.lastError,
        lastStats: scan.lastStats,
        watchlist: sc.queries,
        thresholds: { minProfit: sc.minProfit, minScore: sc.minScore },
        sourceConfigured: provider.status().configured,
      },
    };
  }

  function start() {
    load();
    if (sc.intervalMinutes <= 0) return;
    const every = sc.intervalMinutes * 60000;
    timer = setInterval(() => runOnce().catch(() => {}), every);
    timer.unref();
    const due = !scan.lastRunAt || now() - scan.lastRunAt >= every;
    if (due) setTimeout(() => runOnce().catch(() => {}), 5000).unref();
  }

  function stop() { if (timer) clearInterval(timer); }

  return { runOnce, view, start, stop, load, size: () => items.size };
}

module.exports = { createScanner };
