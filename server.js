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
      systemPrompt: 'You are the Madrasa Assistant for Al-Haqq Digital madrasa in Tarkwa, Ghana. Answer kindly and concisely, using simple English. You help with lesson schedules, admission steps and general school questions.',
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

api.get('/status', (req, res) => {
  const s = readJson(SETTINGS_FILE, {});
  const cfg = Boolean((s.groqApiKey && s.groqApiKey.startsWith('gsk_')) || (process.env.GROQ_API_KEY || '').startsWith('gsk_'));
  res.json({ ok: true, groqConfigured: cfg });
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

// ---------- shared Groq call ----------
async function groqAsk(agent, history) {
  const st = readJson(SETTINGS_FILE, {});
  const key = (st.groqApiKey && st.groqApiKey.startsWith('gsk_')) ? st.groqApiKey : (process.env.GROQ_API_KEY || '');
  if (!key.startsWith('gsk_')) {
    const last = history.length ? history[history.length - 1].content : '';
    return { reply: `*[demo mode — add a Groq API key in Settings to go live]*\n\n${agent.name} here. You said: "${(last || '').slice(0, 120)}".`, demo: true };
  }
  const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + key, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: agent.model,
      messages: [{ role: 'system', content: agent.systemPrompt }, ...history],
      temperature: 0.7, max_tokens: 512
    })
  });
  const d = await r.json();
  if (!r.ok) throw new Error((d.error && d.error.message) || 'Groq request failed');
  return { reply: d.choices[0].message.content, model: agent.model };
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
const tgHistories = new Map();   // chatId -> last 12 messages
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

async function tgSend(chatId, text) {
  const chunks = String(text).match(/[\s\S]{1,3800}(?!\S)/) || [String(text)];
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
        '👋 Welcome to AgentX!\n\nI am an AI assistant running on Groq.\n' +
        'Commands:\n/agents — list available assistants\n/agent <name> — talk to a specific one\n\nJust type your question.');
    }
    if (cmd === '/agents') {
      const live = agents.filter(a => a.status === 'live');
      return tgSend(chatId, live.length
        ? 'Available assistants:\n' + live.map(a => `${a.emoji} ${a.name}`).join('\n')
        : 'No live agents yet — set one live in the dashboard.');
    }
    if (cmd === '/agent' && arg) {
      const found = agents.find(a => a.name.toLowerCase() === arg.toLowerCase());
      if (found && found.status === 'live') {
        tgSelected.set(chatId, found.id); tgHistories.delete(chatId);
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

app.use('/api', api);
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.listen(PORT, () => console.log('AgentX dashboard running on http://localhost:' + PORT));
