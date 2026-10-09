// AgentX — multi-platform AI agent dashboard
// Express backend: agent CRUD, platform channel config, Groq-powered chat console.
const express = require('express');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const DATA_DIR = path.join(__dirname, 'data');
const AGENTS_FILE = path.join(DATA_DIR, 'agents.json');
const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');

app.use(express.json({ limit: '256kb' }));
app.use((req, res, next) => { if (req.path.startsWith('/api')) res.set('Cache-Control', 'no-store'); next(); });
app.use(express.static(path.join(__dirname, 'public'), { etag: true, maxAge: 0, setHeaders: (res) => res.set('Cache-Control', 'no-cache') }));

// ---------- tiny JSON store ----------
function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}
function writeJson(file, obj) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(file, JSON.stringify(obj, null, 2));
}
const uid = () => 'agx_' + Math.random().toString(36).slice(2, 9);

// default agents on first run
if (!fs.existsSync(AGENTS_FILE)) {
  writeJson(AGENTS_FILE, [
    {
      id: uid(), name: 'Madrasa Assistant', emoji: '🕌',
      description: 'Answers student & parent questions about madrasa lessons, timetables and admissions.',
      systemPrompt: 'You are the Madrasa Assistant for Al-Haqq Digital madrasa in Tarkwa, Ghana. Answer kindly and concisely, using simple English. You help with lesson schedules, admission steps and general school questions. When asked about prayer times, Quran verses, hadith, duas or fiqh, use your tools to fetch live accurate data rather than answering from memory.',
      model: 'openai/gpt-oss-120b',
      platforms: { whatsapp: { enabled: true, autoReply: true }, telegram: { enabled: true, autoReply: true } },
      status: 'live', createdAt: new Date().toISOString(), messagesHandled: 128
    },
    {
      id: uid(), name: 'Shop Support', emoji: '🛍️',
      description: 'Handles product questions and order status for the Al-Haqq Digital phone accessories shop.',
      systemPrompt: 'You are Shop Support for Al-Haqq Digital, a phone accessories shop in Tarkwa, Ghana. Help customers with product info, prices and order status. Be brief and friendly.',
      model: 'llama-3.1-8b-instant',
      platforms: { whatsapp: { enabled: true, autoReply: true }, telegram: { enabled: true, autoReply: true } },
      status: 'live', createdAt: new Date().toISOString(), messagesHandled: 47
    }
  ]);
}
if (!fs.existsSync(SETTINGS_FILE)) writeJson(SETTINGS_FILE, { groqApiKey: '', webhookBase: '' });

// ---------- API ----------
const api = express.Router();

// ---------- multi-tenant accounts ----------
const crypto = require('crypto');
const USERS_FILE = path.join(DATA_DIR, 'users.json');
const SESSIONS_FILE = path.join(DATA_DIR, 'sessions.json');
const PUBLIC_API = ['/status', '/auth/status', '/auth/register', '/auth/login', '/auth/logout', '/telegram/status'];

function hashPassword(pw, salt) {
  salt = salt || crypto.randomBytes(12).toString('hex');
  const h = crypto.scryptSync(String(pw), salt, 32).toString('hex');
  return salt + ':' + h;
}
function checkPassword(pw, stored) {
  const [salt, h] = String(stored || '').split(':');
  if (!salt || !h) return false;
  return crypto.timingSafeEqual(Buffer.from(h, 'hex'), crypto.scryptSync(String(pw), salt, 32));
}

function getSessions() { return readJson(SESSIONS_FILE, {}); }
function saveSessions(sess) { writeJson(SESSIONS_FILE, sess); }

api.use((req, res, next) => {
  if (PUBLIC_API.includes(req.path)) return next();
  const m = /agx_sess=([a-f0-9]+)/.exec(req.headers.cookie || '');
  const sess = getSessions()[m && m[1]];
  if (!sess || new Date(sess.expires) < new Date()) return res.status(401).json({ error: 'login required' });
  req.sessionToken = m[1]; req.user = sess.user;
  next();
});

