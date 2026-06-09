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
- **AI bots**: fill the room with 0–8 computer snakes (default 1) so solo play is
  fun; bots chase frogs, dodge bodies and respawn like everyone else.
- **Infinite respawn**: when you die you respawn after a few-second countdown.
- **Name-based colours**: your snake's colour is derived from your name (32-colour
  palette, de-duplicated per room) so everyone is easy to tell apart.
- **Self-safe collisions**: your own tail can't kill you; another snake's body can.
  Dying scatters frogs (proportional to your length) where you fell.
- **Hopping frog food**: frogs face a direction, hop forward every few seconds and
  occasionally turn — eat them to grow.
- **Gem power-ups** (stacking status effects, shown above every snake with a
  countdown):
  - **Vacuum** (20s) — pulls nearby food toward you.
  - **Giant** (10s) — your head doubles in size (and reach).
  - **Poison Gas** (30s) — you're immune and fire fast poison bolts straight
    ahead; snakes hit by one are poisoned and slowed 25% for 8s.
- **Classic mode**: traditional rules — your own tail is lethal, frogs stay still
  and gems are rare.
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

## Admin screen

`/admin` (or `/admin.html`) shows in-memory activity from the last ~24h:
current/peak players, rooms, bots, joins/leaves and a concurrency chart. Data is
counts only (no names) and resets if the process restarts. Protect it by setting
the `ADMIN_TOKEN` env var, then open `/admin?token=YOUR_TOKEN`
(`fly secrets set ADMIN_TOKEN=...`). If unset, the screen is open.

## Deploy (Fly.io)

```bash
fly apps create naga-arena          # first time only
fly deploy --ha=false --remote-only
```

`fly.toml` uses a **single machine** on purpose: a game room lives in server
memory, so all players must connect to the same instance.

## License

MIT
