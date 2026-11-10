// Workflows: a trigger, a short list of steps, and a run log you can actually read.
//
// A workflow is data in the database, not code, so the owner can change what happens
// without a deploy. Two rules shape this file:
//
//   1. Every run is recorded, step by step, with its output and its failure reason.
//      Automation nobody can inspect is automation nobody trusts.
//   2. Nothing that reaches a person can happen without approval unless the workflow was
//      explicitly created as trusted. Verse and hadith text is fetched, never written by
//      the model, because a composed "verse" is the one error these accounts cannot afford.
const db = require('../db');

const STEP_TYPES = ['http', 'agent', 'notify', 'publish'];
const MAX_STEPS = 12;
const STEP_TIMEOUT_MS = 25000;
// Steps may only talk to the owner's own services. A workflow that could call any URL is
// an open redirect with extra steps.
const ALLOWED_HOSTS = String(process.env.WORKFLOW_HOSTS || 'ilm-api.vercel.app,agent-x-ai-l1bd.vercel.app')
  .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);

function getPath(obj, path) {
  const parts = String(path || '').trim().split('.').filter(Boolean);
  let cur = obj;
  for (const p of parts) {
    if (cur === undefined || cur === null) return undefined;
    if (Array.isArray(cur) && /^\d+$/.test(p)) cur = cur[Number(p)];
    else cur = cur[p];
  }
  return cur;
}

function asText(v) {
  if (v === undefined || v === null) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

// {{steps.health.status}} and {{input.topic}} are filled from what actually ran.
function fill(template, ctx) {
  return String(template || '').replace(/\{\{\s*([^}]+?)\s*\}\}/g, (m, path) => {
    const v = getPath(ctx, path);
    return v === undefined ? '' : asText(v);
  });
}

// A step may carry { when: { path, equals } } / { exists: true } / { contains: "..." }.
// That is enough for "only tell me when something broke" without inventing a language.
function whenMatches(when, ctx) {
  if (!when || typeof when !== 'object') return true;
  const v = getPath(ctx, when.path);
  if ('exists' in when) {
    const has = v !== undefined && v !== null && v !== '';
    if (has !== !!when.exists) return false;
  }
  if ('equals' in when && asText(v) !== asText(when.equals)) return false;
  if ('notEquals' in when && asText(v) === asText(when.notEquals)) return false;
  if ('contains' in when && !String(asText(v)).toLowerCase().includes(String(when.contains).toLowerCase())) return false;
  return true;
}

function validate(def) {
  const d = def || {};
  const id = String(d.id || '').trim().toLowerCase().replace(/[^a-z0-9_-]/g, '-').slice(0, 60);
  if (!id) throw new Error('a workflow needs an id');
  const name = String(d.name || id).slice(0, 120);
  const steps = Array.isArray(d.steps) ? d.steps : [];
  if (!steps.length) throw new Error('a workflow needs at least one step');
  if (steps.length > MAX_STEPS) throw new Error('at most ' + MAX_STEPS + ' steps');
  steps.forEach((st, i) => {
    if (!STEP_TYPES.includes(st.type)) throw new Error('step ' + (i + 1) + ': type must be one of ' + STEP_TYPES.join(', '));
    if (st.type === 'http') {
      let u;
      try { u = new URL(st.url); } catch (e) { throw new Error('step ' + (i + 1) + ': url is not a URL'); }
      if (u.protocol !== 'https:') throw new Error('step ' + (i + 1) + ': only https is allowed');
      if (!ALLOWED_HOSTS.includes(u.hostname.toLowerCase())) {
        throw new Error('step ' + (i + 1) + ': ' + u.hostname + ' is not in WORKFLOW_HOSTS (' + ALLOWED_HOSTS.join(', ') + ')');
      }
    }
    if (st.type === 'agent' && !String(st.prompt || '').trim()) throw new Error('step ' + (i + 1) + ': agent needs a prompt');
    if (st.type === 'notify' && !String(st.text || '').trim()) throw new Error('step ' + (i + 1) + ': notify needs text');
    if (st.type === 'publish' && st.slot && !['morning', 'evening'].includes(st.slot)) {
      throw new Error('step ' + (i + 1) + ': publish slot must be morning or evening');
    }
  });
  // Publishing is the one action that cannot be taken back, so a workflow that posts
  // always keeps the gate, whatever the caller asked for.
  const posts = steps.some((st) => st.type === 'publish');
  if (posts && d.approval === false) throw new Error('a workflow with a publish step must keep approval on');
  const trig = d.trigger && typeof d.trigger === 'object' ? { ...d.trigger } : { type: 'manual' };
  if (!['manual', 'cron', 'webhook'].includes(trig.type)) throw new Error('trigger must be manual, cron or webhook');
  if (trig.type === 'webhook' && !trig.token) trig.token = require('crypto').randomBytes(16).toString('hex');
  return {
    id, name,
    enabled: d.enabled !== false,
    trigger: trig,
    steps,
    approval: posts ? true : d.approval !== false,   // approval is the default; trust is opt-in
    createdBy: String(d.createdBy || '').slice(0, 120)
  };
}

