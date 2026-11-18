const STATE = {
  activeTab: 'chat',
  sessionId: localStorage.getItem('bp_active_session_id') || null,
  autoRefreshTimer: null,
  favoritePlayerIds: new Set(),
  newsItems: [],
  newsFilter: 'All',
};

const WELCOME_MESSAGE =
  "Hey slugger! Welcome to **BP’s BPs and MVPs**! I’m your Dugout Coach. " +
  "Ask me anything about baseball—MLB players, live scores, team standings, rules, or hitting and pitching tips. " +
  "Step up to the plate and fire away! ⚾";

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

  if (tab === 'tracker') {
    loadFavorites();
  } else if (tab === 'news') {
    loadNewsfeed();
  }
}

// --- FEATURE 1: DUGOUT CHAT ---

async function initChat() {
  await refreshSessionDropdown();
  if (!STATE.sessionId) {
    await startNewChat(false);
  } else {
    await loadChatMessages(STATE.sessionId);
  }
}

async function refreshSessionDropdown() {
  try {
    const res = await fetch('/api/chat/sessions');
    const data = await res.json();
    const select = document.getElementById('chat-session-select');
    select.innerHTML = '';

    const sessions = data.sessions || [];
    if (!sessions.length) {
      const opt = document.createElement('option');
      opt.value = '';
      opt.textContent = 'Current Dugout Chat';
      select.appendChild(opt);
      return;
    }

    if (!STATE.sessionId) {
      STATE.sessionId = sessions[0].id;
      localStorage.setItem('bp_active_session_id', STATE.sessionId);
    }

    for (const s of sessions) {
      const opt = document.createElement('option');
      opt.value = s.id;
      opt.textContent = s.title || 'Dugout Chat';
      if (s.id === STATE.sessionId) opt.selected = true;
      select.appendChild(opt);
    }
  } catch (err) {
    console.error('Failed to load sessions', err);
  }
}

async function startNewChat(refreshDropdown = true) {
  try {
    const res = await fetch('/api/chat/sessions', { method: 'POST' });
    const data = await res.json();
    STATE.sessionId = data.session.id;
    localStorage.setItem('bp_active_session_id', STATE.sessionId);
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
    const res = await fetch(`/api/chat/sessions/${encodeURIComponent(sessionId)}/messages`);
    const data = await res.json();
    renderChatMessages(data.messages || []);
  } catch (err) {
    console.error('Failed to load messages', err);
    renderChatMessages([]);
  }
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
    bubble.innerHTML = `
      <div class="flex items-center gap-1.5 mb-1">
        <span class="text-xs font-extrabold uppercase tracking-wider text-ballred">Dugout Coach</span>
      </div>
      <div class="leading-relaxed">${formatSimpleMarkdown(content)}</div>
    `;
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

async function sendChatMessage(msg) {
  const btn = document.getElementById('chat-send-btn');
  const input = document.getElementById('chat-input');
  btn.disabled = true;
  input.disabled = true;

  appendMessageBubble('user', msg);
  showTypingIndicator();

  try {
    const res = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ session_id: STATE.sessionId, message: msg }),
    });
    const data = await res.json();
    removeTypingIndicator();

    if (data.session_id) {
      STATE.sessionId = data.session_id;
      localStorage.setItem('bp_active_session_id', STATE.sessionId);
    }
    appendMessageBubble('assistant', data.reply || 'Let’s talk baseball!');
    await refreshSessionDropdown();
  } catch (err) {
    removeTypingIndicator();
    appendMessageBubble('assistant', 'Oops! Could not reach the dugout server. Please try again!');
  } finally {
    btn.disabled = false;
    input.disabled = false;
    input.focus();
  }
}

// --- FEATURE 2: BPs & MVPs TRACKER ---

async function loadTeamsDropdown() {
  try {
    const res = await fetch('/api/teams');
    const data = await res.json();
    const select = document.getElementById('favorite-team-select');
    const current = select.value;
    select.innerHTML = '<option value="">— Choose a Favorite Team —</option>';
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

async function handleFavoriteTeamChange() {
  const select = document.getElementById('favorite-team-select');
  const val = select.value;
  if (!val) {
    await fetch('/api/favorites/team', { method: 'DELETE' });
    await loadFavorites();
    return;
  }
  await fetch('/api/favorites/team', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ team_id: parseInt(val, 10) }),
  });
  await loadFavorites();
}

