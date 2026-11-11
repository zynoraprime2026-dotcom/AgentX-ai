// /hadith used to print the translation only. The Arabic is the narration itself, so it
// belongs above the meaning, exactly like the ayah command.
const fs = require('fs');
let pass = 0, fail = 0;
const ok = (n, c) => { if (c) pass++; else { fail++; console.log('FAIL:', n); } };
const src = fs.readFileSync(__dirname + '/lib/commands.js', 'utf8');
const fn = src.slice(src.indexOf('async function hadith('), src.indexOf('async function dua('));
ok('the Arabic is read from the record', /const arabic = trimSentences\(h\.text_arabic/.test(fn));
ok('it is printed above the translation', /\+ \(arabic \? arabic \+ '\\n\\n' : ''\) \+ body/.test(fn));
ok('a record without Arabic still answers', /arabic \? arabic/.test(fn) && /const body = trimSentences\(h\.text_english/.test(fn));
ok('the reference line is unchanged', /📜 \*\$\{h\.collection/.test(fn));
ok('the grade is still shown', /h\.grade \? ` \(\$\{h\.grade\}\)`/.test(fn));
ok('it still asks for two records at most', /rows\.slice\(0, 2\)/.test(fn));
ok('the ayah command keeps both languages too', /text_arabic[\s\S]{0,120}translation/.test(src));
console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
