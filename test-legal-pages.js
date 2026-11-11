// Meta will not publish an app whose privacy link is not a policy, and "delete my data"
// has to mean something. These checks keep both promises true.
const fs = require('fs');
let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) pass++; else { fail++; console.log('FAIL:', n, String(x).slice(0, 140)); } };
const srv = fs.readFileSync(__dirname + '/server.js', 'utf8');
const priv = fs.readFileSync(__dirname + '/public/privacy.html', 'utf8');
const del = fs.readFileSync(__dirname + '/public/data-deletion.html', 'utf8');
const terms = fs.readFileSync(__dirname + '/public/terms.html', 'utf8');
ok('privacy is really served', /app\.get\('\/privacy'/.test(srv) && priv.length > 1500);
ok('deletion page is really served', /app\.get\('\/data-deletion'/.test(srv) && del.length > 800);
ok('terms is really served', /app\.get\('\/terms'/.test(srv));
ok('privacy names what is collected', /phone number/i.test(priv) && /message/i.test(priv));
ok('privacy names the processors', /Meta/.test(priv) && /Neon/.test(priv) && /Groq/.test(priv));
ok('privacy states a retention period', /90 days/.test(priv) && /30 days/.test(priv));
ok('privacy links the deletion page', /href="\/data-deletion"/.test(priv));
ok('privacy gives a contact address', /zynoraprime2026@gmail\.com/.test(priv));
ok('deletion page explains the in-chat route', /delete my data/i.test(del));
ok('deletion page is honest about platform copies', /Meta, Telegram/.test(del));
ok('terms links back to privacy', /href="\/privacy"/.test(terms));
console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
