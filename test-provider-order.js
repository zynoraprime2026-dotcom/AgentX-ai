// A reply must not spend its whole minute on the lane that is slow to fail.
const fs = require('fs');
let pass = 0, fail = 0;
const ok = (n, c) => { if (c) pass++; else { fail++; console.log('FAIL:', n); } };
const s = fs.readFileSync(__dirname + '/lib/providers.js', 'utf8');
const body = s.slice(s.indexOf('async function chat(opts) {'), s.indexOf('// A configured key is not a working key'));
ok('groq is asked first', body.indexOf('groqChat(opts)') < body.indexOf('geminiReady()'));
ok('gemini is still the fallback', /if \(await geminiReady\(\)\)/.test(body));
ok('a gemini fallback is reported as such', /fellBack: attempts/.test(body));
ok('the failure list keeps both lanes', /attempts\.push\(\{ provider: 'groq'/.test(body) && /attempts\.push\(\{ provider: 'gemini'/.test(body));
ok('an exhausted pair still reports', /No model provider available/.test(body));
ok('gemini keeps one retry on an overload', /one more go on Gemini/.test(body));
console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
