// The daily jobs should be one tap, and each tap must reach the same code the chat uses.
const fs = require('fs');
let pass = 0, fail = 0;
const ok = (n, c) => { if (c) pass++; else { fail++; console.log('FAIL:', n); } };
const srv = fs.readFileSync(__dirname + '/server.js', 'utf8');
const html = fs.readFileSync(__dirname + '/public/index.html', 'utf8');
const js = fs.readFileSync(__dirname + '/public/app.js', 'utf8');
const css = fs.readFileSync(__dirname + '/public/style.css', 'utf8');

ok('a quick action route exists', /api\.post\('\/quick'/.test(srv));
ok('it is founder only', /api\.post\('\/quick'[\s\S]{0,200}req\.user\.founder/.test(srv));
ok('posting the ayah reuses the chat code', /postDailyFromChat\(\{ canManage: true/.test(srv));
ok('posting the hadith reuses the daily job', /runHadithPost\(slot, true\)/.test(srv));
ok('comments are read through the reader', /collectComments\(6\)/.test(srv));
ok('it can say whether today is posted', /readDailyLast\(\)[\s\S]{0,200}slot is (already posted|open)/.test(srv));
ok('an unknown action is refused', /unknown action/.test(srv));
ok('failures come back as messages, not silence', /return res\.json\(\{ ok: false, message: 'Failed: ' \+ out\.error \}\)/.test(srv));
ok('the buttons exist on Today', /data-quick="post-ayah"/.test(html) && /data-quick="post-hadith"/.test(html));
ok('reading comments and checking are offered too', /data-quick="comments"/.test(html) && /data-quick="check"/.test(html));
ok('the screen shows what the server said', /d\.message \|\| \(d\.ok/.test(js));
ok('a button cannot be double-pressed', /btn\.disabled = true/.test(js));
ok('a post refreshes the view', /loadToday\(\)/.test(js));
ok('the buttons share a row style', /\.quickrow \{/.test(css));
console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
