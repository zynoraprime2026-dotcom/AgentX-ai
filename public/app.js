/* AgentX dashboard frontend */
const $ = (s) => document.querySelector(s);
const $$ = (s) => document.querySelectorAll(s);
let agents = [];
let editingId = null;
let chatAgent = null;
let health = null;
let suiteStatus = null;
let kbDocs = [];
let languages = { en: 'English' };

// A founder key is 48 characters. Checking the length here stops a truncated paste from
// spending one of the few recovery attempts the server allows.
function founderKeyProblem(key) {
  const k = String(key || '').trim();
  if (!k) return 'Paste your founder key.';
  if (k.length !== 48) return 'That key is ' + k.length + ' characters; a founder key is 48. Copy the whole thing.';
  return '';
}

async function api(path, opts = {}) {
  const r = await fetch('/api' + path, {
    cache: 'no-store',
    headers: { 'Content-Type': 'application/json' },
    ...opts, body: opts.body ? JSON.stringify(opts.body) : undefined
  });
  const d = await r.json().catch(() => ({}));
  if (r.status === 401) { showLogin(); throw new Error('login required'); }
  if (!r.ok) throw new Error(d.error || r.status);
  return d;
}

function toast(msg) {
  const t = $('#toast'); t.textContent = msg; t.classList.remove('hidden');
  clearTimeout(t._h); t._h = setTimeout(() => t.classList.add('hidden'), 2600);
}

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function pill(status) {
  return `<span class="pill ${status === 'live' ? 'live' : ''} ${status === 'paused' ? 'paused' : ''}">${esc(status)}</span>`;
}

function fmtDate(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (isNaN(d)) return '—';
  return d.toLocaleString(undefined, { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
}

// ---------- auth ----------
function showLogin() { $('#loginOverlay').classList.remove('hidden'); $('#loginErr').textContent = ''; }
$$('.logintab').forEach(t => t.onclick = () => {
  $$('.logintab').forEach(x => x.classList.remove('active'));
  t.classList.add('active');
  $('#signinForm').style.display = t.dataset.tab === 'signin' ? 'flex' : 'none';
  $('#signupForm').style.display = t.dataset.tab === 'signup' ? 'flex' : 'none';
  $('#recoverForm').style.display = t.dataset.tab === 'recover' ? 'flex' : 'none';
});
$('#loginBtn').onclick = async () => {
  try { await api('/auth/login', { method: 'POST', body: { email: $('#loginEmail').value, password: $('#loginPass').value } }); location.reload(); }
  catch (e) { $('#loginErr').textContent = e.message; }
};
$('#registerBtn').onclick = async () => {
  try {
    await api('/auth/register', { method: 'POST', body: {
      name: $('#regName').value.trim(), email: $('#regEmail').value.trim(),
      password: $('#regPass').value, founderKey: $('#regKey').value.trim()
    } });
    location.reload();
  } catch (e) { $('#loginErr').textContent = e.message; }
};
$('#recoverBtn').onclick = async () => {
  try {
    await api('/auth/recover', { method: 'POST', body: { email: $('#recEmail').value.trim(), founderKey: $('#recKey').value.trim(), password: $('#recPass').value } });
    location.reload();
  } catch (e) { $('#loginErr').textContent = e.message; }
};

$('#changePwBtn').onclick = async () => {
  try {
    await api('/auth/password', { method: 'POST', body: { current: $('#pwCurrent').value, next: $('#pwNext').value } });
    $('#pwCurrent').value = ''; $('#pwNext').value = '';
    toast('Password updated');
  } catch (e) { toast(e.message); }
};

$('#logoutBtn').onclick = async () => {
  try { await api('/auth/logout', { method: 'POST' }); } catch (e) {}
  location.reload();
};

// ---------- navigation ----------
const views = {
  overview: renderOverview, agents: renderAgents, analytics: renderAnalytics,
  conversations: renderConversations,
  reminders: loadReminders, triggers: loadTriggers, channels: () => renderHealth(),
  connectors: renderConnectors,
  pagesview: renderPages,
  billing: loadBilling, settings: loadHealth
};

function switchView(name) {
  $$('.navbtn').forEach(x => x.classList.toggle('active', x.dataset.view === name));
  $$('.view').forEach(v => v.classList.add('hidden'));
  const el = $('#view-' + name);
  if (el) el.classList.remove('hidden');
  if (views[name]) { try { views[name](); } catch (e) { toast(e.message); } }
  if (name === 'agents') maybeCoach();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

$$('.navbtn').forEach(b => b.onclick = () => switchView(b.dataset.view));
document.addEventListener('click', (e) => {
  const go = e.target.closest('[data-goto]');
  if (go) switchView(go.dataset.goto);
});




// ---------- install as an app ----------
// A laptop install is a Chromium "install" prompt, and on Safari or Firefox there is no
// prompt at all, so the button explains the browser step instead of pretending to work.
let installEvent = null;

function setupInstall() {
  const btn = $('#installApp');
  if (!btn) return;
  if (window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone) return;

  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    installEvent = e;
    btn.style.display = '';
    btn.textContent = '⬇️ Install on this laptop';
  });

  window.addEventListener('appinstalled', () => {
    installEvent = null;
    btn.style.display = 'none';
    toast('AgentX is installed. Open it from your app list.');
  });

  btn.onclick = async () => {
    if (installEvent) {
      installEvent.prompt();
      const choice = await installEvent.userChoice.catch(() => ({ outcome: 'dismissed' }));
      installEvent = null;
      if (choice && choice.outcome === 'accepted') btn.style.display = 'none';
      else btn.textContent = '⬇️ Try installing again';
      return;
    }
    const ua = navigator.userAgent;
    let how;
    if (/firefox/i.test(ua)) how = 'Firefox on a laptop cannot install web apps. Open AgentX in Chrome or Edge.';
    else if (/safari/i.test(ua)) how = 'In Safari use Share, then Add to Dock.';
    else how = 'Open the browser menu (three dots, top right), then Apps, then Install this site as an app.';
    toast(how);
  };
}

function setupServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  navigator.serviceWorker.register('/sw.js').catch(() => {});
  navigator.serviceWorker.addEventListener('message', (e) => {
    if (e.data === 'agentx-update') toast('A new AgentX build is ready. Reload to use it.');
  });
}

// ---------- pages ----------
// The same three abilities the owner's chat has, with the same rule: a profile change is
// shown as a diff first, and the Apply button only exists after that preview.
let pageProfileCache = null;

async function renderPages() {
  const pick = $('#pgPick');
  try {
    const d = await api('/admin/page-settings');
    const names = d.pages && d.pages.length ? d.pages : [d.page];
    if (!pick.options.length) {
      pick.innerHTML = names.map((n) => '<option' + (n === d.page ? ' selected' : '') + '>' + esc(n) + '</option>').join('');
    }
    pageProfileCache = d;
    drawProfile(d);
  } catch (e) { $('#pgProfile').textContent = 'Could not read the Page: ' + e.message; }
  loadSchedule();
  loadHits();
  pick.onchange = () => loadProfiles(pick.value);
  $('#pgReload').onclick = () => { loadProfiles(pick.value); loadSchedule(); loadHits(); };
  $('#pgPreview').onclick = () => previewProfile(pick.value);
  $('#pgSchedSave').onclick = () => saveSchedule();
}

async function loadProfiles(name) {
  try {
    const d = await api('/admin/page-settings?page=' + encodeURIComponent(name || ''));
    pageProfileCache = d;
    drawProfile(d);
  } catch (e) { toast('Could not read that Page: ' + e.message); }
}

function drawProfile(d) {
  const p = d.profile || {};
  $('#pgProfile').innerHTML = '<b>' + esc(p.name || d.page) + '</b> · ' + esc(p.category || 'no category')
    + ' · ' + (p.followers_count == null ? 'followers not reported' : p.followers_count + ' followers')
    + (p.link ? ' · <a href="' + esc(p.link) + '" target="_blank" rel="noopener">open</a>' : '');
  const fields = d.fields || Object.keys(d.editable || {});
  $('#pgFields').innerHTML = fields.map((f) => {
    const v = (d.editable && d.editable[f]) || '';
    const long = ['about', 'description', 'hours', 'personal_info'].includes(f);
    const input = long
      ? '<textarea class="input" data-field="' + f + '" rows="3">' + esc(v) + '</textarea>'
      : '<input class="input" data-field="' + f + '" value="' + esc(v) + '">';
    return '<label class="muted" style="display:block">' + f + input + '</label>';
  }).join('');
  $('#pgDiff').innerHTML = '';
  $('#pgApply').disabled = true;
  $('#pgNote').textContent = 'Edit a field, then preview.';
}

function profileChanges() {
  const out = {};
  $$('#pgFields [data-field]').forEach((el) => {
    const field = el.dataset.field;
    const before = (pageProfileCache && pageProfileCache.editable && pageProfileCache.editable[field]) || '';
    const now = el.value.trim();
    if (now && now !== before) out[field] = now;
  });
  return out;
}

