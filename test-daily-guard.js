const store = {};
const dbs = require.resolve(process.cwd() + '/db');
require.cache[dbs] = { id: dbs, filename: dbs, loaded: true, exports: {
  getSocial: async (k) => (store[k] === undefined ? '' : JSON.stringify(store[k])),
  putSocial: async (k, v) => { store[k] = JSON.parse(v); }
}};
const daily = require(process.cwd() + '/lib/daily');
let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) pass++; else { fail++; console.log('FAIL:', n, x === undefined ? '' : x); } };
const pagePosts = [];       // what the fake Page carries
const published = [];

function deps(extra) {
  return Object.assign({
    date: new Date(Date.UTC(2026, 11, 5)), page: { id: 'p' },
    studio: async () => ({ url: 'https://cdn/p.jpg' }),
    social: {
      recentPosts: async () => ({ page: { id: 'p', name: 'P' }, posts: pagePosts.slice(0, 10) }),
      postImage: async ({ message }) => { published.push(message); pagePosts.unshift({ message, created_time: 'now' }); return { id: 'fb', url: 'u' }; }
    },
    instagram: { publish: async ({ caption }) => { published.push(caption); return { id: 'ig', permalink: 'p' }; } },
    ilm: async () => { throw new Error('offline'); }
  }, extra || {});
}

(async () => {
  // 1. preview lists eight upcoming posts without publishing or moving the cursor
  const D = new Date(Date.UTC(2026, 11, 5));
  const rows = await daily.upcoming(8, D);
  ok('preview returns eight', rows.length === 8, rows.length);
  ok('preview alternates the slots', rows.map((r) => r.slot[0]).join('') === 'memememe', rows.map((r) => r.slot[0]).join(''));
  ok('preview moves in order', rows.every((r, i) => r.index === (rows[0].index + i) % daily.PLAN.length));
  ok('preview writes nothing', published.length === 0 && !store.daily_cursor);

  // 2. a normal run publishes and takes the first previewed verse
  const first = await daily.run(deps());
  ok('first post matches the preview', first.ref === rows[0].ref, first.ref + ' vs ' + rows[0].ref);
  ok('no guard trip on a clean page', !first.guard, first.guard);

  // 3. simulate a lost claim record: the Page already carries this caption
  const next = await daily.upcoming(1, D);
  const nextRef = next[0].ref;
  const planned = await daily.build({ date: D, index: next[0].index, slot: 'evening' });
  pagePosts.unshift({ message: planned.caption, created_time: 'earlier-today' });
  const guarded = await daily.run(deps({ force: true }));
  ok('guard sees the copy already on the Page', !!guarded.guard, guarded.guard);
  ok('guard moved past it', guarded.ref !== nextRef, guarded.ref);
  ok('guard still published something', guarded.ok === true);

  // 4. preview advances after publishing
  const after = await daily.upcoming(1, D);
  ok('preview follows the cursor', after[0].ref !== nextRef, after[0].ref);

  // 5. guard can be switched off, and a failing guard never blocks a post
  const off = await daily.run(deps({ guard: false, force: true }));
  ok('guard off still posts', off.ok === true && !off.guard);
  const broken = await daily.run(deps({ force: true, social: {
    recentPosts: async () => { throw new Error('facebook 190: bad token'); },
    postImage: async ({ message }) => { published.push(message); return { id: 'fb', url: 'u' }; }
  }}));
  ok('a failing guard is reported, not fatal', !!broken.guardError && broken.ok === true, broken.guardError);

  // 6. the caption comparison ignores whitespace
  ok('normalise flattens whitespace', daily.normaliseCaption(' a\n\nb  c ') === 'a b c', daily.normaliseCaption(' a\n\nb  c '));

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.log('ERROR', e); process.exit(1); });
