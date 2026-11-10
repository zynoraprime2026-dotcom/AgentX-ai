// Learning, in the only sense this pipeline can honestly claim: the numbers Facebook already
// returns are read back and used to change what gets posted next, instead of being collected
// and admired.
//
// What it does not do: move the posting hours. Those live in vercel.json, and two fixed crons
// cannot be nudged by a trend line. A model that says "post at 18:00" while the scheduler stays
// at 19:30 would be a lie with a dashboard.
//
// So it learns the one thing the data can actually support: which verses earn attention on a
// Page of this size, and it biases the rotation toward them. Everything here is plain data in,
// plain data out, so the arithmetic can be checked without a database or a network.

const DEFAULT_WINDOW = 3;
// Below this there is no signal, only noise. Seven posts and one like is not evidence about a
// verse; acting on it would chase a coin flip and call it learning.
const MIN_POSTS = 12;
const MIN_MEAN = 0.5;
const MIN_WEIGHT = 0.6;
const MAX_WEIGHT = 1.6;

// Same weighting the insights endpoint uses, so a "best post" means the same thing everywhere.
function scorePost(p) {
  const likes = Number(p && p.likes) || 0;
  const comments = Number(p && p.comments) || 0;
  const shares = Number(p && p.shares) || 0;
  return likes + comments * 2 + shares * 3;
}

// 'Surah 24 — ayah 35' is how every caption in this pipeline names its verse.
function parseRef(message) {
  const m = /Surah\s*(\d+)\s*[—–-]\s*ayah\s*(\d+)/.exec(String(message || ''));
  return m ? m[1] + ':' + m[2] : null;
}

// posts: [{ref|message, likes, comments, shares, created}]
function tally(posts) {
  const byRef = {};
  for (const p of posts || []) {
    const ref = p && (p.ref || parseRef(p.message));
    if (!ref) continue;
    const s = scorePost(p);
    const row = byRef[ref] || (byRef[ref] = { ref, posts: 0, score: 0, best: 0, last: '' });
    row.posts += 1;
    row.score += s;
    row.best = Math.max(row.best, s);
    if (p.created && String(p.created) > row.last) row.last = String(p.created);
  }
  const rows = Object.keys(byRef).map((k) => {
    const r = byRef[k];
    return { ...r, avg: r.posts ? r.score / r.posts : 0 };
  }).sort((a, b) => b.avg - a.avg || b.best - a.best);
  const total = rows.reduce((n, r) => n + r.avg, 0);
  return {
    rows,
    refs: rows.length,
    mean: rows.length ? total / rows.length : 0,
    best: rows[0] || null,
    worst: rows.length > 1 ? rows[rows.length - 1] : null
  };
}

function clamp(n, lo, hi) { return Math.max(lo, Math.min(hi, n)); }

// A verse's weight is how far its average sits from the mean of the verses we have numbers for.
// Unobserved verses sit at 1, which is the honest value: no evidence, no opinion.
function weights(plan, t, opts) {
  const o = opts || {};
  const rows = (t && t.rows) || [];
  const mean = (t && t.mean) || 0;
  const list = (plan || []).map(() => 1);
  if (!rows.length || mean <= 0) return list;
  const byRef = {};
  for (const r of rows) byRef[r.ref] = r;
  (plan || []).forEach((entry, i) => {
    const ref = entry && (entry.ref || (entry.s && entry.a ? entry.s + ':' + entry.a : null));
    const r = ref ? byRef[ref] : null;
    if (!r) return;
    list[i] = clamp(Number((r.avg / mean).toFixed(3)), o.min || MIN_WEIGHT, o.max || MAX_WEIGHT);
  });
  return list;
}

// Among the next few verses the cursor would reach anyway, take the one with the most evidence
// behind it. Bounded on purpose: the rotation stays a rotation, no verse is skipped for long,
// and nothing repeats inside a day.
function pick(base, weightsList, window) {
  const n = (weightsList || []).length;
  if (!n) return base;
  const span = Math.max(1, Math.min(Number(window) || DEFAULT_WINDOW, n));
  const start = ((base % n) + n) % n;
  let bestAt = start;
  let bestW = Number(weightsList[start]) || 1;
  for (let i = 1; i < span; i++) {
    const at = (start + i) % n;
    const w = Number(weightsList[at]) || 1;
    if (w > bestW) { bestW = w; bestAt = at; }
  }
  return bestAt;
}

