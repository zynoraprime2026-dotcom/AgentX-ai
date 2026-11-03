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
  reminders: loadReminders, triggers: loadTriggers, channels: () => renderHealth(),
  billing: loadBilling, settings: () => {}
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
  $('#overviewAgents').innerHTML = agents.filter(a => a.status === 'live').map(a => `
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
          ${pill(a.status)}
          <button class="icon-btn" data-test="${a.id}" title="Test chat">💬</button>
          <button class="icon-btn" data-edit="${a.id}" title="Open full editor">⚙️</button>
          <button class="icon-btn danger" data-del="${a.id}" title="Delete agent">🗑</button>
        </div>
      </div>
    </div>`;
  }).join('') || '<p class="muted">No agents match that search.</p>';

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

// ---------- analytics ----------
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
    el.queries.innerHTML = s.topQueries.length ? `<table class="table"><tbody>
      ${s.topQueries.map(q => `<tr><td>${esc(q.query)}</td><td class="right muted">${q.count}×</td></tr>`).join('')}
      </tbody></table>` : '<p class="muted">Top questions appear once people start asking.</p>';
  } catch (e) {
    el.tiles.innerHTML = `<div class="card"><div class="lbl">${esc(e.message)}</div></div>`;
  }
}
$('#analyticsRange').addEventListener('change', renderAnalytics);

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
    thinking.classList.remove('muted');
    const speak = document.createElement('button');
    speak.className = 'icon-btn speak';
    speak.title = 'Read this answer aloud';
    speak.textContent = '🔊';
    speak.onclick = () => speakText(d.reply);
    thinking.appendChild(speak);
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
      $('#chatFoot').textContent = 'Spoken by your browser (server voice needs Pro).';
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
    item('Telegram', health.telegramConnected, health.telegramConnected ? '@AgentXtechbot webhook live' : 'Not configured') +
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
})();
