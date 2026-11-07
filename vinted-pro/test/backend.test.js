'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeListing, normalizeMany } = require('../server/providers/normalize');
const { evaluate, rank } = require('../server/analysis');
const { fill } = require('../server/providers/apify');
const { applyFilters, ProviderError } = require('../server/providers');
const { runAgent } = require('../server/agent');
const { createApp } = require('../server/server');
const { load } = require('../server/config');

// Annonces de test : fabriquées ICI, uniquement pour vérifier le code. Elles n'existent pas dans l'application.
const raw = (i, price, extra = {}) => ({
  id: 1000 + i,
  title: `Nike Dunk Low Panda ${i}`,
  brand_title: 'Nike',
  price: { amount: String(price), currency_code: 'EUR' },
  size_title: '42',
  status: 'Très bon état',
  url: `https://www.vinted.fr/items/${1000 + i}-nike-dunk`,
  photo: { url: `https://images1.vinted.net/t/${i}.jpg` },
  ...extra,
});
const pool = [raw(1, 40), raw(2, 70), raw(3, 75), raw(4, 80), raw(5, 85), raw(6, 90)];

test('normalize : rejette les annonces sans lien Vinted, sans prix ou sans titre', () => {
  assert.equal(normalizeListing({ ...raw(1, 40), url: 'https://example.com/x' }, 't'), null);
  assert.equal(normalizeListing({ ...raw(1, 40), url: undefined }, 't'), null);
  assert.equal(normalizeListing({ ...raw(1, 0) }, 't'), null);
  assert.equal(normalizeListing({ ...raw(1, 40), price: undefined }, 't'), null);
  assert.equal(normalizeListing({ ...raw(1, 40), title: '' }, 't'), null);
  assert.equal(normalizeListing(null, 't'), null);
});

test('normalize : conserve les valeurs réelles et laisse null ce qui manque', () => {
  const n = normalizeListing(raw(1, 40), 'apify');
  assert.equal(n.price, 40);
  assert.equal(n.brand, 'Nike');
  assert.equal(n.url, 'https://www.vinted.fr/items/1001-nike-dunk');
  assert.deepEqual(n.photos, ['https://images1.vinted.net/t/1.jpg']);
  assert.equal(n.favourites, null);
  assert.equal(n.views, null);
});

test('normalize : refuse les photos non https et déduplique', () => {
  const n = normalizeListing({ ...raw(1, 40), photo: { url: 'http://x/y.jpg' } }, 't');
  assert.deepEqual(n.photos, []);
  const { listings, rejected } = normalizeMany([raw(1, 40), raw(1, 40), { junk: true }], 't');
  assert.equal(listings.length, 1);
  assert.equal(rejected, 1);
});

test('analysis : pas d’estimation sans assez de comparables', () => {
  const l = normalizeListing(raw(1, 40), 't');
  const few = normalizeMany([raw(1, 40), raw(2, 70)], 't').listings;
  const a = evaluate(l, few);
  assert.equal(a.estimate, null);
  assert.equal(a.score, null);
  assert.match(a.reason, /Pas assez/);
});

test('analysis : calcule médiane, coûts et bénéfice à partir des comparables observés', () => {
  const { listings } = normalizeMany(pool, 't');
  const target = listings[0]; // 40 €
  const a = evaluate(target, listings);
  assert.equal(a.market.n, 5);
  assert.equal(a.market.median, 80);
  assert.equal(a.costs.buyerProtection, 2.7); // 0,70 + 5 % de 40
  assert.equal(a.costs.acquisitionCost, 42.7);
  assert.equal(a.estimate.central.profit, 37.3); // 80 - 42,70
  assert.equal(a.estimate.prudent.resalePrice, 75); // p25
  assert.equal(a.estimate.discountPct, 50);
  assert.ok(a.score > 50);
  assert.match(a.market.basis, /pas des ventes conclues/);
});

test('analysis : les frais personnalisés sont pris en compte', () => {
  const { listings } = normalizeMany(pool, 't');
  const a = evaluate(listings[0], listings, { resaleFeePct: 10, outboundShipping: 3 });
  assert.equal(a.estimate.central.netResale, 69); // 80 - 8 - 3
});

