// Connector registry.
//
// One place that answers "what is this service, is it actually reachable right now, and
// what does it let an agent do". The dashboard used to scatter this across status flags,
// which is why the connectors were hard to find. Nothing here returns a secret: each entry
// says only connected yes/no, what it enables, and the exact env var to set when it is missing.

const CONNECTORS = [
  {
    id: 'github',
    name: 'GitHub',
    category: 'Code',
    glyph: 'GH',
    env: ['GITHUB_TOKEN'],
    optional: ['GITHUB_REPO'],
    scope: 'read',
    enables: 'List files, read a file, search code, list commits in the AgentX repository.',
    tools: ['github_list', 'github_file', 'github_search_code', 'github_commits'],
    note: 'Read-only by design: no commit, no push, no deploy.'
  },
  {
    id: 'render',
    name: 'Render',
    category: 'Code',
    glyph: 'RN',
    env: ['RENDER_API_KEY'],
    optional: ['RENDER_SERVICE_ID'],
    scope: 'read',
    enables: 'Deploy status and production log lines for the live service.',
    tools: ['render_deploy_status', 'render_logs'],
    note: 'Logs never leave the dashboard chat: a log tail can carry phone numbers.'
  },
  {
    id: 'email',
    name: 'Email',
    category: 'Messaging',
    glyph: 'EM',
    env: [],
    optional: ['BREVO_API_KEY', 'RESEND_API_KEY', 'SMTP_HOST', 'SMTP_USER', 'SMTP_PASS', 'SMTP_PORT', 'MAIL_FROM'],
    scope: 'write',
    enables: 'Send an email from the workspace address, with an optional reply-to.',
    tools: ['send_email'],
    note: 'Render free blocks outbound SMTP, so use an HTTPS key (BREVO_API_KEY is simplest). SMTP only connects on a paid instance.'
  },
  {
    id: 'whatsapp',
    name: 'WhatsApp Cloud API',
    category: 'Messaging',
    glyph: 'WA',
    env: ['WHATSAPP_PHONE_NUMBER_ID', 'WHATSAPP_ACCESS_TOKEN'],
    optional: ['WHATSAPP_VERIFY_TOKEN', 'WHATSAPP_APP_SECRET', 'WHATSAPP_WABA_ID'],
    scope: 'write',
    enables: 'Answer and send WhatsApp messages, images and voice notes.',
    tools: [],
    note: 'App secret is optional but leaves the webhook unsigned when missing.'
  },
  {
    id: 'telegram',
    name: 'Telegram',
    category: 'Messaging',
    glyph: 'TG',
    env: ['TELEGRAM_BOT_TOKEN'],
    optional: ['TELEGRAM_WEBHOOK_SECRET'],
    scope: 'write',
    enables: 'Answer on Telegram and send reminders to a chat id.',
    tools: [],
    note: 'Webhook secret verifies that updates really come from Telegram.'
  },
  {
    id: 'ilm',
    name: 'Ilm API',
    category: 'Knowledge',
    glyph: 'IL',
    env: ['ILM_API_KEY'],
    optional: ['ILM_API_URL'],
    scope: 'read',
    enables: 'Prayer times, Quran text, hadith search, duas, fiqh rulings, dictionary.',
    tools: ['get_prayer_times', 'get_quran_ayah', 'search_hadith', 'search_dictionary', 'get_dua', 'get_fiqh_ruling', 'search_islamic_sources', 'cite_reference'],
    note: 'The authority for Quran, hadith and fiqh. Web search never overrides it.'
  },
  {
    id: 'turath',
    name: 'Turath API',
    category: 'Knowledge',
    glyph: 'TU',
    env: ['TURATH_API_KEY'],
    optional: ['TURATH_API_URL'],
    scope: 'read',
    enables: 'Manuscripts, scholars, rijal and historical events.',
    tools: ['search_manuscripts', 'get_manuscript', 'manuscript_of_the_day', 'search_scholars', 'search_historical_events'],
    note: 'Small curated catalogue, not a general history source.'
  },
  {
    id: 'studio',
    name: 'Studio API',
    category: 'Creation',
    glyph: 'ST',
    env: ['STUDIO_API_KEY'],
    optional: ['STUDIO_API_URL'],
    scope: 'write',
    enables: 'Image generation, Ken Burns video, voice, content drafts and PDFs.',
    tools: ['generate_image', 'make_video', 'create_content'],
    note: 'Images bill against your Studio quota; the owner allowance is separate from chat users.'
  },
  {
    id: 'groq',
    name: 'Groq',
    category: 'Models',
    glyph: 'GQ',
    env: ['GROQ_API_KEY'],
    scope: 'read',
    enables: 'Text models with tool calling, and Whisper voice notes.',
    tools: [],
    note: 'Falls back to Gemini when Groq is rate limited.'
  },
  {
    id: 'gemini',
    name: 'Gemini',
    category: 'Models',
    glyph: 'GM',
    env: ['GEMINI_API_KEY'],
    optional: ['GEMINI_MODEL'],
    scope: 'read',
    enables: 'The model lane used when Groq is out of budget.',
    tools: [],
    note: 'Free tier has a daily cap; 429s here are expected at busy hours.'
  },
  {
    id: 'database',
    name: 'Postgres (Neon)',
    category: 'Storage',
    glyph: 'DB',
    env: ['DATABASE_URL'],
    scope: 'write',
    enables: 'Agents, conversation history, knowledge documents, subscribers, usage.',
    tools: [],
    note: 'The whole dashboard falls back to files without it, which loses persistence.'
  }
];

