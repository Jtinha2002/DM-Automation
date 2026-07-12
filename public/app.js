// ── State ──
let allAccounts = [];
let currentLogPage = 0;
let dragSrcId = null;
let refreshTimer = null;
const LOG_PAGE = 50;

// ── Init ──
document.addEventListener('DOMContentLoaded', async () => {
  applyTheme(localStorage.getItem('theme') || 'dark');
  initNav();
  const status = await fetch('/api/app/status').then(r => r.json()).catch(() => ({ authed: true }));
  if (status.protected && !status.authed) { showLogin(); return; }
  startApp();
});

function startApp() {
  hideLogin();
  handleURLParams();
  loadAll();
  startAutoRefresh();
  document.addEventListener('visibilitychange', () =>
    document.hidden ? stopAutoRefresh() : (loadAll(), startAutoRefresh())
  );
}

// ── App login ──
function showLogin() { document.getElementById('loginOverlay').classList.remove('hidden'); }
function hideLogin() { document.getElementById('loginOverlay').classList.add('hidden'); }

async function doLogin(e) {
  e.preventDefault();
  const pwd = document.getElementById('loginPassword').value;
  const btn = document.getElementById('loginBtn');
  const err = document.getElementById('loginError');
  btn.disabled = true; btn.textContent = 'Entrando...';
  err.classList.add('hidden');
  try {
    const res = await fetch('/api/app/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: pwd }) });
    if (!res.ok) { err.textContent = 'Senha incorreta'; err.classList.remove('hidden'); return; }
    startApp();
  } catch { err.textContent = 'Erro de conexão'; err.classList.remove('hidden'); }
  finally { btn.disabled = false; btn.textContent = 'Entrar'; }
}

async function appLogout() {
  if (!confirm('Sair do painel?')) return;
  await fetch('/api/app/logout', { method: 'POST' }).catch(() => {});
  location.reload();
}

function startAutoRefresh() { stopAutoRefresh(); refreshTimer = setInterval(loadAll, 30000); }
function stopAutoRefresh()  { if (refreshTimer) { clearInterval(refreshTimer); refreshTimer = null; } }

function handleURLParams() {
  const p = new URLSearchParams(location.search);
  if (p.get('success') === 'connected') {
    const u = p.get('username') ? `@${p.get('username')} ` : '';
    showToast(`Conta ${u}conectada com sucesso!`, 'success');
    history.replaceState({}, '', '/');
  }
  if (p.get('error')) { showToast(decodeURIComponent(p.get('error')), 'error'); history.replaceState({}, '', '/'); }
}

function loadAll() {
  loadAccounts().then(() => {
    loadStats();
    loadRules();
    loadLogs();
    loadInboxBadge();
  });
}

// ── Navigation ──
function initNav() {
  document.querySelectorAll('.nav-item').forEach(item =>
    item.addEventListener('click', e => { e.preventDefault(); switchTab(item.dataset.tab); })
  );
}

function switchTab(tab) {
  document.querySelectorAll('.nav-item').forEach(i => i.classList.toggle('active', i.dataset.tab === tab));
  document.querySelectorAll('.tab-content').forEach(s => s.classList.toggle('active', s.id === `tab-${tab}`));
  if (tab === 'logs')     { loadLogs(); }
  if (tab === 'accounts') { renderAccountsTab(); }
  if (tab === 'settings') { loadSettingsPage(); }
  if (tab === 'flows')    { loadFlows(); }
  if (tab === 'audience') { loadContacts(); loadContactTags(); }
  if (tab === 'inbox')    { loadInbox(); startInboxPolling(); } else { stopInboxPolling(); }
}

// ── Theme ──
function toggleTheme() {
  const current = document.documentElement.dataset.theme;
  applyTheme(current === 'dark' ? 'light' : 'dark');
}

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  localStorage.setItem('theme', theme);
  const icon = document.getElementById('themeIcon');
  if (icon) {
    icon.innerHTML = theme === 'dark'
      ? '<circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/>'
      : '<path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/>';
  }
}

// ── Accounts ──
async function loadAccounts() {
  try {
    allAccounts = await fetch('/api/accounts').then(r => r.json());
    renderSidebarAccount();
    renderExpiryAlert();
    populateAccountSelects();
  } catch { showToast('Falha ao carregar contas', 'error'); }
}

function renderSidebarAccount() {
  const dot  = document.getElementById('statusDot');
  const name = document.getElementById('accountName');
  const sub  = document.getElementById('accountSub');
  const banner = document.getElementById('connectBanner');

  const connected = allAccounts.filter(a => a.connected);
  if (!connected.length) {
    dot.className = 'account-dot disconnected';
    name.textContent = 'Não conectado';
    sub.textContent = 'Nenhuma conta';
    banner?.classList.remove('hidden');
  } else if (connected.length === 1) {
    dot.className = 'account-dot connected';
    name.textContent = '@' + connected[0].username;
    sub.textContent = 'Conectado';
    banner?.classList.add('hidden');
  } else {
    dot.className = 'account-dot connected';
    name.textContent = `${connected.length} contas`;
    sub.textContent = 'Todas conectadas';
    banner?.classList.add('hidden');
  }
}

function renderExpiryAlert() {
  const alert = document.getElementById('expiryAlert');
  const text  = document.getElementById('expiryAlertText');
  if (!alert) return;

  const expiring = allAccounts.filter(a => a.connected && a.days_until_expiry !== null && a.days_until_expiry <= 7);
  if (expiring.length) {
    const names = expiring.map(a => `@${a.username || a.id} (${a.days_until_expiry}d)`).join(', ');
    text.textContent = `Token expirando em breve: ${names}`;
    alert.classList.remove('hidden');
  } else {
    alert.classList.add('hidden');
  }
}

function populateAccountSelects() {
  const selects = ['ruleAccountId', 'logAccountFilter', 'testAccountSelect'];
  selects.forEach(id => {
    const el = document.getElementById(id);
    if (!el) return;
    const current = el.value;
    const isTest = id === 'testAccountSelect';
    el.innerHTML = isTest
      ? allAccounts.map(a => `<option value="${a.instagram_user_id}">${escHtml(a.label || '@' + a.username)}</option>`).join('')
      : `<option value="">${id === 'ruleAccountId' ? 'Todas as contas' : 'Todas as contas'}</option>` +
        allAccounts.map(a => `<option value="${a.id}">${escHtml(a.label || '@' + a.username)}</option>`).join('');
    if (current) el.value = current;
  });
}

function renderAccountsTab() {
  const container = document.getElementById('accountsList');
  if (!container) return;

  if (!allAccounts.length) {
    container.innerHTML = `<div class="empty-state">
      <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>
      <h3>Nenhuma conta conectada</h3>
      <p>Adicione sua primeira conta do Instagram</p>
      <a href="/auth/login" class="btn btn-primary">Conectar Instagram</a>
    </div>`;
    return;
  }

  container.innerHTML = allAccounts.map(a => {
    const expiryClass = !a.connected ? 'account-expiry-bad' : a.days_until_expiry <= 7 ? 'account-expiry-warn' : 'account-expiry-ok';
    const expiryText  = !a.connected ? 'Token expirado' : a.days_until_expiry !== null ? `Token expira em ${a.days_until_expiry} dias` : 'Token válido';
    const initial = (a.username || '?')[0].toUpperCase();
    return `
    <div class="account-card">
      <div class="account-avatar ${!a.connected ? 'expired' : ''}">${escHtml(initial)}</div>
      <div class="account-card-info">
        <strong>@${escHtml(a.username || a.instagram_user_id)}</strong>
        <span class="${expiryClass}">${expiryText}</span>
        <div style="margin-top:4px">
          <input class="account-label-input" value="${escHtml(a.label || '')}" placeholder="Apelido (opcional)"
            onblur="saveAccountLabel(${a.id}, this.value)" onkeydown="if(event.key==='Enter')this.blur()" />
        </div>
      </div>
      <div style="display:flex;gap:8px;flex-shrink:0">
        <a href="/auth/login" class="btn btn-outline btn-sm">Renovar</a>
        <button class="btn btn-danger-outline btn-sm" onclick="deleteAccount(${a.id}, '${escHtml(a.username || a.id)}')">Remover</button>
      </div>
    </div>`;
  }).join('');
}

async function saveAccountLabel(id, label) {
  await fetch(`/api/accounts/${id}/label`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ label }) });
  await loadAccounts();
}

async function deleteAccount(id, username) {
  if (!confirm(`Remover a conta @${username}? As regras vinculadas a ela também serão excluídas.`)) return;
  try {
    await fetch(`/api/accounts/${id}`, { method: 'DELETE' });
    showToast('Conta removida', 'info');
    await loadAccounts();
    renderAccountsTab();
    loadRules();
  } catch { showToast('Erro ao remover conta', 'error'); }
}

// ── Stats ──
async function loadStats() {
  try {
    const d = await fetch('/api/logs/stats').then(r => r.json());
    document.getElementById('stat-comments').textContent = d.total_comments;
    document.getElementById('stat-replies').textContent  = d.total_replies;
    document.getElementById('stat-dms').textContent      = d.total_dms;
    document.getElementById('stat-errors').textContent   = d.total_errors;
    document.getElementById('stat-retries').textContent  = d.retry_pending;
  } catch {}
}

// ── Rules ──
async function loadRules() {
  try {
    const rules = await fetch('/api/rules').then(r => r.json());
    renderRules(rules);
    renderDashboardRules(rules.filter(r => r.active));
    renderAccountFilterBar(rules);
  } catch { showToast('Falha ao carregar regras', 'error'); }
}

function renderAccountFilterBar(rules) {
  const bar = document.getElementById('accountFilterBar');
  if (!bar || allAccounts.length < 2) { bar?.classList.add('hidden'); return; }
  bar.classList.remove('hidden');
  const counts = {};
  rules.forEach(r => { const k = r.account_id || 'all'; counts[k] = (counts[k] || 0) + 1; });
  bar.innerHTML = `<button class="filter-btn active" onclick="filterRulesByAccount(null, this)">Todas (${rules.length})</button>` +
    allAccounts.map(a => `<button class="filter-btn" onclick="filterRulesByAccount(${a.id}, this)">@${escHtml(a.username)} (${counts[a.id] || 0})</button>`).join('');
}

async function filterRulesByAccount(accountId, btn) {
  document.querySelectorAll('#accountFilterBar .filter-btn').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  const url = accountId ? `/api/rules?account_id=${accountId}` : '/api/rules';
  const rules = await fetch(url).then(r => r.json());
  renderRules(rules);
}

function renderRules(rules) {
  const container = document.getElementById('rulesContainer');
  if (!rules.length) {
    container.innerHTML = `<div class="empty-state">
      <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/></svg>
      <h3>Nenhuma regra criada</h3><p>Crie sua primeira regra para começar a automação</p>
      <button class="btn btn-primary" onclick="openRuleModal()">Criar primeira regra</button>
    </div>`;
    return;
  }

  container.innerHTML = rules.map(rule => {
    const kws = (rule.keywords || '').split(',').map(k => k.trim()).filter(Boolean);
    return `
    <div class="rule-card ${rule.active ? '' : 'inactive'}" id="rule-${rule.id}"
         draggable="true" data-id="${rule.id}" data-priority="${rule.priority || 0}"
         ondragstart="onDragStart(event)" ondragover="onDragOver(event)"
         ondrop="onDrop(event)" ondragend="onDragEnd(event)">
      <div class="drag-handle" title="Arrastar para reordenar"><span></span><span></span><span></span></div>
      <div class="rule-keyword-list">${kws.map(k => `<span class="rule-keyword">${escHtml(k)}</span>`).join('')}</div>
      <div class="rule-details">
        <div class="rule-actions-preview">
          ${rule.comment_reply ? '<span class="rule-action-tag reply">💬 Resposta</span>' : ''}
          ${(rule.dm_message || rule.dm_blocks) ? `<span class="rule-action-tag dm">✉️ DM${dmBlockCount(rule.dm_blocks)}</span>` : ''}
          ${rule.require_follow ? '<span class="rule-action-tag follow">👥 Seguidores</span>' : ''}
          ${rule.trigger_dm ? '<span class="rule-action-tag dm">📩 DM/Story</span>' : ''}
          ${rule.post_id       ? '<span class="rule-action-tag post">📌 Post específico</span>' : ''}
          ${rule.cooldown_hours > 0 ? `<span class="rule-action-tag cooldown">⏱ ${rule.cooldown_hours}h cooldown</span>` : ''}
        </div>
        ${rule.account_username ? `<div class="rule-account-badge">@${escHtml(rule.account_username)}</div>` : ''}
      </div>
      <div class="rule-controls">
        <label class="toggle">
          <input type="checkbox" ${rule.active ? 'checked' : ''} onchange="toggleRule(${rule.id}, this)" />
          <span class="toggle-slider"></span>
        </label>
        <button class="btn btn-ghost btn-sm" onclick="openRuleModal(${rule.id})">Editar</button>
        <button class="btn btn-danger-outline btn-sm" onclick="deleteRule(${rule.id})">Excluir</button>
      </div>
    </div>`;
  }).join('');
}

