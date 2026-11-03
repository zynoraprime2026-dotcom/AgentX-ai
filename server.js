// AgentX — multi-platform AI agent dashboard
// Express backend: agent CRUD, platform channel config, Groq-powered chat console.
const express = require('express');
const path = require('path');

const db = require('./db');
const suite = require('./lib/suite');

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
// Serve the dashboard explicitly for '/' (serve-static's directory-index handling has crashed on Vercel).
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.use(express.static(path.join(__dirname, 'public'), { etag: true, maxAge: 0, setHeaders: (res) => res.set('Cache-Control', 'no-cache') }));

const readJson = db.readJson; const writeJson = db.writeJson;
const uid = () => 'agx_' + Math.random().toString(36).slice(2, 9);

// ---------- API ----------
const api = express.Router();

// ---------- multi-tenant accounts ----------
const crypto = require('crypto');


const PUBLIC_API = ['/status', '/auth/status', '/auth/register', '/auth/login', '/auth/logout', '/auth/recover', '/telegram/status', '/cron/fajr', '/cron/tick'];
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

// Founder-key recovery: no email provider is involved, so the founder key is the
// reset channel. This is the only way back in for an account whose password is lost.
api.post('/auth/recover', rateLimit(6, 3600e3), async (req, res) => {
  const { email, founderKey, password } = req.body || {};
  const em = String(email || '').trim().toLowerCase();
  if (String(password || '').length < 6) return res.status(400).json({ error: 'new password must be at least 6 characters' });
  if (!process.env.ADMIN_KEY) return res.status(503).json({ error: 'Password recovery needs ADMIN_KEY to be set on the server' });
  if (String(founderKey || '') !== process.env.ADMIN_KEY) return res.status(403).json({ error: 'that founder key is not correct' });
  const u = await db.findUserByEmail(em);
  if (!u) return res.status(404).json({ error: 'no account with that email' });
  await db.updateUserPass(u.id, hashPassword(password));
  const token = crypto.randomBytes(24).toString('hex');
  const sess = { user: { id: u.id, email: u.email, name: u.name, founder: Boolean(u.founder) }, expires: new Date(Date.now() + 30 * 864e5).toISOString() };
  await db.putSession(token, sess);
  res.setHeader('Set-Cookie', 'agx_sess=' + token + '; Path=/; HttpOnly; Secure; Max-Age=2592000; SameSite=Lax');
  res.json({ ok: true, user: sess.user });
});

api.post('/auth/password', async (req, res) => {
  const { current, next } = req.body || {};
  const [, sess] = await loadSession(req);
  if (!sess) return res.status(401).json({ error: 'login required' });
  if (String(next || '').length < 6) return res.status(400).json({ error: 'new password must be at least 6 characters' });
  const u = await db.findUserByEmail(sess.user.email);
  if (!u) return res.status(404).json({ error: 'account not found' });
  if (!checkPassword(current, u.pass)) return res.status(403).json({ error: 'current password is wrong' });
  await db.updateUserPass(u.id, hashPassword(next));
  res.json({ ok: true });
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
    ilmConnected: Boolean(process.env.ILM_API_KEY || ((await db.getSettings()).ilmApiKey || '')),
    studioConnected: Boolean(process.env.STUDIO_API_KEY),
    turathConnected: Boolean(process.env.TURATH_API_KEY),
    storage: db.HAS_PG ? 'postgres' : 'files',
    adminAuth: Boolean(process.env.ADMIN_KEY)
  });
});

api.get('/settings', async (req, res) => {
  if (!req.user.founder) return res.json({ readOnly: true });
  const st = await db.getSettings();
  res.json({ webhookBase: st.webhookBase || '', groqApiKeySet: Boolean(st.groqApiKey), groqApiKeyHint: st.groqApiKey ? '••••' + st.groqApiKey.slice(-4) : '', ilmApiKeySet: Boolean(st.ilmApiKey), ilmApiKeyHint: st.ilmApiKey ? '••••' + st.ilmApiKey.slice(-4) : '' });
});
api.put('/settings', async (req, res) => {
  if (!req.user.founder) return res.status(403).json({ error: 'settings are managed by the founder' });
  const s = await db.getSettings();
  const { groqApiKey, webhookBase, ilmApiKey } = req.body || {};
  if (typeof groqApiKey === 'string') s.groqApiKey = groqApiKey.trim();
  if (typeof webhookBase === 'string') s.webhookBase = webhookBase.trim();
  if (typeof ilmApiKey === 'string') s.ilmApiKey = ilmApiKey.trim();
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
  const mine = (await db.listAgents())
    .filter(a => a.ownerId === req.user.id)
    .sort((a, b) => (a.sortOrder || 0) - (b.sortOrder || 0) || String(a.createdAt).localeCompare(String(b.createdAt)));
  res.json(await Promise.all(mine.map(publicAgent)));
});

