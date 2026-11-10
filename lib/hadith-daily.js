// The daily hadith post: a second daily piece that carries a narration rather than an ayah.
//
// Three rules, all of them deliberate:
//
//   1. The Arabic and the English are FETCHED from ilm-api by collection and number. They
//      are never written by a model, because a composed hadith is a fabrication of the
//      Prophet's words and no caption is worth that risk.
//   2. Only references that were checked to exist and carry both languages ship in
//      data/daily_hadith.json. An entry that fails to fetch is skipped, not faked.
//   3. One hadith a day, on whichever Page owns that day, claimed once, so it cannot
//      repeat or double-post beside the ayah.
const fs = require('fs');
const path = require('path');
const db = require('../db');

const HADITH = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'daily_hadith.json'), 'utf8'));
const ENTRIES = HADITH.entries || [];
const CLAIM_KEY = 'hadith_last';
const CURSOR_KEY = 'hadith_cursor';
const API = 'https://ilm-api.vercel.app/web';

const todayKey = (d) => new Date(d || Date.now()).toISOString().slice(0, 10);
const dayIndex = (d) => Math.floor(new Date(d || Date.now()).getTime() / 86400000);

function parseRecord(raw) {
  if (!raw) return null;
  if (typeof raw === 'object') return raw;
  try { return JSON.parse(String(raw)); } catch (e) { return null; }
}

async function lastPost() {
  return parseRecord(await db.getSocial(CLAIM_KEY).catch(() => ''));
}

async function cursor() {
  const rec = parseRecord(await db.getSocial(CURSOR_KEY).catch(() => ''));
  return rec && typeof rec.n === 'number' ? rec.n : null;
}

// The next reference in rotation. A cursor beats arithmetic: a day-based index repeats the
// same entry every list-length days, and a manual post would repeat the morning's hadith.
async function nextIndex() {
  const n = await cursor();
  if (typeof n === 'number') return (n + 1) % ENTRIES.length;
  return dayIndex() % ENTRIES.length;
}

async function advanceCursor(n) {
  await db.putSocial(CURSOR_KEY, JSON.stringify({ n, at: new Date().toISOString() }));
  return n;
}

async function fetchHadith(entry, ilm) {
  const pathq = `/v1/hadith/${encodeURIComponent(entry.collection)}/${encodeURIComponent(entry.number)}`;
  const data = await ilm(pathq);
  const h = (data && (data.hadith || data)) || null;
  if (!h) throw new Error('ilm-api returned nothing for ' + entry.collection + ' ' + entry.number);
  const arabic = String(h.text_arabic || '').trim();
  const english = String(h.text_english || '').trim();
  if (!arabic && !english) throw new Error('no text for ' + entry.collection + ' ' + entry.number);
  return {
    arabic, english,
    narrator: String(h.narrator || '').trim(),
    grade: String(h.grade || '').trim(),
    book: String(h.book_name || '').trim(),
    collection: entry.collection,
    number: String(h.hadith_number || entry.number),
    ref: entry.collection.charAt(0).toUpperCase() + entry.collection.slice(1) + ' ' + (h.hadith_number || entry.number)
  };
}

const BOOK_NAMES = {
  bukhari: 'Sahih al-Bukhari', muslim: 'Sahih Muslim', tirmidhi: 'Jami at-Tirmidhi',
  nasai: "Sunan an-Nasa'i", abudawud: 'Sunan Abu Dawud', ibnmajah: 'Sunan Ibn Majah'
};

function buildCaption(h, theme) {
  const lines = [];
  if (h.arabic) lines.push(h.arabic);
  if (h.english) lines.push((h.narrator ? h.narrator + ': ' : '') + h.english);
  const source = (BOOK_NAMES[h.collection] || h.collection) + (h.grade ? ' · ' + h.grade : '');
  lines.push(source + ' · no. ' + h.number);
  if (theme) lines.push('#Hadith #Sunnah #Islam #DailyHadith');
  return lines.join('\n\n');
}

