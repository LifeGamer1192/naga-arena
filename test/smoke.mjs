// Headless end-to-end smoke for the continuous endless arena.
// Two clients drop into a room: one chases frogs (should grow), one drives off
// a VOID edge repeatedly (should die and respawn). Verifies the core loop.
import { WebSocket } from 'ws';

const URL = process.env.URL || 'ws://localhost:3000';
const ROOM = process.env.ROOM || 'SMOKE';
const MAP = process.env.MAP || 'VOID'; // VOID has edges so the suicide bot can die
const log = (...a) => console.log('[test]', ...a);

let failures = 0;
const check = (name, cond) => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}`); if (!cond) failures++; };

function makeClient(label, strategy) {
  const ws = new WebSocket(URL);
  const c = { ws, label, id: null, state: null, sawAlive: false, moved: false, maxScore: 0, maxLen: 0, deaths: 0, respawns: 0, _alive: null, _hx: null, _hy: null };
  ws.on('open', () => ws.send(JSON.stringify({ type: 'join', room: ROOM, map: MAP, bots: 2, pid: `pid-${label}-${ROOM}`, name: `P-${label}` })));
  ws.on('message', (raw) => {
    const msg = JSON.parse(raw.toString());
    if (msg.type === 'welcome') { c.id = msg.id; return; }
    if (msg.type !== 'state') return;
    c.state = msg.state;
    const me = msg.state.snakes.find((s) => s.id === c.id);
    if (!me) return;
    if (me.alive) { c.sawAlive = true; c.maxScore = Math.max(c.maxScore, me.score); c.maxLen = Math.max(c.maxLen, me.length); c.maxBodyPts = Math.max(c.maxBodyPts || 0, (me.body || []).length); }
    c.maxBots = Math.max(c.maxBots || 0, msg.state.snakes.filter((s) => s.bot).length);
    if (me.alive && me.head) {
      if (c._hx != null && (Math.abs(me.head.x - c._hx) > 0.01 || Math.abs(me.head.y - c._hy) > 0.01)) c.moved = true;
      c._hx = me.head.x; c._hy = me.head.y;
    }
    if (c._alive === true && me.alive === false) c.deaths++;
    if (c._alive === false && me.alive === true) c.respawns++;
    c._alive = me.alive;
    strategy(c, me, msg.state);
  });
  return c;
}

function aim(c, ang) { c.ws.send(JSON.stringify({ type: 'aim', ang })); }

// Chase the nearest frog.
function greedy(c, me, state) {
  if (!me.alive || !me.head || !state.food.length) return;
  let best = null, bd = Infinity;
  for (const f of state.food) { const d = (f.x - me.head.x) ** 2 + (f.y - me.head.y) ** 2; if (d < bd) { bd = d; best = f; } }
  if (best) aim(c, Math.atan2(best.y - me.head.y, best.x - me.head.x));
}
// Drive straight at the right edge so it dies on VOID, then respawns.
function suicide(c, me) { if (me.alive) aim(c, 0); }

const a = makeClient('A', greedy);
const b = makeClient('B', suicide);

const RUN_MS = 12000;
setTimeout(finish, RUN_MS);

function finish() {
  log('--- assertions ---');
  check('both clients connected & got an id', !!a.id && !!b.id);
  check('both clients saw themselves alive', a.sawAlive && b.sawAlive);
  check('snakes moved (continuous motion)', a.moved && b.moved);
  check('frog-chaser grew / scored', a.maxScore > 0 || a.maxLen > 5);
  check('snake body has multiple trail points (continuous body)', (a.maxBodyPts || 0) >= 5);
  check('AI bots present in the room', (a.maxBots || 0) >= 2);
  check('suicide bot died and respawned (infinite respawn)', b.deaths >= 1 && b.respawns >= 1);
  console.log(`   A: score=${a.maxScore} len=${a.maxLen} bodyPts=${a.maxBodyPts} bots=${a.maxBots} | B: deaths=${b.deaths} respawns=${b.respawns}`);
  console.log(`\n${failures === 0 ? 'ALL PASS' : failures + ' FAILED'}`);
  a.ws.close(); b.ws.close();
  process.exit(failures === 0 ? 0 : 1);
}