api.post('/agents', async (req, res) => {
  const { name, emoji, description, systemPrompt, model, persona, languages, autoLanguage, groupReply } = req.body || {};
  if (!name || !String(name).trim()) return res.status(400).json({ error: 'name is required' });
  const mine = (await db.listAgents()).filter(x => x.ownerId === req.user.id);
  const plan = await suite.planFor(req.user).catch(() => null);
  if (plan && mine.length >= plan.limits.agents) {
    return res.status(402).json({ error: 'Your ' + plan.name + ' plan allows ' + plan.limits.agents + ' agents. Upgrade for more.', upgrade: true });
  }
  const agent = {
    id: uid(), name: String(name).trim().slice(0, 60),
    emoji: (emoji || '🤖').slice(0, 4), description: String(description || '').slice(0, 300),
    systemPrompt: String(systemPrompt || 'You are a helpful assistant.').slice(0, 4000),
    model: model || 'openai/gpt-oss-120b',
    platforms: { whatsapp: { enabled: false, autoReply: true }, telegram: { enabled: false, autoReply: true } },
    persona: persona && typeof persona === 'object' ? persona : {},
    languages: Array.isArray(languages) ? languages.slice(0, 8) : [],
    autoLanguage: autoLanguage !== false,
    groupReply: groupReply === 'always' ? 'always' : 'mention',
    sortOrder: mine.length,
    knowledgeEnabled: req.body && req.body.knowledgeEnabled === false ? false : true,
    status: 'draft', createdAt: new Date().toISOString(), messagesHandled: 0, ownerId: req.user.id
  };
  await db.insertAgent(agent);
  res.status(201).json(await publicAgent(agent));
});

