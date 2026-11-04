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

let modelListCache = [];   // every model the key can use, best first
let modelCheckedAt = 0;
const deadModels = new Set(); // models the API has told us it will not serve
let thinkingAllowed = true;  // set false the first time a model rejects thinkingConfig

function geminiKey() {
  return String(process.env.GEMINI_API_KEY || '').trim();
}

// A version number out of the model name, so the newest flash beats an older one.
function versionOf(name) {
  const nums = String(name).match(/\d+(?:\.\d+)?/g) || ['0'];
  return Math.max(...nums.map(Number));
}

// A plain chat model, newest first, is what we want: a preview or special-purpose
// model that happens to sort high is not a better default.
function rankModel(name) {
  const n = String(name).toLowerCase();
  const version = versionOf(n);
  if (/preview|exp\b|antigravity|thinking|customtools|vision/.test(n)) return 9000 - version / 1000;
  if (/^gemini-[\d.]+-flash$/.test(n) || /-flash$/.test(n)) return 1000 - version / 1000;
  if (/-flash-lite$/.test(n)) return 2000 - version / 1000;
  if (/-pro$/.test(n)) return 3000 - version / 1000;
  return 5000 - version / 1000;
}

// A model that refuses systemInstruction can still answer if the instructions are
// folded into the first user turn.
const noSystemModels = new Set();

