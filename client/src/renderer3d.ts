import * as THREE from 'three';
import { ChunkCache, daylightFactor, mulberry32 } from './tiles.js';
import type { DrawEntity } from './types.js';
import {
  TERR_LAVA,
  TERR_NONE,
  TERR_WATER,
  TERRAIN_CLIFF_SLOPE,
  TERRAIN_LAVA_LEVEL,
  TERRAIN_WATER_LEVEL,
  TERRAIN_Z_SCALE,
  zVisual,
  type TerrainView,
} from './terrain_view.js';

const ARENA = 100;
const ISO_OFF = 30;

const BODY_COLORS: Record<string, number> = {
  player: 0xff9a4d, npc: 0x4dc3ff, mob: 0xff5252, pickup: 0xffe066, projectile: 0xffffff,
};

/** Landmark pillar colour per kind (see engine LANDMARK_KINDS). */
const LANDMARK_COLORS: Record<string, number> = {
  ruin: 0x9a9384,
  camp: 0xc9a15a,
  obelisk: 0xa07ce0,
};

/** Rock grey for anything too steep to walk. */
const CLIFF_COLOR = 0x6b6f78;
/** Snow tint applied at the top of the elevation range. */
const SNOW_COLOR = 0xe8f0ff;

/** Palette used to tint water / lava ground tiles and their surfaces. */
const HAZARD_GROUND: Record<number, number> = {
  [TERR_WATER]: 0x14395c,
  [TERR_LAVA]: 0x3a1b12,
};
const HAZARD_SURFACE: Record<number, number> = {
  [TERR_WATER]: 0x2f7fc4,
  [TERR_LAVA]: 0xff5a1e,
};

interface Body {
  g: THREE.Group;
  fg: THREE.Sprite;
  mat: THREE.MeshLambertMaterial;
  baseColor: number;
  isLocal: boolean;
  /** Snapshot kind, so a palette switch can re-tint live bodies. */
  kind: string;
}
interface Flash { m: THREE.Mesh<THREE.RingGeometry, THREE.MeshBasicMaterial>; life: number; max: number; }
interface TeleRing { g: THREE.Group; x: number; y: number; r: number; t0: number; ttl: number; }

const FOG_RADIUS = 25;

/** Dim multipliers for the fog-of-war tiers (see fog.ts). */
const FOG_LIT = 1;
const FOG_MEMORY = 0.5;
const FOG_UNKNOWN = 0.14;

/** Minimal fog surface consumed by the renderer (see fog.ts FogLike). */
export interface FogLike {
  isExploredWorld(x: number, y: number): boolean;
}

/**
 * Isometric 2.5D renderer (Three.js, orthographic dimetric camera).
 *
 * Terrain is 4-5 draw calls (instanced ground + instanced walls + instanced
 * water + instanced lava + instanced landmark pillars, the last hidden when
 * empty); avatars are a handful of meshes. Returns null from tryCreate when
 * WebGL is missing.
 *
 * With a TerrainView attached (the normal path, see main.ts) every ground tile
 * is lifted to its `heightAt()` elevation, tilted along its gradient, tinted by
 * elevation / slope / hazard, and every avatar stands at the ground height of
 * the tile under it — so the server's authoritative elevation is what the
 * player sees. The renderer still works (flat arena) without one.
 */
