// NAGA ARENA - continuous endless engine (server-authoritative).
//
// Slither-style arena: continuous analog steering, follow-camera (client side),
// infinite respawn, name-derived colours. Your own tail is safe; another
// snake's body is lethal. Frogs are food and hop around; coloured gems are
// special foods that grant stacking status effects. AI bots can fill the room.

import { getMap, MAP_IDS } from './maps.js';

export const CONFIG = {
  SPEED: 6.8, TURN: 3.6, SPACING: 0.45, BODY_RADIUS: 0.46, FOOD_RADIUS: 0.85,
  START_LEN: 5, GROW: 1.4, RESPAWN_MS: 3000, FOOD_DENSITY: 0.03,
  DEFAULT_MAP: 'TUNNEL', MAX_PLAYERS: 12,
  BOTS_DEFAULT: 1, BOTS_MAX: 8,
  // Frog wandering.
  FROG_STEP_MS: 3000, FROG_TURN_MS: 10000, FROG_STEP: 0.9,
  // Special gems.
  SPECIAL_SPAWN_MS: 6000, MAX_SPECIALS: 5, CLASSIC_MAX_SPECIALS: 1,
  // Status effects.
  VACUUM_MS: 20000, VACUUM_RADIUS: 5, VACUUM_PULL: 9,
  GIANT_MS: 10000, GIANT_SCALE: 2,
  POISONGAS_MS: 30000, POISON_EMIT_MS: 350, POISON_RADIUS: 1.5, POISON_LIFE: 2600,
  POISONED_MS: 8000, POISON_SLOW: 0.75,
};

export const PALETTE32 = [
  '#ff3b30', '#ff9500', '#ffcc00', '#34c759', '#00c7be', '#30b0c7',
  '#007aff', '#5856d6', '#af52de', '#ff2d55', '#a2845e', '#8e8e93',
  '#39ff14', '#ff6ec7', '#00e5ff', '#ffd60a', '#bf5af2', '#0a84ff',
  '#ff453a', '#ff9f0a', '#ffd426', '#32d74b', '#64d2ff', '#5e5ce6',
  '#ff375f', '#cf6fff', '#66d4cf', '#ac8e68', '#e0e0e0', '#ff8cc6',
  '#7cf67c', '#ffa552',
];

// Special gems and the effect each grants. Effects stack.
export const SPECIALS = {
  VACUUM: { id: 'VACUUM', color: '#00e5ff', effect: 'vacuum', dur: CONFIG.VACUUM_MS },
  GIANT: { id: 'GIANT', color: '#ffd60a', effect: 'giant', dur: CONFIG.GIANT_MS },
  POISON: { id: 'POISON', color: '#7cfc3a', effect: 'poisonGas', dur: CONFIG.POISONGAS_MS },
};
export const SPECIAL_IDS = Object.keys(SPECIALS);
export const EFFECT_TYPES = ['vacuum', 'giant', 'poisonGas', 'poisoned'];

export function sanitizeName(name) {
  const s = String(name || '').replace(/[\x00-\x1f\x7f]/g, '').replace(/\s+/g, ' ').trim().slice(0, 16);
  return s || null;
}
function hashName(name) {
  let h = 2166136261;
  for (let i = 0; i < name.length; i++) { h ^= name.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0);
}
let nameCounter = 1, botCounter = 1;

function angDiff(target, cur) {
  let d = (target - cur) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return d;
}

export class GameRoom {
  constructor(code, opts = {}) {
    this.code = code;
    this.setMap(opts.map || CONFIG.DEFAULT_MAP);
    this.classic = !!opts.classic;
    this.botTarget = Math.max(0, Math.min(CONFIG.BOTS_MAX, opts.bots == null ? CONFIG.BOTS_DEFAULT : opts.bots | 0));
    this.players = new Map();
    this.food = [];
    this.poison = [];
    this.foodSeq = 1;
    this.clock = 0;
    this.specialAccum = 0;
  }

  setMap(mapId) {
    if (MAP_IDS.includes(mapId)) { this.mapId = mapId; this.map = getMap(mapId); }
    else { this.mapId = CONFIG.DEFAULT_MAP; this.map = getMap(CONFIG.DEFAULT_MAP); }
    this.targetFood = Math.round(this.map.w * this.map.h * CONFIG.FOOD_DENSITY);
  }

  hasHumans() { for (const p of this.players.values()) if (!p.bot) return true; return false; }
  isEmpty() { return !this.hasHumans(); }

