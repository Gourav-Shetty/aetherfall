import { ChunkCache, daylightFactor } from './tiles.js';
import type { DrawEntity } from './types.js';
import type { FogLike, RenderOpts } from './fog.js';
import { hexToRgb } from './a11y.js';
import {
  TERR_LAVA,
  TERR_NONE,
  TERR_WATER,
  TERRAIN_CLIFF_SLOPE,
  zPixels,
  type TerrainView,
} from './terrain_view.js';

const TILE_PX_BASE = 32;
const ARENA = 100;
const FOG_RADIUS = 25;

/** Canvas fill colours for the terrain field (mirrors renderer3d palette). */
const GROUND_A = '#1d4a26';
const GROUND_B = '#1a4222';
const WATER_DEEP = '#12314f';
const WATER_SHALLOW = '#1d4f74';
const LAVA_DEEP = '#3a1408';
const LAVA_HOT = '#7a2a0c';
const CLIFF = '#39414c';
const SNOW = '#c9d6e4';

interface Particle { x: number; y: number; vx: number; vy: number; life: number; max: number; color: string; size: number; }
interface DmgNum { x: number; y: number; text: string; life: number; max: number; color: string; }
interface Telegraph { x: number; y: number; r: number; ttlMs: number; t0: number; label: string; }

export type { FogLike, RenderOpts };

const BODY: Record<string, string> = {
  player: '#ff9a4d', npc: '#4dc3ff', mob: '#ff5252', pickup: '#ffe066', projectile: '#ffffff',
};

/** Polished Canvas2D renderer: primary when WebGL is unavailable. */
export class CanvasRenderer {
  private ctx: CanvasRenderingContext2D;
  private tiles = new ChunkCache();
  private parts: Particle[] = [];
  private dmg: DmgNum[] = [];
  private tele: Telegraph[] = [];
  private maxParts = 400;
  private tilePx = TILE_PX_BASE;
  /** Decaying screen-shake offset in px, see shake(). */
  private shakeAmp = 0;
  private shakeX = 0;
  private shakeY = 0;
  private lastMs = 0;
  /** Terrain field (optional — flat arena when null). See terrain_view.ts. */
  private terrain: TerrainView | null = null;
  /**
   * a11y entity colours. Defaults mirror BODY (the shipped palette);
   * setEntityColors() replaces them with a colourblind-safe preset.
   * Bodies are drawn fresh every frame, so a change applies immediately.
   */
  private bodyColors: Record<string, string> = { ...BODY };
  /** Telegraph ring colours as `r,g,b` triples for rgba() composition. */
  private teleFill = '255,40,40';
  private teleRing = '255,60,60';

  constructor(private canvas: HTMLCanvasElement, terrain: TerrainView | null = null) {
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('2d context unavailable');
    this.ctx = ctx;
    this.terrain = terrain;
  }

  /** Attach (or detach) the terrain field. Cheap: no state to rebuild. */
  setTerrain(terrain: TerrainView | null): void {
    this.terrain = terrain;
  }

  /** Quality/perf hook: cap live particles (100..400). */
  setParticleCap(n: number) {
    this.maxParts = Math.max(0, Math.min(800, Math.floor(n)));
    if (this.parts.length > this.maxParts) this.parts.splice(0, this.parts.length - this.maxParts);
  }

  /**
   * a11y: colourblind-safe entity colours (see PALETTES in a11y.ts). Only
   * valid `#rrggbb` values replace a kind; garbage is ignored per entry so
   * one bad value cannot blank the whole world.
   */
  setEntityColors(map: Record<string, string>): void {
    for (const [kind, css] of Object.entries(map)) {
      if (typeof css === 'string' && hexToRgb(css)) this.bodyColors[kind] = css;
    }
  }

  /** Current body colour for a snapshot kind (tests + palette sync). */
  entityColor(kind: string): string {
    return this.bodyColors[kind] ?? '#ccc';
  }