async function previewProfile(name) {
  const changes = profileChanges();
  if (!Object.keys(changes).length) { $('#pgNote').textContent = 'Nothing changed yet.'; return; }
  try {
    const d = await api('/admin/page-settings', { method: 'POST', body: { page: name, changes } });
    if (d.unchanged) { $('#pgNote').textContent = d.message; return; }
    $('#pgDiff').innerHTML = '<div class="table-wrap"><table><thead><tr><th>Field</th><th>Now</th><th>After</th></tr></thead><tbody>'
      + d.diff.map((r) => '<tr><td>' + esc(r.field) + '</td><td>' + esc(r.from).slice(0, 160) + '</td><td>' + esc(r.to).slice(0, 160) + '</td></tr>').join('')
      + '</tbody></table></div>';
    $('#pgNote').textContent = 'Preview only. Nothing has been sent to Facebook.';
    $('#pgApply').disabled = false;
    $('#pgApply').onclick = () => applyProfile(name, changes);
  } catch (e) { $('#pgNote').textContent = 'Could not preview: ' + e.message; }
}

async function applyProfile(name, changes) {
  $('#pgApply').disabled = true;
  try {
    const d = await api('/admin/page-settings?confirm=1', { method: 'POST', body: { page: name, changes } });
    toast(d.applied ? 'Saved ' + (d.changed || []).join(', ') + ' on ' + name : 'Nothing was saved');
    $('#pgNote').textContent = d.applied ? 'Applied.' : (d.message || 'Nothing saved.');
    loadProfiles(name);
  } catch (e) { $('#pgNote').textContent = 'Facebook refused it: ' + e.message; $('#pgApply').disabled = false; }
}

async function loadSchedule() {
  try {
    const d = await api('/admin/daily-schedule');
    const map = d.schedule || {};
    $('#pgSchedule').innerHTML = ['morning', 'evening'].map((slot) => {
      const e = map[slot] || {};
      return '<div><label class="muted" style="display:block">' + slot + ' · 06:00 / 19:30 UTC'
        + '<input class="input" data-slot="' + slot + '" data-kind="page" value="' + esc(e.page || '') + '">'
        + '<input class="input" data-slot="' + slot + '" data-kind="ig" placeholder="Instagram handle, empty for Facebook only" value="' + esc(e.igAccount || '') + '">'
        + '</label></div>';
    }).join('') + '<div class="muted">third run: ' + esc(((map.promo || {}).page) || 'Zynora Prime') + ' (rides the evening run)</div>';
    $('#pgSchedNote').textContent = 'Saving points the next run at those accounts.';
  } catch (e) { $('#pgSchedule').textContent = 'Could not read the schedule: ' + e.message; }
}

async function saveSchedule() {
  const body = {};
  $$('#pgSchedule [data-slot]').forEach((el) => {
    const slot = el.dataset.slot;
    body[slot] = body[slot] || {};
    if (el.dataset.kind === 'page') body[slot].page = el.value.trim();
    if (el.dataset.kind === 'ig') body[slot].ig = el.value.trim().replace(/^@/, '');
  });
  try {
    const d = await api('/admin/daily-schedule', { method: 'POST', body });
    const map = d.schedule || {};
    toast('Saved: morning ' + map.morning.page + ', evening ' + map.evening.page);
    loadSchedule();
  } catch (e) { const m = 'Could not save: ' + e.message; toast(m); $('#pgSchedNote').textContent = m; }
}

async function loadHits() {
  try {
    const d = await api('/admin/cron-hits');
    if (!d.count) {
      $('#pgHits').innerHTML = '<p class="muted">No run has stamped yet. That means either nothing fired or the record was reset today.</p>';
      return;
    }
    $('#pgHits').innerHTML = '<table><thead><tr><th>When</th><th>Run</th></tr></thead><tbody>'
      + d.hits.map((h) => '<tr><td>' + esc(String(h.at).replace('T', ' ').slice(0, 19)) + '</td><td>' + esc(h.entry) + '</td></tr>').join('')
      + '</tbody></table>';
  } catch (e) { $('#pgHits').textContent = 'Could not read the heartbeat: ' + e.message; }
}

// ---------- connectors ----------
// One screen that answers "what is wired up and what does it let an agent do", with a live
// test per service instead of a status flag nobody trusts.
async function renderConnectors(force) {
  const list = $('#connList');
  if (list) list.innerHTML = skeletonRows(5);
  let d;
  try { d = await api('/connectors' + (force ? '?refresh=1' : '')); }
  catch (e) { if (list) list.innerHTML = `<p class="muted">${esc(e.message)}</p>`; return; }
  const rows = d.connectors || [];
  const s = d.summary || {};
  const tiles = $('#connTiles');
  if (tiles) {
    tiles.innerHTML = [
      ['Connected', s.connected || 0, 'answering right now'],
      ['Needs attention', s.broken || 0, 'configured but failing'],
      ['Not set up', s.missing || 0, 'no key on the server']
    ].map(([label, n, hint]) => `<div class="card"><div class="muted">${esc(label)}</div><div class="big">${n}</div><div class="muted small">${esc(hint)}</div></div>`).join('');
  }
  if (!list) return;
  const dot = (st) => st === 'connected' ? '🟢' : st === 'error' ? '🟠' : '⚪';
  list.innerHTML = rows.map(c => `
    <div class="card inner" style="margin-bottom:12px">
      <div class="row-between">
        <div><b>${dot(c.state)} ${esc(c.name)}</b> <span class="chip">${esc(c.category)}</span>
          <span class="chip">${c.scope === 'read' ? 'reads' : 'can write'}</span></div>
        <div class="conv-tools">
          <span class="muted small">${esc(c.state === 'connected' ? (c.ms ? c.ms + 'ms' : 'live') : c.state === 'error' ? 'failing' : 'not set')}</span>
          <button class="btn small" data-conn="${esc(c.id)}">Test</button>
        </div>
      </div>
      <div class="muted" style="margin:8px 0 6px">${esc(c.enables)}</div>
      <div class="muted small">${esc(c.detail || '')}</div>
      ${c.tools && c.tools.length ? `<div class="chips" style="margin-top:8px">${c.tools.map(t => `<span class="chip">${esc(t)}</span>`).join('')}</div>` : ''}
      ${c.note ? `<div class="muted small" style="margin-top:8px">${esc(c.note)}</div>` : ''}
      ${c.missing && c.missing.length ? `<div class="muted small" style="margin-top:8px">Set on the server: <code>${esc(c.missing.join(', '))}</code></div>` : ''}
    </div>`).join('');
  $$('[data-conn]').forEach(btn => {
    btn.onclick = async () => {
      btn.disabled = true; btn.textContent = 'Testing…';
      try {
        const one = await api('/connectors/' + btn.dataset.conn + '/test', { method: 'POST' });
        toast(one.name + ': ' + (one.state === 'connected' ? 'connected' : one.detail));
      } catch (e) { toast(e.message); }
      renderConnectors(true);
    };
  });
  const refresh = $('#connRefresh');
  if (refresh) refresh.onclick = () => renderConnectors(true);
}

// ---------- overview ----------
function renderOverview() {
  const live = agents.filter(a => a.status === 'live').length;
  const msgs = agents.reduce((s, a) => s + (a.messagesHandled || 0), 0);
  const wa = agents.filter(a => a.platforms?.whatsapp?.enabled).length;
  const tg = agents.filter(a => a.platforms?.telegram?.enabled).length;
  $('#statCards').innerHTML = `
    <div class="card"><div class="num">${agents.length}</div><div class="lbl">Total agents</div></div>
    <div class="card"><div class="num" style="color:var(--green)">${live}</div><div class="lbl">Live now</div></div>
    <div class="card"><div class="num">${msgs}</div><div class="lbl">Messages handled</div></div>
    <div class="card"><div class="num">${wa} <small>WA</small> · ${tg} <small>TG</small></div><div class="lbl">Channels enabled</div></div>`;
  fetch('/api/broadcast/subscribers').then(r => r.json()).then(subs => {
    const el = document.createElement('div');
    el.className = 'card';
    el.innerHTML = `<div class="num">${Object.keys(subs || {}).length}</div><div class="lbl">Fajr subscribers</div>`;
    $('#statCards').appendChild(el);
  }).catch(() => {});
  const main = agents.find(a => a.isMain) || agents.find(a => a.status === 'live') || agents[0];
  const mainCard = $('#mainAgentCard');
  if (mainCard) {
    mainCard.innerHTML = main ? `
      <div class="row-between">
        <div>
          <div class="muted" style="font-size:12px">MAIN AGENT</div>
          <div style="display:flex;align-items:center;gap:8px;margin-top:4px">
            <span style="font-size:22px">${esc(main.emoji)}</span>
            <strong style="font-size:18px">${esc(main.name)}</strong>
            ${pill(main.status)}
            ${main.isMain ? '' : '<span class="muted" style="font-size:12px">(busiest live agent, tap ☆ on a card to fix this)</span>'}
          </div>
          <div class="muted" style="font-size:13px;margin-top:4px">${esc(main.description || 'No description yet')}</div>
        </div>
        <div style="text-align:right">
          <div class="muted" style="font-size:12px">${main.messagesHandled || 0} messages</div>
          <button class="btn primary" id="mainAgentChat" style="margin-top:6px">Open chat</button>
        </div>
      </div>` : '<p class="muted">No agents yet.</p>';
    const btn = $('#mainAgentChat');
    if (btn && main) btn.onclick = () => openChat(main.id);
  }
  $('#overviewAgents').innerHTML = agents.filter(a => a.status === 'live' && (!main || a.id !== main.id)).map(a => `
    <div class="agent-card static">
      <div class="top"><span class="emoji">${esc(a.emoji)}</span><span class="name">${esc(a.name)}</span>${pill(a.status)}</div>
      <div class="muted" style="font-size:13px">${esc(a.description || '')}</div>
    </div>`).join('') || '<p class="muted">No live agents yet. Create one and set it live.</p>';
}