  dxWrap(ax, bx) { let d = ax - bx; if (this.map.tunnel) { if (d > this.map.w / 2) d -= this.map.w; else if (d < -this.map.w / 2) d += this.map.w; } return d; }
  dyWrap(ay, by) { let d = ay - by; if (this.map.tunnel) { if (d > this.map.h / 2) d -= this.map.h; else if (d < -this.map.h / 2) d += this.map.h; } return d; }
  dist2(ax, ay, bx, by) { const dx = this.dxWrap(ax, bx), dy = this.dyWrap(ay, by); return dx * dx + dy * dy; }
  wrap(p) { if (this.map.tunnel) { p.hx = (p.hx % this.map.w + this.map.w) % this.map.w; p.hy = (p.hy % this.map.h + this.map.h) % this.map.h; } }

  takenColors() { const s = new Set(); for (const p of this.players.values()) s.add(p.color); return s; }
  colorFor(name) {
    const taken = this.takenColors();
    const base = hashName(name) % PALETTE32.length;
    for (let i = 0; i < PALETTE32.length; i++) { const c = PALETTE32[(base + i) % PALETTE32.length]; if (!taken.has(c)) return c; }
    return PALETTE32[base];
  }

  makeSnake(id, name, bot) {
    return {
      id, name, bot: !!bot, color: this.colorFor(name),
      alive: false, respawnAt: 0,
      hx: 0, hy: 0, ang: 0, targetAng: 0,
      trail: [], bodyLen: CONFIG.START_LEN, score: 0, foodCount: 0,
      eff: { vacuum: 0, giant: 0, poisonGas: 0, poisoned: 0 },
      poisonEmitAt: 0, botTurnAt: 0,
    };
  }

  addPlayer(id, opts = {}) {
    const name = sanitizeName(opts.name) || `SNAKE-${String(nameCounter++).padStart(2, '0')}`;
    const p = this.makeSnake(id, name, false);
    this.players.set(id, p);
    this.spawn(p);
    this.ensureFood();
    return p;
  }
  addBot() {
    const id = `bot-${botCounter}`;
    const p = this.makeSnake(id, `BOT ${botCounter}`, true);
    botCounter++;
    this.players.set(id, p);
    this.spawn(p);
    return p;
  }
  removePlayer(id) { this.players.delete(id); }

  setAim(id, ang) { const p = this.players.get(id); if (p && p.alive && typeof ang === 'number' && isFinite(ang)) p.targetAng = ang; }

  solidAt(x, y) { return this.map.walls.size ? this.map.walls.has(`${Math.floor(x)},${Math.floor(y)}`) : false; }

  randOpenCell() {
    const W = this.map.w, H = this.map.h;
    for (let t = 0; t < 200; t++) {
      const x = Math.random() * W, y = Math.random() * H;
      if (this.solidAt(x, y)) continue;
      let near = false;
      for (const p of this.players.values()) if (p.alive && this.dist2(x, y, p.hx, p.hy) < 9) { near = true; break; }
      if (!near) return { x, y };
    }
    return { x: W / 2, y: H / 2 };
  }

  spawn(p) {
    const s = this.randOpenCell();
    p.hx = s.x; p.hy = s.y; p.ang = Math.random() * Math.PI * 2; p.targetAng = p.ang;
    p.bodyLen = CONFIG.START_LEN; p.alive = true; p.respawnAt = 0;
    p.eff = { vacuum: 0, giant: 0, poisonGas: 0, poisoned: 0 };
    p.trail = [];
    const dx = Math.cos(p.ang) * CONFIG.SPACING, dy = Math.sin(p.ang) * CONFIG.SPACING;
    const n = Math.ceil(CONFIG.START_LEN / CONFIG.SPACING);
    for (let i = 0; i < n; i++) {
      let tx = p.hx - dx * i, ty = p.hy - dy * i;
      if (this.map.tunnel) { tx = (tx % this.map.w + this.map.w) % this.map.w; ty = (ty % this.map.h + this.map.h) % this.map.h; }
      p.trail.push({ x: tx, y: ty });
    }
  }

  spawnFrog() {
    const c = this.randOpenCell();
    this.food.push({ id: this.foodSeq++, kind: 'FROG', x: c.x, y: c.y, ang: Math.random() * Math.PI * 2, stepAt: this.clock + 1500 + Math.random() * CONFIG.FROG_STEP_MS, turnAt: this.clock + Math.random() * CONFIG.FROG_TURN_MS });
  }
  ensureFood() { while (this.food.filter((f) => f.kind === 'FROG').length < this.targetFood) this.spawnFrog(); }
  maybeSpawnSpecial() {
    const cap = this.classic ? CONFIG.CLASSIC_MAX_SPECIALS : CONFIG.MAX_SPECIALS;
    if (this.food.filter((f) => f.kind !== 'FROG').length >= cap) return;
    const id = SPECIAL_IDS[Math.floor(Math.random() * SPECIAL_IDS.length)];
    const c = this.randOpenCell();
    this.food.push({ id: this.foodSeq++, kind: id, x: c.x, y: c.y });
  }

