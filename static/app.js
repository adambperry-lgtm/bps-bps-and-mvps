const STATE = {
  activeTab: 'chat',
  sessionId: localStorage.getItem('bp_active_session_id') || null,
  autoRefreshTimer: null,
  favoritePlayerIds: new Set(),
  newsItems: [],
  newsFilter: 'mlb',
  voiceAutoSpeak: localStorage.getItem('bp_voice_auto') === 'true',
  isListening: false,
  recognition: null,
  activeSpeakBtn: null,
  ttsVoice: localStorage.getItem('bp_tts_voice') || 'Puck',
  currentAudio: null,
  readerPlainText: '',
  standingsTab: 'division',
  lastFavTeam: null,
  lastTeamLiveStatus: null,
};

const WELCOME_MESSAGE =
  "Hey slugger, welcome to **BP’s BPs and MVPs**. I’m your Dugout Coach. " +
  "Ask me about MLB players, live scores, team standings, rules, or hitting and pitching tips—or tell me to add a player to your My MVPs. " +
  "Step up to the plate whenever you’re ready! ⚾";

// --- Utilities ---

function escapeHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatSimpleMarkdown(text) {
  let safe = escapeHtml(text);
  // Bold **text**
  safe = safe.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  // Inline code `text`
  safe = safe.replace(/`([^`]+)`/g, '<code class="bg-slate-200/70 px-1 py-0.5 rounded text-xs font-mono">$1</code>');
  // Line breaks
  safe = safe.replace(/\n/g, '<br />');
  return safe;
}

function formatTimestamp(isoStr) {
  if (!isoStr) return '';
  try {
    const d = new Date(isoStr);
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
  } catch {
    return isoStr.slice(0, 10);
  }
}

// --- Tab Navigation ---

function switchTab(tab) {
  STATE.activeTab = tab;
  const tabs = ['chat', 'tracker', 'news'];
  for (const t of tabs) {
    const panel = document.getElementById(`panel-${t}`);
    const btn = document.getElementById(`tab-btn-${t}`);
    if (t === tab) {
      panel.classList.remove('hidden');
      btn.classList.add('tab-active');
      btn.classList.remove('tab-inactive');
    } else {
      panel.classList.add('hidden');
      btn.classList.remove('tab-active');
      btn.classList.add('tab-inactive');
    }
  }

  if (tab !== 'chat') {
    stopSpeaking();
  }
  if (tab === 'tracker') {
    loadFavorites();
  } else if (tab === 'news') {
    loadNewsfeed();
  }
}

// --- FEATURE 1: DUGOUT CHAT ---

const MAX_RECENT_CHATS = 10;

function getRecentChats() {
  try {
    const raw = localStorage.getItem('bp_recent_chats');
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function saveRecentChats(chats) {
  try {
    const sorted = [...chats]
      .sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')))
      .slice(0, MAX_RECENT_CHATS);
    localStorage.setItem('bp_recent_chats', JSON.stringify(sorted));
  } catch {
    // ignore storage errors
  }
}

function upsertRecentChat(sessionId, { title, messages, appendMessages } = {}) {
  if (!sessionId) return;
  const chats = getRecentChats();
  const idx = chats.findIndex((c) => c.id === sessionId);
  const existing = idx >= 0 ? chats[idx] : { id: sessionId, title: 'New Dugout Chat', messages: [] };

  let nextMessages = Array.isArray(existing.messages) ? [...existing.messages] : [];
  if (Array.isArray(messages)) {
    nextMessages = messages;
  } else if (Array.isArray(appendMessages) && appendMessages.length) {
    nextMessages = [...nextMessages, ...appendMessages];
  }

  let nextTitle = title || existing.title || 'New Dugout Chat';
  if (nextTitle === 'New Dugout Chat' && nextMessages.length) {
    const firstUser = nextMessages.find((m) => m.role === 'user');
    if (firstUser && firstUser.content) {
      nextTitle = firstUser.content.trim().slice(0, 48);
    }
  }

  const updated = {
    id: sessionId,
    title: nextTitle,
    updatedAt: new Date().toISOString(),
    messages: nextMessages,
  };

  if (idx >= 0) {
    chats.splice(idx, 1);
  }
  chats.unshift(updated);
  saveRecentChats(chats);
}

async function initChat() {
  await refreshSessionDropdown();
  if (!STATE.sessionId) {
    await startNewChat(true);
  } else {
    await loadChatMessages(STATE.sessionId);
  }
}

async function refreshSessionDropdown() {
  const select = document.getElementById('chat-session-select');
  if (!select) return;

  let serverSessions = [];
  try {
    const res = await fetch('/api/chat/sessions', { cache: 'no-store' });
    const data = await res.json();
    serverSessions = data.sessions || [];
  } catch (err) {
    console.error('Failed to load sessions', err);
  }

  // Merge server sessions with localStorage recent chats (keeps last 10 even across redeploys)
  const localChats = getRecentChats();
  const serverIds = new Set(serverSessions.map((s) => s && s.id).filter(Boolean));
  const missingLocalChats = localChats.filter(
    (lc) => lc && lc.id && !serverIds.has(lc.id) && Array.isArray(lc.messages) && lc.messages.length > 0
  );

  if (missingLocalChats.length > 0) {
    try {
      const restoreRes = await fetch('/api/chat/sessions/restore', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sessions: missingLocalChats.map((lc) => ({
            id: lc.id,
            title: lc.title || 'Dugout Chat',
            updated_at: lc.updatedAt || null,
            messages: lc.messages,
          })),
        }),
      });
      if (restoreRes.ok) {
        const restoreData = await restoreRes.json();
        if (Array.isArray(restoreData.sessions)) {
          serverSessions = restoreData.sessions;
        }
      }
    } catch (err) {
      console.error('Failed to restore cached sessions to server', err);
    }
  }

  const byId = new Map();

  for (const lc of localChats) {
    if (lc && lc.id) {
      byId.set(lc.id, {
        id: lc.id,
        title: lc.title || 'Dugout Chat',
        updatedAt: lc.updatedAt || '',
        messages: Array.isArray(lc.messages) ? lc.messages : [],
      });
    }
  }

  for (const s of serverSessions) {
    if (!s || !s.id) continue;
    const prev = byId.get(s.id);
    byId.set(s.id, {
      id: s.id,
      title: s.title || prev?.title || 'Dugout Chat',
      updatedAt: s.updated_at || prev?.updatedAt || new Date().toISOString(),
      messages: prev?.messages || [],
    });
  }

  const merged = Array.from(byId.values())
    .sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')))
    .slice(0, MAX_RECENT_CHATS);

  saveRecentChats(merged);

  select.innerHTML = '';
  if (!merged.length) {
    const opt = document.createElement('option');
    opt.value = '';
    opt.textContent = 'Current Dugout Chat';
    select.appendChild(opt);
    return;
  }

  if (!STATE.sessionId || !merged.some((s) => s.id === STATE.sessionId)) {
    STATE.sessionId = merged[0].id;
    localStorage.setItem('bp_active_session_id', STATE.sessionId);
  }

  for (const s of merged) {
    const opt = document.createElement('option');
    opt.value = s.id;
    opt.textContent = s.title || 'Dugout Chat';
    if (s.id === STATE.sessionId) opt.selected = true;
    select.appendChild(opt);
  }
}

async function startNewChat(refreshDropdown = true) {
  stopSpeaking();
  try {
    const res = await fetch('/api/chat/sessions', { method: 'POST', cache: 'no-store' });
    const data = await res.json();
    STATE.sessionId = data.session.id;
    localStorage.setItem('bp_active_session_id', STATE.sessionId);
    upsertRecentChat(STATE.sessionId, {
      title: data.session.title || 'New Dugout Chat',
      messages: [],
    });
    if (refreshDropdown) {
      await refreshSessionDropdown();
    }
    renderChatMessages([]);
  } catch (err) {
    console.error('Failed to create new chat', err);
  }
}

async function loadSelectedSession() {
  const select = document.getElementById('chat-session-select');
  if (!select.value) return;
  STATE.sessionId = select.value;
  localStorage.setItem('bp_active_session_id', STATE.sessionId);
  await loadChatMessages(STATE.sessionId);
}

async function loadChatMessages(sessionId) {
  try {
    const res = await fetch(`/api/chat/sessions/${encodeURIComponent(sessionId)}/messages`, { cache: 'no-store' });
    const data = await res.json();
    const serverMsgs = data.messages || [];
    if (serverMsgs.length) {
      upsertRecentChat(sessionId, { messages: serverMsgs });
      renderChatMessages(serverMsgs);
      return;
    }
  } catch (err) {
    console.error('Failed to load messages', err);
  }

  // Fallback to localStorage cached messages if server DB was reset
  const local = getRecentChats().find((c) => c.id === sessionId);
  renderChatMessages(local?.messages || []);
}

function renderChatMessages(messages) {
  const container = document.getElementById('chat-messages');
  container.innerHTML = '';

  // Always show Dugout Coach welcome message at the top
  appendMessageBubble('assistant', WELCOME_MESSAGE, false);

  for (const m of messages) {
    appendMessageBubble(m.role, m.content, false);
  }
  container.scrollTop = container.scrollHeight;
}

function appendMessageBubble(role, content, scroll = true) {
  const container = document.getElementById('chat-messages');
  const wrapper = document.createElement('div');
  const isUser = role === 'user';

  wrapper.className = `flex ${isUser ? 'justify-end' : 'justify-start'}`;

  const bubble = document.createElement('div');
  bubble.className = isUser
    ? 'max-w-[82%] bg-navy text-white rounded-2xl rounded-br-sm px-4 py-2.5 text-sm sm:text-base shadow-sm'
    : 'max-w-[85%] bg-white border border-slate-200 text-slate-800 rounded-2xl rounded-bl-sm px-4 py-3 text-sm sm:text-base shadow-sm';

  if (!isUser) {
    const header = document.createElement('div');
    header.className = 'flex items-center justify-between gap-2 mb-1';
    header.innerHTML = `<span class="text-xs font-extrabold uppercase tracking-wider text-ballred">Dugout Coach</span>`;

    if ('speechSynthesis' in window) {
      const speakBtn = document.createElement('button');
      speakBtn.type = 'button';
      speakBtn.className = 'text-xs text-slate-400 hover:text-navy font-semibold px-1.5 py-0.5 rounded transition flex items-center gap-1';
      speakBtn.title = 'Read this message out loud';
      speakBtn.innerHTML = '<span>🔊</span><span>Listen</span>';
      speakBtn.onclick = () => speakText(content, speakBtn);
      header.appendChild(speakBtn);
    }

    const body = document.createElement('div');
    body.className = 'leading-relaxed';
    body.innerHTML = formatSimpleMarkdown(content);

    bubble.appendChild(header);
    bubble.appendChild(body);
  } else {
    bubble.innerHTML = `<div class="leading-relaxed">${formatSimpleMarkdown(content)}</div>`;
  }

  wrapper.appendChild(bubble);
  container.appendChild(wrapper);
  if (scroll) {
    container.scrollTop = container.scrollHeight;
  }
}

function showTypingIndicator() {
  const container = document.getElementById('chat-messages');
  const el = document.createElement('div');
  el.id = 'chat-typing';
  el.className = 'flex justify-start';
  el.innerHTML = `
    <div class="bg-white border border-slate-200 text-slate-500 rounded-2xl rounded-bl-sm px-4 py-2.5 text-sm shadow-sm italic">
      🧢 Coach is checking the dugout clipboard...
    </div>
  `;
  container.appendChild(el);
  container.scrollTop = container.scrollHeight;
}

function removeTypingIndicator() {
  const el = document.getElementById('chat-typing');
  if (el) el.remove();
}

async function sendQuickPrompt(text) {
  document.getElementById('chat-input').value = text;
  await sendChatMessage(text);
}

async function handleChatSubmit(event) {
  event.preventDefault();
  const input = document.getElementById('chat-input');
  const msg = input.value.trim();
  if (!msg) return;
  input.value = '';
  await sendChatMessage(msg);
}

function appendMvpAddedNotice(addedPlayers) {
  if (!Array.isArray(addedPlayers) || !addedPlayers.length) return;
  const container = document.getElementById('chat-messages');
  if (!container) return;

  const names = addedPlayers.map((p) => p.full_name).filter(Boolean).join(', ');
  const wrapper = document.createElement('div');
  wrapper.className = 'flex justify-start';
  wrapper.innerHTML = `
    <div class="inline-flex flex-wrap items-center gap-2 bg-gold-light border border-gold/70 text-navy rounded-xl px-3 py-1.5 text-xs font-semibold shadow-sm">
      <span>⭐ Added to My MVPs: <strong>${escapeHtml(names)}</strong></span>
      <button type="button" onclick="switchTab('tracker')"
        class="px-2 py-0.5 rounded-lg bg-navy hover:bg-navy-light text-white text-[11px] font-bold transition">
        View My MVPs →
      </button>
    </div>
  `;
  container.appendChild(wrapper);
  container.scrollTop = container.scrollHeight;
}

async function sendChatMessage(msg) {
  const btn = document.getElementById('chat-send-btn');
  const input = document.getElementById('chat-input');
  const micBtn = document.getElementById('voice-mic-btn');
  btn.disabled = true;
  input.disabled = true;
  if (micBtn) micBtn.disabled = true;
  if (STATE.isListening && STATE.recognition) {
    STATE.recognition.stop();
  }

  appendMessageBubble('user', msg);
  showTypingIndicator();

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 65000);

  try {
    const res = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ session_id: STATE.sessionId, message: msg }),
      signal: controller.signal,
    });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }
    const data = await res.json();
    removeTypingIndicator();

    if (data.session_id) {
      STATE.sessionId = data.session_id;
      localStorage.setItem('bp_active_session_id', STATE.sessionId);
    }
    const reply = data.reply || 'Let’s talk baseball!';
    appendMessageBubble('assistant', reply);

    if (Array.isArray(data.added_mvps) && data.added_mvps.length > 0) {
      const ids = getSavedMvpIds();
      for (const p of data.added_mvps) {
        if (p && p.player_id) {
          ids.push(p.player_id);
          STATE.favoritePlayerIds.add(p.player_id);
        }
      }
      setSavedMvpIds(ids);
      appendMvpAddedNotice(data.added_mvps);
      loadFavorites();
    }

    upsertRecentChat(STATE.sessionId, {
      appendMessages: [
        { role: 'user', content: msg },
        { role: 'assistant', content: reply },
      ],
    });
    if (STATE.voiceAutoSpeak) {
      speakText(reply);
    }
    await refreshSessionDropdown();
  } catch (err) {
    removeTypingIndicator();
    const errMsg = err && err.name === 'AbortError'
      ? 'Oops! The dugout coach took too long to respond. Please try again!'
      : 'Oops! Could not reach the dugout server. Please try again!';
    appendMessageBubble('assistant', errMsg);
  } finally {
    clearTimeout(timeoutId);
    btn.disabled = false;
    input.disabled = false;
    if (micBtn && STATE.recognition) micBtn.disabled = false;
    input.focus();
  }
}

// --- Voice Chat (Web Speech API + SpeechSynthesis) ---

function initVoiceControls() {
  updateAutoVoiceButton();

  const autoBtn = document.getElementById('voice-auto-btn');
  if (autoBtn && !('speechSynthesis' in window)) {
    autoBtn.classList.add('hidden');
  }

  const micBtn = document.getElementById('voice-mic-btn');
  const SpeechRec = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SpeechRec) {
    if (micBtn) {
      micBtn.disabled = true;
      micBtn.title = 'Voice input is supported in Chrome, Edge, or Safari';
    }
    return;
  }

  const recognition = new SpeechRec();
  recognition.lang = 'en-US';
  recognition.interimResults = true;
  recognition.maxAlternatives = 1;
  recognition.continuous = false;

  let finalTranscript = '';

  recognition.onstart = () => {
    STATE.isListening = true;
    finalTranscript = '';
    stopSpeaking();
    const input = document.getElementById('chat-input');
    if (input) {
      input.dataset.prevPlaceholder = input.placeholder;
      input.placeholder = 'Listening... speak your baseball question!';
    }
    if (micBtn) {
      micBtn.classList.remove('bg-slate-100', 'text-navy', 'hover:bg-gold-light');
      micBtn.classList.add('bg-ballred', 'text-white', 'animate-pulse');
      micBtn.title = 'Listening... click to stop';
    }
  };

  recognition.onresult = (event) => {
    let interim = '';
    for (let i = event.resultIndex; i < event.results.length; i++) {
      const t = event.results[i][0].transcript;
      if (event.results[i].isFinal) {
        finalTranscript += t;
      } else {
        interim += t;
      }
    }
    const input = document.getElementById('chat-input');
    if (input) {
      input.value = (finalTranscript || interim).trim();
    }
  };

  recognition.onerror = (event) => {
    if (event.error !== 'no-speech' && event.error !== 'aborted') {
      console.warn('Speech recognition error:', event.error);
    }
  };

  recognition.onend = async () => {
    STATE.isListening = false;
    const input = document.getElementById('chat-input');
    if (input && input.dataset.prevPlaceholder) {
      input.placeholder = input.dataset.prevPlaceholder;
    }
    if (micBtn) {
      micBtn.classList.add('bg-slate-100', 'text-navy', 'hover:bg-gold-light');
      micBtn.classList.remove('bg-ballred', 'text-white', 'animate-pulse');
      micBtn.title = 'Speak your question to Dugout Coach';
    }
    const spoken = finalTranscript.trim();
    if (spoken && input && !input.disabled) {
      input.value = '';
      await sendChatMessage(spoken);
    }
  };

  STATE.recognition = recognition;
}

function toggleVoiceInput() {
  if (!STATE.recognition) return;
  if (STATE.isListening) {
    STATE.recognition.stop();
  } else {
    try {
      STATE.recognition.start();
    } catch (err) {
      console.warn('Could not start speech recognition:', err);
    }
  }
}

function toggleAutoVoice() {
  STATE.voiceAutoSpeak = !STATE.voiceAutoSpeak;
  localStorage.setItem('bp_voice_auto', String(STATE.voiceAutoSpeak));
  updateAutoVoiceButton();
  if (!STATE.voiceAutoSpeak) {
    stopSpeaking();
  }
}

function updateAutoVoiceButton() {
  const btn = document.getElementById('voice-auto-btn');
  const icon = document.getElementById('voice-auto-icon');
  const label = document.getElementById('voice-auto-label');
  if (!btn || !icon || !label) return;

  if (STATE.voiceAutoSpeak) {
    btn.classList.remove('bg-white', 'text-slate-700', 'border-slate-300', 'hover:bg-slate-100');
    btn.classList.add('bg-navy', 'text-white', 'border-navy', 'hover:bg-navy-light');
    icon.textContent = '🔊';
    label.textContent = 'Voice On';
  } else {
    btn.classList.add('bg-white', 'text-slate-700', 'border-slate-300', 'hover:bg-slate-100');
    btn.classList.remove('bg-navy', 'text-white', 'border-navy', 'hover:bg-navy-light');
    icon.textContent = '🔇';
    label.textContent = 'Voice Off';
  }
}

function cleanTextForSpeech(text) {
  return String(text || '')
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function unlockAudioPlayer() {
  const player = document.getElementById('tts-audio-player');
  if (!player) return null;
  try {
    player.src = 'data:audio/wav;base64,UklGRigAAABXQVZFZm10IBIAAAABAAEARKwAAIhYAQACABAAAABkYXRhAgAAAAEA';
    const p = player.play();
    if (p && typeof p.catch === 'function') p.catch(() => {});
  } catch {
    // ignore
  }
  return player;
}

function stopAudioPlayer() {
  const player = document.getElementById('tts-audio-player');
  if (player) {
    try {
      player.pause();
      player.removeAttribute('src');
      player.load();
    } catch {
      // ignore
    }
  }
  if (STATE.currentAudioUrl) {
    URL.revokeObjectURL(STATE.currentAudioUrl);
    STATE.currentAudioUrl = null;
  }
  STATE.currentAudio = null;
}

function stopSpeaking() {
  stopAudioPlayer();
  if ('speechSynthesis' in window) {
    window.speechSynthesis.cancel();
  }
  if (STATE.activeSpeakBtn) {
    STATE.activeSpeakBtn.innerHTML = '<span>🔊</span><span>Listen</span>';
    STATE.activeSpeakBtn.classList.remove('text-ballred');
    STATE.activeSpeakBtn.classList.add('text-slate-400');
    STATE.activeSpeakBtn = null;
  }
}

async function speakText(text, btnEl = null) {
  const player = document.getElementById('tts-audio-player');
  const isPlaying = Boolean(
    (player && !player.paused && player.currentTime > 0) ||
    ('speechSynthesis' in window && window.speechSynthesis.speaking)
  );
  const isSameActiveBtn = btnEl && STATE.activeSpeakBtn === btnEl && isPlaying;
  stopSpeaking();
  if (isSameActiveBtn) return;

  const cleaned = cleanTextForSpeech(text);
  if (!cleaned) return;

  // Unlock iPad Safari audio synchronously inside tap gesture
  unlockAudioPlayer();

  if (btnEl) {
    STATE.activeSpeakBtn = btnEl;
    btnEl.innerHTML = '<span>⏳</span><span>Loading...</span>';
    btnEl.classList.remove('text-slate-400');
    btnEl.classList.add('text-ballred');
  }

  try {
    const res = await fetch('/api/tts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: cleaned, voice: STATE.ttsVoice || 'Puck' }),
    });
    if (!res.ok) throw new Error(`TTS HTTP ${res.status}`);

    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    STATE.currentAudioUrl = url;
    STATE.currentAudio = player;

    player.src = url;
    player.onended = () => stopSpeaking();
    player.onerror = () => stopSpeaking();

    if (btnEl && STATE.activeSpeakBtn === btnEl) {
      btnEl.innerHTML = '<span>⏹️</span><span>Stop</span>';
    }
    await player.play();
    return;
  } catch (err) {
    console.warn('Gemini TTS fallback to browser speech:', err);
  }

  if (!('speechSynthesis' in window)) {
    stopSpeaking();
    return;
  }

  const utterance = new SpeechSynthesisUtterance(cleaned);
  utterance.lang = 'en-US';
  utterance.rate = 0.96;
  utterance.pitch = 1.0;

  const voices = window.speechSynthesis.getVoices();
  const preferred =
    voices.find((v) => v.lang.startsWith('en') && /enhanced|premium|siri|natural/i.test(v.name)) ||
    voices.find((v) => v.lang.startsWith('en-US')) ||
    voices.find((v) => v.lang.startsWith('en'));
  if (preferred) {
    utterance.voice = preferred;
  }

  if (btnEl) {
    STATE.activeSpeakBtn = btnEl;
    btnEl.innerHTML = '<span>⏹️</span><span>Stop</span>';
    btnEl.classList.remove('text-slate-400');
    btnEl.classList.add('text-ballred');
  }
  utterance.onend = () => stopSpeaking();
  utterance.onerror = () => stopSpeaking();

  window.speechSynthesis.speak(utterance);
}

// --- FEATURE 2: BPs & MVPs TRACKER ---

async function loadTeamsDropdown() {
  try {
    const res = await fetch('/api/teams');
    const data = await res.json();
    const select = document.getElementById('settings-team-select');
    if (!select) return;
    const current = select.value || String(STATE.favoriteTeamId || 143);
    select.innerHTML = '';
    for (const t of data.teams || []) {
      const opt = document.createElement('option');
      opt.value = t.team_id;
      opt.textContent = t.team_name;
      select.appendChild(opt);
    }
    if (current) select.value = current;
  } catch (err) {
    console.error('Failed to load teams', err);
  }
}

function openSettingsModal() {
  const modal = document.getElementById('settings-modal');
  const teamSelect = document.getElementById('settings-team-select');
  const voiceSelect = document.getElementById('settings-voice-select');

  if (teamSelect && STATE.favoriteTeamId) {
    teamSelect.value = String(STATE.favoriteTeamId);
  }
  if (voiceSelect && STATE.ttsVoice) {
    voiceSelect.value = STATE.ttsVoice;
  }
  modal.classList.remove('hidden');
  document.body.classList.add('overflow-hidden');
}

function closeSettingsModal() {
  const modal = document.getElementById('settings-modal');
  modal.classList.add('hidden');
  document.body.classList.remove('overflow-hidden');
}

function syncAutoRefreshFromSettings() {
  toggleAutoRefresh();
}

async function saveSettings() {
  const teamSelect = document.getElementById('settings-team-select');
  const voiceSelect = document.getElementById('settings-voice-select');
  const teamId = parseInt(teamSelect.value || '143', 10);
  if (voiceSelect && voiceSelect.value) {
    STATE.ttsVoice = voiceSelect.value;
    localStorage.setItem('bp_tts_voice', STATE.ttsVoice);
  }
  await fetch('/api/favorites/team', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ team_id: teamId }),
  });
  closeSettingsModal();
  await loadFavorites(true);
  if (STATE.activeTab === 'news') {
    await loadNewsfeed();
  }
}

async function resetToPhillies() {
  const teamSelect = document.getElementById('settings-team-select');
  if (teamSelect) teamSelect.value = '143';
  await saveSettings();
}

function toggleAutoRefresh() {
  const settingsAuto = document.getElementById('settings-auto-refresh');
  const checked = settingsAuto ? settingsAuto.checked : false;
  if (STATE.autoRefreshTimer) {
    clearInterval(STATE.autoRefreshTimer);
    STATE.autoRefreshTimer = null;
  }
  if (checked) {
    STATE.autoRefreshTimer = setInterval(() => {
      if (STATE.activeTab === 'tracker') {
        loadFavorites(true);
      }
    }, 60000);
  }
}

function getSavedMvpIds() {
  try {
    const raw = localStorage.getItem('bp_my_mvps');
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function setSavedMvpIds(ids) {
  try {
    localStorage.setItem('bp_my_mvps', JSON.stringify(Array.from(new Set(ids))));
  } catch {
    // ignore storage errors
  }
}

async function loadFavorites(showSpinner = false) {
  const btn = document.getElementById('refresh-live-btn');
  if (showSpinner && btn) btn.textContent = '⏳ Refreshing...';

  try {
    let res = await fetch('/api/favorites', { cache: 'no-store' });
    let data = await res.json();

    let favPlayers = data.favorite_players || [];
    const localIds = getSavedMvpIds();

    // If server DB was reset (e.g., Railway redeploy without /data volume), restore from localStorage
    if (favPlayers.length === 0 && localIds.length > 0) {
      for (const pid of localIds) {
        await fetch('/api/favorites/players', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ player_id: pid }),
        });
      }
      res = await fetch('/api/favorites', { cache: 'no-store' });
      data = await res.json();
      favPlayers = data.favorite_players || [];
    } else if (favPlayers.length > 0) {
      setSavedMvpIds(favPlayers.map((p) => p.player_id));
    }

    STATE.favoritePlayerIds = new Set(favPlayers.map((p) => p.player_id));

    const favTeam = data.favorite_team;
    STATE.favoriteTeamId = favTeam ? favTeam.team_id : 143;
    const select = document.getElementById('settings-team-select');
    if (select && STATE.favoriteTeamId) {
      select.value = String(STATE.favoriteTeamId);
    }

    renderTeamLiveCard(favTeam, data.team_live_status);
    renderFavoritePlayersGrid(favPlayers);
  } catch (err) {
    console.error('Failed to load favorites', err);
  } finally {
    if (btn) btn.innerHTML = '<span>🔄</span><span>Refresh Live Stats</span>';
  }
}

function switchStandingsTab(tab) {
  STATE.standingsTab = tab === 'wildcard' ? 'wildcard' : 'division';
  if (STATE.lastFavTeam) {
    renderTeamLiveCard(STATE.lastFavTeam, STATE.lastTeamLiveStatus);
  }
}

function renderTeamLiveCard(favTeam, liveStatus) {
  const card = document.getElementById('team-live-card');
  if (!favTeam) {
    card.innerHTML = `
      <div class="text-center py-4">
        <p class="text-sm text-slate-300">Select your favorite MLB team in Settings to see live game updates, next scheduled game, recent scores, and standings!</p>
      </div>
    `;
    return;
  }

  STATE.lastFavTeam = favTeam;
  STATE.lastTeamLiveStatus = liveStatus;

  const todayGame = liveStatus?.today_game;
  const nextGame = liveStatus?.next_game;
  const lastFinal = liveStatus?.last_final_game;
  const divStandings = liveStatus?.division_standings;
  const wcStandings = liveStatus?.wildcard_standings;

  let todayHtml = '';
  if (todayGame) {
    const isLive = todayGame.abstract_state === 'Live';
    const badgeColor = isLive ? 'bg-ballred text-white animate-pulse' : 'bg-gold text-navy';
    const statusLabel = isLive
      ? `LIVE • ${todayGame.inning_state || ''} ${todayGame.inning || ''}`
      : (todayGame.detailed_state || 'Today');

    const countHtml = isLive
      ? `<div class="mt-3 pt-3 border-t border-white/15 flex flex-wrap gap-4 text-xs text-slate-200">
           <span><strong>Count:</strong> ${todayGame.balls ?? 0}-${todayGame.strikes ?? 0}, ${todayGame.outs ?? 0} Out</span>
           ${todayGame.current_pitcher ? `<span><strong>Pitching:</strong> ${escapeHtml(todayGame.current_pitcher)}</span>` : ''}
           ${todayGame.current_batter ? `<span><strong>At Bat:</strong> ${escapeHtml(todayGame.current_batter)}</span>` : ''}
         </div>`
      : '';

    todayHtml = `
      <div class="bg-white/10 rounded-xl p-3.5 mb-3">
        <div class="flex items-center justify-between gap-2 mb-2">
          <span class="text-xs font-bold uppercase tracking-wider px-2.5 py-0.5 rounded-full ${badgeColor}">${escapeHtml(statusLabel)}</span>
          <span class="text-xs text-slate-300">${escapeHtml(todayGame.venue || '')}</span>
        </div>
        <div class="grid grid-cols-3 items-center text-center py-1">
          <div>
            <div class="text-xs text-slate-300 uppercase">Away</div>
            <div class="font-bold text-base sm:text-lg">${escapeHtml(todayGame.away_team)}</div>
            <div class="text-2xl font-extrabold text-gold">${todayGame.away_score ?? '—'}</div>
          </div>
          <div class="text-xs font-bold text-slate-400">VS</div>
          <div>
            <div class="text-xs text-slate-300 uppercase">Home</div>
            <div class="font-bold text-base sm:text-lg">${escapeHtml(todayGame.home_team)}</div>
            <div class="text-2xl font-extrabold text-gold">${todayGame.home_score ?? '—'}</div>
          </div>
        </div>
        ${countHtml}
      </div>
    `;
  }

  const isWc = STATE.standingsTab === 'wildcard' && wcStandings?.teams?.length;
  const activeStandings = isWc ? wcStandings : divStandings;
  const activeTitle = isWc
    ? `${wcStandings.league_name || 'League'} Wild Card`
    : `${divStandings?.division_name || 'Division'} Standings`;

  const standingsRows = isWc
    ? (wcStandings.teams || [])
        .map((t, idx) => {
          const isFavTeam = t.name === favTeam.team_name;
          const cutoffBorder = idx === 2 ? 'border-b-2 border-dashed border-gold/60' : '';
          return `
            <tr class="${isFavTeam ? 'bg-gold/20 text-gold font-extrabold' : 'text-slate-100 border-t border-white/10'} ${cutoffBorder}">
              <td class="py-1.5 px-2 text-left font-mono text-slate-300">${escapeHtml(String(t.rank ?? idx + 1))}</td>
              <td class="py-1.5 px-2 text-left truncate">${escapeHtml(t.name)}</td>
              <td class="py-1.5 px-2 text-right font-mono">${t.w ?? '—'}</td>
              <td class="py-1.5 px-2 text-right font-mono">${t.l ?? '—'}</td>
              <td class="py-1.5 px-2 text-right font-mono">${escapeHtml(String(t.wc_gb ?? '—'))}</td>
            </tr>
          `;
        })
        .join('')
    : (divStandings?.teams || [])
        .map((t) => {
          const isFavTeam = t.name === favTeam.team_name;
          return `
            <tr class="${isFavTeam ? 'bg-gold/20 text-gold font-extrabold' : 'text-slate-100 border-t border-white/10'}">
              <td class="py-1.5 px-2 text-left truncate">${escapeHtml(t.name)}</td>
              <td class="py-1.5 px-2 text-right font-mono">${t.w ?? '—'}</td>
              <td class="py-1.5 px-2 text-right font-mono">${t.l ?? '—'}</td>
              <td class="py-1.5 px-2 text-right font-mono">${escapeHtml(String(t.gb ?? '—'))}</td>
            </tr>
          `;
        })
        .join('');

  const standingsHtml = activeStandings?.teams?.length
    ? `
      <div class="mt-3 bg-white/10 rounded-lg p-3">
        <div class="flex flex-wrap items-center justify-between gap-2 mb-2.5">
          <div class="flex items-center gap-2">
            <span class="text-xs uppercase tracking-wider text-slate-200 font-bold">
              ${escapeHtml(activeTitle)}
            </span>
            ${activeStandings.season ? `<span class="text-[11px] font-bold text-gold">${escapeHtml(String(activeStandings.season))}</span>` : ''}
          </div>
          <div class="inline-flex rounded-full bg-black/25 p-0.5 text-[11px] font-bold">
            <button type="button" onclick="switchStandingsTab('division')"
              class="px-2.5 py-1 rounded-full transition ${!isWc ? 'bg-gold text-navy' : 'text-slate-200 hover:text-white'}">
              Division
            </button>
            <button type="button" onclick="switchStandingsTab('wildcard')"
              class="px-2.5 py-1 rounded-full transition ${isWc ? 'bg-gold text-navy' : 'text-slate-200 hover:text-white'}">
              Wild Card
            </button>
          </div>
        </div>
        <div class="overflow-x-auto">
          <table class="w-full text-xs border-collapse">
            <thead>
              <tr class="text-[11px] uppercase tracking-wider text-slate-300 border-b border-white/15">
                ${isWc ? '<th class="py-1 px-2 text-left">#</th>' : ''}
                <th class="py-1 px-2 text-left">Team</th>
                <th class="py-1 px-2 text-right">W</th>
                <th class="py-1 px-2 text-right">L</th>
                <th class="py-1 px-2 text-right">${isWc ? 'WCGB' : 'GB'}</th>
              </tr>
            </thead>
            <tbody>
              ${standingsRows}
            </tbody>
          </table>
        </div>
      </div>
    `
    : '';

  card.innerHTML = `
    <div class="flex items-center justify-between mb-3">
      <span class="inline-flex items-center gap-2 text-xs sm:text-sm font-bold uppercase tracking-wider px-3 py-1 rounded-full bg-white/15 text-gold">
        <img src="https://www.mlbstatic.com/team-logos/team-cap-on-dark/${escapeHtml(String(favTeam.team_id || 143))}.svg"
          alt="${escapeHtml(favTeam.team_name)} logo"
          class="w-5 h-5 object-contain shrink-0" />
        <span>${escapeHtml(favTeam.team_name)}</span>
      </span>
    </div>
    ${todayHtml}
    <div class="grid grid-cols-1 sm:grid-cols-2 gap-3 text-sm">
      <div class="bg-white/10 rounded-lg p-3">
        <div class="text-xs uppercase tracking-wider text-slate-300 font-bold mb-1">Next Game</div>
        ${
          nextGame
            ? `<div class="font-semibold">${escapeHtml(nextGame.away_team)} @ ${escapeHtml(nextGame.home_team)}</div>
               <div class="text-xs text-slate-300 mt-0.5">${escapeHtml(nextGame.game_date)}${nextGame.venue ? ` • ${escapeHtml(nextGame.venue)}` : ''}</div>`
            : `<div class="text-xs text-slate-300">No upcoming games on the schedule right now.</div>`
        }
      </div>
      <div class="bg-white/10 rounded-lg p-3">
        <div class="text-xs uppercase tracking-wider text-slate-300 font-bold mb-1">Most Recent Game</div>
        ${
          lastFinal
            ? `<div class="font-semibold">${escapeHtml(lastFinal.away_team)} ${lastFinal.away_score ?? 0} – ${lastFinal.home_score ?? 0} ${escapeHtml(lastFinal.home_team)}</div>
               <div class="text-xs text-slate-300 mt-0.5">Final • ${escapeHtml(lastFinal.game_date)}</div>`
            : `<div class="text-xs text-slate-300">No recent final game found.</div>`
        }
      </div>
    </div>
    ${standingsHtml}
  `;
}

function renderFavoritePlayersGrid(players) {
  const grid = document.getElementById('favorite-players-grid');
  if (!players.length) {
    grid.innerHTML = `
      <div class="col-span-full bg-slate-50 border border-dashed border-slate-300 rounded-xl p-6 text-center text-sm text-slate-500">
        No MVPs followed yet! Search for your favorite MLB players below and click <strong>+ Add to My MVPs</strong>.
      </div>
    `;
    return;
  }

  grid.innerHTML = players
    .map((p) => {
      const jerseyTag = p.jersey_number ? `#${escapeHtml(p.jersey_number)}` : '';
      const posTag = escapeHtml(p.position || 'MLB');
      const teamName = escapeHtml(p.team_name || 'MLB');

      return `
        <div onclick="viewPlayerDetails(${p.player_id})"
          role="button"
          tabindex="0"
          onkeydown="if(event.key==='Enter'||event.key===' '){event.preventDefault();viewPlayerDetails(${p.player_id});}"
          class="group bg-[#fdfaf2] p-2 rounded-2xl border-2 border-navy/85 shadow-md hover:shadow-xl hover:-translate-y-0.5 transition cursor-pointer select-none">
          <div class="relative rounded-xl overflow-hidden border-2 border-ballred bg-gradient-to-b from-[#13294b] via-[#1e3f73] to-[#0c1c36] aspect-[5/7] flex flex-col justify-between">
            <!-- Top Card Banner -->
            <div class="relative z-10 flex items-center justify-between gap-1 px-2.5 pt-2">
              <span class="px-2 py-0.5 rounded-full bg-gold text-navy text-[10px] font-black uppercase tracking-wider shadow-sm">
                ${posTag}${jerseyTag ? ` • ${jerseyTag}` : ''}
              </span>
              <button type="button"
                onclick="event.stopPropagation(); removeFavoritePlayer(${p.player_id})"
                title="Remove from My MVPs"
                aria-label="Remove ${escapeHtml(p.full_name)} from My MVPs"
                class="w-6 h-6 rounded-full bg-black/45 hover:bg-ballred text-white text-xs font-bold flex items-center justify-center transition">
                ×
              </button>
            </div>

            <!-- Player Portrait -->
            <div class="relative flex-1 flex items-end justify-center overflow-hidden px-2 pt-1">
              <div class="absolute inset-x-4 bottom-2 top-3 rounded-full bg-white/10 blur-xl pointer-events-none"></div>
              <img src="${escapeHtml(p.headshot_url)}" alt="${escapeHtml(p.full_name)}"
                class="relative z-10 w-full h-full object-contain object-bottom drop-shadow-[0_6px_10px_rgba(0,0,0,0.45)] group-hover:scale-[1.03] transition duration-200" />
            </div>

            <!-- Classic Bottom Nameplate -->
            <div class="relative z-10">
              <div class="h-1 bg-gold w-full"></div>
              <div class="bg-navy/95 px-2.5 py-2 text-center border-t border-white/10">
                <h4 class="font-black text-white text-xs sm:text-sm uppercase tracking-wide truncate">${escapeHtml(p.full_name)}</h4>
                <p class="text-[10px] font-bold text-gold uppercase tracking-wider truncate mt-0.5">${teamName}</p>
                <p class="text-[9px] text-slate-300/80 uppercase tracking-widest mt-0.5">Tap for Card Back</p>
              </div>
            </div>
          </div>
        </div>
      `;
    })
    .join('');
}

