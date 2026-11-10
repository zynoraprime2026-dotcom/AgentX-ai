// Stories and the chained third post: the story rides a feed post that landed, and the third
// Page gets the same verse and picture without spending a second image or moving the cursor.
const store = {};
const dbs = require.resolve(process.cwd() + '/db');
require.cache[dbs] = { id: dbs, filename: dbs, loaded: true, exports: {
  getSocial: async (k) => (store[k] === undefined ? '' : JSON.stringify(store[k])),
  putSocial: async (k, v) => { store[k] = JSON.parse(v); }
}};

let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) pass++; else { fail++; console.log('FAIL:', n, x === undefined ? '' : String(x).slice(0, 300)); } };

// ---- instagram story call shape, against a stubbed fetch ----
const calls = [];
global.fetch = async (url, init) => {
  const u = String(url);
  calls.push({ url: u, method: (init && init.method) || 'GET', body: init && init.body ? String(init.body) : '' });
  if (u.includes('/media_publish')) return { ok: true, json: async () => ({ id: '1790000001' }) };
  if (/\/media(\?|$)/.test(u.replace(/https:\/\/[^/]+/, '')) && (init && init.method) === 'POST') {
    return { ok: true, json: async () => ({ id: 'container1' }) };
  }
  if (u.includes('/container1')) return { ok: true, json: async () => ({ status_code: 'FINISHED' }) };
  if (u.includes('/me/accounts')) {
    return { ok: true, json: async () => ({ data: [{
      id: '108861494336428',
      name: 'The salafi Da\u2019wah',
      instagram_business_account: { id: '17841400393837342', username: 'the_salafi_dawah' }
    }] }) };
  }
  return { ok: true, json: async () => ({}) };
};
const instagram = require('./lib/instagram');
instagram.setToken('ig-token');

(async () => {
  calls.length = 0;
  const story = await instagram.publishStory({ account: 'the_salafi_dawah', imageUrl: 'https://cdn.example/a.jpg' });
  const create = calls.find((c) => c.method === 'POST' && /\/media(\?|$)/.test(c.url));
  ok('the story container is created', Boolean(create), calls.map((c) => c.method + ' ' + c.url).join(' | '));
  ok('media_type is STORIES', /media_type=STORIES/.test(create.body), create.body);
  ok('it is published', calls.some((c) => /media_publish/.test(c.url)));
  ok('the story reports itself as a story', story.story === true && story.id === '1790000001');

  const bad = await instagram.publishStory({ account: 'the_salafi_dawah', imageUrl: 'nope' }).then(() => null, (e) => e.message);
  ok('a story without a public URL is refused', /public image URL/.test(String(bad)), bad);

  // ---- daily.run with stories ----
  const daily = require('./lib/daily');
  const day = new Date(Date.UTC(2027, 0, 4));
  const made = [];
  function deps(extra) {
    return Object.assign({
      date: day,
      page: 'The salafi Da\u2019wah',
      igAccount: 'the_salafi_dawah',
      studio: async () => ({ url: 'https://cdn.example/generated.jpg' }),
      social: { postImage: async () => ({ id: 'fb1', url: 'https://facebook.com/p/1' }) },
      instagram: {
        publish: async () => ({ id: 'ig1', permalink: 'https://instagram.com/p/1' }),
        publishStory: async (a) => { made.push(a); return { id: 'st1', story: true }; }
      },
      ilm: async () => { throw new Error('offline'); }
    }, extra || {});
  }

  let out = await daily.run(deps());
  ok('the feed post published', out.ok === true && out.facebook && !out.facebook.error);
  ok('a story was made for the slot\'s Instagram account', made.length === 1 && made[0].account === 'the_salafi_dawah' && /generated\.jpg/.test(made[0].imageUrl), JSON.stringify(made));
  ok('the story is in the steps', (out.steps || []).includes('story'), JSON.stringify(out.steps));
  ok('the story is in the record', out.record && out.record.story && out.record.story.id === 'st1');

  // a slot that says stories:false makes none
  made.length = 0;
  const s2 = { ...store }; Object.keys(store).forEach((k) => delete store[k]);
  out = await daily.run(deps({ slot: 'promo', stories: false }));
  ok('stories:false makes no story', made.length === 0);
  ok('the promo slot still posted', out.ok === true);

  // a broken story does not fail the post
  const s3 = Object.keys(store).forEach((k) => delete store[k]);
  made.length = 0;
  out = await daily.run(deps({ instagram: {
    publish: async () => ({ id: 'ig1' }),
    publishStory: async () => { throw new Error('story rejected'); }
  } }));
  ok('a failed story is reported, not thrown', out.ok === true && out.story && /story rejected/.test(out.story.error), JSON.stringify(out.story));

  // ---- the chained third post ----
  Object.keys(store).forEach((k) => delete store[k]);
  const evening = await daily.run(deps({ slot: 'evening' }));
  const cursorAfterEvening = JSON.parse(JSON.stringify(store.daily_cursor || {}));
  ok('the evening run advanced the cursor', cursorAfterEvening && cursorAfterEvening.n >= 0, JSON.stringify(cursorAfterEvening));

  const generated = [];
  const promo = await daily.run({
    date: day,
    slot: 'promo',
    index: evening.index,
    imageUrl: evening.imageUrl,
    captionSuffix: 'Zynora Prime \u00b7 a daily reflection',
    stories: false,
    studio: async (p) => { generated.push(p); return { url: 'https://cdn.example/second.jpg' }; },
    social: { postImage: async () => ({ id: 'fb2' }) },
    instagram: { publish: async () => ({ id: 'ig2' }), publishStory: async () => ({ id: 'st2' }) },
    ilm: async () => { throw new Error('offline'); }
  });
  ok('the third post published', promo.ok === true, JSON.stringify(promo.facebook));
  ok('it used the same verse', promo.ref === evening.ref, promo.ref + ' vs ' + evening.ref);
  ok('it reused the picture instead of generating one', promo.imageReused === true && generated.length === 0, JSON.stringify(generated));
  ok('the caption carries its own line', /Zynora Prime/.test(promo.caption), promo.caption.slice(-120));
  ok('the line sits before the hashtags', promo.caption.indexOf('Zynora Prime') < promo.caption.indexOf('#'), promo.caption.slice(-160));
  ok('it kept its own claim', store.daily_last_promo && store.daily_last_promo.slot === 'promo', Object.keys(store).join(',') + ' | ' + JSON.stringify(promo.claimSkipped || promo.claimError || promo.claimSaved));
  ok('the shared cursor did not move again',
    JSON.stringify(store.daily_cursor) === JSON.stringify(cursorAfterEvening),
    JSON.stringify(store.daily_cursor) + ' vs ' + JSON.stringify(cursorAfterEvening));

  const repeat = await daily.run({
    date: day, slot: 'promo', index: evening.index, imageUrl: evening.imageUrl,
    studio: async () => ({ url: 'x' }), social: { postImage: async () => ({ id: 'fb3' }) },
    instagram: { publish: async () => ({ id: 'ig3' }) }, ilm: async () => { throw new Error('offline'); }
  });
  ok('a second third-slot run the same day is refused', /already published today/.test(String(repeat.skipped)), repeat.skipped);

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.log('ERROR', e); process.exit(1); });