  trailLength(trail) {
    let len = 0;
    for (let i = 1; i < trail.length; i++) len += Math.hypot(this.dxWrap(trail[i].x, trail[i - 1].x), this.dyWrap(trail[i].y, trail[i - 1].y));
    return len;
  }

  headRadius(p) { return CONFIG.BODY_RADIUS * (p.eff.giant && this.clock < p.eff.giant ? CONFIG.GIANT_SCALE : 1); }
  eatRadius(p) { return CONFIG.FOOD_RADIUS * (p.eff.giant && this.clock < p.eff.giant ? 1.6 : 1); }
  speedMult(p) { return (p.eff.poisoned && this.clock < p.eff.poisoned) ? CONFIG.POISON_SLOW : 1; }

  maintainBots() {
    if (!this.hasHumans()) return;
    let bots = 0; for (const p of this.players.values()) if (p.bot) bots++;
    while (bots < this.botTarget) { this.addBot(); bots++; }
  }

  // Simple bot steering: head for the nearest food, swerve from imminent bodies.
  botSteer(bot) {
    let best = null, bd = Infinity;
    for (const f of this.food) { const d = this.dist2(bot.hx, bot.hy, f.x, f.y); if (d < bd) { bd = d; best = f; } }
    let desired = best ? Math.atan2(this.dyWrap(best.y, bot.hy), this.dxWrap(best.x, bot.hx)) : bot.ang;
    // Look ahead; if another snake's body is close in front, steer away.
    const ax = bot.hx + Math.cos(bot.ang) * 2, ay = bot.hy + Math.sin(bot.ang) * 2;
    for (const o of this.players.values()) {
      if (o === bot || !o.alive) continue;
      for (let i = 0; i < o.trail.length; i += 3) {
        if (this.dist2(ax, ay, o.trail[i].x, o.trail[i].y) < 1.7) { desired = bot.ang + (((bot.id.length + i) % 2) ? 1.3 : -1.3); break; }
      }
    }
    // Avoid edges on non-tunnel maps.
    if (!this.map.tunnel) {
      const m = 2.5;
      if (bot.hx < m && Math.cos(bot.ang) < 0) desired = 0;
      else if (bot.hx > this.map.w - m && Math.cos(bot.ang) > 0) desired = Math.PI;
      else if (bot.hy < m && Math.sin(bot.ang) < 0) desired = Math.PI / 2;
      else if (bot.hy > this.map.h - m && Math.sin(bot.ang) > 0) desired = -Math.PI / 2;
    }
    bot.targetAng = desired;
  }

