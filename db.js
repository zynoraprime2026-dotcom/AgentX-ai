// db.js — AgentX storage layer.
// Uses Postgres when DATABASE_URL is set; otherwise falls back to JSON files in data/.
const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, 'data');
const HAS_PG = Boolean(process.env.DATABASE_URL);
let pool = null;

function localSsl(url) {
  return /localhost|127\.0\.0\.1/.test(url) ? false : { rejectUnauthorized: false };
}

async function init() {
  if (!HAS_PG) return;
  // try SSL first (Render/Neon), then plain (internal host without TLS), else degrade to JSON files
  const attempts = [localSsl(process.env.DATABASE_URL), false];
  for (const ssl of attempts) {
    try { await initPg(ssl); return; }
    catch (e) { console.error('[db] connection attempt failed (ssl=' + Boolean(ssl) + '):', String(e).slice(0, 140)); }
  }
  console.error('[db] Postgres unreachable, degrading to JSON file mode');
  pool = null;
}

async function initPg(ssl) {
  const { Pool } = require('pg');
  pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl, max: 5 });
  await pool.query(`
    CREATE TABLE IF NOT EXISTS agx_agents (
      id text PRIMARY KEY, name text NOT NULL, emoji text DEFAULT '🤖',
      description text DEFAULT '', system_prompt text DEFAULT '', model text DEFAULT 'openai/gpt-oss-120b',
      platforms jsonb DEFAULT '{}', status text DEFAULT 'draft', created_at text,
      messages_handled int DEFAULT 0, owner_id text, wa_phone_id text
    );
    CREATE TABLE IF NOT EXISTS agx_agent_secrets (agent_id text PRIMARY KEY, wa_token text NOT NULL);
    CREATE TABLE IF NOT EXISTS agx_users (
      id text PRIMARY KEY, email text UNIQUE NOT NULL, name text, founder boolean DEFAULT false,
      pass text NOT NULL, created_at text
    );
    CREATE TABLE IF NOT EXISTS agx_sessions (token text PRIMARY KEY, user_data jsonb NOT NULL, expires text NOT NULL);
    CREATE TABLE IF NOT EXISTS agx_settings (id int PRIMARY KEY DEFAULT 1, groq_api_key text DEFAULT '', webhook_base text DEFAULT '');
    INSERT INTO agx_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING;
    CREATE TABLE IF NOT EXISTS agx_subscribers (chat_id text PRIMARY KEY, city text, platform text, since text);
    CREATE TABLE IF NOT EXISTS agx_subs_sent (chat_id text PRIMARY KEY, day text);
    CREATE TABLE IF NOT EXISTS agx_hist (id bigserial PRIMARY KEY, channel text, chat_id text, role text, content text);
    CREATE INDEX IF NOT EXISTS agx_hist_chat ON agx_hist (channel, chat_id, id);
  `);
}

// ---------- JSON fallback helpers ----------
function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}
function writeJson(file, obj) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(file, JSON.stringify(obj, null, 2));
}

function rowToAgent(r) {
  return {
    id: r.id, name: r.name, emoji: r.emoji, description: r.description,
    systemPrompt: r.system_prompt, model: r.model, platforms: r.platforms || {},
    status: r.status, createdAt: r.created_at, messagesHandled: r.messages_handled,
    ownerId: r.owner_id, waPhoneId: r.wa_phone_id || undefined
  };
}

