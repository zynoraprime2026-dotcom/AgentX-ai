// Deep research: several lookups, the pages themselves, then one written brief that cites only
// what was actually in front of it. The point is not more prose, it is a brief whose every
// claim can be traced to a URL that was opened.
const MAX_QUERIES = 4;
const MAX_PAGES = 4;
const PAGE_CHARS = 1400;

function host(url) {
  try { return new URL(url).host.replace(/^www\./, ''); } catch (e) { return ''; }
}

// Three angles on one question. The variants are cheap and do not need a model to invent them,
// which keeps the first step honest and fast.
function buildQueries(question) {
  const q = String(question || '').trim();
  if (!q) return [];
  const out = [q];
  if (q.split(/\s+/).length > 2) {
    out.push(q + ' explained');
    out.push(q + ' latest news');
    out.push(q + ' criticism limitations');
  }
  return out.slice(0, MAX_QUERIES);
}

function cleanResults(list, limit) {
  const seen = new Set();
  const out = [];
  for (const r of list || []) {
    const url = String((r && (r.url || r.link)) || '');
    if (!/^https?:\/\//i.test(url)) continue;
    if (seen.has(url)) continue;
    seen.add(url);
    out.push({ title: String((r && (r.title || r.name)) || host(url)).slice(0, 160), url, snippet: String((r && (r.snippet || r.description)) || '').slice(0, 240) });
    if (out.length >= limit) break;
  }
  return out;
}

async function run({ question, search, readPage, ask, maxQueries, maxPages, onProgress } = {}) {
  const q = String(question || '').trim();
  if (q.length < 3) throw new Error('a research question needs a few words');
  if (typeof search !== 'function' || typeof ask !== 'function') throw new Error('research needs a search and a writer');
  const queries = buildQueries(q).slice(0, Math.min(Number(maxQueries) || MAX_QUERIES, MAX_QUERIES));
  const note = typeof onProgress === 'function' ? onProgress : () => {};

  const found = [];
  for (const query of queries) {
    note('searching: ' + query);
    try {
      const res = await search(query);
      found.push(...cleanResults(res, 6));
    } catch (e) { /* one failing query must not end the brief */ }
  }
  const sources = cleanResults(found, Math.min(Number(maxPages) || MAX_PAGES, MAX_PAGES) * 2);

  // Read the pages themselves: a snippet is a claim about a page, not the page.
  const corpus = [];
  for (const src of sources.slice(0, Math.min(Number(maxPages) || MAX_PAGES, MAX_PAGES))) {
    note('reading: ' + host(src.url));
    let text = '';
    try { text = String((await readPage(src.url)) || ''); } catch (e) { text = ''; }
    text = text.replace(/\s+/g, ' ').trim();
    if (text.length < 200) continue; // a page that gave nothing is not evidence
    corpus.push({ ...src, text: text.slice(0, PAGE_CHARS) });
  }

  // No page opened. Snippets are still something, but they are a claim about a page rather
  // than the page, so the brief is written from them and labelled as such - never as verified.
  if (!corpus.length) {
    const snippetRows = sources.filter((x) => x.snippet);
    if (!snippetRows.length) {
      return {
        question: q,
        queries,
        sources: sources.map((s) => ({ title: s.title, url: s.url })),
        brief: 'I could not open a single page and the results carried no usable excerpt, so I will not write this up as if I had read anything. Ask me again with narrower words, or ask me to answer from what I already know and mark it as unverified.',
        verified: false
      };
    }
    const asked = await ask([
      'Question: ' + q,
      '',
      'Search excerpts only (no page could be opened):',
      snippetRows.map((x, i) => '[' + (i + 1) + '] ' + x.title + ' — ' + x.url + '\n' + x.snippet).join('\n\n'),
      '',
      'Write: SUMMARY (two sentences), WHAT THE EXCERPTS SAY (three points, each ending with its [n]), WHAT IS UNCERTAIN.',
      'First line must state that this comes from search excerpts, not opened pages. Never add a fact that is not above.'
    ].join('\n'));
    return {
      question: q,
      queries,
      sources: snippetRows.map((x) => ({ title: x.title, url: x.url })),
      brief: String(asked || '').trim() || 'The searches returned excerpts but no readable pages, and the writer returned nothing.',
      verified: false,
      snippetOnly: true
    };
  }

  const numbered = corpus.map((c, i) => '[' + (i + 1) + '] ' + c.title + ' — ' + c.url + '\n' + c.text).join('\n\n');
  const prompt = [
    'Question: ' + q,
    '',
    'Sources actually opened (use only these):',
    numbered,
    '',
    'Write a research brief in plain text with these sections exactly:',
    'SUMMARY — three sentences at most.',
    'FINDINGS — between three and six numbered points. Every point ends with the source number it came from, like [2].',
    'WHAT IS UNCERTAIN — what the sources disagree on, or what none of them answered.',
    'SOURCES — the number and URL of each source you actually cited.',
    '',
    'Rules: never cite a source number that is not above, never add a fact that is not in the text above, and if the sources do not answer the question say so in the first line. No preamble, no markdown headings with #.'
  ].join('\n');

  const wrote = await ask(prompt);
  const brief = String(wrote || '').trim();
  if (!brief) throw new Error('the writer returned nothing');

  const cited = new Set((brief.match(/\[(\d+)\]/g) || []).map((m) => Number(m.replace(/\D/g, ''))));
  const used = corpus.filter((c, i) => cited.has(i + 1)).map((c) => ({ title: c.title, url: c.url }));
  return {
    question: q,
    queries,
    brief,
    verified: used.length > 0,
    sources: (used.length ? used : corpus.map((c) => ({ title: c.title, url: c.url }))).slice(0, 8),
    pagesRead: corpus.length
  };
}

module.exports = { run, buildQueries, cleanResults, host, MAX_QUERIES, MAX_PAGES };
