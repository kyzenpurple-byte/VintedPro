'use strict';
// Agent IA : Modèle via API OpenRouter qui comprend la demande, lance des recherches réelles
// via les outils ci-dessous, lit les analyses calculées par le serveur, puis classe et commente.
//
// Garde-fou central : le modèle ne produit JAMAIS d'annonce. Il renvoie des identifiants (listing_id)
// et du texte. Le serveur ne garde que les identifiants qui existent dans les résultats réellement
// récupérés, et affiche les données de l'annonce (prix, photo, lien) telles que reçues de la source.

const { evaluate, rank } = require('./analysis');
const { ProviderError } = require('./providers');
const { AgentError } = require('./errors');

const SYSTEM_PROMPT = `Tu es l'analyste d'un outil de revente Vinted. Tu aides à repérer des articles qui valent le coup d'être achetés pour être revendus avec bénéfice.

Règles non négociables :
- Tu ne connais aucune annonce par toi-même. Toute annonce, tout prix, toute taille viennent exclusivement des résultats de l'outil search_vinted. N'invente rien, ne complète rien de mémoire.
- Les prix des annonces sont des prix DEMANDÉS observés. Les prix de revente sont des ESTIMATIONS calculées à partir d'annonces comparables actives, jamais des ventes réalisées. Emploie toujours ces mots-là, sans les confondre.
- Les chiffres (marché, bénéfice, ROI, score) sont calculés par le serveur : reprends-les tels quels, ne les recalcule pas et n'en fabrique pas d'autres.
- Si une analyse indique « pas assez de comparables », dis-le et ne recommande pas l'article comme une affaire.
- Si la recherche ne renvoie rien ou échoue, dis-le simplement. Ne propose pas d'annonces de remplacement.
- Pour une demande large, lance plusieurs recherches ciblées (par modèle, par marque), pas une seule requête vague. Tu peux lancer plusieurs recherches en même temps.
- Pour une demande générale sans marque (« les meilleures affaires du moment »), lance 3 à 5 recherches sur des marques ou modèles qui se revendent bien (par exemple Nike, Adidas, Carhartt, Ralph Lauren, Levi's, The North Face, Patagonia, New Balance), puis compare.
- Si l'utilisateur veut un bénéfice minimum (« au moins 20 € de bénéfice »), passe-le dans min_profit : il s'agit du bénéfice prudent estimé.
- Respecte les contraintes de l'utilisateur (budget, taille, marque). Si tu dois en relâcher une, dis-le.

Quand tu as assez d'éléments, appelle present_results une seule fois : au plus 8 annonces, de la plus à la moins intéressante. Pour chacune, une justification concrète appuyée sur les chiffres fournis (écart avec la médiane, nombre de comparables, état, signaux de demande) et les risques réels (état, photos, authenticité, estimation fragile). Pas de formules creuses, pas de remplissage. Réponds en français.`;

// Transformation des schémas d'outils au format OpenAI / OpenRouter
const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'search_vinted',
      description:
        "Recherche de vraies annonces Vinted via la source de données configurée. Renvoie les annonces avec leur analyse de marché calculée (prix médian des comparables, bénéfice estimé prudent et central, score). À utiliser pour toute recherche d'articles.",
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Mots-clés (modèle, type de pièce). Ex : "dunk low", "polaire".' },
          brand: { type: 'string', description: 'Marque, si pertinente.' },
          max_price: { type: 'number', description: "Prix maximum de l'annonce en euros." },
          size: { type: 'string', description: 'Taille (S, M, L, 42...).' },
          min_profit: { type: 'number', description: 'Bénéfice prudent estimé minimum, en euros (ex. 20). N\'afficher que les annonces au moins aussi rentables.' },
          category: {
            type: 'string',
            enum: ['Toutes', 'Sneakers', 'Sweats', 'Vestes', 'T-shirts', 'Pantalons', 'Vintage', 'Accessoires'],
          },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'compare_listings',
      description: "Compare côte à côte des annonces déjà renvoyées par search_vinted (par listing_id) : prix demandés, coûts d'acquisition, estimations, score.",
      parameters: {
        type: 'object',
        properties: { listing_ids: { type: 'array', items: { type: 'string' }, minItems: 2, maxItems: 6 } },
        required: ['listing_ids'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'present_results',
      description:
        "Termine la mission : renvoie la sélection finale à l'utilisateur. N'utilise que des listing_id issus de search_vinted. Appel unique.",
      parameters: {
        type: 'object',
        properties: {
          summary: { type: 'string', description: 'Réponse courte à la demande (2 à 4 phrases), en français.' },
          picks: {
            type: 'array',
            maxItems: 8,
            items: {
              type: 'object',
              properties: {
                listing_id: { type: 'string' },
                verdict: { type: 'string', enum: ['a_saisir', 'a_surveiller', 'a_eviter'] },
                rationale: { type: 'string', description: 'Pourquoi cet article est (ou non) une bonne affaire, avec les chiffres fournis.' },
                risks: { type: 'string', description: 'Risques concrets à vérifier avant achat.' },
              },
              required: ['listing_id', 'verdict', 'rationale'],
            },
          },
        },
        required: ['summary', 'picks'],
      },
    },
  },
];

