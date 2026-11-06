// Read-only code and deployment tools.
//
// Deliberately read-only: the agent may look at the repo and the Render service, but
// it cannot commit, push, or deploy. Render auto-deploys main, so push rights would
// let a bad prompt or a poisoned web page change the agent's own instructions and the
// answers every WhatsApp user receives. Reading covers the useful half of the job.
//
// Tokens live in the service environment (GITHUB_TOKEN, RENDER_API_KEY), never in a
// prompt. Anything that fails loudly says so instead of guessing.

const GITHUB_API = 'https://api.github.com';
const RENDER_API = 'https://api.render.com/v1';

const REPO = process.env.GITHUB_REPO || 'zynoraprime2026-dotcom/AgentX-ai';
const SERVICE_ID = process.env.RENDER_SERVICE_ID || 'srv-db3ga7tg1s2s73ab8t4g';

const FILE_CHARS = 6000;
const MAX_FILES = 60;

function ghToken() { return process.env.GITHUB_TOKEN || ''; }
function renderToken() { return process.env.RENDER_API_KEY || ''; }

async function gh(path, accept) {
  const token = ghToken();
  if (!token) throw new Error('GITHUB_TOKEN is not configured on the service');
  const r = await fetch(GITHUB_API + path, {
    headers: {
      Authorization: 'Bearer ' + token,
      Accept: accept || 'application/vnd.github+json',
      'User-Agent': 'AgentX/1.0',
      'X-GitHub-Api-Version': '2022-11-28'
    },
    signal: AbortSignal.timeout(15000)
  });
  if (r.status === 404) throw new Error('not found in ' + REPO + ' (check the path)');
  if (!r.ok) throw new Error('github ' + r.status + ': ' + (await r.text()).slice(0, 160));
  return r.json();
}

async function render(path) {
  const token = renderToken();
  if (!token) throw new Error('RENDER_API_KEY is not configured on the service');
  const r = await fetch(RENDER_API + path, {
    headers: { Authorization: 'Bearer ' + token, Accept: 'application/json', 'User-Agent': 'AgentX/1.0' },
    signal: AbortSignal.timeout(15000)
  });
  if (!r.ok) throw new Error('render ' + r.status + ': ' + (await r.text()).slice(0, 160));
  return r.json();
}

function clip(s, n) {
  const t = String(s == null ? '' : s);
  return t.length > n ? t.slice(0, n - 1) + '\n… (truncated)' : t;
}

async function listFiles(dir, ref) {
  const out = await gh('/repos/' + REPO + '/contents/' + encodeURIComponent(dir || '').replace(/%2F/g, '/') + (ref ? '?ref=' + encodeURIComponent(ref) : ''));
  if (!Array.isArray(out)) throw new Error('that path is a file; use github_file to read it');
  const rows = out.slice(0, MAX_FILES).map((f) => f.type + '  ' + f.path + (f.type === 'file' ? '  (' + f.size + ' bytes)' : ''));
  return REPO + (dir ? '/' + dir : '/') + ' (' + out.length + ' entries' + (out.length > MAX_FILES ? ', first ' + MAX_FILES : '') + ')\n\n' + rows.join('\n');
}

async function readFile(path, ref) {
  if (!path) throw new Error('a file path is required');
  const d = await gh('/repos/' + REPO + '/contents/' + encodeURIComponent(path).replace(/%2F/g, '/') + (ref ? '?ref=' + encodeURIComponent(ref) : ''));
  if (Array.isArray(d)) throw new Error('that path is a directory; use github_list');
  if (!d.content) throw new Error('file is too large for the API or has no inline content');
  const text = Buffer.from(d.content, d.encoding === 'base64' ? 'base64' : 'utf8').toString('utf8');
  const line = text.split('\n').length;
  return path + ' @ ' + (ref || 'main') + ' (' + line + ' lines, ' + d.size + ' bytes)\n\n' + clip(text, FILE_CHARS);
}

async function commits(limit) {
  const n = Math.min(Math.max(Number(limit) || 6, 1), 15);
  const rows = await gh('/repos/' + REPO + '/commits?per_page=' + n);
  return 'Latest commits on ' + REPO + ':\n\n' + rows.map((c) => {
    const first = (c.commit && c.commit.message || '').split('\n')[0];
    return c.sha.slice(0, 8) + '  ' + (c.commit && c.commit.author && c.commit.author.date || '') + '  ' + first;
  }).join('\n');
}