api.put('/agents/:id', async (req, res) => {
  const a = (await db.listAgents()).find(x => x.id === req.params.id && x.ownerId === req.user.id);
  if (!a) return res.status(404).json({ error: 'agent not found' });
  const allowed = ['name','emoji','description','systemPrompt','model','status','platforms','persona','languages','autoLanguage','groupReply','sortOrder','knowledgeEnabled'];
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

async function getIlmKey() {
  if (process.env.ILM_API_KEY) return process.env.ILM_API_KEY;
  try { return (await db.getSettings()).ilmApiKey || ''; } catch (e) { return ''; }
}

async function ilmCall(pathname, params) {
  const qs = params ? '?' + new URLSearchParams(Object.entries(params).filter(([, v]) => v !== undefined && v !== '')) : '';
  const r = await fetch(ILM_API_URL + pathname + qs, { headers: { 'x-api-key': await getIlmKey() } });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error('Ilm API error: ' + JSON.stringify(d).slice(0, 200));
  const str = typeof d === 'string' ? d : JSON.stringify(d);
  return str.length > 2200 ? str.slice(0, 2200) + '…[truncated]' : str;
}

// ---------- Studio API (images + content scaffolding) ----------
const STUDIO_API_URL = (process.env.STUDIO_API_URL || 'https://studio-api-nqpm.onrender.com').replace(/\/$/, '');
const STUDIO_API_KEY = process.env.STUDIO_API_KEY || '';

async function studioCall(pathname, body) {
  if (!STUDIO_API_KEY) throw new Error('Studio API is not configured on this server.');
  const r = await fetch(STUDIO_API_URL + pathname, {
    method: body ? 'POST' : 'GET',
    headers: { 'x-api-key': STUDIO_API_KEY, 'Content-Type': 'application/json', 'User-Agent': 'AgentX/1.0' },
    body: body ? JSON.stringify(body) : undefined
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error('Studio API error: ' + JSON.stringify(d).slice(0, 200));
  const str = typeof d === 'string' ? d : JSON.stringify(d);
  return str.length > 2200 ? str.slice(0, 2200) + '…[truncated]' : str;
}

// Per-chat daily caps so a public agent cannot burn rendering quota
async function toolQuota(ctx, tool, limit) {
  try {
    const p = require('./db').poolRef;
    if (!p || !ctx || !ctx.chatId) return true;
    const day = new Date().toISOString().slice(0, 10);
    await p.query('CREATE TABLE IF NOT EXISTS agx_tool_uses (chat_id text, day text, tool text, uses int NOT NULL DEFAULT 0, PRIMARY KEY (chat_id, day, tool))');
    const r = await p.query('INSERT INTO agx_tool_uses (chat_id, day, tool, uses) VALUES ($1,$2,$3,1) ON CONFLICT (chat_id, day, tool) DO UPDATE SET uses = agx_tool_uses.uses + 1 RETURNING uses', [String(ctx.chatId), day, tool]);
    return (r.rows[0] && r.rows[0].uses || 1) <= limit;
  } catch (e) { console.log('[quota err]', String(e).slice(0, 120)); return true; }
}

const STUDIO_TOOLS = STUDIO_API_KEY ? [
  { type: 'function', function: {
      name: 'generate_image',
      description: 'Create an original image from a text prompt and get back a public image URL. Use for posters, illustrations, reminders, thumbnails and visual explainers. Keep prompts descriptive and free of forbidden imagery.',
      parameters: { type: 'object', properties: {
        prompt: { type: 'string', description: 'Detailed description of the image to generate' },
        width: { type: 'integer', description: 'Pixel width, 256-1920 (default 1024)' },
        height: { type: 'integer', description: 'Pixel height, 256-1920 (default 1024)' }
      }, required: ['prompt'] } } },
  { type: 'function', function: {
      name: 'create_content',
      description: 'Draft content for a topic: a short video script, a structured lesson outline, or a set of social posts. Use when the user wants teaching material, da\'wah captions or a lesson plan.',
      parameters: { type: 'object', properties: {
        type: { type: 'string', enum: ['shorts_script', 'lesson', 'social_post'], description: 'Kind of content to draft' },
        topic: { type: 'string', description: 'The subject to write about' },
        audience: { type: 'string', description: 'Who it is for (e.g. new Muslims, children, general)' }
      }, required: ['type', 'topic'] } } }
] : [];

// ---------- Turath API (manuscripts, scholars, chronology) ----------
const TURATH_API_URL = (process.env.TURATH_API_URL || 'https://turath-api.vercel.app').replace(/\/$/, '');
const TURATH_API_KEY = process.env.TURATH_API_KEY || '';

async function turathCall(pathname, params) {
  if (!TURATH_API_KEY) throw new Error('Turath API not configured');
  const qs = params ? '?' + new URLSearchParams(Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== '')).toString() : '';
  const r = await fetch(TURATH_API_URL + pathname + qs, {
    headers: { 'x-api-key': TURATH_API_KEY, 'User-Agent': 'AgentX/1.0' }
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error('Turath API error: ' + JSON.stringify(d).slice(0, 180));
  const str = typeof d === 'string' ? d : JSON.stringify(d);
  return str.length > 2400 ? str.slice(0, 2400) + '…[truncated]' : str;
}

const TURATH_TOOLS = TURATH_API_KEY ? [
  { type: 'function', function: {
      name: 'search_manuscripts',
      description: 'Search the Turath database of Islamic manuscripts (47 records: Qurans, biographical dictionaries, scholarly works) by keyword, subject, language, region or century.',
      parameters: { type: 'object', properties: {
        query: { type: 'string', description: 'Keyword: title, author, holding library or description' },
        subject: { type: 'string', description: 'Subject, e.g. Quran, Hadith, Biography & Scholarship, Fiqh' },
        language: { type: 'string', description: 'Arabic, Persian, Malay (Jawi script)…' },
        region: { type: 'string', description: 'Region of origin, e.g. Hijaz, Sahel, Andalusia' },
        century: { type: 'integer', description: 'Hijri century as a number, e.g. 10' }
      }, required: ['query'] } } },
  { type: 'function', function: {
      name: 'get_manuscript',
      description: 'Fetch the full record of one Turath manuscript by its numeric id: title, author, date, script, holding library, description and any digital or image link.',
      parameters: { type: 'object', properties: { id: { type: 'integer', description: 'Manuscript id from a previous search' } }, required: ['id'] } } },
  { type: 'function', function: {
      name: 'manuscript_of_the_day',
      description: 'Get the Turath manuscript featured for today. Use it as a warm opener or a daily knowledge share.',
      parameters: { type: 'object', properties: {}, required: [] } } },
  { type: 'function', function: {
      name: 'search_scholars',
      description: 'Search Turath scholar biographies (classical Islamic scholars, their era, field, region and works).',
      parameters: { type: 'object', properties: {
        query: { type: 'string', description: 'Scholar name, work or topic' },
        field: { type: 'string', description: 'Field of scholarship, e.g. Hadith, Tafsir, Fiqh, History' }
      }, required: ['query'] } } },
  { type: 'function', function: {
      name: 'search_historical_events',
      description: 'Search Turath Islamic historical events and chronology by keyword or year.',
      parameters: { type: 'object', properties: {
        query: { type: 'string', description: 'Event keyword, e.g. Timbuktu, Andalusia, Hajj' },
        year: { type: 'integer', description: 'Hijri year' }
      }, required: ['query'] } } }
] : [];

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

const PROFILE_TOOLS = [
  { type: 'function', function: {
      name: 'get_customer_profile',
      description: "Look up the saved profile of the customer you are currently chatting with (their name, phone and notes from previous chats). Call this at the START of a conversation so you can greet returning customers by name.",
      parameters: { type: 'object', properties: {}, required: [] } } },
  { type: 'function', function: {
      name: 'save_customer_profile',
      description: 'Save or update the current customer profile so they are recognised next time. Call whenever the customer shares their name, phone number, or a lasting preference/need.',
      parameters: { type: 'object', properties: {
        name: { type: 'string', description: 'Customer name' },
        phone: { type: 'string', description: 'Customer WhatsApp/phone number' },
        notes: { type: 'string', description: 'Short notes: usual orders, interests, preferences' }
      }, required: ['name'] } } }
];

async function runTool(name, args, ctx) {
  try {
    switch (name) {
      case 'generate_image': {
        if (!(await toolQuota(ctx, 'image', 3))) return 'This chat has reached its daily limit of 3 images. Tell the user to try again tomorrow, or offer a text description instead.';
        const raw = await studioCall('/v1/image/generate', { prompt: args.prompt, width: args.width, height: args.height });
        try {
          const j = JSON.parse(raw);
          if (j && j.url && ctx) ctx.imageUrl = j.url;
          return 'Image generated (share this URL): ' + (j.url || raw);
        } catch (e) { return raw; }
      }
      case 'create_content': {
        if (!(await toolQuota(ctx, 'content', 10))) return 'This chat has reached its daily limit for content drafts. Tell the user to try again tomorrow.';
        return await studioCall('/v1/content/generate', { type: args.type, topic: args.topic, audience: args.audience });
      }
      case 'search_manuscripts': return await turathCall('/api/manuscripts', { q: args.query, subject: args.subject, language: args.language, region: args.region, century: args.century, per: 5 });
      case 'get_manuscript': return await turathCall('/api/manuscripts/' + encodeURIComponent(args.id));
      case 'manuscript_of_the_day': return await turathCall('/api/manuscripts/daily');
      case 'search_scholars': return await turathCall('/api/scholars', { q: args.query, field: args.field, per: 5 });
      case 'search_historical_events': return await turathCall('/api/events', { q: args.query, year: args.year, per: 5 });
      case 'get_prayer_times': return await ilmCall('/v1/prayer-times', { city: args.city, date: args.date, method: 'MuslimWorldLeague' });
      case 'get_quran_ayah': return await ilmCall(`/v1/quran/${args.surah}/${args.ayah}`, { translation: args.translation });
      case 'search_hadith': return await ilmCall('/v1/hadith/search', { q: args.query, collection: args.collection, language: args.language, limit: 5 });
      case 'search_dictionary':
        return args.mode === 'root'
          ? await ilmCall('/v1/dictionary/root/' + encodeURIComponent(args.query))
          : await ilmCall('/v1/dictionary/search', { q: args.query });
      case 'get_dua': return args.search ? await ilmCall('/v1/duas/search', { q: args.search }) : await ilmCall('/v1/duas/random');
      case 'get_fiqh_ruling': return await ilmCall('/v1/fiqh/search', { topic: args.topic });
      case 'get_customer_profile': {
        if (!ctx) return 'No chat context available.';
        const p = await db.getProfile(ctx.channel, ctx.chatId);
        return Object.keys(p).length ? 'Saved profile of this customer: ' + JSON.stringify(p) : 'No saved profile yet — this is a first-time customer. Introduce yourself and ask their name.';
      }
      case 'save_customer_profile': {
        if (!ctx) return 'No chat context available.';
        const patch = {};
        for (const k of ['name', 'phone', 'notes']) if (args[k]) patch[k] = String(args[k]).slice(0, 400);
        if (!patch.name) return 'Nothing saved — a name is required.';
        const p = await db.saveProfile(ctx.channel, ctx.chatId, patch);
        return 'Profile saved: ' + JSON.stringify(p);
      }
      case 'shop_list_products': {
        const d = await shopCall('/api/products');
        const lines = (d.products || []).map(p => `- ${p.name} (category: ${p.category || 'general'}) — GH₵${Number(p.price).toFixed(2)}, stock: ${p.stock}${p.stock <= 3 ? ' (LOW)' : ''}`);
        return lines.length ? 'Current shop products:\n' + lines.join('\n') : 'The shop product list is currently empty — no items have been added yet. Tell the customer the shop team can be contacted directly.';
      }
      default: return 'Unknown tool';
    }
  } catch (e) { return 'Tool error: ' + e.message; }
}

// ---------- Al-Haqq Ops shop tools (read-only) ----------
const ALHAQQ_OPS_API_URL = (process.env.ALHAQQ_OPS_API_URL || 'https://alhaqq-ops-api.vercel.app').replace(/\/$/, '');
const ALHAQQ_OPS_API_KEY = process.env.ALHAQQ_OPS_API_KEY || '';

async function shopCall(pathname) {
  const r = await fetch(ALHAQQ_OPS_API_URL + pathname, { headers: { 'x-api-key': ALHAQQ_OPS_API_KEY } });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error('Shop API error: ' + JSON.stringify(d).slice(0, 200));
  return d;
}

const SHOP_TOOLS = ALHAQQ_OPS_API_KEY ? [
  {
    type: 'function',
    function: {
      name: 'shop_list_products',
      description: 'List the shop products currently in stock with live prices in Ghana cedis (GHS) and stock counts. Use for ANY customer question about what the shop sells, prices, availability or stock of an item.',
      parameters: { type: 'object', properties: {}, required: [] }
    }
  }
] : [];

// ---------- shared Groq call ----------

async function groqAsk(agent, history, ctx) {
  const st = await db.getSettings();
  const key = (st.groqApiKey && st.groqApiKey.startsWith('gsk_')) ? st.groqApiKey : (process.env.GROQ_API_KEY || '');
  if (!key.startsWith('gsk_')) {
    const last = history.length ? history[history.length - 1].content : '';
    return { reply: `*[demo mode — add a Groq API key in Settings to go live]*\n\n${agent.name} here. You said: "${(last || '').slice(0, 120)}".`, demo: true };
  }
  let extras = '';
  try {
    const lastUser = [...history].reverse().find(m => m.role === 'user');
    extras = await suite.promptExtras(agent, {
      query: lastUser ? String(lastUser.content || '') : '',
      channel: ctx && ctx.channel,
      isGroup: Boolean(ctx && ctx.isGroup)
    });
  } catch (e) { console.log('[prompt extras]', String(e).slice(0, 120)); }
  const messages = [{ role: 'system', content: agent.systemPrompt + (extras ? '\n\n' + extras : '') }, ...history];
  const ilmKey = await getIlmKey();
  for (let round = 0; round < 4; round++) {
    const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + key, 'Content-Type': 'application/json', 'User-Agent': 'AgentX/1.0' },
      signal: AbortSignal.timeout(90000),
      body: JSON.stringify({
        model: agent.model,
        messages,
        tools: [...TOOLS, ...SHOP_TOOLS, ...PROFILE_TOOLS, ...STUDIO_TOOLS, ...TURATH_TOOLS],
        tool_choice: 'auto',
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
      const result = await runTool(c.function.name, args, ctx);
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
  const lastUser = [...history].reverse().find(m => m.role === 'user');
  const started = Date.now();
  const base = { ownerId: req.user.id, agentId: a.id, agentName: a.name, channel: 'web' };
  suite.logEvent({ ...base, kind: 'message', query: lastUser ? String(lastUser.content || '').slice(0, 300) : '' });
  try {
    const out = await groqAsk(a, history, { channel: 'web', chatId: req.user.id });
    if (!out.demo) {
      bumpMessages(a.id);
      suite.logEvent({ ...base, kind: 'reply', latency: Date.now() - started, query: lastUser ? String(lastUser.content || '').slice(0, 300) : '' });
    }
    res.json(out);
  } catch (e) {
    suite.logEvent({ ...base, kind: 'error', error: String(e.message).slice(0, 200) });
    res.status(502).json({ error: e.message });
  }
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
    const r = await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text: c }),
      signal: AbortSignal.timeout(15000)
    }).catch((e) => { console.log('[tg send]', String(e.message).slice(0, 120)); return null; });
    if (r && !r.ok) {
      const d = await r.json().catch(() => ({}));
      throw new Error('telegram: ' + ((d.description || r.status) + '').slice(0, 120));
    }
  }
}

async function tgSendPhoto(chatId, photoUrl, caption) {
  const r = await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendPhoto`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, photo: photoUrl, caption: captionClean(caption).slice(0, 1000) }),
    signal: AbortSignal.timeout(20000)
  }).catch((e) => { console.log('[tg photo]', String(e.message).slice(0, 120)); return null; });
  if (r && !r.ok) console.log('[tg photo] failed', r.status);
}

// A Telegram voice note: download it, transcribe with Whisper, then answer as if typed.
async function handleTgVoice(msg) {
  const chatId = msg.chat && msg.chat.id;
  if (!chatId || !TG_TOKEN) return;
  const fileId = msg.voice && msg.voice.file_id;
  if (!fileId) return;
  const info = await (await fetch(`https://api.telegram.org/bot${TG_TOKEN}/getFile?file_id=${encodeURIComponent(fileId)}`, { signal: AbortSignal.timeout(15000) })).json();
  const filePath = info && info.result && info.result.file_path;
  if (!filePath) return tgSend(chatId, 'I could not fetch that voice note.');
  const audio = await fetch(`https://api.telegram.org/file/bot${TG_TOKEN}/${filePath}`);
  const buf = Buffer.from(await audio.arrayBuffer());
  let text = '';
  try {
    text = await suite.transcribeBuffer(buf, msg.voice.mime_type || 'audio/ogg');
  } catch (e) {
    return tgSend(chatId, 'I could not hear that clearly. Please type it, or try again.');
  }
  if (!text.trim()) return tgSend(chatId, 'That voice note came through empty. Please try again.');
  await handleTgMessage(Object.assign({}, msg, { text, voice: undefined }));
}

async function handleTgMessage(msg) {
  const chatId = msg.chat && msg.chat.id;
  const text = (msg.text || '').trim();
  if (!chatId || !text) return;
  const agents = await db.listAgents();
  const isGroup = ['group', 'supergroup'].includes((msg.chat && msg.chat.type) || '');
  const anyAgent = pickAgent(agents, chatId);

  if (text.startsWith('/')) {
    const cmd = text.split(/\s+/)[0].split('@')[0].toLowerCase();
    const arg = text.split(/\s+/).slice(1).join(' ').trim();
    if (cmd === '/start' || cmd === '/help') {
      return tgSend(chatId,
        '👋 Welcome to AgentX!\n\nI am an AI assistant running on Groq with live access to prayer times, Quran, hadith, duas and more.\n' +
        'Commands:\n/agents — list available assistants\n/agent <name> — talk to a specific one\n/remind 30m drink water — set a reminder\n/reminders — your pending reminders\n\nJust type your question.\n/subscribe <city> — daily Fajr time + morning dua');
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
    if (cmd === '/remind') {
      const r = await suite.quickReminder({ agent: anyAgent, channel: 'telegram', chatId, arg });
      return tgSend(chatId, r.reply);
    }
    if (cmd === '/reminders') {
      const mine = (await suite.docs.list('reminders', { chatId: String(chatId) })).filter(r => r.status === 'pending');
      if (!mine.length) return tgSend(chatId, 'No pending reminders. Set one with /remind 30m drink water.');
      return tgSend(chatId, 'Pending reminders:\n' + mine.slice(0, 10).map(r => '• ' + r.dueAt.slice(0, 16).replace('T', ' ') + ' UTC — ' + r.title).join('\n'));
    }
  }

  const agent = pickAgent(agents, chatId);
  if (!agent) return; // no live telegram-enabled agent: stay silent
  if (isGroup) {
    const replyToBot = Boolean(msg.reply_to_message && msg.reply_to_message.from && msg.reply_to_message.from.is_bot);
    const mentioned = (msg.entities || []).some(e => e.type === 'mention') || /@\w+/.test(text);
    const allowed = suite.shouldAnswerGroup({ isGroup: true, mode: agent.groupReply, text, botNames: [agent.name], replyToBot: replyToBot || mentioned });
    if (!allowed) return; // group etiquette: only answer when addressed
  }
  const tgBase = { ownerId: agent.ownerId, agentId: agent.id, agentName: agent.name, channel: 'telegram' };
  const tgStarted = Date.now();
  suite.logEvent({ ...tgBase, kind: 'message', query: String(text).slice(0, 300) });
  try {
    const history = [...(await tgHist(chatId)), { role: 'user', content: text }].slice(-12);
    const ctx = { channel: 'telegram', chatId: String(chatId), isGroup };
    const out = await groqAsk(agent, history, ctx);
    if (out.demo) return; // never send demo noise to Telegram
    bumpMessages(agent.id);
    suite.logEvent({ ...tgBase, kind: 'reply', latency: Date.now() - tgStarted, query: String(text).slice(0, 300) });
    await db.appendHistory('telegram', chatId, 'user', text);
    await db.appendHistory('telegram', chatId, 'assistant', out.reply);
    if (ctx.imageUrl) await tgSendPhoto(chatId, ctx.imageUrl, out.reply);
    else await tgSend(chatId, out.reply);
  } catch (e) {
    suite.logEvent({ ...tgBase, kind: 'error', error: String(e.message).slice(0, 200) });
    await tgSend(chatId, 'Sorry, I could not answer right now. Please try again.');
  }
}

app.post('/webhook/telegram', (req, res) => {
  if (TG_SECRET && !safeEq(req.get('x-telegram-bot-api-secret-token') || '', TG_SECRET)) return res.status(401).end();
  const upd = req.body || {};
  const msg = upd.message || upd.edited_message;
  if (msg && msg.voice) {
    handleTgVoice(msg).catch(e => console.log('[TG voice]', String(e).slice(0, 160)));
  } else if (msg && msg.text) handleTgMessage(msg).catch(() => {});
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
  const r = await fetch(`https://graph.facebook.com/v21.0/${pid}/messages`, {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + tok, 'Content-Type': 'application/json' },
    body: JSON.stringify({ messaging_product: 'whatsapp', to, type: 'text', text: { body: String(text).slice(0, 3800) } }),
    signal: AbortSignal.timeout(15000)
  }).catch((e) => { console.log('[wa send]', String(e.message).slice(0, 120)); return null; });
  if (r && !r.ok) {
    const d = await r.json().catch(() => ({}));
    throw new Error('whatsapp: ' + ((d.error && d.error.message) || r.status + '').slice(0, 120));
  }
}

function captionClean(text) {
  return String(text || '')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/https?:\/\/\S+/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .trim();
}

// Meta keeps media behind a two-step URL that needs the same access token.
async function waMedia(mediaId, phoneId, token) {
  const pid = phoneId || WA_PHONE_ID, tok = token || WA_TOKEN;
  if (!pid || !tok) throw new Error('WhatsApp is not connected');
  const meta = await (await fetch(`https://graph.facebook.com/v21.0/${mediaId}`, { headers: { Authorization: 'Bearer ' + tok } })).json();
  if (!meta || !meta.url) throw new Error((meta && meta.error && meta.error.message) || 'media lookup failed');
  const r = await fetch(meta.url, { headers: { Authorization: 'Bearer ' + tok } });
  if (!r.ok) throw new Error('media download failed (' + r.status + ')');
  return Buffer.from(await r.arrayBuffer());
}

async function waSendImage(to, imageUrl, caption, phoneId, token) {
  const pid = phoneId || WA_PHONE_ID, tok = token || WA_TOKEN;
  if (!pid || !tok) return;
  const body = { messaging_product: 'whatsapp', to, type: 'image', image: { link: imageUrl } };
  if (caption) body.image.caption = captionClean(caption).slice(0, 900);
  const r = await fetch(`https://graph.facebook.com/v21.0/${pid}/messages`, {
    method: 'POST', headers: { 'Authorization': 'Bearer ' + tok, 'Content-Type': 'application/json' },
    body: JSON.stringify(body), signal: AbortSignal.timeout(20000)
  }).catch((e) => { console.log('[wa img]', String(e.message).slice(0, 120)); return null; });
  if (r && !r.ok) console.log('[WA img err]', (await r.text()).slice(0, 160));
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
  const chatTarget = msg.group_id || from;
  const reply = (t) => waSend(chatTarget, t, linked ? linked.waPhoneId : undefined, linked ? linkedToken : undefined);
  let text = '';
  if (msg.type === 'text') {
    text = (msg.text && msg.text.body || '').trim();
  } else if (msg.type === 'audio' || msg.type === 'voice') {
    const pid = linked ? linked.waPhoneId : WA_PHONE_ID;
    const tok = linked ? linkedToken : WA_TOKEN;
    try {
      const buf = await waMedia(msg[msg.type].id, pid, tok);
      text = await suite.transcribeBuffer(buf, msg[msg.type].mime_type || 'audio/ogg');
      console.log('[WA voice]', String(text).slice(0, 100));
      if (!text) return reply('I could not hear that clearly. Please type it or send the voice note again.');
    } catch (e) {
      console.log('[WA voice err]', String(e.message).slice(0, 160));
      return reply('I could not read that voice note. Please type your question instead.');
    }
  } else {
    console.log('[WA in ] non-text', msg.type);
    return reply('I can read text and voice notes. Please type your question or send a voice note.');
  }
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
  const isGroup = Boolean(msg.group_id || /@g\.us$/i.test(String(msg.group_id || '')) || /@g\.us$/i.test(String(from)));
  if (isGroup) {
    const allowed = suite.shouldAnswerGroup({ isGroup: true, mode: agent.groupReply, text, botNames: [agent.name, 'agentx'] });
    if (!allowed) { console.log('[WA group] not addressed, staying silent'); return; }
  }
  const history = [...(await db.getHistory('whatsapp', hkey)), { role: 'user', content: text }].slice(-12);
  console.log('[WA use]', agent.name, linked ? '(linked number)' : '(shared number)');
  const waBase = { ownerId: agent.ownerId, agentId: agent.id, agentName: agent.name, channel: 'whatsapp' };
  const waStarted = Date.now();
  suite.logEvent({ ...waBase, kind: 'message', query: String(text).slice(0, 300) });
  try {
    const ctx = { channel: 'whatsapp', chatId: String(hkey), isGroup };
    const out = await groqAsk(agent, history, ctx);
    if (out.demo) { console.log('[WA out] demo mode'); return; }
    bumpMessages(agent.id);
    suite.logEvent({ ...waBase, kind: 'reply', latency: Date.now() - waStarted, query: String(text).slice(0, 300) });
    await db.appendHistory('whatsapp', hkey, 'user', text);
    await db.appendHistory('whatsapp', hkey, 'assistant', out.reply);
    console.log('[WA out]', String(out.reply).replace(/\n/g, ' | ').slice(0, 150));
    if (ctx.imageUrl) {
      await waSendImage(chatTarget, ctx.imageUrl, out.reply, linked ? linked.waPhoneId : undefined, linked ? linkedToken : undefined);
    } else {
      await reply(out.reply);
    }
  } catch (e) {
    console.log('[WA err]', String(e).slice(0, 200));
    suite.logEvent({ ...waBase, kind: 'error', error: String(e.message).slice(0, 200) });
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

// Vercel cron (or any external scheduler) pings this GET daily before dawn.
// Guarded by CRON_SECRET (falls back to BROADCAST_TOKEN so either can be used).
api.get('/cron/fajr', async (req, res) => {
  const token = process.env.CRON_SECRET || process.env.BROADCAST_TOKEN;
  const auth = req.get('authorization') || '';
  if (token && auth !== 'Bearer ' + token) return res.status(401).json({ error: 'unauthorized' });
  const results = await sendFajrBroadcast();
  const ticked = await suite.tick().catch(e => ({ error: String(e).slice(0, 160) }));
  res.json({ ok: true, results, reminders: ticked.reminders, triggers: ticked.triggers });
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
api.get('/admin/dbtest', async (req, res) => {
  if (!isFounderOrKey(req)) return res.status(403).json({ error: 'founder only' });
  const https = require('https');
  const events = [];
  await new Promise((r) => https.get('https://api.ipify.org?format=json', { timeout: 8000 }, (rs) => {
    let b = ''; rs.on('data', (c) => b += c); rs.on('end', () => { events.push('egress-ip: ' + b); r(); });
  }).on('error', (e) => { events.push('ipify-error: ' + String(e).slice(0, 80)); r(); }));
  await new Promise((r) => https.get('https://ipinfo.io/json', { timeout: 8000 }, (rs) => {
    let b = ''; rs.on('data', (c) => b += c); rs.on('end', () => { try { const j = JSON.parse(b); events.push('ipinfo: ' + (j.city || '?') + ', ' + (j.region || '?') + ', ' + (j.country || '?') + ' org=' + (j.org || '?')); } catch (_) { events.push('ipinfo: parse fail'); } r(); });
  }).on('error', (e) => { events.push('ipinfo-error: ' + String(e).slice(0, 80)); r(); }));
  res.json({ node: process.version, events });
});
api.get('/admin/stats', async (req, res) => {
  if (!isFounderOrKey(req)) return res.status(403).json({ error: 'founder only' });
  const agents = await db.listAgents();
  res.json({
    users: (await db.listUsers()).length,
    agents: agents.length,
    liveAgents: agents.filter(a => a.status === 'live').length,
    unownedAgents: agents.filter(a => !a.ownerId).length,
    subscribers: (await db.listSubscribers()).length,
    storage: db.HAS_PG ? 'postgres' : 'files',
    dbError: db.lastDbError ? db.lastDbError.slice(0, 300) : null
  });
});
api.post('/admin/dbdebug', async (req, res) => {
  const byKey = !(req.user && req.user.founder) && req.headers['x-admin-key'] === process.env.ADMIN_KEY;
  if (!byKey) return res.status(403).json({ error: 'admin key required' });
  const p = require('./db').pool();
  if (!p) return res.json({ mode: 'json-file (no postgres)' });
  const out = {};
  try {
    out.activity = (await p.query("SELECT pid, state, wait_event_type, wait_event, age(now(), xact_start) AS xage, left(query,90) AS q FROM pg_stat_activity WHERE datname IS NOT NULL ORDER BY pid")).rows;
    out.killed = (await p.query("SELECT count(*) FROM pg_terminate_backend(pid) FROM pg_stat_activity WHERE state='idle in transaction' AND pid<>pg_backend_pid()")).rows[0].count;
  } catch (e) { out.error = String(e).slice(0, 300); }
  res.json(out);
});

api.post('/admin/users/:id/founder', async (req, res) => {
  const byKey = !(req.user && req.user.founder) && req.headers['x-admin-key'] === process.env.ADMIN_KEY;
  if (!byKey) return res.status(403).json({ error: 'admin key required' });
  const u = (await db.listUsers()).find(x => x.id === req.params.id);
  if (!u) return res.status(404).json({ error: 'user not found' });
  await db.setFounder(u.id, true);
  const from = req.body && req.body.transferFrom;
  if (from) {
    for (const a of await db.listAgents()) if (a.ownerId === from) { a.ownerId = u.id; await db.updateAgent(a); }
    await db.deleteUser(from);
  }
  res.json({ ok: true, promoted: u.email, founder: true });
});

api.delete('/admin/users/:id', async (req, res) => {
  if (!isFounderOrKey(req)) return res.status(403).json({ error: 'founder only' });
  const u = (await db.listUsers()).find(x => x.id === req.params.id);
  if (!u) return res.status(404).json({ error: 'user not found' });
  const byKey = !(req.user && req.user.founder) && req.headers['x-admin-key'] === process.env.ADMIN_KEY;
  if (u.founder && !byKey) return res.status(400).json({ error: 'founder account can only be removed with the admin key' });
  await db.deleteUser(u.id);
  res.json({ ok: true, deleted: u.email });
});

api.get('/broadcast/subscribers', async (req, res) => { if (!req.user.founder) return res.status(403).json({ error: 'founder only' }); res.json(await db.listSubscribers()); });

suite.attach({
  api,
  db,
  send: async (channel, chatId, text) => {
    if (channel === 'whatsapp') return waSend(chatId, text);
    return tgSend(chatId, text);
  }
});

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

const ready = db.init().then(() => seedAgents());
module.exports = { app, ready, groqAsk, runTool, suite };

if (process.env.VERCEL) {
  // serverless: no listener, the handler in api/index.js awaits `ready`
  ready.catch(e => { console.error('Init failed:', e); });
} else {
  ready.then(() => {
    app.listen(PORT, () => console.log('AgentX dashboard running on http://localhost:' + PORT + (db.HAS_PG ? ' [postgres]' : ' [json files]')));
  }).catch(e => { console.error('Failed to start:', e); process.exit(1); });
}
