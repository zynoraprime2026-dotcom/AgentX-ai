// Daily dawah post: one ayah, one reflection, one image, published to the Page and
// to Instagram. The ayah text comes from ilm-api rather than from a model, because a
// generated "verse" is the one error this account cannot afford. Thirty curated ayat
// rotate, so the same verse does not reappear for a month.
const db = require('../db');

const PLAN = [
{ s: 94, a: 5, note: 'Ease is not promised after the hardship. It is placed with it.', scene: 'interior of a stone masjid at dawn, rows of arches receding, warm light through latticed windows, quiet and empty' },
  { s: 2, a: 152, note: 'Remembrance is a two-way street, and the return is always greater than the effort.', scene: 'a Quran resting open on a carved wooden rehal, soft window light, shallow depth of field' },
  { s: 13, a: 28, note: 'The heart that feels heavy is usually the heart that has gone quiet.', scene: 'wooden prayer beads resting on a woven prayer rug, morning light raking across the fibres' },
  { s: 3, a: 139, note: 'Low spirits are not a verdict on your worth.', scene: 'a tall minaret against a pale morning sky, soft clouds, low angle' },
  { s: 65, a: 3, note: 'Trust is not the absence of a plan. It is what you do when the plan runs out.', scene: 'sunlight falling through an intricate wooden lattice screen onto a bare stone floor' },
  { s: 2, a: 186, note: 'Nearness is not something you have to earn first.', scene: 'a mihrab niche in a plain masjid wall, single lamp, deep shadow' },
  { s: 39, a: 53, note: 'The door described here never closes on the one who turns back.', scene: 'an open Quran on a wooden stand, pages catching light, rest of the room dark' },
  { s: 40, a: 60, note: 'Asking is the act of worship, not the last resort.', scene: 'a small brass lantern glowing on a stone ledge, deep blue evening light behind it' },
  { s: 2, a: 216, note: 'What you would have chosen is not always what was good for you.', scene: 'a quiet stone courtyard of an old masjid, single tree, long shadows' },
  { s: 57, a: 23, note: 'Neither the win nor the loss is the whole story.', scene: 'a brass oil lamp on a worn wooden shelf, warm glow, dark background' },
  { s: 3, a: 200, note: 'Steadfastness is quiet, repetitive and unglamorous. That is the point.', scene: 'geometric Islamic tilework in blue and turquoise, symmetrical, high detail' },
  { s: 24, a: 35, note: 'Light is described here as something borrowed, not owned.', scene: 'a glass lantern in a dark niche, flame reflected in the glass, deep shadow' },
  { s: 55, a: 13, note: 'The question repeats because the answer keeps being overlooked.', scene: 'date palms in a masjid courtyard at golden hour, ripe clusters, empty ground' },
  { s: 6, a: 59, note: 'Nothing is lost, including what you think nobody saw.', scene: 'an old Arabic manuscript open on a dark table, gold illumination, dust in a light beam' },
  { s: 17, a: 80, note: 'Ask for a good entrance and a good exit, in everything.', scene: 'a carved wooden door of an old masjid, brass studs, worn stone threshold' },
  { s: 20, a: 114, note: 'Knowledge is one of the few things you can always ask for more of.', scene: 'shelves of leather-bound Arabic books in a dim library, single shaft of light' },
  { s: 16, a: 97, note: 'The promise attached to good work does not wait for the next life only.', scene: 'a walled garden with a stone water channel, greenery, soft morning light' },
  { s: 49, a: 13, note: 'The measure is not lineage or language, and it is not visible from outside.', scene: 'close detail of carved marble with an interlocking star pattern, warm white stone' },
  { s: 62, a: 10, note: 'Work after prayer is part of the same obedience, not a break from it.', scene: 'domes and rooftops of an old city at sunrise, minarets in the distance, no people' },
  { s: 4, a: 103, note: 'Fixed times are a mercy: the day gets a skeleton before it gets a crowd.', scene: 'a single prayer rug unrolled on a stone floor, mihrab ahead, plain and peaceful' },
  { s: 29, a: 45, note: 'Prayer is described as a restraint, not merely a ritual.', scene: 'a simple masjid interior with a hanging lamp and a wall of small arched windows' },
  { s: 9, a: 105, note: 'Your work is seen before it is judged.', scene: 'a reed pen resting on an inkwell beside a blank sheet of parchment, warm light' },
  { s: 2, a: 286, note: 'The limit is stated plainly here: nothing is placed beyond what can be carried.', scene: 'a plain plastered wall with one small window, hard rectangle of light on the floor' },
  { s: 41, a: 34, note: 'Answering a bad deed with a good one is the harder and the stronger path.', scene: 'still water in a stone courtyard basin, arches reflected, no wind' },
  { s: 14, a: 7, note: 'Gratitude is presented as a cause, not just a reaction.', scene: 'a bowl of ripe dates on a wooden table beside a folded cloth, natural light' },
  { s: 51, a: 56, note: 'Purpose stated in one line, and everything else arranged around it.', scene: 'a masjid dome against a deep blue evening sky, first stars, silhouette only of architecture' },
  { s: 33, a: 41, note: 'Remembrance is given a schedule here, morning and evening, so it survives busy days.', scene: 'dawn sky above a quiet masjid courtyard, soft pink and grey clouds, empty ground' },
  { s: 3, a: 103, note: 'Unity is described as something held, which means it can be let go.', scene: 'repeating horseshoe arches in a hypostyle prayer hall, warm stone, long perspective' },
  { s: 2, a: 153, note: 'Patience and prayer are named together because one without the other does not hold.', scene: 'an empty prayer hall with columns and hanging lamps, soft daylight, complete stillness' },
  { s: 10, a: 57, note: 'What is sent down is described as healing, not only as information.', scene: 'an open Quran with a thin beam of light across the page, dark calm background' },
{ s: 2, a: 45, note: "Patience and prayer are named as the two things to reach for first, before the situation is understood.", scene: "a stone courtyard at dawn with a single prayer rug laid out, long shadow of an arch across the floor" },
  { s: 3, a: 8, note: "The fear here is not of doubt arriving, but of the heart drifting after it has been guided.", scene: "a plain plastered wall with one arched window, hard morning light on the stone floor" },
  { s: 3, a: 31, note: "Love is measured by following, not by feeling. The claim and the proof are not the same thing.", scene: "worn stone steps up to an old masjid doorway, soft shadow, no people" },
  { s: 3, a: 159, note: "Consultation is commanded, and trust is commanded after it. Neither replaces the other.", scene: "a low wooden table with an open book, a brass lamp and a folded cloth, warm interior light" },
  { s: 3, a: 185, note: "Every soul is stated to taste death, so no plan here is the final one.", scene: "an old wall of plain stone blocks in soft evening light, dry grass at its foot" },
  { s: 3, a: 190, note: "The night sky and the turning of day are named as signs for people who reason.", scene: "a clear night sky above the silhouette of a masjid dome and minaret" },
  { s: 7, a: 56, note: "The earth is described as repaired, and the instruction is not to undo that repair.", scene: "a narrow stone water channel running through a green walled garden, morning light" },
  { s: 7, a: 180, note: "The Names are called the most beautiful, and the instruction is to call by them.", scene: "carved plaster showing interlocking circles and stars, raking light, fine detail" },
  { s: 8, a: 2, note: "Trembling here sits beside remembrance and reliance, not beside fear of people.", scene: "a single lit oil lamp in an empty prayer hall, deep shadow around it" },
  { s: 9, a: 51, note: "Nothing arrives that was not written, and that is stated as a comfort rather than a warning.", scene: "raindrops on an iron window grille with a blurred minaret beyond" },
  { s: 13, a: 11, note: "The condition is placed on people, not on God: change begins with the one who wants it.", scene: "a folded woven prayer rug on a low wooden bench, soft window light" },
  { s: 13, a: 24, note: "The greeting the angels give is built on patience, which was the work of a lifetime.", scene: "an arched walkway around a shaded garden, afternoon light, empty ground" },
  { s: 14, a: 40, note: "Prayer is asked for as a habit to be established, and asked for on behalf of those who come after.", scene: "two prayer rugs side by side on a stone floor, one smaller than the other" },
  { s: 16, a: 90, note: "Justice, good conduct and giving to relatives are named in one verse, in that order.", scene: "a set of brass scales resting on a worn wooden table, soft light" },
  { s: 17, a: 110, note: "Two ways of calling on the same Lord are accepted, and neither is corrected.", scene: "a wall of small arched niches, each holding a single unlit lamp" },
  { s: 18, a: 24, note: "Even a settled intention is taught to be spoken with the reminder that nothing happens without God's will.", scene: "a reed pen and inkwell beside an open page, candlelight, deep shadow" },
  { s: 20, a: 14, note: "Remembrance is given as the reason for prayer, not the reward for it.", scene: "a stone mihrab with one hanging lamp at dusk, plain walls" },
  { s: 25, a: 63, note: "The servants described here are known by how they walk and how they answer rudeness.", scene: "a narrow alley of an old stone city, morning light across the walls, empty of people" },
  { s: 29, a: 69, note: "Guidance is promised after effort, which means the effort comes first.", scene: "a long stone corridor with daylight at the far end" },
  { s: 33, a: 56, note: "Blessing is asked upon the Prophet ﷺ as an order, which makes it an act of worship rather than a sentiment.", scene: "a green dome with a crescent finial against a pale morning sky" },
  { s: 39, a: 9, note: "The one who stands at night is asked a question here, and the question is the point.", scene: "a small room with a prayer rug and a window showing night sky" },
  { s: 55, a: 60, note: "The reward for good is stated as a question because the answer is meant to be obvious.", scene: "a bowl of clear still water reflecting an arch, close detail" },
  { s: 61, a: 3, note: "Saying one thing and doing another is named as hated, which makes follow-through part of speech.", scene: "an open ledger with a reed pen on a plain wooden desk, daylight" },
  { s: 64, a: 11, note: "Permission is stated even for calamity, so nothing is outside the decree.", scene: "a broken stone wall with fresh grass growing at its base, soft light" },
  { s: 67, a: 2, note: "Life and death are described as a test of conduct, not as prizes.", scene: "a lone tree in a wide empty plain under a vast sky" },
  { s: 68, a: 4, note: "The character described is not a mood but a settled disposition, given as the highest praise.", scene: "a plain clay vessel on a stone ledge, soft side light, quiet composition" },
  { s: 73, a: 8, note: "Remembrance is given as the reply to a busy night, which is when it is hardest.", scene: "a string of dark wooden prayer beads coiled on a stone surface" },
  { s: 94, a: 6, note: "Ease is stated with the hardship, not after it, and then repeated.", scene: "an opening between two stone walls with bright light beyond" },
  { s: 99, a: 7, note: "Good is measured in the smallest visible unit here, and so is its opposite.", scene: "a single date stone resting on a coarse linen cloth, soft light" },
  { s: 103, a: 3, note: "Three things are listed and none of them is individual: truth, patience, and encouragement.", scene: "a row of worn stone columns in an empty prayer hall, warm morning light" }
];

