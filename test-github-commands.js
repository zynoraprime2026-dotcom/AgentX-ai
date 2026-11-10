// The plain-word repo status triggers: owner answers without a model, strangers get silence.
process.env.GITHUB_TOKEN='ghp_test'; process.env.GITHUB_REPO='zynoraprime2026-dotcom/AgentX-ai';
const cmds = require('./lib/commands');
const st = { actions: 0, pulls: 0, issues: 0 };
global.fetch = async (u) => {
  const s = String(u);
  if (s.includes('/actions/runs')) st.actions++;
  if (s.includes('/pulls?')) st.pulls++;
  if (s.includes('/issues?')) st.issues++;
  const body = s.includes('/actions/runs') ? { workflow_runs: [{ name:'deploy', conclusion:'failure', head_branch:'main', head_sha:'aaaa', created_at:'2026-11-10T06:00:00Z' }] }
    : s.includes('/pulls?') ? [{ number: 2, title:'x', head:{ref:'a'}, base:{ref:'main'}, user:{login:'o'} }]
    : [{ number: 5, title:'Ask Sunnah.com', state:'open' }];
  return { ok:true, status:200, json: async()=>body, text: async()=>'' };
};
const { handle } = cmds.create({});
(async () => {
  const h = handle;
  let pass=0, fail=0; const ok=(n,c,x)=>{c?pass++:(fail++,console.log('FAIL',n,String(x).slice(0,160)))};
  for (const t of ['ci','builds','build status','actions']) { const r = await h(t,{canManage:true}); ok(t+' answers with a run table', /deploy/.test(String(r)), r); }
  const pr = await h('prs',{canManage:true}); ok('prs lists the pull request', /#2/.test(String(pr)), pr);
  const is = await h('issues',{canManage:true}); ok('issues lists the issue', /#5/.test(String(is)), is);
  for (const t of ['ci','prs','issues']) ok(t+' is silent for a stranger', (await h(t,{canManage:false}))===null);
  console.log('\n'+pass+' passed, '+fail+' failed'); process.exit(fail?1:0);
})();
