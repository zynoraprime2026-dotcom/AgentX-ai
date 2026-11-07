// Inbox reading: IMAP against Gmail with an app password.
//
// Sending goes out through an HTTPS API (Brevo/Resend) because Render free blocks SMTP
// ports. Reading has no such shortcut: a mailbox needs IMAP, so this lane is only open
// when the owner supplies GMAIL_USER + GMAIL_APP_PASSWORD. Google app passwords are the
// one route a phone user can complete without OAuth plumbing.
//
// Nothing here writes to the mailbox: FETCH uses BODY.PEEK so reading does not flip a
// message to seen, and no flags are set anywhere.

const tls = require('tls');

function cfg() {
  const user = String(process.env.GMAIL_USER || process.env.IMAP_USER || '').trim();
  const pass = String(process.env.GMAIL_APP_PASSWORD || process.env.IMAP_PASS || '').trim().replace(/\s+/g, '');
  const host = String(process.env.IMAP_HOST || '').trim() ||
    ((user.endsWith('@gmail.com') || user.endsWith('@googlemail.com')) ? 'imap.gmail.com' : '');
  const port = Number(process.env.IMAP_PORT) || 993;
  return { user, pass, host, port };
}

function configured() {
  const c = cfg();
  return Boolean(c.user && c.pass && c.host);
}

// Line-oriented IMAP: one reader feeds a queue, commands consume lines until their tag.
function connect() {
  const c = cfg();
  return new Promise((resolve, reject) => {
    const sock = tls.connect({ host: c.host, port: c.port, servername: c.host }, () => {});
    let leftover = '';
    const queue = [];
    const waiters = [];
    let closed = false;

    const push = (line) => {
      const w = waiters.shift();
      if (w) w(line); else queue.push(line);
    };
    const nextLine = (ms = 20000) => new Promise((res, rej) => {
      if (queue.length) return res(queue.shift());
      if (closed) return rej(new Error('connection closed'));
      const t = setTimeout(() => {
        const i = waiters.indexOf(wrapper);
        if (i >= 0) waiters.splice(i, 1);
        rej(new Error('imap timeout'));
      }, ms);
      const wrapper = (line) => { clearTimeout(t); res(line); };
      waiters.push(wrapper);
    });

    sock.on('data', (d) => {
      leftover += d.toString('utf8');
      let nl;
      while ((nl = leftover.indexOf('\r\n')) >= 0) {
        push(leftover.slice(0, nl));
        leftover = leftover.slice(nl + 2);
      }
    });
    sock.on('error', (e) => { closed = true; reject(e); for (const w of waiters.splice(0)) w(''); });
    sock.on('close', () => { closed = true; });

    let tagN = 0;
    const command = async (text) => {
      const tag = 'p' + (++tagN);
      sock.write(tag + ' ' + text + '\r\n');
      const lines = [];
      for (;;) {
        const line = await nextLine();
        if (line.startsWith(tag + ' ')) {
          const status = /^[A-Z]+/.exec(line.slice(tag.length + 1))[0];
          return { status, lines, line };
        }
        lines.push(line);
      }
    };

    sock.once('secureConnect', async () => {
      try {
        const greeting = await nextLine(15000);
        if (!/^\* OK/i.test(greeting)) throw new Error('no IMAP greeting');
        const login = await command('LOGIN "' + c.user.replace(/"/g, '') + '" "' + c.pass.replace(/"/g, '') + '"');
        if (login.status !== 'OK') throw new Error('login rejected — Gmail refused the app password');
        const sel = await command('SELECT INBOX');
        if (sel.status !== 'OK') throw new Error('cannot open INBOX');
        resolve({
          command,
          logout: () => { try { sock.write('p999 LOGOUT\r\n'); } catch (e) {} try { sock.end(); } catch (e) {} }
        });
      } catch (e) { try { sock.destroy(); } catch (x) {} reject(e); }
    });
  });
}

const decodeMime = (s) => {
  let out = String(s || '').replace(/\r?\n\s+/g, ' ').trim();
  out = out.replace(/\?=\s+=\?/g, '?==?');           // re-join folded encoded words
  out = out.replace(/=\?([^?]+)\?([BQbq])\?([^?]*)\?=/g, (mm, cs, enc, data) => {
    try {
      if (enc.toUpperCase() === 'B') return Buffer.from(data, 'base64').toString('utf8');
      return Buffer.from(data.replace(/_/g, ' ').replace(/=([0-9A-F]{2})/gi, (m, h) => String.fromCharCode(parseInt(h, 16))), 'latin1').toString('utf8');
    } catch (e) { return mm; }
  });
  return out;
};