async function handlePlayerSearch(event) {
  event.preventDefault();
  const q = document.getElementById('player-search-input').value.trim();
  if (!q) return;

  const resultsBox = document.getElementById('player-search-results');
  resultsBox.classList.remove('hidden');
  resultsBox.innerHTML = '<div class="col-span-full text-sm text-slate-500 py-2">Searching MLB roster...</div>';

  try {
    const res = await fetch(`/api/players/search?q=${encodeURIComponent(q)}`);
    const data = await res.json();
    const results = data.results || [];

    if (!results.length) {
      resultsBox.innerHTML = '<div class="col-span-full text-sm text-slate-500 py-2">No MLB players found. Try another name!</div>';
      return;
    }

    resultsBox.innerHTML = results
      .map(
        (p) => `
      <button onclick="viewPlayerDetails(${p.player_id})"
        class="text-left border border-slate-200 hover:border-navy rounded-xl p-3 bg-slate-50 hover:bg-white transition flex items-center gap-3">
        <img src="${escapeHtml(p.headshot_url)}" alt="${escapeHtml(p.full_name)}"
          class="w-12 h-12 rounded-full object-cover bg-white border border-slate-200 shrink-0" />
        <div class="min-w-0">
          <div class="font-bold text-navy text-sm truncate">${escapeHtml(p.full_name)}</div>
          <div class="text-xs text-slate-500 truncate">${escapeHtml(p.position)} • ${escapeHtml(p.team_name)}</div>
          <span class="inline-block mt-1 text-[10px] font-bold uppercase px-2 py-0.5 rounded-full ${
            p.active ? 'bg-green-100 text-green-800' : 'bg-slate-200 text-slate-600'
          }">${p.active ? 'Active' : 'Historical'}</span>
        </div>
      </button>
    `
      )
      .join('');
  } catch (err) {
    resultsBox.innerHTML = '<div class="col-span-full text-sm text-ballred py-2">Search failed. Please try again.</div>';
  }
}

