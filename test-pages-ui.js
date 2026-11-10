// The dashboard gets the same powers as the chat, and the same preview rule.
const fs = require('fs');
let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) pass++; else { fail++; console.log('FAIL:', n, String(x).slice(0, 200)); } };
const html = fs.readFileSync(__dirname + '/public/index.html', 'utf8');
const js = fs.readFileSync(__dirname + '/public/app.js', 'utf8');
const server = fs.readFileSync(__dirname + '/server.js', 'utf8');

ok('the Pages view has a nav button', /data-view="pagesview"/.test(html));
ok('the Pages view has a section', /id="view-pagesview"/.test(html));
ok('the view is registered in the router', /pagesview: renderPages/.test(js));
ok('it renders a Page picker, profile fields, targets and heartbeat',
  /id="pgPick"/.test(html) && /id="pgFields"/.test(html) && /id="pgSchedule"/.test(html) && /id="pgHits"/.test(html));
ok('Apply starts disabled', /id="pgApply" disabled/.test(html));
ok('a preview is required before Apply is enabled', /previewProfile[\s\S]{0,900}\$\('#pgApply'\)\.disabled = false/.test(js));
ok('Apply sends confirm=1', /admin\/page-settings\?confirm=1/.test(js));
ok('the heartbeat is loaded in the view', /async function loadHits/.test(js) && /admin\/cron-hits/.test(js));

// the route semantics: preview by default, apply on confirm=1, nothing sent when unchanged
ok('the route previews without confirm', /if \(String\(req\.query\.confirm \|\| ''\) !== '1'\) \{\s*\n\s*return res\.json\(\{ ok: true, page: page\.name, applied: false, preview: true/.test(server));
ok('an unchanged field is not sent to Facebook', /Nothing differs, so nothing was sent to Facebook/.test(server));
ok('only editable fields are written', /social\.EDITABLE_FIELDS\.includes\(k\) && String\(v \|\| ''\)\.trim\(\)/.test(server));
ok('the heartbeat route is guarded', /'\/admin\/cron-hits'[\s\S]{0,200}isFounderOrKey/.test(server));
ok('the settings routes are guarded', (server.match(/api\.(get|post)\('\/admin\/page-settings'[\s\S]{0,120}isFounderOrKey/g) || []).length === 2);
ok('the view styles exist', /\.grid2 \{ display: grid/.test(fs.readFileSync(__dirname + '/public/style.css', 'utf8')));
console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