api.get('/auth/status', (req, res) => {
  const m = /agx_sess=([a-f0-9]+)/.exec(req.headers.cookie || '');
  const sess = getSessions()[m && m[1]];
  const authed = Boolean(sess && new Date(sess.expires) > new Date());
  res.json({ needsLogin: true, authed, user: authed ? sess.user : null });
});

api.post('/auth/register', (req, res) => {
  const { email, password, name, founderKey } = req.body || {};
  const em = String(email || '').trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(em)) return res.status(400).json({ error: 'valid email required' });
  if (String(password || '').length < 6) return res.status(400).json({ error: 'password must be at least 6 characters' });
  const users = readJson(USERS_FILE, {});
  if (Object.values(users).some(u => u.email === em)) return res.status(409).json({ error: 'that email is already registered' });
  const isFounder = Boolean(process.env.ADMIN_KEY && founderKey === process.env.ADMIN_KEY);
  const id = 'u_' + crypto.randomBytes(5).toString('hex');
  users[id] = { id, email: em, name: String(name || em.split('@')[0]).slice(0, 40), founder: isFounder, pass: hashPassword(password), createdAt: new Date().toISOString() };
  writeJson(USERS_FILE, users);
  if (isFounder) {
    const agents = readJson(AGENTS_FILE, []);
    let claimed = 0;
    for (const a of agents) if (!a.ownerId) { a.ownerId = id; claimed++; }
    writeJson(AGENTS_FILE, agents);
  }
  const token = crypto.randomBytes(24).toString('hex');
  const sess = getSessions();
  sess[token] = { user: { id, email: em, name: users[id].name, founder: isFounder }, expires: new Date(Date.now() + 30 * 864e5).toISOString() };
  saveSessions(sess);
  res.setHeader('Set-Cookie', 'agx_sess=' + token + '; Path=/; HttpOnly; Max-Age=2592000; SameSite=Lax');
  res.json({ ok: true, user: sess[token].user });
});

api.post('/auth/login', (req, res) => {
  const { email, password } = req.body || {};
  const em = String(email || '').trim().toLowerCase();
  const users = readJson(USERS_FILE, {});
  const u = Object.values(users).find(x => x.email === em);
  if (!u || !checkPassword(password, u.pass)) return res.status(401).json({ error: 'wrong email or password' });
  const token = crypto.randomBytes(24).toString('hex');
  const sess = getSessions();
  sess[token] = { user: { id: u.id, email: u.email, name: u.name, founder: Boolean(u.founder) }, expires: new Date(Date.now() + 30 * 864e5).toISOString() };
  saveSessions(sess);
  res.setHeader('Set-Cookie', 'agx_sess=' + token + '; Path=/; HttpOnly; Max-Age=2592000; SameSite=Lax');
  res.json({ ok: true, user: sess[token].user });
});

api.post('/auth/logout', (req, res) => {
  const m = /agx_sess=([a-f0-9]+)/.exec(req.headers.cookie || '');
  if (m) { const sess = getSessions(); delete sess[m[1]]; saveSessions(sess); }
  res.setHeader('Set-Cookie', 'agx_sess=; Path=/; HttpOnly; Max-Age=0');
  res.json({ ok: true });
});

api.get('/status', (req, res) => {
  const s = readJson(SETTINGS_FILE, {});
  const cfg = Boolean((s.groqApiKey && s.groqApiKey.startsWith('gsk_')) || (process.env.GROQ_API_KEY || '').startsWith('gsk_'));
  res.json({
    ok: true,
    groqConfigured: cfg,
    telegramConnected: Boolean(process.env.TELEGRAM_BOT_TOKEN),
    whatsappConnected: Boolean(process.env.WHATSAPP_PHONE_NUMBER_ID && process.env.WHATSAPP_ACCESS_TOKEN),
    ilmConnected: Boolean(process.env.ILM_API_KEY),
    adminAuth: Boolean(process.env.ADMIN_KEY)
  });
});

