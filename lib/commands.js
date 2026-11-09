// Islamic-knowledge slash commands shared by Telegram, WhatsApp and the
// dashboard chat. Each command calls the Ilm API directly instead of going
// through the model, so answers are fast, cheap and citable.
const docs = require('./docs');
const crypto = require('crypto');

const uid = (p) => p + '_' + crypto.randomBytes(4).toString('hex');
const nowIso = () => new Date().toISOString();

const COMMANDS = [
  ['prayer', '/prayer Accra', "today's five prayer times"],
  ['quran', '/quran 2:255', 'an ayah in Arabic and English'],
  ['hadith', '/hadith patience | bukhari', 'search 47,000+ narrations'],
  ['dua', '/dua travel', "a du'a (or /dua for a random one)"],
  ['fiqh', '/fiqh wudu', 'the four madhhabs side by side'],
  ['post', '/post', "publish today's ayah to Facebook and Instagram now"],
  ['help', '/help', 'this list']
];

function clean(s) {
  return String(s == null ? '' : s).replace(/^\uFEFF/, '').replace(/\uFEFF/g, (m, i) => (i === 0 ? '' : m)).trim();
}

function trimSentences(s, n) {
  const t = String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
  if (t.length <= n) return t;
  const cut = t.slice(0, n);
  const end = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('! '), cut.lastIndexOf('? '));
  return (end > n * 0.5 ? cut.slice(0, end + 1) : cut.trimEnd() + '…');
}

function trim(s, n) {
  const t = String(s == null ? '' : s).replace(/\r/g, '').trim();
  return t.length > n ? t.slice(0, n - 1).trimEnd() + '…' : t;
}

function helpText(extra) {
  const lines = COMMANDS.map(([name, example, what]) => `${example} — ${what}`);
  return '*What I can do*\n' + lines.join('\n') + (extra ? '\n' + extra : '') +
    '\n\n_Anything else you ask, I answer with the model._';
}

// prayer times come back as ISO strings anchored to the city's own clock
function hhmm(iso) {
  const m = /T(\d{2}):(\d{2})/.exec(String(iso || ''));
  return m ? `${m[1]}:${m[2]}` : String(iso || '').slice(0, 5);
}

function clock(iso, tz) {
  const d = new Date(iso);
  if (isNaN(d)) return String(iso || '').slice(11, 16);
  if (!tz) return String(iso).slice(11, 16) + ' UTC';
  try {
    return new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false }).format(d);
  } catch (e) { return String(iso).slice(11, 16) + ' UTC'; }
}

function nextPrayer(times, tz) {
  const order = ['fajr', 'dhuhr', 'asr', 'maghrib', 'isha'];
  const now = Date.now();
  for (const name of order) {
    const t = Date.parse(times[name]);
    if (Number.isFinite(t) && t > now) {
      const mins = Math.round((t - now) / 60000);
      const when = mins < 60 ? `${mins} min` : `${Math.floor(mins / 60)}h ${mins % 60}m`;
      return `${name.charAt(0).toUpperCase() + name.slice(1)} in ${when} (${clock(times[name], tz)})`;
    }
  }
  return 'Isha has passed — next is Fajr tomorrow';
}

function madhabName(m) {
  const k = String(m || '').toLowerCase();
  return { hanafi: 'Hanafi', shafii: "Shafi'i", shafi_i: "Shafi'i", maliki: 'Maliki', hanbali: 'Hanbali' }[k] || (k ? k[0].toUpperCase() + k.slice(1) : 'General');
}

