// The daily audit: did each slot post what it was supposed to, where it was supposed to?
//
// This exists because a whole day once went to the wrong Page while every run reported
// success: the claim was written, the post existed, and nobody looked at the pair together.
// The audit is deliberately plain data in, plain findings out, so it can be tested and
// read without a database.

const SLOT_HOUR_UTC = { morning: 6, evening: 19.5 };
const GRACE_MINUTES = 45;

function slotDueAt(slot, dateKey) {
  const hour = SLOT_HOUR_UTC[slot];
  if (hour === undefined) return null;
  const h = Math.floor(hour);
  const m = Math.round((hour - h) * 60);
  return new Date(dateKey + 'T' + String(h).padStart(2, '0') + ':' + String(m).padStart(2, '0') + ':00Z');
}

function isSameDay(dateKey, d) {
  return String(dateKey || '') === String(d || '');
}

// claims: { morning: record|null, evening: record|null, hadith: record|null }
// schedule: { morning: {page}, evening: {page} }
function auditSlots({ now, dateKey, schedule, claims }) {
  const when = now ? new Date(now) : new Date();
  const today = dateKey || when.toISOString().slice(0, 10);
  const sched = schedule || {};
  const cl = claims || {};
  const findings = [];

  for (const slot of ['morning', 'evening']) {
    const due = slotDueAt(slot, today);
    const claim = cl[slot] || null;
    const want = (sched[slot] && sched[slot].page) || '';
    const overdue = due && when.getTime() > due.getTime() + GRACE_MINUTES * 60000;

    if (!claim || !isSameDay(claim.date, today)) {
      if (overdue) {
        findings.push({
          slot,
          level: 'missing',
          page: want,
          detail: 'no ' + slot + ' post today' + (claim && claim.date ? ', last one was ' + claim.date : '')
        });
      }
      continue;
    }

    // The pair that matters: the Page the slot is configured for, and the Page the post
    // actually landed on.
    const posted = String(claim.page || '').trim();
    if (want && posted && posted.toLowerCase() !== want.toLowerCase()) {
      findings.push({
        slot,
        level: 'wrong_page',
        page: want,
        postedOn: posted,
        ref: claim.ref || '',
        detail: 'the ' + slot + ' post went to ' + posted + ' instead of ' + want
      });
    }
    if (want && !posted) {
      findings.push({
        slot,
        level: 'unknown_page',
        page: want,
        ref: claim.ref || '',
        detail: 'the ' + slot + ' post (' + (claim.ref || 'unknown') + ') did not record which Page it used'
      });
    }
  }

  const hadith = cl.hadith || null;
  if (hadith && isSameDay(hadith.date, today)) {
    const want = (sched[hadith.slot] && sched[hadith.slot].page) || '';
    const posted = String(hadith.page || '').trim();
    if (want && posted && posted.toLowerCase() !== want.toLowerCase()) {
      findings.push({
        slot: 'hadith',
        level: 'wrong_page',
        page: want,
        postedOn: posted,
        ref: hadith.ref || '',
        detail: 'the hadith went to ' + posted + ' instead of ' + want
      });
    }
  }

  return { date: today, ok: !findings.some((f) => f.level !== 'unknown_page'), findings };
}

function describe(findings) {
  if (!findings || !findings.length) return '';
  return findings.map((f) => {
    const icon = f.level === 'missing' ? 'missing:' : f.level === 'wrong_page' ? 'wrong page:' : 'unrecorded:';
    return icon + ' ' + f.detail;
  }).join('\n');
}

module.exports = { auditSlots, describe, slotDueAt, SLOT_HOUR_UTC, GRACE_MINUTES };
