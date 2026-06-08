// NAGA ARENA - Phase 1 MVP server.
// Express serves the static client; ws handles the realtime game protocol.
// Single shared room (URL-shared rooms come in Phase 2).

import express from 'express';
import { WebSocketServer } from 'ws';
import http from 'http';
import { fileURLToPath } from 'url';
import path from 'path';
import { randomUUID } from 'crypto';
import { GameRoom, PHASE } from './game.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const PORT = process.env.PORT || 3000;
const BROADCAST_MS = 50; // 20 ticks/sec broadcast (per spec)

const app = express();
app.use(express.static(PUBLIC_DIR));
app.get('/health', (_req, res) => res.json({ ok: true }));

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

const room = new GameRoom();
const sockets = new Map(); // id -> ws

function send(ws, type, data) {
  if (ws.readyState === ws.OPEN) {
    ws.send(JSON.stringify({ type, ...data }));
  }
}

function broadcast(type, data) {
  const msg = JSON.stringify({ type, ...data });
  for (const ws of sockets.values()) {
    if (ws.readyState === ws.OPEN) ws.send(msg);
  }
}

wss.on('connection', (ws) => {
  const id = randomUUID();
  sockets.set(id, ws);
  const player = room.addPlayer(id);
  // Tell the client its own identity.
  send(ws, 'welcome', { id, you: { name: player.name, color: player.color } });

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }
    switch (msg.type) {
      case 'input':
        if (typeof msg.dir === 'string') room.setDirection(id, msg.dir);
        break;
      case 'ready':
        room.setReady(id, !!msg.ready);
        room.maybeStart();
        break;
      case 'ping':
        send(ws, 'pong', { ts: msg.ts });
        break;
      default:
        break;
    }
  });

  ws.on('close', () => {
    sockets.delete(id);
    room.removePlayer(id);
  });

  ws.on('error', () => {
    sockets.delete(id);
    room.removePlayer(id);
  });
});

// Main server loop.
let last = Date.now();
setInterval(() => {
  const now = Date.now();
  const dt = now - last;
  last = now;

  const events = room.update(dt);
  for (const ev of events) {
    if (ev.type === 'KILL') broadcast('event', { event: ev });
    if (ev.type === 'ROUND_END') broadcast('result', { results: ev.results });
  }
  broadcast('state', { state: room.snapshot() });
}, BROADCAST_MS);

server.listen(PORT, () => {
  console.log(`NAGA ARENA server listening on http://localhost:${PORT}`);
  console.log(`Phase 1 MVP — Battle Royale, food only. Phase: ${PHASE.LOBBY}`);
});
