'use strict';

/* ===== STATE ===== */
let currentSessionId = null;
let examMode = 'deep';
let selectedImages = [];
let vaultPending = null;
let sessions = [];
let vaultTagFilter = 'all';
let vaultDetailItem = null;

let pomodoroTimer = null;
let pomodoroSeconds = 25 * 60;
let pomodoroMode = 'focus';
let pomodoroRunning = false;
let pomodoroSessions = 0;
const POMODORO_DURATIONS = { focus: 25 * 60, short: 5 * 60, long: 15 * 60 };

let totalPoints = 0;
let dailyDoubts = 0;
const DAILY_GOAL = 5;

let voiceRecognition = null;
let isListening = false;

/* ===== BOOT ===== */
document.addEventListener('DOMContentLoaded', async () => {
  await Promise.all([loadSessions(), loadStats()]);
  if (sessions.length > 0) {
    await loadSession(sessions[0].id);
  }
  initStreak();
  initPomodoro();
  initVoice();
});

/* ===== STATS ===== */
async function loadStats() {
  try {
    const res = await fetch('/d/stats');
    const data = await res.json();
    totalPoints = data.total_points || 0;
    dailyDoubts = data.daily_doubts || 0;
    renderStats();
  } catch { /* silent */ }
}

function renderStats() {
  const ptsEl = document.getElementById('hdr-points');
  const goalEl = document.getElementById('hdr-goal');
  if (ptsEl) ptsEl.textContent = totalPoints;
  if (goalEl) {
    const pct = Math.min(100, (dailyDoubts / DAILY_GOAL) * 100);
    goalEl.style.width = pct + '%';
    document.getElementById('hdr-goal-text').textContent = `${dailyDoubts}/${DAILY_GOAL} today`;
  }
}

function showPointsToast(pts) {
  const el = document.getElementById('points-burst');
  if (!el) return;
  el.textContent = `+${pts} Points!`;
  el.classList.add('show');
  setTimeout(() => el.classList.remove('show'), 2400);
}

/* ===== STREAK ===== */
function initStreak() {
  const data = JSON.parse(localStorage.getItem('doubtly_streak') || '{"streak":0,"lastDate":""}');
  renderStreak(data.streak);
  // Sync to backend
  if (data.streak > 0) {
    fetch('/d/stats/streak', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ streak: data.streak })
    }).catch(() => {});
  }
}

function bumpStreak() {
  const today = new Date().toISOString().slice(0, 10);
  const data = JSON.parse(localStorage.getItem('doubtly_streak') || '{"streak":0,"lastDate":""}');
  if (data.lastDate === today) return;
  const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
  data.streak = (data.lastDate === yesterday) ? data.streak + 1 : 1;
  data.lastDate = today;
  localStorage.setItem('doubtly_streak', JSON.stringify(data));
  renderStreak(data.streak);
  fetch('/d/stats/streak', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ streak: data.streak })
  }).catch(() => {});
}

function renderStreak(streak) {
  const el = document.getElementById('hdr-streak');
  const sideEl = document.getElementById('streak-display');
  const sideLabel = document.getElementById('streak-label');
  if (el) el.textContent = streak > 0 ? `Day ${streak}` : 'Day 0';
  if (sideEl && sideLabel) {
    if (streak >= 1) {
      sideLabel.textContent = `Day ${streak}`;
      sideEl.style.display = 'flex';
    } else {
      sideEl.style.display = 'none';
    }
  }
}