function dmBlockCount(raw) {
  if (!raw) return '';
  try { const a = JSON.parse(raw); return Array.isArray(a) && a.length > 1 ? ` (${a.length})` : ''; } catch { return ''; }
}

function renderDashboardRules(active) {
  const c = document.getElementById('dashboardRules');
  if (!active.length) { c.innerHTML = '<div class="empty-state-mini">Nenhuma regra ativa.</div>'; return; }
  c.innerHTML = active.slice(0, 5).map(r => {
    const kws = (r.keywords || '').split(',').map(k => k.trim()).filter(Boolean);
    return `<div class="log-item">
      <div class="rule-keyword-list">${kws.map(k => `<span class="rule-keyword">${escHtml(k)}</span>`).join('')}</div>
      <div style="flex:1;font-size:12px;color:var(--text-muted)">
        ${r.comment_reply ? '💬 ' : ''}${(r.dm_message || r.dm_blocks) ? '✉️ ' : ''}${r.require_follow ? '👥' : ''}
        ${r.account_username ? `· @${escHtml(r.account_username)}` : ''}
      </div>
      <span style="font-size:11px;color:var(--green)">● Ativa</span>
    </div>`;
  }).join('');
}

// ── Drag & Drop ──
function onDragStart(e) {
  dragSrcId = e.currentTarget.dataset.id;
  e.currentTarget.classList.add('dragging');
  e.dataTransfer.effectAllowed = 'move';
}

function onDragOver(e) {
  e.preventDefault();
  e.dataTransfer.dropEffect = 'move';
  document.querySelectorAll('.rule-card').forEach(c => c.classList.remove('drag-over'));
  e.currentTarget.classList.add('drag-over');
}

function onDrop(e) {
  e.preventDefault();
  const targetId = e.currentTarget.dataset.id;
  if (dragSrcId === targetId) return;

  const cards = [...document.querySelectorAll('.rule-card')];
  const srcIdx = cards.findIndex(c => c.dataset.id === dragSrcId);
  const tgtIdx = cards.findIndex(c => c.dataset.id === targetId);

  const container = document.getElementById('rulesContainer');
  if (srcIdx < tgtIdx) {
    container.insertBefore(cards[srcIdx], cards[tgtIdx].nextSibling);
  } else {
    container.insertBefore(cards[srcIdx], cards[tgtIdx]);
  }

  saveRuleOrder();
}

function onDragEnd(e) {
  document.querySelectorAll('.rule-card').forEach(c => {
    c.classList.remove('dragging', 'drag-over');
  });
}

async function saveRuleOrder() {
  const items = [...document.querySelectorAll('.rule-card')].map((c, i) => ({ id: Number(c.dataset.id), priority: i }));
  try {
    await fetch('/api/rules/reorder', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(items) });
    showToast('Ordem salva', 'info');
  } catch { showToast('Erro ao salvar ordem', 'error'); }
}

// ── Rule Modal ──
async function openRuleModal(id = null) {
  // Reset form
  ['ruleId','ruleKeywords','ruleCommentReply','rulePostId','ruleFollowPrompt'].forEach(f => {
    const el = document.getElementById(f); if (el) el.value = '';
  });
  document.getElementById('ruleCooldownHours').value = '24';
  document.getElementById('ruleRequireFollow').checked = false;
  document.getElementById('ruleTriggerDm').checked = false;
  document.getElementById('ruleActive').checked = true;
  document.getElementById('ruleAccountId').value = '';
  document.getElementById('modalTitle').textContent = id ? 'Editar Automação' : 'Nova Automação';
  document.getElementById('ruleId').value = id || '';
  dmBlocks = [];
  bonusBlocks = [];
  renderDmBlocks();
  renderBonusBlocks();
  clearPostFilter();
  toggleFollowGateFields(false);
  setTrigger('comment_any');
  updateCharCounters();
  goToStep(1);
  syncPhoneAccount();
  renderPhonePreview();
  document.getElementById('ruleModal').classList.remove('hidden');

  if (id) {
    try {
      const rule = await fetch(`/api/rules/${id}`).then(r => r.json());
      if (rule.error) return;
      document.getElementById('ruleKeywords').value        = rule.keywords || '';
      document.getElementById('ruleCommentReply').value    = rule.comment_reply || '';
      document.getElementById('rulePostId').value          = rule.post_id || '';
      onManualPostId();
      document.getElementById('ruleCooldownHours').value   = rule.cooldown_hours ?? 24;
      document.getElementById('ruleRequireFollow').checked = !!rule.require_follow;
      document.getElementById('ruleTriggerDm').checked     = !!rule.trigger_dm;
      document.getElementById('ruleActive').checked        = !!rule.active;
      document.getElementById('ruleAccountId').value       = rule.account_id || '';
      document.getElementById('ruleFollowPrompt').value    = rule.follow_prompt_message || '';
      // Load DM blocks (or convert legacy dm_message)
      dmBlocks = parseRuleBlocks(rule);
      renderDmBlocks();
      // Load bonus blocks
      bonusBlocks = [];
      if (rule.bonus_blocks) { try { const a = JSON.parse(rule.bonus_blocks); if (Array.isArray(a)) bonusBlocks = a; } catch {} }
      renderBonusBlocks();
      setRuleDelivery(!rule.require_follow ? 'all' : (rule.allow_skip ? 'choice' : 'strict'));
      setTrigger(rule.trigger_dm ? 'dm' : (rule.post_id ? 'comment_post' : 'comment_any'));
      updateCharCounters();
      syncPhoneAccount();
      renderPhonePreview();
    } catch { showToast('Erro ao carregar regra', 'error'); }
  }
}

function parseRuleBlocks(rule) {
  if (rule.dm_blocks) {
    try { const a = JSON.parse(rule.dm_blocks); if (Array.isArray(a)) return a; } catch {}
  }
  if (rule.dm_message) return [{ type: 'text', text: rule.dm_message }];
  return [];
}

// Delivery mode: 'all' = todos recebem · 'strict' = só seguindo · 'choice' = deixa escolher
let wizDelivery = 'all';
function setRuleDelivery(mode) {
  if (mode === true)  mode = 'choice';   // compat legado (booleano)
  if (mode === false) mode = 'all';
  wizDelivery = mode;
  const follow = mode !== 'all';
  document.getElementById('ruleRequireFollow').checked = follow;
  document.getElementById('ruleAllowSkip').checked     = (mode === 'choice');
  document.getElementById('segAll')?.classList.toggle('active',    mode === 'all');
  document.getElementById('segStrict')?.classList.toggle('active', mode === 'strict');
  document.getElementById('segChoice')?.classList.toggle('active', mode === 'choice');
  document.getElementById('followInviteBox')?.classList.toggle('hidden', !follow);
  updateCharCounters();
  renderPhonePreview();
}
function toggleFollowGateFields(show) { setRuleDelivery(show ? 'choice' : 'all'); }

// ════════════════════════════════════════════════
// Wizard navigation (3 steps)
// ════════════════════════════════════════════════
let wizStep = 1;
const WIZ_MAX = 3;

function goToStep(n) {
  wizStep = Math.max(1, Math.min(WIZ_MAX, n));
  document.querySelectorAll('.wiz-panel').forEach(p => p.classList.toggle('active', +p.dataset.panel === wizStep));
  document.querySelectorAll('.wiz-step').forEach(s => {
    const step = +s.dataset.step;
    s.classList.toggle('active', step === wizStep);
    s.classList.toggle('done', step < wizStep);
  });
  document.querySelectorAll('.wiz-dot').forEach(d => d.classList.toggle('active', +d.dataset.dot === wizStep));
  document.getElementById('wizPrevBtn').style.visibility = wizStep === 1 ? 'hidden' : 'visible';
  document.getElementById('wizNextBtn').classList.toggle('hidden', wizStep === WIZ_MAX);
  document.getElementById('saveRuleBtn').classList.toggle('hidden', wizStep !== WIZ_MAX);
  if (wizStep === WIZ_MAX) renderWizSummary();
  document.querySelector('.wiz-panel.active')?.scrollTo(0, 0);
}

function wizNext() {
  if (wizStep === 1 && !validateStep1()) return;
  goToStep(wizStep + 1);
}
function wizPrev() { goToStep(wizStep - 1); }

function validateStep1() {
  const kws = document.getElementById('ruleKeywords').value.split(',').map(k => k.trim()).filter(Boolean);
  if (!kws.length) { showToast('Adicione pelo menos uma palavra-chave', 'error'); return false; }
  if (wizTrigger === 'comment_post' && !document.getElementById('rulePostId').value.trim()) {
    showToast('Escolha um post (ou cole o ID) para o gatilho específico', 'error'); return false;
  }
  return true;
}

// ── Trigger type ──
let wizTrigger = 'comment_any';
function setTrigger(type) {
  wizTrigger = type;
  document.getElementById('trigCommentAny')?.classList.toggle('active', type === 'comment_any');
  document.getElementById('trigCommentPost')?.classList.toggle('active', type === 'comment_post');
  document.getElementById('trigDm')?.classList.toggle('active', type === 'dm');
  // post picker só no modo "post específico"
  document.getElementById('wizPostGroup')?.classList.toggle('hidden', type !== 'comment_post');
  if (type !== 'comment_post') clearPostFilter();
  // resposta pública no comentário não faz sentido pra DM
  document.getElementById('wizReplyGroup')?.classList.toggle('hidden', type === 'dm');
  // hidden checkbox que o saveRule lê
  const dm = document.getElementById('ruleTriggerDm');
  if (dm) dm.checked = (type === 'dm');
  renderPhonePreview();
}

// ── Summary (step 3) ──
function renderWizSummary() {
  const el = document.getElementById('wizSummary');
  if (!el) return;
  const kws = document.getElementById('ruleKeywords').value.split(',').map(k => k.trim()).filter(Boolean);
  const acc = document.getElementById('ruleAccountId');
  const accTxt = acc.value ? acc.options[acc.selectedIndex].text : 'Todas as contas';
  const trigTxt = wizTrigger === 'dm' ? '📩 DM / resposta de story'
    : wizTrigger === 'comment_post' ? '📌 Comentário em post específico'
    : '💬 Comentário em qualquer post';
  const delivTxt = wizDelivery === 'strict' ? '🔒 Só quem seguir'
    : wizDelivery === 'choice' ? '🤝 Deixa escolher (seguir ou não)'
    : '📩 Todos recebem';
  const nBlocks = dmBlocks.filter(hasBlockContent).length;
  const rows = [
    ['🎯', 'Gatilho', trigTxt],
    ['🔑', 'Palavras-chave', kws.length ? kws.join(', ') : '—'],
    ['👤', 'Conta', accTxt],
    ['📬', 'Entrega', delivTxt],
    ['✉️', 'Mensagem', nBlocks ? `${nBlocks} bloco${nBlocks > 1 ? 's' : ''}` : '— (defina na etapa 2)']
  ];
  el.innerHTML = rows.map(([i, l, v]) => `<div class="wiz-sum-row"><span class="sum-ico">${i}</span><span class="sum-label">${l}</span><span class="sum-val">${escHtml(v)}</span></div>`).join('');
}

// ════════════════════════════════════════════════
// Live phone preview
// ════════════════════════════════════════════════
function syncPhoneAccount() {
  const acc = document.getElementById('ruleAccountId');
  const sel = acc && acc.value ? allAccounts.find(a => String(a.id) === acc.value) : allAccounts[0];
  const uname = sel ? (sel.username || 'sua_conta') : 'sua_conta';
  const nameEl = document.getElementById('phoneAccountName');
  const avEl = document.getElementById('phoneAvatar');
  if (nameEl) nameEl.textContent = '@' + uname;
  if (avEl) avEl.textContent = uname[0] || 'i';
}

function renderPhonePreview() {
  const chat = document.getElementById('phonePreview');
  if (!chat) return;
  const vars = { username: 'joaozinho', keyword: (document.getElementById('ruleKeywords').value.split(',')[0] || 'link').trim() };
  const follow = document.getElementById('ruleRequireFollow').checked;
  let html = '<div class="ph-day">Hoje</div>';

  // Se for gatilho de comentário, mostra a resposta pública primeiro
  if (wizTrigger !== 'dm') {
    const reply = document.getElementById('ruleCommentReply').value.trim();
    if (reply) html += `<div class="ph-in">💬 <b>resposta no comentário:</b><br>${phVars(reply, vars)}</div>`;
  }

  if (follow) {
    // DM inicial com botões de escolha (follow-gate)
    const prompt = document.getElementById('ruleFollowPrompt').value.trim() || 'Oi @{{username}}! 👋 Como você prefere receber?';
    html += `<div class="ph-out">${phVars(prompt, vars)}</div>`;
    const btns = [];
    if (wizDelivery === 'choice') btns.push('⏭️ Não seguir, só o link');
    btns.push('🧡 Seguir e receber');
    html += `<div class="ph-qr">${btns.map(b => `<span class="ph-qr-btn">${escHtml(b)}</span>`).join('')}</div>`;
  }

  // Mensagem principal (blocos)
  const valid = dmBlocks.filter(hasBlockContent);
  if (valid.length) {
    html += valid.map(b => phBlock(b, vars)).join('');
  } else if (!follow) {
    html += `<div class="ph-empty">✨ Adicione a mensagem com o link na etapa <b>"Eles receberão"</b> para ver a prévia aqui.</div>`;
  }

  chat.innerHTML = html;
  chat.scrollTop = chat.scrollHeight;
}