function buildImagePrompt(entry, h) {
  const base = entry.scene || 'a quiet masjid interior, no people, warm light';
  return 'Traditional Islamic dawah photograph for a hadith post. ' + base +
    '. Absolutely no human beings, no faces, no silhouettes, no calligraphy of Quranic text. ' +
    'Vertical composition, muted deep green and gold palette, soft natural light, calm and reverent, ' +
    'space at the top for a text overlay.';
}

// Same shape as the ayah post: dry mode for previews, claim, guard against a repeat on the
// Page, and a record that says what happened.
async function run(d) {
  const deps = d || {};
  const dateKey = d.date ? todayKey(d.date) : todayKey();
  const out = { ok: false, steps: [], date: dateKey, kind: 'hadith' };

  // Which Page owns today's hadith: the day alternates so the second Page gets content
  // without a third cron run.
  const slot = d.slot === 'morning' || d.slot === 'evening'
    ? d.slot
    : (dayIndex(d.date) % 2 === 0 ? 'morning' : 'evening');
  out.slot = slot;
  out.page = d.page || '';
  out.igAccount = d.igAccount || '';

  const claim = await lastPost();
  if (claim && claim.date === dateKey && !d.force) {
    out.skipped = 'hadith post already published today (' + claim.date + ')';
    out.previous = claim;
    return out;
  }

  const idx = typeof d.index === 'number' ? d.index : await nextIndex();
  const entry = ENTRIES[idx];
  if (!entry) { out.error = 'no hadith entry at index ' + idx; return out; }

  let h;
  try {
    h = await fetchHadith(entry, d.ilm);
  } catch (e) {
    // Never substitute a remembered narration: report and let the next run try another.
    out.error = 'could not fetch ' + entry.collection + ' ' + entry.number + ': ' + String(e.message).slice(0, 160);
    out.ref = entry.collection + ' ' + entry.number;
    return out;
  }

  const caption = buildCaption(h, entry.theme);
  out.ref = entry.collection + ':' + h.number;
  out.theme = entry.theme || '';
  out.caption = caption;
  out.prompt = buildImagePrompt(entry, h);

  if (d.dry) {
    out.imageUrl = d.generateImage ? await d.generateImage(out.prompt).catch((e) => 'error: ' + e.message) : null;
    return out;
  }

  const image = await (d.generateImage
    ? d.generateImage(out.prompt)
    : d.studio('/v1/image/generate', { prompt: out.prompt, width: 1024, height: 1280 }).then((j) => j && j.url));
  out.imageUrl = image;

  if (d.page && d.social) {
    try {
      out.facebook = await d.social.postImage({ page: d.page, imageUrl: image, message: caption });
      out.steps.push('facebook');
    } catch (e) { out.facebook = { error: String(e.message).slice(0, 200) }; }
  }
  if (d.instagram && d.igAccount) {
    try {
      out.instagram = await d.instagram.publish({ account: d.igAccount, imageUrl: image, caption });
      out.steps.push('instagram');
    } catch (e) { out.instagram = { error: String(e.message).slice(0, 200) }; }
  }

  const published = out.steps.length > 0;
  const record = {
    date: dateKey, slot, page: d.page || '', igAccount: d.igAccount || '',
    ref: out.ref, imageUrl: image, facebook: out.facebook || null, instagram: out.instagram || null,
    at: new Date().toISOString()
  };
  if (published) {
    out.cursor = await advanceCursor(idx).catch(() => null);
    await db.putSocial(CLAIM_KEY, JSON.stringify(record))
      .then(() => { out.claimSaved = true; })
      .catch((e) => { out.claimSaved = false; out.claimError = String((e && e.message) || e).slice(0, 140); });
  } else {
    out.claimSaved = false;
    out.claimSkipped = 'nothing was published, so the hadith slot stays open';
  }
  out.record = record;
  out.ok = published;
  return out;
}

module.exports = { ENTRIES, run, buildCaption, buildImagePrompt, fetchHadith, nextIndex, lastPost, parseRecord, CLAIM_KEY, CURSOR_KEY };