/* ===== VOICE TO TEXT ===== */
function initVoice() {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  const micBtn = document.getElementById('mic-btn');
  if (!SR || !micBtn) {
    if (micBtn) micBtn.style.display = 'none';
    return;
  }
  voiceRecognition = new SR();
  voiceRecognition.continuous = false;
  voiceRecognition.interimResults = true;
  voiceRecognition.lang = 'en-US';
  voiceRecognition.maxAlternatives = 1;

  voiceRecognition.onstart = () => {
    isListening = true;
    micBtn.classList.add('listening');
  };

  voiceRecognition.onresult = (e) => {
    const transcript = Array.from(e.results).map(r => r[0].transcript).join('');
    const input = document.getElementById('msg-input');
    input.value = transcript;
    resizeInput(input);
  };

  voiceRecognition.onend = () => {
    isListening = false;
    micBtn.classList.remove('listening');
  };

  voiceRecognition.onerror = (e) => {
    isListening = false;
    micBtn.classList.remove('listening');
    if (e.error === 'not-allowed') showToast('Microphone permission denied');
    else if (e.error === 'no-speech') showToast('No speech detected — try again');
  };
}

function toggleVoice() {
  if (!voiceRecognition) { showToast('Voice input not supported in this browser'); return; }
  if (isListening) {
    voiceRecognition.stop();
  } else {
    try {
      voiceRecognition.start();
    } catch (e) {
      showToast('Could not start voice input');
    }
  }
}

/* ===== SESSIONS ===== */
async function loadSessions() {
  try {
    const res = await fetch('/d/sessions');
    if (!res.ok) throw new Error('Server error ' + res.status);
    sessions = await res.json();
    renderSessionList();
  } catch (e) {
    console.error('loadSessions failed:', e);
  }
}

function renderSessionList() {
  const el = document.getElementById('sessions-list');
  if (!sessions.length) {
    el.innerHTML = `<div class="empty-sidebar">
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
      No chats yet.<br>Start a new conversation.
    </div>`;
    return;
  }
  el.innerHTML = sessions.map(s => `
    <div class="session-item ${s.id === currentSessionId ? 'active' : ''}" onclick="loadSession(${s.id})">
      <div class="session-info">
        <div class="session-title">${esc(s.title)}</div>
        <div class="session-date">${relativeTime(s.updated_at)}</div>
      </div>
      <button class="session-del" onclick="deleteSession(event,${s.id})">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4h6v2"/></svg>
      </button>
    </div>`).join('');
}

async function newChat() {
  try {
    const res = await fetch('/d/sessions', { method: 'POST' });
    const s = await res.json();
    sessions.unshift(s);
    await loadSession(s.id);
    closeSidebar();
  } catch { showToast('Failed to create chat'); }
}

async function loadSession(id) {
  currentSessionId = id;
  renderSessionList();
  clearMessages();
  try {
    const res = await fetch(`/d/sessions/${id}/messages`);
    if (!res.ok) throw new Error('');
    const msgs = await res.json();
    const empty = document.getElementById('empty-state');
    if (msgs.length && empty) empty.remove();
    msgs.forEach(m => {
      if (m.role === 'user') appendUser(m.content, m.images || []);
      else appendAI(m.content, false);
    });
    scrollBottom();
  } catch { /* silent */ }
  closeSidebar();
}

async function deleteSession(e, id) {
  e.stopPropagation();
  try {
    await fetch(`/d/sessions/${id}`, { method: 'DELETE' });
    sessions = sessions.filter(s => s.id !== id);
    if (currentSessionId === id) {
      currentSessionId = null;
      clearMessages();
      showEmptyState();
    }
    renderSessionList();
  } catch { showToast('Failed to delete'); }
}

function clearMessages() {
  document.getElementById('messages').innerHTML = '';
}

function showEmptyState() {
  document.getElementById('messages').innerHTML = `
    <div id="empty-state" class="empty-state">
      <div class="empty-icon">
        <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>
      </div>
      <h2>How can I help you study?</h2>
      <p>Ask any question — formulas, concepts, theory, problems.</p>
      <div class="suggestions">
        <button class="suggestion-chip" onclick="useSuggestion(this)">Explain Newton's laws of motion</button>
        <button class="suggestion-chip" onclick="useSuggestion(this)">What is the quadratic formula?</button>
        <button class="suggestion-chip" onclick="useSuggestion(this)">Explain photosynthesis step by step</button>
        <button class="suggestion-chip" onclick="useSuggestion(this)">How does compound interest work?</button>
      </div>
    </div>`;
}

