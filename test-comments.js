// Reading and answering comments: the Page token on the edge, the two refusals that matter,
// and the chat routing that keeps a reply behind a numbered list and a yes.
const assert = require('node:assert');
const calls = [];
global.fetch = async (url, init) => {
  const u = String(url);
  calls.push({ url: u, method: (init && init.method) || 'GET', body: init && init.body ? String(init.body) : '' });
  if (u.includes('/comments?') && ((init && init.method) || 'GET') === 'GET') {
    return { ok: true, json: async () => ({ data: [
      { id: 'c1', message: 'MashaAllah', from: { id: 'u1', name: 'Amina' }, created_time: '2026-11-10T08:00:00+0000', permalink_url: 'https://fb/c1', like_count: 2 },
      { id: 'c2', message: 'JazakAllahu khayran', created_time: '2026-11-10T07:00:00+0000' }
    ] }) };
  }
  if ((init && init.method) === 'DELETE') return { ok: true, json: async () => ({ success: true }) };
  return { ok: true, json: async () => ({ id: 'new' }) };
};
const social = require('./lib/social');
social.setToken('page-token');

let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) pass++; else { fail++; console.log('FAIL:', n, x === undefined ? '' : String(x).slice(0, 200)); } };

(async () => {
  calls.length = 0;
  const list = await social.listComments('108861_777', 'ptoken', 10);
  ok('comments are read with GET on the post', calls[0].method === 'GET' && calls[0].url.includes('/108861_777/comments'), calls[0].url);
  ok('the caller\'s token is the one used', calls[0].url.includes('access_token=ptoken'), calls[0].url.slice(0, 120));
  ok('the author is kept', list[0].author === 'Amina');
  ok('a comment without a from block still reads', list[1].author === 'someone');
  ok('the like count survives', list[0].likeCount === 2);

  calls.length = 0;
  const rep = await social.replyToComment('c1', 'Wa iyyakum', 'ptoken');
  ok('a reply posts to the comment id', calls[0].method === 'POST' && calls[0].url.endsWith('/c1/comments'), calls[0].url);
  ok('the reply text is in the body', /message=Wa\+iyyakum/.test(calls[0].body), calls[0].body);
  ok('the reply reports its own id', rep.commentId === 'c1');

  const emptyReply = await social.replyToComment('c1', '  ', 'ptoken').then(() => null, (e) => e.message);
  ok('an empty reply is refused', /needs words/.test(String(emptyReply)), emptyReply);

  calls.length = 0;
  const del = await social.deleteComment('c1', 'ptoken');
  ok('deleting a comment uses DELETE', calls[0].method === 'DELETE' && calls[0].url.includes('/c1'), calls[0].method);
  ok('the delete reports success', del.ok === true);

  // routing
  const seen = [];
  const commands = require('./lib/commands').create({
    ilm: async () => '{}',
    comments: async () => 'COMMENTS',
    commentAction: async (verb, arg) => { seen.push([verb, arg]); return 'STAGED ' + verb; }
  });
  const owner = { canManage: true };
  for (const t of ['comments', 'replies', 'inbox', '/comments']) {
    ok('"' + t + '" lists comments', (await commands.handle(t, owner)) === 'COMMENTS');
  }
  ok('"reply 2 ..." stages a reply', (await commands.handle('reply 2 JazakAllahu khayran', owner)) === 'STAGED reply');
  ok('the number and words reach the action',
    seen.some((s) => s[0] === 'reply' && s[1].n === 2 && s[1].message === 'JazakAllahu khayran'), JSON.stringify(seen));
  ok('"reply to comment 3 ..." also stages', (await commands.handle('reply to comment 3 Thanks', owner)) === 'STAGED reply');
  ok('"hide 1" stages a hide', (await commands.handle('hide 1', owner)) === 'STAGED hide');
  ok('"delete comment 2" stages a hide', (await commands.handle('delete comment 2', owner)) === 'STAGED hide');

  const stranger = { canManage: false };
  ok('a stranger cannot list comments', (await commands.handle('comments', stranger)) === null);
  ok('a stranger cannot reply', /owner/.test(String(await commands.handle('reply 1 hello', stranger))));
  ok('a stranger cannot hide a comment', /owner/.test(String(await commands.handle('hide 1', stranger))));
  ok('"reply" with no number is not a command', (await commands.handle('reply without number', owner)) === null);

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.log('ERROR', e); process.exit(1); });
