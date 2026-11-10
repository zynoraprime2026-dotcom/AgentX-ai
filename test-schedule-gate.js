// Changing which Page a slot posts to is a staged action: it waits for a yes, and the
// promo slot has no cron of its own, so it must be refused there.
const src = require('fs').readFileSync(__dirname + '/server.js', 'utf8');
let pass = 0, fail = 0;
const ok = (n, c) => { if (c) pass++; else { fail++; console.log('FAIL:', n); } };

ok('both tools are offered to the model', /name: 'schedule_view'/.test(src) && /name: 'schedule_stage'/.test(src));
ok('the view is dispatchable', /case 'schedule_view'/.test(src));
ok('the stage is dispatchable', /case 'schedule_stage'/.test(src));
ok('staging validates the Page before saving anything', /await social\.resolvePage\(String\(args\.page/.test(src));
ok('a bad slot is refused', /\['morning', 'evening'\]\.includes\(slot\)/.test(src));
ok('staging writes nothing to the schedule', !/case 'schedule_stage'[\s\S]{0,1600}putSocial\('daily_schedule'/.test(src));
ok('the yes branch saves it', /settings\.kind === 'schedule'[\s\S]{0,600}putSocial\('daily_schedule'/.test(src));
ok('a no on a schedule change is harmless', /Left the ' \+ settings\.slot \+ ' run on ' \+ settings\.before\.page/.test(src));
ok('profile changes keep their own kind', /kind: 'profile'/.test(src));
ok('an empty Instagram handle means Facebook only', /\(Facebook only\)/.test(src));

// the merge must not lose the other slot
const current = { morning: { page: "The salafi Da'wah", ig: 'the_salafi_dawah' } };
const next = { ...current, evening: { page: 'Hikmah Hub', ig: 'thesalafidawah' } };
ok('saving one slot keeps the other', next.morning.page === "The salafi Da'wah" && next.evening.page === 'Hikmah Hub');
console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
