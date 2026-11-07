'use strict';
// Analyse de marché et calcul de bénéfice. Tout est calculé ici en code, jamais "deviné" par l'IA.
//
// Principe : le prix de revente estimé vient UNIQUEMENT des prix demandés sur des annonces comparables
// réellement récupérées. Ce sont des prix affichés, pas des ventes conclues : le résultat est donc
// toujours présenté comme une estimation. Sans assez de comparables, aucune estimation n'est produite.

const DEFAULT_FEES = {
  protectionFixed: 0.7, // € – protection acheteur (partie fixe), à vérifier sur Vinted
  protectionPct: 5, // % – protection acheteur (partie variable), à vérifier sur Vinted
  inboundShipping: 0, // € – port payé à l'achat si non fourni par l'annonce
  resaleFeePct: 0, // % – frais éventuels à la revente (le vendeur ne paie normalement pas de commission Vinted)
  outboundShipping: 0, // € – port à ta charge à la revente (normalement payé par l'acheteur)
  minComparables: 4,
};

const STOPWORDS = new Set([
  'le', 'la', 'les', 'de', 'du', 'des', 'un', 'une', 'et', 'en', 'pour', 'avec', 'sans', 'the', 'and', 'for', 'with',
  'taille', 'size', 'tres', 'tbe', 'etat', 'neuf', 'bon', 'homme', 'femme', 'men', 'women', 'mixte', 'unisexe',
]);

const norm = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
const round2 = (n) => Math.round(n * 100) / 100;

function tokens(title, brand) {
  const b = new Set(norm(brand).split(/[^a-z0-9]+/).filter(Boolean));
  return new Set(
    norm(title)
      .split(/[^a-z0-9]+/)
      .filter((t) => t.length > 1 && !STOPWORDS.has(t) && !b.has(t))
  );
}

function overlap(a, b) {
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  return inter;
}

function jaccard(a, b) {
  if (!a.size || !b.size) return 0;
  const inter = overlap(a, b);
  return inter / (a.size + b.size - inter);
}

// Deux titres décrivent le même article si leurs mots se recoupent assez (Jaccard), ou si le titre le plus
// court est presque entièrement contenu dans le plus long (≥ 3 mots communs et ≥ 80 % du court) :
// sur Vinted, « Dunk Low Panda » et « Nike Dunk Low Retro Panda noire taille 42 neuve » sont le même modèle.
function similar(a, b, threshold) {
  if (!a.size || !b.size) return false;
  if (jaccard(a, b) >= threshold) return true;
  const inter = overlap(a, b);
  return inter >= 3 && inter / Math.min(a.size, b.size) >= 0.8;
}

