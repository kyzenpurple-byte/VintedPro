'use strict';
// Configuration lue depuis les variables d'environnement (fichier .env à la racine).
// Aucune clé n'est jamais envoyée au navigateur.
const fs = require('node:fs');
const path = require('node:path');

// Lecteur de .env maison : fonctionne sur toutes les versions de Node et gère les fins de ligne
// Windows (CRLF), le BOM du Bloc-notes et les guillemets. Les variables déjà définies priment.
function parseEnv(text) {
  const out = {};
  for (const raw of String(text).replace(/^﻿/, '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 1) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) val = val.slice(1, -1);
    out[key] = val;
  }
  return out;
}

function loadDotEnv(file = path.join(__dirname, '..', '.env')) {
  if (!fs.existsSync(file)) return;
  const parsed = parseEnv(fs.readFileSync(file, 'utf8'));
  for (const [k, v] of Object.entries(parsed)) if (process.env[k] === undefined) process.env[k] = v;
}
loadDotEnv();

const int = (v, d) => {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : d;
};

function loadAi(env) {
  const openrouter = env.OPENROUTER_API_KEY || '';
  const gemini = env.GEMINI_API_KEY || env.GOOGLE_API_KEY || '';
  const anthropic = env.ANTHROPIC_API_KEY || '';

  let provider = String(env.AI_PROVIDER || '').toLowerCase();
  
  // Détection automatique du provider si non spécifié explicitement
  if (!['openrouter', 'gemini', 'anthropic'].includes(provider)) {
    if (openrouter) provider = 'openrouter';
    else if (anthropic) provider = 'anthropic';
    else provider = 'gemini';
  }

  const maxSteps = int(env.AGENT_MAX_STEPS, 8);

  if (provider === 'openrouter') {
    return {
      provider,
      apiKey: openrouter,
      maxSteps,
      model: env.OPENROUTER_MODEL || 'google/gemini-2.0-flash-exp:free',
      baseUrl: env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1',
      keyVar: 'OPENROUTER_API_KEY',
      siteUrl: env.SITE_URL || 'http://localhost',
      appName: env.APP_NAME || 'VintedPro',
    };
  }

  if (provider === 'anthropic') {
    return {
      provider,
      apiKey: anthropic,
      maxSteps,
      model: env.ANTHROPIC_MODEL || 'claude-sonnet-5-5',
      baseUrl: env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com',
      keyVar: 'ANTHROPIC_API_KEY',
    };
  }

  return {
    provider,
    apiKey: gemini,
    maxSteps,
    model: env.GEMINI_MODEL || 'gemini-3.8-flash',
    baseUrl: env.GEMINI_BASE_URL || 'https://generativelanguage.googleapis.com',
    keyVar: 'GEMINI_API_KEY',
  };
}

function load(env = process.env) {
  return {
    port: int(env.PORT, 3000),
    host: env.HOST || '127.0.0.1',
    accessToken: env.APP_ACCESS_TOKEN || '',
    ai: loadAi(env),
    provider: {
      name: (env.VINTED_PROVIDER || 'none').toLowerCase(),
      vintedDomain: env.VINTED_DOMAIN || 'vinted.fr',
      apify: {
        token: env.APIFY_TOKEN || '',
        actorId: env.APIFY_ACTOR_ID || '',
        inputTemplate: env.APIFY_INPUT_TEMPLATE || '',
      },
      generic: {
        url: env.GENERIC_PROVIDER_URL || '',
        key: env.GENERIC_PROVIDER_KEY || '',
        method: (env.GENERIC_PROVIDER_METHOD || 'GET').toUpperCase(),
        bodyTemplate: env.GENERIC_PROVIDER_BODY || '',
      },
      timeoutMs: int(env.PROVIDER_TIMEOUT_MS, 90000),
      cacheTtlSeconds: int(env.CACHE_TTL_SECONDS, 600),
      maxResults: int(env.PROVIDER_MAX_RESULTS, 40),
    },
    scan: {
      intervalMinutes: int(env.SCAN_INTERVAL_MINUTES, 60), // 0 = balayage automatique désactivé
      queries: (env.SCAN_QUERIES || 'Nike,Adidas,Carhartt,Ralph Lauren,Levi\'s,The North Face,Patagonia,New Balance,Lacoste,Stüssy')
        .split(',').map((x) => x.trim()).filter(Boolean),
      batch: int(env.SCAN_BATCH, 3), // recherches par balayage (chaque recherche consomme ta source d'annonces)
      minProfit: int(env.SCAN_MIN_PROFIT, 8),
      minScore: int(env.SCAN_MIN_SCORE, 45),
      maxPrice: env.SCAN_MAX_PRICE ? Number(env.SCAN_MAX_PRICE) : null,
      aiReview: String(env.SCAN_AI_REVIEW || 'true').toLowerCase() !== 'false',
      dataDir: env.DATA_DIR || require('node:path').join(__dirname, '..', 'data'),
    },
    rateLimit: {
      windowMs: 60_000,
      max: int(env.RATE_LIMIT_PER_MINUTE, 20),
    },
  };
}

const isLoopback = (host) => ['127.0.0.1', 'localhost', '::1'].includes(String(host).toLowerCase());

module.exports = { load, parseEnv, loadDotEnv, isLoopback };