const CITY_COORDS = {
  accra: [5.6037, -0.187], kumasi: [6.6885, -1.6244], tamale: [9.4008, -0.8393],
  'cape coast': [5.1053, -1.2466], takoradi: [4.8984, -1.7603], tarkwa: [5.3006, -1.9833],
  techiman: [7.5833, -1.9333], sunyani: [7.3399, -2.3268], ho: [6.6008, 0.4713],
  lagos: [6.5244, 3.3792], abuja: [9.0765, 7.3986], kano: [12.0022, 8.592], 'new york': [40.7128, -74.006],
  london: [51.5072, -0.1276], manchester: [53.4808, -2.2426], paris: [48.8566, 2.3522],
  berlin: [52.52, 13.405], madrid: [40.4168, -3.7038], istanbul: [41.0082, 28.9784],
  cairo: [30.0444, 31.2357], mecca: [21.4225, 39.8262], medina: [24.4686, 39.6142],
  jeddah: [21.4858, 39.1925], riyadh: [24.7136, 46.6753], dubai: [25.2048, 55.2708],
  doha: [25.2854, 51.531], kuwait: [29.3759, 47.9774], amman: [31.9454, 35.9284],
  'al quds': [31.7683, 35.2137], jerusalem: [31.7683, 35.2137], karachi: [24.8607, 67.0011],
  lahore: [31.5204, 74.3587], islamabad: [33.6844, 73.0479], dhaka: [23.8103, 90.4125],
  delhi: [28.7041, 77.1025], mumbai: [19.076, 72.8777], 'kuala lumpur': [3.139, 101.6869],
  jakarta: [-6.2088, 106.8456], singapore: [1.3521, 103.8198], nairobi: [-1.2921, 36.8219],
  'dar es salaam': [-6.7924, 39.2083], johannesburg: [-26.2041, 28.0473], capetown: [-33.9249, 18.4241],
  'cape town': [-33.9249, 18.4241], toronto: [43.6532, -79.3832], chicago: [41.8781, -87.6298],
  houston: [29.7604, -95.3698], 'los angeles': [34.0522, -118.2437], atlanta: [33.749, -84.388],
  sydney: [-33.8688, 151.2093], melbourne: [-37.8136, 144.9631], tokyo: [35.6762, 139.6503]
};

function titleCase(s) {
  return String(s || '').split(/\s+/).map((w) => (w ? w[0].toUpperCase() + w.slice(1) : w)).join(' ');
}

