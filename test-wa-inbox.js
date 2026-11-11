// The inbox only counts as real if it reads live history, writes back what it sends, and
// stays owner-only. These checks keep it from drifting back into a mock.
const fs = require('fs');
let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) pass++; else { fail++; console.log('FAIL:', n, String(x).slice(0, 160)); } };
const srv = fs.readFileSync(__dirname + '/server.js', 'utf8');
const db = fs.readFileSync(__dirname + '/db.js', 'utf8');
const page = fs.readFileSync(__dirname + '/public/inbox.html', 'utf8');
const dash = fs.readFileSync(__dirname + '/public/index.html', 'utf8');

ok('threads come from the real history table', /wa-threads[\s\S]{0,400}FROM agx_hist/.test(srv));
ok('messages too', /wa-messages[\s\S]{0,400}FROM agx_hist/.test(srv));
ok('unread is counted, not guessed', /COUNT\(\*\) FILTER \(WHERE role <> 'assistant' AND seen IS NOT TRUE\)/.test(srv));
ok('a reply is really sent', /wa-send[\s\S]{0,1200}await waSend\(chat, text\)/.test(srv));
ok('and written back into history', /agx_hist \(channel, chat_id, role, content, created_at\)/.test(srv));
ok('history gained its missing columns', /ADD COLUMN IF NOT EXISTS created_at/.test(db) && /ADD COLUMN IF NOT EXISTS seen/.test(db));
ok('chat is required before sending', /chat is required[\s\S]{0,200}text is required/.test(srv));
ok('missing credentials say so plainly', /WhatsApp is not configured on this deployment yet/.test(srv));
ok('every inbox route is owner only', (srv.match(/app\.(get|post)\('\/api\/admin\/wa-(threads|messages|send|read)'/g) || []).length === 4 && (srv.match(/wa-(threads|messages|send|read)'[\s\S]{0,200}isFounderOrKey/g) || []).length >= 4);
ok('the page exists and is served', /public', 'inbox\.html'/.test(srv) && page.length > 2000);
ok('the dashboard links to it', /href="\/inbox"/.test(dash));
ok('messages are rendered as text, never html', /textContent = m\.text/.test(page) && !/innerHTML = m\.text/.test(page));
ok('the page polls so replies appear', /setInterval\(/.test(page));
ok('a failed send is shown, not hidden', /Could not send: /.test(page));
console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