test('analysis : classe par score décroissant, sans estimation en dernier', () => {
  const { listings } = normalizeMany(pool, 't');
  const r = rank(listings, listings);
  assert.equal(r[0].listing.price, 40);
  for (let i = 1; i < r.length; i++) assert.ok((r[i - 1].analysis.score ?? -1) >= (r[i].analysis.score ?? -1));
});

test('filtres : budget, marque, taille, catégorie sur les annonces réelles', () => {
  const { listings } = normalizeMany(pool, 't');
  assert.equal(applyFilters(listings, { maxPrice: 75 }).length, 3);
  assert.equal(applyFilters(listings, { brand: 'adidas' }).length, 0);
  assert.equal(applyFilters(listings, { size: '42' }).length, 6);
  assert.equal(applyFilters(listings, { size: '38' }).length, 0);
  const sized = [{ ...listings[0], size: 'XL' }, { ...listings[1], size: 'L' }, { ...listings[2], size: 'M / 38 / 10' }];
  assert.equal(applyFilters(sized, { size: 'L' }).length, 1); // pas de faux positif sur XL
  assert.equal(applyFilters(sized, { size: 'm' }).length, 1);
  assert.equal(applyFilters(sized, { size: '38' }).length, 1);
  assert.equal(applyFilters(listings, { category: 'Sneakers' }).length, 6);
  assert.equal(applyFilters(listings, { category: 'Vestes' }).length, 0);
});

test('apify : le gabarit d’entrée est rempli en JSON valide', () => {
  const out = fill('{"search":{{query}},"maxPrice":{{maxPrice}},"n":{{limit}}}', { query: 'dunk "low"', maxPrice: 50, limit: 20 });
  assert.deepEqual(JSON.parse(out), { search: 'dunk "low"', maxPrice: 50, n: 20 });
  const none = fill('{"p":{{maxPrice}}}', { maxPrice: null });
  assert.deepEqual(JSON.parse(none), { p: null });
});

// ---------- Agent avec un faux modèle (script de réponses) ----------
function fakeProvider(listings) {
  return {
    status: () => ({ name: 'fake', configured: true, missing: [] }),
    search: async () => ({ provider: 'fake', listings, pool: listings, cached: false, totalFetched: listings.length, rejected: 0, fetchedAt: 'now' }),
  };
}
const cfg = load({ ANTHROPIC_API_KEY: 'test' });

test('agent : boucle outil -> résultats, et ne garde que des annonces réellement récupérées', async () => {
  const { listings } = normalizeMany(pool, 't');
  const script = [
    { content: [{ type: 'tool_use', id: 'a', name: 'search_vinted', input: { query: 'dunk' } }] },
    {
      content: [{
        type: 'tool_use', id: 'b', name: 'present_results',
        input: {
          summary: 'ok',
          picks: [
            { listing_id: '1001', verdict: 'a_saisir', rationale: 'bon prix' },
            { listing_id: '999999', verdict: 'a_saisir', rationale: 'annonce inventée par le modèle' },
          ],
        },
      }],
    },
  ];
  let calls = 0;
  const seen = [];
  const out = await runAgent(
    { cfg, provider: fakeProvider(listings), callModel: async (body) => { seen.push(JSON.parse(JSON.stringify(body.messages))); return script[calls++]; } },
    { message: 'trouve des dunk', filters: {}, fees: {} }
  );
  assert.equal(out.picks.length, 1);
  assert.equal(out.picks[0].listing.id, '1001');
  assert.equal(out.picks[0].listing.url, 'https://www.vinted.fr/items/1001-nike-dunk');
  assert.equal(out.dropped, 1);
  // le résultat d'outil renvoyé au modèle contient bien les vraies données et marque l'estimation comme telle
  const toolResult = JSON.parse(seen[1][seen[1].length - 1].content[0].content);
  assert.equal(toolResult.listings[0].estimate.kind, 'estimation');
});

