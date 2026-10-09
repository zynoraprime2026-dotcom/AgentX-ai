/* AgentX dashboard frontend */
const $ = (s) => document.querySelector(s);
const $$ = (s) => document.querySelectorAll(s);
let agents = [];
let editingId = null;
let chatAgent = null;

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
  clearTimeout(t._h); t._h = setTimeout(() => t.classList.add('hidden'), 2200);
}

function pill(status) {
  return `<span class="pill ${status === 'live' ? 'live' : ''} ${status === 'paused' ? 'paused' : ''}">${status}</span>`;
}

// ---------- auth ----------
function showLogin() {
  $('#loginOverlay').classList.remove('hidden');
  $('#loginErr').textContent = '';
}
$$('.logintab').forEach(t => t.onclick = () => {
  $$('.logintab').forEach(x => x.classList.remove('active'));
  t.classList.add('active');
  $('#signinForm').style.display = t.dataset.tab === 'signin' ? 'flex' : 'none';
  $('#signupForm').style.display = t.dataset.tab === 'signup' ? 'flex' : 'none';
});
$('#loginBtn').onclick = async () => {
  try {
    await api('/auth/login', { method: 'POST', body: { email: $('#loginEmail').value, password: $('#loginPass').value } });
    location.reload();
  } catch (e) { $('#loginErr').textContent = e.message; }
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
$('#logoutBtn').onclick = async () => {
  try { await api('/auth/logout', { method: 'POST' }); } catch (e) {}
  location.reload();
};

// ---------- navigation ----------
$$('.navbtn').forEach(b => b.onclick = () => {
  $$('.navbtn').forEach(x => x.classList.remove('active'));
  b.classList.add('active');
  $$('.view').forEach(v => v.classList.add('hidden'));
  $('#view-' + b.dataset.view).classList.remove('hidden');
  if (b.dataset.view === 'channels') renderHealth();
});

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
    const n = Object.keys(subs || {}).length;
    const el = document.createElement('div');
    el.className = 'card';
    el.innerHTML = `<div class="num">${n}</div><div class="lbl">Fajr subscribers</div>`;
    $('#statCards').appendChild(el);
  }).catch(() => {});
  $('#overviewAgents').innerHTML = agents.filter(a => a.status === 'live').map(a => `
    <div class="agent-card">
      <div class="top"><span class="emoji">${a.emoji}</span><span class="name">${esc(a.name)}</span>${pill(a.status)}</div>
      <div class="muted" style="font-size:13px">${esc(a.description || '')}</div>
    </div>`).join('') || '<p class="muted">No live agents yet. Create one and set it live.</p>';
}

// ---------- agents ----------
function renderAgents() {
  $('#agentsList').innerHTML = agents.map(a => `
    <div class="agent-row">
      <span style="font-size:24px">${a.emoji}</span>
      <div class="meta">
        <div class="name">${esc(a.name)} ${pill(a.status)}</div>
        <div class="desc">${esc(a.description || '')}</div>
      </div>
      <button class="btn small" data-test="${a.id}">💬 Test</button>
      <button class="btn small" data-edit="${a.id}">Edit</button>
      <button class="btn small danger" data-del="${a.id}">Delete</button>
    </div>`).join('') || '<p class="muted">No agents yet.</p>';

  $('#agentsList').querySelectorAll('[data-test]').forEach(b => b.onclick = () => openChat(b.dataset.test));
  $('#agentsList').querySelectorAll('[data-edit]').forEach(b => b.onclick = () => openEditor(b.dataset.edit));
  $('#agentsList').querySelectorAll('[data-del]').forEach(b => b.onclick = async () => {
    if (!confirm('Delete this agent?')) return;
    try { await api('/agents/' + b.dataset.del, { method: 'DELETE' }); await load(); toast('Agent deleted'); }
    catch (e) { toast(e.message); }
  });
}