const HASHTAGS = '#quran #islam #dawah #sunnah #tauheed #salah #sabr #dhikr #islamicreminder #alfurqan';
const NO_PEOPLE = 'no people, no faces, no silhouettes, no figures, no human shapes';

function todayKey(d) {
  const t = d || new Date();
  return t.toISOString().slice(0, 10);
}

function slotFor(d, slot) {
  if (slot === 'morning' || slot === 'evening') return slot;
  const h = (d ? new Date(d) : new Date()).getUTCHours();
  return h < 12 ? 'morning' : 'evening';
}

// A continuous day number, not day-of-year. The old formula stepped by two per day
// (index * 2 for the slot), and with thirty verses that only ever reached every other
// entry, so each slot came back round to the same fifteen after a fortnight. One step
// per day, with the evening entry half a plan away, gives every slot all thirty verses
// before any of them returns.
function dayNumber(d) {
  const t = d || new Date();
  return Math.floor(Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate()) / 86400000);
}

function dayIndex(d) {
  const n = dayNumber(d);
  return ((n % PLAN.length) + PLAN.length) % PLAN.length;
}

// The thirty ayat this pipeline rotates through ship with the app, so a broken or
// slow ilm-api can never leave a day with nothing to post. Text is still never
// composed: these are the uthmani text plus the Saheeh International translation.
let BUNDLED_AYAT = null;
function bundledAyah(surah, ayah) {
  if (BUNDLED_AYAT === null) {
    try { BUNDLED_AYAT = require('../data/daily_ayat.json'); } catch (e) { BUNDLED_AYAT = {}; }
  }
  return BUNDLED_AYAT[surah + ':' + ayah] || null;
}

