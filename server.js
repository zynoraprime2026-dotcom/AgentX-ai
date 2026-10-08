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

// ---------- admin auth ----------
const crypto = require('crypto');
const ADMIN_KEY = process.env.ADMIN_KEY || '';
const ADMIN_COOKIE = crypto.createHash('sha256').update('agx' + ADMIN_KEY).digest('hex');
const PUBLIC_API = ['/status', '/auth/status', '/auth/login', '/auth/logout', '/telegram/status'];
api.use((req, res, next) => {
  if (!ADMIN_KEY) return next();
  if (PUBLIC_API.includes(req.path)) return next();
  if ((req.headers.cookie || '').includes('agx_auth=' + ADMIN_COOKIE)) return next();
  res.status(401).json({ error: 'login required', needsLogin: true });
});

api.get('/auth/status', (req, res) => res.json({
  needsLogin: Boolean(ADMIN_KEY),
  authed: !ADMIN_KEY || (req.headers.cookie || '').includes('agx_auth=' + ADMIN_COOKIE)
}));
api.post('/auth/login', (req, res) => {
  if (!ADMIN_KEY) return res.json({ ok: true, authed: true });
  if ((req.body && req.body.key) !== ADMIN_KEY) return res.status(401).json({ error: 'wrong key' });
  res.setHeader('Set-Cookie', 'agx_auth=' + ADMIN_COOKIE + '; Path=/; HttpOnly; Max-Age=2592000; SameSite=Lax');
  res.json({ ok: true, authed: true });
});
api.post('/auth/logout', (req, res) => {
  res.setHeader('Set-Cookie', 'agx_auth=; Path=/; HttpOnly; Max-Age=0');
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

api.get('/settings', (req, res) => res.json(readJson(SETTINGS_FILE, {})));
api.put('/settings', (req, res) => {
  const s = readJson(SETTINGS_FILE, {});
  const { groqApiKey, webhookBase } = req.body || {};
  if (typeof groqApiKey === 'string') s.groqApiKey = groqApiKey.trim();
  if (typeof webhookBase === 'string') s.webhookBase = webhookBase.trim();
  writeJson(SETTINGS_FILE, s);
  const cfg = Boolean((s.groqApiKey && s.groqApiKey.startsWith('gsk_')) || (process.env.GROQ_API_KEY || '').startsWith('gsk_'));
  res.json({ ok: true, groqConfigured: cfg });
});

api.get('/agents', (req, res) => res.json(readJson(AGENTS_FILE, [])));

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
    status: 'draft', createdAt: new Date().toISOString(), messagesHandled: 0
  };
  agents.push(agent); writeJson(AGENTS_FILE, agents);
  res.status(201).json(agent);
});

api.put('/agents/:id', (req, res) => {
  const agents = readJson(AGENTS_FILE, []);
  const a = agents.find(x => x.id === req.params.id);
  if (!a) return res.status(404).json({ error: 'agent not found' });
  const allowed = ['name','emoji','description','systemPrompt','model','status','platforms'];
  for (const k of allowed) if (req.body && k in req.body) a[k] = req.body[k];
  writeJson(AGENTS_FILE, agents);
  res.json(a);
});

api.delete('/agents/:id', (req, res) => {
  let agents = readJson(AGENTS_FILE, []);
  const before = agents.length;
  agents = agents.filter(x => x.id !== req.params.id);
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

async function waSend(to, text) {
  if (!WA_PHONE_ID || !WA_TOKEN) return; // not configured yet
  await fetch(`https://graph.facebook.com/v21.0/${WA_PHONE_ID}/messages`, {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + WA_TOKEN, 'Content-Type': 'application/json' },
    body: JSON.stringify({ messaging_product: 'whatsapp', to, type: 'text', text: { body: String(text).slice(0, 3800) } })
  });
}

app.get('/webhook/whatsapp', (req, res) => {
  const q = req.query || {};
  if (q['hub.mode'] === 'subscribe' && q['hub.verify_token'] === WA_VERIFY_TOKEN) return res.send(q['hub.challenge'] || '');
  res.status(403).send('verification failed');
});

app.post('/webhook/whatsapp', (req, res) => {
  res.json({ ok: true });
  try {
    const val = req.body && req.body.entry && req.body.entry[0] && req.body.entry[0].changes && req.body.entry[0].changes[0] && req.body.entry[0].changes[0].value;
    const msg = val && val.messages && val.messages[0];
    if (!msg || msg.type !== 'text') return;
    const from = msg.from;
    const text = (msg.text && msg.text.body || '').trim();
    if (!text) return;
    const agents = readJson(AGENTS_FILE, []);
    const agent = agents.find(a => a.platforms && a.platforms.whatsapp && a.platforms.whatsapp.enabled && a.platforms.whatsapp.autoReply && a.status === 'live')
        || agents.find(a => a.platforms && a.platforms.whatsapp && a.platforms.whatsapp.enabled && a.status === 'live');
    if (!agent) return;
    const history = [...(waHistories.get(from) || []), { role: 'user', content: text }].slice(-12);
    groqAsk(agent, history).then(out => {
      if (out.demo) return;
      bumpMessages(agent.id);
      waHistories.set(from, [...history, { role: 'assistant', content: out.reply }].slice(-12));
      return waSend(from, out.reply);
    }).catch(() => waSend(from, 'Sorry, I could not answer right now.'));
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
