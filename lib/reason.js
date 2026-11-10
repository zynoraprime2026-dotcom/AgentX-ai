// A reasoning layer, in the only form that survives contact with this pipeline: rules over facts,
// forward chaining, and an explanation for every decision.
//
// There are no probabilities here and no model in the loop. The point is not to sound clever; it
// is that when AgentX decides "change the content, not the time", the facts and the rule that
// produced it can be read back and argued with. Anything a model adds on top of this would have
// to be judged against these rules, not instead of them.
//
// Facts come in, derived facts accumulate, decisions come out. Plain data, no I/O, so every rule
// can be tested without a Page, a token or a clock.

// Each rule: { id, priority, when(facts) -> derived fact|null, decide(facts) -> decision|null }
// A rule that fires on `when` adds its fact; a decision is only produced when the fact is present,
// which is what makes the reasoning traceable rather than a pile of ifs.
const RULES = [
  {
    id: 'token-expiring',
    priority: 90,
    when: (f) => {
      const t = f.token || null;
      if (!t || t.valid === false) return null;
      if (typeof t.daysLeft !== 'number') return null;
      if (t.daysLeft > 14) return null;
      return { fact: 'instagram-token-due', value: t.daysLeft };
    },
    decide: (f) => ({
      action: 'refresh the Instagram token',
      why: 'it has ' + f.token.daysLeft + ' days left; a refresh now costs nothing, a failed post later costs the day',
      rule: 'token-expiring',
      how: 'GET /api/cron/ig-refresh'
    })
  },
  {
    id: 'slot-missing',
    priority: 80,
    when: (f) => {
      const overdue = slots(f).filter((s) => s.overdue && !s.posted);
      return overdue.length ? { fact: 'slot-missing', value: overdue.map((s) => s.slot) } : null;
    },
    decide: (f) => {
      const lost = slots(f).filter((s) => s.overdue && !s.posted);
      return {
        action: 'publish ' + lost.map((s) => s.slot).join(' and ') + ' now',
        why: lost.map((s) => s.slot + ' was due at ' + (s.due || 'its time') + ' and there is no post for it today').join('; '),
        rule: 'slot-missing',
        how: 'GET /api/cron/daily-post?slot=' + (lost[0] && lost[0].slot)
      };
    }
  },
  {
    id: 'wrong-page',
    priority: 95,
    when: (f) => {
      const bad = slots(f).filter((s) => s.posted && s.want && s.page && s.want.toLowerCase() !== s.page.toLowerCase());
      return bad.length ? { fact: 'post-misrouted', value: bad.map((s) => s.slot) } : null;
    },
    decide: (f) => {
      const bad = slots(f).filter((s) => s.posted && s.want && s.page && s.want.toLowerCase() !== s.page.toLowerCase());
      return {
        action: 'fix the schedule before the next run',
        why: bad.map((s) => s.slot + ' went to ' + s.page + ' instead of ' + s.want).join('; '),
        rule: 'wrong-page',
        how: 'POST /api/admin/daily-schedule'
      };
    }
  },
  {
    id: 'engagement-flat',
    priority: 60,
    when: (f) => {
      const e = f.engagement || null;
      if (!e || typeof e.observed !== 'number' || typeof e.mean !== 'number') return null;
      if (e.observed < 12 || e.mean >= 1) return null;
      return { fact: 'engagement-flat', value: e.mean };
    },
    decide: (f) => ({
      action: 'change the content, not the posting time',
      why: f.engagement.observed + ' posts averaging ' + f.engagement.mean.toFixed(2) + ' engagement each: the schedule is working and the reach is not',
      rule: 'engagement-flat',
      how: 'a series, a format change or a Page with an audience'
    })
  },
  {
    id: 'learning-stale',
    priority: 40,
    when: (f) => {
      const w = f.weights || null;
      if (!w || !w.at) return null;
      const age = (Date.now() - new Date(w.at).getTime()) / 86400000;
      if (!(age > 8)) return null;
      return { fact: 'learning-stale', value: Math.round(age) };
    },
    decide: (f) => ({
      action: 'run the weekly review again',
      why: 'the rotation is still using weights from ' + Math.round((Date.now() - new Date(f.weights.at).getTime()) / 86400000) + ' days ago',
      rule: 'learning-stale',
      how: 'GET /api/learn-review?dry=0'
    })
  },
  {
    // Fires off the fact the learning review derives, not off raw data: the two systems agree
    // about what counts as evidence instead of each having its own threshold.
    id: 'apply-learning',
    priority: 30,
    when: (f) => (f.facts && f.facts['learning-ready'] ? { fact: 'learning-apply', value: true } : null),
    decide: () => ({
      action: 'let the review move the rotation',
      why: 'there is enough engagement behind the numbers now for a ranking to mean something',
      rule: 'apply-learning',
      how: 'GET /api/learn-review?dry=0'
    })
  },
  {
    id: 'collect-evidence',
    priority: 10,
    when: (f) => {
      const e = f.engagement || null;
      if (!e || typeof e.observed !== 'number') return null;
      if (e.observed >= 12) return null;
      return { fact: 'evidence-thin', value: e.observed };
    },
    decide: (f) => ({
      action: 'keep posting and do not tune anything yet',
      why: 'only ' + f.engagement.observed + ' posts have numbers; ranking verses on that is guessing',
      rule: 'collect-evidence',
      how: 'nothing to do'
    })
  }
];