test('agent : aucun résultat -> aucune annonce, jamais de remplissage', async () => {
  const script = [
    { content: [{ type: 'tool_use', id: 'a', name: 'search_vinted', input: { query: 'xyz' } }] },
    { content: [{ type: 'tool_use', id: 'b', name: 'present_results', input: { summary: 'Rien trouvé', picks: [{ listing_id: '5', verdict: 'a_saisir', rationale: 'x' }] } }] },
  ];
  let i = 0;
  const out = await runAgent({ cfg, provider: fakeProvider([]), callModel: async () => script[i++] }, { message: 'xyz', filters: {}, fees: {} });
  assert.equal(out.picks.length, 0);
});

test('agent : erreur de la source relayée au modèle sans casser la boucle', async () => {
  const provider = { status: () => ({}), search: async () => { throw new ProviderError('PROVIDER_NOT_CONFIGURED', 'non configuré', 503); } };
  const script = [
    { content: [{ type: 'tool_use', id: 'a', name: 'search_vinted', input: { query: 'x' } }] },
    { content: [{ type: 'text', text: 'Source indisponible.' }] },
  ];
  let i = 0;
  const bodies = [];
  const out = await runAgent({ cfg, provider, callModel: async (b) => { bodies.push(JSON.stringify(b.messages)); return script[i++]; } }, { message: 'x', filters: {}, fees: {} });
  assert.equal(out.picks.length, 0);
  assert.match(bodies[1], /PROVIDER_NOT_CONFIGURED/);
});

test('agent : sans clé API, erreur explicite', async () => {
  await assert.rejects(
    runAgent({ cfg: load({}), provider: fakeProvider([]) }, { message: 'x', filters: {}, fees: {} }),
    (e) => e.code === 'AI_NOT_CONFIGURED'
  );
});

test('agent : le budget de l’interface plafonne la recherche demandée par le modèle', async () => {
  let got;
  const provider = { status: () => ({}), search: async (p) => { got = p; return { listings: [], pool: [], cached: false }; } };
  const script = [
    { content: [{ type: 'tool_use', id: 'a', name: 'search_vinted', input: { query: 'x', max_price: 500 } }] },
    { content: [{ type: 'text', text: 'fin' }] },
  ];
  let i = 0;
  await runAgent({ cfg, provider, callModel: async () => script[i++] }, { message: 'x', filters: { maxPrice: 50 }, fees: {} });
  assert.equal(got.maxPrice, 50);
});

