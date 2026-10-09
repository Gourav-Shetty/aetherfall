// @aetherfall/engine — A* pathfinding on tile grids.
//
// - Binary-heap open list (O(log n) push/pop).
// - Octile heuristic (admissible for 8-directional movement).
// - Diagonal movement with corner-cut prevention; 4-dir mode via opts.
// - Optional greedy line-of-sight smoothing (Bresenham supercover).
// - Signature astar(grid, sx, sy, tx, ty, opts?) keeps the v0 BFS fallback
//   call shape: grid[y][x] with 1 = blocked, everything else walkable.

export interface AStarOptions {
  /** Allow 8-directional movement. Default true. */
  diagonal?: boolean;
  /** Cost of diagonal steps. Default Math.SQRT2. */
  diagonalCost?: number;
  /** Collapse line-of-sight-visible waypoints. Default true. */
  smooth?: boolean;
  /** Cap on expanded nodes (0 = unlimited). Default 0. */
  maxExpansions?: number;
}

export type Grid = number[][];

/** Minimal binary min-heap keyed by numeric priority. */
export class BinaryHeap<T> {
  private keys: number[] = [];
  private values: T[] = [];

  get size(): number {
    return this.keys.length;
  }

  isEmpty(): boolean {
    return this.keys.length === 0;
  }

  push(key: number, value: T): void {
    this.keys.push(key);
    this.values.push(value);
    this.bubbleUp(this.keys.length - 1);
  }

  pop(): T | undefined {
    if (this.keys.length === 0) return undefined;
    const top = this.values[0];
    const lastK = this.keys.pop()!;
    const lastV = this.values.pop()!;
    if (this.keys.length > 0) {
      this.keys[0] = lastK;
      this.values[0] = lastV;
      this.sinkDown(0);
    }
    return top;
  }

  private bubbleUp(i: number): void {
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (this.keys[p] <= this.keys[i]) break;
      this.swap(i, p);
      i = p;
    }
  }

  private sinkDown(i: number): void {
    const n = this.keys.length;
    for (;;) {
      const l = i * 2 + 1;
      const r = l + 1;
      let m = i;
      if (l < n && this.keys[l] < this.keys[m]) m = l;
      if (r < n && this.keys[r] < this.keys[m]) m = r;
      if (m === i) break;
      this.swap(i, m);
      i = m;
    }
  }

  private swap(a: number, b: number): void {
    [this.keys[a], this.keys[b]] = [this.keys[b], this.keys[a]];
    [this.values[a], this.values[b]] = [this.values[b], this.values[a]];
  }
}

/** Octile distance: admissible heuristic for 8-directional grids. */
export function octile(ax: number, ay: number, bx: number, by: number, diagCost = Math.SQRT2): number {
  const dx = Math.abs(ax - bx);
  const dy = Math.abs(ay - by);
  return Math.max(dx, dy) + (diagCost - 1) * Math.min(dx, dy);
}

export function isWalkable(grid: Grid, x: number, y: number): boolean {
  if (y < 0 || x < 0 || y >= grid.length) return false;
  const row = grid[y];
  if (!row || x >= row.length) return false;
  return row[x] !== 1;
}

/** Bresenham line-of-sight: true when every cell on the line is walkable. */
export function hasLineOfSight(grid: Grid, x0: number, y0: number, x1: number, y1: number): boolean {
  let x = x0;
  let y = y0;
  const dx = Math.abs(x1 - x0);
  const dy = Math.abs(y1 - y0);
  const sx = x0 < x1 ? 1 : -1;
  const sy = y0 < y1 ? 1 : -1;
  let err = dx - dy;
  for (;;) {
    if (!isWalkable(grid, x, y)) return false;
    if (x === x1 && y === y1) return true;
    const e2 = 2 * err;
    if (e2 > -dy) {
      err -= dy;
      x += sx;
    }
    if (e2 < dx) {
      err += dx;
      y += sy;
    }
  }
}

/** Greedy smoothing: jump to the farthest line-of-sight-visible waypoint. */
export function smoothPath(grid: Grid, path: Array<[number, number]>): Array<[number, number]> {
  if (path.length <= 2) return path.slice();
  const out: Array<[number, number]> = [path[0]];
  let anchor = 0;
  for (let i = 2; i < path.length; i++) {
    const [ax, ay] = path[anchor];
    const [bx, by] = path[i];
    if (!hasLineOfSight(grid, ax, ay, bx, by)) {
      out.push(path[i - 1]);
      anchor = i - 1;
    }
  }
  out.push(path[path.length - 1]);
  return out;
}

export function astar(
  grid: Grid,
  sx: number,
  sy: number,
  tx: number,
  ty: number,
  opts: AStarOptions = {},
): Array<[number, number]> {
  const H = grid.length;
  const W = grid[0]?.length ?? 0;
  if (W === 0 || H === 0) return [];
  if (!isWalkable(grid, sx, sy) || !isWalkable(grid, tx, ty)) return [];
  if (sx === tx && sy === ty) return [[sx, sy]];

  const diagonal = opts.diagonal ?? true;
  const diagCost = opts.diagonalCost ?? Math.SQRT2;
  const smooth = opts.smooth ?? true;
  const maxExpansions = opts.maxExpansions ?? 0;

  const key = (x: number, y: number): number => y * W + x;
  const open = new BinaryHeap<{ x: number; y: number }>();
  const gScore = new Map<number, number>();
  const cameFrom = new Map<number, number>();

  gScore.set(key(sx, sy), 0);
  open.push(octile(sx, sy, tx, ty, diagCost), { x: sx, y: sy });

  const closed = new Set<number>();
  let expansions = 0;

  while (!open.isEmpty()) {
    const cur = open.pop()!;
    const ck = key(cur.x, cur.y);
    if (closed.has(ck)) continue;
    closed.add(ck);

    if (cur.x === tx && cur.y === ty) {
      const path: Array<[number, number]> = [[tx, ty]];
      let k = ck;
      while (cameFrom.has(k)) {
        const p = cameFrom.get(k)!;
        path.unshift([p % W, Math.floor(p / W)]);
        k = p;
      }
      return smooth ? smoothPath(grid, path) : path;
    }

    if (maxExpansions > 0 && ++expansions > maxExpansions) return [];

    const g = gScore.get(ck)!;
    // Build neighbor list: 4-dir always, diagonals unless disabled.
    const neighbors: Array<[number, number, number]> = [
      [1, 0, 1],
      [-1, 0, 1],
      [0, 1, 1],
      [0, -1, 1],
    ];
    if (diagonal) {
      neighbors.push(
        [1, 1, diagCost],
        [1, -1, diagCost],
        [-1, 1, diagCost],
        [-1, -1, diagCost],
      );
    }

    for (const [dx, dy, cost] of neighbors) {
      const nx = cur.x + dx;
      const ny = cur.y + dy;
      if (!isWalkable(grid, nx, ny)) continue;
      // No corner cutting: diagonal step needs both orthogonal sides free.
      if (dx !== 0 && dy !== 0) {
        if (!isWalkable(grid, cur.x + dx, cur.y) || !isWalkable(grid, cur.x, cur.y + dy)) {
          continue;
        }
      }
      const nk = key(nx, ny);
      if (closed.has(nk)) continue;
      const tentative = g + cost;
      if (tentative < (gScore.get(nk) ?? Infinity)) {
        gScore.set(nk, tentative);
        cameFrom.set(nk, ck);
        open.push(tentative + octile(nx, ny, tx, ty, diagCost), { x: nx, y: ny });
      }
    }
  }
  return [];
}