api.get('/settings', (req, res) => {
  if (!req.user.founder) return res.json({ readOnly: true });
  res.json(readJson(SETTINGS_FILE, {}));
});
api.put('/settings', (req, res) => {
  if (!req.user.founder) return res.status(403).json({ error: 'settings are managed by the founder' });
  const s = readJson(SETTINGS_FILE, {});
  const { groqApiKey, webhookBase } = req.body || {};
  if (typeof groqApiKey === 'string') s.groqApiKey = groqApiKey.trim();
  if (typeof webhookBase === 'string') s.webhookBase = webhookBase.trim();
  writeJson(SETTINGS_FILE, s);
  const cfg = Boolean((s.groqApiKey && s.groqApiKey.startsWith('gsk_')) || (process.env.GROQ_API_KEY || '').startsWith('gsk_'));
  res.json({ ok: true, groqConfigured: cfg });
});

function publicAgent(a) {
  const o = Object.assign({}, a);
  o.waTokenSet = Boolean(a.waToken);
  delete o.waToken;
  return o;
}

api.get('/agents', (req, res) => res.json(readJson(AGENTS_FILE, []).filter(a => a.ownerId === req.user.id).map(publicAgent)));

api.post('/agents', (req, res) => {
  const { name, emoji, description, systemPrompt, model } = req.body || {};
  if (!name || !String(name).trim()) return res.status(400).json({ error: 'name is required' });
  const agents = readJson(AGENTS_FILE, []);
  const agent = {
    id: uid(), name: String(name).trim().slice(0, 60),
    emoji: (emoji || '🤖').slice(0, 4), description: String(description || '').slice(0, 300),
    systemPrompt: String(systemPrompt || 'You are a helpful assistant.').slice(0, 4000),
    model: model || 'openai/gpt-oss-120b',
    platforms: { whatsapp: { enabled: false, autoReply: true }, telegram: { enabled: false, autoReply: true } },
    status: 'draft', createdAt: new Date().toISOString(), messagesHandled: 0, ownerId: req.user.id
  };
  agents.push(agent); writeJson(AGENTS_FILE, agents);
  res.status(201).json(publicAgent(agent));
});

api.put('/agents/:id', (req, res) => {
  const agents = readJson(AGENTS_FILE, []);
  const a = agents.find(x => x.id === req.params.id && x.ownerId === req.user.id);
  if (!a) return res.status(404).json({ error: 'agent not found' });
  const allowed = ['name','emoji','description','systemPrompt','model','status','platforms'];
  for (const k of allowed) if (req.body && k in req.body) a[k] = req.body[k];
  if (req.body && 'waPhoneId' in req.body) {
    const pid = String(req.body.waPhoneId || '').replace(/\D/g, '').slice(0, 24);
    if (pid && agents.some(x => x.id !== a.id && x.waPhoneId === pid)) return res.status(409).json({ error: 'That WhatsApp phone number ID is already linked to another agent' });
    a.waPhoneId = pid;
  }
  if (req.body && typeof req.body.waToken === 'string' && req.body.waToken.trim()) a.waToken = req.body.waToken.trim().slice(0, 600);
  if (req.body && req.body.waToken === '') delete a.waToken;
  writeJson(AGENTS_FILE, agents);
  res.json(publicAgent(a));
});

api.delete('/agents/:id', (req, res) => {
  let agents = readJson(AGENTS_FILE, []);
  const before = agents.length;
  agents = agents.filter(x => x.id !== req.params.id && x.ownerId === req.user.id);
  if (agents.length === before) return res.status(404).json({ error: 'agent not found' });
  writeJson(AGENTS_FILE, agents);
  res.json({ ok: true });
});