// ---------- Serveur HTTP ----------
async function withServer(app, fn) {
  await new Promise((r) => app.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${app.address().port}`;
  try { await fn(base); } finally { await new Promise((r) => app.close(r)); }
}
const post = (base, p, body, headers = {}) =>
  fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });

test('http : /api/status n’expose aucune clé', async () => {
  const app = createApp(load({ ANTHROPIC_API_KEY: 'sk-secret', VINTED_PROVIDER: 'apify', APIFY_TOKEN: 'tok-secret' }));
  await withServer(app, async (base) => {
    const txt = await (await fetch(base + '/api/status')).text();
    assert.ok(!txt.includes('sk-secret') && !txt.includes('tok-secret'));
    const j = JSON.parse(txt);
    assert.equal(j.ai.configured, true);
    assert.equal(j.listings.configured, false);
  });
});

test('http : /api/search sans source configurée -> 503 explicite, pas de données de remplacement', async () => {
  const app = createApp(load({}));
  await withServer(app, async (base) => {
    const r = await post(base, '/api/search', { query: 'dunk' });
    assert.equal(r.status, 503);
    const j = await r.json();
    assert.equal(j.error, 'PROVIDER_NOT_CONFIGURED');
    assert.equal(j.results, undefined);
  });
});

test('http : /api/search renvoie les annonces classées et filtrées', async () => {
  const { listings } = normalizeMany(pool, 't');
  const app = createApp(load({}), { provider: fakeProvider(listings) });
  await withServer(app, async (base) => {
    const j = await (await post(base, '/api/search', { query: 'dunk', filters: { maxPrice: 80, minProfit: 10 } })).json();
    assert.ok(j.results.length >= 1);
    assert.ok(j.results.every((x) => x.listing.price <= 80 && x.analysis.estimate.prudent.profit >= 10));
    assert.equal(j.results[0].listing.url.startsWith('https://www.vinted.fr/items/'), true);
  });
});

test('http : jeton d’accès, JSON invalide, traversée de chemin, limite de débit', async () => {
  const app = createApp(load({ APP_ACCESS_TOKEN: 'abc', RATE_LIMIT_PER_MINUTE: '2' }));
  await withServer(app, async (base) => {
    assert.equal((await post(base, '/api/search', { query: 'x' })).status, 401);
    const h = { 'x-access-token': 'abc' };
    const bad = await fetch(base + '/api/search', { method: 'POST', headers: { 'content-type': 'application/json', ...h }, body: '{oops' });
    assert.equal(bad.status, 400);
    const trav = await fetch(base + '/..%2f..%2fetc%2fpasswd');
    assert.ok([403, 404].includes(trav.status));
    await post(base, '/api/search', { query: 'x' }, h);
    assert.equal((await post(base, '/api/search', { query: 'x' }, h)).status, 429);
  });
});

test('cache : les filtres sont réappliqués à chaque appel (pas de résultats périmés)', async () => {
  const { createProvider } = require('../server/providers');
  const items = [
    { ...pool[0], size_title: 'L' }, { ...pool[1], size_title: 'XL' }, { ...pool[2], size_title: 'L' },
  ];
  let fetches = 0;
  const realFetch = global.fetch;
  global.fetch = async () => { fetches++; return { ok: true, json: async () => items }; };
  try {
    const p = createProvider(load({ VINTED_PROVIDER: 'generic', GENERIC_PROVIDER_URL: 'http://x/?q={query}' }));
    const a = await p.search({ query: 'dunk', size: 'L' });
    const b = await p.search({ query: 'dunk', size: 'XL' });
    const c = await p.search({ query: 'dunk' });
    assert.equal(fetches, 1, 'une seule récupération, ensuite le cache');
    assert.deepEqual([a.listings.length, b.listings.length, c.listings.length], [2, 1, 3]);
    assert.equal(b.cached, true);
  } finally { global.fetch = realFetch; }
});

// ---------- Gemini ----------
const http = require('node:http');
const { toGeminiRequest, toGeminiContents, fromGeminiResponse, callGemini } = require('../server/gemini');

function geminiStub(handler) {
  return new Promise((resolve) => {
    const calls = [];
    const srv = http.createServer((req, res) => {
      let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => {
        const rec = { url: req.url, key: req.headers['x-goog-api-key'], body: JSON.parse(b) };
        calls.push(rec);
        const out = handler(rec, calls.length);
        res.writeHead(out.status || 200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(out.json));
      });
    });
    srv.listen(0, '127.0.0.1', () => resolve({ srv, calls, base: `http://127.0.0.1:${srv.address().port}` }));
  });
}
const gcfg = (base, extra = {}) => load({ GEMINI_API_KEY: 'g-key', GEMINI_BASE_URL: base, GEMINI_MODEL: 'test-model', ...extra });

test('config : Gemini choisi automatiquement avec GEMINI_API_KEY, Anthropic en alternative', () => {
  assert.equal(load({ GEMINI_API_KEY: 'a' }).ai.provider, 'gemini');
  assert.equal(load({ ANTHROPIC_API_KEY: 'a' }).ai.provider, 'anthropic');
  assert.equal(load({ GEMINI_API_KEY: 'a', ANTHROPIC_API_KEY: 'b' }).ai.provider, 'gemini');
  assert.equal(load({ GEMINI_API_KEY: 'a', ANTHROPIC_API_KEY: 'b', AI_PROVIDER: 'anthropic' }).ai.apiKey, 'b');
  assert.equal(load({}).ai.keyVar, 'GEMINI_API_KEY');
});