// ---------- agents: cards, search, drag to reorder ----------
function visibleAgents() {
  const q = ($('#agentSearch')?.value || '').trim().toLowerCase();
  const st = $('#agentStatusFilter')?.value || '';
  const md = $('#agentModelFilter')?.value || '';
  return agents.filter(a => {
    if (st && a.status !== st) return false;
    if (md && a.model !== md) return false;
    if (!q) return true;
    return [a.name, a.description, a.status, a.model].join(' ').toLowerCase().includes(q);
  });
}

function renderAgents() {
  const list = visibleAgents();
  const count = $('#agentCount');
  if (count) count.textContent = list.length === agents.length ? `${agents.length} agent${agents.length === 1 ? '' : 's'}` : `${list.length} of ${agents.length}`;
  const grid = $('#agentsList');
  grid.innerHTML = list.map(a => {
    const wa = a.platforms?.whatsapp?.enabled;
    const tg = a.platforms?.telegram?.enabled;
    const langs = (a.languages || []).map(l => languages[l] || l).join(', ');
    return `<div class="agent-card" draggable="true" data-id="${a.id}">
      <div class="top">
        <span class="drag" title="Drag to reorder">⠿</span>
        <span class="emoji">${esc(a.emoji)}</span>
        <span class="name">${esc(a.name)}</span>
        <button class="icon-btn" data-quick="${a.id}" title="Quick edit name and emoji">✏️</button>
      </div>
      <div class="desc">${esc(a.description || 'No description yet')}</div>
      <div class="chips">
        <span class="chip" title="Model">${esc((a.model || '').split('/').pop())}</span>
        ${langs ? `<span class="chip" title="Languages">🌐 ${esc(langs)}</span>` : ''}
        ${a.knowledgeEnabled === false ? '' : '<span class="chip" title="Knowledge files">📚</span>'}
      </div>
      <div class="card-foot">
        <label class="mini" title="Answer on WhatsApp"><span>WA</span><span class="toggle ${wa ? 'on' : ''}" data-ch="whatsapp" data-agent="${a.id}"></span></label>
        <label class="mini" title="Answer on Telegram"><span>TG</span><span class="toggle ${tg ? 'on' : ''}" data-ch="telegram" data-agent="${a.id}"></span></label>
        <div class="foot-actions">
          <a class="icon-btn" href="/api/agents/${a.id}/export" download title="Download this agent's config">⬇️</a>
          ${pill(a.status)}
          <button class="icon-btn" data-main="${a.id}" title="${a.isMain ? 'This is the main agent' : 'Make this the main agent'}">${a.isMain ? '★' : '☆'}</button>
          <button class="icon-btn" data-test="${a.id}" title="Test chat">💬</button>
          <button class="icon-btn" data-edit="${a.id}" title="Open full editor">⚙️</button>
          <button class="icon-btn danger" data-del="${a.id}" title="Delete agent">🗑</button>
        </div>
      </div>
    </div>`;
  }).join('') || '<p class="muted">No agents match that search.</p>';

  grid.querySelectorAll('[data-main]').forEach(b => b.onclick = async () => {
    try { await api('/agents/' + b.dataset.main + '/main', { method: 'POST' }); await load(); toast('Main agent set'); }
    catch (e) { toast(e.message); }
  });
  grid.querySelectorAll('[data-test]').forEach(b => b.onclick = () => openChat(b.dataset.test));
  grid.querySelectorAll('[data-edit]').forEach(b => b.onclick = () => openEditor(b.dataset.edit));
  grid.querySelectorAll('[data-quick]').forEach(b => b.onclick = () => openQuickEdit(b.dataset.quick));
  grid.querySelectorAll('[data-del]').forEach(b => b.onclick = async () => {
    if (!confirm('Delete this agent?')) return;
    try { await api('/agents/' + b.dataset.del, { method: 'DELETE' }); await load(); toast('Agent deleted'); }
    catch (e) { toast(e.message); }
  });
  grid.querySelectorAll('.toggle[data-ch]').forEach(t => t.onclick = async (e) => {
    e.stopPropagation();
    const a = agents.find(x => x.id === t.dataset.agent);
    a.platforms = a.platforms || {};
    a.platforms[t.dataset.ch] = a.platforms[t.dataset.ch] || { enabled: false, autoReply: true };
    a.platforms[t.dataset.ch].enabled = !a.platforms[t.dataset.ch].enabled;
    try { await api('/agents/' + a.id, { method: 'PUT', body: { platforms: a.platforms } }); renderAgents(); }
    catch (err) { toast(err.message); }
  });
  wireDragAndDrop();
}