  /**
   * a11y: telegraph ring colour as `#rrggbb`. Garbage keeps the current
   * colour (default shipped red) instead of throwing mid-frame.
   */
  setTelegraphColor(hex: string): void {
    const rgb = typeof hex === 'string' ? hexToRgb(hex) : null;
    if (!rgb) return;
    const triple = rgb.join(',');
    this.teleFill = triple;
    this.teleRing = triple;
  }

  /** Current telegraph colours as `r,g,b` triples (tests). */
  telegraphColors(): { fill: string; ring: string } {
    return { fill: this.teleFill, ring: this.teleRing };
  }

  /**
   * World -> screen pixels (the inverse of `screenToWorld`). Used by DOM
   * overlays that must track entities — the emote bubbles — so they line
   * up with the canvas without duplicating the camera maths. Mirrors render()'s
   * toSx/toSy including the live shake offset, then divides by the DPR ratio so
   * the result is in CSS pixels (what `style.left` expects).
   */
  worldToScreen(x: number, y: number, camX: number, camY: number): { sx: number; sy: number } {
    const dpr = this.canvas.width > 0 ? this.canvas.width / Math.max(1, this.canvas.clientWidth || 1) : 1;
    const sx = ((x - camX) * this.tilePx + this.canvas.width / 2 + this.shakeX) / dpr;
    const sy = ((y - camY) * this.tilePx + this.canvas.height / 2 + this.shakeY) / dpr;
    return { sx, sy };
  }

  /** Render-distance hook: view 15..50 maps to tile size 64..~19px. */
  setViewDistance(v: number) {
    const clamped = Math.max(15, Math.min(50, v));
    this.tilePx = TILE_PX_BASE * (30 / clamped);
  }

  fitToContainer() {
    try {
      const parent = this.canvas.parentElement;
      const w = parent?.clientWidth || 960;
      const h = parent?.clientHeight || 600;
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const bw = Math.floor(w * dpr);
      const bh = Math.floor(h * dpr);
      if (this.canvas.width !== bw || this.canvas.height !== bh) {
        this.canvas.width = bw;
        this.canvas.height = bh;
      }
    } catch {
      /* ignore */
    }
  }

