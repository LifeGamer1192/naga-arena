// Deterministic unit tests for the continuous endless engine (no network).
import { GameRoom, RoomManager, CONFIG, PALETTE32, sanitizeName } from '../server/game.js';

let failures = 0;
const check = (name, cond) => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}`); if (!cond) failures++; };
const only = (room) => [...room.players.values()][0];

// U1: a new player spawns alive with a trail and a palette colour.
(() => {
  const room = new GameRoom('T', 'VOID');
  const p = room.addPlayer('a', { name: 'ALPHA' });
  check('U1: spawned alive with trail', p.alive && p.trail.length > 2);
  check('U1: colour from palette', PALETTE32.includes(p.color));
  check('U1: food spawned', room.food.length > 0);
})();

// U2: colour is name-derived (deterministic) and de-duplicated per room.
(() => {
  const r1 = new GameRoom('A', 'VOID'); const c1 = r1.addPlayer('x', { name: 'Bob' }).color;
  const r2 = new GameRoom('B', 'VOID'); const c2 = r2.addPlayer('y', { name: 'Bob' }).color;
  check('U2: same name -> same colour', c1 === c2);
  const room = new GameRoom('C', 'VOID');
  const a = room.addPlayer('a', { name: 'Bob' }), b = room.addPlayer('b', { name: 'Bob' });
  check('U2: same-name players get distinct colours', a.color !== b.color);
})();

// U3: heading turns toward the target (rate-limited) and the head moves forward.
(() => {
  const room = new GameRoom('T', 'TUNNEL');
  const p = room.addPlayer('a', { name: 'A' });
  p.hx = 10; p.hy = 10; p.ang = 0; p.targetAng = Math.PI / 2;
  const x0 = p.hx;
  room.update(100);
  check('U3: turned toward target but rate-limited', p.ang > 0 && p.ang <= CONFIG.TURN * 0.1 + 1e-6);
  check('U3: head advanced forward', p.hx > x0);
})();

// U4: tunnel wraps around the edge instead of dying.
(() => {
  const room = new GameRoom('T', 'TUNNEL');
  const p = room.addPlayer('a', { name: 'A' });
  p.hx = 0.1; p.hy = 5; p.ang = Math.PI; p.targetAng = Math.PI; // heading -x
  room.update(60);
  check('U4: wrapped to far edge, alive', p.alive && p.hx > room.map.w - 1);
})();

// U5: walls are lethal.
(() => {
  const room = new GameRoom('T', 'LABYRINTH');
  const p = room.addPlayer('a', { name: 'A' });
  const [wx, wy] = [...room.map.walls][0].split(',').map(Number);
  p.hx = wx + 0.5; p.hy = wy + 0.5; p.ang = 0; p.targetAng = 0;
  room.update(16);
  check('U5: entering a wall kills', !p.alive);
})();

// U6: eating a frog grows the body and scores.
(() => {
  const room = new GameRoom('T', 'TUNNEL');
  const p = room.addPlayer('a', { name: 'A' });
  p.hx = 10; p.hy = 10; p.bodyLen = CONFIG.START_LEN;
  room.food = [{ id: 999, x: 10, y: 10 }];
  room.update(16);
  check('U6: ate one frog', p.foodCount === 1 && p.score === 10);
  check('U6: body grew', p.bodyLen > CONFIG.START_LEN);
})();

// U7: another snake's body is lethal, but your own tail is safe.
(() => {
  const room = new GameRoom('T', 'TUNNEL');
  const a = room.addPlayer('a', { name: 'A' });
  const b = room.addPlayer('b', { name: 'B' });
  // B is a straight horizontal body; put A's head onto B's mid-trail.
  b.hx = 14; b.hy = 10; b.ang = 0; b.targetAng = 0;
  b.trail = []; for (let i = 0; i < 12; i++) b.trail.push({ x: 14 - i * CONFIG.SPACING, y: 10 });
  a.hx = b.trail[5].x; a.hy = 10; a.ang = Math.PI; a.targetAng = Math.PI;
  room.update(16);
  check('U7: hitting another snake is lethal', !a.alive);
  check('U7: the other snake survives', b.alive);

  // Self-safety: a lone snake curling into its own body stays alive.
  const room2 = new GameRoom('S', 'TUNNEL');
  const s = room2.addPlayer('s', { name: 'S' });
  s.hx = 15; s.hy = 15; s.ang = 0; s.targetAng = 0; s.bodyLen = 8;
  s.targetAng = Math.PI; // force a hard U-turn so the head crosses the tail
  let alive = true;
  for (let i = 0; i < 60 && alive; i++) { room2.update(33); alive = s.alive; }
  check('U7: self tail is safe through a tight turn', s.alive);
})();

// U8: a dead snake respawns after the countdown.
(() => {
  const room = new GameRoom('T', 'TUNNEL');
  const p = room.addPlayer('a', { name: 'A' });
  const wasColor = p.color;
  room.kill(p, null, []);
  check('U8: dead with respawn scheduled', !p.alive && p.respawnAt > 0);
  for (let t = 0; t <= CONFIG.RESPAWN_MS + 200 && !p.alive; t += 50) room.update(50);
  check('U8: respawned alive', p.alive && p.color === wasColor);
})();

// U9: leaving the field on a non-tunnel map is lethal.
(() => {
  const room = new GameRoom('T', 'VOID');
  const p = room.addPlayer('a', { name: 'A' });
  p.hx = 0.1; p.hy = 5; p.ang = Math.PI; p.targetAng = Math.PI;
  room.update(120);
  check('U9: out of bounds kills on VOID', !p.alive);
})();

// U10: food is replenished up to the target density.
(() => {
  const room = new GameRoom('T', 'VOID');
  room.addPlayer('a', { name: 'A' });
  room.food = []; room.ensureFood();
  check('U10: food maintained at target', room.food.length === room.targetFood && room.targetFood > 0);
})();

// U11: RoomManager creates, reuses and cleans up rooms.
(() => {
  const m = new RoomManager();
  const r1 = m.getOrCreate('abc', 'TUNNEL');
  const r2 = m.getOrCreate('ABC');
  check('U11: same code reuses room', r1 === r2 && r1.code === 'ABC');
  check('U11: code generator', /^[A-Z0-9]{5}$/.test(m.generateCode()));
  r1.addPlayer('z', { name: 'Z' }); r1.removePlayer('z');
  m.updateAll(16);
  check('U11: empty room cleaned up', !m.rooms.has('ABC'));
})();

// U12: name sanitisation.
(() => {
  check('U12: trims & caps', sanitizeName('  Snakey McSnake Face  ').length <= 16);
  check('U12: empty -> null', sanitizeName('   ') === null);
})();

console.log(`\n${failures === 0 ? 'ALL UNIT TESTS PASS' : failures + ' UNIT TESTS FAILED'}`);
process.exit(failures === 0 ? 0 : 1);