function phVars(s, vars) {
  return escHtml((s || '').replace(/\{\{username\}\}/g, vars.username).replace(/\{\{keyword\}\}/g, vars.keyword)).replace(/\n/g, '<br>');
}

function phBlock(b, vars) {
  if (b.type === 'text') return `<div class="ph-out">${phVars(b.text, vars)}</div>`;
  if (b.type === 'image') return `<img class="ph-img" src="${escAttr(b.url)}" onerror="this.style.display='none'"/>`;
  if (b.type === 'buttons') {
    const t = b.text ? `<div>${phVars(b.text, vars)}</div>` : '';
    const btns = (b.buttons || []).filter(x => x.title).map(x => `<div class="ph-linkbtn">${phVars(x.title, vars)}</div>`).join('');
    return `<div class="ph-out">${t}<div class="ph-linkbtns">${btns}</div></div>`;
  }
  if (b.type === 'card') {
    const btns = (b.buttons || []).filter(x => x.title).map(x => `<div class="ph-linkbtn">${phVars(x.title, vars)}</div>`).join('');
    return `<div class="ph-card">${b.image_url ? `<img src="${escAttr(b.image_url)}" onerror="this.style.display='none'"/>` : ''}<div class="ph-card-body"><strong>${phVars(b.title, vars)}</strong>${b.subtitle ? `<small>${phVars(b.subtitle, vars)}</small>` : ''}${btns ? `<div class="ph-linkbtns">${btns}</div>` : ''}</div></div>`;
  }
  return '';
}

// ── Seletor visual de post (miniaturas dos posts recentes) ──
async function openPostPicker() {
  const grid = document.getElementById('postGrid');
  const accId = document.getElementById('ruleAccountId').value || '';
  if (!allAccounts.length) { showToast('Conecte uma conta do Instagram primeiro', 'error'); return; }
  grid.classList.remove('hidden');
  grid.innerHTML = '<div class="post-empty">Carregando seus posts…</div>';
  try {
    const params = new URLSearchParams();
    if (accId) params.set('account_id', accId);
    const res = await fetch('/api/media?' + params);
    const data = await res.json();
    if (!res.ok) { grid.innerHTML = `<div class="post-empty">${escHtml(data.error || 'Não foi possível carregar')}</div>`; return; }
    if (!data.posts || !data.posts.length) { grid.innerHTML = '<div class="post-empty">Nenhum post encontrado.</div>'; return; }
    grid.innerHTML = data.posts.map(p => `
      <button type="button" class="post-thumb" title="${escAttr(p.caption || '')}"
        onclick="pickPost('${p.id}','${escAttr(p.thumb || '')}','${escAttr((p.caption || '').slice(0, 28))}')">
        <img src="${escAttr(p.thumb || '')}" loading="lazy" onerror="this.style.opacity='.15'"/>
        ${p.type === 'VIDEO' ? '<span class="post-badge">Reel</span>' : p.type === 'CAROUSEL_ALBUM' ? '<span class="post-badge">Álbum</span>' : ''}
      </button>`).join('');
  } catch { grid.innerHTML = '<div class="post-empty">Erro de conexão.</div>'; }
}

function pickPost(id, thumb, caption) {
  document.getElementById('rulePostId').value = id;
  const picked = document.getElementById('postPicked');
  picked.classList.remove('hidden');
  picked.innerHTML = `${thumb ? `<img src="${escAttr(thumb)}"/>` : ''}<span>${escHtml(caption || ('post #' + id.slice(-6)))}</span>`;
  document.getElementById('postClearBtn').classList.remove('hidden');
  document.getElementById('postGrid').classList.add('hidden');
}

function clearPostFilter() {
  document.getElementById('rulePostId').value = '';
  const picked = document.getElementById('postPicked');
  picked.classList.add('hidden'); picked.innerHTML = '';
  document.getElementById('postClearBtn').classList.add('hidden');
  document.getElementById('postGrid').classList.add('hidden');
}

function onManualPostId() {
  const v = document.getElementById('rulePostId').value.trim();
  document.getElementById('postClearBtn').classList.toggle('hidden', !v);
  if (v) { const p = document.getElementById('postPicked'); p.classList.add('hidden'); p.innerHTML = ''; }
}

function closeRuleModal() { document.getElementById('ruleModal').classList.add('hidden'); }

async function saveRule() {
  const id = document.getElementById('ruleId').value;
  const payload = {
    keywords:              document.getElementById('ruleKeywords').value,
    comment_reply:         document.getElementById('ruleCommentReply').value,
    dm_message:            '',
    dm_blocks:             dmBlocks,
    bonus_blocks:          bonusBlocks,
    follow_prompt_message: document.getElementById('ruleFollowPrompt').value,
    post_id:               document.getElementById('rulePostId').value,
    cooldown_hours:        Number(document.getElementById('ruleCooldownHours').value),
    require_follow:        document.getElementById('ruleRequireFollow').checked,
    allow_skip:            document.getElementById('ruleAllowSkip').checked,
    trigger_dm:            document.getElementById('ruleTriggerDm').checked,
    active:                document.getElementById('ruleActive').checked,
    account_id:            document.getElementById('ruleAccountId').value || null
  };

  const btn = document.getElementById('saveRuleBtn');
  btn.disabled = true; btn.textContent = 'Salvando...';

  try {
    const res  = await fetch(id ? `/api/rules/${id}` : '/api/rules', {
      method: id ? 'PUT' : 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const data = await res.json();
    if (!res.ok) { showToast(data.error || 'Erro ao salvar', 'error'); return; }
    showToast(id ? 'Regra atualizada!' : 'Regra criada!', 'success');
    closeRuleModal();
    loadRules();
  } catch { showToast('Erro de conexão', 'error'); }
  finally { btn.disabled = false; btn.textContent = 'Salvar Regra'; }
}

async function toggleRule(id, cb) {
  try {
    const data = await fetch(`/api/rules/${id}/toggle`, { method: 'PATCH' }).then(r => r.json());
    const card = document.getElementById(`rule-${id}`);
    if (card) card.classList.toggle('inactive', !data.active);
    showToast(data.active ? 'Regra ativada' : 'Regra desativada', 'info');
  } catch { cb.checked = !cb.checked; showToast('Erro ao alterar regra', 'error'); }
}

async function deleteRule(id) {
  if (!confirm('Excluir esta regra?')) return;
  try {
    await fetch(`/api/rules/${id}`, { method: 'DELETE' });
    showToast('Regra excluída', 'info');
    loadRules();
  } catch { showToast('Erro ao excluir', 'error'); }
}

// ── Character counters & preview ──
function updateCharCounters() {
  updateCounter('ruleCommentReply', 'replyCounter',  2200, 'replyPreview');
  updateCounter('ruleFollowPrompt', 'promptCounter', 1000, 'promptPreview');
  updateCounter('ruleKeywords',     'keywordCounter', null, null);
}

function updateCounter(fieldId, counterId, max, previewId) {
  const field   = document.getElementById(fieldId);
  const counter = document.getElementById(counterId);
  if (!field || !counter) return;

  const val = field.value;
  const len = val.length;

  if (max) {
    counter.textContent = `${len} / ${max}`;
    counter.className = 'char-count' + (len > max ? ' over-limit' : len > max * 0.9 ? ' near-limit' : '');
  } else {
    // Keywords: show chips
    const kws = val.split(',').map(k => k.trim()).filter(Boolean);
    counter.textContent = kws.length ? `${kws.length} palavra${kws.length > 1 ? 's' : ''}` : '';
    counter.className = 'char-count';
  }

  // Live preview with variable substitution
  if (previewId && val.trim()) {
    const preview = document.getElementById(previewId);
    if (preview) {
      const rendered = val.replace(/\{\{username\}\}/g, 'usuario_exemplo').replace(/\{\{keyword\}\}/g, 'link');
      preview.classList.remove('hidden');
      preview.innerHTML = `<strong>Preview</strong>${escHtml(rendered)}`;
    }
  } else if (previewId) {
    document.getElementById(previewId)?.classList.add('hidden');
  }
}

// ── Logs ──
async function loadLogs(resetPage = true) {
  if (resetPage) currentLogPage = 0;
  const eventType = document.getElementById('logFilter')?.value || '';
  const accountId = document.getElementById('logAccountFilter')?.value || '';
  const params = new URLSearchParams({ limit: LOG_PAGE, offset: currentLogPage * LOG_PAGE });
  if (eventType) params.set('event_type', eventType);
  if (accountId) params.set('account_id', accountId);

  try {
    const { logs, total } = await fetch(`/api/logs?${params}`).then(r => r.json());
    renderLogs(logs, total);
    renderDashboardLogs(logs.slice(0, 8));
  } catch { showToast('Falha ao carregar logs', 'error'); }
}

const EVENT_LABELS = {
  comment_received:    'Comentário recebido',
  comment_reply_sent:  'Resposta enviada',
  comment_reply_failed:'Falha na resposta',
  dm_sent:             'DM enviada',
  dm_failed:           'Falha no DM',
  follow_check_failed: 'Não segue',
  follow_gate_sent:    'Follow-gate enviado',
  cooldown_skipped:    'Cooldown ativo',
  flow_started:        'Fluxo iniciado',
  flow_done:           'Fluxo concluído'
};

function renderLogs(logs, total) {
  const container = document.getElementById('logsContainer');
  if (!logs.length) {
    container.innerHTML = `<div class="empty-state">
      <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
      <h3>Nenhuma atividade ainda</h3><p>Os logs aparecem aqui quando comentários são recebidos</p>
    </div>`;
    return;
  }

  const totalPages = Math.ceil(total / LOG_PAGE);
  const pagination = totalPages > 1 ? `
    <div class="log-pagination">
      <button class="btn btn-ghost btn-sm" onclick="prevLogPage()" ${currentLogPage === 0 ? 'disabled' : ''}>← Anterior</button>
      <span class="page-info">Pág. ${currentLogPage + 1} / ${totalPages} · ${total} registros</span>
      <button class="btn btn-ghost btn-sm" onclick="nextLogPage()" ${currentLogPage >= totalPages - 1 ? 'disabled' : ''}>Próxima →</button>
    </div>` : `<div class="log-pagination"><span class="page-info">${total} registro${total !== 1 ? 's' : ''}</span></div>`;

  container.innerHTML = `<div class="logs-table-wrap">
    ${logs.map(log => `
      <div class="log-item">
        <span class="log-badge ${log.event_type}">${EVENT_LABELS[log.event_type] || log.event_type}</span>
        <div class="log-meta">
          ${log.username ? `<strong>@${escHtml(log.username)}</strong>` : ''}
          ${log.keyword_matched ? ` · palavra: <code>${escHtml(log.keyword_matched)}</code>` : ''}
          ${log.comment_id ? ` · <span title="${escHtml(log.comment_id)}">#${log.comment_id.slice(-8)}</span>` : ''}
          ${log.account_username ? `<div class="log-account">@${escHtml(log.account_username)}</div>` : ''}
          ${log.error_message ? `<div class="log-error">⚠ ${escHtml(log.error_message)}</div>` : ''}
        </div>
        <span class="log-time" title="${new Date((log.created_at || 0) * 1000).toLocaleString('pt-BR')}">${formatTime(log.created_at)}</span>
      </div>`).join('')}
  </div>${pagination}`;
}

function renderDashboardLogs(logs) {
  const c = document.getElementById('dashboardLogs');
  if (!logs.length) { c.innerHTML = '<div class="empty-state-mini">Nenhuma atividade ainda.</div>'; return; }
  c.innerHTML = logs.map(log => `
    <div class="log-item">
      <span class="log-badge ${log.event_type}">${EVENT_LABELS[log.event_type] || log.event_type}</span>
      <div class="log-meta">
        ${log.username ? `<strong>@${escHtml(log.username)}</strong>` : '—'}
        ${log.keyword_matched ? ` · "${escHtml(log.keyword_matched)}"` : ''}
        ${log.account_username ? ` · @${escHtml(log.account_username)}` : ''}
      </div>
      <span class="log-time">${formatTime(log.created_at)}</span>
    </div>`).join('');
}

function prevLogPage() { if (currentLogPage > 0) { currentLogPage--; loadLogs(false); } }
function nextLogPage() { currentLogPage++; loadLogs(false); }

async function clearLogs() {
  if (!confirm('Limpar todos os logs, histórico de comentários processados e cooldowns?\nEsta ação não pode ser desfeita.')) return;
  try {
    await fetch('/api/logs', { method: 'DELETE' });
    showToast('Logs limpos', 'info');
    currentLogPage = 0;
    loadLogs();
    loadStats();
  } catch { showToast('Erro ao limpar logs', 'error'); }
}

function exportLogs() {
  const eventType = document.getElementById('logFilter')?.value || '';
  const accountId = document.getElementById('logAccountFilter')?.value || '';
  const params = new URLSearchParams();
  if (eventType) params.set('event_type', eventType);
  if (accountId) params.set('account_id', accountId);
  window.location.href = `/api/logs/export?${params}`;
}

// ── Settings Page ──
function loadSettingsPage() {
  const input = document.getElementById('webhookUrl');
  if (input) input.value = `${location.origin}/webhook`;
  loadRetryQueue();
}

async function loadRetryQueue() {
  const panel = document.getElementById('retryQueuePanel');
  if (!panel) return;
  try {
    const stats = await fetch('/api/logs/stats').then(r => r.json());
    if (stats.retry_pending === 0 && stats.retry_failed === 0) {
      panel.innerHTML = '<p class="info-note" style="color:var(--green)">✓ Nenhum item na fila de reenvio.</p>';
    } else {
      panel.innerHTML = `
        <p class="info-note" style="margin-bottom:12px">O sistema tenta reenviar automaticamente a cada 60 segundos.</p>
        <div class="retry-item"><span class="retry-badge">${stats.retry_pending} pendente${stats.retry_pending !== 1 ? 's' : ''}</span> aguardando reenvio</div>
        ${stats.retry_failed ? `<div class="retry-item"><span class="retry-badge retry-failed">${stats.retry_failed} falhou</span> sem mais tentativas</div>` : ''}`;
    }
  } catch { panel.innerHTML = '<p class="info-note">Erro ao carregar fila.</p>'; }
}

function copyWebhookUrl() {
  const val = document.getElementById('webhookUrl')?.value;
  if (!val) return;
  navigator.clipboard.writeText(val)
    .then(() => showToast('URL copiada!', 'success'))
    .catch(() => showToast('Não foi possível copiar', 'error'));
}

// ── Test Comment ──
async function sendTestComment() {
  const text = document.getElementById('testCommentText').value.trim();
  const user = (document.getElementById('testCommentUser').value || 'test_user').replace('@', '');
  const igId = document.getElementById('testAccountSelect')?.value;
  const result = document.getElementById('testResult');
  const btn = document.querySelector('[onclick="sendTestComment()"]');

  if (!text) { showToast('Digite um texto de comentário', 'error'); return; }

  btn.disabled = true; btn.textContent = 'Enviando...';

  const webhook = {
    object: 'instagram',
    entry: [{
      id: igId || (allAccounts[0]?.instagram_user_id || 'test_account'),
      changes: [{
        field: 'comments',
        value: { id: 'test_' + Date.now(), text, media: { id: 'test_media' }, from: { id: 'test_user_001', username: user } }
      }]
    }]
  };

  try {
    await fetch('/webhook', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(webhook) });
    result.className = 'test-result success';
    result.textContent = '✓ Simulação enviada. Verifique os logs para ver o resultado.';
    result.classList.remove('hidden');
    setTimeout(() => { loadLogs(); loadStats(); }, 700);
  } catch {
    result.className = 'test-result error';
    result.textContent = '✗ Erro ao enviar simulação.';
    result.classList.remove('hidden');
  } finally { btn.disabled = false; btn.textContent = 'Enviar Simulação'; }
}

// ── Utils ──
let toastTimer = null;
function showToast(msg, type = 'info') {
  const t = document.getElementById('toast');
  t.textContent = msg; t.className = `toast ${type}`;
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add('hidden'), type === 'error' ? 6000 : 3500);
}

