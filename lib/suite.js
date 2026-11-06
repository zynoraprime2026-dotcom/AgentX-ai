// AgentX feature suite: language + personality prompts, knowledge base, FAQ,
// reminders, analytics, voice, triggers (event-driven messages) and billing.
//
// Mounted once from server.js with `suite.attach({ api, db, groqAsk })`.
const crypto = require('crypto');
const docs = require('./docs');
const { extract } = require('./extract');

const GROQ_CHAT = 'https://api.groq.com/openai/v1/chat/completions';
const state = { api: null, db: null, send: null, ticker: null, ticking: false, lastTick: null };

// ---------- small helpers ----------
const uid = (p) => p + '_' + crypto.randomBytes(5).toString('hex');
const nowIso = () => new Date().toISOString();

function oneLine(s, max) {
  return String(s == null ? '' : s).replace(/\s+/g, ' ').trim().slice(0, max || 200);
}

// Orpheus streams WAV with placeholder lengths (0xFFFFFFFF), which leaves browsers
// unable to report a duration. Rewrite the real sizes before handing it out.
function fixWav(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 44) return buf;
  if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') return buf;
  const out = Buffer.from(buf);
  out.writeUInt32LE(out.length - 8, 4);
  let p = 12;
  while (p + 8 <= out.length) {
    const id = out.toString('ascii', p, p + 4);
    const size = out.readUInt32LE(p + 4);
    if (id === 'data') {
      const real = out.length - (p + 8);
      if (size !== real) out.writeUInt32LE(real, p + 4);
      break;
    }
    p += 8 + size + (size % 2);
    if (!Number.isFinite(p) || size > out.length) break;
  }
  return out;
}

async function getKey() {
  const st = await state.db.getSettings();
  const k = (st.groqApiKey && st.groqApiKey.startsWith('gsk_')) ? st.groqApiKey : (process.env.GROQ_API_KEY || '');
  return k.startsWith('gsk_') ? k : '';
}

async function llm(system, user, opts) {
  const key = await getKey();
  if (!key) throw new Error('Groq API key is not configured');
  const o = opts || {};
  const r = await fetch(GROQ_CHAT, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json', 'User-Agent': 'AgentX/1.0' },
    body: JSON.stringify({
      model: o.model || 'openai/gpt-oss-20b',
      messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
      temperature: o.temperature == null ? 0.4 : o.temperature,
      max_tokens: o.maxTokens || 700
    })
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error((d.error && d.error.message) || 'model request failed');
  return String((d.choices && d.choices[0] && d.choices[0].message && d.choices[0].message.content) || '').trim();
}

// Models do not always honour "return only a JSON array": they wrap it in prose,
// use markdown fences, or answer as Q/A lines. Try each shape before giving up.
function parseFaqItems(out) {
  const txt = String(out || '').trim();
  if (!txt) return [];
  const shapes = [];
  const first = txt.indexOf('[');
  const last = txt.lastIndexOf(']');
  if (first !== -1 && last > first) shapes.push(txt.slice(first, last + 1));
  shapes.push(txt, txt.replace(/^```(?:json)?/i, '').replace(/```$/, '').trim());
  for (const shape of shapes) {
    try {
      const arr = JSON.parse(shape);
      if (Array.isArray(arr)) return arr.filter((x) => x && x.q && x.a);
    } catch (e) { /* try the next shape */ }
  }
  const items = [];
  const re = /(?:^|\n)\s*(?:Q\d*\s*[:.)-]|\d+\s*[.)])\s*([\s\S]*?)\s*(?:\n+\s*(?:A\d*\s*[:.)-]))\s*([\s\S]*?)(?=\n\s*(?:Q\d*\s*[:.)-]|\d+\s*[.)])|\n*$)/gi;
  let m;
  while ((m = re.exec(txt))) {
    if (m[1] && m[2]) items.push({ q: m[1], a: m[2] });
  }
  return items;
}

async function ownAgent(req, id) {
  const agents = await state.db.listAgents();
  return agents.find((a) => a.id === id && a.ownerId === req.user.id) || null;
}

// ---------- personality + language prompt ----------
const TONES = {
  1: 'Formal and precise. Complete sentences, no slang, no exclamation marks.',
  2: 'Polite and professional, with the occasional warm turn of phrase.',
  3: 'Friendly and natural, contractions welcome, plain words.',
  4: 'Warm and conversational, like a helpful friend who knows the subject well.',
  5: 'Casual and lively, short sentences, light humour when it fits the moment.'
};
const DEPTH = {
  1: 'Answer in the fewest words that fully answer. No preamble, no recap.',
  2: 'Answer briefly, then add one clarifying detail if it helps.',
  3: 'Answer clearly with the reasoning that matters, then stop.',
  4: 'Teach: answer, then the evidence or step-by-step behind it.',
  5: 'Go deep: context, evidence, caveats and a short worked example.'
};
const LANG_NAMES = {
  en: 'English', ar: 'Arabic', fr: 'French', ha: 'Hausa', tw: 'Twi', wo: 'Wolof',
  sw: 'Swahili', ur: 'Urdu', ms: 'Malay', id: 'Indonesian', tr: 'Turkish', so: 'Somali'
};

