// db.js — AgentX storage layer.
// Uses Postgres when DATABASE_URL is set; otherwise falls back to JSON files in data/.
const fs = require('fs');
const path = require('path');

// On serverless (Vercel) the bundle filesystem is READ-ONLY: use /tmp for JSON mode,
// copying any bundled data/ files over so seed agents survive cold starts.
const DATA_DIR = process.env.VERCEL ? path.join('/tmp', 'agx-data') : path.join(__dirname, 'data');
const BUNDLED_DATA = path.join(__dirname, 'data');
const HAS_PG = Boolean(process.env.DATABASE_URL);
let pool = null;

function localSsl(url) {
  return /localhost|127\.0\.0\.1/.test(url) ? false : { rejectUnauthorized: false };
}

let lastDbError = null;

async function init() {
  if (process.env.VERCEL && !HAS_PG) {
    try {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      for (const f of fs.readdirSync(BUNDLED_DATA)) fs.copyFileSync(path.join(BUNDLED_DATA, f), path.join(DATA_DIR, f));
    } catch (e) { console.error('[db] bundled data copy failed:', String(e).slice(0, 140)); }
  }
  if (!HAS_PG) return;
  // try SSL first (Render/Neon), then plain (internal host without TLS), else degrade to JSON files
  const attempts = [localSsl(process.env.DATABASE_URL), false];
  for (const ssl of attempts) {
    try { await initPg(ssl); return; }
    catch (e) { lastDbError = String(e); console.error('[db] connection attempt failed (ssl=' + Boolean(ssl) + '):', lastDbError.slice(0, 140)); }
  }
  console.error('[db] Postgres unreachable, degrading to JSON file mode');
  pool = null;
}