export class IsoRenderer {
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera: THREE.OrthographicCamera;
  private sun: THREE.DirectionalLight;
  private amb: THREE.AmbientLight;
  private hemi: THREE.HemisphereLight;
  private bg = new THREE.Color(0x0b1026);
  private night = new THREE.Color(0x0b1026);
  private day = new THREE.Color(0x87b5e0);
  private bodies = new Map<number, Body>();
  private flashes: Flash[] = [];
  private tele: TeleRing[] = [];
  private target = new THREE.Vector3(50, 0, 50);
  private lastMs = 0;
  private viewDist = 30;
  private maxFlashes = 60;
  private onResize = () => this.resize();
  // ---- fog-of-war state (see fog.ts) ----
  private fog: FogLike | null = null;
  private fogX = 50;
  private fogY = 50;
  /** Cached fog tier per ground instance (-1 = dirty). Bumped on setFog. */
  private groundTier: Int8Array = new Int8Array(ARENA * ARENA).fill(-1);
  private ground!: THREE.InstancedMesh;
  private wall!: THREE.InstancedMesh;
  private wallPos: Array<[number, number]> = [];
  /** Un-fogged ground RGB per tile (3 floats each) so tinting is reversible. */
  private baseGround = new Float32Array(ARENA * ARENA * 3);
  /** Instanced hazard surfaces (1 draw call each) + their per-instance RGB. */
  private water: THREE.InstancedMesh | null = null;
  private lava: THREE.InstancedMesh | null = null;
  private waterPos: Array<[number, number, number]> = [];
  private lavaPos: Array<[number, number, number]> = [];
  private waterBase = new Float32Array(ARENA * ARENA * 3);
  private lavaBase = new Float32Array(ARENA * ARENA * 3);
  /** Landmark pillars; `null` when nothing is in range (no draw call). */
  private landmarks: THREE.InstancedMesh | null = null;
  /** Terrain field (optional — flat arena when null). */
  private terrain: TerrainView | null = null;
  /** Smoothed visual elevation of the ground under the camera. */
  private groundY = 0;
  private lastFogApply = 0;
  /** Decaying screen-shake amplitude (0 = idle), see shake(). */
  private shakeAmp = 0;
  /**
   * a11y entity colours. Defaults mirror BODY_COLORS (the shipped palette);
   * setEntityColors() replaces them with a colourblind-safe preset and
   * re-tints live bodies of the same kinds (the fog pass re-applies
   * baseColor every frame, so the change shows on the next update).
   */
  private bodyColors: Record<string, number> = { ...BODY_COLORS };
  /** Telegraph ring + disc colours (override via setTelegraphColor). */
  private teleRing = 0xff3b3b;
  private teleDisc = 0xff2828;

  private constructor(private container: HTMLElement, renderer: THREE.WebGLRenderer) {
    this.renderer = renderer;
    const w = container.clientWidth || 960, h = container.clientHeight || 600;
    const view = this.viewDist, aspect = w / h;
    this.camera = new THREE.OrthographicCamera((-view * aspect) / 2, (view * aspect) / 2, view / 2, -view / 2, 0.1, 300);
    this.sun = new THREE.DirectionalLight(0xfff2d9, 1.2);
    this.sun.position.set(40, 60, 20);
    this.amb = new THREE.AmbientLight(0xffffff, 0.7);
    this.hemi = new THREE.HemisphereLight(0xbdd7ff, 0x3a5f3a, 0.4);
    this.scene.add(this.sun, this.amb, this.hemi);
    this.scene.background = this.bg;
    // Atmospheric distance haze for far geometry (fog-of-war terrain tinting
    // is a separate, exact per-chunk pass — see setFog()/applyFog()).
    this.scene.fog = new THREE.Fog(0x0b1026, 55, 90);
    this.buildTerrain();
    this.resize();
    window.addEventListener('resize', this.onResize);
    const el = renderer.domElement;
    el.style.position = 'absolute'; el.style.inset = '0';
    el.style.width = '100%'; el.style.height = '100%';
  }

  static tryCreate(container: HTMLElement, terrain: TerrainView | null = null): IsoRenderer | null {
    try {
      const probe = document.createElement('canvas');
      if (!probe.getContext('webgl2') && !probe.getContext('webgl')) return null;
      const renderer = new THREE.WebGLRenderer({ antialias: true });
      renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
      container.appendChild(renderer.domElement);
      const iso = new IsoRenderer(container, renderer);
      if (terrain !== null) iso.setTerrain(terrain);
      return iso;
    } catch {
      return null;
    }
  }

  get element(): HTMLElement { return this.renderer.domElement; }

  /** Render-distance hook: ortho view size 15..50 (larger = more visible). */
  setViewDistance(v: number) {
    this.viewDist = Math.max(15, Math.min(50, v));
    this.resize();
  }

