// Tiny document store used by the AgentX feature suite (knowledge, reminders,
// analytics counters, triggers, billing requests).
//
// Everything lives in one table, `agx_docs`, with a jsonb body. That means:
//   - no schema migrations as features grow,
//   - the same code path works on Postgres and on the JSON-file fallback the
//     app already uses when DATABASE_URL is missing.
const path = require('path');
const db = require('../db');

const TABLE = 'agx_docs';
let ensured = false;

function pool() {
  return db.poolRef || null;
}

async function ensure() {
  const p = pool();
  if (!p || ensured) return;
  await p.query(`CREATE TABLE IF NOT EXISTS ${TABLE} (
    tbl text NOT NULL,
    id text NOT NULL,
    data jsonb NOT NULL,
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (tbl, id)
  )`);
  ensured = true;
}

function file(name) {
  return path.join(db.DATA_DIR, 'docs-' + name + '.json');
}

function readFile(tbl) {
  return db.readJson(file(tbl), {});
}

function writeFile(tbl, all) {
  db.writeJson(file(tbl), all);
}

function matches(doc, filter) {
  if (!filter) return true;
  return Object.entries(filter).every(([k, v]) => {
    if (v === undefined) return true;
    const got = k.split('.').reduce((o, part) => (o == null ? o : o[part]), doc);
    return got === v;
  });
}

const store = {
  async put(tbl, doc) {
    if (!doc || !doc.id) throw new Error('document needs an id');
    const row = Object.assign({}, doc, { updatedAt: new Date().toISOString() });
    const p = pool();
    if (p) {
      await ensure();
      await p.query(
        `INSERT INTO ${TABLE} (tbl, id, data, updated_at) VALUES ($1,$2,$3,now())
         ON CONFLICT (tbl, id) DO UPDATE SET data = $3, updated_at = now()`,
        [tbl, String(doc.id), row]
      );
      return row;
    }
    const all = readFile(tbl);
    all[doc.id] = row;
    writeFile(tbl, all);
    return row;
  },

  async get(tbl, id) {
    const p = pool();
    if (p) {
      await ensure();
      const r = await p.query(`SELECT data FROM ${TABLE} WHERE tbl=$1 AND id=$2`, [tbl, String(id)]);
      return r.rows[0] ? r.rows[0].data : null;
    }
    return readFile(tbl)[id] || null;
  },

  async del(tbl, id) {
    const p = pool();
    if (p) {
      await ensure();
      await p.query(`DELETE FROM ${TABLE} WHERE tbl=$1 AND id=$2`, [tbl, String(id)]);
      return true;
    }
    const all = readFile(tbl);
    delete all[id];
    writeFile(tbl, all);
    return true;
  },

  async list(tbl, filter) {
    const p = pool();
    if (p) {
      await ensure();
      const r = await p.query(`SELECT data FROM ${TABLE} WHERE tbl=$1`, [tbl]);
      const docs = r.rows.map((x) => x.data);
      return docs.filter((d) => matches(d, filter));
    }
    return Object.values(readFile(tbl)).filter((d) => matches(d, filter));
  },

  async count(tbl, filter) {
    return (await store.list(tbl, filter)).length;
  },

  // append to a bounded list kept inside one document (used for analytics rolls)
  async push(tbl, id, field, item, max) {
    const doc = (await store.get(tbl, id)) || { id };
    const list = Array.isArray(doc[field]) ? doc[field] : [];
    list.push(item);
    doc[field] = max ? list.slice(-max) : list;
    return store.put(tbl, doc);
  }
};

module.exports = store;
module.exports.newId = (prefix) => prefix + '_' + Math.random().toString(36).slice(2, 10);
