// Headless render smoke for the browser client.
// Mocks enough of the DOM / Canvas / WebSocket APIs to actually execute
// public/client.js and drive render frames across every map, catching runtime
// errors in the rendering path that the server-side smoke cannot reach.
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
    canvas: { width: 1200, height: 800 },
    createRadialGradient: () => gradient, createLinearGradient: () => gradient,
    fillRect() { drawCalls++; }, arc() { drawCalls++; }, ellipse() { drawCalls++; },
    fillText() {}, measureText: (s) => ({ width: String(s).length * 6 }),
    setLineDash() {}, setTransform() {}, save() {}, restore() {},
    translate() {}, rotate() {}, beginPath() {}, moveTo() {}, lineTo() {}, stroke() {},
    fill() {}, arcTo() {}, closePath() {}, clearRect() {}, strokeRect() {},
  }, { get(t, k) { return (k in t) ? t[k] : (() => {}); }, set(t, k, v) { t[k] = v; return true; } });
}

const rafQueue = [];
function makeEl() {
  const ctx = makeCtx();
  return {
    width: 1200, height: 800, value: '', textContent: '', innerHTML: '', dataset: {},
    style: {}, classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
    addEventListener() {}, appendChild() {}, querySelectorAll() { return []; }, getContext() { return ctx; },
  };
}
const elements = new Map();
const doc = {
  getElementById(id) { if (!elements.has(id)) elements.set(id, makeEl()); return elements.get(id); },
  querySelectorAll() { return []; }, addEventListener() {}, createElement() { return makeEl(); },
};

let wsInstance = null;
class MockWS { constructor() { this.readyState = 1; wsInstance = this; setTimeout(() => this.onopen && this.onopen(), 0); } send() {} close() {} }
MockWS.OPEN = 1;
function audioNode() { return new Proxy({ frequency: { setValueAtTime() {}, exponentialRampToValueAtTime() {} }, gain: { setValueAtTime() {}, exponentialRampToValueAtTime() {} } }, { get(t, k) { return (k in t) ? t[k] : (() => {}); } }); }
class MockAudioContext { constructor() { this.currentTime = 0; this.state = 'running'; this.destination = {}; } createOscillator() { return audioNode(); } createGain() { return audioNode(); } resume() {} }

const sandbox = {
  window: {}, addEventListener() {}, document: doc, innerWidth: 1200, innerHeight: 800,
  navigator: { maxTouchPoints: 0, clipboard: { writeText: () => Promise.resolve() } },
  location: { protocol: 'http:', host: 'localhost:3000', href: 'http://localhost:3000/', search: '' },
  history: { replaceState() {} },
  localStorage: { _d: {}, getItem(k) { return this._d[k] ?? null; }, setItem(k, v) { this._d[k] = String(v); } },
  WebSocket: MockWS, AudioContext: MockAudioContext, crypto: { randomUUID: () => 'test-uuid' },
  URL, URLSearchParams, requestAnimationFrame: (cb) => { rafQueue.push(cb); return rafQueue.length; },
  setTimeout: (fn) => { try { fn(); } catch (e) { throw e; } return 0; }, setInterval: () => 0,
  Math, JSON, Date, console, parseInt, parseFloat, isNaN, Object, Array, String, Number,
};
sandbox.window = sandbox; sandbox.globalThis = sandbox;
function runFrames(n) { for (let i = 0; i < n; i++) { const q = rafQueue.splice(0); for (const cb of q) cb(); } }

function makeState(mapId, tunnel) {
  const body = []; for (let i = 0; i < 14; i++) body.push({ x: 10 - i * 0.4, y: 7 });
  return {
    code: 'TEST',
    map: { id: mapId, w: 20, h: 15, tunnel: !!tunnel, walls: tunnel ? [] : [{ x: 5, y: 5 }, { x: 6, y: 5 }] },
    snakes: [
      { id: 'me', name: 'ME', color: '#39ff14', bot: false, alive: true, head: { x: 10, y: 7 }, body, score: 50, length: 12, giant: true, effects: [{ type: 'giant', remain: 8 }, { type: 'vacuum', remain: 14 }], respawnIn: 0 },
      { id: 'b', name: 'BOT 1', color: '#ff2d55', bot: true, alive: true, head: { x: 2, y: 12 }, body: [{ x: 2, y: 12 }, { x: 19.6, y: 12 }], score: 20, length: 6, giant: false, effects: [{ type: 'poisoned', remain: 5 }], respawnIn: 0 },
      { id: 'c', name: 'CC', color: '#0a84ff', bot: false, alive: false, head: null, body: [], score: 10, length: 5, giant: false, effects: [], respawnIn: 2 },
    ],
    food: [
      { id: 1, kind: 'FROG', x: 3.5, y: 3.2, ang: 0.7 }, { id: 2, kind: 'FROG', x: 12.1, y: 9.4, ang: 2.4 },
      { id: 3, kind: 'VACUUM', x: 0.5, y: 0.5, color: '#00e5ff' }, { id: 4, kind: 'GIANT', x: 8, y: 2, color: '#ffd60a' },
      { id: 5, kind: 'POISON', x: 15, y: 13, color: '#7cfc3a' },
    ],
    poison: [{ x: 6, y: 8 }, { x: 6.5, y: 8.3 }],
  };
}

let failures = 0;
const check = (name, cond) => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}`); if (!cond) failures++; };

try {
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox, { filename: 'client.js' });
  check('R1: client.js loaded without throwing', true);

  wsInstance.onmessage({ data: JSON.stringify({ type: 'welcome', id: 'me', room: 'TEST', you: { name: 'ME', color: '#39ff14' } }) });
  for (const [mapId, tunnel] of [['TUNNEL', true], ['VOID', false], ['LABYRINTH', false], ['ARENA', false]]) {
    wsInstance.onmessage({ data: JSON.stringify({ type: 'state', state: makeState(mapId, tunnel) }) });
    runFrames(3);
  }
  wsInstance.onmessage({ data: JSON.stringify({ type: 'event', event: { type: 'KILL', killer: 'me', victim: 'b' } }) });
  // Local player dead -> respawn overlay path.
  const dead = makeState('TUNNEL', true);
  dead.snakes[0].alive = false; dead.snakes[0].head = null; dead.snakes[0].body = []; dead.snakes[0].respawnIn = 3;
  wsInstance.onmessage({ data: JSON.stringify({ type: 'state', state: dead }) });
  runFrames(3);

  check('R2: rendered all maps + kill + respawn without throwing', true);
  check('R3: canvas draw calls were issued', drawCalls > 0);
} catch (e) {
  check(`render harness threw: ${e && e.stack || e}`, false);
}

console.log(`\n${failures === 0 ? 'ALL RENDER TESTS PASS' : failures + ' RENDER TESTS FAILED'}`);
process.exit(failures === 0 ? 0 : 1);
