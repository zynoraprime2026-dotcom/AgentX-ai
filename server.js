// AgentX — multi-platform AI agent dashboard
// Express backend: agent CRUD, platform channel config, Groq-powered chat console.
const express = require('express');
const path = require('path');

const db = require('./db');

const app = express();
const PORT = process.env.PORT || 3000;
const DATA_DIR = path.join(__dirname, 'data');



function safeEq(a, b) {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}
app.set('trust proxy', 1);
app.use((req, res, next) => {
  res.set({ 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'no-referrer', 'Strict-Transport-Security': 'max-age=15552000' });
  next();
});
// keep the raw body so Meta's webhook signature can be verified
app.use(express.json({ limit: '256kb', verify: (req, res, buf) => { req.rawBody = buf; } }));
const loginHits = new Map();
function rateLimit(max, windowMs) {
  return (req, res, next) => {
    const k = req.path + '|' + req.ip, now = Date.now();
    const hits = (loginHits.get(k) || []).filter(t => now - t < windowMs);
    if (hits.length >= max) return res.status(429).json({ error: 'too many attempts, try again later' });
    hits.push(now); loginHits.set(k, hits); next();
  };
}
app.use((req, res, next) => { if (req.path.startsWith('/api')) res.set('Cache-Control', 'no-store'); next(); });
app.use(express.static(path.join(__dirname, 'public'), { etag: true, maxAge: 0, setHeaders: (res) => res.set('Cache-Control', 'no-cache') }));

const readJson = db.readJson; const writeJson = db.writeJson;
const uid = () => 'agx_' + Math.random().toString(36).slice(2, 9);

// ---------- API ----------
const api = express.Router();

// ---------- multi-tenant accounts ----------
const crypto = require('crypto');


const PUBLIC_API = ['/status', '/auth/status', '/auth/register', '/auth/login', '/auth/logout', '/telegram/status'];
// admin routes pass the middleware (key-checked inside) so the platform owner can manage users without a session

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

async function loadSession(req) {
  const m = /agx_sess=([a-f0-9]+)/.exec(req.headers.cookie || '');
  if (!m) return [null, null];
  return [m[1], await db.getSession(m[1])];
}

api.use(async (req, res, next) => {
  if (PUBLIC_API.includes(req.path)) return next();
  if (req.path.startsWith('/admin/')) return next(); // guarded by x-admin-key or founder session
  const [token, sess] = await loadSession(req);
  if (!sess || new Date(sess.expires) < new Date()) return res.status(401).json({ error: 'login required' });
  req.sessionToken = token; req.user = sess.user;
  next();
});

api.get('/auth/status', async (req, res) => {
  const [, sess] = await loadSession(req);
  const authed = Boolean(sess && new Date(sess.expires) > new Date());
  res.json({ needsLogin: true, authed, user: authed ? sess.user : null });
});

api.post('/auth/register', rateLimit(8, 3600e3), async (req, res) => {
  const { email, password, name, founderKey } = req.body || {};
  const em = String(email || '').trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(em)) return res.status(400).json({ error: 'valid email required' });
  if (String(password || '').length < 6) return res.status(400).json({ error: 'password must be at least 6 characters' });
  if (await db.findUserByEmail(em)) return res.status(409).json({ error: 'that email is already registered' });
  const isFounder = Boolean(process.env.ADMIN_KEY && founderKey === process.env.ADMIN_KEY);
  const id = 'u_' + crypto.randomBytes(5).toString('hex');
  const uname = String(name || em.split('@')[0]).slice(0, 40);
  await db.insertUser({ id, email: em, name: uname, founder: isFounder, pass: hashPassword(password), createdAt: new Date().toISOString() });
  if (isFounder) {
    const agents = await db.listAgents();
    for (const a of agents) if (!a.ownerId) { a.ownerId = id; await db.updateAgent(a); }
  }
  const token = crypto.randomBytes(24).toString('hex');
  const sess = { user: { id, email: em, name: uname, founder: isFounder }, expires: new Date(Date.now() + 30 * 864e5).toISOString() };
  await db.putSession(token, sess);
  res.setHeader('Set-Cookie', 'agx_sess=' + token + '; Path=/; HttpOnly; Secure; Max-Age=2592000; SameSite=Lax');
  res.json({ ok: true, user: sess.user });
});

