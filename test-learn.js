// The weekly review: what the numbers support, what they do not, and that a quiet week cannot
// quietly undo the last one.
const learn = require('./lib/learn');

let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) pass++; else { fail++; console.log('FAIL:', n, x === undefined ? '' : String(x).slice(0, 260)); } };

const PLAN = [
  { s: 1, a: 1 }, { s: 2, a: 2 }, { s: 3, a: 3 }, { s: 4, a: 4 }, { s: 5, a: 5 }
];

// ---- scoring and parsing
ok('likes count once, comments twice, shares three times', learn.scorePost({ likes: 1, comments: 1, shares: 1 }) === 6);
ok('an empty post scores zero', learn.scorePost({}) === 0);
ok('the ayah ref is read from the caption', learn.parseRef('Surah 24 \u2014 ayah 35\n\nLight is...') === '24:35', learn.parseRef('Surah 24 \u2014 ayah 35'));
ok('a caption without a ref is not guessed', learn.parseRef('just words') === null);

// ---- tally
const posts = [
  { ref: '1:1', likes: 10, comments: 0, shares: 0 },
  { ref: '1:1', likes: 6, comments: 1, shares: 0 },
  { ref: '2:2', likes: 2, comments: 0, shares: 0 },
  { ref: '3:3', likes: 4, comments: 0, shares: 0 },
  { message: 'Surah 4 \u2014 ayah 4', likes: 5 },
  { message: 'no ref here', likes: 99 }
];
const t = learn.tally(posts);
ok('posts without a ref are ignored', t.refs === 4, JSON.stringify(t.rows.map((r) => r.ref)));
ok('the average is per post, not the sum', t.rows[0].ref === '1:1' && t.rows[0].avg === 9, JSON.stringify(t.rows[0]));
ok('the best is the top average', t.best.ref === '1:1');
ok('the weakest is the bottom average', t.worst.ref === '2:2', JSON.stringify(t.worst));

// ---- weights
const w = learn.weights(PLAN, t);
ok('a verse with no data sits at 1', w[4] === 1, w[4]);
ok('the strong verse is pushed up', w[0] > 1, w[0]);
ok('the weak verse is held back', w[1] < 1, w[1]);
ok('weights stay inside their bounds', w.every((n) => n >= learn.MIN_WEIGHT && n <= learn.MAX_WEIGHT), JSON.stringify(w));
ok('no data at all means no opinion', learn.weights(PLAN, { rows: [], mean: 0 }).every((n) => n === 1));

// ---- pick: bounded, deterministic, never far from the cursor
ok('window 1 keeps the cursor where it is', learn.pick(2, [1, 1, 1, 1, 10], 1) === 2);
ok('a better verse just ahead is taken', learn.pick(0, [1, 1.1, 1.6, 1, 1], 3) === 2, learn.pick(0, [1, 1.1, 1.6, 1, 1], 3));
ok('it never looks past the window', learn.pick(0, [1, 1, 1, 1, 9], 3) === 0, learn.pick(0, [1, 1, 1, 1, 9], 3));
ok('a tie keeps the cursor where it is', learn.pick(1, [1, 1, 1, 1, 1], 3) === 1);
ok('a weight inside the window is taken', learn.pick(2, [1, 1, 1, 1.5, 1], 3) === 3, learn.pick(2, [1, 1, 1, 1.5, 1], 3));
ok('the window wraps past the end of the plan', learn.pick(4, [1.5, 1, 1, 1, 1], 3) === 0, learn.pick(4, [1.5, 1, 1, 1, 1], 3));