function useSuggestion(btn) {
  document.getElementById('msg-input').value = btn.textContent;
  sendMessage();
}

/* ===== MODE ===== */
function toggleMode() {
  examMode = examMode === 'deep' ? 'speed' : 'deep';
  const knob = document.getElementById('mode-knob');
  const lblDeep = document.getElementById('mode-lbl-deep');
  const lblSpeed = document.getElementById('mode-lbl-speed');
  const bar = document.getElementById('mode-bar-text');
  if (examMode === 'speed') {
    knob.classList.add('speed');
    lblDeep.classList.add('inactive');
    lblSpeed.classList.add('active');
    if (bar) bar.textContent = 'Speed Mode — Fast, exam-ready answers';
  } else {
    knob.classList.remove('speed');
    lblDeep.classList.remove('inactive');
    lblSpeed.classList.remove('active');
    if (bar) bar.textContent = 'Deep Mode — Socratic explanations';
  }
}

/* ===== IMAGE UPLOAD ===== */
function triggerUpload() {
  if (selectedImages.length >= 4) { showToast('Max 4 images per message'); return; }
  document.getElementById('file-input').click();
}
async function handleFiles(e) {
  const files = Array.from(e.target.files).slice(0, 4 - selectedImages.length);
  for (const f of files) selectedImages.push(await toDataURL(f));
  e.target.value = '';
  renderThumbs();
}
function toDataURL(f) {
  return new Promise(res => {
    const r = new FileReader();
    r.onload = ev => res(ev.target.result);
    r.readAsDataURL(f);
  });
}
function renderThumbs() {
  const bar = document.getElementById('image-bar');
  const tc = document.getElementById('image-thumbs');
  if (!selectedImages.length) { bar.classList.add('hidden'); tc.innerHTML = ''; return; }
  bar.classList.remove('hidden');
  tc.innerHTML = selectedImages.map((src, i) => `
    <div class="thumb-wrap">
      <img src="${src}" class="thumb-img" />
      <button class="thumb-rm" onclick="removeImg(${i})">
        <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
      </button>
    </div>`).join('');
}
function removeImg(i) { selectedImages.splice(i, 1); renderThumbs(); }

/* ===== SEND MESSAGE (STREAMING) ===== */
async function sendMessage() {
  const input = document.getElementById('msg-input');
  const text = input.value.trim();
  if (!text) return;

  if (isListening && voiceRecognition) voiceRecognition.stop();

  if (!currentSessionId) {
    try {
      const res = await fetch('/d/sessions', { method: 'POST' });
      const s = await res.json();
      sessions.unshift(s);
      currentSessionId = s.id;
      renderSessionList();
    } catch { showToast('Error creating session'); return; }
  }

  const imgs = [...selectedImages];
  selectedImages = [];
  renderThumbs();
  input.value = '';
  resizeInput(input);

  const empty = document.getElementById('empty-state');
  if (empty) empty.remove();

  appendUser(text, imgs);
  const typingId = appendTyping();
  setSendDisabled(true);
  scrollBottom();

  try {
    const response = await fetch('/d/chat/stream', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ session_id: currentSessionId, message: text, images: imgs, exam_mode: examMode })
    });

    if (!response.ok) {
      removeTyping(typingId);
      appendError('Server error ' + response.status);
      setSendDisabled(false);
      return;
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let aiRow = null;
    let bubbleEl = null;
    let rawText = '';
    let firstChunk = true;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      const lines = buffer.split('\n');
      buffer = lines.pop();

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        let parsed;
        try { parsed = JSON.parse(line.slice(6)); } catch { continue; }

        if (parsed.error) {
          removeTyping(typingId);
          appendError(parsed.error);
          setSendDisabled(false);
          return;
        }

        if (parsed.text) {
          if (firstChunk) {
            removeTyping(typingId);
            ({ row: aiRow, bubble: bubbleEl } = appendAIStreaming(text));
            firstChunk = false;
          }
          rawText += parsed.text;
          bubbleEl.innerHTML = formatMd(rawText) + '<span class="stream-cursor"></span>';
          scrollBottom();
        }

        if (parsed.done) {
          if (bubbleEl) {
            bubbleEl.innerHTML = formatMd(parsed.full_text || rawText);
            addAIActions(aiRow, text, parsed.full_text || rawText);
          }
          if (parsed.title_updated && parsed.session) {
            const idx = sessions.findIndex(s => s.id === currentSessionId);
            if (idx !== -1) sessions[idx] = parsed.session;
            renderSessionList();
          }
          bumpStreak();
          // Update smart points
          if (parsed.points_earned > 0) {
            totalPoints = parsed.total_points;
            dailyDoubts = parsed.daily_doubts;
            renderStats();
            setTimeout(() => showPointsToast(parsed.points_earned), 400);
          } else {
            dailyDoubts = parsed.daily_doubts || dailyDoubts;
            if (parsed.total_points !== undefined) totalPoints = parsed.total_points;
            renderStats();
          }
        }
      }
    }
  } catch {
    removeTyping(typingId);
    appendError('Network error. Check your connection and try again.');
  }

  setSendDisabled(false);
  scrollBottom();
}

