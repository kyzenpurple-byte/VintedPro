'use strict';
// Couche d'accès aux annonces. Vinted ne propose pas d'API publique officielle :
// l'accès passe par un fournisseur autorisé que TU configures (service tiers ou ton propre endpoint).
// Si rien n'est configuré, la recherche renvoie une erreur explicite : jamais de données de remplacement.
const { normalizeMany } = require('./normalize');
const apify = require('./apify');
const generic = require('./generic');

class ProviderError extends Error {
  constructor(code, message, status = 502) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

const CATEGORY_KEYWORDS = {
  Sneakers: ['sneaker', 'basket', 'dunk', 'jordan', 'air max', 'air force', 'samba', 'gazelle', 'chaussure', 'new balance', 'yeezy', 'campus', 'spezial'],
  Sweats: ['sweat', 'pull', 'hoodie', 'crewneck', 'pullover', 'knit', 'cardigan', 'polaire', 'fleece'],
  Vestes: ['veste', 'manteau', 'jacket', 'coat', 'parka', 'doudoune', 'blouson', 'bomber', 'puffer', 'trench', 'imper'],
  'T-shirts': ['t-shirt', 'tee', 'tshirt', 'polo', 'maillot'],
  Pantalons: ['pantalon', 'jean', 'jeans', 'cargo', 'short', 'jogging', 'chino', 'denim'],
  Vintage: ['vintage', 'y2k', '90s', '80s', 'retro', 'rétro'],
  Accessoires: ['casquette', 'bonnet', 'sac', 'ceinture', 'echarpe', 'écharpe', 'montre', 'lunettes', 'bob', 'portefeuille'],
};

const norm = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');

function matchesCategory(listing, category) {
  if (!category || category === 'Toutes') return true;
  const kws = CATEGORY_KEYWORDS[category];
  if (!kws) return true;
  const hay = norm(`${listing.title} ${listing.category || ''}`);
  return kws.some((k) => hay.includes(norm(k)));
}

// Compare des tailles entières ("M / 38 / 10" contient M, 38 et 10) : "L" ne correspond pas à "XL".
function sizeMatches(listingSize, wanted) {
  if (!listingSize) return false;
  const want = norm(wanted).trim();
  return norm(listingSize).split(/[^a-z0-9]+/).filter(Boolean).includes(want);
}

function applyFilters(listings, f) {
  return listings.filter((l) => {
    if (f.maxPrice != null && l.price > f.maxPrice) return false;
    if (f.minPrice != null && l.price < f.minPrice) return false;
    if (f.brand && !norm(`${l.brand || ''} ${l.title}`).includes(norm(f.brand))) return false;
    if (f.size && !sizeMatches(l.size, f.size)) return false;
    if (!matchesCategory(l, f.category)) return false;
    return true;
  });
}

function createProvider(cfg) {
  const name = cfg.provider.name;
  const cache = new Map();

  function status() {
    if (name === 'apify') {
      const missing = [];
      if (!cfg.provider.apify.token) missing.push('APIFY_TOKEN');
      if (!cfg.provider.apify.actorId) missing.push('APIFY_ACTOR_ID');
      if (!cfg.provider.apify.inputTemplate) missing.push('APIFY_INPUT_TEMPLATE');
      return { name, configured: missing.length === 0, missing };
    }
    if (name === 'generic') {
      const missing = cfg.provider.generic.url ? [] : ['GENERIC_PROVIDER_URL'];
      return { name, configured: missing.length === 0, missing };
    }
    return { name: 'none', configured: false, missing: ['VINTED_PROVIDER'] };
  }

  async function search(params) {
    const st = status();
    if (!st.configured) {
      throw new ProviderError(
        'PROVIDER_NOT_CONFIGURED',
        `Aucune source d'annonces Vinted n'est configurée (variables manquantes : ${st.missing.join(', ')}).`,
        503
      );
    }
    const query = [params.brand, params.query].filter(Boolean).join(' ').trim();
    if (!query) throw new ProviderError('EMPTY_QUERY', 'Précise au moins un mot-clé ou une marque.', 400);

    const limit = Math.min(params.limit || cfg.provider.maxResults, cfg.provider.maxResults);
    const key = JSON.stringify([name, query, params.maxPrice ?? null, limit]);
    // Le cache ne garde que les annonces récupérées ; les filtres (taille, catégorie...) sont réappliqués à chaque appel.
    const view = (base, cached) => ({
      ...base,
      listings: applyFilters(base.pool, params).slice(0, limit),
      cached,
    });
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < cfg.provider.cacheTtlSeconds * 1000) {
      return view(hit.value, true);
    }

    const ctx = { query, maxPrice: params.maxPrice ?? null, limit, domain: cfg.provider.vintedDomain };
    let raw;
    try {
      raw = name === 'apify'
        ? await apify.fetchItems(cfg.provider, ctx)
        : await generic.fetchItems(cfg.provider, ctx);
    } catch (e) {
      if (e instanceof ProviderError) throw e;
      if (e.name === 'TimeoutError' || e.name === 'AbortError') {
        throw new ProviderError('PROVIDER_TIMEOUT', 'La source d’annonces a mis trop de temps à répondre.', 504);
      }
      throw new ProviderError('PROVIDER_FAILED', `La source d’annonces a échoué : ${e.message}`, 502);
    }

    const { listings, rejected } = normalizeMany(raw, name);
    const value = {
      provider: name,
      query,
      totalFetched: listings.length,
      rejected, // annonces ignorées car incomplètes ou sans lien Vinted valide
      // pool complet (avant filtres taille/catégorie) : sert aussi de base de comparaison pour le marché
      pool: listings,
      fetchedAt: new Date().toISOString(),
    };
    cache.set(key, { at: Date.now(), value });
    return view(value, false);
  }

  return { search, status };
}

module.exports = { createProvider, ProviderError, applyFilters, CATEGORY_KEYWORDS };