// The verse text is fetched, never composed: ilm-api returns the uthmani text plus a
// published English translation, so a wrong citation cannot enter the pipeline.
async function fetchAyah(surah, ayah, ilm) {
  const d = await ilm(`/v1/quran/${surah}/${ayah}`);
  if (!d || !d.text_arabic) throw new Error('ilm-api returned no text for ' + surah + ':' + ayah);
  return {
    arabic: String(d.text_arabic).trim(),
    english: String(d.translation || '').trim(),
    ref: surah + ':' + ayah,
    surahNumber: surah,
    ayahNumber: ayah,
    edition: d.source_edition || ''
  };
}

function buildCaption(entry, verse) {
  const parts = [];
  parts.push(verse.arabic);
  if (verse.english) parts.push(verse.english);
  parts.push(entry.note);
  parts.push('Surah ' + verse.ref.replace(':', ' — ayah '));
  parts.push(HASHTAGS);
  return parts.join('\n\n');
}

function buildImagePrompt(entry) {
  return [
    entry.scene,
    'architectural or still-life photograph, natural light, calm and reverent mood, fine detail',
    'high quality, no text, no lettering, no calligraphy overlay',
    NO_PEOPLE
  ].join(', ');
}

// Instagram only accepts JPEG between 4:5 and 1.91:1. The generator returns whatever
// it likes, so anything that is not already a JPEG is re-encoded through a resizing
// proxy that crops to 4:5 at IG's preferred 1080x1350.
function toInstagramJpeg(url) {
  const u = String(url || '');
  if (/\.jpe?g(\?|$)/i.test(u)) return u;
  return 'https://images.weserv.nl/?url=' + encodeURIComponent(u) + '&output=jpg&w=1080&h=1350&fit=cover&q=90';
}