function toggleAutoRefresh() {
  const checked = document.getElementById('auto-refresh-toggle').checked;
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

async function loadFavorites(showSpinner = false) {
  const btn = document.getElementById('refresh-live-btn');
  if (showSpinner && btn) btn.textContent = '⏳ Refreshing...';

  try {
    const res = await fetch('/api/favorites');
    const data = await res.json();

    const favPlayers = data.favorite_players || [];
    STATE.favoritePlayerIds = new Set(favPlayers.map((p) => p.player_id));

    // Sync team dropdown
    const favTeam = data.favorite_team;
    const select = document.getElementById('favorite-team-select');
    if (favTeam && select) {
      select.value = String(favTeam.team_id);
      document.getElementById('favorite-team-badge').innerHTML =
        `<span class="font-semibold text-navy">Following:</span> ${escapeHtml(favTeam.team_name)}`;
    } else if (select) {
      document.getElementById('favorite-team-badge').textContent =
        'Pick a team to see today’s live game, next matchup, and last final score!';
    }

    renderTeamLiveCard(favTeam, data.team_live_status);
    renderFavoritePlayersGrid(favPlayers);
  } catch (err) {
    console.error('Failed to load favorites', err);
  } finally {
    if (btn) btn.innerHTML = '<span>🔄</span><span>Refresh Live Stats</span>';
  }
}

function renderTeamLiveCard(favTeam, liveStatus) {
  const card = document.getElementById('team-live-card');
  if (!favTeam) {
    card.innerHTML = `
      <div class="text-center py-4">
        <p class="text-sm text-slate-300">Select your favorite MLB team on the left to see live game updates, next scheduled game, and recent scores!</p>
      </div>
    `;
    return;
  }

  const todayGame = liveStatus?.today_game;
  const nextGame = liveStatus?.next_game;
  const lastFinal = liveStatus?.last_final_game;

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

    card.innerHTML = `
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
    `;
    return;
  }

  // No game today -> show next scheduled game & most recent final score
  card.innerHTML = `
    <div class="flex items-center justify-between mb-2">
      <span class="text-xs font-bold uppercase tracking-wider px-2.5 py-0.5 rounded-full bg-white/15 text-gold">
        ${escapeHtml(favTeam.team_name)} • Off Day / Offseason
      </span>
    </div>
    <div class="grid grid-cols-1 sm:grid-cols-2 gap-3 text-sm">
      <div class="bg-white/10 rounded-lg p-3">
        <div class="text-xs uppercase tracking-wider text-slate-300 font-bold mb-1">Next Scheduled Game</div>
        ${
          nextGame
            ? `<div class="font-semibold">${escapeHtml(nextGame.away_team)} @ ${escapeHtml(nextGame.home_team)}</div>
               <div class="text-xs text-slate-300 mt-0.5">${escapeHtml(nextGame.game_date)} • ${escapeHtml(nextGame.venue || '')}</div>`
            : `<div class="text-xs text-slate-300">No upcoming games on the schedule right now.</div>`
        }
      </div>
      <div class="bg-white/10 rounded-lg p-3">
        <div class="text-xs uppercase tracking-wider text-slate-300 font-bold mb-1">Most Recent Final</div>
        ${
          lastFinal
            ? `<div class="font-semibold">${escapeHtml(lastFinal.away_team)} ${lastFinal.away_score ?? 0} – ${lastFinal.home_score ?? 0} ${escapeHtml(lastFinal.home_team)}</div>
               <div class="text-xs text-slate-300 mt-0.5">Final • ${escapeHtml(lastFinal.game_date)}</div>`
            : `<div class="text-xs text-slate-300">No recent final game in the last 10 days.</div>`
        }
      </div>
    </div>
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
      const h = p.hitting_stats;
      const pit = p.pitching_stats;
      let statSummary = '<span class="text-xs text-slate-400">Stats unavailable</span>';
      if (p.is_pitcher && pit) {
        statSummary = `
          <div class="grid grid-cols-3 gap-1 text-center bg-slate-50 rounded-lg p-2 mt-2 text-xs">
            <div><div class="text-slate-400">ERA</div><div class="font-bold text-navy">${escapeHtml(pit.era)}</div></div>
            <div><div class="text-slate-400">W-L</div><div class="font-bold text-navy">${escapeHtml(pit.w_l)}</div></div>
            <div><div class="text-slate-400">K</div><div class="font-bold text-navy">${pit.strikeouts}</div></div>
          </div>
        `;
      } else if (h) {
        statSummary = `
          <div class="grid grid-cols-3 gap-1 text-center bg-slate-50 rounded-lg p-2 mt-2 text-xs">
            <div><div class="text-slate-400">AVG</div><div class="font-bold text-navy">${escapeHtml(h.avg)}</div></div>
            <div><div class="text-slate-400">HR</div><div class="font-bold text-navy">${h.hr}</div></div>
            <div><div class="text-slate-400">RBI</div><div class="font-bold text-navy">${h.rbi}</div></div>
          </div>
        `;
      }

      return `
        <div class="border border-slate-200 rounded-xl p-4 bg-white shadow-sm flex flex-col justify-between">
          <div class="flex items-center gap-3">
            <img src="${escapeHtml(p.headshot_url)}" alt="${escapeHtml(p.full_name)}"
              class="w-14 h-14 rounded-full object-cover bg-slate-100 border-2 border-gold shrink-0" />
            <div class="min-w-0 flex-1">
              <h4 class="font-bold text-navy truncate">${escapeHtml(p.full_name)}</h4>
              <p class="text-xs text-slate-500 truncate">${escapeHtml(p.position || '')} • ${escapeHtml(p.team_name || 'MLB')}</p>
            </div>
          </div>
          ${statSummary}
          <div class="flex items-center justify-between gap-2 mt-3 pt-2 border-t border-slate-100">
            <button onclick="viewPlayerDetails(${p.player_id})"
              class="text-xs font-semibold text-navy hover:underline">View Full Card</button>
            <button onclick="removeFavoritePlayer(${p.player_id})"
              class="text-xs font-semibold text-ballred hover:underline">Remove</button>
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

async function viewPlayerDetails(playerId) {
  const card = document.getElementById('player-detail-card');
  card.classList.remove('hidden');
  card.innerHTML = '<div class="text-sm text-slate-500 py-4">Loading player stats &amp; game log...</div>';

  try {
    const res = await fetch(`/api/players/${playerId}`);
    const data = await res.json();
    const p = data.player;
    const isFav = STATE.favoritePlayerIds.has(p.player_id);

    const h = p.hitting_stats;
    const pit = p.pitching_stats;

    let statsHtml = '';
    if (h) {
      statsHtml += `
        <div>
          <h4 class="text-xs font-bold uppercase tracking-wider text-slate-500 mb-2">
            Hitting Stats (${escapeHtml(h.season || p.season_used || '')})
          </h4>
          <div class="grid grid-cols-4 sm:grid-cols-7 gap-2 text-center">
            ${statBox('AVG', h.avg)}
            ${statBox('OBP', h.obp)}
            ${statBox('SLG', h.slg)}
            ${statBox('OPS', h.ops)}
            ${statBox('HR', h.hr)}
            ${statBox('RBI', h.rbi)}
            ${statBox('SB', h.sb)}
          </div>
        </div>
      `;
    }
    if (pit) {
      statsHtml += `
        <div class="mt-4">
          <h4 class="text-xs font-bold uppercase tracking-wider text-slate-500 mb-2">
            Pitching Stats (${escapeHtml(pit.season || p.season_used || '')})
          </h4>
          <div class="grid grid-cols-3 sm:grid-cols-5 gap-2 text-center">
            ${statBox('ERA', pit.era)}
            ${statBox('WHIP', pit.whip)}
            ${statBox('K', pit.strikeouts)}
            ${statBox('IP', pit.innings_pitched)}
            ${statBox('W-L', pit.w_l)}
          </div>
        </div>
      `;
    }
    if (!h && !pit) {
      statsHtml = '<p class="text-sm text-slate-500">No season stats available for this player.</p>';
    }

    const logs = p.last_5_games || [];
    const logsHtml = logs.length
      ? `<div class="mt-4">
           <h4 class="text-xs font-bold uppercase tracking-wider text-slate-500 mb-2">Last 5 Games</h4>
           <div class="space-y-1.5">
             ${logs
               .map(
                 (g) => `
               <div class="flex flex-wrap items-center justify-between gap-2 text-xs sm:text-sm bg-slate-50 rounded-lg px-3 py-2 border border-slate-100">
                 <span class="font-semibold text-navy">${escapeHtml(g.date)} • ${escapeHtml(g.matchup)}</span>
                 <span class="font-medium text-slate-700">${escapeHtml(g.summary)}</span>
               </div>
             `
               )
               .join('')}
           </div>
         </div>`
      : '';

    card.innerHTML = `
      <div class="bg-slate-50/70 border border-slate-200 rounded-2xl p-5 space-y-4">
        <div class="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div class="flex items-center gap-4">
            <img src="${escapeHtml(p.headshot_url)}" alt="${escapeHtml(p.full_name)}"
              class="w-20 h-20 rounded-full object-cover bg-white border-4 border-gold shadow-sm shrink-0" />
            <div>
              <div class="flex items-center gap-2 flex-wrap">
                <h3 class="text-2xl font-extrabold text-navy">${escapeHtml(p.full_name)}</h3>
                ${p.jersey_number ? `<span class="text-sm font-bold px-2 py-0.5 rounded bg-navy text-white">#${escapeHtml(p.jersey_number)}</span>` : ''}
              </div>
              <p class="text-sm text-slate-600 font-medium">${escapeHtml(p.position_name)} • ${escapeHtml(p.team_name)}</p>
              <p class="text-xs text-slate-500 mt-0.5">
                Bats/Throws: <strong>${escapeHtml(p.bats)}/${escapeHtml(p.throws)}</strong>
                ${p.age ? ` • Age: <strong>${p.age}</strong>` : ''}
              </p>
            </div>
          </div>

          <button onclick="${isFav ? `removeFavoritePlayer(${p.player_id})` : `addFavoritePlayer(${p.player_id})`}"
            class="px-4 py-2 rounded-xl text-sm font-bold transition shadow-sm shrink-0 ${
              isFav
                ? 'bg-slate-200 hover:bg-slate-300 text-slate-800'
                : 'bg-gold hover:bg-yellow-400 text-navy'
            }">
            ${isFav ? '⭐ In My MVPs (Remove)' : '☆ Add to My MVPs'}
          </button>
        </div>

        ${statsHtml}
        ${logsHtml}
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
  await fetch('/api/favorites/players', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ player_id: playerId }),
  });
  await loadFavorites();
  await viewPlayerDetails(playerId);
}