// Model names come and go (a key can still list a model that new users may no
// longer call), so nothing is hard-coded: ask the key what it can use, and fall
// through the list until one answers.
async function geminiModels(refresh) {
  const forced = String(process.env.GEMINI_MODEL || '').trim();
  if (forced) return [forced];
  if (modelListCache.length && !refresh) return modelListCache;
  if (!refresh && Date.now() - modelCheckedAt < 10 * 60 * 1000) return modelListCache;
  modelCheckedAt = Date.now();
  const key = geminiKey();
  if (!key) return [];
  try {
    const r = await fetch(GEMINI_BASE + '/models?key=' + encodeURIComponent(key), { signal: AbortSignal.timeout(15000) });
    const d = await r.json().catch(() => ({}));
    const names = (d.models || [])
      .filter((m) => (m.supportedGenerationMethods || []).includes('generateContent'))
      .map((m) => String(m.name || '').replace(/^models\//, ''))
      .filter((n) => n && !/image|tts|audio|live|embedding|aqa|veo|imagen/i.test(n));
    if (names.length) modelListCache = names.sort((a, b) => rankModel(a) - rankModel(b));
  } catch (e) {
    // keep whatever we had
  }
  return modelListCache;
}

const busyUntil = new Map(); // model -> time it is worth trying again
const QUOTA = /quota|rate limit|rateLimitExceeded|RESOURCE_EXHAUSTED|exceeded your current quota|per day|billing/i;

async function geminiModel() {
  const list = await geminiModels(false);
  const now = Date.now();
  const live = list.filter((m) => !deadModels.has(m));
  return live.find((m) => !(busyUntil.get(m) > now)) || live[0] || null;
}

// Out of quota for the day: answer from the other provider now rather than making
// the person wait through five models that will all say the same thing.
function parkForQuota(model) {
  busyUntil.set(model, Date.now() + 15 * 60 * 1000);
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
      // Gemini 3 signs its function calls and rejects a replay without the
      // signature, so keep its own parts verbatim when they came from Gemini.
      if (Array.isArray(m.provider_parts) && m.provider_parts.length) {
        contents.push({ role: 'model', parts: m.provider_parts });
        continue;
      }
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

function toGroqMessages(messages, hasTools) {
  return messages.map((m) => {
    if (!m) return m;
    // Groq rejects a request whose history holds tool calls when the request
    // declares no tools, so those turns become plain text.
    if (!hasTools && m.role === 'assistant' && m.tool_calls && m.tool_calls.length) {
      const used = m.tool_calls.map((c) => c.name + '(' + JSON.stringify(c.args || {}) + ')').join(', ');
      return { role: 'assistant', content: [String(m.content || '').trim(), 'Called ' + used].filter(Boolean).join('\n') };
    }
    if (!hasTools && m.role === 'tool') {
      return { role: 'user', content: 'Result of ' + (m.name || 'lookup') + ': ' + String(m.content || '') };
    }
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

async function geminiOnce({ key, model, messages, tools, maxTokens, temperature, timeoutMs }) {
  const conv = toGeminiContents(messages);
  const contents = conv.contents;
  const body = { contents, generationConfig: {} };
  if (conv.systemText) {
    if (noSystemModels.has(model)) {
      // Fold the instructions into the first user turn instead.
      const first = contents.find((c) => c.role === 'user') || contents[0];
      first.parts = [{ text: conv.systemText + '\n\n' + first.parts.map((p) => p.text || '').join('\n') }];
    } else {
      body.systemInstruction = { parts: [{ text: conv.systemText }] };
    }
  }
  const toolRound = Boolean(tools && tools.length);
  // A tool round needs room for hidden reasoning plus the answer, because keeping
  // thinking on is what makes the model sign its function calls.
  if (Number.isFinite(maxTokens)) body.generationConfig.maxOutputTokens = toolRound ? Math.max(maxTokens, 2048) : maxTokens;
  if (Number.isFinite(temperature)) body.generationConfig.temperature = temperature;
  // Flash models spend the output budget on hidden reasoning by default, which
  // turns a 700-token answer into a truncated one. Ask them not to - except when
  // tools are declared: Gemini 3 only issues thought signatures while thinking,
  // and it rejects a replayed function call that has none.
  if (thinkingAllowed && !toolRound) body.generationConfig.thinkingConfig = { thinkingBudget: 0 };
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
    if (res.status === 400 && /developer instruction|system instruction/i.test(msg) && !noSystemModels.has(model)) {
      noSystemModels.add(model); // answer without a separate system turn
      return geminiOnce({ key, model, messages, tools, maxTokens, temperature, timeoutMs });
    }
    if (res.status === 400 && /thinking/i.test(msg) && thinkingAllowed) {
      thinkingAllowed = false; // this model does not take a thinking budget
      return geminiOnce({ key, model, messages, tools, maxTokens, temperature, timeoutMs });
    }
    if (res.status === 400 && /thought_signature/i.test(msg) && body.generationConfig.thinkingConfig) {
      // Some models insist on signing tool calls; answer this round with thinking on.
      delete body.generationConfig.thinkingConfig;
      body.generationConfig.maxOutputTokens = Math.max(Number(body.generationConfig.maxOutputTokens) || 0, 2048);
      return geminiOnce({ key, model, messages, tools, maxTokens: body.generationConfig.maxOutputTokens, temperature, timeoutMs });
    }
    const quota = res.status === 429 || QUOTA.test(msg);
    if (quota) parkForQuota(model);
    return { ok: false, status: res.status, error: msg.slice(0, 300), wait: waitFrom(res, msg), quota };
  }
  const cand = (data.candidates || [])[0] || {};
  const parts = (cand.content && cand.content.parts) || [];
  const text = parts.filter((p) => typeof p.text === 'string' && !p.thought).map((p) => p.text).join('').trim();
  const calls = parts
    .filter((p) => p.functionCall && p.functionCall.name)
    .map((p) => ({ id: 'gm_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8), name: p.functionCall.name, args: p.functionCall.args || {} }));
  const rawParts = Array.isArray(parts) ? JSON.parse(JSON.stringify(parts)) : [];
  const blocked = cand.finishReason === 'SAFETY' || cand.finishReason === 'PROHIBITED_CONTENT';
  if (!text && !calls.length) {
    return { ok: false, status: 200, error: blocked ? 'Gemini blocked that reply (safety)' : 'Gemini returned an empty message', provider: 'gemini' };
  }
  return { ok: true, status: res.status, text, calls, provider_parts: calls.length ? rawParts : null, provider: 'gemini', model };
}

const RETIRED = /no longer available|not available to new users|not found|not supported for generateContent|deprecated|does not support/i;
const OVERLOADED = /high demand|overloaded|unavailable|try again later|temporarily/i;
const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

// Put a model that is currently overloaded at the back of the queue, keeping it
// available for later instead of retiring it.
function rotateModel(model) {
  busyUntil.set(model, Date.now() + 3 * 60 * 1000);
}

async function geminiChat(opts) {
  const key = geminiKey();
  if (!key) return { ok: false, status: 0, error: 'Gemini is not configured' };
  const tried = [];
  for (let i = 0; i < 5; i++) {
    const model = await geminiModel();
    if (!model) return { ok: false, status: 0, error: 'No Gemini model on this key can be used', tried };
    const out = await geminiOnce({ ...opts, key, model });
    if (out.ok) return out;
    const msg = String(out.error || '');
    if (out.quota) return { ...out, tried: tried.concat(model + ' (out of quota)') };
    if (out.status === 400 && RETIRED.test(msg)) {
      deadModels.add(model);
      tried.push(model + ' (retired)');
      // Gemini often names its replacement in the message; use it first next time.
      const rec = /models\/([A-Za-z0-9._-]+)/.exec(msg);
      if (rec && !deadModels.has(rec[1]) && !modelListCache.includes(rec[1])) {
        modelListCache = [rec[1]].concat(modelListCache.filter((m) => m !== rec[1]));
      }
      await geminiModels(true);
      continue;
    }
    // A busy model is worth routing around rather than failing the user's message.
    if (out.status >= 500 || OVERLOADED.test(msg)) {
      rotateModel(model);
      tried.push(model + ' (busy)');
      if (i < 3) { await sleep(600 + i * 900); continue; }
      return { ...out, tried };
    }
    return { ...out, tried };
  }
  return { ok: false, status: 0, error: 'Every Gemini model is busy right now', tried };
}

async function groqChat({ key, model, messages, tools, maxTokens, temperature, timeoutMs }) {
  if (!key || !String(key).startsWith('gsk_')) return { ok: false, status: 0, error: 'Groq is not configured' };
  const payload = {
    model,
    messages: toGroqMessages(messages, Boolean(tools && tools.length)),
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
    let g = await geminiChat(opts);
    if (!g.ok && (g.status >= 500 || OVERLOADED.test(String(g.error || '')))) {
      await sleep(2500); // one more go on Gemini before dropping to the other lane
      g = await geminiChat(opts);
    }
    if (g.ok) return g;
    attempts.push({ provider: 'gemini', status: g.status, error: g.error, tried: g.tried });
    // A Gemini-only complaint (an unsigned function call, a rejected field) is not
    // a broken request for Groq, so the other lane still gets its turn.
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

// Why the primary lane is or is not being used, readable from one endpoint.
async function diagnostics() {
  const key = Boolean(geminiKey());
  const list = await geminiModels(true).catch(() => []);
  const now = Date.now();
  const parked = {};
  for (const [m, t] of busyUntil) if (t > now) parked[m] = Math.round((t - now) / 1000) + 's';
  return {
    gemini: {
      key,
      models: list,
      dead: [...deadModels],
      parked,
      ready: Boolean(key && list.some((m) => !deadModels.has(m)))
    },
    groq: Boolean(String(process.env.GROQ_API_KEY || '').trim())
  };
}

module.exports = { chat, geminiChat, groqChat, geminiReady, geminiModel, geminiModels, status, diagnostics, toGeminiContents, toGeminiSchema, toGroqMessages };
