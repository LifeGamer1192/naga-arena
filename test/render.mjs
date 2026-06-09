// Headless render smoke for the browser client.
// Mocks just enough of the DOM / Canvas / WebSocket APIs to actually execute
// public/client.js and drive a few render frames, catching runtime errors in
// the rendering path (which the server-side smoke test cannot reach).
import fs from 'fs';
import path from 'path';
import vm from 'vm';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const code = fs.readFileSync(path.join(__dirname, '..', 'public', 'client.js'), 'utf8');

let drawCalls = 0;
const gradient = { addColorStop() {} };
function makeCtx() {
  return new Proxy({
    canvas: { width: 800, height: 600 },
    createRadialGradient: () => gradient,
    createLinearGradient: () => gradient,
    fillRect() { drawCalls++; },
    arc() { drawCalls++; },
    fillText() {}, setLineDash() {}, setTransform() {},
    save() {}, restore() {}, translate() {}, rotate() {},
    beginPath() {}, moveTo() {}, lineTo() {}, stroke() {}, fill() {},
    arcTo() {}, closePath() {}, clearRect() {}, strokeRect() {},
  }, {
    get(t, k) { return (k in t) ? t[k] : (typeof k === 'string' ? (() => {}) : undefined); },
    set(t, k, v) { t[k] = v; return true; },
  });
}

const rafQueue = [];
function makeEl(id) {
  const ctx = makeCtx();
  return {
    id, width: 800, height: 600, value: '', textContent: '', innerHTML: '', dataset: {},
    style: {}, classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
    addEventListener() {}, appendChild() {}, querySelectorAll() { return []; },
    getContext() { return ctx; },
  };
}

const elements = new Map();
const doc = {
  getElementById(id) { if (!elements.has(id)) elements.set(id, makeEl(id)); return elements.get(id); },
  querySelectorAll() { return []; },
  addEventListener() {}, createElement() { return makeEl('dyn'); },
};

let wsInstance = null;
class MockWS {
  constructor() { this.readyState = 1; wsInstance = this; setTimeout(() => this.onopen && this.onopen(), 0); }
  send() {}
  close() {}
}
MockWS.OPEN = 1;

function makeAudioNode() {
  return new Proxy({ frequency: { setValueAtTime() {}, exponentialRampToValueAtTime() {} },
    gain: { setValueAtTime() {}, exponentialRampToValueAtTime() {} },
    connect() {}, start() {}, stop() {} },
  { get(t, k) { return (k in t) ? t[k] : (() => {}); } });
}
class MockAudioContext {
  constructor() { this.currentTime = 0; this.state = 'running'; this.destination = {}; }
  createOscillator() { return makeAudioNode(); }
  createGain() { return makeAudioNode(); }
  resume() {}
}

const sandbox = {
  window: {},
  addEventListener() {},
  document: doc,
  navigator: { maxTouchPoints: 0, clipboard: { writeText: () => Promise.resolve() } },
  location: { protocol: 'http:', host: 'localhost:3000', href: 'http://localhost:3000/', search: '' },
  history: { replaceState() {} },
  localStorage: { _d: {}, getItem(k) { return this._d[k] ?? null; }, setItem(k, v) { this._d[k] = String(v); } },
  WebSocket: MockWS,
  AudioContext: MockAudioContext,
  crypto: { randomUUID: () => 'test-uuid-1234' },
  URL, URLSearchParams,
  fetch: () => Promise.resolve({ json: () => Promise.resolve({ leaderboard: [] }) }),
  requestAnimationFrame: (cb) => { rafQueue.push(cb); return rafQueue.length; },
  setTimeout: (fn) => { try { fn(); } catch (e) { throw e; } return 0; },
  setInterval: () => 0,
  Math, JSON, Date, console, parseInt, parseFloat, isNaN, Object, Array, String, Number,
};
sandbox.window = sandbox;
sandbox.globalThis = sandbox;

function runFrames(n) { for (let i = 0; i < n; i++) { const q = rafQueue.splice(0); for (const cb of q) cb(); } }