function quantile(sorted, q) {
  if (!sorted.length) return null;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

function stats(prices) {
  const s = [...prices].sort((a, b) => a - b);
  if (!s.length) return { n: 0 };
  return {
    n: s.length,
    min: round2(s[0]),
    p25: round2(quantile(s, 0.25)),
    median: round2(quantile(s, 0.5)),
    p75: round2(quantile(s, 0.75)),
    max: round2(s[s.length - 1]),
  };
}

function comparablesFor(listing, pool, threshold = 0.34) {
  const t = tokens(listing.title, listing.brand);
  const brand = norm(listing.brand);
  return pool.filter((o) => {
    if (o.id === listing.id) return false;
    if (brand && o.brand && norm(o.brand) !== brand) return false;
    return similar(t, tokens(o.title, o.brand), threshold);
  });
}

// Demande : proxy prudent fondé sur les « favoris » des annonces comparables, quand la source les fournit.
// Ce n'est PAS un volume de ventes (Vinted n'expose pas les ventes conclues) : à lire comme un indice d'intérêt.
function demandOf(listing, comps) {
  const favs = comps.map((c) => c.favourites).filter((v) => v != null);
  if (listing.favourites != null) favs.push(listing.favourites);
  if (favs.length < 3) return { level: 'inconnue', avgFavourites: null, basis: 'favoris non fournis par la source' };
  const avg = Math.round((favs.reduce((a, b) => a + b, 0) / favs.length) * 10) / 10;
  return { level: avg >= 5 ? 'forte' : avg >= 2 ? 'moyenne' : 'faible', avgFavourites: avg, basis: `moyenne de ${avg} favoris sur ${favs.length} annonces` };
}

function buyerProtection(price, fees) {
  return round2(fees.protectionFixed + (price * fees.protectionPct) / 100);
}

const CONDITION_SCORE = [
  [/neuf avec/i, 1], [/neuf sans/i, 0.9], [/tr[eè]s bon/i, 0.8], [/\bbon [eé]tat/i, 0.6],
  [/satisfaisant/i, 0.35], [/new with tags/i, 1], [/new without/i, 0.9], [/very good/i, 0.8], [/good/i, 0.6],
];
function conditionScore(c) {
  if (!c) return 0.5;
  for (const [re, v] of CONDITION_SCORE) if (re.test(c)) return v;
  return 0.5;
}

/**
 * Évalue une annonce par rapport au pool d'annonces réellement récupérées.
 * Retourne toujours un objet ; `estimate` vaut null si les données sont insuffisantes.
 */
function evaluate(listing, pool, feesIn = {}) {
  const fees = { ...DEFAULT_FEES, ...feesIn };
  const protection = buyerProtection(listing.price, fees);
  const inbound = listing.shippingPrice != null ? listing.shippingPrice : fees.inboundShipping;
  const acquisitionCost = round2(listing.price + protection + inbound);

  const comps = comparablesFor(listing, pool);
  const market = stats(comps.map((c) => c.price));
  const base = {
    listingId: listing.id,
    observed: { askingPrice: listing.price, currency: listing.currency },
    costs: { buyerProtection: protection, inboundShipping: round2(inbound), acquisitionCost },
    demand: demandOf(listing, comps),
    market: { ...market, comparableIds: comps.slice(0, 12).map((c) => c.id), basis: 'prix demandés sur des annonces actives, pas des ventes conclues' },
  };

  if (market.n < fees.minComparables) {
    return {
      ...base,
      estimate: null,
      reason: `Pas assez d’annonces comparables (${market.n} trouvée(s), ${fees.minComparables} minimum) pour estimer une revente.`,
      score: null,
    };
  }

  const net = (resale) => round2(resale - (resale * fees.resaleFeePct) / 100 - fees.outboundShipping);
  const build = (resale) => {
    const netResale = net(resale);
    const profit = round2(netResale - acquisitionCost);
    return {
      resalePrice: round2(resale),
      netResale,
      profit,
      roiPct: acquisitionCost > 0 ? Math.round((profit / acquisitionCost) * 100) : null,
    };
  };

  const prudent = build(market.p25); // scénario prudent : bas de fourchette observée
  const central = build(market.median); // scénario central : médiane des prix demandés
  const discountPct = market.median > 0 ? Math.round((1 - listing.price / market.median) * 100) : 0;

  // Score de classement (heuristique 0-100, ce n'est pas une prédiction de vente) :
  //  50 : rentabilité du scénario prudent (plafonnée à +60 % de ROI)
  //  20 : écart entre le prix demandé et la médiane du marché (plafonné à 40 %)
  //  15 : fiabilité de l'estimation (nombre de comparables, plafonné à 10)
  //  10 : état de l'article
  //   5 : intérêt de la communauté (favoris, si fournis par la source)
  const roi = prudent.roiPct == null ? 0 : prudent.roiPct / 100;
  const demand = listing.favourites == null ? 0.3 : Math.min(1, listing.favourites / 15);
  const score = Math.round(
    50 * Math.min(1, Math.max(0, roi / 0.6)) +
      20 * Math.min(1, Math.max(0, discountPct / 40)) +
      15 * Math.min(1, market.n / 10) +
      10 * conditionScore(listing.condition) +
      5 * demand
  );

  return {
    ...base,
    estimate: { prudent, central, discountPct },
    reason: null,
    score,
    confidence: market.n >= 10 ? 'correcte' : market.n >= 6 ? 'moyenne' : 'faible',
  };
}

function rank(listings, pool, fees) {
  return listings
    .map((l) => ({ listing: l, analysis: evaluate(l, pool, fees) }))
    .sort((a, b) => (b.analysis.score ?? -1) - (a.analysis.score ?? -1));
}

module.exports = { DEFAULT_FEES, evaluate, rank, stats, comparablesFor, buyerProtection, tokens, jaccard, similar };