// ---------- Ilm API tools (function calling) ----------
const ILM_API_URL = (process.env.ILM_API_URL || 'https://ilm-api.vercel.app').replace(/\/$/, '');
const ILM_API_KEY = process.env.ILM_API_KEY || '';

async function ilmCall(pathname, params) {
  const qs = params ? '?' + new URLSearchParams(Object.entries(params).filter(([, v]) => v !== undefined && v !== '')) : '';
  const r = await fetch(ILM_API_URL + pathname + qs, { headers: { 'x-api-key': ILM_API_KEY } });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error('Ilm API error: ' + JSON.stringify(d).slice(0, 200));
  const str = typeof d === 'string' ? d : JSON.stringify(d);
  return str.length > 2200 ? str.slice(0, 2200) + '…[truncated]' : str;
}

const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'get_prayer_times',
      description: 'Get Islamic prayer times (Fajr, Dhuhr, Asr, Maghrib, Isha) for a city. Use for any question about salat/salah times.',
      parameters: {
        type: 'object',
        properties: {
          city: { type: 'string', description: 'City name, e.g. Tarkwa, Accra, Kumasi, Makkah' },
          date: { type: 'string', description: 'Optional date YYYY-MM-DD' }
        },
        required: ['city']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'get_quran_ayah',
      description: 'Get a Quran verse with Arabic text and translation. Use when the user quotes, references or asks about a specific verse.',
      parameters: {
        type: 'object',
        properties: {
          surah: { type: 'integer', description: 'Surah number 1-114' },
          ayah: { type: 'integer', description: 'Ayah number within the surah' },
          translation: { type: 'string', description: 'Optional translation key, e.g. en.sahih, ur.jalandhari, fr.hamidullah' }
        },
        required: ['surah', 'ayah']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'search_hadith',
      description: 'Search hadith collections (Bukhari, Muslim, Tirmidhi, Nasai, Abu Dawud, Ibn Majah) by keyword. Use when the user asks about a hadith on a topic.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Search keywords, e.g. intention, patience' },
          collection: { type: 'string', description: 'Optional collection slug, e.g. bukhari, muslim' },
          language: { type: 'string', description: 'Optional 2-letter language code, e.g. en, ar, fr' }
        },
        required: ['query']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'search_dictionary',
      description: 'Look up an Arabic word or English meaning in the Islamic dictionary, or get all words from an Arabic root (3 letters).',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Arabic word, English meaning, or 3-letter root like ص-ب-ر' },
          mode: { type: 'string', enum: ['search', 'root'], description: '"root" to look up all words from an Arabic root' }
        },
        required: ['query']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'get_dua',
      description: 'Get duas (supplications). Use when the user asks for a dua on a topic like morning, distress, forgiveness, or a random one.',
      parameters: {
        type: 'object',
        properties: {
          search: { type: 'string', description: 'Topic keywords to search, e.g. morning, distress, forgiveness' },
          random: { type: 'boolean', description: 'True for a random dua' }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'get_fiqh_ruling',
      description: 'Get comparative fiqh rulings across the 4 madhabs on a topic, e.g. wudu, fasting, zakat.',
      parameters: {
        type: 'object',
        properties: {
          topic: { type: 'string', description: 'The fiqh topic, e.g. wudu, tayammum' }
        },
        required: ['topic']
      }
    }
  }
];

async function runTool(name, args) {
  try {
    switch (name) {
      case 'get_prayer_times': return await ilmCall('/v1/prayer-times', { city: args.city, date: args.date, method: 'MuslimWorldLeague' });
      case 'get_quran_ayah': return await ilmCall(`/v1/quran/${args.surah}/${args.ayah}`, { translation: args.translation });
      case 'search_hadith': return await ilmCall('/v1/hadith/search', { q: args.query, collection: args.collection, language: args.language, limit: 5 });
      case 'search_dictionary':
        return args.mode === 'root'
          ? await ilmCall('/v1/dictionary/root/' + encodeURIComponent(args.query))
          : await ilmCall('/v1/dictionary/search', { q: args.query });
      case 'get_dua': return args.search ? await ilmCall('/v1/duas/search', { q: args.search }) : await ilmCall('/v1/duas/random');
      case 'get_fiqh_ruling': return await ilmCall('/v1/fiqh/search', { topic: args.topic });
      default: return 'Unknown tool';
    }
  } catch (e) { return 'Tool error: ' + e.message; }
}