test('gemini : requête au bon format (schéma en majuscules, instruction système, outils)', () => {
  const { TOOLS, SYSTEM_PROMPT } = require('../server/agent');
  const r = toGeminiRequest({ system: SYSTEM_PROMPT, tools: TOOLS, messages: [{ role: 'user', content: 'salut' }] });
  assert.equal(r.systemInstruction.parts[0].text, SYSTEM_PROMPT);
  assert.deepEqual(r.contents, [{ role: 'user', parts: [{ text: 'salut' }] }]);
  const decl = r.tools[0].functionDeclarations;
  assert.deepEqual(decl.map((d) => d.name), ['search_vinted', 'compare_listings', 'present_results']);
  assert.equal(decl[0].parameters.type, 'OBJECT');
  assert.equal(decl[0].parameters.properties.max_price.type, 'NUMBER');
  assert.equal(decl[2].parameters.properties.picks.items.type, 'OBJECT');
  assert.ok(!JSON.stringify(r).includes('input_schema'));
});

test('gemini : les parts d’origine (signature de réflexion, id d’appel) sont renvoyées telles quelles', () => {
  const resp = fromGeminiResponse({ candidates: [{ content: { parts: [
    { thought: true, text: 'résumé de réflexion' },
    { functionCall: { id: 'fc1', name: 'search_vinted', args: { query: 'dunk' } }, thoughtSignature: 'SIG123' },
  ] } }] });
  assert.equal(resp.content.length, 1); // la réflexion n'est pas exposée
  assert.equal(resp.content[0].name, 'search_vinted');
  const contents = toGeminiContents([
    { role: 'user', content: 'x' },
    { role: 'assistant', content: resp.content },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'fc1', content: JSON.stringify({ found: 2 }) }] },
  ]);
  assert.equal(contents[1].role, 'model');
  assert.equal(contents[1].parts[0].thoughtSignature, 'SIG123');
  assert.deepEqual(contents[2].parts[0].functionResponse, { name: 'search_vinted', id: 'fc1', response: { found: 2 } });
});

test('gemini : boucle d’agent complète via HTTP, clé en en-tête, annonce inventée écartée', async () => {
  const { listings } = normalizeMany(pool, 't');
  const stub = await geminiStub((rec, n) => {
    if (n === 1) return { json: { candidates: [{ content: { role: 'model', parts: [{ functionCall: { name: 'search_vinted', args: { query: 'dunk' } }, thoughtSignature: 'S' }] } }] } };
    const fr = rec.body.contents[rec.body.contents.length - 1].parts[0].functionResponse;
    const first = fr.response.listings[0];
    return { json: { candidates: [{ content: { role: 'model', parts: [{ functionCall: { name: 'present_results', args: {
      summary: 'ok gemini',
      picks: [{ listing_id: first.listing_id, verdict: 'a_saisir', rationale: 'prix bas' }, { listing_id: '31337', verdict: 'a_saisir', rationale: 'inventée' }],
    } } }] } }] } };
  });
  try {
    const out = await runAgent({ cfg: gcfg(stub.base), provider: fakeProvider(listings) }, { message: 'dunk', filters: {}, fees: {} });
    assert.equal(out.picks.length, 1);
    assert.equal(out.picks[0].listing.id, '1001');
    assert.equal(out.model, 'test-model');
    assert.equal(stub.calls[0].key, 'g-key');
    assert.equal(stub.calls[0].url, '/v1beta/models/test-model:generateContent');
    // la signature renvoyée au 2e appel est bien celle reçue au 1er
    assert.equal(stub.calls[1].body.contents[1].parts[0].thoughtSignature, 'S');
  } finally { stub.srv.close(); }
});

test('gemini : nouvelle tentative sur quota dépassé (429) puis succès', async () => {
  const stub = await geminiStub((rec, n) => n === 1
    ? { status: 429, json: { error: { message: 'quota' } } }
    : { json: { candidates: [{ content: { parts: [{ text: 'bonjour' }] } }] } });
  try {
    const c = gcfg(stub.base); c.ai.retryDelayMs = 0;
    const r = await callGemini(c, { system: 's', tools: [], messages: [{ role: 'user', content: 'x' }] });
    assert.equal(r.content[0].text, 'bonjour');
    assert.ok(stub.calls.length >= 2);
  } finally { stub.srv.close(); }
});