function wireDragAndDrop() {
  let dragId = null;
  $$('#agentsList .agent-card').forEach(card => {
    card.addEventListener('dragstart', (e) => {
      dragId = card.dataset.id;
      card.classList.add('dragging');
      if (e.dataTransfer) { e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', dragId); }
    });
    card.addEventListener('dragend', () => {
      card.classList.remove('dragging');
      $$('#agentsList .agent-card').forEach(c => c.classList.remove('drop-target'));
    });
    card.addEventListener('dragover', (e) => {
      e.preventDefault();
      if (card.dataset.id !== dragId) card.classList.add('drop-target');
    });
    card.addEventListener('dragleave', () => card.classList.remove('drop-target'));
    card.addEventListener('drop', async (e) => {
      e.preventDefault();
      card.classList.remove('drop-target');
      const targetId = card.dataset.id;
      if (!dragId || dragId === targetId) return;
      const from = agents.findIndex(a => a.id === dragId);
      const to = agents.findIndex(a => a.id === targetId);
      if (from < 0 || to < 0) return;
      const [moved] = agents.splice(from, 1);
      agents.splice(to, 0, moved);
      renderAgents();
      try { await api('/agents/reorder', { method: 'POST', body: { ids: agents.map(a => a.id) } }); toast('Order saved'); }
      catch (err) { toast(err.message); }
    });
  });
}

[['#agentSearch', 'input'], ['#agentStatusFilter', 'change'], ['#agentModelFilter', 'change']].forEach(([sel, ev]) => {
  const el = $(sel);
  if (el) el.addEventListener(ev, () => renderAgents());
});

// ---------- describe an agent ----------
// A description becomes a draft the person edits, never an agent: the model is good
// at the shape of a role and bad at knowing which tools it truly needs.
const DRAFT_TOOL_LABELS = { ilm: 'Islamic lookups', turath: 'Manuscripts', shop: 'Shop & orders', profile: 'Customer memory', studio: 'Film & video' };

function wireDraftBox() {
  const btn = $('#draftBtn');
  const input = $('#draftInput');
  if (!btn || !input || btn.dataset.wired) return;
  btn.dataset.wired = '1';
  btn.onclick = async () => {
    const description = String(input.value || '').trim();
    if (description.length < 8) return toast('Describe what it should do, in a sentence or two.');
    btn.disabled = true; btn.textContent = 'Drafting…';
    try {
      const r = await api('/agents/draft', { method: 'POST', body: { description } });
      renderDraft(r.draft, r.remaining);
    } catch (e) { toast(e.message); }
    finally { btn.disabled = false; btn.textContent = 'Draft it'; }
  };
}

function describeValue(field, v) {
  if (field === 'telegram' || field === 'whatsapp') return v ? 'on' : 'off';
  const t = String(v == null ? '' : v);
  return t.length > 120 ? t.slice(0, 120) + '…' : (t || '(empty)');
}

function renderPendingChange(c) {
  const body = $('#chatBody');
  if (!body || !c) return;
  const card = document.createElement('div');
  card.className = 'msg';
  card.style.cssText = 'display:grid;gap:8px;border:1px dashed var(--line);border-radius:10px;padding:10px';
  const fieldLabel = { name: 'Name', description: 'Description', systemPrompt: 'Instructions', status: 'Status', telegram: 'Telegram', whatsapp: 'WhatsApp' }[c.field] || c.field;
  card.innerHTML = `<div><strong>${esc(c.agentName)}</strong> · ${esc(fieldLabel)}</div>
    <div class="muted" style="font-size:12px">from <code>${esc(describeValue(c.field, c.from))}</code> to <code>${esc(describeValue(c.field, c.to))}</code></div>
    <div style="display:flex;gap:8px"><button class="btn primary" id="pcApply">Apply</button><button class="btn" id="pcDrop">Discard</button></div>`;
  body.appendChild(card);
  card.querySelector('#pcDrop').onclick = () => card.remove();
  card.querySelector('#pcApply').onclick = async () => {
    const btn = card.querySelector('#pcApply');
    btn.disabled = true; btn.textContent = 'Applying…';
    try {
      await api('/agents/' + c.agentId, { method: 'PUT', body: c.patch });
      card.remove();
      await load();
      toast('Change applied');
    } catch (e) { toast(e.message); btn.disabled = false; btn.textContent = 'Apply'; }
  };
  body.scrollTop = body.scrollHeight;
}

function renderDraft(d, remaining) {
  const box = $('#draftResult');
  if (!box || !d) return;
  const meter = $('#draftMeter');
  if (meter && remaining !== null && remaining !== undefined) {
    meter.textContent = remaining + ' draft' + (remaining === 1 ? '' : 's') + ' left today';
  }
  const checked = new Set(d.toolsets || []);
  const tools = Object.keys(DRAFT_TOOL_LABELS).map(k =>
    `<label><input type="checkbox" value="${k}"${checked.has(k) ? ' checked' : ''}> ${DRAFT_TOOL_LABELS[k]}</label>`).join('');
  const qs = (d.sampleQuestions || []).length
    ? `<div><span class="muted" style="font-size:12px">What it will be asked</span><ul class="draft-qs">${d.sampleQuestions.map(q => `<li>${esc(q)}</li>`).join('')}</ul></div>`
    : '';
  box.classList.remove('hidden');
  box.innerHTML = `<div class="draft-card">
    <div class="row-between">
      <strong>${d.generated ? 'Draft' : 'Draft (written from your words, the model was busy)'}</strong>
      <span class="muted" style="font-size:12px">${d.needsKnowledge ? 'Needs a knowledge doc to be good' : 'No knowledge doc needed'}</span>
    </div>
    <div style="display:grid;grid-template-columns:70px 1fr;gap:10px">
      <label>Emoji<input id="draftEmoji" value="${esc(d.emoji || '🤖')}" maxlength="4"></label>
      <label>Name<input id="draftName" value="${esc(d.name || '')}" maxlength="60"></label>
    </div>
    <label>What it does<input id="draftDesc" value="${esc(d.description || '')}" maxlength="300"></label>
    <label>Instructions<textarea id="draftPrompt" rows="7">${esc(d.systemPrompt || '')}</textarea></label>
    <div><span class="muted" style="font-size:12px">Tools it gets</span><div class="draft-tools">${tools}</div></div>
    ${qs}
    <div class="row-between">
      <button class="btn" id="draftDiscard">Discard</button>
      <button class="btn primary" id="draftCreate">Create agent</button>
    </div>
  </div>`;
  $('#draftDiscard').onclick = () => { box.classList.add('hidden'); box.innerHTML = ''; };
  $('#draftCreate').onclick = async () => {
    const name = String($('#draftName').value || '').trim();
    if (!name) return toast('Give it a name first.');
    const toolsets = [...box.querySelectorAll('.draft-tools input:checked')].map(i => i.value);
    const btn = $('#draftCreate');
    btn.disabled = true; btn.textContent = 'Creating…';
    try {
      await api('/agents', { method: 'POST', body: {
        name,
        emoji: String($('#draftEmoji').value || '🤖').trim().slice(0, 4) || '🤖',
        description: String($('#draftDesc').value || '').trim().slice(0, 300),
        systemPrompt: String($('#draftPrompt').value || '').trim().slice(0, 4000),
        toolsets,
        source: 'builder'
      } });
      box.classList.add('hidden'); box.innerHTML = '';
      const input = $('#draftInput'); if (input) input.value = '';
      await load();
      toast(name + ' created as a draft');
    } catch (e) {
      toast(e.message);
      btn.disabled = false; btn.textContent = 'Create agent';
    }
  };
}

// ---------- quick edit ----------
let quickId = null;
function openQuickEdit(id) {
  const a = agents.find(x => x.id === id);
  if (!a) return;
  quickId = id;
  $('#qeEmoji').value = a.emoji || '🤖';
  $('#qeName').value = a.name || '';
  $('#quickEdit').classList.remove('hidden');
  $('#qeName').focus();
}
$('#qeCancel').onclick = () => $('#quickEdit').classList.add('hidden');
$('#qeSave').onclick = async () => {
  const name = $('#qeName').value.trim();
  if (!name) return toast('Name is required');
  try {
    await api('/agents/' + quickId, { method: 'PUT', body: { name, emoji: $('#qeEmoji').value.trim() || '🤖' } });
    $('#quickEdit').classList.add('hidden');
    await load(); toast('Saved');
  } catch (e) { toast(e.message); }
};

// ---------- editor ----------
const TONE_WORDS = ['', 'formal', 'polished', 'balanced', 'warm', 'casual'];
const DEPTH_WORDS = ['', 'very brief', 'brief', 'clear', 'teaching', 'deep'];

function renderLangChips(selected) {
  $('#langChips').innerHTML = Object.entries(languages).map(([code, name]) =>
    `<label class="chip check ${selected.includes(code) ? 'on' : ''}"><input type="checkbox" value="${code}" ${selected.includes(code) ? 'checked' : ''}> ${esc(name)}</label>`
  ).join('');
  $('#langChips').querySelectorAll('input').forEach(i => i.onchange = () => i.closest('.chip').classList.toggle('on', i.checked));
}

function openEditor(id) {
  editingId = id || null;
  const a = id ? agents.find(x => x.id === id) : null;
  $('#editorTitle').textContent = a ? 'Edit ' + a.name : 'New agent';
  $('#fName').value = a?.name || ''; $('#fEmoji').value = a?.emoji || '🤖';
  $('#fDesc').value = a?.description || ''; $('#fPrompt').value = a?.systemPrompt || '';
  $('#fModel').value = a?.model || 'openai/gpt-oss-120b';
  $('#fStatus').value = a?.status || 'draft';
  $('#fWaPhone').value = a?.waPhoneId || ''; $('#fWaToken').value = '';
  $('#fWaToken').placeholder = a?.waTokenSet ? 'Token saved. Leave blank to keep it' : 'Paste your Meta access token';
  const p = a?.persona || {};
  $('#fTone').value = p.tone || 3; $('#fDepth').value = p.depth || 3;
  $('#fPreset').value = p.preset || ''; $('#fSignoff').value = p.signoff || '';
  $('#fNoHumor').checked = Boolean(p.noHumor);
  $('#fAutoLang').checked = a ? a.autoLanguage !== false : true;
  $('#fGroupReply').value = a?.groupReply || 'mention';
  $('#fKnowledge').checked = a ? a.knowledgeEnabled !== false : true;
  renderLangChips(a?.languages || []);
  updatePersonaLabels();
  renderPreview();
  $('#knowledgeCard').classList.toggle('hidden', !id);
  kbDocs = [];
  $('#kbList').innerHTML = '';
  if (id) loadKnowledge(id);
  $('#editor').classList.remove('hidden');
  $('#editor').scrollIntoView({ behavior: 'smooth', block: 'start' });
  if (!id) $('#fName').focus();
}

function updatePersonaLabels() {
  $('#toneLabel').textContent = TONE_WORDS[Number($('#fTone').value)] || '';
  $('#depthLabel').textContent = DEPTH_WORDS[Number($('#fDepth').value)] || '';
}

function renderPreview() {
  const name = $('#fName').value.trim() || 'Your agent';
  const emoji = $('#fEmoji').value.trim() || '🤖';
  const tone = Number($('#fTone').value);
  const depth = Number($('#fDepth').value);
  const preset = $('#fPreset').value;
  const opener = tone <= 2 ? 'Good afternoon. How may I help you today?' : tone === 3 ? 'Hi! How can I help?' : 'Hey! What do you need?';
  const bodyLine = depth <= 2 ? 'Short answer, no waffle.' : depth === 3 ? 'A clear answer with the detail that matters.' : 'The answer, then the evidence behind it, with a caveat where it counts.';
  const ask = $('#fPrompt').value.trim();
  $('#promptPreview').innerHTML = `
    <div class="msg bot">${esc(opener)}</div>
    <div class="msg bot">${esc(bodyLine)}</div>
    <div class="preview-meta muted">
      ${emoji} ${esc(name)}${preset ? ' · ' + esc(preset) : ''} · tone ${tone}/5 · depth ${depth}/5
      ${ask ? `<br><span class="preview-prompt">Prompt starts: “${esc(ask.slice(0, 90))}${ask.length > 90 ? '…' : ''}”</span>` : ''}
      ${$('#fSignoff').value.trim() ? `<br>Signs off “${esc($('#fSignoff').value.trim())}”` : ''}
    </div>`;
}

['#fName', '#fEmoji', '#fPrompt', '#fTone', '#fDepth', '#fPreset', '#fSignoff'].forEach(sel => {
  const el = $(sel);
  if (!el) return;
  el.addEventListener('input', () => { updatePersonaLabels(); renderPreview(); });
  el.addEventListener('change', () => { updatePersonaLabels(); renderPreview(); });
});

['#newAgentBtn'].forEach(sel => { $(sel).onclick = () => openEditor(null); });
$('#cancelEdit').onclick = () => $('#editor').classList.add('hidden');
$('#closeEditor').onclick = () => $('#editor').classList.add('hidden');

$('#saveAgent').onclick = async () => {
  const body = {
    name: $('#fName').value.trim(), emoji: $('#fEmoji').value.trim() || '🤖',
    description: $('#fDesc').value.trim(), systemPrompt: $('#fPrompt').value.trim(),
    model: $('#fModel').value, status: $('#fStatus').value,
    waPhoneId: $('#fWaPhone').value.trim(),
    persona: {
      tone: Number($('#fTone').value), depth: Number($('#fDepth').value),
      preset: $('#fPreset').value || '', signoff: $('#fSignoff').value.trim().slice(0, 60),
      noHumor: $('#fNoHumor').checked
    },
    languages: [...$('#langChips').querySelectorAll('input:checked')].map(i => i.value),
    autoLanguage: $('#fAutoLang').checked,
    groupReply: $('#fGroupReply').value,
    knowledgeEnabled: $('#fKnowledge').checked
  };
  if ($('#fWaToken').value.trim()) body.waToken = $('#fWaToken').value.trim();
  if (!body.name) return toast('Name is required');
  try {
    if (editingId) { await api('/agents/' + editingId, { method: 'PUT', body }); toast('Saved'); }
    else { const a = await api('/agents', { method: 'POST', body }); toast('Agent created'); }
    $('#editor').classList.add('hidden');
    await load();
  } catch (e) { toast(e.message); }
};

// ---------- knowledge base ----------
async function loadKnowledge(agentId) {
  try {
    kbDocs = await api('/agents/' + agentId + '/knowledge');
    renderKnowledge();
  } catch (e) { $('#kbList').innerHTML = `<p class="muted">${esc(e.message)}</p>`; }
}

function renderKnowledge() {
  if (!kbDocs.length) { $('#kbList').innerHTML = '<p class="muted" style="font-size:13px">No files yet. Upload a PDF or paste text so the agent quotes your own material.</p>'; return; }
  $('#kbList').innerHTML = kbDocs.map(d => `
    <div class="kb-row">
      <span class="kb-kind">${d.kind === 'faq' ? '✨' : '📄'}</span>
      <div class="kb-meta">
        <b>${esc(d.title)}</b>
        <span class="muted">${d.kind === 'faq' ? (d.items || []).length + ' Q&A pairs' : (d.chars || 0).toLocaleString() + ' chars · ' + (d.chunks || 0) + ' chunks'}</span>
      </div>
      <button class="icon-btn danger" data-kbdel="${d.id}" title="Remove">🗑</button>
    </div>`).join('');
  $('#kbList').querySelectorAll('[data-kbdel]').forEach(b => b.onclick = async () => {
    try { await api('/knowledge/' + b.dataset.kbdel, { method: 'DELETE' }); await loadKnowledge(editingId); toast('Removed'); }
    catch (e) { toast(e.message); }
  });
}

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).replace(/^data:[^;]+;base64,/, ''));
    r.onerror = () => reject(new Error('could not read that file'));
    r.readAsDataURL(file);
  });
}

