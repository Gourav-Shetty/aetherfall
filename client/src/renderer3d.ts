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
import {
  BurstPool,
  DECOR_CAP,
  averageGroundColor,
  animateAvatar,
  avatarVariant,
  biomeTint,
  blobShadowTexture,
  createAvatar,
  createLevelBeam,
  createSkyDome,
  createStars,
  createSunSprite,
  createTelegraphGlow,
  decorMatrices,
  glowTexture,
  hash2i,
  planDecorations,
  sharedGeos,
  tileEdgeTexture,
  tileShade,
  triggerLevelBeam,
  updateLevelBeam,
  updateSkyDome,
  updateStars,
  updateSun,
  zoneDensity,
  type AvatarRefs,
  type DecorItem,
} from './scene_art.js';

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
  refs: AvatarRefs;
  baseColor: number;
  teamColor: number;
  isLocal: boolean;
  /** Snapshot kind, so a palette switch can re-tint live bodies. */
  kind: string;
  name: string;
  lastBX: number;
  lastBZ: number;
}
interface Flash { m: THREE.Mesh<THREE.RingGeometry, THREE.MeshBasicMaterial>; life: number; max: number; }
interface TeleRing { g: THREE.Group; x: number; y: number; r: number; t0: number; ttl: number; }
/** Floor blood decal: a kill position (+ its splat mesh) fading over BLOOD_TTL_MS. */
interface BloodSplat { x: number; y: number; t0: number; mesh: THREE.Mesh; }