const compact = ({ listing: l, analysis: a }) => ({
  listing_id: l.id,
  title: l.title,
  brand: l.brand,
  asking_price_eur: l.price,
  size: l.size,
  condition: l.condition,
  favourites: l.favourites,
  seller_rating: l.seller && l.seller.rating,
  description_excerpt: l.description ? l.description.slice(0, 160) : null,
  acquisition_cost_eur: a.costs.acquisitionCost,
  market: a.market.n
    ? { comparables: a.market.n, p25: a.market.p25, median: a.market.median, p75: a.market.p75, basis: a.market.basis }
    : { comparables: 0 },
  estimate: a.estimate
    ? {
        prudent_resale_eur: a.estimate.prudent.resalePrice,
        prudent_profit_eur: a.estimate.prudent.profit,
        central_resale_eur: a.estimate.central.resalePrice,
        central_profit_eur: a.estimate.central.profit,
        discount_vs_median_pct: a.estimate.discountPct,
        confidence: a.confidence,
        kind: 'estimation',
      }
    : { unavailable: a.reason },
  score: a.score,
});

async function callOpenRouter(cfg, body) {
  const baseUrl = cfg.ai.baseUrl || 'https://openrouter.ai/api/v1';
  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'authorization': `Bearer ${cfg.ai.apiKey}`,
      'http-referer': cfg.ai.siteUrl || 'http://localhost',
      'x-title': cfg.ai.appName || 'VintedPro',
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(120000),
  });

  if (!res.ok) {
    const text = (await res.text().catch(() => '')).slice(0, 300);
    if (res.status === 401) throw new AgentError('AI_AUTH', 'Clé API OpenRouter refusée.', 502);
    if (res.status === 429) throw new AgentError('AI_RATE_LIMIT', 'Limite de requêtes atteinte sur OpenRouter, réessaie dans un instant.', 429);
    throw new AgentError('AI_FAILED', `L’API OpenRouter a répondu ${res.status} ${text}`, 502);
  }

  const data = await res.json();
  return data.choices[0].message;
}

function defaultCallModel(cfg, body) {
  return callOpenRouter(cfg, body);
}

function describeSearch(p) {
  const bits = [[p.brand, p.query].filter(Boolean).join(' ')];
  if (p.maxPrice != null) bits.push(`≤ ${p.maxPrice} €`);
  if (p.size) bits.push(`taille ${p.size}`);
  if (p.minProfit != null) bits.push(`bénéfice ≥ ${p.minProfit} €`);
  return bits.join(' · ');
}

