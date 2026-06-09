// NAGA ARENA - Phase 2 client.
// WebSocket client + Canvas renderer. Handles URL-shared rooms, mode/map
// selection (host), all items, status effects, teams, timer and mobile input.

(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const screens = {
    title: $('screen-title'), lobby: $('screen-lobby'),
    game: $('screen-game'), result: $('screen-result'),
  };
  const connStatus = $('conn-status');
  const canvas = $('board');
  const ctx = canvas.getContext('2d');
  const countdownEl = $('countdown');
  const scoreboardEl = $('scoreboard');
  const killlogEl = $('killlog');
  const timerEl = $('timer');
  const resultList = $('result-list');
  const teamResultEl = $('team-result');
  const resultCountdown = $('result-countdown');
  const touchControls = $('touch-controls');
  const roomCodeEl = $('room-code');
  const playerList = $('player-list');
  const hostNote = $('host-note');

  const MODES = [
    { id: 'BATTLE_ROYALE', label: 'BATTLE ROYALE' },
    { id: 'SCORE_ATTACK', label: 'SCORE ATTACK' },
    { id: 'TEAM_BATTLE', label: 'TEAM BATTLE' },
  ];
  const MAPS = [
    { id: 'VOID', label: 'VOID' }, { id: 'LABYRINTH', label: 'LABYRINTH' },
    { id: 'TUNNEL', label: 'TUNNEL' }, { id: 'ARENA', label: 'ARENA' },
  ];
  // type -> { color, label } for item rendering.
  const ITEM_STYLE = {
    FOOD: { color: '#ff465a', label: '' },
    SUPER_FOOD: { color: '#ffd60a', label: 'S' },
    SPEED_UP: { color: '#64d2ff', label: '>' },
    SHRINK: { color: '#bf5af2', label: '-' },
    SHIELD: { color: '#0a84ff', label: 'O' },
    FREEZE_BOMB: { color: '#9fe8ff', label: '*' },
    GHOST: { color: '#e8f0ff', label: 'G' },
  };

  const KEY_DIR = {
    ArrowUp: 'UP', KeyW: 'UP', ArrowDown: 'DOWN', KeyS: 'DOWN',
    ArrowLeft: 'LEFT', KeyA: 'LEFT', ArrowRight: 'RIGHT', KeyD: 'RIGHT',
  };

  let ws = null, myId = null, ready = false, isHost = false;
  let lastState = null, killFeed = [], cell = 16, prevPhase = null;
  const isTouch = ('ontouchstart' in window) || navigator.maxTouchPoints > 0;

  function showScreen(name) {
    for (const [k, el] of Object.entries(screens)) el.classList.toggle('active', k === name);
  }

  function roomFromUrl() {
    const m = new URLSearchParams(location.search).get('room');
    return m ? m.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8) : '';
  }

  function connect() {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    ws = new WebSocket(`${proto}://${location.host}`);
    ws.onopen = () => { connStatus.textContent = 'Connected. Press ENTER ARENA.'; };
    ws.onclose = () => { connStatus.textContent = 'Disconnected. Reconnecting...'; setTimeout(connect, 1500); };
    ws.onerror = () => { connStatus.textContent = 'Connection error.'; };
    ws.onmessage = (ev) => { let m; try { m = JSON.parse(ev.data); } catch { return; } handle(m); };
  }

  function send(obj) { if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj)); }

  function handle(msg) {
    switch (msg.type) {
      case 'welcome':
        myId = msg.id; isHost = !!msg.isHost;
        setRoomCode(msg.room);
        showScreen('lobby');
        break;
      case 'state': onState(msg.state); break;
      case 'event': if (msg.event && msg.event.type === 'KILL') onKill(msg.event); break;
      default: break;
    }
  }

  function setRoomCode(code) {
    roomCodeEl.textContent = code;
    const url = new URL(location.href);
    url.searchParams.set('room', code);
    history.replaceState(null, '', url.toString());
  }

  // ---- Enter / lobby controls ----
  $('btn-enter').addEventListener('click', () => {
    send({ type: 'join', room: roomFromUrl(), mode: 'BATTLE_ROYALE', map: 'VOID' });
  });

  $('btn-copy').addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(location.href); $('btn-copy').textContent = 'Copied!'; }
    catch { $('btn-copy').textContent = location.href; }
    setTimeout(() => { $('btn-copy').textContent = 'Copy invite link'; }, 1500);
  });

  function buildOptions() {
    const modeRow = $('mode-options'), mapRow = $('map-options');
    modeRow.innerHTML = ''; mapRow.innerHTML = '';
    for (const m of MODES) {
      const b = document.createElement('button');
      b.className = 'opt'; b.dataset.mode = m.id; b.textContent = m.label;
      b.addEventListener('click', () => { if (isHost) send({ type: 'config', mode: m.id }); });
      modeRow.appendChild(b);
    }
    for (const m of MAPS) {
      const b = document.createElement('button');
      b.className = 'opt'; b.dataset.map = m.id; b.textContent = m.label;
      b.addEventListener('click', () => { if (isHost) send({ type: 'config', map: m.id }); });
      mapRow.appendChild(b);
    }
  }
  buildOptions();

  $('btn-ready').addEventListener('click', () => {
    ready = !ready;
    $('btn-ready').classList.toggle('ready-on', ready);
    $('btn-ready').textContent = ready ? 'READY (waiting...)' : 'READY';
    send({ type: 'ready', ready });
  });

  // ---- input ----
  function sendDir(dir) { send({ type: 'input', dir }); }
  document.addEventListener('keydown', (e) => {
    const dir = KEY_DIR[e.code];
    if (dir && lastState && lastState.phase === 'PLAYING') { sendDir(dir); e.preventDefault(); }
  });
  touchControls.querySelectorAll('.dpad').forEach((b) => {
    const fire = (e) => { e.preventDefault(); sendDir(b.dataset.dir); };
    b.addEventListener('touchstart', fire, { passive: false });
    b.addEventListener('mousedown', fire);
  });
  let touchStart = null;
  canvas.addEventListener('touchstart', (e) => { touchStart = { x: e.touches[0].clientX, y: e.touches[0].clientY }; }, { passive: true });
  canvas.addEventListener('touchend', (e) => {
    if (!touchStart) return;
    const t = e.changedTouches[0], dx = t.clientX - touchStart.x, dy = t.clientY - touchStart.y;
    if (Math.abs(dx) < 20 && Math.abs(dy) < 20) return;
    if (Math.abs(dx) > Math.abs(dy)) sendDir(dx > 0 ? 'RIGHT' : 'LEFT');
    else sendDir(dy > 0 ? 'DOWN' : 'UP');
    touchStart = null;
  }, { passive: true });

  function onKill(ev) {
    const snakes = lastState ? lastState.snakes : [];
    const nameOf = (id) => { const s = snakes.find((x) => x.id === id); return s ? s.name : '???'; };
    killFeed.unshift(ev.killer ? `${nameOf(ev.killer)} x ${nameOf(ev.victim)}` : `${nameOf(ev.victim)} crashed`);
    killFeed = killFeed.slice(0, 5);
  }

  // ---- state ----
  function onState(state) {
    lastState = state;
    isHost = state.hostId === myId;

    if (state.phase === 'LOBBY') { showScreen('lobby'); renderLobby(state); }
    else if (state.phase === 'COUNTDOWN' || state.phase === 'PLAYING') {
      showScreen('game');
      if (isTouch) touchControls.classList.remove('hidden');
    } else if (state.phase === 'RESULT') { showScreen('result'); renderResult(state); }

    if (state.phase !== prevPhase) {
      if (state.phase === 'COUNTDOWN' || state.phase === 'PLAYING') resizeCanvas(state.map);
      if (state.phase !== 'PLAYING' && state.phase !== 'COUNTDOWN') killFeed = [];
      prevPhase = state.phase;
    }
  }

  function renderLobby(state) {
    // Highlight selected mode/map; enable only for host.
    document.querySelectorAll('#mode-options .opt').forEach((b) => {
      b.classList.toggle('selected', b.dataset.mode === state.mode);
      b.classList.toggle('disabled', !isHost);
    });
    document.querySelectorAll('#map-options .opt').forEach((b) => {
      b.classList.toggle('selected', b.dataset.map === state.map.id);
      b.classList.toggle('disabled', !isHost);
    });
    hostNote.textContent = isHost ? 'You are the host: pick mode & map.' : 'Only the host can change mode & map.';

    playerList.innerHTML = '';
    for (const s of state.snakes) {
      const li = document.createElement('li');
      const me = s.id === myId ? ' (YOU)' : '';
      const host = s.id === state.hostId ? '<span class="tag-host">HOST</span>' : '';
      li.innerHTML = `<span class="swatch" style="background:${s.color}"></span>
        <span class="pname">${esc(s.name)}${me} ${host}</span>
        <span class="ready-tag ${s.ready ? 'on' : ''}">${s.ready ? 'READY' : 'waiting'}</span>`;
      playerList.appendChild(li);
    }
  }

  function renderResult(state) {
    if (!state.results) return;
    if (state.teamTotals) {
      const { RED, BLUE } = state.teamTotals;
      const winner = RED === BLUE ? 'DRAW' : (RED > BLUE ? 'RED' : 'BLUE');
      teamResultEl.classList.remove('hidden');
      teamResultEl.innerHTML = `<span style="color:#ff3b5c">RED ${RED}</span> &nbsp;vs&nbsp; <span style="color:#2d7dff">BLUE ${BLUE}</span><br>` +
        (winner === 'DRAW' ? 'DRAW' : `${winner} WINS`);
    } else { teamResultEl.classList.add('hidden'); }

    resultList.innerHTML = '';
    for (const r of state.results) {
      const li = document.createElement('li');
      li.className = `rank-${r.rank}`;
      const me = r.id === myId ? ' (YOU)' : '';
      li.innerHTML = `<span class="rank">${r.rank}</span>
        <span class="swatch" style="background:${r.color}"></span>
        <span class="pname">${esc(r.name)}${me}</span>
        <span class="stats">food ${r.foodCount} / kills ${r.kills}</span>
        <span class="final">${r.score}</span>`;
      resultList.appendChild(li);
    }
    resultCountdown.textContent = 'Returning to lobby...';
  }

  function resizeCanvas(map) {
    const maxW = Math.min(window.innerWidth - 12, 1100);
    const maxH = window.innerHeight - 12;
    cell = Math.max(6, Math.floor(Math.min(maxW / map.w, maxH / map.h)));
    canvas.width = map.w * cell;
    canvas.height = map.h * cell;
  }

  // ---- render loop ----
  function draw() {
    requestAnimationFrame(draw);
    if (!lastState) return;
    const state = lastState;
    if (state.phase !== 'PLAYING' && state.phase !== 'COUNTDOWN') return;
    const map = state.map;

    ctx.fillStyle = '#070b14';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    // Grid.
    ctx.strokeStyle = 'rgba(28,40,64,0.5)';
    ctx.lineWidth = 1;
    for (let x = 0; x <= map.w; x++) { ctx.beginPath(); ctx.moveTo(x * cell + 0.5, 0); ctx.lineTo(x * cell + 0.5, canvas.height); ctx.stroke(); }
    for (let y = 0; y <= map.h; y++) { ctx.beginPath(); ctx.moveTo(0, y * cell + 0.5); ctx.lineTo(canvas.width, y * cell + 0.5); ctx.stroke(); }

    // Tunnel edge hint.
    if (map.tunnel) {
      ctx.strokeStyle = 'rgba(100,210,255,0.6)';
      ctx.setLineDash([6, 6]); ctx.lineWidth = 2;
      ctx.strokeRect(1, 1, canvas.width - 2, canvas.height - 2);
      ctx.setLineDash([]);
    }

    // Static + dynamic walls.
    ctx.fillStyle = '#243250';
    for (const w of map.walls) fillCell(w.x, w.y, 0);
    const pulse = 0.5 + 0.5 * Math.sin(Date.now() / 250);
    ctx.fillStyle = `rgba(255,159,10,${0.5 + 0.4 * pulse})`;
    for (const w of (map.dynamic || [])) fillCell(w.x, w.y, 0);

    // Items.
    for (const it of state.items) drawItem(it);

    // Snakes.
    for (const s of state.snakes) drawSnake(s);

    // Countdown overlay.
    if (state.phase === 'COUNTDOWN' && state.countdown > 0) { countdownEl.classList.remove('hidden'); countdownEl.textContent = state.countdown; }
    else countdownEl.classList.add('hidden');

    renderHud(state);
  }

  function fillCell(x, y, pad) { ctx.fillRect(x * cell + pad, y * cell + pad, cell - pad * 2, cell - pad * 2); }

  function drawItem(it) {
    const style = ITEM_STYLE[it.type] || ITEM_STYLE.FOOD;
    const cx = it.x * cell + cell / 2, cy = it.y * cell + cell / 2, r = cell / 2 - cell * 0.15;
    const pulse = 0.6 + 0.4 * Math.sin(Date.now() / 200 + it.id);
    ctx.fillStyle = style.color;
    ctx.globalAlpha = it.type === 'FOOD' ? 0.7 + 0.3 * pulse : 0.85;
    if (it.type === 'FOOD') {
      ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.fill();
    } else {
      // Rounded square badge with a letter.
      roundRect(it.x * cell + 2, it.y * cell + 2, cell - 4, cell - 4, 3);
      ctx.globalAlpha = 1;
      ctx.fillStyle = '#05060a';
      ctx.font = `bold ${Math.max(8, Math.floor(cell * 0.6))}px monospace`;
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      if (style.label) ctx.fillText(style.label, cx, cy + 0.5);
    }
    ctx.globalAlpha = 1;
  }

  function drawSnake(s) {
    if (!s.body || s.body.length === 0) return;
    const fx = s.effects || {};
    ctx.globalAlpha = s.alive ? (fx.ghost ? 0.45 : 1) : 0.3;
    const base = s.alive ? s.color : 'rgba(120,130,150,0.6)';
    for (let i = 0; i < s.body.length; i++) {
      const seg = s.body[i];
      ctx.fillStyle = fx.frozen ? '#9fe8ff' : base;
      const pad = i === 0 ? 0.5 : 1.5;
      roundRect(seg.x * cell + pad, seg.y * cell + pad, cell - pad * 2, cell - pad * 2, 3);
    }
    ctx.globalAlpha = 1;
    if (!s.alive) return;
    const head = s.body[0];
    const hx = head.x * cell + cell / 2, hy = head.y * cell + cell / 2;
    // Effect outlines.
    if (fx.shield) { ctx.strokeStyle = '#0a84ff'; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(hx, hy, cell * 0.6, 0, Math.PI * 2); ctx.stroke(); }
    if (fx.speed) { ctx.strokeStyle = '#64d2ff'; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(hx, hy, cell * 0.5, 0, Math.PI * 2); ctx.stroke(); }
    // Head dot.
    ctx.fillStyle = '#ffffff'; ctx.globalAlpha = 0.85;
    ctx.beginPath(); ctx.arc(hx, hy, Math.max(1.5, cell * 0.12), 0, Math.PI * 2); ctx.fill();
    ctx.globalAlpha = 1;
  }

  function roundRect(x, y, w, h, r) {
    if (w <= 0 || h <= 0) return;
    r = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath(); ctx.fill();
  }

  function renderHud(state) {
    const sorted = [...state.snakes].sort((a, b) => b.score - a.score);
    const fxLabel = (fx) => [fx.speed ? '>' : '', fx.shield ? 'O' : '', fx.ghost ? 'G' : '', fx.frozen ? '*' : ''].join('');
    scoreboardEl.innerHTML = sorted.map((s) => `
      <div class="row ${s.alive ? '' : 'dead'}">
        <span class="swatch" style="background:${s.color};width:12px;height:12px"></span>
        <span>${esc(s.name)}${s.id === myId ? ' (YOU)' : ''}</span>
        <span class="fx">${fxLabel(s.effects || {})}</span>
        <span class="sc">${s.score}</span>
      </div>`).join('');

    if (state.timeLeft > 0) {
      timerEl.classList.remove('hidden');
      const mm = Math.floor(state.timeLeft / 60), ss = String(state.timeLeft % 60).padStart(2, '0');
      let html = `${mm}:${ss}`;
      if (state.teamTotals) html += `<div class="teamline"><span style="color:#ff3b5c">${state.teamTotals.RED}</span><span style="color:#2d7dff">${state.teamTotals.BLUE}</span></div>`;
      timerEl.innerHTML = html;
      timerEl.classList.toggle('warn', state.timeLeft <= 30);
    } else { timerEl.classList.add('hidden'); }

    killlogEl.innerHTML = killFeed.map((t) => `<div>${esc(t)}</div>`).join('');
  }

  function esc(str) {
    return String(str).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  setInterval(() => send({ type: 'ping', ts: Date.now() }), 5000);
  window.addEventListener('resize', () => { if (lastState && lastState.map) resizeCanvas(lastState.map); });

  showScreen('title');
  connect();
  requestAnimationFrame(draw);
})();
