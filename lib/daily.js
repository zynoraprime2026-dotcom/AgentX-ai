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
  { s: 10, a: 57, note: 'What is sent down is described as healing, not only as information.', scene: 'an open Quran with a thin beam of light across the page, dark calm background' }
];

const HASHTAGS = '#quran #islam #dawah #sunnah #tauheed #salah #sabr #dhikr #islamicreminder #alfurqan';
const NO_PEOPLE = 'no people, no faces, no silhouettes, no figures, no human shapes';

function todayKey(d) {
  const t = d || new Date();
  return t.toISOString().slice(0, 10);
}

function dayIndex(d) {
  const t = d || new Date();
  const start = Date.UTC(t.getUTCFullYear(), 0, 0);
  const day = Math.floor((Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate()) - start) / 86400000);
  return ((day % PLAN.length) + PLAN.length) % PLAN.length;
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
  const idx = Number.isInteger(o.index) ? (o.index % PLAN.length) : dayIndex(when);
  const entry = PLAN[idx];
  const verse = await o.ilm(`/v1/quran/${entry.s}/${entry.a}`);
  if (!verse || !verse.text_arabic) throw new Error('ilm-api returned no text for ' + entry.s + ':' + entry.a);
  const caption = buildCaption(entry, {
    arabic: String(verse.text_arabic).trim(),
    english: String(verse.translation || '').trim(),
    ref: entry.s + ':' + entry.a
  });
  const prompt = buildImagePrompt(entry);
  return { index: idx, ref: entry.s + ':' + entry.a, caption, prompt, note: entry.note };
}

async function generateImage(prompt, studio) {
  const j = await studio('/v1/image/generate', { prompt, width: 1024, height: 1280 });
  const url = (j && j.url) || '';
  if (!/^https?:\/\//i.test(url)) throw new Error('studio-api returned no image url');
  return url;
}

// One post per day, and a second run of the cron must not double-post, so the day is
// claimed in the database before anything goes public.
async function claimDay(dateKey) {
  const prev = await db.getSocial('daily_last').catch(() => null);
  if (prev && prev.date === dateKey && !prev.force) return { ok: false, prev };
  return { ok: true, prev };
}

async function run(deps) {
  const d = deps || {};
  const dateKey = todayKey(d.date);
  const out = { date: dateKey, dry: !!d.dry, steps: [] };
  const built = await build({ date: d.date, index: d.index, ilm: d.ilm });
  out.ref = built.ref;
  out.caption = built.caption;
  out.prompt = built.prompt;

  if (d.dry) {
    out.imageUrl = d.generateImage ? await d.generateImage(built.prompt).catch((e) => 'error: ' + e.message) : null;
    out.instagramImage = out.imageUrl && !String(out.imageUrl).startsWith('error:') ? toInstagramJpeg(out.imageUrl) : null;
    return out;
  }

  const claim = await claimDay(dateKey);
  if (!claim.ok && !d.force) {
    out.skipped = 'already posted today (' + claim.prev.date + ')';
    out.previous = claim.prev;
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
    ref: built.ref,
    imageUrl: image,
    facebook: out.facebook || null,
    instagram: out.instagram || null,
    at: new Date().toISOString()
  };
  await db.putSocial('daily_last', record).catch(() => {});
  out.record = record;
  out.ok = out.steps.length > 0;
  return out;
}

module.exports = { PLAN, run, build, buildCaption, buildImagePrompt, toInstagramJpeg, isJpeg, dayIndex, todayKey };