/* ===== MESSAGE RENDERING ===== */
function appendUser(text, images) {
  const c = document.getElementById('messages');
  const row = document.createElement('div');
  row.className = 'msg-row user';
  let imgs = '';
  if (images && images.length) {
    imgs = `<div class="bubble-images">${images.map(s => `<img src="${s}" class="bubble-img"/>`).join('')}</div>`;
  }
  row.innerHTML = `<div class="bubble user">${imgs}${esc(text)}</div>`;
  c.appendChild(row);
}

function appendAI(text, showActions, question) {
  const c = document.getElementById('messages');
  const row = document.createElement('div');
  row.className = 'msg-row assistant';
  if (question) row.setAttribute('data-question', question);
  row.setAttribute('data-answer', text);
  row.innerHTML = `<div class="bubble assistant">${formatMd(text)}</div>`;
  if (showActions) addAIActions(row, question, text);
  c.appendChild(row);
  return row;
}

function appendAIStreaming(question) {
  const c = document.getElementById('messages');
  const row = document.createElement('div');
  row.className = 'msg-row assistant';
  row.setAttribute('data-question', question || '');
  const bubble = document.createElement('div');
  bubble.className = 'bubble assistant';
  bubble.innerHTML = '<span class="stream-cursor"></span>';
  row.appendChild(bubble);
  c.appendChild(row);
  return { row, bubble };
}

function addAIActions(row, question, answer) {
  row.setAttribute('data-question', question || '');
  row.setAttribute('data-answer', answer || '');
  const existing = row.querySelector('.ai-actions');
  if (existing) existing.remove();
  const actions = document.createElement('div');
  actions.className = 'ai-actions';
  actions.innerHTML = `
    <button class="action-btn" onclick="openVaultModal(this)">
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>
      Save
    </button>
    <button class="action-btn" onclick="copyAIResponse(this)">
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
      Copy
    </button>`;
  row.appendChild(actions);
}

