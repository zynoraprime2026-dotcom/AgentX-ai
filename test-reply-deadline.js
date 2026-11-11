// A killed function answers the browser with nothing. The reply carries its own deadline and
// answers with what it has instead of running into Vercel's limit.
const fs = require('fs');
let pass = 0, fail = 0;
const ok = (n, c) => { if (c) pass++; else { fail++; console.log('FAIL:', n); } };
const s = fs.readFileSync(__dirname + '/server.js', 'utf8');
const v = JSON.parse(fs.readFileSync(__dirname + '/vercel.json', 'utf8'));
ok('the reply has a deadline', /const REPLY_DEADLINE = Date\.now\(\) \+/.test(s));
ok('the deadline is configurable', /process\.env\.REPLY_BUDGET_MS/.test(s));
ok('it defaults below the platform limit', /\) \|\| 40000\)/.test(s));
ok('passing the deadline drops the tools', /Date\.now\(\) > REPLY_DEADLINE && toolsOn[\s\S]{0,120}toolsOn = false/.test(s));
ok('the model is told to answer now', /Time is nearly up\. Answer now/.test(s));
ok('the function is allowed the full minute', v.functions && v.functions['api/index.js'] && v.functions['api/index.js'].maxDuration === 60);
ok('the crons survived the edit', (v.crons || []).length >= 6);
ok('the deadline only applies after the first round', /round > 0 && Date\.now\(\) > REPLY_DEADLINE/.test(s));
ok('the model call is given only the remaining budget', /timeoutMs: Math\.max\(8000, Math\.min\(25000, REPLY_DEADLINE - Date\.now\(\)\)\)/.test(s));
ok('a slow model cannot hold the route hostage', /Promise\.race\(\[\s*\n?\s*groqAsk\(a, history, ctx\)/.test(s));
ok('the guard answers instead of failing silently', /took longer than the dashboard allows/.test(s));
ok('the guard fires before the platform limit', /\}, 50000\)\)/.test(s));
console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
