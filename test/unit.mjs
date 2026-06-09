// Deterministic unit tests for the Phase 2 + Phase 3 engine (no network).
import { GameRoom, RoomManager, CONFIG, sanitizeName, sanitizeSkin } from '../server/game.js';
import { RatingStore, tierOf } from '../server/ratings.js';
import os from 'os';
import path from 'path';

let failures = 0;
const check = (name, cond) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}`);
  if (!cond) failures++;
};

// Build a room forced into PLAYING with the given player count.
function playingRoom(n, mode = 'BATTLE_ROYALE', map = 'VOID') {
  const room = new GameRoom('TEST', mode, map);
  for (let i = 0; i < n; i++) room.addPlayer('p' + i);
  for (const id of [...room.players.keys()]) room.setReady(id, true);
  room.maybeStart();                       // -> COUNTDOWN, snakes spawned
  room.update(CONFIG.COUNTDOWN_MS + 1);    // -> PLAYING, clock reset to 0
  return room;
}
const arr = (room) => [...room.players.values()];
const stepOnce = (room) => room.update(CONFIG.STEP_MS); // advance every snake one cell

// T1: wall crash kills, Battle Royale last-survivor win + rank x2.0 multiplier.
(() => {
  const room = playingRoom(2);
  const [a, b] = arr(room);
  a.body = [{ x: room.map.w - 1, y: 5 }, { x: room.map.w - 2, y: 5 }, { x: room.map.w - 3, y: 5 }];
  a.dir = a.pendingDir = 'RIGHT';
  b.body = [{ x: 5, y: 20 }, { x: 4, y: 20 }, { x: 3, y: 20 }];
  b.dir = b.pendingDir = 'DOWN'; b.score = 10;
  room.items = [];
  stepOnce(room);
  check('T1: wall crash kills A', !a.alive);
  check('T1: B survives & round ends', b.alive && room.phase === 'RESULT');
  const w = room.results.find((r) => r.rank === 1);
  check('T1: B is rank-1 with x2.0 multiplier (score 20)', w && w.id === b.id && w.score === 20);
})();

// T2: ramming another snake credits a kill (+50) and emits a KILL event.
(() => {
  const room = playingRoom(2);
  const [a, b] = arr(room);
  b.body = [{ x: 10, y: 8 }, { x: 10, y: 9 }, { x: 10, y: 10 }, { x: 10, y: 11 }]; b.dir = b.pendingDir = 'UP';
  a.body = [{ x: 9, y: 10 }, { x: 8, y: 10 }, { x: 7, y: 10 }]; a.dir = a.pendingDir = 'RIGHT';
  room.items = [];
  const events = stepOnce(room);
  check('T2: A dies ramming B', !a.alive);
  check('T2: B credited kill +50', b.kills === 1 && b.score === 50);
  check('T2: KILL event emitted', events.some((e) => e.type === 'KILL' && e.killer === b.id && e.victim === a.id));
})();

// T3: 180-degree reversal rejected, perpendicular accepted.
(() => {
  const room = playingRoom(1);
  const [a] = arr(room); a.dir = a.pendingDir = 'RIGHT';
  room.setDirection(a.id, 'LEFT');
  check('T3: reversal ignored', a.pendingDir === 'RIGHT');
  room.setDirection(a.id, 'UP');
  check('T3: perpendicular accepted', a.pendingDir === 'UP');
})();

// T4: eating food grows the snake and applies combo scoring.
(() => {
  const room = playingRoom(1);
  const [a] = arr(room);
  a.body = [{ x: 5, y: 5 }, { x: 4, y: 5 }, { x: 3, y: 5 }]; a.dir = a.pendingDir = 'RIGHT';
  a.combo = 0; a.score = 0;
  room.items = [{ id: 1, type: 'FOOD', x: 6, y: 5 }];
  const len = a.body.length;
  stepOnce(room);
  check('T4: grew by 1', a.body.length === len + 1);
  check('T4: foodCount + score', a.foodCount === 1 && a.score >= 11);
})();

// T5: SUPER_FOOD grows by 3 and scores 50+.
(() => {
  const room = playingRoom(1);
  const [a] = arr(room);
  a.body = [{ x: 5, y: 5 }, { x: 4, y: 5 }, { x: 3, y: 5 }]; a.dir = a.pendingDir = 'RIGHT';
  room.ensureFood = () => {}; // keep the field deterministic across the multi-step advance
  room.items = [{ id: 1, type: 'SUPER_FOOD', x: 6, y: 5 }];
  const len = a.body.length;
  // Advance enough steps for the +3 growth to fully materialise.
  for (let i = 0; i < 3; i++) stepOnce(room);
  check('T5: SUPER_FOOD grew by 3', a.body.length === len + 3);
})();

// T6: SHIELD absorbs a lethal hit once.
(() => {
  const room = playingRoom(1);
  const [a] = arr(room);
  a.body = [{ x: room.map.w - 1, y: 5 }, { x: room.map.w - 2, y: 5 }, { x: room.map.w - 3, y: 5 }];
  a.dir = a.pendingDir = 'RIGHT';
  a.shieldUntil = 999999; room.items = [];
  const events = stepOnce(room);
  check('T6: shield saved A from wall', a.alive && a.shieldUntil === 0);
  check('T6: SHIELD event emitted', events.some((e) => e.type === 'SHIELD'));
})();

// T7: GHOST lets a snake pass through a body.
(() => {
  const room = playingRoom(2);
  const [a, b] = arr(room);
  b.body = [{ x: 6, y: 5 }, { x: 6, y: 6 }, { x: 6, y: 7 }]; b.dir = b.pendingDir = 'DOWN';
  a.body = [{ x: 5, y: 5 }, { x: 4, y: 5 }, { x: 3, y: 5 }]; a.dir = a.pendingDir = 'RIGHT';
  a.ghostUntil = 999999; room.items = [];
  stepOnce(room);
  check('T7: ghost passed through, A alive at (6,5)', a.alive && a.body[0].x === 6 && a.body[0].y === 5);
})();

// T8: SPEED_UP makes a snake advance two cells where a normal snake moves one.
(() => {
  const room = playingRoom(1);
  const [a] = arr(room);
  a.body = [{ x: 5, y: 5 }, { x: 4, y: 5 }, { x: 3, y: 5 }]; a.dir = a.pendingDir = 'RIGHT';
  a.speedUntil = 999999; room.items = [];
  room.update(180); // > 130 * (1/1.5) * 2 -> two steps at 1.5x speed
  check('T8: speed snake advanced 2 cells', a.body[0].x === 7);
})();

// T9: SHRINK roughly halves a long snake.
(() => {
  const room = playingRoom(1);
  const [a] = arr(room);
  a.body = []; for (let i = 0; i < 8; i++) a.body.push({ x: 10 - i, y: 5 });
  a.dir = a.pendingDir = 'RIGHT';
  room.items = [{ id: 1, type: 'SHRINK', x: 11, y: 5 }];
  stepOnce(room);
  check('T9: snake shrank', a.body.length < 8 && a.body.length >= CONFIG.START_LEN);
})();

// T10: TUNNEL map wraps around the edge instead of killing.
(() => {
  const room = playingRoom(1, 'BATTLE_ROYALE', 'TUNNEL');
  const [a] = arr(room);
  a.body = [{ x: 0, y: 5 }, { x: 1, y: 5 }, { x: 2, y: 5 }]; a.dir = a.pendingDir = 'LEFT';
  room.items = [];
  stepOnce(room);
  check('T10: wrapped to right edge, alive', a.alive && a.body[0].x === room.map.w - 1);
})();

// T11: TEAM_BATTLE - friendly pass-through vs enemy collision.
(() => {
  const room = playingRoom(4, 'TEAM_BATTLE'); // teams alternate RED/BLUE/RED/BLUE
  const ps = arr(room);
  const red = ps.filter((p) => p.team === 'RED');
  const [r1, r2] = red;
  // r2 head at (6,5) with its body extending UP, so moving DOWN is valid.
  r2.body = [{ x: 6, y: 5 }, { x: 6, y: 4 }, { x: 6, y: 3 }]; r2.dir = r2.pendingDir = 'DOWN';
  r1.body = [{ x: 5, y: 5 }, { x: 4, y: 5 }, { x: 3, y: 5 }]; r1.dir = r1.pendingDir = 'RIGHT';
  room.items = [];
  stepOnce(room);
  check('T11: teammate pass-through (both alive)', r1.alive && r2.alive && r1.body[0].x === 6);
})();

// T12: SCORE_ATTACK respawns a dead snake after the delay, keeping score.
(() => {
  const room = playingRoom(1, 'SCORE_ATTACK'); // solo keeps the field clear
  const [a] = arr(room);
  a.score = 42;
  room.killSnake(a, null, []);
  check('T12: dead with respawn scheduled', !a.alive && a.respawnAt > 0);
  // Advance in small real-time steps; stop the instant the respawn lands so the
  // fresh snake never fast-forwards into a wall.
  for (let t = 0; t <= CONFIG.RESPAWN_MS + 1000 && !a.alive; t += 50) room.update(50);
  check('T12: respawned with score kept', a.alive && a.score === 42);
})();

// T13: RoomManager creates, reuses and cleans up rooms.
(() => {
  const m = new RoomManager();
  const r1 = m.getOrCreate('abc', 'BATTLE_ROYALE', 'VOID');
  const r2 = m.getOrCreate('ABC');
  check('T13: same code reuses room', r1 === r2 && r1.code === 'ABC');
  const gen = m.generateCode();
  check('T13: generated code is 5 chars', /^[A-Z0-9]{5}$/.test(gen));
  r1.addPlayer('x'); r1.removePlayer('x'); // now empty
  m.updateAll(16);
  check('T13: empty room cleaned up', !m.rooms.has('ABC'));
})();

// T14: rating tiers map correctly at boundaries.
(() => {
  check('T14: 1000 -> SILVER', tierOf(1000).name === 'SILVER');
  check('T14: 999 -> BRONZE', tierOf(999).name === 'BRONZE');
  check('T14: 2500 -> SERPENT KING', tierOf(2500).name === 'SERPENT KING');
})();

// T15: RatingStore applies tier-scaled win/loss to a ranked round.
(() => {
  const store = new RatingStore(path.join(os.tmpdir(), 'naga-test-ratings-' + 'x' + '.json'));
  store.players.clear();
  const changes = store.recordRankedRound([
    { pid: 'a', name: 'A', rank: 1 },
    { pid: 'b', name: 'B', rank: 2 },
  ]);
  const ca = changes.get('a'), cb = changes.get('b');
  // Both start at 1000 (SILVER): win +25, loss -22.
  check('T15: winner +25 from SILVER', ca && ca.won && ca.delta === 25 && ca.after === 1025);
  check('T15: loser -22 from SILVER', cb && !cb.won && cb.delta === -22 && cb.after === 978);
  check('T15: leaderboard sorted by rating', store.leaderboard()[0].name === 'A');
})();

// T16: RANKED round applies ratings and annotates result rows.
(() => {
  const store = new RatingStore(path.join(os.tmpdir(), 'naga-test-ratings-2.json'));
  store.players.clear();
  const room = new GameRoom('RK', 'RANKED', 'VOID');
  room.ratings = store;
  const pa = room.addPlayer('a', { pid: 'pa', name: 'ALPHA' });
  const pb = room.addPlayer('b', { pid: 'pb', name: 'BETA' });
  room.setReady('a', true); room.setReady('b', true);
  room.maybeStart();
  room.update(CONFIG.COUNTDOWN_MS + 1);
  // B crashes into the wall; A survives and wins the ranked round.
  pb.body = [{ x: room.map.w - 1, y: 5 }, { x: room.map.w - 2, y: 5 }, { x: room.map.w - 3, y: 5 }];
  pb.dir = pb.pendingDir = 'RIGHT';
  pa.body = [{ x: 5, y: 20 }, { x: 4, y: 20 }, { x: 3, y: 20 }]; pa.dir = pa.pendingDir = 'DOWN';
  room.items = [];
  room.update(CONFIG.STEP_MS);
  check('T16: ranked round ended', room.phase === 'RESULT');
  const winner = room.results.find((r) => r.rank === 1);
  check('T16: winner row annotated with rating gain', winner && winner.rating && winner.rating.delta === 25);
  check('T16: store updated for winner', store.get('pa').rating === 1025);
})();

// T17: a player joining mid-round spectates and is excluded from results.
(() => {
  const room = playingRoom(2);
  const spec = room.addPlayer('spec', { pid: 'ps', name: 'WATCHER' });
  check('T17: mid-round joiner is spectating', spec.spectating === true);
  check('T17: spectator not a round participant', !room.roundParticipants.includes(spec));
  // End the round; spectator must not appear in results.
  const [a, b] = arr(room).filter((p) => p !== spec);
  a.body = [{ x: room.map.w - 1, y: 5 }, { x: room.map.w - 2, y: 5 }, { x: room.map.w - 3, y: 5 }];
  a.dir = a.pendingDir = 'RIGHT';
  room.items = [];
  stepOnce(room);
  check('T17: results exclude the spectator', !room.results.some((r) => r.id === 'spec'));
})();

// T18: name sanitisation.
(() => {
  check('T18: trims & caps name', sanitizeName('  Snakey McSnake Face  ').length <= 16);
  check('T18: empty -> null', sanitizeName('   ') === null);
  check('T18: strips control chars', sanitizeName('a'+String.fromCharCode(1)+'b'+String.fromCharCode(31)+'c') === 'abc');
})();

// T19: skin sanitisation.
(() => {
  const ok = sanitizeSkin({ pattern: 'NEON', color: '#39ff14' });
  check('T19: valid skin kept', ok.pattern === 'NEON' && ok.color === '#39ff14');
  const bad = sanitizeSkin({ pattern: 'BOGUS', color: '#123123' });
  check('T19: invalid pattern -> SOLID, bad color -> null', bad.pattern === 'SOLID' && bad.color === null);
  check('T19: null skin -> null', sanitizeSkin(null) === null);
})();

// T20: skin is applied to the player and exposed in the snapshot.
(() => {
  const room = new GameRoom('SK', 'BATTLE_ROYALE', 'VOID');
  const p = room.addPlayer('a', { skin: { pattern: 'STRIPES', color: '#0a84ff' } });
  check('T20: player skin stored', p.skin.pattern === 'STRIPES');
  check('T20: chosen colour overrides auto colour', p.color === '#0a84ff');
  const snap = room.snapshot();
  check('T20: snapshot carries skin', snap.snakes[0].skin.pattern === 'STRIPES');
})();

// T21: TOURNAMENT runs N rounds, accumulates points, then crowns a champion.
(() => {
  const room = new GameRoom('TR', 'TOURNAMENT', 'VOID');
  const pa = room.addPlayer('a'); const pb = room.addPlayer('b');
  room.setReady('a', true); room.setReady('b', true);
  room.maybeStart();
  check('T21: tournament started, round 0, active', room.tournamentActive && room.tournamentRound === 0);

  const forceRoundEnd = () => {
    room.update(CONFIG.COUNTDOWN_MS + 1); // COUNTDOWN -> PLAYING
    // a survives (heads down in open space); b drives into the right wall.
    pa.body = [{ x: 5, y: 20 }, { x: 4, y: 20 }, { x: 3, y: 20 }]; pa.dir = pa.pendingDir = 'DOWN';
    pb.body = [{ x: room.map.w - 1, y: 6 }, { x: room.map.w - 2, y: 6 }, { x: room.map.w - 3, y: 6 }];
    pb.dir = pb.pendingDir = 'RIGHT';
    room.ensureFood = () => {}; room.items = [];
    room.update(CONFIG.STEP_MS); // b crashes -> endRound -> RESULT
  };

  forceRoundEnd();
  check('T21: round 1 ended, points awarded', room.tournamentRound === 1 && room.phase === 'RESULT');
  const r1 = room.results.find((r) => r.id === 'a');
  check('T21: winner got round points', r1 && r1.roundPoints === 2);

  // Advance through the remaining rounds.
  room.update(CONFIG.INTERMISSION_MS + 1); // RESULT -> next COUNTDOWN
  forceRoundEnd(); // round 2
  room.update(CONFIG.INTERMISSION_MS + 1);
  forceRoundEnd(); // round 3 (final)
  check('T21: tournament finished after 3 rounds', room.tournamentRound === 3 && !room.tournamentActive);
  check('T21: champion is player a (most points)', room.champion && room.champion.id === 'a');
  check('T21: standings total points = 6 for a', room.tournamentStandings()[0].points === 6);

  // After the final RESULT, it returns to the lobby (not another round).
  room.update(CONFIG.RESULT_MS + 1);
  check('T21: returns to lobby after final round', room.phase === 'LOBBY');
})();

console.log(`\n${failures === 0 ? 'ALL UNIT TESTS PASS' : failures + ' UNIT TESTS FAILED'}`);
process.exit(failures === 0 ? 0 : 1);