  update(dt) {
    const events = [];
    this.clock += dt;
    const step = dt / 1000;

    this.maintainBots();

    // Respawns.
    for (const p of this.players.values()) if (!p.alive && p.respawnAt && this.clock >= p.respawnAt) this.spawn(p);

    // Frogs wander (unless classic).
    if (!this.classic) {
      for (const f of this.food) {
        if (f.kind !== 'FROG') continue;
        if (this.clock >= f.turnAt) { f.ang = Math.random() * Math.PI * 2; f.turnAt = this.clock + CONFIG.FROG_TURN_MS * (0.6 + Math.random() * 0.8); }
        if (this.clock >= f.stepAt) {
          let nx = f.x + Math.cos(f.ang) * CONFIG.FROG_STEP, ny = f.y + Math.sin(f.ang) * CONFIG.FROG_STEP;
          if (this.map.tunnel) { nx = (nx % this.map.w + this.map.w) % this.map.w; ny = (ny % this.map.h + this.map.h) % this.map.h; }
          if (nx >= 0 && ny >= 0 && nx < this.map.w && ny < this.map.h && !this.solidAt(nx, ny)) { f.x = nx; f.y = ny; }
          else f.ang = Math.random() * Math.PI * 2;
          f.stepAt = this.clock + CONFIG.FROG_STEP_MS * (0.6 + Math.random() * 0.8);
        }
      }
    }

    // Bot AI.
    for (const p of this.players.values()) if (p.bot && p.alive) this.botSteer(p);

    // Move snakes.
    for (const p of this.players.values()) {
      if (!p.alive) continue;
      p.ang += Math.max(-CONFIG.TURN * step, Math.min(CONFIG.TURN * step, angDiff(p.targetAng, p.ang)));
      const move = CONFIG.SPEED * this.speedMult(p) * step;
      p.hx += Math.cos(p.ang) * move; p.hy += Math.sin(p.ang) * move;
      if (this.map.tunnel) this.wrap(p);
      else if (p.hx < 0 || p.hy < 0 || p.hx >= this.map.w || p.hy >= this.map.h) { this.kill(p, null, events); continue; }
      if (this.solidAt(p.hx, p.hy)) { this.kill(p, null, events); continue; }

      // Record a new trail anchor once the head has moved a full SPACING from
      // the last anchor. The live head (p.hx/hy) floats ahead of trail[0].
      const a0 = p.trail[0];
      if (!a0 || Math.hypot(this.dxWrap(p.hx, a0.x), this.dyWrap(p.hy, a0.y)) >= CONFIG.SPACING) p.trail.unshift({ x: p.hx, y: p.hy });
      while (p.trail.length > 4 && this.trailLength(p.trail) > p.bodyLen) p.trail.pop();
    }

    // Vacuum: pull food toward snakes with the effect.
    for (const p of this.players.values()) {
      if (!p.alive || !(p.eff.vacuum && this.clock < p.eff.vacuum)) continue;
      const r2 = CONFIG.VACUUM_RADIUS * CONFIG.VACUUM_RADIUS;
      for (const f of this.food) {
        const dx = this.dxWrap(p.hx, f.x), dy = this.dyWrap(p.hy, f.y), d2 = dx * dx + dy * dy;
        if (d2 < r2 && d2 > 0.01) {
          const d = Math.sqrt(d2), pull = Math.min(d, CONFIG.VACUUM_PULL * step);
          f.x += (dx / d) * pull; f.y += (dy / d) * pull;
          if (this.map.tunnel) { f.x = (f.x % this.map.w + this.map.w) % this.map.w; f.y = (f.y % this.map.h + this.map.h) % this.map.h; }
        }
      }
    }

    // Poison gas: emit clouds and infect snakes that touch them.
    for (const p of this.players.values()) {
      if (!p.alive || !(p.eff.poisonGas && this.clock < p.eff.poisonGas)) continue;
      if (this.clock >= p.poisonEmitAt) {
        p.poisonEmitAt = this.clock + CONFIG.POISON_EMIT_MS;
        const a = Math.random() * Math.PI * 2, r = Math.random() * 1.2;
        this.poison.push({ x: p.hx + Math.cos(a) * r, y: p.hy + Math.sin(a) * r, until: this.clock + CONFIG.POISON_LIFE });
      }
    }
    this.poison = this.poison.filter((c) => c.until > this.clock);
    const pr2 = CONFIG.POISON_RADIUS * CONFIG.POISON_RADIUS;
    for (const p of this.players.values()) {
      if (!p.alive || (p.eff.poisonGas && this.clock < p.eff.poisonGas)) continue; // gas carriers are immune
      for (const c of this.poison) {
        if (this.dist2(p.hx, p.hy, c.x, c.y) < pr2) { p.eff.poisoned = this.clock + CONFIG.POISONED_MS; break; }
      }
    }

    // Eat food.
    for (const p of this.players.values()) {
      if (!p.alive) continue;
      const er2 = this.eatRadius(p) ** 2;
      for (let i = this.food.length - 1; i >= 0; i--) {
        const f = this.food[i];
        if (this.dist2(p.hx, p.hy, f.x, f.y) < er2) {
          this.food.splice(i, 1);
          if (f.kind === 'FROG') { p.bodyLen += CONFIG.GROW; p.foodCount++; p.score += 10; events.push({ type: 'EAT', player: p.id }); }
          else { const sp = SPECIALS[f.kind]; if (sp) { p.eff[sp.effect] = this.clock + sp.dur; p.score += 20; events.push({ type: 'GEM', player: p.id, gem: f.kind }); } }
        }
      }
    }

    // Collisions: another snake's body is lethal; own tail is safe except in classic.
    for (const p of this.players.values()) {
      if (!p.alive) continue;
      const hr = this.headRadius(p);
      for (const o of this.players.values()) {
        if (!o.alive) continue;
        if (o === p && !this.classic) continue;
        const rr2 = (hr + CONFIG.BODY_RADIUS) ** 2;
        const start = o === p ? Math.ceil(CONFIG.START_LEN / CONFIG.SPACING) : 0; // skip own neck in classic
        for (let i = start; i < o.trail.length; i += 2) {
          if (this.dist2(p.hx, p.hy, o.trail[i].x, o.trail[i].y) < rr2) { this.kill(p, o === p ? null : o, events); break; }
        }
        if (!p.alive) break;
      }
    }

    this.ensureFood();
    this.specialAccum += dt;
    while (this.specialAccum >= CONFIG.SPECIAL_SPAWN_MS) { this.specialAccum -= CONFIG.SPECIAL_SPAWN_MS; this.maybeSpawnSpecial(); }
    return events;
  }

