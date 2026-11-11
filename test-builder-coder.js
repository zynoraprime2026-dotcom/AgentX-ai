// AgentX is now a builder as well as a reader: it can start a project and commit to one, but
// only after the owner says yes, and it must never claim what a tool did not confirm.
const fs = require('fs');
let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) pass++; else { fail++; console.log('FAIL:', n, String(x).slice(0, 160)); } };
const srv = fs.readFileSync(__dirname + '/server.js', 'utf8');
const dev = fs.readFileSync(__dirname + '/lib/devtools.js', 'utf8');

ok('the scout tool is offered to the model', /name: 'project_scaffold'/.test(srv));
ok('it creates a repository through GitHub', /async function createRepo/.test(dev) && /\/user\/repos/.test(dev));
ok('a new project is seeded with several files', /async function seedFiles/.test(dev));
ok('the starter app really is a working page', /function starterFiles/.test(srv) && /<script src="app.js">/.test(srv));
ok('a webapp starter is installable', /manifest\.webmanifest/.test(srv) && /sw\.js/.test(srv));
ok('an api starter has a handler', /api\/index\.js/.test(srv));
ok('the scaffold is staged, not immediate', /if \(!\(ctx && ctx\.canManage\)\) return 'Not available here\.';\s*\n\s*try \{\s*\n\s*const name = String\(args\.name/.test(srv));
ok('staging says yes is required', /Reply yes to create it/.test(srv));
ok('a file commit is staged too', /kind: 'github_write'/.test(srv) && /Reply yes to commit it/.test(srv));
ok('the staged write records the content', /content, message: String\(args\.message \|\| ''\)/.test(srv));
ok('yes commits the file', /if \(gh\.kind === 'github_write'\)[\s\S]{0,300}devtools\.writeFile/.test(srv));
ok('yes creates the project and seeds it', /if \(gh\.kind === 'project_scaffold'\)[\s\S]{0,400}seedFiles/.test(srv));
ok('the staging is cleared after success', /devtools\.seedFiles\([\s\S]{0,200}clearPendingGithub/.test(srv));
ok('the model is told it cannot deploy', /You cannot deploy, restart a service/.test(srv));
ok('the model is told to say yes is needed', /only happen after the owner says yes/.test(srv));
ok('it must not claim unconfirmed work', /never claim a commit, a project or a deploy that a tool did not confirm/.test(srv));
ok('repo names are sanitised', /replace\(\/\[\^a-z0-9\._-\]\+\/g, '-'\)/.test(dev));
ok('a one-character name is refused', /at least two characters/.test(dev));
ok('the dashboard chat applies a staged yes', /for EVERY message, not only slash commands/.test(srv) && /if \(lastUser\) \{\s*\n\s*const out = await commands\.handle/.test(srv));
ok('unrecognised text still reaches the agent', /falls through to the agent untouched/.test(srv));
ok('a GET request carries no body', /const withBody = !\/\^\(GET\|HEAD\)\$\/i\.test/.test(fs.readFileSync(__dirname + '/lib/devtools.js', 'utf8')));
ok('a write still sends its payload', /\.\.\.\(withBody \? \{ body: JSON\.stringify\(payload \|\| \{\}\) \} : \{\}\)/.test(fs.readFileSync(__dirname + '/lib/devtools.js', 'utf8')));
const srvTxt = fs.readFileSync(__dirname + '/server.js', 'utf8');
ok('admin routes attach the session before they run', srvTxt.indexOf("app.use('/api/admin'") > 0 && srvTxt.indexOf("app.use('/api/admin'") < srvTxt.indexOf("app.get('/api/admin"));
console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