function copyAIResponse(btn) {
  const row = btn.closest('.msg-row');
  const text = row.getAttribute('data-answer') || '';
  if (!navigator.clipboard) { showToast('Clipboard not available'); return; }
  navigator.clipboard.writeText(text).then(() => {
    const orig = btn.innerHTML;
    btn.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg> Copied!`;
    btn.classList.add('saved');
    showToast('Answer copied to clipboard');
    setTimeout(() => { btn.innerHTML = orig; btn.classList.remove('saved'); }, 2200);
  }).catch(() => showToast('Copy failed'));
}

function appendTyping() {
  const c = document.getElementById('messages');
  const row = document.createElement('div');
  row.className = 'msg-row assistant';
  const id = 'typing-' + Date.now();
  row.id = id;
  row.innerHTML = `<div class="bubble assistant"><div class="typing-indicator"><div class="t-dot"></div><div class="t-dot"></div><div class="t-dot"></div></div></div>`;
  c.appendChild(row);
  return id;
}
function removeTyping(id) { document.getElementById(id)?.remove(); }

function appendError(msg) {
  const c = document.getElementById('messages');
  const row = document.createElement('div');
  row.className = 'msg-row assistant';
  row.innerHTML = `<div class="error-bubble"><strong>Error:</strong> ${esc(msg)}</div>`;
  c.appendChild(row);
}

/* ===== VAULT SAVE MODAL ===== */
function openVaultModal(btn) {
  const row = btn.closest('.msg-row');
  const question = row.getAttribute('data-question') || '';
  const answer = row.getAttribute('data-answer') || '';
  vaultPending = { question, answer, btn };
  document.getElementById('modal-q').textContent = question;
  document.getElementById('modal-a').textContent = answer;
  document.querySelectorAll('.vault-tag-chip').forEach(c => c.classList.remove('selected'));
  document.getElementById('vault-modal').classList.remove('hidden');
}
function closeVaultModal() {
  document.getElementById('vault-modal').classList.add('hidden');
  vaultPending = null;
}
function selectVaultTag(chip) {
  document.querySelectorAll('.vault-tag-chip').forEach(c => c.classList.remove('selected'));
  chip.classList.toggle('selected');
}
async function confirmSave() {
  if (!vaultPending) return;
  const { question, answer, btn } = vaultPending;
  const selectedChip = document.querySelector('.vault-tag-chip.selected');
  const tag = selectedChip ? selectedChip.dataset.tag : null;
  closeVaultModal();
  try {
    const res = await fetch('/d/vault', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ session_id: currentSessionId, user_question: question, ai_response: answer, tag })
    });
    if (res.ok) {
      btn.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg> Saved`;
      btn.classList.add('saved');
      showToast('Saved to Revision Vault');
      loadVault();
    }
  } catch { showToast('Failed to save'); }
}

/* ===== VAULT LIST ===== */
async function loadVault() {
  try {
    const url = vaultTagFilter && vaultTagFilter !== 'all'
      ? `/d/vault?tag=${encodeURIComponent(vaultTagFilter)}` : '/d/vault';
    const res = await fetch(url);
    renderVault(await res.json());
  } catch { /* silent */ }
}

function setVaultFilter(tag) {
  vaultTagFilter = tag;
  document.querySelectorAll('.vault-filter-chip').forEach(c => c.classList.toggle('active', c.dataset.tag === tag));
  loadVault();
}

function renderVault(items) {
  const el = document.getElementById('vault-list');
  if (!items.length) {
    el.innerHTML = `<div class="empty-sidebar">
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>
      No saved items${vaultTagFilter !== 'all' ? ' with this tag' : ''}.<br>
      ${vaultTagFilter === 'all' ? 'Tap "Save" on any AI answer.' : ''}
    </div>`;
    return;
  }
  el.innerHTML = items.map(v => `
    <div class="vault-card" id="vc-${v.id}" onclick="openVaultDetail(${v.id})">
      ${v.tag ? `<span class="vault-tag-badge">${esc(v.tag)}</span>` : ''}
      <div class="vault-card-q">${esc(v.user_question)}</div>
      <div class="vault-card-a">${esc(v.ai_response.slice(0, 150))}${v.ai_response.length > 150 ? '…' : ''}</div>
      <div class="vault-card-footer">
        <span class="vault-card-date">${relativeTime(v.created_at)}</span>
        <button class="vault-del-btn" onclick="deleteVaultItem(event,${v.id})">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/></svg>
        </button>
      </div>
    </div>`).join('');
}