api.post('/auth/login', rateLimit(10, 900e3), async (req, res) => {
  const { email, password } = req.body || {};
  const em = String(email || '').trim().toLowerCase();
  const u = await db.findUserByEmail(em);
  if (!u || !checkPassword(password, u.pass)) return res.status(401).json({ error: 'wrong email or password' });
  const token = crypto.randomBytes(24).toString('hex');
  const sess = { user: { id: u.id, email: u.email, name: u.name, founder: Boolean(u.founder) }, expires: new Date(Date.now() + 30 * 864e5).toISOString() };
  await db.putSession(token, sess);
  res.setHeader('Set-Cookie', 'agx_sess=' + token + '; Path=/; HttpOnly; Secure; Max-Age=2592000; SameSite=Lax');
  res.json({ ok: true, user: sess.user });
});

api.post('/auth/logout', async (req, res) => {
  const m = /agx_sess=([a-f0-9]+)/.exec(req.headers.cookie || '');
  if (m) await db.delSession(m[1]);
  res.setHeader('Set-Cookie', 'agx_sess=; Path=/; HttpOnly; Secure; Max-Age=0');
  res.json({ ok: true });
});

api.get('/status', async (req, res) => {
  const s = await db.getSettings();
  const cfg = Boolean((s.groqApiKey && s.groqApiKey.startsWith('gsk_')) || (process.env.GROQ_API_KEY || '').startsWith('gsk_'));
  res.json({
    ok: true,
    groqConfigured: cfg,
    telegramConnected: Boolean(process.env.TELEGRAM_BOT_TOKEN),
    whatsappConnected: Boolean(process.env.WHATSAPP_PHONE_NUMBER_ID && process.env.WHATSAPP_ACCESS_TOKEN),
    ilmConnected: Boolean(process.env.ILM_API_KEY),
    storage: db.HAS_PG ? 'postgres' : 'files',
    adminAuth: Boolean(process.env.ADMIN_KEY)
  });
});

api.get('/settings', async (req, res) => {
  if (!req.user.founder) return res.json({ readOnly: true });
  const st = await db.getSettings();
  res.json({ webhookBase: st.webhookBase || '', groqApiKeySet: Boolean(st.groqApiKey), groqApiKeyHint: st.groqApiKey ? '••••' + st.groqApiKey.slice(-4) : '' });
});
api.put('/settings', async (req, res) => {
  if (!req.user.founder) return res.status(403).json({ error: 'settings are managed by the founder' });
  const s = await db.getSettings();
  const { groqApiKey, webhookBase } = req.body || {};
  if (typeof groqApiKey === 'string') s.groqApiKey = groqApiKey.trim();
  if (typeof webhookBase === 'string') s.webhookBase = webhookBase.trim();
  await db.putSettings(s);
  const cfg = Boolean((s.groqApiKey && s.groqApiKey.startsWith('gsk_')) || (process.env.GROQ_API_KEY || '').startsWith('gsk_'));
  res.json({ ok: true, groqConfigured: cfg });
});

// Per-agent WhatsApp tokens live in an untracked file, never in agents.json (which is committed to git)
async function publicAgent(a) {
  const o = Object.assign({}, a);
  o.waTokenSet = Boolean(await db.getAgentToken(a.id));
  delete o.waToken;
  return o;
}

api.get('/agents', async (req, res) => {
  const mine = (await db.listAgents()).filter(a => a.ownerId === req.user.id);
  res.json(await Promise.all(mine.map(publicAgent)));
});