test('gemini : erreurs expliquées (clé invalide, modèle inconnu, quota, réponse vide)', async () => {
  const cases = [
    [{ status: 400, json: { error: { message: 'API key not valid. Please pass a valid API key.' } } }, 'AI_AUTH'],
    [{ status: 403, json: { error: { message: 'denied' } } }, 'AI_AUTH'],
    [{ status: 404, json: { error: { message: 'not found' } } }, 'AI_MODEL'],
    [{ status: 429, json: { error: { message: 'quota' } } }, 'AI_RATE_LIMIT'],
    [{ status: 500, json: { error: { message: 'boom' } } }, 'AI_FAILED'],
    [{ json: { candidates: [{ finishReason: 'SAFETY' }] } }, 'AI_EMPTY'],
  ];
  for (const [resp, code] of cases) {
    const stub = await geminiStub(() => resp);
    try {
      const c = gcfg(stub.base); c.ai.retryDelayMs = 0;
      await assert.rejects(callGemini(c, { system: 's', tools: [], messages: [{ role: 'user', content: 'x' }] }), (e) => e.code === code, code);
    } finally { stub.srv.close(); }
  }
});

test('config : lecture du .env avec fins de ligne Windows, guillemets et BOM', () => {
  const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path');
  const f = path.join(os.tmpdir(), `env-test-${process.pid}`);
  fs.writeFileSync(f, '﻿# commentaire\r\nGEMINI_API_KEY_T1="abc"\r\nPLAIN_T2=xyz  \r\n');
  delete process.env.GEMINI_API_KEY_T1; delete process.env.PLAIN_T2;
  require('../server/config').loadDotEnv(f);
  assert.equal(process.env.GEMINI_API_KEY_T1, 'abc');
  assert.equal(process.env.PLAIN_T2, 'xyz');
  fs.unlinkSync(f);
});

test('analysis : un titre long et un titre court du même modèle sont rapprochés, pas deux modèles différents', () => {
  const { comparablesFor } = require('../server/analysis');
  const mk = (id, title) => normalizeListing({ ...raw(1, 40), id, title, url: `https://www.vinted.fr/items/${id}-x` }, 't');
  const long = mk(1, 'Nike Dunk Low Retro Panda noire et blanche taille 42 neuve jamais portée');
  const shortSame = mk(2, 'Nike Dunk Low Panda');
  const other = mk(3, 'Nike Air Max 90 blanche');
  const sameWords2 = mk(4, 'Nike Air Max');
  assert.equal(comparablesFor(long, [shortSame, other]).map((c) => c.id).join(), '2');
  // 2 mots communs seulement : pas de rapprochement par inclusion
  assert.equal(comparablesFor(other, [sameWords2]).length, 1); // couvert par Jaccard (2/3), pas par l'inclusion
  assert.equal(comparablesFor(long, [other]).length, 0);
});

// ---- Tâches de fond ----
const { createJobs } = require('../server/jobs');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('jobs : cycle de vie, étapes, erreur connue conservée, erreur inconnue masquée', async () => {
  const jobs = createJobs();
  const ok = jobs.start(async (report) => { report('étape 1'); await sleep(10); return { a: 1 }; });
  assert.equal(jobs.view(ok).status, 'running');
  await sleep(40);
  const v = jobs.view(ok);
  assert.equal(v.status, 'done'); assert.deepEqual(v.result, { a: 1 }); assert.equal(v.steps[0].msg, 'étape 1');
  const known = jobs.start(async () => { throw Object.assign(new Error('clé invalide'), { status: 401, code: 'AI_AUTH' }); });
  const unknown = jobs.start(async () => { throw new Error('secret interne'); });
  await sleep(20);
  assert.equal(jobs.view(known).error.code, 'AI_AUTH');
  assert.equal(jobs.view(unknown).error.code, 'INTERNAL');
  assert.ok(!JSON.stringify(jobs.view(unknown)).includes('secret interne'));
  assert.equal(jobs.view('inconnu'), null);
});

test('jobs : limite de tâches simultanées, délai maximal et expiration', async () => {
  const jobs = createJobs({ maxRunning: 1, timeoutMs: 30, ttlMs: 20 });
  const id = jobs.start(() => new Promise(() => {}));
  assert.throws(() => jobs.start(async () => 1), (e) => e.code === 'BUSY' && e.status === 429);
  await sleep(60);
  assert.equal(jobs.view(id).error.code, 'JOB_TIMEOUT');
  await sleep(30);
  jobs.start(async () => 1); // déclenche le nettoyage
  assert.equal(jobs.view(id), null);
});