async function deleteVaultItem(e, id) {
  e.stopPropagation();
  try {
    await fetch(`/d/vault/${id}`, { method: 'DELETE' });
    document.getElementById(`vc-${id}`)?.remove();
    if (!document.querySelectorAll('.vault-card').length) loadVault();
    showToast('Removed from Vault');
  } catch { showToast('Failed to remove'); }
}

/* ===== VAULT DETAIL ===== */
async function openVaultDetail(id) {
  try {
    const res = await fetch('/d/vault');
    const item = (await res.json()).find(v => v.id === id);
    if (!item) return;
    vaultDetailItem = item;
    renderVaultDetail(item, true);
    document.getElementById('vault-detail-modal').classList.remove('hidden');
  } catch { showToast('Failed to load item'); }
}

function renderVaultDetail(item, hideAnswer) {
  document.getElementById('vd-question').textContent = item.user_question;
  const answerBlock = document.getElementById('vd-answer-block');
  const revealBtn = document.getElementById('vd-reveal-btn');
  if (hideAnswer) {
    answerBlock.classList.add('hidden');
    revealBtn.classList.remove('hidden');
  } else {
    answerBlock.innerHTML = formatMd(item.ai_response);
    answerBlock.classList.remove('hidden');
    revealBtn.classList.add('hidden');
  }
  document.querySelectorAll('.vd-tag-chip').forEach(c => c.classList.toggle('selected', c.dataset.tag === item.tag));
  document.getElementById('vd-note').value = item.personal_note || '';
}

function revealAnswer() {
  if (!vaultDetailItem) return;
  document.getElementById('vd-answer-block').innerHTML = formatMd(vaultDetailItem.ai_response);
  document.getElementById('vd-answer-block').classList.remove('hidden');
  document.getElementById('vd-reveal-btn').classList.add('hidden');
}

function selectVdTag(chip) {
  document.querySelectorAll('.vd-tag-chip').forEach(c => c.classList.remove('selected'));
  chip.classList.toggle('selected', chip.dataset.tag !== vaultDetailItem?.tag);
}