// ---------- shared Groq call ----------

async function groqAsk(agent, history) {
  const st = readJson(SETTINGS_FILE, {});
  const key = (st.groqApiKey && st.groqApiKey.startsWith('gsk_')) ? st.groqApiKey : (process.env.GROQ_API_KEY || '');
  if (!key.startsWith('gsk_')) {
    const last = history.length ? history[history.length - 1].content : '';
    return { reply: `*[demo mode — add a Groq API key in Settings to go live]*\n\n${agent.name} here. You said: "${(last || '').slice(0, 120)}".`, demo: true };
  }
  const messages = [{ role: 'system', content: agent.systemPrompt }, ...history];
  for (let round = 0; round < 4; round++) {
    const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + key, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: agent.model,
        messages,
        tools: ILM_API_KEY ? TOOLS : undefined,
        tool_choice: ILM_API_KEY ? 'auto' : undefined,
        temperature: 0.7, max_tokens: 800
      })
    });
    const d = await r.json();
    if (!r.ok) throw new Error((d.error && d.error.message) || 'Groq request failed');
    const msg = d.choices[0].message;
    const calls = msg.tool_calls || [];
    if (!calls.length) return { reply: msg.content, model: agent.model };
    messages.push(msg);
    for (const c of calls) {
      let args = {};
      try { args = JSON.parse(c.function.arguments || '{}'); } catch {}
      const result = await runTool(c.function.name, args);
      messages.push({ role: 'tool', tool_call_id: c.id, content: result });
    }
  }
  return { reply: 'I got carried away checking references — please ask again.', model: agent.model };
}

function bumpMessages(agentId) {
  const agents = readJson(AGENTS_FILE, []);
  const a = agents.find(x => x.id === agentId);
  if (a) { a.messagesHandled = (a.messagesHandled || 0) + 1; writeJson(AGENTS_FILE, agents); }
}

// test chat console — same path the Telegram webhook uses
api.post('/chat/:id', async (req, res) => {
  const owned = readJson(AGENTS_FILE, []).find(x => x.id === req.params.id && x.ownerId === req.user.id);
  if (!owned) return res.status(404).json({ error: 'agent not found' });
  const agents = readJson(AGENTS_FILE, []);
  const a = agents.find(x => x.id === req.params.id);
  if (!a) return res.status(404).json({ error: 'agent not found' });
  const history = Array.isArray(req.body.history) ? req.body.history.slice(-12) : [];
  try {
    const out = await groqAsk(a, history);
    if (!out.demo) bumpMessages(a.id);
    res.json(out);
  } catch (e) { res.status(502).json({ error: e.message }); }
});

// ---------- Telegram webhook ----------
const TG_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const TG_SECRET = process.env.TELEGRAM_WEBHOOK_SECRET || '';
const TG_HISTORY_FILE = path.join(DATA_DIR, 'tg_history.json');
const tgHistories = new Map(readJson(TG_HISTORY_FILE, []));   // chatId -> last 12 messages
function saveTgHistory() { writeJson(TG_HISTORY_FILE, Array.from(tgHistories.entries())); }
const tgSelected = new Map();   // chatId -> agent id chosen via /agent

