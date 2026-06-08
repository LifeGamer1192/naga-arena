// Deterministic unit tests for GameRoom collision/kill/score logic
// (no network). Drives the simulation directly.
import { GameRoom, CONFIG, PHASE } from '../server/game.js';

let failures = 0;
const check = (name, cond) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}`);
  if (!cond) failures++;
};

// Helper: build a room with N players forced into PLAYING.
function playingRoom(n) {
  const room = new GameRoom();
  const ids = [];
  for (let i = 0; i < n; i++) { const p = room.addPlayer('p' + i); ids.push(p.id); }
  for (const id of ids) room.setReady(id, true);
  room.maybeStart();        // -> COUNTDOWN, snakes spawned
  room.update(CONFIG.COUNTDOWN_MS + 1); // -> PLAYING
  return { room, ids };
}

// --- Test 1: wall collision kills, last survivor wins ---
(() => {
  const { room, ids } = playingRoom(2);
  const a = room.players.get(ids[0]);
  const b = room.players.get(ids[1]);
  // Put A one cell from the right wall, moving right -> dies next step.
  a.body = [{ x: CONFIG.GRID_W - 1, y: 5 }, { x: CONFIG.GRID_W - 2, y: 5 }, { x: CONFIG.GRID_W - 3, y: 5 }];
  a.dir = a.pendingDir = 'RIGHT';
  b.body = [{ x: 5, y: 20 }, { x: 4, y: 20 }, { x: 3, y: 20 }];
  b.dir = b.pendingDir = 'DOWN';
  b.score = 10; // known base score to verify the rank multiplier
  room.food = []; // avoid interference
  const events = [];
  room.step(events);
  check('T1: wall crash kills A', !a.alive);
  check('T1: B survives', b.alive);
  check('T1: round ended (last survivor)', room.phase === PHASE.RESULT);
  const winner = room.results.find((r) => r.rank === 1);
  check('T1: B is rank 1 winner', winner && winner.id === b.id);
  // base(10) + tiny survival bonus, x2.0 rank-1 multiplier -> 20
  check('T1: rank-1 x2.0 multiplier applied (score=20)', winner && winner.score === 20);
})();

// --- Test 2: ramming another snake's body credits a kill (+50) ---
(() => {
  const { room, ids } = playingRoom(2);
  const a = room.players.get(ids[0]);
  const b = room.players.get(ids[1]);
  // B is a vertical wall; A moves right into B's body cell (10,10).
  b.body = [{ x: 10, y: 8 }, { x: 10, y: 9 }, { x: 10, y: 10 }, { x: 10, y: 11 }];
  b.dir = b.pendingDir = 'UP';
  a.body = [{ x: 9, y: 10 }, { x: 8, y: 10 }, { x: 7, y: 10 }];
  a.dir = a.pendingDir = 'RIGHT';
  room.food = [];
  const events = [];
  const scoreBefore = b.score;
  room.step(events);
  check('T2: A dies ramming B body', !a.alive);
  check('T2: B credited the kill', b.kills === 1);
  check('T2: B got +50 kill reward', b.score === scoreBefore + 50);
  check('T2: a KILL event emitted with killer=B', events.some((e) => e.type === 'KILL' && e.killer === b.id && e.victim === a.id));
})();

// --- Test 3: 180-degree reversal is rejected ---
(() => {
  const { room, ids } = playingRoom(1);
  const a = room.players.get(ids[0]);
  a.dir = a.pendingDir = 'RIGHT';
  room.setDirection(a.id, 'LEFT'); // illegal reversal
  check('T3: reversal ignored (pendingDir stays RIGHT)', a.pendingDir === 'RIGHT');
  room.setDirection(a.id, 'UP'); // legal
  check('T3: perpendicular turn accepted', a.pendingDir === 'UP');
})();

// --- Test 4: eating food grows the snake and applies combo scoring ---
(() => {
  const { room, ids } = playingRoom(1);
  const a = room.players.get(ids[0]);
  a.body = [{ x: 5, y: 5 }, { x: 4, y: 5 }, { x: 3, y: 5 }];
  a.dir = a.pendingDir = 'RIGHT';
  a.combo = 0; a.score = 0;
  room.food = [{ x: 6, y: 5 }]; // directly ahead
  const lenBefore = a.body.length;
  room.step([]);
  check('T4: snake grew by 1 after eating', a.body.length === lenBefore + 1);
  check('T4: foodCount incremented', a.foodCount === 1);
  check('T4: score increased (>=11 with combo)', a.score >= 11);
})();

console.log(`\n${failures === 0 ? 'ALL UNIT TESTS PASS ✅' : failures + ' UNIT TESTS FAILED ❌'}`);
process.exit(failures === 0 ? 0 : 1);
