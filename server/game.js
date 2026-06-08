// NAGA ARENA - Phase 1 MVP game logic (server-authoritative)
// Scope: Battle Royale only, food only. Map: VOID 40x30, no obstacles.

export const CONFIG = {
  GRID_W: 40,
  GRID_H: 30,
  STEP_MS: 130, // snake advances one cell every STEP_MS
  COUNTDOWN_MS: 3000,
  RESULT_MS: 6000,
  FOOD_COUNT: 12, // target number of food on the field
  START_LEN: 3,
  MAX_PLAYERS: 8,
};

const DIRS = {
  UP: { x: 0, y: -1 },
  DOWN: { x: 0, y: 1 },
  LEFT: { x: -1, y: 0 },
  RIGHT: { x: 1, y: 0 },
};

const OPPOSITE = { UP: 'DOWN', DOWN: 'UP', LEFT: 'RIGHT', RIGHT: 'LEFT' };

const COLORS = [
  '#39ff14', '#ff2d55', '#0a84ff', '#ffd60a',
  '#bf5af2', '#ff9f0a', '#64d2ff', '#ff6482',
];

// Phases of a room.
export const PHASE = {
  LOBBY: 'LOBBY',
  COUNTDOWN: 'COUNTDOWN',
  PLAYING: 'PLAYING',
  RESULT: 'RESULT',
};

let nextPlayerNum = 1;

export class GameRoom {
  constructor() {
    this.players = new Map(); // id -> player
    this.food = []; // [{x,y}]
    this.phase = PHASE.LOBBY;
    this.tick = 0;
    this.phaseTimer = 0; // ms remaining for timed phases
    this.results = null; // computed at end of round
    this.lastResults = null;
  }

  addPlayer(id) {
    const colorIdx = (this.players.size) % COLORS.length;
    const player = {
      id,
      name: `SNAKE-${String(nextPlayerNum++).padStart(2, '0')}`,
      color: COLORS[colorIdx],
      body: [], // [{x,y}], head first
      dir: 'RIGHT',
      pendingDir: 'RIGHT',
      alive: false,
      ready: false,
      score: 0,
      foodCount: 0,
      combo: 0,
      kills: 0,
      spawnTick: 0,
      deathRank: 0,
    };
    this.players.set(id, player);
    return player;
  }

  removePlayer(id) {
    this.players.delete(id);
    // If a round is running and everyone left, reset.
    if (this.players.size === 0) {
      this.phase = PHASE.LOBBY;
      this.food = [];
    }
  }

  setReady(id, ready) {
    const p = this.players.get(id);
    if (!p) return;
    p.ready = ready;
  }

  setDirection(id, dir) {
    const p = this.players.get(id);
    if (!p || !p.alive || !DIRS[dir]) return;
    // Disallow 180-degree reversal relative to the committed direction.
    if (dir === OPPOSITE[p.dir]) return;
    p.pendingDir = dir;
  }

  // Try to begin a countdown when all connected players are ready (min 1).
  maybeStart() {
    if (this.phase !== PHASE.LOBBY) return;
    const players = [...this.players.values()];
    if (players.length === 0) return;
    if (players.every((p) => p.ready)) {
      this.startCountdown();
    }
  }

  startCountdown() {
    this.phase = PHASE.COUNTDOWN;
    this.phaseTimer = CONFIG.COUNTDOWN_MS;
    this.spawnSnakes();
    this.food = [];
    this.ensureFood();
  }

  spawnSnakes() {
    const players = [...this.players.values()];
    const n = players.length;
    players.forEach((p, i) => {
      // Spread spawn points around the field; all start facing RIGHT.
      const margin = 5;
      const cols = Math.ceil(Math.sqrt(n));
      const rows = Math.ceil(n / cols);
      const cx = Math.floor(((i % cols) + 1) / (cols + 1) * CONFIG.GRID_W);
      const cy = Math.floor((Math.floor(i / cols) + 1) / (rows + 1) * CONFIG.GRID_H);
      const x = Math.min(Math.max(cx, margin), CONFIG.GRID_W - margin);
      const y = Math.min(Math.max(cy, margin), CONFIG.GRID_H - margin);
      p.body = [];
      for (let k = 0; k < CONFIG.START_LEN; k++) {
        p.body.push({ x: x - k, y });
      }
      p.dir = 'RIGHT';
      p.pendingDir = 'RIGHT';
      p.alive = true;
      p.score = 0;
      p.foodCount = 0;
      p.combo = 0;
      p.kills = 0;
      p.spawnTick = this.tick;
      p.deathRank = 0;
    });
    this.startPlayers = n; // players present at round start
    this.deathOrder = 0;
  }