function isJpeg(url) {
  return /\.jpe?g(\?|$)/i.test(String(url || ''));
}

async function build(opts) {
  const o = opts || {};
  const when = o.date ? new Date(o.date) : new Date();
  const slot = slotFor(o.date, o.slot);
  const base = dayIndex(when) + (slot === 'evening' ? Math.floor(PLAN.length / 2) : 0);
  const idx = Number.isInteger(o.index) ? (o.index % PLAN.length) : (base % PLAN.length);
  const entry = PLAN[idx];
  const local = bundledAyah(entry.s, entry.a);
  let verse = local ? { text_arabic: local.arabic, translation: local.english } : null;
  if (!verse) {
    try { verse = await o.ilm(`/v1/quran/${entry.s}/${entry.a}`); }
    catch (e) { verse = null; }
  }
  if (!verse || !verse.text_arabic) throw new Error('no text for ' + entry.s + ':' + entry.a + ' from the bundle or ilm-api');
  const caption = buildCaption(entry, {
    arabic: String(verse.text_arabic).trim(),
    english: String(verse.translation || '').trim(),
    ref: entry.s + ':' + entry.a
  });
  const prompt = buildImagePrompt(entry);
  return { index: idx, ref: entry.s + ':' + entry.a, caption, prompt, note: entry.note, slot };
}

