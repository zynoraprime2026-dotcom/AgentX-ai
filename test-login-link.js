// The founder key is sealed in Vercel, so a one-time link is the only way back in when the
// password is lost. It must be admin-key only, single use, and short lived.
const fs = require('fs');
let pass = 0, fail = 0;
const ok = (n, c) => { if (c) pass++; else { fail++; console.log('FAIL:', n); } };
const srv = fs.readFileSync(__dirname + '/server.js', 'utf8');
const mint = srv.slice(srv.indexOf("api.post('/admin/login-link'"), srv.indexOf("api.get('/auth/link'"));
const use = srv.slice(srv.indexOf("api.get('/auth/link'"), srv.indexOf("api.get('/auth/link'") + 2200);

ok('minting needs the admin key', /adminKeyOk\(req\)/.test(mint) && /403/.test(mint));
ok('minting refuses an unknown account', /no account with that email/.test(mint));
ok('the token is random, not derived from the email', /crypto\.randomBytes\(24\)/.test(mint));
ok('the token expires in fifteen minutes', /15 \* 60000/.test(mint));
ok('the link is returned as a path, not a bare token', /'\/api\/auth\/link\?t=' \+ token/.test(mint));
ok('using the link compares the token', /rec\.token !== String\(req\.query\.t \|\| ''\)/.test(use));
ok('an expired link is refused', /That link has expired/.test(use));
ok('the token is burnt after one use', /login_link', ''\)/.test(use));
ok('a valid link sets a normal session cookie', /Set-Cookie[\s\S]{0,120}agx_sess/.test(use));
ok('it redirects to the dashboard', /res\.redirect\('\/'\)/.test(use));
ok('the route is reachable without a session', /PUBLIC_API = \[[^\]]*'\/auth\/link'/.test(srv));
ok('recovery is still founder-key only', /String\(founderKey \|\| ''\) !== process\.env\.ADMIN_KEY/.test(srv));
console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