  burst(x: number, y: number, color: string, n = 10) {
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2, sp = 2 + Math.random() * 5;
      this.parts.push({ x, y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, life: 0.5, max: 0.5, color, size: 2 + Math.random() * 3 });
    }
    if (this.parts.length > this.maxParts) this.parts.splice(0, this.parts.length - this.maxParts);
  }

  damage(x: number, y: number, text: string, color = '#ff6b6b') {
    this.dmg.push({ x, y: y - 1, text, life: 0.9, max: 0.9, color });
    if (this.dmg.length > 40) this.dmg.shift();
  }

  /**
   * Boss telegraph ring (`event/telegraph` from server/src/ai/npc.ts).
   * Drawn as an expanding red circle over ttlMs, then flashed once.
   * `label` is carried for debugging; rendering is label-agnostic.
   */
  telegraph(x: number, y: number, r: number, ttlMs: number, label = '') {
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(r) || r <= 0) return;
    if (!Number.isFinite(ttlMs) || ttlMs <= 0) return;
    this.tele.push({ x, y, r: Math.min(30, r), ttlMs: Math.min(5000, Math.round(ttlMs)), t0: performance.now(), label });
    if (this.tele.length > 12) this.tele.splice(0, this.tele.length - 12);
  }

  /**
   * Screen shake (damage taken, boss slam landing). `strength` is roughly
   * "pixels of offset at full amplitude"; decays with a ~350ms time constant.
   */
  shake(strength = 8) {
    this.shakeAmp = Math.min(26, this.shakeAmp + Math.max(0, strength));
  }

  screenToWorld(sx: number, sy: number, camX: number, camY: number): { x: number; y: number } {
    const r = this.canvas.getBoundingClientRect();
    return {
      x: camX + (sx - r.left - r.width / 2) / this.tilePx,
      y: camY + (sy - r.top - r.height / 2) / this.tilePx,
    };
  }

  render(ents: DrawEntity[], camX: number, camY: number, timeMs: number, editorWalls?: Set<string>, opts?: RenderOpts) {
    const { ctx, canvas } = this;
    const TILE_PX = this.tilePx;
    const W = canvas.width, H = canvas.height;

    // Screen-shake decay (frame delta derived from the render timestamp).
    const dtShake = this.lastMs ? Math.min(0.1, (timeMs - this.lastMs) / 1000) : 0.016;
    this.lastMs = timeMs;
    if (this.shakeAmp > 0.05) {
      this.shakeX = (Math.random() * 2 - 1) * this.shakeAmp;
      this.shakeY = (Math.random() * 2 - 1) * this.shakeAmp * 0.7;
      this.shakeAmp *= Math.exp(-dtShake * 9);
    } else {
      this.shakeAmp = 0;
      this.shakeX = 0;
      this.shakeY = 0;
    }

    const toSx = (wx: number) => (wx - camX) * TILE_PX + W / 2 + this.shakeX;
    const toSy = (wy: number) => (wy - camY) * TILE_PX + H / 2 + this.shakeY;

    ctx.fillStyle = '#0b0e14';
    ctx.fillRect(0, 0, W, H);

    // Tiles from genChunk-mirror view window.
    const x0 = Math.floor(camX - W / 2 / TILE_PX) - 1, x1 = Math.ceil(camX + W / 2 / TILE_PX) + 1;
    const y0 = Math.floor(camY - H / 2 / TILE_PX) - 1, y1 = Math.ceil(camY + H / 2 / TILE_PX) + 1;
    const tv = this.terrain;
    for (let ty = y0; ty <= y1; ty++) {
      for (let tx = x0; tx <= x1; tx++) {
        const sx = toSx(tx), sy = toSy(ty);
        if (tx < 0 || ty < 0 || tx >= ARENA || ty >= ARENA) {
          ctx.fillStyle = '#05070b';
          ctx.fillRect(sx, sy, TILE_PX + 1, TILE_PX + 1);
          continue;
        }
        // TERRAIN: hazard and slope decide the fill; elevation only matters
        // through them (2D is top-down), so the pass stays one rect per tile.
        let kind = TERR_NONE;
        let slope = 0;
        let height = 0;
        if (tv !== null) {
          kind = tv.kindAtTile(tx, ty);
          slope = tv.slopeFromGrid(tx, ty);
          height = tv.heightAtTile(tx, ty);
        }
        if (kind === TERR_WATER) {
          // Deeper water is darker: use elevation below the water line.
          const deep = Math.max(0, Math.min(1, -height / 12));
          ctx.fillStyle = deep > 0.5 ? WATER_DEEP : WATER_SHALLOW;
          ctx.fillRect(sx, sy, TILE_PX + 1, TILE_PX + 1);
          ctx.fillStyle = 'rgba(140,200,255,0.22)';
          ctx.fillRect(sx, sy, TILE_PX + 1, Math.max(1, TILE_PX * 0.12));
        } else if (kind === TERR_LAVA) {
          ctx.fillStyle = LAVA_HOT;
          ctx.fillRect(sx, sy, TILE_PX + 1, TILE_PX + 1);
          ctx.fillStyle = LAVA_DEEP;
          ctx.fillRect(sx, sy + TILE_PX * 0.6, TILE_PX + 1, TILE_PX * 0.4 + 1);
        } else {
          const t = this.tiles.tile(tx, ty);
          if (t === 1) {
            ctx.fillStyle = '#3d4350';
            ctx.fillRect(sx, sy, TILE_PX + 1, TILE_PX + 1);
            ctx.fillStyle = '#565e70';
            ctx.fillRect(sx, sy, TILE_PX + 1, 6);
          } else {
            ctx.fillStyle = (tx + ty) % 2 === 0 ? GROUND_A : GROUND_B;
            ctx.fillRect(sx, sy, TILE_PX + 1, TILE_PX + 1);
            if (tv !== null) {
              // Cliffs read as rock, high ground as snow — the same cues the
              // 3D renderer gets from slope/elevation.
              if (slope > TERRAIN_CLIFF_SLOPE) {
                ctx.fillStyle = CLIFF;
                ctx.fillRect(sx, sy, TILE_PX + 1, TILE_PX + 1);
              } else if (height > 24) {
                ctx.fillStyle = SNOW;
                ctx.fillRect(sx, sy, TILE_PX + 1, TILE_PX + 1);
              }
            }
          }
        }
        if (editorWalls?.has(tx + ',' + ty)) {
          ctx.fillStyle = 'rgba(178,102,255,0.55)';
          ctx.fillRect(sx, sy, TILE_PX + 1, TILE_PX + 1);
        }
      }
    }

    // Entities sorted by y (painter's order).
    const fog = opts?.fog ?? null;
    const fpx = opts?.playerX;
    const fpy = opts?.playerY;
    const fogOn = !!fog && typeof fpx === 'number' && typeof fpy === 'number';
    const sorted = [...ents].sort((a, b) => a.y - b.y);
    ctx.textAlign = 'center';
    for (const e of sorted) {
      // Fog-of-war hides entities standing in never-explored ground.
      if (fogOn && !e.isLocal) {
        if (Math.hypot(e.x - fpx!, e.y - fpy!) > FOG_RADIUS && !fog!.isExploredWorld(e.x, e.y)) continue;
      }
      // TERRAIN: lift the sprite by the ground elevation (server `z` when
      // present, else the local sample) and keep the shadow on the floor.
      const worldZ = typeof e.z === 'number' && Number.isFinite(e.z)
        ? e.z
        : tv !== null ? tv.tileHeightAt(e.x, e.y) : 0;
      const lift = zPixels(worldZ);
      const sx = toSx(e.x), sy = toSy(e.y) - lift;
      if (sx < -40 || sy < -40 || sx > W + 40 || sy > H + 40) continue;
      const color = e.isLocal ? '#59d98c' : this.entityColor(e.kind);
      // shadow — always on the tile the body stands on, never lifted
      ctx.fillStyle = 'rgba(0,0,0,0.35)';
      ctx.beginPath(); ctx.ellipse(toSx(e.x), toSy(e.y) + 12, 11, 4.5, 0, 0, Math.PI * 2); ctx.fill();
      if (e.kind === 'pickup') {
        ctx.fillStyle = color;
        ctx.save(); ctx.translate(sx, sy); ctx.rotate(Math.PI / 4);
        ctx.fillRect(-7, -7, 14, 14); ctx.restore();
      } else if (e.kind === 'projectile') {
        ctx.fillStyle = color;
        ctx.beginPath(); ctx.arc(sx, sy, 4, 0, Math.PI * 2); ctx.fill();
      } else {
        const bob = Math.sin(timeMs / 300 + e.id) * 1.5;
        ctx.fillStyle = color;
        ctx.beginPath(); ctx.roundRect(sx - 10, sy - 14 + bob, 20, 26, 5); ctx.fill();
        if (e.isLocal) { ctx.strokeStyle = '#fff'; ctx.lineWidth = 2; ctx.stroke(); }
        // eyes
        ctx.fillStyle = '#101418';
        ctx.fillRect(sx - 6, sy - 6 + bob, 4, 5);
        ctx.fillRect(sx + 2, sy - 6 + bob, 4, 5);
      }
      // health bar
      if (e.kind !== 'pickup' && e.kind !== 'projectile') {
        const frac = e.maxHp > 0 ? Math.max(0, e.hp / e.maxHp) : 0;
        ctx.fillStyle = '#141a24';
        ctx.fillRect(sx - 15, sy - 24, 30, 5);
        ctx.fillStyle = frac > 0.5 ? '#51ff7a' : frac > 0.25 ? '#ffb84d' : '#ff5252';
        ctx.fillRect(sx - 15, sy - 24, 30 * frac, 5);
        // name
        ctx.fillStyle = e.isLocal ? '#d6ffe2' : '#fff';
        ctx.font = '11px system-ui';
        ctx.fillText(e.name, sx, sy - 28);
      }
    }

    // Telegraph rings: expanding red circle over the windup, flash on expiry.
    const nowMs = performance.now();
    this.tele = this.tele.filter((t) => {
      if (nowMs - t.t0 >= t.ttlMs) {
        this.burst(t.x, t.y, '#ff4040', 10);
        return false;
      }
      return true;
    });
    for (const t of this.tele) {
      if (fogOn && Math.hypot(t.x - fpx!, t.y - fpy!) > FOG_RADIUS && !fog!.isExploredWorld(t.x, t.y)) continue;
      const frac = Math.max(0, Math.min(1, (nowMs - t.t0) / t.ttlMs));
      const rr = Math.max(0.05, t.r * (0.15 + 0.85 * frac)) * TILE_PX;
      const sx = toSx(t.x), sy = toSy(t.y);
      ctx.fillStyle = `rgba(${this.teleFill},${(0.06 + 0.16 * frac).toFixed(3)})`;
      ctx.beginPath(); ctx.arc(sx, sy, rr, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = `rgba(${this.teleRing},${(0.55 + 0.45 * frac).toFixed(3)})`;
      ctx.lineWidth = 1 + 2 * frac;
      ctx.beginPath(); ctx.arc(sx, sy, rr, 0, Math.PI * 2); ctx.stroke();
      ctx.lineWidth = 1;
    }

    // Particles (world space, ~60Hz decay).
    const dt = 1 / 60;
    this.parts = this.parts.filter((p) => (p.life -= dt) > 0);
    for (const p of this.parts) {
      p.x += p.vx * dt; p.y += p.vy * dt; p.vx *= 0.96; p.vy *= 0.96;
      ctx.globalAlpha = Math.max(0, p.life / p.max);
      ctx.fillStyle = p.color;
      ctx.fillRect(toSx(p.x) - p.size / 2, toSy(p.y) - p.size / 2, p.size, p.size);
    }
    ctx.globalAlpha = 1;

    // Damage numbers (float up).
    this.dmg = this.dmg.filter((d) => (d.life -= dt) > 0);
    ctx.font = 'bold 13px system-ui';
    for (const d of this.dmg) {
      const f = 1 - d.life / d.max;
      ctx.globalAlpha = Math.max(0, d.life / d.max);
      ctx.fillStyle = d.color;
      ctx.fillText(d.text, toSx(d.x), toSy(d.y) - f * 26);
    }
    ctx.globalAlpha = 1;

    // Day/night lerp overlay.
    const f = daylightFactor(timeMs / 1000);
    if (f < 1) {
      ctx.fillStyle = `rgba(8,10,38,${((1 - f) * 0.45).toFixed(3)})`;
      ctx.fillRect(0, 0, W, H);
    }

    // Fog-of-war: dim world beyond FOG_RADIUS from the local player.
    // Explored chunks stay dim; never-seen chunks go near-black.
    if (fogOn) {
      for (let ty = y0; ty <= y1; ty++) {
        for (let tx = x0; tx <= x1; tx++) {
          if (tx < 0 || ty < 0 || tx >= ARENA || ty >= ARENA) continue;
          const wx = tx + 0.5, wy = ty + 0.5;
          if (Math.hypot(wx - fpx!, wy - fpy!) <= FOG_RADIUS) continue;
          ctx.fillStyle = fog!.isExploredWorld(wx, wy)
            ? 'rgba(4,6,12,0.45)'
            : 'rgba(2,3,6,0.80)';
          ctx.fillRect(toSx(tx), toSy(ty), TILE_PX + 1, TILE_PX + 1);
        }
      }
    }
  }
}