async function generateImage(prompt, studio) {
  const j = await studio('/v1/image/generate', { prompt, width: 1024, height: 1280 });
  const url = (j && j.url) || '';
  if (!/^https?:\/\//i.test(url)) throw new Error('studio-api returned no image url');
  return url;
}

// One post per day, and a second run of the cron must not double-post, so the day is
// claimed in the database before anything goes public.
// The record is stored as JSON text, so it has to be parsed before it can be read.
// Comparing the raw string against an object meant `prev.date === dateKey` was never
// true, the claim never held, and every run published again: four copies of one ayah
// reached the Page on 2026-11-09.
function parseRecord(raw) {
  if (!raw) return null;
  if (typeof raw === 'object') return raw;
  try { return JSON.parse(String(raw)); } catch (e) { return null; }
}

async function lastPost(slot) {
  const raw = await db.getSocial('daily_last_' + slot).catch(() => null);
  return parseRecord(raw);
}

// A single cursor decides which verse goes out next, and every publish moves it on.
// Deriving the verse from the date could not work once the pipeline posted twice a day:
// a manual post on a day that had already published repeated the same ayah, which is
// exactly what the Page showed on 2026-11-09. The date only seeds the very first run.
async function cursorIndex() {
  const raw = await db.getSocial('daily_cursor').catch(() => null);
  const rec = parseRecord(raw);
  return rec && Number.isInteger(rec.n) ? rec.n : null;
}

async function nextIndex(when) {
  const at = await cursorIndex();
  if (at !== null) return ((at % PLAN.length) + PLAN.length) % PLAN.length;
  return dayIndex(when ? new Date(when) : new Date());
}

async function advanceCursor(idx, dateKey, ref) {
  const next = { n: idx + 1, date: dateKey, ref, at: new Date().toISOString() };
  await db.putSocial('daily_cursor', JSON.stringify(next));
  return next;
}

async function claimSlot(dateKey, slot) {
  const prev = await lastPost(slot);
  if (prev && prev.date === dateKey) return { ok: false, prev };
  return { ok: true, prev };
}

// Built from the bundled text only, so rotation decisions never wait on the network.
function compose(entry, idx, slot) {
  const local = bundledAyah(entry.s, entry.a);
  if (!local || !local.arabic) return null;
  const ref = entry.s + ':' + entry.a;
  const caption = buildCaption(entry, {
    arabic: String(local.arabic).trim(),
    english: String(local.english || '').trim(),
    ref
  });
  return { index: idx, ref, caption, prompt: buildImagePrompt(entry), note: entry.note, slot };
}

function nextUnposted(startIdx, taken) {
  for (let i = 1; i <= PLAN.length; i++) {
    const idx = (((startIdx + i) % PLAN.length) + PLAN.length) % PLAN.length;
    const cand = compose(PLAN[idx], idx, 'morning');
    if (cand && taken.indexOf(cand.ref) === -1) return cand;
  }
  return null;
}

async function run(deps) {
  const d = deps || {};
  const dateKey = todayKey(d.date);
  const out = { date: dateKey, dry: !!d.dry, steps: [] };
  const idx = Number.isInteger(d.index) ? d.index : await nextIndex(d.date);
  let built = await build({ date: d.date, index: idx, slot: d.slot, ilm: d.ilm });
  const claim = await claimSlot(dateKey, built.slot);
  if (!claim.ok) {
    if (!d.force) {
      out.slot = built.slot;
      out.ref = built.ref;
      out.caption = built.caption;
      out.prompt = built.prompt;
      out.skipped = built.slot + ' post already published today (' + claim.prev.date + ')';
      out.previous = claim.prev;
      return out;
    }
  }
  out.slot = built.slot;
  out.ref = built.ref;
  out.caption = built.caption;
  out.prompt = built.prompt;

  if (d.dry) {
    out.imageUrl = d.generateImage ? await d.generateImage(built.prompt).catch((e) => 'error: ' + e.message) : null;
    out.instagramImage = out.imageUrl && !String(out.imageUrl).startsWith('error:') ? toInstagramJpeg(out.imageUrl) : null;
    return out;
  }

  const image = await generateImage(built.prompt, d.studio);
  out.imageUrl = image;
  const igImage = toInstagramJpeg(image);
  out.instagramImage = igImage;

  if (d.page) {
    try {
      out.facebook = await d.social.postImage({ page: d.page, imageUrl: image, message: built.caption });
      out.steps.push('facebook');
    } catch (e) { out.facebook = { error: String(e.message).slice(0, 200) }; }
  }
  if (d.instagram) {
    try {
      out.instagram = await d.instagram.publish({ account: d.igAccount, imageUrl: image, caption: built.caption });
      out.steps.push('instagram');
    } catch (e) {
      // Instagram is picky about format and aspect ratio; only then pay for a re-encode.
      try {
        out.instagram = await d.instagram.publish({ account: d.igAccount, imageUrl: igImage, caption: built.caption });
        out.steps.push('instagram');
        out.instagramRetried = true;
      } catch (e2) { out.instagram = { error: String(e2.message).slice(0, 200), firstError: String(e.message).slice(0, 160) }; }
    }
  }

  const record = {
    date: dateKey,
    slot: built.slot,
    ref: built.ref,
    imageUrl: image,
    facebook: out.facebook || null,
    instagram: out.instagram || null,
    at: new Date().toISOString()
  };
  const published = out.steps.length > 0;
  if (published) {
    await advanceCursor(built.index, dateKey, built.ref)
      .then((c) => { out.cursor = c.n; })
      .catch((e) => { out.cursorSaved = false; out.cursorError = String((e && e.message) || e).slice(0, 140); });
  }
  // Stored as JSON text on purpose: the reader parses it, and a silent failure here is
  // what lets the same slot publish twice, so the outcome is always reported.
  await db.putSocial('daily_last_' + built.slot, JSON.stringify(record))
    .then(() => { out.claimSaved = true; })
    .catch((e) => { out.claimSaved = false; out.claimError = String((e && e.message) || e).slice(0, 140); });
  out.record = record;
  out.ok = out.steps.length > 0;
  return out;
}

module.exports = { PLAN, run, build, buildCaption, buildImagePrompt, toInstagramJpeg, isJpeg, dayIndex, slotFor, todayKey, parseRecord, nextIndex, cursorIndex, advanceCursor };
