// Instagram publishing through the linked Facebook Page.
//
// Instagram's API is a two-step job: create a media container, wait for it to finish,
// then publish it. Both calls take the Page token of the Page the account is linked to,
// never the user token. The image has to be a public JPEG, so callers pass a URL that
// Instagram's servers can fetch.

const GRAPH = 'https://graph.facebook.com/v21.0';

let storedToken = '';
let igToken = '';   // a token that additionally carries the Instagram scopes
function setToken(t) { if (t) storedToken = String(t); }
function setIgToken(t) { if (t) igToken = String(t); }
function pageToken() { return igToken || process.env.META_PAGE_TOKEN || storedToken; }

async function call(path, params, method) {
  const tok = pageToken();
  if (!tok) throw new Error('no Page token configured');
  const body = new URLSearchParams();
  for (const [k, v] of Object.entries(params || {})) {
    if (v === undefined || v === null || v === '') continue;
    body.set(k, String(v));
  }
  body.set('access_token', tok);
  const r = await fetch(GRAPH + path, { method: method || 'POST', body, signal: AbortSignal.timeout(30000) });
  const d = await r.json().catch(() => ({}));
  if (!r.ok || d.error) throw new Error('instagram: ' + ((d.error && d.error.message) || 'request failed').slice(0, 220));
  return d;
}

async function get(path, fields) {
  const tok = pageToken();
  const sep = path.includes('?') ? '&' : '?';
  const r = await fetch(GRAPH + path + sep + 'fields=' + encodeURIComponent(fields) + '&access_token=' + encodeURIComponent(tok), { signal: AbortSignal.timeout(20000) });
  const d = await r.json().catch(() => ({}));
  if (!r.ok || d.error) throw new Error('instagram: ' + ((d.error && d.error.message) || 'request failed').slice(0, 220));
  return d;
}

// Which Page carries the Instagram account, and what that account is called. Asking for
// this field is also the honest test of whether instagram_basic is on the token.
async function accounts() {
  const d = await get('/me/accounts', 'name,instagram_business_account{id,username}');
  return (d.data || [])
    .filter((p) => p.instagram_business_account && p.instagram_business_account.id)
    .map((p) => ({ page: p.name, pageId: p.id, igId: p.instagram_business_account.id, username: p.instagram_business_account.username }));
}

async function resolve(want) {
  const list = await accounts();
  if (!list.length) throw new Error('no Instagram business account is linked to any Page this token reaches, or instagram_basic is missing');
  const w = String(want || '').toLowerCase().replace(/^@/, '').trim();
  if (!w) return list[0];
  const hit = list.find((a) => a.username && a.username.toLowerCase() === w)
    || list.find((a) => a.username && a.username.toLowerCase().includes(w))
    || list.find((a) => a.page && a.page.toLowerCase().includes(w));
  if (!hit) throw new Error('no linked Instagram account matches "' + want + '"; available: ' + list.map((a) => '@' + a.username).join(', '));
  return hit;
}

// Container status is asynchronous: a large image can still be processing when the
// create call returns, so poll briefly before publishing.
async function waitReady(containerId) {
  for (let i = 0; i < 10; i++) {
    const d = await get('/' + containerId, 'status_code,status');
    const code = d.status_code || '';
    if (code === 'FINISHED') return true;
    if (code === 'ERROR' || code === 'EXPIRED') throw new Error('instagram rejected the media: ' + (d.status || code));
    await new Promise((r) => setTimeout(r, 2000));
  }
  return false;
}

async function publish({ account, imageUrl, caption, videoUrl, isReel } = {}) {
  const url = String(imageUrl || videoUrl || '').trim();
  if (!/^https?:\/\//i.test(url)) throw new Error('a public image or video URL is required');
  const acct = await resolve(account);
  const params = { caption };
  if (videoUrl) {
    params.media_type = isReel === false ? 'VIDEO' : 'REELS';
    params.video_url = videoUrl;
  } else {
    params.image_url = url;
  }
  const created = await call('/' + acct.igId + '/media', params);
  if (!created.id) throw new Error('instagram did not return a media container');
  await waitReady(created.id);
  const pub = await call('/' + acct.igId + '/media_publish', { creation_id: created.id });
  let permalink = '';
  try { permalink = (await get('/' + (pub.id || created.id), 'permalink')).permalink || ''; } catch (e) { /* link is a nicety */ }
  return { account: '@' + acct.username, page: acct.page, id: pub.id, permalink };
}

// Instagram tokens from Explorer/the debugger expire, so surface the date instead of
// discovering it when a publish fails.
async function tokenInfo() {
  const t = pageToken();
  if (!t) return null;
  const r = await fetch(`${GRAPH}/debug_token?input_token=${encodeURIComponent(t)}&access_token=${encodeURIComponent(t)}`);
  const j = await r.json();
  const d = (j && j.data) || {};
  const exp = Number(d.expires_at) || 0;
  return {
    type: d.type || null,
    valid: !!d.is_valid,
    scopes: d.scopes || [],
    expiresAt: exp ? new Date(exp * 1000).toISOString() : null,
    daysLeft: exp ? Math.round((exp * 1000 - Date.now()) / 86400000) : null
  };
}

module.exports = {
  tokenInfo, accounts, resolve, publish, setToken, setIgToken };
