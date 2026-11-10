// The daily audit: missing posts, posts on the wrong Page, and the same when nothing is
// due yet.
const audit = require('./lib/audit');
let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) pass++; else { fail++; console.log('FAIL:', n, x === undefined ? '' : String(x).slice(0, 200)); } };

const schedule = { morning: { page: "The salafi Da'wah" }, evening: { page: 'Hikmah Hub' } };
const run = (now, claims) => audit.auditSlots({ now, dateKey: now.slice(0, 10), schedule, claims });

// ---- the incident this was written for
let r = run('2026-11-10T12:00:00Z', {
  morning: { date: '2026-11-10', page: 'Hikmah Hub', ref: '2:216' },
  evening: { date: '2026-11-09', page: 'Hikmah Hub', ref: '40:60' }
});
ok('a post on the wrong Page is caught', r.findings.some((f) => f.level === 'wrong_page' && f.slot === 'morning'), JSON.stringify(r.findings));
ok('the finding names both Pages', /Hikmah Hub/.test(audit.describe(r.findings)) && /salafi/.test(audit.describe(r.findings)), audit.describe(r.findings));
ok('a wrong Page is not "ok"', r.ok === false);

// ---- a clean day
r = run('2026-11-10T12:00:00Z', {
  morning: { date: '2026-11-10', page: "The salafi Da'wah", ref: '3:200' },
  evening: { date: '2026-11-09', page: 'Hikmah Hub', ref: '40:60' },
  hadith: { date: '2026-11-10', page: 'Hikmah Hub', ref: 'tirmidhi:2518', slot: 'evening' }
});
ok('a clean morning is clean', r.ok === true && r.findings.length === 0, JSON.stringify(r.findings));

// ---- nothing due yet
r = run('2026-11-10T03:00:00Z', { morning: null, evening: { date: '2026-11-09', page: 'Hikmah Hub' } });
ok('nothing is missing before the slot is due', r.findings.length === 0, JSON.stringify(r.findings));

// ---- overdue and absent
r = run('2026-11-10T07:30:00Z', { morning: null, evening: { date: '2026-11-09', page: 'Hikmah Hub' } });
ok('a missing morning is reported after the grace period', r.findings.some((f) => f.slot === 'morning' && f.level === 'missing'), JSON.stringify(r.findings));
ok('a missing post is described as such', /no morning post today/.test(audit.describe(r.findings)), audit.describe(r.findings));

// ---- grace period boundary
const justDue = run('2026-11-10T06:30:00Z', { morning: null, evening: null });
ok('inside the 45-minute grace it is quiet', !justDue.findings.some((f) => f.slot === 'morning'), JSON.stringify(justDue.findings));
const pastGrace = run('2026-11-10T06:46:00Z', { morning: null, evening: null });
ok('past the grace it speaks', pastGrace.findings.some((f) => f.slot === 'morning'), JSON.stringify(pastGrace.findings));

// ---- an old claim appears as missing today, not as a stale success
r = run('2026-11-10T20:45:00Z', { morning: { date: '2026-11-09', page: "The salafi Da'wah" }, evening: null });
ok('yesterday claim does not count for today', r.findings.filter((f) => f.level === 'missing').length === 2, JSON.stringify(r.findings));

// ---- unrecorded Page is softer than wrong Page, and does not make the day fail
r = run('2026-11-10T12:00:00Z', { morning: { date: '2026-11-10', page: '', ref: '9:1' }, evening: null });
ok('an unrecorded Page is flagged', r.findings.some((f) => f.level === 'unknown_page'), JSON.stringify(r.findings));
ok('an unrecorded Page still counts as posted', r.ok === true, JSON.stringify(r.findings));

// ---- the hadith is checked against the slot it rode
r = run('2026-11-10T12:00:00Z', {
  morning: { date: '2026-11-10', page: "The salafi Da'wah" },
  evening: { date: '2026-11-09', page: 'Hikmah Hub' },
  hadith: { date: '2026-11-10', page: "The salafi Da'wah", slot: 'evening' }
});
ok('a hadith on the wrong Page is caught', r.findings.some((f) => f.slot === 'hadith' && f.level === 'wrong_page'), JSON.stringify(r.findings));

// ---- slot times are what the crons use
ok('morning is 06:00 UTC', audit.slotDueAt('morning', '2026-11-10').toISOString() === '2026-11-10T06:00:00.000Z');
ok('evening is 19:30 UTC', audit.slotDueAt('evening', '2026-11-10').toISOString() === '2026-11-10T19:30:00.000Z');

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
