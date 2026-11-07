// Email connector: plain SMTP, because every provider offers it and it needs no OAuth
// dance. Gmail works with an app password (16 characters, spaces ignored), which is the
// route most owners can actually complete on a phone.
//
// Nothing here is sent until the owner supplies SMTP_USER and SMTP_PASS; until then
// configured() returns false and the tools say so plainly instead of pretending.

// Two ways out: an HTTPS email API, or plain SMTP. Render's free instances block
// outbound SMTP ports (25/465/587), so on that host only the API route actually connects
// and the SMTP attempt ends in a connection timeout that looks like a bad password.
function provider() {
  if (String(process.env.BREVO_API_KEY || '').trim()) return 'brevo';
  if (String(process.env.RESEND_API_KEY || '').trim()) return 'resend';
  if (cfg().host && cfg().user && cfg().pass) return 'smtp';
  return '';
}

function cfg() {
  const host = String(process.env.SMTP_HOST || '').trim();
  const user = String(process.env.SMTP_USER || '').trim();
  const pass = String(process.env.SMTP_PASS || '').trim();
  const rawPort = Number(String(process.env.SMTP_PORT || '').trim()) || 0;
  const port = rawPort || 587;
  const from = String(process.env.MAIL_FROM || '').trim() || user;
  return { host, user, pass, port, from, secure: port === 465 };
}

function configured() {
  return Boolean(provider());
}

function transport() {
  const c = cfg();
  const nodemailer = require('nodemailer');
  return {
    mailer: nodemailer.createTransport({
      host: c.host,
      port: c.port,
      secure: c.secure,
      auth: { user: c.user, pass: c.pass.replace(/\s+/g, '') },
      connectionTimeout: 12000,
      greetingTimeout: 10000,
      socketTimeout: 20000
    }),
    from: c.from
  };
}

async function verifyMail() {
  const p = provider();
  if (!p) throw new Error('no email provider set: add BREVO_API_KEY, RESEND_API_KEY, or SMTP_HOST+SMTP_USER+SMTP_PASS');
  if (p === 'brevo') {
    const r = await fetch('https://api.brevo.com/v3/account', {
      headers: { 'api-key': String(process.env.BREVO_API_KEY).trim(), Accept: 'application/json', 'User-Agent': 'AgentX/1.0' },
      signal: AbortSignal.timeout(12000)
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error('brevo rejected the key: ' + String((d.message || r.status)).slice(0, 100));
    return { detail: 'Brevo ready · ' + (d.email || 'account ok') + (d.plan && d.plan.length ? ' · ' + d.plan[0].type : '') };
  }
  if (p === 'resend') {
    const r = await fetch('https://api.resend.com/domains', {
      headers: { Authorization: 'Bearer ' + String(process.env.RESEND_API_KEY).trim(), 'User-Agent': 'AgentX/1.0' },
      signal: AbortSignal.timeout(12000)
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error('resend rejected the key: ' + String((d.message || r.status)).slice(0, 100));
    const n = (d.data || []).length;
    return { detail: 'Resend ready · ' + n + ' domain' + (n === 1 ? '' : 's') + ' verified' };
  }
  const { mailer, from } = transport();
  try {
    await mailer.verify();
  } catch (e) {
    const msg = String(e.message || e);
    if (/timeout|ETIMEDOUT|ECONNREFUSED|EHOSTUNREACH/i.test(msg)) {
      throw new Error('SMTP cannot connect from this host (Render free blocks ports 25/465/587). Use BREVO_API_KEY instead');
    }
    throw new Error('smtp refused the login: ' + msg.slice(0, 110));
  }
  return { detail: 'SMTP ready · sends as ' + from };
}

const EMAIL_RE = /^[^\s@,;<>"]+@[^\s@,;<>"]+\.[A-Za-z]{2,}$/;

function cleanAddress(raw) {
  const a = String(raw || '').trim().replace(/^mailto:/i, '');
  if (!EMAIL_RE.test(a)) throw new Error('"' + String(raw).slice(0, 60) + '" is not a valid email address');
  return a;
}

// A cap on recipients per call: a mistaken instruction should never turn into a mailshot.
async function sendMail(input) {
  if (!configured()) throw new Error('email is not connected yet: missing SMTP_USER or SMTP_PASS');
  const to = (Array.isArray(input.to) ? input.to : String(input.to || '').split(/[,;]/)).filter(Boolean).map(cleanAddress);
  if (!to.length) throw new Error('at least one recipient is required');
  if (to.length > 3) throw new Error('too many recipients in one send (' + to.length + '); send to at most 3 at a time');
  const subject = String(input.subject || '').trim().slice(0, 180);
  if (!subject) throw new Error('a subject is required');
  const text = String(input.text || input.body || '').trim();
  const html = String(input.html || '').trim();
  if (!text && !html) throw new Error('the message body is empty');
  const p = provider();
  const replyTo = input.replyTo ? cleanAddress(input.replyTo) : undefined;
  const fromAddr = cfg().from || String(process.env.MAIL_FROM || '').trim() || String(process.env.SMTP_USER || '').trim();
  if (p === 'brevo' || p === 'resend') {
    if (!fromAddr) throw new Error('set MAIL_FROM to the verified sender address');
    const html = String(input.html || '').trim();
    const res = p === 'brevo'
      ? await fetch('https://api.brevo.com/v3/smtp/email', {
          method: 'POST',
          headers: { 'api-key': String(process.env.BREVO_API_KEY).trim(), 'Content-Type': 'application/json', Accept: 'application/json' },
          body: JSON.stringify({ sender: { email: fromAddr }, to: to.map((e) => ({ email: e })), subject, textContent: text || undefined, htmlContent: html || undefined, replyTo: replyTo ? { email: replyTo } : undefined }),
          signal: AbortSignal.timeout(20000)
        })
      : await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: { Authorization: 'Bearer ' + String(process.env.RESEND_API_KEY).trim(), 'Content-Type': 'application/json' },
          body: JSON.stringify({ from: fromAddr, to, subject, text: text || undefined, html: html || undefined, reply_to: replyTo }),
          signal: AbortSignal.timeout(20000)
        });
    const d = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(p + ' refused the send: ' + String((d.message || d.error || res.status)).slice(0, 140));
    return { sent: true, to, subject, id: d.messageId || d.id || null, via: p };
  }
  const { mailer, from } = transport();
  const info = await mailer.sendMail({
    from,
    to: to.join(', '),
    subject,
    text: text || undefined,
    html: html || undefined,
    replyTo
  });
  return { sent: true, to, subject, id: info.messageId || null };
}

module.exports = { configured, verifyMail, sendMail, cfg, cleanAddress, provider };
