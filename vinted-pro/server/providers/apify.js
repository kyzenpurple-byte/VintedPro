'use strict';
// Fournisseur via Apify (service tiers payant). Tu choisis l'acteur Vinted que tu veux utiliser et
// tu décris son entrée dans APIFY_INPUT_TEMPLATE (JSON avec {{query}}, {{maxPrice}}, {{limit}}, {{domain}}).
// Rien n'est codé en dur : le schéma d'entrée change d'un acteur à l'autre.
// Vérifie les conditions d'utilisation de l'acteur et de Vinted avant usage.

function fill(template, ctx) {
  const json = JSON.stringify(ctx).slice(0); // eslint-disable-line no-unused-vars
  return template.replace(/"?\{\{(\w+)\}\}"?/g, (m, key) => {
    const v = ctx[key];
    if (v === undefined || v === null) return 'null';
    const quoted = m.startsWith('"') && m.endsWith('"');
    if (typeof v === 'number') return String(v);
    return quoted || typeof v === 'string' ? JSON.stringify(String(v)) : JSON.stringify(v);
  });
}

async function fetchItems(providerCfg, ctx) {
  const { token, actorId, inputTemplate } = providerCfg.apify;
  let input;
  try {
    input = JSON.parse(fill(inputTemplate, ctx));
  } catch (e) {
    const err = new Error('APIFY_INPUT_TEMPLATE n’est pas un JSON valide après remplacement des variables.');
    err.name = 'ConfigError';
    throw err;
  }
  const url = `https://api.apify.com/v2/acts/${encodeURIComponent(actorId)}/run-sync-get-dataset-items?format=json&clean=true`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(input),
    signal: AbortSignal.timeout(providerCfg.timeoutMs),
  });
  if (!res.ok) {
    const text = (await res.text().catch(() => '')).slice(0, 300);
    throw new Error(`Apify a répondu ${res.status} ${text}`);
  }
  const data = await res.json();
  return Array.isArray(data) ? data : data.items || [];
}

module.exports = { fetchItems, fill };
