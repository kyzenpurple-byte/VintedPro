'use strict';
// Fournisseur générique : n'importe quel endpoint HTTP autorisé qui renvoie des annonces Vinted en JSON
// (ton propre service, un autre fournisseur de données, un export...).
// GENERIC_PROVIDER_URL accepte {query} {maxPrice} {limit} {domain}. La réponse doit être un tableau
// ou un objet contenant items / data / results / listings.

function subst(str, ctx) {
  return str.replace(/\{(\w+)\}/g, (_, k) => encodeURIComponent(ctx[k] ?? ''));
}

async function fetchItems(providerCfg, ctx) {
  const g = providerCfg.generic;
  const headers = { Accept: 'application/json' };
  if (g.key) headers.Authorization = `Bearer ${g.key}`;
  const opts = { method: g.method, headers, signal: AbortSignal.timeout(providerCfg.timeoutMs) };
  if (g.method === 'POST') {
    headers['Content-Type'] = 'application/json';
    opts.body = (g.bodyTemplate || '{"query":"{query}","maxPrice":"{maxPrice}","limit":"{limit}"}')
      .replace(/\{(\w+)\}/g, (_, k) => String(ctx[k] ?? '').replace(/"/g, '\\"'));
  }
  const res = await fetch(subst(g.url, ctx), opts);
  if (!res.ok) throw new Error(`Le fournisseur a répondu ${res.status}`);
  const data = await res.json();
  if (Array.isArray(data)) return data;
  for (const k of ['items', 'data', 'results', 'listings']) {
    if (Array.isArray(data[k])) return data[k];
  }
  return [];
}

module.exports = { fetchItems };
