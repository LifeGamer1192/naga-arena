// NAGA ARENA - Phase 2 server.
// Express serves the static client; ws handles the realtime protocol.
// Players are grouped into URL-shared rooms managed by RoomManager.

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

const app = express();
app.use(express.static(PUBLIC_DIR));
app.get('/health', (_req, res) => res.json({ ok: true, rooms: manager.rooms.size }));

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

const manager = new RoomManager();
const clients = new Map(); // id -> { ws, roomCode }

function send(ws, type, data) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type, ...data }));
}

function broadcast(code, type, data) {
  const msg = JSON.stringify({ type, ...data });
  for (const c of clients.values()) {
    if (c.roomCode === code && c.ws.readyState === c.ws.OPEN) c.ws.send(msg);
  }
}

wss.on('connection', (ws) => {
  const id = randomUUID();
  clients.set(id, { ws, roomCode: null });

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    const client = clients.get(id);
    if (!client) return;

    switch (msg.type) {
      case 'join': {
        const room = manager.getOrCreate(msg.room, msg.mode, msg.map);
        client.roomCode = room.code;
        const player = room.addPlayer(id);
        send(ws, 'welcome', {
          id, room: room.code,
          you: { name: player.name, color: player.color },
          isHost: room.hostId === id,
        });
        break;
      }
      case 'config': {
        const room = client.roomCode && manager.rooms.get(client.roomCode);
        if (room) room.configure(id, { mode: msg.mode, map: msg.map });
        break;
      }
      case 'ready': {
        const room = client.roomCode && manager.rooms.get(client.roomCode);
        if (room) { room.setReady(id, !!msg.ready); room.maybeStart(); }
        break;
      }
      case 'input': {
        const room = client.roomCode && manager.rooms.get(client.roomCode);
        if (room && typeof msg.dir === 'string') room.setDirection(id, msg.dir);
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

// Main loop: advance every room and broadcast per-room state.
let last = Date.now();
setInterval(() => {
  const now = Date.now();
  const dt = now - last;
  last = now;

  for (const { code, room, events } of manager.updateAll(dt)) {
    for (const ev of events) {
      if (ev.type === 'KILL') broadcast(code, 'event', { event: ev });
      if (ev.type === 'ROUND_END') broadcast(code, 'result', { results: ev.results });
    }
    broadcast(code, 'state', { state: room.snapshot() });
  }
}, BROADCAST_MS);

server.listen(PORT, () => {
  console.log(`NAGA ARENA server listening on http://localhost:${PORT}`);
  console.log('Phase 2 — rooms, 4 maps, 7 items, Battle Royale / Score Attack / Team Battle');
});
