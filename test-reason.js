// The reasoning layer: every decision names the rule and the facts behind it, and nothing fires
// on facts that are not there.
const reason = require('./lib/reason');

let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) pass++; else { fail++; console.log('FAIL:', n, x === undefined ? '' : String(x).slice(0, 260)); } };

const base = {
  now: '2026-11-10T21:00:00Z',
  dateKey: '2026-11-10',
  schedule: { morning: { page: 'The salafi Da\u2019wah' }, evening: { page: 'Hikmah Hub' }, promo: { page: 'Zynora Prime' } },
  claims: {
    morning: { date: '2026-11-10', page: 'The salafi Da\u2019wah', ref: '3:200' },
    evening: { date: '2026-11-10', page: 'Hikmah Hub', ref: '40:60' },
    promo: { date: '2026-11-10', page: 'Zynora Prime', ref: '40:60' }
  },
  due: { morning: '2026-11-10T06:45:00Z', evening: '2026-11-10T20:15:00Z', promo: '2026-11-10T20:30:00Z' },
  token: { valid: true, daysLeft: 58 },
  engagement: { observed: 40, mean: 3.2 }
};

const quiet = reason.decide(base);
ok('a healthy day produces no decisions', quiet.decisions.length === 0, JSON.stringify(quiet.decisions));
ok('and it says so plainly', /Nothing needs a decision/.test(reason.explain(quiet)), reason.explain(quiet));

// ---- a missing slot
let r = reason.decide({ ...base, claims: { ...base.claims, evening: { date: '2026-11-09', page: 'Hikmah Hub' } } });
ok('a missing evening is noticed', r.decisions.some((d) => d.rule === 'slot-missing' && /evening/.test(d.action)), JSON.stringify(r.decisions));
ok('the missing slot names its remedy', r.decisions[0].how === 'GET /api/cron/daily-post?slot=evening', r.decisions[0].how);
ok('and it explains itself', /no post for it today/.test(r.decisions[0].why), r.decisions[0].why);

// ---- a post on the wrong Page outranks the missing one
r = reason.decide({ ...base, claims: { ...base.claims, morning: { date: '2026-11-10', page: 'Zynora Prime' } } });
ok('a misrouted post is a decision', r.decisions.some((d) => d.rule === 'wrong-page'));
ok('it is the first thing to fix', r.decisions[0].rule === 'wrong-page', JSON.stringify(r.decisions.map((d) => d.rule)));
ok('it names both Pages', /Zynora Prime instead of The salafi Da\u2019wah/.test(r.decisions[0].why), r.decisions[0].why);

// ---- token
r = reason.decide({ ...base, token: { valid: true, daysLeft: 9 } });
ok('a token near expiry is a decision', r.decisions.some((d) => d.rule === 'token-expiring'));
r = reason.decide({ ...base, token: { valid: true, daysLeft: 58 } });
ok('a healthy token is not', !r.decisions.some((d) => d.rule === 'token-expiring'));
r = reason.decide({ ...base, token: { valid: false, daysLeft: 0 } });
ok('a dead token is not a refresh, it is a repair', !r.decisions.some((d) => d.rule === 'token-expiring'), JSON.stringify(r.decisions.map((d) => d.rule)));

// ---- engagement
r = reason.decide({ ...base, engagement: { observed: 40, mean: 0.3 } });
ok('flat engagement on plenty of posts changes the content, not the time', r.decisions.some((d) => d.rule === 'engagement-flat' && /content, not the posting time/.test(d.action)), JSON.stringify(r.decisions));
r = reason.decide({ ...base, engagement: { observed: 7, mean: 0.1 } });
ok('a thin week is told to keep posting rather than tune', r.decisions.some((d) => d.rule === 'collect-evidence'), JSON.stringify(r.decisions));
ok('and it is not called flat', !r.decisions.some((d) => d.rule === 'engagement-flat'));

// ---- chaining: a fact derived elsewhere enables a rule here
r = reason.decide({ ...base, facts: { 'learning-ready': true } });
ok('a derived fact can enable a decision', r.decisions.some((d) => d.rule === 'apply-learning'), JSON.stringify(r.decisions.map((d) => d.rule)));
ok('the chain records what fired', r.fired.includes('apply-learning'), JSON.stringify(r.fired));

// ---- a broken rule can never take the scheduler down
const saved = reason.RULES.slice();
reason.RULES.push({ id: 'explodes', priority: 99, when: () => { throw new Error('boom'); }, decide: () => { throw new Error('boom'); } });
r = reason.decide(base);
ok('a throwing rule is skipped, not fatal', Array.isArray(r.decisions), JSON.stringify(r));
reason.RULES.length = 0; reason.RULES.push(...saved);

// ---- several problems at once, in a deliberate order
r = reason.decide({
  ...base,
  token: { valid: true, daysLeft: 5 },
  claims: { morning: { date: '2026-11-10', page: 'Hikmah Hub' }, evening: { date: '2026-11-09' } },
  engagement: { observed: 40, mean: 0.2 }
});
const order = r.decisions.map((d) => d.rule);
ok('four problems produce four decisions', r.decisions.length === 4, JSON.stringify(order));
ok('the misroute is first', order[0] === 'wrong-page', JSON.stringify(order));
ok('the token comes before the content advice', order.indexOf('token-expiring') < order.indexOf('engagement-flat'), JSON.stringify(order));
ok('every decision carries its reason', r.decisions.every((d) => d.why && d.rule), JSON.stringify(r.decisions));
ok('the explanation is numbered prose', /^1\. /.test(reason.explain(r)) && reason.explain(r).split('\n').length === 4, reason.explain(r));

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