  randEmptyCell() {
    const occupied = new Set();
    for (const p of this.players.values()) {
      for (const seg of p.body) occupied.add(`${seg.x},${seg.y}`);
    }
    for (const f of this.food) occupied.add(`${f.x},${f.y}`);
    // Try random cells; fall back to scanning.
    for (let tries = 0; tries < 200; tries++) {
      const x = Math.floor(Math.random() * CONFIG.GRID_W);
      const y = Math.floor(Math.random() * CONFIG.GRID_H);
      if (!occupied.has(`${x},${y}`)) return { x, y };
    }
    for (let y = 0; y < CONFIG.GRID_H; y++) {
      for (let x = 0; x < CONFIG.GRID_W; x++) {
        if (!occupied.has(`${x},${y}`)) return { x, y };
      }
    }
    return null;
  }

  ensureFood() {
    while (this.food.length < CONFIG.FOOD_COUNT) {
      const cell = this.randEmptyCell();
      if (!cell) break;
      this.food.push(cell);
    }
  }

  // Advance the simulation by dt milliseconds. Returns array of events.
  update(dt) {
    const events = [];
    switch (this.phase) {
      case PHASE.COUNTDOWN:
        this.phaseTimer -= dt;
        if (this.phaseTimer <= 0) {
          this.phase = PHASE.PLAYING;
          this.stepAccum = 0;
        }
        break;
      case PHASE.PLAYING:
        this.stepAccum = (this.stepAccum || 0) + dt;
        while (this.stepAccum >= CONFIG.STEP_MS) {
          this.stepAccum -= CONFIG.STEP_MS;
          this.step(events);
          if (this.phase !== PHASE.PLAYING) break;
        }
        break;
      case PHASE.RESULT:
        this.phaseTimer -= dt;
        if (this.phaseTimer <= 0) {
          this.phase = PHASE.LOBBY;
          for (const p of this.players.values()) {
            p.ready = false;
            p.alive = false;
            p.body = [];
          }
        }
        break;
      default:
        break;
    }
    return events;
  }