function pickAgent(agents, chatId) {
  const chosenId = tgSelected.get(chatId);
  if (chosenId) {
    const chosen = agents.find(a => a.id === chosenId);
    if (chosen && chosen.status === 'live') return chosen;
  }
  return agents.find(a => a.platforms && a.platforms.telegram && a.platforms.telegram.enabled && a.platforms.telegram.autoReply && a.status === 'live')
      || agents.find(a => a.platforms && a.platforms.telegram && a.platforms.telegram.enabled && a.status === 'live')
      || null;
}

function tgFormat(text) {
  return String(text)
    .replace(/\*\*(.+?)\*\*/g, '*$1*')
    .replace(/^#{1,6}\s*/gm, '')
    .replace(/^[-*]\s+/gm, '• ');
}

async function tgSend(chatId, text) {
  const chunks = tgFormat(text).match(/[\s\S]{1,3800}(?!\S)/) || [tgFormat(text)];
  for (const c of chunks) {
    await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text: c })
    });
  }
}

async function handleTgMessage(msg) {
  const chatId = msg.chat && msg.chat.id;
  const text = (msg.text || '').trim();
  if (!chatId || !text) return;
  const agents = readJson(AGENTS_FILE, []);

  if (text.startsWith('/')) {
    const cmd = text.split(/\s+/)[0].split('@')[0].toLowerCase();
    const arg = text.split(/\s+/).slice(1).join(' ').trim();
    if (cmd === '/start' || cmd === '/help') {
      return tgSend(chatId,
        '👋 Welcome to AgentX!\n\nI am an AI assistant running on Groq with live access to prayer times, Quran, hadith, duas and more.\n' +
        'Commands:\n/agents — list available assistants\n/agent <name> — talk to a specific one\n\nJust type your question.\n/subscribe <city> — daily Fajr time + morning dua');
    }
    if (cmd === '/agents') {
      const live = agents.filter(a => a.status === 'live');
      return tgSend(chatId, live.length
        ? 'Available assistants:\n' + live.map(a => `${a.emoji} ${a.name}`).join('\n')
        : 'No live agents yet — set one live in the dashboard.');
    }
    if (cmd === '/subscribe') {
      const city = arg || 'Tarkwa';
      addSubscriber(chatId, city.charAt(0).toUpperCase() + city.slice(1));
      return tgSend(chatId, `\u2705 You are subscribed to the daily Fajr reminder for ${city}. You will get the time and a morning dua each day before dawn. /unsubscribe to stop.`);
    }
    if (cmd === '/unsubscribe') {
      removeSubscriber(chatId);
      return tgSend(chatId, 'You have been unsubscribed from the Fajr reminder.');
    }
    if (cmd === '/agent' && arg) {
      const found = agents.find(a => a.name.toLowerCase() === arg.toLowerCase());
      if (found && found.status === 'live') {
        tgSelected.set(chatId, found.id); tgHistories.delete(chatId); saveTgHistory();
        return tgSend(chatId, `${found.emoji} You are now talking to ${found.name}.`);
      }
      return tgSend(chatId, `No live agent named "${arg}". Use /agents to list them.`);
    }
  }

  const agent = pickAgent(agents, chatId);
  if (!agent) return; // no live telegram-enabled agent: stay silent
  try {
    const history = [...(tgHistories.get(chatId) || []), { role: 'user', content: text }].slice(-12);
    const out = await groqAsk(agent, history);
    if (out.demo) return; // never send demo noise to Telegram
    bumpMessages(agent.id);
    tgHistories.set(chatId, [...history, { role: 'assistant', content: out.reply }].slice(-12));
    saveTgHistory();
    await tgSend(chatId, out.reply);
  } catch (e) {
    await tgSend(chatId, 'Sorry, I could not answer right now. Please try again.');
  }
}

app.post('/webhook/telegram', (req, res) => {
  if (TG_SECRET && req.get('x-telegram-bot-api-secret-token') !== TG_SECRET) return res.status(401).end();
  const upd = req.body || {};
  const msg = upd.message || upd.edited_message;
  if (msg && msg.text) handleTgMessage(msg).catch(() => {});
  res.json({ ok: true });
});

