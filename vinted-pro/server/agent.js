'use strict';
// Agent IA : Intégration directe de l'API Gemini REST v1beta avec fallback automatique.

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

const GEMINI_TOOLS = [
  {
    functionDeclarations: [
      {
        name: 'search_vinted',
        description:
          "Recherche de vraies annonces Vinted via la source de données configurée. Renvoie les annonces avec leur analyse de marché calculée (prix médian des comparables, bénéfice estimé prudent et central, score). À utiliser pour toute recherche d'articles.",
        parameters: {
          type: 'OBJECT',
          properties: {
            query: { type: 'STRING', description: 'Mots-clés (modèle, type de pièce). Ex : "dunk low", "polaire".' },
            brand: { type: 'STRING', description: 'Marque, si pertinente.' },
            max_price: { type: 'NUMBER', description: "Prix maximum de l'annonce en euros." },
            size: { type: 'STRING', description: 'Taille (S, M, L, 42...).' },
            min_profit: { type: 'NUMBER', description: 'Bénéfice prudent estimé minimum, en euros (ex. 20).' },
            category: {
              type: 'STRING',
              enum: ['Toutes', 'Sneakers', 'Sweats', 'Vestes', 'T-shirts', 'Pantalons', 'Vintage', 'Accessoires'],
            },
          },
          required: ['query'],
        },
      },
      {
        name: 'compare_listings',
        description: "Compare côte à côte des annonces déjà renvoyées par search_vinted (par listing_id) : prix demandés, coûts d'acquisition, estimations, score.",
        parameters: {
          type: 'OBJECT',
          properties: {
            listing_ids: {
              type: 'ARRAY',
              items: { type: 'STRING' },
              description: 'Liste des identifiants des annonces à comparer.'
            }
          },
          required: ['listing_ids'],
        },
      },
      {
        name: 'present_results',
        description: "Termine la mission : renvoie la sélection finale à l'utilisateur. N'utilise que des listing_id issus de search_vinted. Appel unique.",
        parameters: {
          type: 'OBJECT',
          properties: {
            summary: { type: 'STRING', description: 'Réponse courte à la demande (2 à 4 phrases), en français.' },
            picks: {
              type: 'ARRAY',
              items: {
                type: 'OBJECT',
                properties: {
                  listing_id: { type: 'STRING' },
                  verdict: { type: 'STRING', enum: ['a_saisir', 'a_surveiller', 'a_eviter'] },
                  rationale: { type: 'STRING', description: 'Pourquoi cet article est (ou non) une bonne affaire, avec les chiffres fournis.' },
                  risks: { type: 'STRING', description: 'Risques concrets à vérifier avant achat.' },
                },
                required: ['listing_id', 'verdict', 'rationale'],
              },
            },
          },
          required: ['summary', 'picks'],
        },
      },
    ],
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

async function callGeminiApi(cfg, modelName, body) {
  const url = `${cfg.ai.baseUrl}/v1beta/models/${modelName}:generateContent?key=${cfg.ai.apiKey}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(120000),
  });

  if (!res.ok) {
    const text = (await res.text().catch(() => '')).slice(0, 300);
    if (res.status === 400 || res.status === 401) throw new AgentError('AI_AUTH', 'Clé GEMINI_API_KEY refusée ou invalide.', 502);
    if (res.status === 429) throw new AgentError('AI_RATE_LIMIT', 'Limite de requêtes atteinte sur Gemini API, réessaie dans un instant.', 429);
    
    const err = new AgentError('AI_FAILED', `L’API Gemini a répondu ${res.status} ${text}`, 502);
    err.status = res.status;
    throw err;
  }

  const data = await res.json();
  const candidate = data.candidates && data.candidates[0];
  if (!candidate || !candidate.content) {
    throw new AgentError('AI_FAILED', 'L’API Gemini a renvoyé une réponse vide.', 502);
  }
  return candidate.content;
}

const GEMINI_MODELS = ['gemini-1.5-flash', 'gemini-1.5-pro', 'gemini-2.0-flash'];

async function callGemini(cfg, body) {
  const initialModel = cfg.ai.model || 'gemini-1.5-flash';
  const modelsToTry = [initialModel, ...GEMINI_MODELS.filter((m) => m !== initialModel)];

  let lastError;
  for (const modelName of modelsToTry) {
    try {
      return await callGeminiApi(cfg, modelName, body);
    } catch (err) {
      lastError = err;
      if (err.status === 404 || (err.message && err.message.includes('404'))) {
        continue;
      }
      throw err;
    }
  }
  throw lastError;
}

function defaultCallModel(cfg, body) {
  return callGemini(cfg, body);
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
    throw new AgentError('AI_NOT_CONFIGURED', `${cfg.ai.keyVar} n’est pas défini : l’assistant IA est indisponible.`, 503);
  }

  const filters = req.filters || {};
  const registry = new Map();
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

  const contents = [
    ...(req.history || []).slice(-6).map((h) => ({
      role: h.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: typeof h.content === 'string' ? h.content : JSON.stringify(h.content) }],
    })),
    { role: 'user', parts: [{ text: userText }] },
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
  for (let step = 0; step < (cfg.ai.maxSteps || 8); step++) {
    const responseContent = await callModel({
      systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
      tools: GEMINI_TOOLS,
      contents,
    });

    contents.push(responseContent);

    const parts = responseContent.parts || [];
    const functionCalls = parts.filter((p) => p.functionCall).map((p) => p.functionCall);

    if (!functionCalls.length) {
      const text = parts.filter((p) => p.text).map((p) => p.text).join('\n').trim();
      return finish({ summary: text, picks: [] });
    }

    const presentingCall = functionCalls.find((fc) => fc.name === 'present_results');
    if (presentingCall) {
      final = presentingCall.args || {};
      progress('Rédaction de la sélection');
    }

    const functionResponsesParts = await Promise.all(
      functionCalls.map(async (fc) => {
        if (fc.name === 'present_results') {
          return {
            functionResponse: {
              name: fc.name,
              response: { status: 'ok' },
            },
          };
        }

        let out;
        try {
          out = await runTool(fc.name, fc.args || {});
        } catch (e) {
          out = { error: 'internal', message: e.message };
        }

        return {
          functionResponse: {
            name: fc.name,
            response: out,
          },
        };
      })
    );

    if (final) return finish(final);

    contents.push({
      role: 'user',
      parts: functionResponsesParts,
    });
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
    return { summary: f.summary || '', picks, searches, dropped, model: cfg.ai.model };
  }
}

module.exports = { defaultCallModel, runAgent, AgentError, TOOLS: GEMINI_TOOLS, SYSTEM_PROMPT, evaluate };