$('#kbUploadBtn').onclick = async () => {
  const f = $('#kbFile').files[0];
  if (!f || !editingId) return toast('Choose a file first');
  if (f.size > 4 * 1024 * 1024) return toast('File is larger than 4 MB');
  try {
    toast('Reading ' + f.name + '…');
    const dataBase64 = await fileToBase64(f);
    const r = await api('/agents/' + editingId + '/knowledge', { method: 'POST', body: { filename: f.name, title: f.name, dataBase64 } });
    toast('Added ' + r.chunks + ' chunks');
    $('#kbFile').value = '';
    await loadKnowledge(editingId);
  } catch (e) { toast(e.message); }
};

$('#kbPasteBtn').onclick = async () => {
  const text = $('#kbPaste').value.trim();
  if (!text || !editingId) return toast('Paste some text first');
  try {
    await api('/agents/' + editingId + '/knowledge', { method: 'POST', body: { title: 'Pasted note ' + new Date().toLocaleDateString(), text } });
    $('#kbPaste').value = '';
    await loadKnowledge(editingId); toast('Added');
  } catch (e) { toast(e.message); }
};

$('#genFaqBtn').onclick = async () => {
  if (!editingId) return toast('Save the agent first');
  const btn = $('#genFaqBtn'); btn.disabled = true; btn.textContent = 'Thinking…';
  try { await api('/agents/' + editingId + '/faq', { method: 'POST' }); await loadKnowledge(editingId); toast('FAQ drafted'); }
  catch (e) { toast(e.message); }
  finally { btn.disabled = false; btn.textContent = '✨ Generate FAQ'; }
};

// ---------- channels ----------
function renderChannels() {
  $('#channelsList').innerHTML = agents.map(a => ['whatsapp', 'telegram'].map(p => {
    const st = a.platforms?.[p] || { enabled: false, autoReply: true };
    return `<div class="agent-row">
      <span style="font-size:22px">${p === 'whatsapp' ? '🟢' : '🔵'}</span>
      <div class="meta">
        <div class="name">${p === 'whatsapp' ? 'WhatsApp' : 'Telegram'} — ${esc(a.name)}</div>
        <div class="desc">${st.enabled ? 'Connected · auto-reply ' + (st.autoReply ? 'ON' : 'OFF') : 'Not connected'}</div>
      </div>
      <span class="muted" style="font-size:12px;margin-right:8px">enable</span>
      <div class="toggle ${st.enabled ? 'on' : ''}" data-agent="${a.id}" data-plat="${p}" data-field="enabled"></div>
      <span class="muted" style="font-size:12px;margin-right:8px">auto</span>
      <div class="toggle ${st.autoReply ? 'on' : ''}" data-agent="${a.id}" data-plat="${p}" data-field="autoReply"></div>
    </div>`;
  }).join('')).join('') || '<p class="muted">Create an agent first.</p>';

  $('#channelsList').querySelectorAll('.toggle').forEach(t => t.onclick = async () => {
    const a = agents.find(x => x.id === t.dataset.agent);
    const st = a.platforms[t.dataset.plat];
    st[t.dataset.field] = !st[t.dataset.field];
    try { await api('/agents/' + a.id, { method: 'PUT', body: { platforms: a.platforms } }); renderChannels(); }
    catch (e) { toast(e.message); }
  });
}

// ---------- conversations ----------
// WhatsApp chat ids look like "<phone_number_id>:<user>" on the shared number.
function prettyChat(id) {
  const s = String(id || '');
  if (s.includes(':')) {
    const [, user] = s.split(':');
    return user;
  }
  return s;
}

// A card that holds its shape while the first paint is still fetching, so a slow
// free-tier cold start reads as "loading" instead of "broken".
function skeletonRows(n = 5) {
  return Array.from({ length: n }, () => '<div class="skeleton-row"><span class="skeleton w60"></span><span class="skeleton w35"></span></div>').join('');
}

let convCurrent = null;

async function renderConversations() {
  const list = $('#convList'), thread = $('#convThread');
  list.innerHTML = skeletonRows(5);
  thread.innerHTML = '<p class="muted">Pick a conversation to read it.</p>';
  let threads = [];
  try {
    threads = (await api('/conversations')).threads || [];
  } catch (e) {
    list.innerHTML = `<p class="muted">${esc(e.message)}</p>`;
    return;
  }
  const q = ($('#convSearch').value || '').trim().toLowerCase();
  const shown = threads.filter((t) => !q
    || String(t.chat_id).toLowerCase().includes(q)
    || String(t.last_text || '').toLowerCase().includes(q));
  if (!shown.length) {
    list.innerHTML = `<p class="muted">${threads.length ? 'Nothing matches that search.' : 'No conversations recorded yet.'}</p>`;
    return;
  }
  list.innerHTML = shown.map((t) => `
    <button class="conv-item${convCurrent && convCurrent.channel === t.channel && convCurrent.chat === t.chat_id ? ' active' : ''}"
      data-channel="${esc(t.channel)}" data-chat="${esc(t.chat_id)}">
      <span class="conv-who">${esc(prettyChat(t.chat_id))}</span>
      <span class="conv-meta">${esc(t.channel)} · ${t.messages} message${t.messages === 1 ? '' : 's'}</span>
      <span class="conv-preview">${esc(String(t.last_text || '').replace(/\s+/g, ' ').slice(0, 90))}</span>
    </button>`).join('');
  $$('.conv-item').forEach((b) => { b.onclick = () => openThread(b.dataset.channel, b.dataset.chat); });
  const first = convCurrent && shown.find((t) => t.channel === convCurrent.channel && t.chat_id === convCurrent.chat);
  const target = first || shown[0];
  openThread(target.channel, target.chat_id);
}