async function removeFavoritePlayer(playerId) {
  await fetch(`/api/favorites/players/${playerId}`, { method: 'DELETE' });
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
  list.innerHTML = '<div class="text-sm text-slate-500 py-6 text-center">Fetching kid-safe MLB news &amp; highlights...</div>';

  try {
    const res = await fetch('/api/newsfeed');
    const data = await res.json();
    STATE.newsItems = data.items || [];

    if (!data.has_favorites) {
      list.innerHTML = `
        <div class="bg-slate-50 border border-dashed border-slate-300 rounded-xl p-6 text-center text-sm text-slate-600">
          ${escapeHtml(data.message)}
        </div>
      `;
      return;
    }

    renderNewsfeed();
  } catch (err) {
    list.innerHTML = '<div class="text-sm text-ballred py-4 text-center">Could not load newsfeed. Please try again!</div>';
  } finally {
    if (btn) btn.textContent = '🔄 Refresh Newsfeed';
  }
}

function filterNews(category) {
  STATE.newsFilter = category;
  document.querySelectorAll('.news-filter-btn').forEach((b) => {
    if (b.dataset.newsFilter === category) {
      b.className = 'news-filter-btn px-3 py-1 rounded-full text-xs font-bold bg-navy text-white transition';
    } else {
      b.className = 'news-filter-btn px-3 py-1 rounded-full text-xs font-bold bg-slate-100 text-slate-700 hover:bg-slate-200 transition';
    }
  });
  renderNewsfeed();
}

