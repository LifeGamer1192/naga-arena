# NAGA ARENA

A browser-based, real-time multiplayer snake game with an authoritative server
(all game logic runs on the server; clients only send input and render).

> **🎮 Live demo: https://naga-arena.fly.dev/**
> Share the room link with friends and open it on multiple devices to play together.
> (Machines stop when idle, so the first request may take a few seconds to cold-start.)

> **Phase 3** — current state of this repository.
> URL-shared rooms / all 7 items / 4 maps / 4 game modes / Ranked rating +
> leaderboard / spectating / mobile support.

## Features

- **Authoritative server**: every decision (movement, collisions, scoring) runs
  server-side, which keeps the game cheat-resistant. Clients only send input.
- **URL-shared rooms**: each room has a short code in the URL. Open the same link
  to join the same room; the host picks the mode and map.
- **4 game modes**:
  - **Battle Royale** — last snake standing wins.
  - **Score Attack** — 3 minutes, respawn on death, highest score wins.
  - **Team Battle** — 2 teams, friendly pass-through, highest team total wins.
  - **Ranked** — last-survivor play that updates your persistent rating.
- **Ranked rating & leaderboard**: a persistent rating per player (no account
  needed — a local id), tier-scaled win/loss deltas, and a global leaderboard
  served at `/api/leaderboard`.
- **Spectating**: join a room mid-match (or after being eliminated) and watch
  the live game until the next round.
- **4 maps**: VOID (open), LABYRINTH (maze walls), TUNNEL (wrap-around edges),
  ARENA (central coliseum with periodic obstacles).
- **7 items**: Food, Super Food, Speed Up, Shrink, Shield, Freeze Bomb, Ghost.
- **Real-time sync** over WebSocket, broadcasting state at 20 ticks/sec.
- **Desktop & mobile**: arrow keys / WASD, or swipe / on-screen D-pad.

## Requirements

- Node.js 20+

## Run locally

```bash
npm install
npm start
```

Open http://localhost:3000. Open multiple tabs/devices to play together.

- `ENTER ARENA` → lobby
- The host selects mode & map; everyone presses `READY` → 3..2..1 → start
  (you can play solo to practice).
- Use **Copy invite link** to share the room URL.

## Controls

| Action | Desktop | Mobile |
| --- | --- | --- |
| Move | Arrow keys / WASD | Swipe / on-screen D-pad |

Reversing directly into your current direction is ignored (prevents instant death).

## Items

| Item | Effect | Spawn chance | Duration |
| --- | --- | --- | --- |
| Food | +1 length, +10 score | always on field | — |
| Super Food | +3 length, +50 score | 5% | — |
| Speed Up | move 1.5x faster | 8% | 5s |
| Shrink | halve your length | 5% | — |
| Shield | block one collision | 6% | 10s |
| Freeze Bomb | freeze snakes within 3 cells | 4% | 1s |
| Ghost | pass through bodies & obstacles | 3% | 4s |

## Scoring

```
food score   = base(10/50) x combo multiplier
combo mult   = 1 + (consecutive picks x 0.1)   // capped at x3.0
survival     = seconds alive x 0.5             // Battle Royale
kill reward  = kills x 50
rank bonus   = 1st x2.0 / 2nd x1.5 / 3rd x1.2  // Battle Royale
```

## Ranked rating

In Ranked mode, finishing in the top half of the lobby is a win. The rating
change scales by your current tier (higher tiers gain less and lose more).
Everyone starts at 1000 (SILVER).

| Tier | Rating | Win / Loss |
| --- | --- | --- |
| BRONZE | 0–999 | +30 / -20 |
| SILVER | 1000–1499 | +25 / -22 |
| GOLD | 1500–1999 | +20 / -25 |
| DIAMOND | 2000–2499 | +15 / -28 |
| SERPENT KING | 2500+ | +12 / -30 |

The leaderboard (players with at least one ranked match) is available at
`GET /api/leaderboard` and from the title screen.

## Tech stack

| Layer | Tech |
| --- | --- |
| Frontend | HTML5 Canvas, Vanilla JS (ES2022), WebSocket API |
| Backend | Node.js 20+, ws, Express |
| Hosting | Fly.io (single machine) |

## Architecture

```
Browser Clients ──WebSocket(input / state)──> Node.js Game Server
                                                └ RoomManager → GameRoom (per room)
```

- Server loop broadcasts each room's state every 50ms.
- Each snake advances one cell every `STEP_MS` (default 130ms); Speed Up shortens
  that interval per snake.
- Collisions: walls, static/dynamic obstacles, snake bodies (self & others),
  with tunnel wrap, shield, ghost and friendly pass-through handled per map/mode.

## Project layout

```
naga_arena/
├── package.json
├── Dockerfile, fly.toml, .dockerignore   # deployment
├── server/
│   ├── server.js   # Express + ws, RoomManager wiring, broadcast loop, /api
│   ├── game.js     # GameRoom + RoomManager: movement, items, modes, scoring
│   ├── maps.js     # 4 map definitions
│   └── ratings.js  # persistent rating store, tiers, leaderboard
├── public/
│   ├── index.html  # screens: TITLE / LEADERBOARD / LOBBY / GAME / RESULT
│   ├── style.css
│   └── client.js   # WebSocket client, Canvas renderer, input
└── test/
    ├── unit.mjs    # deterministic engine tests
    └── smoke.mjs   # headless 2-client end-to-end test
```

## Tests

```bash
npm test            # deterministic unit tests

# headless end-to-end (server must be running on :3000)
node test/smoke.mjs                       # Battle Royale on VOID
MODE=SCORE_ATTACK MAP=ARENA node test/smoke.mjs
```

## Deploy (Fly.io)

```bash
fly apps create naga-arena                       # first time only
fly volumes create naga_data --region nrt --size 1  # ratings persistence
fly deploy --ha=false --remote-only
```

`fly.toml` uses a **single machine** on purpose: a game room lives in server
memory, so all players must connect to the same instance. Multi-node sharing
(via Redis) is planned for a later phase. Ratings are written to a mounted
volume (`/data`) via the `RATINGS_FILE` env var, so they survive redeploys.

## Roadmap

| Phase | Scope | Status |
| --- | --- | --- |
| Phase 1 | MVP: WebSocket, Battle Royale, food only | ✅ done |
| Phase 2 | URL-shared rooms, all items, 4 maps, modes, mobile | ✅ done |
| Phase 3 | Ranked mode, rating, leaderboard, spectating | ✅ done |
| Phase 4 | Skins, SFX, tournament mode, production deploy | planned |

## License

MIT
