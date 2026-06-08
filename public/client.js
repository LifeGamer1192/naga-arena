// NAGA ARENA - Phase 1 MVP client.
// Connects to the game server over WebSocket, renders the authoritative
// state on a Canvas, and sends direction/ready inputs.

(() => {
  'use strict';

  const screens = {
    title: document.getElementById('screen-title'),
    lobby: document.getElementById('screen-lobby'),
    game: document.getElementById('screen-game'),
    result: document.getElementById('screen-result'),
  };
  const connStatus = document.getElementById('conn-status');
  const btnEnter = document.getElementById('btn-enter');
  const btnReady = document.getElementById('btn-ready');
  const playerList = document.getElementById('player-list');
  const canvas = document.getElementById('board');
  const ctx = canvas.getContext('2d');
  const countdownEl = document.getElementById('countdown');
  const scoreboardEl = document.getElementById('scoreboard');
  const killlogEl = document.getElementById('killlog');
  const resultList = document.getElementById('result-list');
  const resultCountdown = document.getElementById('result-countdown');
  const touchControls = document.getElementById('touch-controls');

  const KEY_DIR = {
    ArrowUp: 'UP', KeyW: 'UP',
    ArrowDown: 'DOWN', KeyS: 'DOWN',
    ArrowLeft: 'LEFT', KeyA: 'LEFT',
    ArrowRight: 'RIGHT', KeyD: 'RIGHT',
  };

  let ws = null;
  let myId = null;
  let ready = false;
  let entered = false;
  let lastState = null;
  let killFeed = [];
  let cell = 16;
  const isTouch = ('ontouchstart' in window) || navigator.maxTouchPoints > 0;

  function showScreen(name) {
    for (const [k, el] of Object.entries(screens)) {
      el.classList.toggle('active', k === name);
    }
  }

  function connect() {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    ws = new WebSocket(`${proto}://${location.host}`);

    ws.onopen = () => {
      connStatus.textContent = '接続OK — ENTER ARENA を押してください';
    };
    ws.onclose = () => {
      connStatus.textContent = '切断されました。再接続中…';
      setTimeout(connect, 1500);
    };
    ws.onerror = () => {
      connStatus.textContent = '接続エラー';
    };
    ws.onmessage = (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      handleMessage(msg);
    };
  }

  function handleMessage(msg) {
    switch (msg.type) {
      case 'welcome':
        myId = msg.id;
        break;
      case 'state':
        onState(msg.state);
        break;
      case 'event':
        if (msg.event && msg.event.type === 'KILL') onKill(msg.event);
        break;
      case 'result':
        // Result rendering is driven by state.phase === RESULT.
        break;
      default:
        break;
    }
  }

  function send(obj) {
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
  }

  // --- input ---
  function sendDir(dir) {
    send({ type: 'input', dir });
  }

  document.addEventListener('keydown', (e) => {
    const dir = KEY_DIR[e.code];
    if (dir && lastState && lastState.phase === 'PLAYING') {
      sendDir(dir);
      e.preventDefault();
    }
  });

  touchControls.querySelectorAll('.dpad').forEach((b) => {
    const fire = (e) => { e.preventDefault(); sendDir(b.dataset.dir); };
    b.addEventListener('touchstart', fire, { passive: false });
    b.addEventListener('mousedown', fire);
  });

  // Swipe support on the canvas.
  let touchStart = null;
  canvas.addEventListener('touchstart', (e) => {
    touchStart = { x: e.touches[0].clientX, y: e.touches[0].clientY };
  }, { passive: true });
  canvas.addEventListener('touchend', (e) => {
    if (!touchStart) return;
    const t = e.changedTouches[0];
    const dx = t.clientX - touchStart.x;
    const dy = t.clientY - touchStart.y;
    if (Math.abs(dx) < 20 && Math.abs(dy) < 20) return;
    if (Math.abs(dx) > Math.abs(dy)) sendDir(dx > 0 ? 'RIGHT' : 'LEFT');
    else sendDir(dy > 0 ? 'DOWN' : 'UP');
    touchStart = null;
  }, { passive: true });

  btnEnter.addEventListener('click', () => {
    entered = true;
    showScreen('lobby');
  });

  btnReady.addEventListener('click', () => {
    ready = !ready;
    btnReady.classList.toggle('ready-on', ready);
    btnReady.textContent = ready ? 'READY ✓ (待機中…)' : 'READY';
    send({ type: 'ready', ready });
  });

  function onKill(ev) {
    const snakes = lastState ? lastState.snakes : [];
    const nameOf = (id) => {
      const s = snakes.find((x) => x.id === id);
      return s ? s.name : '???';
    };
    const text = ev.killer
      ? `${nameOf(ev.killer)} ☠ ${nameOf(ev.victim)}`
      : `${nameOf(ev.victim)} crashed`;
    killFeed.unshift(text);
    killFeed = killFeed.slice(0, 5);
  }

  // --- state handling ---
  let prevPhase = null;
  function onState(state) {
    lastState = state;

    // Screen routing by phase (only once entered).
    if (entered) {
      if (state.phase === 'LOBBY') {
        showScreen('lobby');
        renderLobby(state);
      } else if (state.phase === 'COUNTDOWN' || state.phase === 'PLAYING') {
        showScreen('game');
        if (isTouch) touchControls.classList.remove('hidden');
      } else if (state.phase === 'RESULT') {
        showScreen('result');
        renderResult(state);
      }
    }

    if (state.phase !== prevPhase) {
      if (state.phase === 'COUNTDOWN' || state.phase === 'PLAYING') resizeCanvas(state.grid);
      if (state.phase !== 'PLAYING' && state.phase !== 'COUNTDOWN') {
        killFeed = [];
      }
      prevPhase = state.phase;
    }
  }

  function renderLobby(state) {
    playerList.innerHTML = '';
    for (const s of state.snakes) {
      const li = document.createElement('li');
      const me = s.id === myId ? ' (YOU)' : '';
      li.innerHTML = `
        <span class="swatch" style="background:${s.color}"></span>
        <span class="pname">${escapeHtml(s.name)}${me}</span>
        <span class="ready-tag ${s.ready ? 'on' : ''}">${s.ready ? 'READY' : 'waiting'}</span>`;
      playerList.appendChild(li);
    }
  }

  function renderResult(state) {
    if (!state.results) return;
    resultList.innerHTML = '';
    for (const r of state.results) {
      const li = document.createElement('li');
      li.className = `rank-${r.rank}`;
      const me = r.id === myId ? ' (YOU)' : '';
      li.innerHTML = `
        <span class="rank">${r.rank}</span>
        <span class="swatch" style="background:${r.color}"></span>
        <span class="pname">${escapeHtml(r.name)}${me}</span>
        <span class="stats">🍎${r.foodCount} ☠${r.kills}</span>
        <span class="final">${r.score}</span>`;
      resultList.appendChild(li);
    }
    resultCountdown.textContent = 'まもなくロビーに戻ります…';
  }

  function resizeCanvas(grid) {
    const maxW = Math.min(window.innerWidth - 16, 1000);
    const maxH = window.innerHeight - 16;
    cell = Math.max(6, Math.floor(Math.min(maxW / grid.w, maxH / grid.h)));
    canvas.width = grid.w * cell;
    canvas.height = grid.h * cell;
  }

  // --- render loop ---
  function draw() {
    requestAnimationFrame(draw);
    if (!lastState) return;
    const state = lastState;
    if (state.phase !== 'PLAYING' && state.phase !== 'COUNTDOWN') return;

    const grid = state.grid;
    // Background grid.
    ctx.fillStyle = '#070b14';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.strokeStyle = 'rgba(28,40,64,0.6)';
    ctx.lineWidth = 1;
    for (let x = 0; x <= grid.w; x++) {
      ctx.beginPath();
      ctx.moveTo(x * cell + 0.5, 0);
      ctx.lineTo(x * cell + 0.5, canvas.height);
      ctx.stroke();
    }
    for (let y = 0; y <= grid.h; y++) {
      ctx.beginPath();
      ctx.moveTo(0, y * cell + 0.5);
      ctx.lineTo(canvas.width, y * cell + 0.5);
      ctx.stroke();
    }

    // Food.
    const pulse = 0.5 + 0.5 * Math.sin(Date.now() / 200);
    for (const f of state.food) {
      ctx.fillStyle = `rgba(255, 70, 90, ${0.6 + 0.4 * pulse})`;
      const pad = cell * 0.15;
      ctx.beginPath();
      ctx.arc(f.x * cell + cell / 2, f.y * cell + cell / 2, cell / 2 - pad, 0, Math.PI * 2);
      ctx.fill();
    }

    // Snakes.
    for (const s of state.snakes) {
      if (!s.body || s.body.length === 0) continue;
      ctx.fillStyle = s.alive ? s.color : 'rgba(120,130,150,0.35)';
      for (let i = 0; i < s.body.length; i++) {
        const seg = s.body[i];
        const pad = i === 0 ? 0.5 : 1.5;
        roundRect(seg.x * cell + pad, seg.y * cell + pad, cell - pad * 2, cell - pad * 2, 3);
      }
      // Head highlight.
      if (s.alive) {
        const head = s.body[0];
        ctx.fillStyle = '#ffffff';
        ctx.globalAlpha = 0.85;
        ctx.beginPath();
        ctx.arc(head.x * cell + cell / 2, head.y * cell + cell / 2, Math.max(1.5, cell * 0.12), 0, Math.PI * 2);
        ctx.fill();
        ctx.globalAlpha = 1;
      }
    }

    // Countdown overlay.
    if (state.phase === 'COUNTDOWN' && state.countdown > 0) {
      countdownEl.classList.remove('hidden');
      countdownEl.textContent = state.countdown;
    } else {
      countdownEl.classList.add('hidden');
    }

    renderHud(state);
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
    ctx.closePath();
    ctx.fill();
  }

  function renderHud(state) {
    const sorted = [...state.snakes].sort((a, b) => b.score - a.score);
    scoreboardEl.innerHTML = sorted.map((s) => `
      <div class="row ${s.alive ? '' : 'dead'}">
        <span class="swatch" style="background:${s.color};width:12px;height:12px"></span>
        <span>${escapeHtml(s.name)}${s.id === myId ? ' (YOU)' : ''}</span>
        <span class="sc">${s.score}</span>
      </div>`).join('');
    killlogEl.innerHTML = killFeed.map((t) => `<div>${escapeHtml(t)}</div>`).join('');
  }

  function escapeHtml(str) {
    return String(str).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
  }

  // Latency ping every 5s (per spec).
  setInterval(() => send({ type: 'ping', ts: Date.now() }), 5000);

  window.addEventListener('resize', () => {
    if (lastState && lastState.grid) resizeCanvas(lastState.grid);
  });

  showScreen('title');
  connect();
  requestAnimationFrame(draw);
})();
