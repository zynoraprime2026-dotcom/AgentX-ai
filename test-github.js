// GitHub reads: the repo's state, its review queue, and whether the build is green.
// These answer from a stubbed API, so the formatting and the refusals are tested without
// touching the owner's account.
const dev = require('./lib/devtools');

let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) pass++; else { fail++; console.log('FAIL:', n, x === undefined ? '' : String(x).slice(0, 300)); } };

const original = global.fetch;
const env = process.env.GITHUB_TOKEN;
process.env.GITHUB_TOKEN = 'ghp_test';
process.env.GITHUB_REPO = 'zynoraprime2026-dotcom/AgentX-ai';

let asked = [];
function stub(routes) {
  asked = [];
  global.fetch = async (url) => {
    const u = String(url).replace('https://api.github.com', '');
    asked.push(u);
    for (const [needle, body] of routes) {
      if (u.includes(needle)) {
        if (body === 404) return { ok: false, status: 404, text: async () => 'Not Found', json: async () => ({}) };
        return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) };
      }
    }
    return { ok: false, status: 404, text: async () => 'Not Found', json: async () => ({}) };
  };
}

(async () => {
  // overview
  stub([['/repos/zynoraprime2026-dotcom/AgentX-ai', { full_name: 'zynoraprime2026-dotcom/AgentX-ai', private: true, default_branch: 'main', pushed_at: '2026-11-10T18:00:00Z', open_issues_count: 2, stargazers_count: 0, language: 'JavaScript', description: 'AgentX' }]]);
  let out = await dev.overview();
  ok('overview names the repo and branch', /AgentX-ai \(private\)/.test(out) && /default branch: main/.test(out), out);
  ok('overview reports open work', /open issues and PRs: 2/.test(out), out);

  // branches
  stub([['/branches', [{ name: 'main', commit: { sha: 'abcdef1234567' } }, { name: 'permanent-ig', commit: { sha: '9876543210ff' } }]]]);
  out = await dev.branches(null, 5);
  ok('branches list with short shas', /main\s+abcdef12/.test(out) && /permanent-ig\s+98765432/.test(out), out);

  // pull requests
  stub([['/pulls?', [{ number: 4, title: 'Add CI heartbeat', draft: false, head: { ref: 'ci-heartbeat' }, base: { ref: 'main' }, user: { login: 'zynoraprime2026-dotcom' } }]]]);
  out = await dev.pullRequests(null, 'open', 5);
  ok('pr list shows number, route and author', /#4/.test(out) && /ci-heartbeat → main/.test(out) && /zynoraprime2026-dotcom/.test(out), out);
  stub([['/pulls?', []]]);
  out = await dev.pullRequests(null, 'open', 5);
  ok('an empty PR list says so plainly', /No open pull requests/.test(out), out);

  // one pull request, with checks and files
  stub([
    ['/pulls/4/files', [{ status: 'modified', filename: 'lib/daily.js', additions: 12, deletions: 3 }]],
    ['/check-runs', { total_count: 2, check_runs: [{ name: 'build', status: 'completed', conclusion: 'failure' }, { name: 'lint', status: 'completed', conclusion: 'success' }] }],
    ['/pulls/4', { number: 4, title: 'Add CI heartbeat', state: 'open', draft: false, mergeable: true, head: { ref: 'ci-heartbeat', sha: 'abc1234def' }, base: { ref: 'main' }, user: { login: 'owner' }, commits: 2, changed_files: 1, additions: 12, deletions: 3, body: 'Adds a heartbeat.' }]
  ]);
  out = await dev.pullRequest(null, 4);
  ok('pr detail carries the failing check name', /failure\s+build/.test(out) && /success\s+lint/.test(out), out);
  ok('pr detail lists changed files', /lib\/daily\.js/.test(out), out);
  ok('pr detail states mergeability', /mergeable: true/.test(out), out);
  try { await dev.pullRequest(null, 'x'); ok('a non-numeric PR number is refused', false); } catch (e) { ok('a non-numeric PR number is refused', /number is required/.test(e.message), e.message); }

  // issues exclude pull requests
  stub([['/issues?', [
    { number: 7, title: 'Ask Sunnah.com for narration access', state: 'open', labels: [{ name: 'upstream' }], comments: 3 },
    { number: 8, title: 'A pull request that is not an issue', pull_request: { url: 'x' } }
  ]]]);
  out = await dev.issues(null, { state: 'open', limit: 5 });
  ok('issues list carries labels and comment counts', /#7/.test(out) && /\[upstream\]/.test(out) && /3 comments/.test(out), out);
  ok('pull requests are not counted as issues', !/#8/.test(out), out);

  stub([['/search/issues', { items: [{ number: 9, title: 'Email deliverability', state: 'open' }] }]]);
  out = await dev.issues(null, { query: 'email', limit: 5 });
  ok('a search names what matched', /matching "email"/.test(out) && /#9/.test(out), out);

  // actions
  stub([['/actions/runs', { workflow_runs: [
    { name: 'deploy', conclusion: 'failure', status: 'completed', head_branch: 'main', head_sha: 'aaaabbbbcccc', created_at: '2026-11-10T06:01:00Z' },
    { name: 'deploy', conclusion: 'success', status: 'completed', head_branch: 'main', head_sha: 'dddd', created_at: '2026-11-09T06:01:00Z' }
  ] }]]);
  out = await dev.actions(null, 5);
  ok('a failing run is stated up front', /Failing or unfinished: 1 of the last 2/.test(out), out);
  ok('runs show conclusion and branch', /failure\s+deploy\s+main/.test(out), out);

  stub([['/actions/runs', { workflow_runs: [] }]]);
  out = await dev.actions(null, 5);
  ok('no runs says so instead of an empty table', /No workflow runs/.test(out), out);

  // a bad repo string is refused before any request is made
  stub([]);
  try { await dev.overview('not-a-repo'); ok('a malformed repo is refused', false); } catch (e) { ok('a malformed repo is refused', /owner\/name/.test(e.message), e.message); }
  ok('the refusal never reached the network', asked.length === 0, JSON.stringify(asked));

  global.fetch = original;
  if (env) process.env.GITHUB_TOKEN = env;
  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})();