function escHtml(s) {
  return String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function formatTime(unix) {
  if (!unix) return '';
  const diff = Math.floor((Date.now() - unix * 1000) / 60000);
  if (diff < 1) return 'agora';
  if (diff < 60) return `${diff}m atrás`;
  if (diff < 1440) return `${Math.floor(diff / 60)}h atrás`;
  return new Date(unix * 1000).toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' });
}

// ════════════════════════════════════════════════
// DM Block Composer (rich messages)
// ════════════════════════════════════════════════
let dmBlocks = [];
let bonusBlocks = [];
const TYPE_LABEL = { text: '📝 Texto', image: '🖼️ Imagem', buttons: '🔘 Botões', card: '🗂️ Card' };

function addBlock(type) {
  const defaults = {
    text:    { type: 'text', text: '' },
    image:   { type: 'image', url: '' },
    buttons: { type: 'buttons', text: '', buttons: [{ title: '', url: '' }] },
    card:    { type: 'card', title: '', subtitle: '', image_url: '', buttons: [{ title: '', url: '' }] }
  };
  dmBlocks.push(JSON.parse(JSON.stringify(defaults[type])));
  renderDmBlocks();
}
function removeBlock(i) { dmBlocks.splice(i, 1); renderDmBlocks(); }
function moveBlock(i, dir) {
  const j = i + dir;
  if (j < 0 || j >= dmBlocks.length) return;
  [dmBlocks[i], dmBlocks[j]] = [dmBlocks[j], dmBlocks[i]];
  renderDmBlocks();
}
function setBlockField(i, field, value) { dmBlocks[i][field] = value; updateDmPreview(); }
function addBlockButton(i) { (dmBlocks[i].buttons ||= []).push({ title: '', url: '' }); renderDmBlocks(); }
function removeBlockButton(i, bi) { dmBlocks[i].buttons.splice(bi, 1); renderDmBlocks(); }
function setBlockButton(i, bi, field, value) { dmBlocks[i].buttons[bi][field] = value; updateDmPreview(); }

function renderDmBlocks() {
  const wrap = document.getElementById('dmBlocks');
  if (!wrap) return;
  wrap.innerHTML = dmBlocks.length
    ? dmBlocks.map((b, i) => blockEditorHtml(b, i)).join('')
    : '<div class="dm-empty-hint">Nenhum bloco ainda. Adicione um abaixo 👇</div>';
  updateDmPreview();
}

function blockEditorHtml(b, i) {
  const head = `<div class="dm-block-head"><span class="dm-block-type">${TYPE_LABEL[b.type] || b.type}</span>
    <div class="dm-block-actions">
      <button title="Subir" onclick="moveBlock(${i},-1)">↑</button>
      <button title="Descer" onclick="moveBlock(${i},1)">↓</button>
      <button title="Remover" onclick="removeBlock(${i})">✕</button>
    </div></div>`;
  let body = '';
  if (b.type === 'text') {
    body = `<textarea class="input textarea" rows="2" maxlength="1000" placeholder="Texto... use {{username}}" oninput="setBlockField(${i},'text',this.value)">${escHtml(b.text || '')}</textarea>`;
  } else if (b.type === 'image') {
    body = `<input class="input" placeholder="URL da imagem (https://...)" value="${escAttr(b.url || '')}" oninput="setBlockField(${i},'url',this.value)"/>`;
  } else if (b.type === 'buttons') {
    body = `<textarea class="input textarea" rows="2" placeholder="Texto antes dos botões" oninput="setBlockField(${i},'text',this.value)">${escHtml(b.text || '')}</textarea>${buttonRowsHtml(b, i)}`;
  } else if (b.type === 'card') {
    body = `<input class="input" placeholder="Título" value="${escAttr(b.title || '')}" oninput="setBlockField(${i},'title',this.value)"/>
      <input class="input" placeholder="Subtítulo (opcional)" value="${escAttr(b.subtitle || '')}" oninput="setBlockField(${i},'subtitle',this.value)"/>
      <input class="input" placeholder="URL da imagem (opcional)" value="${escAttr(b.image_url || '')}" oninput="setBlockField(${i},'image_url',this.value)"/>${buttonRowsHtml(b, i)}`;
  }
  return `<div class="dm-block">${head}${body}</div>`;
}

function buttonRowsHtml(b, i) {
  const rows = (b.buttons || []).map((btn, bi) => `<div class="dm-btn-row">
    <input class="input" placeholder="Texto do botão" value="${escAttr(btn.title || '')}" oninput="setBlockButton(${i},${bi},'title',this.value)"/>
    <input class="input" placeholder="https://link" value="${escAttr(btn.url || '')}" oninput="setBlockButton(${i},${bi},'url',this.value)"/>
    <button class="dm-btn-remove" onclick="removeBlockButton(${i},${bi})">✕</button>
  </div>`).join('');
  const add = (b.buttons || []).length < 3 ? `<button type="button" class="dm-add-btn" onclick="addBlockButton(${i})">+ Botão</button>` : '';
  return rows + add;
}

function hasBlockContent(b) {
  if (b.type === 'text')    return (b.text || '').trim().length > 0;
  if (b.type === 'image')   return (b.url || '').trim().length > 0;
  if (b.type === 'buttons') return (b.buttons || []).some(x => x.title && x.url);
  if (b.type === 'card')    return (b.title || '').trim() || (b.image_url || '').trim() || (b.buttons || []).some(x => x.title && x.url);
  return false;
}

function updateDmPreview() {
  renderPhonePreview();
  const wrap = document.getElementById('dmPreviewWrap');
  const prev = document.getElementById('dmChatPreview');
  if (!wrap || !prev) return;
  const valid = dmBlocks.filter(hasBlockContent);
  if (!valid.length) { wrap.classList.add('hidden'); return; }
  wrap.classList.remove('hidden');
  prev.innerHTML = valid.map(b => `<div class="msg-row out">${renderRichBlock(b)}</div>`).join('');
}

// ── Bonus blocks (mesmo composer, array separado) ──
function addBonusBlock(type) {
  const defaults = {
    text:    { type: 'text', text: '' },
    image:   { type: 'image', url: '' },
    buttons: { type: 'buttons', text: '', buttons: [{ title: '', url: '' }] }
  };
  bonusBlocks.push(JSON.parse(JSON.stringify(defaults[type])));
  renderBonusBlocks();
}
function removeBonusBlock(i) { bonusBlocks.splice(i, 1); renderBonusBlocks(); }
function moveBonusBlock(i, dir) {
  const j = i + dir; if (j < 0 || j >= bonusBlocks.length) return;
  [bonusBlocks[i], bonusBlocks[j]] = [bonusBlocks[j], bonusBlocks[i]];
  renderBonusBlocks();
}
function setBonusField(i, field, value) { bonusBlocks[i][field] = value; renderPhonePreview(); }
function addBonusBtn(i) { (bonusBlocks[i].buttons ||= []).push({ title: '', url: '' }); renderBonusBlocks(); }
function removeBonusBtn(i, bi) { bonusBlocks[i].buttons.splice(bi, 1); renderBonusBlocks(); }
function setBonusBtn(i, bi, field, value) { bonusBlocks[i].buttons[bi][field] = value; }

function renderBonusBlocks() {
  const wrap = document.getElementById('bonusBlocks');
  if (!wrap) return;
  wrap.innerHTML = bonusBlocks.length
    ? bonusBlocks.map((b, i) => bonusEditorHtml(b, i)).join('')
    : '<div class="dm-empty-hint">Sem bônus. Adicione um bloco 👇</div>';
  renderPhonePreview();
}
function bonusEditorHtml(b, i) {
  const head = `<div class="dm-block-head"><span class="dm-block-type">${TYPE_LABEL[b.type] || b.type}</span>
    <div class="dm-block-actions">
      <button title="Subir" onclick="moveBonusBlock(${i},-1)">↑</button>
      <button title="Descer" onclick="moveBonusBlock(${i},1)">↓</button>
      <button title="Remover" onclick="removeBonusBlock(${i})">✕</button>
    </div></div>`;
  let body = '';
  if (b.type === 'text') {
    body = `<textarea class="input textarea" rows="2" maxlength="1000" placeholder="Ex: Ganhe 20% OFF com o código VIP20 🎁" oninput="setBonusField(${i},'text',this.value)">${escHtml(b.text || '')}</textarea>`;
  } else if (b.type === 'image') {
    body = `<input class="input" placeholder="URL da imagem" value="${escAttr(b.url || '')}" oninput="setBonusField(${i},'url',this.value)"/>`;
  } else if (b.type === 'buttons') {
    body = `<textarea class="input textarea" rows="2" placeholder="Texto antes dos botões" oninput="setBonusField(${i},'text',this.value)">${escHtml(b.text || '')}</textarea>${bonusBtnRows(b, i)}`;
  }
  return `<div class="dm-block">${head}${body}</div>`;
}
function bonusBtnRows(b, i) {
  const rows = (b.buttons || []).map((btn, bi) => `<div class="dm-btn-row">
    <input class="input" placeholder="Texto do botão" value="${escAttr(btn.title || '')}" oninput="setBonusBtn(${i},${bi},'title',this.value)"/>
    <input class="input" placeholder="https://link" value="${escAttr(btn.url || '')}" oninput="setBonusBtn(${i},${bi},'url',this.value)"/>
    <button class="dm-btn-remove" onclick="removeBonusBtn(${i},${bi})">✕</button>
  </div>`).join('');
  const add = (b.buttons || []).length < 3 ? `<button type="button" class="dm-add-btn" onclick="addBonusBtn(${i})">+ Botão</button>` : '';
  return rows + add;
}

// Shared rich renderer (used in preview + inbox)
function renderRichBlock(block, vars = { username: 'usuario_exemplo', keyword: 'link' }) {
  const sub = s => escHtml((s || '').replace(/\{\{username\}\}/g, vars.username || '').replace(/\{\{keyword\}\}/g, vars.keyword || ''));
  switch (block.type) {
    case 'text':
      return `<div class="bubble">${sub(block.text)}</div>`;
    case 'image':
      return block.url ? `<img class="rich-image" src="${escAttr(block.url)}" alt="" loading="lazy"/>` : '';
    case 'buttons':
      return `<div class="bubble bubble-buttons">${block.text ? `<div class="bb-text">${sub(block.text)}</div>` : ''}
        <div class="rich-buttons">${(block.buttons || []).filter(x => x.title).map(x => `<a class="rich-btn" href="${escAttr(x.url)}" target="_blank" rel="noopener">${sub(x.title)}</a>`).join('')}</div></div>`;
    case 'card':
      return `<div class="rich-card">${block.image_url ? `<img class="rich-card-img" src="${escAttr(block.image_url)}" loading="lazy"/>` : ''}
        <div class="rich-card-body"><div class="rich-card-title">${sub(block.title)}</div>${block.subtitle ? `<div class="rich-card-sub">${sub(block.subtitle)}</div>` : ''}</div>
        ${(block.buttons || []).filter(x => x.title).length ? `<div class="rich-buttons">${block.buttons.filter(x => x.title).map(x => `<a class="rich-btn" href="${escAttr(x.url)}" target="_blank" rel="noopener">${sub(x.title)}</a>`).join('')}</div>` : ''}</div>`;
    default: return '';
  }
}

// ════════════════════════════════════════════════
// Inbox
// ════════════════════════════════════════════════
let currentConvId = null;
let inboxPollTimer = null;

async function loadInboxBadge() {
  try {
    const d = await fetch('/api/conversations').then(r => r.json());
    const badge = document.getElementById('inboxBadge');
    if (!badge) return;
    if (d.total_unread > 0) { badge.textContent = d.total_unread > 99 ? '99+' : d.total_unread; badge.classList.remove('hidden'); }
    else badge.classList.add('hidden');
  } catch {}
}

async function loadInbox() {
  try {
    const d = await fetch('/api/conversations').then(r => r.json());
    renderConvList(d.conversations);
    const badge = document.getElementById('inboxBadge');
    if (badge) { if (d.total_unread > 0) { badge.textContent = d.total_unread > 99 ? '99+' : d.total_unread; badge.classList.remove('hidden'); } else badge.classList.add('hidden'); }
  } catch { showToast('Falha ao carregar conversas', 'error'); }
}

function renderConvList(convs) {
  const list = document.getElementById('inboxList');
  if (!list) return;
  if (!convs.length) { list.innerHTML = '<div class="dm-empty-hint" style="padding:30px 16px">Nenhuma conversa ainda.<br>Elas aparecem quando alguém te enviar DM.</div>'; return; }
  list.innerHTML = convs.map(c => {
    const initial = (c.username || '?')[0].toUpperCase();
    return `<div class="conv-item ${c.unread > 0 ? 'unread' : ''} ${c.id === currentConvId ? 'active' : ''}" onclick="openConversation(${c.id})">
      <div class="conv-avatar">${escHtml(initial)}</div>
      <div class="conv-body">
        <div class="conv-top"><span class="conv-name">@${escHtml(c.username || c.user_id)}</span><span class="conv-time">${formatTime(c.last_message_at)}</span></div>
        <div class="conv-preview">${c.last_direction === 'out' ? '<span style="opacity:.6">Você: </span>' : ''}${escHtml(c.last_message || '')}</div>
      </div>
      ${c.unread > 0 ? '<div class="conv-unread-dot"></div>' : ''}
    </div>`;
  }).join('');
}

async function openConversation(id) {
  const switching = id !== currentConvId;
  currentConvId = id;
  if (switching) inboxAttachments = []; // clear attachments only when switching conversations
  try {
    const d = await fetch(`/api/conversations/${id}/messages`).then(r => r.json());
    if (d.error) return;
    renderThread(d.conversation, d.messages, d);
    loadInbox();
  } catch { showToast('Erro ao abrir conversa', 'error'); }
}

function renderThread(conv, messages, meta = {}) {
  const thread = document.getElementById('inboxThread');
  if (!thread) return;
  const initial = (conv.username || '?')[0].toUpperCase();
  const windowOpen = meta.window_open;
  const warn = windowOpen === false
    ? `<div class="composer-warn">⚠ Fora da janela de 24h do Instagram — o envio pode ser bloqueado. Aguarde uma nova mensagem da pessoa.</div>`
    : '';
  const windowTag = windowOpen
    ? `<span class="window-tag ok">Janela aberta · ${meta.window_hours_left}h</span>`
    : (windowOpen === false ? '<span class="window-tag closed">Janela fechada</span>' : '');
  thread.innerHTML = `
    <div class="thread-head">
      <div class="conv-avatar">${escHtml(initial)}</div>
      <div class="thread-head-info"><strong>@${escHtml(conv.username || conv.user_id)}</strong><span>${conv.account_username ? 'via @' + escHtml(conv.account_username) : 'conversa'}</span></div>
      <div class="thread-head-actions">${windowTag}<button class="btn btn-danger-outline btn-sm" onclick="deleteConversation(${conv.id})">Excluir</button></div>
    </div>
    <div class="thread-messages" id="threadMessages">${messages.map(renderThreadMsg).join('')}</div>
    ${warn}
    <div id="inboxAttachChips" class="inbox-attach-chips"></div>
    <div id="inboxAttachPanel" class="inbox-attach-panel hidden">
      <div class="attach-row">
        <input id="attachImageUrl" class="input" placeholder="URL da imagem (https://...)" />
        <button type="button" class="btn btn-sm btn-ghost" onclick="attachImage()">🖼️ Anexar</button>
      </div>
      <div class="attach-row">
        <input id="attachBtnTitle" class="input" placeholder="Texto do botão" />
        <input id="attachBtnUrl" class="input" placeholder="https://link" />
        <button type="button" class="btn btn-sm btn-ghost" onclick="attachButton()">🔘 Botão</button>
      </div>
    </div>
    <div class="thread-composer">
      <button class="composer-attach" onclick="toggleAttachPanel()" title="Anexar imagem ou botão">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
      </button>
      <textarea id="composerInput" placeholder="Escreva uma resposta..." rows="1" oninput="autoGrow(this)" onkeydown="composerKey(event)"></textarea>
      <button class="composer-send" id="composerSend" onclick="sendReply()">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>
      </button>
    </div>`;
  renderAttachChips();
  scrollThreadBottom();
}

// ── Inbox rich attachments ──
let inboxAttachments = [];

function toggleAttachPanel() {
  document.getElementById('inboxAttachPanel')?.classList.toggle('hidden');
}
function attachImage() {
  const el = document.getElementById('attachImageUrl');
  const url = el.value.trim();
  if (!url) return;
  inboxAttachments.push({ type: 'image', url });
  el.value = '';
  renderAttachChips();
}
function attachButton() {
  const t = document.getElementById('attachBtnTitle');
  const u = document.getElementById('attachBtnUrl');
  const title = t.value.trim(), url = u.value.trim();
  if (!title || !url) { showToast('Preencha texto e link do botão', 'error'); return; }
  // group consecutive buttons into one block
  const last = inboxAttachments[inboxAttachments.length - 1];
  if (last && last.type === 'buttons') last.buttons.push({ title, url });
  else inboxAttachments.push({ type: 'buttons', text: '', buttons: [{ title, url }] });
  t.value = ''; u.value = '';
  renderAttachChips();
}
function removeAttach(i) { inboxAttachments.splice(i, 1); renderAttachChips(); }
function renderAttachChips() {
  const wrap = document.getElementById('inboxAttachChips');
  if (!wrap) return;
  if (!inboxAttachments.length) { wrap.innerHTML = ''; return; }
  wrap.innerHTML = inboxAttachments.map((b, i) => {
    const label = b.type === 'image' ? '🖼️ Imagem' : `🔘 ${b.buttons.length} botão(ões)`;
    return `<span class="attach-chip">${label}<button onclick="removeAttach(${i})">✕</button></span>`;
  }).join('');
}

function renderThreadMsg(m) {
  const payload = m.payload && typeof m.payload === 'string' ? safeJson(m.payload) : m.payload;
  let content;
  if (payload && payload.type) {
    content = renderRichBlock(payload, {});
  } else if (m.type === 'image' && payload?.attachments) {
    const url = payload.attachments[0]?.payload?.url;
    content = url ? `<img class="rich-image" src="${escAttr(url)}" loading="lazy"/>` : '<div class="bubble">📷 Imagem</div>';
  } else {
    content = `<div class="bubble">${escHtml(m.text || '')}</div>`;
  }
  const manual = m.source === 'manual' ? '<span class="msg-manual-tag">manual</span>' : '';
  return `<div class="msg-row ${m.direction}">${content}<div class="msg-meta">${formatTime(m.created_at)}${m.direction === 'out' ? manual : ''}</div></div>`;
}

async function sendReply() {
  const input = document.getElementById('composerInput');
  if (!input || !currentConvId) return;
  const text = input.value.trim();
  const hasAttach = inboxAttachments.length > 0;
  if (!text && !hasAttach) return;

  // Build payload: blocks if attachments present (text becomes a leading text block)
  let body;
  if (hasAttach) {
    const blocks = [];
    if (text) blocks.push({ type: 'text', text });
    blocks.push(...inboxAttachments);
    body = { blocks };
  } else {
    body = { text };
  }

  const btn = document.getElementById('composerSend');
  btn.disabled = true;
  try {
    const res = await fetch(`/api/conversations/${currentConvId}/reply`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
    });
    const data = await res.json();
    if (!res.ok) { showToast(data.error || 'Erro ao enviar', 'error'); return; }
    input.value = ''; autoGrow(input);
    inboxAttachments = []; renderAttachChips();
    document.getElementById('inboxAttachPanel')?.classList.add('hidden');
    openConversation(currentConvId);
  } catch { showToast('Erro de conexão', 'error'); }
  finally { btn.disabled = false; }
}