async function save(def) {
  const clean = validate(def);
  return db.putWorkflow(clean);
}

async function runStep(step, ctx, deps) {
  if (step.type === 'http') {
    const url = fill(step.url, ctx);
    const method = String(step.method || 'GET').toUpperCase();
    const init = { method, signal: AbortSignal.timeout(STEP_TIMEOUT_MS), headers: {} };
    if (step.body) { init.body = fill(typeof step.body === 'string' ? step.body : JSON.stringify(step.body), ctx); init.headers['content-type'] = 'application/json'; }
    if (step.headers && typeof step.headers === 'object') {
      for (const [k, v] of Object.entries(step.headers)) init.headers[k] = fill(v, ctx);
    }
    const r = await (deps.fetch || fetch)(url, init);
    const text = await r.text();
    let body = text;
    try { body = JSON.parse(text); } catch (e) { /* keep the text */ }
    // A 500 that silently flows on to the next step is how a workflow tells you it
    // worked when it did not. Failing here is the default; allowFailure opts out for
    // the cases where the status code is the answer.
    if (!r.ok && step.allowFailure !== true) {
      throw new Error('http ' + r.status + ' from ' + url + ': ' + String(text).slice(0, 160));
    }
    return { ok: r.ok, status: r.status, body, url };
  }
  if (step.type === 'agent') {
    const prompt = fill(step.prompt, ctx);
    const out = await deps.agent({ prompt, system: fill(step.system || '', ctx), model: step.model, maxTokens: step.maxTokens });
    if (!out || out.ok === false) throw new Error('agent step failed: ' + String((out && out.error) || 'no reply').slice(0, 200));
    return { ok: true, text: asText(out.text || out.reply) };
  }
  if (step.type === 'publish') {
    if (typeof deps.publish !== 'function') throw new Error('this deployment cannot publish');
    const res = await deps.publish({ slot: step.slot, workflow: ctx.workflow, run: ctx.run });
    if (!res || res.ok === false) throw new Error('publish failed: ' + String((res && (res.error || res.skipped)) || 'no result').slice(0, 200));
    return { ok: true, slot: res.slot || step.slot || '', ref: res.ref || '', url: res.url || '', channels: res.steps || [] };
  }
  if (step.type === 'notify') {
    const text = fill(step.text, ctx);
    const sent = await deps.notify(text, { run: ctx.run, workflow: ctx.workflow });
    return { ok: true, text, delivered: sent };
  }
  throw new Error('unknown step type: ' + step.type);
}

function stepName(step, i) {
  return String(step.name || (step.type === 'http' ? 'http' : step.type) + (i + 1)).replace(/[^A-Za-z0-9_]/g, '_');
}

// Executes; returns the run record. Approval-gated notify steps are held, not sent.
async function execute(wf, opts) {
  const o = opts || {};
  const deps = o.deps || {};
  const ctx = { input: o.input || {}, workflow: { id: wf.id, name: wf.name } };
  const record = { workflowId: wf.id, trigger: o.trigger || 'manual', status: 'running', steps: [] };
  const runId = await db.insertRun(record);
  ctx.run = { id: String(runId) };
  const entry = (i, name, status, extra) => ({ i, name, status, at: new Date().toISOString(), ...(extra || {}) });
  let failed = null;
  const held = [];

  for (let i = 0; i < wf.steps.length && i < MAX_STEPS; i++) {
    const step = wf.steps[i];
    const name = stepName(step, i + 1);
    if (!whenMatches(step.when, ctx)) {
      record.steps.push(entry(i, name, 'skipped', { reason: 'condition not met' }));
      continue;
    }
    if ((step.type === 'notify' || step.type === 'publish') && wf.approval && o.approved !== true) {
      const preview = step.type === 'publish'
        ? 'Publish the ' + (step.slot || 'next') + ' post'
        : fill(step.text, ctx);
      held.push({ i, name, kind: step.type, text: preview });
      record.steps.push(entry(i, name, 'held', { kind: step.type, text: preview }));
      continue;
    }
    try {
      const res = await runStep(step, ctx, deps);
      const saved = step.save || name;
      ctx[saved] = res;
      ctx.steps = ctx.steps || {};
      ctx.steps[saved] = res;
      record.steps.push(entry(i, name, 'ok', {
        saved,
        value: trimValue(res),
        note: res.ok === false ? 'http ' + res.status + ' (allowed to continue)' : undefined
      }));
    } catch (e) {
      const msg = String((e && e.message) || e).slice(0, 300);
      record.steps.push(entry(i, name, 'failed', { error: msg }));
      failed = msg;
      break;
    }
  }

  record.status = failed ? 'failed' : (held.length ? 'pending_approval' : 'succeeded');
  record.error = failed || '';
  record.finishedAt = new Date().toISOString();
  const out = await db.updateRun(runId, record);
  return { ...(out || record), id: String(runId), held };
}