function detectLanguage(text) {
  const t = String(text || '');
  if (/[\u0600-\u06FF]/.test(t)) return 'ar';
  const words = t.toLowerCase().split(/[^a-zà-ÿ']+/).filter(Boolean);
  const hits = {
    fr: ['bonjour', 'merci', 'comment', 'vous', 'est-ce', 'je', 'pour', 'avec', 'prière', 'quelle'],
    ha: ['sannu', 'yaya', 'nagode', 'domin', 'ina', 'kai', 'muna', 'allah'],
    tw: ['ete sen', 'medaase', 'wo ho', 'me ho', 'yɛ', 'akwaaba'],
    sw: ['habari', 'asante', 'tafadhali', 'vipi', 'mimi', 'wewe'],
    wo: ['nanga def', 'jerejef', 'salaam', 'baax']
  };
  let best = 'en', score = 0;
  for (const [lang, list] of Object.entries(hits)) {
    const n = words.filter((w) => list.includes(w)).length;
    if (n > score) { best = lang; score = n; }
  }
  return score > 0 ? best : 'en';
}

function personaBlock(agent) {
  const p = agent.persona || {};
  const out = [];
  const tone = Math.min(5, Math.max(1, Number(p.tone) || 3));
  const depth = Math.min(5, Math.max(1, Number(p.depth) || 3));
  out.push('STYLE (follow exactly): ' + TONES[tone]);
  out.push('LENGTH (follow exactly): ' + DEPTH[depth]);
  if (p.preset) out.push('Persona preset: ' + oneLine(p.preset, 40) + '.');
  if (p.signoff) out.push('Close with: ' + oneLine(p.signoff, 60));
  if (p.noHumor) out.push('Never use humour or emoji.');
  return out.join('\n');
}

function languageBlock(agent, userText) {
  const langs = Array.isArray(agent.languages) ? agent.languages.filter((l) => LANG_NAMES[l]) : [];
  const auto = agent.autoLanguage !== false;
  const detected = detectLanguage(userText);
  const lines = [];
  if (auto) {
    lines.push('LANGUAGE: reply in the language the user writes in. If they switch, switch with them. Never translate your answer back into English unless asked.');
    if (langs.length) lines.push('Languages this agent is expected to serve: ' + langs.map((l) => LANG_NAMES[l]).join(', ') + '.');
    lines.push('The latest message looks like ' + LANG_NAMES[detected] + '.');
  } else if (langs.length) {
    lines.push('LANGUAGE: always reply in ' + LANG_NAMES[langs[0]] + ' unless the user explicitly asks for another language.');
  }
  return lines.join('\n');
}

function channelBlock(agent, opts) {
  const o = opts || {};
  const lines = [];
  if (o.channel === 'whatsapp') lines.push('CHANNEL: WhatsApp. Keep answers under 900 characters, use *single asterisks* for bold, never markdown headings or tables.');
  if (o.channel === 'telegram') lines.push('CHANNEL: Telegram. Markdown is fine but keep answers compact; no tables.');
  if (o.isGroup) {
    lines.push('GROUP CHAT: you were mentioned in a group. Answer only the question addressed to you, skip greetings aimed at the whole group, and keep it to a few lines. Do not repeat what other members said.');
  }
  return lines.join('\n');
}

// ---------- knowledge base ----------
const CHUNK = 850;

function chunk(text) {
  const out = [];
  const paras = String(text || '').split(/\n{2,}/);
  let buf = '';
  for (const p of paras) {
    if ((buf + '\n\n' + p).length > CHUNK && buf) { out.push(buf.trim()); buf = p; }
    else buf = buf ? buf + '\n\n' + p : p;
  }
  if (buf.trim()) out.push(buf.trim());
  // very long single paragraphs
  return out.flatMap((c) => (c.length <= CHUNK * 1.6 ? [c] : c.match(new RegExp('[\\s\\S]{1,' + CHUNK + '}(?!\\S)', 'g')) || [c]));
}

const STOP = new Set('the and for you your with that this from have has are was were will would can could should what when where who how why not but they them their there here about into over under then than also just only very much many some any all our out its it\'s i you we he she'.split(/\s+/));

function tokens(s) {
  return String(s || '').toLowerCase().match(/[a-zà-ÿ0-9']{3,}/g)?.filter((w) => !STOP.has(w)) || [];
}

async function knowledgeDocs(agentId) {
  return docs.list('knowledge', { agentId });
}

async function retrieve(agentId, query, budget) {
  const q = new Set(tokens(query));
  if (!q.size) return '';
  const scored = [];
  for (const doc of await knowledgeDocs(agentId)) {
    (doc.chunks || []).forEach((text, i) => {
      const words = tokens(text);
      if (!words.length) return;
      const set = new Set(words);
      let hit = 0;
      for (const t of q) if (set.has(t)) hit++;
      if (!hit) return;
      scored.push({ score: hit / Math.sqrt(words.length / 40 + 1), title: doc.title, text, i });
    });
  }
  scored.sort((a, b) => b.score - a.score);
  let out = '', used = 0, taken = 0;
  for (const s of scored) {
    if (taken >= 3 || used + s.text.length > (budget || 1500)) break;
    out += (out ? '\n\n' : '') + '[' + s.title + ']\n' + s.text;
    used += s.text.length;
    taken++;
  }
  return out;
}

async function promptExtras(agent, opts) {
  const o = opts || {};
  const parts = [personaBlock(agent), languageBlock(agent, o.query), channelBlock(agent, o)];
  if (agent.knowledgeEnabled !== false) {
    try {
      const kb = o.query ? await retrieve(agent.id, o.query, 900) : '';
      if (kb) parts.push('KNOWLEDGE BASE — the owner uploaded these files. Prefer them over your own memory, quote them plainly, and if they conflict with your general knowledge say which you are using:\n' + kb);
      const faqs = (await knowledgeDocs(agent.id)).filter((d) => d.kind === 'faq').flatMap((d) => d.items || []);
      if (faqs.length && o.query) {
        const q = new Set(tokens(o.query));
        const best = faqs.map((f) => ({ f, s: tokens(f.q + ' ' + f.a).filter((t) => q.has(t)).length }))
          .filter((x) => x.s > 0).sort((a, b) => b.s - a.s).slice(0, 2);
        if (best.length) parts.push('KNOWN FAQ ANSWERS (reuse the wording where it fits):\n' + best.map((b) => 'Q: ' + b.f.q + '\nA: ' + b.f.a).join('\n'));
      }
    } catch (e) { /* knowledge is best-effort */ }
  }
  return parts.filter(Boolean).join('\n\n');
}

// ---------- analytics ----------
function dayKey(d) { return new Date(d || Date.now()).toISOString().slice(0, 10); }

async function logEvent(ev) {
  try {
    const at = nowIso();
    await docs.put('events', Object.assign({
      id: uid('ev'), at, day: dayKey(at), channel: 'web', kind: 'message'
    }, ev, { at, day: dayKey(at) }));
  } catch (e) { console.log('[analytics]', String(e).slice(0, 120)); }
}

async function summary(ownerId, days) {
  const span = Math.min(120, Math.max(1, Number(days) || 14));
  const from = new Date(Date.now() - (span - 1) * 864e5).toISOString().slice(0, 10);
  const events = (await docs.list('events', { ownerId })).filter((e) => e.day >= from);
  const byDay = {}, byAgent = {}, byChannel = {}, queries = {};
  let msgs = 0, replies = 0, errors = 0, latency = 0, latencyN = 0;
  for (const e of events) {
    byDay[e.day] = byDay[e.day] || { day: e.day, messages: 0, replies: 0, errors: 0 };
    if (e.kind === 'message') { msgs++; byDay[e.day].messages++; }
    else if (e.kind === 'reply') {
      replies++; byDay[e.day].replies++;
      if (typeof e.latency === 'number') { latency += e.latency; latencyN++; }
      if (e.query) {
        const key = oneLine(e.query, 80).toLowerCase().replace(/[?!.]+$/, '');
        if (key.length > 2) queries[key] = (queries[key] || 0) + 1;
      }
    } else if (e.kind === 'error') { errors++; byDay[e.day].errors++; }
    const a = (byAgent[e.agentId] = byAgent[e.agentId] || { agentId: e.agentId, name: e.agentName || e.agentId, messages: 0, replies: 0, errors: 0, latency: 0, latencyN: 0 });
    if (e.kind === 'message') a.messages++;
    if (e.kind === 'reply') { a.replies++; if (typeof e.latency === 'number') { a.latency += e.latency; a.latencyN++; } }
    if (e.kind === 'error') a.errors++;
    const c = (byChannel[e.channel || 'web'] = byChannel[e.channel || 'web'] || { channel: e.channel || 'web', messages: 0, replies: 0 });
    if (e.kind === 'message') c.messages++;
    if (e.kind === 'reply') c.replies++;
  }
  const series = [];
  for (let i = span - 1; i >= 0; i--) {
    const day = new Date(Date.now() - i * 864e5).toISOString().slice(0, 10);
    series.push(byDay[day] || { day, messages: 0, replies: 0, errors: 0 });
  }
  const agentRows = Object.values(byAgent).map((a) => ({
    ...a, avgLatency: a.latencyN ? Math.round(a.latency / a.latencyN) : null
  })).sort((a, b) => b.messages - a.messages);
  return {
    window: { days: span, from, to: dayKey() },
    totals: {
      messages: msgs, replies, errors,
      avgLatencyMs: latencyN ? Math.round(latency / latencyN) : null,
      activeAgents: agentRows.filter((a) => a.messages).length,
      replyRate: msgs ? Math.round((replies / msgs) * 100) : 0
    },
    series, agents: agentRows,
    channels: Object.values(byChannel).sort((a, b) => b.messages - a.messages),
    topQueries: Object.entries(queries).sort((a, b) => b[1] - a[1]).slice(0, 12).map(([query, count]) => ({ query, count }))
  };
}

// ---------- reminders + triggers tick ----------
function nextDue(iso, repeat) {
  const d = new Date(iso);
  if (isNaN(d)) return null;
  const now = Date.now();
  const step = repeat === 'weekly' ? 7 : repeat === 'daily' ? 1 : 0;
  if (!step) return null;
  let guard = 0;
  while (d.getTime() <= now && guard++ < 400) d.setDate(d.getDate() + step);
  return d.toISOString();
}

async function deliver(channel, chatId, text, agentId) {
  if (!chatId) throw new Error('no destination chat for this message');
  if (channel === 'telegram' && !process.env.TELEGRAM_BOT_TOKEN) throw new Error('Telegram is not connected on this server');
  if (channel === 'whatsapp' && !(process.env.WHATSAPP_PHONE_NUMBER_ID && process.env.WHATSAPP_ACCESS_TOKEN)) throw new Error('WhatsApp is not connected on this server');
  if (state.send) return state.send(channel, chatId, text, agentId);
  throw new Error('no delivery channel available');
}

async function runReminders(ownerFilter) {
  const all = await docs.list('reminders');
  const due = all.filter((r) => r.status === 'pending' && new Date(r.dueAt).getTime() <= Date.now() && (!ownerFilter || r.ownerId === ownerFilter));
  const results = [];
  for (const r of due) {
    try {
      await deliver(r.channel, r.chatId, r.message, r.agentId);
      const next = nextDue(r.dueAt, r.repeat);
      await docs.put('reminders', { ...r, status: next ? 'pending' : 'sent', dueAt: next || r.dueAt, sentAt: nowIso(), lastSentAt: nowIso() });
      results.push({ id: r.id, sent: true, next });
      await logEvent({ ownerId: r.ownerId, agentId: r.agentId, agentName: r.agentName, channel: r.channel, kind: 'reply', query: 'reminder: ' + oneLine(r.title, 60) });
    } catch (e) {
      const attempts = (Number(r.attempts) || 0) + 1;
      const retry = attempts < 3;
      await docs.put('reminders', {
        ...r, attempts,
        status: retry ? 'pending' : 'failed',
        dueAt: retry ? new Date(Date.now() + 5 * 60e3).toISOString() : r.dueAt,
        error: oneLine(e.message, 200), failedAt: retry ? undefined : nowIso(), lastTriedAt: nowIso()
      });
      results.push({ id: r.id, error: oneLine(e.message, 160), retry });
    }
  }
  return results;
}

const net = require('net');
const dnsPromises = require('dns').promises;

function isPrivateAddress(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  const v = String(ip).toLowerCase();
  return v === '::1' || v === '::' || v.startsWith('fc') || v.startsWith('fd') || v.startsWith('fe80') || v.startsWith('::ffff:127') || v.startsWith('::ffff:169.254');
}

// A trigger fetches a URL the owner types in. It must not be able to read the
// host's own network (cloud metadata, localhost, other services on the box), so
// the address is checked when it is saved and again on every poll.
async function assertPublicUrl(raw) {
  let u;
  try { u = new URL(String(raw || '').trim()); } catch (e) { throw new Error('that is not a valid URL'); }
  if (!/^https?:$/.test(u.protocol)) throw new Error('only http and https sources are allowed');
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (/^(localhost|.*\.local|.*\.internal|.*\.localhost)$/i.test(host)) throw new Error('that host is not reachable from here');
  let addrs;
  if (net.isIP(host)) addrs = [host];
  else {
    try { addrs = (await dnsPromises.lookup(host, { all: true })).map((a) => a.address); }
    catch (e) { throw new Error('that host did not resolve'); }
  }
  if (!addrs.length) throw new Error('that host did not resolve');
  if (addrs.some(isPrivateAddress)) throw new Error('that address points inside the network, so it is not allowed');
  return u.toString();
}

function pickPath(obj, pathStr) {
  if (!pathStr) return obj;
  return String(pathStr).split('.').reduce((o, k) => {
    if (o == null) return undefined;
    const m = /^(.*)\[(\d+)\]$/.exec(k);
    if (m) { const base = o[m[1]]; return base ? base[Number(m[2])] : undefined; }
    return o[k];
  }, obj);
}

// Plenty of real JSON APIs answer the first request with a redirect (Aladhan sends
// you to a date-stamped timings URL, for instance). Following redirects is what makes
// those usable, but each hop is a fresh URL the owner did not type, so every hop goes
// through assertPublicUrl again - otherwise a public source could bounce the poller
// into localhost or the metadata endpoint.
async function fetchJsonSource(rawUrl) {
  let url = await assertPublicUrl(rawUrl);
  for (let hop = 0; hop < 4; hop += 1) {
    const r = await fetch(url, {
      headers: { 'User-Agent': 'AgentX/1.0', Accept: 'application/json' },
      signal: AbortSignal.timeout(15000),
      redirect: 'manual'
    });
    if (r.status >= 300 && r.status < 400) {
      const loc = r.headers.get('location');
      if (!loc) throw new Error('source redirected (HTTP ' + r.status + ') without a location');
      let next;
      try { next = new URL(loc, url).toString(); } catch (e) { throw new Error('source redirected to an invalid URL'); }
      url = await assertPublicUrl(next);
      continue;
    }
    const body = await r.json().catch(() => null);
    if (!r.ok || body == null) throw new Error('source returned ' + r.status);
    return body;
  }
  throw new Error('source redirected too many times');
}

async function fireTrigger(t, value, previous) {
  const agent = (await state.db.listAgents()).find((a) => a.id === t.agentId) || null;
  let message = '';
  const changed = JSON.stringify(value) !== JSON.stringify(previous);
  try {
    const system = 'You write one short push notification for a chat subscriber. 2 sentences maximum, no markdown headings, no invented facts. Use the data you are given.';
    const user = [
      t.name ? 'Trigger: ' + t.name : '',
      t.prompt ? 'Instruction: ' + t.prompt : '',
      'Current value: ' + JSON.stringify(value).slice(0, 1200),
      previous === undefined ? '' : 'Previous value: ' + JSON.stringify(previous).slice(0, 600),
      agent ? 'Persona: ' + (agent.persona && agent.persona.preset ? agent.persona.preset : 'helpful assistant') : ''
    ].filter(Boolean).join('\n');
    message = await llm(system, user, { maxTokens: 220 });
  } catch (e) {
    message = (t.name || 'Update') + ': ' + String(JSON.stringify(value)).slice(0, 300);
  }
  await deliver(t.channel, t.chatId, message, t.agentId);
  await docs.put('triggers', { ...t, lastRunAt: nowIso(), lastValue: value, lastMessage: oneLine(message, 400), runs: (t.runs || 0) + 1, changed });
  await logEvent({ ownerId: t.ownerId, agentId: t.agentId, agentName: t.agentName, channel: t.channel, kind: 'reply', query: 'trigger: ' + oneLine(t.name, 60) });
  return { id: t.id, fired: true, changed, message };
}

function conditionMet(cond, prev, next) {
  if (!cond || cond === 'always') return true;
  if (cond === 'changed') return JSON.stringify(prev) !== JSON.stringify(next);
  const m = /^(>=|<=|>|<|==)\s*(-?\d+(?:\.\d+)?)$/.exec(String(cond).trim());
  if (!m) return true;
  const a = Number(next), b = Number(m[2]);
  if (isNaN(a)) return false;
  return { '>': a > b, '<': a < b, '>=': a >= b, '<=': a <= b, '==': a === b }[m[1]];
}

async function runTriggers(ownerFilter, forceId) {
  const all = (await docs.list('triggers')).filter((t) => t.active !== false && (!ownerFilter || t.ownerId === ownerFilter));
  const results = [];
  for (const t of all) {
    if (forceId && t.id !== forceId) continue;
    const interval = Math.max(5, Number(t.intervalMin) || 30);
    const last = t.lastCheckAt ? new Date(t.lastCheckAt).getTime() : 0;
    if (!forceId && Date.now() - last < interval * 60e3) continue;
    try {
      const body = await fetchJsonSource(t.url);
      const value = pickPath(body, t.jsonPath);
      await docs.put('triggers', { ...t, lastCheckAt: nowIso(), lastError: null, lastRaw: oneLine(JSON.stringify(value), 300) });
      if (conditionMet(t.condition, t.lastValue, value)) {
        results.push(await fireTrigger({ ...t, lastCheckAt: nowIso() }, value, t.lastValue));
      } else {
        results.push({ id: t.id, fired: false, value });
        await docs.put('triggers', { ...t, lastCheckAt: nowIso(), lastValue: value });
      }
    } catch (e) {
      await docs.put('triggers', { ...t, lastCheckAt: nowIso(), lastError: oneLine(e.message, 200) });
      results.push({ id: t.id, error: oneLine(e.message, 160) });
    }
  }
  return results;
}

// A 60-second ticker keeps a managed Postgres awake around the clock, which eats
// through Neon's free compute hours (~192/month vs ~730 hours in a month). So the
// ticker only touches the database when something can actually be due, and sleeps
// until the next reminder or the earliest trigger interval.
const TICK_SECONDS = Math.max(15, Number(process.env.AGX_TICK_SECONDS) || 60);
const IDLE_SECONDS = Math.max(TICK_SECONDS, Number(process.env.AGX_TICK_IDLE_SECONDS) || 900);

async function soonestWork() {
  const [rems, trgs] = await Promise.all([docs.list('reminders'), docs.list('triggers')]);
  let next = 0;
  for (const r of rems) {
    if (r.status !== 'pending') continue;
    const t = new Date(r.dueAt).getTime();
    if (!isNaN(t) && (!next || t < next)) next = t;
  }
  for (const t of trgs) {
    if (t.active === false) continue;
    const span = Math.max(5, Number(t.intervalMin) || 30) * 60e3;
    const due = (t.lastCheckAt ? new Date(t.lastCheckAt).getTime() : 0) + span;
    if (!next || due < next) next = due;
  }
  return next;
}

function wake() { state.wakeAt = 0; }

async function tick(opts) {
  const force = Boolean(opts && opts.force);
  if (state.ticking) {
    // A send or source fetch that never returns must not block every later tick.
    if (Date.now() - (state.tickingSince || 0) < 120e3) return { skipped: 'already running' };
    console.log('[tick] previous tick stalled, taking over');
  }
  if (!force && state.wakeAt && Date.now() < state.wakeAt) {
    return { skipped: 'idle', nextWakeAt: new Date(state.wakeAt).toISOString() };
  }
  state.ticking = true;
  state.tickingSince = Date.now();
  try {
    const reminders = await runReminders();
    const triggers = await runTriggers();
    const next = await soonestWork();
    const now = Date.now();
    const cap = now + IDLE_SECONDS * 1000;
    // Wake at the next due item, but never sleep longer than the idle window, and
    // never fall into a tight 5-second loop when nothing is due.
    state.wakeAt = next && next > now ? Math.min(next, cap) : cap;
    state.lastTick = { at: nowIso(), reminders, triggers, nextWakeAt: new Date(state.wakeAt).toISOString() };
    return state.lastTick;
  } finally {
    state.ticking = false;
  }
}


// ---------- quick reminders from chat ("/remind 30m drink water") ----------
function parseWhen(arg) {
  const m = /^(\d{1,4})\s*(m|min|mins|minutes|h|hr|hrs|hours|d|day|days)\b\s*([\s\S]*)$/i.exec(String(arg || '').trim());
  if (m) {
    const n = Number(m[1]);
    const unit = m[2].toLowerCase()[0];
    const ms = unit === 'm' ? n * 60e3 : unit === 'h' ? n * 3600e3 : n * 864e5;
    const rest = m[3].trim();
    if (rest) return { dueAt: new Date(Date.now() + ms).toISOString(), text: rest };
  }
  const t = /^(?:at\s+)?(\d{1,2}):(\d{2})\s*([\s\S]*)$/i.exec(String(arg || '').trim());
  if (t) {
    const d = new Date();
    d.setHours(Number(t[1]), Number(t[2]), 0, 0);
    if (d.getTime() <= Date.now()) d.setDate(d.getDate() + 1);
    return { dueAt: d.toISOString(), text: (t[3] || '').trim() };
  }
  return null;
}

async function quickReminder({ agent, channel, chatId, arg, ownerId }) {
  const parsed = parseWhen(arg);
  if (!parsed || !parsed.text) {
    return { ok: false, reply: 'Use: /remind 30m drink water — you can use minutes (m), hours (h), days (d) or a time like 07:30.' };
  }
  const owner = (agent && agent.ownerId) || ownerId || null;
  const doc = {
    id: uid('rem'), ownerId: owner, agentId: agent ? agent.id : null, agentName: agent ? agent.name : null,
    title: oneLine(parsed.text, 120), message: parsed.text.slice(0, 900),
    dueAt: parsed.dueAt, repeat: 'none', channel: channel === 'whatsapp' ? 'whatsapp' : 'telegram',
    chatId: String(chatId), status: 'pending', createdAt: nowIso()
  };
  await docs.put('reminders', doc);
  wake();
  const when = new Date(doc.dueAt);
  return { ok: true, reminder: doc, reply: 'Reminder set for ' + when.toISOString().slice(0, 16).replace('T', ' ') + ' UTC: ' + doc.title };
}

// ---------- shared transcription ----------
async function transcribeBuffer(buf, mime) {
  const key = await getKey();
  if (!key) throw new Error('Speech-to-text needs a Groq API key');
  const form = new FormData();
  const ext = String(mime || '').includes('ogg') ? 'ogg' : String(mime || '').includes('mp4') ? 'm4a' : 'webm';
  form.append('file', new Blob([buf], { type: mime || 'audio/ogg' }), 'audio.' + ext);
  form.append('model', 'whisper-large-v3-turbo');
  form.append('response_format', 'json');
  const r = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
    method: 'POST', headers: { Authorization: 'Bearer ' + key }, body: form
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error((d.error && d.error.message) || 'transcription failed');
  return String(d.text || '').trim();
}

// ---------- group chat gate ----------
function shouldAnswerGroup(opts) {
  const o = opts || {};
  if (!o.isGroup) return true;
  const mode = o.mode || 'mention';
  if (mode === 'always') return true;
  const text = String(o.text || '');
  const names = (o.botNames || []).filter(Boolean).map((n) => String(n).toLowerCase());
  const lower = text.toLowerCase();
  if (names.some((n) => lower.includes('@' + n))) return true;
  if (o.replyToBot) return true;
  return false;
}

// ---------- billing ----------
const PLANS = {
  free: {
    id: 'free', name: 'Free', priceGhs: 0,
    limits: { agents: 5, knowledgeDocs: 3, triggers: 1, analyticsDays: 14, voice: false },
    features: ['5 agents', 'WhatsApp + Telegram channels', '3 knowledge documents', '14-day analytics', 'Islamic knowledge tools', 'Daily Fajr broadcast']
  },
  pro: {
    id: 'pro', name: 'Pro', priceGhs: 25,
    limits: { agents: 50, knowledgeDocs: 100, triggers: 20, analyticsDays: 120, voice: true },
    features: ['50 agents', '100 knowledge documents + FAQ', '120-day analytics', 'Voice replies (speech in/out)', '20 event triggers', 'Priority support']
  }
};

async function planFor(user) {
  if (!user) return PLANS.free;
  if (user.founder || user.plan === 'pro') return PLANS.pro;
  try {
    const doc = await docs.get('plans', user.id);
    return doc && doc.plan === 'pro' ? PLANS.pro : PLANS.free;
  } catch (e) { return PLANS.free; }
}

async function billingConfig() {
  return (await docs.get('config', 'billing')) || { provider: '', link: '', note: '' };
}

// ---------- HTTP surface ----------
function attach(opts) {
  // Create the store on boot rather than on the first user action, so a broken
  // database connection shows up in the logs immediately instead of silently
  // dropping reminders and knowledge later.
  docs.list('reminders').then(() => console.log('[suite] document store ready'))
    .catch((e) => console.log('[suite] document store unavailable:', oneLine(e.message, 160)));
  state.api = opts.api;
  state.db = opts.db;
  state.send = opts.send || null;
  const api = state.api;

  api.get('/suite/status', async (req, res) => {
    const cfg = await billingConfig();
    const plan = await planFor(req.user);
    res.json({
      plan: plan.id,
      limits: plan.limits,
      billingConfigured: Boolean(cfg.link),
      billingProvider: cfg.provider || null,
      tickerRunning: Boolean(state.ticker),
      lastTick: state.lastTick,
      languages: LANG_NAMES,
      lastTickAt: state.lastTick ? state.lastTick.at : null
    });
  });

  // ----- knowledge base -----
  api.get('/agents/:id/knowledge', async (req, res) => {
    const a = await ownAgent(req, req.params.id);
    if (!a) return res.status(404).json({ error: 'agent not found' });
    const list = await knowledgeDocs(a.id);
    res.json(list.map((d) => ({
      id: d.id, title: d.title, kind: d.kind, chars: d.chars, chunks: (d.chunks || []).length,
      items: d.items || [], createdAt: d.createdAt
    })));
  });

  api.post('/agents/:id/knowledge', async (req, res) => {
    const a = await ownAgent(req, req.params.id);
    if (!a) return res.status(404).json({ error: 'agent not found' });
    const plan = await planFor(req.user);
    const existing = await knowledgeDocs(a.id);
    if (existing.length >= plan.limits.knowledgeDocs) {
      return res.status(402).json({ error: 'Your plan allows ' + plan.limits.knowledgeDocs + ' knowledge documents. Upgrade to add more.', upgrade: true });
    }
    const { title, filename, dataBase64, text, kind } = req.body || {};
    let body = '';
    let name = oneLine(title || filename || 'Untitled', 90);
    try {
      if (typeof text === 'string' && text.trim()) {
        if (text.length > 400000) return res.status(413).json({ error: 'That document is too long. Split it into smaller documents.' });
        body = text;
      }
      else if (typeof dataBase64 === 'string' && dataBase64) {
        const buf = Buffer.from(dataBase64.replace(/^data:[^;]+;base64,/, ''), 'base64');
        if (buf.length > 4 * 1024 * 1024) return res.status(413).json({ error: 'File is larger than 4 MB' });
        body = extract(filename || title || '', buf);
        name = oneLine(title || filename, 90);
      }
    } catch (e) {
      return res.status(400).json({ error: oneLine(e.message, 200) });
    }
    body = String(body || '').trim();
    if (body.length < 20) return res.status(400).json({ error: 'No readable text found in that file. Paste the text instead.' });
    const doc = {
      id: uid('kb'), agentId: a.id, ownerId: req.user.id, title: name,
      kind: kind === 'faq' ? 'faq' : 'file', chars: body.length,
      chunks: chunk(body), createdAt: nowIso()
    };
    await docs.put('knowledge', doc);
    res.status(201).json({ id: doc.id, title: doc.title, chars: doc.chars, chunks: doc.chunks.length });
  });

  api.delete('/knowledge/:id', async (req, res) => {
    const doc = await docs.get('knowledge', req.params.id);
    if (!doc || doc.ownerId !== req.user.id) return res.status(404).json({ error: 'not found' });
    await docs.del('knowledge', req.params.id);
    res.json({ ok: true });
  });

  api.post('/agents/:id/faq', throttle(5, 60e3, 'faq'), async (req, res) => {
    const a = await ownAgent(req, req.params.id);
    if (!a) return res.status(404).json({ error: 'agent not found' });
    try {
      const kdocs = await knowledgeDocs(a.id);
      const source = kdocs.filter((d) => d.kind !== 'faq').map((d) => '[' + d.title + ']\n' + (d.chunks || []).join('\n').slice(0, 4000)).join('\n\n');
      const basis = (source || '').slice(0, 9000) || ('Agent description: ' + (a.description || '') + '\nSystem prompt: ' + (a.systemPrompt || ''));
      const out = await llm(
        'You write FAQ pairs for a customer-facing chat agent. Return ONLY a JSON array of objects with keys "q" and "a". Answers must be 1-3 sentences, drawn strictly from the material given, in the language of the material. 5 pairs maximum. No markdown, no commentary.',
        basis, { maxTokens: 900, temperature: 0.3 }
      );
      const items = parseFaqItems(out).slice(0, 8).map((x) => ({ q: oneLine(x.q, 200), a: oneLine(x.a, 600) }));
      if (!items.length) throw new Error('The model did not return usable pairs. Try again, or add a knowledge document so it has material to work from.');
      const doc = { id: uid('faq'), agentId: a.id, ownerId: req.user.id, title: 'Generated FAQ', kind: 'faq', chars: 0, chunks: [], items, createdAt: nowIso() };
      await docs.put('knowledge', doc);
      res.json({ id: doc.id, items });
    } catch (e) {
      res.status(502).json({ error: oneLine(e.message, 200) });
    }
  });

  // ----- reminders -----
  api.get('/reminders', async (req, res) => {
    const list = (await docs.list('reminders', { ownerId: req.user.id }))
      .sort((a, b) => String(a.dueAt).localeCompare(String(b.dueAt)));
    res.json(list);
  });

  api.post('/reminders', async (req, res) => {
    const { title, message, dueAt, repeat, channel, chatId, agentId } = req.body || {};
    if (!title || !dueAt) return res.status(400).json({ error: 'title and dueAt are required' });
    const due = new Date(dueAt);
    if (isNaN(due)) return res.status(400).json({ error: 'dueAt must be a date' });
    const ch = channel === 'whatsapp' ? 'whatsapp' : 'telegram';
    const agent = agentId ? await ownAgent(req, agentId) : null;
    const reminder = {
      id: uid('rem'), ownerId: req.user.id, agentId: agent ? agent.id : null, agentName: agent ? agent.name : null,
      title: oneLine(title, 120), message: String(message || title).slice(0, 900),
      dueAt: due.toISOString(), repeat: ['none', 'daily', 'weekly'].includes(repeat) ? repeat : 'none',
      channel: ch, chatId: String(chatId || '').trim() || null, status: 'pending', createdAt: nowIso()
    };
    if (!reminder.chatId) {
      if (ch === 'telegram') return res.status(400).json({ error: 'A Telegram chat id is required (send /start to the bot, or use a subscriber chat id)' });
      return res.status(400).json({ error: 'A WhatsApp number is required' });
    }
    await docs.put('reminders', reminder);
    wake();
    res.status(201).json(reminder);
  });

  api.delete('/reminders/:id', async (req, res) => {
    const r = await docs.get('reminders', req.params.id);
    if (!r || r.ownerId !== req.user.id) return res.status(404).json({ error: 'not found' });
    await docs.del('reminders', req.params.id);
    res.json({ ok: true });
  });

  api.post('/reminders/:id/send-now', throttle(10, 60e3, 'send'), async (req, res) => {
    const r = await docs.get('reminders', req.params.id);
    if (!r || r.ownerId !== req.user.id) return res.status(404).json({ error: 'not found' });
    try {
      await deliver(r.channel, r.chatId, r.message, r.agentId);
      await docs.put('reminders', { ...r, lastSentAt: nowIso(), status: r.repeat === 'none' ? 'sent' : r.status });
      res.json({ ok: true });
    } catch (e) { res.status(502).json({ error: oneLine(e.message, 200) }); }
  });

  // ----- triggers -----
  api.get('/triggers', async (req, res) => {
    res.json(await docs.list('triggers', { ownerId: req.user.id }));
  });

  api.post('/triggers', async (req, res) => {
    const plan = await planFor(req.user);
    const existing = await docs.list('triggers', { ownerId: req.user.id });
    if (existing.length >= plan.limits.triggers) return res.status(402).json({ error: 'Your plan allows ' + plan.limits.triggers + ' trigger(s). Upgrade for more.', upgrade: true });
    const { name, url, jsonPath, condition, prompt, channel, chatId, agentId, intervalMin } = req.body || {};
    try { await assertPublicUrl(url); } catch (e) { return res.status(400).json({ error: oneLine(e.message, 200) }); }
    const agent = agentId ? await ownAgent(req, agentId) : null;
    const t = {
      id: uid('trg'), ownerId: req.user.id, name: oneLine(name || 'Untitled trigger', 90), url: String(url).slice(0, 500),
      jsonPath: oneLine(jsonPath || '', 120), condition: oneLine(condition || 'changed', 40), prompt: String(prompt || '').slice(0, 600),
      channel: channel === 'whatsapp' ? 'whatsapp' : 'telegram', chatId: String(chatId || '').trim() || null,
      agentId: agent ? agent.id : null, agentName: agent ? agent.name : null,
      intervalMin: Math.min(1440, Math.max(5, Number(intervalMin) || 60)), active: true, createdAt: nowIso()
    };
    if (!t.chatId) return res.status(400).json({ error: 'A destination chat id / phone number is required' });
    await docs.put('triggers', t);
    wake();
    res.status(201).json(t);
  });

  api.delete('/triggers/:id', async (req, res) => {
    const t = await docs.get('triggers', req.params.id);
    if (!t || t.ownerId !== req.user.id) return res.status(404).json({ error: 'not found' });
    await docs.del('triggers', req.params.id);
    res.json({ ok: true });
  });

  api.post('/triggers/:id/run', async (req, res) => {
    const t = await docs.get('triggers', req.params.id);
    if (!t || t.ownerId !== req.user.id) return res.status(404).json({ error: 'not found' });
    const [out] = await runTriggers(req.user.id, t.id);
    res.json(out || { fired: false });
  });

  api.post('/cron/tick', async (req, res) => {
    if (!(await cronOk(req))) return res.status(401).json({ error: 'unauthorized: set CRON_SECRET and send it as a Bearer token' });
    res.json(await tick({ force: true }));
  });

  // ----- analytics -----
  api.get('/analytics/summary', async (req, res) => {
    const plan = await planFor(req.user);
    const days = Math.min(plan.limits.analyticsDays, Number(req.query.days) || 14);
    res.json(await summary(req.user.id, days));
  });

  // ----- voice -----
  api.post('/voice/transcribe', throttle(12, 60e3, 'stt'), async (req, res) => {
    const { audioBase64, mime, language } = req.body || {};
    if (!audioBase64) return res.status(400).json({ error: 'audioBase64 is required' });
    const key = await getKey();
    if (!key) return res.status(503).json({ error: 'Speech-to-text needs a Groq API key' });
    try {
      const buf = Buffer.from(String(audioBase64).replace(/^data:[^;]+;base64,/, ''), 'base64');
      if (buf.length > 20 * 1024 * 1024) return res.status(413).json({ error: 'Recording is too long' });
      const form = new FormData();
      form.append('file', new Blob([buf], { type: mime || 'audio/webm' }), 'audio.' + (String(mime || '').includes('ogg') ? 'ogg' : 'webm'));
      form.append('model', 'whisper-large-v3-turbo');
      form.append('response_format', 'json');
      if (language) form.append('language', String(language).slice(0, 2));
      const r = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
        method: 'POST', headers: { Authorization: 'Bearer ' + key }, body: form
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error((d.error && d.error.message) || 'transcription failed');
      res.json({ text: String(d.text || '').trim() });
    } catch (e) { res.status(502).json({ error: oneLine(e.message, 200) }); }
  });

  api.post('/voice/speak', throttle(10, 60e3, 'tts'), async (req, res) => {
    const plan = await planFor(req.user);
    if (!plan.limits.voice) return res.status(402).json({ error: 'Voice replies are a Pro feature', upgrade: true });
    const { text, language } = req.body || {};
    const clean = String(text || '').replace(/[*_`#>]/g, '').slice(0, 900);
    if (!clean) return res.status(400).json({ error: 'text is required' });
    const key = await getKey();
    if (!key) return res.status(503).json({ error: 'Text-to-speech needs a Groq API key' });
    const arabic = String(language || '').startsWith('ar');
    const model = arabic ? 'canopylabs/orpheus-arabic-saudi' : 'canopylabs/orpheus-v1-english';
    // Groq's docs name only a few Orpheus voices, so probe a short list once and
    // remember the first voice the account accepts.
    const candidates = arabic ? ['noura', 'ahmed', 'khalid', 'layla', 'hannah'] : ['hannah', 'troy', 'austin', 'daniel', 'diana'];
    const cached = state.tts && state.tts[model];
    const tryVoices = cached ? [cached].concat(candidates.filter((v) => v !== cached)) : candidates;
    const problems = [];
    try {
      for (const voice of tryVoices) {
        const r = await fetch('https://api.groq.com/openai/v1/audio/speech', {
          method: 'POST',
          headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' },
          body: JSON.stringify({ model, voice, input: clean, response_format: 'wav' }),
          signal: AbortSignal.timeout(30000)
        });
        if (r.ok) {
          const audio = Buffer.from(await r.arrayBuffer());
          state.tts = state.tts || {};
          state.tts[model] = voice;
          return res.json({ mime: 'audio/wav', voice, model, audioBase64: fixWav(audio).toString('base64') });
        }
        const d = await r.json().catch(() => ({}));
        problems.push(voice + ': ' + ((d.error && d.error.message) || r.status));
      }
      const first = problems[0] || 'speech failed';
      if (/terms acceptance/i.test(first)) {
        throw new Error('Voice needs a one-time terms acceptance in Groq: open console.groq.com, play the Orpheus voice model once to accept its terms, then try again.');
      }
      throw new Error(problems.slice(0, 2).join(' | '));
    } catch (e) { res.status(502).json({ error: oneLine(e.message, 220) }); }
  });

  // ----- billing -----
  api.get('/billing/plans', async (req, res) => {
    const cfg = await billingConfig();
    res.json({ plans: PLANS, current: (await planFor(req.user)).id, provider: cfg.provider || null, link: cfg.link || '', note: cfg.note || '' });
  });

  api.put('/billing/config', async (req, res) => {
    if (!req.user || !req.user.founder) return res.status(403).json({ error: 'founder only' });
    const { provider, link, note, priceGhs } = req.body || {};
    if (link) { try { new URL(link); } catch (e) { return res.status(400).json({ error: 'link must be a full URL' }); } }
    const cfg = await billingConfig();
    const next = {
      id: 'billing', provider: oneLine(provider || cfg.provider || '', 40), link: String(link || cfg.link || '').slice(0, 400),
      note: String(note == null ? cfg.note || '' : note).slice(0, 300),
      priceGhs: Number(priceGhs) > 0 ? Number(priceGhs) : (cfg.priceGhs || PLANS.pro.priceGhs)
    };
    await docs.put('config', next);
    res.json(next);
  });

  api.post('/billing/upgrade-request', async (req, res) => {
    const { note, channel } = req.body || {};
    const cfg = await billingConfig();
    const reqDoc = { id: uid('upg'), ownerId: req.user.id, email: req.user.email, name: req.user.name, note: oneLine(note || '', 400), channel: oneLine(channel || '', 40), status: 'pending', createdAt: nowIso() };
    await docs.put('upgrade_requests', reqDoc);
    res.json({ ok: true, link: cfg.link || '', provider: cfg.provider || null });
  });

  api.get('/admin/upgrade-requests', async (req, res) => {
    if (!req.user || !req.user.founder) return res.status(403).json({ error: 'founder only' });
    res.json(await docs.list('upgrade_requests'));
  });

  api.post('/admin/users/:id/plan', async (req, res) => {
    if (!req.user || !req.user.founder) return res.status(403).json({ error: 'founder only' });
    const plan = (req.body && req.body.plan) === 'pro' ? 'pro' : 'free';
    await docs.put('plans', { id: req.params.id, plan, updatedAt: nowIso() });
    res.json({ ok: true, plan });
  });

  // ----- reorder agents -----
  api.post('/agents/reorder', async (req, res) => {
    const ids = Array.isArray(req.body && req.body.ids) ? req.body.ids : [];
    const agents = await state.db.listAgents();
    let i = 0;
    for (const id of ids) {
      const a = agents.find((x) => x.id === id && x.ownerId === req.user.id);
      if (a) { a.sortOrder = i++; await state.db.updateAgent(a); }
    }
    res.json({ ok: true, order: ids });
  });

  // Per-account throttle for the endpoints that cost model or voice credits.
  const hitLog = new Map();
  function throttle(max, windowMs, label) {
    return (req, res, next) => {
      const who = (req.user && req.user.id) || req.ip;
      const k = label + '|' + who, now = Date.now();
      const hits = (hitLog.get(k) || []).filter((t) => now - t < windowMs);
      if (hits.length >= max) return res.status(429).json({ error: 'That is a lot at once. Give it a moment and try again.' });
      hits.push(now); hitLog.set(k, hits);
      if (hitLog.size > 2000) for (const [key, times] of hitLog) if (!times.some((t) => now - t < windowMs)) hitLog.delete(key);
      next();
    };
  }

  // Cron paths skip the session middleware, so they prove themselves here.
  async function cronOk(req) {
    const token = process.env.CRON_SECRET || process.env.BROADCAST_TOKEN;
    const auth = req.get('authorization') || '';
    if (token && auth === 'Bearer ' + token) return true;
    const admin = process.env.ADMIN_KEY;
    const given = req.headers['x-admin-key'];
    if (admin && typeof given === 'string' && given === admin) return true;
    const m = /agx_sess=([a-f0-9]+)/.exec(req.headers.cookie || '');
    if (!m) return false;
    const sess = await state.db.getSession(m[1]);
    return Boolean(sess && sess.user && sess.user.founder && new Date(sess.expires) > new Date());
  }

  // background ticker for long-running hosts (Render, VPS). Vercel uses /api/cron/tick.
  if (!process.env.VERCEL && process.env.AGX_DISABLE_TICKER !== '1') {
    state.ticker = setInterval(() => { tick().catch((e) => console.log('[tick]', oneLine(e.message, 120))); }, TICK_SECONDS * 1000);
    if (state.ticker.unref) state.ticker.unref();
  }
}

module.exports = {
  attach, promptExtras, retrieve, logEvent, summary, tick, runReminders, runTriggers,
  shouldAnswerGroup, detectLanguage, planFor, PLANS, LANG_NAMES, chunk, tokens, deliver, parseFaqItems, fixWav, state,
  transcribeBuffer, quickReminder, parseWhen, wake, soonestWork, TICK_SECONDS, IDLE_SECONDS, fireTrigger, runTriggers, knowledgeDocs, docs
};