async function deleteConversation(id) {
  if (!confirm('Excluir esta conversa do histórico? (não afeta o Instagram)')) return;
  await fetch(`/api/conversations/${id}`, { method: 'DELETE' });
  currentConvId = null;
  document.getElementById('inboxThread').innerHTML = `<div class="inbox-empty"><h3>Conversa excluída</h3><p>Selecione outra conversa.</p></div>`;
  loadInbox();
}

function composerKey(e) {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendReply(); }
}
function autoGrow(el) { el.style.height = 'auto'; el.style.height = Math.min(el.scrollHeight, 120) + 'px'; }
function scrollThreadBottom() { const t = document.getElementById('threadMessages'); if (t) t.scrollTop = t.scrollHeight; }

function startInboxPolling() {
  stopInboxPolling();
  inboxPollTimer = setInterval(() => { loadInbox(); if (currentConvId) refreshOpenThread(); }, 10000);
}
function stopInboxPolling() { if (inboxPollTimer) { clearInterval(inboxPollTimer); inboxPollTimer = null; } }

async function refreshOpenThread() {
  const input = document.getElementById('composerInput');
  const saved = input ? input.value : '';
  const focused = document.activeElement === input;
  const panelOpen = !document.getElementById('inboxAttachPanel')?.classList.contains('hidden');
  try {
    const d = await fetch(`/api/conversations/${currentConvId}/messages`).then(r => r.json());
    if (d.error) return;
    renderThread(d.conversation, d.messages, d); // inboxAttachments preserved (module var)
    const ni = document.getElementById('composerInput');
    if (ni && saved) { ni.value = saved; autoGrow(ni); if (focused) ni.focus(); }
    if (panelOpen) document.getElementById('inboxAttachPanel')?.classList.remove('hidden');
  } catch {}
}

