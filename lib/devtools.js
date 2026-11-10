// Code and deployment tools.
//
// Reading is open to the owner; writing is the one narrow exception. writeFile commits
// a single file to a repo the owner names, and only the owner's own private chat can
// reach it. Nothing here deploys, and the AgentX repo itself is refused unless it is
// explicitly asked for, because pushing there changes the agent's own instructions and
// every answer it gives.
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

// --- the one write path -------------------------------------------------------
// A commit is a real change to the owner's account, so every guard is a refusal, not
// a warning: a repo-shaped string, a sane path, a size cap, and no workflow files
// (a workflow can run code on his account the moment it lands).
const WRITE_MAX_BYTES = 400 * 1024;

function parseRepo(repo) {
  const value = String(repo || REPO).trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,38}\/[A-Za-z0-9_.-]{1,100}$/.test(value)) {
    throw new Error('repo must look like owner/name, got "' + value.slice(0, 60) + '"');
  }
  return value;
}

function parsePath(path) {
  const p = String(path || '').trim().replace(/^\/+/, '');
  if (!p) throw new Error('a file path inside the repo is required');
  if (p.length > 240) throw new Error('that path is too long for GitHub');
  if (p.split('/').some((part) => part === '..' || part === '.')) throw new Error('relative path segments are not allowed');
  if (/\.git\//i.test(p)) throw new Error('paths inside .git are not allowed');
  if (/^\.github\/workflows?\//i.test(p)) throw new Error('workflow files are not written by the agent: a workflow runs code on your account');
  return p;
}

async function writeFile({ path, content, message, repo, branch } = {}) {
  if (!ghToken()) throw new Error('GITHUB_TOKEN is not configured on the service');
  const target = parseRepo(repo);
  const file = parsePath(path);
  const body = String(content == null ? '' : content);
  const bytes = Buffer.byteLength(body, 'utf8');
  if (bytes > WRITE_MAX_BYTES) {
    throw new Error('that file is ' + Math.round(bytes / 1024) + 'KB, over the ' + WRITE_MAX_BYTES / 1024 + 'KB limit for one commit');
  }
  const ref = String(branch || '').trim();
  const base = '/repos/' + target + '/contents/' + file.split('/').map(encodeURIComponent).join('/');

  // An update needs the blob sha; a create must not send one.
  let sha = null;
  try {
    const meta = await gh(base + (ref ? '?ref=' + encodeURIComponent(ref) : ''));
    if (meta && meta.sha) sha = meta.sha;
  } catch (e) {
    if (!/not found/i.test(String(e.message))) throw e;
  }

  const payload = {
    message: String(message || (sha ? 'Update ' : 'Add ') + file).slice(0, 200),
    content: Buffer.from(body, 'utf8').toString('base64')
  };
  if (sha) payload.sha = sha;
  if (ref) payload.branch = ref;

  const r = await fetch(GITHUB_API + base, {
    method: 'PUT',
    headers: {
      Authorization: 'Bearer ' + ghToken(),
      Accept: 'application/vnd.github+json',
      'Content-Type': 'application/json',
      'User-Agent': 'AgentX/1.0',
      'X-GitHub-Api-Version': '2022-11-28'
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(20000)
  });
  if (!r.ok) throw new Error('github ' + r.status + ': ' + (await r.text()).slice(0, 200));
  const d = await r.json();
  return {
    repo: target,
    path: file,
    action: sha ? 'updated' : 'created',
    branch: (d.commit && d.commit.tree && ref) || ref || 'default',
    commit: d.commit && d.commit.sha ? d.commit.sha.slice(0, 10) : '',
    url: d.commit && d.commit.html_url ? d.commit.html_url : 'https://github.com/' + target + '/blob/' + (ref || 'main') + '/' + file
  };
}

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

// --- what the repos are doing -------------------------------------------------
// Reads only, and the questions they answer are the ones that used to need a dashboard:
// did the build pass, what is waiting in review, what is open that nobody picked up.
// Writing stays the single narrow path above; none of this changes anything on GitHub.

function shortSha(x) { return String(x || '').slice(0, 8); }

function oneLine(s) { return String(s == null ? '' : s).split('\n')[0].slice(0, 90); }

async function overview(repo) {
  const r = parseRepo(repo);
  const d = await gh('/repos/' + r);
  return d.full_name + (d.private ? ' (private)' : ' (public)') + '\n'
    + 'default branch: ' + d.default_branch + '   last push: ' + (d.pushed_at || '?') + '\n'
    + 'open issues and PRs: ' + d.open_issues_count + '   stars: ' + d.stargazers_count
    + '   language: ' + (d.language || 'not reported') + '\n'
    + (d.description ? d.description : '');
}

async function branches(repo, limit) {
  const r = parseRepo(repo);
  const n = Math.min(Math.max(Number(limit) || 10, 1), 30);
  const rows = await gh('/repos/' + r + '/branches?per_page=' + n);
  if (!Array.isArray(rows) || !rows.length) return 'No branches came back for ' + r + '.';
  return r + ' branches (' + rows.length + '):\n'
    + rows.map((b) => '  ' + b.name + '  ' + shortSha(b.commit && b.commit.sha)).join('\n');
}

async function pullRequests(repo, state, limit) {
  const r = parseRepo(repo);
  const want = String(state || 'open').toLowerCase();
  const st = ['open', 'closed', 'all'].includes(want) ? want : 'open';
  const n = Math.min(Math.max(Number(limit) || 10, 1), 30);
  const rows = await gh('/repos/' + r + '/pulls?state=' + st + '&per_page=' + n);
  if (!Array.isArray(rows) || !rows.length) return 'No ' + st + ' pull requests on ' + r + '.';
  return r + ' ' + st + ' pull requests (' + rows.length + '):\n'
    + rows.map((p) => '  #' + p.number + (p.draft ? ' draft' : '') + '  ' + oneLine(p.title)
      + '  (' + ((p.head && p.head.ref) || '?') + ' → ' + ((p.base && p.base.ref) || '?') + ', ' + (p.user && p.user.login || '?') + ')').join('\n');
}

async function pullRequest(repo, number) {
  const r = parseRepo(repo);
  const num = Number(number);
  if (!Number.isInteger(num) || num <= 0) throw new Error('a pull request number is required');
  const p = await gh('/repos/' + r + '/pulls/' + num);
  const headSha = (p.head && p.head.sha) || '';
  const [files, checks] = await Promise.all([
    gh('/repos/' + r + '/pulls/' + num + '/files?per_page=20').catch(() => []),
    headSha ? gh('/repos/' + r + '/commits/' + headSha + '/check-runs').catch(() => null) : Promise.resolve(null)
  ]);
  const lines = [
    '#' + num + ' ' + oneLine(p.title),
    'state: ' + p.state + (p.draft ? ' (draft)' : '') + '   mergeable: ' + (p.mergeable == null ? 'unknown' : p.mergeable)
      + '   ' + ((p.head && p.head.ref) || '?') + ' → ' + ((p.base && p.base.ref) || '?'),
    'by ' + ((p.user && p.user.login) || '?') + '   commits: ' + (p.commits == null ? '?' : p.commits)
      + '   changed files: ' + (p.changed_files == null ? '?' : p.changed_files) + ' (+' + (p.additions || 0) + '/-' + (p.deletions || 0) + ')'
  ];
  if (checks && Array.isArray(checks.check_runs) && checks.check_runs.length) {
    lines.push('checks:');
    for (const c of checks.check_runs.slice(0, 12)) {
      lines.push('  ' + (c.conclusion || c.status || '?') + '  ' + (c.name || 'unnamed'));
    }
  } else if (checks) {
    lines.push('checks: none reported for ' + shortSha(headSha));
  }
  if (Array.isArray(files) && files.length) {
    lines.push('files:');
    for (const f of files.slice(0, 20)) lines.push('  ' + (f.status || '?') + '  ' + f.filename + ' (+' + (f.additions || 0) + '/-' + (f.deletions || 0) + ')');
  }
  if (p.body) lines.push('', clip(String(p.body), 600));
  return lines.join('\n');
}

// Issues and pull requests share one numbering space on GitHub, so a list of "issues"
// contains PRs unless they are filtered out. Showing a PR as an issue is confusing, and
// pretending it is tracked work is worse.
async function issues(repo, { state, query, limit } = {}) {
  const r = parseRepo(repo);
  const n = Math.min(Math.max(Number(limit) || 10, 1), 30);
  const q = String(query || '').trim();
  let rows;
  if (q) {
    const d = await gh('/search/issues?q=' + encodeURIComponent('repo:' + r + ' ' + q) + '&per_page=' + n);
    rows = (d.items || []).filter((x) => !x.pull_request);
    if (!rows.length) return 'Nothing in ' + r + ' matches "' + q + '".';
    return r + ' matching "' + q + '" (' + rows.length + '):\n'
      + rows.map((x) => '  #' + x.number + ' ' + x.state + '  ' + oneLine(x.title)).join('\n');
  }
  const want = String(state || 'open').toLowerCase();
  const st = ['open', 'closed', 'all'].includes(want) ? want : 'open';
  rows = (await gh('/repos/' + r + '/issues?state=' + st + '&per_page=' + Math.min(n * 3, 100)))
    .filter((x) => !x.pull_request);
  if (!rows.length) return 'No ' + st + ' issues on ' + r + '.';
  return r + ' ' + st + ' issues (' + rows.length + '):\n'
    + rows.slice(0, n).map((x) => '  #' + x.number + '  ' + oneLine(x.title)
      + (Array.isArray(x.labels) && x.labels.length ? '  [' + x.labels.map((l) => l.name).join(', ') + ']' : '')
      + (x.comments ? '  ' + x.comments + ' comments' : '')).join('\n');
}

// The build is the thing that silently breaks while everything looks fine, so a failing
// conclusion is stated first and by name rather than left for the owner to notice.
async function actions(repo, limit) {
  const r = parseRepo(repo);
  const n = Math.min(Math.max(Number(limit) || 8, 1), 20);
  const d = await gh('/repos/' + r + '/actions/runs?per_page=' + n);
  const runs = (d && d.workflow_runs) || [];
  if (!runs.length) return 'No workflow runs have been recorded for ' + r + '.';
  const bad = runs.filter((x) => x.conclusion && !['success', 'neutral', 'skipped'].includes(x.conclusion));
  const head = bad.length
    ? 'Failing or unfinished: ' + bad.length + ' of the last ' + runs.length + ' runs'
    : 'All ' + runs.length + ' recent runs finished cleanly';
  return r + ' Actions\n' + head + '\n'
    + runs.map((x) => '  ' + String(x.conclusion || x.status || '?').padEnd(11) + ' ' + String(x.name || 'workflow').slice(0, 28)
      + '  ' + String(x.head_branch || '').slice(0, 20) + '  ' + shortSha(x.head_sha)
      + '  ' + String(x.created_at || '').slice(0, 16).replace('T', ' ')).join('\n');
}

// --- the two writes the owner still confirms by hand --------------------------
// An issue and a pull request are visible to anyone with the repo URL, so neither is
// created here on a model's judgement: these run only after the owner answers yes.
function cleanTitle(t) {
  const v = String(t || '').replace(/\s+/g, ' ').trim();
  if (!v) throw new Error('a title is required');
  if (v.length > 200) throw new Error('that title is ' + v.length + ' characters; GitHub allows 256, keep it under 200');
  return v;
}

function cleanBody(b) {
  const v = String(b == null ? '' : b);
  if (v.length > 20000) throw new Error('that body is ' + v.length + ' characters; shorten it before sending');
  return v;
}

async function openIssue({ repo, title, body, labels } = {}) {
  const r = parseRepo(repo);
  const payload = { title: cleanTitle(title), body: cleanBody(body) };
  if (Array.isArray(labels) && labels.length) {
    payload.labels = labels.map((l) => String(l).slice(0, 50)).slice(0, 5);
  }
  const out = await postJson('/repos/' + r + '/issues', payload);
  return { number: out.number, url: out.html_url, repo: r, title: out.title };
}

// head must already exist: committing is github_write_file's job, and a pull request
// invented from nothing would fail in a way that reads like a permissions problem.
async function openPull({ repo, title, head, base, body, draft } = {}) {
  const r = parseRepo(repo);
  const branch = String(head || '').trim();
  if (!branch) throw new Error('a head branch is required: commit the change to a branch first');
  if (/^[0-9a-f]{40}$/i.test(branch)) throw new Error('that looks like a commit sha, not a branch');
  const payload = {
    title: cleanTitle(title),
    body: cleanBody(body),
    head: branch.slice(0, 200),
    base: String(base || 'main').slice(0, 200),
    draft: Boolean(draft)
  };
  const out = await postJson('/repos/' + r + '/pulls', payload);
  return { number: out.number, url: out.html_url, repo: r, title: out.title, base: payload.base, head: payload.head };
}

async function postJson(path, payload) {
  const token = ghToken();
  if (!token) throw new Error('GITHUB_TOKEN is not configured on the service');
  const r = await fetch(GITHUB_API + path, {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + token,
      Accept: 'application/vnd.github+json',
      'Content-Type': 'application/json',
      'User-Agent': 'AgentX/1.0',
      'X-GitHub-Api-Version': '2022-11-28'
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(15000)
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) {
    const msg = (d && d.message) || 'request failed';
    const detail = Array.isArray(d.errors) && d.errors.length ? ': ' + d.errors.map((e) => e.message || e.code).join('; ') : '';
    throw new Error('github ' + r.status + ' ' + msg + detail);
  }
  return d;
}

module.exports = {
  writeFile, listFiles, readFile, commits, searchCode, deployStatus, logs,
  overview, branches, pullRequests, pullRequest, issues, actions, openIssue, openPull,
  REPO, SERVICE_ID, ghToken, renderToken };