async function openThread(channel, chat) {
  convCurrent = { channel, chat };
  $$('.conv-item').forEach((b) => b.classList.toggle('active', b.dataset.channel === channel && b.dataset.chat === chat));
  const thread = $('#convThread');
  thread.innerHTML = skeletonRows(4);
  try {
    const d = await api('/conversations/thread?channel=' + encodeURIComponent(channel) + '&chat=' + encodeURIComponent(chat));
    const msgs = d.messages || [];
    thread.innerHTML = `
      <div class="thread-head">
        <b>${esc(prettyChat(chat))}</b>
        <span class="muted">${esc(channel)} · ${msgs.length}${msgs.length >= 120 ? '+ (latest shown)' : ''} messages</span>
        <a class="btn small" href="/api/conversations/thread/export?channel=${encodeURIComponent(channel)}&chat=${encodeURIComponent(chat)}" download title="Download this conversation as markdown">Export .md</a>
      </div>
      <div class="thread-body">
        ${msgs.length ? msgs.map((m) => `
          <div class="bubble ${m.role === 'assistant' ? 'bot' : 'user'}">
            <div class="bubble-text">${esc(m.content)}</div>
            <div class="bubble-role">${m.role === 'assistant' ? 'agent' : 'person'}</div>
          </div>`).join('') : '<p class="muted">This conversation is empty.</p>'}
      </div>`;
    thread.querySelector('.thread-body').scrollTop = 1e6;
  } catch (e) {
    thread.innerHTML = `<p class="muted">${esc(e.message)}</p>`;
  }
}

$('#convSearch').addEventListener('input', () => {
  clearTimeout(window._convT);
  window._convT = setTimeout(renderConversations, 250);
});
$('#convRefresh').addEventListener('click', renderConversations);

// ---------- analytics ----------

// A rating is what turns Analytics from "how fast" into "how good": it is the only
// signal that says whether a prompt change actually helped.
function ratingButtons(agent, query, reply) {
  const wrap = document.createElement('span');
  wrap.className = 'rate';
  const send = async (rating, btn) => {
    try {
      await api('/feedback', { method: 'POST', body: { agentId: agent.id, agentName: agent.name, chatId: 'web:' + (agent.ownerId || ''), channel: 'web', rating, query, reply } });
      $$('.rate').forEach((r) => r.querySelectorAll('button').forEach((b) => { b.classList.remove('picked'); }));
      btn.classList.add('picked');
      btn.title = rating === 'up' ? 'Thanks, recorded' : 'Thanks, recorded as unhelpful';
    } catch (e) { toast(e.message); }
  };
  ['up', 'down'].forEach((rating) => {
    const b = document.createElement('button');
    b.className = 'icon-btn rate-btn';
    b.textContent = rating === 'up' ? '👍' : '👎';
    b.title = rating === 'up' ? 'This answer was good' : 'This answer was wrong or unhelpful';
    b.onclick = () => send(rating, b);
    wrap.appendChild(b);
  });
  return wrap;
}

async function renderFeedbackCard() {
  const el = $('#analyticsFeedback');
  if (!el) return;
  el.innerHTML = '<p class="muted">Loading…</p>';
  try {
    const s = await api('/feedback/summary?days=30');
    if (!s.total) { el.innerHTML = '<p class="muted">No ratings yet. Use 👍 or 👎 under an answer in the chat.</p>'; return; }
    const score = s.up + s.down ? Math.round((s.up / (s.up + s.down)) * 100) : null;
    el.innerHTML = `
      <p class="muted" style="margin:0 0 8px">${s.up} 👍 · ${s.down} 👎${score == null ? '' : ' · ' + score + '% positive'} in the last ${s.window.days} days</p>
      ${s.agents.length ? `<table class="table"><thead><tr><th>Agent</th><th>Good</th><th>Bad</th><th>Score</th></tr></thead><tbody>
        ${s.agents.map((a) => `<tr><td>${esc(a.agentName || a.agentId || 'unknown')}</td><td>${a.up}</td><td>${a.down}</td><td>${a.score == null ? '—' : a.score + '%'}</td></tr>`).join('')}
      </tbody></table>` : ''}
      ${s.recent.filter((f) => f.rating === 'down').slice(0, 5).map((f) => `<p class="muted" style="margin:8px 0 0">👎 ${esc(String(f.query || f.reply || '').slice(0, 110))}</p>`).join('')}`;
  } catch (e) { el.innerHTML = `<p class="muted">${esc(e.message)}</p>`; }
}

async function renderRegressionCard() {
  const el = $('#analyticsRegression');
  if (!el) return;
  try {
    const run = await api('/regression/latest');
    if (!run) { el.innerHTML = '<p class="muted">No run recorded yet. Tap Run now, or wait for the nightly check.</p>'; return; }
    el.innerHTML = `
      <p class="muted" style="margin:0 0 8px">${new Date(run.at).toLocaleString()} · ${run.passed} passed, ${run.failed} failed</p>
      <table class="table"><tbody>
        ${(run.results || []).map((r) => `<tr><td>${r.ok ? '✅' : '❌'} ${esc(r.agent || r.agentId)}</td><td class="right muted">${r.ms}ms${r.why ? ' · ' + esc(r.why) : ''}</td></tr>`).join('')}
      </tbody></table>`;
  } catch (e) { el.innerHTML = `<p class="muted">${esc(e.message)}</p>`; }
}

async function renderAnalytics() {
  const days = $('#analyticsRange').value || 14;
  const el = { tiles: $('#analyticsTiles'), chart: $('#analyticsChart'), agents: $('#analyticsAgents'), queries: $('#analyticsQueries') };
  el.tiles.innerHTML = '<div class="card"><div class="num">…</div><div class="lbl">loading</div></div>';
  try {
    const s = await api('/analytics/summary?days=' + days);
    const t = s.totals;
    el.tiles.innerHTML = `
      <div class="card"><div class="num">${t.messages}</div><div class="lbl">Messages in ${s.window.days}d</div></div>
      <div class="card"><div class="num" style="color:var(--green)">${t.replies}</div><div class="lbl">Replies sent</div></div>
      <div class="card"><div class="num">${t.avgLatencyMs == null ? '—' : t.avgLatencyMs + '<small>ms</small>'}</div><div class="lbl">Average reply time</div></div>
      <div class="card"><div class="num">${t.errors}</div><div class="lbl">Errors</div></div>
      <div class="card"><div class="num">${t.activeAgents}</div><div class="lbl">Agents answering</div></div>`;
    const max = Math.max(1, ...s.series.map(d => d.messages));
    el.chart.innerHTML = s.series.map(d => `
      <div class="bar-wrap" title="${d.day}: ${d.messages} messages, ${d.replies} replies">
        <div class="bar" style="height:${Math.max(3, Math.round((d.messages / max) * 100))}%"></div>
        <span class="bar-label">${d.day.slice(8)}</span>
      </div>`).join('');
    el.agents.innerHTML = s.agents.length ? `<table class="table"><thead><tr><th>Agent</th><th>Msgs</th><th>Replies</th><th>Avg</th><th>Errors</th></tr></thead><tbody>
      ${s.agents.map(a => `<tr><td>${esc(a.name)}</td><td>${a.messages}</td><td>${a.replies}</td><td>${a.avgLatency ? a.avgLatency + 'ms' : '—'}</td><td>${a.errors || ''}</td></tr>`).join('')}
      </tbody></table>` : '<p class="muted">No traffic yet in this window.</p>';
    api('/usage/tools?days=' + days).then((u) => {
      const tools = (u.tools || []);
      $('#analyticsTools').innerHTML = tools.length
        ? `<table class="table"><tbody>${tools.map((x) => `<tr><td>${esc(x.tool)}</td><td class="right muted">${x.uses}× on ${x.days}d</td></tr>`).join('')}</tbody></table>`
        : '<p class="muted">No tool calls yet in this window.</p>';
    }).catch(() => { $('#analyticsTools').innerHTML = '<p class="muted">Tool usage unavailable.</p>'; });
    el.queries.innerHTML = s.topQueries.length ? `<table class="table"><tbody>
      ${s.topQueries.map(q => `<tr><td>${esc(q.query)}</td><td class="right muted">${q.count}×</td></tr>`).join('')}
      </tbody></table>` : '<p class="muted">Top questions appear once people start asking.</p>';
  } catch (e) {
    el.tiles.innerHTML = `<div class="card"><div class="lbl">${esc(e.message)}</div></div>`;
  }
}
$('#analyticsRange').addEventListener('change', renderAnalytics);
// The CSV must follow whatever range is on screen, so the link is rebuilt on each change.
function syncExportLink() {
  const btn = $('#analyticsExport');
  if (btn) btn.href = '/api/usage/export?days=' + encodeURIComponent($('#analyticsRange').value);
}
$('#analyticsRange').addEventListener('change', syncExportLink);
syncExportLink();
if ($('#feedbackRefresh')) $('#feedbackRefresh').onclick = renderFeedbackCard;
if ($('#regressionRun')) $('#regressionRun').onclick = async (e) => {
  const b = e.target; b.disabled = true; b.textContent = 'Running…';
  try { await api('/regression/run', { method: 'POST', body: {} }); toast('Regression run finished'); renderRegressionCard(); }
  catch (err) { toast(err.message); }
  finally { b.disabled = false; b.textContent = 'Run now'; }
};
renderFeedbackCard();
renderRegressionCard();

