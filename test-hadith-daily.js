// Tests for lib/hadith-daily.js: rotation, the claim, the fetch-or-refuse rule, and the
// caption. The database and ilm-api are stubbed.
const assert = require('node:assert');

const store = {};
const dbPath = require.resolve(process.cwd() + '/db');
require.cache[dbPath] = {
  id: dbPath, filename: dbPath, loaded: true,
  exports: {
    getSocial: async (k) => (store[k] === undefined ? '' : JSON.stringify(store[k])),
    putSocial: async (k, v) => { store[k] = JSON.parse(v); }
  }
};

const hadith = require('./lib/hadith-daily');
let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) pass++; else { fail++; console.log('FAIL:', n, x === undefined ? '' : String(x).slice(0, 220)); } };

const ilmStub = (over) => async (pathq) => {
  const m = /\/v1\/hadith\/([a-z]+)\/(\d+)/.exec(pathq);
  const c = m[1], n = m[2];
  if (over && over.fail) throw new Error('ilm-api 503');
  return {
    hadith: {
      collection: c, hadith_number: n,
      narrator: 'Abu Huraira',
      text_arabic: 'نَصٌّ عَرَبِيٌّ ' + n,
      text_english: 'English text for ' + n,
      grade: c === 'tirmidhi' ? 'Sahih' : null,
      book_name: 'Book'
    }
  };
};

const deps = (over) => ({
  ilm: ilmStub(over),
  studio: async () => ({ url: 'https://cdn/h.jpg' }),
  social: { postImage: async () => ({ id: 'f', url: 'https://fb/h' }) },
  instagram: { publish: async () => ({ id: 'i', permalink: 'https://ig/h' }) },
  page: 'The salafi Da\'wah',
  igAccount: 'the_salafi_dawah',
  date: new Date(Date.UTC(2026, 10, 12)),
  force: true,
  ...(over && over.deps ? over.deps : {})
});

(async () => {
  ok('the bundle only holds verified references', hadith.ENTRIES.length >= 10 && hadith.ENTRIES.every((e) => e.collection && e.number));
  ok('every entry carries a scene for the image', hadith.ENTRIES.every((e) => typeof e.scene === 'string' && e.scene.length > 20));

  // ---- a normal run
  let out = await hadith.run(deps());
  ok('a run publishes', out.ok === true && out.steps.includes('facebook'), JSON.stringify(out.steps));
  ok('it also posts to Instagram when an account is set', out.steps.includes('instagram'));
  ok('the caption carries arabic, english and the source', /نَصٌّ/.test(out.caption) && /English text/.test(out.caption) && /no\. \d+/.test(out.caption));
  ok('the caption does not invent a grade', !/\u00b7\s*Sahih/.test(hadith.buildCaption({ arabic: 'x', english: 'y', collection: 'bukhari', number: '1', grade: '' }, 't')));
  ok('the caption shows a real grade', /Sahih/.test(hadith.buildCaption({ arabic: 'x', english: 'y', collection: 'tirmidhi', number: '1', grade: 'Sahih' }, 't')));
  ok('the image prompt forbids people', /no human beings/i.test(out.prompt));
  ok('the run is claimed', out.claimSaved === true && store.hadith_last && store.hadith_last.ref === out.ref);

  // ---- no repeat on the same day
  const again = await hadith.run(deps({ deps: { force: false } }));
  ok('a second run the same day is skipped', /already published today/.test(String(again.skipped)), again.skipped);

  // ---- the claim moves the rotation forward
  const firstRef = out.ref;
  const tomorrow = await hadith.run({ ...deps(), date: new Date(Date.UTC(2026, 10, 13)) });
  ok('the next day carries a different reference', tomorrow.ref !== firstRef, firstRef + ' vs ' + tomorrow.ref);

  // ---- a fetch failure refuses rather than invents
  const broken = await hadith.run({ ...deps({ fail: true }), date: new Date(Date.UTC(2026, 10, 14)) });
  ok('a failed fetch publishes nothing', broken.ok === false && !broken.caption, JSON.stringify(broken.steps));
  ok('a failed fetch says why', /could not fetch/.test(String(broken.error)), broken.error);
  ok('a failed fetch does not claim the day', !store.hadith_last || store.hadith_last.date !== '2026-11-14');

  // ---- an empty narration is refused too
  const emptyIlm = async () => ({ hadith: { collection: 'bukhari', hadith_number: '9', text_arabic: '', text_english: '' } });
  const empty = await hadith.run({ ...deps(), ilm: emptyIlm, date: new Date(Date.UTC(2026, 10, 15)) });
  ok('a record with no text is refused', empty.ok === false && /no text/.test(String(empty.error)), empty.error);

  // ---- publish failure leaves the slot open and says so
  const noPublish = await hadith.run({
    ...deps(),
    date: new Date(Date.UTC(2026, 10, 16)),
    social: { postImage: async () => { throw new Error('facebook 190'); } },
    instagram: { publish: async () => { throw new Error('instagram down'); } }
  });
  ok('a publish failure is not okay', noPublish.ok === false, JSON.stringify(noPublish.steps));
  ok('a publish failure reports both channels', /190/.test(JSON.stringify(noPublish.facebook)) && /instagram/.test(JSON.stringify(noPublish.instagram)));
  ok('a publish failure keeps the slot open', /stays open/.test(String(noPublish.claimSkipped)));

  // ---- dry run does not publish
  const dry = await hadith.run({ ...deps(), dry: true, date: new Date(Date.UTC(2026, 10, 17)) });
  ok('a dry run has a caption but publishes nothing', !!dry.caption && !dry.steps.length && !dry.facebook);

  // ---- one hadith a day alternates the Page
  const days = [11, 12, 13, 14, 15];
  const slots = days.map((day) => hadith.run({ ...deps(), dry: true, date: new Date(Date.UTC(2026, 10, day)) }));
  const resolved = await Promise.all(slots);
  ok('the slot alternates by day', new Set(resolved.map((r) => r.slot)).size === 2, resolved.map((r) => r.slot).join(','));

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.log('ERROR', e); process.exit(1); });
