// The watchdog is the audit on a timer: same findings, but it tells the owner instead of
// waiting to be asked, and it says each problem once a day so a fault that lasts all day is
// one message rather than one every run.
//
// Kept apart from the route so the once-a-day rule can be tested without a server: the audit,
// the alert sender and the store are all handed in.

const LEVELS_WORTH_WAKING_SOMEONE = new Set(['missing', 'wrong_page']);
const STATE_KEY = 'watchdog_alerts';

function worth(level) {
  // unknown_page means a post went out but recorded no Page. That is a warning to read, not a
  // reason to wake the owner, and the audit already reports it.
  return LEVELS_WORTH_WAKING_SOMEONE.has(level);
}

// state: what was already alerted, {date, slots:{'morning:missing': iso}}
function plan(findings, state, slot, dateKey) {
  const scope = String(slot || '').trim();
  const worthy = (findings || []).filter((f) => worth(f.level) && (!scope || f.slot === scope));
  // The store hands back the raw string it was given, so the state is parsed here. Getting this
  // wrong means every run repeats the same alert, which is the failure this file exists to avoid.
  let parsed = state;
  if (typeof parsed === 'string') { try { parsed = JSON.parse(parsed); } catch (e) { parsed = null; } }
  let current = parsed && typeof parsed === 'object' ? parsed : {};
  if (current.date !== dateKey) current = { date: dateKey, slots: {} };
  current.slots = current.slots || {};
  const fresh = worthy.filter((f) => !current.slots[f.slot + ':' + f.level]);
  const next = { date: dateKey, slots: { ...current.slots } };
  for (const f of fresh) next.slots[f.slot + ':' + f.level] = new Date().toISOString();
  return { worthy, fresh, next, keys: fresh.map((f) => f.slot + ':' + f.level) };
}

async function run({ slot, audit, readState, writeState, alert, describe } = {}) {
  const found = await audit();
  const dateKey = found && found.date ? found.date : new Date().toISOString().slice(0, 10);
  let state = null;
  try { state = await readState(STATE_KEY); } catch (e) { state = null; }
  const p = plan(found && found.findings, state, slot, dateKey);

  let sendResult = null;
  let sendError = '';
  let delivered = false;
  if (p.fresh.length) {
    const text = 'AgentX watchdog\n' + (describe ? describe(p.fresh) : p.fresh.map((f) => f.detail).join('\n'));
    try { sendResult = await alert(text); delivered = Boolean(sendResult && sendResult.length); }
    catch (e) { sendError = String((e && e.message) || e).slice(0, 160); }
    // Only a delivered alert is recorded. A failed send leaves the state alone so the next
    // check tries again instead of pretending the owner was told.
    if (delivered) {
      try { await writeState(STATE_KEY, JSON.stringify(p.next)); } catch (e) { /* repeating is the safe direction */ }
    }
  }
  return {
    date: dateKey,
    ok: p.worthy.length === 0,
    findings: p.worthy,
    alerted: delivered ? p.keys : [],
    alertSent: delivered,
    alertError: sendError || undefined,
    summary: describe ? describe(p.worthy) : ''
  };
}

module.exports = { run, plan, worth, STATE_KEY };