api.get('/telegram/status', (req, res) => res.json({
  tokenConfigured: Boolean(TG_TOKEN),
  selectionEnabled: tgSelected.size > 0
}));

// ---------- WhatsApp Cloud API ----------
const WA_VERIFY_TOKEN = process.env.WHATSAPP_VERIFY_TOKEN || '';
const WA_PHONE_ID = process.env.WHATSAPP_PHONE_NUMBER_ID || '';
const WA_TOKEN = process.env.WHATSAPP_ACCESS_TOKEN || '';
const waHistories = new Map();

async function waSend(to, text, phoneId, token) {
  const pid = phoneId || WA_PHONE_ID, tok = token || WA_TOKEN;
  if (!pid || !tok) return; // not configured yet
  await fetch(`https://graph.facebook.com/v21.0/${pid}/messages`, {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + tok, 'Content-Type': 'application/json' },
    body: JSON.stringify({ messaging_product: 'whatsapp', to, type: 'text', text: { body: String(text).slice(0, 3800) } })
  });
}

app.get('/webhook/whatsapp', (req, res) => {
  const q = req.query || {};
  if (q['hub.mode'] === 'subscribe' && q['hub.verify_token'] === WA_VERIFY_TOKEN) return res.send(q['hub.challenge'] || '');
  res.status(403).send('verification failed');
});

const waChoice = new Map(); // shared-number users: sender -> chosen agent id

app.post('/webhook/whatsapp', (req, res) => {
  res.json({ ok: true });
  try {
    const val = req.body && req.body.entry && req.body.entry[0] && req.body.entry[0].changes && req.body.entry[0].changes[0] && req.body.entry[0].changes[0].value;
    const msg = val && val.messages && val.messages[0];
    if (!msg) return;
    const toPhoneId = val.metadata && val.metadata.phone_number_id ? String(val.metadata.phone_number_id) : WA_PHONE_ID;
    const from = msg.from;
    const agents = readJson(AGENTS_FILE, []);
    const liveWa = a => a.status === 'live' && a.platforms && a.platforms.whatsapp && a.platforms.whatsapp.enabled;
    const linked = agents.find(a => a.waPhoneId && a.waPhoneId === toPhoneId && liveWa(a));
    const reply = (t) => waSend(from, t, linked ? linked.waPhoneId : undefined, linked ? linked.waToken : undefined);
    if (msg.type !== 'text') { console.log('[WA in ] non-text', msg.type); return reply('I can only read text messages for now. Please type your question.').catch(() => {}); }
    const text = (msg.text && msg.text.body || '').trim();
    console.log('[WA in ]', toPhoneId, from, String(text).slice(0, 100));
    if (!text) return;

    let agent = linked;
    if (!linked) {
      // Shared number: only public showcase agents (no private linked number) are reachable
      const shared = agents.filter(a => liveWa(a) && !a.waPhoneId && a.sharedWhatsApp !== false);
      const lower = text.toLowerCase();
      if (lower === '/agents' || lower === 'agents' || lower === 'menu') {
        const list = shared.map((a, i) => `${i + 1}. ${a.emoji || ''} *${a.name}* (/agent ${i + 1})`).join('\n');
        return reply('Available agents on this number:\n' + list + '\n\nReply with /agent <number> to switch.').catch(() => {});
      }
      const m = lower.match(/^\/agent\s+(.+)$/);
      if (m) {
        const q = m[1].trim();
        const pick = /^\d+$/.test(q) ? shared[parseInt(q, 10) - 1] : shared.find(a => a.name.toLowerCase().includes(q));
        if (!pick) return reply('I could not find that agent. Send /agents to see the list.').catch(() => {});
        waChoice.set(from, pick.id);
        waHistories.delete(from);
        return reply(`Switched to ${pick.emoji || ''} *${pick.name}*. Ask away.`).catch(() => {});
      }
      agent = shared.find(a => a.id === waChoice.get(from)) || shared.find(a => a.id === 'agx_web01') || shared[0];
    }
    if (!agent) return;
    const hkey = toPhoneId + ':' + from;
    const history = [...(waHistories.get(hkey) || []), { role: 'user', content: text }].slice(-12);
    console.log('[WA use]', agent.name, linked ? '(linked number)' : '(shared number)');
    groqAsk(agent, history).then(out => {
      if (out.demo) { console.log('[WA out] demo mode'); return; }
      bumpMessages(agent.id);
      waHistories.set(hkey, [...history, { role: 'assistant', content: out.reply }].slice(-12));
      console.log('[WA out]', String(out.reply).replace(/\n/g, ' | ').slice(0, 150));
      return reply(out.reply);
    }).catch(e => { console.log('[WA err]', String(e).slice(0, 200)); return reply('Sorry, I could not answer right now.').catch(() => {}); });
  } catch (e) { /* never crash on a webhook */ }
});