function makeState(mode, mapId, tunnel) {
  return {
    code: 'TEST', phase: 'PLAYING', mode, hostId: 'me',
    map: { id: mapId, w: 20, h: 15, tunnel: !!tunnel,
      walls: [{ x: 5, y: 5 }, { x: 6, y: 5 }], dynamic: [{ x: 10, y: 8 }] },
    countdown: 0, timeLeft: 0, teamTotals: null, tournament: null,
    snakes: [
      { id: 'me', name: 'ME', color: '#39ff14', team: null, skin: { pattern: 'GRADIENT', color: '#39ff14' }, alive: true, ready: true, spectating: false, body: [{ x: 10, y: 7 }, { x: 9, y: 7 }, { x: 8, y: 7 }], score: 30, kills: 0, effects: { speed: true, shield: true, ghost: false, frozen: false }, rating: null },
      { id: 'b', name: 'B', color: '#ff2d55', team: null, skin: { pattern: 'NEON', color: '#ff2d55' }, alive: false, ready: true, spectating: false, body: [{ x: 0, y: 1 }, { x: 19, y: 1 }], score: 10, kills: 1, effects: {}, rating: null },
    ],
    items: [
      { id: 1, type: 'FOOD', x: 3, y: 3 }, { id: 2, type: 'SHIELD', x: 12, y: 9 },
      { id: 3, type: 'GHOST', x: 14, y: 2 },
    ],
    results: null,
  };
}

let failures = 0;
const check = (name, cond) => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}`); if (!cond) failures++; };

try {
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox, { filename: 'client.js' });
  check('R1: client.js loaded without throwing', true);

  // Feed a welcome + several states across every map/pattern and render frames.
  wsInstance.onmessage({ data: JSON.stringify({ type: 'welcome', id: 'me', room: 'TEST', isHost: true, you: { name: 'ME', color: '#39ff14', rating: 1000, tier: 'SILVER' } }) });

  const combos = [
    ['BATTLE_ROYALE', 'VOID', false], ['TOURNAMENT', 'LABYRINTH', false],
    ['SCORE_ATTACK', 'TUNNEL', true], ['TEAM_BATTLE', 'ARENA', false],
  ];
  for (const [mode, mapId, tunnel] of combos) {
    const st = makeState(mode, mapId, tunnel);
    if (mode === 'TOURNAMENT') st.tournament = { round: 1, rounds: 3, active: true, standings: [{ id: 'me', name: 'ME', color: '#39ff14', points: 4, place: 1 }], champion: null };
    if (mode === 'TEAM_BATTLE') st.teamTotals = { RED: 10, BLUE: 5 };
    wsInstance.onmessage({ data: JSON.stringify({ type: 'state', state: st }) });
    runFrames(4);
  }

  // A KILL event and a RESULT state.
  wsInstance.onmessage({ data: JSON.stringify({ type: 'event', event: { type: 'KILL', killer: 'me', victim: 'b' } }) });
  const res = makeState('TOURNAMENT', 'VOID', false);
  res.phase = 'RESULT';
  res.tournament = { round: 3, rounds: 3, active: false, standings: [{ id: 'me', name: 'ME', color: '#39ff14', points: 9, place: 1 }], champion: { id: 'me', name: 'ME', color: '#39ff14', points: 9 } };
  res.results = [{ id: 'me', pid: null, name: 'ME', color: '#39ff14', rank: 1, score: 100, kills: 1, foodCount: 3, roundPoints: 2 }];
  wsInstance.onmessage({ data: JSON.stringify({ type: 'state', state: res }) });
  runFrames(2);

  check('R2: rendered frames across all maps/patterns without throwing', true);
  check('R3: canvas draw calls were issued', drawCalls > 0);
} catch (e) {
  check(`render harness threw: ${e && e.stack || e}`, false);
}

console.log(`\n${failures === 0 ? 'ALL RENDER TESTS PASS' : failures + ' RENDER TESTS FAILED'}`);
process.exit(failures === 0 ? 0 : 1);
