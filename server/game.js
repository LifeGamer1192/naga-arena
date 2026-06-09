// NAGA ARENA - Phase 2 game engine (server-authoritative).
// Adds to the Phase 1 MVP: URL-shared rooms, 4 maps, all 7 items,
// 3 game modes (Battle Royale / Score Attack / Team Battle), per-snake
// speed, status effects, respawn and teams.
//
// RANKED mode and its rating system are intentionally deferred to Phase 3.

import { getMap, MAP_IDS } from './maps.js';

export const CONFIG = {
  STEP_MS: 130,          // base time for a snake to advance one cell
  COUNTDOWN_MS: 3000,
  RESULT_MS: 7000,
  RESPAWN_MS: 2500,      // respawn delay in timed modes
  FOOD_COUNT: 12,        // food kept on the field at all times
  MAX_SPECIAL: 6,        // cap on simultaneous special items
  SPECIAL_SPAWN_MS: 1800,// interval between special-item spawn rolls
  TIMED_DURATION_MS: 180000, // 3 minutes for Score Attack / Team Battle
  START_LEN: 3,
  MAX_PLAYERS: 8,
};

const DIRS = {
  UP: { x: 0, y: -1 }, DOWN: { x: 0, y: 1 },
  LEFT: { x: -1, y: 0 }, RIGHT: { x: 1, y: 0 },
};
const OPPOSITE = { UP: 'DOWN', DOWN: 'UP', LEFT: 'RIGHT', RIGHT: 'LEFT' };

const COLORS = [
  '#39ff14', '#ff2d55', '#0a84ff', '#ffd60a',
  '#bf5af2', '#ff9f0a', '#64d2ff', '#ff6482',
];
const TEAM_COLORS = { RED: '#ff3b5c', BLUE: '#2d7dff' };

export const PHASE = { LOBBY: 'LOBBY', COUNTDOWN: 'COUNTDOWN', PLAYING: 'PLAYING', RESULT: 'RESULT' };

export const MODES = {
  BATTLE_ROYALE: { id: 'BATTLE_ROYALE', respawn: false, timed: false, teams: false },
  SCORE_ATTACK: { id: 'SCORE_ATTACK', respawn: true, timed: true, teams: false },
  TEAM_BATTLE: { id: 'TEAM_BATTLE', respawn: true, timed: true, teams: true },
};
export const MODE_IDS = Object.keys(MODES);

// Item catalogue. `prob` is the chance to be chosen on a special-spawn roll.
// FOOD has no prob; it is kept topped up separately.
export const ITEMS = {
  FOOD: { id: 'FOOD', grow: 1, score: 10 },
  SUPER_FOOD: { id: 'SUPER_FOOD', grow: 3, score: 50, prob: 0.05 },
  SPEED_UP: { id: 'SPEED_UP', effect: 'speed', durationMs: 5000, prob: 0.08 },
  SHRINK: { id: 'SHRINK', effect: 'shrink', prob: 0.05 },
  SHIELD: { id: 'SHIELD', effect: 'shield', durationMs: 10000, prob: 0.06 },
  FREEZE_BOMB: { id: 'FREEZE_BOMB', effect: 'freeze', radius: 3, freezeMs: 1000, prob: 0.04 },
  GHOST: { id: 'GHOST', effect: 'ghost', durationMs: 4000, prob: 0.03 },
};

let globalPlayerNum = 1;

export class GameRoom {
  constructor(code, modeId = 'BATTLE_ROYALE', mapId = 'VOID') {
    this.code = code;
    this.setMode(modeId);
    this.setMap(mapId);
    this.players = new Map();
    this.items = [];
    this.phase = PHASE.LOBBY;
    this.clock = 0;          // ms elapsed since the current round started
    this.tick = 0;
    this.phaseTimer = 0;
    this.specialAccum = 0;
    this.dynamicAccum = 0;
    this.results = null;
    this.hostId = null;
    this.itemSeq = 1;
  }

  setMode(modeId) {
    if (MODES[modeId]) { this.modeId = modeId; this.mode = MODES[modeId]; }
  }
  setMap(mapId) {
    if (MAP_IDS.includes(mapId)) { this.mapId = mapId; this.map = getMap(mapId); }
  }

