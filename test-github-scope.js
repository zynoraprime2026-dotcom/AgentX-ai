// Reading every repo the token can see is fine. Writing stays on an allowlist, because a
// stray commit into a live project is the one mistake chat cannot undo.
const dev = require('./lib/devtools');
let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) pass++; else { fail++; console.log('FAIL:', n, String(x).slice(0, 200)); } };
const origFetch = global.fetch;
const token = process.env.GITHUB_TOKEN;
process.env.GITHUB_TOKEN = 'ghp_test';
let calls = [];
function stub(status, body) {
  calls = [];
  global.fetch = async (url, opts) => {
    calls.push({ url: String(url).replace('https://api.github.com', ''), method: (opts || {}).method, body: (opts || {}).body });
    return { ok: status < 400, status, json: async () => body, text: async () => JSON.stringify(body) };
  };
}
(async () => {
  stub(200, [
    { full_name: 'zynoraprime2026-dotcom/AgentX-ai', private: true, pushed_at: '2026-11-10T19:00:00Z' },
    { full_name: 'zynoraprime2026-dotcom/noor-api', private: true, pushed_at: '2026-11-08T10:00:00Z' },
    { full_name: 'zynoraprime2026-dotcom/ilm-api', private: true, pushed_at: '2026-11-07T10:00:00Z' }
  ]);
  const out = await dev.listRepos(10);
  ok('every repo is listed', /AgentX-ai/.test(out) && /noor-api/.test(out) && /ilm-api/.test(out), out);
  ok('the writable one is marked', /AgentX-ai private  \[can write\]/.test(out), out);
  ok('the others are marked read only', /noor-api private  \[read only\]/.test(out) && /ilm-api private  \[read only\]/.test(out), out);
  ok('the listing states the allowlist', /Writable: zynoraprime2026-dotcom\/AgentX-ai/.test(out), out);

  // reading another repo works
  stub(200, { full_name: 'zynoraprime2026-dotcom/noor-api', private: true, default_branch: 'main', pushed_at: 'x', open_issues_count: 0, stargazers_count: 0, language: 'JS', description: 'noor' });
  const ov = await dev.overview('zynoraprime2026-dotcom/noor-api');
  ok('another repo can be read', /noor-api/.test(ov), ov);

  // writing to it is refused before anything is sent
  stub(201, { number: 1, html_url: 'x', title: 't' });
  for (const [name, fn] of [
    ['a commit', () => dev.writeFile({ repo: 'zynoraprime2026-dotcom/noor-api', path: 'a.txt', content: 'x' })],
    ['an issue', () => dev.openIssue({ repo: 'zynoraprime2026-dotcom/noor-api', title: 'x' })],
    ['a pull request', () => dev.openPull({ repo: 'zynoraprime2026-dotcom/noor-api', title: 'x', head: 'b' })]
  ]) {
    calls = [];
    try { await fn(); ok(name + ' outside the allowlist is refused', false); }
    catch (e) { ok(name + ' outside the allowlist is refused', /read-only from here/.test(e.message) && calls.length === 0, e.message + ' | calls ' + calls.length); }
  }

  // the allowlist can be widened by configuration, and then the same write is allowed
  process.env.GITHUB_WRITE_REPOS = 'zynoraprime2026-dotcom/noor-api,zynoraprime2026-dotcom/AgentX-ai';
  stub(201, { number: 7, html_url: 'https://github.com/o/noor-api/issues/7', title: 'x' });
  const iss = await dev.openIssue({ repo: 'zynoraprime2026-dotcom/noor-api', title: 'x' });
  ok('a configured repo becomes writable', iss.number === 7 && calls.length === 1, JSON.stringify(iss));
  delete process.env.GITHUB_WRITE_REPOS;

  global.fetch = origFetch;
  if (token) process.env.GITHUB_TOKEN = token;
  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})();
