// Facebook Page publishing.
//
// One narrow job: put text, a link or an image on the Page the owner names, and hand
// back the permalink. It deliberately does not read inboxes, reply to comments, or
// touch ads: those need permissions this integration will never ask for.
//
// Credentials live in the service environment, never in a prompt:
//   META_PAGE_TOKEN  - a Page access token with pages_manage_posts (ideally the
//                      permanent System User token, so it does not expire hourly)
//   META_PAGE_ID     - optional; resolved from the token when absent

const GRAPH = 'https://graph.facebook.com/v21.0';

// The token can arrive two ways: the env var (set by hand in Vercel) or the stored
// setting written by the /api/fb/callback exchange. The env var wins.
let storedToken = '';
let pageTokens = {};   // page id -> its own token, so posting survives the user token expiring
function pageToken() { return process.env.META_PAGE_TOKEN || storedToken; }
function setToken(t) { if (t) storedToken = String(t); }
function setPageTokens(map) { if (map && typeof map === 'object') pageTokens = { ...pageTokens, ...map }; }

function configured() { return Boolean(pageToken()); }

async function graph(path, params, overrideToken) {
  const tok = overrideToken || pageToken();
  if (!tok) throw new Error('META_PAGE_TOKEN is not configured on the service');
  const body = new URLSearchParams();
  for (const [k, v] of Object.entries(params || {})) {
    if (v === undefined || v === null || v === '') continue;
    body.set(k, String(v));
  }
  body.set('access_token', tok);
  const r = await fetch(GRAPH + path, {
    method: 'POST',
    body,
    signal: AbortSignal.timeout(20000)
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok || data.error) {
    const e = data.error || {};
    const msg = [e.message, e.error_user_title, e.error_user_msg].filter(Boolean).join(' — ');
    throw new Error('facebook ' + (e.code || r.status) + ': ' + (msg || 'request failed').slice(0, 220));
  }
  return data;
}

// Every Page this token can publish to. A System User token usually reaches more
// than one Page, so the caller always has to say which, unless there is exactly one.
async function listPages() {
  const tok = pageToken();
  const r = await fetch(GRAPH + '/me/accounts?fields=id,name,fan_count,access_token&limit=50&access_token=' + encodeURIComponent(tok), {
    signal: AbortSignal.timeout(15000)
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok || d.error) throw new Error('facebook: ' + ((d.error && d.error.message) || 'could not list pages').slice(0, 200));
  let pages = (d.data || []).map(p => ({ id: p.id, name: p.name, followers: p.fan_count, token: p.access_token }));

  // A Page owned by a business portfolio often shows up in no personal account list.
  // With business_management granted, ask the portfolio itself and reuse the Page
  // token each owned Page carries.
  if (!pages.length) {
    const biz = await fetch(GRAPH + '/me/businesses?fields=id,name&limit=25&access_token=' + encodeURIComponent(tok), {
      signal: AbortSignal.timeout(15000)
    });
    const bd = await biz.json().catch(() => ({}));
    for (const b of (bd.data || [])) {
      const own = await fetch(GRAPH + '/' + b.id + '/owned_pages?fields=id,name,access_token&limit=50&access_token=' + encodeURIComponent(tok), {
        signal: AbortSignal.timeout(15000)
      });
      const od = await own.json().catch(() => ({}));
      for (const p of (od.data || [])) pages.push({ id: p.id, name: p.name, token: p.access_token, business: b.name });
    }
  }
  return pages.map(p => ({ ...p, token: p.token || pageTokens[p.id] || '' }));
}

// Resolve the Page the owner named. Matching is forgiving (case, accents, spaces)
// because the name arrives as typed chat, not as an id.
function score(page, want) {
  const norm = (x) => String(x || '').toLowerCase().normalize('NFKD').replace(/[^a-z0-9]/g, '');
  const w = norm(want);
  if (!w) return 0;
  const n = norm(page.name);
  if (w === n) return 3;
  if (n.includes(w) || w.includes(n)) return 2;
  const words = String(want).toLowerCase().split(/[^a-z0-9]+/).filter(Boolean).map(norm);
  const hits = words.filter((x) => x && n.includes(x)).length;
  return hits ? 1 : 0;
}

async function resolvePage(want) {
  const pages = await listPages();
  if (!pages.length) throw new Error('this token can see no Pages — check the System User has the Page asset assigned');
  const asked = String(want || '').trim() || process.env.META_PAGE_ID || (pages.length === 1 ? pages[0].name : '');
  if (!asked) {
    throw new Error('which Page? this token reaches ' + pages.map((p) => p.name).join(' and ') + ' — name one');
  }
  if (pages.some((p) => p.id === asked)) return pages.find((p) => p.id === asked);
  const ranked = pages.map((p) => ({ p, s: score(p, asked) })).sort((a, b) => b.s - a.s);
  if (!ranked[0] || !ranked[0].s) throw new Error('no Page matches "' + asked + '" — this token reaches ' + pages.map((p) => p.name).join(' and '));
  return ranked[0].p;
}

// Text or link post: one call to /feed.
async function postText({ page, message, link } = {}) {
  const text = String(message || '').trim();
  if (!text) throw new Error('a post needs a message');
  const target = await resolvePage(page);
  const out = await graph('/' + target.id + '/feed', { message: text, link }, target.token);
  return { page: target.name, id: out.id, url: 'https://www.facebook.com/' + String(out.id).replace('_', '/posts/') };
}

// Image post: publish a photo with its own caption, which is what a Page should use
// rather than a link preview.
async function postImage({ page, imageUrl, message } = {}) {
  const url = String(imageUrl || '').trim();
  if (!/^https?:\/\//i.test(url)) throw new Error('imageUrl must be a public https URL');
  const target = await resolvePage(page);
  const id = target.id;
  const out = await graph('/' + id + '/photos', { url, caption: message, published: 'true' }, target.token);
  const postId = out.post_id || out.id;
  return { page: target.name, id: postId, url: 'https://www.facebook.com/' + String(postId).replace('_', '/posts/') };
}

// What the tool reports before it writes: the Page it will post to, so the owner can
// catch a wrong Page before it goes public.
// The last few messages already on the Page, newest first. The daily pipeline reads
// this before publishing so a verse that is already up there cannot go out twice, even
// if the local claim record is ever lost or reset.
async function recentPosts({ page, limit } = {}) {
  const p = await resolvePage(page);
  if (!p) throw new Error('page not found: ' + page);
  const tok = pageTokens[p.id] || pageToken();
  const r = await graph('/' + p.id + '/posts', { fields: 'message,created_time', limit: String(limit || 10) }, tok);
  return { page: { id: p.id, name: p.name }, posts: (r && r.data) || [] };
}

async function whoami() {
  if (!configured()) return { configured: false, pages: [] };
  return { configured: true, pages: await listPages() };
}

module.exports = { configured, postText, postImage, whoami, listPages, resolvePage, recentPosts, setToken, setPageTokens };