function buildHittingCardTable(yearByYearStats, seasonStats, careerStats, seasonLabel) {
  const yearlyRows = Array.isArray(yearByYearStats) && yearByYearStats.length
    ? yearByYearStats
    : (seasonStats && seasonLabel !== 'Career' ? [seasonStats] : []);
  const careerRow = careerStats || seasonStats;
  if (!yearlyRows.length && !careerRow) return '';

  const renderRow = (label, teamAbbr, s, isTotal = false, idx = 0) => {
    const rowBg = isTotal
      ? 'bg-[#efe4c8] border-t-2 border-navy font-extrabold text-navy'
      : `${idx % 2 === 0 ? 'bg-[#fdf8ec]' : 'bg-[#f8f0dc]'} text-slate-800 border-t border-amber-200/80`;
    return `
      <tr class="${rowBg}">
        <td class="px-2.5 py-1.5 font-sans font-bold text-left whitespace-nowrap">${escapeHtml(label)}</td>
        <td class="px-2 py-1.5 font-sans font-semibold text-left whitespace-nowrap text-navy/80">${escapeHtml(teamAbbr)}</td>
        <td class="px-2 py-1.5 text-right">${s.games ?? '—'}</td>
        <td class="px-2 py-1.5 text-right">${s.at_bats ?? '—'}</td>
        <td class="px-2 py-1.5 text-right">${s.runs ?? '—'}</td>
        <td class="px-2 py-1.5 text-right">${s.hits ?? '—'}</td>
        <td class="px-2 py-1.5 text-right">${s.doubles ?? '—'}</td>
        <td class="px-2 py-1.5 text-right">${s.triples ?? '—'}</td>
        <td class="px-2 py-1.5 text-right">${s.hr ?? '—'}</td>
        <td class="px-2 py-1.5 text-right">${s.rbi ?? '—'}</td>
        <td class="px-2 py-1.5 text-right">${s.sb ?? '—'}</td>
        <td class="px-2 py-1.5 text-right">${s.walks ?? '—'}</td>
        <td class="px-2 py-1.5 text-right">${escapeHtml(s.avg ?? '—')}</td>
        <td class="px-2.5 py-1.5 text-right">${escapeHtml(s.ops ?? '—')}</td>
      </tr>
    `;
  };

  return `
    <div class="space-y-1.5">
      <div class="flex items-center justify-between">
        <h4 class="text-[11px] font-black uppercase tracking-[0.14em] text-ballred">Major League Batting Record</h4>
        <span class="text-[10px] font-bold uppercase tracking-wider text-slate-500">Year-by-Year &amp; Career</span>
      </div>
      <div class="overflow-x-auto rounded-lg border-2 border-navy shadow-inner">
        <table class="w-full text-xs font-mono tabular-nums border-collapse">
          <thead>
            <tr class="bg-navy text-gold font-sans text-[11px] font-extrabold uppercase tracking-wider">
              <th class="px-2.5 py-1.5 text-left">YR</th>
              <th class="px-2 py-1.5 text-left">TEAM</th>
              <th class="px-2 py-1.5 text-right">G</th>
              <th class="px-2 py-1.5 text-right">AB</th>
              <th class="px-2 py-1.5 text-right">R</th>
              <th class="px-2 py-1.5 text-right">H</th>
              <th class="px-2 py-1.5 text-right">2B</th>
              <th class="px-2 py-1.5 text-right">3B</th>
              <th class="px-2 py-1.5 text-right">HR</th>
              <th class="px-2 py-1.5 text-right">RBI</th>
              <th class="px-2 py-1.5 text-right">SB</th>
              <th class="px-2 py-1.5 text-right">BB</th>
              <th class="px-2 py-1.5 text-right">AVG</th>
              <th class="px-2.5 py-1.5 text-right">OPS</th>
            </tr>
          </thead>
          <tbody>
            ${yearlyRows.map((row, idx) => renderRow(String(row.season || seasonLabel || ''), row.team_abbr || 'MLB', row, false, idx)).join('')}
            ${careerRow ? renderRow('MLB TOTALS', '', careerRow, true, 0) : ''}
          </tbody>
        </table>
      </div>
    </div>
  `;
}

