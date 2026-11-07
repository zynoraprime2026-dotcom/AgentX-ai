// Email connector: plain SMTP, because every provider offers it and it needs no OAuth
// dance. Gmail works with an app password (16 characters, spaces ignored), which is the
// route most owners can actually complete on a phone.
//
// Nothing here is sent until the owner supplies SMTP_USER and SMTP_PASS; until then
// configured() returns false and the tools say so plainly instead of pretending.

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
  const c = cfg();
  return Boolean(c.host && c.user && c.pass);
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
  if (!configured()) throw new Error('set SMTP_HOST, SMTP_USER and SMTP_PASS');
  const { mailer, from } = transport();
  try {
    await mailer.verify();
  } catch (e) {
    throw new Error('smtp refused the login: ' + String(e.message || e).slice(0, 110));
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
  const { mailer, from } = transport();
  const replyTo = input.replyTo ? cleanAddress(input.replyTo) : undefined;
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

module.exports = { configured, verifyMail, sendMail, cfg, cleanAddress };