function renderNewsfeed() {
  const list = document.getElementById('newsfeed-list');
  const items =
    STATE.newsFilter === 'All'
      ? STATE.newsItems
      : STATE.newsItems.filter((i) => i.category === STATE.newsFilter);

  if (!items.length) {
    list.innerHTML = `
      <div class="bg-slate-50 border border-dashed border-slate-300 rounded-xl p-6 text-center text-sm text-slate-500">
        No stories in this category right now. Try selecting "All" or follow more players!
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

    const paragraphsHtml =
      data.reader_available && data.paragraphs?.length
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
    body.innerHTML = `
      <div class="space-y-4">
        <h2 class="text-xl sm:text-2xl font-extrabold text-navy leading-snug">${escapeHtml(item.title)}</h2>
        <p class="text-base leading-relaxed text-slate-700">${escapeHtml(item.summary)}</p>
        <p class="text-xs text-slate-500">Could not load the full article in reader mode. Tap "Open on ${escapeHtml(sourceName)} ↗" below to view it directly.</p>
      </div>
    `;
  }
}

function closeArticleReader() {
  const modal = document.getElementById('article-reader-modal');
  modal.classList.add('hidden');
  document.body.classList.remove('overflow-hidden');
}

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    closeArticleReader();
  }
});

// --- Boot ---
document.addEventListener('DOMContentLoaded', async () => {
  await initChat();
  await loadTeamsDropdown();
  await loadFavorites();
});
