// Tests for lib/workflows.js: the definition rules, the step engine, the approval gate
// and the run log. The database is stubbed, so these run without Postgres.
const assert = require('node:assert');

const runs = [];
const workflows = new Map();
const dbPath = require.resolve(process.cwd() + '/db');
require.cache[dbPath] = {
  id: dbPath, filename: dbPath, loaded: true,
  exports: {
    insertRun: async (r) => { const id = String(runs.length + 1); runs.push({ id, ...r, steps: [] }); return id; },
    updateRun: async (id, patch) => {
      const i = runs.findIndex((x) => String(x.id) === String(id));
      runs[i] = { ...runs[i], ...patch };
      return runs[i];
    },
    getRun: async (id) => runs.find((x) => String(x.id) === String(id)) || null,
    getWorkflow: async (id) => workflows.get(id) || null,
    listWorkflows: async () => [...workflows.values()],
    putWorkflow: async (w) => { workflows.set(w.id, w); return w; }
  }
};

const wf = require('./lib/workflows');
let pass = 0, fail = 0;
const ok = (name, cond, extra) => { if (cond) pass++; else { fail++; console.log('FAIL:', name, extra === undefined ? '' : String(extra).slice(0, 220)); } };
const threw = (fn, re) => { try { fn(); return false; } catch (e) { return !re || re.test(e.message); } };

