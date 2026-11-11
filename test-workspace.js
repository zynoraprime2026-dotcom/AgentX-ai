// Documents are the floor under research and the office view, so the store itself is tested
// directly: save, update in place, search, isolation between owners, and the size limit.
const fs = require('fs');
const os = require('os');
const path = require('path');
let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) pass++; else { fail++; console.log('FAIL:', n, String(x).slice(0, 200)); } };

// The store keeps its data in one directory, so each run claims its own owner ids rather
// than assuming an empty file.
const w = require('./lib/workspace');
const RUN = 't' + Math.random().toString(36).slice(2, 8);
const OWN = RUN + '-u1';
const OTHER = RUN + '-u2';

(async () => {
  const a = await w.save({ ownerId: OWN, title: 'Proposal for Zakat app', body: 'Nisab 85g gold.', kind: 'proposal' });
  ok('a document gets an id', /^doc_/.test(a.id), a.id);
  ok('version starts at one', a.version === 1, a.version);
  ok('the kind is kept', a.kind === 'proposal', a.kind);

  const b = await w.save({ ownerId: OWN, id: a.id, title: 'Proposal for Zakat app', body: 'Nisab 85g gold.\n\nFee 2.5%.' });
  ok('an update keeps the same id', b.id === a.id);
  ok('an update bumps the version', b.version === 2, b.version);
  const all = await w.list({ ownerId: OWN });
  ok('an update does not create a duplicate', all.length === 1, all.length);
  ok('the body is the new one', /2.5%/.test(b.body));

  const app = await w.append({ ownerId: OWN, id: a.id, text: 'Reviewed.' });
  ok('append extends the body', /Reviewed\./.test(app.body) && app.version === 3);

  const found = await w.list({ ownerId: OWN, q: 'zakat' });
  ok('search is case-insensitive and matches the title', found.length === 1);
  const none = await w.list({ ownerId: OWN, q: 'nothing here' });
  ok('search finds nothing when nothing matches', none.length === 0);
  const other = await w.list({ ownerId: OTHER });
  ok('another owner sees none of it', other.length === 0);

  const r = await w.research({ ownerId: OWN, question: 'Gold nisab', findings: '85 grams.', sources: [
    { title: 'Reliable', url: 'https://example.com/nisab' },
    { title: 'Nonsense', url: 'javascript:alert(1)' },
    { title: 'No url' }
  ] });
  ok('research saves as a research document', r.kind === 'research');
  ok('only real http sources are kept', r.sources.length === 1 && r.sources[0].url === 'https://example.com/nisab', JSON.stringify(r.sources));

  let refused = false;
  try { await w.research({ ownerId: OWN, question: 'x', findings: '' }); } catch (e) { refused = /findings/.test(e.message); }
  ok('empty research is refused', refused);

  let tooBig = false;
  try { await w.save({ ownerId: OWN, title: 'big', body: 'x'.repeat(30000) }); } catch (e) { tooBig = /limit/.test(e.message); }
  ok('an oversized document is refused', tooBig);

  ok('reading by title fragment works', (await w.read({ ownerId: OWN, title: 'Zakat app' })).id === a.id);
  ok('reading someone else\'s document returns nothing', (await w.read({ ownerId: OTHER, id: a.id })) === null);
  ok('delete is owner-scoped', (await w.remove({ ownerId: OTHER, id: a.id })) === false);

  const office = await w.officeToday({ ownerId: OWN, reminders: [], unread: 3, lastPost: { date: '2026-11-11', slots: ['morning'] }, pending: [] });
  ok('the office view has a date', /^\d{4}-\d{2}-\d{2}$/.test(office.date));
  ok('the office view reports unread mail', office.email.unread === 3);
  ok('the office view lists recent documents', office.documents.length >= 1);

  const srv = fs.readFileSync(__dirname + '/server.js', 'utf8');
  ok('the tools are offered to the owner', /for \(const extra of \['work', 'email', 'dev', 'social'\]\)/.test(srv));
  ok('documents have an http surface', /api\.get\('\/documents'/.test(srv) && /api\.post\('\/documents'/.test(srv));
  ok('the office has an http surface', /api\.get\('\/office'/.test(srv));
  ok('the model is told to save documents', /write it with doc_save/.test(srv));
  ok('the model is told to cite research', /listing every link you actually opened/.test(srv));
  ok('the office answer may not invent items', /never add a meeting, an email or a reminder the tool did not return/.test(srv));
  ok('project_check reads the repo it is given', /devtools\.readFileIn\(repo, f\)/.test(srv));
  ok('the office text is rendered server-side', /function formatOffice/.test(srv));
  ok('posting state is read from the claims', /async function readDailyLast/.test(srv));

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.log('ERR', e.message); process.exit(1); });