// ---------- Fajr broadcast (subscribers) ----------
const SUBS_FILE = path.join(DATA_DIR, 'subscribers.json');
const SUB_SENT_FILE = path.join(DATA_DIR, 'subs_sent.json');

function addSubscriber(chatId, city) {
  const subs = readJson(SUBS_FILE, {});
  subs[chatId] = { city, platform: 'telegram', since: new Date().toISOString() };
  writeJson(SUBS_FILE, subs);
}

function removeSubscriber(chatId) {
  const subs = readJson(SUBS_FILE, {});
  delete subs[chatId];
  writeJson(SUBS_FILE, subs);
}

function hhmm(iso) { return String(iso).slice(11, 16); }

async function sendFajrBroadcast() {
  const subs = readJson(SUBS_FILE, {});
  const sentToday = readJson(SUB_SENT_FILE, {});
  const today = new Date().toISOString().slice(0, 10);
  const results = [];
  for (const [chatId, sub] of Object.entries(subs)) {
    if (sentToday[chatId] === today) { results.push({ chatId, skipped: true }); continue; }
    try {
      const raw = await ilmCall('/v1/prayer-times', { city: sub.city, method: 'MuslimWorldLeague' });
      const times = JSON.parse(raw);
      const t = times.times || times.data || times;
      const line = `\U0001F319 *Fajr in ${sub.city} today: ${hhmm(t.fajr)}*\nSunrise: ${hhmm(t.sunrise)} — catch it before then, in shaa Allah.`;
      let dua = '';
      try {
        const dr = JSON.parse(await ilmCall('/v1/duas/search', { q: 'morning' }));
        const first = (dr.results && dr.results[0]) || (dr.data && dr.data[0]);
        if (first) dua = `\n\n*Morning dua*\n${(first.arabic || '').slice(0, 200)}\n${(first.english || first.translation || '').slice(0, 220)}`;
      } catch (e) {}
      await tgSend(chatId, line + dua);
      sentToday[chatId] = today;
      results.push({ chatId, city: sub.city, fajr: hhmm(t.fajr), sent: true });
    } catch (e) {
      results.push({ chatId, error: e.message.slice(0, 120) });
    }
  }
  writeJson(SUB_SENT_FILE, sentToday);
  return results;
}

app.post('/broadcast/fajr', async (req, res) => {
  if (!process.env.BROADCAST_TOKEN || req.get('authorization') !== 'Bearer ' + process.env.BROADCAST_TOKEN)
    return res.status(401).json({ error: 'unauthorized' });
  res.json({ ok: true, results: await sendFajrBroadcast() });
});

api.get('/broadcast/subscribers', (req, res) => res.json(readJson(SUBS_FILE, {})));

app.use('/api', api);
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.listen(PORT, () => console.log('AgentX dashboard running on http://localhost:' + PORT));
