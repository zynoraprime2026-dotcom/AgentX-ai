// The watchdog: a missing or misrouted slot wakes the owner, once per problem per day, and a
// warning is not a wake-up.
const assert = require('node:assert');
const w = require('./lib/watchdog');

let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) pass++; else { fail++; console.log('FAIL:', n, x === undefined ? '' : String(x).slice(0, 240)); } };

const missing = { slot: 'morning', level: 'missing', page: 'The salafi Da\u2019wah', detail: 'no morning post today' };
const wrong = { slot: 'evening', level: 'wrong_page', page: 'Hikmah Hub', postedOn: 'Zynora Prime', detail: 'the evening post went to Zynora Prime instead of Hikmah Hub' };
const unknown = { slot: 'evening', level: 'unknown_page', page: 'Hikmah Hub', detail: 'the evening post did not record which Page it used' };

// 1. planning
let p = w.plan([missing], null, '', '2026-11-10');
ok('a missing slot is worth an alert', p.worthy.length === 1 && p.fresh.length === 1);
ok('the key names slot and level', p.keys[0] === 'morning:missing', JSON.stringify(p.keys));
ok('the state is dated', p.next.date === '2026-11-10');

p = w.plan([unknown], null, '', '2026-11-10');
ok('an unrecorded Page is not a wake-up', p.worthy.length === 0, JSON.stringify(p.worthy));
ok('so nothing is alerted for it', p.fresh.length === 0);

p = w.plan([missing, wrong], null, 'morning', '2026-11-10');
ok('a scoped check looks at one slot only', p.worthy.length === 1 && p.worthy[0].slot === 'morning');

// 2. once a day
const state = { date: '2026-11-10', slots: { 'morning:missing': '2026-11-10T07:10:00Z' } };
p = w.plan([missing], state, '', '2026-11-10');
ok('the same problem is not repeated the same day', p.fresh.length === 0);
ok('it is still reported as a finding', p.worthy.length === 1);

p = w.plan([missing, wrong], state, '', '2026-11-10');
ok('a different problem still alerts', p.fresh.length === 1 && p.keys[0] === 'evening:wrong_page', JSON.stringify(p.keys));

p = w.plan([missing], state, '', '2026-11-11');
ok('a new day forgets yesterday', p.fresh.length === 1);

// 3. running it
(async () => {
  const sent = [];
  let stored = null;
  const quiet = { date: '2026-11-10', ok: false, findings: [] };
  let out = await w.run({
    audit: async () => quiet,
    readState: async () => null,
    writeState: async (k, v) => { stored = v; },
    alert: async (t) => { sent.push(t); return ['whatsapp']; },
    describe: (f) => f.map((x) => x.detail).join('\n')
  });
  ok('a clean day sends nothing', sent.length === 0 && out.ok === true);

  out = await w.run({
    audit: async () => ({ date: '2026-11-10', ok: false, findings: [missing, wrong] }),
    readState: async () => null,
    writeState: async (k, v) => { stored = v; },
    alert: async (t) => { sent.push(t); return ['whatsapp']; },
    describe: (f) => f.map((x) => x.detail).join('\n')
  });
  ok('a bad day sends one message', sent.length === 1, JSON.stringify(sent));
  ok('the message names both problems', /no morning post today/.test(sent[0]) && /Zynora Prime instead of Hikmah Hub/.test(sent[0]), sent[0]);
  ok('the message is labelled', /watchdog/i.test(sent[0]));
  ok('the alert is recorded', stored && /morning:missing/.test(stored) && /evening:wrong_page/.test(stored), stored);
  ok('the result lists what was sent', out.alerted.length === 2 && out.alertSent === true);

  // second run same day: silent, because the store now holds the keys
  sent.length = 0;
  let state2 = stored;
  out = await w.run({
    audit: async () => ({ date: '2026-11-10', ok: false, findings: [missing, wrong] }),
    readState: async () => state2,
    writeState: async (k, v) => { state2 = v; },
    alert: async (t) => { sent.push(t); return ['whatsapp']; }
  });
  ok('the same day does not alert twice', sent.length === 0 && out.alerted.length === 0);

  // a broken store must not swallow the alert
  sent.length = 0;
  out = await w.run({
    audit: async () => ({ date: '2026-11-12', ok: false, findings: [missing] }),
    readState: async () => { throw new Error('db down'); },
    writeState: async () => { throw new Error('db down'); },
    alert: async (t) => { sent.push(t); return ['whatsapp']; }
  });
  ok('a store failure still sends the alert', sent.length === 1 && out.alertSent === true);

  // a failing alert sender is reported, not thrown
  out = await w.run({
    audit: async () => ({ date: '2026-11-12', ok: false, findings: [missing] }),
    readState: async () => null,
    writeState: async () => {},
    alert: async () => { throw new Error('whatsapp down'); }
  });
  ok('a failed alert does not crash the run', out.ok === false && out.alertSent === false);

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})();