  isEmpty() { return this.players.size === 0; }

  addPlayer(id) {
    const idx = this.players.size % COLORS.length;
    const player = {
      id,
      name: `SNAKE-${String(globalPlayerNum++).padStart(2, '0')}`,
      color: COLORS[idx],
      team: null,
      body: [], dir: 'RIGHT', pendingDir: 'RIGHT',
      alive: false, ready: false,
      score: 0, foodCount: 0, combo: 0, kills: 0,
      spawnClock: 0, deathOrder: 0, growth: 0,
      stepAccum: 0,
      speedUntil: 0, shieldUntil: 0, ghostUntil: 0, frozenUntil: 0, respawnAt: 0,
    };
    this.players.set(id, player);
    if (!this.hostId) this.hostId = id; // first joiner is the host
    return player;
  }

  removePlayer(id) {
    this.players.delete(id);
    if (this.hostId === id) {
      this.hostId = this.players.keys().next().value || null;
    }
    if (this.isEmpty()) { this.phase = PHASE.LOBBY; this.items = []; }
  }

  setReady(id, ready) {
    const p = this.players.get(id);
    if (p) p.ready = ready;
  }

  // Host-only lobby configuration.
  configure(id, { mode, map } = {}) {
    if (id !== this.hostId || this.phase !== PHASE.LOBBY) return;
    if (mode) this.setMode(mode);
    if (map) this.setMap(map);
  }

  setDirection(id, dir) {
    const p = this.players.get(id);
    if (!p || !p.alive || !DIRS[dir]) return;
    if (dir === OPPOSITE[p.dir]) return;
    p.pendingDir = dir;
  }

  maybeStart() {
    if (this.phase !== PHASE.LOBBY) return;
    const players = [...this.players.values()];
    if (players.length === 0) return;
    if (players.every((p) => p.ready)) this.startCountdown();
  }

  startCountdown() {
    this.phase = PHASE.COUNTDOWN;
    this.phaseTimer = CONFIG.COUNTDOWN_MS;
    this.clock = 0;
    this.tick = 0;
    this.specialAccum = 0;
    this.dynamicAccum = 0;
    this.dynamicWalls = new Set();
    this.assignTeams();
    this.spawnAll();
    this.items = [];
    this.ensureFood();
  }

  assignTeams() {
    if (!this.mode.teams) {
      for (const p of this.players.values()) p.team = null;
      return;
    }
    const players = [...this.players.values()];
    players.forEach((p, i) => {
      p.team = i % 2 === 0 ? 'RED' : 'BLUE';
      p.color = TEAM_COLORS[p.team];
    });
  }

  spawnAll() {
    const players = [...this.players.values()];
    const n = players.length;
    players.forEach((p, i) => { this.spawnSnake(p, i, n); });
    this.startPlayers = n;
    this.deathCounter = 0;
  }

  spawnSnake(p, i, n) {
    const W = this.map.w, H = this.map.h;
    // Spread spawn points; find a clear spot near the slot position.
    const cols = Math.ceil(Math.sqrt(n));
    const rows = Math.ceil(n / cols);
    let x = Math.floor(((i % cols) + 1) / (cols + 1) * W);
    let y = Math.floor((Math.floor(i / cols) + 1) / (rows + 1) * H);
    const spot = this.findClearSpot(x, y);
    x = spot.x; y = spot.y;
    p.body = [];
    for (let k = 0; k < CONFIG.START_LEN; k++) {
      p.body.push({ x: Math.max(0, x - k), y });
    }
    p.dir = p.pendingDir = 'RIGHT';
    p.alive = true;
    p.growth = 0;
    p.stepAccum = 0;
    p.combo = 0;
    p.speedUntil = p.shieldUntil = p.ghostUntil = p.frozenUntil = p.respawnAt = 0;
    p.spawnClock = this.clock;
    if (this.phase !== PHASE.PLAYING && this.phase !== PHASE.COUNTDOWN) p.spawnClock = 0;
  }