async function saveVaultDetail() {
  if (!vaultDetailItem) return;
  const tag = document.querySelector('.vd-tag-chip.selected')?.dataset.tag || null;
  const personal_note = document.getElementById('vd-note').value;
  try {
    const updated = await (await fetch(`/d/vault/${vaultDetailItem.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tag, personal_note })
    })).json();
    vaultDetailItem = updated;
    showToast('Study card updated');
    loadVault();
  } catch { showToast('Failed to save'); }
}

async function deleteVaultDetail() {
  if (!vaultDetailItem) return;
  await fetch(`/d/vault/${vaultDetailItem.id}`, { method: 'DELETE' });
  closeVaultDetail();
  loadVault();
  showToast('Removed from Vault');
}

function closeVaultDetail() {
  document.getElementById('vault-detail-modal').classList.add('hidden');
  vaultDetailItem = null;
}

/* ===== PRINT/EXPORT VAULT ===== */
async function printVault() {
  try {
    const res = await fetch('/d/vault');
    const items = await res.json();
    if (!items.length) { showToast('No saved items to export'); return; }
    const html = buildPrintHTML(items);
    const w = window.open('', '_blank');
    if (!w) { showToast('Allow pop-ups to export'); return; }
    w.document.write(html);
    w.document.close();
    setTimeout(() => w.print(), 400);
  } catch { showToast('Export failed'); }
}

function buildPrintHTML(items) {
  const date = new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Revision Vault — Doubtly AI</title>
<style>
  body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif;padding:28px 32px;color:#1a1a1a;max-width:800px;margin:0 auto}
  h1{font-size:22px;font-weight:700;color:#10a37f;border-bottom:2px solid #10a37f;padding-bottom:8px;margin-bottom:4px}
  .meta{font-size:12px;color:#888;margin-bottom:24px}
  .card{border:1px solid #ddd;border-radius:10px;padding:16px 18px;margin-bottom:16px;page-break-inside:avoid}
  .tag{display:inline-block;font-size:9px;font-weight:700;text-transform:uppercase;letter-spacing:0.5px;background:#e6f5f0;color:#10a37f;padding:3px 8px;border-radius:4px;margin-bottom:8px}
  .q{font-size:14px;font-weight:700;color:#1a1a1a;margin-bottom:10px;line-height:1.4}
  .a{font-size:13px;color:#333;line-height:1.65;white-space:pre-wrap}
  .a strong{font-weight:700}
  .note{background:#f5faf8;border-left:3px solid #10a37f;padding:8px 12px;margin-top:10px;font-size:12px;color:#555;font-style:italic;border-radius:0 6px 6px 0}
  .note-lbl{font-weight:700;font-style:normal;color:#10a37f}
  .footer{margin-top:32px;text-align:center;font-size:11px;color:#bbb}
  @media print{body{padding:14px}}
</style></head><body>
  <h1>Revision Vault</h1>
  <div class="meta">Doubtly AI — Exported ${date} &nbsp;·&nbsp; ${items.length} study card${items.length !== 1 ? 's' : ''}</div>
  ${items.map((v, i) => `
  <div class="card">
    ${v.tag ? `<div class="tag">${v.tag}</div>` : ''}
    <div class="q">Q${i + 1}. ${v.user_question}</div>
    <div class="a">${v.ai_response.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>').replace(/\n/g, '\n')}</div>
    ${v.personal_note ? `<div class="note"><span class="note-lbl">My Notes: </span>${v.personal_note}</div>` : ''}
  </div>`).join('')}
  <div class="footer">Generated by Doubtly AI — Your Socratic Exam Tutor</div>
</body></html>`;
}

/* ===== SIDEBAR ===== */
function openSidebar() {
  document.getElementById('sidebar').classList.add('open');
  document.getElementById('sidebar-overlay').classList.add('open');
  loadVault();
}
function closeSidebar() {
  document.getElementById('sidebar').classList.remove('open');
  document.getElementById('sidebar-overlay').classList.remove('open');
}
function switchTab(tab) {
  ['chats', 'vault', 'formulas'].forEach(t => {
    document.getElementById('tab-' + t)?.classList.toggle('active', t === tab);
    document.getElementById('panel-' + t)?.classList.toggle('hidden', t !== tab);
  });
  if (tab === 'vault') loadVault();
}

/* ===== POMODORO ===== */
function initPomodoro() { renderPomodoroTime(); }

function togglePomodoro() {
  document.getElementById('pomodoro-widget').classList.toggle('open');
}

function startPausePomodoro() {
  if (pomodoroRunning) {
    clearInterval(pomodoroTimer);
    pomodoroRunning = false;
    document.getElementById('pom-start-btn').innerHTML = svgPlay();
  } else {
    pomodoroRunning = true;
    document.getElementById('pom-start-btn').innerHTML = svgPause();
    pomodoroTimer = setInterval(() => {
      pomodoroSeconds--;
      if (pomodoroSeconds <= 0) {
        clearInterval(pomodoroTimer);
        pomodoroRunning = false;
        if (pomodoroMode === 'focus') {
          pomodoroSessions++;
          document.getElementById('pom-sessions').textContent = pomodoroSessions;
        }
        handlePomodoroEnd();
      }
      renderPomodoroTime();
    }, 1000);
  }
}

function handlePomodoroEnd() {
  document.getElementById('pom-start-btn').innerHTML = svgPlay();
  showToast(pomodoroMode === 'focus' ? 'Focus session complete! Take a break.' : 'Break over — time to focus!');
  setPomodoroMode(pomodoroMode === 'focus'
    ? (pomodoroSessions % 4 === 0 ? 'long' : 'short')
    : 'focus');
}

function resetPomodoro() {
  clearInterval(pomodoroTimer);
  pomodoroRunning = false;
  pomodoroSeconds = POMODORO_DURATIONS[pomodoroMode];
  document.getElementById('pom-start-btn').innerHTML = svgPlay();
  renderPomodoroTime();
}

function setPomodoroMode(mode) {
  pomodoroMode = mode;
  clearInterval(pomodoroTimer);
  pomodoroRunning = false;
  pomodoroSeconds = POMODORO_DURATIONS[mode];
  document.getElementById('pom-start-btn').innerHTML = svgPlay();
  document.querySelectorAll('.pom-mode-btn').forEach(b => b.classList.toggle('active', b.dataset.mode === mode));
  document.getElementById('pom-label').textContent =
    mode === 'focus' ? 'Focus' : mode === 'short' ? 'Short Break' : 'Long Break';
  renderPomodoroTime();
}

function renderPomodoroTime() {
  const m = String(Math.floor(pomodoroSeconds / 60)).padStart(2, '0');
  const s = String(pomodoroSeconds % 60).padStart(2, '0');
  const el = document.getElementById('pom-time');
  if (el) el.textContent = `${m}:${s}`;
  const ring = document.getElementById('pom-ring');
  if (ring) {
    const pct = pomodoroSeconds / POMODORO_DURATIONS[pomodoroMode];
    ring.style.strokeDashoffset = 226 * (1 - pct);
  }
  const fab = document.getElementById('pom-fab-time');
  if (fab) fab.textContent = pomodoroRunning ? `${m}:${s}` : '';
  const fabBtn = document.getElementById('pom-fab-btn');
  if (fabBtn) fabBtn.classList.toggle('running', pomodoroRunning);
}

function svgPlay() {
  return `<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M5 3l14 9-14 9V3z"/></svg>`;
}
function svgPause() {
  return `<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg>`;
}

/* ===== INPUT ===== */
function onKey(e) {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); }
}
function resizeInput(el) {
  el.style.height = 'auto';
  el.style.height = Math.min(el.scrollHeight, 140) + 'px';
}
function setSendDisabled(v) {
  document.getElementById('send-btn').disabled = v;
}

/* ===== HELPERS ===== */
function scrollBottom() {
  const ca = document.getElementById('chat-area');
  setTimeout(() => ca.scrollTo({ top: ca.scrollHeight, behavior: 'smooth' }), 40);
}

function showToast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), 2600);
}

