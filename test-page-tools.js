// The model gets real Facebook tools, and the destructive ones only ever stage.
const { runTool } = require('./server');
let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) pass++; else { fail++; console.log('FAIL:', n, String(x).slice(0, 200)); } };
(async () => {
  const owner = { canManage: true, channel: 'whatsapp', chatId: 'owner' };
  const guest = { canManage: false, channel: 'whatsapp', chatId: 'guest' };
  for (const t of ['page_recent_posts', 'page_comments', 'page_engagement', 'page_stage_edit', 'page_stage_delete']) {
    const r = await runTool(t, { message: 'x' }, guest);
    ok(t + ' refuses a stranger', /Not available here/.test(String(r)), r);
  }
  const names = require('fs').readFileSync(__dirname + '/server.js', 'utf8');
  for (const t of ['page_recent_posts', 'page_comments', 'page_engagement', 'page_stage_edit', 'page_stage_delete']) {
    ok(t + ' is offered to the model', names.includes("name: '" + t + "'"));
  }
  // the stage tools must not call the apply path
  ok('stage_edit only stages', /postActionFromChat\('edit'/.test(names) && !/page_stage_edit[\s\S]{0,300}editPostMessage/.test(names));
  ok('stage_delete only stages', /postActionFromChat\('delete'/.test(names) && !/page_stage_delete[\s\S]{0,300}deletePost\(/.test(names));
  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.log('ERR', e.message); process.exit(1); });
