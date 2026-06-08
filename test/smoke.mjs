// Headless smoke test for NAGA ARENA Phase 1.
// Spawns two WebSocket clients, plays a Battle Royale round to completion,
// and asserts the core mechanics (food eating, growth, win condition, scoring).
import { WebSocket } from 'ws';

const URL = process.env.URL || 'ws://localhost:3000';
const log = (...a) => console.log('[test]', ...a);
let failures = 0;
function check(name, cond) {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}`);
  if (!cond) failures++;
}

const OPP = { UP: 'DOWN', DOWN: 'UP', LEFT: 'RIGHT', RIGHT: 'LEFT' };

function makeClient(label, strategy) {
  const ws = new WebSocket(URL);
  const c = { ws, label, id: null, state: null, dir: 'RIGHT', maxLen: 0, ateScore: 0, sawPlaying: false, result: null };
  ws.on('message', (raw) => {
    const msg = JSON.parse(raw.toString());
    if (msg.type === 'welcome') {
      c.id = msg.id;
      ws.send(JSON.stringify({ type: 'ready', ready: true }));
    } else if (msg.type === 'state') {
      c.state = msg.state;
      const me = msg.state.snakes.find((s) => s.id === c.id);
      if (me) {
        c.maxLen = Math.max(c.maxLen, me.body.length);
        c.ateScore = Math.max(c.ateScore, me.score);
      }
      if (msg.state.phase === 'PLAYING') {
        c.sawPlaying = true;
        strategy(c, me, msg.state);
      }
      if (msg.state.phase === 'RESULT' && msg.state.results) {
        c.result = msg.state.results;
      }
    }
  });
  return c;
}

function steer(c, dir) {
  if (!dir || dir === OPP[c.dir]) return;
  c.dir = dir;
  c.ws.send(JSON.stringify({ type: 'input', dir }));
}

// Greedy food seeker: move head toward nearest food.
function greedy(c, me, state) {
  if (!me || !me.alive || state.food.length === 0) return;
  const head = me.body[0];
  let best = null, bestD = Infinity;
  for (const f of state.food) {
    const d = Math.abs(f.x - head.x) + Math.abs(f.y - head.y);
    if (d < bestD) { bestD = d; best = f; }
  }
  if (!best) return;
  const dx = best.x - head.x, dy = best.y - head.y;
  let dir;
  if (Math.abs(dx) >= Math.abs(dy)) dir = dx > 0 ? 'RIGHT' : (dx < 0 ? 'LEFT' : c.dir);
  else dir = dy > 0 ? 'DOWN' : 'UP';
  // Avoid immediate reversal; fall back to a perpendicular move.
  if (dir === OPP[c.dir]) dir = dy !== 0 ? (head.x > 1 ? 'LEFT' : 'RIGHT') : (head.y > 1 ? 'UP' : 'DOWN');
  steer(c, dir);
}

// Suicide runner: after a delay, drive straight into the right wall.
let suicideArmed = false;
function suicideAfter(ms) {
  setTimeout(() => { suicideArmed = true; }, ms);
  return (c, me, state) => {
    if (suicideArmed) { steer(c, 'RIGHT'); return; }
    greedy(c, me, state);
  };
}

const a = makeClient('A', greedy);
const b = makeClient('B', suicideAfter(4000)); // B eats for 4s then rams a wall

const TIMEOUT_MS = 30000;
const start = Date.now();
const timer = setInterval(() => {
  const done = a.result && b.result;
  if (done || Date.now() - start > TIMEOUT_MS) {
    clearInterval(timer);
    finish();
  }
}, 200);

function finish() {
  log('--- assertions ---');
  check('both clients connected & got an id', !!a.id && !!b.id);
  check('both clients saw PLAYING phase', a.sawPlaying && b.sawPlaying);
  check('at least one snake grew beyond start length (3)', Math.max(a.maxLen, b.maxLen) > 3);
  check('at least one snake scored points (food eaten)', Math.max(a.ateScore, b.ateScore) > 0);
  const res = a.result || b.result;
  check('round produced results', !!res && res.length === 2);
  if (res) {
    const ranks = res.map((r) => r.rank).sort();
    check('results have distinct ranks 1 and 2', ranks[0] === 1 && ranks[1] === 2);
    const winner = res.find((r) => r.rank === 1);
    check('winner has a final score > 0', winner && winner.score > 0);
    console.log('   results:', JSON.stringify(res.map((r) => ({ name: r.name, rank: r.rank, score: r.score, food: r.foodCount, kills: r.kills }))));
  }
  console.log(`\n${failures === 0 ? 'ALL PASS ✅' : failures + ' FAILED ❌'}`);
  a.ws.close(); b.ws.close();
  process.exit(failures === 0 ? 0 : 1);
}
