'use strict';
// Serveur HTTP sans dépendance (Node >= 20.12). Sert le site et expose l'API.
//  GET  /api/status   -> état de la configuration (sans jamais exposer de clé)
//  POST /api/search   -> recherche directe de vraies annonces + analyse de marché (sans IA)
//  POST /api/agent    -> assistant IA (appelle le modèle, qui lance de vraies recherches)
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const zlib = require('node:zlib');

const { load, isLoopback } = require('./config');
const { createProvider, ProviderError } = require('./providers');
const { rank } = require('./analysis');
const { runAgent } = require('./agent');
const { createJobs } = require('./jobs');
const { createScanner } = require('./scanner');
const { AgentError } = require('./errors');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
};

const num = (v) => (v === '' || v === null || v === undefined || !Number.isFinite(Number(v)) ? null : Number(v));
const str = (v, max = 120) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null);

function sanitizeFilters(f = {}) {
  const size = str(f.size, 30);
  const category = str(f.category, 30);
  return {
    maxPrice: num(f.maxPrice),
    minProfit: num(f.minProfit),
    brand: str(f.brand, 60),
    size: size && size !== 'Toutes' ? size : null,
    category: category && category !== 'Toutes' ? category : null,
  };
}

function sanitizeFees(f = {}) {
  const out = {};
  for (const k of ['protectionFixed', 'protectionPct', 'inboundShipping', 'resaleFeePct', 'outboundShipping']) {
    const v = num(f[k]);
    if (v !== null && v >= 0 && v < 1000) out[k] = v;
  }
  return out;
}

