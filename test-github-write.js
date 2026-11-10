// Opening an issue or a pull request is a public act on the owner's account, so the test
// is as much about what is refused as what is sent.
const dev = require('./lib/devtools');
let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) pass++; else { fail++; console.log('FAIL:', n, String(x).slice(0, 240)); } };

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
  stub(201, { number: 12, html_url: 'https://github.com/zynoraprime2026-dotcom/AgentX-ai/issues/12', title: 'Ask Sunnah.com for narration access' });
  let out = await dev.openIssue({ title: 'Ask Sunnah.com for narration access', body: 'Tracked upstream.' });
  ok('issue returns its number and url', out.number === 12 && /issues\/12/.test(out.url), JSON.stringify(out));
  ok('issue posts to the repo issues endpoint', calls[0].url === '/repos/zynoraprime2026-dotcom/AgentX-ai/issues' && calls[0].method === 'POST', JSON.stringify(calls[0]));
  ok('issue carries title and body', JSON.parse(calls[0].body).title === 'Ask Sunnah.com for narration access' && JSON.parse(calls[0].body).body === 'Tracked upstream.', calls[0].body);

  stub(201, { number: 3, html_url: 'https://github.com/o/r/pull/3', title: 'Add heartbeat' });
  out = await dev.openPull({ title: 'Add heartbeat', head: 'cron-heartbeat', body: 'Adds a stamp.' });
  ok('pull request returns its number and url', out.number === 3 && /pull\/3/.test(out.url), JSON.stringify(out));
  ok('pull request defaults its base to main', JSON.parse(calls[0].body).base === 'main', calls[0].body);
  ok('pull request sends the head branch', JSON.parse(calls[0].body).head === 'cron-heartbeat', calls[0].body);

  stub(201, { number: 4, html_url: 'x', title: 't' });
  await dev.openPull({ title: 't', head: 'b', base: 'develop', draft: true });
  ok('draft flag is passed through', JSON.parse(calls[0].body).draft === true, calls[0].body);

  // refusals: each must not reach the network
  stub(201, { number: 1, html_url: 'x', title: 't' });
  const refused = async (name, fn, pattern) => {
    calls = [];
    try { await fn(); ok(name, false, 'no error'); }
    catch (e) { ok(name, pattern.test(e.message) && calls.length === 0, e.message + ' | calls ' + calls.length); }
  };
  await refused('an empty issue title is refused', () => dev.openIssue({ title: '   ' }), /title is required/);
  await refused('a pull request without a head is refused', () => dev.openPull({ title: 'x' }), /head branch is required/);
  await refused('a sha where a branch belongs is refused', () => dev.openPull({ title: 'x', head: 'a'.repeat(40) }), /commit sha/);
  await refused('a malformed repo is refused', () => dev.openIssue({ repo: 'nope', title: 'x' }), /owner\/name/);

  // GitHub's own refusal must come back readable, not as a stack trace
  stub(422, { message: 'Validation Failed', errors: [{ message: 'A pull request already exists for o:branch.' }] });
  try { await dev.openPull({ title: 'x', head: 'branch' }); ok('github refusal surfaces', false); }
  catch (e) { ok('github refusal is readable', /github 422 Validation Failed/.test(e.message) && /already exists/.test(e.message), e.message); }

  global.fetch = origFetch;
  if (token) process.env.GITHUB_TOKEN = token;
  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  /* shape checks below still run */
})();

// A staged repo action waits in its own slot, so a yes meant for a caption edit can
// never open an issue on GitHub instead.
const src = require('fs').readFileSync(__dirname + '/server.js', 'utf8');
let pass2 = 0, fail2 = 0;
const ok2 = (n, c) => { if (c) pass2++; else { fail2++; console.log('FAIL:', n); } };
ok2('issue waits in the repo slot', /setPendingGithub\(\{\s*kind: 'github_issue'/.test(src));
ok2('pull request waits in the repo slot', /setPendingGithub\(\{\s*kind: 'github_pr'/.test(src));
ok2('repo slot is a separate records key', /PENDING_GITHUB_KEY = 'pending_github_action'/.test(src));
ok2('a yes reads the repo slot when the Page slot is empty', /const gh = await getPendingGithub\(\)/.test(src));
ok2('a no clears the repo slot too', /clearPendingGithub\(\)/.test(src));
ok2('the repo slot is never written into the Page slot', !/setPendingAction\(\{\s*kind: 'github_/.test(src));
console.log(pass2 + ' passed, ' + fail2 + ' failed');
process.exit(fail2 ? 1 : 0);
