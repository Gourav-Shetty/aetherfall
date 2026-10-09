// @aetherfall/server — interest management: 40m radius culling per player.
import type { EntitySnapshot } from '@aetherfall/shared';

export const INTEREST_RADIUS = 40;

export function dist2(ax: number, ay: number, bx: number, by: number): number {
  const dx = ax - bx;
  const dy = ay - by;
  return dx * dx + dy * dy;
}

/** Return only entities within radius of viewer (inclusive). Viewer always sees self. */
export function filterInterest(
  viewer: { x: number; y: number; id?: number },
  entities: EntitySnapshot[],
  radius: number = INTEREST_RADIUS,
): EntitySnapshot[] {
  const r2 = radius * radius;
  return entities.filter((e) => {
    if (viewer.id !== undefined && e.id === viewer.id) return true;
    return dist2(viewer.x, viewer.y, e.p.x, e.p.y) <= r2;
  });
}

/**
 * Per-player visibility tracker. Computes `removed` (ids that left range /
 * despawned) so clients can evict predicted entities. Server sends
 * interest-filtered snapshot + removed[] per tick.
 */
export class InterestTracker {
  private known = new Map<number, Set<number>>();

  /** Compute visible set + removed ids for one viewer. Updates known state. */
  update(
    viewerId: number,
    viewer: { x: number; y: number },
    entities: EntitySnapshot[],
    radius: number = INTEREST_RADIUS,
  ): { visible: EntitySnapshot[]; removed: number[] } {
    const visible = filterInterest({ ...viewer, id: viewerId }, entities, radius);
    const prev = this.known.get(viewerId) ?? new Set<number>();
    const next = new Set(visible.map((e) => e.id));
    const removed: number[] = [];
    for (const id of prev) if (!next.has(id)) removed.push(id);
    this.known.set(viewerId, next);
    return { visible, removed };
  }

  /** Mark an entity despawned globally: every viewer reports it removed once. */
  despawn(entityId: number): number[] {
    const affected: number[] = [];
    for (const [viewerId, set] of this.known) {
      if (set.delete(entityId)) affected.push(viewerId);
    }
    return affected;
  }

  forget(viewerId: number): void {
    this.known.delete(viewerId);
  }

  /**
   * Index-based variant of updateKnown(): the caller supplies visible entity
   * INDICES (e.g. from InterestIndex.collectIndices) plus the array they index
   * into. Only ids are read — the entities themselves are never copied.
   */
  updateKnownIndices(
    viewerId: number,
    visibleIdx: number[],
    entities: EntitySnapshot[],
  ): { removed: number[] } {
    const prev = this.known.get(viewerId) ?? new Set<number>();
    const next = new Set<number>();
    for (let i = 0; i < visibleIdx.length; i++) next.add(entities[visibleIdx[i]!]!.id);
    const removed: number[] = [];
    for (const id of prev) if (!next.has(id)) removed.push(id);
    this.known.set(viewerId, next);
    return { removed };
  }

  /**
   * Precomputed-visible variant of update(): same removed[] semantics and known
   * bookkeeping, but skips the O(E) full-entity filter. The caller supplies the
   * already-filtered visible set (e.g. from InterestIndex.collect); this method
   * only diffs ids against the viewer's known set. Order of `removed` matches
   * update() (previous-known insertion order).
   */
  updateKnown(viewerId: number, visible: EntitySnapshot[]): { visible: EntitySnapshot[]; removed: number[] } {
    const prev = this.known.get(viewerId) ?? new Set<number>();
    const next = new Set<number>();
    for (let i = 0; i < visible.length; i++) next.add(visible[i]!.id);
    const removed: number[] = [];
    for (const id of prev) if (!next.has(id)) removed.push(id);
    this.known.set(viewerId, next);
    return { visible, removed };
  }

  knownIds(viewerId: number): Set<number> {
    return this.known.get(viewerId) ?? new Set();
  }
}

