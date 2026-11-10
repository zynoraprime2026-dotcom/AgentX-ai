// accounts() must see both kinds of Instagram link, and resolve() must not pretend the
// publishable flag is the only thing that matters.
const ig = require('./lib/instagram');

let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) pass++; else { fail++; console.log('FAIL:', n, x === undefined ? '' : String(x).slice(0, 240)); } };

const originalFetch = global.fetch;
function stub(payload) {
  global.fetch = async () => ({ ok: true, status: 200, json: async () => payload });
}
ig.setToken('tok');

(async () => {
  stub({ data: [
    { id: '1', name: 'The salafi Da\u2019wah', instagram_business_account: { id: '11', username: 'the_salafi_dawah' }, connected_instagram_account: { id: '11', username: 'the_salafi_dawah' } },
    { id: '2', name: 'Hikmah Hub', connected_instagram_account: { id: '22', username: 'thesalafidawah' } },
    { id: '3', name: 'Zynora Prime' }
  ] });
  const list = await ig.accounts();
  ok('a business account is listed', list.some((a) => a.username === 'the_salafi_dawah' && a.publishable === true), JSON.stringify(list));
  ok('a merely connected account is listed too', list.some((a) => a.username === 'thesalafidawah' && a.igId === '22'), JSON.stringify(list));
  ok('and it is marked as not the business field', list.find((a) => a.username === 'thesalafidawah').publishable === false);
  ok('a Page with no Instagram is skipped', !list.some((a) => a.page === 'Zynora Prime'), JSON.stringify(list));
  ok('each row carries its Page', list.every((a) => a.page && a.pageId));

  const byUser = await ig.resolve('@thesalafidawah');
  ok('resolve finds it by handle', byUser && byUser.igId === '22', JSON.stringify(byUser));
  const byPage = await ig.resolve('Hikmah Hub');
  ok('resolve finds it by Page name', byPage && byPage.igId === '22', JSON.stringify(byPage));

  stub({ data: [] });
  let threw = '';
  try { await ig.resolve('nobody'); } catch (e) { threw = e.message; }
  ok('resolve refuses clearly when nothing is linked', /no Instagram business account is linked/.test(threw), threw);

  global.fetch = originalFetch;
  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})();