const store = {
  init, readJson, writeJson, DATA_DIR,

  // ---------- agents ----------
  async listAgents() {
    if (pool) return (await pool.query('SELECT * FROM agx_agents ORDER BY created_at')).rows.map(rowToAgent);
    return readJson(path.join(DATA_DIR, 'agents.json'), []);
  },
  async insertAgent(a) {
    if (pool) {
      await pool.query(
        'INSERT INTO agx_agents (id,name,emoji,description,system_prompt,model,platforms,status,created_at,messages_handled,owner_id,wa_phone_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)',
        [a.id, a.name, a.emoji || '🤖', a.description || '', a.systemPrompt || '', a.model || 'openai/gpt-oss-120b',
         JSON.stringify(a.platforms || {}), a.status || 'draft', a.createdAt || new Date().toISOString(),
         a.messagesHandled || 0, a.ownerId || null, a.waPhoneId || null]);
      return;
    }
    const all = readJson(path.join(DATA_DIR, 'agents.json'), []);
    all.push(a); writeJson(path.join(DATA_DIR, 'agents.json'), all);
  },
  async updateAgent(a) {
    if (pool) {
      await pool.query(
        'UPDATE agx_agents SET name=$2,emoji=$3,description=$4,system_prompt=$5,model=$6,platforms=$7,status=$8,messages_handled=$9,owner_id=$10,wa_phone_id=$11 WHERE id=$1',
        [a.id, a.name, a.emoji || '🤖', a.description || '', a.systemPrompt || '', a.model || 'openai/gpt-oss-120b',
         JSON.stringify(a.platforms || {}), a.status || 'draft', a.messagesHandled || 0, a.ownerId || null, a.waPhoneId || null]);
      return;
    }
    const all = readJson(path.join(DATA_DIR, 'agents.json'), []);
    const i = all.findIndex(x => x.id === a.id);
    if (i >= 0) { all[i] = a; writeJson(path.join(DATA_DIR, 'agents.json'), all); }
  },
  async deleteAgent(id) {
    if (pool) {
      await pool.query('DELETE FROM agx_agents WHERE id=$1', [id]);
      await pool.query('DELETE FROM agx_agent_secrets WHERE agent_id=$1', [id]);
      return;
    }
    writeJson(path.join(DATA_DIR, 'agents.json'), readJson(path.join(DATA_DIR, 'agents.json'), []).filter(x => x.id !== id));
  },
  async incMessages(id) {
    if (pool) { await pool.query('UPDATE agx_agents SET messages_handled = messages_handled + 1 WHERE id=$1', [id]); return; }
    const all = readJson(path.join(DATA_DIR, 'agents.json'), []);
    const a = all.find(x => x.id === id);
    if (a) { a.messagesHandled = (a.messagesHandled || 0) + 1; writeJson(path.join(DATA_DIR, 'agents.json'), all); }
  },

  // ---------- per-agent WhatsApp tokens ----------
  async getAgentToken(id) {
    if (pool) return ((await pool.query('SELECT wa_token FROM agx_agent_secrets WHERE agent_id=$1', [id])).rows[0] || {}).wa_token || '';
    return ((readJson(path.join(DATA_DIR, 'agent_secrets.json'), {})[id]) || {}).waToken || '';
  },
  async setAgentToken(id, tok) {
    if (pool) {
      if (tok) await pool.query('INSERT INTO agx_agent_secrets (agent_id, wa_token) VALUES ($1,$2) ON CONFLICT (agent_id) DO UPDATE SET wa_token=$2', [id, tok]);
      else await pool.query('DELETE FROM agx_agent_secrets WHERE agent_id=$1', [id]);
      return;
    }
    const m = readJson(path.join(DATA_DIR, 'agent_secrets.json'), {});
    if (tok) m[id] = { waToken: tok }; else delete m[id];
    writeJson(path.join(DATA_DIR, 'agent_secrets.json'), m);
  },

  // ---------- users ----------
  async findUserByEmail(email) {
    if (pool) return (await pool.query('SELECT * FROM agx_users WHERE email=$1', [email])).rows[0] || null;
    return Object.values(readJson(path.join(DATA_DIR, 'users.json'), {})).find(u => u.email === email) || null;
  },
  async insertUser(u) {
    if (pool) {
      await pool.query('INSERT INTO agx_users (id,email,name,founder,pass,created_at) VALUES ($1,$2,$3,$4,$5,$6)',
        [u.id, u.email, u.name, Boolean(u.founder), u.pass, u.createdAt]);
      return;
    }
    const users = readJson(path.join(DATA_DIR, 'users.json'), {});
    users[u.id] = u; writeJson(path.join(DATA_DIR, 'users.json'), users);
  },

  async listUsers() {
    if (pool) {
      const r = await pool.query('SELECT u.id, u.email, u.name, u.founder, u.created_at, (SELECT count(*) FROM agx_agents a WHERE a.owner_id=u.id) AS agents FROM agx_users u ORDER BY u.created_at');
      return r.rows.map(x => ({ id: x.id, email: x.email, name: x.name, founder: x.founder, createdAt: x.created_at, agents: Number(x.agents) }));
    }
    return Object.values(readJson(path.join(DATA_DIR, 'users.json'), {})).map(u => {
      const agents = Object.values(readJson(path.join(DATA_DIR, 'agents.json'), {})).filter(a => a.ownerId === u.id).length;
      return { id: u.id, email: u.email, name: u.name, founder: Boolean(u.founder), createdAt: u.createdAt, agents };
    });
  },
  async deleteUser(id) {
    if (pool) {
      await pool.query('DELETE FROM agx_sessions WHERE user_data->>\'id\'=$1', [id]);
      await pool.query('DELETE FROM agx_agent_secrets WHERE agent_id IN (SELECT id FROM agx_agents WHERE owner_id=$1)', [id]);
      await pool.query('DELETE FROM agx_agents WHERE owner_id=$1', [id]);
      await pool.query('DELETE FROM agx_users WHERE id=$1', [id]);
      return true;
    }
    const users = readJson(path.join(DATA_DIR, 'users.json'), {}); delete users[id];
    writeJson(path.join(DATA_DIR, 'users.json'), users);
    const sess = readJson(path.join(DATA_DIR, 'sessions.json'), {});
    for (const [t, v] of Object.entries(sess)) if (v.user && v.user.id === id) delete sess[t];
    writeJson(path.join(DATA_DIR, 'sessions.json'), sess);
    const agents = readJson(path.join(DATA_DIR, 'agents.json'), {});
    for (const a of Object.values(agents)) if (a.ownerId === id) delete agents[a.id];
    writeJson(path.join(DATA_DIR, 'agents.json'), agents);
    return true;
  },

  // ---------- sessions ----------
  async getSession(token) {
    if (!token) return null;
    if (pool) {
      const s = (await pool.query('SELECT * FROM agx_sessions WHERE token=$1', [token])).rows[0];
      if (!s) return null;
      return { user: s.user_data, expires: s.expires };
    }
    return readJson(path.join(DATA_DIR, 'sessions.json'), {})[token] || null;
  },
  async putSession(token, sess) {
    if (pool) { await pool.query('INSERT INTO agx_sessions (token, user_data, expires) VALUES ($1,$2,$3) ON CONFLICT (token) DO UPDATE SET user_data=$2, expires=$3', [token, JSON.stringify(sess.user), sess.expires]); return; }
    const s = readJson(path.join(DATA_DIR, 'sessions.json'), {});
    s[token] = sess; writeJson(path.join(DATA_DIR, 'sessions.json'), s);
  },
  async delSession(token) {
    if (pool) { await pool.query('DELETE FROM agx_sessions WHERE token=$1', [token]); return; }
    const s = readJson(path.join(DATA_DIR, 'sessions.json'), {});
    delete s[token]; writeJson(path.join(DATA_DIR, 'sessions.json'), s);
  },

  // ---------- settings ----------
  async getSettings() {
    if (pool) {
      const r = (await pool.query('SELECT * FROM agx_settings WHERE id=1')).rows[0];
      return { groqApiKey: r.groq_api_key || '', webhookBase: r.webhook_base || '' };
    }
    return readJson(path.join(DATA_DIR, 'settings.json'), { groqApiKey: '', webhookBase: '' });
  },
  async putSettings(s) {
    if (pool) { await pool.query('UPDATE agx_settings SET groq_api_key=$1, webhook_base=$2 WHERE id=1', [s.groqApiKey || '', s.webhookBase || '']); return; }
    writeJson(path.join(DATA_DIR, 'settings.json'), s);
  },

  // ---------- Fajr subscribers ----------
  async listSubscribers() {
    if (pool) {
      const rows = (await pool.query('SELECT * FROM agx_subscribers')).rows;
      const o = {}; for (const r of rows) o[r.chat_id] = { city: r.city, platform: r.platform, since: r.since };
      return o;
    }
    return readJson(path.join(DATA_DIR, 'subscribers.json'), {});
  },
  async addSubscriber(chatId, city) {
    if (pool) { await pool.query('INSERT INTO agx_subscribers (chat_id, city, platform, since) VALUES ($1,$2,$3,$4) ON CONFLICT (chat_id) DO UPDATE SET city=$2', [chatId, city, 'telegram', new Date().toISOString()]); return; }
    const s = readJson(path.join(DATA_DIR, 'subscribers.json'), {});
    s[chatId] = { city, platform: 'telegram', since: new Date().toISOString() };
    writeJson(path.join(DATA_DIR, 'subscribers.json'), s);
  },
  async removeSubscriber(chatId) {
    if (pool) { await pool.query('DELETE FROM agx_subscribers WHERE chat_id=$1', [chatId]); await pool.query('DELETE FROM agx_subs_sent WHERE chat_id=$1', [chatId]); return; }
    const s = readJson(path.join(DATA_DIR, 'subscribers.json'), {});
    delete s[chatId]; writeJson(path.join(DATA_DIR, 'subscribers.json'), s);
  },
  async getSentDay(chatId) {
    if (pool) return ((await pool.query('SELECT day FROM agx_subs_sent WHERE chat_id=$1', [chatId])).rows[0] || {}).day || null;
    return readJson(path.join(DATA_DIR, 'subs_sent.json'), {})[chatId] || null;
  },
  async putSentDay(chatId, day) {
    if (pool) { await pool.query('INSERT INTO agx_subs_sent (chat_id, day) VALUES ($1,$2) ON CONFLICT (chat_id) DO UPDATE SET day=$2', [chatId, day]); return; }
    const s = readJson(path.join(DATA_DIR, 'subs_sent.json'), {});
    s[chatId] = day; writeJson(path.join(DATA_DIR, 'subs_sent.json'), s);
  },

  // ---------- chat histories (WhatsApp + Telegram) ----------
  async getHistory(channel, chatId) {
    if (pool) {
      const r = await pool.query('SELECT role, content FROM agx_hist WHERE channel=$1 AND chat_id=$2 ORDER BY id DESC LIMIT 12', [channel, String(chatId)]);
      return r.rows.reverse().map(x => ({ role: x.role, content: x.content }));
    }
    const all = readJson(path.join(DATA_DIR, 'histories.json'), {});
    return (all[channel] && all[channel][chatId]) || [];
  },
  async appendHistory(channel, chatId, role, content) {
    if (pool) { await pool.query('INSERT INTO agx_hist (channel, chat_id, role, content) VALUES ($1,$2,$3,$4)', [channel, String(chatId), role, String(content).slice(0, 6000)]); return; }
    const all = readJson(path.join(DATA_DIR, 'histories.json'), {});
    all[channel] = all[channel] || {};
    const arr = all[channel][chatId] = (all[channel][chatId] || []);
    arr.push({ role, content });
    all[channel][chatId] = arr.slice(-24);
    writeJson(path.join(DATA_DIR, 'histories.json'), all);
  },
  async clearHistory(channel, chatId) {
    if (pool) { await pool.query('DELETE FROM agx_hist WHERE channel=$1 AND chat_id=$2', [channel, String(chatId)]); return; }
    const all = readJson(path.join(DATA_DIR, 'histories.json'), {});
    if (all[channel]) { delete all[channel][chatId]; writeJson(path.join(DATA_DIR, 'histories.json'), all); }
  }
};
module.exports = store;
Object.defineProperty(store, 'HAS_PG', { get: () => Boolean(pool) });