function buildPitchingCardTable(yearByYearStats, seasonStats, careerStats, seasonLabel) {
  const yearlyRows = Array.isArray(yearByYearStats) && yearByYearStats.length
    ? yearByYearStats
    : (seasonStats && seasonLabel !== 'Career' ? [seasonStats] : []);
  const careerRow = careerStats || seasonStats;
  if (!yearlyRows.length && !careerRow) return '';

  const renderRow = (label, teamAbbr, s, isTotal = false, idx = 0) => {
    const rowBg = isTotal
      ? 'bg-[#efe4c8] border-t-2 border-navy font-extrabold text-navy'
      : `${idx % 2 === 0 ? 'bg-[#fdf8ec]' : 'bg-[#f8f0dc]'} text-slate-800 border-t border-amber-200/80`;
    return `
      <tr class="${rowBg}">
        <td class="px-2.5 py-1.5 font-sans font-bold text-left whitespace-nowrap">${escapeHtml(label)}</td>
        <td class="px-2 py-1.5 font-sans font-semibold text-left whitespace-nowrap text-navy/80">${escapeHtml(teamAbbr)}</td>
        <td class="px-2 py-1.5 text-right">${s.wins ?? '—'}</td>
        <td class="px-2 py-1.5 text-right">${s.losses ?? '—'}</td>
        <td class="px-2 py-1.5 text-right">${escapeHtml(s.era ?? '—')}</td>
        <td class="px-2 py-1.5 text-right">${s.games ?? '—'}</td>
        <td class="px-2 py-1.5 text-right">${s.games_started ?? '—'}</td>
        <td class="px-2 py-1.5 text-right">${s.saves ?? '—'}</td>
        <td class="px-2 py-1.5 text-right">${escapeHtml(s.innings_pitched ?? '—')}</td>
        <td class="px-2 py-1.5 text-right">${s.hits ?? '—'}</td>
        <td class="px-2 py-1.5 text-right">${s.earned_runs ?? '—'}</td>
        <td class="px-2 py-1.5 text-right">${s.walks ?? '—'}</td>
        <td class="px-2 py-1.5 text-right">${s.strikeouts ?? '—'}</td>
        <td class="px-2.5 py-1.5 text-right">${escapeHtml(s.whip ?? '—')}</td>
      </tr>
    `;
  };

  return `
    <div class="space-y-1.5">
      <div class="flex items-center justify-between">
        <h4 class="text-[11px] font-black uppercase tracking-[0.14em] text-ballred">Major League Pitching Record</h4>
        <span class="text-[10px] font-bold uppercase tracking-wider text-slate-500">Year-by-Year &amp; Career</span>
      </div>
      <div class="overflow-x-auto rounded-lg border-2 border-navy shadow-inner">
        <table class="w-full text-xs font-mono tabular-nums border-collapse">
          <thead>
            <tr class="bg-navy text-gold font-sans text-[11px] font-extrabold uppercase tracking-wider">
              <th class="px-2.5 py-1.5 text-left">YR</th>
              <th class="px-2 py-1.5 text-left">TEAM</th>
              <th class="px-2 py-1.5 text-right">W</th>
              <th class="px-2 py-1.5 text-right">L</th>
              <th class="px-2 py-1.5 text-right">ERA</th>
              <th class="px-2 py-1.5 text-right">G</th>
              <th class="px-2 py-1.5 text-right">GS</th>
              <th class="px-2 py-1.5 text-right">SV</th>
              <th class="px-2 py-1.5 text-right">IP</th>
              <th class="px-2 py-1.5 text-right">H</th>
              <th class="px-2 py-1.5 text-right">ER</th>
              <th class="px-2 py-1.5 text-right">BB</th>
              <th class="px-2 py-1.5 text-right">SO</th>
              <th class="px-2.5 py-1.5 text-right">WHIP</th>
            </tr>
          </thead>
          <tbody>
            ${yearlyRows.map((row, idx) => renderRow(String(row.season || seasonLabel || ''), row.team_abbr || 'MLB', row, false, idx)).join('')}
            ${careerRow ? renderRow('MLB TOTALS', '', careerRow, true, 0) : ''}
          </tbody>
        </table>
      </div>
    </div>
  `;
}