// Is there enough behind the numbers to change what gets posted? Deliberately conservative:
// the review reports every week, but only a week with real signal may move the rotation.
function significance(r, opts) {
  const o = opts || {};
  const minPosts = Number.isFinite(o.minPosts) ? o.minPosts : MIN_POSTS;
  const minMean = Number.isFinite(o.minMean) ? o.minMean : MIN_MEAN;
  const observed = (r && r.observed) || 0;
  const mean = (r && r.mean) || 0;
  if (observed < minPosts) {
    return { enough: false, reason: 'only ' + observed + ' scored posts so far (needs ' + minPosts + ')' };
  }
  if (mean < minMean) {
    return { enough: false, reason: 'average engagement is ' + mean.toFixed(1) + ' per post, too flat to rank verses' };
  }
  return { enough: true, reason: '' };
}

function summarise(review, pages) {
  if (!review || !review.observed) return 'Not enough engagement data yet to change the rotation.';
  const lines = [];
  lines.push('Week in review: ' + review.observed + ' posts scored across ' + review.refs + ' verses.');
  if (pages && pages.length) lines.push(pages.join(', '));
  if (review.best) lines.push('Best: ' + review.best.ref + ' (' + review.best.avg.toFixed(1) + ' avg, ' + review.best.posts + ' post' + (review.best.posts === 1 ? '' : 's') + ')');
  if (review.worst && review.worst.ref !== (review.best && review.best.ref)) lines.push('Weakest: ' + review.worst.ref + ' (' + review.worst.avg.toFixed(1) + ' avg)');
  if (review.raised.length) lines.push('Pushing forward: ' + review.raised.slice(0, 5).join(', '));
  if (review.lowered.length) lines.push('Holding back: ' + review.lowered.slice(0, 5).join(', '));
  lines.push('Times are unchanged: the posting hours live in the deployment, not in the trend.');
  return lines.join('\n');
}

// review(): pure. weightsFrom(): the stored weights, or nothing if there are none.
function review({ posts, plan, now, minPosts } = {}) {
  const t = tally(posts || []);
  const min = Number.isInteger(minPosts) ? minPosts : 1;
  const usable = { ...t, rows: t.rows.filter((r) => r.posts >= min) };
  usable.best = usable.rows[0] || null;
  usable.worst = usable.rows.length > 1 ? usable.rows[usable.rows.length - 1] : null;
  usable.mean = usable.rows.length ? usable.rows.reduce((n, r) => n + r.avg, 0) / usable.rows.length : 0;
  const w = weights(plan, usable);
  const raised = [];
  const lowered = [];
  (plan || []).forEach((entry, i) => {
    const ref = entry && (entry.s && entry.a ? entry.s + ':' + entry.a : null);
    if (!ref) return;
    if (w[i] > 1.01) raised.push(ref);
    else if (w[i] < 0.99) lowered.push(ref);
  });
  return {
    at: (now ? new Date(now) : new Date()).toISOString(),
    observed: usable.rows.reduce((n, r) => n + r.posts, 0),
    refs: usable.rows.length,
    mean: usable.mean,
    best: usable.best,
    worst: usable.worst,
    weights: w,
    raised: raised.sort((a, b) => w[parseRefIndex(plan, b)] - w[parseRefIndex(plan, a)]),
    lowered: lowered.sort((a, b) => w[parseRefIndex(plan, a)] - w[parseRefIndex(plan, b)])
  };
}

function parseRefIndex(plan, ref) {
  return (plan || []).findIndex((e) => e && e.s && e.a && e.s + ':' + e.a === ref);
}

// anything other than a real weight list is treated as "no learning yet"
function weightsFrom(raw) {
  let v = raw;
  if (typeof v === 'string') { try { v = JSON.parse(v); } catch (e) { return null; } }
  if (!v || !Array.isArray(v.weights) || !v.weights.length) return null;
  const list = v.weights.map((n) => Number(n));
  if (list.some((n) => !Number.isFinite(n) || n <= 0)) return null;
  return { weights: list, at: v.at || null };
}

module.exports = { scorePost, parseRef, tally, weights, pick, review, summarise, significance, weightsFrom, DEFAULT_WINDOW, MIN_WEIGHT, MAX_WEIGHT, MIN_POSTS, MIN_MEAN };
