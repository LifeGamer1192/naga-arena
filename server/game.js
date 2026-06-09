// NAGA ARENA - continuous endless engine (server-authoritative).
//
// A single drop-in game per room: snakes move with a continuous heading
// (analog steering, diagonals and gentle curves), the camera follows each
// player zoomed in, and death is never final - you respawn after a short
// countdown and keep playing until you leave. Hitting another snake's body is
// lethal; your own tail is safe. Food is frogs.

import { getMap, MAP_IDS } from './maps.js';

export const CONFIG = {
  SPEED: 6.8,          // head speed in cells/sec
  TURN: 3.6,           // max turn rate in rad/sec (analog steering)
  SPACING: 0.45,       // distance between recorded trail points (cells)
  BODY_RADIUS: 0.46,   // half-width of a snake body (collision)
  FOOD_RADIUS: 0.85,   // pickup distance for frogs
  START_LEN: 5,        // starting body length (cells)
  GROW: 1.4,           // body length gained per frog
  RESPAWN_MS: 3000,    // respawn countdown after death
  FOOD_DENSITY: 0.03,  // frogs per cell of field area
  DEFAULT_MAP: 'TUNNEL',
  MAX_PLAYERS: 12,
};

// 32 visually distinct colours; a snake's colour is derived from its name.
export const PALETTE32 = [
  '#ff3b30', '#ff9500', '#ffcc00', '#34c759', '#00c7be', '#30b0c7',
  '#007aff', '#5856d6', '#af52de', '#ff2d55', '#a2845e', '#8e8e93',
  '#39ff14', '#ff6ec7', '#00e5ff', '#ffd60a', '#bf5af2', '#0a84ff',
  '#ff453a', '#ff9f0a', '#ffd426', '#32d74b', '#64d2ff', '#5e5ce6',
  '#ff375f', '#bf5af2', '#66d4cf', '#ac8e68', '#e0e0e0', '#ff8cc6',
  '#7cf67c', '#ffa552',
];

export function sanitizeName(name) {
  const s = String(name || '').replace(/[\x00-\x1f\x7f]/g, '').replace(/\s+/g, ' ').trim().slice(0, 16);
  return s || null;
}

// Deterministic hash so the same name maps to the same colour.
function hashName(name) {
  let h = 2166136261;
  for (let i = 0; i < name.length; i++) { h ^= name.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0);
}

let nameCounter = 1;

function angDiff(target, cur) {
  let d = (target - cur) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return d;
}

export class GameRoom {
  constructor(code, mapId = CONFIG.DEFAULT_MAP) {
    this.code = code;
    this.setMap(mapId);
    this.players = new Map();
    this.food = [];
    this.foodSeq = 1;
    this.clock = 0;
  }

  setMap(mapId) {
    if (MAP_IDS.includes(mapId)) { this.mapId = mapId; this.map = getMap(mapId); }
    else { this.mapId = CONFIG.DEFAULT_MAP; this.map = getMap(CONFIG.DEFAULT_MAP); }
    this.targetFood = Math.round(this.map.w * this.map.h * CONFIG.FOOD_DENSITY);
  }

  isEmpty() { return this.players.size === 0; }

  // Toroidal-aware distance components for the current map.
  dxWrap(ax, bx) { let d = ax - bx; if (this.map.tunnel) { if (d > this.map.w / 2) d -= this.map.w; else if (d < -this.map.w / 2) d += this.map.w; } return d; }
  dyWrap(ay, by) { let d = ay - by; if (this.map.tunnel) { if (d > this.map.h / 2) d -= this.map.h; else if (d < -this.map.h / 2) d += this.map.h; } return d; }
  dist2(ax, ay, bx, by) { const dx = this.dxWrap(ax, bx), dy = this.dyWrap(ay, by); return dx * dx + dy * dy; }

  takenColors() {
    const set = new Set();
    for (const p of this.players.values()) set.add(p.color);
    return set;
  }

  // Pick a palette colour from the name, avoiding colours already in the room.
  colorFor(name) {
    const taken = this.takenColors();
    const base = hashName(name) % PALETTE32.length;
    for (let i = 0; i < PALETTE32.length; i++) {
      const c = PALETTE32[(base + i) % PALETTE32.length];
      if (!taken.has(c)) return c;
    }
    return PALETTE32[base];
  }

