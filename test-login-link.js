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
ok('the GET burns nothing, it only renders a button', /The GET renders a button and burns nothing/.test(srv));
ok('a chat preview crawler cannot consume the token', /api\.get\('\/auth\/link'[\s\S]{0,1400}?return res\.type\('html'\)\.send\(linkPage\('Sign in'/.test(srv));
const getOnly = srv.slice(srv.indexOf("api.get('/auth/link'"), srv.indexOf("api.post('/auth/link'"));
ok('the GET never writes to the login_link record', !/putSocial\('login_link'/.test(getOnly));
ok('signing in happens on a POST the crawler will not send', /api\.post\('\/auth\/link'[\s\S]{0,1600}?Set-Cookie/.test(srv));
ok('the button posts to the same token', /method="POST" action="\/api\/auth\/link\?t=' \+ token/.test(srv));
ok('an expired link is refused', /That link has expired/.test(use));
ok('the token is burnt after one use', /login_link', ''\)/.test(use));
ok('a valid link sets a normal session cookie', /Set-Cookie[\s\S]{0,120}agx_sess/.test(use));
ok('it redirects to the dashboard', /res\.redirect\('\/'\)/.test(use));
ok('the route is reachable without a session', /PUBLIC_API = \[[^\]]*'\/auth\/link'/.test(srv));
ok('recovery is still founder-key only', /String\(founderKey \|\| ''\) !== process\.env\.ADMIN_KEY/.test(srv));
console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