// ---- the review itself
const r = learn.review({ posts, plan: PLAN, now: '2026-11-10T06:00:00Z' });
ok('the review counts what it scored (five posts, four verses)', r.observed === 5 && r.refs === 4, r.observed + '/' + r.refs);
ok('it names the winner', r.best.ref === '1:1');
ok('it lists what it pushes forward', r.raised.includes('1:1'), JSON.stringify(r.raised));
ok('it lists what it holds back', r.lowered.includes('2:2'), JSON.stringify(r.lowered));
ok('the weights line up with the plan', r.weights.length === PLAN.length);
const text = learn.summarise(r, ['The salafi Da\u2019wah: 4 scored']);
ok('the summary names the winner and the count', /1:1/.test(text) && /5 posts scored/.test(text), text);
ok('the summary refuses to claim it moved the posting times', /Times are unchanged/.test(text), text);
ok('an empty week says so plainly', /Not enough engagement data/.test(learn.summarise({ observed: 0 })));

// ---- stored weights are only trusted when they fit the plan
ok('no stored weights means no learning yet', learn.weightsFrom('') === null && learn.weightsFrom(null) === null);
ok('garbage stored weights are ignored', learn.weightsFrom('{not json') === null && learn.weightsFrom(JSON.stringify({ weights: [0, 1] })) === null);
ok('a real stored list is read back', (learn.weightsFrom(JSON.stringify({ at: 'x', weights: [1.2, 0.8] })) || {}).weights.length === 2);

// ---- integration: the rotation follows the weights, and only when they fit
const store = {};
const dbs = require.resolve(process.cwd() + '/db');
require.cache[dbs] = { id: dbs, filename: dbs, loaded: true, exports: {
  getSocial: async (k) => (store[k] === undefined ? '' : JSON.stringify(store[k])),
  putSocial: async (k, v) => { store[k] = JSON.parse(v); }
}};
const daily = require('./lib/daily');

(async () => {
  store.daily_cursor = { n: 3, date: '2026-11-09', ref: 'x' };
  let idx = await daily.nextIndex(new Date('2026-11-10T06:00:00Z'));
  ok('without learning the cursor is followed exactly', idx === 3, idx);

  const voiced = daily.PLAN.map((e) => ({ s: e.s, a: e.a }));
  const pushed = Array.from({ length: daily.PLAN.length }, () => 1);
  const target = (3 + 2) % daily.PLAN.length;
  pushed[target] = 1.6;
  store.learn_weights = { at: '2026-11-10', weights: pushed, observed: 5 };
  idx = await daily.nextIndex(new Date('2026-11-10T06:00:00Z'));
  ok('a learned verse two ahead is chosen', idx === target, idx + ' vs ' + target);

  // a stored list of the wrong length is refused rather than applied to the wrong verses
  store.learn_weights = { at: 'x', weights: [1.5, 1.5] };
  idx = await daily.nextIndex(new Date('2026-11-10T06:00:00Z'));
  ok('weights that do not fit the plan are ignored', idx === 3, idx);

  // and a broken store never stops a post
  delete store.learn_weights;
  const realGet = require.cache[dbs].exports.getSocial;
  require.cache[dbs].exports.getSocial = async () => { throw new Error('db down'); };
  idx = await daily.nextIndex(new Date('2026-11-10T06:00:00Z'));
  ok('a failing store still yields a verse in range', Number.isInteger(idx) && idx >= 0 && idx < daily.PLAN.length, idx);
  require.cache[dbs].exports.getSocial = realGet;

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})();

// ---- significance: a thin week reports but does not steer
const thin = learn.review({ posts: [{ ref: '1:1', likes: 1 }], plan: PLAN, now: '2026-11-10T06:00:00Z' });
const thinSig = learn.significance(thin);
ok('one like is not evidence', thinSig.enough === false && /only 1 scored posts/.test(thinSig.reason), JSON.stringify(thinSig));
const fat = learn.review({ posts: Array.from({ length: 14 }, () => ({ ref: '1:1', likes: 30, comments: 4 })), plan: PLAN });
const fatSig = learn.significance(fat);
ok('fourteen posts with real engagement is evidence', fatSig.enough === true, JSON.stringify(fatSig));
const flat = learn.review({ posts: Array.from({ length: 20 }, () => ({ ref: '2:2', likes: 0 })), plan: PLAN });
ok('volume with no engagement is still not evidence', learn.significance(flat).enough === false && /too flat/.test(learn.significance(flat).reason));