  addPlayer(id, opts = {}) {
    const name = sanitizeName(opts.name) || `SNAKE-${String(nameCounter++).padStart(2, '0')}`;
    const player = {
      id, pid: opts.pid || null, name,
      color: this.colorFor(name),
      alive: false, respawnAt: 0,
      hx: 0, hy: 0, ang: 0, targetAng: 0,
      trail: [], bodyLen: CONFIG.START_LEN,
      score: 0, foodCount: 0, best: 0,
    };
    this.players.set(id, player);
    this.spawn(player);
    this.ensureFood();
    return player;
  }

  removePlayer(id) { this.players.delete(id); }

  setAim(id, ang) {
    const p = this.players.get(id);
    if (p && p.alive && typeof ang === 'number' && isFinite(ang)) p.targetAng = ang;
  }

  randOpenCell() {
    const W = this.map.w, H = this.map.h;
    for (let t = 0; t < 200; t++) {
      const x = Math.random() * W, y = Math.random() * H;
      if (this.solidAt(x, y)) continue;
      let near = false;
      for (const p of this.players.values()) {
        if (p.alive && this.dist2(x, y, p.hx, p.hy) < 9) { near = true; break; }
      }
      if (!near) return { x, y };
    }
    return { x: this.map.w / 2, y: this.map.h / 2 };
  }

  solidAt(x, y) {
    if (!this.map.walls.size) return false;
    return this.map.walls.has(`${Math.floor(x)},${Math.floor(y)}`);
  }

  spawn(p) {
    const spot = this.randOpenCell();
    p.hx = spot.x; p.hy = spot.y;
    p.ang = Math.random() * Math.PI * 2;
    p.targetAng = p.ang;
    p.bodyLen = CONFIG.START_LEN;
    p.alive = true;
    p.respawnAt = 0;
    // Seed a short trail behind the head.
    p.trail = [];
    const dx = Math.cos(p.ang) * CONFIG.SPACING, dy = Math.sin(p.ang) * CONFIG.SPACING;
    const n = Math.ceil(CONFIG.START_LEN / CONFIG.SPACING);
    for (let i = 0; i < n; i++) {
      let tx = p.hx - dx * i, ty = p.hy - dy * i;
      if (this.map.tunnel) { tx = (tx % this.map.w + this.map.w) % this.map.w; ty = (ty % this.map.h + this.map.h) % this.map.h; }
      p.trail.push({ x: tx, y: ty });
    }
  }

  ensureFood() {
    while (this.food.length < this.targetFood) {
      const c = this.randOpenCell();
      this.food.push({ id: this.foodSeq++, x: c.x, y: c.y });
    }
  }

  // Total trail length using wrap-aware distances.
  trailLength(trail) {
    let len = 0;
    for (let i = 1; i < trail.length; i++) {
      const dx = this.dxWrap(trail[i].x, trail[i - 1].x), dy = this.dyWrap(trail[i].y, trail[i - 1].y);
      len += Math.hypot(dx, dy);
    }
    return len;
  }

