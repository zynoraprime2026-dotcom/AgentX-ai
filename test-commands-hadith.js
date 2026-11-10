// The chat triggers around the daily posts: "post hadith" must never publish the ayah,
// "post" must never publish the hadith, and a stranger must get neither.
const commands = require('./lib/commands').create({
  ilm: async () => '{}',
  postDaily: async () => 'AYAH',
  postHadith: async () => 'HADITH',
  hadithPreview: async () => 'PREVIEW'
});

let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) pass++; else { fail++; console.log('FAIL:', n, x === undefined ? '' : String(x).slice(0, 160)); } };
const owner = { canManage: true };
const stranger = { canManage: false };

(async () => {
  const cases = [
    ['post hadith', 'HADITH', owner],
    ['publish the daily hadith', 'HADITH', owner],
    ['send hadith now', 'HADITH', owner],
    ['/hadithpost', 'HADITH', owner],
    ['post', 'AYAH', owner],
    ["post today's update", 'AYAH', owner],
    ['/post', 'AYAH', owner],
    ['hadith', 'PREVIEW', owner],
    ['hadith of the day', 'PREVIEW', owner],
    ['/hadithday', 'PREVIEW', owner]
  ];
  for (const [text, want, ctx] of cases) {
    const got = await commands.handle(text, ctx);
    ok('"' + text + '" -> ' + want, got === want, got);
  }
  const s1 = await commands.handle('post hadith', stranger);
  ok('a stranger cannot post the hadith', /owner/.test(String(s1)), s1);
  const s2 = await commands.handle('post', stranger);
  ok('a stranger cannot post the ayah', /owner/.test(String(s2)), s2);
  const s3 = await commands.handle('hadith', stranger);
  ok('a stranger gets no hadith preview', s3 === null, JSON.stringify(s3));

  // a search must still reach the search tool, not the daily triggers
  const s4 = await commands.handle('hadith patience', owner);
  ok('a hadith search is not swallowed by the daily triggers', s4 !== 'HADITH' && s4 !== 'PREVIEW', JSON.stringify(s4));

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.log('ERROR', e); process.exit(1); });