function safeJson(s) { try { return JSON.parse(s); } catch { return null; } }
function escAttr(s) { return String(s ?? '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

// ════════════════════════════════════════════════
// Flow Builder
// ════════════════════════════════════════════════
let flowState = null;   // { id, name, account_id, active, nodes, edges }
let flowConn  = null;   // armed connection { fromId, fromPort }
let flowDrag  = null;   // { id, ox, oy }

const FLOW_NODE_META = {
  trigger:       { ico: '⚡', label: 'Gatilho' },
  message:       { ico: '✉️', label: 'Mensagem' },
  comment_reply: { ico: '💬', label: 'Resposta' },
  delay:         { ico: '⏱️', label: 'Espera' },
  condition:     { ico: '🔀', label: 'Condição' }
};

// ── List ──
async function loadFlows() {
  try {
    const flows = await fetch('/api/flows').then(r => r.json());
    renderFlowsList(flows);
  } catch { showToast('Falha ao carregar fluxos', 'error'); }
}

function renderFlowsList(flows) {
  const c = document.getElementById('flowsList');
  if (!flows.length) {
    c.innerHTML = `<div class="empty-state">
      <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4"><circle cx="6" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="12" r="3"/><path d="M9 6h6a3 3 0 0 1 3 3M9 18h6a3 3 0 0 0 3-3"/></svg>
      <h3>Nenhum fluxo criado</h3><p>Comece de um modelo pronto ou crie um fluxo visual do zero</p>
      <button class="btn btn-primary" onclick="openFlowTemplates()">Ver modelos de fluxo</button>
    </div>`;
    return;
  }
  c.innerHTML = flows.map(f => `
    <div class="flow-card ${f.active ? '' : 'inactive'}">
      <div class="flow-card-icon"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="6" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="12" r="3"/><path d="M9 6h6a3 3 0 0 1 3 3M9 18h6a3 3 0 0 0 3-3"/></svg></div>
      <div class="flow-card-info">
        <strong>${escHtml(f.name)}</strong>
        <span>${f.nodes} bloco${f.nodes !== 1 ? 's' : ''}${f.account_username ? ' · @' + escHtml(f.account_username) : ''}</span>
      </div>
      <div class="flow-card-controls">
        <label class="toggle"><input type="checkbox" ${f.active ? 'checked' : ''} onchange="toggleFlow(${f.id}, this)"/><span class="toggle-slider"></span></label>
        <button class="btn btn-ghost btn-sm" onclick="openFlowEditor(${f.id})">Editar</button>
        <button class="btn btn-danger-outline btn-sm" onclick="deleteFlow(${f.id})">Excluir</button>
      </div>
    </div>`).join('');
}

async function toggleFlow(id, cb) {
  try { await fetch(`/api/flows/${id}/toggle`, { method: 'PATCH' }); showToast('Fluxo atualizado', 'info'); }
  catch { cb.checked = !cb.checked; showToast('Erro', 'error'); }
}
async function deleteFlow(id) {
  if (!confirm('Excluir este fluxo?')) return;
  await fetch(`/api/flows/${id}`, { method: 'DELETE' });
  showToast('Fluxo excluído', 'info'); loadFlows();
}

// ── Editor ──
function flowUid() { return 'n' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }

// ── Fluxos pré-definidos (templates) ──
const T = (type, x, y, data) => ({ id: type + '_' + Math.random().toString(36).slice(2, 6), type, x, y, data });
function txt(t) { return { blocks: [{ type: 'text', text: t }] }; }

const FLOW_TEMPLATES = [
  {
    id: 'follow_bonus', icon: '🎁', name: 'Seguiu → Recebe + Bônus',
    desc: 'Recompensa quem seguir com um bônus extra além do link — turbina conversão.',
    build: () => {
      const tr = { id: 'trigger', type: 'trigger', x: 40, y: 200, data: { keywords: 'quero,link,eu quero' } };
      const c1 = { id: 'c1', type: 'condition', x: 300, y: 200, data: { kind: 'follows' } };
      const m1 = { id: 'm1', type: 'message', x: 580, y: 100, data: txt('Perfeito @{{username}}! Aqui está: https://seulink.com 🎉') };
      const m1b = { id: 'm1b', type: 'message', x: 840, y: 100, data: txt('🎁 Como você segue, ganhou um bônus: código VIP20 (20% OFF)') };
      const m2 = { id: 'm2', type: 'message', x: 580, y: 320, data: txt('Ei @{{username}}! Me segue pra receber o link + um bônus exclusivo 💜') };
      return { nodes: [tr, c1, m1, m1b, m2], edges: [
        { from: 'trigger', to: 'c1' },
        { from: 'c1', fromPort: 'yes', to: 'm1' },
        { from: 'm1', to: 'm1b' },
        { from: 'c1', fromPort: 'no', to: 'm2' }
      ] };
    }
  },
  {
    id: 'category_choice', icon: '🧭', name: 'Escolha sua Categoria',
    desc: 'Pergunta o interesse (IA, Marketing, Vídeos…) e envia conteúdo personalizado.',
    build: () => {
      const tr = { id: 'trigger', type: 'trigger', x: 40, y: 200, data: { keywords: 'oi,quero,tudo' } };
      const m1 = { id: 'm1', type: 'message', x: 320, y: 200, data: {
        blocks: [
          { type: 'text', text: 'Oi @{{username}}! Sobre o que você quer receber?' },
          { type: 'buttons', text: 'Escolhe uma opção 👇', buttons: [
            { title: '🤖 IA', url: 'https://seulink.com/ia' },
            { title: '📈 Marketing', url: 'https://seulink.com/mkt' },
            { title: '🎬 Vídeos', url: 'https://seulink.com/videos' }
          ] }
        ]
      } };
      return { nodes: [tr, m1], edges: [{ from: 'trigger', to: 'm1' }] };
    }
  },
  {
    id: 'link_then_invite', icon: '📩', name: 'Recebeu link → Convite pra seguir',
    desc: 'Manda o link direto e, DEPOIS de 2 min, convida gentilmente pra seguir.',
    build: () => {
      const tr = { id: 'trigger', type: 'trigger', x: 40, y: 200, data: { keywords: 'link,quero' } };
      const m1 = { id: 'm1', type: 'message', x: 300, y: 200, data: txt('Aqui está @{{username}}! 👉 https://seulink.com') };
      const d1 = { id: 'd1', type: 'delay', x: 560, y: 200, data: { minutes: 2 } };
      const m2 = { id: 'm2', type: 'message', x: 820, y: 200, data: txt('Conseguiu acessar? 😊 Se curtir, me segue pra receber mais coisas assim 💜') };
      return { nodes: [tr, m1, d1, m2], edges: [
        { from: 'trigger', to: 'm1' }, { from: 'm1', to: 'd1' }, { from: 'd1', to: 'm2' }
      ] };
    }
  },
  {
    id: 'welcome_series', icon: '🎉', name: 'Sequência de Boas-vindas',
    desc: 'Mensagem 1 na hora + mensagem 2 em 30 min + mensagem 3 no dia seguinte.',
    build: () => {
      const tr = { id: 'trigger', type: 'trigger', x: 40, y: 200, data: { keywords: 'oi,quero' } };
      const m1 = { id: 'm1', type: 'message', x: 260, y: 200, data: txt('Bem-vindo(a) @{{username}}! 🎉 Aqui está seu link: https://seulink.com') };
      const d1 = { id: 'd1', type: 'delay', x: 500, y: 200, data: { minutes: 30 } };
      const m2 = { id: 'm2', type: 'message', x: 720, y: 200, data: txt('Aproveitou o material? 😉 Se sim, dá uma olhada aqui também: https://seulink.com/extra') };
      const d2 = { id: 'd2', type: 'delay', x: 960, y: 200, data: { minutes: 1440 } };
      const m3 = { id: 'm3', type: 'message', x: 1180, y: 200, data: txt('Oi de novo! 👋 Separei uma dica bônus pra você: https://seulink.com/bonus') };
      return { nodes: [tr, m1, d1, m2, d2, m3], edges: [
        { from: 'trigger', to: 'm1' }, { from: 'm1', to: 'd1' }, { from: 'd1', to: 'm2' },
        { from: 'm2', to: 'd2' }, { from: 'd2', to: 'm3' }
      ] };
    }
  },
  {
    id: 'blank', icon: '➕', name: 'Em branco',
    desc: 'Comece do zero com um gatilho vazio.',
    build: () => ({ nodes: [{ id: 'trigger', type: 'trigger', x: 80, y: 160, data: { keywords: '', post_id: '' } }], edges: [] })
  },
  {
    id: 'comment_link', icon: '🔗', name: 'Comentário → Link no DM',
    desc: 'Comentou a palavra-chave → responde o comentário e envia o link no direct.',
    build: () => {
      const tr = { id: 'trigger', type: 'trigger', x: 60, y: 180, data: { keywords: 'link' } };
      const r1 = { id: 'r1', type: 'comment_reply', x: 340, y: 180, data: { text: 'Te mandei no direct! 📩' } };
      const m1 = { id: 'm1', type: 'message', x: 620, y: 180, data: txt('Oi @{{username}}! Aqui está o seu link: https://seulink.com 🔗') };
      return { nodes: [tr, r1, m1], edges: [{ from: 'trigger', to: 'r1' }, { from: 'r1', to: 'm1' }] };
    }
  },
  {
    id: 'follow_gate', icon: '🔒', name: 'Seguir para receber o link',
    desc: 'Se a pessoa SEGUE, recebe o link. Se NÃO segue, recebe um convite pra seguir.',
    build: () => {
      const tr = { id: 'trigger', type: 'trigger', x: 60, y: 200, data: { keywords: 'quero,link' } };
      const c1 = { id: 'c1', type: 'condition', x: 340, y: 200, data: { kind: 'follows' } };
      const m1 = { id: 'm1', type: 'message', x: 640, y: 110, data: txt('Perfeito @{{username}}! Aqui está: https://seulink.com 🎉') };
      const m2 = { id: 'm2', type: 'message', x: 640, y: 300, data: txt('Ei @{{username}}! Me segue primeiro 👇 depois comenta de novo que eu te envio o link 💜') };
      return { nodes: [tr, c1, m1, m2], edges: [
        { from: 'trigger', to: 'c1' },
        { from: 'c1', fromPort: 'yes', to: 'm1' },
        { from: 'c1', fromPort: 'no', to: 'm2' }
      ] };
    }
  },
  {
    id: 'not_follow_direct', icon: '📩', name: 'Enviar o link sem exigir seguir',
    desc: 'Qualquer pessoa que comentar recebe o link no direct — sem precisar seguir.',
    build: () => {
      const tr = { id: 'trigger', type: 'trigger', x: 60, y: 180, data: { keywords: 'link,quero' } };
      const m1 = { id: 'm1', type: 'message', x: 360, y: 180, data: txt('Oi @{{username}}! Aqui está sem enrolação: https://seulink.com 🚀') };
      return { nodes: [tr, m1], edges: [{ from: 'trigger', to: 'm1' }] };
    }
  },
  {
    id: 'remind_10min', icon: '⏱️', name: 'Não seguiu → lembrete em 10 min',
    desc: 'Se seguir, envia o link. Se não, espera 10 min e responde o comentário + DM pedindo pra seguir.',
    build: () => {
      const tr = { id: 'trigger', type: 'trigger', x: 40, y: 220, data: { keywords: 'link' } };
      const c1 = { id: 'c1', type: 'condition', x: 300, y: 220, data: { kind: 'follows' } };
      const m1 = { id: 'm1', type: 'message', x: 560, y: 110, data: txt('Aqui está @{{username}}: https://seulink.com 🎉') };
      const d1 = { id: 'd1', type: 'delay', x: 560, y: 320, data: { minutes: 10 } };
      const r1 = { id: 'r1', type: 'comment_reply', x: 820, y: 320, data: { text: '@{{username}} me segue que eu te mando o link! 💜' } };
      const m2 = { id: 'm2', type: 'message', x: 1080, y: 320, data: txt('Vi que você ainda não segue 👀 segue lá e comenta de novo que eu te envio na hora!') };
      return { nodes: [tr, c1, m1, d1, r1, m2], edges: [
        { from: 'trigger', to: 'c1' },
        { from: 'c1', fromPort: 'yes', to: 'm1' },
        { from: 'c1', fromPort: 'no', to: 'd1' },
        { from: 'd1', to: 'r1' },
        { from: 'r1', to: 'm2' }
      ] };
    }
  },
  {
    id: 'welcome', icon: '👋', name: 'Boas-vindas para quem já segue',
    desc: 'Se já segue, recebe boas-vindas + link. Se não, um convite pra seguir.',
    build: () => {
      const tr = { id: 'trigger', type: 'trigger', x: 60, y: 200, data: { keywords: 'oi,quero,eu' } };
      const c1 = { id: 'c1', type: 'condition', x: 340, y: 200, data: { kind: 'follows' } };
      const m1 = { id: 'm1', type: 'message', x: 640, y: 110, data: txt('Que alegria te ver por aqui @{{username}}! 🎉 Aqui está o que você quer: https://seulink.com') };
      const m2 = { id: 'm2', type: 'message', x: 640, y: 300, data: txt('Me segue pra fazer parte 💜 depois comenta de novo!') };
      return { nodes: [tr, c1, m1, m2], edges: [
        { from: 'trigger', to: 'c1' },
        { from: 'c1', fromPort: 'yes', to: 'm1' },
        { from: 'c1', fromPort: 'no', to: 'm2' }
      ] };
    }
  },
  {
    id: 'reels_sale', icon: '🎬', name: 'Vender pelos comentários do Reel',
    desc: 'Comentou no seu Reel → recebe a oferta/link direto no direct.',
    build: () => {
      const tr = { id: 'trigger', type: 'trigger', x: 60, y: 180, data: { keywords: 'quero,eu quero,preço' } };
      const r1 = { id: 'r1', type: 'comment_reply', x: 340, y: 180, data: { text: 'Olha seu direct que te mandei tudo! 😍' } };
      const m1 = { id: 'm1', type: 'message', x: 620, y: 180, data: txt('Oi @{{username}}! Achou o Reel bom né? 🔥 Garante o seu aqui: https://seulink.com') };
      return { nodes: [tr, r1, m1], edges: [{ from: 'trigger', to: 'r1' }, { from: 'r1', to: 'm1' }] };
    }
  },
  {
    id: 'whatsapp', icon: '💚', name: 'Levar leads pro WhatsApp',
    desc: 'Comentou → recebe uma DM com o link do seu WhatsApp pra conversar.',
    build: () => {
      const tr = { id: 'trigger', type: 'trigger', x: 60, y: 180, data: { keywords: 'contato,whats,quero' } };
      const m1 = { id: 'm1', type: 'message', x: 360, y: 180, data: txt('Oi @{{username}}! Bora conversar no WhatsApp? 👉 https://wa.me/5599999999999') };
      return { nodes: [tr, m1], edges: [{ from: 'trigger', to: 'm1' }] };
    }
  },
  {
    id: 'rsvp', icon: '🎟️', name: 'Confirmar presença (aula/evento)',
    desc: '"Comente EU QUERO" → confirma a presença e envia o link de acesso.',
    build: () => {
      const tr = { id: 'trigger', type: 'trigger', x: 60, y: 180, data: { keywords: 'eu quero,quero,participar' } };
      const r1 = { id: 'r1', type: 'comment_reply', x: 340, y: 180, data: { text: 'Presença confirmada! Olha seu direct 🎟️' } };
      const m1 = { id: 'm1', type: 'message', x: 620, y: 180, data: txt('Presença confirmada @{{username}}! 🎉 Acesse aqui: https://seulink.com') };
      return { nodes: [tr, r1, m1], edges: [{ from: 'trigger', to: 'r1' }, { from: 'r1', to: 'm1' }] };
    }
  },
  {
    id: 'promo', icon: '🎁', name: 'Cupom / Promoção',
    desc: 'Comentou "cupom" ou "promo" → recebe o código de desconto no direct.',
    build: () => {
      const tr = { id: 'trigger', type: 'trigger', x: 60, y: 180, data: { keywords: 'cupom,promo,desconto' } };
      const r1 = { id: 'r1', type: 'comment_reply', x: 340, y: 180, data: { text: 'Cupom no seu direct! 🛍️' } };
      const m1 = { id: 'm1', type: 'message', x: 620, y: 180, data: txt('Seu cupom @{{username}}: PROMO20 🎁 Use em: https://seulink.com') };
      return { nodes: [tr, r1, m1], edges: [{ from: 'trigger', to: 'r1' }, { from: 'r1', to: 'm1' }] };
    }
  }
];

function openFlowTemplates() {
  const grid = document.getElementById('flowTemplatesGrid');
  grid.innerHTML = FLOW_TEMPLATES.map(t => `
    <button class="tpl-card ${t.id === 'blank' ? 'tpl-blank' : ''}" onclick="pickFlowTemplate('${t.id}')">
      <span class="tpl-ico">${t.icon}</span>
      <strong>${escHtml(t.name)}</strong>
      <span class="tpl-desc">${escHtml(t.desc)}</span>
    </button>`).join('');
  document.getElementById('flowTemplatesModal').classList.remove('hidden');
}
function closeFlowTemplates() { document.getElementById('flowTemplatesModal').classList.add('hidden'); }

function pickFlowTemplate(id) {
  const t = FLOW_TEMPLATES.find(x => x.id === id);
  if (!t) return;
  closeFlowTemplates();
  const def = t.build();
  openFlowEditor(null, { name: id === 'blank' ? '' : t.name, nodes: def.nodes, edges: def.edges });
}

async function openFlowEditor(id = null, prefill = null) {
  flowConn = null; flowDrag = null;
  // account dropdown
  const accSel = document.getElementById('flowAccount');
  accSel.innerHTML = '<option value="">Todas as contas</option>' + allAccounts.map(a => `<option value="${a.id}">@${escHtml(a.username)}</option>`).join('');

  if (id) {
    const f = await fetch(`/api/flows/${id}`).then(r => r.json());
    if (f.error) { showToast(f.error, 'error'); return; }
    flowState = { id: f.id, name: f.name, account_id: f.account_id, active: !!f.active, nodes: f.definition.nodes || [], edges: f.definition.edges || [] };
  } else if (prefill) {
    flowState = { id: null, name: prefill.name || '', account_id: null, active: true, nodes: prefill.nodes, edges: prefill.edges };
  } else {
    flowState = { id: null, name: '', account_id: null, active: true,
      nodes: [{ id: 'trigger', type: 'trigger', x: 80, y: 160, data: { keywords: '', post_id: '' } }], edges: [] };
  }
  document.getElementById('flowName').value = flowState.name;
  document.getElementById('flowAccount').value = flowState.account_id || '';
  document.getElementById('flowActive').checked = flowState.active;
  document.getElementById('flowEditor').classList.remove('hidden');
  renderFlowCanvas();
}

function closeFlowEditor() {
  document.getElementById('flowEditor').classList.add('hidden');
  flowState = null; flowConn = null;
  loadFlows();
}

function addFlowNode(type) {
  if (!flowState) return;
  const wrap = document.getElementById('flowCanvasWrap');
  const x = (wrap.scrollLeft || 0) + 320;
  const y = (wrap.scrollTop || 0) + 140 + Math.random() * 80;
  const defaults = {
    message:       { blocks: [{ type: 'text', text: '' }] },
    comment_reply: { text: '' },
    delay:         { minutes: 60 },
    condition:     { kind: 'follows', value: '' }
  };
  flowState.nodes.push({ id: flowUid(), type, x, y, data: JSON.parse(JSON.stringify(defaults[type])) });
  renderFlowCanvas();
}

function removeFlowNode(id) {
  flowState.nodes = flowState.nodes.filter(n => n.id !== id);
  flowState.edges = flowState.edges.filter(e => e.from !== id && e.to !== id);
  renderFlowCanvas();
}

// Node data binding (no re-render → keeps focus)
function setNodeData(id, field, value) {
  const n = flowState.nodes.find(x => x.id === id); if (!n) return;
  if (field === 'message_text') {
    n.data.blocks = n.data.blocks || [];
    let tb = n.data.blocks.find(b => b.type === 'text');
    if (tb) tb.text = value;
    else n.data.blocks.unshift({ type: 'text', text: value }); // keep any extras
  } else n.data[field] = value;
}

// Rich blocks inside a flow message node
function addNodeBlock(id, type) {
  const n = flowState.nodes.find(x => x.id === id); if (!n) return;
  n.data.blocks = n.data.blocks || [];
  if (type === 'image') n.data.blocks.push({ type: 'image', url: '' });
  else if (type === 'buttons') n.data.blocks.push({ type: 'buttons', text: '', buttons: [{ title: '', url: '' }] });
  renderFlowCanvas();
}
function removeNodeBlock(id, idx) {
  const n = flowState.nodes.find(x => x.id === id); if (!n) return;
  n.data.blocks.splice(idx, 1); renderFlowCanvas();
}
function setNodeBlockField(id, idx, field, value) {
  const n = flowState.nodes.find(x => x.id === id); if (!n || !n.data.blocks[idx]) return;
  n.data.blocks[idx][field] = value;
}
function setNodeBtn(id, idx, field, value) {
  const n = flowState.nodes.find(x => x.id === id); if (!n || !n.data.blocks[idx]) return;
  (n.data.blocks[idx].buttons ||= [{}])[0] = { ...(n.data.blocks[idx].buttons[0] || {}), [field]: value };
}
function nodeExtraHtml(b, id, idx) {
  if (b.type === 'image')
    return `<div class="node-xblock"><input class="input" placeholder="URL da imagem" value="${escAttr(b.url || '')}" oninput="setNodeBlockField('${id}',${idx},'url',this.value)"/><button class="node-x-del" onclick="removeNodeBlock('${id}',${idx})" title="Remover">✕</button></div>`;
  if (b.type === 'buttons') { const bt = (b.buttons && b.buttons[0]) || {};
    return `<div class="node-xblock"><input class="input" placeholder="Texto do botão" value="${escAttr(bt.title || '')}" oninput="setNodeBtn('${id}',${idx},'title',this.value)"/><input class="input" placeholder="https://link" value="${escAttr(bt.url || '')}" oninput="setNodeBtn('${id}',${idx},'url',this.value)"/><button class="node-x-del" onclick="removeNodeBlock('${id}',${idx})" title="Remover">✕</button></div>`; }
  if (b.type === 'card') return `<div class="node-xblock node-card-hint">🗂 Card (edite em Regras)</div>`;
  return '';
}

// Port click → arm / connect
function onPortClick(e, nodeId, port) {
  e.stopPropagation();
  flowConn = { fromId: nodeId, fromPort: port };
  document.querySelectorAll('.port').forEach(p => p.classList.remove('armed'));
  e.currentTarget.classList.add('armed');
  document.getElementById('flowCanvasWrap').classList.add('flow-connecting');
  setFlowHint('Agora clique no bloco de destino');
}

function onNodeClick(nodeId) {
  if (!flowConn) return;
  if (flowConn.fromId === nodeId) { cancelConn(); return; }
  // replace any existing edge from same port
  flowState.edges = flowState.edges.filter(e => !(e.from === flowConn.fromId && (e.fromPort || 'out') === flowConn.fromPort));
  flowState.edges.push({ from: flowConn.fromId, fromPort: flowConn.fromPort, to: nodeId });
  cancelConn();
  renderFlowCanvas();
}

function cancelConn() {
  flowConn = null;
  document.querySelectorAll('.port').forEach(p => p.classList.remove('armed'));
  document.getElementById('flowCanvasWrap')?.classList.remove('flow-connecting');
  setFlowHint('');
}

function setFlowHint(t) { const h = document.getElementById('flowHint'); if (h) h.textContent = t; }

// ── Render ──
function renderFlowCanvas() {
  const canvas = document.getElementById('flowCanvas');
  if (!canvas || !flowState) return;
  canvas.innerHTML = flowState.nodes.map(nodeHtml).join('');
  renderFlowEdges();
}

function nodeHtml(n) {
  const meta = FLOW_NODE_META[n.type];
  const delBtn = n.type === 'trigger' ? '' : `<button class="nh-del" onclick="removeFlowNode('${n.id}')" title="Remover">✕</button>`;
  let body = '';
  if (n.type === 'trigger') {
    body = `<input class="input" placeholder="palavras-chave (vírgula)" value="${escAttr(n.data.keywords || '')}" oninput="setNodeData('${n.id}','keywords',this.value)"/>
      <input class="input" placeholder="Post ID (opcional)" value="${escAttr(n.data.post_id || '')}" oninput="setNodeData('${n.id}','post_id',this.value)" style="margin-top:6px"/>`;
  } else if (n.type === 'message') {
    const blocks = n.data.blocks || [];
    const tb = blocks.find(b => b.type === 'text');
    const extras = blocks.map((b, i) => ({ b, i })).filter(x => x.b.type !== 'text');
    body = `<textarea class="input textarea" rows="2" placeholder="Mensagem... use {{username}}" oninput="setNodeData('${n.id}','message_text',this.value)">${escHtml(tb?.text || '')}</textarea>
      ${extras.length ? `<div class="node-extras">${extras.map(x => nodeExtraHtml(x.b, n.id, x.i)).join('')}</div>` : ''}
      <div class="node-add-row">
        <button type="button" class="node-add-btn" onclick="addNodeBlock('${n.id}','image')">🖼️ Imagem</button>
        <button type="button" class="node-add-btn" onclick="addNodeBlock('${n.id}','buttons')">🔘 Botão</button>
      </div>`;
  } else if (n.type === 'comment_reply') {
    body = `<textarea class="input textarea" rows="2" placeholder="Resposta no comentário" oninput="setNodeData('${n.id}','text',this.value)">${escHtml(n.data.text || '')}</textarea>`;
  } else if (n.type === 'delay') {
    body = `<div class="fn-row"><input type="number" class="input" min="1" value="${escAttr(n.data.minutes || 60)}" oninput="setNodeData('${n.id}','minutes',this.value)" style="width:80px"/><span style="font-size:12px;color:var(--text-muted)">minutos</span></div>`;
  } else if (n.type === 'condition') {
    body = `<select class="input select-input" onchange="setNodeData('${n.id}','kind',this.value); rerenderNodeCond('${n.id}',this.value)">
        <option value="follows" ${n.data.kind === 'follows' ? 'selected' : ''}>Usuário me segue?</option>
        <option value="contains" ${n.data.kind === 'contains' ? 'selected' : ''}>Comentário contém...</option>
      </select>
      <input class="input cond-val" placeholder="texto a conter" value="${escAttr(n.data.value || '')}" oninput="setNodeData('${n.id}','value',this.value)" style="margin-top:6px;display:${n.data.kind === 'contains' ? 'block' : 'none'}"/>`;
  }

  // ports
  let ports = '';
  if (n.type !== 'trigger') ports += `<div class="port in"></div>`;
  if (n.type === 'condition') {
    ports += `<div class="port yes" onclick="onPortClick(event,'${n.id}','yes')"></div><span class="port-lbl-yes">SIM</span>`;
    ports += `<div class="port no" onclick="onPortClick(event,'${n.id}','no')"></div><span class="port-lbl-no">NÃO</span>`;
  } else {
    ports += `<div class="port out" onclick="onPortClick(event,'${n.id}','out')"></div>`;
  }

  return `<div class="flow-node ${n.type}" id="fn-${n.id}" style="left:${n.x}px;top:${n.y}px" onclick="onNodeClick('${n.id}')">
    <div class="flow-node-head" onmousedown="startNodeDrag(event,'${n.id}')"><span class="nh-ico">${meta.ico}</span>${meta.label}${delBtn}</div>
    <div class="flow-node-body">${body}</div>
    ${ports}
  </div>`;
}

function rerenderNodeCond(id, kind) {
  const node = document.getElementById('fn-' + id);
  const val = node?.querySelector('.cond-val');
  if (val) val.style.display = kind === 'contains' ? 'block' : 'none';
}

// Port anchor points (approx, based on stored coords)
const NODE_W = 220;
function outAnchor(n, port) {
  if (port === 'yes') return { x: n.x + NODE_W, y: n.y + 34 + 18 };
  if (port === 'no')  return { x: n.x + NODE_W, y: n.y + 34 + 42 };
  return { x: n.x + NODE_W, y: n.y + 18 };
}
function inAnchor(n) { return { x: n.x, y: n.y + 18 }; }

function renderFlowEdges() {
  const svg = document.getElementById('flowEdges');
  if (!svg) return;
  const byId = Object.fromEntries(flowState.nodes.map(n => [n.id, n]));
  const paths = flowState.edges.map((e, i) => {
    const a = byId[e.from], b = byId[e.to];
    if (!a || !b) return '';
    const s = outAnchor(a, e.fromPort || 'out');
    const t = inAnchor(b);
    const dx = Math.max(40, Math.abs(t.x - s.x) / 2);
    const color = e.fromPort === 'yes' ? 'var(--green)' : e.fromPort === 'no' ? 'var(--red)' : 'var(--accent)';
    return `<path d="M ${s.x} ${s.y} C ${s.x + dx} ${s.y}, ${t.x - dx} ${t.y}, ${t.x} ${t.y}" stroke="${color}" stroke-width="2.5" fill="none" onclick="deleteEdge(${i})"><title>Clique para remover</title></path>`;
  }).join('');
  svg.innerHTML = paths;
}

function deleteEdge(i) { flowState.edges.splice(i, 1); renderFlowCanvas(); }

// ── Node drag ──
function startNodeDrag(e, id) {
  if (flowConn) { onNodeClick(id); return; } // connecting takes priority
  if (e.target.classList.contains('nh-del')) return;
  e.preventDefault();
  const n = flowState.nodes.find(x => x.id === id); if (!n) return;
  const wrap = document.getElementById('flowCanvasWrap');
  const rect = wrap.getBoundingClientRect();
  const cx = e.clientX - rect.left + wrap.scrollLeft;
  const cy = e.clientY - rect.top + wrap.scrollTop;
  flowDrag = { id, ox: cx - n.x, oy: cy - n.y };
  document.addEventListener('mousemove', onNodeDragMove);
  document.addEventListener('mouseup', onNodeDragEnd);
}
function onNodeDragMove(e) {
  if (!flowDrag) return;
  const n = flowState.nodes.find(x => x.id === flowDrag.id); if (!n) return;
  const wrap = document.getElementById('flowCanvasWrap');
  const rect = wrap.getBoundingClientRect();
  n.x = Math.max(0, e.clientX - rect.left + wrap.scrollLeft - flowDrag.ox);
  n.y = Math.max(0, e.clientY - rect.top + wrap.scrollTop - flowDrag.oy);
  const el = document.getElementById('fn-' + n.id);
  if (el) { el.style.left = n.x + 'px'; el.style.top = n.y + 'px'; }
  renderFlowEdges();
}
function onNodeDragEnd() {
  flowDrag = null;
  document.removeEventListener('mousemove', onNodeDragMove);
  document.removeEventListener('mouseup', onNodeDragEnd);
}

// ── Save ──
async function saveFlow() {
  if (!flowState) return;
  const name = document.getElementById('flowName').value.trim();
  if (!name) { showToast('Dê um nome ao fluxo', 'error'); return; }
  const trigger = flowState.nodes.find(n => n.type === 'trigger');
  if (!trigger || !(trigger.data.keywords || '').trim()) { showToast('O gatilho precisa de ao menos uma palavra-chave', 'error'); return; }

  const payload = {
    name,
    account_id: document.getElementById('flowAccount').value || null,
    active: document.getElementById('flowActive').checked,
    definition: { nodes: flowState.nodes, edges: flowState.edges }
  };
  const btn = document.getElementById('flowSaveBtn');
  btn.disabled = true; btn.textContent = 'Salvando...';
  try {
    const url = flowState.id ? `/api/flows/${flowState.id}` : '/api/flows';
    const method = flowState.id ? 'PUT' : 'POST';
    const res = await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    const data = await res.json();
    if (!res.ok) { showToast(data.error || 'Erro ao salvar', 'error'); return; }
    flowState.id = data.id;
    showToast('Fluxo salvo!', 'success');
  } catch { showToast('Erro de conexão', 'error'); }
  finally { btn.disabled = false; btn.textContent = 'Salvar Fluxo'; }
}

// Cancel connection when clicking empty canvas
document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('flowCanvas')?.addEventListener('click', e => {
    if (e.target.id === 'flowCanvas' && flowConn) cancelConn();
  });
});

