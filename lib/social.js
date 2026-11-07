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

function pageToken() { return process.env.META_PAGE_TOKEN || ''; }

function configured() { return Boolean(pageToken()); }

async function graph(path, params) {
  const tok = pageToken();
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

async function pageId() {
  if (process.env.META_PAGE_ID) return process.env.META_PAGE_ID;
  const r = await fetch(GRAPH + '/me/accounts?fields=id,name&access_token=' + encodeURIComponent(pageToken()), {
    signal: AbortSignal.timeout(15000)
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok || d.error) throw new Error('facebook: ' + ((d.error && d.error.message) || 'could not list pages').slice(0, 200));
  const first = (d.data || [])[0];
  if (!first) throw new Error('this token can see no Pages — check the System User has the Page asset assigned');
  return first.id;
}

// Text or link post: one call to /feed.
async function postText({ message, link } = {}) {
  const text = String(message || '').trim();
  if (!text) throw new Error('a post needs a message');
  const id = await pageId();
  const out = await graph('/' + id + '/feed', { message: text, link });
  return { id: out.id, url: 'https://www.facebook.com/' + String(out.id).replace('_', '/posts/') };
}

// Image post: publish a photo with its own caption, which is what a Page should use
// rather than a link preview.
async function postImage({ imageUrl, message } = {}) {
  const url = String(imageUrl || '').trim();
  if (!/^https?:\/\//i.test(url)) throw new Error('imageUrl must be a public https URL');
  const id = await pageId();
  const out = await graph('/' + id + '/photos', { url, caption: message, published: 'true' });
  const postId = out.post_id || out.id;
  return { id: postId, url: 'https://www.facebook.com/' + String(postId).replace('_', '/posts/') };
}

// What the tool reports before it writes: the Page it will post to, so the owner can
// catch a wrong Page before it goes public.
async function whoami() {
  if (!configured()) return { configured: false };
  const id = await pageId();
  const r = await fetch(GRAPH + '/' + id + '?fields=name,fan_count&access_token=' + encodeURIComponent(pageToken()), {
    signal: AbortSignal.timeout(15000)
  });
  const d = await r.json().catch(() => ({}));
  return { configured: true, pageId: id, name: d.name || '', followers: d.fan_count };
}

module.exports = { configured, postText, postImage, whoami, pageId };