// ---------- reminders ----------
async function loadReminders() {
  fillAgentSelect('#remAgent');
  const list = await api('/reminders').catch(e => { toast(e.message); return []; });
  $('#reminderList').innerHTML = list.length ? list.map(r => `
    <div class="agent-row">
      <span style="font-size:20px">${r.channel === 'whatsapp' ? '🟢' : '🔵'}</span>
      <div class="meta">
        <div class="name">${esc(r.title)} ${r.status === 'sent' ? '<span class="pill">sent</span>' : r.status === 'failed' ? '<span class="pill paused">failed</span>' : ''}</div>
        <div class="desc">${fmtDate(r.dueAt)} · ${r.channel}${r.repeat !== 'none' ? ' · ' + r.repeat : ''} · ${esc(r.chatId || '')}${r.agentName ? ' · ' + esc(r.agentName) : ''}</div>
      </div>
      <button class="btn small" data-sendnow="${r.id}">Send now</button>
      <button class="icon-btn danger" data-remdel="${r.id}" title="Delete">🗑</button>
    </div>`).join('') : '<p class="muted">No reminders yet.</p>';
  $('#reminderList').querySelectorAll('[data-remdel]').forEach(b => b.onclick = async () => {
    try { await api('/reminders/' + b.dataset.remdel, { method: 'DELETE' }); loadReminders(); } catch (e) { toast(e.message); }
  });
  $('#reminderList').querySelectorAll('[data-sendnow]').forEach(b => b.onclick = async () => {
    try { await api('/reminders/' + b.dataset.sendnow + '/send-now', { method: 'POST' }); toast('Sent'); loadReminders(); } catch (e) { toast(e.message); }
  });
}

$('#addReminder').onclick = async () => {
  const when = $('#remWhen').value;
  if (!when) return toast('Pick a date and time');
  try {
    await api('/reminders', { method: 'POST', body: {
      title: $('#remTitle').value.trim() || $('#remMessage').value.trim().slice(0, 60),
      message: $('#remMessage').value.trim(),
      dueAt: new Date(when).toISOString(),
      repeat: $('#remRepeat').value,
      channel: $('#remChannel').value,
      chatId: $('#remChat').value.trim(),
      agentId: $('#remAgent').value || null
    } });
    $('#remTitle').value = ''; $('#remMessage').value = '';
    toast('Reminder scheduled'); loadReminders();
  } catch (e) { toast(e.message); }
};

// ---------- triggers ----------
async function loadTriggers() {
  fillAgentSelect('#trgAgent');
  const list = await api('/triggers').catch(e => { toast(e.message); return []; });
  $('#triggerList').innerHTML = list.length ? list.map(t => `
    <div class="agent-row">
      <span style="font-size:20px">🔔</span>
      <div class="meta">
        <div class="name">${esc(t.name)} ${t.lastError ? '<span class="pill paused">error</span>' : ''}</div>
        <div class="desc">${esc(t.url)} → ${esc(t.jsonPath || 'whole body')} · fires when ${esc(t.condition)} · every ${t.intervalMin}m · ${t.channel} ${esc(t.chatId || '')}</div>
        <div class="desc">Last value: <code>${esc(t.lastRaw || '—')}</code>${t.lastRunAt ? ' · fired ' + fmtDate(t.lastRunAt) : ''}${t.lastError ? ' · ' + esc(t.lastError) : ''}</div>
      </div>
      <button class="btn small" data-trun="${t.id}">Run now</button>
      <button class="icon-btn danger" data-trdel="${t.id}" title="Delete">🗑</button>
    </div>`).join('') : '<p class="muted">No triggers yet.</p>';
  $('#triggerList').querySelectorAll('[data-trdel]').forEach(b => b.onclick = async () => {
    try { await api('/triggers/' + b.dataset.trdel, { method: 'DELETE' }); loadTriggers(); } catch (e) { toast(e.message); }
  });
  $('#triggerList').querySelectorAll('[data-trun]').forEach(b => b.onclick = async () => {
    b.disabled = true; b.textContent = 'Checking…';
    try {
      const r = await api('/triggers/' + b.dataset.trun + '/run', { method: 'POST' });
      toast(r.error ? r.error : r.fired ? 'Fired: ' + (r.message || '').slice(0, 80) : 'Checked, condition not met');
      loadTriggers();
    } catch (e) { toast(e.message); b.disabled = false; b.textContent = 'Run now'; }
  });
}

$('#addTrigger').onclick = async () => {
  try {
    await api('/triggers', { method: 'POST', body: {
      name: $('#trgName').value.trim(), url: $('#trgUrl').value.trim(),
      jsonPath: $('#trgPath').value.trim(), condition: $('#trgCond').value,
      prompt: $('#trgPrompt').value.trim(), channel: $('#trgChannel').value,
      chatId: $('#trgChat').value.trim(), agentId: $('#trgAgent').value || null,
      intervalMin: Number($('#trgEvery').value)
    } });
    $('#trgName').value = ''; $('#trgUrl').value = ''; $('#trgPath').value = ''; $('#trgPrompt').value = '';
    toast('Trigger created'); loadTriggers();
  } catch (e) { toast(e.message); }
};

function fillAgentSelect(sel) {
  const el = $(sel);
  if (!el) return;
  const keep = el.value;
  el.innerHTML = '<option value="">None</option>' + agents.map(a => `<option value="${a.id}">${esc(a.emoji + ' ' + a.name)}</option>`).join('');
  el.value = keep;
}

// ---------- billing ----------
async function loadBilling() {
  try {
    const d = await api('/billing/plans');
    const cur = d.current;
    $('#planCards').innerHTML = Object.values(d.plans).map(p => `
      <div class="card plan ${p.id === cur ? 'current' : ''}">
        <div class="row-between"><h3>${esc(p.name)}</h3>${p.id === cur ? '<span class="pill live">current</span>' : ''}</div>
        <div class="num">${p.priceGhs ? 'GH₵' + p.priceGhs + '<small>/mo</small>' : 'Free'}</div>
        <ul>${p.features.map(f => `<li>${esc(f)}</li>`).join('')}</ul>
        ${p.id === cur ? '' : `<button class="btn primary" data-upgrade="${p.id}">Upgrade</button>`}
      </div>`).join('');
    $('#billingNote').textContent = d.link ? '' : 'Payments are not connected yet. Request an upgrade below and the founder can switch your account to Pro.';
    $('#planCards').querySelectorAll('[data-upgrade]').forEach(b => b.onclick = async () => {
      try {
        const r = await api('/billing/upgrade-request', { method: 'POST', body: { note: 'Dashboard upgrade button' } });
        if (r.link) window.open(r.link, '_blank', 'noopener');
        else toast('Request sent — the founder will activate Pro');
        loadBilling();
      } catch (e) { toast(e.message); }
    });
    const st = await api('/auth/status');
    if (st.user && st.user.founder) {
      $('#billingFounder').classList.remove('hidden');
      $('#billLink').value = d.link || '';
      $('#billProvider').value = d.provider || '';
      const reqs = await api('/admin/upgrade-requests').catch(() => []);
      $('#upgradeRequests').innerHTML = reqs.length ? reqs.map(r => `
        <div class="agent-row">
          <div class="meta"><div class="name">${esc(r.name || r.email)}</div><div class="desc">${fmtDate(r.createdAt)} · ${esc(r.note || '')}</div></div>
          <button class="btn small" data-markpro="${r.ownerId}">Mark Pro</button>
        </div>`).join('') : '<p class="muted">No upgrade requests.</p>';
      $('#upgradeRequests').querySelectorAll('[data-markpro]').forEach(b => b.onclick = async () => {
        try { await api('/admin/users/' + b.dataset.markpro + '/plan', { method: 'POST', body: { plan: 'pro' } }); toast('Marked Pro'); loadBilling(); }
        catch (e) { toast(e.message); }
      });
    }
  } catch (e) {
    $('#planCards').innerHTML = `<div class="card"><div class="lbl">${esc(e.message)}</div></div>`;
  }
}

$('#saveBilling').onclick = async () => {
  try {
    await api('/billing/config', { method: 'PUT', body: { provider: $('#billProvider').value, link: $('#billLink').value, note: $('#billNoteInput').value, priceGhs: Number($('#billPrice').value) || undefined } });
    toast('Payment settings saved'); loadBilling();
  } catch (e) { toast(e.message); }
};

// ---------- chat console ----------
function openChat(id) {
  renderChatCommands();
  chatAgent = agents.find(x => x.id === id);
  $('#chatAgentName').textContent = chatAgent.emoji + ' ' + chatAgent.name;
  $('#chatBody').innerHTML = '';
  $('#chatDock').classList.remove('hidden');
  $('#chatText').focus();
}
$('#chatClose').onclick = () => $('#chatDock').classList.add('hidden');
$('#chatSend').onclick = sendChat;

// System health card: a readable version of /api/status, so nobody has to read JSON.
$('#healthRefresh') && ($('#healthRefresh').onclick = loadHealth);

async function loadHealth() {
  const box = $('#healthBody');
  if (!box) return;
  box.textContent = 'Checking…';
  try {
    const d = await api('/status');
    const rows = [
      ['Assistant running', d.ok ? 'yes' : 'no'],
      ['Keeps itself awake', d.keepAlive && d.keepAlive.on ? 'yes, every ' + d.keepAlive.everyMinutes + ' min' : 'no (sleeps after 15 min idle)'],
      ['Database', d.storage === 'postgres' ? 'Postgres' : 'local files'],
      ['Groq (the model)', d.groqConfigured ? 'connected' : 'not set'],
      ['Islamic knowledge (Ilm)', d.ilmConnected ? 'connected' : 'not set'],
      ['Telegram', d.telegramConnected ? 'connected' : 'not set'],
      ['WhatsApp', d.whatsappConnected ? 'connected' : 'not set'],
      ['Studio images/video', d.studioConnected ? 'connected' : 'not set']
    ];
    box.innerHTML = rows.map(([k, v]) =>
      '<div class="row-between" style="padding:3px 0"><span>' + k + '</span><strong>' + v + '</strong></div>'
    ).join('');
  } catch (e) {
    box.textContent = 'Could not reach the server just now (' + e.message + '). Try Refresh.';
  }
}