test('http : /api/jobs (recherche) -> 202, suivi par interrogation, jeton exigé, sans limite de débit', async () => {
  const { listings } = normalizeMany(pool, 't');
  const app = createApp(load({ APP_ACCESS_TOKEN: 'tok', RATE_LIMIT_PER_MINUTE: '3' }), { provider: fakeProvider(listings) });
  await withServer(app, async (base) => {
    const H = { 'x-access-token': 'tok' };
    assert.equal((await post(base, '/api/jobs', { kind: 'search', query: 'dunk' })).status, 401);
    assert.equal((await post(base, '/api/jobs', { kind: 'nimporte' }, H)).status, 400);
    const r = await post(base, '/api/jobs', { kind: 'search', query: 'dunk', filters: { maxPrice: 80 } }, H);
    assert.equal(r.status, 202);
    const { jobId } = await r.json();
    assert.equal((await fetch(`${base}/api/jobs/${jobId}`)).status, 401);
    let v;
    for (let i = 0; i < 30; i++) { // bien plus que la limite de 3 requêtes/minute
      v = await (await fetch(`${base}/api/jobs/${jobId}`, { headers: H })).json();
      if (v.status !== 'running') break;
      await sleep(10);
    }
    assert.equal(v.status, 'done');
    assert.ok(v.result.results.length >= 1);
    const nf = await fetch(`${base}/api/jobs/00000000-0000-0000-0000-000000000000`, { headers: H });
    assert.equal(nf.status, 404);
    assert.equal((await nf.json()).error, 'JOB_NOT_FOUND');
  });
});

test('http : /api/jobs (agent) remonte la progression et les erreurs du modèle', async () => {
  const { listings } = normalizeMany(pool, 't');
  const callModel = async () => { throw Object.assign(new Error('Clé IA refusée'), { status: 401, code: 'AI_AUTH' }); };
  const app = createApp(load({ GEMINI_API_KEY: 'k' }), { provider: fakeProvider(listings), callModel });
  await withServer(app, async (base) => {
    assert.equal((await post(base, '/api/jobs', { kind: 'agent', message: '  ' })).status, 400);
    const { jobId } = await (await post(base, '/api/jobs', { kind: 'agent', message: 'Trouve des Nike' })).json();
    let v;
    for (let i = 0; i < 50; i++) { v = await (await fetch(`${base}/api/jobs/${jobId}`)).json(); if (v.status !== 'running') break; await sleep(10); }
    assert.equal(v.status, 'error');
    assert.equal(v.error.code, 'AI_AUTH');
    assert.ok(v.steps.some((s) => /Analyse/.test(s.msg)));
  });
});

// ---- Détecteur autonome ----
const { createScanner } = require('../server/scanner');
const fsx = require('node:fs'); const osx = require('node:os'); const pathx = require('node:path');
const tmpDir = () => fsx.mkdtempSync(pathx.join(osx.tmpdir(), 'scan-'));
const scanCfg = (extra = {}) => load({ GEMINI_API_KEY: 'k', DATA_DIR: tmpDir(), SCAN_QUERIES: 'Nike,Adidas', SCAN_BATCH: '1', ...extra });

function mutableProvider(listings) {
  const p = { listings, calls: [], configured: true };
  p.status = () => ({ name: 'fake', configured: p.configured, missing: p.configured ? [] : ['APIFY_TOKEN'] });
  p.search = async (q) => { p.calls.push(q.query); return { provider: 'fake', listings: p.listings, pool: p.listings, cached: false, totalFetched: p.listings.length, rejected: 0, fetchedAt: 'now' }; };
  return p;
}
const fav = (i, price, f = 6) => raw(i, price, { favourite_count: f });

