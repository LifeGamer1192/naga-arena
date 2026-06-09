// NAGA ARENA - server.
// Express serves the static client; ws handles the realtime protocol.
// Players drop into a URL-shared endless world and steer with a heading angle.

import express from 'express';
import { WebSocketServer } from 'ws';
import http from 'http';
import { fileURLToPath } from 'url';
import path from 'path';
import fs from 'fs';
import { randomUUID } from 'crypto';
import { RoomManager } from './game.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const PORT = process.env.PORT || 3000;
const BROADCAST_MS = 50;

const manager = new RoomManager();

const app = express();
app.disable('x-powered-by');
app.use((_req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; connect-src 'self' ws: wss:; img-src 'self' data:; " +
    "style-src 'self' 'unsafe-inline'; script-src 'self'; base-uri 'self'; frame-ancestors 'self'",
  );
  next();
});
app.use(express.static(PUBLIC_DIR));
app.get('/health', (_req, res) => res.json({ ok: true, rooms: manager.rooms.size }));

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

const clients = new Map(); // id -> { ws, roomCode }

// Lightweight in-memory activity history for the admin screen (last ~24h).
// No names or PII are stored — only counts. Resets if the process restarts.
const DAY_MS = 24 * 3600 * 1000;
const HISTORY_FILE = process.env.HISTORY_FILE || path.join(process.cwd(), 'data', 'history.json');
function countHumans() { let n = 0; for (const c of clients.values()) if (c.roomCode) n++; return n; }
function countBots() { let n = 0; for (const r of manager.rooms.values()) for (const p of r.players.values()) if (p.bot) n++; return n; }
const history = {
  samples: [], events: [], saveTimer: null,
  load() {
    try {
      const d = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8'));
      const cut = Date.now() - DAY_MS;
      this.samples = (d.samples || []).filter((s) => s.t >= cut);
      this.events = (d.events || []).filter((e) => e.t >= cut);
    } catch { /* no file yet */ }
  },
  save() {
    if (this.saveTimer) return; // debounce a burst of changes into one write
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      try { fs.mkdirSync(path.dirname(HISTORY_FILE), { recursive: true }); fs.writeFileSync(HISTORY_FILE, JSON.stringify({ samples: this.samples, events: this.events })); }
      catch (e) { console.error('history save failed:', e.message); }
    }, 2000);
  },
  prune() {
    const cut = Date.now() - DAY_MS;
    while (this.samples.length && this.samples[0].t < cut) this.samples.shift();
    while (this.events.length && this.events[0].t < cut) this.events.shift();
  },
  record(type) { this.events.push({ t: Date.now(), type }); this.prune(); this.save(); },
  sample() { this.samples.push({ t: Date.now(), humans: countHumans(), rooms: manager.rooms.size, bots: countBots() }); this.prune(); this.save(); },
  dump() {
    this.prune();
    const joins = this.events.filter((e) => e.type === 'join').length;
    const leaves = this.events.filter((e) => e.type === 'leave').length;
    const peak = this.samples.reduce((m, s) => Math.max(m, s.humans), 0);
    return {
      now: Date.now(), windowHours: 24,
      current: { humans: countHumans(), rooms: manager.rooms.size, bots: countBots() },
      joins24h: joins, leaves24h: leaves, peakHumans24h: peak,
      samples: this.samples,
    };
  },
};
history.load();
setInterval(() => history.sample(), 60000);
history.sample();

function adminOk(req) { const t = process.env.ADMIN_TOKEN; return !t || req.query.token === t; }
app.get('/api/admin/history', (req, res) => {
  if (!adminOk(req)) return res.status(403).json({ error: 'forbidden' });
  res.json(history.dump());
});
app.get('/admin', (req, res) => res.redirect('/admin.html' + (req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '')));

function send(ws, type, data) { if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type, ...data })); }
function broadcast(code, type, data) {
  const msg = JSON.stringify({ type, ...data });
  for (const c of clients.values()) if (c.roomCode === code && c.ws.readyState === c.ws.OPEN) c.ws.send(msg);
}

wss.on('connection', (ws) => {
  const id = randomUUID();
  clients.set(id, { ws, roomCode: null });

  ws.on('message', (raw) => {
    let msg; try { msg = JSON.parse(raw.toString()); } catch { return; }
    const client = clients.get(id);
    if (!client) return;
    switch (msg.type) {
      case 'join': {
        const room = manager.getOrCreate(msg.room, { map: msg.map, bots: msg.bots, classic: msg.classic });
        client.roomCode = room.code;
        const player = room.addPlayer(id, { pid: msg.pid, name: msg.name });
        history.record('join'); history.sample(); // capture concurrency at join time
        send(ws, 'welcome', { id, room: room.code, you: { name: player.name, color: player.color } });
        break;
      }
      case 'aim': {
        const room = client.roomCode && manager.rooms.get(client.roomCode);
        if (room) room.setAim(id, msg.ang);
        break;
      }
      case 'ping':
        send(ws, 'pong', { ts: msg.ts });
        break;
      default: break;
    }
  });

  const cleanup = () => {
    const client = clients.get(id);
    if (client && client.roomCode) {
      const room = manager.rooms.get(client.roomCode);
      if (room) room.removePlayer(id);
      history.record('leave');
    }
    clients.delete(id);
  };
  ws.on('close', cleanup);
  ws.on('error', cleanup);
});

let last = Date.now();
setInterval(() => {
  const now = Date.now();
  const dt = now - last;
  last = now;
  for (const { code, room, events } of manager.updateAll(dt)) {
    for (const ev of events) {
      if (ev.type === 'KILL' || ev.type === 'GEM') broadcast(code, 'event', { event: ev });
    }
    broadcast(code, 'state', { state: room.snapshot() });
  }
}, BROADCAST_MS);

server.listen(PORT, () => {
  console.log(`NAGA ARENA server listening on http://localhost:${PORT}`);
  console.log('Endless mode - continuous steering, follow-cam, infinite respawn.');
});