api.post('/agents', async (req, res) => {
  const { name, emoji, description, systemPrompt, model } = req.body || {};
  if (!name || !String(name).trim()) return res.status(400).json({ error: 'name is required' });
  const agent = {
    id: uid(), name: String(name).trim().slice(0, 60),
    emoji: (emoji || '🤖').slice(0, 4), description: String(description || '').slice(0, 300),
    systemPrompt: String(systemPrompt || 'You are a helpful assistant.').slice(0, 4000),
    model: model || 'openai/gpt-oss-120b',
    platforms: { whatsapp: { enabled: false, autoReply: true }, telegram: { enabled: false, autoReply: true } },
    status: 'draft', createdAt: new Date().toISOString(), messagesHandled: 0, ownerId: req.user.id
  };
  await db.insertAgent(agent);
  res.status(201).json(await publicAgent(agent));
});

api.put('/agents/:id', async (req, res) => {
  const a = (await db.listAgents()).find(x => x.id === req.params.id && x.ownerId === req.user.id);
  if (!a) return res.status(404).json({ error: 'agent not found' });
  const allowed = ['name','emoji','description','systemPrompt','model','status','platforms'];
  for (const k of allowed) if (req.body && k in req.body) a[k] = req.body[k];
  if (req.body && 'waPhoneId' in req.body) {
    const pid = String(req.body.waPhoneId || '').replace(/\D/g, '').slice(0, 24);
    const others = (await db.listAgents()).some(x => x.id !== a.id && x.waPhoneId === pid);
    if (pid && others) return res.status(409).json({ error: 'That WhatsApp phone number ID is already linked to another agent' });
    a.waPhoneId = pid || undefined;
  }
  delete a.waToken;
  if (req.body && typeof req.body.waToken === 'string' && req.body.waToken.trim()) await db.setAgentToken(a.id, req.body.waToken.trim().slice(0, 600));
  if (req.body && req.body.waToken === '') await db.setAgentToken(a.id, '');
  await db.updateAgent(a);
  res.json(await publicAgent(a));
});

api.delete('/agents/:id', async (req, res) => {
  const a = (await db.listAgents()).find(x => x.id === req.params.id && x.ownerId === req.user.id);
  if (!a) return res.status(404).json({ error: 'agent not found' });
  await db.deleteAgent(req.params.id);
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
  const st = await db.getSettings();
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

function bumpMessages(agentId) { return db.incMessages(agentId).catch(() => {}); }

// test chat console — same path the Telegram webhook uses
api.post('/chat/:id', async (req, res) => {
  const a = (await db.listAgents()).find(x => x.id === req.params.id && x.ownerId === req.user.id);
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
const tgSelected = new Map();   // chatId -> agent id chosen via /agent (transient)
const tgHist = (chatId) => db.getHistory('telegram', chatId);

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
  const agents = await db.listAgents();

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
        tgSelected.set(chatId, found.id); await db.clearHistory('telegram', chatId);
        return tgSend(chatId, `${found.emoji} You are now talking to ${found.name}.`);
      }
      return tgSend(chatId, `No live agent named "${arg}". Use /agents to list them.`);
    }
  }

  const agent = pickAgent(agents, chatId);
  if (!agent) return; // no live telegram-enabled agent: stay silent
  try {
    const history = [...(await tgHist(chatId)), { role: 'user', content: text }].slice(-12);
    const out = await groqAsk(agent, history);
    if (out.demo) return; // never send demo noise to Telegram
    bumpMessages(agent.id);
    await db.appendHistory('telegram', chatId, 'user', text);
    await db.appendHistory('telegram', chatId, 'assistant', out.reply);
    await tgSend(chatId, out.reply);
  } catch (e) {
    await tgSend(chatId, 'Sorry, I could not answer right now. Please try again.');
  }
}