function createApp(cfg, overrides = {}) {
  const provider = overrides.provider || createProvider(cfg);
  const hits = new Map();

  function limited(ip) {
    const now = Date.now();
    const arr = (hits.get(ip) || []).filter((t) => now - t < cfg.rateLimit.windowMs);
    arr.push(now);
    hits.set(ip, arr);
    return arr.length > cfg.rateLimit.max;
  }

  function send(res, status, body) {
    const data = JSON.stringify(body);
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    });
    res.end(data);
  }

  function readJson(req, limit = 64 * 1024) {
    return new Promise((resolve, reject) => {
      let size = 0;
      const chunks = [];
      req.on('data', (c) => {
        size += c.length;
        if (size > limit) { reject(Object.assign(new Error('Requête trop volumineuse'), { status: 413 })); req.destroy(); return; }
        chunks.push(c);
      });
      req.on('end', () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); }
        catch { reject(Object.assign(new Error('JSON invalide'), { status: 400 })); }
      });
      req.on('error', reject);
    });
  }

  function authorized(req) {
    if (!cfg.accessToken) return true;
    const given = String(req.headers['x-access-token'] || '');
    const a = Buffer.from(given);
    const b = Buffer.from(cfg.accessToken);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  }

  function status() {
    return {
      ai: { configured: Boolean(cfg.ai.apiKey), provider: cfg.ai.provider, model: cfg.ai.model, keyVar: cfg.ai.keyVar },
      listings: provider.status(),
      domain: cfg.provider.vintedDomain,
      protected: Boolean(cfg.accessToken),
      scan: { enabled: cfg.scan.intervalMinutes > 0, intervalMinutes: cfg.scan.intervalMinutes },
    };
  }

  const jobs = createJobs();
  const scanner = overrides.scanner || createScanner({ cfg, provider, callModel: overrides.callModel });

  // --- Traitements (utilisés en direct par /api/search et /api/agent, et en tâche de fond par /api/jobs) ---
  async function doSearch(body, report = () => {}) {
    const filters = sanitizeFilters(body.filters);
    const query = str(body.query, 120);
    report(`Recherche : ${[filters.brand, query].filter(Boolean).join(' ')}`);
    const r = await provider.search({ query, brand: filters.brand, maxPrice: filters.maxPrice, size: filters.size, category: filters.category });
    const ranked = rank(r.listings, r.pool, sanitizeFees(body.fees)).filter(
      (x) => filters.minProfit == null || (x.analysis.estimate && x.analysis.estimate.prudent.profit >= filters.minProfit)
    );
    return {
      provider: r.provider,
      fetchedAt: r.fetchedAt,
      cached: r.cached,
      totalFetched: r.totalFetched,
      rejected: r.rejected,
      results: ranked,
    };
  }

  async function doAgent(body, report = () => {}) {
    const message = str(body.message, 1000);
    if (!message) throw Object.assign(new Error('Message vide.'), { status: 400, code: 'EMPTY' });
    const history = Array.isArray(body.history)
      ? body.history
          .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
          .slice(-6)
          .map((m) => ({ role: m.role, content: m.content.slice(0, 1500) }))
      : [];
    return runAgent(
      { cfg, provider, callModel: overrides.callModel, onProgress: report },
      { message, filters: sanitizeFilters(body.filters), fees: sanitizeFees(body.fees), history }
    );
  }

  async function api(req, res, pathname) {
    if (pathname === '/api/status' && req.method === 'GET') return send(res, 200, status());

    // Lecture de l'état d'une tâche de fond : protégée par le jeton, non comptée dans la limite de débit
    // (le navigateur l'interroge toutes les secondes pendant une recherche).
    if (pathname === '/api/feed' && req.method === 'GET') {
      if (!authorized(req)) return send(res, 401, { error: 'UNAUTHORIZED', message: 'Jeton d’accès invalide.' });
      return send(res, 200, scanner.view());
    }

    const m = pathname.match(/^\/api\/jobs\/([0-9a-f-]{36})$/);
    if (m && req.method === 'GET') {
      if (!authorized(req)) return send(res, 401, { error: 'UNAUTHORIZED', message: 'Jeton d’accès invalide.' });
      const v = jobs.view(m[1]);
      if (!v) return send(res, 404, { error: 'JOB_NOT_FOUND', message: 'Recherche introuvable (le serveur a peut-être redémarré). Relance-la.' });
      return send(res, 200, v);
    }

    if (req.method !== 'POST') return send(res, 405, { error: 'METHOD', message: 'Méthode non autorisée.' });
    if (!authorized(req)) return send(res, 401, { error: 'UNAUTHORIZED', message: 'Jeton d’accès invalide.' });
    if (limited(req.socket.remoteAddress || 'x')) {
      return send(res, 429, { error: 'RATE_LIMIT', message: 'Trop de requêtes, réessaie dans une minute.' });
    }
    const body = await readJson(req);

    if (pathname === '/api/search') return send(res, 200, await doSearch(body));
    if (pathname === '/api/agent') return send(res, 200, await doAgent(body));

    if (pathname === '/api/scan') {
      if (scanner.view().scan.running) return send(res, 409, { error: 'SCAN_RUNNING', message: 'Un balayage est déjà en cours.' });
      scanner.runOnce().catch(() => {});
      return send(res, 202, { started: true });
    }

    if (pathname === '/api/jobs') {
      if (body.kind !== 'agent' && body.kind !== 'search') return send(res, 400, { error: 'BAD_KIND', message: 'Type de tâche inconnu.' });
      if (body.kind === 'agent' && !str(body.message, 1000)) return send(res, 400, { error: 'EMPTY', message: 'Message vide.' });
      const jobId = jobs.start((report) => (body.kind === 'agent' ? doAgent(body, report) : doSearch(body, report)));
      return send(res, 202, { jobId });
    }
    return send(res, 404, { error: 'NOT_FOUND', message: 'Route inconnue.' });
  }

  const gzCache = new Map(); // fichier -> { mtimeMs, buf }
  const COMPRESSIBLE = new Set(['.html', '.js', '.css', '.json', '.svg', '.webmanifest']);

  function serveStatic(req, res, pathname) {
    let rel;
    try { rel = pathname === '/' ? 'index.html' : decodeURIComponent(pathname).replace(/^\/+/, ''); }
    catch { res.writeHead(400); return res.end(); }
    const file = path.resolve(PUBLIC_DIR, rel);
    if (!file.startsWith(PUBLIC_DIR + path.sep) && file !== PUBLIC_DIR) { res.writeHead(403); return res.end('Interdit'); }
    fs.stat(file, (e1, st) => {
      if (e1 || !st.isFile()) { res.writeHead(404); return res.end('Introuvable'); }
      fs.readFile(file, (err, data) => {
        if (err) { res.writeHead(404); return res.end('Introuvable'); }
        const ext = path.extname(file);
        // Bibliothèques et icônes : cache long. Page, CSS et scripts de l'appli : toujours revalidés.
        const longCache = /^(vendor[\\/]|icon[-.]|apple-touch)/.test(rel);
        const headers = {
          'Content-Type': MIME[ext] || 'application/octet-stream',
          'Cache-Control': longCache ? 'public, max-age=86400' : 'no-cache',
          'X-Content-Type-Options': 'nosniff',
          'Referrer-Policy': 'no-referrer',
          'Vary': 'Accept-Encoding',
        };
        let body = data;
        if (COMPRESSIBLE.has(ext) && /\bgzip\b/.test(String(req.headers['accept-encoding'] || ''))) {
          let hit = gzCache.get(file);
          if (!hit || hit.mtimeMs !== st.mtimeMs) { hit = { mtimeMs: st.mtimeMs, buf: zlib.gzipSync(data) }; gzCache.set(file, hit); }
          body = hit.buf;
          headers['Content-Encoding'] = 'gzip';
        }
        headers['Content-Length'] = body.length;
        res.writeHead(200, headers);
        res.end(req.method === 'HEAD' ? undefined : body);
      });
    });
  }

  const server = http.createServer(async (req, res) => {
    try {
      const { pathname } = new URL(req.url, 'http://localhost');
      if (pathname.startsWith('/api/')) return await api(req, res, pathname);
      if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); return res.end(); }
      return serveStatic(req, res, pathname);
    } catch (e) {
      if (e instanceof ProviderError || e instanceof AgentError) {
        return send(res, e.status, { error: e.code, message: e.message });
      }
      if (e && e.status) return send(res, e.status, { error: 'BAD_REQUEST', message: e.message });
      console.error('[erreur]', e);
      return send(res, 500, { error: 'INTERNAL', message: 'Erreur interne du serveur.' });
    }
  });
  server.scanner = scanner;
  return server;
}

