// NAGA ARENA - server.
// Express serves the static client; ws handles the realtime protocol.
// Players drop into a URL-shared endless world and steer with a heading angle.

import express from 'express';
import { WebSocketServer } from 'ws';
import http from 'http';
import { fileURLToPath } from 'url';
import path from 'path';
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