app.post('/webhook/telegram', (req, res) => {
  if (TG_SECRET && !safeEq(req.get('x-telegram-bot-api-secret-token') || '', TG_SECRET)) return res.status(401).end();
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
const waChoice = new Map(); // shared-number users: sender -> chosen agent id (transient)

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

app.post('/webhook/whatsapp', (req, res) => {
  const appSecret = process.env.WHATSAPP_APP_SECRET || '';
  if (appSecret) {
    const sig = req.get('x-hub-signature-256') || '';
    const want = 'sha256=' + crypto.createHmac('sha256', appSecret).update(req.rawBody || Buffer.from('')).digest('hex');
    if (!safeEq(sig, want)) return res.status(401).end();
  }
  res.json({ ok: true });
  handleWa(req).catch(e => console.log('[WA err]', String(e).slice(0, 200)));
});

async function handleWa(req) {
  const val = req.body && req.body.entry && req.body.entry[0] && req.body.entry[0].changes && req.body.entry[0].changes[0] && req.body.entry[0].changes[0].value;
  const msg = val && val.messages && val.messages[0];
  if (!msg) return;
  const toPhoneId = val.metadata && val.metadata.phone_number_id ? String(val.metadata.phone_number_id) : WA_PHONE_ID;
  const from = msg.from;
  const agents = await db.listAgents();
  const liveWa = a => a.status === 'live' && a.platforms && a.platforms.whatsapp && a.platforms.whatsapp.enabled;
  const linked = agents.find(a => a.waPhoneId && a.waPhoneId === toPhoneId && liveWa(a));
  const linkedToken = linked ? await db.getAgentToken(linked.id) : '';
  const reply = (t) => waSend(from, t, linked ? linked.waPhoneId : undefined, linked ? linkedToken : undefined);
  if (msg.type !== 'text') { console.log('[WA in ] non-text', msg.type); return reply('I can only read text messages for now. Please type your question.'); }
  const text = (msg.text && msg.text.body || '').trim();
  console.log('[WA in ]', toPhoneId, from, String(text).slice(0, 100));
  if (!text) return;
  const hkey = toPhoneId + ':' + from;

  let agent = linked;
  if (!linked) {
    // Shared number: only public showcase agents (no private linked number) are reachable
    const shared = agents.filter(a => liveWa(a) && !a.waPhoneId && a.sharedWhatsApp !== false);
    const lower = text.toLowerCase();
    if (lower === '/agents' || lower === 'agents' || lower === 'menu') {
      const list = shared.map((a, i) => `${i + 1}. ${a.emoji || ''} *${a.name}* (/agent ${i + 1})`).join('\n');
      return reply('Available agents on this number:\n' + list + '\n\nReply with /agent <number> to switch.');
    }
    const m = lower.match(/^\/agent\s+(.+)$/);
    if (m) {
      const q = m[1].trim();
      const pick = /^\d+$/.test(q) ? shared[parseInt(q, 10) - 1] : shared.find(a => a.name.toLowerCase().includes(q));
      if (!pick) return reply('I could not find that agent. Send /agents to see the list.');
      waChoice.set(from, pick.id);
      await db.clearHistory('whatsapp', hkey);
      return reply(`Switched to ${pick.emoji || ''} *${pick.name}*. Ask away.`);
    }
    agent = shared.find(a => a.id === waChoice.get(from)) || shared.find(a => a.id === 'agx_web01') || shared[0];
  }
  if (!agent) return;
  const history = [...(await db.getHistory('whatsapp', hkey)), { role: 'user', content: text }].slice(-12);
  console.log('[WA use]', agent.name, linked ? '(linked number)' : '(shared number)');
  try {
    const out = await groqAsk(agent, history);
    if (out.demo) { console.log('[WA out] demo mode'); return; }
    bumpMessages(agent.id);
    await db.appendHistory('whatsapp', hkey, 'user', text);
    await db.appendHistory('whatsapp', hkey, 'assistant', out.reply);
    console.log('[WA out]', String(out.reply).replace(/\n/g, ' | ').slice(0, 150));
    await reply(out.reply);
  } catch (e) {
    console.log('[WA err]', String(e).slice(0, 200));
    await reply('Sorry, I could not answer right now.').catch(() => {});
  }
}

// ---------- Fajr broadcast (subscribers) ----------
function addSubscriber(chatId, city) { return db.addSubscriber(chatId, city); }
function removeSubscriber(chatId) { return db.removeSubscriber(chatId); }

function hhmm(iso) { return String(iso).slice(11, 16); }

async function sendFajrBroadcast() {
  const subs = await db.listSubscribers();
  const today = new Date().toISOString().slice(0, 10);
  const results = [];
  for (const [chatId, sub] of Object.entries(subs)) {
    if ((await db.getSentDay(chatId)) === today) { results.push({ chatId, skipped: true }); continue; }
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
      await db.putSentDay(chatId, today);
      results.push({ chatId, city: sub.city, fajr: hhmm(t.fajr), sent: true });
    } catch (e) {
      results.push({ chatId, error: e.message.slice(0, 120) });
    }
  }
  return results;
}

app.post('/broadcast/fajr', async (req, res) => {
  if (!process.env.BROADCAST_TOKEN || !safeEq(req.get('authorization') || '', 'Bearer ' + process.env.BROADCAST_TOKEN))
    return res.status(401).json({ error: 'unauthorized' });
  res.json({ ok: true, results: await sendFajrBroadcast() });
});

function isFounderOrKey(req) {
  if (req.user && req.user.founder) return true;
  const k = req.headers['x-admin-key'];
  return Boolean(process.env.ADMIN_KEY && k && k === process.env.ADMIN_KEY);
}
api.get('/admin/users', async (req, res) => {
  if (!isFounderOrKey(req)) return res.status(403).json({ error: 'founder only' });
  res.json(await db.listUsers());
});
api.get('/admin/stats', async (req, res) => {
  if (!isFounderOrKey(req)) return res.status(403).json({ error: 'founder only' });
  const agents = await db.listAgents();
  res.json({
    users: (await db.listUsers()).length,
    agents: agents.length,
    liveAgents: agents.filter(a => a.status === 'live').length,
    unownedAgents: agents.filter(a => !a.ownerId).length,
    subscribers: (await db.listSubscribers()).length
  });
});
api.delete('/admin/users/:id', async (req, res) => {
  if (!isFounderOrKey(req)) return res.status(403).json({ error: 'founder only' });
  const u = (await db.listUsers()).find(x => x.id === req.params.id);
  if (!u) return res.status(404).json({ error: 'user not found' });
  if (u.founder) return res.status(400).json({ error: 'cannot delete the founder account' });
  await db.deleteUser(u.id);
  res.json({ ok: true, deleted: u.email });
});

api.get('/broadcast/subscribers', async (req, res) => { if (!req.user.founder) return res.status(403).json({ error: 'founder only' }); res.json(await db.listSubscribers()); });

app.use('/api', api);
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

async function seedAgents() {
  if ((await db.listAgents()).length) return;
  const now = new Date().toISOString();
  const webPrompt = `You are the AgentX Assistant — the official WhatsApp helpdesk for the AgentX website (https://agentx-byai.onrender.com), built by Zynora AI (Tarkwa, Ghana). Answer in simple, friendly English. Be concise on WhatsApp: short paragraphs, *bold* for emphasis (never **double asterisks**).

WHAT AGENTX IS AND WHAT WE OFFER (answer from these facts):
1. AgentX is a free multi-platform AI agent dashboard: anyone can build their own AI agents that answer on WhatsApp and Telegram.
2. Sign up at the website with name, email and password — every user sees and manages only their own agents (data is isolated). No payment, it is free to use.
3. Each agent has a name, emoji, description, system prompt, and a choice of models: GPT-OSS 120B (most capable), GPT-OSS 20B (fast), Qwen 3.8 27B, or Allam 2 7B (Arabic-strong). Models run on Groq.
4. Per-agent channel controls: toggle WhatsApp and Telegram separately for each agent, and set status to Draft, Live or Paused.
5. Agents can use live Islamic-knowledge tools from the Ilm API: prayer times by city, Quran ayah with translations, hadith search, Arabic dictionary and root search, duas, and comparative fiqh rulings.
6. Free daily Fajr prayer-time broadcast on Telegram: send /subscribe <city> to @AgentXtechbot.
7. The platform is owned and maintained by Zynora AI; agents currently serving users include the Madrasa Assistant (madrasa lessons, timetables, admissions for Al-Haqq Digital madrasa in Tarkwa) and Shop Support (customer help for the shop).

RULES:
- When asked what this is, what the website does, or what we offer, answer from the facts above and mention the website link.
- When asked how to sign up or create an agent, give the steps: open the website, Create account, then New agent, fill name/description/system prompt, pick a model, set Live, toggle channels.
- For Islamic questions (prayer times, Quran, hadith, duas, dictionary, fiqh) use the tools to answer accurately.
- If asked about pricing: the platform is free for users; Zynora AI owns and pays for the infrastructure.
- Never invent features or prices. If something is not in the facts above or your tools, say you will check with the team at Zynora AI and invite the user to ask on the website dashboard.`;
  const madrasaPrompt = 'You are the Madrasa Assistant for Al-Haqq Digital madrasa in Tarkwa, Ghana. Answer kindly and concisely, using simple English. You help with lesson schedules, admission steps and general school questions. When asked about prayer times, Quran verses, hadith, duas or fiqh, use your tools to fetch live accurate data rather than answering from memory. You do not know exact fees, dates or phone numbers. Never invent them; say the madrasa office will confirm.';
  const shopPrompt = 'You are Shop Support for Al-Haqq Digital, a phone accessories shop in Tarkwa, Ghana. Be brief and friendly. You do NOT have the shop\'s address, phone numbers, email, prices, stock, delivery or return policies. Never invent them. If asked, say you will pass the question to the shop team and ask for the customer\'s name and what they need. Only discuss accessories in general terms.';
  const seeds = [
    { id: 'agx_web01', name: 'AgentX Assistant', emoji: '🌐', description: 'Website helpdesk: explains the AgentX platform, what it offers, sign-up steps, and channels.', systemPrompt: webPrompt, platforms: { whatsapp: { enabled: true, autoReply: true }, telegram: { enabled: false, autoReply: false } }, messagesHandled: 0 },
    { id: 'agx_mad01', name: 'Madrasa Assistant', emoji: '🕌', description: 'Answers student & parent questions about madrasa lessons, timetables and admissions.', systemPrompt: madrasaPrompt, platforms: { whatsapp: { enabled: true, autoReply: true }, telegram: { enabled: true, autoReply: true } }, messagesHandled: 128 },
    { id: 'agx_shp01', name: 'Shop Support', emoji: '🛍️', description: 'Handles product questions and order status for the Al-Haqq Digital phone accessories shop.', systemPrompt: shopPrompt, platforms: { whatsapp: { enabled: true, autoReply: true }, telegram: { enabled: true, autoReply: true } }, messagesHandled: 47 }
  ];
  for (const sd of seeds) {
    await db.insertAgent(Object.assign({ model: 'openai/gpt-oss-120b', status: 'live', createdAt: now }, sd));
  }
  console.log('Seeded', seeds.length, 'agents');
}

db.init().then(() => seedAgents()).then(() => {
  app.listen(PORT, () => console.log('AgentX dashboard running on http://localhost:' + PORT + (db.HAS_PG ? ' [postgres]' : ' [json files]')));
}).catch(e => { console.error('Failed to start:', e); process.exit(1); });
