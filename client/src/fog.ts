// AETHERFALL client — fog-of-war.
//
// Dims the world beyond FOG_RADIUS (25m) from the local player. Chunks the
// player has ever seen stay "explored" (dim) instead of black; explored
// chunks persist in sessionStorage so a reload keeps the map learned.

export const FOG_RADIUS = 25;
export const FOG_CHUNK = 8;
const FOG_KEY = 'af_fog_v1';
const MAX_CHUNKS = 4000;

export function fogChunkKey(x: number, y: number): string {
  return Math.floor(x / FOG_CHUNK) + ',' + Math.floor(y / FOG_CHUNK);
}

/**
 * Minimal surface both renderers + the HUD minimap need. Structural type so
 * fog.ts stays the only place that owns sessionStorage persistence.
 */
export interface FogLike {
  isExploredWorld(x: number, y: number): boolean;
  isExploredChunk(cx: number, cy: number): boolean;
}

/** Per-frame fog context handed to the renderers + HUD minimap. */
export interface RenderOpts {
  /** Local player world position (fog centre). */
  playerX?: number;
  playerY?: number;
  /** Explored-chunk store, or null to disable fog-of-war entirely. */
  fog?: FogLike | null;
}

export class FogOfWar {
  explored = new Set<string>();
  private saveT = 0;

  constructor() {
    this.load();
  }

  private load(): void {
    try {
      const raw = sessionStorage.getItem(FOG_KEY);
      if (!raw) return;
      const arr = JSON.parse(raw) as unknown;
      if (!Array.isArray(arr)) return;
      for (const k of arr) {
        if (typeof k === 'string' && /^-?\d+,-?\d+$/.test(k)) this.explored.add(k);
        if (this.explored.size >= MAX_CHUNKS) break;
      }
    } catch {
      /* storage unavailable — play without persistence */
    }
  }

  private save(): void {
    try {
      sessionStorage.setItem(FOG_KEY, JSON.stringify([...this.explored].slice(-MAX_CHUNKS)));
    } catch {
      /* ignore quota/private-mode errors */
    }
  }

  private saveThrottled(): void {
    const now = Date.now();
    if (now - this.saveT < 2000) return;
    this.saveT = now;
    this.save();
  }

  /**
   * Write explored chunks immediately, bypassing the 2s throttle. Call on
   * pagehide/visibilitychange so the last few chunks before a reload are not
   * lost (see `installFogPersistence`).
   */
  flush(): void {
    this.saveT = Date.now();
    this.save();
  }

  /**
   * Mark every chunk within r of (x, y) explored.
   * Returns the number of chunks that were newly explored (0 when nothing
   * changed) — main.ts feeds that to the 'explore' chain quest.
   */
  markAround(x: number, y: number, r: number = FOG_RADIUS): number {
    let grown = 0;
    const x0 = Math.floor((x - r) / FOG_CHUNK);
    const x1 = Math.floor((x + r) / FOG_CHUNK);
    const y0 = Math.floor((y - r) / FOG_CHUNK);
    const y1 = Math.floor((y + r) / FOG_CHUNK);
    for (let cy = y0; cy <= y1; cy++) {
      for (let cx = x0; cx <= x1; cx++) {
        // Chunk center must be inside the radius (cheap, no per-tile work).
        const wx = (cx + 0.5) * FOG_CHUNK;
        const wy = (cy + 0.5) * FOG_CHUNK;
        if (Math.hypot(wx - x, wy - y) > r + FOG_CHUNK * 0.75) continue;
        const k = cx + ',' + cy;
        if (!this.explored.has(k)) {
          this.explored.add(k);
          grown++;
        }
      }
    }
    // Cap memory: drop oldest (insertion-ordered) chunks first.
    while (this.explored.size > MAX_CHUNKS) {
      const first = this.explored.values().next().value as string | undefined;
      if (first === undefined) break;
      this.explored.delete(first);
    }
    if (grown > 0) this.saveThrottled();
    return grown;
  }

  isExploredChunk(cx: number, cy: number): boolean {
    return this.explored.has(cx + ',' + cy);
  }

  isExploredWorld(x: number, y: number): boolean {
    return this.explored.has(fogChunkKey(x, y));
  }

  exploredCount(): number {
    return this.explored.size;
  }
}

/**
 * Flush explored chunks when the tab is hidden or closed, so the 2s save
 * throttle never drops the last few chunks. Idempotent + safe in node.
 */
export function installFogPersistence(fog: FogOfWar): void {
  try {
    if (typeof window === 'undefined') return;
    window.addEventListener('pagehide', () => fog.flush());
    window.addEventListener('beforeunload', () => fog.flush());
    document?.addEventListener?.('visibilitychange', () => {
      if (document.visibilityState === 'hidden') fog.flush();
    });
  } catch {
    /* ignore */
  }
}
