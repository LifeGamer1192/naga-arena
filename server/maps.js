// NAGA ARENA - map definitions (Phase 2).
// Each map provides a grid size and a set of static wall cells ("x,y").
// Some maps have special behaviour flags (tunnel wrap, dynamic obstacles).

function key(x, y) { return `${x},${y}`; }

// VOID - open field, no obstacles.
function buildVoid() {
  return { id: 'VOID', w: 40, h: 30, walls: new Set(), tunnel: false, dynamic: false };
}

// LABYRINTH - scattered L-shaped walls forming a maze-like field.
function buildLabyrinth() {
  const w = 50, h = 40;
  const walls = new Set();
  for (let gx = 6; gx < w - 4; gx += 9) {
    for (let gy = 5; gy < h - 4; gy += 8) {
      // Alternate the L orientation for variety (deterministic).
      const flip = ((gx + gy) / 2) % 2 === 0;
      for (let i = 0; i < 4; i++) walls.add(key(gx + (flip ? -i : i), gy));
      for (let i = 0; i < 3; i++) walls.add(key(gx, gy + i));
    }
  }
  return { id: 'LABYRINTH', w, h, walls, tunnel: false, dynamic: false };
}

// TUNNEL - open field but edges wrap around (teleport through walls).
function buildTunnel() {
  return { id: 'TUNNEL', w: 40, h: 30, walls: new Set(), tunnel: true, dynamic: false };
}

// ARENA - central coliseum ring with gates, plus periodic dynamic obstacles.
function buildArena() {
  const w = 60, h = 50;
  const walls = new Set();
  const cx = Math.floor(w / 2), cy = Math.floor(h / 2);
  const rx = 13, ry = 9;
  const left = cx - rx, right = cx + rx, top = cy - ry, bottom = cy + ry;
  for (let x = left; x <= right; x++) {
    // Leave a gate in the middle of the top and bottom edges.
    if (Math.abs(x - cx) > 1) { walls.add(key(x, top)); walls.add(key(x, bottom)); }
  }
  for (let y = top; y <= bottom; y++) {
    // Leave a gate in the middle of the left and right edges.
    if (Math.abs(y - cy) > 1) { walls.add(key(left, y)); walls.add(key(right, y)); }
  }
  // Candidate cells that periodically appear/disappear during play.
  const dynamicCells = [
    [cx, cy], [cx - 6, cy - 4], [cx + 6, cy - 4], [cx - 6, cy + 4], [cx + 6, cy + 4],
    [8, 8], [w - 9, 8], [8, h - 9], [w - 9, h - 9],
    [cx, 6], [cx, h - 7], [10, cy], [w - 11, cy],
  ];
  return {
    id: 'ARENA', w, h, walls, tunnel: false, dynamic: true,
    dynamicCells: dynamicCells.map(([x, y]) => ({ x, y })),
  };
}

const BUILDERS = {
  VOID: buildVoid,
  LABYRINTH: buildLabyrinth,
  TUNNEL: buildTunnel,
  ARENA: buildArena,
};

export const MAP_IDS = Object.keys(BUILDERS);

export function getMap(id) {
  const build = BUILDERS[id] || BUILDERS.VOID;
  return build();
}
