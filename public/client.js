// NAGA ARENA - client (endless continuous arena).
// Follow-camera, analog steering (mouse / keyboard / touch), frog food,
// name-derived colours, infinite respawn. Renders the authoritative state.

(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const screens = { title: $('screen-title'), game: $('screen-game') };
  const connStatus = $('conn-status');
  const canvas = $('board');
  const ctx = canvas.getContext('2d');
  const nameInput = $('name-input');
  const youStats = $('you-stats');
  const leadersEl = $('leaders');
  const respawnEl = $('respawn');
  const killlogEl = $('killlog');

  const MAPS = [{ id: 'TUNNEL', label: 'TUNNEL' }, { id: 'VOID', label: 'VOID' },
    { id: 'LABYRINTH', label: 'LABYRINTH' }, { id: 'ARENA', label: 'ARENA' }];
  const ZOOM = 2;

  let ws = null, myId = null, lastState = null, killFeed = [];
  let chosenMap = localStorage.getItem('naga_map') || 'TUNNEL';
  const isTouch = ('ontouchstart' in window) || navigator.maxTouchPoints > 0;

  // graphics / fx
  const particles = [];
  const prevMeta = new Map();
  let shakeT = 0, shakeMag = 0, lastFrame = Date.now();
  let lastHead = null; // remember camera focus while dead

  // input
  let pointer = null;     // {x,y} in screen space (mouse/touch)
  const keys = new Set();
  let inputMode = isTouch ? 'touch' : 'mouse';
  let aimAng = 0, lastSentAng = null, lastSentTime = 0;

  function showScreen(name) { for (const [k, el] of Object.entries(screens)) el.classList.toggle('active', k === name); }

  // ---- identity ----
  function loadPid() {
    let pid = localStorage.getItem('naga_pid');
    if (!pid) { pid = (crypto.randomUUID ? crypto.randomUUID() : 'p' + Math.random().toString(36).slice(2)); localStorage.setItem('naga_pid', pid); }
    return pid;
  }
  const myPid = loadPid();
  nameInput.value = localStorage.getItem('naga_name') || '';
  function myName() { return (nameInput.value || '').trim(); }

  function roomFromUrl() {
    const m = new URLSearchParams(location.search).get('room');
    return m ? m.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8) : '';
  }
  function setRoomCode(code) {
    const url = new URL(location.href); url.searchParams.set('room', code);
    history.replaceState(null, '', url.toString());
  }

  // ---- map picker ----
  (function buildMaps() {
    const row = $('map-options');
    for (const m of MAPS) {
      const b = document.createElement('button');
      b.className = 'opt' + (m.id === chosenMap ? ' selected' : '');
      b.textContent = m.label; b.dataset.map = m.id;
      b.addEventListener('click', () => {
        chosenMap = m.id; localStorage.setItem('naga_map', chosenMap);
        row.querySelectorAll('.opt').forEach((o) => o.classList.toggle('selected', o.dataset.map === chosenMap));
      });
      row.appendChild(b);
    }
  })();

  // ---- connection ----
  function connect() {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    ws = new WebSocket(`${proto}://${location.host}`);
    ws.onopen = () => { connStatus.textContent = 'Connected. Press PLAY.'; };
    ws.onclose = () => { connStatus.textContent = 'Disconnected. Reconnecting...'; setTimeout(connect, 1500); };
    ws.onerror = () => { connStatus.textContent = 'Connection error.'; };
    ws.onmessage = (ev) => { let m; try { m = JSON.parse(ev.data); } catch { return; } handle(m); };
  }
  function send(obj) { if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj)); }

  function handle(msg) {
    if (msg.type === 'welcome') { myId = msg.id; setRoomCode(msg.room); showScreen('game'); resizeCanvas(); }
    else if (msg.type === 'state') onState(msg.state);
    else if (msg.type === 'event' && msg.event && msg.event.type === 'KILL') onKill(msg.event);
  }

  $('btn-play').addEventListener('click', () => {
    localStorage.setItem('naga_name', myName());
    sound.resume();
    send({ type: 'join', room: roomFromUrl(), map: chosenMap, pid: myPid, name: myName() });
  });
  $('btn-copy').addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(location.href); $('btn-copy').textContent = 'Copied!'; }
    catch { $('btn-copy').textContent = location.href; }
    setTimeout(() => { $('btn-copy').textContent = 'Copy invite link'; }, 1500);
  });

  // ---- sound ----
  const sound = (() => {
    let ac = null, muted = localStorage.getItem('naga_muted') === '1';
    const ensure = () => { if (!ac) { try { ac = new (window.AudioContext || window.webkitAudioContext)(); } catch { ac = null; } } if (ac && ac.state === 'suspended') ac.resume(); return ac; };
    function tone(freq, dur, type, gain, slideTo) {
      if (muted) return; const a = ensure(); if (!a) return;
      const o = a.createOscillator(), g = a.createGain();
      o.type = type || 'square'; o.frequency.setValueAtTime(freq, a.currentTime);
      if (slideTo) o.frequency.exponentialRampToValueAtTime(slideTo, a.currentTime + dur);
      g.gain.setValueAtTime(gain || 0.06, a.currentTime); g.gain.exponentialRampToValueAtTime(0.0001, a.currentTime + dur);
      o.connect(g); g.connect(a.destination); o.start(); o.stop(a.currentTime + dur);
    }
    return {
      isMuted: () => muted, resume: ensure,
      toggle() { muted = !muted; localStorage.setItem('naga_muted', muted ? '1' : '0'); if (!muted) ensure(); return muted; },
      eat() { tone(680, 0.07, 'square', 0.04); },
      kill() { tone(300, 0.22, 'sawtooth', 0.07, 130); },
      death() { tone(200, 0.4, 'sawtooth', 0.08, 70); },
      spawn() { tone(720, 0.16, 'sine', 0.06); },
    };
  })();
  const btnSound = $('btn-sound');
  if (sound.isMuted()) btnSound.textContent = 'SOUND: OFF';
  btnSound.addEventListener('click', () => { btnSound.textContent = sound.toggle() ? 'SOUND: OFF' : 'SOUND: ON'; });

  // ---- input ----
  function aimFromPointer() { if (!pointer) return aimAng; return Math.atan2(pointer.y - canvas.height / 2, pointer.x - canvas.width / 2); }
  function aimFromKeys() {
    let dx = 0, dy = 0;
    if (keys.has('up')) dy -= 1; if (keys.has('down')) dy += 1;
    if (keys.has('left')) dx -= 1; if (keys.has('right')) dx += 1;
    if (dx === 0 && dy === 0) return null;
    return Math.atan2(dy, dx);
  }
  const KEYMAP = { ArrowUp: 'up', KeyW: 'up', ArrowDown: 'down', KeyS: 'down', ArrowLeft: 'left', KeyA: 'left', ArrowRight: 'right', KeyD: 'right' };
  document.addEventListener('keydown', (e) => { const k = KEYMAP[e.code]; if (k) { keys.add(k); inputMode = 'key'; e.preventDefault(); } });
  document.addEventListener('keyup', (e) => { const k = KEYMAP[e.code]; if (k) keys.delete(k); });
  canvas.addEventListener('mousemove', (e) => { pointer = { x: e.clientX, y: e.clientY }; inputMode = 'mouse'; });
  canvas.addEventListener('touchstart', (e) => { const t = e.touches[0]; pointer = { x: t.clientX, y: t.clientY }; inputMode = 'touch'; }, { passive: true });
  canvas.addEventListener('touchmove', (e) => { const t = e.touches[0]; pointer = { x: t.clientX, y: t.clientY }; inputMode = 'touch'; }, { passive: true });

  function updateAim(now) {
    let ang = aimAng;
    if (inputMode === 'key') { const k = aimFromKeys(); if (k != null) ang = k; }
    else ang = aimFromPointer();
    aimAng = ang;
    let d = Math.abs(((ang - (lastSentAng ?? 99)) + Math.PI) % (Math.PI * 2) - Math.PI);
    if (lastSentAng == null || (d > 0.04 && now - lastSentTime > 40)) { send({ type: 'aim', ang }); lastSentAng = ang; lastSentTime = now; }
  }

  // ---- state ----
  function onState(state) {
    detectFx(state);
    lastState = state;
    const me = state.snakes.find((s) => s.id === myId);
    if (me && me.alive && me.head) lastHead = me.head;
  }
  function onKill(ev) {
    const snakes = lastState ? lastState.snakes : [];
    const nameOf = (id) => { const s = snakes.find((x) => x.id === id); return s ? s.name : '???'; };
    if (ev.killer) killFeed.unshift(`${nameOf(ev.killer)} ate ${nameOf(ev.victim)}`);
    else killFeed.unshift(`${nameOf(ev.victim)} crashed`);
    killFeed = killFeed.slice(0, 4);
    if (ev.killer === myId) sound.kill();
  }
  function detectFx(state) {
    for (const s of state.snakes) {
      const prev = prevMeta.get(s.id);
      const head = s.head || (s.body && s.body[0]);
      if (prev && head) {
        if (s.score > prev.score && s.id === myId) sound.eat();
        if (prev.alive && !s.alive) {
          const hx = head.x, hy = head.y;
          burstWorld(hx, hy, s.color, 20);
          if (s.id === myId) { sound.death(); shakeT = 16; shakeMag = 22; }
        }
        if (!prev.alive && s.alive && s.id === myId) sound.spawn();
      }
      prevMeta.set(s.id, { score: s.score, alive: s.alive });
    }
  }

  // ---- canvas / camera ----
  function resizeCanvas() {
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
  }
  window.addEventListener('resize', resizeCanvas);

  function cellSize(map) {
    const base = Math.min(canvas.width / map.w, canvas.height / map.h);
    return Math.max(16, base * ZOOM);
  }

  function draw() {
    requestAnimationFrame(draw);
    const now = Date.now();
    const dt = Math.min(2, (now - lastFrame) / 16.67); lastFrame = now;
    if (!lastState) return;
    updateAim(now);
    const state = lastState, map = state.map;
    const cell = cellSize(map);
    const Wpx = map.w * cell, Hpx = map.h * cell;

    const me = state.snakes.find((s) => s.id === myId);
    const focus = (me && me.alive && me.head) ? me.head : (lastHead || { x: map.w / 2, y: map.h / 2 });
    let camX = focus.x * cell - canvas.width / 2;
    let camY = focus.y * cell - canvas.height / 2;
    if (!map.tunnel) {
      camX = Wpx > canvas.width ? Math.max(0, Math.min(camX, Wpx - canvas.width)) : (Wpx - canvas.width) / 2;
      camY = Hpx > canvas.height ? Math.max(0, Math.min(camY, Hpx - canvas.height)) : (Hpx - canvas.height) / 2;
    }

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = '#060912';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    ctx.save();
    if (shakeT > 0) { shakeT -= dt; const m = shakeMag * Math.max(0, shakeT / 16); ctx.translate((Math.random() - 0.5) * m, (Math.random() - 0.5) * m); }
    ctx.translate(-camX, -camY);

    drawGrid(map, cell, camX, camY);

    const offsets = map.tunnel ? wrapOffsets(map, cell, camX, camY) : [{ ox: 0, oy: 0 }];
    for (const off of offsets) {
      ctx.save();
      ctx.translate(off.ox * Wpx, off.oy * Hpx);
      if (!map.tunnel) drawWalls(map, cell);
      for (const f of state.food) drawFrog(ctx, f.x * cell, f.y * cell, cell * 0.42, now + f.id);
      for (const s of state.snakes) drawSnake(s, cell, s.id === myId);
      ctx.restore();
    }
    updateDrawParticles(dt);
    ctx.restore();

    renderHud(state, me);
  }

  function wrapOffsets(map, cell, camX, camY) {
    const Wpx = map.w * cell, Hpx = map.h * cell, out = [];
    for (let ox = -1; ox <= 1; ox++) {
      const left = ox * Wpx - camX;
      if (left + Wpx < 0 || left > canvas.width) continue;
      for (let oy = -1; oy <= 1; oy++) {
        const top = oy * Hpx - camY;
        if (top + Hpx < 0 || top > canvas.height) continue;
        out.push({ ox, oy });
      }
    }
    return out.length ? out : [{ ox: 0, oy: 0 }];
  }

  function drawGrid(map, cell, camX, camY) {
    ctx.strokeStyle = 'rgba(40,60,96,0.3)'; ctx.lineWidth = 1;
    const x0 = Math.floor(camX / cell), x1 = Math.ceil((camX + canvas.width) / cell);
    const y0 = Math.floor(camY / cell), y1 = Math.ceil((camY + canvas.height) / cell);
    ctx.beginPath();
    for (let x = x0; x <= x1; x++) { ctx.moveTo(x * cell, camY); ctx.lineTo(x * cell, camY + canvas.height); }
    for (let y = y0; y <= y1; y++) { ctx.moveTo(camX, y * cell); ctx.lineTo(camX + canvas.width, y * cell); }
    ctx.stroke();
  }

  function drawWalls(map, cell) {
    for (const w of map.walls) {
      ctx.fillStyle = '#26344f';
      roundRect(w.x * cell, w.y * cell, cell, cell, Math.max(2, cell * 0.18));
      ctx.fillStyle = 'rgba(90,120,170,0.5)';
      roundRect(w.x * cell + cell * 0.12, w.y * cell + cell * 0.12, cell * 0.45, cell * 0.45, 2);
    }
  }

  function drawFrog(g, cx, cy, r, t) {
    const bob = Math.sin(t / 350) * r * 0.06;
    cy += bob;
    g.fillStyle = '#2c9b50';
    g.beginPath(); g.ellipse(cx - r * 0.78, cy + r * 0.45, r * 0.5, r * 0.28, 0.6, 0, Math.PI * 2); g.fill();
    g.beginPath(); g.ellipse(cx + r * 0.78, cy + r * 0.45, r * 0.5, r * 0.28, -0.6, 0, Math.PI * 2); g.fill();
    g.fillStyle = '#39c46a';
    g.beginPath(); g.ellipse(cx, cy + r * 0.1, r, r * 0.82, 0, 0, Math.PI * 2); g.fill();
    for (const sx of [-1, 1]) {
      g.fillStyle = '#39c46a'; g.beginPath(); g.arc(cx + sx * r * 0.42, cy - r * 0.55, r * 0.4, 0, Math.PI * 2); g.fill();
      g.fillStyle = '#f2fff6'; g.beginPath(); g.arc(cx + sx * r * 0.42, cy - r * 0.55, r * 0.3, 0, Math.PI * 2); g.fill();
      g.fillStyle = '#0a1f10'; g.beginPath(); g.arc(cx + sx * r * 0.42, cy - r * 0.5, r * 0.15, 0, Math.PI * 2); g.fill();
    }
  }

  function drawSnake(s, cell, isMe) {
    if (!s.alive || !s.body || s.body.length === 0) return;
    renderSnake(ctx, s.body, s.color, cell, isMe);
    // Name tag above the head.
    const h = s.body[0];
    ctx.globalAlpha = isMe ? 0.95 : 0.6;
    ctx.fillStyle = '#e8f0ff';
    ctx.font = `${Math.max(9, Math.round(cell * 0.6))}px system-ui, sans-serif`;
    ctx.textAlign = 'center'; ctx.textBaseline = 'bottom';
    ctx.fillText(s.name, h.x * cell, h.y * cell - cell * 0.7);
    ctx.globalAlpha = 1;
  }

  // Connected snake with eyes; splits on big gaps (tunnel seam).
  function renderSnake(g, pts, color, cell, glow) {
    const w = cell * 0.82;
    const C = (p) => ({ x: p.x * cell, y: p.y * cell });
    const runs = []; let run = [pts[0]];
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1], b = pts[i];
      if (Math.abs(a.x - b.x) + Math.abs(a.y - b.y) > 2.5) { runs.push(run); run = [b]; }
      else run.push(b);
    }
    runs.push(run);
    g.lineCap = 'round'; g.lineJoin = 'round';
    if (glow) { g.shadowColor = color; g.shadowBlur = cell * 0.9; }
    g.strokeStyle = color; g.fillStyle = color; g.lineWidth = w;
    for (const r of runs) {
      if (r.length === 1) { const c = C(r[0]); g.beginPath(); g.arc(c.x, c.y, w / 2, 0, Math.PI * 2); g.fill(); continue; }
      g.beginPath(); const p0 = C(r[0]); g.moveTo(p0.x, p0.y);
      for (let i = 1; i < r.length; i++) { const c = C(r[i]); g.lineTo(c.x, c.y); }
      g.stroke();
    }
    g.shadowBlur = 0;
    // Head + eyes.
    const head = C(pts[0]);
    g.fillStyle = color; g.beginPath(); g.arc(head.x, head.y, w * 0.62, 0, Math.PI * 2); g.fill();
    let dx = 1, dy = 0;
    if (pts.length > 1) { const ddx = pts[0].x - pts[1].x, ddy = pts[0].y - pts[1].y; if ((Math.abs(ddx) + Math.abs(ddy)) <= 2.5 && (ddx || ddy)) { dx = ddx; dy = ddy; } }
    const len = Math.hypot(dx, dy) || 1; dx /= len; dy /= len;
    const px = -dy, py = dx, eo = w * 0.27, ef = w * 0.18;
    for (const sgn of [1, -1]) {
      const ex = head.x + dx * ef + px * eo * sgn, ey = head.y + dy * ef + py * eo * sgn;
      g.fillStyle = '#ffffff'; g.beginPath(); g.arc(ex, ey, w * 0.17, 0, Math.PI * 2); g.fill();
      g.fillStyle = '#05060a'; g.beginPath(); g.arc(ex + dx * ef * 0.5, ey + dy * ef * 0.5, w * 0.09, 0, Math.PI * 2); g.fill();
    }
  }

  function roundRect(x, y, w, h, r) {
    if (w <= 0 || h <= 0) return; r = Math.min(r, w / 2, h / 2);
    ctx.beginPath(); ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath(); ctx.fill();
  }

  // ---- particles ----
  function burstWorld(cellX, cellY, color, count) {
    const map = lastState && lastState.map; if (!map) return;
    const cell = cellSize(map);
    for (let i = 0; i < count; i++) {
      const a = Math.random() * Math.PI * 2, sp = (3 + Math.random() * 5);
      particles.push({ x: cellX * cell, y: cellY * cell, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, life: 1, decay: 0.02 + Math.random() * 0.03, color, size: cell * (0.12 + Math.random() * 0.16) });
    }
    if (particles.length > 400) particles.splice(0, particles.length - 400);
  }
  function updateDrawParticles(dt) {
    for (let i = particles.length - 1; i >= 0; i--) {
      const p = particles[i];
      p.x += p.vx * dt; p.y += p.vy * dt; p.vx *= 0.92; p.vy *= 0.92; p.life -= p.decay * dt;
      if (p.life <= 0) { particles.splice(i, 1); continue; }
      ctx.globalAlpha = Math.max(0, p.life); ctx.fillStyle = p.color; ctx.shadowColor = p.color; ctx.shadowBlur = 6;
      ctx.beginPath(); ctx.arc(p.x, p.y, Math.max(0.5, p.size * p.life), 0, Math.PI * 2); ctx.fill();
    }
    ctx.globalAlpha = 1; ctx.shadowBlur = 0;
  }

  // ---- HUD ----
  function renderHud(state, me) {
    if (me && !me.alive && me.respawnIn > 0) {
      respawnEl.classList.remove('hidden');
      respawnEl.innerHTML = `${me.respawnIn}<div class="sub">RESPAWNING</div>`;
    } else { respawnEl.classList.add('hidden'); }

    if (me) youStats.innerHTML = `<span class="big">${me.length}</span> length &nbsp; ${me.score} pts`;
    const top = [...state.snakes].filter((s) => s.length != null).sort((a, b) => b.length - a.length).slice(0, 6);
    leadersEl.innerHTML = top.map((s) => `
      <div class="row ${s.id === myId ? 'me' : ''}">
        <span class="sw" style="background:${s.color}"></span>
        <span>${esc(s.name)}</span><span class="ln">${s.length}</span>
      </div>`).join('');
    killlogEl.innerHTML = killFeed.map((t) => `<div>${esc(t)}</div>`).join('');
  }

  function esc(str) { return String(str).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

  setInterval(() => send({ type: 'ping', ts: Date.now() }), 5000);

  showScreen('title');
  resizeCanvas();
  connect();
  requestAnimationFrame(draw);
})();