test('balayage : retient les bonnes affaires, rend un avis IA limité aux annonces connues, persiste', async () => {
  const { listings } = normalizeMany([fav(1, 35), fav(2, 70), fav(3, 75), fav(4, 80), fav(5, 85), fav(6, 90), fav(7, 160)], 't');
  const provider = mutableProvider(listings);
  const cfg = scanCfg();
  const callModel = async () => ({ content: [{ type: 'text', text: '```json\n' + JSON.stringify([
    { id: String(listings[0].id), verdict: 'a_saisir', rationale: 'Écart net.', risks: 'Vérifier l’état.' },
    { id: '999999', verdict: 'a_saisir', rationale: 'inventée', risks: '' },
  ]) + '\n```' }] });
  const sc = createScanner({ cfg, provider, callModel });
  const stats = await sc.runOnce();
  const v = sc.view();
  assert.ok(stats.added >= 1, JSON.stringify(stats));
  assert.equal(v.items[0].listing.id, listings[0].id);
  assert.equal(v.items[0].ai.verdict, 'a_saisir');
  assert.ok(v.items.every((it) => it.listing.price < 160 && it.analysis.estimate.prudent.profit >= 8));
  assert.ok(v.items.every((it) => it.ai === null || it.listing.id === listings[0].id), 'avis uniquement sur une annonce réelle');
  assert.match(v.items[0].explanation, /médiane/);
  assert.deepEqual(provider.calls, ['Nike']);
  await sc.runOnce(); assert.deepEqual(provider.calls, ['Nike', 'Adidas'], 'rotation des recherches');
  const sc2 = createScanner({ cfg, provider }); sc2.load();
  assert.equal(sc2.size(), sc.size(), 'liste conservée après redémarrage');
});

test('balayage : annonce disparue signalée « à vérifier » puis retirée ; source absente = aucun balayage', async () => {
  const { listings } = normalizeMany([fav(1, 35), fav(2, 70), fav(3, 75), fav(4, 80), fav(5, 85), fav(6, 90)], 't');
  const provider = mutableProvider(listings);
  const cfg = scanCfg({ SCAN_QUERIES: 'Nike', SCAN_AI_REVIEW: 'false' });
  let clock = 1000000; const sc = createScanner({ cfg, provider, now: () => (clock += 1000) });
  await sc.runOnce();
  const id = listings[0].id; assert.equal(sc.view().items.find((i) => i.listing.id === id).status, 'active');
  provider.listings = listings.slice(1);
  await sc.runOnce();
  assert.equal(sc.view().items.find((i) => i.listing.id === id).status, 'unverified');
  for (let i = 0; i < 3; i++) await sc.runOnce();
  assert.equal(sc.view().items.find((i) => i.listing.id === id), undefined, 'retirée après plusieurs balayages sans la revoir');

  provider.configured = false; const before = provider.calls.length;
  const r = await sc.runOnce();
  assert.equal(r.skipped, 'non configuré'); assert.equal(provider.calls.length, before);
  assert.match(sc.view().scan.lastError, /non configurée/);
});

test('http : /api/feed protégé par le jeton, /api/scan lance un balayage réel', async () => {
  const { listings } = normalizeMany([fav(1, 35), fav(2, 70), fav(3, 75), fav(4, 80), fav(5, 85), fav(6, 90)], 't');
  const cfg = scanCfg({ APP_ACCESS_TOKEN: 'tok', SCAN_AI_REVIEW: 'false' });
  const app = createApp(cfg, { provider: mutableProvider(listings) });
  await withServer(app, async (base) => {
    assert.equal((await fetch(base + '/api/feed')).status, 401);
    const H = { 'x-access-token': 'tok' };
    assert.equal((await post(base, '/api/scan', {}, H)).status, 202);
    let v;
    for (let i = 0; i < 50; i++) { v = await (await fetch(base + '/api/feed', { headers: H })).json(); if (!v.scan.running && v.scan.lastRunAt) break; await sleep(20); }
    assert.ok(v.items.length >= 1); assert.equal(v.scan.sourceConfigured, true);
  });
});

test('gemini : sans outil, aucune liste d’outils vide envoyée', () => {
  const r = toGeminiRequest({ system: 's', tools: [], messages: [{ role: 'user', content: 'x' }] });
  assert.equal(r.tools, undefined);
});
