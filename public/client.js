// NAGA ARENA - Phase 2 client.
// WebSocket client + Canvas renderer. Handles URL-shared rooms, mode/map
// selection (host), all items, status effects, teams, timer and mobile input.

(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const screens = {
    title: $('screen-title'), lobby: $('screen-lobby'),
    game: $('screen-game'), result: $('screen-result'),
    leaderboard: $('screen-leaderboard'), customize: $('screen-customize'),
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
  const spectatingEl = $('spectating');
  const tournamentBar = $('tournament-bar');
  const championEl = $('champion');
  const tournamentStandingsEl = $('tournament-standings');
  const resultTitle = $('result-title');
  const roomCodeEl = $('room-code');
  const playerList = $('player-list');
  const hostNote = $('host-note');

  const MODES = [
    { id: 'BATTLE_ROYALE', label: 'BATTLE ROYALE' },
    { id: 'SCORE_ATTACK', label: 'SCORE ATTACK' },
    { id: 'TEAM_BATTLE', label: 'TEAM BATTLE' },
    { id: 'RANKED', label: 'RANKED' },
    { id: 'TOURNAMENT', label: 'TOURNAMENT' },
  ];
  // Must match server SKIN_PATTERNS / SKIN_COLORS.
  const SKIN_PATTERNS = ['SOLID', 'STRIPES', 'GRADIENT', 'NEON', 'DASHED'];
  const SKIN_COLORS = [
    '#39ff14', '#ff2d55', '#0a84ff', '#ffd60a',
    '#bf5af2', '#ff9f0a', '#64d2ff', '#ff6482', '#ffffff', '#00e0c0',
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

  // ---- graphics state ----
  const particles = [];
  const smoothBodies = new Map(); // snake id -> [{x,y}] eased render positions
  const prevMeta = new Map();     // snake id -> { score, alive } for FX triggers
  let shakeT = 0, shakeMag = 0;   // screen-shake decay timer / magnitude
  let bgGradient = null;          // cached vignette, rebuilt on resize
  let lastFrame = Date.now();

  // Persistent identity for ratings (no account system).
  function loadPid() {
    let pid = localStorage.getItem('naga_pid');
    if (!pid) {
      pid = (crypto.randomUUID ? crypto.randomUUID() : 'p' + Math.random().toString(36).slice(2) + Date.now());
      localStorage.setItem('naga_pid', pid);
    }
    return pid;
  }
  const myPid = loadPid();
  let myRating = null;
  const nameInput = $('name-input');
  nameInput.value = localStorage.getItem('naga_name') || '';
  function myName() { return (nameInput.value || '').trim(); }

  // Skin selection, persisted locally.
  function loadSkin() {
    try {
      const s = JSON.parse(localStorage.getItem('naga_skin'));
      if (s && SKIN_PATTERNS.includes(s.pattern)) {
        return { pattern: s.pattern, color: SKIN_COLORS.includes(s.color) ? s.color : SKIN_COLORS[0] };
      }
    } catch { /* ignore */ }
    return { pattern: 'SOLID', color: SKIN_COLORS[0] };
  }
  let mySkin = loadSkin();
  function saveSkin() { localStorage.setItem('naga_skin', JSON.stringify(mySkin)); }

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
        myRating = msg.you || null;
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

  // ---- Sound engine (procedural WebAudio, no asset files) ----
  const sound = (() => {
    let ctx = null;
    let muted = localStorage.getItem('naga_muted') === '1';
    const ensure = () => {
      if (!ctx) { try { ctx = new (window.AudioContext || window.webkitAudioContext)(); } catch { ctx = null; } }
      if (ctx && ctx.state === 'suspended') ctx.resume();
      return ctx;
    };
    function tone(freq, dur, type = 'square', gain = 0.07, slideTo = null) {
      if (muted) return;
      const ac = ensure(); if (!ac) return;
      const osc = ac.createOscillator(), g = ac.createGain();
      osc.type = type; osc.frequency.setValueAtTime(freq, ac.currentTime);
      if (slideTo) osc.frequency.exponentialRampToValueAtTime(slideTo, ac.currentTime + dur);
      g.gain.setValueAtTime(gain, ac.currentTime);
      g.gain.exponentialRampToValueAtTime(0.0001, ac.currentTime + dur);
      osc.connect(g); g.connect(ac.destination);
      osc.start(); osc.stop(ac.currentTime + dur);
    }
    const seq = (notes) => notes.forEach((n, i) => setTimeout(() => tone(n.f, n.d || 0.12, n.t || 'square', 0.07, n.s), i * 90));
    return {
      isMuted: () => muted,
      toggle() { muted = !muted; localStorage.setItem('naga_muted', muted ? '1' : '0'); if (!muted) ensure(); return muted; },
      resume: ensure,
      eat() { tone(660, 0.08, 'square', 0.05); },
      pickup() { seq([{ f: 520 }, { f: 780 }]); },
      kill() { tone(300, 0.25, 'sawtooth', 0.08, 120); },
      death() { tone(200, 0.45, 'sawtooth', 0.09, 70); },
      beep() { tone(440, 0.1, 'sine', 0.08); },
      go() { tone(880, 0.2, 'sine', 0.09); },
      win() { seq([{ f: 523, t: 'sine' }, { f: 659, t: 'sine' }, { f: 784, t: 'sine' }, { f: 1047, t: 'sine', d: 0.25 }]); },
      lose() { seq([{ f: 392, t: 'triangle' }, { f: 311, t: 'triangle', d: 0.3 }]); },
    };
  })();

  const btnSound = $('btn-sound');
  if (sound.isMuted()) btnSound.textContent = 'SOUND: OFF';
  btnSound.addEventListener('click', () => {
    const muted = sound.toggle();
    btnSound.textContent = muted ? 'SOUND: OFF' : 'SOUND: ON';
  });

  // ---- Customize UI ----
  function buildCustomize() {
    const pRow = $('pattern-options'), cRow = $('color-options');
    pRow.innerHTML = ''; cRow.innerHTML = '';
    for (const p of SKIN_PATTERNS) {
      const b = document.createElement('button');
      b.className = 'opt'; b.dataset.pattern = p; b.textContent = p;
      b.addEventListener('click', () => { mySkin.pattern = p; saveSkin(); refreshCustomize(); });
      pRow.appendChild(b);
    }
    for (const c of SKIN_COLORS) {
      const b = document.createElement('button');
      b.className = 'swatch-btn'; b.dataset.color = c; b.style.background = c;
      b.addEventListener('click', () => { mySkin.color = c; saveSkin(); refreshCustomize(); });
      cRow.appendChild(b);
    }
  }
  function refreshCustomize() {
    document.querySelectorAll('#pattern-options .opt').forEach((b) => b.classList.toggle('selected', b.dataset.pattern === mySkin.pattern));
    document.querySelectorAll('#color-options .swatch-btn').forEach((b) => b.classList.toggle('selected', b.dataset.color === mySkin.color));
    drawSkinPreview();
  }
  function drawSkinPreview() {
    const pc = $('skin-preview'), g = pc.getContext('2d');
    g.clearRect(0, 0, pc.width, pc.height);
    const cs = 24, n = 11;
    const body = [];
    for (let i = 0; i < n; i++) body.push({ x: n - i, y: 1 }); // head at the right
    renderSnake(g, body, mySkin, cs, { glow: mySkin.pattern === 'NEON', head: true, dir: { x: 1, y: 0 } });
  }
  buildCustomize();
  $('btn-customize').addEventListener('click', () => { showScreen('customize'); refreshCustomize(); });
  $('btn-customize-back').addEventListener('click', () => showScreen('title'));

  // ---- Enter / lobby controls ----
  $('btn-enter').addEventListener('click', () => {
    localStorage.setItem('naga_name', myName());
    sound.resume(); // unlock audio on the first user gesture
    send({ type: 'join', room: roomFromUrl(), mode: 'BATTLE_ROYALE', map: 'VOID', pid: myPid, name: myName(), skin: mySkin });
  });

  // ---- Leaderboard ----
  async function showLeaderboard() {
    showScreen('leaderboard');
    const list = $('lb-list'), empty = $('lb-empty');
    list.innerHTML = ''; empty.textContent = 'Loading...';
    try {
      const res = await fetch('/api/leaderboard');
      const data = await res.json();
      const rows = data.leaderboard || [];
      if (!rows.length) { empty.textContent = 'No ranked matches played yet.'; return; }
      empty.textContent = '';
      list.innerHTML = rows.map((r) => `
        <li>
          <span class="rank">${r.rank}</span>
          <span class="pname">${esc(r.name)}</span>
          <span class="tier">${esc(r.tier)}</span>
          <span class="stats">${r.wins}W / ${r.losses}L</span>
          <span class="final">${r.rating}</span>
        </li>`).join('');
    } catch { empty.textContent = 'Could not load leaderboard.'; }
  }
  $('btn-leaderboard').addEventListener('click', showLeaderboard);
  $('btn-lb-back').addEventListener('click', () => showScreen('title'));

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
    if (ev.killer === myId && ev.victim !== myId) sound.kill();
  }

  // Sound-effect detection from state diffs.
  let prevScore = 0, prevEffects = {}, prevAlive = false, prevCountdown = 0;
  function detectSounds(state) {
    const me = state.snakes.find((s) => s.id === myId);
    if (state.phase === 'COUNTDOWN' && state.countdown !== prevCountdown) {
      if (state.countdown > 0) sound.beep();
      prevCountdown = state.countdown;
    }
    if (state.phase === 'PLAYING' && me) {
      if (prevPhase === 'COUNTDOWN') sound.go();
      if (me.score > prevScore) sound.eat();
      const fx = me.effects || {};
      if ((fx.speed && !prevEffects.speed) || (fx.shield && !prevEffects.shield) || (fx.ghost && !prevEffects.ghost)) sound.pickup();
      if (prevAlive && !me.alive) sound.death();
      prevScore = me.score; prevEffects = { ...fx }; prevAlive = me.alive;
    } else if (state.phase !== 'PLAYING') {
      prevScore = me ? me.score : 0; prevEffects = (me && me.effects) || {}; prevAlive = me ? me.alive : false;
    }
    if (state.phase === 'RESULT' && prevPhase !== 'RESULT' && me) {
      const r = (state.results || []).find((x) => x.id === myId);
      if (r && r.rank === 1) sound.win(); else sound.lose();
    }
    if (state.phase === 'COUNTDOWN' && prevPhase !== 'COUNTDOWN') prevCountdown = 0;
  }

  // ---- state ----
  function onState(state) {
    detectSounds(state);
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
    const myr = $('my-rating');
    if (myRating && myRating.rating != null) {
      myr.classList.remove('hidden');
      myr.innerHTML = `${esc(myRating.tier)} &middot; <b>${myRating.rating}</b>`;
    } else { myr.classList.add('hidden'); }

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
    const t = state.tournament;

    if (state.teamTotals) {
      const { RED, BLUE } = state.teamTotals;
      const winner = RED === BLUE ? 'DRAW' : (RED > BLUE ? 'RED' : 'BLUE');
      teamResultEl.classList.remove('hidden');
      teamResultEl.innerHTML = `<span style="color:#ff3b5c">RED ${RED}</span> &nbsp;vs&nbsp; <span style="color:#2d7dff">BLUE ${BLUE}</span><br>` +
        (winner === 'DRAW' ? 'DRAW' : `${winner} WINS`);
    } else { teamResultEl.classList.add('hidden'); }

    // Tournament: round vs final standings / champion.
    const finished = t && !t.active;
    resultTitle.textContent = t ? (finished ? 'TOURNAMENT OVER' : `ROUND ${t.round} / ${t.rounds}`) : 'RESULT';
    if (t && finished && t.champion) {
      championEl.classList.remove('hidden');
      championEl.innerHTML = `<span class="swatch" style="background:${t.champion.color}"></span> CHAMPION: ${esc(t.champion.name)} (${t.champion.points} pts)`;
    } else { championEl.classList.add('hidden'); }
    if (t) {
      tournamentStandingsEl.classList.remove('hidden');
      tournamentStandingsEl.innerHTML = '<div class="ts-title">STANDINGS</div>' + t.standings.map((row) => `
        <div class="ts-row ${row.id === myId ? 'me' : ''}">
          <span class="ts-place">${row.place}</span>
          <span class="swatch" style="background:${row.color}"></span>
          <span class="pname">${esc(row.name)}</span>
          <span class="ts-pts">${row.points} pts</span>
        </div>`).join('');
    } else { tournamentStandingsEl.classList.add('hidden'); }

    resultList.innerHTML = '';
    for (const r of state.results) {
      const li = document.createElement('li');
      li.className = `rank-${r.rank}`;
      const me = r.id === myId ? ' (YOU)' : '';
      let ratingHtml = '';
      if (r.rating) {
        const d = r.rating.delta;
        const cls = d >= 0 ? 'up' : 'down';
        ratingHtml = `<span class="rating ${cls}">${d >= 0 ? '+' : ''}${d} &rarr; ${r.rating.after} <small>${esc(r.rating.tier)}</small></span>`;
      }
      const ptsHtml = (r.roundPoints != null) ? `<span class="rating up">+${r.roundPoints} pt</span>` : '';
      li.innerHTML = `<span class="rank">${r.rank}</span>
        <span class="swatch" style="background:${r.color}"></span>
        <span class="pname">${esc(r.name)}${me}</span>
        <span class="stats">food ${r.foodCount} / kills ${r.kills}</span>
        ${ratingHtml}${ptsHtml}
        <span class="final">${r.score}</span>`;
      resultList.appendChild(li);
    }
    resultCountdown.textContent = t && t.active ? 'Next round starting...' : 'Returning to lobby...';
  }

  function resizeCanvas(map) {
    const maxW = Math.min(window.innerWidth - 12, 1100);
    const maxH = window.innerHeight - 12;
    cell = Math.max(6, Math.floor(Math.min(maxW / map.w, maxH / map.h)));
    canvas.width = map.w * cell;
    canvas.height = map.h * cell;
    const g = ctx.createRadialGradient(
      canvas.width / 2, canvas.height / 2, canvas.height * 0.2,
      canvas.width / 2, canvas.height / 2, canvas.height * 0.75);
    g.addColorStop(0, 'rgba(0,0,0,0)');
    g.addColorStop(1, 'rgba(0,0,0,0.55)');
    bgGradient = g;
  }

  // ---- render loop ----
  function draw() {
    requestAnimationFrame(draw);
    const now = Date.now();
    const dt = Math.min(2, (now - lastFrame) / 16.67); // frames elapsed (capped)
    lastFrame = now;
    if (!lastState) return;
    const state = lastState;
    if (state.phase !== 'PLAYING' && state.phase !== 'COUNTDOWN') return;
    const map = state.map;

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    // Background.
    ctx.fillStyle = '#060912';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    triggerSnakeFx(state); // eat sparkles / death bursts from state diffs

    ctx.save();
    if (shakeT > 0) {
      shakeT -= dt;
      const m = shakeMag * Math.max(0, shakeT);
      ctx.translate((Math.random() - 0.5) * m, (Math.random() - 0.5) * m);
    }

    drawGrid(map, now);
    drawWalls(map, now);
    for (const it of state.items) drawItem(it, now);
    for (const s of state.snakes) drawSnake(s, map);
    updateDrawParticles(dt);

    ctx.restore();
    if (bgGradient) { ctx.fillStyle = bgGradient; ctx.fillRect(0, 0, canvas.width, canvas.height); }

    // Countdown overlay.
    if (state.phase === 'COUNTDOWN' && state.countdown > 0) { countdownEl.classList.remove('hidden'); countdownEl.textContent = state.countdown; }
    else countdownEl.classList.add('hidden');

    // Spectating overlay.
    const mine = state.snakes.find((s) => s.id === myId);
    const spectating = state.phase === 'PLAYING' && mine && (mine.spectating || !mine.alive);
    spectatingEl.classList.toggle('hidden', !spectating);
    if (spectating) spectatingEl.textContent = mine.spectating ? 'SPECTATING (next round)' : 'SPECTATING';

    // Tournament progress bar.
    if (state.tournament) {
      tournamentBar.classList.remove('hidden');
      const t = state.tournament;
      tournamentBar.textContent = `TOURNAMENT  ROUND ${Math.min(t.round + 1, t.rounds)} / ${t.rounds}`;
    } else { tournamentBar.classList.add('hidden'); }

    renderHud(state);
  }

  function drawGrid(map, now) {
    ctx.lineWidth = 1;
    ctx.strokeStyle = 'rgba(40,60,96,0.35)';
    ctx.beginPath();
    for (let x = 0; x <= map.w; x++) { ctx.moveTo(x * cell + 0.5, 0); ctx.lineTo(x * cell + 0.5, canvas.height); }
    for (let y = 0; y <= map.h; y++) { ctx.moveTo(0, y * cell + 0.5); ctx.lineTo(canvas.width, y * cell + 0.5); }
    ctx.stroke();
    if (map.tunnel) {
      const a = 0.4 + 0.3 * Math.sin(now / 300);
      ctx.strokeStyle = `rgba(100,210,255,${a})`;
      ctx.setLineDash([8, 6]); ctx.lineWidth = 3;
      ctx.strokeRect(1.5, 1.5, canvas.width - 3, canvas.height - 3);
      ctx.setLineDash([]);
    }
  }

  function drawWalls(map, now) {
    for (const w of map.walls) {
      ctx.fillStyle = '#26344f';
      roundRect(w.x * cell, w.y * cell, cell, cell, Math.max(2, cell * 0.18));
      ctx.fillStyle = 'rgba(90,120,170,0.5)'; // top-left bevel
      roundRect(w.x * cell + cell * 0.12, w.y * cell + cell * 0.12, cell * 0.45, cell * 0.45, 2);
    }
    const pulse = 0.5 + 0.5 * Math.sin(now / 220);
    for (const w of (map.dynamic || [])) {
      ctx.shadowColor = '#ff9f0a'; ctx.shadowBlur = cell * 0.6;
      ctx.fillStyle = `rgba(255,159,10,${0.5 + 0.4 * pulse})`;
      roundRect(w.x * cell + 1, w.y * cell + 1, cell - 2, cell - 2, Math.max(2, cell * 0.2));
      ctx.shadowBlur = 0;
    }
  }

  function drawItem(it, now) {
    const style = ITEM_STYLE[it.type] || ITEM_STYLE.FOOD;
    const cx = it.x * cell + cell / 2, cy = it.y * cell + cell / 2;
    const pulse = 0.5 + 0.5 * Math.sin(now / 200 + it.id);
    ctx.shadowColor = style.color;
    ctx.shadowBlur = cell * (0.4 + 0.4 * pulse);
    if (it.type === 'FOOD') {
      const r = cell * (0.3 + 0.05 * pulse);
      const grad = ctx.createRadialGradient(cx - r * 0.3, cy - r * 0.3, r * 0.1, cx, cy, r);
      grad.addColorStop(0, '#ffd0d6'); grad.addColorStop(1, style.color);
      ctx.fillStyle = grad;
      ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.fill();
    } else {
      // Spinning rounded badge with a glow and a letter.
      ctx.save();
      ctx.translate(cx, cy);
      ctx.rotate(Math.sin(now / 600 + it.id) * 0.25);
      ctx.fillStyle = style.color;
      roundRect(-cell * 0.36, -cell * 0.36, cell * 0.72, cell * 0.72, cell * 0.18);
      ctx.shadowBlur = 0;
      ctx.fillStyle = '#05060a';
      ctx.font = `bold ${Math.max(8, Math.floor(cell * 0.55))}px monospace`;
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      if (style.label) ctx.fillText(style.label, 0, 1);
      ctx.restore();
    }
    ctx.shadowBlur = 0;
  }

  // Ease the rendered body toward the authoritative one for smooth motion.
  function smoothBody(s, map) {
    const target = s.body;
    let arr = smoothBodies.get(s.id);
    if (!arr || !s.alive || arr.length === 0) {
      arr = target.map((p) => ({ x: p.x, y: p.y }));
      smoothBodies.set(s.id, arr);
      return arr;
    }
    while (arr.length < target.length) arr.push({ ...arr[arr.length - 1] });
    if (arr.length > target.length) arr.length = target.length;
    const k = 0.4;
    for (let i = 0; i < target.length; i++) {
      const t = target[i], a = arr[i];
      let dx = t.x - a.x, dy = t.y - a.y;
      if (map.tunnel) {
        if (dx > map.w / 2) dx -= map.w; else if (dx < -map.w / 2) dx += map.w;
        if (dy > map.h / 2) dy -= map.h; else if (dy < -map.h / 2) dy += map.h;
      }
      if (Math.abs(dx) > 2.2 || Math.abs(dy) > 2.2) { a.x = t.x; a.y = t.y; }
      else {
        a.x += dx * k; a.y += dy * k;
        if (map.tunnel) { a.x = (a.x + map.w) % map.w; a.y = (a.y + map.h) % map.h; }
      }
    }
    return arr;
  }

  function drawSnake(s, map) {
    if (!s.body || s.body.length === 0) { smoothBodies.delete(s.id); return; }
    const fx = s.effects || {};
    const pts = smoothBody(s, map);
    ctx.globalAlpha = s.alive ? (fx.ghost ? 0.5 : 1) : 0.28;
    const effSkin = {
      pattern: (s.alive && !fx.frozen) ? ((s.skin && s.skin.pattern) || 'SOLID') : 'SOLID',
      color: !s.alive ? '#7a8296' : (fx.frozen ? '#9fe8ff' : s.color),
    };
    const glow = s.alive && (effSkin.pattern === 'NEON' || fx.speed || fx.shield);
    renderSnake(ctx, pts, effSkin, cell, { glow, head: s.alive });
    ctx.globalAlpha = 1;
    if (!s.alive) return;
    const head = pts[0];
    const hx = head.x * cell + cell / 2, hy = head.y * cell + cell / 2;
    if (fx.shield) { ctx.strokeStyle = 'rgba(10,132,255,0.9)'; ctx.lineWidth = 2.5; ctx.beginPath(); ctx.arc(hx, hy, cell * 0.66, 0, Math.PI * 2); ctx.stroke(); }
    if (fx.speed) { ctx.strokeStyle = 'rgba(100,210,255,0.7)'; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(hx, hy, cell * 0.54, 0, Math.PI * 2); ctx.stroke(); }
  }

  // Connected snake renderer with eyes and glow. `pts` are cell coordinates.
  function renderSnake(g, pts, skin, cellSize, opts) {
    opts = opts || {};
    const pattern = (skin && skin.pattern) || 'SOLID';
    const color = (skin && skin.color) || '#39ff14';
    const w = cellSize * 0.78;
    const C = (p) => ({ x: p.x * cellSize + cellSize / 2, y: p.y * cellSize + cellSize / 2 });

    // Split the body into runs, breaking at large gaps (tunnel wrap).
    const runs = []; let run = [pts[0]];
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1], b = pts[i];
      if (Math.abs(a.x - b.x) + Math.abs(a.y - b.y) > 1.8) { runs.push(run); run = [b]; }
      else run.push(b);
    }
    runs.push(run);

    g.lineCap = 'round'; g.lineJoin = 'round';
    if (opts.glow) { g.shadowColor = color; g.shadowBlur = cellSize * 0.85; }
    for (const r of runs) {
      if (r.length === 1) {
        const c = C(r[0]); g.fillStyle = color; g.beginPath(); g.arc(c.x, c.y, w / 2, 0, Math.PI * 2); g.fill();
        continue;
      }
      let stroke = color;
      if (pattern === 'GRADIENT') {
        const h = C(r[0]), t = C(r[r.length - 1]);
        const grad = g.createLinearGradient(h.x, h.y, t.x, t.y);
        grad.addColorStop(0, color); grad.addColorStop(1, shade(color, 0.35));
        stroke = grad;
      }
      g.setLineDash(pattern === 'DASHED' ? [cellSize * 0.7, cellSize * 0.45] : []);
      g.strokeStyle = stroke; g.lineWidth = w;
      g.beginPath();
      const p0 = C(r[0]); g.moveTo(p0.x, p0.y);
      for (let i = 1; i < r.length; i++) { const c = C(r[i]); g.lineTo(c.x, c.y); }
      g.stroke();
      g.setLineDash([]);
      if (pattern === 'STRIPES') {
        g.fillStyle = shade(color, 0.5);
        for (let i = 1; i < r.length; i += 2) { const c = C(r[i]); g.beginPath(); g.arc(c.x, c.y, w * 0.34, 0, Math.PI * 2); g.fill(); }
      }
    }
    g.shadowBlur = 0;

    if (opts.head === false) return;
    // Head + eyes.
    const head = C(pts[0]);
    if (opts.glow) { g.shadowColor = color; g.shadowBlur = cellSize * 0.85; }
    g.fillStyle = color; g.beginPath(); g.arc(head.x, head.y, w * 0.62, 0, Math.PI * 2); g.fill();
    g.shadowBlur = 0;
    let dx = (opts.dir && opts.dir.x) || 1, dy = (opts.dir && opts.dir.y) || 0;
    if (pts.length > 1) {
      const ddx = pts[0].x - pts[1].x, ddy = pts[0].y - pts[1].y;
      if (Math.abs(ddx) <= 1.8 && Math.abs(ddy) <= 1.8 && (ddx || ddy)) { dx = ddx; dy = ddy; }
    }
    const len = Math.hypot(dx, dy) || 1; dx /= len; dy /= len;
    const px = -dy, py = dx, eo = w * 0.26, ef = w * 0.16;
    for (const sgn of [1, -1]) {
      const ex = head.x + dx * ef + px * eo * sgn, ey = head.y + dy * ef + py * eo * sgn;
      g.fillStyle = '#ffffff'; g.beginPath(); g.arc(ex, ey, Math.max(1.2, w * 0.17), 0, Math.PI * 2); g.fill();
      g.fillStyle = '#05060a'; g.beginPath(); g.arc(ex + dx * ef * 0.5, ey + dy * ef * 0.5, Math.max(0.8, w * 0.09), 0, Math.PI * 2); g.fill();
    }
  }

  // ---- particles ----
  function spawnBurst(px, py, color, count, spd, sizeBase) {
    for (let i = 0; i < count; i++) {
      const a = Math.random() * Math.PI * 2, s = spd * (0.4 + Math.random() * 0.7);
      particles.push({ x: px, y: py, vx: Math.cos(a) * s, vy: Math.sin(a) * s, life: 1, decay: 0.02 + Math.random() * 0.03, color, size: sizeBase * (0.5 + Math.random() * 0.6) });
    }
    if (particles.length > 400) particles.splice(0, particles.length - 400);
  }
  function updateDrawParticles(dt) {
    for (let i = particles.length - 1; i >= 0; i--) {
      const p = particles[i];
      p.x += p.vx * dt; p.y += p.vy * dt; p.vx *= 0.92; p.vy *= 0.92; p.life -= p.decay * dt;
      if (p.life <= 0) { particles.splice(i, 1); continue; }
      ctx.globalAlpha = Math.max(0, p.life);
      ctx.fillStyle = p.color; ctx.shadowColor = p.color; ctx.shadowBlur = 6;
      ctx.beginPath(); ctx.arc(p.x, p.y, Math.max(0.5, p.size * p.life), 0, Math.PI * 2); ctx.fill();
    }
    ctx.globalAlpha = 1; ctx.shadowBlur = 0;
  }
  function triggerSnakeFx(state) {
    for (const s of state.snakes) {
      const prev = prevMeta.get(s.id);
      const head = (smoothBodies.get(s.id) || s.body)[0] || s.body[0];
      if (head && prev) {
        const hx = head.x * cell + cell / 2, hy = head.y * cell + cell / 2;
        if (s.score > prev.score) spawnBurst(hx, hy, '#ffe07a', 6, cell * 0.18, cell * 0.16);
        if (prev.alive && !s.alive) {
          spawnBurst(hx, hy, s.color, 22, cell * 0.4, cell * 0.24);
          if (s.id === myId) { shakeT = 16; shakeMag = cell * 0.5; }
        }
      }
      prevMeta.set(s.id, { score: s.score, alive: s.alive });
    }
  }

  // Darken (<1) or lighten (>1) a #rrggbb colour; non-hex passes through.
  function shade(hex, factor) {
    if (typeof hex !== 'string' || hex[0] !== '#' || hex.length !== 7) return hex;
    const n = parseInt(hex.slice(1), 16);
    const r = Math.min(255, Math.round(((n >> 16) & 255) * factor));
    const gg = Math.min(255, Math.round(((n >> 8) & 255) * factor));
    const b = Math.min(255, Math.round((n & 255) * factor));
    return `rgb(${r},${gg},${b})`;
  }

  function roundRectOn(g, x, y, w, h, r) {
    if (w <= 0 || h <= 0) return;
    r = Math.min(r, w / 2, h / 2);
    g.beginPath();
    g.moveTo(x + r, y);
    g.arcTo(x + w, y, x + w, y + h, r);
    g.arcTo(x + w, y + h, x, y + h, r);
    g.arcTo(x, y + h, x, y, r);
    g.arcTo(x, y, x + w, y, r);
    g.closePath(); g.fill();
  }
  function roundRect(x, y, w, h, r) { roundRectOn(ctx, x, y, w, h, r); }

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