async function runAgent(deps, req) {
  const { cfg, provider } = deps;
  const progress = typeof deps.onProgress === 'function' ? deps.onProgress : () => {};
  const callModel = deps.callModel || ((body) => defaultCallModel(cfg, body));
  if (!cfg.ai.apiKey && !deps.callModel) {
    throw new AgentError('AI_NOT_CONFIGURED', `${cfg.ai.keyVar || 'OPENROUTER_API_KEY'} n’est pas défini : l’assistant IA est indisponible.`, 503);
  }

  const filters = req.filters || {};
  const registry = new Map(); // id -> { listing, analysis }
  const searches = [];
  let final = null;

  const constraints = [];
  if (filters.maxPrice != null) constraints.push(`budget max ${filters.maxPrice} €`);
  if (filters.brand) constraints.push(`marque ${filters.brand}`);
  if (filters.size) constraints.push(`taille ${filters.size}`);
  if (filters.category && filters.category !== 'Toutes') constraints.push(`catégorie ${filters.category}`);
  if (filters.minProfit != null) constraints.push(`bénéfice prudent estimé minimum ${filters.minProfit} €`);
  const userText = constraints.length
    ? `${req.message}\n\n(Contraintes choisies dans l'interface : ${constraints.join(', ')}.)`
    : req.message;

  const messages = [
    { role: 'system', content: SYSTEM_PROMPT },
    ...(req.history || []).slice(-6),
    { role: 'user', content: userText }
  ];

  async function runTool(name, input) {
    if (name === 'search_vinted') {
      const maxPrice = [input.max_price, filters.maxPrice].filter((v) => typeof v === 'number');
      const minProfits = [input.min_profit, filters.minProfit].filter((v) => typeof v === 'number');
      const minProfit = minProfits.length ? Math.max(...minProfits) : null;
      const params = {
        query: input.query,
        brand: input.brand || filters.brand || null,
        size: input.size || filters.size || null,
        category: input.category || filters.category || null,
        maxPrice: maxPrice.length ? Math.min(...maxPrice) : null,
        minProfit,
      };
      progress(`Recherche : ${describeSearch(params)}`);
      try {
        const r = await provider.search(params);
        const ranked = rank(r.listings, r.pool, req.fees).filter((x) =>
          minProfit == null || (x.analysis.estimate && x.analysis.estimate.prudent.profit >= minProfit)
        );
        progress(`${describeSearch(params)} : ${r.listings.length} annonce(s), ${ranked.length} retenue(s)`);
        ranked.forEach((x) => registry.set(x.listing.id, x));
        searches.push({ params, found: r.listings.length, kept: ranked.length, cached: r.cached });
        return {
          found: r.listings.length,
          returned: Math.min(ranked.length, 15),
          note: ranked.length ? undefined : 'Aucune annonce réelle ne correspond. Ne propose rien d’autre.',
          listings: ranked.slice(0, 15).map(compact),
        };
      } catch (e) {
        if (e instanceof ProviderError) {
          searches.push({ params, error: e.code });
          progress(`${describeSearch(params)} : ${e.message}`);
          return { error: e.code, message: e.message };
        }
        throw e;
      }
    }
    if (name === 'compare_listings') {
      const rows = (input.listing_ids || []).map((id) => registry.get(String(id))).filter(Boolean);
      if (rows.length < 2) return { error: 'Il faut au moins deux listing_id issus de search_vinted.' };
      return { listings: rows.map(compact) };
    }
    return { error: `Outil inconnu : ${name}` };
  }

  progress('Analyse de ta demande');
  for (let step = 0; step < (cfg.ai.maxSteps || 10); step++) {
    const modelChoice = cfg.ai.model || 'meta-llama/llama-3.3-70b-instruct:free';
    const assistantMessage = await callModel({
      model: modelChoice,
      temperature: 0.2,
      tools: TOOLS,
      messages,
    });

    messages.push(assistantMessage);

    const toolCalls = assistantMessage.tool_calls || [];
    if (!toolCalls.length) {
      return finish({ summary: assistantMessage.content || '', picks: [] });
    }

    const presentingCall = toolCalls.find((tc) => tc.function.name === 'present_results');
    if (presentingCall) {
      try {
        final = JSON.parse(presentingCall.function.arguments);
      } catch (e) {
        final = null;
      }
      progress('Rédaction de la sélection');
    }

    // Exécution des outils en parallèle
    const toolResults = await Promise.all(
      toolCalls.map(async (tc) => {
        if (tc.function.name === 'present_results') {
          return {
            role: 'tool',
            tool_call_id: tc.id,
            content: JSON.stringify({ status: 'ok' }),
          };
        }

        let input = {};
        try {
          input = JSON.parse(tc.function.arguments || '{}');
        } catch (e) {}

        let out;
        try {
          out = await runTool(tc.function.name, input);
        } catch (e) {
          out = { error: 'internal', message: e.message };
        }

        return {
          role: 'tool',
          tool_call_id: tc.id,
          content: JSON.stringify(out),
        };
      })
    );

    if (final) return finish(final);
    messages.push(...toolResults);
  }

  return finish({ summary: 'La recherche a été interrompue avant de produire une sélection.', picks: [] });

  function finish(f) {
    const seen = new Set();
    const picks = [];
    let dropped = 0;
    for (const p of f.picks || []) {
      const row = registry.get(String(p.listing_id));
      if (!row || seen.has(row.listing.id)) { dropped++; continue; }
      seen.add(row.listing.id);
      picks.push({
        listing: row.listing,
        analysis: row.analysis,
        ai: { verdict: p.verdict, rationale: p.rationale, risks: p.risks || null },
      });
    }
    return { summary: f.summary || '', picks, searches, dropped, model: cfg.ai.model || 'openrouter' };
  }
}

module.exports = { defaultCallModel, runAgent, AgentError, TOOLS, SYSTEM_PROMPT, evaluate };