  update(dt) {
    const events = [];
    this.clock += dt;
    const step = dt / 1000;

    // Respawns.
    for (const p of this.players.values()) {
      if (!p.alive && p.respawnAt && this.clock >= p.respawnAt) this.spawn(p);
    }

    // Move every alive snake.
    for (const p of this.players.values()) {
      if (!p.alive) continue;
      const da = angDiff(p.targetAng, p.ang);
      const maxTurn = CONFIG.TURN * step;
      p.ang += Math.max(-maxTurn, Math.min(maxTurn, da));
      const move = CONFIG.SPEED * step;
      p.hx += Math.cos(p.ang) * move;
      p.hy += Math.sin(p.ang) * move;

      if (this.map.tunnel) {
        p.hx = (p.hx % this.map.w + this.map.w) % this.map.w;
        p.hy = (p.hy % this.map.h + this.map.h) % this.map.h;
      } else if (p.hx < 0 || p.hy < 0 || p.hx >= this.map.w || p.hy >= this.map.h) {
        this.kill(p, null, events); continue;
      }
      if (this.solidAt(p.hx, p.hy)) { this.kill(p, null, events); continue; }

      // Record trail and trim to the current body length.
      const head = p.trail[0];
      if (!head || Math.hypot(this.dxWrap(p.hx, head.x), this.dyWrap(p.hy, head.y)) >= CONFIG.SPACING) {
        p.trail.unshift({ x: p.hx, y: p.hy });
      } else { head.x = p.hx; head.y = p.hy; }
      while (p.trail.length > 4 && this.trailLength(p.trail) > p.bodyLen) p.trail.pop();

      // Eat frogs.
      const rf2 = CONFIG.FOOD_RADIUS * CONFIG.FOOD_RADIUS;
      for (let i = this.food.length - 1; i >= 0; i--) {
        const f = this.food[i];
        if (this.dist2(p.hx, p.hy, f.x, f.y) < rf2) {
          this.food.splice(i, 1);
          p.bodyLen += CONFIG.GROW; p.foodCount++; p.score += 10;
          p.best = Math.max(p.best, Math.round(p.bodyLen));
          events.push({ type: 'EAT', player: p.id });
        }
      }
    }

    // Collisions: a head touching another snake's body is lethal (self is safe).
    const rb2 = (CONFIG.BODY_RADIUS * 1.7) ** 2;
    for (const p of this.players.values()) {
      if (!p.alive) continue;
      for (const o of this.players.values()) {
        if (o === p || !o.alive) continue;
        const trail = o.trail;
        for (let i = 0; i < trail.length; i += 2) {
          if (this.dist2(p.hx, p.hy, trail[i].x, trail[i].y) < rb2) {
            this.kill(p, o, events);
            break;
          }
        }
        if (!p.alive) break;
      }
    }

    this.ensureFood();
    return events;
  }

  kill(p, killer, events) {
    if (!p.alive) return;
    p.alive = false;
    p.respawnAt = this.clock + CONFIG.RESPAWN_MS;
    if (killer && killer !== p) killer.score += 25;
    // Scatter some frogs where the snake fell.
    const drops = Math.min(10, Math.max(3, Math.floor(p.bodyLen / 2)));
    for (let i = 0; i < drops && p.trail.length; i++) {
      const seg = p.trail[Math.floor(Math.random() * p.trail.length)];
      this.food.push({ id: this.foodSeq++, x: seg.x, y: seg.y });
    }
    p.trail = [];
    p.bodyLen = CONFIG.START_LEN;
    events.push({ type: 'KILL', killer: killer ? killer.id : null, victim: p.id });
  }

  // Downsample a trail for the wire (keeps payload small).
  wireBody(trail) {
    const out = [];
    const stride = Math.max(1, Math.round(0.8 / CONFIG.SPACING));
    for (let i = 0; i < trail.length; i += stride) out.push({ x: +trail[i].x.toFixed(2), y: +trail[i].y.toFixed(2) });
    if (trail.length && (trail.length - 1) % stride !== 0) {
      const t = trail[trail.length - 1]; out.push({ x: +t.x.toFixed(2), y: +t.y.toFixed(2) });
    }
    return out;
  }

  snapshot() {
    return {
      code: this.code,
      map: {
        id: this.mapId, w: this.map.w, h: this.map.h, tunnel: this.map.tunnel,
        walls: [...this.map.walls].map((k) => { const [x, y] = k.split(','); return { x: +x, y: +y }; }),
      },
      snakes: [...this.players.values()].map((p) => ({
        id: p.id, name: p.name, color: p.color, alive: p.alive,
        head: p.alive ? { x: +p.hx.toFixed(2), y: +p.hy.toFixed(2) } : null,
        ang: p.ang, body: p.alive ? this.wireBody(p.trail) : [],
        score: p.score, length: Math.round(p.bodyLen),
        respawnIn: !p.alive && p.respawnAt ? Math.max(0, Math.ceil((p.respawnAt - this.clock) / 1000)) : 0,
      })),
      food: this.food.map((f) => ({ id: f.id, x: +f.x.toFixed(2), y: +f.y.toFixed(2) })),
    };
  }
}

export class RoomManager {
  constructor() { this.rooms = new Map(); }

  normalizeCode(code) {
    const c = String(code || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8);
    return c || this.generateCode();
  }
  generateCode() {
    const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let code;
    do { code = ''; for (let i = 0; i < 5; i++) code += alphabet[Math.floor(Math.random() * alphabet.length)]; }
    while (this.rooms.has(code));
    return code;
  }
  getOrCreate(code, mapId) {
    const c = this.normalizeCode(code);
    let room = this.rooms.get(c);
    if (!room) { room = new GameRoom(c, mapId); this.rooms.set(c, room); }
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