// GitHub's code search only answers for indexed repositories and this one comes back
// with "incomplete_results: true, total_count: 0" even for strings that certainly
// exist, so the search walks the tree and greps the text files itself.
const TEXTY = /\.(js|mjs|cjs|ts|tsx|json|md|html|css|yml|yaml|txt)$/i;
const SKIP = /(^|\/)(node_modules|\.git|dist|build|coverage)\//;

async function textFiles() {
  const t = await gh('/repos/' + REPO + '/git/trees/main?recursive=1');
  return (t.tree || []).filter((f) => f.type === 'blob' && TEXTY.test(f.path) && !SKIP.test(f.path) && (f.size || 0) < 250000);
}

async function searchCode(q) {
  const needle = String(q || '').trim();
  if (!needle) throw new Error('a search query is required');
  const files = (await textFiles()).slice(0, 40);
  const re = new RegExp(needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
  const hits = await Promise.all(files.map(async (f) => {
    try {
      const r = await fetch('https://raw.githubusercontent.com/' + REPO + '/main/' + f.path.split('/').map(encodeURIComponent).join('/'), {
        headers: { 'User-Agent': 'AgentX/1.0', Authorization: 'Bearer ' + ghToken() },
        signal: AbortSignal.timeout(12000)
      });
      if (!r.ok) return null;
      const lines = (await r.text()).split('\n');
      const found = [];
      lines.forEach((line, i) => {
        if (found.length < 3 && re.test(line)) found.push('   ' + (i + 1) + ': ' + line.trim().slice(0, 160));
      });
      return found.length ? f.path + '\n' + found.join('\n') : null;
    } catch (e) { return null; }
  }));
  const out = hits.filter(Boolean).slice(0, 8);
  if (!out.length) return 'No file in ' + REPO + ' (searched ' + files.length + ' text files) contains "' + needle + '".';
  return 'Matches for "' + needle + '" in ' + REPO + ':\n\n' + out.join('\n\n');
}

async function deployStatus() {
  const svc = await render('/services/' + SERVICE_ID);
  const deps = await render('/services/' + SERVICE_ID + '/deploys?limit=3');
  const rows = (Array.isArray(deps) ? deps : []).map((x) => x.deploy || x).map((d) => {
    const c = d.commit || {};
    return '  ' + (d.status || '?') + '  ' + (c.id || '').slice(0, 8) + '  ' + (c.message || '').split('\n')[0].slice(0, 80) + '  finished ' + (d.finishedAt || d.createdAt || '');
  });
  const s = svc.service || svc;
  return 'Render service ' + (s.name || SERVICE_ID) + ' (' + (s.region || '?') + ', ' + (s.type || 'web_service') + ')\n'
    + 'autoDeploy: ' + String(s.autoDeploy) + '  branch: ' + (s.branch || 'main') + '\n'
    + 'url: ' + (s.serviceDetails && s.serviceDetails.url || '') + '\n\n'
    + 'Recent deploys:\n' + rows.join('\n');
}

async function logs(limit, text) {
  const n = Math.min(Math.max(Number(limit) || 40, 1), 100);
  const svc = await render('/services/' + SERVICE_ID);
  const s = svc.service || svc;
  const ownerId = s.ownerId;
  if (!ownerId) throw new Error('could not resolve the service owner id');
  let q = '/logs?ownerId=' + encodeURIComponent(ownerId) + '&resource=' + encodeURIComponent(SERVICE_ID)
    + '&limit=' + n + '&direction=backward' + (text ? '&text=' + encodeURIComponent(text) : '');
  const d = await render(q);
  const rows = (d.logs || d.data || []);
  if (!rows.length) return 'No log lines came back' + (text ? ' matching "' + text + '"' : '') + '. Rendering logs may need a paid plan; say so rather than guessing what happened.';
  return 'Last ' + rows.length + ' log lines' + (text ? ' matching "' + text + '"' : '') + ':\n\n'
    + rows.map((l) => (l.timestamp || '') + '  ' + String(l.message || '').replace(/\s+/g, ' ').slice(0, 240)).join('\n');
}

module.exports = { listFiles, readFile, commits, searchCode, deployStatus, logs, REPO, SERVICE_ID, ghToken, renderToken };