  kill(p, killer, events) {
    if (!p.alive) return;
    p.alive = false;
    p.respawnAt = this.clock + CONFIG.RESPAWN_MS;
    if (killer && killer !== p) killer.score += 25;
    // Scatter frogs proportional to length where the snake fell.
    const drops = Math.min(30, Math.max(3, Math.round(p.bodyLen)));
    for (let i = 0; i < drops && p.trail.length; i++) {
      const seg = p.trail[Math.floor(Math.random() * p.trail.length)];
      this.food.push({ id: this.foodSeq++, kind: 'FROG', x: seg.x, y: seg.y, ang: Math.random() * Math.PI * 2, stepAt: this.clock + Math.random() * CONFIG.FROG_STEP_MS, turnAt: this.clock + Math.random() * CONFIG.FROG_TURN_MS });
    }
    p.trail = []; p.bodyLen = CONFIG.START_LEN;
    events.push({ type: 'KILL', killer: killer ? killer.id : null, victim: p.id });
  }

  wireBody(trail) {
    const out = [], stride = Math.max(1, Math.round(0.8 / CONFIG.SPACING));
    for (let i = 0; i < trail.length; i += stride) out.push({ x: +trail[i].x.toFixed(2), y: +trail[i].y.toFixed(2) });
    if (trail.length && (trail.length - 1) % stride !== 0) { const t = trail[trail.length - 1]; out.push({ x: +t.x.toFixed(2), y: +t.y.toFixed(2) }); }
    return out;
  }
  wireEffects(p) {
    const out = [];
    for (const t of EFFECT_TYPES) { if (p.eff[t] && this.clock < p.eff[t]) out.push({ type: t, remain: Math.ceil((p.eff[t] - this.clock) / 1000) }); }
    return out;
  }

  snapshot() {
    return {
      code: this.code, classic: this.classic, bots: this.botTarget,
      map: { id: this.mapId, w: this.map.w, h: this.map.h, tunnel: this.map.tunnel, walls: [...this.map.walls].map((k) => { const [x, y] = k.split(','); return { x: +x, y: +y }; }) },
      snakes: [...this.players.values()].map((p) => ({
        id: p.id, name: p.name, color: p.color, bot: p.bot, alive: p.alive,
        head: p.alive ? { x: +p.hx.toFixed(2), y: +p.hy.toFixed(2) } : null,
        // Prepend the live head so the rendered body reaches the true head.
        body: p.alive ? this.wireBody([{ x: p.hx, y: p.hy }, ...p.trail]) : [],
        score: p.score, length: Math.round(p.bodyLen),
        giant: !!(p.eff.giant && this.clock < p.eff.giant),
        effects: this.wireEffects(p),
        respawnIn: !p.alive && p.respawnAt ? Math.max(0, Math.ceil((p.respawnAt - this.clock) / 1000)) : 0,
      })),
      food: this.food.map((f) => f.kind === 'FROG'
        ? { id: f.id, kind: 'FROG', x: +f.x.toFixed(2), y: +f.y.toFixed(2), ang: +f.ang.toFixed(2) }
        : { id: f.id, kind: f.kind, x: +f.x.toFixed(2), y: +f.y.toFixed(2), color: SPECIALS[f.kind].color }),
      poison: this.poison.map((c) => ({ x: +c.x.toFixed(2), y: +c.y.toFixed(2) })),
    };
  }
}

export class RoomManager {
  constructor() { this.rooms = new Map(); }
  normalizeCode(code) { const c = String(code || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8); return c || this.generateCode(); }
  generateCode() {
    const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let code; do { code = ''; for (let i = 0; i < 5; i++) code += alphabet[Math.floor(Math.random() * alphabet.length)]; } while (this.rooms.has(code));
    return code;
  }
  getOrCreate(code, opts) {
    const c = this.normalizeCode(code);
    let room = this.rooms.get(c);
    if (!room) { room = new GameRoom(c, opts); this.rooms.set(c, room); }
    return room;
  }
  updateAll(dt) {
    const out = [];
    for (const [code, room] of this.rooms) {
      const events = room.update(dt);
      out.push({ code, room, events });
      if (room.isEmpty()) this.rooms.delete(code);
    }
    return out;
  }
}
