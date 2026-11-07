'use strict';
// Normalisation d'une annonce brute (peu importe la source) vers un format unique.
// Règle absolue : une annonce sans titre, sans prix valide ou sans lien Vinted valide est rejetée.
// Aucune valeur n'est jamais inventée : un champ absent reste null.

const VINTED_URL = /^https:\/\/(www\.)?vinted\.[a-z.]{2,}\//i;

const pick = (obj, keys) => {
  for (const k of keys) {
    const parts = k.split('.');
    let cur = obj;
    for (const p of parts) cur = cur == null ? undefined : cur[p];
    if (cur !== undefined && cur !== null && cur !== '') return cur;
  }
  return null;
};

function toNumber(v) {
  if (v == null) return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'object') return toNumber(pick(v, ['amount', 'value', 'price']));
  const n = parseFloat(String(v).replace(',', '.').replace(/[^0-9.]/g, ''));
  return Number.isFinite(n) ? n : null;
}

function toStr(v) {
  if (v == null) return null;
  if (typeof v === 'object') return toStr(pick(v, ['title', 'name', 'label']));
  const s = String(v).trim();
  return s || null;
}

function photoUrls(raw) {
  const out = [];
  const push = (u) => {
    if (typeof u === 'string' && /^https:\/\//i.test(u) && !out.includes(u)) out.push(u);
  };
  const single = pick(raw, ['photo.full_size_url', 'photo.url', 'photo', 'image', 'imageUrl', 'thumbnail']);
  if (typeof single === 'string') push(single);
  else if (single && typeof single === 'object') push(single.full_size_url || single.url);
  const many = pick(raw, ['photos', 'images', 'photoUrls']);
  if (Array.isArray(many)) {
    for (const p of many) push(typeof p === 'string' ? p : p && (p.full_size_url || p.url));
  }
  return out.slice(0, 6);
}

function normalizeListing(raw, source) {
  if (!raw || typeof raw !== 'object') return null;
  const url = toStr(pick(raw, ['url', 'link', 'item_url', 'itemUrl']));
  if (!url || !VINTED_URL.test(url)) return null;
  const title = toStr(pick(raw, ['title', 'name']));
  const price = toNumber(pick(raw, ['price.amount', 'price', 'total_item_price.amount']));
  if (!title || price == null || price <= 0) return null;

  const idRaw = pick(raw, ['id', 'item_id', 'itemId']);
  const urlId = (url.match(/\/items\/(\d+)/) || [])[1];
  const id = String(idRaw != null ? idRaw : urlId || '');
  if (!id) return null;

  const favourites = toNumber(pick(raw, ['favourite_count', 'favouriteCount', 'favorites', 'favourites']));
  const views = toNumber(pick(raw, ['view_count', 'viewCount', 'views']));
  const rating = toNumber(pick(raw, ['user.feedback_reputation', 'seller.rating', 'sellerRating']));
  const shipping = toNumber(pick(raw, ['shipping_price', 'shippingPrice', 'shipping.price']));

  return {
    id,
    title,
    brand: toStr(pick(raw, ['brand_title', 'brand', 'brandTitle'])),
    price,
    currency: toStr(pick(raw, ['price.currency_code', 'currency', 'currency_code'])) || 'EUR',
    size: toStr(pick(raw, ['size_title', 'size', 'sizeTitle'])),
    condition: toStr(pick(raw, ['status', 'condition'])),
    description: (toStr(pick(raw, ['description'])) || '').slice(0, 1200) || null,
    category: toStr(pick(raw, ['catalog_title', 'category', 'catalog'])),
    url,
    photos: photoUrls(raw),
    seller: {
      name: toStr(pick(raw, ['user.login', 'seller.name', 'sellerName', 'seller'])),
      rating: rating, // peut être sur 0-1 ou 0-5 selon la source : affiché tel quel
      reviews: toNumber(pick(raw, ['user.feedback_count', 'seller.reviews', 'sellerReviews'])),
    },
    favourites,
    views,
    shippingPrice: shipping,
    publishedAt: toStr(pick(raw, ['created_at', 'publishedAt', 'published_at', 'created_at_ts'])),
    source: source || 'inconnue',
    fetchedAt: new Date().toISOString(),
  };
}

function normalizeMany(rawItems, source) {
  const seen = new Set();
  const out = [];
  let rejected = 0;
  for (const r of Array.isArray(rawItems) ? rawItems : []) {
    const n = normalizeListing(r, source);
    if (!n) { rejected++; continue; }
    if (seen.has(n.id)) continue;
    seen.add(n.id);
    out.push(n);
  }
  return { listings: out, rejected };
}

module.exports = { normalizeListing, normalizeMany, VINTED_URL };