function esc(s) {
  const d = document.createElement('div');
  d.appendChild(document.createTextNode(s || ''));
  return d.innerHTML;
}

function relativeTime(iso) {
  if (!iso) return '';
  const d = new Date(iso.endsWith('Z') ? iso : iso + 'Z');
  const diff = (Date.now() - d) / 1000;
  if (diff < 60) return 'Just now';
  if (diff < 3600) return Math.floor(diff / 60) + 'm ago';
  if (diff < 86400) return Math.floor(diff / 3600) + 'h ago';
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function formatMd(text) {
  let h = esc(text);
  h = h.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');
  h = h.replace(/(?<!\*)\*(?!\*)(.*?)(?<!\*)\*(?!\*)/g, '<em>$1</em>');
  h = h.replace(/`([^`\n]+)`/g, '<code>$1</code>');
  h = h.replace(/^(\d+)\.\s+(.+)$/gm, '<li>$2</li>');
  h = h.replace(/^[-•]\s+(.+)$/gm, '<li>$1</li>');
  h = h.replace(/(<li>.*?<\/li>(\n<li>.*?<\/li>)*)/gs, '<ul>$1</ul>');
  h = h.replace(/^(<strong>)(.*?)(<\/strong>)\s*$/gm,
    '<p class="ai-section-hdr">$2</p>');
  h = h.replace(/^---+$/gm, '<hr>');
  h = h.replace(/\n/g, '<br>');
  return h;
}