async function initPg(ssl) {
  const { Pool } = require('pg');
  pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl, max: 3, connectionTimeoutMillis: 8000, idleTimeoutMillis: 30000 });
  pool.on('connect', (c) => { c.query('SET statement_timeout=15000').catch(() => {}); });
  module.exports.poolRef = pool;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS agx_agents (
      id text PRIMARY KEY, name text NOT NULL, emoji text DEFAULT '🤖',
      description text DEFAULT '', system_prompt text DEFAULT '', model text DEFAULT 'openai/gpt-oss-120b',
      platforms jsonb DEFAULT '{}', status text DEFAULT 'draft', created_at text,
      messages_handled int DEFAULT 0, owner_id text, wa_phone_id text
    );
    CREATE TABLE IF NOT EXISTS agx_agent_secrets (agent_id text PRIMARY KEY, wa_token text NOT NULL);
    ALTER TABLE agx_agents ADD COLUMN IF NOT EXISTS persona jsonb DEFAULT '{}';
    ALTER TABLE agx_agents ADD COLUMN IF NOT EXISTS languages jsonb DEFAULT '[]';
    ALTER TABLE agx_agents ADD COLUMN IF NOT EXISTS auto_language boolean DEFAULT true;
    ALTER TABLE agx_agents ADD COLUMN IF NOT EXISTS group_reply text DEFAULT 'mention';
    ALTER TABLE agx_agents ADD COLUMN IF NOT EXISTS sort_order int DEFAULT 0;
    ALTER TABLE agx_agents ADD COLUMN IF NOT EXISTS knowledge_enabled boolean DEFAULT true;
    ALTER TABLE agx_agents ADD COLUMN IF NOT EXISTS toolsets jsonb DEFAULT '[]';
    ALTER TABLE agx_agents ADD COLUMN IF NOT EXISTS source text DEFAULT 'user';
    ALTER TABLE agx_agents ADD COLUMN IF NOT EXISTS is_main boolean DEFAULT false;
    CREATE TABLE IF NOT EXISTS agx_users (
      id text PRIMARY KEY, email text UNIQUE NOT NULL, name text, founder boolean DEFAULT false,
      pass text NOT NULL, created_at text
    );
    CREATE TABLE IF NOT EXISTS agx_sessions (token text PRIMARY KEY, user_data jsonb NOT NULL, expires text NOT NULL);
    CREATE TABLE IF NOT EXISTS agx_settings (id int PRIMARY KEY DEFAULT 1, groq_api_key text DEFAULT '', webhook_base text DEFAULT '');
    ALTER TABLE agx_settings ADD COLUMN IF NOT EXISTS ilm_api_key text DEFAULT '';
    INSERT INTO agx_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING;
    CREATE TABLE IF NOT EXISTS agx_subscribers (chat_id text PRIMARY KEY, city text, platform text, since text);
    CREATE TABLE IF NOT EXISTS agx_subs_sent (chat_id text PRIMARY KEY, day text);
    CREATE TABLE IF NOT EXISTS agx_hist (id bigserial PRIMARY KEY, channel text, chat_id text, role text, content text);
    CREATE INDEX IF NOT EXISTS agx_hist_chat ON agx_hist (channel, chat_id, id);
    CREATE TABLE IF NOT EXISTS agx_workflows (
      id text PRIMARY KEY, name text NOT NULL, enabled boolean DEFAULT true,
      trigger jsonb DEFAULT '{}', steps jsonb DEFAULT '[]', approval boolean DEFAULT false,
      created_at text, updated_at text, created_by text
    );
    CREATE TABLE IF NOT EXISTS agx_runs (
      id bigserial PRIMARY KEY, workflow_id text, status text, trigger text,
      steps jsonb DEFAULT '[]', output text, error text,
      started_at text, finished_at text, approved_at text
    );
    CREATE INDEX IF NOT EXISTS agx_runs_wf ON agx_runs (workflow_id, id);
    CREATE TABLE IF NOT EXISTS agx_profiles (
      channel text NOT NULL, chat_id text NOT NULL, profile jsonb DEFAULT '{}', updated_at text,
      PRIMARY KEY (channel, chat_id)
    );
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
    ownerId: r.owner_id, waPhoneId: r.wa_phone_id || undefined,
    persona: r.persona || {}, languages: r.languages || [],
    autoLanguage: r.auto_language !== false, groupReply: r.group_reply || 'mention',
    sortOrder: r.sort_order || 0, knowledgeEnabled: r.knowledge_enabled !== false,
    toolsets: Array.isArray(r.toolsets) ? r.toolsets : [],
    source: r.source || 'user',
    isMain: r.is_main === true
  };
}

function rowToWorkflow(r) {
  return {
    id: r.id, name: r.name, enabled: r.enabled !== false,
    trigger: r.trigger || {}, steps: r.steps || [], approval: r.approval === true,
    createdAt: r.created_at, updatedAt: r.updated_at, createdBy: r.created_by || ''
  };
}