function create(opts) {
  const ilm = opts && opts.ilm;
  const postDaily = (opts && opts.postDaily) || null;

  async function get(path, params) {
    const raw = await ilm(path, params);
    return typeof raw === 'string' ? JSON.parse(raw) : raw;
  }

  // the Ilm client reports the HTTP status in the error text
  function missing(e) { return /->\s*40\d/.test(String(e && e.message)); }

  // Astronomy needs a position, and the API's built-in city list is short, so
  // turn whatever was typed into coordinates (coordinates themselves still work).
  // Prayer times come back as real UTC instants; show them on the place's clock.
async function tzFor(lat, lng, key) {
  const cached = await docs.get('geo_tz', key).catch(() => null);
  if (cached && cached.tz) return cached.tz;
  try {
    const r = await fetch('https://timeapi.io/api/TimeZone/coordinate?latitude=' + lat + '&longitude=' + lng,
      { signal: AbortSignal.timeout(8000) });
    const d = await r.json().catch(() => ({}));
    if (d && d.timeZone) {
      await docs.put('geo_tz', { id: key, tz: d.timeZone, createdAt: nowIso() }).catch(() => {});
      return d.timeZone;
    }
  } catch (e) { /* fall back to UTC below */ }
  return null;
}

async function coords(place) {
    const raw = String(place || '').trim();
    if (!raw) return { lat: CITY_COORDS.accra[0], lng: CITY_COORDS.accra[1], name: 'Accra' };
    const pair = /^(-?\d{1,2}(?:\.\d+)?)\s*,\s*(-?\d{1,3}(?:\.\d+)?)$/.exec(raw);
    if (pair) return { lat: Number(pair[1]), lng: Number(pair[2]), name: `${pair[1]}, ${pair[2]}` };
    // "Accra today" should still find Accra, so try the whole phrase, then
    // shorter versions of it before giving up.
    const words = raw.split(/\s+/).filter(Boolean);
    const tries = [raw];
    for (let n = Math.min(3, words.length - 1); n >= 1; n--) tries.push(words.slice(0, n).join(' '));
    for (const attempt of tries) {
      const key = attempt.toLowerCase().replace(/[^\p{L}\p{N}\s-]/gu, '').replace(/\s+/g, ' ').trim();
      if (!key) continue;
      if (CITY_COORDS[key]) return { lat: CITY_COORDS[key][0], lng: CITY_COORDS[key][1], name: titleCase(key) };
      try {
        const hit = await docs.get('geo', key);
        if (hit && Number.isFinite(hit.lat)) return hit;
      } catch (e) {}
      try {
        const r = await fetch('https://nominatim.openstreetmap.org/search?format=json&limit=1&q=' + encodeURIComponent(attempt), {
          headers: { 'User-Agent': 'AgentX/1.0 (agent dashboard prayer times)' }, signal: AbortSignal.timeout(9000)
        });
        const arr = await r.json().catch(() => []);
        if (arr && arr.length) {
          const out = { id: key, lat: Number(arr[0].lat), lng: Number(arr[0].lon), name: titleCase(String(arr[0].display_name || attempt).split(',')[0]), createdAt: nowIso() };
          await docs.put('geo', out).catch(() => {});
          return out;
        }
      } catch (e) { console.log('[geo]', String(e.message).slice(0, 100)); }
    }
    return null;
  }

  async function prayer(args) {
    const asked = trim(args || '', 60) || 'Accra';
    const at = await coords(asked);
    if (!at) return `I could not find "${asked}". Send a town or a position, like */prayer Kumasi* or */prayer 51.5072,-0.1276*.`;
    const d = await get('/v1/prayer-times', { lat: at.lat, lng: at.lng, method: 'MuslimWorldLeague' });
    const t = d && (d.times || d.data || d);
    if (!t || !t.fajr) throw new Error('no times for that place');
    const place = d.city || at.name || asked;
    const tz = await tzFor(at.lat, at.lng, String(asked).toLowerCase());
    const c = (k) => clock(t[k], tz);
    return `🕌 *${place} · ${d.date || 'today'}*\n` +
      `Fajr ${c('fajr')} · Sunrise ${c('sunrise')}\n` +
      `Dhuhr ${c('dhuhr')} · Asr ${c('asr')}\n` +
      `Maghrib ${c('maghrib')} · Isha ${c('isha')}\n` +
      `_${nextPrayer(t, tz)}_`;
  }

  async function quran(args) {
    const m = /^(\d{1,3})\s*[:\s.-]\s*(\d{1,3})/.exec(String(args || '').trim());
    if (!m) return 'Send it as a reference, e.g. */quran 2:255* or */quran 18:10*.';
    const [, s, a] = m;
    let d;
    try { d = await get(`/v1/quran/${s}/${a}`, { translation: 'en.sahih' }); }
    catch (e) { if (missing(e)) return `There is no ayah ${s}:${a}. Surahs run 1-114; check the numbers.`; throw e; }
    if (!d || !d.text_arabic) return `I could not find ${s}:${a}. Check the surah and ayah numbers.`;
    return `📖 *Surah ${d.surah_number}:${d.ayah_number}*\n${clean(d.text_arabic)}\n\n${trim(clean(d.translation), 900)}\n_${d.translation_code || 'en.sahih'}_`;
  }

  async function hadith(args) {
    if (!String(args || '').trim()) return 'What should I look for? e.g. */hadith patience* or */hadith patience | bukhari*.';
    const [q, collection] = String(args).split('|').map((x) => x.trim());
    const d = await get('/v1/hadith/search', { q, collection: collection || undefined, language: 'en', limit: 2 });
    const rows = (d && (d.results || d.hadiths)) || [];
    if (!rows.length) return `No narration matched "${q}". Try fewer or different words.`;
    return rows.slice(0, 2).map((h) => {
      const body = trimSentences(h.text_english || h.text || '', 560);
      // the narration usually opens with "Narrated X:", so only add the chain when it does not
      const needsNarrator = h.narrator && !/^narrated/i.test(body);
      const head = `📜 *${h.collection || collection || 'Hadith'}${h.hadith_number ? ' · ' + h.hadith_number : ''}*` +
        (h.grade ? ` (${h.grade})` : '') + (needsNarrator ? `\n_Narrated by ${h.narrator}_` : '');
      return head + '\n' + body;
    }).join('\n\n');
  }

  async function dua(self, args) {
    const raw = String(args || '').trim();
    const [word] = raw.toLowerCase().split(/\s+/);
    if (word === 'saved') return duaSaved(self, raw.slice(5).trim());
    if (word === 'save') return duaSave(self, raw.slice(4).trim());
    const d = raw
      ? await get('/v1/duas/search', { q: raw })
      : await get('/v1/duas/random', {});
    const rows = (d && (d.results || d.duas)) || (d && d.title ? [d] : []);
    if (!rows.length) return `I could not find a du'a for "${raw}". Try a simpler word, like travel, sleep or anxiety.`;
    const x = rows[0];
    return `🤲 *${clean(x.title) || "Du'a"}*${x.category ? ` · ${x.category}` : ''}\n${clean(x.text_arabic)}\n` +
      (x.transliteration ? `\n_${trim(clean(x.transliteration), 500)}_\n` : '') +
      `\n${trim(clean(x.translation), 700)}` + (x.reference ? `\n_${x.reference}_` : '');
  }

  async function duaSave(self, topic) {
    if (!topic) return 'Which du\'a? e.g. */dua save travel*.';
    const d = await get('/v1/duas/search', { q: topic });
    const rows = (d && d.results) || [];
    if (!rows.length) return `No du'a matched "${topic}".`;
    const x = rows[0];
    await docs.put('dua_favs', {
      id: uid('fav'), ownerId: self.ownerId || null, savedBy: self.key || null,
      topic, title: x.title || topic, arabic: x.text_arabic || '',
      translation: x.translation || '', reference: x.reference || '', createdAt: nowIso()
    });
    return `Saved *${x.title || topic}* to your du'as. Send */dua saved* to see them.`;
  }

  async function duaSaved(self, rest) {
    const mine = (await docs.list('dua_favs')).filter((f) =>
      (self.ownerId && f.ownerId === self.ownerId) || (self.key && f.savedBy === self.key));
    if (!mine.length) return "You have not saved any du'as yet. Try */dua save travel*.";
    if (/^remove\s+\d+$/i.test(rest || '')) {
      const i = parseInt(rest.split(/\s+/)[1], 10) - 1;
      if (!mine[i]) return 'That number is not in your list.';
      await docs.del('dua_favs', mine[i].id);
      return `Removed *${mine[i].title}*.`;
    }
    if (/^\d+$/.test(String(rest || '').trim())) {
      const f = mine[parseInt(rest, 10) - 1];
      if (!f) return 'That number is not in your list. Send */dua saved* to see them.';
      return `🤲 *${f.title}*${f.topic ? ` · ${f.topic}` : ''}\n${f.arabic || ''}\n\n${trim(f.translation, 700)}` +
        (f.reference ? `\n_${f.reference}_` : '');
    }
    return `*Your du'as*\n` + mine.slice(0, 10).map((f, i) =>
      `${i + 1}. ${f.title}` + (f.topic ? ` (${f.topic})` : '')).join('\n') +
      '\n\n*/dua saved <number>* to read one, */dua saved remove <number>* to drop it.';
  }

  async function fiqh(args) {
    const topic = String(args || '').trim();
    if (!topic) return 'Which topic? e.g. */fiqh wudu*, */fiqh zakat*, */fiqh travel prayer*.';
    const d = await get('/v1/fiqh/search', { topic });
    const rows = (d && (d.rulings || d.results)) || [];
    if (!rows.length) return `I have no ruling for "${topic}". Try a single word like wudu, salah, zakat or fasting.`;

    // the dataset is a set of questions, each answered by four schools.
    // find the question that best matches what was asked.
    const stop = new Set(['does', 'do', 'the', 'a', 'an', 'of', 'is', 'are', 'what', 'break', 'nullify', 'in', 'on', 'for', 'to', 'and']);
    const words = topic.toLowerCase().split(/\W+/).filter((w) => w.length > 2 && !stop.has(w));
    const groups = new Map();
    for (const r of rows) {
      const key = r.topic || 'General';
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(r);
    }
    let best = null; let bestScore = -1;
    for (const [key, list] of groups) {
      const text = (key + ' ' + (list[0].question || '')).toLowerCase();
      const score = words.reduce((n, w) => n + (text.includes(w) ? 1 : 0), 0);
      if (score > bestScore) { best = { key, list }; bestScore = score; }
    }
    const seen = new Set();
    const lines = [];
    for (const r of best.list) {
      const m = String(r.madhab || 'general').toLowerCase();
      if (seen.has(m)) continue;
      seen.add(m); lines.push(`*${madhabName(m)}:* ${trimSentences(r.ruling, 380)}`);
      if (lines.length === 4) break;
    }
    const others = [...groups.keys()].filter((k) => k !== best.key).slice(0, 4);
    return `⚖️ *${best.key}* — the four schools\n` + lines.join('\n\n') +
      (others.length ? `\n\n_Also asked:_ ${others.map((o) => trim(o, 60)).join(' · ')}` : '') +
      '\n\n_Brief comparison; for a personal ruling ask a qualified scholar._';
  }

  async function handle(text, ctx) {
    const raw = String(text || '').trim();
    // "post today's update" in plain words should work from the owner's own chat,
    // without learning a slash command.
    const PLainPost = /^(?:please\s+)?post\s+(?:today'?s\s+|the\s+)?(?:daily\s+|dawah\s+|islamic\s+)?(?:update|post|ayah)$/i;
    if (!raw.startsWith('/') && PLainPost.test(raw)) {
      if (!(ctx && ctx.canManage)) return 'Posting is the owner\'s job. Ask them to send it.';
      if (!postDaily) return 'Posting is not configured on this deployment.';
      try { return await postDaily(ctx); }
      catch (e) { return 'I could not publish just now: ' + String(e.message).slice(0, 140); }
    }
    const m = /^\/([a-z]+)(?:@\w+)?\s*([\s\S]*)$/i.exec(raw);
    if (!m) return null;
    const cmd = m[1].toLowerCase();
    const args = m[2] || '';
    const self = { ownerId: (ctx && ctx.ownerId) || null, key: (ctx && ctx.key) || null };
    const run = async (fn, label) => {
      try { return await fn(self); } catch (e) {
        console.log('[cmd ' + label + ']', String(e.message).slice(0, 160));
        return 'I could not reach the knowledge service just now. Please try again in a moment.';
      }
    };
    switch (cmd) {
      case 'prayer': case 'salah': case 'salat': return run(() => prayer(args), cmd);
      case 'quran': case 'ayah': return run(() => quran(args), cmd);
      case 'hadith': return run(() => hadith(args), cmd);
      case 'dua': case 'duaa': return run((self) => dua(self, args), cmd);
      case 'fiqh': return run(() => fiqh(args), cmd);
      case 'post': case 'publish': {
        if (!(ctx && ctx.canManage)) return 'Posting is the owner\'s job.';
        if (!postDaily) return 'Posting is not configured on this deployment.';
        return run(() => postDaily(ctx), cmd);
      }
      case 'help': case 'commands': return helpText();
      default: return null;
    }
  }

  return { handle, helpText, COMMANDS, prayer, quran, hadith, dua, fiqh };
}

module.exports = { create, helpText, COMMANDS };
