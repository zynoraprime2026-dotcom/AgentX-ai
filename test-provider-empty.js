// An empty message from a provider is a failure, not an answer. This is the exact bug that
// turned a plain "Hi" into "I could not pull a clear answer together".
const providers = require('./lib/providers');

let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) pass++; else { fail++; console.log('FAIL:', n, x === undefined ? '' : String(x)); } };

const original = global.fetch;
const { GEMINI_API_KEY } = process.env;
delete process.env.GEMINI_API_KEY;   // isolate the Groq lane

function stub(body, status) {
  global.fetch = async () => ({ ok: (status || 200) < 400, status: status || 200, headers: { get: () => null }, json: async () => body });
}

(async () => {
  stub({ choices: [{ message: { content: '' } }] });
  let r = await providers.chat({ key: 'gsk_test', messages: [{ role: 'user', content: 'Hi' }] });
  ok('an empty Groq message is not ok', r.ok === false, JSON.stringify({ ok: r.ok, text: r.text }));
  ok('and it says so', /empty message/i.test(String(r.error || '')), r.error);
  ok('the lane is named', (r.attempts || []).some((a) => a.provider === 'groq'), JSON.stringify(r.attempts));

  stub({ choices: [{ message: { content: 'Wa alaikum assalam.' } }] });
  r = await providers.chat({ key: 'gsk_test', messages: [{ role: 'user', content: 'Hi' }] });
  ok('a real message still comes through', r.ok === true && /assalam/.test(r.text), JSON.stringify({ ok: r.ok, text: r.text }));

  stub({ choices: [{ message: { content: '', tool_calls: [{ id: 'c1', function: { name: 'get_weather', arguments: '{}' } }] } }] });
  r = await providers.chat({ key: 'gsk_test', messages: [{ role: 'user', content: 'Hi' }] });
  ok('a tool call with no prose is still a success', r.ok === true && (r.calls || []).length === 1, JSON.stringify({ ok: r.ok, calls: r.calls }));

  stub({ error: { message: 'Invalid API Key' } }, 401);
  r = await providers.chat({ key: 'gsk_test', messages: [{ role: 'user', content: 'Hi' }] });
  ok('a rejected key is a failure', r.ok === false, JSON.stringify({ ok: r.ok, status: r.status }));

  global.fetch = original;
  if (GEMINI_API_KEY) process.env.GEMINI_API_KEY = GEMINI_API_KEY;
  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})();