function rowToRun(r) {
  return {
    id: String(r.id), workflowId: r.workflow_id, status: r.status, trigger: r.trigger,
    steps: r.steps || [], output: r.output || '', error: r.error || '',
    startedAt: r.started_at, finishedAt: r.finished_at, approvedAt: r.approved_at
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
        `INSERT INTO agx_agents (id,name,emoji,description,system_prompt,model,platforms,status,created_at,messages_handled,owner_id,wa_phone_id,
           persona,languages,auto_language,group_reply,sort_order,knowledge_enabled,toolsets,source,is_main)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)`,
        [a.id, a.name, a.emoji || '🤖', a.description || '', a.systemPrompt || '', a.model || 'openai/gpt-oss-120b',
         JSON.stringify(a.platforms || {}), a.status || 'draft', a.createdAt || new Date().toISOString(),
         a.messagesHandled || 0, a.ownerId || null, a.waPhoneId || null,
         JSON.stringify(a.persona || {}), JSON.stringify(a.languages || []), a.autoLanguage !== false,
         a.groupReply || 'mention', a.sortOrder || 0, a.knowledgeEnabled !== false, JSON.stringify(a.toolsets || []),
         a.source || 'user', a.isMain === true]);
      return;
    }
    const all = readJson(path.join(DATA_DIR, 'agents.json'), []);
    all.push(a); writeJson(path.join(DATA_DIR, 'agents.json'), all);
  },
  async updateAgent(a) {
    if (pool) {
      await pool.query(
        `UPDATE agx_agents SET name=$2,emoji=$3,description=$4,system_prompt=$5,model=$6,platforms=$7,status=$8,messages_handled=$9,
           owner_id=$10,wa_phone_id=$11,persona=$12,languages=$13,auto_language=$14,group_reply=$15,sort_order=$16,knowledge_enabled=$17,
           toolsets=$18,source=$19,is_main=$20
         WHERE id=$1`,
        [a.id, a.name, a.emoji || '🤖', a.description || '', a.systemPrompt || '', a.model || 'openai/gpt-oss-120b',
         JSON.stringify(a.platforms || {}), a.status || 'draft', a.messagesHandled || 0, a.ownerId || null, a.waPhoneId || null,
         JSON.stringify(a.persona || {}), JSON.stringify(a.languages || []), a.autoLanguage !== false,
         a.groupReply || 'mention', a.sortOrder || 0, a.knowledgeEnabled !== false, JSON.stringify(a.toolsets || []),
         a.source || 'user', a.isMain === true]);
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

  async setFounder(id, flag) {
    if (pool) { await pool.query('UPDATE agx_users SET founder=$2 WHERE id=$1', [id, Boolean(flag)]); return; }
    const users = readJson(path.join(DATA_DIR, 'users.json'), {});
    if (users[id]) { users[id].founder = Boolean(flag); writeJson(path.join(DATA_DIR, 'users.json'), users); }
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
  async updateUserPass(id, pass) {
    if (pool) { await pool.query('UPDATE agx_users SET pass=$2 WHERE id=$1', [id, pass]); return true; }
    const all = readJson(path.join(DATA_DIR, 'users.json'), {});
    if (all[id]) { all[id].pass = pass; writeJson(path.join(DATA_DIR, 'users.json'), all); return true; }
    return false;
  },
  async deleteUser(id) {
    if (pool) {
      await pool.query('DELETE FROM agx_sessions WHERE user_data->>\'id\'=$1', [id]);
      await pool.query('DELETE FROM agx_agent_secrets WHERE agent_id IN (SELECT id FROM agx_agents WHERE owner_id=$1)', [id]);
      await pool.query('UPDATE agx_agents SET owner_id=NULL, wa_phone_id=NULL WHERE owner_id=$1', [id]);
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

  // A password change must end every other signed-in session for that account.
  async clearUserSessions(userId, keepToken) {
    if (pool) {
      if (keepToken) { await pool.query("DELETE FROM agx_sessions WHERE user_data->>'id'=$1 AND token<>$2", [userId, keepToken]); return; }
      await pool.query("DELETE FROM agx_sessions WHERE user_data->>'id'=$1", [userId]);
      return;
    }
    const all = readJson(path.join(DATA_DIR, 'sessions.json'), {});
    for (const t of Object.keys(all)) {
      const u = all[t] && all[t].user;
      if (u && u.id === userId && t !== keepToken) delete all[t];
    }
    writeJson(path.join(DATA_DIR, 'sessions.json'), all);
  },

  // ---------- settings ----------
  async getSettings() {
    if (pool) {
      const r = (await pool.query('SELECT * FROM agx_settings WHERE id=1')).rows[0];
      return { groqApiKey: r.groq_api_key || '', webhookBase: r.webhook_base || '', ilmApiKey: r.ilm_api_key || '' };
    }
    return readJson(path.join(DATA_DIR, 'settings.json'), { groqApiKey: '', webhookBase: '', ilmApiKey: '' });
  },
  async putSettings(s) {
    if (pool) { await pool.query('UPDATE agx_settings SET groq_api_key=$1, webhook_base=$2, ilm_api_key=$3 WHERE id=1', [s.groqApiKey || '', s.webhookBase || '', s.ilmApiKey || '']); return; }
    writeJson(path.join(DATA_DIR, 'settings.json'), s);
  },

  // ---------- Social tokens ----------
  // A key/value table of its own: agx_settings has fixed columns, so anything new
  // would otherwise be silently dropped on write.
  async getSocial(key) {
    if (!pool) return readJson(path.join(DATA_DIR, 'social.json'), {})[key] || '';
    await pool.query('CREATE TABLE IF NOT EXISTS agx_social (key text primary key, value text, updated timestamptz default now())');
    const r = await pool.query('SELECT value FROM agx_social WHERE key=$1', [key]);
    return (r.rows[0] && r.rows[0].value) || '';
  },
  async putSocial(key, value) {
    if (!pool) {
      const f = path.join(DATA_DIR, 'social.json');
      const s = readJson(f, {});
      s[key] = value;
      writeJson(f, s);
      return;
    }
    await pool.query('CREATE TABLE IF NOT EXISTS agx_social (key text primary key, value text, updated timestamptz default now())');
    await pool.query('INSERT INTO agx_social (key,value) VALUES ($1,$2) ON CONFLICT (key) DO UPDATE SET value=$2, updated=now()', [key, value]);
  },

  // ---------- Workflows and their run log ----------
  // A workflow is data, not code: trigger + steps + whether a human has to approve it.
  // The run log is the point of the exercise. Automation nobody can inspect is automation
  // nobody trusts, so every run keeps its steps, their outputs and its failure reason.
  async listWorkflows() {
    if (!pool) return readJson(path.join(DATA_DIR, 'workflows.json'), []);
    const r = await pool.query('SELECT * FROM agx_workflows ORDER BY name');
    return r.rows.map(rowToWorkflow);
  },
  async getWorkflow(id) {
    if (!pool) return readJson(path.join(DATA_DIR, 'workflows.json'), []).find((w) => w.id === id) || null;
    const r = await pool.query('SELECT * FROM agx_workflows WHERE id=$1', [id]);
    return r.rows[0] ? rowToWorkflow(r.rows[0]) : null;
  },
  async putWorkflow(w) {
    const now = new Date().toISOString();
    if (!pool) {
      const f = path.join(DATA_DIR, 'workflows.json');
      const all = readJson(f, []);
      const i = all.findIndex((x) => x.id === w.id);
      const rec = { ...w, createdAt: i >= 0 ? all[i].createdAt : now, updatedAt: now };
      if (i >= 0) all[i] = rec; else all.push(rec);
      writeJson(f, all);
      return rec;
    }
    await pool.query(
      `INSERT INTO agx_workflows (id,name,enabled,trigger,steps,approval,created_at,updated_at,created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$7,$8)
       ON CONFLICT (id) DO UPDATE SET name=$2, enabled=$3, trigger=$4, steps=$5, approval=$6, updated_at=$7`,
      [w.id, w.name, w.enabled !== false, JSON.stringify(w.trigger || {}), JSON.stringify(w.steps || []), !!w.approval, now, w.createdBy || '']
    );
    return this.getWorkflow(w.id);
  },
  async deleteWorkflow(id) {
    if (!pool) {
      const f = path.join(DATA_DIR, 'workflows.json');
      writeJson(f, readJson(f, []).filter((w) => w.id !== id));
      return true;
    }
    await pool.query('DELETE FROM agx_workflows WHERE id=$1', [id]);
    return true;
  },
  async insertRun(r) {
    const started = r.startedAt || new Date().toISOString();
    if (!pool) {
      const f = path.join(DATA_DIR, 'runs.json');
      const all = readJson(f, []);
      const id = String((Number(all[0] && all[0].id) || 0) + 1);
      all.unshift({ id, ...r, started_at: started });
      writeJson(f, all.slice(0, 500));
      return id;
    }
    const out = await pool.query(
      `INSERT INTO agx_runs (workflow_id,status,trigger,steps,output,error,started_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
      [r.workflowId, r.status || 'running', r.trigger || 'manual', JSON.stringify(r.steps || []), r.output || '', r.error || '', started]
    );
    return String(out.rows[0].id);
  },
  async updateRun(id, patch) {
    if (!pool) {
      const f = path.join(DATA_DIR, 'runs.json');
      const all = readJson(f, []);
      const i = all.findIndex((x) => String(x.id) === String(id));
      if (i >= 0) { all[i] = { ...all[i], ...patch }; if (patch.steps) all[i].steps = patch.steps; }
      writeJson(f, all);
      return all[i] || null;
    }
    const cur = await pool.query('SELECT * FROM agx_runs WHERE id=$1', [id]);
    if (!cur.rows[0]) return null;
    const row = cur.rows[0];
    await pool.query(
      `UPDATE agx_runs SET status=$2, steps=$3, output=$4, error=$5, finished_at=$6, approved_at=$7 WHERE id=$1`,
      [id,
       patch.status || row.status,
       JSON.stringify(patch.steps || row.steps || []),
       patch.output === undefined ? row.output : patch.output,
       patch.error === undefined ? row.error : patch.error,
       patch.finishedAt === undefined ? row.finished_at : patch.finishedAt,
       patch.approvedAt === undefined ? row.approved_at : patch.approvedAt]
    );
    return this.getRun(id);
  },
  async getRun(id) {
    if (!pool) {
      const all = readJson(path.join(DATA_DIR, 'runs.json'), []);
      return all.find((x) => String(x.id) === String(id)) || null;
    }
    const r = await pool.query('SELECT * FROM agx_runs WHERE id=$1', [id]);
    return r.rows[0] ? rowToRun(r.rows[0]) : null;
  },
  async listRuns(limit) {
    const n = Math.max(1, Math.min(200, parseInt(limit, 10) || 20));
    if (!pool) return readJson(path.join(DATA_DIR, 'runs.json'), []).slice(0, n);
    const r = await pool.query('SELECT * FROM agx_runs ORDER BY id DESC LIMIT $1', [n]);
    return r.rows.map(rowToRun);
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
  // ---------- customer profiles (recognition across sessions) ----------
  async getProfile(channel, chatId) {
    if (pool) {
      const r = await pool.query('SELECT profile FROM agx_profiles WHERE channel=$1 AND chat_id=$2', [channel, String(chatId)]);
      return r.rows.length ? (r.rows[0].profile || {}) : {};
    }
    const all = readJson(path.join(DATA_DIR, 'profiles.json'), {});
    return (all[channel] && all[channel][chatId]) || {};
  },
  async saveProfile(channel, chatId, patch) {
    const cur = await store.getProfile(channel, chatId);
    const next = Object.assign({}, cur, patch);
    const now = new Date().toISOString();
    if (pool) {
      await pool.query(
        'INSERT INTO agx_profiles (channel, chat_id, profile, updated_at) VALUES ($1,$2,$3,$4) ON CONFLICT (channel, chat_id) DO UPDATE SET profile=$3, updated_at=$4',
        [channel, String(chatId), JSON.stringify(next), now]);
    } else {
      const all = readJson(path.join(DATA_DIR, 'profiles.json'), {});
      all[channel] = all[channel] || {};
      all[channel][chatId] = next;
      writeJson(path.join(DATA_DIR, 'profiles.json'), all);
    }
    return next;
  },
  // ---------- conversation browsing (dashboard) ----------
  // agx_hist has no timestamp column, so recency comes from the autoincrement id:
  // the newest row for a chat is its last activity and the best ordering available.
  async listThreads(limit) {
    const n = Math.min(300, Math.max(1, Number(limit) || 120));
    // Older rows stored the bare number, newer ones store "<phone_number_id>:<number>",
    // so the same person appeared as two threads. Group on the normalised number.
    if (pool) {
      const r = await pool.query(`
        WITH norm AS (
          SELECT channel, regexp_replace(chat_id, '^[0-9]+:', '') AS chat_key, id, role, content
          FROM agx_hist
        ), t AS (
          SELECT channel, chat_key, count(*)::int AS messages, max(id) AS last_id
          FROM norm GROUP BY channel, chat_key
        )
        SELECT t.channel, t.chat_key AS chat_id, t.messages, n.role AS last_role, n.content AS last_text
        FROM t JOIN norm n ON n.id = t.last_id
        ORDER BY t.last_id DESC LIMIT $1`, [n]);
      return r.rows;
    }
    const all = readJson(path.join(DATA_DIR, 'histories.json'), {});
    const merged = {};
    for (const channel of Object.keys(all)) {
      for (const chatId of Object.keys(all[channel] || {})) {
        const key = channel + '|' + String(chatId).replace(/^[0-9]+:/, '');
        merged[key] = merged[key] || { channel, chat_id: String(chatId).replace(/^[0-9]+:/, ''), messages: 0, last_text: '' };
        const msgs = all[channel][chatId] || [];
        merged[key].messages += msgs.length;
        if (msgs.length) merged[key].last_text = msgs[msgs.length - 1].content || '';
      }
    }
    return Object.values(merged).slice(0, n);
  },
  async listMessages(channel, chatId, limit) {
    const n = Math.min(500, Math.max(1, Number(limit) || 120));
    if (pool) {
      const r = await pool.query(
        "SELECT id, role, content FROM agx_hist WHERE channel=$1 AND regexp_replace(chat_id, '^[0-9]+:', '') = $2 ORDER BY id DESC LIMIT $3",
        [channel, String(chatId).replace(/^[0-9]+:/, ''), n]);
      return r.rows.reverse();
    }
    const all = readJson(path.join(DATA_DIR, 'histories.json'), {});
    const bucket = all[channel] || {};
    const key = Object.keys(bucket).find((k) => String(k).replace(/^[0-9]+:/, '') === String(chatId).replace(/^[0-9]+:/, ''));
    return (key ? bucket[key] : []).slice(-n);
  },
  async toolUsage(days) {
    const span = Math.min(90, Math.max(1, Number(days) || 30));
    const from = new Date(Date.now() - (span - 1) * 864e5).toISOString().slice(0, 10);
    if (pool) {
      const r = await pool.query(
        'SELECT tool, sum(uses)::int AS uses, count(DISTINCT day)::int AS days FROM agx_tool_uses WHERE day >= $1 GROUP BY tool ORDER BY uses DESC', [from]);
      return { window: { days: span, from }, tools: r.rows };
    }
    return { window: { days: span, from }, tools: [] };
  },
  async clearHistory(channel, chatId) {
    if (pool) { await pool.query('DELETE FROM agx_hist WHERE channel=$1 AND chat_id=$2', [channel, String(chatId)]); return; }
    const all = readJson(path.join(DATA_DIR, 'histories.json'), {});
    if (all[channel]) { delete all[channel][chatId]; writeJson(path.join(DATA_DIR, 'histories.json'), all); }
  }
};
module.exports = store;
// store replaces module.exports, so the poolRef assigned in initPg is lost unless the
// getter is re-attached here. Without it lib/docs.js sees no pool and silently falls
// back to JSON files on Postgres deployments: no agx_docs table, reminders and
// knowledge lost on restart.
Object.defineProperty(store, 'poolRef', { get: () => pool });
Object.defineProperty(store, 'HAS_PG', { get: () => Boolean(pool) });
Object.defineProperty(store, 'lastDbError', { get: () => lastDbError });
