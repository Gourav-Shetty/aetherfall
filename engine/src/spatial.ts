// @aetherfall/engine — dynamic spatial hash for interest management.
//
// - Cell size configurable (default 8 world units).
// - Incremental updates: insert/move/remove are O(1); rebuild() for bulk load.
// - radius query (near) filters by exact Euclidean distance.
// - box() AABB query for chunk/region streaming.
// - Chunk helpers map the 40m interest radius (protocol v1) to chunk coords
//   so the server only sends entities in subscribed chunks.

export const DEFAULT_CELL_SIZE = 8;
/** Protocol v1 interest radius: server only replicates within 40 units. */
export const INTEREST_RADIUS = 40;

export interface Point {
  x: number;
  y: number;
}

export interface ChunkCoord {
  cx: number;
  cy: number;
}

export function chunkOf(x: number, y: number, chunkSize = 32): ChunkCoord {
  return { cx: Math.floor(x / chunkSize), cy: Math.floor(y / chunkSize) };
}

export class SpatialHash {
  private cell: number;
  /** cellKey -> entity ids */
  private cells = new Map<string, Set<number>>();
  /** entity id -> world position */
  private positions = new Map<number, Point>();
  /** entity id -> cellKey (for O(1) moves) */
  private entityCell = new Map<number, string>();

  constructor(cellSize = DEFAULT_CELL_SIZE) {
    if (cellSize <= 0) throw new Error('cellSize must be positive');
    this.cell = cellSize;
  }

  get cellSize(): number {
    return this.cell;
  }

  get size(): number {
    return this.positions.size;
  }

  private key(x: number, y: number): string {
    return `${Math.floor(x / this.cell)},${Math.floor(y / this.cell)}`;
  }

  /** Insert or reposition an entity (upsert). */
  insert(id: number, x: number, y: number): void {
    this.move(id, x, y);
  }

  /** Update an entity's position, moving cells when needed. */
  move(id: number, x: number, y: number): void {
    const k = this.key(x, y);
    const old = this.entityCell.get(id);
    this.positions.set(id, { x, y });
    if (old === k) return;
    if (old !== undefined) {
      const set = this.cells.get(old);
      if (set) {
        set.delete(id);
        if (set.size === 0) this.cells.delete(old);
      }
    }
    let set = this.cells.get(k);
    if (!set) {
      set = new Set();
      this.cells.set(k, set);
    }
    set.add(id);
    this.entityCell.set(id, k);
  }

  remove(id: number): boolean {
    const cellKey = this.entityCell.get(id);
    if (cellKey === undefined) return false;
    const set = this.cells.get(cellKey);
    if (set) {
      set.delete(id);
      if (set.size === 0) this.cells.delete(cellKey);
    }
    this.entityCell.delete(id);
    this.positions.delete(id);
    return true;
  }

  has(id: number): boolean {
    return this.positions.has(id);
  }

  get(id: number): Point | undefined {
    return this.positions.get(id);
  }

  clear(): void {
    this.cells.clear();
    this.positions.clear();
    this.entityCell.clear();
  }

  /** Bulk load: clears the index and inserts every entry. */
  rebuild(pos: Map<number, { x: number; y: number }>): void {
    this.clear();
    for (const [id, p] of pos) this.move(id, p.x, p.y);
  }

  /**
   * Entity ids within radius r of (x, y), exact-distance filtered and
   * sorted by ascending distance. Optional `max` caps result count.
   */
  near(x: number, y: number, r: number, max = Infinity): number[] {
    if (r < 0) return [];
    const c = Math.ceil(r / this.cell);
    const cx = Math.floor(x / this.cell);
    const cy = Math.floor(y / this.cell);
    const r2 = r * r;
    const scored: Array<{ id: number; d2: number }> = [];
    for (let ix = cx - c; ix <= cx + c; ix++) {
      for (let iy = cy - c; iy <= cy + c; iy++) {
        const set = this.cells.get(`${ix},${iy}`);
        if (!set) continue;
        for (const id of set) {
          const p = this.positions.get(id)!;
          const dx = p.x - x;
          const dy = p.y - y;
          const d2 = dx * dx + dy * dy;
          if (d2 <= r2) scored.push({ id, d2 });
        }
      }
    }
    scored.sort((a, b) => a.d2 - b.d2);
    const out = scored.map((s) => s.id);
    return max === Infinity ? out : out.slice(0, max);
  }

  /** Entity ids inside the axis-aligned box [minX,maxX] x [minY,maxY]. */
  box(minX: number, minY: number, maxX: number, maxY: number): number[] {
    if (maxX < minX || maxY < minY) return [];
    const x0 = Math.floor(minX / this.cell);
    const x1 = Math.floor(maxX / this.cell);
    const y0 = Math.floor(minY / this.cell);
    const y1 = Math.floor(maxY / this.cell);
    const out: number[] = [];
    for (let ix = x0; ix <= x1; ix++) {
      for (let iy = y0; iy <= y1; iy++) {
        const set = this.cells.get(`${ix},${iy}`);
        if (!set) continue;
        for (const id of set) {
          const p = this.positions.get(id)!;
          if (p.x >= minX && p.x <= maxX && p.y >= minY && p.y <= maxY) out.push(id);
        }
      }
    }
    return out;
  }

  /**
   * Chunk coords covering the interest circle around (x, y).
   * The server subscribes a client to these chunks and only replicates
   * entities inside them (interest radius defaults to 40m per protocol v1).
   */
  subscribedChunks(x: number, y: number, r = INTEREST_RADIUS, chunkSize = 32): ChunkCoord[] {
    const min = chunkOf(x - r, y - r, chunkSize);
    const max = chunkOf(x + r, y + r, chunkSize);
    const out: ChunkCoord[] = [];
    for (let cx = min.cx; cx <= max.cx; cx++) {
      for (let cy = min.cy; cy <= max.cy; cy++) {
        out.push({ cx, cy });
      }
    }
    return out;
  }

  /** Stable string keys ("cx,cy") for a chunk subscription set. */
  subscriptionKeys(x: number, y: number, r = INTEREST_RADIUS, chunkSize = 32): Set<string> {
    const keys = new Set<string>();
    for (const c of this.subscribedChunks(x, y, r, chunkSize)) {
      keys.add(`${c.cx},${c.cy}`);
    }
    return keys;
  }

  /**
   * Diff two subscription key sets (from subscriptionKeys) into
   * { entered, left } so the server can stream in/out chunk entities.
   */
  static diffSubscriptions(
    prev: Set<string>,
    next: Set<string>,
  ): { entered: string[]; left: string[] } {
    const entered: string[] = [];
    const left: string[] = [];
    for (const k of next) if (!prev.has(k)) entered.push(k);
    for (const k of prev) if (!next.has(k)) left.push(k);
    return { entered, left };
  }
}
