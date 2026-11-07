'use strict';
// Adaptateur Google Gemini (API generateContent, appels de fonctions).
// L'agent parle en blocs { type: 'text' | 'tool_use' | 'tool_result' } ; ce module les convertit
// vers le format Gemini et inversement. Les "parts" d'origine renvoyées par Gemini sont conservées
// (gemini_part) et renvoyées telles quelles au tour suivant : c'est obligatoire pour les modèles
// qui utilisent des signatures de réflexion (thoughtSignature).
const { AgentError } = require('./errors');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Schéma JSON -> schéma Gemini (types en majuscules, sous-ensemble OpenAPI)
function toGeminiSchema(s) {
  if (!s || typeof s !== 'object') return s;
  const out = {};
  for (const [k, v] of Object.entries(s)) {
    if (k === 'type') out.type = String(v).toUpperCase();
    else if (k === 'properties') out.properties = Object.fromEntries(Object.entries(v).map(([n, p]) => [n, toGeminiSchema(p)]));
    else if (k === 'items') out.items = toGeminiSchema(v);
    else out[k] = v;
  }
  return out;
}

function toGeminiContents(messages) {
  const calls = new Map(); // tool_use id -> { name, nativeId }
  const contents = [];
  for (const m of messages) {
    if (typeof m.content === 'string') {
      if (m.content) contents.push({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] });
      continue;
    }
    if (m.role === 'assistant') {
      const parts = [];
      for (const b of m.content) {
        if (b.type === 'tool_use') calls.set(b.id, { name: b.name, nativeId: b.gemini_part && b.gemini_part.functionCall && b.gemini_part.functionCall.id });
        if (b.gemini_part) parts.push(b.gemini_part);
        else if (b.type === 'text' && b.text) parts.push({ text: b.text });
        else if (b.type === 'tool_use') parts.push({ functionCall: { name: b.name, args: b.input || {} } });
      }
      if (parts.length) contents.push({ role: 'model', parts });
    } else {
      const parts = m.content.map((b) => {
        if (b.type !== 'tool_result') return { text: b.text || '' };
        let r;
        try { r = JSON.parse(b.content); } catch { r = b.content; }
        const info = calls.get(b.tool_use_id) || { name: 'inconnu' };
        const fr = { name: info.name, response: r && typeof r === 'object' && !Array.isArray(r) ? r : { result: r } };
        if (info.nativeId) fr.id = info.nativeId;
        return { functionResponse: fr };
      });
      contents.push({ role: 'user', parts });
    }
  }
  return contents;
}

function toGeminiRequest(body) {
  const req = {
    systemInstruction: { parts: [{ text: body.system }] },
    contents: toGeminiContents(body.messages),
    generationConfig: { maxOutputTokens: 8192 },
  };
  // Sans outil (ex. avis du balayage automatique), on n'envoie pas de liste vide : l'API la refuserait.
  if (body.tools && body.tools.length) {
    req.tools = [{
      functionDeclarations: body.tools.map((t) => ({ name: t.name, description: t.description, parameters: toGeminiSchema(t.input_schema) })),
    }];
  }
  return req;
}

function fromGeminiResponse(data) {
  const cand = data && data.candidates && data.candidates[0];
  const parts = (cand && cand.content && cand.content.parts) || [];
  if (!parts.length) {
    const reason = (cand && cand.finishReason) || (data && data.promptFeedback && data.promptFeedback.blockReason) || 'inconnu';
    throw new AgentError('AI_EMPTY', `Gemini n’a renvoyé aucune réponse (motif : ${reason}). Reformule la demande.`, 502);
  }
  const content = [];
  let n = 0;
  for (const p of parts) {
    if (p.functionCall) {
      content.push({ type: 'tool_use', id: p.functionCall.id || `call_${Date.now()}_${n++}`, name: p.functionCall.name, input: p.functionCall.args || {}, gemini_part: p });
    } else if (typeof p.text === 'string' && !p.thought) {
      content.push({ type: 'text', text: p.text, gemini_part: p });
    }
  }
  return { content };
}

async function callGemini(cfg, body) {
  const ai = cfg.ai;
  const url = `${ai.baseUrl}/v1beta/models/${encodeURIComponent(ai.model)}:generateContent`;
  const payload = JSON.stringify(toGeminiRequest(body));
  const delays = ai.retryDelayMs === undefined ? [4000, 8000] : [ai.retryDelayMs, ai.retryDelayMs];

  for (let attempt = 0; ; attempt++) {
    let res;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-goog-api-key': ai.apiKey },
        body: payload,
        signal: AbortSignal.timeout(120000),
      });
    } catch (e) {
      throw new AgentError('AI_FAILED', `Impossible de joindre l’API Gemini : ${e.message}`, 502);
    }
    if (res.ok) return fromGeminiResponse(await res.json());

    if ((res.status === 429 || res.status === 503) && attempt < delays.length) {
      await sleep(delays[attempt]);
      continue;
    }
    let detail = '';
    try { detail = (await res.json()).error.message || ''; } catch { /* corps non JSON */ }
    if (res.status === 401 || res.status === 403 || (res.status === 400 && /api key|API_KEY/i.test(detail))) {
      throw new AgentError('AI_AUTH', 'Clé GEMINI_API_KEY refusée par Google. Vérifie qu’elle est complète et active.', 502);
    }
    if (res.status === 404) {
      throw new AgentError('AI_MODEL', `Modèle « ${ai.model} » introuvable. Change GEMINI_MODEL dans .env (liste des modèles : Google AI Studio).`, 502);
    }
    if (res.status === 429) {
      throw new AgentError('AI_RATE_LIMIT', 'Limite de requêtes Gemini atteinte (quota gratuit ?). Attends une minute puis réessaie.', 429);
    }
    throw new AgentError('AI_FAILED', `Gemini a répondu ${res.status}${detail ? ' : ' + detail.slice(0, 250) : ''}`, 502);
  }
}

module.exports = { callGemini, toGeminiRequest, toGeminiContents, toGeminiSchema, fromGeminiResponse };
