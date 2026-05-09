// --- State ---
let posts = [];
let config = {};
let stats = { scanned: 0, relevant: 0, approved: 0, skipped: 0 };
let schedulerStatus = {};
let redditAuth = { loggedIn: false, username: null };
let scanning = false;
let activeTab = 'queue';

// --- API helpers ---
async function api(path, opts = {}) {
  const res = await fetch(`/api${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...opts,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error || 'API error');
  }
  return res.json();
}

// --- Data fetching ---
async function loadStats() {
  stats = await api('/stats');
  document.getElementById('m-scanned').textContent = stats.scanned;
  document.getElementById('m-relevant').textContent = stats.relevant;
  document.getElementById('m-approved').textContent = stats.approved;
  document.getElementById('m-skipped').textContent = stats.skipped;
}

async function loadPosts() {
  const subFilter = document.getElementById('filter-sub').value;
  const scoreFilter = document.getElementById('filter-score').value;
  const params = new URLSearchParams();
  if (activeTab === 'approved') {
    params.set('status', 'approved');
  } else {
    // queue shows pending + skipped
  }
  if (subFilter !== 'all') params.set('subreddit', subFilter);
  if (scoreFilter !== 'all') params.set('score', scoreFilter);

  posts = await api(`/posts?${params}`);
  renderCurrentTab();
}

async function loadConfig() {
  config = await api('/config');
  renderConfigForm();
}

async function loadSchedulerStatus() {
  schedulerStatus = await api('/scheduler');
  renderSchedulerStatus();
}

async function loadRedditAuth() {
  redditAuth = await api('/reddit-auth');
  renderRedditAuth();
}

async function loginReddit() {
  const { url } = await api('/reddit-auth/url');
  window.location.href = url;
}

function renderRedditAuth() {
  // Top status bar
  const el = document.getElementById('reddit-auth-status');
  if (el) {
    if (redditAuth.loggedIn) {
      el.innerHTML = `<span class="dot"></span> Logged in as <strong>u/${esc(redditAuth.username)}</strong> — comments will auto-post on approve`;
    } else {
      el.innerHTML = `<span class="dot off"></span> Not logged in — <a href="#" onclick="loginReddit(); return false;" style="color:#2563eb;">Login to Reddit</a> to enable auto-posting`;
    }
  }

  // Settings card
  const statusEl = document.getElementById('reddit-login-status');
  const btnEl = document.getElementById('reddit-login-btn');
  if (statusEl) {
    if (redditAuth.loggedIn) {
      statusEl.innerHTML = `✅ Logged in as <strong>u/${esc(redditAuth.username)}</strong>. Approved comments will be auto-posted.`;
      if (btnEl) btnEl.style.display = 'none';
    } else {
      statusEl.textContent = 'Not connected. Login to enable auto-posting comments when you approve them.';
      if (btnEl) btnEl.style.display = '';
    }
  }
}

// --- Scan ---
async function startScan() {
  if (scanning) return;
  scanning = true;
  const btn = document.getElementById('scan-btn');
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span> Scanning...';

  try {
    const result = await api('/scan', { method: 'POST' });
    showToast(`Scan complete: ${result.postsFound} new posts found`);
    await Promise.all([loadPosts(), loadStats(), loadSchedulerStatus()]);
  } catch (err) {
    showToast('Scan failed: ' + err.message);
  } finally {
    scanning = false;
    btn.disabled = false;
    btn.innerHTML = '↻ Scan Reddit';
  }
}

// --- Post actions ---
async function draftComment(id) {
  const card = document.getElementById('card-' + id);
  if (card) {
    const actionsRight = card.querySelector('.post-actions-right');
    const draftBtn = actionsRight?.querySelector('[data-action="draft"]');
    if (draftBtn) { draftBtn.disabled = true; draftBtn.innerHTML = '<span class="spinner"></span> Drafting...'; }
  }

  try {
    const result = await api(`/posts/${encodeURIComponent(id)}/draft`, { method: 'POST' });
    const post = posts.find(p => p.id === id);
    if (post) post.drafted_comment = result.drafted_comment;
    renderCurrentTab();
    showToast('Comment drafted');
  } catch (err) {
    showToast('Draft failed: ' + err.message);
  }
}

async function scorePostAction(id) {
  try {
    const result = await api(`/posts/${encodeURIComponent(id)}/score`, { method: 'POST' });
    const post = posts.find(p => p.id === id);
    if (post) { post.score = result.score; post.score_reason = result.reason; }
    renderCurrentTab();
    showToast(`Scored: ${result.score}`);
  } catch (err) {
    showToast('Scoring failed: ' + err.message);
  }
}

async function updatePostStatus(id, status) {
  // Show posting indicator for approve action
  if (status === 'approved') {
    const card = document.getElementById('card-' + CSS.escape(id));
    if (card) {
      const approveBtn = card.querySelector('[data-action="approve"]');
      if (approveBtn) { approveBtn.disabled = true; approveBtn.innerHTML = '<span class="spinner"></span> Posting...'; }
    }
  }

  try {
    const result = await api(`/posts/${encodeURIComponent(id)}`, { method: 'PATCH', body: { status } });
    const post = posts.find(p => p.id === id);
    if (post) post.status = status;
    await loadStats();
    renderCurrentTab();
    if (result.posted) {
      showToast('Comment approved and posted to Reddit!');
    } else if (result.post_warning) {
      showToast(result.post_warning);
    } else {
      showToast(`Status: ${status}`);
    }
  } catch (err) {
    showToast('Update failed: ' + err.message);
    await loadPosts(); // reload to get reverted status
  }
}

async function saveComment(id) {
  const ta = document.getElementById('ta-' + CSS.escape(id));
  if (!ta) return;
  try {
    await api(`/posts/${encodeURIComponent(id)}`, { method: 'PATCH', body: { drafted_comment: ta.value } });
    showToast('Comment saved');
  } catch (err) {
    showToast('Save failed: ' + err.message);
  }
}

function copyComment(id) {
  const post = posts.find(p => p.id === id);
  if (post && post.drafted_comment) {
    navigator.clipboard.writeText(post.drafted_comment).catch(() => {});
    showToast('Copied to clipboard');
  }
}

// --- Config ---
async function saveConfig() {
  const subreddits = Array.from(document.getElementById('sub-tags').querySelectorAll('.tag'))
    .map(t => t.dataset.sub);

  const body = {
    subreddits: JSON.stringify(subreddits),
    product_url: document.getElementById('cfg-url').value,
    product_desc: document.getElementById('cfg-desc').value,
    comment_style: document.getElementById('cfg-style').value,
    scan_interval: document.getElementById('cfg-interval').value,
    max_post_age_hours: document.getElementById('cfg-age').value,
  };

  try {
    config = await api('/config', { method: 'PUT', body });
    showToast('Settings saved');
    renderSubredditFilter();
    await loadSchedulerStatus();
  } catch (err) {
    showToast('Save failed: ' + err.message);
  }
}

function addSub() {
  const inp = document.getElementById('new-sub');
  const val = inp.value.trim().replace(/^r\//, '');
  if (!val) return;
  const subs = JSON.parse(config.subreddits || '[]');
  if (!subs.includes(val)) {
    subs.push(val);
    config.subreddits = JSON.stringify(subs);
    renderConfigForm();
  }
  inp.value = '';
}

function removeSub(sub) {
  const subs = JSON.parse(config.subreddits || '[]').filter(s => s !== sub);
  config.subreddits = JSON.stringify(subs);
  renderConfigForm();
}

// --- Rendering ---
function switchTab(name) {
  activeTab = name;
  document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
  document.querySelector(`[data-tab="${name}"]`).classList.add('active');

  document.getElementById('tab-queue').style.display = name === 'queue' ? 'block' : 'none';
  document.getElementById('tab-approved').style.display = name === 'approved' ? 'block' : 'none';
  document.getElementById('tab-config').style.display = name === 'config' ? 'block' : 'none';
  document.getElementById('tab-history').style.display = name === 'history' ? 'block' : 'none';

  if (name === 'queue' || name === 'approved') loadPosts();
  if (name === 'history') loadScanLog();
}

function renderCurrentTab() {
  if (activeTab === 'queue') renderQueue();
  else if (activeTab === 'approved') renderApproved();
}

function renderQueue() {
  const list = document.getElementById('post-list');
  const filtered = posts.filter(p => p.status !== 'approved');

  if (!filtered.length) {
    list.innerHTML = '<div class="empty">No posts yet. Hit "Scan Reddit" to find leads.</div>';
    return;
  }

  list.innerHTML = filtered.map(renderPostCard).join('');
}

function renderApproved() {
  const list = document.getElementById('approved-list');
  const approved = posts.filter(p => p.status === 'approved');

  if (!approved.length) {
    list.innerHTML = '<div class="empty">No approved comments yet.</div>';
    return;
  }

  list.innerHTML = approved.map(p => `
    <div class="post-card approved">
      <div class="post-top">
        <div class="post-meta">
          <div class="post-subreddit">${esc(p.subreddit)}</div>
          <div class="post-title"><a href="${esc(p.url)}" target="_blank">${esc(p.title)}</a></div>
        </div>
        <span class="score-badge score-high">approved</span>
      </div>
      <div class="comment-box">
        <div class="comment-label">✓ Posted to Reddit</div>
        <div style="white-space:pre-wrap;">${esc(p.drafted_comment)}</div>
      </div>
      <div class="post-actions">
        <div class="post-actions-right">
          <button class="btn" onclick="copyComment('${escAttr(p.id)}')">📋 Copy</button>
          <a class="btn" href="${esc(p.url)}" target="_blank">↗ Open on Reddit</a>
        </div>
      </div>
    </div>
  `).join('');
}

function renderPostCard(p) {
  const hasComment = p.drafted_comment && p.drafted_comment.length > 0;
  const scoreClass = p.score === 'high' ? 'score-high' : p.score === 'med' ? 'score-med' : p.score === 'low' ? 'score-low' : 'score-pending';
  const scoreLabel = p.score === 'high' ? 'High fit' : p.score === 'med' ? 'Medium fit' : p.score === 'low' ? 'Low fit' : 'Unscored';

  return `<div class="post-card ${p.status}" id="card-${CSS.escape(p.id)}">
    <div class="post-top">
      <div class="post-meta">
        <div class="post-subreddit">${esc(p.subreddit)}</div>
        <div class="post-title"><a href="${esc(p.url)}" target="_blank">${esc(p.title)}</a></div>
        <div class="post-stats">
          <span>▲ ${p.upvotes}</span>
          <span>💬 ${p.comments_count} comments</span>
          ${p.score_reason ? `<span title="${escAttr(p.score_reason)}">ℹ️ ${esc(p.score_reason.slice(0, 50))}</span>` : ''}
        </div>
      </div>
      <span class="score-badge ${scoreClass}">${scoreLabel}</span>
    </div>
    ${hasComment ? `
    <div class="comment-box">
      <div class="comment-label">🤖 Drafted comment</div>
      <textarea id="ta-${CSS.escape(p.id)}" onchange="saveComment('${escAttr(p.id)}')">${esc(p.drafted_comment)}</textarea>
    </div>` : ''}
    <div class="post-actions">
      <span class="status-tag status-${p.status}">${p.status}</span>
      <div class="post-actions-right">
        ${p.score === 'pending' ? `<button class="btn" onclick="scorePostAction('${escAttr(p.id)}')">🎯 Score</button>` : ''}
        ${!hasComment ? `<button class="btn" data-action="draft" onclick="draftComment('${escAttr(p.id)}')">🤖 Draft comment</button>` : ''}
        ${hasComment && p.status === 'pending' ? `
          <button class="btn" onclick="copyComment('${escAttr(p.id)}')">📋 Copy</button>
          <button class="btn" onclick="updatePostStatus('${escAttr(p.id)}', 'skipped')">✕ Skip</button>
          <button class="btn primary" data-action="approve" onclick="updatePostStatus('${escAttr(p.id)}', 'approved')">✓ Approve & Post</button>
        ` : ''}
        ${p.status === 'skipped' ? `<button class="btn" onclick="updatePostStatus('${escAttr(p.id)}', 'pending')">Restore</button>` : ''}
      </div>
    </div>
  </div>`;
}

function renderConfigForm() {
  const subs = JSON.parse(config.subreddits || '[]');
  document.getElementById('sub-tags').innerHTML = subs.map(s =>
    `<div class="tag" data-sub="${escAttr(s)}" onclick="removeSub('${escAttr(s)}')">r/${esc(s)} ✕</div>`
  ).join('');
  document.getElementById('cfg-url').value = config.product_url || '';
  document.getElementById('cfg-desc').value = config.product_desc || '';
  document.getElementById('cfg-style').value = config.comment_style || '';
  document.getElementById('cfg-interval').value = config.scan_interval || '0 */2 * * *';
  document.getElementById('cfg-age').value = config.max_post_age_hours || '48';
  renderSubredditFilter();
}

function renderSubredditFilter() {
  const subs = JSON.parse(config.subreddits || '[]');
  const sel = document.getElementById('filter-sub');
  const cur = sel.value;
  sel.innerHTML = '<option value="all">All subreddits</option>' +
    subs.map(s => `<option value="r/${esc(s)}" ${cur === 'r/' + s ? 'selected' : ''}>r/${esc(s)}</option>`).join('');
}

function renderSchedulerStatus() {
  const el = document.getElementById('scheduler-status');
  if (!el) return;
  const s = schedulerStatus;
  el.innerHTML = `
    <span class="dot ${s.scheduled ? '' : 'off'}"></span>
    <span>${s.scheduled ? 'Scheduler active' : 'Scheduler off'}</span>
    <span>Interval: ${s.interval || 'N/A'}</span>
    ${s.lastRun ? `<span>Last: ${new Date(s.lastRun).toLocaleString()}</span>` : ''}
    ${s.running ? '<span class="spinner"></span> Running...' : ''}
  `;
}

async function loadScanLog() {
  const logs = await api('/scan-log');
  const el = document.getElementById('scan-log-list');
  if (!logs.length) {
    el.innerHTML = '<div class="empty">No scans yet.</div>';
    return;
  }
  el.innerHTML = `<table class="scan-log-table">
    <thead><tr><th>Time</th><th>Posts found</th><th>Subreddits</th><th>Duration</th></tr></thead>
    <tbody>${logs.map(l => {
      const dur = l.finished_at && l.started_at
        ? Math.round((new Date(l.finished_at) - new Date(l.started_at)) / 1000) + 's'
        : '—';
      return `<tr>
        <td>${new Date(l.started_at).toLocaleString()}</td>
        <td>${l.posts_found}</td>
        <td>${l.subreddits_scanned}</td>
        <td>${dur}</td>
      </tr>`;
    }).join('')}</tbody>
  </table>`;
}

// --- Helpers ---
function esc(s) {
  if (!s) return '';
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function escAttr(s) {
  return esc(s).replace(/'/g, '&#39;');
}

function showToast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), 2500);
}

// --- Init ---
async function init() {
  await Promise.all([loadStats(), loadConfig(), loadSchedulerStatus(), loadRedditAuth()]);
  await loadPosts();

  // Show auth success toast
  if (new URLSearchParams(window.location.search).get('auth') === 'success') {
    showToast('Reddit login successful!');
    history.replaceState(null, '', '/');
  }

  // Auto-refresh stats every 30s
  setInterval(loadStats, 30000);
  setInterval(loadSchedulerStatus, 30000);
}

init();
