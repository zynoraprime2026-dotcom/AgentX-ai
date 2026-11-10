// Small talk answers without a model, and never swallows a real question.
const st = require('./lib/smalltalk');

let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) pass++; else { fail++; console.log('FAIL:', n, x === undefined ? '' : String(x)); } };

for (const g of ['Hi', 'hi', 'Hello', 'hey', 'Yo', 'Salam', 'salaam', 'Assalamu alaikum', 'assalam o alaikum', 'Good morning', 'good evening', 'Hi!']) {
  const a = st.answer(g);
  ok('greeting "' + g + '" is answered', a && a.kind === 'greeting' && a.reply === st.GREETING_REPLY, JSON.stringify(a));
}
for (const t of ['Thanks', 'thank you', 'shukran', 'Jazak Allahu khayran', 'Thanks!']) {
  const a = st.answer(t);
  ok('thanks "' + t + '" is answered', a && a.kind === 'thanks', JSON.stringify(a));
}

const notSmallTalk = [
  'Hi, can you post the evening ayah to Hikmah Hub now please?',
  'Hello? When is the next post',
  'what is hajj?',
  '/post',
  '  ',
  '',
  null,
  'post the ayah'
];
for (const q of notSmallTalk) {
  ok('"' + String(q) + '" is left to the model', st.answer(q) === null, JSON.stringify(st.answer(q)));
}
ok('a short question mark still wins', st.answer('ok?') === null, JSON.stringify(st.answer('ok?')));
ok('very short "ok" is not hijacked', st.answer('ok') === null, JSON.stringify(st.answer('ok')));

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