if (require.main === module) {
  const cfg = load();
  if (!isLoopback(cfg.host) && !cfg.accessToken) {
    console.error('\nRefus de démarrer : HOST=' + cfg.host + ' rend le site accessible sur ton réseau (téléphone),');
    console.error('mais APP_ACCESS_TOKEN est vide. Sans jeton, n\'importe qui sur le Wi-Fi pourrait consommer ton quota IA.');
    console.error('Ajoute dans .env une ligne du type  APP_ACCESS_TOKEN=un-mot-de-passe-long  puis relance.\n');
    process.exit(1);
  }
  const app = createApp(cfg);
  app.scanner.start();
  app.listen(cfg.port, cfg.host, () => {
    const p = createProvider(cfg).status();
    console.log(`VintedPro sur http://${cfg.host === '0.0.0.0' ? 'localhost' : cfg.host}:${cfg.port}`);
    if (!isLoopback(cfg.host)) {
      const lan = Object.values(require('node:os').networkInterfaces()).flat()
        .filter((n) => n && n.family === 'IPv4' && !n.internal).map((n) => `http://${n.address}:${cfg.port}`);
      if (lan.length) console.log(`  Téléphone (même Wi-Fi) : ${lan.join('  ou  ')}`);
      console.log('  Sur le téléphone, saisis ton jeton dans Paramètres au premier lancement.');
    }
    console.log(`  IA        : ${cfg.ai.apiKey ? `configurée (${cfg.ai.provider} · ${cfg.ai.model})` : `NON configurée (${cfg.ai.keyVar})`}`);
    console.log(`  Balayage  : ${cfg.scan.intervalMinutes > 0 ? `automatique toutes les ${cfg.scan.intervalMinutes} min (${cfg.scan.batch} recherches parmi ${cfg.scan.queries.length} marques)` : 'désactivé (SCAN_INTERVAL_MINUTES=0)'}`);
    console.log(`  Annonces  : ${p.configured ? `source « ${p.name} »` : `NON configurées (manque : ${p.missing.join(', ')})`}`);
  });
}

module.exports = { createApp, sanitizeFilters, sanitizeFees };
