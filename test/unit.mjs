// Deterministic unit tests for the continuous endless engine (no network).
import { GameRoom, RoomManager, CONFIG, PALETTE32, SPECIALS, sanitizeName } from '../server/game.js';

let failures = 0;
const check = (name, cond) => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}`); if (!cond) failures++; };
const room = (opts = {}) => new GameRoom('T', { map: 'VOID', bots: 0, ...opts });

// U1: spawn alive with trail + palette colour; food present.
(() => {
  const r = room();
  const p = r.addPlayer('a', { name: 'ALPHA' });
  check('U1: spawned alive with trail', p.alive && p.trail.length > 2);
  check('U1: colour from palette', PALETTE32.includes(p.color));
  check('U1: food present', r.food.length > 0);
})();

// U2: name-derived colour, de-duplicated per room.
(() => {
  const c1 = room().addPlayer('x', { name: 'Bob' }).color;
  const c2 = room().addPlayer('y', { name: 'Bob' }).color;
  check('U2: same name -> same colour', c1 === c2);
  const r = room(); const a = r.addPlayer('a', { name: 'Bob' }), b = r.addPlayer('b', { name: 'Bob' });
  check('U2: same-name players distinct colours', a.color !== b.color);
})();

// U3: heading eases toward target; head advances.
(() => {
  const r = room({ map: 'TUNNEL' }); const p = r.addPlayer('a', { name: 'A' });
  p.hx = 10; p.hy = 10; p.ang = 0; p.targetAng = Math.PI / 2; const x0 = p.hx;
  r.update(100);
  check('U3: turned toward target (rate-limited)', p.ang > 0 && p.ang <= CONFIG.TURN * 0.1 + 1e-6);
  check('U3: head advanced', p.hx > x0);
})();

// U4: tunnel wraps; U9: VOID out-of-bounds kills.
(() => {
  const r = room({ map: 'TUNNEL' }); const p = r.addPlayer('a', { name: 'A' });
  p.hx = 0.1; p.hy = 5; p.ang = Math.PI; p.targetAng = Math.PI; r.update(60);
  check('U4: wrapped to far edge, alive', p.alive && p.hx > r.map.w - 1);
  const r2 = room(); const q = r2.addPlayer('a', { name: 'A' });
  q.hx = 0.1; q.hy = 5; q.ang = Math.PI; q.targetAng = Math.PI; r2.update(120);
  check('U9: out of bounds kills on VOID', !q.alive);
})();

// U5: walls kill.
(() => {
  const r = room({ map: 'LABYRINTH' }); const p = r.addPlayer('a', { name: 'A' });
  const [wx, wy] = [...r.map.walls][0].split(',').map(Number);
  p.hx = wx + 0.5; p.hy = wy + 0.5; p.ang = 0; r.update(16);
  check('U5: entering a wall kills', !p.alive);
})();

// U6: eating a frog grows + scores.
(() => {
  const r = room({ map: 'TUNNEL' }); const p = r.addPlayer('a', { name: 'A' });
  p.hx = 10; p.hy = 10; p.bodyLen = CONFIG.START_LEN;
  r.food = [{ id: 1, kind: 'FROG', x: 10, y: 10, ang: 0, stepAt: 1e9, turnAt: 1e9 }];
  r.update(16);
  check('U6: ate one frog (grow + score)', p.foodCount === 1 && p.score === 10 && p.bodyLen > CONFIG.START_LEN);
})();

// U7: enemy body lethal; own tail safe (non-classic).
(() => {
  const r = room({ map: 'TUNNEL' });
  const a = r.addPlayer('a', { name: 'A' }), b = r.addPlayer('b', { name: 'B' });
  a.spawnSafeUntil = 0; b.spawnSafeUntil = 0; // disable spawn protection for the collision
  b.hx = 14; b.hy = 10; b.trail = []; for (let i = 0; i < 12; i++) b.trail.push({ x: 14 - i * CONFIG.SPACING, y: 10 });
  a.hx = b.trail[5].x; a.hy = 10; a.ang = Math.PI; r.update(16);
  check('U7: hitting another snake is lethal', !a.alive && b.alive);
  // self-safe through a hard U-turn
  const r2 = room({ map: 'TUNNEL' }); const s = r2.addPlayer('s', { name: 'S' });
  s.hx = 20; s.hy = 20; s.ang = 0; s.bodyLen = 8; s.targetAng = Math.PI; let alive = true;
  for (let i = 0; i < 60 && alive; i++) { r2.update(33); alive = s.alive; }
  check('U7: own tail safe (non-classic)', s.alive);
})();

// U8: respawn after the countdown.
(() => {
  const r = room({ map: 'TUNNEL' }); const p = r.addPlayer('a', { name: 'A' });
  r.kill(p, null, []);
  check('U8: dead, respawn scheduled', !p.alive && p.respawnAt > 0);
  for (let t = 0; t <= CONFIG.RESPAWN_MS + 200 && !p.alive; t += 50) r.update(50);
  check('U8: respawned alive', p.alive);
})();

// U10: food maintained at target density.
(() => {
  const r = room(); r.addPlayer('a', { name: 'A' }); r.food = []; r.ensureFood();
  check('U10: frogs maintained at target', r.food.filter((f) => f.kind === 'FROG').length === r.targetFood && r.targetFood > 0);
})();

// U11: RoomManager create/reuse/cleanup.
(() => {
  const m = new RoomManager();
  const r1 = m.getOrCreate('abc', { bots: 0 }); const r2 = m.getOrCreate('ABC');
  check('U11: reuse by code', r1 === r2 && r1.code === 'ABC');
  check('U11: code generator', /^[A-Z0-9]{5}$/.test(m.generateCode()));
  r1.addPlayer('z', { name: 'Z' }); r1.removePlayer('z'); m.updateAll(16);
  check('U11: empty room cleaned up', !m.rooms.has('ABC'));
})();

// U12: AI bots are maintained to the target count while a human is present.
(() => {
  const r = room({ map: 'TUNNEL', bots: 3 }); r.addPlayer('human', { name: 'H' });
  r.update(16);
  const bots = [...r.players.values()].filter((p) => p.bot).length;
  check('U12: bots maintained to target', bots === 3);
  check('U12: bots have palette colours & names', [...r.players.values()].every((p) => PALETTE32.includes(p.color)));
})();

// U13: bots do not keep an empty room alive.
(() => {
  const m = new RoomManager();
  const r = m.getOrCreate('BR', { bots: 2 }); r.addPlayer('h', { name: 'H' }); m.updateAll(16);
  check('U13: room alive with a human + bots', m.rooms.has('BR') && [...r.players.values()].some((p) => p.bot));
  r.removePlayer('h'); m.updateAll(16);
  check('U13: room cleaned up once the human leaves', !m.rooms.has('BR'));
})();

// U14: frogs hop when not classic; stay still in classic.
(() => {
  const r = room({ map: 'VOID' }); r.addPlayer('a', { name: 'A' });
  const f = { id: 1, kind: 'FROG', x: 10, y: 10, ang: 0, stepAt: -1, turnAt: 1e9 };
  r.food = [f]; r.update(16);
  check('U14: frog hopped forward (normal)', f.x !== 10 || f.y !== 10);
  const rc = room({ map: 'VOID', classic: true }); rc.addPlayer('a', { name: 'A' });
  const fc = { id: 1, kind: 'FROG', x: 10, y: 10, ang: 0, stepAt: -1, turnAt: -1 };
  rc.food = [fc]; rc.update(16);
  check('U14: frog static (classic)', fc.x === 10 && fc.y === 10);
})();

// U15: gems grant stacking effects; giant enlarges the head.
(() => {
  const r = room({ map: 'TUNNEL' }); const p = r.addPlayer('a', { name: 'A' });
  p.hx = 10; p.hy = 10;
  r.food = [{ id: 1, kind: 'GIANT', x: 10, y: 10, color: SPECIALS.GIANT.color }];
  const r0 = r.headRadius(p); r.update(16);
  check('U15: giant effect active', p.eff.giant > r.clock);
  check('U15: head radius doubled while giant', r.headRadius(p) > r0 * 1.9);
})();

// U16: vacuum pulls nearby food toward the head.
(() => {
  const r = room({ map: 'TUNNEL' }); const p = r.addPlayer('a', { name: 'A' });
  p.hx = 10; p.hy = 10; p.ang = Math.PI; p.targetAng = Math.PI; p.eff.vacuum = 1e9;
  const f = { id: 1, kind: 'FROG', x: 14, y: 10, ang: 0, stepAt: 1e9, turnAt: 1e9 };
  r.food = [f]; const d0 = Math.hypot(r.dxWrap(p.hx, f.x), r.dyWrap(p.hy, f.y));
  r.update(80); const d1 = Math.hypot(r.dxWrap(p.hx, f.x), r.dyWrap(p.hy, f.y));
  check('U16: vacuum pulled food closer', d1 < d0);
})();

// U17: poison clouds poison non-carriers (slow them); carriers are immune.
(() => {
  const r = room({ map: 'TUNNEL' });
  const b = r.addPlayer('b', { name: 'B' });
  b.hx = 8; b.hy = 8;
  r.poison = [{ x: 8, y: 8, until: r.clock + 5000 }];
  r.update(16);
  check('U17: touching poison poisons you', b.eff.poisoned > r.clock);
  check('U17: poisoned snakes are slowed 25%', Math.abs(r.speedMult(b) - CONFIG.POISON_SLOW) < 1e-9);
  const a = r.addPlayer('a', { name: 'A' }); a.hx = 8; a.hy = 8; a.eff.poisonGas = 1e9; a.eff.poisoned = 0;
  r.poison = [{ x: 8, y: 8, until: r.clock + 5000 }]; r.update(16);
  check('U17: gas carriers are immune to poison', a.eff.poisoned === 0);
})();

// U18: classic mode makes your own tail lethal.
(() => {
  const r = room({ map: 'TUNNEL', classic: true }); const s = r.addPlayer('s', { name: 'S' });
  s.spawnSafeUntil = 0; // disable spawn protection so self-collision applies
  s.hx = 20; s.hy = 20; s.ang = 0; s.bodyLen = 18; // longer than the tight-turn circle
  s.trail = []; for (let i = 0; i < 12; i++) s.trail.push({ x: 20 - i * CONFIG.SPACING, y: 20 });
  let alive = true;
  for (let i = 0; i < 220 && alive; i++) { s.targetAng = s.ang + 1.5; r.update(33); alive = s.alive; } // keep turning left into its coil
  check('U18: own tail is lethal in classic', !s.alive);
})();

// U19: death scatters frogs proportional to length.
(() => {
  const r = room({ map: 'TUNNEL' }); const p = r.addPlayer('a', { name: 'A' });
  p.bodyLen = 20; p.trail = []; for (let i = 0; i < 40; i++) p.trail.push({ x: 10, y: 10 });
  const before = r.food.length; r.kill(p, null, []);
  check('U19: many frogs dropped for a long snake', r.food.length - before >= 15);
})();

// U21: bots self-destruct on their life timer.
(() => {
  const r = room({ map: 'TUNNEL', bots: 1 }); r.addPlayer('h', { name: 'H' }); r.update(16);
  const bot = [...r.players.values()].find((p) => p.bot);
  check('U21: bot has a life timer', bot && bot.lifeUntil > r.clock);
  bot.lifeUntil = r.clock + 50; r.update(120);
  check('U21: bot self-destructed past its timer', !bot.alive && bot.respawnAt > 0);
})();

// U23: a freshly (re)spawned snake is invulnerable & non-lethal for a moment,
// so nothing dies to a snake that appears right in front of it.
(() => {
  const r = room({ map: 'TUNNEL' });
  const a = r.addPlayer('a', { name: 'A' }); const b = r.addPlayer('b', { name: 'B' });
  check('U23: fresh spawn is protected', r.protectedNow(a) && r.protectedNow(b));
  // B (protection cleared) drives into A's body while A is still protected.
  b.spawnSafeUntil = 0;
  a.hx = 10; a.hy = 10; a.trail = []; for (let i = 0; i < 12; i++) a.trail.push({ x: 10 - i * CONFIG.SPACING, y: 10 });
  b.hx = a.trail[5].x; b.hy = 10; b.ang = Math.PI;
  r.update(16);
  check('U23: a protected snake body is non-lethal', b.alive);
  // Once A's protection expires, the same hit is lethal again.
  a.spawnSafeUntil = 0; b.spawnSafeUntil = 0;
  b.hx = a.trail[5].x; b.hy = 10; b.ang = Math.PI;
  r.update(16);
  check('U23: lethal again after protection ends', !b.alive);
})();

// U22: respawn picks a spot clear of other snakes' bodies.
(() => {
  const r = room({ map: 'VOID' });
  const b = r.addPlayer('b', { name: 'B' }); const a = r.addPlayer('a', { name: 'A' });
  b.hx = 20; b.hy = 15; b.trail = []; for (let i = 0; i < 60; i++) b.trail.push({ x: 5 + i * 0.5, y: 15 });
  r.spawn(a);
  let min = Infinity;
  for (const t of b.trail) min = Math.min(min, Math.hypot(r.dxWrap(a.hx, t.x), r.dyWrap(a.hy, t.y)));
  min = Math.min(min, Math.hypot(r.dxWrap(a.hx, b.hx), r.dyWrap(a.hy, b.hy)));
  check('U22: respawn keeps clear of other bodies', min >= 3);
})();

// U20: name sanitisation.
(() => {
  check('U20: trims & caps', sanitizeName('  Snakey McSnake Face  ').length <= 16);
  check('U20: empty -> null', sanitizeName('   ') === null);
})();

console.log(`\n${failures === 0 ? 'ALL UNIT TESTS PASS' : failures + ' UNIT TESTS FAILED'}`);
process.exit(failures === 0 ? 0 : 1);
