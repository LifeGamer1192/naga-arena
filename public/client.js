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
  let chosenBots = parseInt(localStorage.getItem('naga_bots') ?? '1', 10);
  let chosenClassic = localStorage.getItem('naga_classic') === '1';
  const BOT_CHOICES = [0, 1, 2, 3, 4, 6, 8];
  const EFFECT_LABEL = { vacuum: 'VAC', giant: 'BIG', poisonGas: 'GAS', poisoned: 'PSN' };
  const EFFECT_COLOR = { vacuum: '#00e5ff', giant: '#ffd60a', poisonGas: '#7cfc3a', poisoned: '#b06bff' };
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

  const roomInput = $('room-input');
  function normRoom(v) { return String(v || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8); }
  function roomFromUrl() { return normRoom(new URLSearchParams(location.search).get('room')); }
  // Prefer a typed code, fall back to the URL's ?room=.
  function chosenRoom() { return normRoom(roomInput.value) || roomFromUrl(); }
  roomInput.value = roomFromUrl();
  roomInput.addEventListener('input', () => { roomInput.value = normRoom(roomInput.value); });
  function setRoomCode(code) {
    const url = new URL(location.href); url.searchParams.set('room', code);
    history.replaceState(null, '', url.toString());
  }

  // ---- pickers ----
  function buildPicker(rowId, items, getSel, onPick) {
    const row = $(rowId);
    row.innerHTML = '';
    for (const it of items) {
      const b = document.createElement('button');
      b.className = 'opt' + (getSel() === it.val ? ' selected' : '');
      b.textContent = it.label; b.dataset.val = it.val;
      b.addEventListener('click', () => { onPick(it.val); row.querySelectorAll('.opt').forEach((o) => o.classList.toggle('selected', String(getSel()) === o.dataset.val)); });
      row.appendChild(b);
    }
  }
  buildPicker('map-options', MAPS.map((m) => ({ val: m.id, label: m.label })), () => chosenMap, (v) => { chosenMap = v; localStorage.setItem('naga_map', v); });
  buildPicker('bot-options', BOT_CHOICES.map((n) => ({ val: n, label: String(n) })), () => chosenBots, (v) => { chosenBots = v; localStorage.setItem('naga_bots', String(v)); });
  buildPicker('mode-options', [{ val: false, label: 'NORMAL' }, { val: true, label: 'CLASSIC' }], () => chosenClassic, (v) => { chosenClassic = v; localStorage.setItem('naga_classic', v ? '1' : '0'); });

  // ---- connection ----
  function connect() {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    ws = new WebSocket(`${proto}://${location.host}`);
    ws.onopen = () => {
      connStatus.textContent = 'Connected. Press PLAY.';
      // If we were already playing, rejoin automatically so play resumes.
      if (lastJoin) send(lastJoin);
    };
    ws.onclose = () => { connStatus.textContent = 'Disconnected. Reconnecting...'; setTimeout(connect, 1200); };
    ws.onerror = () => { connStatus.textContent = 'Connection error.'; };
    ws.onmessage = (ev) => { let m; try { m = JSON.parse(ev.data); } catch { return; } handle(m); };
  }
  function send(obj) { if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj)); }

  // Show a banner when the connection drops or the server goes quiet; hide on recovery.
  const netStatusEl = $('net-status');
  let joined = false, lastStateMs = 0, lastJoin = null;
  setInterval(() => {
    if (!joined) { netStatusEl.classList.add('hidden'); return; }
    const disconnected = !ws || ws.readyState !== WebSocket.OPEN;
    const stale = Date.now() - lastStateMs > 2500;
    if (disconnected || stale) {
      netStatusEl.classList.remove('hidden');
      netStatusEl.textContent = disconnected ? 'Connection lost — reconnecting…' : 'No response from server — reconnecting…';
    } else { netStatusEl.classList.add('hidden'); }
  }, 500);

  function handle(msg) {
    if (msg.type === 'welcome') {
      myId = msg.id; setRoomCode(msg.room); showScreen('game'); resizeCanvas();
      joined = true; lastStateMs = Date.now();
      if (lastJoin) lastJoin.room = msg.room; // rejoin the same room after a drop
    } else if (msg.type === 'state') { lastStateMs = Date.now(); onState(msg.state); }
    else if (msg.type === 'event' && msg.event) {
      if (msg.event.type === 'KILL') onKill(msg.event);
      else if (msg.event.type === 'GEM' && msg.event.player === myId) sound.gem();
    }
  }

  $('btn-play').addEventListener('click', () => {
    localStorage.setItem('naga_name', myName());
    sound.resume();
    lastJoin = { type: 'join', room: chosenRoom(), map: chosenMap, bots: chosenBots, classic: chosenClassic, pid: myPid, name: myName() };
    send(lastJoin);
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
      gem() { tone(520, 0.08, 'sine', 0.06); setTimeout(() => tone(880, 0.12, 'sine', 0.06), 80); },
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

    // Points (walls/poison/food) live in [0,W); camera-culled wrap copies suffice.
    const ptOffsets = map.tunnel ? wrapOffsets(map, cell, camX, camY) : [{ ox: 0, oy: 0 }];
    for (const off of ptOffsets) {
      ctx.save();
      ctx.translate(off.ox * Wpx, off.oy * Hpx);
      if (!map.tunnel) drawWalls(map, cell);
      for (const c of (state.poison || [])) drawPoison(c.x * cell, c.y * cell, cell, now);
      for (const f of state.food) drawFood(f, cell, now);
      ctx.restore();
    }
    // Snakes are drawn at ALL wrap copies on tunnel maps: an unwrapped body's
    // tail can sit outside [0,W), so camera-based culling would drop it (the
    // "enemy rear flickers / invisible" bug).
    const krange = map.tunnel ? [-1, 0, 1] : [0];
    for (const ox of krange) for (const oy of krange) {
      ctx.save();
      ctx.translate(ox * Wpx, oy * Hpx);
      for (const s of state.snakes) drawSnake(s, cell, s.id === myId, map);
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

  function drawFood(f, cell, now) {
    if (f.kind === 'FROG') drawFrog(ctx, f.x * cell, f.y * cell, cell * 0.42, now + f.id, f.ang || 0);
    else drawGem(ctx, f.x * cell, f.y * cell, cell * 0.42, f.color || '#00e5ff', now + f.id);
  }

  // A top-down frog facing +x locally; rotated by `ang` so its heading reads.
  // Legs are rounded haunches and round feet (cute, not insect-like).
  function drawFrog(g, cx, cy, r, t, ang) {
    const green = '#3fbf63', dark = '#2c9b50', light = '#79e893';
    g.save();
    g.translate(cx, cy + Math.sin(t / 300) * r * 0.05);
    g.rotate(ang || 0);
    // Rounded hind haunches tucked at the back, with a round foot each.
    g.fillStyle = dark;
    for (const sy of [-1, 1]) {
      g.beginPath(); g.ellipse(-r * 0.42, sy * r * 0.6, r * 0.52, r * 0.42, sy * 0.5, 0, Math.PI * 2); g.fill();
      g.beginPath(); g.arc(-r * 0.02, sy * r * 0.86, r * 0.22, 0, Math.PI * 2); g.fill();
    }
    // Small round front feet.
    for (const sy of [-1, 1]) { g.beginPath(); g.arc(r * 0.82, sy * r * 0.5, r * 0.2, 0, Math.PI * 2); g.fill(); }
    // Body.
    g.fillStyle = green; g.beginPath(); g.ellipse(0, 0, r * 1.0, r * 0.82, 0, 0, Math.PI * 2); g.fill();
    g.fillStyle = light; g.beginPath(); g.ellipse(r * 0.12, 0, r * 0.55, r * 0.45, 0, 0, Math.PI * 2); g.fill();
    // Bulging eyes at the front (pupils forward to show the heading).
    for (const sy of [-1, 1]) {
      g.fillStyle = green; g.beginPath(); g.arc(r * 0.6, sy * r * 0.5, r * 0.34, 0, Math.PI * 2); g.fill();
      g.fillStyle = '#f4fff8'; g.beginPath(); g.arc(r * 0.64, sy * r * 0.5, r * 0.24, 0, Math.PI * 2); g.fill();
      g.fillStyle = '#0a1f10'; g.beginPath(); g.arc(r * 0.76, sy * r * 0.5, r * 0.11, 0, Math.PI * 2); g.fill();
    }
    g.restore();
  }

  function drawGem(g, cx, cy, r, color, t) {
    g.save(); g.translate(cx, cy); g.rotate(Math.sin(t / 600) * 0.25);
    g.shadowColor = color; g.shadowBlur = r * 1.6;
    g.fillStyle = color;
    g.beginPath(); g.moveTo(0, -r); g.lineTo(r * 0.78, 0); g.lineTo(0, r); g.lineTo(-r * 0.78, 0); g.closePath(); g.fill();
    g.shadowBlur = 0;
    g.fillStyle = 'rgba(255,255,255,0.55)';
    g.beginPath(); g.moveTo(0, -r); g.lineTo(r * 0.78, 0); g.lineTo(0, 0); g.closePath(); g.fill();
    g.restore();
  }

  function drawPoison(x, y, cell, t) {
    const r = cell * (0.85 + 0.1 * Math.sin(t / 200 + x));
    g_fillGlow(x, y, r, 'rgba(124,252,58,0.18)');
  }
  function g_fillGlow(x, y, r, color) { ctx.fillStyle = color; ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill(); }

  // Unwrap a tunnel-wrapped body into one continuous polyline (relative to the
  // head) so the connected renderer never has to split across the seam.
  function unwrapBody(body, w, h, tunnel) {
    if (!tunnel || body.length < 2) return body;
    const out = [body[0]];
    for (let i = 1; i < body.length; i++) {
      let x = body[i].x, y = body[i].y; const prev = out[i - 1];
      while (x - prev.x > w / 2) x -= w; while (x - prev.x < -w / 2) x += w;
      while (y - prev.y > h / 2) y -= h; while (y - prev.y < -h / 2) y += h;
      out.push({ x, y });
    }
    return out;
  }

  function drawSnake(s, cell, isMe, map) {
    if (!s.alive || !s.body || s.body.length === 0) return;
    const headScale = s.giant ? 2 : 1;
    const body = unwrapBody(s.body, map.w, map.h, map.tunnel);
    renderSnake(ctx, body, s.color, cell, isMe || s.giant, headScale);
    const h = s.body[0];
    const hxp = h.x * cell, hyp = h.y * cell;
    const headTop = hyp - cell * (0.7 * headScale);
    // Name tag.
    ctx.globalAlpha = isMe ? 0.95 : 0.6; ctx.fillStyle = '#e8f0ff';
    ctx.font = `${Math.max(9, Math.round(cell * 0.6))}px system-ui, sans-serif`;
    ctx.textAlign = 'center'; ctx.textBaseline = 'bottom';
    ctx.fillText(s.name, hxp, headTop - cell * 0.15);
    ctx.globalAlpha = 1;
    // Status badges (type + remaining seconds), readable for every snake.
    const fx = s.effects || [];
    if (fx.length) {
      const chipH = cell * 0.62, gap = cell * 0.12;
      const chips = fx.map((e) => `${EFFECT_LABEL[e.type] || e.type} ${e.remain}`);
      ctx.font = `bold ${Math.max(8, Math.round(cell * 0.4))}px system-ui, sans-serif`;
      const widths = chips.map((c) => ctx.measureText(c).width + cell * 0.4);
      const total = widths.reduce((a, b) => a + b, 0) + gap * (fx.length - 1);
      let bx = hxp - total / 2; const by = headTop - cell * 1.05;
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      for (let i = 0; i < fx.length; i++) {
        ctx.fillStyle = 'rgba(8,12,22,0.82)'; roundRect(bx, by, widths[i], chipH, 4);
        ctx.fillStyle = EFFECT_COLOR[fx[i].type] || '#fff';
        ctx.fillText(chips[i], bx + widths[i] / 2, by + chipH / 2 + 0.5);
        bx += widths[i] + gap;
      }
    }
  }

  // Connected snake with eyes. The body is pre-unwrapped (continuous), so it is
  // drawn as a single polyline — no run-splitting (which used to break the body
  // wherever the point spacing happened to exceed a fixed threshold).
  function renderSnake(g, pts, color, cell, glow, headScale) {
    headScale = headScale || 1;
    const w = cell * 0.82;
    const C = (p) => ({ x: p.x * cell, y: p.y * cell });
    g.lineCap = 'round'; g.lineJoin = 'round';
    if (glow) { g.shadowColor = color; g.shadowBlur = cell * 0.9; }
    g.strokeStyle = color; g.fillStyle = color; g.lineWidth = w;
    if (pts.length === 1) {
      const c = C(pts[0]); g.beginPath(); g.arc(c.x, c.y, w / 2, 0, Math.PI * 2); g.fill();
    } else {
      g.beginPath(); const p0 = C(pts[0]); g.moveTo(p0.x, p0.y);
      for (let i = 1; i < pts.length; i++) { const c = C(pts[i]); g.lineTo(c.x, c.y); }
      g.stroke();
    }
    g.shadowBlur = 0;
    // Head + eyes (scaled up when giant).
    const head = C(pts[0]);
    const hw = w * headScale;
    if (glow && headScale > 1) { g.shadowColor = color; g.shadowBlur = cell * 1.1; }
    g.fillStyle = color; g.beginPath(); g.arc(head.x, head.y, hw * 0.62, 0, Math.PI * 2); g.fill();
    g.shadowBlur = 0;
    let dx = 1, dy = 0;
    if (pts.length > 1) { const ddx = pts[0].x - pts[1].x, ddy = pts[0].y - pts[1].y; if ((Math.abs(ddx) + Math.abs(ddy)) <= 8 && (ddx || ddy)) { dx = ddx; dy = ddy; } }
    const len = Math.hypot(dx, dy) || 1; dx /= len; dy /= len;
    const px = -dy, py = dx, eo = hw * 0.27, ef = hw * 0.18;
    for (const sgn of [1, -1]) {
      const ex = head.x + dx * ef + px * eo * sgn, ey = head.y + dy * ef + py * eo * sgn;
      g.fillStyle = '#ffffff'; g.beginPath(); g.arc(ex, ey, hw * 0.17, 0, Math.PI * 2); g.fill();
      g.fillStyle = '#05060a'; g.beginPath(); g.arc(ex + dx * ef * 0.5, ey + dy * ef * 0.5, hw * 0.09, 0, Math.PI * 2); g.fill();
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
