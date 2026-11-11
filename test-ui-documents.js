// The documents and office features are only real if the dashboard shows them, so the view,
// the nav entry and the wiring are asserted here.
const fs = require('fs');
let pass = 0, fail = 0;
const ok = (n, c) => { if (c) pass++; else { fail++; console.log('FAIL:', n); } };
const html = fs.readFileSync(__dirname + '/public/index.html', 'utf8');
const js = fs.readFileSync(__dirname + '/public/app.js', 'utf8');
const css = fs.readFileSync(__dirname + '/public/style.css', 'utf8');

ok('the sidebar links to Today', /data-view="today"/.test(html));
ok('the sidebar links to Documents', /data-view="documents"/.test(html));
ok('a Today view exists', /id="view-today"/.test(html));
ok('a Documents view exists', /id="view-documents"/.test(html));
ok('the document form has a title, kind and body', /id="docTitle"/.test(html) && /id="docKind"/.test(html) && /id="docBody"/.test(html));
ok('a reader panel exists', /id="docReaderBody"/.test(html));
ok('the views are registered', /today: loadToday, documents: loadDocuments/.test(js));
ok('today reads the office endpoint', /api\('\/office'\)/.test(js));
ok('documents read the documents endpoint', /api\('\/documents'\)/.test(js));
ok('saving posts the document', /api\('\/documents', \{ method: 'POST'/.test(js));
ok('opening one uses its id', /api\('\/documents\/' \+ encodeURIComponent\(id\)\)/.test(js));
ok('deleting asks first', /confirm\('Delete this document\?/.test(js));
ok('research sources are shown as links', /Sources:<br>/.test(js));
ok('text is escaped before it reaches the page', /esc\(x\.title\)/.test(js));
ok('the reader is closable', /id="docClose"/.test(html) && /\$\('#docClose'\)/.test(js));
ok('rows share one style', /\.docrow \{/.test(css));
console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
