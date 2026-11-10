// The heartbeat is the only evidence that a scheduled run happened, so it has to survive
// a round trip through the text column it is stored in.
let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) pass++; else { fail++; console.log('FAIL:', n, String(x).slice(0, 200)); } };
const src = require('fs').readFileSync(__dirname + '/server.js', 'utf8');

ok('the reader parses what is stored', /const d = typeof raw === 'string' \? JSON\.parse\(raw \|\| '\{\}'\)/.test(src));
ok('the writer stores JSON text', /db\.putSocial\('cron_hits', JSON\.stringify\(\{ hits: hits\.slice\(0, 60\) \}\)\)/.test(src));
ok('the writer reads through the same parser', /const hits = await cronHits\(\);/.test(src));
ok('the diagnostic uses it too', /out\.cronHits = await cronHits\(\)/.test(src));
ok('a corrupt record cannot break a run', /catch \(e\) \{ return \[\]; \}/.test(src));

// the real round trip, with the store standing in for the text column
const store = {};
const db = {
  getSocial: async (k) => (k in store ? store[k] : ''),
  putSocial: async (k, v) => { store[k] = v; }
};
async function cronHits() {
  try {
    const raw = await db.getSocial('cron_hits');
    const d = typeof raw === 'string' ? JSON.parse(raw || '{}') : (raw || {});
    return Array.isArray(d.hits) ? d.hits.filter((h) => h && h.at) : [];
  } catch (e) { return []; }
}
async function noteCron(entry) {
  try {
    const hits = await cronHits();
    hits.unshift({ at: new Date().toISOString(), entry: String(entry).slice(0, 40) });
    await db.putSocial('cron_hits', JSON.stringify({ hits: hits.slice(0, 60) }));
  } catch (e) {}
}
(async () => {
  await noteCron('daily-post:morning');
  await noteCron('fajr');
  const hits = await cronHits();
  ok('two stamps are kept, newest first', hits.length === 2 && hits[0].entry === 'fajr' && hits[1].entry === 'daily-post:morning', JSON.stringify(hits));
  for (let i = 0; i < 70; i++) await noteCron('n' + i);
  const capped = await cronHits();
  ok('the log stays capped at 60', capped.length === 60, capped.length);
  store.cron_hits = 'not json at all';
  ok('a corrupt record reads as empty instead of throwing', (await cronHits()).length === 0);
  store.cron_hits = '';
  ok('a missing record reads as empty', (await cronHits()).length === 0);
  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})();