// ════════════════════════════════════════════════
// Audience (contacts) + Broadcast
// ════════════════════════════════════════════════
let contactsCache = {};

function populateContactFilters() {
  const acc = document.getElementById('contactAccFilter');
  if (acc && acc.options.length <= 1) {
    acc.innerHTML = '<option value="">Todas as contas</option>' + allAccounts.map(a => `<option value="${a.id}">@${escHtml(a.username)}</option>`).join('');
  }
}

async function loadContacts() {
  populateContactFilters();
  const q   = document.getElementById('contactSearch')?.value.trim() || '';
  const tag = document.getElementById('contactTagFilter')?.value || '';
  const acc = document.getElementById('contactAccFilter')?.value || '';
  const params = new URLSearchParams();
  if (q) params.set('q', q);
  if (tag) params.set('tag', tag);
  if (acc) params.set('account_id', acc);
  try {
    const { contacts } = await fetch(`/api/contacts?${params}`).then(r => r.json());
    contactsCache = {};
    contacts.forEach(c => contactsCache[c.id] = c);
    renderContactsList(contacts);
  } catch { showToast('Falha ao carregar audiência', 'error'); }
}

async function loadContactTags() {
  try {
    const tags = await fetch('/api/contacts/tags').then(r => r.json());
    const opts = '<option value="">Todas as tags</option>' + tags.map(t => `<option value="${escAttr(t)}">${escHtml(t)}</option>`).join('');
    const f = document.getElementById('contactTagFilter'); if (f) { const v = f.value; f.innerHTML = opts; f.value = v; }
    const bc = document.getElementById('bcTag'); if (bc) { const v = bc.value; bc.innerHTML = '<option value="">Toda a audiência</option>' + tags.map(t => `<option value="${escAttr(t)}">${escHtml(t)}</option>`).join(''); bc.value = v; }
  } catch {}
}

