// The workspace layer: documents, research notes and the one-screen "today" view.
//
// Documents are the floor under everything else. Research writes into them, the office view
// reads them back, and the builder refers to them, so all of it lives in one collection
// ('documents') with a kind field rather than four half-stores.
const docs = require('./docs');

const KIND = ['note', 'document', 'research', 'brief', 'proposal', 'list', 'artwork'];
const MAX_BODY = 24000;

function clean(s, max) {
  return String(s == null ? '' : s).replace(/\r\n/g, '\n').slice(0, max || 400);
}

function slugTitle(t) {
  return clean(t, 120).replace(/\s+/g, ' ').trim() || 'Untitled';
}

async function save({ ownerId, title, body, kind, tags, sources, id }) {
  if (!ownerId) throw new Error('a document needs an owner');
  const text = String(body == null ? '' : body);
  if (text.length > MAX_BODY) throw new Error('that document is ' + text.length + ' characters; the limit is ' + MAX_BODY);
  const k = KIND.includes(String(kind)) ? String(kind) : 'document';
  const docId = String(id || docs.newId('doc'));
  const existing = id ? await docs.get('documents', docId) : null;
  const row = {
    id: docId,
    ownerId,
    kind: k,
    title: slugTitle(title || (existing && existing.title)),
    body: text,
    tags: Array.isArray(tags) ? tags.map((t) => clean(t, 40)).slice(0, 8) : (existing && existing.tags) || [],
    sources: Array.isArray(sources) ? sources.slice(0, 12).map((s) => ({
      title: clean(s && s.title, 160), url: clean(s && s.url, 400)
    })).filter((s) => s.url) : (existing && existing.sources) || [],
    version: existing ? (Number(existing.version) || 1) + 1 : 1,
    createdAt: (existing && existing.createdAt) || new Date().toISOString()
  };
  return docs.put('documents', row);
}

async function append({ ownerId, id, title, text }) {
  let doc = id ? await docs.get('documents', id) : null;
  if (!doc && title) {
    const found = await list({ ownerId, q: title, limit: 1 });
    doc = found[0] || null;
  }
  if (!doc) throw new Error('no document matched that id or title');
  if (doc.ownerId !== ownerId) throw new Error('that document belongs to someone else');
  const next = doc.body ? doc.body + '\n\n' + String(text || '') : String(text || '');
  return save({ ownerId, id: doc.id, title: doc.title, body: next, kind: doc.kind, tags: doc.tags, sources: doc.sources });
}

async function list({ ownerId, kind, q, limit, tag }) {
  const rows = (await docs.list('documents', { ownerId })) || [];
  const needle = clean(q, 120).toLowerCase();
  return rows
    .filter((d) => (kind ? d.kind === kind : true))
    .filter((d) => (tag ? (d.tags || []).includes(tag) : true))
    .filter((d) => (needle ? (String(d.title) + ' ' + String(d.body)).toLowerCase().includes(needle) : true))
    .sort((a, b) => String(b.updatedAt || b.createdAt).localeCompare(String(a.updatedAt || a.createdAt)))
    .slice(0, Math.min(Number(limit) || 10, 50));
}

async function read({ ownerId, id, title }) {
  if (id) {
    const d = await docs.get('documents', id);
    return d && d.ownerId === ownerId ? d : null;
  }
  const found = await list({ ownerId, q: title, limit: 1 });
  return found[0] || null;
}

async function remove({ ownerId, id }) {
  const d = await docs.get('documents', id);
  if (!d || d.ownerId !== ownerId) return false;
  await docs.del('documents', id);
  return true;
}

// A research note is a document that remembers where each claim came from, which is the one
// thing a chat answer cannot do: it survives the conversation.
async function research({ ownerId, question, findings, sources }) {
  if (!clean(findings, 40)) throw new Error('a research note needs findings');
  const src = (Array.isArray(sources) ? sources : []).map((s) => ({
    title: clean(s && (s.title || s.name), 160),
    url: clean(s && (s.url || s.link), 400)
  })).filter((s) => /^https?:\/\//i.test(s.url));
  return save({
    ownerId,
    kind: 'research',
    title: clean(question, 120) || 'Research note',
    body: String(findings),
    tags: ['research'],
    sources: src
  });
}

// One deterministic screen: no model, no guessing, just what is true right now.
async function officeToday({ ownerId, reminders, unread, lastPost, pending }) {
  const today = new Date().toISOString().slice(0, 10);
  const mine = (await docs.list('reminders', {})).filter((r) => r && r.status === 'pending');
  const due = mine.filter((r) => String(r.due || r.when || '').slice(0, 10) <= today);
  const recent = await list({ ownerId, limit: 5 });
  return {
    date: today,
    reminders: { open: mine.length, dueNow: due.length, next: due.slice(0, 5).map((r) => ({ id: r.id, text: clean(r.text || r.title, 120), due: r.due || r.when || null })) },
    email: { unread: Number(unread) || 0 },
    posting: lastPost || null,
    pendingActions: pending || [],
    documents: recent.map((d) => ({ id: d.id, title: d.title, kind: d.kind, updatedAt: d.updatedAt || d.createdAt }))
  };
}

module.exports = { save, append, list, read, remove, research, officeToday, KIND, MAX_BODY };
