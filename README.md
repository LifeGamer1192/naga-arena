# NAGA ARENA

A browser-based, real-time multiplayer snake arena with an authoritative server
(all game logic runs on the server; clients only send input and render).

> **🎮 Live demo: https://naga-arena.fly.dev/**
> Share the room link with friends and open it on multiple devices to play together.
> (Machines stop when idle, so the first request may take a few seconds to cold-start.)

Slither around an endless arena, eat frogs to grow, and avoid other snakes.
Your own tail is safe — only touching **another** snake is fatal. Death is never
final: you respawn after a short countdown and keep playing until you leave.

## Features

- **Authoritative server**: movement, collisions and scoring all run server-side.
- **Continuous analog steering**: smooth heading with diagonals and gentle curves
  (no rigid 90° grid turns). Mouse, keyboard (WASD / arrows) or touch.
- **Follow camera**: the view is zoomed in and tracks your snake; you don't need
  to see the whole field.
- **Infinite respawn**: when you die you respawn after a few-second countdown.
- **Name-based colours**: your snake's colour is derived from your name (32-colour
  palette, de-duplicated per room) so everyone is easy to tell apart.
- **Self-safe collisions**: your own tail can't kill you; another snake's body can.
- **Frog food**: eat frogs to grow; dying scatters frogs where you fell.
- **4 maps** (default **TUNNEL**): VOID, LABYRINTH, TUNNEL (wrap-around edges),
  ARENA. TUNNEL wraps seamlessly thanks to a tiling follow-camera.
- **URL-shared rooms**, sound effects, particle effects, and mobile support.
- **Production hardening**: security headers (CSP, nosniff, frame options).

## Requirements

- Node.js 20+

## Run locally

```bash
npm install
npm start
```

Open http://localhost:3000, type a name, pick a map and press **PLAY**.
Open the same URL on another device/tab to join the same room.

## Controls

| Input | How to steer |
| --- | --- |
| Mouse | Snake heads toward the cursor |
| Keyboard | Arrow keys / WASD (hold two for diagonals) |
| Touch | Drag — the snake heads toward your finger |

## Tech stack

| Layer | Tech |
| --- | --- |
| Frontend | HTML5 Canvas, Vanilla JS (ES2022), WebSocket API |
| Backend | Node.js 20+, ws, Express |
| Hosting | Fly.io (single machine) |

## Architecture

```
Browser Clients ──WebSocket(aim / state)──> Node.js Game Server
                                              └ RoomManager → GameRoom (per room)
```

- Each snake has a continuous head position, heading angle and a trail; the head
  advances each tick and the heading eases toward the player's aim (analog turn).
- Collisions use wrap-aware (toroidal) distance against other snakes' trails.
- The server broadcasts each room's state every 50ms; the client interpolates and
  renders with a zoomed follow-camera (tiling the world for seamless TUNNEL wrap).

## Project layout

```
naga_arena/
├── package.json
├── Dockerfile, fly.toml, .dockerignore   # deployment
├── server/
│   ├── server.js   # Express + ws, RoomManager wiring, broadcast loop
│   ├── game.js     # GameRoom + RoomManager: continuous movement, food, respawn
│   └── maps.js     # 4 map definitions
├── public/
│   ├── index.html  # TITLE + GAME screens
│   ├── style.css
│   └── client.js   # WebSocket client, follow-camera renderer, analog input
└── test/
    ├── unit.mjs    # deterministic engine tests
    ├── render.mjs  # headless DOM/Canvas harness that executes client.js
    └── smoke.mjs   # headless 2-client end-to-end test
```

## Tests

```bash
npm test            # deterministic unit tests + headless render harness

# headless end-to-end (server must be running on :3000)
node test/smoke.mjs                 # VOID: chase frogs + verify respawn
```

## Deploy (Fly.io)

```bash
fly apps create naga-arena          # first time only
fly deploy --ha=false --remote-only
```

`fly.toml` uses a **single machine** on purpose: a game room lives in server
memory, so all players must connect to the same instance.

## License

MIT
