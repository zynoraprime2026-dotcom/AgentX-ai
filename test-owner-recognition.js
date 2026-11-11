// The owner should never be greeted as a stranger. Being founder grants tools; recognition
// has to be told to the model, because profiles are per channel and per chat.
const fs = require('fs');
let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) pass++; else { fail++; console.log('FAIL:', n, String(x).slice(0, 160)); } };
const s = fs.readFileSync(__dirname + '/server.js', 'utf8');

ok('an owner rule exists and is owner-gated', /const OWNER_RULE = ctx && ctx\.canManage/.test(s));
ok('the rule says not to ask his name', /do not ask his name/.test(s));
ok('the rule reaches the system message', /\+ OWNER_RULE \+/.test(s));
ok('it uses his first name when known', /String\(ctx\.ownerName\)\.split\(' '\)\[0\]/.test(s));
ok('web chat carries the founder name', /channel: 'web'.*ownerName: req\.user\.founder \? req\.user\.name/.test(s));
ok('telegram carries it', /channel: 'telegram'.*ownerName: canManage \? await ownerDisplayName\(\)/.test(s));
ok('whatsapp carries it', /channel: 'whatsapp'.*ownerName: canManage \? await ownerDisplayName\(\)/.test(s));
ok('the founder name is resolved from users', /async function ownerDisplayName/.test(s) && /users\.find\(\(u\) => u\.founder\)/.test(s));
ok('the profile tool answers for the owner', /This is the owner of the workspace/.test(s));
ok('a stranger still gets the first-time path', /Introduce yourself and ask their name/.test(s));
ok('the owner branch only runs for a manager', /if \(ctx\.canManage\) return 'This is the owner/.test(s));
console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