/**
 * Chunk-bucket interest index (perf path).
 *
 * The per-tick snapshot loop used to run filterInterest() per player — an
 * O(P*E) full scan with a closure + spread + Set per viewer. Instead, bucket
 * every entity once per tick into coarse cells, then each viewer only scans
 * the cells overlapping its interest circle. Membership and ordering match
 * filterInterest() exactly (ascending entity order = `entities` order), so
 * `removed[]` diffs and client views are unchanged.
 */
export class InterestIndex {
  private cell: number;
  /** cellKey -> entity indices into the last build() input */
  private buckets = new Map<string, number[]>();
  private entities: EntitySnapshot[] = [];

  constructor(cell = 20) {
    if (cell <= 0) throw new Error('cell must be positive');
    this.cell = cell;
  }

  /** Bucket all entities once per snapshot tick. Reuses bucket arrays. */
  build(entities: EntitySnapshot[]): void {
    this.entities = entities;
    const cell = this.cell;
    // Clear arrays in place so repeated ticks don't churn the Map.
    for (const arr of this.buckets.values()) arr.length = 0;
    for (let i = 0; i < entities.length; i++) {
      const e = entities[i]!;
      const k = `${Math.floor(e.p.x / cell)},${Math.floor(e.p.y / cell)}`;
      let arr = this.buckets.get(k);
      if (!arr) {
        arr = [];
        this.buckets.set(k, arr);
      }
      arr.push(i);
    }
  }

  /**
   * Fill `outIdx` with the indices of the entities visible to a viewer at
   * (x, y). Self (selfId) is always included, matching filterInterest().
   *
   * Membership is identical to filterInterest(); only the ORDER differs (this
   * emits in cell-scan order, not ascending entity order). Nothing depends on
   * it: the client keys entities by id and `removed[]` order is likewise
   * order-independent. An earlier revision sorted the hits to restore
   * filterInterest()'s ordering, but that sort cost more than the linear scan
   * it replaced (measured: 6.2ms vs 2.7ms per tick at 300 players, see
   * docs/BENCHMARKS.md), so ordering is deliberately not preserved.
   *
   * Indices (not EntitySnapshots) are returned so callers can splice
   * pre-serialized JSON fragments — see SnapshotJson in index.ts.
   */
  collectIndices(
    x: number,
    y: number,
    selfId: number,
    outIdx: number[],
    radius: number = INTEREST_RADIUS,
  ): number[] {
    outIdx.length = 0;
    const entities = this.entities;
    if (entities.length === 0) return outIdx;
    const cell = this.cell;
    const buckets = this.buckets;
    const r2 = radius * radius;
    const x0 = Math.floor((x - radius) / cell);
    const x1 = Math.floor((x + radius) / cell);
    const y0 = Math.floor((y - radius) / cell);
    const y1 = Math.floor((y + radius) / cell);
    // Overlapping cells cannot contain the same entity, so no dedup is needed.
    for (let cx = x0; cx <= x1; cx++) {
      for (let cy = y0; cy <= y1; cy++) {
        const arr = buckets.get(`${cx},${cy}`);
        if (!arr) continue;
        for (let k = 0; k < arr.length; k++) {
          const i = arr[k]!;
          const e = entities[i]!;
          if (e.id === selfId) {
            outIdx.push(i);
            continue;
          }
          const dx = e.p.x - x;
          const dy = e.p.y - y;
          if (dx * dx + dy * dy <= r2) outIdx.push(i);
        }
      }
    }
    return outIdx;
  }

  /**
   * Entity-reference variant of collectIndices(). Kept for tests/tools that
   * want the visible set directly; the hot path uses collectIndices().
   */
  collect(
    x: number,
    y: number,
    selfId: number,
    out: EntitySnapshot[],
    radius: number = INTEREST_RADIUS,
  ): EntitySnapshot[] {
    out.length = 0;
    const idx = this.collectIndices(x, y, selfId, this.scratch, radius);
    const entities = this.entities;
    for (let k = 0; k < idx.length; k++) out.push(entities[idx[k]!]!);
    return out;
  }

  /** Scratch index buffer reused by collect() (the reference variant). */
  private scratch: number[] = [];
}