  /** Quality hook: pixel-ratio cap + flash-particle cap. */
  setQuality(pixelRatioCap: number, maxFlashes: number) {
    this.maxFlashes = Math.max(0, Math.min(200, Math.floor(maxFlashes)));
    try {
      this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, pixelRatioCap));
    } catch {
      /* ignore */
    }
  }

  /** Remove the WebGL canvas + free GPU resources (for Canvas2D fallback). */
  dispose() {
    try {
      window.removeEventListener('resize', this.onResize);
      this.scene.traverse((o) => {
        const mesh = o as THREE.Mesh;
        if (mesh.isMesh) {
          mesh.geometry?.dispose?.();
          const m = mesh.material as THREE.Material | THREE.Material[] | undefined;
          if (Array.isArray(m)) m.forEach((x) => x.dispose());
          else m?.dispose();
        }
      });
      this.renderer.dispose();
      this.renderer.domElement.remove();
    } catch {
      /* ignore */
    }
  }

  resize() {
    const w = this.container.clientWidth || 960, h = this.container.clientHeight || 600;
    const view = this.viewDist, aspect = w / h;
    this.camera.left = (-view * aspect) / 2; this.camera.right = (view * aspect) / 2;
    this.camera.top = view / 2; this.camera.bottom = -view / 2;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h, false);
  }

  /**
   * Attach the terrain field, rebuilding the ground / wall / hazard instances
   * so the scene picks up elevation, slope and water/lava. Called from
   * tryCreate(); calling it twice with the same view is a no-op.
   */
  setTerrain(terrain: TerrainView | null): void {
    if (terrain === this.terrain) return;
    this.terrain = terrain;
    this.buildTerrain();
  }

  /** Dispose the terrain-derived meshes before a rebuild. */
  private clearHazards(): void {
    for (const mesh of [this.water, this.lava, this.landmarks]) {
      if (!mesh) continue;
      this.scene.remove(mesh);
      mesh.geometry.dispose();
      const m = mesh.material as THREE.Material | undefined;
      m?.dispose();
    }
    this.water = null;
    this.lava = null;
    this.landmarks = null;
  }

  /**
   * Ground / wall / hazard geometry.
   *
   * With terrain: every tile is placed at `zVisual(heightAt)`, rotated so its
   * plane follows the local gradient, and coloured from elevation (snow line),
   * slope (cliff rock) and hazard. Hazard tiles additionally get an instanced
   * surface quad at the water or lava level — the only new draw calls, two in
   * total, so terrain stays at 4-5.
   */
  private buildTerrain() {
    this.clearHazards();
    const tiles = new ChunkCache();
    const rand = mulberry32(1337);
    const dummy = new THREE.Object3D();
    const up = new THREE.Vector3(0, 1, 0);
    const nrm = new THREE.Vector3();
    const flat = new THREE.Quaternion().setFromEuler(new THREE.Euler(-Math.PI / 2, 0, 0));
    const tv = this.terrain;
    const ground = new THREE.InstancedMesh(
      new THREE.PlaneGeometry(1, 1), new THREE.MeshLambertMaterial({ color: 0xffffff }), ARENA * ARENA);
    const wallPos: Array<[number, number, number]> = [];
    const waterPos: Array<[number, number, number]> = [];
    const lavaPos: Array<[number, number, number]> = [];
    const c = new THREE.Color();
    const snow = new THREE.Color(SNOW_COLOR);
    const cliff = new THREE.Color(CLIFF_COLOR);
    let gi = 0;
    for (let y = 0; y < ARENA; y++) {
      for (let x = 0; x < ARENA; x++) {
        const t = tiles.tile(x, y);
        let gz = 0;
        let slope = 0;
        let gx = 0;
        let gy = 0;
        let kind = TERR_NONE;
        let height = 0;
        if (tv !== null) {
          height = tv.heightAtTile(x, y);
          kind = tv.kindAtTile(x, y);
          gz = zVisual(height);
          slope = tv.slopeFromGrid(x, y);
          const g = tv.gradientFromGrid(x, y);
          gx = g.gx;
          gy = g.gy;
        }
        dummy.position.set(x + 0.5, gz, y + 0.5);
        if (tv !== null && slope > 0.02) {
          // Align the quad with the terrain normal (-dh/dx, 1, -dh/dy).
          nrm.set(-gx, 1, -gy).normalize();
          dummy.quaternion.setFromUnitVectors(up, nrm).multiply(flat);
        } else {
          dummy.quaternion.copy(flat);
        }
        dummy.updateMatrix();
        ground.setMatrixAt(gi, dummy.matrix);
        if (kind !== TERR_NONE) {
          // Hazard floor: dark bed so the surface quad reads as depth.
          c.set(HAZARD_GROUND[kind] ?? 0x101010).offsetHSL(0, 0, (rand() - 0.5) * 0.03);
          (kind === TERR_WATER ? waterPos : lavaPos).push([x, y, gz]);
        } else if (t === 1) {
          c.set(CLIFF_COLOR).offsetHSL(0, 0, (rand() - 0.5) * 0.06);
        } else {
          c.set((x + y) % 2 === 0 ? 0x4a8f4d : 0x439047).offsetHSL(0, 0, (rand() - 0.5) * 0.05);
          if (tv !== null) {
            // Steep ground reads as rock, high ground as snow.
            if (slope > TERRAIN_CLIFF_SLOPE) c.lerp(cliff, Math.min(1, (slope - TERRAIN_CLIFF_SLOPE) / 2));
            const alt = Math.max(0, Math.min(1, (height - 18) / 22));
            if (alt > 0) c.lerp(snow, alt * 0.8);
          }
        }
        ground.setColorAt(gi, c);
        const b = gi * 3;
        this.baseGround[b] = c.r; this.baseGround[b + 1] = c.g; this.baseGround[b + 2] = c.b;
        gi++;
        if (t === 1) wallPos.push([x, y, gz]);
      }
    }
    ground.instanceMatrix.needsUpdate = true;
    if (ground.instanceColor) ground.instanceColor.needsUpdate = true;
    this.scene.add(ground);
    this.ground = ground;

    const walls = new THREE.InstancedMesh(
      new THREE.BoxGeometry(1, 1, 1), new THREE.MeshLambertMaterial({ color: 0x8b93a3 }), Math.max(1, wallPos.length));
    const d2 = new THREE.Object3D();
    wallPos.forEach(([x, y, gz], i) => {
      // Walls ride the terrain height so a cliff edge still lines up.
      d2.position.set(x + 0.5, gz + 0.5, y + 0.5);
      d2.rotation.set(0, 0, 0);
      d2.updateMatrix();
      walls.setMatrixAt(i, d2.matrix);
      // Per-instance color so fog can dim walls like the ground.
      walls.setColorAt(i, c.setHex(0x8b93a3));
    });
    walls.instanceMatrix.needsUpdate = true;
    if (walls.instanceColor) walls.instanceColor.needsUpdate = true;
    walls.count = wallPos.length;
    this.scene.add(walls);
    this.wall = walls;
    this.wallPos = wallPos.map(([x, y]) => [x, y] as [number, number]);

    this.water = this.buildHazardSurface(waterPos, this.waterBase, TERR_WATER, 0.74);
    this.waterPos = waterPos;
    this.lava = this.buildHazardSurface(lavaPos, this.lavaBase, TERR_LAVA, 1);
    this.lavaPos = lavaPos;
    if (tv !== null) this.buildLandmarks();
    // A rebuild invalidates every cached fog tier.
    this.groundTier.fill(-1);
  }

  /**
   * One instanced quad layer for a hazard kind, laid flat at that hazard's
   * surface height (water at WATER_LEVEL, lava at LAVA_LEVEL). Water is
   * translucent so the dark floor below shows through; lava is opaque.
   * Returns null when the arena has no tile of that kind.
   */
  private buildHazardSurface(
    pos: Array<[number, number, number]>,
    base: Float32Array,
    kind: number,
    opacity: number,
  ): THREE.InstancedMesh | null {
    if (pos.length === 0) return null;
    const surfaceY = zVisual(kind === TERR_WATER ? TERRAIN_WATER_LEVEL : TERRAIN_LAVA_LEVEL);
    const mat = kind === TERR_WATER
      ? new THREE.MeshLambertMaterial({ color: 0xffffff, transparent: true, opacity, depthWrite: false })
      : new THREE.MeshLambertMaterial({ color: 0xffffff });
    const mesh = new THREE.InstancedMesh(new THREE.PlaneGeometry(1, 1), mat, pos.length);
    const d = new THREE.Object3D();
    d.rotation.set(-Math.PI / 2, 0, 0);
    const c = new THREE.Color();
    for (let i = 0; i < pos.length; i++) {
      const p = pos[i]!;
      d.position.set(p[0] + 0.5, surfaceY, p[1] + 0.5);
      d.updateMatrix();
      mesh.setMatrixAt(i, d.matrix);
      c.set(HAZARD_SURFACE[kind] ?? 0xff00ff).offsetHSL(0, 0, (i % 5) * 0.012 - 0.024);
      mesh.setColorAt(i, c);
      const b = i * 3;
      base[b] = c.r; base[b + 1] = c.g; base[b + 2] = c.b;
    }
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    // Quads tile the surface, so they must not z-fight each other.
    mesh.renderOrder = kind === TERR_LAVA ? 2 : 1;
    this.scene.add(mesh);
    return mesh;
  }

  /**
   * Landmark pillars, one instanced mesh, sized by footprint radius and
   * coloured per kind. Skipped entirely when nothing is in range: at seed 1337
   * the 100x100 arena covers landmark cell (0,0), which is empty, so this
   * costs no draw call until a bigger arena or another seed puts one in view.
   */
  private buildLandmarks(): void {
    const tv = this.terrain;
    if (tv === null) return;
    const found = tv.landmarksNear(ARENA / 2, ARENA / 2, ARENA);
    if (found.length === 0) return;
    const mesh = new THREE.InstancedMesh(
      new THREE.BoxGeometry(1, 1, 1),
      new THREE.MeshLambertMaterial({ color: 0xffffff }),
      found.length,
    );
    const d = new THREE.Object3D();
    const c = new THREE.Color();
    found.forEach((lm, i) => {
      const z = zVisual(tv.heightAtTile(lm.x, lm.y));
      const h = lm.kind === 'obelisk' ? 3.4 : lm.kind === 'ruin' ? 1.8 : 1.1;
      const r = Math.max(1.2, lm.radius * 0.5);
      d.position.set(lm.x + 0.5, z + h / 2, lm.y + 0.5);
      d.rotation.set(0, 0, 0);
      d.scale.set(r, h, r);
      d.updateMatrix();
      mesh.setMatrixAt(i, d.matrix);
      mesh.setColorAt(i, c.setHex(LANDMARK_COLORS[lm.kind] ?? 0xcccccc));
    });
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    this.scene.add(mesh);
    this.landmarks = mesh;
  }

  /**
   * Fog-of-war hook. Pass `null` to disable. Called every frame from main.ts;
   * the expensive instanceColor rewrite is throttled to ~2Hz and skipped when
   * no tile tier changed (e.g. walking inside already-lit ground).
   */
  setFog(fog: FogLike | null, px: number, py: number) {
    this.fog = fog;
    this.fogX = px;
    this.fogY = py;
  }

  /** Fog tier for a world point: 0 lit (within radius), 1 remembered, 2 unknown. */
  private fogTierAt(wx: number, wy: number): number {
    const dx = wx - this.fogX, dy = wy - this.fogY;
    if (dx * dx + dy * dy <= FOG_RADIUS * FOG_RADIUS) return 0;
    if (this.fog && !this.fog.isExploredWorld(wx, wy)) return 2;
    return 1;
  }

  /**
   * Retint terrain/wall instances for fog-of-war. Runs at most every 500ms and
   * only rewrites an instance's color when its tier actually changed, so the
   * steady-state cost is a 10k tier scan (~0.1ms) a couple of times a second.
   */
  private applyFog(nowMs: number): void {
    const fog = this.fog;
    if (!fog) return;
    if (nowMs - this.lastFogApply < 500) return;
    this.lastFogApply = nowMs;
    const c = new THREE.Color();
    const dim = [FOG_LIT, FOG_MEMORY, FOG_UNKNOWN];
    const base = this.baseGround;
    for (let y = 0; y < ARENA; y++) {
      for (let x = 0; x < ARENA; x++) {
        const i = y * ARENA + x;
        const tier = this.fogTierAt(x + 0.5, y + 0.5);
        if (this.groundTier[i] === tier) continue;
        this.groundTier[i] = tier;
        const t = dim[tier]!;
        const b = i * 3;
        c.setRGB(base[b]!, base[b + 1]!, base[b + 2]!).multiplyScalar(t);
        this.ground.setColorAt(i, c);
        if (this.ground.instanceColor) this.ground.instanceColor.needsUpdate = true;
      }
    }
    for (let i = 0; i < this.wallPos.length; i++) {
      const [x, y] = this.wallPos[i]!;
      const tier = this.fogTierAt(x + 0.5, y + 0.5);
      c.setHex(0x8b93a3).multiplyScalar(dim[tier]!);
      this.wall.setColorAt(i, c);
    }
    if (this.wall.instanceColor) this.wall.instanceColor.needsUpdate = true;
    // Hazard surfaces dim with the same three tiers.
    this.applyFogToSurface(this.water, this.waterPos, this.waterBase, dim);
    this.applyFogToSurface(this.lava, this.lavaPos, this.lavaBase, dim);
  }

  /** Fog tint for one instanced hazard surface (no-op when absent). */
  private applyFogToSurface(
    mesh: THREE.InstancedMesh | null,
    pos: Array<[number, number, number]>,
    base: Float32Array,
    dim: number[],
  ): void {
    if (mesh === null) return;
    const c = new THREE.Color();
    for (let i = 0; i < pos.length; i++) {
      const p = pos[i]!;
      const tier = this.fogTierAt(p[0] + 0.5, p[1] + 0.5);
      const b = i * 3;
      c.setRGB(base[b]!, base[b + 1]!, base[b + 2]!).multiplyScalar(dim[tier]!);
      mesh.setColorAt(i, c);
    }
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  }

  private makeBody(e: DrawEntity): Body {
    const g = new THREE.Group();
    const baseColor = e.isLocal ? 0x59d98c : (this.bodyColors[e.kind] ?? 0xcccccc);
    const mat = new THREE.MeshLambertMaterial({ color: baseColor });
    if (e.isLocal) mat.emissive = new THREE.Color(0x0d3a1e);
    let h = 1.1;
    if (e.kind === 'pickup') h = 0.3;
    else if (e.kind === 'projectile') h = 0.25;
    const body = new THREE.Mesh(new THREE.BoxGeometry(e.kind === 'pickup' ? 0.5 : 0.8, h, e.kind === 'pickup' ? 0.5 : 0.8), mat);
    body.position.y = h / 2;
    g.add(body);
    if (e.kind !== 'pickup' && e.kind !== 'projectile') {
      const head = new THREE.Mesh(new THREE.BoxGeometry(0.45, 0.45, 0.45), new THREE.MeshLambertMaterial({ color: 0xf2c89b }));
      head.position.y = h + 0.25;
      g.add(head);
      const bg = new THREE.Sprite(new THREE.SpriteMaterial({ color: 0x1a1214, depthTest: false }));
      bg.scale.set(1.3, 0.16, 1);
      bg.position.y = h + 0.85;
      const fg = new THREE.Sprite(new THREE.SpriteMaterial({ color: 0x51ff7a, depthTest: false }));
      fg.center.set(0, 0.5);
      fg.scale.set(1.2, 0.12, 1);
      fg.position.set(-0.6, h + 0.85, 0);
      g.add(bg, fg);
      g.position.set(e.x, 0, e.y);
      this.scene.add(g);
      return { g, fg, mat, baseColor, isLocal: e.isLocal, kind: e.kind };
    }
    g.position.set(e.x, 0, e.y);
    this.scene.add(g);
    // Non-character entities share a dummy bar sprite (unused, zero scale).
    const fg = new THREE.Sprite(new THREE.SpriteMaterial({ color: 0x51ff7a }));
    fg.scale.set(0, 0, 1);
    return { g, fg, mat, baseColor, isLocal: e.isLocal, kind: e.kind };
  }

  /** Short-lived ring flash for attacks/hits (world x,y). Capped for perf. */
  flash(x: number, y: number, color = 0xffffff, z?: number) {
    if (this.flashes.length >= this.maxFlashes) {
      const old = this.flashes.shift();
      if (old) {
        this.scene.remove(old.m);
        old.m.geometry.dispose();
        (old.m.material as THREE.Material).dispose();
      }
    }
    const m = new THREE.Mesh(
      new THREE.RingGeometry(0.3, 0.7, 24),
      new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.9, side: THREE.DoubleSide, depthTest: false }));
    m.rotation.x = -Math.PI / 2;
    m.position.set(x, (z ?? this.terrain?.tileHeightAt(x, y) ?? 0) * TERRAIN_Z_SCALE + 0.1, y);
    this.scene.add(m);
    this.flashes.push({ m, life: 0.35, max: 0.35 });
  }

  /**
   * a11y: colourblind-safe entity colours (see PALETTES in a11y.ts, as
   * 0xrrggbb numbers). Non-finite values are ignored per entry. Live bodies
   * of the same kind are re-tinted (except the local player, who keeps the
   * green self marker); bodies created later use the new map.
   */
  setEntityColors(map: Record<string, number>): void {
    for (const [kind, num] of Object.entries(map)) {
      if (typeof num !== 'number' || !Number.isFinite(num)) continue;
      const c = Math.floor(num) & 0xffffff;
      this.bodyColors[kind] = c;
      for (const b of this.bodies.values()) {
        if (!b.isLocal && b.kind === kind) b.baseColor = c;
      }
    }
  }

  /**
   * a11y: telegraph ring colour as 0xrrggbb. Rings created afterwards use it;
   * rings already winding up keep their old material.
   */
  setTelegraphColor(ring: number, disc?: number): void {
    if (typeof ring === 'number' && Number.isFinite(ring)) {
      this.teleRing = Math.floor(ring) & 0xffffff;
      this.teleDisc = typeof disc === 'number' && Number.isFinite(disc)
        ? Math.floor(disc) & 0xffffff
        : this.teleRing;
    }
  }

  telegraph(x: number, y: number, r: number, ttlMs: number) {
    // Boss telegraph ring (`event/telegraph` from server/src/ai/npc.ts).
    // Expanding circle over ttlMs, then a flash when the hit lands. Colours
    // follow the a11y palette (see setTelegraphColor); the shipped reds are
    // the defaults.
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(r) || r <= 0) return;
    if (!Number.isFinite(ttlMs) || ttlMs <= 0) return;
    const rr = Math.min(30, r);
    const ttl = Math.min(5000, Math.round(ttlMs));
    const g = new THREE.Group();
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(0.85, 1.0, 40),
      new THREE.MeshBasicMaterial({ color: this.teleRing, transparent: true, opacity: 0.85, side: THREE.DoubleSide, depthTest: false }));
    ring.rotation.x = -Math.PI / 2;
    const disc = new THREE.Mesh(
      new THREE.CircleGeometry(1.0, 40),
      new THREE.MeshBasicMaterial({ color: this.teleDisc, transparent: true, opacity: 0.1, side: THREE.DoubleSide, depthTest: false }));
    disc.rotation.x = -Math.PI / 2;
    g.add(ring, disc);
    g.position.set(x, (this.terrain?.tileHeightAt(x, y) ?? 0) * TERRAIN_Z_SCALE + 0.12, y);
    g.scale.setScalar(Math.max(0.05, rr * 0.15));
    this.scene.add(g);
    this.tele.push({ g, x, y, r: rr, t0: performance.now(), ttl });
    if (this.tele.length > 12) {
      const old = this.tele.shift();
      if (old) {
        this.scene.remove(old.g);
        old.g.traverse((o) => {
          const mesh = o as THREE.Mesh;
          if (mesh.isMesh) {
            mesh.geometry.dispose();
            (mesh.material as THREE.Material)?.dispose();
          }
        });
      }
    }
  }

  /**
   * Screen shake (`impactShake`): decays over ~350ms. Offsets the camera
   * position by a decaying random vector; direction is random so repeated
   * hits never form a visible standing wave.
   */
  shake(strength = 1) {
    this.shakeAmp = Math.min(1.6, this.shakeAmp + Math.max(0, strength));
  }

  project(x: number, y: number, z?: number): { sx: number; sy: number } {
    const v = new THREE.Vector3(x, (z ?? 0) * TERRAIN_Z_SCALE + 1.6, y).project(this.camera);
    const w = this.container.clientWidth || 960, h = this.container.clientHeight || 600;
    return { sx: ((v.x + 1) / 2) * w, sy: ((1 - v.y) / 2) * h };
  }

  screenToWorld(sx: number, sy: number): { x: number; y: number } {
    const rect = this.renderer.domElement.getBoundingClientRect();
    const nx = ((sx - rect.left) / Math.max(1, rect.width)) * 2 - 1;
    const ny = -(((sy - rect.top) / Math.max(1, rect.height)) * 2 - 1);
    const ray = new THREE.Raycaster();
    ray.setFromCamera(new THREE.Vector2(nx, ny), this.camera);
    const out = new THREE.Vector3();
    if (ray.ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 1, 0), -this.groundY), out)) {
      return { x: out.x, y: out.z };
    }
    return { x: this.target.x, y: this.target.z };
  }

  /** Visual Y for an entity: server `z` when present, else the local field. */
  private entityZ(e: DrawEntity): number {
    if (typeof e.z === 'number' && Number.isFinite(e.z)) return zVisual(e.z);
    const tv = this.terrain;
    return tv === null ? 0 : zVisual(tv.tileHeightAt(e.x, e.y));
  }

  update(ents: DrawEntity[], camX: number, camY: number, timeMs: number) {
    const dt = this.lastMs ? Math.min(0.1, (timeMs - this.lastMs) / 1000) : 0.016;
    this.lastMs = timeMs;

    // Fog-of-war tinting (throttled internally to ~2Hz).
    this.applyFog(performance.now());

    // Camera follow (smoothed) — fixed dimetric angle, position tracks player.
    const k = 1 - Math.exp(-dt * 5);
    this.target.x += (camX - this.target.x) * k;
    this.target.z += (camY - this.target.z) * k;
    // Terrain-aware: the whole rig rides the ground height under the camera so
    // a hillside scrolls up instead of the avatar sinking into the tiles.
    const wantY = this.terrain === null ? 0 : zVisual(this.terrain.tileHeightAt(this.target.x, this.target.z));
    this.groundY += (wantY - this.groundY) * k;
    this.camera.position.set(this.target.x + ISO_OFF, ISO_OFF + this.groundY, this.target.z + ISO_OFF);
    this.camera.lookAt(this.target.x, this.groundY, this.target.z);
    // Screen shake: post-lookAt translation keeps the fixed iso angle.
    if (this.shakeAmp > 0.0005) {
      const a = this.shakeAmp;
      this.camera.position.x += (Math.random() * 2 - 1) * a * 0.9;
      this.camera.position.y += (Math.random() * 2 - 1) * a * 0.7;
      this.camera.position.z += (Math.random() * 2 - 1) * a * 0.9;
      this.shakeAmp *= Math.exp(-dt * 9);
    } else {
      this.shakeAmp = 0;
    }

    const alive = new Set<number>();
    for (const e of ents) {
      alive.add(e.id);
      let b = this.bodies.get(e.id);
      if (!b) { b = this.makeBody(e); this.bodies.set(e.id, b); }
      // TERRAIN: stand the avatar on the ground (server `z`, else local field).
      b.g.position.set(e.x, this.entityZ(e), e.y);
      // Fog-of-war: avatars beyond 25m from the follow target go dark, and
      // avatars in never-explored ground fade out almost entirely.
      let dim = 1;
      if (!e.isLocal) {
        const tier = this.fog ? this.fogTierAt(e.x, e.y) : (Math.hypot(e.x - this.target.x, e.y - this.target.z) > FOG_RADIUS ? 1 : 0);
        dim = tier === 0 ? 1 : tier === 1 ? 0.45 : 0.15;
      }
      b.mat.color.set(b.baseColor).multiplyScalar(dim);
      if (e.kind !== 'pickup' && e.kind !== 'projectile') {
        const frac = e.maxHp > 0 ? Math.max(0, e.hp / e.maxHp) : 0;
        b.fg.scale.set(1.2 * frac, 0.12, 1);
        (b.fg.material as THREE.SpriteMaterial).color.set(frac > 0.5 ? 0x51ff7a : frac > 0.25 ? 0xffb84d : 0xff5252);
      }
    }
    for (const [id, b] of [...this.bodies]) {
      if (alive.has(id)) continue;
      this.scene.remove(b.g);
      b.g.traverse((o) => {
        const mesh = o as THREE.Mesh;
        if (mesh.isMesh) {
          mesh.geometry.dispose();
          const m = mesh.material as THREE.Material | undefined;
          m?.dispose();
        }
      });
      this.bodies.delete(id);
    }

    // Flashes decay.
    this.flashes = this.flashes.filter((f) => {
      f.life -= dt;
      const t = Math.max(0, f.life / f.max);
      f.m.scale.setScalar(1 + (1 - t) * 2.2);
      (f.m.material as THREE.MeshBasicMaterial).opacity = t * 0.9;
      if (f.life <= 0) { this.scene.remove(f.m); f.m.geometry.dispose(); f.m.material.dispose(); return false; }
      return true;
    });

    // Telegraph rings expand over their windup, then flash once.
    const nowMs = performance.now();
    this.tele = this.tele.filter((t) => {
      const frac = (nowMs - t.t0) / Math.max(1, t.ttl);
      if (frac >= 1) {
        this.scene.remove(t.g);
        t.g.traverse((o) => {
          const mesh = o as THREE.Mesh;
          if (mesh.isMesh) {
            mesh.geometry.dispose();
            (mesh.material as THREE.Material)?.dispose();
          }
        });
        this.flash(t.x, t.y, 0xff3030);
        return false;
      }
      const f = Math.max(0, Math.min(1, frac));
      t.g.scale.setScalar(Math.max(0.05, t.r * (0.15 + 0.85 * f)));
      const ring = t.g.children[0] as THREE.Mesh<THREE.CircleGeometry, THREE.MeshBasicMaterial> | undefined;
      const disc = t.g.children[1] as THREE.Mesh<THREE.CircleGeometry, THREE.MeshBasicMaterial> | undefined;
      if (ring) (ring.material as THREE.MeshBasicMaterial).opacity = 0.55 + 0.45 * f;
      if (disc) (disc.material as THREE.MeshBasicMaterial).opacity = 0.06 + 0.16 * f;
      return true;
    });

    // Day/night lerp: sun + ambient + background.
    const f = daylightFactor(timeMs / 1000);
    this.sun.intensity = 0.25 + 1.15 * f;
    this.amb.intensity = 0.35 + 0.45 * f;
    this.hemi.intensity = 0.15 + 0.35 * f;
    this.bg.copy(this.night).lerp(this.day, f);

    this.renderer.render(this.scene, this.camera);
  }
}