  // One discrete game step (all snakes move one cell).
  step(events) {
    this.tick++;
    const alivePlayers = [...this.players.values()].filter((p) => p.alive);

    // 1. Commit pending directions and compute new heads.
    const newHeads = new Map();
    for (const p of alivePlayers) {
      if (p.pendingDir !== OPPOSITE[p.dir]) p.dir = p.pendingDir;
      const d = DIRS[p.dir];
      const head = p.body[0];
      newHeads.set(p.id, { x: head.x + d.x, y: head.y + d.y });
    }

    // 2. Determine which snakes eat (to decide tail removal before collision).
    const eating = new Map();
    for (const p of alivePlayers) {
      const nh = newHeads.get(p.id);
      const fi = this.food.findIndex((f) => f.x === nh.x && f.y === nh.y);
      eating.set(p.id, fi);
    }

    // 3. Build occupancy of bodies AFTER tail moves (a tail cell is vacated
    //    unless that snake grows this step).
    const occupied = new Map(); // "x,y" -> ownerId (body cell that will still exist)
    for (const p of alivePlayers) {
      const grows = eating.get(p.id) >= 0;
      const len = p.body.length;
      // Cells that remain: all except the tail when not growing.
      const keep = grows ? len : len - 1;
      for (let i = 0; i < keep; i++) {
        const seg = p.body[i];
        occupied.set(`${seg.x},${seg.y}`, p.id);
      }
    }

    // 4. Collision resolution.
    const dead = new Set(); // ids dying this step
    const killCredit = new Map(); // victimId -> killerId

    for (const p of alivePlayers) {
      const nh = newHeads.get(p.id);
      // Wall.
      if (nh.x < 0 || nh.y < 0 || nh.x >= CONFIG.GRID_W || nh.y >= CONFIG.GRID_H) {
        dead.add(p.id);
        continue;
      }
      // Body collision (self or others).
      const owner = occupied.get(`${nh.x},${nh.y}`);
      if (owner) {
        dead.add(p.id);
        if (owner !== p.id) killCredit.set(p.id, owner);
        continue;
      }
    }

    // 5. Head-on collisions (two heads to same cell, or swap).
    const headCell = new Map(); // "x,y" -> [ids]
    for (const p of alivePlayers) {
      const nh = newHeads.get(p.id);
      const key = `${nh.x},${nh.y}`;
      if (!headCell.has(key)) headCell.set(key, []);
      headCell.get(key).push(p.id);
    }
    for (const [, ids] of headCell) {
      if (ids.length > 1) {
        for (const id of ids) dead.add(id);
        // Mutual kill: credit each other (first listed as killer is arbitrary).
        for (const id of ids) {
          const other = ids.find((o) => o !== id);
          if (other) killCredit.set(id, other);
        }
      }
    }
    // Swap collision (A->B's cell while B->A's cell).
    for (const a of alivePlayers) {
      for (const b of alivePlayers) {
        if (a.id >= b.id) continue;
        const ah = newHeads.get(a.id);
        const bh = newHeads.get(b.id);
        if (ah.x === b.body[0].x && ah.y === b.body[0].y &&
            bh.x === a.body[0].x && bh.y === a.body[0].y) {
          dead.add(a.id); dead.add(b.id);
          killCredit.set(a.id, b.id); killCredit.set(b.id, a.id);
        }
      }
    }

    // 6. Apply movement for survivors, handle eating.
    for (const p of alivePlayers) {
      if (dead.has(p.id)) continue;
      const nh = newHeads.get(p.id);
      p.body.unshift({ x: nh.x, y: nh.y });
      const fi = eating.get(p.id);
      if (fi >= 0) {
        // Eat: remove food, grow (don't pop tail), score with combo.
        this.food.splice(fi, 1);
        p.foodCount++;
        p.combo++;
        const comboMult = Math.min(1 + p.combo * 0.1, 3.0);
        p.score += Math.round(10 * comboMult);
        events.push({ type: 'EAT', player: p.id });
      } else {
        p.body.pop();
        p.combo = 0;
      }
    }

    // 7. Process deaths, assign kills and death rank.
    if (dead.size > 0) {
      // Higher deathRank = died later = better placement among the dead.
      for (const id of dead) {
        const p = this.players.get(id);
        if (!p || !p.alive) continue;
        p.alive = false;
        this.deathOrder++;
        p.deathRank = this.deathOrder;
        const killerId = killCredit.get(id);
        if (killerId && killerId !== id && !dead.has(killerId)) {
          const killer = this.players.get(killerId);
          if (killer) {
            killer.kills++;
            killer.score += 50;
          }
        }
        events.push({
          type: 'KILL',
          killer: killCredit.get(id) || null,
          victim: id,
        });
      }
    }

    // 8. Refill food.
    this.ensureFood();

    // 9. Win condition (Battle Royale: last survivor).
    const stillAlive = [...this.players.values()].filter((p) => p.alive);
    const threshold = this.startPlayers > 1 ? 1 : 0;
    if (stillAlive.length <= threshold) {
      this.endRound(events);
    }
  }

  endRound(events) {
    // Assign final placements. Survivors rank above the dead;
    // ties broken by score.
    const players = [...this.players.values()];
    const survivors = players.filter((p) => p.alive);
    const dead = players.filter((p) => !p.alive);

    survivors.sort((a, b) => b.score - a.score);
    dead.sort((a, b) => b.deathRank - a.deathRank); // later death = higher
    const ordered = [...survivors, ...dead];

    const rankMult = { 1: 2.0, 2: 1.5, 3: 1.2 };
    const results = ordered.map((p, i) => {
      const rank = i + 1;
      const survivalTicks = this.tick - p.spawnTick;
      const survivalSec = (survivalTicks * CONFIG.STEP_MS) / 1000;
      const survivalBonus = survivalSec * 0.5;
      const base = p.score + survivalBonus;
      const mult = rankMult[rank] || 1.0;
      const finalScore = Math.round(base * mult);
      return {
        id: p.id,
        name: p.name,
        color: p.color,
        rank,
        score: finalScore,
        kills: p.kills,
        foodCount: p.foodCount,
      };
    });

    this.results = results;
    this.lastResults = results;
    this.phase = PHASE.RESULT;
    this.phaseTimer = CONFIG.RESULT_MS;
    events.push({ type: 'ROUND_END', results });
  }

  // Build the state snapshot broadcast to clients.
  snapshot() {
    return {
      phase: this.phase,
      tick: this.tick,
      grid: { w: CONFIG.GRID_W, h: CONFIG.GRID_H },
      countdown: this.phase === PHASE.COUNTDOWN
        ? Math.ceil(this.phaseTimer / 1000)
        : 0,
      snakes: [...this.players.values()].map((p) => ({
        id: p.id,
        name: p.name,
        color: p.color,
        alive: p.alive,
        ready: p.ready,
        body: p.body,
        score: p.score,
        kills: p.kills,
      })),
      food: this.food,
      results: this.phase === PHASE.RESULT ? this.results : null,
    };
  }
}