(async () => {
  // ---- definition rules
  ok('needs an id', threw(() => wf.validate({ steps: [{ type: 'notify', text: 'x' }] }), /needs an id/));
  ok('needs steps', threw(() => wf.validate({ id: 'a', steps: [] }), /at least one step/));
  ok('rejects unknown step types', threw(() => wf.validate({ id: 'a', steps: [{ type: 'shell' }] }), /type must be one of/));
  ok('rejects a foreign host', threw(() => wf.validate({ id: 'a', steps: [{ type: 'http', url: 'https://evil.example/x' }] }), /not in WORKFLOW_HOSTS/));
  ok('rejects plain http', threw(() => wf.validate({ id: 'a', steps: [{ type: 'http', url: 'http://ilm-api.vercel.app/x' }] }), /only https/));
  ok('agent step needs a prompt', threw(() => wf.validate({ id: 'a', steps: [{ type: 'agent' }] }), /needs a prompt/));
  ok('ids are slugged', wf.validate({ id: 'Daily Check!', steps: [{ type: 'notify', text: 'x' }] }).id === 'daily-check-');
  const trusted = wf.validate({ id: 'a', steps: [{ type: 'notify', text: 'x' }], approval: false });
  ok('approval is on unless switched off', wf.validate({ id: 'b', steps: [{ type: 'notify', text: 'x' }] }).approval === true && trusted.approval === false);

  // ---- templating and conditions
  const ctx = { steps: { health: { status: 200, body: { ok: true, name: 'ilm' } } }, input: { topic: 'sabr' } };
  ok('fills nested paths', wf.fill('health {{steps.health.status}} for {{input.topic}}', ctx) === 'health 200 for sabr', wf.fill('{{steps.health.status}}', ctx));
  ok('missing paths render empty, not undefined', wf.fill('[{{steps.nope.x}}]', ctx) === '[]');
  ok('objects are serialised', wf.fill('{{steps.health.body}}', ctx).includes('"ok":true'));
  ok('when equals', wf.whenMatches({ path: 'steps.health.status', equals: 200 }, ctx) === true);
  ok('when equals mismatch', wf.whenMatches({ path: 'steps.health.status', equals: 500 }, ctx) === false);
  ok('when exists false', wf.whenMatches({ path: 'steps.missing', exists: false }, ctx) === true);
  ok('when contains is case-insensitive', wf.whenMatches({ path: 'steps.health.body.name', contains: 'ILM' }, ctx) === true);
  ok('no condition runs', wf.whenMatches(null, ctx) === true);

  // ---- execution with no approval gate (trusted workflow)
  const calls = [];
  const deps = {
    fetch: async (url) => ({ ok: true, status: 200, text: async () => JSON.stringify({ ok: true, verse: 'text-' + calls.length }) }),
    agent: async ({ prompt }) => { calls.push('agent:' + prompt); return { ok: true, text: 'reflection for ' + prompt }; },
    notify: async (text) => { calls.push('notify:' + text); return true; }
  };
  workflows.set('trusted', wf.validate({
    id: 'trusted', name: 'Trusted', approval: false,
    steps: [
      { type: 'http', url: 'https://ilm-api.vercel.app/v1/health', save: 'health' },
      { type: 'agent', prompt: 'Write one line about {{steps.health.body.verse}}', save: 'note' },
      { type: 'notify', text: 'Note: {{steps.note.text}}' }
    ]
  }));
  const run1 = await wf.execute(workflows.get('trusted'), { deps, trigger: 'manual' });
  ok('trusted run succeeds', run1.status === 'succeeded', run1.status + ' ' + run1.error);
  ok('every step recorded ok', run1.steps.every((s) => s.status === 'ok'), JSON.stringify(run1.steps.map((s) => s.status)));
  ok('http output fed the agent step', calls.some((c) => c.startsWith('agent:Write one line about text-')), calls.join(' | '));
  ok('notify got the filled text', calls.some((c) => c === 'notify:Note: reflection for Write one line about text-0'), calls.join(' | '));
  const stored1 = await require.cache[dbPath].exports.getRun(run1.id);
  ok('run is in the log', stored1 && stored1.status === 'succeeded', stored1 && stored1.status);

  // ---- approval gate
  calls.length = 0;
  workflows.set('gated', wf.validate({
    id: 'gated', name: 'Gated',
    steps: [
      { type: 'http', url: 'https://ilm-api.vercel.app/v1/health', save: 'health' },
      { type: 'notify', text: 'Report: {{steps.health.body.verse}}' }
    ]
  }));
  const run2 = await wf.execute(workflows.get('gated'), { deps });
  ok('gated run waits for approval', run2.status === 'pending_approval', run2.status);
  ok('nothing was sent yet', !calls.some((c) => c.startsWith('notify:')), calls.join(' | '));
  ok('the held text is visible in the log', run2.steps.some((s) => s.status === 'held' && s.text === 'Report: text-0'), JSON.stringify(run2.steps));
  const approved = await wf.approve(run2.id, { deps });
  ok('approving sends the held text', calls.some((c) => c === 'notify:Report: text-0'), calls.join(' | '));
  ok('approval marks the run approved', approved.status === 'approved', approved.status);
  ok('approval does not re-run the http step', calls.filter((c) => c.startsWith('notify:')).length === 1);
  ok('approving twice is refused', await wf.approve(run2.id, { deps }).then(() => false, () => true));

  // ---- reject
  calls.length = 0;
  const run3 = await wf.execute(workflows.get('gated'), { deps });
  const rejected = await wf.reject(run3.id);
  ok('reject marks the run rejected', rejected.status === 'rejected', rejected.status);
  ok('reject sends nothing', !calls.some((c) => c.startsWith('notify:')));

  // ---- failure handling
  workflows.set('broken', wf.validate({
    id: 'broken', name: 'Broken', approval: false,
    steps: [
      { type: 'http', url: 'https://ilm-api.vercel.app/v1/health', save: 'h' },
      { type: 'notify', text: 'should not send' }
    ]
  }));
  const badDeps = { ...deps, fetch: async () => ({ ok: false, status: 503, text: async () => 'down' }), notify: async (t) => { calls.push('notify:' + t); return true; } };
  calls.length = 0;
  const run4 = await wf.execute(workflows.get('broken'), { deps: badDeps });
  ok('a failing step fails the run', run4.status === 'failed', run4.status);
  ok('the failure reason is in the log', /503/.test(run4.error), run4.error);
  ok('later steps do not run after a failure', !calls.some((c) => c.startsWith('notify:')), calls.join(' | '));

  // a throwing agent fails the step rather than the process
  const run5 = await wf.execute(wf.validate({ id: 'x', name: 'X', approval: false, steps: [{ type: 'agent', prompt: 'hi' }] }),
    { deps: { agent: async () => ({ ok: false, error: 'groq 429' }), notify: async () => true } });
  ok('agent failure recorded', run5.status === 'failed' && /groq 429/.test(run5.error), run5.error);

  const softDeps = { ...badDeps, fetch: async () => ({ ok: false, status: 404, text: async () => '{"error":"nope"}' }) };
  workflows.set('soft', wf.validate({ id: 'soft', name: 'Soft', approval: false, steps: [{ type: 'http', url: 'https://ilm-api.vercel.app/x', save: 'probe', allowFailure: true }] }));
  const runSoft = await wf.execute(workflows.get('soft'), { deps: softDeps });
  ok('allowFailure lets a non-2xx through', runSoft.status === 'succeeded' && runSoft.steps[0].status === 'ok', runSoft.status);

  // ---- conditions skip steps
  workflows.set('cond', wf.validate({
    id: 'cond', name: 'Cond', approval: false,
    steps: [
      { type: 'notify', text: 'only when broken', when: { path: 'input.state', equals: 'broken' } }
    ]
  }));
  calls.length = 0;
  const run6 = await wf.execute(workflows.get('cond'), { deps, input: { state: 'ok' } });
  ok('a false condition skips the step', run6.steps[0].status === 'skipped' && !calls.some((c) => c.startsWith('notify:')), JSON.stringify(run6.steps));
  const run7 = await wf.execute(workflows.get('cond'), { deps, input: { state: 'broken' } });
  ok('a true condition runs it', calls.some((c) => c === 'notify:only when broken'), calls.join(' | '));
  ok('skipped run still counts as succeeded', run7.status === 'succeeded', run7.status);

  // ---- cron attachment
  await wf.save({ id: 'slot-a', name: 'Slot A', trigger: { type: 'cron', slot: 'morning' }, steps: [{ type: 'notify', text: 'x' }] });
  await wf.save({ id: 'slot-b', name: 'Slot B', trigger: { type: 'cron', slot: 'evening' }, steps: [{ type: 'notify', text: 'x' }] });
  await wf.save({ id: 'off', name: 'Off', enabled: false, trigger: { type: 'cron', slot: 'morning' }, steps: [{ type: 'notify', text: 'x' }] });
  const morning = await wf.dueForSlot('morning');
  ok('dueForSlot picks the slot', morning.some((w) => w.id === 'slot-a') && !morning.some((w) => w.id === 'slot-b'), morning.map((w) => w.id).join(','));
  ok('dueForSlot skips disabled workflows', !morning.some((w) => w.id === 'off'));

// ---------- publishing, and what may reach the Page ----------
  ok('a publish step cannot be saved without the gate',
    threw(() => wf.validate({ id: 'p', steps: [{ type: 'publish', slot: 'morning' }], approval: false })));

  const clean = wf.validate({ id: 'p', steps: [{ type: 'publish', slot: 'morning' }] });
  ok('publish therefore saves with approval on', clean.approval === true);

  ok('a bad publish slot is refused',
    threw(() => wf.validate({ id: 'p', steps: [{ type: 'publish', slot: 'midnight' }] })));

  const hooked = wf.validate({ id: 'h', trigger: { type: 'webhook' }, steps: [{ type: 'notify', text: 'hi' }] });
  ok('a webhook trigger is given a token', typeof hooked.trigger.token === 'string' && hooked.trigger.token.length >= 20);

  ok('an unknown trigger type is refused',
    threw(() => wf.validate({ id: 't', trigger: { type: 'pigeon' }, steps: [{ type: 'notify', text: 'x' }] })));

  // The whole path: held, approved, posted once, and the post's link available to a
  // later notify step without re-running anything.
  const posts = [];
  const notes = [];
  const pubDeps = {
    publish: async ({ slot }) => { posts.push(slot); return { ok: true, slot, ref: '39:53', url: 'https://facebook.com/p/1', steps: ['facebook'] }; },
    notify: async (t) => { notes.push(t); return true; }
  };
  const wfPub = await wf.save({
    id: 'pub-test', approval: true,
    steps: [
      { type: 'publish', slot: 'morning', save: 'post' },
      { type: 'notify', text: 'Posted {{steps.post.ref}} — {{steps.post.url}}' }
    ]
  });
  const first = await wf.execute(wfPub, { deps: pubDeps });
  ok('nothing is posted before approval', posts.length === 0 && first.status === 'pending_approval');
  ok('the held publish reads as a sentence', (first.steps[0].text || '').includes('Publish the morning post'));

  const gated = await wf.approve(first.id, { deps: pubDeps });
  ok('approving posts exactly once', posts.length === 1 && posts[0] === 'morning');
  ok('the run records what was published', gated.status === 'approved' && gated.steps[0].value.ref === '39:53');
  ok('a later notify can quote the post', (notes[0] || '').includes('39:53') && (notes[0] || '').includes('facebook.com'),
    notes[0]);

  ok('a rejected publish never posts', await (async () => {
    const r = await wf.execute(wfPub, { deps: pubDeps });
    await wf.reject(r.id);
    return posts.length === 1;
  })());

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.log('ERROR', e); process.exit(1); });
