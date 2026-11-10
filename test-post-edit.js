// The caption-edit and delete paths: Graph calls that must carry the right verb and token,
// and the chat routing that keeps them behind the owner and behind a yes.
const assert = require('node:assert');
process.env.META_PAGE_TOKEN = 'test-token';

const calls = [];
global.fetch = async (url, init) => {
  const u = String(url);
  calls.push({ url: u, method: (init && init.method) || 'GET', body: init && init.body ? String(init.body) : '' });
  if (u.includes('/posts?')) {
    return { ok: true, json: async () => ({ data: [{ id: '108861_777', message: 'Old caption here', created_time: '2026-11-10T06:04:00+0000', permalink_url: 'https://fb/p/777' }] }) };
  }
  if ((init && init.method) === 'DELETE') return { ok: true, json: async () => ({ success: true }) };
  return { ok: true, json: async () => ({ id: '108861_777' }) };
};

const social = require('./lib/social');
social.setToken('test-token');

let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) pass++; else { fail++; console.log('FAIL:', n, x === undefined ? '' : String(x).slice(0, 200)); } };

(async () => {
  // ---- reading the latest post
  calls.length = 0;
  const last = await social.lastPagePost('108861494336428');
  ok('the latest post is read with GET', calls[0].method === 'GET' && calls[0].url.includes('/posts'), calls[0] && calls[0].method);
  ok('the latest post carries its caption and link', last.message === 'Old caption here' && last.url === 'https://fb/p/777');

  // ---- editing
  calls.length = 0;
  const edited = await social.editPostMessage('108861_777', 'A corrected caption');
  ok('editing posts to the post id, not the page', calls[0].url.endsWith('/108861_777') && calls[0].method === 'POST', calls[0].url);
  ok('the new caption is in the body', /message=A\+corrected\+caption/.test(calls[0].body), calls[0].body);
  ok('the edit reports the same post id', edited.id === '108861_777');

  const empty = await social.editPostMessage('108861_777', '   ').then(() => null, (e) => e.message);
  ok('an empty caption is refused', /cannot be empty/.test(String(empty)), empty);

  const long = await social.editPostMessage('108861_777', 'x'.repeat(5001)).then(() => null, (e) => e.message);
  ok('a 5001-character caption is refused', /5000/.test(String(long)), long);

  // ---- deleting
  calls.length = 0;
  const gone = await social.deletePost('108861_777');
  ok('deleting uses DELETE on the post', calls[0].method === 'DELETE' && calls[0].url.includes('/108861_777'), calls[0].method);
  ok('the delete reports success', gone.ok === true);

  // ---- chat routing, with the Page stubbed out
  const seen = [];
  const commands = require('./lib/commands').create({
    ilm: async () => '{}',
    postAction: async (verb, arg) => { seen.push([verb, arg]); return 'STAGED ' + verb; }
  });
  const owner = { canManage: true };
  const stranger = { canManage: false };

  const cases = [
    ['last post', 'STAGED last'],
    ['fix caption A better line', 'STAGED edit'],
    ['change the caption to Another line', 'STAGED edit'],
    ['delete the last post', 'STAGED delete'],
    ['/lastpost', 'STAGED last'],
    ['/fixcaption hello', 'STAGED edit'],
    ['/deletepost', 'STAGED delete']
  ];
  for (const [text, want] of cases) {
    ok('"' + text + '" routes to ' + want, (await commands.handle(text, owner)) === want);
  }
  ok('the new caption reaches the action', seen.some((s) => s[1] && s[1].message === 'A better line'), JSON.stringify(seen.map((s) => s[1])));

  // yes / no are only forwarded when something is waiting
  const yesHandled = await commands.handle('yes', owner);
  ok('a bare yes is forwarded', yesHandled === 'STAGED yes', yesHandled);
  const nothingWaiting = require('./lib/commands').create({
    ilm: async () => '{}',
    postAction: async () => 'Nothing is waiting for a yes.'
  });
  const quiet = await nothingWaiting.handle('yes', owner);
  ok('a yes with nothing staged stays silent', quiet === null, JSON.stringify(quiet));

  // a stranger gets nothing, and cannot even see the last post
  const s1 = await commands.handle('fix caption hacked', stranger);
  ok('a stranger cannot edit', /owner/.test(String(s1)), s1);
  const s2 = await commands.handle('delete the last post', stranger);
  ok('a stranger cannot delete', /owner/.test(String(s2)), s2);
  const s3 = await commands.handle('yes', stranger);
  ok('a stranger cannot confirm', s3 === null, JSON.stringify(s3));

  // an ordinary sentence starting with yes must not be treated as a confirmation
  const s4 = await commands.handle('yes I will look at it later', owner);
  ok('an ordinary "yes ..." sentence is left alone', s4 === null, JSON.stringify(s4));

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.log('ERROR', e); process.exit(1); });
