// NAGA ARENA - rating store (Phase 3).
// Tracks a persistent rating per player identity (pid) and a leaderboard.
// Win/loss deltas scale by the player's current tier, per the design document.

import fs from 'fs';
import path from 'path';

export const TIERS = [
  { name: 'BRONZE', min: 0, max: 999, win: 30, loss: 20 },
  { name: 'SILVER', min: 1000, max: 1499, win: 25, loss: 22 },
  { name: 'GOLD', min: 1500, max: 1999, win: 20, loss: 25 },
  { name: 'DIAMOND', min: 2000, max: 2499, win: 15, loss: 28 },
  { name: 'SERPENT KING', min: 2500, max: Infinity, win: 12, loss: 30 },
];

export function tierOf(rating) {
  return TIERS.find((t) => rating >= t.min && rating <= t.max) || TIERS[0];
}

const START_RATING = 1000; // everyone starts in SILVER

export class RatingStore {
  constructor(file) {
    this.file = file || process.env.RATINGS_FILE || path.join(process.cwd(), 'data', 'ratings.json');
    this.players = new Map(); // pid -> { pid, name, rating, games, wins, losses }
    this.saveTimer = null;
    this.load();
  }

  load() {
    try {
      const raw = fs.readFileSync(this.file, 'utf8');
      const data = JSON.parse(raw);
      for (const p of data.players || []) this.players.set(p.pid, p);
    } catch {
      // No file yet (first run) - start empty.
    }
  }

  save() {
    // Debounced write so a burst of updates costs one disk write.
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      try {
        fs.mkdirSync(path.dirname(this.file), { recursive: true });
        const data = { players: [...this.players.values()] };
        fs.writeFileSync(this.file, JSON.stringify(data));
      } catch (e) {
        console.error('rating save failed:', e.message);
      }
    }, 800);
  }

  ensure(pid, name) {
    let p = this.players.get(pid);
    if (!p) {
      p = { pid, name: name || 'SNAKE', rating: START_RATING, games: 0, wins: 0, losses: 0 };
      this.players.set(pid, p);
    } else if (name) {
      p.name = name;
    }
    return p;
  }

  get(pid) {
    const p = this.players.get(pid);
    return p || { pid, name: 'SNAKE', rating: START_RATING, games: 0, wins: 0, losses: 0 };
  }

  // rows: ordered [{ pid, name, rank }] for a finished ranked round.
  // Top half of the lobby counts as a win. Returns pid -> change details.
  recordRankedRound(rows) {
    const eligible = rows.filter((r) => r.pid);
    const n = eligible.length;
    const changes = new Map();
    if (n < 2) return changes; // need at least 2 rated players
    const winCutoff = Math.ceil(n / 2);
    for (const row of eligible) {
      const p = this.ensure(row.pid, row.name);
      const tier = tierOf(p.rating);
      const won = row.rank <= winCutoff;
      const before = p.rating;
      const delta = won ? tier.win : -tier.loss;
      p.rating = Math.max(0, before + delta);
      p.games++;
      if (won) p.wins++; else p.losses++;
      changes.set(row.pid, {
        before, after: p.rating, delta, won,
        tier: tierOf(p.rating).name,
      });
    }
    this.save();
    return changes;
  }

  leaderboard(limit = 50) {
    return [...this.players.values()]
      .filter((p) => p.games > 0) // only players who have played ranked
      .sort((a, b) => b.rating - a.rating)
      .slice(0, limit)
      .map((p, i) => ({
        rank: i + 1, name: p.name, rating: p.rating,
        tier: tierOf(p.rating).name, games: p.games, wins: p.wins, losses: p.losses,
      }));
  }

  rankOf(pid) {
    const sorted = [...this.players.values()].sort((a, b) => b.rating - a.rating);
    const idx = sorted.findIndex((p) => p.pid === pid);
    return idx < 0 ? null : idx + 1;
  }
}