  // Find a spawn cell with a clear 3-cell horizontal runway, searching outward.
  findClearSpot(sx, sy) {
    const W = this.map.w, H = this.map.h;
    const ok = (x, y) => {
      if (x < 3 || y < 1 || x >= W - 1 || y >= H - 1) return false;
      for (let k = 0; k < CONFIG.START_LEN + 1; k++) {
        if (this.solidAt(x - k, y) || this.snakeAt(x - k, y, null)) return false;
      }
      return true;
    };
    if (ok(sx, sy)) return { x: sx, y: sy };
    for (let r = 1; r < Math.max(W, H); r++) {
      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          const x = sx + dx, y = sy + dy;
          if (ok(x, y)) return { x, y };
        }
      }
    }
    return { x: Math.floor(W / 2), y: Math.floor(H / 2) };
  }

  solidAt(x, y) {
    const k = `${x},${y}`;
    return this.map.walls.has(k) || (this.dynamicWalls && this.dynamicWalls.has(k));
  }
  snakeAt(x, y, ignore) {
    for (const p of this.players.values()) {
      if (!p.alive || p === ignore) continue;
      for (const seg of p.body) if (seg.x === x && seg.y === y) return p;
    }
    // also self body when ignore is the snake itself handled by caller via snakeBodyOwnerAt
    return null;
  }
  // Returns the snake owning a body cell, including the given snake itself.
  snakeBodyOwnerAt(x, y, self) {
    for (const p of this.players.values()) {
      if (!p.alive) continue;
      const body = p.body;
      for (let i = 0; i < body.length; i++) {
        if (body[i].x === x && body[i].y === y) {
          // The head cell of `self` (i === 0) is where it currently is; ignore it.
          if (p === self && i === 0) continue;
          return p;
        }
      }
    }
    return null;
  }

  occupiedCells() {
    const occ = new Set();
    for (const p of this.players.values()) {
      if (!p.alive) continue;
      for (const seg of p.body) occ.add(`${seg.x},${seg.y}`);
    }
    for (const it of this.items) occ.add(`${it.x},${it.y}`);
    return occ;
  }

  randEmptyCell() {
    const occ = this.occupiedCells();
    const W = this.map.w, H = this.map.h;
    for (let t = 0; t < 300; t++) {
      const x = Math.floor(Math.random() * W);
      const y = Math.floor(Math.random() * H);
      const k = `${x},${y}`;
      if (!occ.has(k) && !this.solidAt(x, y)) return { x, y };
    }
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const k = `${x},${y}`;
      if (!occ.has(k) && !this.solidAt(x, y)) return { x, y };
    }
    return null;
  }

  ensureFood() {
    const foodOnField = this.items.filter((i) => i.type === 'FOOD').length;
    for (let i = foodOnField; i < CONFIG.FOOD_COUNT; i++) {
      const cell = this.randEmptyCell();
      if (!cell) break;
      this.items.push({ id: this.itemSeq++, type: 'FOOD', x: cell.x, y: cell.y });
    }
  }

  trySpawnSpecial() {
    const specials = this.items.filter((i) => i.type !== 'FOOD').length;
    if (specials >= CONFIG.MAX_SPECIAL) return;
    const roll = Math.random();
    let acc = 0, picked = null;
    for (const def of Object.values(ITEMS)) {
      if (def.prob == null) continue;
      acc += def.prob;
      if (roll < acc) { picked = def; break; }
    }
    if (!picked) return; // no special this roll
    const cell = this.randEmptyCell();
    if (!cell) return;
    this.items.push({ id: this.itemSeq++, type: picked.id, x: cell.x, y: cell.y });
  }

  // ---- main update ----
  update(dt) {
    const events = [];
    switch (this.phase) {
      case PHASE.COUNTDOWN:
        this.phaseTimer -= dt;
        if (this.phaseTimer <= 0) { this.phase = PHASE.PLAYING; this.clock = 0; }
        break;
      case PHASE.PLAYING:
        this.simulate(dt, events);
        break;
      case PHASE.RESULT:
        this.phaseTimer -= dt;
        if (this.phaseTimer <= 0) this.resetToLobby();
        break;
      default: break;
    }
    return events;
  }

  resetToLobby() {
    this.phase = PHASE.LOBBY;
    this.items = [];
    for (const p of this.players.values()) {
      p.ready = false; p.alive = false; p.body = [];
    }
  }

  simulate(dt, events) {
    this.clock += dt;

    // Expire status effects.
    for (const p of this.players.values()) {
      if (p.speedUntil && this.clock >= p.speedUntil) p.speedUntil = 0;
      if (p.shieldUntil && this.clock >= p.shieldUntil) p.shieldUntil = 0;
      if (p.ghostUntil && this.clock >= p.ghostUntil) p.ghostUntil = 0;
      if (p.frozenUntil && this.clock >= p.frozenUntil) p.frozenUntil = 0;
    }

    // Respawns (timed modes).
    if (this.mode.respawn) {
      for (const p of this.players.values()) {
        if (!p.alive && p.respawnAt && this.clock >= p.respawnAt) {
          p.respawnAt = 0;
          this.spawnSnake(p, this.indexOf(p), this.players.size);
        }
      }
    }

    // Per-snake stepping (speed affects the interval).
    for (const p of this.players.values()) {
      if (!p.alive) continue;
      if (p.frozenUntil && this.clock < p.frozenUntil) { p.stepAccum = 0; continue; }
      const speedMult = (p.speedUntil && this.clock < p.speedUntil) ? 1.5 : 1.0;
      const interval = CONFIG.STEP_MS / speedMult;
      p.stepAccum += dt;
      let guard = 0;
      while (p.stepAccum >= interval && p.alive && guard < 4) {
        p.stepAccum -= interval;
        this.stepSnake(p, events);
        guard++;
      }
    }

    // Item spawning.
    this.ensureFood();
    this.specialAccum += dt;
    while (this.specialAccum >= CONFIG.SPECIAL_SPAWN_MS) {
      this.specialAccum -= CONFIG.SPECIAL_SPAWN_MS;
      this.trySpawnSpecial();
    }

    // Dynamic obstacles (ARENA).
    if (this.map.dynamic) this.updateDynamic(dt);

    this.tick++;
    this.checkEnd(events);
  }

  indexOf(target) {
    let i = 0;
    for (const p of this.players.values()) { if (p === target) return i; i++; }
    return 0;
  }

  stepSnake(p, events) {
    if (p.pendingDir !== OPPOSITE[p.dir]) p.dir = p.pendingDir;
    const d = DIRS[p.dir];
    const head = p.body[0];
    let nx = head.x + d.x, ny = head.y + d.y;
    const W = this.map.w, H = this.map.h;
    const ghost = p.ghostUntil && this.clock < p.ghostUntil;

    // Boundary: wrap on tunnel maps, otherwise lethal.
    if (this.map.tunnel) {
      nx = (nx + W) % W; ny = (ny + H) % H;
    } else if (nx < 0 || ny < 0 || nx >= W || ny >= H) {
      return this.handleLethal(p, null, events);
    }

    // Static / dynamic obstacles.
    if (!ghost && this.solidAt(nx, ny)) return this.handleLethal(p, null, events);

    // Snake bodies.
    if (!ghost) {
      const owner = this.snakeBodyOwnerAt(nx, ny, p);
      if (owner) {
        const friendly = this.mode.teams && owner !== p && owner.team === p.team;
        if (!friendly) {
          const killer = owner === p ? null : owner;
          return this.handleLethal(p, killer, events);
        }
        // friendly: fall through and pass over the teammate
      }
    }

    // Commit move.
    p.body.unshift({ x: nx, y: ny });

    const item = this.items.find((it) => it.x === nx && it.y === ny);
    if (item) { this.applyItem(p, item, events); this.removeItem(item.id); }

    if (p.growth > 0) p.growth--; else p.body.pop();
    if (p.body.length === 0) p.body.push({ x: nx, y: ny });
  }

  handleLethal(p, killer, events) {
    if (p.shieldUntil && this.clock < p.shieldUntil) {
      p.shieldUntil = 0; // consume the shield, cancel the move
      events.push({ type: 'SHIELD', player: p.id });
      return;
    }
    this.killSnake(p, killer, events);
  }

  killSnake(p, killer, events) {
    if (!p.alive) return;
    p.alive = false;
    p.combo = 0;
    this.deathCounter = (this.deathCounter || 0) + 1;
    p.deathOrder = this.deathCounter;
    if (killer && killer !== p && killer.alive) {
      killer.kills++;
      killer.score += 50;
    }
    if (this.mode.respawn) p.respawnAt = this.clock + CONFIG.RESPAWN_MS;
    p.body = [];
    events.push({ type: 'KILL', killer: killer ? killer.id : null, victim: p.id });
  }

  applyItem(p, item, events) {
    const def = ITEMS[item.type];
    if (!def) return;
    if (def.grow != null) {
      p.growth += def.grow;
      p.foodCount++;
      p.combo++;
      const mult = Math.min(1 + p.combo * 0.1, 3.0);
      p.score += Math.round(def.score * mult);
      events.push({ type: 'EAT', player: p.id, item: item.type });
      return;
    }
    // Reset combo on non-food pickups (food chain broken).
    p.combo = 0;
    switch (def.effect) {
      case 'speed': p.speedUntil = this.clock + def.durationMs; break;
      case 'shield': p.shieldUntil = this.clock + def.durationMs; break;
      case 'ghost': p.ghostUntil = this.clock + def.durationMs; break;
      case 'shrink': {
        const keep = Math.max(CONFIG.START_LEN, Math.ceil(p.body.length / 2));
        p.body = p.body.slice(0, keep);
        p.growth = 0;
        break;
      }
      case 'freeze': {
        // Freeze other snakes within radius of the pickup.
        for (const other of this.players.values()) {
          if (other === p || !other.alive) continue;
          const h = other.body[0];
          if (Math.abs(h.x - item.x) <= def.radius && Math.abs(h.y - item.y) <= def.radius) {
            other.frozenUntil = this.clock + def.freezeMs;
          }
        }
        break;
      }
      default: break;
    }
    events.push({ type: 'PICKUP', player: p.id, item: item.type });
  }

  removeItem(id) {
    const i = this.items.findIndex((it) => it.id === id);
    if (i >= 0) this.items.splice(i, 1);
  }

  updateDynamic(dt) {
    this.dynamicAccum += dt;
    // Every ~4s, toggle whether the dynamic cells are solid.
    if (this.dynamicAccum >= 4000) {
      this.dynamicAccum = 0;
      if (this.dynamicWalls && this.dynamicWalls.size > 0) {
        this.dynamicWalls = new Set();
      } else {
        this.dynamicWalls = new Set();
        for (const c of (this.map.dynamicCells || [])) {
          // Don't appear directly on top of a snake head.
          if (!this.snakeBodyOwnerAt(c.x, c.y, null)) this.dynamicWalls.add(`${c.x},${c.y}`);
        }
      }
    }
  }

  checkEnd(events) {
    if (this.mode.timed) {
      if (this.clock >= CONFIG.TIMED_DURATION_MS) this.endRound(events);
      return;
    }
    // Battle Royale: last survivor (or last team) wins.
    const alive = [...this.players.values()].filter((p) => p.alive);
    if (this.mode.teams) {
      const teams = new Set(alive.map((p) => p.team));
      const threshold = this.startPlayers > 1 ? 1 : 0;
      if (teams.size <= threshold && this.startPlayers > 0) this.endRound(events);
    } else {
      const threshold = this.startPlayers > 1 ? 1 : 0;
      if (alive.length <= threshold) this.endRound(events);
    }
  }

  endRound(events) {
    const players = [...this.players.values()];
    let results;
    if (this.mode.teams) {
      results = this.rankTeams(players);
    } else if (this.mode.timed) {
      const ordered = [...players].sort((a, b) => b.score - a.score);
      results = ordered.map((p, i) => this.resultRow(p, i + 1, p.score));
    } else {
      // Battle Royale: survivors first, then by death order; rank multiplier.
      const survivors = players.filter((p) => p.alive).sort((a, b) => b.score - a.score);
      const dead = players.filter((p) => !p.alive).sort((a, b) => b.deathOrder - a.deathOrder);
      const ordered = [...survivors, ...dead];
      const rankMult = { 1: 2.0, 2: 1.5, 3: 1.2 };
      results = ordered.map((p, i) => {
        const rank = i + 1;
        const survivalSec = Math.max(0, (this.clock - p.spawnClock) / 1000);
        const base = p.score + survivalSec * 0.5;
        const final = Math.round(base * (rankMult[rank] || 1.0));
        return this.resultRow(p, rank, final);
      });
    }
    this.results = results;
    this.phase = PHASE.RESULT;
    this.phaseTimer = CONFIG.RESULT_MS;
    events.push({ type: 'ROUND_END', results });
  }

  rankTeams(players) {
    const totals = { RED: 0, BLUE: 0 };
    for (const p of players) totals[p.team] = (totals[p.team] || 0) + p.score;
    const winning = totals.RED >= totals.BLUE ? 'RED' : 'BLUE';
    const ordered = [...players].sort((a, b) => b.score - a.score);
    return ordered.map((p, i) => ({
      ...this.resultRow(p, i + 1, p.score),
      team: p.team,
      teamWon: p.team === winning,
      teamTotals: totals,
    }));
  }

  resultRow(p, rank, score) {
    return {
      id: p.id, name: p.name, color: p.color, team: p.team,
      rank, score, kills: p.kills, foodCount: p.foodCount,
    };
  }

  effectsOf(p) {
    return {
      speed: !!(p.speedUntil && this.clock < p.speedUntil),
      shield: !!(p.shieldUntil && this.clock < p.shieldUntil),
      ghost: !!(p.ghostUntil && this.clock < p.ghostUntil),
      frozen: !!(p.frozenUntil && this.clock < p.frozenUntil),
    };
  }

  snapshot() {
    const timed = this.mode.timed;
    const timeLeft = timed && this.phase === PHASE.PLAYING
      ? Math.max(0, Math.ceil((CONFIG.TIMED_DURATION_MS - this.clock) / 1000)) : 0;
    let teamTotals = null;
    if (this.mode.teams) {
      teamTotals = { RED: 0, BLUE: 0 };
      for (const p of this.players.values()) teamTotals[p.team] = (teamTotals[p.team] || 0) + p.score;
    }
    return {
      code: this.code,
      phase: this.phase,
      mode: this.modeId,
      hostId: this.hostId,
      map: {
        id: this.mapId, w: this.map.w, h: this.map.h, tunnel: this.map.tunnel,
        walls: [...this.map.walls].map((k) => { const [x, y] = k.split(','); return { x: +x, y: +y }; }),
        dynamic: this.dynamicWalls ? [...this.dynamicWalls].map((k) => { const [x, y] = k.split(','); return { x: +x, y: +y }; }) : [],
      },
      countdown: this.phase === PHASE.COUNTDOWN ? Math.ceil(this.phaseTimer / 1000) : 0,
      timeLeft,
      teamTotals,
      snakes: [...this.players.values()].map((p) => ({
        id: p.id, name: p.name, color: p.color, team: p.team,
        alive: p.alive, ready: p.ready, body: p.body,
        score: p.score, kills: p.kills, effects: this.effectsOf(p),
      })),
      items: this.items,
      results: this.phase === PHASE.RESULT ? this.results : null,
    };
  }
}

// Manages the set of active rooms keyed by short code.
export class RoomManager {
  constructor() { this.rooms = new Map(); }

  normalizeCode(code) {
    const c = String(code || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8);
    return c || this.generateCode();
  }

  generateCode() {
    const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let code;
    do {
      code = '';
      for (let i = 0; i < 5; i++) code += alphabet[Math.floor(Math.random() * alphabet.length)];
    } while (this.rooms.has(code));
    return code;
  }

  getOrCreate(code, modeId, mapId) {
    const c = this.normalizeCode(code);
    let room = this.rooms.get(c);
    if (!room) { room = new GameRoom(c, modeId, mapId); this.rooms.set(c, room); }
    return room;
  }

  remove(code) { this.rooms.delete(code); }

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