/** Blood decals kept per renderer (last kills as fading floor splats). */
export const BLOOD_MAX = 200;
/** ms a blood splat stays visible before it is pruned (fades throughout). */
export const BLOOD_TTL_MS = 30000;

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
 * Stylized low-poly pass (procedural, no assets): grouped characters with
 * walk bob + lean + blob shadows, two-tone biome-tinted tiles with edge
 * facets, an instanced decoration layer, gradient sky + stars + sun sprite,
 * water shimmer / lava pulse + flicker light, and pooled combat particles.
 *
 * Steady-state base scene is <= 12 draw calls: ground, walls, water, lava,
 * 4 decoration meshes, sky, stars (night only), sun, plus the pooled burst
 * Points and the level beam (both hidden when idle). Avatars, flashes and
 * telegraph rings are transient per-entity extras with shared geometries.
 *
 * With a TerrainView attached (the normal path, see main.ts) every ground tile
 * is lifted to its `heightAt()` elevation, tilted along its gradient, tinted by
 * elevation / slope / hazard / biome, and every avatar stands at the ground
 * height of the tile under it. The renderer still works (flat arena) without one.
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
  private wallSet = new Set<string>();
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
  /** Hit-stop freeze end (ms, same clock as update's timeMs). See hitStop(). */
  private hitStopUntil = 0;
  /** Floor blood decals: last BLOOD_MAX kill positions, fading over BLOOD_TTL_MS. */
  private blood: BloodSplat[] = [];
  /** Downed (crawling) entity ids: set by `mob-downed`, cleared by `mob-up`/`mob-die`. */
  private downedIds = new Set<number>();
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
  // ---- stylized-art layer (scene_art.ts) ----
  private sky: THREE.Mesh | null = null;
  private stars: THREE.Points | null = null;
  private sunSprite: THREE.Sprite | null = null;
  private lavaLight: THREE.PointLight | null = null;
  private bursts: BurstPool | null = null;
  private beam: THREE.Mesh | null = null;
  private lastSkyUpdate = 0;
  private decorDensity = 1;
  private decorPlan: DecorItem[] = [];
  private grassMesh: THREE.InstancedMesh | null = null;
  private foliageMesh: THREE.InstancedMesh | null = null;
  private trunkMesh: THREE.InstancedMesh | null = null;
  private rockMesh: THREE.InstancedMesh | null = null;
  private grassBase: Float32Array = new Float32Array(0);
  private foliageBase: Float32Array = new Float32Array(0);
  private trunkBase: Float32Array = new Float32Array(0);
  private rockBase: Float32Array = new Float32Array(0);
  private grassPos: Array<[number, number]> = [];
  private foliagePos: Array<[number, number]> = [];
  private rockPos: Array<[number, number]> = [];
  // ---- frame-loop scratch (no per-frame allocation) ----
  private scratchColor = new THREE.Color();
  private scratchColor2 = new THREE.Color();
  private scratchColor3 = new THREE.Color();
  private scratchObj = new THREE.Object3D();
  private scratchVec = new THREE.Vector3();
  private scratchVec2 = new THREE.Vector2();
  private scratchRay = new THREE.Raycaster();
  private scratchUp = new THREE.Vector3(0, 1, 0);
  private scratchPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  private scratchOut = new THREE.Vector3();
  private aliveSet = new Set<number>();
  private removeIds: number[] = [];
  private sunWarm = new THREE.Color(0xffb36b);
  private sunNoon = new THREE.Color(0xfff3d6);
  private lavaNearCheckedAt = 0;
  private lavaNear = false;
  private hasGround = false;

  private constructor(private container: HTMLElement, renderer: THREE.WebGLRenderer) {
    this.renderer = renderer;
    const w = container.clientWidth || 960, h = container.clientHeight || 600;
    const view = this.viewDist, aspect = w / h;
    this.camera = new THREE.OrthographicCamera((-view * aspect) / 2, (view * aspect) / 2, view / 2, -view / 2, 0.1, 400);
    this.sun = new THREE.DirectionalLight(0xfff2d9, 1.2);
    this.sun.position.set(40, 60, 20);
    this.amb = new THREE.AmbientLight(0xffffff, 0.7);
    this.hemi = new THREE.HemisphereLight(0xbdd7ff, 0x3a5f3a, 0.4);
    this.scene.add(this.sun, this.amb, this.hemi);
    this.scene.background = this.bg;
    // Atmospheric distance haze for far geometry (fog-of-war terrain tinting
    // is a separate, exact per-chunk pass — see setFog()/applyFog()).
    this.scene.fog = new THREE.Fog(0x0b1026, 55, 90);
    // Lava flicker light: single PointLight, enabled only near lava.
    this.lavaLight = new THREE.PointLight(0xff6a1e, 0, 14, 1.8);
    this.lavaLight.visible = false;
    this.scene.add(this.lavaLight);
    this.buildTerrain();
    this.buildSkyLayer();
    this.resize();
    try {
      if (typeof window !== 'undefined') window.addEventListener('resize', this.onResize);
    } catch { /* ignore */ }
    try {
      const el = renderer.domElement as unknown as { style?: Record<string, string> };
      if (el.style !== undefined) {
        el.style.position = 'absolute'; el.style.inset = '0';
        el.style.width = '100%'; el.style.height = '100%';
      }
    } catch { /* ignore */ }
  }

  static tryCreate(container: HTMLElement, terrain: TerrainView | null = null): IsoRenderer | null {
    try {
      const doc = (globalThis as unknown as { document?: Document }).document;
      if (!doc) return null;
      const probe = doc.createElement('canvas');
      const ctx = probe.getContext('webgl2') ?? probe.getContext('webgl');
      if (!ctx) return null;
      const g = globalThis as unknown as { window?: { devicePixelRatio?: number } };
      const renderer = new THREE.WebGLRenderer({ antialias: true });
      renderer.setPixelRatio(Math.min(g.window?.devicePixelRatio ?? 1, 2));
      container.appendChild(renderer.domElement);
      const iso = new IsoRenderer(container, renderer);
      if (terrain !== null) iso.setTerrain(terrain);
      return iso;
    } catch {
      return null;
    }
  }

  /**
   * Headless constructor for node tests: no WebGL, no window. Uses a stub
   * renderer whose render() is a no-op, so update() exercises the whole
   * scene graph (child-count stability, determinism) without a GPU.
   */
  static createHeadless(container: HTMLElement, terrain: TerrainView | null = null): IsoRenderer {
    const stubCanvas = { style: {} as Record<string, string>, remove: () => {} };
    const stub = {
      domElement: stubCanvas,
      setPixelRatio: (_n: number) => {},
      setSize: (_w: number, _h: number, _u?: boolean) => {},
      render: (_s: unknown, _c: unknown) => {},
      dispose: () => {},
    } as unknown as THREE.WebGLRenderer;
    const iso = new IsoRenderer(container, stub);
    if (terrain !== null) iso.setTerrain(terrain);
    return iso;
  }

  get element(): HTMLElement { return this.renderer.domElement as unknown as HTMLElement; }

  /** Render-distance hook: ortho view size 15..50 (larger = more visible). */
  setViewDistance(v: number) {
    this.viewDist = Math.max(15, Math.min(50, v));
    this.resize();
  }

  /**
   * Quality hook: pixel-ratio cap + flash-particle cap. Decoration density
   * and burst particles scale from the same knob (low ~1/0.35, med ~1.5/0.7,
   * high ~2/1.0); pass an explicit decorDensity to override.
   */
  setQuality(pixelRatioCap: number, maxFlashes: number, decorDensity?: number) {
    this.maxFlashes = Math.max(0, Math.min(200, Math.floor(maxFlashes)));
    try {
      const g = globalThis as unknown as { window?: { devicePixelRatio?: number } };
      this.renderer.setPixelRatio(Math.min(g.window?.devicePixelRatio ?? 1, pixelRatioCap));
    } catch {
      /* ignore */
    }
    const derived = pixelRatioCap <= 1 ? 0.35 : pixelRatioCap <= 1.5 ? 0.7 : 1;
    const want = decorDensity === undefined ? derived : Math.max(0.1, Math.min(1, decorDensity));
    if (Math.abs(want - this.decorDensity) > 1e-6) {
      this.decorDensity = want;
      this.bursts?.setQualityScale(want);
      this.buildDecorations();
    } else {
      this.bursts?.setQualityScale(this.decorDensity);
    }
  }

  /** Remove the WebGL canvas + free GPU resources (for Canvas2D fallback). */
  dispose() {
    try {
      try {
        if (typeof window !== 'undefined') window.removeEventListener('resize', this.onResize);
      } catch { /* ignore */ }
      // Bodies: dispose per-instance materials only (geometries are shared).
      for (const b of this.bodies.values()) this.disposeBody(b);
      this.bodies.clear();
      // Transient fx own their geometries.
      for (const f of this.flashes) {
        this.scene.remove(f.m);
        f.m.geometry.dispose();
        (f.m.material as THREE.Material).dispose();
      }
      this.flashes.length = 0;
      for (const s of this.blood) {
        this.scene.remove(s.mesh);
        s.mesh.geometry.dispose();
        (s.mesh.material as THREE.Material).dispose();
      }
      this.blood.length = 0;
      for (const t of this.tele) {
        this.scene.remove(t.g);
        t.g.traverse((o) => {
          const mesh = o as THREE.Mesh;
          if ((mesh as unknown as { isMesh?: boolean }).isMesh) {
            mesh.geometry.dispose();
            (mesh.material as THREE.Material)?.dispose();
          }
        });
      }
      this.tele.length = 0;
      this.clearHazards();
      this.clearTerrainMeshes();
      this.clearDecorations();
      if (this.sky !== null) {
        this.scene.remove(this.sky);
        this.sky.geometry.dispose();
        ((this.sky.material as THREE.Material)).dispose();
        this.sky = null;
      }
      if (this.stars !== null) {
        this.scene.remove(this.stars);
        this.stars.geometry.dispose();
        ((this.stars.material as THREE.Material)).dispose();
        this.stars = null;
      }
      if (this.sunSprite !== null) {
        this.scene.remove(this.sunSprite);
        ((this.sunSprite.material as THREE.Material)).dispose();
        this.sunSprite = null;
      }
      if (this.bursts !== null) {
        this.scene.remove(this.bursts.points);
        this.bursts.points.geometry.dispose();
        ((this.bursts.points.material as THREE.Material)).dispose();
        this.bursts = null;
      }
      if (this.beam !== null) {
        this.scene.remove(this.beam);
        ((this.beam.material as THREE.Material)).dispose();
        this.beam = null;
      }
      if (this.lavaLight !== null) {
        this.scene.remove(this.lavaLight);
        this.lavaLight = null;
      }
      this.renderer.dispose();
      try {
        (this.renderer.domElement as unknown as { remove?: () => void }).remove?.();
      } catch { /* ignore */ }
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
    try {
      this.renderer.setSize(w, h, false);
    } catch { /* ignore */ }
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
    this.waterPos = [];
    this.lavaPos = [];
  }

  private clearTerrainMeshes(): void {
    if (this.hasGround) {
      try {
        this.scene.remove(this.ground);
        this.ground.geometry.dispose();
        (this.ground.material as THREE.Material).dispose();
      } catch { /* ignore */ }
      try {
        this.scene.remove(this.wall);
        this.wall.geometry.dispose();
        (this.wall.material as THREE.Material).dispose();
      } catch { /* ignore */ }
      this.hasGround = false;
    }
    this.wallPos = [];
    this.wallSet.clear();
  }

  private clearDecorations(): void {
    for (const mesh of [this.grassMesh, this.foliageMesh, this.trunkMesh, this.rockMesh]) {
      if (!mesh) continue;
      this.scene.remove(mesh);
      // Geometries are shared singletons — dispose the material only.
      (mesh.material as THREE.Material).dispose();
    }
    this.grassMesh = null;
    this.foliageMesh = null;
    this.trunkMesh = null;
    this.rockMesh = null;
    this.grassBase = new Float32Array(0);
    this.foliageBase = new Float32Array(0);
    this.trunkBase = new Float32Array(0);
    this.rockBase = new Float32Array(0);
    this.grassPos = [];
    this.foliagePos = [];
    this.rockPos = [];
  }

  /** Sky dome + stars + sun sprite + pooled bursts + level beam (once). */
  private buildSkyLayer(): void {
    if (this.sky === null) {
      this.sky = createSkyDome(150);
      this.scene.add(this.sky);
    }
    if (this.stars === null) {
      this.stars = createStars(220, 130);
      this.scene.add(this.stars);
    }
    if (this.sunSprite === null) {
      this.sunSprite = createSunSprite();
      this.scene.add(this.sunSprite);
    }
    if (this.bursts === null) {
      this.bursts = new BurstPool(256);
      this.bursts.setQualityScale(this.decorDensity);
      this.scene.add(this.bursts.points);
    }
    if (this.beam === null) {
      this.beam = createLevelBeam();
      this.scene.add(this.beam);
    }
  }

  /**
   * Ground / wall / hazard geometry.
   *
   * With terrain: every tile is placed at `zVisual(heightAt)`, rotated so its
   * plane follows the local gradient, and coloured from elevation (snow line),
   * slope (cliff rock), hazard and biome (two-tone checker + seeded noise +
   * biome tint over an edge-facet texture). Hazard tiles additionally get an
   * instanced surface quad at the water or lava level.
   */
  private buildTerrain() {
    this.clearHazards();
    this.clearTerrainMeshes();
    this.clearDecorations();
    const tiles = new ChunkCache();
    const rand = mulberry32(1337);
    const dummy = this.scratchObj;
    const up = new THREE.Vector3(0, 1, 0);
    const nrm = new THREE.Vector3();
    const flat = new THREE.Quaternion().setFromEuler(new THREE.Euler(-Math.PI / 2, 0, 0));
    const tv = this.terrain;
    const seed = tv?.seed ?? 1337;
    const ground = new THREE.InstancedMesh(
      new THREE.PlaneGeometry(1, 1),
      new THREE.MeshLambertMaterial({ color: 0xffffff, map: tileEdgeTexture() }),
      ARENA * ARENA);
    const wallPos: Array<[number, number, number]> = [];
    const waterPos: Array<[number, number, number]> = [];
    const lavaPos: Array<[number, number, number]> = [];
    const c = this.scratchColor;
    const snow = this.scratchColor2;
    const biomeScratch = this.scratchColor3;
    const cliff = new THREE.Color(CLIFF_COLOR);
    snow.set(SNOW_COLOR);
    let gi = 0;
    // Track the wall-tile set so decorations never sprout inside walls.
    const wallKeys = new Set<string>();
    for (let y = 0; y < ARENA; y++) {
      for (let x = 0; x < ARENA; x++) {
        const t = tiles.tile(x, y);
        let gz = 0;
        let slope = 0;
        let gx = 0;
        let gy = 0;
        let kind = TERR_NONE;
        let height = 0;
        let biome = 'plains';
        if (tv !== null) {
          height = tv.heightAtTile(x, y);
          kind = tv.kindAtTile(x, y);
          gz = zVisual(height);
          slope = tv.slopeFromGrid(x, y);
          const g = tv.gradientFromGrid(x, y);
          gx = g.gx;
          gy = g.gy;
          try {
            biome = tv.biomeAtTile(x, y);
          } catch { biome = 'plains'; }
        }
        dummy.position.set(x + 0.5, gz, y + 0.5);
        if (tv !== null && slope > 0.02) {
          // Align the quad with the terrain normal (-dh/dx, 1, -dh/dy).
          nrm.set(-gx, 1, -gy).normalize();
          dummy.quaternion.setFromUnitVectors(up, nrm).multiply(flat);
        } else {
          dummy.quaternion.copy(flat);
        }
        dummy.scale.set(1, 1, 1);
        dummy.updateMatrix();
        ground.setMatrixAt(gi, dummy.matrix);
        if (kind !== TERR_NONE) {
          // Hazard floor: dark bed so the surface quad reads as depth.
          c.set(HAZARD_GROUND[kind] ?? 0x101010).offsetHSL(0, 0, (rand() - 0.5) * 0.03);
          (kind === TERR_WATER ? waterPos : lavaPos).push([x, y, gz]);
        } else if (t === 1) {
          c.set(CLIFF_COLOR).offsetHSL(0, 0, (rand() - 0.5) * 0.06);
        } else {
          // Stylized base: two-tone checker + seeded brightness noise, then
          // biome tint, cliff rock and snow altitude cues.
          c.set((x + y) % 2 === 0 ? 0x4a8f4d : 0x439047);
          c.multiplyScalar(tileShade(x, y, seed));
          biomeScratch.setHex(biomeTint(biome));
          c.lerp(biomeScratch, 0.32);
          if (tv !== null) {
            // Steep ground reads as rock, high ground as snow.
            if (slope > TERRAIN_CLIFF_SLOPE) c.lerp(cliff, Math.min(1, (slope - TERRAIN_CLIFF_SLOPE) / 2));
            const alt = Math.max(0, Math.min(1, (height - 18) / 22));
            if (alt > 0) c.lerp(snow, alt * 0.8);
          } else {
            c.offsetHSL(0, 0, (rand() - 0.5) * 0.02);
          }
        }
        ground.setColorAt(gi, c);
        const b = gi * 3;
        this.baseGround[b] = c.r; this.baseGround[b + 1] = c.g; this.baseGround[b + 2] = c.b;
        gi++;
        if (t === 1) {
          wallPos.push([x, y, gz]);
          wallKeys.add(x + ',' + y);
        }
      }
    }
    ground.instanceMatrix.needsUpdate = true;
    if (ground.instanceColor) ground.instanceColor.needsUpdate = true;
    this.scene.add(ground);
    this.ground = ground;
    this.hasGround = true;

    const walls = new THREE.InstancedMesh(
      new THREE.BoxGeometry(1, 1, 1), new THREE.MeshLambertMaterial({ color: 0x8b93a3 }), Math.max(1, wallPos.length));
    const d2 = new THREE.Object3D();
    wallPos.forEach(([x, y, gz], i) => {
      // Walls ride the terrain height so a cliff edge still lines up.
      d2.position.set(x + 0.5, gz + 0.5, y + 0.5);
      d2.rotation.set(0, 0, 0);
      d2.scale.set(1, 1, 1);
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
    this.wallSet = wallKeys;

    this.water = this.buildHazardSurface(waterPos, this.waterBase, TERR_WATER, 0.74);
    this.waterPos = waterPos;
    this.lava = this.buildHazardSurface(lavaPos, this.lavaBase, TERR_LAVA, 1);
    this.lavaPos = lavaPos;
    if (tv !== null) this.buildLandmarks();
    // Hemisphere ground follows the biome-averaged ground tone.
    try {
      const [r, g, b] = averageGroundColor(this.baseGround);
      this.hemi.groundColor.setRGB(r, g, b);
    } catch { /* ignore */ }
    // A rebuild invalidates every cached fog tier.
    this.groundTier.fill(-1);
    this.buildDecorations();
  }

  /**
   * Instanced decoration layer: grass tufts (crossed planes), trees
   * (cone foliage + cylinder trunk) and rocks (dodecahedra), scattered
   * deterministically per tile and capped at ~400 items. One draw call per
   * mesh (4 total), rebuilt on terrain attach and on setQuality().
   */
  private buildDecorations(): void {
    if (!this.hasGround) return;
    this.clearDecorations();
    const tv = this.terrain;
    const seed = tv?.seed ?? 1337;
    const isWall = (tx: number, ty: number): boolean => this.wallSet.has(tx + ',' + ty);
    let plan: DecorItem[];
    try {
      plan = planDecorations(
        tv !== null
          ? {
              kindAtTile: (x, y) => tv.kindAtTile(x, y),
              heightAtTile: (x, y) => tv.heightAtTile(x, y),
              slopeFromGrid: (x, y) => tv.slopeFromGrid(x, y),
              biomeAtTile: (x, y) => tv.biomeAtTile(x, y),
              zoneAtTile: (x, y) => tv.zoneAtTile(x, y),
            }
          : null,
        seed,
        DECOR_CAP,
        this.decorDensity,
        isWall,
      );
    } catch {
      plan = [];
    }
    // Density knob path (tests): zoneDensity is consulted for documentation.
    void zoneDensity;
    this.decorPlan = plan;
    if (plan.length === 0) return;
    const G = sharedGeos();
    const grassItems = plan.filter((d) => d.kind === 'grass');
    const treeItems = plan.filter((d) => d.kind === 'tree');
    const rockItems = plan.filter((d) => d.kind === 'rock');
    const dummy = this.scratchObj;
    const c = this.scratchColor;
    if (grassItems.length > 0) {
      const mat = new THREE.MeshLambertMaterial({ color: 0xffffff, side: THREE.DoubleSide });
      const mesh = new THREE.InstancedMesh(G.grassBlade, mat, Math.max(1, grassItems.length * 2));
      const base = new Float32Array(grassItems.length * 2 * 3);
      let idx = 0;
      for (const d of grassItems) {
        for (let k = 0; k < 2; k++) {
          dummy.position.set(d.x, d.z, d.y);
          dummy.rotation.set(0, d.rotY + (k * Math.PI) / 2, 0);
          dummy.scale.setScalar(d.scale);
          dummy.updateMatrix();
          mesh.setMatrixAt(idx, dummy.matrix);
          c.setHex(d.tint);
          mesh.setColorAt(idx, c);
          base[idx * 3] = c.r; base[idx * 3 + 1] = c.g; base[idx * 3 + 2] = c.b;
          this.grassPos.push([d.x, d.y]);
          idx++;
        }
      }
      mesh.count = idx;
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      this.scene.add(mesh);
      this.grassMesh = mesh;
      this.grassBase = base;
    }
    if (treeItems.length > 0) {
      const folMat = new THREE.MeshLambertMaterial({ color: 0xffffff });
      const trunkMat = new THREE.MeshLambertMaterial({ color: 0xffffff });
      const fol = new THREE.InstancedMesh(G.treeFoliage, folMat, Math.max(1, treeItems.length));
      const trunk = new THREE.InstancedMesh(G.treeTrunk, trunkMat, Math.max(1, treeItems.length));
      const folBase = new Float32Array(treeItems.length * 3);
      const trunkBase = new Float32Array(treeItems.length * 3);
      treeItems.forEach((d, i) => {
        dummy.position.set(d.x, d.z, d.y);
        dummy.rotation.set(0, d.rotY, 0);
        dummy.scale.setScalar(d.scale);
        dummy.updateMatrix();
        fol.setMatrixAt(i, dummy.matrix);
        trunk.setMatrixAt(i, dummy.matrix);
        c.setHex(d.tint);
        fol.setColorAt(i, c);
        folBase[i * 3] = c.r; folBase[i * 3 + 1] = c.g; folBase[i * 3 + 2] = c.b;
        c.setHex(0x6b4a2e).offsetHSL(0, 0, ((d.tx + d.ty) % 5) * 0.008 - 0.016);
        trunk.setColorAt(i, c);
        trunkBase[i * 3] = c.r; trunkBase[i * 3 + 1] = c.g; trunkBase[i * 3 + 2] = c.b;
        this.foliagePos.push([d.x, d.y]);
      });
      fol.instanceMatrix.needsUpdate = true;
      trunk.instanceMatrix.needsUpdate = true;
      if (fol.instanceColor) fol.instanceColor.needsUpdate = true;
      if (trunk.instanceColor) trunk.instanceColor.needsUpdate = true;
      this.scene.add(fol);
      this.scene.add(trunk);
      this.foliageMesh = fol;
      this.trunkMesh = trunk;
      this.foliageBase = folBase;
      this.trunkBase = trunkBase;
    }
    if (rockItems.length > 0) {
      const mat = new THREE.MeshLambertMaterial({ color: 0xffffff });
      const mesh = new THREE.InstancedMesh(G.rock, mat, Math.max(1, rockItems.length));
      const base = new Float32Array(rockItems.length * 3);
      rockItems.forEach((d, i) => {
        dummy.position.set(d.x, d.z + 0.15 * d.scale, d.y);
        dummy.rotation.set(d.rotY * 0.3, d.rotY, 0);
        dummy.scale.setScalar(d.scale);
        dummy.updateMatrix();
        mesh.setMatrixAt(i, dummy.matrix);
        c.setHex(d.tint);
        mesh.setColorAt(i, c);
        base[i * 3] = c.r; base[i * 3 + 1] = c.g; base[i * 3 + 2] = c.b;
        this.rockPos.push([d.x, d.y]);
      });
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      this.scene.add(mesh);
      this.rockMesh = mesh;
      this.rockBase = base;
    }
    // New instances start fully lit; the throttled fog pass dims them.
    this.lastFogApply = 0;
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
      : new THREE.MeshLambertMaterial({ color: 0xffffff, emissive: 0x531a08, emissiveIntensity: 0.7 });
    const mesh = new THREE.InstancedMesh(new THREE.PlaneGeometry(1, 1), mat, pos.length);
    const d = new THREE.Object3D();
    d.rotation.set(-Math.PI / 2, 0, 0);
    const c = this.scratchColor;
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
    const c = this.scratchColor;
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
   * Retint terrain/wall/decoration instances for fog-of-war. Runs at most
   * every 500ms and only rewrites an instance's color when its tier actually
   * changed, so the steady-state cost is a 10k tier scan (~0.1ms) a couple of
   * times a second.
   */
  private applyFog(nowMs: number): void {
    const fog = this.fog;
    if (!fog) return;
    if (nowMs - this.lastFogApply < 500) return;
    this.lastFogApply = nowMs;
    const c = this.scratchColor;
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
    // Decorations dim with the same tiers (rewritten at 2Hz, ~400 instances).
    this.applyFogToDecor(this.grassMesh, this.grassPos, this.grassBase, dim);
    this.applyFogToDecor(this.foliageMesh, this.foliagePos, this.foliageBase, dim);
    this.applyFogToDecor(this.trunkMesh, this.foliagePos, this.trunkBase, dim);
    this.applyFogToDecor(this.rockMesh, this.rockPos, this.rockBase, dim);
  }

  /** Fog tint for one instanced hazard surface (no-op when absent). */
  private applyFogToSurface(
    mesh: THREE.InstancedMesh | null,
    pos: Array<[number, number, number]>,
    base: Float32Array,
    dim: number[],
  ): void {
    if (mesh === null) return;
    const c = this.scratchColor;
    for (let i = 0; i < pos.length; i++) {
      const p = pos[i]!;
      const tier = this.fogTierAt(p[0] + 0.5, p[1] + 0.5);
      const b = i * 3;
      c.setRGB(base[b]!, base[b + 1]!, base[b + 2]!).multiplyScalar(dim[tier]!);
      mesh.setColorAt(i, c);
    }
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  }

  /** Fog tint for one decoration layer (no-op when absent). */
  private applyFogToDecor(
    mesh: THREE.InstancedMesh | null,
    pos: Array<[number, number]>,
    base: Float32Array,
    dim: number[],
  ): void {
    if (mesh === null || pos.length === 0) return;
    const c = this.scratchColor;
    const n = Math.min(pos.length, Math.floor(base.length / 3));
    for (let i = 0; i < n; i++) {
      const p = pos[i]!;
      const tier = this.fogTierAt(p[0], p[1]);
      const b = i * 3;
      c.setRGB(base[b]!, base[b + 1]!, base[b + 2]!).multiplyScalar(dim[tier]!);
      mesh.setColorAt(i, c);
    }
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  }

  private teamColorFor(e: DrawEntity): number {
    if (e.isLocal) return 0x59d98c;
    return this.bodyColors[e.kind] ?? 0xcccccc;
  }

  private makeBody(e: DrawEntity): Body {
    const baseColor = e.isLocal ? 0x59d98c : (this.bodyColors[e.kind] ?? 0xcccccc);
    const teamColor = this.teamColorFor(e);
    const refs = createAvatar({
      kind: e.kind,
      name: e.name,
      baseColor,
      teamColor,
      isLocal: e.isLocal,
    });
    refs.group.position.set(e.x, 0, e.y);
    refs.lastX = e.x;
    refs.lastZ = e.y;
    // Deterministic bob phase so a crowd never pulses in sync.
    refs.bobPhase = ((e.id * 2.39) % (Math.PI * 2));
    this.scene.add(refs.group);
    return { refs, baseColor, teamColor, isLocal: e.isLocal, kind: e.kind, name: e.name, lastBX: e.x, lastBZ: e.y };
  }

  /** Dispose per-instance avatar materials (shared geos/textures stay alive). */
  private disposeBody(b: Body): void {
    this.scene.remove(b.refs.group);
    try {
      b.refs.bodyMat.dispose();
      b.refs.baseMat.dispose();
      b.refs.headMat.dispose();
      if (b.refs.hpBg !== null) (b.refs.hpBg.material as THREE.Material).dispose();
      if (b.refs.hpFg !== null) (b.refs.hpFg.material as THREE.Material).dispose();
      if (b.refs.glow !== null) (b.refs.glow.material as THREE.Material).dispose();
    } catch { /* ignore */ }
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

  /** Death burst: 8 pooled particles with gravity + additive fade. */
  deathBurst(x: number, y: number, color = 0xffd27f, z?: number) {
    if (this.bursts === null) return;
    const gz = (z ?? this.terrain?.tileHeightAt(x, y) ?? 0) * TERRAIN_Z_SCALE;
    this.bursts.burst(x, gz, y, color, 8);
  }

  /** Level-up beam at a world position (reuses the single beam mesh). */
  levelUp(x: number, y: number, z?: number) {
    if (this.beam === null) return;
    const gz = (z ?? this.terrain?.tileHeightAt(x, y) ?? 0) * TERRAIN_Z_SCALE;
    triggerLevelBeam(this.beam, x, gz, y);
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
        if (!b.isLocal && b.kind === kind) {
          b.baseColor = c;
          b.teamColor = c;
        }
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
    // the defaults. A soft additive outer glow rides along for readability.
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
    const glow = createTelegraphGlow(this.teleRing);
    glow.position.y = 0.01;
    g.add(ring, disc, glow);
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
          if ((mesh as unknown as { isMesh?: boolean }).isMesh) {
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

  /**
   * Hit-stop freeze (server `hit-stop` on kills, 90ms). While frozen, update()
   * returns immediately so the last frame persists — camera, particles, flashes
   * and telegraphs all pause. Callers gate on the reduced-motion setting (no
   * freeze when reduced motion is on); pass an explicit `nowMs` in tests.
   */
  hitStop(durationMs = 90, nowMs?: number) {
    if (!(durationMs > 0)) return;
    const t = nowMs ?? performance.now();
    if (!Number.isFinite(t)) return;
    this.hitStopUntil = Math.max(this.hitStopUntil, t + durationMs);
  }

  /** True while a hit-stop freeze covers `nowMs` (defaults to now). */
  isHitStopped(nowMs?: number): boolean {
    const t = nowMs ?? performance.now();
    return Number.isFinite(t) && t < this.hitStopUntil;
  }

  /**
   * Record a kill position as a floor blood splat (flat dark-red disc that
   * fades over BLOOD_TTL_MS). Keeps the last BLOOD_MAX; non-finite input is
   * ignored. Meshes are shared-geometry circles with per-splat materials so
   * fading never touches another splat.
   */
  addBlood(x: number, y: number, nowMs?: number) {
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    const t = nowMs ?? performance.now();
    if (!Number.isFinite(t)) return;
    const gz = (this.terrain?.tileHeightAt(x, y) ?? 0) * TERRAIN_Z_SCALE;
    const mesh = new THREE.Mesh(
      new THREE.CircleGeometry(0.45, 20),
      new THREE.MeshBasicMaterial({ color: 0x8a1420, transparent: true, opacity: 0.55, depthWrite: false }),
    );
    mesh.rotation.x = -Math.PI / 2;
    mesh.position.set(x, gz + 0.03, y);
    mesh.renderOrder = 1;
    this.scene.add(mesh);
    this.blood.push({ x, y, t0: t, mesh });
    while (this.blood.length > BLOOD_MAX) {
      const old = this.blood.shift();
      if (old) {
        this.scene.remove(old.mesh);
        old.mesh.geometry.dispose();
        (old.mesh.material as THREE.Material).dispose();
      }
    }
  }

  /** Live blood splat count (tests + cap pinning). */
  bloodCount(): number {
    return this.blood.length;
  }

  /** Mark an entity downed (crawl state) via the server `mob-downed` event. */
  markDowned(id: number) {
    if (Number.isInteger(id)) this.downedIds.add(id);
  }

  /** Clear a downed mark (`mob-up` recovery or `mob-die` finish). */
  clearDowned(id: number) {
    this.downedIds.delete(id);
  }

  /** True while the entity renders in the crawl state. */
  isDowned(id: number): boolean {
    return this.downedIds.has(id);
  }

  project(x: number, y: number, z?: number): { sx: number; sy: number } {
    const v = this.scratchOut;
    v.set(x, (z ?? 0) * TERRAIN_Z_SCALE + 1.6, y).project(this.camera);
    const w = this.container.clientWidth || 960, h = this.container.clientHeight || 600;
    return { sx: ((v.x + 1) / 2) * w, sy: ((1 - v.y) / 2) * h };
  }

  screenToWorld(sx: number, sy: number): { x: number; y: number } {
    try {
      const rect = (this.renderer.domElement as unknown as {
        getBoundingClientRect?: () => { left: number; top: number; width: number; height: number };
      }).getBoundingClientRect?.();
      if (!rect) return { x: this.target.x, y: this.target.z };
      const nx = ((sx - rect.left) / Math.max(1, rect.width)) * 2 - 1;
      const ny = -(((sy - rect.top) / Math.max(1, rect.height)) * 2 - 1);
      this.scratchVec2.set(nx, ny);
      this.scratchRay.setFromCamera(this.scratchVec2, this.camera);
      this.scratchPlane.set(this.scratchUp, -this.groundY);
      const out = this.scratchOut;
      if (this.scratchRay.ray.intersectPlane(this.scratchPlane, out)) {
        return { x: out.x, y: out.z };
      }
    } catch { /* ignore */ }
    return { x: this.target.x, y: this.target.z };
  }

  /** Visual Y for an entity: server `z` when present, else the local field. */
  private entityZ(e: DrawEntity): number {
    if (typeof e.z === 'number' && Number.isFinite(e.z)) return zVisual(e.z);
    const tv = this.terrain;
    return tv === null ? 0 : zVisual(tv.tileHeightAt(e.x, e.y));
  }

  /** Steady-state base draw calls (ground/walls/hazards/decor/sky/sun). */
  baseDrawCalls(): number {
    let n = 0;
    if (this.hasGround) n += 2; // ground + walls
    if (this.water !== null) n += 1;
    if (this.lava !== null) n += 1;
    if (this.landmarks !== null) n += 1;
    if (this.grassMesh !== null) n += 1;
    if (this.foliageMesh !== null) n += 1;
    if (this.trunkMesh !== null) n += 1;
    if (this.rockMesh !== null) n += 1;
    if (this.sky !== null) n += 1;
    if (this.stars !== null && this.stars.visible) n += 1;
    if (this.sunSprite !== null) n += 1;
    return n;
  }

  /** Scene child count (tests pin stability across frames). */
  childCount(): number {
    return this.scene.children.length;
  }

  /** Current decoration plan (tests pin determinism). */
  decorPlanSnapshot(): DecorItem[] {
    return this.decorPlan.map((d) => ({ ...d }));
  }

  update(ents: DrawEntity[], camX: number, camY: number, timeMs: number) {
    // Hit-stop: freeze the sim — the last frame persists, nothing advances.
    if (this.isHitStopped(timeMs)) return;
    const dt = this.lastMs ? Math.min(0.1, (timeMs - this.lastMs) / 1000) : 0.016;
    this.lastMs = timeMs;
    const timeSec = timeMs / 1000;

    // Fog-of-war tinting (throttled internally to ~2Hz).
    let nowPerf = timeMs;
    try {
      nowPerf = performance.now();
    } catch { /* ignore */ }
    this.applyFog(nowPerf);

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

    // Sky dome follows the camera target so the horizon never clips.
    if (this.sky !== null) {
      this.sky.position.set(this.target.x, this.groundY, this.target.z);
      if (timeMs - this.lastSkyUpdate > 200) {
        this.lastSkyUpdate = timeMs;
        const f = daylightFactor(timeSec);
        updateSkyDome(this.sky, f, 150);
      }
    }
    if (this.stars !== null) {
      this.stars.position.set(this.target.x, this.groundY, this.target.z);
      updateStars(this.stars, daylightFactor(timeSec));
    }
    if (this.sunSprite !== null) updateSun(this.sunSprite, this.target, daylightFactor(timeSec));

    // Water shimmer + lava pulse (materials only, no new geometry).
    if (this.water !== null) {
      const m = this.water.material as THREE.MeshLambertMaterial;
      m.opacity = 0.68 + Math.sin(timeSec * 2.1) * 0.1;
    }
    if (this.lava !== null) {
      const m = this.lava.material as THREE.MeshLambertMaterial;
      m.emissiveIntensity = 0.65 + (Math.sin(timeSec * 5.2) * 0.5 + 0.5) * 0.5;
    }

    const alive = this.aliveSet;
    alive.clear();
    for (const e of ents) {
      alive.add(e.id);
      let b = this.bodies.get(e.id);
      if (!b) { b = this.makeBody(e); this.bodies.set(e.id, b); }
      // TERRAIN: stand the avatar on the ground (server `z`, else local field).
      const gz = this.entityZ(e);
      b.refs.group.position.set(e.x, gz, e.y);
      // DOWNED crawl (server `mob-downed`): flattened avatar while the crawl
      // timer runs. animateAvatar() never writes group.scale (only children),
      // so this composes with the walk bob instead of fighting it.
      if ((e.kind === 'mob' || e.kind === 'npc') && this.downedIds.has(e.id)) {
        b.refs.group.scale.set(1.25, 0.45, 1.25);
      } else if (e.kind === 'mob' || e.kind === 'npc') {
        b.refs.group.scale.set(1, 1, 1);
      }
      // Stylized locomotion: bob + lean (+ pickup spin/bob, projectile pulse).
      const isPickup = e.kind === 'pickup';
      const isProj = e.kind === 'projectile';
      animateAvatar(b.refs, e.kind, timeSec, dt, isPickup, isProj);
      // Fog-of-war: avatars beyond 25m from the follow target go dark, and
      // avatars in never-explored ground fade out almost entirely.
      let dim = 1;
      if (!e.isLocal) {
        const tier = this.fog ? this.fogTierAt(e.x, e.y) : (Math.hypot(e.x - this.target.x, e.y - this.target.z) > FOG_RADIUS ? 1 : 0);
        dim = tier === 0 ? 1 : tier === 1 ? 0.45 : 0.15;
      }
      b.refs.bodyMat.color.setHex(b.baseColor).multiplyScalar(dim);
      b.refs.baseMat.color.setHex(b.teamColor).multiplyScalar(dim);
      b.refs.headMat.color.setHex(0xf2c89b).multiplyScalar(dim);
      // Projectile tracers: additive glow + periodic ember trail.
      if (isProj) {
        b.refs.body.rotation.y += dt * 6;
        if (this.bursts !== null && timeMs - b.refs.trailT > 90) {
          b.refs.trailT = timeMs;
          this.bursts.ember(e.x, gz, e.y, b.baseColor);
        }
      }
      if (!isPickup && !isProj && b.refs.hpFg !== null && b.refs.hpBg !== null) {
        const frac = e.maxHp > 0 ? Math.max(0, e.hp / e.maxHp) : 0;
        b.refs.hpFg.scale.set(1.2 * frac, 0.12, 1);
        (b.refs.hpFg.material as THREE.SpriteMaterial).color.set(frac > 0.5 ? 0x51ff7a : frac > 0.25 ? 0xffb84d : 0xff5252);
        const hpDim = 0.35 + 0.65 * dim;
        (b.refs.hpBg.material as THREE.SpriteMaterial).opacity = hpDim;
        (b.refs.hpFg.material as THREE.SpriteMaterial).opacity = hpDim;
      }
      b.lastBX = e.x;
      b.lastBZ = e.y;
    }
    // Removals double as deaths: pop a pooled burst at the last position.
    this.removeIds.length = 0;
    for (const [id, b] of this.bodies) {
      if (alive.has(id)) continue;
      this.removeIds.push(id);
    }
    for (let i = 0; i < this.removeIds.length; i++) {
      const id = this.removeIds[i]!;
      const b = this.bodies.get(id);
      if (!b) continue;
      if (b.kind === 'mob' || b.kind === 'player' || b.kind === 'npc') {
        this.deathBurst(b.lastBX, b.lastBZ, b.baseColor);
      } else if (b.kind === 'projectile' || b.kind === 'pickup') {
        this.deathBurst(b.lastBX, b.lastBZ, 0xfff2b0);
      }
      this.disposeBody(b);
      this.bodies.delete(id);
    }

    // Pooled particles + beam (no per-frame allocation).
    this.bursts?.update(dt);
    if (this.bursts !== null) {
      const anyAlive = this.bursts.alive() > 0;
      this.bursts.points.visible = anyAlive;
    }
    if (this.beam !== null) updateLevelBeam(this.beam, dt);

    // Lava flicker light follows the local player when lava is near.
    if (this.lavaLight !== null) {
      let lx = this.target.x;
      let lz = this.target.z;
      let ly = this.groundY;
      for (const b of this.bodies.values()) {
        if (b.isLocal) {
          lx = b.refs.group.position.x;
          lz = b.refs.group.position.z;
          ly = b.refs.group.position.y;
          break;
        }
      }
      if (timeMs - this.lavaNearCheckedAt > 400) {
        this.lavaNearCheckedAt = timeMs;
        this.lavaNear = false;
        if (this.terrain !== null && this.lavaPos.length > 0) {
          const R = 7;
          const cx = Math.floor(lx);
          const cy = Math.floor(lz);
          outer: for (let ty = cy - R; ty <= cy + R; ty++) {
            for (let tx = cx - R; tx <= cx + R; tx++) {
              if (tx < 0 || ty < 0 || tx >= ARENA || ty >= ARENA) continue;
              try {
                if (this.terrain.kindAtTile(tx, ty) === TERR_LAVA) {
                  this.lavaNear = true;
                  break outer;
                }
              } catch { /* ignore */ }
            }
          }
        }
      }
      if (this.lavaNear) {
        this.lavaLight.visible = true;
        this.lavaLight.position.set(lx, ly + 2.2, lz);
        this.lavaLight.intensity = 1.4 + Math.sin(timeSec * 11) * 0.45 + Math.sin(timeSec * 23.7) * 0.25;
      } else {
        this.lavaLight.visible = false;
        this.lavaLight.intensity = 0;
      }
    }

    // Blood decals fade over BLOOD_TTL_MS, then are pruned (geometry disposed).
    for (let i = this.blood.length - 1; i >= 0; i--) {
      const s = this.blood[i]!;
      const age = timeMs - s.t0;
      if (age >= BLOOD_TTL_MS) {
        this.scene.remove(s.mesh);
        s.mesh.geometry.dispose();
        (s.mesh.material as THREE.Material).dispose();
        this.blood.splice(i, 1);
        continue;
      }
      (s.mesh.material as THREE.MeshBasicMaterial).opacity = 0.55 * (1 - Math.max(0, age) / BLOOD_TTL_MS);
    }

    // Flashes decay (backwards splice — no new array per frame).
    for (let i = this.flashes.length - 1; i >= 0; i--) {
      const f = this.flashes[i]!;
      f.life -= dt;
      const t = Math.max(0, f.life / f.max);
      f.m.scale.setScalar(1 + (1 - t) * 2.2);
      (f.m.material as THREE.MeshBasicMaterial).opacity = t * 0.9;
      if (f.life <= 0) {
        this.scene.remove(f.m);
        f.m.geometry.dispose();
        f.m.material.dispose();
        this.flashes.splice(i, 1);
      }
    }

    // Telegraph rings expand over their windup, then flash once.
    for (let i = this.tele.length - 1; i >= 0; i--) {
      const t = this.tele[i]!;
      const frac = (nowPerf - t.t0) / Math.max(1, t.ttl);
      if (frac >= 1) {
        this.scene.remove(t.g);
        t.g.traverse((o) => {
          const mesh = o as THREE.Mesh;
          if ((mesh as unknown as { isMesh?: boolean }).isMesh) {
            mesh.geometry.dispose();
            (mesh.material as THREE.Material)?.dispose();
          }
        });
        this.tele.splice(i, 1);
        this.flash(t.x, t.y, 0xff3030);
        continue;
      }
      const f = Math.max(0, Math.min(1, frac));
      t.g.scale.setScalar(Math.max(0.05, t.r * (0.15 + 0.85 * f)));
      const ring = t.g.children[0] as THREE.Mesh<THREE.CircleGeometry, THREE.MeshBasicMaterial> | undefined;
      const disc = t.g.children[1] as THREE.Mesh<THREE.CircleGeometry, THREE.MeshBasicMaterial> | undefined;
      const glow = t.g.children[2] as THREE.Mesh<THREE.RingGeometry, THREE.MeshBasicMaterial> | undefined;
      if (ring) (ring.material as THREE.MeshBasicMaterial).opacity = 0.55 + 0.45 * f;
      if (disc) (disc.material as THREE.MeshBasicMaterial).opacity = 0.06 + 0.16 * f;
      if (glow) (glow.material as THREE.MeshBasicMaterial).opacity = 0.12 + 0.22 * f;
    }

    // Day/night lerp: sun + ambient + background, warm at dawn/dusk.
    const f = daylightFactor(timeSec);
    this.sun.intensity = 0.25 + 1.15 * f;
    this.sun.color.copy(this.sunWarm).lerp(this.sunNoon, Math.min(1, f * 1.2));
    this.amb.intensity = 0.35 + 0.45 * f;
    this.hemi.intensity = 0.15 + 0.35 * f;
    this.bg.copy(this.night).lerp(this.day, f);

    try {
      this.renderer.render(this.scene, this.camera);
    } catch { /* headless stub render is a no-op */ }
  }
}

// Re-export art-test surface so render tests pin determinism without
// importing scene_art directly (keeps the old import graph working).
export { decorMatrices, planDecorations };
export type { DecorItem };
export { avatarVariant, tileShade, hash2i };
export { blobShadowTexture, glowTexture, tileEdgeTexture };
