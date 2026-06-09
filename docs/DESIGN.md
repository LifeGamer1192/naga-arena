# NAGA ARENA

## NAGA ARENA — Design Document

### Overview

NAGA ARENA is a browser-based multiplayer game that combines the classic snake
game with real-time competition. No installation required: share a room URL and
play with friends instantly, while keeping the strategic depth of competitive play.

| Item | Detail |
| --- | --- |
| Genre | Multiplayer competitive snake |
| Platform | Browser (HTML/CSS/JS) |
| Max players (per room) | 8 |
| Target match length | 2–5 minutes |
| Devices | PC / mobile (touch supported) |

### Core gameplay

Each player's snake moves continuously on a grid map. Eating food increases body
length and score. Colliding with your own body, another player's body, or a wall
kills you. The last survivor, or the highest score, wins.

### Movement & controls

| Action | PC | Mobile | Note |
| --- | --- | --- | --- |
| Up | ↑ / W | Swipe up | Ignored while moving down |
| Down | ↓ / S | Swipe down | Ignored while moving up |
| Left | ← / A | Swipe left | Ignored while moving right |
| Right | → / D | Swipe right | Ignored while moving left |
| Boost | Space / Shift | Long-press | 2x speed, -2 length (requires 3+ cells) |

### Scoring

```
food score   = food eaten x 10 x combo multiplier
combo mult   = 1 + (consecutive picks x 0.1)   // max x3.0
survival     = seconds alive x 0.5
kill reward  = kills x 50
final score  = food score + survival + kill reward

Rank bonus (Battle Royale)
1st: x2.0  /  2nd: x1.5  /  3rd: x1.2
```

---

### Game modes

| Mode | Players | Win condition | Notes |
| --- | --- | --- | --- |
| BATTLE ROYALE | 2–8 | Last survivor | Standard mode |
| SCORE ATTACK | 2–8 | Highest score within time limit | 3 minutes, respawn on death |
| TEAM BATTLE | 4–8 (2 teams) | Team total score | Friendly collisions disabled |
| RANKED | 4–8 | Point-based | Rating changes |

### Maps

| Map | Size | Notes |
| --- | --- | --- |
| VOID | 40×30 | No obstacles. Standard field |
| LABYRINTH | 50×40 | Fixed walls, maze-like |
| TUNNEL | 40×30 | Teleport tunnel (wrap-around edges) |
| ARENA | 60×50 | Central coliseum, periodic obstacles |

### Items

| Item | Effect | Spawn chance | Duration |
| --- | --- | --- | --- |
| Food | +1 length, +10 score | Always | — |
| Super Food | +3 length, +50 score | 5% | — |
| Speed Up | Move speed x1.5 | 8% | 5s |
| Shrink | Halve length | 5% | — |
| Shield | Block one collision | 6% | 10s |
| Freeze Bomb | Freeze snakes within 3 cells for 1s | 4% | — |
| Ghost | Disable collision (pass through) | 3% | 4s |

### System design

#### Architecture

Authoritative-server model. All game logic runs on the server; clients only send
input and render.

```
Browser Clients (~8)
  ↕ WebSocket (input / state diffs)
Node.js Game Server
  ↕
Redis (rooms / sessions) + PostgreSQL (scores / rankings)
```

#### Tech stack

| Layer | Tech |
| --- | --- |
| Frontend | HTML5 Canvas, Vanilla JS (ES2022), WebSocket API |
| Backend | Node.js 20+, ws, Express |
| Cache | Redis 7 (Upstash free tier) |
| DB | PostgreSQL 15 (Neon free tier) |
| Hosting | Cloudflare Pages (frontend) + Fly.io (server) |

#### Game loop (server-side, 50ms interval)

```
1. Resolve each snake's next direction from the input buffer
2. Move all snakes one cell (compute new head positions)
3. Collision checks (wall / body / head-on)
4. Item pickup checks → apply effects
5. Spawn new food if short
6. Check win conditions
7. Broadcast state diffs
```

#### WebSocket message spec

**Client → Server**

| Event | Payload | Description |
| --- | --- | --- |
| input | {"dir":"UP","seq":42} | Direction input (with sequence number) |
| boost | {"active":true,"seq":43} | Boost start/stop |

**Server → Client**

| Event | Payload | Description |
| --- | --- | --- |
| state | {"tick":1200,"snakes":[…],"items":[…]} | Per-tick state diff |
| event | {"type":"KILL","killer":"p1","victim":"p3"} | Game event notification |
| result | {"rank":1,"score":1240,"kills":3} | Match result |
| ping | {"ts":1749600000} | Latency measurement (every 5s) |

#### Latency handling

| Technique | Detail |
| --- | --- |
| Client-Side Prediction | Apply input locally immediately, correct on server confirmation |
| Interpolation | Buffer other players' positions by 2 frames, render with linear interpolation |

| Metric | Target |
| --- | --- |
| Server tick rate | 20 tick/sec (50ms) |
| Max acceptable latency | 200ms |
| Message payload | < 2KB / tick |

#### Canvas rendering (4 layers)

| Layer | Content | Update frequency |
| --- | --- | --- |
| Background | Grid lines, map obstacles | Only on map change |
| Items | Food, items (blinking animation) | 30fps |
| Snakes | Bodies, heads, effects | 60fps (interpolated) |
| UI Overlay | Score, time left, kill log | Every frame |

#### Screen flow

```
TITLE → LOBBY → COUNTDOWN(3..2..1) → PLAYING → RESULT → LOBBY
                                          ↓
                                   spectate after death
```

---

### Rating system

| Rank | Rating range | Change (win/loss) |
| --- | --- | --- |
| BRONZE | 0–999 | +30 / -20 |
| SILVER | 1000–1499 | +25 / -22 |
| GOLD | 1500–1999 | +20 / -25 |
| DIAMOND | 2000–2499 | +15 / -28 |
| SERPENT KING | 2500+ | +12 / -30 |

### Infrastructure & operating cost

| Service | Role | Free tier |
| --- | --- | --- |
| Fly.io | Node.js server | Shared CPU / ~256MB RAM (free tier may change) |
| Upstash | Redis | 10,000 requests/day, 256MB |
| Neon | PostgreSQL | 500MB |
| Cloudflare Pages | Static file delivery | Unlimited |

For a circle of friends (~50 players/month) it can run fully free.

---

### Development roadmap

| Phase | Duration | Scope |
| --- | --- | --- |
| Phase 1 | ~2 weeks | MVP: WebSocket connection, Battle Royale only, food only |
| Phase 2 | ~4 weeks | URL-shared rooms, all items, 4 maps, all modes, mobile support |
| Phase 3 | ~6 weeks | Ranked mode, rating, leaderboard, spectating |
| Phase 4 | ~8 weeks | Custom skins, SFX, tournament mode, production deploy |

### Technical risks

| Risk | Severity | Mitigation |
| --- | --- | --- |
| Gameplay breaks under high latency | High | Warn above 200ms, correct with input timestamps |
| Cheating (direction tampering, etc.) | High | Run all decisions server-side |
| Room distribution when scaling out | Medium | Share across nodes via Redis Pub/Sub |
| Canvas rendering load on mobile | Medium | OffscreenCanvas, pre-render static layers |
