// Editing what a Page says about itself, always staged and always confirmable.
const social = require('./lib/social');
let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) pass++; else { fail++; console.log('FAIL:', n, String(x).slice(0, 220)); } };
const origFetch = global.fetch;
let calls = [];
function stub(body) {
  calls = [];
  global.fetch = async (url, opts) => {
    calls.push({ url: String(url), method: (opts || {}).method, body: String((opts || {}).body || '') });
    return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) };
  };
}
(async () => {
  stub({ id: '108861494336428', name: "The salafi Da'wah", category: 'Religious Organization', about: 'Salafi dawah', followers_count: 985 });
  const p = await social.pageProfile('108861494336428', 'tok');
  ok('a profile reads through the Page token', p.name === "The salafi Da'wah" && /fields=/.test(calls[0].url), JSON.stringify(p));
  ok('the read is a GET', calls[0].method === 'GET');

  stub({ success: true });
  const out = await social.updatePage('108861494336428', 'tok', { about: 'New about', description: 'New description' });
  ok('an update posts the changed fields', /about/.test(calls[0].body) && calls[0].method === 'POST', calls[0].body);
  ok('the applied keys come back', Object.keys(out.applied).sort().join(',') === 'about,description', JSON.stringify(out.applied));

  // the identity fields are not reachable, and a call with only those is refused outright
  try { await social.updatePage('1', 'tok', { name: 'Something else' }); ok('a name change is refused', false); }
  catch (e) { ok('a name change is refused', /none of those fields/.test(e.message), e.message); }
  try { await social.updatePage('1', 'tok', { access_token: 'leak' }); ok('a smuggled param is refused', false); }
  catch (e) { ok('a smuggled param is refused', /none of those fields/.test(e.message), e.message); }

  global.fetch = origFetch;
  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})();