// slash commands the server answers without spending model tokens
const CHAT_COMMANDS = [
  ['/prayer Accra', 'Prayer times'],
  ['/quran 2:255', 'Ayah'],
  ['/hadith patience', 'Hadith'],
  ['/dua travel', 'Du\'a'],
  ['/fiqh wudu', 'Fiqh'],
  ['/help', 'All commands']
];
function renderChatCommands() {
  const bar = $('#chatCmds');
  if (!bar || bar.childElementCount) return;
  CHAT_COMMANDS.forEach(([text, label]) => {
    const b = document.createElement('button');
    b.type = 'button'; b.textContent = label; b.title = text;
    b.onclick = () => { const input = $('#chatText'); input.value = text; input.focus(); };
    bar.appendChild(b);
  });
}
$('#chatText').onkeydown = (e) => { if (e.key === 'Enter') sendChat(); };

async function sendChat() {
  const text = $('#chatText').value.trim();
  if (!text || !chatAgent) return;
  $('#chatText').value = '';
  const body = $('#chatBody');
  body.insertAdjacentHTML('beforeend', `<div class="msg user">${esc(text)}</div>`);
  const thinking = document.createElement('div');
  thinking.className = 'msg bot muted'; thinking.textContent = '…';
  body.appendChild(thinking); body.scrollTop = body.scrollHeight;
  const history = [...body.querySelectorAll('.msg.user')].map(m => ({ role: 'user', content: m.textContent }));
  try {
    const d = await api('/chat/' + chatAgent.id, { method: 'POST', body: { history } });
    thinking.textContent = d.reply;
    thinking.classList.remove('muted');
    if (d.pendingChange) {
      renderPendingChange(d.pendingChange);
      thinking.insertAdjacentHTML('beforeend', '<div class="muted" style="font-size:12px;margin-top:6px">Nothing saved yet: apply or discard the change below.</div>');
    }
    if (d.draft) {
      renderDraft(d.draft, null);
      thinking.insertAdjacentHTML('beforeend', '<div class="muted" style="font-size:12px;margin-top:6px">Draft ready on the 🤖 Agents page: review it there and tap Create.</div>');
    }
    const speak = document.createElement('button');
    speak.className = 'icon-btn speak';
    speak.title = 'Read this answer aloud';
    speak.textContent = '🔊';
    speak.onclick = () => speakText(d.reply);
    thinking.appendChild(speak);
    thinking.appendChild(ratingButtons(chatAgent, text, d.reply));
  } catch (e) { thinking.textContent = '⚠️ ' + e.message; }
  body.scrollTop = body.scrollHeight;
}

async function speakText(text) {
  try {
    const d = await api('/voice/speak', { method: 'POST', body: { text } });
    const audio = new Audio('data:' + d.mime + ';base64,' + d.audioBase64);
    await audio.play();
    $('#chatFoot').textContent = '';
  } catch (e) {
    if ('speechSynthesis' in window) {
      const u = new SpeechSynthesisUtterance(text.slice(0, 600));
      speechSynthesis.speak(u);
      $('#chatFoot').textContent = 'Spoken by your browser' + (e && e.message ? ' (' + e.message + ')' : '.');
    } else {
      $('#chatFoot').textContent = e.message;
    }
  }
}

let recorder = null, chunks = [];
$('#chatMic').onclick = async () => {
  const btn = $('#chatMic');
  if (recorder && recorder.state === 'recording') { recorder.stop(); return; }
  if (!navigator.mediaDevices || !window.MediaRecorder) return toast('This browser cannot record audio');
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    recorder = new MediaRecorder(stream);
    chunks = [];
    recorder.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
    recorder.onstop = async () => {
      stream.getTracks().forEach(t => t.stop());
      btn.classList.remove('recording');
      const blob = new Blob(chunks, { type: recorder.mimeType || 'audio/webm' });
      $('#chatFoot').textContent = 'Transcribing…';
      try {
        const b64 = await new Promise((res) => { const r = new FileReader(); r.onload = () => res(String(r.result).replace(/^data:[^;]+;base64,/, '')); r.readAsDataURL(blob); });
        const d = await api('/voice/transcribe', { method: 'POST', body: { audioBase64: b64, mime: blob.type } });
        $('#chatText').value = d.text || '';
        $('#chatFoot').textContent = d.text ? 'Say it again or press Send.' : 'Nothing heard.';
        if (d.text) sendChat();
      } catch (e) { $('#chatFoot').textContent = e.message; }
    };
    recorder.start();
    btn.classList.add('recording');
    $('#chatFoot').textContent = 'Recording… tap the mic to stop.';
  } catch (e) { toast('Microphone blocked: ' + e.message); }
};

// ---------- settings ----------
$('#saveSettings').onclick = async () => {
  try {
    await api('/settings', { method: 'PUT', body: Object.assign({ webhookBase: $('#fWebhookBase').value }, $('#fGroqKey').value.trim() ? { groqApiKey: $('#fGroqKey').value.trim() } : {}, $('#fIlmKey').value.trim() ? { ilmApiKey: $('#fIlmKey').value.trim() } : {}) });
    toast('Settings saved'); await refreshStatus();
  } catch (e) { toast(e.message); }
};

async function refreshStatus() {
  const s = await api('/status');
  const b = $('#groqBadge');
  b.textContent = s.groqConfigured ? 'Groq ✓' : 'Groq: off';
  b.classList.toggle('on', s.groqConfigured);
  const t = $('#tgBadge');
  t.textContent = s.telegramConnected ? 'Telegram ✓' : 'Telegram: off';
  t.classList.toggle('on', s.telegramConnected);
  health = s;
  if (!$('#view-channels').classList.contains('hidden')) renderHealth();
  try {
    const st = await api('/suite/status');
    suiteStatus = st;
    if (st.languages) {
      languages = st.languages;
      if (!$('#editor').classList.contains('hidden')) renderLangChips([...$('#langChips').querySelectorAll('input:checked')].map(i => i.value));
    }
  } catch (e) { /* suite status is optional */ }
}

function renderHealth() {
  if (!health) return;
  const item = (name, ok, note) => `<div class="card"><div style="margin-bottom:8px"><span class="status-dot ${ok ? 'on' : 'off'}"></span><b>${name}</b></div><div class="lbl muted" style="font-size:12px">${note}</div></div>`;
  const tick = suiteStatus && suiteStatus.tickerRunning;
  $('#healthCards').innerHTML =
    item('Groq (LLM brain)', health.groqConfigured, health.groqConfigured ? 'Agents think via Groq' : 'Add key in Settings') +
    item('Telegram', health.telegramConnected, health.telegramConnected ? (health.telegramBot ? health.telegramBot + ' connected' : 'webhook live') : 'Not configured') +
    item('WhatsApp', health.whatsappConnected, health.whatsappConnected ? 'Cloud API ready' : 'Needs Meta credentials') +
    item('Ilm API tools', health.ilmConnected, health.ilmConnected ? 'Prayer times, Quran, hadith live' : 'No Ilm key') +
    item('Reminders + triggers', Boolean(tick), tick ? 'Background ticker every 60s' : 'Uses /api/cron/tick on serverless hosts');
}

// ---------- coach marks ----------
function maybeCoach() {
  try {
    if (localStorage.getItem('agentx.coach.v1')) return;
    $('#coach').classList.remove('hidden');
  } catch (e) {}
}
$('#coachDone').onclick = () => {
  $('#coach').classList.add('hidden');
  try { localStorage.setItem('agentx.coach.v1', '1'); } catch (e) {}
};

// ---------- boot ----------
async function load() {
  agents = await api('/agents');
  renderOverview();
  renderAgents();
  wireDraftBox();
  renderChannels();
  fillAgentSelect('#remAgent');
  fillAgentSelect('#trgAgent');
}

(async () => {
  try {
    const st = await api('/auth/status');
    if (st.authed && st.user) {
      $('#whoami').textContent = (st.user.founder ? '★ ' : '') + st.user.name + ' · ' + st.user.email;
      await refreshStatus();
      await load();
    } else showLogin();
  } catch (e) { toast(e.message); }
  refreshStatus().catch(() => {});
  const when = $('#remWhen');
  if (when && !when.value) {
    const d = new Date(Date.now() + 30 * 60e3 - new Date().getTimezoneOffset() * 60e3);
    when.value = d.toISOString().slice(0, 16);
  }

// Boot: the install prompt and the offline shell, plus ?view= links from the manifest shortcuts.
try { setupServiceWorker(); setupInstall(); } catch (e) {}
try {
  const wanted = new URLSearchParams(location.search).get('view');
  if (wanted && document.getElementById('view-' + wanted)) switchView(wanted);
} catch (e) {}

})();