function openEditor(id) {
  editingId = id || null;
  const a = id ? agents.find(x => x.id === id) : null;
  $('#editorTitle').textContent = a ? 'Edit agent' : 'New agent';
  $('#fName').value = a?.name || ''; $('#fEmoji').value = a?.emoji || '🤖';
  $('#fDesc').value = a?.description || ''; $('#fPrompt').value = a?.systemPrompt || '';
  $('#fModel').value = a?.model || 'llama-3.3-70b-versatile';
  $('#fStatus').value = a?.status || 'draft';
  $('#fWaPhone').value = a?.waPhoneId || ''; $('#fWaToken').value = '';
  $('#fWaToken').placeholder = a?.waTokenSet ? 'Token saved. Leave blank to keep it' : 'Paste your Meta access token';
  $('#editor').classList.remove('hidden');
  $('#fName').focus();
}

$('#newAgentBtn').onclick = () => openEditor(null);
$('#cancelEdit').onclick = () => $('#editor').classList.add('hidden');
$('#saveAgent').onclick = async () => {
  const body = {
    name: $('#fName').value.trim(), emoji: $('#fEmoji').value.trim() || '🤖',
    description: $('#fDesc').value.trim(), systemPrompt: $('#fPrompt').value.trim(),
    model: $('#fModel').value, status: $('#fStatus').value,
    waPhoneId: $('#fWaPhone').value.trim()
  };
  if ($('#fWaToken').value.trim()) body.waToken = $('#fWaToken').value.trim();
  if (!body.name) return toast('Name is required');
  try {
    if (editingId) { await api('/agents/' + editingId, { method: 'PUT', body }); toast('Saved'); }
    else { await api('/agents', { method: 'POST', body }); toast('Agent created'); }
    $('#editor').classList.add('hidden');
    await load();
  } catch (e) { toast(e.message); }
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

// ---------- chat console ----------
function openChat(id) {
  chatAgent = agents.find(x => x.id === id);
  $('#chatAgentName').textContent = chatAgent.emoji + ' ' + chatAgent.name;
  $('#chatBody').innerHTML = '';
  $('#chatDock').classList.remove('hidden');
  $('#chatText').focus();
}
$('#chatClose').onclick = () => $('#chatDock').classList.add('hidden');
$('#chatSend').onclick = sendChat;
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
  } catch (e) { thinking.textContent = '⚠️ ' + e.message; }
  body.scrollTop = body.scrollHeight;
}

// ---------- settings ----------
$('#saveSettings').onclick = async () => {
  try {
    await api('/settings', { method: 'PUT', body: { groqApiKey: $('#fGroqKey').value, webhookBase: $('#fWebhookBase').value } });
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
}

let health = null;
function renderHealth() {
  if (!health) return;
  const item = (name, ok, note) => `<div class="card"><div style="margin-bottom:8px"><span class="status-dot ${ok ? 'on' : 'off'}"></span><b>${name}</b></div><div class="lbl muted" style="font-size:12px">${note}</div></div>`;
  $('#healthCards').innerHTML =
    item('Groq (LLM brain)', health.groqConfigured, health.groqConfigured ? 'Agents think via Groq' : 'Add key in Settings') +
    item('Telegram', health.telegramConnected, health.telegramConnected ? '@AgentXtechbot webhook live' : 'Not configured') +
    item('WhatsApp', health.whatsappConnected, health.whatsappConnected ? 'Cloud API ready' : 'Needs Meta credentials') +
    item('Ilm API tools', health.ilmConnected, health.ilmConnected ? 'Prayer times, Quran, hadith live' : 'No Ilm key');
}

async function load() {
  agents = await api('/agents');
  renderOverview(); renderAgents(); renderChannels();
}

function esc(s) { return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }

(async () => {
  try {
    const st = await api('/auth/status');
    if (st.authed && st.user) {
      $('#whoami').textContent = (st.user.founder ? '★ ' : '') + st.user.name + ' · ' + st.user.email;
      await load();
    } else showLogin();
  } catch (e) { toast(e.message); }
  refreshStatus();
})();