function readEnv(key) {
  const v = process.env[key];
  return typeof v === 'string' ? v.trim() : '';
}

function present(id) {
  const c = CONNECTORS.find((x) => x.id === id);
  if (!c) return false;
  return c.env.every((k) => readEnv(k).length > 0);
}

// Each check is a cheap read against the provider. Anything that throws is reported as
// unreachable with the reason, because "connected but broken" is a different problem from
// "not set up" and the owner needs to tell them apart.
async function timed(fn, ms) {
  const t0 = Date.now();
  const out = await fn();
  return { ...out, ms: Date.now() - t0, ...(ms ? {} : {}) };
}

const CHECKS = {
  github: async () => {
    const token = readEnv('GITHUB_TOKEN');
    const repo = readEnv('GITHUB_REPO') || 'zynoraprime2026-dotcom/AgentX-ai';
    const r = await fetch('https://api.github.com/repos/' + repo, {
      headers: { Authorization: 'Bearer ' + token, Accept: 'application/vnd.github+json', 'User-Agent': 'AgentX/1.0' },
      signal: AbortSignal.timeout(9000)
    });
    if (r.status === 401) throw new Error('token rejected (401)');
    if (r.status === 404) throw new Error('repo not visible to this token: ' + repo);
    if (!r.ok) throw new Error('github ' + r.status);
    const d = await r.json();
    return { detail: repo + ' · default branch ' + d.default_branch + ' · ' + (d.private ? 'private' : 'public') };
  },
  render: async () => {
    const token = readEnv('RENDER_API_KEY');
    const svc = readEnv('RENDER_SERVICE_ID') || 'srv-db3ga7tg1s2s73ab8t4g';
    const r = await fetch('https://api.render.com/v1/services/' + svc, {
      headers: { Authorization: 'Bearer ' + token, Accept: 'application/json', 'User-Agent': 'AgentX/1.0' },
      signal: AbortSignal.timeout(9000)
    });
    if (!r.ok) throw new Error('render ' + r.status);
    const d = await r.json();
    const s = d.service || d;
    return { detail: (s.name || svc) + ' · ' + (s.suspended === 'suspended' ? 'suspended' : 'live') + ' · autoDeploy ' + String(s.autoDeploy) };
  },
  email: async () => {
    const mailer = require('./mailer');
    const v = await mailer.verifyMail();
    return { detail: v.detail };
  },
  whatsapp: async () => {
    const id = readEnv('WHATSAPP_PHONE_NUMBER_ID');
    const token = readEnv('WHATSAPP_ACCESS_TOKEN');
    const r = await fetch('https://graph.facebook.com/v21.0/' + id + '?fields=verified_name,display_phone_number,quality_rating', {
      headers: { Authorization: 'Bearer ' + token, 'User-Agent': 'AgentX/1.0' },
      signal: AbortSignal.timeout(9000)
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error('meta ' + r.status + ': ' + String((d.error && d.error.message) || '').slice(0, 90));
    return { detail: (d.verified_name || 'number') + ' · ' + (d.display_phone_number || id) + ' · quality ' + (d.quality_rating || 'n/a') };
  },
  telegram: async () => {
    const r = await fetch('https://api.telegram.org/bot' + readEnv('TELEGRAM_BOT_TOKEN') + '/getMe', { signal: AbortSignal.timeout(9000) });
    const d = await r.json().catch(() => ({}));
    if (!d.ok) throw new Error('telegram: ' + String((d.description) || r.status).slice(0, 80));
    return { detail: '@' + d.result.username + ' · ' + d.result.first_name };
  },
  ilm: async () => {
    const base = (readEnv('ILM_API_URL') || 'https://ilm-api.vercel.app').replace(/\/$/, '');
    const r = await fetch(base + '/v1/prayer-times?city=Tarkwa', { headers: { 'x-api-key': readEnv('ILM_API_KEY'), 'User-Agent': 'AgentX/1.0' }, signal: AbortSignal.timeout(12000) });
    if (!r.ok) throw new Error('ilm ' + r.status);
    const d = await r.json();
    // The Ilm API returns ISO timestamps for the times, so show a clock time rather than
    // the raw string or 'n/a', which looked like a broken connector.
    const raw = (d.times && d.times.fajr) || (d.timings && d.timings.fajr) || d.fajr || '';
    let fajr = 'n/a';
    if (raw) {
      const dt = new Date(raw);
      fajr = isNaN(dt) ? String(raw).slice(0, 12) : dt.toISOString().slice(11, 16) + ' UTC';
    }
    return { detail: 'prayer times live · Fajr ' + fajr + ' · ' + (d.city || '') + (d.method ? ' · ' + d.method : '') };
  },
  turath: async () => {
    const base = (readEnv('TURATH_API_URL') || 'https://turath-api.vercel.app').replace(/\/$/, '');
    const r = await fetch(base + '/api/stats', { headers: { 'x-api-key': readEnv('TURATH_API_KEY'), 'User-Agent': 'AgentX/1.0' }, signal: AbortSignal.timeout(12000) });
    if (!r.ok) throw new Error('turath ' + r.status);
    const d = await r.json().catch(() => ({}));
    const n = d.manuscripts || (d.totals && d.totals.manuscripts);
    return { detail: 'catalogue live' + (n ? ' · ' + n + ' manuscripts' : '') };
  },
  studio: async () => {
    const base = (readEnv('STUDIO_API_URL') || 'https://studio-api-nqpm.onrender.com').replace(/\/$/, '');
    const r = await fetch(base + '/v1/usage', { headers: { 'x-api-key': readEnv('STUDIO_API_KEY'), 'User-Agent': 'AgentX/1.0' }, signal: AbortSignal.timeout(12000) });
    if (!r.ok) throw new Error('studio ' + r.status);
    const d = await r.json();
    return { detail: 'usage ' + d.used + '/' + d.limit + ' this month' };
  },
  groq: async () => {
    const r = await fetch('https://api.groq.com/openai/v1/models', { headers: { Authorization: 'Bearer ' + readEnv('GROQ_API_KEY'), 'User-Agent': 'AgentX/1.0' }, signal: AbortSignal.timeout(9000) });
    if (!r.ok) throw new Error('groq ' + r.status);
    const d = await r.json();
    return { detail: (d.data || []).length + ' models available' };
  },
  gemini: async () => {
    const r = await fetch('https://generativelanguage.googleapis.com/v1beta/models?key=' + readEnv('GEMINI_API_KEY'), { signal: AbortSignal.timeout(9000) });
    if (!r.ok) throw new Error('gemini ' + r.status);
    const d = await r.json();
    return { detail: (d.models || []).length + ' models available' };
  },
  database: async () => {
    const p = require('../db').poolRef;
    if (!p) throw new Error('pool not initialised');
    const r = await p.query('SELECT count(*)::int AS n FROM agx_agents');
    return { detail: 'postgres reachable · ' + r.rows[0].n + ' agents stored' };
  }
};

let cache = { at: 0, list: null };

// The dashboard polls this, and each entry costs a provider round trip, so a short cache
// keeps a refresh-happy tab from turning into a rate-limit incident.
async function connectorStatus(opts) {
  const force = Boolean(opts && opts.force);
  if (!force && cache.list && Date.now() - cache.at < 60e3) return { ...cache.list, cached: true };
  const list = await Promise.all(CONNECTORS.map(async (c) => {
    const missing = c.env.filter((k) => !readEnv(k));
    const base = {
      id: c.id, name: c.name, category: c.category, glyph: c.glyph, scope: c.scope,
      enables: c.enables, tools: c.tools || [], note: c.note || '',
      env: c.env.concat(c.optional || []), missing
    };
    if (missing.length) return { ...base, connected: false, state: 'not_set', detail: 'Missing ' + missing.join(', ') };
    try {
      const out = await timed(CHECKS[c.id]);
      return { ...base, connected: true, state: 'connected', ...out };
    } catch (e) {
      return { ...base, connected: false, state: 'error', detail: String(e.message || e).slice(0, 140) };
    }
  }));
  const summary = {
    total: list.length,
    connected: list.filter((c) => c.state === 'connected').length,
    broken: list.filter((c) => c.state === 'error').length,
    missing: list.filter((c) => c.state === 'not_set').length
  };
  cache = { at: Date.now(), list: { connectors: list, summary } };
  return cache.list;
}

module.exports = { connectorStatus, CONNECTORS, present, readEnv };
