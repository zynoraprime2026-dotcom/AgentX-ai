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
app.use(express.static(path.join(__dirname, 'public')));

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
      model: 'llama-3.3-70b-versatile',
      platforms: { whatsapp: { enabled: true, autoReply: true }, telegram: { enabled: false, autoReply: false } },
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
  res.json({ ok: true, groqConfigured: Boolean(s.groqApiKey && s.groqApiKey.startsWith('gsk_')) });
});

api.get('/settings', (req, res) => res.json(readJson(SETTINGS_FILE, {})));
api.put('/settings', (req, res) => {
  const s = readJson(SETTINGS_FILE, {});
  const { groqApiKey, webhookBase } = req.body || {};
  if (typeof groqApiKey === 'string') s.groqApiKey = groqApiKey.trim();
  if (typeof webhookBase === 'string') s.webhookBase = webhookBase.trim();
  writeJson(SETTINGS_FILE, s);
  res.json({ ok: true, groqConfigured: Boolean(s.groqApiKey && s.groqApiKey.startsWith('gsk_')) });
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
    model: model || 'llama-3.3-70b-versatile',
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

// test chat console — Groq if key configured, canned demo otherwise
api.post('/chat/:id', async (req, res) => {
  const agents = readJson(AGENTS_FILE, []);
  const a = agents.find(x => x.id === req.params.id);
  if (!a) return res.status(404).json({ error: 'agent not found' });
  const history = Array.isArray(req.body.history) ? req.body.history.slice(-12) : [];
  const s = readJson(SETTINGS_FILE, {});
  if (!s.groqApiKey || !s.groqApiKey.startsWith('gsk_')) {
    const last = history.length ? history[history.length - 1].content : '';
    return res.json({
      reply: `*[demo mode — add a Groq API key in Settings to go live]*\n\n${a.name} here. You said: "${(last || '').slice(0, 120)}". Configure a Groq key and I'll answer with ${a.model}.`,
      demo: true
    });
  }
  try {
    const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + s.groqApiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: a.model,
        messages: [{ role: 'system', content: a.systemPrompt }, ...history],
        temperature: 0.7, max_tokens: 512
      })
    });
    const d = await r.json();
    if (!r.ok) return res.status(502).json({ error: (d.error && d.error.message) || 'Groq request failed' });
    a.messagesHandled = (a.messagesHandled || 0) + 1;
    writeJson(AGENTS_FILE, agents);
    res.json({ reply: d.choices[0].message.content, model: a.model });
  } catch (e) {
    res.status(502).json({ error: 'Groq unreachable: ' + e.message });
  }
});

app.use('/api', api);
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.listen(PORT, () => console.log(`AgentX dashboard running on http://localhost:${PORT}`));
