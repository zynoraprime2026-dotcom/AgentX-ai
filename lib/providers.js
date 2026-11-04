'use strict';
// Model providers for AgentX.
//
// Gemini is the primary: its free tier carries a large per-minute token budget,
// which is what makes real conversations (and tool lookups) possible at all.
// Groq stays as the fallback, because it is what answered before and it costs
// nothing to keep as a second lane.
//
// Everything here speaks the same shape the reply loop already used:
//   messages: [{ role: 'system' | 'user' | 'assistant' | 'tool', content, tool_calls, tool_call_id, name }]
//   tools:    [{ type: 'function', function: { name, description, parameters } }]
//   result:   { ok, status, error, text, calls: [{ id, name, args }], provider, model }

const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta';
const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions';

// Preference order, newest usable first. A name that does not exist on this key
// is skipped rather than guessed, so a rename upstream cannot break replies.
const GEMINI_PREFS = ['gemini-2.5-flash', 'gemini-flash-latest', 'gemini-2.0-flash', 'gemini-1.5-flash'];

let modelCache = null;
let modelCheckedAt = 0;
let thinkingAllowed = true; // set false the first time a model rejects thinkingConfig

function geminiKey() {
  return String(process.env.GEMINI_API_KEY || '').trim();
}

async function geminiModel() {
  const forced = String(process.env.GEMINI_MODEL || '').trim();
  if (forced) return forced;
  if (modelCache) return modelCache;
  if (Date.now() - modelCheckedAt < 10 * 60 * 1000) return null; // do not hammer the list endpoint
  modelCheckedAt = Date.now();
  const key = geminiKey();
  if (!key) return null;
  try {
    const r = await fetch(GEMINI_BASE + '/models?key=' + encodeURIComponent(key), { signal: AbortSignal.timeout(15000) });
    const d = await r.json().catch(() => ({}));
    const names = (d.models || [])
      .filter((m) => (m.supportedGenerationMethods || []).includes('generateContent'))
      .map((m) => String(m.name || '').replace(/^models\//, ''));
    const usable = names.filter((n) => !/image|tts|audio|live|embedding|aqa/i.test(n));
    modelCache = GEMINI_PREFS.find((p) => usable.includes(p)) || usable.find((n) => /flash/i.test(n)) || usable[0] || null;
  } catch (e) {
    modelCache = null;
  }
  return modelCache;
}

async function geminiReady() {
  return Boolean(geminiKey() && (await geminiModel()));
}

// ---------- format conversion ----------

function toGeminiSchema(schema) {
  const src = schema || {};
  const out = { type: String(src.type || 'object').toUpperCase() };
  if (src.description) out.description = String(src.description);
  if (Array.isArray(src.enum) && src.enum.length) out.enum = src.enum.map((v) => String(v));
  if (src.properties && typeof src.properties === 'object') {
    out.properties = {};
    for (const [k, v] of Object.entries(src.properties)) out.properties[k] = toGeminiSchema(v);
  }
  if (Array.isArray(src.required) && src.required.length) out.required = src.required.slice();
  if (src.items) out.items = toGeminiSchema(src.items);
  return out;
}

function toGeminiContents(messages) {
  const systemParts = [];
  const contents = [];
  for (const m of messages) {
    if (!m) continue;
    if (m.role === 'system') { systemParts.push(String(m.content || '')); continue; }
    if (m.role === 'tool') {
      contents.push({ role: 'user', parts: [{ functionResponse: { name: m.name || 'tool', response: { result: String(m.content || '') } } }] });
      continue;
    }
    if (m.role === 'assistant') {
      const parts = [];
      if (m.content) parts.push({ text: String(m.content) });
      for (const c of (m.tool_calls || [])) parts.push({ functionCall: { name: c.name, args: c.args || {} } });
      if (!parts.length) parts.push({ text: '(no content)' });
      contents.push({ role: 'model', parts });
      continue;
    }
    contents.push({ role: 'user', parts: [{ text: String(m.content || '') }] });
  }
  // Gemini wants alternating turns; merge any consecutive same-role turns.
  const merged = [];
  for (const c of contents) {
    const prev = merged[merged.length - 1];
    if (prev && prev.role === c.role) prev.parts.push(...c.parts);
    else merged.push({ role: c.role, parts: c.parts.slice() });
  }
  if (!merged.length) merged.push({ role: 'user', parts: [{ text: 'Hello' }] });
  if (merged[0].role !== 'user') merged.unshift({ role: 'user', parts: [{ text: 'Continue.' }] });
  return { systemText: systemParts.filter(Boolean).join('\n\n'), contents: merged };
}

function toGroqMessages(messages) {
  return messages.map((m) => {
    if (!m) return m;
    if (m.role === 'assistant' && m.tool_calls && m.tool_calls.length) {
      return {
        role: 'assistant',
        content: m.content || null,
        tool_calls: m.tool_calls.map((c) => ({
          id: c.id, type: 'function',
          function: { name: c.name, arguments: JSON.stringify(c.args || {}) }
        }))
      };
    }
    if (m.role === 'tool') return { role: 'tool', tool_call_id: m.tool_call_id, content: String(m.content || '') };
    return { role: m.role, content: String(m.content || '') };
  });
}

// ---------- calls ----------

function waitFrom(res, msg) {
  const after = Number(res.headers.get('retry-after'));
  if (Number.isFinite(after) && after > 0) return Math.min(after * 1000 + 300, 45000);
  const m = /try again in ([\d.]+)s/i.exec(String(msg || ''));
  if (m) return Math.min(Math.ceil(parseFloat(m[1]) * 1000) + 400, 45000);
  const reset = /reset-tokens[^0-9]*([\d.]+)s/i.exec(String(res.headers.get('x-ratelimit-reset-tokens') || ''));
  if (reset) return Math.min(Math.ceil(parseFloat(reset[1]) * 1000) + 400, 45000);
  return 8000;
}

async function geminiChat({ messages, tools, maxTokens, temperature, timeoutMs }) {
  const key = geminiKey();
  const model = await geminiModel();
  if (!key || !model) return { ok: false, status: 0, error: 'Gemini is not configured' };
  const { systemText, contents } = toGeminiContents(messages);
  const body = { contents, generationConfig: {} };
  if (systemText) body.systemInstruction = { parts: [{ text: systemText }] };
  if (Number.isFinite(maxTokens)) body.generationConfig.maxOutputTokens = maxTokens;
  if (Number.isFinite(temperature)) body.generationConfig.temperature = temperature;
  // Flash models spend the output budget on hidden reasoning by default, which
  // turns a 700-token answer into a truncated one. Ask them not to.
  if (thinkingAllowed) body.generationConfig.thinkingConfig = { thinkingBudget: 0 };
  if (tools && tools.length) {
    const declarations = tools.map((t) => {
      const fn = (t && t.function) || {};
      const decl = { name: fn.name, description: fn.description || fn.name };
      const params = fn.parameters ? toGeminiSchema(fn.parameters) : null;
      if (params && params.properties && Object.keys(params.properties).length) decl.parameters = params;
      return decl;
    });
    body.tools = [{ functionDeclarations: declarations }];
  }
  let res, data;
  try {
    res = await fetch(`${GEMINI_BASE}/models/${encodeURIComponent(model)}:generateContent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs || 90000)
    });
    data = await res.json().catch(() => ({}));
  } catch (e) {
    return { ok: false, status: 0, error: String(e.message || e).slice(0, 200) };
  }
  if (!res.ok) {
    const msg = String((data.error && data.error.message) || 'Gemini request failed');
    if (res.status === 400 && /thinking/i.test(msg) && thinkingAllowed) {
      thinkingAllowed = false; // this model does not take a thinking budget
      return geminiChat({ messages, tools, maxTokens, temperature, timeoutMs });
    }
    return { ok: false, status: res.status, error: msg.slice(0, 300), wait: waitFrom(res, msg) };
  }
  const cand = (data.candidates || [])[0] || {};
  const parts = (cand.content && cand.content.parts) || [];
  const text = parts.filter((p) => typeof p.text === 'string').map((p) => p.text).join('').trim();
  const calls = parts
    .filter((p) => p.functionCall && p.functionCall.name)
    .map((p) => ({ id: 'gm_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8), name: p.functionCall.name, args: p.functionCall.args || {} }));
  const blocked = cand.finishReason === 'SAFETY' || cand.finishReason === 'PROHIBITED_CONTENT';
  if (!text && !calls.length) {
    return { ok: false, status: 200, error: blocked ? 'Gemini blocked that reply (safety)' : 'Gemini returned an empty message', provider: 'gemini' };
  }
  return { ok: true, status: res.status, text, calls, provider: 'gemini', model };
}

async function groqChat({ key, model, messages, tools, maxTokens, temperature, timeoutMs }) {
  if (!key || !String(key).startsWith('gsk_')) return { ok: false, status: 0, error: 'Groq is not configured' };
  const payload = {
    model,
    messages: toGroqMessages(messages),
    temperature: Number.isFinite(temperature) ? temperature : 0.7,
    max_tokens: Number.isFinite(maxTokens) ? maxTokens : 700
  };
  if (tools && tools.length) { payload.tools = tools; payload.tool_choice = 'auto'; }
  let res, data;
  try {
    res = await fetch(GROQ_URL, {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + key, 'Content-Type': 'application/json', 'User-Agent': 'AgentX/1.0' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(timeoutMs || 90000)
    });
    data = await res.json().catch(() => ({}));
  } catch (e) {
    return { ok: false, status: 0, error: String(e.message || e).slice(0, 200) };
  }
  if (!res.ok) {
    const msg = String((data.error && data.error.message) || 'Groq request failed');
    return { ok: false, status: res.status, error: msg.slice(0, 300), wait: waitFrom(res, msg) };
  }
  const msg = (data.choices && data.choices[0] && data.choices[0].message) || {};
  const text = String(msg.content || '').trim();
  const calls = (msg.tool_calls || []).map((c) => {
    let args = {};
    try { args = JSON.parse((c.function && c.function.arguments) || '{}'); } catch (e) { args = {}; }
    return { id: c.id, name: c.function && c.function.name, args };
  }).filter((c) => c.name);
  return { ok: true, status: res.status, text, calls, provider: 'groq', model };
}

// Gemini first, Groq second. A provider that is down or over its budget should
// never be the reason a message goes unanswered.
async function chat(opts) {
  const attempts = [];
  if (await geminiReady()) {
    const g = await geminiChat(opts);
    if (g.ok) return g;
    attempts.push({ provider: 'gemini', status: g.status, error: g.error });
    if (g.status === 400) return g; // a malformed request will fail on Groq too
  }
  const gq = await groqChat(opts);
  if (gq.ok) return gq;
  attempts.push({ provider: 'groq', status: gq.status, error: gq.error });
  const last = attempts[attempts.length - 1] || {};
  return { ok: false, status: last.status || 0, error: last.error || 'No model provider available', attempts, wait: gq.wait };
}

async function status() {
  const model = await geminiModel();
  return {
    gemini: { configured: Boolean(geminiKey()), model: model || null },
    groq: { configured: Boolean(String(process.env.GROQ_API_KEY || '').trim()) }
  };
}

module.exports = { chat, geminiChat, groqChat, geminiReady, geminiModel, status, toGeminiContents, toGeminiSchema, toGroqMessages };