function renderContactsList(contacts) {
  const c = document.getElementById('contactsList');
  if (!contacts.length) {
    c.innerHTML = `<div class="empty-state">
      <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/></svg>
      <h3>Nenhum contato ainda</h3><p>Quem comentar ou te mandar DM aparece aqui automaticamente</p></div>`;
    return;
  }
  c.innerHTML = `<div class="contacts-table">${contacts.map(contactRow).join('')}</div>`;
}

function contactRow(c) {
  const initial = (c.username || '?')[0].toUpperCase();
  return `<div class="contact-row" id="ct-${c.id}">
    <div class="conv-avatar" style="width:36px;height:36px;font-size:14px">${escHtml(initial)}</div>
    <div class="contact-main">
      <div class="contact-name">@${escHtml(c.username || c.user_id)}
        ${c.window_open ? '<span class="window-tag ok" style="margin-left:6px">24h aberta</span>' : ''}
      </div>
      <div class="contact-meta">${c.source === 'comment' ? 'via comentário' : 'via DM'} · visto ${formatTime(c.last_seen)}${c.account_username ? ' · @' + escHtml(c.account_username) : ''}</div>
    </div>
    <div class="contact-tags" id="cttags-${c.id}">${renderTagChips(c)}</div>
    <input class="tag-add-input" placeholder="+ tag" onkeydown="if(event.key==='Enter'){addContactTag(${c.id}, this.value); this.value='';}" />
  </div>`;
}

function renderTagChips(c) {
  return (c.tags || []).map(t => `<span class="tag-chip">${escHtml(t)}<button onclick="removeContactTag(${c.id}, '${escAttr(t).replace(/'/g, "\\'")}')">✕</button></span>`).join('');
}

async function addContactTag(id, value) {
  const tag = (value || '').trim();
  if (!tag) return;
  const c = contactsCache[id]; if (!c) return;
  if (!c.tags) c.tags = [];
  if (c.tags.includes(tag)) return;
  c.tags.push(tag);
  await saveContactTags(id, c.tags);
  document.getElementById(`cttags-${id}`).innerHTML = renderTagChips(c);
  loadContactTags();
}

async function removeContactTag(id, tag) {
  const c = contactsCache[id]; if (!c) return;
  c.tags = (c.tags || []).filter(t => t !== tag);
  await saveContactTags(id, c.tags);
  document.getElementById(`cttags-${id}`).innerHTML = renderTagChips(c);
  loadContactTags();
}

async function saveContactTags(id, tags) {
  try { await fetch(`/api/contacts/${id}/tags`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ tags }) }); }
  catch { showToast('Erro ao salvar tag', 'error'); }
}

// ── Broadcast ──
function openBroadcast() {
  const acc = document.getElementById('bcAccount');
  acc.innerHTML = allAccounts.map(a => `<option value="${a.id}">@${escHtml(a.username)}</option>`).join('');
  if (!allAccounts.length) { showToast('Conecte uma conta primeiro', 'error'); return; }
  document.getElementById('bcText').value = '';
  document.getElementById('bcImage').value = '';
  loadContactTags();
  document.getElementById('broadcastModal').classList.remove('hidden');
  updateBroadcastPreview();
}
function closeBroadcast() { document.getElementById('broadcastModal').classList.add('hidden'); }

async function updateBroadcastPreview() {
  const acc = document.getElementById('bcAccount').value;
  const tag = document.getElementById('bcTag').value;
  const el = document.getElementById('bcPreview');
  if (!acc) { el.textContent = '—'; return; }
  const params = new URLSearchParams({ account_id: acc });
  if (tag) params.set('tag', tag);
  try {
    const d = await fetch(`/api/contacts/broadcast/preview?${params}`).then(r => r.json());
    el.innerHTML = `Segmento: <strong>${d.total}</strong> contato(s) · <strong style="color:var(--green)">${d.reachable}</strong> alcançável(is) na janela de 24h`;
  } catch { el.textContent = '—'; }
}

async function sendBroadcast() {
  const account_id = document.getElementById('bcAccount').value;
  const tag = document.getElementById('bcTag').value || null;
  const text = document.getElementById('bcText').value.trim();
  const image_url = document.getElementById('bcImage').value.trim();
  if (!account_id) { showToast('Escolha a conta', 'error'); return; }
  if (!text && !image_url) { showToast('Escreva uma mensagem', 'error'); return; }
  if (!confirm('Disparar para todos os contatos alcançáveis do segmento?')) return;

  const btn = document.getElementById('bcSendBtn');
  btn.disabled = true; btn.textContent = 'Enviando...';
  try {
    const res = await fetch('/api/contacts/broadcast', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ account_id, tag, text, image_url }) });
    const d = await res.json();
    if (!res.ok) { showToast(d.error || 'Erro no disparo', 'error'); return; }
    showToast(`Disparo concluído: ${d.sent} enviados, ${d.failed} falhas`, 'success');
    closeBroadcast();
  } catch { showToast('Erro de conexão', 'error'); }
  finally { btn.disabled = false; btn.textContent = 'Disparar'; }
}

document.getElementById('bcText')?.addEventListener('input', function() {
  const cnt = document.getElementById('bcCounter');
  if (cnt) cnt.textContent = `${this.value.length} / 2200`;
});

// ── Modal events ──
document.getElementById('ruleModal').addEventListener('click', e => { if (e.target === e.currentTarget) closeRuleModal(); });
document.getElementById('broadcastModal').addEventListener('click', e => { if (e.target === e.currentTarget) closeBroadcast(); });
document.getElementById('flowTemplatesModal')?.addEventListener('click', e => { if (e.target === e.currentTarget) closeFlowTemplates(); });

['ruleCommentReply','ruleKeywords','ruleFollowPrompt'].forEach(id =>
  document.getElementById(id)?.addEventListener('input', updateCharCounters)
);

// Show/hide follow-gate fields when toggle changes
document.getElementById('ruleRequireFollow')?.addEventListener('change', function() {
  toggleFollowGateFields(this.checked);
});
document.querySelector('[data-tab="settings"]').addEventListener('click', () => setTimeout(loadSettingsPage, 80));
document.querySelector('[data-tab="accounts"]').addEventListener('click', () => setTimeout(renderAccountsTab, 80));