const field = (block, name) => {
  const re = new RegExp('^' + name + ':\\s*(.*)$', 'im');
  const m = re.exec(block);
  return m ? decodeMime(m[1]) : '';
};

async function recent(limit) {
  const n = Math.min(Math.max(Number(limit) || 10, 1), 25);
  const s = await connect();
  try {
    const res = await s.command('FETCH 1:* (UID FLAGS BODY.PEEK[HEADER.FIELDS (FROM SUBJECT DATE)])');
    const blocks = [];
    let cur = null;
    for (const line of res.lines) {
      if (/^\* \d+ FETCH/i.test(line)) { cur = { head: line, body: '' }; blocks.push(cur); }
      else if (cur) { cur.body += line + '\n'; }
    }
    const rows = blocks.map((b) => ({
      uid: (/UID (\d+)/i.exec(b.head) || [])[1] || '',
      from: field(b.body, 'From'),
      subject: field(b.body, 'Subject'),
      date: field(b.body, 'Date'),
      unread: !/\\Seen/.test(b.head)
    })).filter((r) => r.subject || r.from);
    return rows.slice(-n).reverse();
  } finally { s.logout(); }
}

// One message's body: prefers text/plain, falls back to a stripped HTML part. Capped so a
// newsletter cannot eat the context window.
async function readOne(uid) {
  const id = String(uid || '').replace(/[^0-9]/g, '');
  if (!id) throw new Error('a message id (uid) is required — call check_inbox first');
  const s = await connect();
  try {
    const res = await s.command('UID FETCH ' + id + ' (FLAGS BODY.PEEK[HEADER.FIELDS (FROM SUBJECT DATE)] BODY.PEEK[TEXT])');
    const head = res.lines.filter((l) => !/^\* /.test(l)).join('\n');
    let body = res.lines.filter((l) => !/^\* /.test(l) && l.trim() !== ')').join('\n');
    body = body.replace(/^--[-=_a-zA-Z0-9.]+$/gm, '');
    // pick the text part, then everything after its first blank line
    const part = (/content-type:\s*text\/plain[\s\S]*?(?=\ncontent-type:|$)/i.exec(body) ||
                  /content-type:\s*text\/html[\s\S]*?(?=\ncontent-type:|$)/i.exec(body) ||
                  [body])[0];
    const segs = part.split(/\r?\n\r?\n/);
    const payload = (segs.length > 1 ? segs.slice(1).join('\n') : part);
    const text = payload
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/=\r?\n/g, '')
      .replace(/=([0-9A-F]{2})/gi, (m, h) => String.fromCharCode(parseInt(h, 16)))
      .replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')
      .replace(/[ \t]+/g, ' ')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
    return {
      from: field(head, 'From'),
      subject: field(head, 'Subject'),
      date: field(head, 'Date'),
      unread: !/\\Seen/.test(head),
      text: text.slice(0, 1500)
    };
  } finally { s.logout(); }
}

// Move one message to Gmail's Trash. Recoverable for 30 days, which is why "delete" here
// is a move and never an expunge-only destruction.
async function trash(uid) {
  const id = String(uid || '').replace(/[^0-9]/g, '');
  if (!id) throw new Error('a message id (uid) is required — call check_inbox first');
  const s = await connect();
  try {
    const cp = await s.command('UID COPY ' + id + ' "[Gmail]/Trash"');
    if (cp.status !== 'OK') throw new Error('could not move the message to Trash');
    await s.command('UID STORE ' + id + ' +FLAGS.SILENT (\\Deleted)');
    await s.command('UID EXPUNGE ' + id);
    return { moved: true };
  } finally { s.logout(); }
}

async function verifyInbox() {
  const c = cfg();
  const rows = await recent(1);
  return { detail: 'inbox reachable · ' + c.user + (rows[0] ? ' · latest: "' + String(rows[0].subject).slice(0, 48) + '"' : '') };
}

module.exports = { configured, recent, readOne, trash, verifyInbox, cfg };