async function viewPlayerDetails(playerId) {
  const card = document.getElementById('player-detail-card');
  card.classList.remove('hidden');
  card.innerHTML = '<div class="text-sm text-slate-500 py-4">Loading player stats &amp; game log...</div>';

  try {
    const res = await fetch(`/api/players/${playerId}`);
    const data = await res.json();
    const p = data.player;
    const isFav = STATE.favoritePlayerIds.has(p.player_id);

    const isOhtani = p.player_id === 660271 || p.position === 'TWP' || /ohtani/i.test(p.full_name || '');
    const hittingTable = (!p.is_pitcher || isOhtani)
      ? buildHittingCardTable(
          p.year_by_year_hitting,
          p.hitting_stats,
          p.career_hitting_stats,
          p.season_used
        )
      : '';
    const pitchingTable = buildPitchingCardTable(
      p.year_by_year_pitching,
      p.pitching_stats,
      p.career_pitching_stats,
      p.season_used
    );

    let statsHtml = '';
    if (p.is_pitcher) {
      statsHtml = [pitchingTable, hittingTable].filter(Boolean).join('<div class="mt-4"></div>');
    } else {
      statsHtml = [hittingTable, pitchingTable].filter(Boolean).join('<div class="mt-4"></div>');
    }
    if (!statsHtml) {
      statsHtml = '<p class="text-sm text-slate-600">No MLB stats available for this player.</p>';
    }

    const vitals = [
      p.height ? `HT: <strong>${escapeHtml(p.height)}</strong>` : '',
      p.weight ? `WT: <strong>${escapeHtml(String(p.weight))} lbs</strong>` : '',
      `BATS: <strong>${escapeHtml(p.bats || '—')}</strong>`,
      `THROWS: <strong>${escapeHtml(p.throws || '—')}</strong>`,
      p.age ? `AGE: <strong>${p.age}</strong>` : '',
      p.mlb_debut_date ? `DEBUT: <strong>${escapeHtml(p.mlb_debut_date)}</strong>` : '',
    ].filter(Boolean).join(' <span class="text-amber-500">•</span> ');

    const logs = p.last_5_games || [];
    const isPitcherLog = Boolean(
      logs.length && (logs[0]?.stat?.inningsPitched !== undefined || logs[0]?.stat?.earnedRuns !== undefined)
    );
    const logsHtml = logs.length
      ? `<div class="pt-3 border-t border-amber-300/70">
           <h4 class="text-[11px] font-black uppercase tracking-[0.14em] text-ballred mb-2">Recent Game Log (Last 5 Games)</h4>
           <div class="overflow-x-auto rounded-lg border-2 border-navy shadow-inner">
             <table class="w-full text-xs font-mono tabular-nums border-collapse">
               <thead>
                 <tr class="bg-navy text-gold font-sans text-[11px] font-extrabold uppercase tracking-wider">
                   <th class="px-2.5 py-1.5 text-left">DATE</th>
                   <th class="px-2 py-1.5 text-left">OPP</th>
                   ${
                     isPitcherLog
                       ? `<th class="px-2 py-1.5 text-right">IP</th>
                          <th class="px-2 py-1.5 text-right">H</th>
                          <th class="px-2 py-1.5 text-right">R</th>
                          <th class="px-2 py-1.5 text-right">ER</th>
                          <th class="px-2 py-1.5 text-right">BB</th>
                          <th class="px-2 py-1.5 text-right">SO</th>
                          <th class="px-2.5 py-1.5 text-right">HR</th>`
                       : `<th class="px-2 py-1.5 text-right">AB</th>
                          <th class="px-2 py-1.5 text-right">R</th>
                          <th class="px-2 py-1.5 text-right">H</th>
                          <th class="px-2 py-1.5 text-right">2B</th>
                          <th class="px-2 py-1.5 text-right">3B</th>
                          <th class="px-2 py-1.5 text-right">HR</th>
                          <th class="px-2 py-1.5 text-right">RBI</th>
                          <th class="px-2 py-1.5 text-right">BB</th>
                          <th class="px-2 py-1.5 text-right">SB</th>
                          <th class="px-2.5 py-1.5 text-right">SO</th>`
                   }
                 </tr>
               </thead>
               <tbody>
                 ${logs
                   .map((g, idx) => {
                     const st = g.stat || {};
                     const rowBg = idx % 2 === 0 ? 'bg-[#fdf8ec]' : 'bg-[#f8f0dc]';
                     const hi = (val) => (Number(val) > 0 ? 'font-extrabold text-navy' : 'text-slate-600');
                     if (isPitcherLog) {
                       return `
                         <tr class="${rowBg} text-slate-800 border-t border-amber-200/80">
                           <td class="px-2.5 py-1.5 font-sans font-bold text-navy whitespace-nowrap">${escapeHtml(g.date)}</td>
                           <td class="px-2 py-1.5 font-sans font-semibold whitespace-nowrap">${escapeHtml(g.matchup)}</td>
                           <td class="px-2 py-1.5 text-right">${escapeHtml(st.inningsPitched ?? '0.0')}</td>
                           <td class="px-2 py-1.5 text-right">${st.hits ?? 0}</td>
                           <td class="px-2 py-1.5 text-right">${st.runs ?? 0}</td>
                           <td class="px-2 py-1.5 text-right">${st.earnedRuns ?? 0}</td>
                           <td class="px-2 py-1.5 text-right">${st.baseOnBalls ?? 0}</td>
                           <td class="px-2 py-1.5 text-right ${hi(st.strikeOuts)}">${st.strikeOuts ?? 0}</td>
                           <td class="px-2.5 py-1.5 text-right">${st.homeRuns ?? 0}</td>
                         </tr>
                       `;
                     }
                     return `
                       <tr class="${rowBg} text-slate-800 border-t border-amber-200/80">
                         <td class="px-2.5 py-1.5 font-sans font-bold text-navy whitespace-nowrap">${escapeHtml(g.date)}</td>
                         <td class="px-2 py-1.5 font-sans font-semibold whitespace-nowrap">${escapeHtml(g.matchup)}</td>
                         <td class="px-2 py-1.5 text-right">${st.atBats ?? 0}</td>
                         <td class="px-2 py-1.5 text-right ${hi(st.runs)}">${st.runs ?? 0}</td>
                         <td class="px-2 py-1.5 text-right ${hi(st.hits)}">${st.hits ?? 0}</td>
                         <td class="px-2 py-1.5 text-right ${hi(st.doubles)}">${st.doubles ?? 0}</td>
                         <td class="px-2 py-1.5 text-right ${hi(st.triples)}">${st.triples ?? 0}</td>
                         <td class="px-2 py-1.5 text-right ${hi(st.homeRuns)}">${st.homeRuns ?? 0}</td>
                         <td class="px-2 py-1.5 text-right ${hi(st.rbi)}">${st.rbi ?? 0}</td>
                         <td class="px-2 py-1.5 text-right ${hi(st.baseOnBalls)}">${st.baseOnBalls ?? 0}</td>
                         <td class="px-2 py-1.5 text-right ${hi(st.stolenBases)}">${st.stolenBases ?? 0}</td>
                         <td class="px-2.5 py-1.5 text-right">${st.strikeOuts ?? 0}</td>
                       </tr>
                     `;
                   })
                   .join('')}
               </tbody>
             </table>
           </div>
         </div>`
      : '';

    card.innerHTML = `
      <div class="bg-[#fdf8ec] border-2 border-navy rounded-2xl shadow-md overflow-hidden">
        <!-- Classic Baseball Card Back Header -->
        <div class="bg-navy text-white px-5 py-3.5 border-b-4 border-ballred flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div class="flex items-center gap-3.5">
            ${p.jersey_number ? `<div class="w-11 h-11 rounded-lg bg-gold text-navy font-black text-lg flex items-center justify-center shrink-0 shadow-sm">#${escapeHtml(p.jersey_number)}</div>` : ''}
            <div>
              <div class="flex items-center gap-2 flex-wrap">
                <h3 class="text-xl sm:text-2xl font-black uppercase tracking-wide text-white">${escapeHtml(p.full_name)}</h3>
                <span class="text-[10px] font-bold uppercase px-2 py-0.5 rounded-full ${p.active ? 'bg-turf text-white' : 'bg-slate-600 text-slate-100'}">${p.active ? 'Active' : 'Historical'}</span>
              </div>
              <p class="text-xs sm:text-sm text-gold font-bold uppercase tracking-wider">${escapeHtml(p.position_name)} • ${escapeHtml(p.team_name)}</p>
            </div>
          </div>

          <button onclick="${isFav ? `removeFavoritePlayer(${p.player_id})` : `addFavoritePlayer(${p.player_id})`}"
            class="px-4 py-2 rounded-xl text-xs sm:text-sm font-bold transition shadow-sm shrink-0 ${
              isFav
                ? 'bg-white/15 hover:bg-white/25 text-white border border-white/25'
                : 'bg-gold hover:bg-yellow-400 text-navy'
            }">
            ${isFav ? '⭐ In My MVPs (Remove)' : '☆ Add to My MVPs'}
          </button>
        </div>

        <!-- Vitals / Bio Strip -->
        <div class="bg-[#f4ebd4] border-b border-amber-300/80 px-5 py-2.5 flex items-center gap-3.5">
          <img src="${escapeHtml(p.headshot_url)}" alt="${escapeHtml(p.full_name)}"
            class="w-12 h-12 rounded-full object-cover bg-white border-2 border-navy shrink-0 shadow-sm" />
          <div class="text-xs text-navy leading-relaxed">${vitals}</div>
        </div>

        <!-- Card Back Stats & Game Log -->
        <div class="p-4 sm:p-5 space-y-4">
          ${statsHtml}
          ${logsHtml}
        </div>
      </div>
    `;
    card.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  } catch (err) {
    card.innerHTML = '<div class="text-sm text-ballred py-4">Could not load player details.</div>';
  }
}

function statBox(label, value) {
  return `
    <div class="bg-white border border-slate-200 rounded-xl p-2">
      <div class="text-[11px] font-bold text-slate-400 uppercase">${escapeHtml(label)}</div>
      <div class="text-sm sm:text-base font-extrabold text-navy">${escapeHtml(value ?? '—')}</div>
    </div>
  `;
}

async function addFavoritePlayer(playerId) {
  const res = await fetch('/api/favorites/players', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ player_id: playerId }),
  });
  if (res.ok) {
    const ids = getSavedMvpIds();
    ids.push(playerId);
    setSavedMvpIds(ids);
  }
  await loadFavorites();
  await viewPlayerDetails(playerId);
}

async function removeFavoritePlayer(playerId) {
  const res = await fetch(`/api/favorites/players/${playerId}`, { method: 'DELETE' });
  if (res.ok) {
    setSavedMvpIds(getSavedMvpIds().filter((id) => id !== playerId));
  }
  await loadFavorites();
  const card = document.getElementById('player-detail-card');
  if (!card.classList.contains('hidden')) {
    await viewPlayerDetails(playerId);
  }
}

// --- FEATURE 3: PLAYER NEWSFEED ---

async function loadNewsfeed() {
  const list = document.getElementById('newsfeed-list');
  const btn = document.getElementById('refresh-news-btn');
  if (btn) btn.textContent = '⏳ Loading...';
  list.innerHTML = '<div class="text-sm text-slate-500 py-6 text-center">Fetching MLB news &amp; highlights...</div>';

  try {
    const res = await fetch('/api/newsfeed', { cache: 'no-store' });
    const data = await res.json();
    STATE.newsItems = data.items || [];

    const teamPill = document.getElementById('news-team-pill-label');
    if (teamPill && data.team_short_name) {
      teamPill.textContent = data.team_short_name;
    }

    renderNewsfeed();
  } catch (err) {
    list.innerHTML = '<div class="text-sm text-ballred py-4 text-center">Could not load Baseball News. Please try again!</div>';
  } finally {
    if (btn) btn.textContent = '🔄 Refresh News';
  }
}

function filterNews(scope) {
  STATE.newsFilter = scope;
  document.querySelectorAll('.news-filter-btn').forEach((b) => {
    if (b.dataset.newsFilter === scope) {
      b.className = 'news-filter-btn px-3.5 py-1.5 rounded-full text-xs sm:text-sm font-bold bg-navy text-white transition';
    } else {
      b.className = 'news-filter-btn px-3.5 py-1.5 rounded-full text-xs sm:text-sm font-bold bg-slate-100 text-slate-700 hover:bg-slate-200 transition';
    }
  });
  renderNewsfeed();
}

function renderNewsfeed() {
  const list = document.getElementById('newsfeed-list');
  let items = STATE.newsItems;
  if (STATE.newsFilter === 'team') {
    items = STATE.newsItems.filter((i) => i.is_team && i.category === 'MLB News');
  } else if (STATE.newsFilter === 'mvp') {
    items = STATE.newsItems.filter((i) => i.is_mvp);
  } else {
    items = STATE.newsItems.filter((i) => i.category === 'MLB News');
  }

  if (!items.length) {
    const emptyMsg =
      STATE.newsFilter === 'mvp'
        ? 'No stories for your MVPs yet. Follow players in BPs & MVPs Tracker or switch to Phillies / MLB News!'
        : 'No stories from today in this filter right now. Try selecting MLB News!';
    list.innerHTML = `
      <div class="bg-slate-50 border border-dashed border-slate-300 rounded-xl p-6 text-center text-sm text-slate-500">
        ${emptyMsg}
      </div>
    `;
    return;
  }

  const badgeColors = {
    'Game Highlight': 'bg-turf/15 text-turf',
    'Roster Move': 'bg-gold-light text-navy',
    'MLB News': 'bg-blue-100 text-navy',
  };

  STATE.renderedNewsItems = items;

  list.innerHTML = items
    .map((item, idx) => {
      const catClass = badgeColors[item.category] || 'bg-slate-100 text-slate-700';
      const sourceName = item.source || 'MLB.com';
      const avatar = item.headshot_url
        ? `<img src="${escapeHtml(item.headshot_url)}" alt="${escapeHtml(item.player_name)}"
             class="w-12 h-12 rounded-full object-cover bg-slate-100 border-2 border-gold shrink-0" />`
        : `<div class="w-12 h-12 rounded-full bg-navy text-white flex items-center justify-center text-xl shrink-0">⚾</div>`;

      return `
        <article class="border border-slate-200 rounded-xl p-4 bg-white shadow-sm flex gap-3.5 items-start">
          ${avatar}
          <div class="flex-1 min-w-0">
            <div class="flex flex-wrap items-center gap-2 mb-1">
              <span class="text-[11px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-full ${catClass}">
                ${escapeHtml(item.category)}
              </span>
              <span class="text-[11px] font-bold px-2 py-0.5 rounded-full bg-slate-100 text-navy">
                ${escapeHtml(sourceName)}
              </span>
              <span class="text-xs text-slate-400">${formatTimestamp(item.published_at)}</span>
            </div>
            <h3 class="font-bold text-navy text-base leading-snug">${escapeHtml(item.title)}</h3>
            <p class="text-sm text-slate-600 mt-1 leading-relaxed">${escapeHtml(item.summary)}</p>
            <div class="mt-2.5">
              <button onclick="openArticleReader(${idx})"
                class="text-xs sm:text-sm font-bold text-ballred hover:text-ballred-light hover:underline inline-flex items-center gap-1">
                Read full story on ${escapeHtml(sourceName)} →
              </button>
            </div>
          </div>
        </article>
      `;
    })
    .join('');
}

async function openArticleReader(idx) {
  const item = (STATE.renderedNewsItems || [])[idx];
  if (!item) return;

  const modal = document.getElementById('article-reader-modal');
  const body = document.getElementById('reader-modal-body');
  const badge = document.getElementById('reader-source-badge');
  const subtitle = document.getElementById('reader-header-subtitle');
  const extLink = document.getElementById('reader-external-link');

  const sourceName = item.source || 'MLB.com';
  badge.textContent = sourceName;
  subtitle.textContent = item.player_name ? `${item.player_name} • ${item.category}` : item.category;
  extLink.href = item.url || '#';
  extLink.textContent = `Open on ${sourceName} ↗`;

  stopReaderAudio();
  STATE.readerPlainText = `${item.title}. ${item.summary || ''}`;

  body.innerHTML = `
    <h2 class="text-xl sm:text-2xl font-extrabold text-navy leading-snug">${escapeHtml(item.title)}</h2>
    <div class="text-sm text-slate-500 py-6 text-center">Loading full story in reader mode...</div>
  `;

  modal.classList.remove('hidden');
  document.body.classList.add('overflow-hidden');

  try {
    const res = await fetch(`/api/article?url=${encodeURIComponent(item.url)}`);
    if (!res.ok) throw new Error('Reader unavailable');
    const data = await res.json();

    const imgHtml = data.image_url
      ? `<img src="${escapeHtml(data.image_url)}" alt="${escapeHtml(data.title || item.title)}"
           class="w-full max-h-64 object-cover rounded-xl border border-slate-200" />`
      : '';

    const hasParagraphs = data.reader_available && data.paragraphs?.length;
    STATE.readerPlainText = hasParagraphs
      ? `${data.title || item.title}. ${data.paragraphs.join(' ')}`
      : `${item.title}. ${item.summary || ''}`;

    const paragraphsHtml = hasParagraphs
      ? data.paragraphs
          .map((p) => `<p class="text-base sm:text-[17px] leading-relaxed text-slate-700">${escapeHtml(p)}</p>`)
          .join('')
      : `<div class="bg-slate-50 border border-slate-200 rounded-xl p-4 space-y-2">
           <p class="text-base leading-relaxed text-slate-700">${escapeHtml(item.summary)}</p>
           <p class="text-xs text-slate-500">
             Full text preview is limited for this story on ${escapeHtml(sourceName)}. You can still tap
             <strong>Open on ${escapeHtml(sourceName)} ↗</strong> below if you'd like to view the original page.
           </p>
         </div>`;

    body.innerHTML = `
      <div class="space-y-4">
        <div class="text-xs font-semibold text-slate-400">${formatTimestamp(item.published_at)} • ${escapeHtml(sourceName)}</div>
        <h2 class="text-xl sm:text-2xl font-extrabold text-navy leading-snug">${escapeHtml(data.title || item.title)}</h2>
        ${imgHtml}
        <div class="space-y-3.5 pt-1">
          ${paragraphsHtml}
        </div>
      </div>
    `;
  } catch {
    STATE.readerPlainText = `${item.title}. ${item.summary || ''}`;
    body.innerHTML = `
      <div class="space-y-4">
        <h2 class="text-xl sm:text-2xl font-extrabold text-navy leading-snug">${escapeHtml(item.title)}</h2>
        <p class="text-base leading-relaxed text-slate-700">${escapeHtml(item.summary)}</p>
        <p class="text-xs text-slate-500">Could not load the full article in reader mode. Tap "Open on ${escapeHtml(sourceName)} ↗" below to view it directly.</p>
      </div>
    `;
  }
}

function setReaderTtsButton(state) {
  const btn = document.getElementById('reader-tts-btn');
  if (!btn) return;
  if (state === 'loading') {
    btn.disabled = true;
    btn.innerHTML = '<span>⏳</span><span>Loading Voice...</span>';
  } else if (state === 'playing') {
    btn.disabled = false;
    btn.className = 'px-3 py-1 rounded-lg bg-ballred hover:bg-ballred-light text-white text-xs sm:text-sm font-bold transition flex items-center gap-1';
    btn.innerHTML = '<span>⏹</span><span>Stop</span>';
  } else {
    btn.disabled = false;
    btn.className = 'px-3 py-1 rounded-lg bg-gold hover:bg-yellow-400 text-navy text-xs sm:text-sm font-bold transition flex items-center gap-1';
    btn.innerHTML = '<span>🔊</span><span>Read Aloud</span>';
  }
}

function stopReaderAudio() {
  stopAudioPlayer();
  if ('speechSynthesis' in window) {
    window.speechSynthesis.cancel();
  }
  setReaderTtsButton('idle');
}

async function toggleReaderAudio() {
  const player = document.getElementById('tts-audio-player');
  const isPlaying = Boolean(
    (player && !player.paused && player.currentTime > 0) ||
    STATE.currentAudio ||
    ('speechSynthesis' in window && window.speechSynthesis.speaking)
  );
  if (isPlaying) {
    stopReaderAudio();
    return;
  }

  const text = (STATE.readerPlainText || '').trim();
  if (!text) return;

  // Unlock iPad Safari audio synchronously inside tap gesture
  const unlockedPlayer = unlockAudioPlayer();
  setReaderTtsButton('loading');

  try {
    const res = await fetch('/api/tts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, voice: STATE.ttsVoice || 'Puck' }),
    });
    if (!res.ok) throw new Error(`TTS HTTP ${res.status}`);

    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    STATE.currentAudioUrl = url;
    STATE.currentAudio = unlockedPlayer;

    unlockedPlayer.src = url;
    unlockedPlayer.onended = () => stopReaderAudio();
    unlockedPlayer.onerror = () => stopReaderAudio();

    await unlockedPlayer.play();
    setReaderTtsButton('playing');
  } catch (err) {
    console.warn('Gemini TTS reader fallback to browser speech:', err);
    // Graceful fallback to browser SpeechSynthesis (preferring Enhanced/Siri English voices on iPad)
    if ('speechSynthesis' in window) {
      const utter = new SpeechSynthesisUtterance(text);
      const voices = window.speechSynthesis.getVoices() || [];
      const preferred =
        voices.find((v) => v.lang.startsWith('en') && /enhanced|premium|siri|natural/i.test(v.name)) ||
        voices.find((v) => v.lang.startsWith('en-US')) ||
        voices.find((v) => v.lang.startsWith('en'));
      if (preferred) utter.voice = preferred;
      utter.rate = 0.96;
      utter.onend = () => stopReaderAudio();
      utter.onerror = () => stopReaderAudio();
      window.speechSynthesis.speak(utter);
      setReaderTtsButton('playing');
    } else {
      setReaderTtsButton('idle');
    }
  }
}

function closeArticleReader() {
  stopReaderAudio();
  const modal = document.getElementById('article-reader-modal');
  modal.classList.add('hidden');
  document.body.classList.remove('overflow-hidden');
}

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    closeArticleReader();
    closeSettingsModal();
  }
});

// --- Boot ---
document.addEventListener('DOMContentLoaded', async () => {
  initVoiceControls();
  await initChat();
  await loadTeamsDropdown();
  await loadFavorites();
});
