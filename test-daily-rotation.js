const store = {};
const dbs = require.resolve(process.cwd() + '/db');
require.cache[dbs] = { id: dbs, filename: dbs, loaded: true, exports: {
  getSocial: async (k) => (store[k] === undefined ? '' : JSON.stringify(store[k])),
  putSocial: async (k, v) => { store[k] = JSON.parse(v); }
}};
const daily = require(process.cwd() + '/lib/daily');
let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) pass++; else { fail++; console.log('FAIL:', n, x || ''); } };
const posts = [];
function deps(date, extra) {
  return Object.assign({
    date, page: { id: 'p' },
    studio: async () => ({ url: 'https://cdn.example/p.jpg' }),
    social: { postImage: async () => { posts.push(1); return { id: 'fb', url: 'u' }; } },
    instagram: { publish: async () => { posts.push(1); return { id: 'ig', permalink: 'p' }; } },
    ilm: async () => { throw new Error('offline'); }
  }, extra || {});
}
(async () => {
  const day0 = Date.UTC(2026, 11, 1);
  // ten days, two slotted runs a day: nothing may repeat
  const refs = [];
  for (let i = 0; i < 10; i++) {
    const d = new Date(day0 + i * 86400000);
    const m = await daily.run(deps(d, { slot: 'morning' }));
    const e = await daily.run(deps(d, { slot: 'evening' }));
    ok('morning published ' + i, m.ok && m.claimSaved, m.skipped);
    ok('evening published ' + i, e.ok && e.claimSaved, e.skipped);
    refs.push(m.ref, e.ref);
  }
  ok('twenty posts, twenty different verses', new Set(refs).size === refs.length,
     new Set(refs).size + ' unique of ' + refs.length);

  // a bare repeat run the same day must be refused (the duplicate bug)
  const before = posts.length;
  const lastDay = new Date(day0 + 9 * 86400000);
  const again = await daily.run(deps(lastDay, { slot: 'morning' }));
  ok('repeat run refused', !!again.skipped, again.ref);
  ok('nothing published on the refused run', posts.length === before);

  // an owner post on an already-posted day gets a fresh verse, not a repeat
  const forced = await daily.run(deps(lastDay, { slot: 'morning', force: true }));
  ok('owner post is a new verse', !refs.includes(forced.ref), forced.ref);
  ok('owner post published', forced.ok === true);

  // cursor advanced by one on every publish
  const seed = daily.dayIndex(new Date(day0));
  ok('cursor moved once per publish', store.daily_cursor.n === seed + 21, store.daily_cursor.n + ' vs ' + (seed + 21));
  // sixty verses means a full month before anything returns
  const seen = new Set(refs.concat([forced.ref]));
  ok('60-verse plan gives a month of unique posts', seen.size === 21 && daily.PLAN.length === 60, daily.PLAN.length);

  // ---------- a run that published nothing must not spend the slot ----------
  const brokenDeps = (over) => ({
    date: new Date(Date.UTC(2026, 11, 20)), page: { id: 'p' },
    studio: async () => ({ url: 'https://cdn/p.jpg' }),
    social: { recentPosts: async () => ({ page: { id: 'p' }, posts: [] }), postImage: async () => { throw new Error('facebook 190: token'); } },
    instagram: { publish: async () => { throw new Error('instagram down'); } },
    ilm: async () => { throw 1; },
    ...over
  });
  const failed = await daily.run(brokenDeps());
  ok('a failed run is not ok', failed.ok === false, JSON.stringify(failed.steps));
  ok('a failed run does not claim the day',
    !store['daily_last_' + failed.slot] || store['daily_last_' + failed.slot].date !== '2026-12-20',
    JSON.stringify(store['daily_last_' + failed.slot] || null));
  ok('a failed run says the slot stays open', String(failed.claimSkipped || '').includes('stays open'), failed.claimSkipped);
  const retry = await daily.run(brokenDeps({
    social: { recentPosts: async () => ({ page: { id: 'p' }, posts: [] }), postImage: async () => ({ id: 'f', url: 'https://fb/ok' }) },
    instagram: undefined
  }));
  ok('the retry is not told the slot was taken', !retry.skipped && retry.ok === true, retry.skipped || JSON.stringify(retry.steps));
  ok('the retry saves the claim', Boolean(store['daily_last_' + retry.slot]), JSON.stringify(Object.keys(store)));
  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.log('ERROR', e); process.exit(1); });