// Sending what was held, and nothing else: approval must not re-run the research.
async function approve(runId, opts) {
  const o = opts || {};
  const run = await db.getRun(runId);
  if (!run) throw new Error('no such run: ' + runId);
  if (run.status !== 'pending_approval') throw new Error('run ' + runId + ' is ' + run.status + ', not waiting for approval');
  const wf = await db.getWorkflow(run.workflowId);
  if (!wf) throw new Error('the workflow behind this run is gone');
  const deps = o.deps || {};
  const ctx = { input: {}, workflow: { id: wf.id, name: wf.name }, run: { id: String(run.id) }, steps: {} };
  // Rebuild what the run had learned, so held text fills in the same values.
  for (const s of run.steps) {
    if (s.saved && s.value !== undefined) { ctx[s.saved] = s.value; ctx.steps[s.saved] = s.value; }
  }
  const steps = run.steps.map((s) => ({ ...s }));
  let problem = null;
  for (const s of steps) {
    if (s.status !== 'held') continue;
    try {
      const step = wf.steps[s.i];
      if (step.type === 'publish') {
        // The post itself happens now, at approval time, so what the owner approved is
        // the verse and the copy they were shown, not yesterday's.
        if (typeof deps.publish !== 'function') throw new Error('this deployment cannot publish');
        const res = await deps.publish({ slot: step.slot, workflow: ctx.workflow, run: ctx.run });
        if (!res || res.ok === false) {
          throw new Error('publish failed: ' + String((res && (res.error || res.skipped)) || 'no result').slice(0, 200));
        }
        const saved = step.save || s.name;
        const value = { ok: true, slot: res.slot || step.slot || '', ref: res.ref || '', url: res.url || '', links: res.links || {} };
        ctx[saved] = value;
        ctx.steps[saved] = value;
        s.status = 'ok';
        s.value = value;
        s.publishedAt = new Date().toISOString();
        continue;
      }
      const text = fill(step.text, ctx);
      const delivered = await deps.notify(text, { run: ctx.run, workflow: ctx.workflow });
      s.status = 'ok';
      s.delivered = delivered;
      s.sentAt = new Date().toISOString();
    } catch (e) {
      s.status = 'failed';
      s.error = String((e && e.message) || e).slice(0, 300);
      problem = s.error;
      // A step that did not happen makes everything after it a lie: "Posted ..." must not
      // go out when the publish was refused. The remaining held steps stay held and say why.
      const rest = steps.slice(steps.indexOf(s) + 1).filter((x) => x.status === 'held');
      for (const x of rest) {
        x.status = 'skipped';
        x.note = 'not attempted because "' + (s.name || 'an earlier step') + '" failed';
      }
      break;
    }
  }
  const updated = await db.updateRun(run.id, {
    status: problem ? 'failed' : 'approved',
    steps,
    error: problem || '',
    approvedAt: new Date().toISOString(),
    finishedAt: new Date().toISOString()
  });
  return updated;
}

async function reject(runId) {
  const run = await db.getRun(runId);
  if (!run) throw new Error('no such run: ' + runId);
  if (run.status !== 'pending_approval') throw new Error('run ' + runId + ' is ' + run.status + ', not waiting for approval');
  const steps = run.steps.map((s) => (s.status === 'held' ? { ...s, status: 'rejected' } : s));
  return db.updateRun(run.id, { status: 'rejected', steps, finishedAt: new Date().toISOString() });
}

function trimValue(res) {
  const clone = { ...res };
  if (clone.body && typeof clone.body === 'object') {
    const s = JSON.stringify(clone.body);
    clone.body = s.length > 4000 ? JSON.parse(s.slice(0, 4000) + '""}'.slice(0, 0) || '{}') : clone.body;
    if (s.length > 4000) clone.body = s.slice(0, 4000) + '…';
  }
  if (clone.text && clone.text.length > 4000) clone.text = clone.text.slice(0, 4000) + '…';
  return clone;
}

// Which workflows should ride an existing cron slot. Vercel's free plan allows only the
// two runs the pipeline already uses, so workflows attach to those instead of demanding
// a scheduler of their own.
async function dueForSlot(slot) {
  const all = await db.listWorkflows().catch(() => []);
  return all.filter((w) => w.enabled && w.trigger && w.trigger.type === 'cron' && String(w.trigger.slot || '') === slot);
}

// Thin wrappers so a caller never needs to know which table backs a workflow.
const list = () => db.listWorkflows();
const get = (id) => db.getWorkflow(String(id || '').trim().toLowerCase());
const remove = (id) => db.deleteWorkflow(String(id || '').trim().toLowerCase());

module.exports = {
  STEP_TYPES, MAX_STEPS, ALLOWED_HOSTS,
  fill, getPath, whenMatches, validate, save, list, get, remove,
  execute, approve, reject, dueForSlot, runStep
};
