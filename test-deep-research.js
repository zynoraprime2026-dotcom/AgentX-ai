// A brief is only worth having if every claim in it can be traced to a page that was opened.
const fs = require('fs');
let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) pass++; else { fail++; console.log('FAIL:', n, String(x).slice(0, 160)); } };
const r = require('./lib/research');

(async () => {
  const qs = r.buildQueries('Is intermittent fasting effective for weight loss');
  ok('one question becomes several angles', qs.length >= 3, qs.length);
  ok('the plain question comes first', qs[0] === 'Is intermittent fasting effective for weight loss');
  ok('short questions do not get padded', r.buildQueries('gold nisab').length === 1);
  ok('an empty question yields nothing', r.buildQueries('').length === 0);

  const cleaned = r.cleanResults([{ url: 'https://a.example/1', title: 'A' }, { url: 'https://a.example/1', title: 'dup' }, { url: 'ftp://x' }, { link: 'https://b.example/2' }], 5);
  ok('only http links survive', cleaned.length === 2, JSON.stringify(cleaned));
  ok('duplicates are dropped', cleaned.filter((c) => c.url === 'https://a.example/1').length === 1);
  ok('the host is readable', r.host('https://www.example.com/a') === 'example.com');

  const pages = [];
  const out = await r.run({
    question: 'What is the nisab of gold?',
    search: async () => [{ title: 'One', url: 'https://one.example/a' }, { title: 'Two', url: 'https://two.example/b' }, { title: 'Three', url: 'https://three.example/c' }],
    readPage: async (u) => { pages.push(u); return 'x'.repeat(260) + ' text for ' + u; },
    ask: async (p) => {
      ok('the writer is given the opened text', /text for https:\/\/one\.example\/a/.test(p));
      ok('the writer is told to cite by number', /Every point ends with the source number/.test(p));
      ok('the writer may not invent sources', /never cite a source number that is not above/.test(p));
      return 'SUMMARY — 85 grams.\nFINDINGS — 1. It is 85g [1]\n2. Scholars agree [2]\nWHAT IS UNCERTAIN — currency.\nSOURCES — 1 https://one.example/a 2 https://two.example/b';
    },
    maxPages: 3
  });
  ok('pages were actually read', pages.length === 3, pages.length);
  ok('only cited sources are kept', out.sources.length === 2 && out.sources[0].url === 'https://one.example/a', JSON.stringify(out.sources));
  ok('the brief is marked verified when it cites', out.verified === true);
  ok('the brief is returned', /85 grams/.test(out.brief));

  const uncited = await r.run({
    question: 'anything',
    search: async () => [{ title: 'A', url: 'https://a.example/1' }],
    readPage: async () => 'y'.repeat(300),
    ask: async () => 'SUMMARY — no citation here.\nFINDINGS — 1. A claim without a number.'
  });
  ok('an uncited brief is not called verified', uncited.verified === false);

  const nothing = await r.run({ question: 'obscure', search: async () => [{ title: 'A', url: 'https://a.example/1' }], readPage: async () => '' , ask: async () => 'never' });
  ok('no readable page means an honest refusal', /could not open a single page/.test(nothing.brief));
  ok('nothing readable is not verified', nothing.verified === false);

  let threw = false;
  try { await r.run({ question: 'a real question' }); } catch (e) { threw = /needs a search and a writer/.test(e.message); }
  ok('research refuses to run without its parts', threw);

  const srv = fs.readFileSync(__dirname + '/server.js', 'utf8');
  ok('deep research is a chat tool', /name: 'deep_research'/.test(srv));
  ok('it saves what it finds', /workspace\.research\(\{ ownerId: ctx\.ownerId, question: out\.question/.test(srv));
  ok('it warns when nothing was traceable', /could not trace a citation/.test(srv));
  ok('it has an endpoint of its own', /api\.post\('\/research'/.test(srv));
  ok('reference lanes are asked before news', /\[web\.wikipedia, web\.duckduckgo, web\.news\]/.test(srv));
  ok('opaque news redirects are not counted as sources', /news\.google\.com\/rss\/articles/.test(srv));
  ok('excerpts are used when no page opens, and labelled', /comes from search excerpts, not opened pages/.test(require('fs').readFileSync(__dirname + '/lib/research.js', 'utf8')));
  ok('an excerpt brief is never verified', /snippetOnly: true/.test(require('fs').readFileSync(__dirname + '/lib/research.js', 'utf8')));
  ok('research asks the search lanes for result objects', /async function researchSearch/.test(srv) && /web\.duckduckgo, web\.news, web\.wikipedia/.test(srv));
  ok('both call sites use it', (srv.match(/search: \(q\) => researchSearch\(q\)/g) || []).length === 2, (srv.match(/researchSearch\(q\)/g) || []).length);
  ok('a blocked lane does not end the search', /for \(const lane of \[web\.wikipedia, web\.duckduckgo, web\.news\]\)/.test(srv));
  ok('the endpoint is founder only', /api\.post\('\/research'[\s\S]{0,160}req\.user\.founder/.test(srv));

  ok('art generation is a tool', /name: 'art_generate'/.test(srv));
  ok('styles are a fixed library', /const ART_STYLES = \{/.test(srv) && /geometric:/.test(srv) && /calligraphy:/.test(srv));
  ok('a dawah picture defaults to no people', /const noPeople = args\.noPeople !== false/.test(srv));
  ok('artwork is kept in the workspace', /kind: 'artwork'/.test(srv));

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.log('ERR', e.message); process.exit(1); });