function slots(f) {
  const out = [];
  const claims = (f.claims && typeof f.claims === 'object') ? f.claims : {};
  const schedule = (f.schedule && typeof f.schedule === 'object') ? f.schedule : {};
  const due = (f.due && typeof f.due === 'object') ? f.due : {};
  for (const slot of ['morning', 'evening', 'promo']) {
    const claim = claims[slot] || null;
    const posted = Boolean(claim && claim.date && claim.date === f.dateKey);
    out.push({
      slot,
      posted,
      page: posted ? String(claim.page || '') : '',
      want: String((schedule[slot] && schedule[slot].page) || ''),
      due: due[slot] || '',
      overdue: Boolean(due[slot] && f.now && new Date(f.now).getTime() > new Date(due[slot]).getTime())
    });
  }
  return out;
}

// Forward chaining: rules add facts, added facts can enable other rules, and the loop stops when
// nothing new arrives. Bounded, because a rule cycle would otherwise be an infinite loop.
function infer(facts) {
  const f = { ...(facts || {}) };
  f.facts = { ...(f.facts || {}) };
  const fired = [];
  for (let pass = 0; pass < 5; pass++) {
    let added = false;
    for (const rule of RULES) {
      if (f.facts[rule.id]) continue;
      let got = null;
      try { got = rule.when(f); } catch (e) { got = null; }
      if (!got || !got.fact) continue;
      f.facts[rule.id] = true;
      f.facts[got.fact] = got.value === undefined ? true : got.value;
      fired.push(rule.id);
      added = true;
    }
    if (!added) break;
  }
  return { facts: f.facts, fired };
}

function decide(facts) {
  const { facts: derived, fired } = infer(facts);
  const f = { ...(facts || {}), facts: derived };
  const out = [];
  for (const rule of RULES) {
    if (!derived[rule.id]) continue;
    let d = null;
    try { d = rule.decide(f); } catch (e) { d = null; }
    if (d) out.push({ ...d, priority: rule.priority });
  }
  out.sort((a, b) => b.priority - a.priority);
  return { decisions: out, fired, facts: derived };
}

function explain(result) {
  const list = (result && result.decisions) || [];
  if (!list.length) return 'Nothing needs a decision: every slot posted where it should, and the token and the numbers are within range.';
  return list.map((d, i) => (i + 1) + '. ' + d.action + ' — ' + d.why).join('\n');
}

module.exports = { RULES, infer, decide, explain, slots };
