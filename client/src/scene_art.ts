// AETHERFALL client — procedural stylized art helpers (no assets, no deps).
//
// Everything here is built from three.js primitives + canvas textures:
// low-poly avatars, instanced decorations, gradient sky, stars, sun sprite,
// pooled combat particles and glow sprites. All randomness is seeded and
// deterministic so headless tests can pin it.
//
// The frame loop must never allocate: shared geometries / textures are
// singletons, and every per-frame update writes into preallocated buffers.
// See renderer3d.ts for the wiring (draw calls, fog tinting, quality hooks).

import * as THREE from 'three';
import { TERR_LAVA, TERR_WATER, zVisual } from './terrain_view.js';

// ---------------------------------------------------------------------------
// Deterministic hashing + tile shading
// ---------------------------------------------------------------------------

/** Integer lattice hash -> [0, 1). Mirrors engine hash2, standalone. */
export function hash2i(ix: number, iy: number, seed: number): number {
  let h = seed >>> 0;
  h = Math.imul(h ^ (ix >>> 0), 374761393);
  h = Math.imul(h ^ (iy >>> 0), 668265263);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

/**
 * Two-tone checker brightness with seeded per-tile noise. Stable for a tile:
 * the same (x, y, seed) always returns the same multiplier (~0.87..1.06).
 */
export function tileShade(tx: number, ty: number, seed: number): number {
  const checker = ((tx + ty) & 1) === 0 ? 1.0 : 0.93;
  const n = hash2i(tx, ty, seed);
  return checker * (0.94 + 0.12 * n);
}

/** Biome tint multiplied over the green base (hex). */
export function biomeTint(biome: string): number {
  switch (biome) {
    case 'beach': return 0xd9c28a;
    case 'desert': return 0xe0c080;
    case 'forest': return 0x8fce8f;
    case 'mountain': return 0xb8bcc4;
    case 'snow': return 0xe8f0ff;
    case 'ocean': return 0x9fb6c9;
    default: return 0xffffff; // plains / meadow neutral
  }
}

/** Decoration density multiplier per overworld zone. */
export function zoneDensity(zone: string): number {
  if (zone === 'dungeon') return 0.3;
  if (zone === 'volcano') return 0.22;
  return 1;
}

/** True for Elder Maren-type quest-giver names (wizard hat rule). */
export function isMarenName(name: string): boolean {
  return /maren/i.test(name ?? '');
}

export type AvatarVariant = 'sword' | 'staff' | 'hat-staff' | 'none';

/** Weapon / hat variant for an entity kind + display name. */
export function avatarVariant(kind: string, name: string): AvatarVariant {
  if (kind === 'pickup' || kind === 'projectile') return 'none';
  if (isMarenName(name)) return 'hat-staff';
  if (kind === 'npc') return 'staff';
  return 'sword';
}

// ---------------------------------------------------------------------------
// Shared geometries (singletons — one GPU upload each)
// ---------------------------------------------------------------------------

export interface SharedGeos {
  body: THREE.CylinderGeometry;
  head: THREE.SphereGeometry;
  visor: THREE.BoxGeometry;
  base: THREE.CylinderGeometry;
  sword: THREE.BoxGeometry;
  staff: THREE.CylinderGeometry;
  hat: THREE.ConeGeometry;
  shadowPlane: THREE.PlaneGeometry;
  grassBlade: THREE.PlaneGeometry;
  treeFoliage: THREE.ConeGeometry;
  treeTrunk: THREE.CylinderGeometry;
  rock: THREE.DodecahedronGeometry;
  beam: THREE.CylinderGeometry;
  projCore: THREE.OctahedronGeometry;
  pickupCore: THREE.OctahedronGeometry;
}

let geosCache: SharedGeos | null = null;

/** Shared low-poly geometries. Geometries are reused across every avatar. */
export function sharedGeos(): SharedGeos {
  if (geosCache !== null) return geosCache;
  const body = new THREE.CylinderGeometry(0.26, 0.44, 1.15, 6);
  const head = new THREE.SphereGeometry(0.27, 8, 6);
  const visor = new THREE.BoxGeometry(0.42, 0.13, 0.12);
  const base = new THREE.CylinderGeometry(0.55, 0.62, 0.08, 16);
  const sword = new THREE.BoxGeometry(0.09, 0.95, 0.18);
  const staff = new THREE.CylinderGeometry(0.05, 0.05, 1.25, 6);
  const hat = new THREE.ConeGeometry(0.32, 0.62, 8);
  const shadowPlane = new THREE.PlaneGeometry(1.15, 1.15);
  const grassBlade = new THREE.PlaneGeometry(0.7, 0.55);
  grassBlade.translate(0, 0.27, 0);
  const treeFoliage = new THREE.ConeGeometry(0.62, 1.35, 6);
  treeFoliage.translate(0, 1.15, 0);
  const treeTrunk = new THREE.CylinderGeometry(0.11, 0.14, 0.6, 6);
  treeTrunk.translate(0, 0.3, 0);
  const rock = new THREE.DodecahedronGeometry(0.38, 0);
  const beam = new THREE.CylinderGeometry(0.55, 0.95, 3.2, 10, 1, true);
  const projCore = new THREE.OctahedronGeometry(0.22, 0);
  const pickupCore = new THREE.OctahedronGeometry(0.3, 0);
  geosCache = {
    body, head, visor, base, sword, staff, hat, shadowPlane,
    grassBlade, treeFoliage, treeTrunk, rock, beam, projCore, pickupCore,
  };
  return geosCache;
}

/** Test hook: drop cached geometries so suites start from a clean slate. */
export function resetSharedGeosForTest(): void {
  geosCache = null;
}

// ---------------------------------------------------------------------------
// Procedural canvas textures (guarded for headless node)
// ---------------------------------------------------------------------------

function makeCanvas(w: number, h: number): HTMLCanvasElement | null {
  try {
    if (typeof document === 'undefined') return null;
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    return c;
  } catch {
    return null;
  }
}

function dataTextureFallback(r: number, g: number, b: number): THREE.DataTexture {
  const data = new Uint8Array([r, g, b, 255, r, g, b, 255, r, g, b, 255, r, g, b, 255]);
  const t = new THREE.DataTexture(data, 2, 2);
  t.needsUpdate = true;
  return t;
}

let blobCache: THREE.Texture | null = null;
/** Soft dark blob for ground shadows (radial gradient, transparent edge). */
export function blobShadowTexture(): THREE.Texture {
  if (blobCache !== null) return blobCache;
  try {
    const c = makeCanvas(64, 64);
    if (c === null) throw new Error('no-canvas');
    const ctx = c.getContext('2d') as unknown as {
      createRadialGradient?: (...a: number[]) => { addColorStop(c: number, s: string): void };
      fillRect?: (...a: number[]) => void;
      fillStyle?: unknown;
    } | null;
    if (ctx === null || typeof ctx.createRadialGradient !== 'function') throw new Error('no-2d');
    const g = ctx.createRadialGradient(32, 32, 4, 32, 32, 30);
    g.addColorStop(0, 'rgba(0,0,0,0.55)');
    g.addColorStop(0.6, 'rgba(0,0,0,0.32)');
    g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g;
    ctx.fillRect?.(0, 0, 64, 64);
    blobCache = new THREE.CanvasTexture(c);
    return blobCache;
  } catch {
    blobCache = dataTextureFallback(0, 0, 0);
    return blobCache;
  }
}

let glowCache: THREE.Texture | null = null;
/** Soft white radial glow (tinted per-sprite via material color). */
export function glowTexture(): THREE.Texture {
  if (glowCache !== null) return glowCache;
  try {
    const c = makeCanvas(64, 64);
    if (c === null) throw new Error('no-canvas');
    const ctx = c.getContext('2d') as unknown as {
      createRadialGradient?: (...a: number[]) => { addColorStop(c: number, s: string): void };
      fillRect?: (...a: number[]) => void;
      fillStyle?: unknown;
    } | null;
    if (ctx === null || typeof ctx.createRadialGradient !== 'function') throw new Error('no-2d');
    const g = ctx.createRadialGradient(32, 32, 2, 32, 32, 30);
    g.addColorStop(0, 'rgba(255,255,255,1)');
    g.addColorStop(0.35, 'rgba(255,255,255,0.5)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g;
    ctx.fillRect?.(0, 0, 64, 64);
    glowCache = new THREE.CanvasTexture(c);
    return glowCache;
  } catch {
    glowCache = dataTextureFallback(255, 255, 255);
    return glowCache;
  }
}

let edgeCache: THREE.Texture | null = null;
/**
 * Tile edge darkening texture: white centre, subtle dark border + speckle.
 * Multiplied by the per-instance color so every ground tile reads as a
 * separate low-poly facet with biome-tinted edges.
 */
export function tileEdgeTexture(): THREE.Texture {
  if (edgeCache !== null) return edgeCache;
  try {
    const c = makeCanvas(64, 64);
    if (c === null) throw new Error('no-canvas');
    const ctx = c.getContext('2d') as unknown as {
      fillRect?: (...a: number[]) => void;
      strokeRect?: (...a: number[]) => void;
      fillStyle?: unknown;
      strokeStyle?: unknown;
      lineWidth?: number;
    } | null;
    if (ctx === null || typeof ctx.fillRect !== 'function') throw new Error('no-2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, 64, 64);
    // Speckle for a hand-painted feel (deterministic pattern, not random).
    ctx.fillStyle = 'rgba(0,0,0,0.05)';
    for (let i = 0; i < 24; i++) {
      const x = (i * 37) % 60 + 2;
      const y = (i * 53) % 60 + 2;
      ctx.fillRect(x, y, 2, 2);
    }
    if (typeof ctx.strokeRect === 'function') {
      ctx.strokeStyle = 'rgba(0,0,0,0.22)';
      ctx.lineWidth = 4;
      ctx.strokeRect(0, 0, 64, 64);
      ctx.strokeStyle = 'rgba(255,255,255,0.25)';
      ctx.lineWidth = 1;
      ctx.strokeRect(4, 4, 56, 56);
    }
    edgeCache = new THREE.CanvasTexture(c);
    return edgeCache;
  } catch {
    edgeCache = dataTextureFallback(255, 255, 255);
    return edgeCache;
  }
}

// ---------------------------------------------------------------------------
// Avatars — grouped low-poly characters
// ---------------------------------------------------------------------------

export interface AvatarRefs {
  group: THREE.Group;
  body: THREE.Mesh;
  head: THREE.Mesh;
  visor: THREE.Mesh | null;
  weapon: THREE.Mesh | null;
  hat: THREE.Mesh | null;
  baseDisc: THREE.Mesh;
  shadow: THREE.Mesh;
  glow: THREE.Sprite | null;
  hpBg: THREE.Sprite | null;
  hpFg: THREE.Sprite | null;
  bodyMat: THREE.MeshLambertMaterial;
  baseMat: THREE.MeshLambertMaterial;
  headMat: THREE.MeshLambertMaterial;
  lastX: number;
  lastZ: number;
  bobPhase: number;
  trailT: number;
}

const SKIN = 0xf2c89b;
const VISOR = 0x1a2430;

let shadowMatCache: THREE.MeshBasicMaterial | null = null;
function sharedShadowMat(): THREE.MeshBasicMaterial {
  if (shadowMatCache !== null) return shadowMatCache;
  shadowMatCache = new THREE.MeshBasicMaterial({
    map: blobShadowTexture(),
    transparent: true,
    depthWrite: false,
  });
  return shadowMatCache;
}

let visorMatCache: THREE.MeshBasicMaterial | null = null;
function sharedVisorMat(): THREE.MeshBasicMaterial {
  if (visorMatCache !== null) return visorMatCache;
  visorMatCache = new THREE.MeshBasicMaterial({ color: VISOR });
  return visorMatCache;
}

let weaponMatCache: THREE.MeshLambertMaterial | null = null;
function sharedWeaponMat(): THREE.MeshLambertMaterial {
  if (weaponMatCache !== null) return weaponMatCache;
  weaponMatCache = new THREE.MeshLambertMaterial({ color: 0xcfd6e4 });
  return weaponMatCache;
}

let staffMatCache: THREE.MeshLambertMaterial | null = null;
function sharedStaffMat(): THREE.MeshLambertMaterial {
  if (staffMatCache !== null) return staffMatCache;
  staffMatCache = new THREE.MeshLambertMaterial({ color: 0x7a5a36 });
  return staffMatCache;
}

let hatMatCache: THREE.MeshLambertMaterial | null = null;
function sharedHatMat(): THREE.MeshLambertMaterial {
  if (hatMatCache !== null) return hatMatCache;
  hatMatCache = new THREE.MeshLambertMaterial({ color: 0x6a4fd0 });
  return hatMatCache;
}

/**
 * Build a low-poly character group. Geometries are shared singletons;
 * materials carrying the per-instance color are fresh per avatar.
 */
export function createAvatar(opts: {
  kind: string;
  name: string;
  baseColor: number;
  teamColor: number;
  isLocal: boolean;
}): AvatarRefs {
  const G = sharedGeos();
  const group = new THREE.Group();
  const variant = avatarVariant(opts.kind, opts.name);
  const isPickup = opts.kind === 'pickup';
  const isProj = opts.kind === 'projectile';

  const bodyMat = new THREE.MeshLambertMaterial({ color: opts.baseColor });
  if (opts.isLocal) bodyMat.emissive = new THREE.Color(0x0d3a1e);
  const baseMat = new THREE.MeshLambertMaterial({ color: opts.teamColor });
  const headMat = new THREE.MeshLambertMaterial({ color: SKIN });

  // Team base disc.
  const baseDisc = new THREE.Mesh(G.base, baseMat);
  baseDisc.position.y = 0.04;
  group.add(baseDisc);

  let body: THREE.Mesh;
  if (isPickup) {
    body = new THREE.Mesh(G.pickupCore, bodyMat);
    body.position.y = 0.55;
    body.scale.setScalar(1);
  } else if (isProj) {
    body = new THREE.Mesh(G.projCore, bodyMat);
    body.position.y = 0.7;
  } else {
    body = new THREE.Mesh(G.body, bodyMat);
    body.position.y = 0.65;
  }
  group.add(body);

  let head: THREE.Mesh;
  let visor: THREE.Mesh | null = null;
  let weapon: THREE.Mesh | null = null;
  let hat: THREE.Mesh | null = null;
  if (!isPickup && !isProj) {
    head = new THREE.Mesh(G.head, headMat);
    head.position.y = 1.45;
    group.add(head);
    visor = new THREE.Mesh(G.visor, sharedVisorMat());
    visor.position.set(0, 1.47, 0.22);
    group.add(visor);
    if (variant === 'sword') {
      weapon = new THREE.Mesh(G.sword, sharedWeaponMat());
      weapon.position.set(0.5, 0.85, 0.1);
      weapon.rotation.z = -0.35;
      group.add(weapon);
    } else if (variant === 'staff' || variant === 'hat-staff') {
      weapon = new THREE.Mesh(G.staff, sharedStaffMat());
      weapon.position.set(0.5, 0.9, 0.1);
      weapon.rotation.z = 0.12;
      group.add(weapon);
    }
    if (variant === 'hat-staff') {
      hat = new THREE.Mesh(G.hat, sharedHatMat());
      hat.position.y = 1.95;
      hat.rotation.y = 0.4;
      group.add(hat);
    }
  } else {
    // Pickups / projectiles still carry a head slot (unused) for a uniform
    // refs shape — a zero-scale placeholder that costs no draw call.
    head = new THREE.Mesh(G.head, headMat);
    head.scale.setScalar(0);
    head.visible = false;
    group.add(head);
  }

  // Blob shadow: flat dark disc that stays on the floor while the body bobs.
  const shadow = new THREE.Mesh(G.shadowPlane, sharedShadowMat());
  shadow.rotation.x = -Math.PI / 2;
  shadow.position.y = 0.03;
  shadow.renderOrder = 1;
  group.add(shadow);

  // Glow sprite for pickups / projectiles (additive, shared texture).
  let glow: THREE.Sprite | null = null;
  if (isPickup || isProj) {
    glow = new THREE.Sprite(new THREE.SpriteMaterial({
      map: glowTexture(),
      color: opts.baseColor,
      transparent: true,
      opacity: isPickup ? 0.55 : 0.8,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    }));
    glow.scale.set(isPickup ? 1.4 : 1.1, isPickup ? 1.4 : 1.1, 1);
    glow.position.y = 0.6;
    group.add(glow);
  }

  // HP bar sprites for characters only.
  let hpBg: THREE.Sprite | null = null;
  let hpFg: THREE.Sprite | null = null;
  if (!isPickup && !isProj) {
    hpBg = new THREE.Sprite(new THREE.SpriteMaterial({ color: 0x1a1214, depthTest: false }));
    hpBg.scale.set(1.3, 0.16, 1);
    hpBg.position.y = 2.15;
    hpFg = new THREE.Sprite(new THREE.SpriteMaterial({ color: 0x51ff7a, depthTest: false }));
    hpFg.center.set(0, 0.5);
    hpFg.scale.set(1.2, 0.12, 1);
    hpFg.position.set(-0.6, 2.15, 0);
    group.add(hpBg, hpFg);
  }

  // Deterministic bob phase from the group position hash (set on first move).
  const refs: AvatarRefs = {
    group, body, head, visor, weapon, hat, baseDisc, shadow, glow,
    hpBg, hpFg, bodyMat, baseMat, headMat,
    lastX: 0, lastZ: 0, bobPhase: 0, trailT: 0,
  };
  return refs;
}

// Scratch for avatar animation (no per-frame allocation).
const animTmp = { lean: 0, bob: 0, dx: 0, dz: 0, speed: 0 };

/**
 * Walk bob + lean + pickup/projectile idle motion. Writes directly into the
 * group's children; allocates nothing. `moving` gates the lean so idle
 * characters stand straight while still breathing (small bob).
 */
export function animateAvatar(
  refs: AvatarRefs,
  kind: string,
  timeSec: number,
  dt: number,
  isPickup: boolean,
  isProjectile: boolean,
): void {
  const g = refs.group;
  animTmp.dx = g.position.x - refs.lastX;
  animTmp.dz = g.position.z - refs.lastZ;
  const dist = Math.sqrt(animTmp.dx * animTmp.dx + animTmp.dz * animTmp.dz);
  animTmp.speed = dt > 0 ? dist / dt : 0;
  refs.lastX = g.position.x;
  refs.lastZ = g.position.z;

  if (isPickup) {
    refs.body.position.y = 0.55 + Math.sin(timeSec * 3 + refs.bobPhase) * 0.15;
    refs.body.rotation.y += dt * 1.6;
    if (refs.glow !== null) {
      const s = 1.3 + Math.sin(timeSec * 3 + refs.bobPhase) * 0.15;
      refs.glow.scale.set(s, s, 1);
    }
    return;
  }
  if (isProjectile) {
    const p = 1 + Math.sin(timeSec * 18) * 0.12;
    refs.body.scale.set(p, 1, p);
    if (refs.glow !== null) {
      const s = 1.05 + Math.sin(timeSec * 18) * 0.12;
      refs.glow.scale.set(s, s, 1);
    }
    return;
  }
  // Characters: walk bob at stride frequency, lean into motion.
  const stride = Math.min(1, animTmp.speed / 6);
  refs.bobPhase += dt * (4 + 7 * stride);
  animTmp.bob = Math.sin(refs.bobPhase) * (0.03 + 0.07 * stride);
  refs.body.position.y = 0.65 + animTmp.bob;
  refs.head.position.y = 1.45 + animTmp.bob * 1.2;
  if (refs.visor !== null) refs.visor.position.y = 1.47 + animTmp.bob * 1.2;
  if (refs.hat !== null) refs.hat.position.y = 1.95 + animTmp.bob * 1.2;
  // Lean: tilt toward travel direction (clamped, smoothed by direct set).
  const leanAmt = Math.min(0.3, animTmp.speed * 0.045);
  if (dist > 1e-6) {
    animTmp.lean = leanAmt;
    g.rotation.x = (animTmp.dz / dist) * animTmp.lean;
    g.rotation.z = -(animTmp.dx / dist) * animTmp.lean;
  } else {
    g.rotation.x *= 0.85;
    g.rotation.z *= 0.85;
  }
}

// ---------------------------------------------------------------------------
// Decorations — deterministic scatter, capped, instanced
// ---------------------------------------------------------------------------

export type DecorKind = 'grass' | 'tree' | 'rock';

export interface DecorTerrain {
  kindAtTile(tx: number, ty: number): number;
  heightAtTile(tx: number, ty: number): number;
  slopeFromGrid(tx: number, ty: number): number;
  biomeAtTile?(tx: number, ty: number): string;
  zoneAtTile?(tx: number, ty: number): string;
}

export interface DecorItem {
  tx: number;
  ty: number;
  x: number;
  y: number;
  z: number;
  kind: DecorKind;
  scale: number;
  rotY: number;
  tint: number;
  hash: number;
}

export const DECOR_CAP = 400;
export const DECOR_ARENA = 100;

/**
 * Deterministic decoration scatter. Same terrain + seed + caps always yields
 * the same items in the same order (hash-sorted, then truncated, then
 * position-sorted). Pure: no THREE allocation, headless-safe.
 */
export function planDecorations(
  terrain: DecorTerrain | null,
  seed: number,
  maxTotal = DECOR_CAP,
  densityScale = 1,
  isWall?: (tx: number, ty: number) => boolean,
): DecorItem[] {
  const effectiveMax = Math.max(0, Math.min(maxTotal, Math.floor(maxTotal * densityScale)));
  if (effectiveMax === 0) return [];
  const out: DecorItem[] = [];
  for (let ty = 0; ty < DECOR_ARENA; ty++) {
    for (let tx = 0; tx < DECOR_ARENA; tx++) {
      const h1 = hash2i(tx, ty, seed);
      const h2 = hash2i(tx + 7919, ty + 104729, seed ^ 0x9e37);
      const h3 = hash2i(tx - 31, ty + 17, seed ^ 0x51f3);
      let kind = TERR_WATER; // placeholder, replaced below
      let slope = 0;
      let height = 0;
      let biome = 'plains';
      let zone = 'meadow';
      if (terrain !== null) {
        kind = terrain.kindAtTile(tx, ty);
        if (kind !== 0) continue; // hazard: no decor
        slope = terrain.slopeFromGrid(tx, ty);
        height = terrain.heightAtTile(tx, ty);
        try {
          biome = terrain.biomeAtTile !== undefined ? terrain.biomeAtTile(tx, ty) : 'plains';
        } catch { biome = 'plains'; }
        try {
          zone = terrain.zoneAtTile !== undefined ? terrain.zoneAtTile(tx, ty) : 'meadow';
        } catch { zone = 'meadow'; }
      } else {
        // Flat-arena fallback (tests): treat everything as meadow grassland.
        kind = 0;
      }
      if (isWall !== undefined) {
        try { if (isWall(tx, ty)) continue; } catch { /* ignore */ }
      }
      const steep = slope > 1.6;
      const high = height > 30;
      // Base probabilities (meadow).
      let pTree = 0.03;
      let pRock = 0.022;
      let pGrass = 0.085;
      const zd = zoneDensity(zone);
      pTree *= zd;
      pGrass *= zd;
      pRock *= zone === 'meadow' ? 1 : 0.6;
      // Biome adjustments.
      if (biome === 'forest') { pTree *= 1.8; pGrass *= 1.3; }
      else if (biome === 'desert') { pTree *= 0.3; pGrass *= 0.4; }
      else if (biome === 'snow' || biome === 'mountain') { pTree *= 0.3; pGrass *= 0.2; pRock *= 1.5; }
      else if (biome === 'beach') { pGrass *= 0.5; pTree *= 0.4; }
      if (steep) { pTree = 0; pGrass = 0; }
      if (high) { pTree = 0; pGrass = 0; }
      let pick: DecorKind | null = null;
      if (h1 < pTree) pick = 'tree';
      else if (h1 < pTree + pRock) pick = 'rock';
      else if (h1 < pTree + pRock + pGrass) pick = 'grass';
      if (pick === null) continue;
      const scale = 0.7 + h2 * 0.7;
      const rotY = h3 * Math.PI * 2;
      const jx = (hash2i(tx * 2 + 1, ty, seed) - 0.5) * 0.6;
      const jy = (hash2i(tx, ty * 2 + 1, seed ^ 0x1234) - 0.5) * 0.6;
      let tint = 0xffffff;
      if (pick === 'grass') tint = h2 < 0.5 ? 0x4fae4f : 0x63c05e;
      else if (pick === 'tree') tint = h2 < 0.5 ? 0x2f7d3a : 0x3d9950;
      else tint = h2 < 0.5 ? 0x8a8f98 : 0x6f747e;
      out.push({
        tx, ty,
        x: tx + 0.5 + jx,
        y: ty + 0.5 + jy,
        z: zVisual(height),
        kind: pick,
        scale,
        rotY,
        tint,
        hash: h1,
      });
    }
  }
  // Deterministic cap: keep the lowest-hash items (even spatial spread),
  // then re-sort by position for a stable instance order.
  out.sort((a, b) => a.hash - b.hash);
  const kept = out.length > effectiveMax ? out.slice(0, effectiveMax) : out;
  kept.sort((a, b) => (a.ty * DECOR_ARENA + a.tx) - (b.ty * DECOR_ARENA + b.tx));
  return kept;
}

/**
 * Matrices for a decoration plan as plain 16-float arrays (headless-safe).
 * Uses a scratch Object3D; allocates only the output arrays (test path, not
 * the frame loop).
 */
export function decorMatrices(plan: DecorItem[]): number[][] {
  const dummy = new THREE.Object3D();
  const out: number[][] = [];
  for (const d of plan) {
    dummy.position.set(d.x, d.z, d.y);
    dummy.rotation.set(0, d.rotY, 0);
    dummy.scale.setScalar(d.scale);
    dummy.updateMatrix();
    out.push(Array.from(dummy.matrix.elements));
  }
  return out;
}

// ---------------------------------------------------------------------------
// Sky, stars, sun
// ---------------------------------------------------------------------------

export const SKY_DAY_TOP = 0x3a7bd5;
export const SKY_DAY_BOT = 0xbfd9e8;
export const SKY_NIGHT_TOP = 0x060a1c;
export const SKY_NIGHT_BOT = 0x0e1630;

const skyTopScratch = new THREE.Color();
const skyBotScratch = new THREE.Color();
const skyMixScratch = new THREE.Color();
const skyDayTop = new THREE.Color(SKY_DAY_TOP);
const skyDayBot = new THREE.Color(SKY_DAY_BOT);
const skyNightTop = new THREE.Color(SKY_NIGHT_TOP);
const skyNightBot = new THREE.Color(SKY_NIGHT_BOT);

/** Gradient sky dome with per-vertex colors (BackSide, no fog). */
export function createSkyDome(radius = 140): THREE.Mesh {
  const geo = new THREE.SphereGeometry(radius, 16, 12);
  const count = geo.attributes.position.count;
  const colors = new Float32Array(count * 3);
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  const mat = new THREE.MeshBasicMaterial({
    vertexColors: true,
    side: THREE.BackSide,
    fog: false,
    depthWrite: false,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.renderOrder = -10;
  mesh.frustumCulled = false;
  updateSkyDome(mesh, 1, radius);
  return mesh;
}

/** Lerp the dome's vertex colors between night and day. No allocation. */
export function updateSkyDome(mesh: THREE.Mesh, dayF: number, radius = 140): void {
  const geo = mesh.geometry as THREE.BufferGeometry;
  const pos = geo.attributes.position as THREE.BufferAttribute;
  const col = geo.attributes.color as THREE.BufferAttribute | undefined;
  if (col === undefined) return;
  skyTopScratch.copy(skyNightTop).lerp(skyDayTop, dayF);
  skyBotScratch.copy(skyNightBot).lerp(skyDayBot, dayF);
  const topR = skyTopScratch.r;
  const topG = skyTopScratch.g;
  const topB = skyTopScratch.b;
  const botR = skyBotScratch.r;
  const botG = skyBotScratch.g;
  const botB = skyBotScratch.b;
  const arr = col.array as Float32Array;
  for (let i = 0; i < pos.count; i++) {
    const y = pos.getY(i);
    const t = Math.max(0, Math.min(1, (y / radius + 1) / 2));
    arr[i * 3] = botR + (topR - botR) * t;
    arr[i * 3 + 1] = botG + (topG - botG) * t;
    arr[i * 3 + 2] = botB + (topB - botB) * t;
  }
  col.needsUpdate = true;
}

/** Deterministic star field on the upper hemisphere (Points, 1 draw call). */
export function createStars(count = 220, radius = 125): THREE.Points {
  const pos = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    const a = hash2i(i, 11, 1337) * Math.PI * 2;
    const e = 0.12 + hash2i(i, 77, 7331) * 1.3; // elevation above horizon
    const r = radius * (0.92 + hash2i(i, 55, 9187) * 0.08);
    pos[i * 3] = Math.cos(a) * Math.cos(e) * r;
    pos[i * 3 + 1] = Math.sin(e) * r;
    pos[i * 3 + 2] = Math.sin(a) * Math.cos(e) * r;
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  const mat = new THREE.PointsMaterial({
    color: 0xffffff,
    size: 1.4,
    sizeAttenuation: false,
    transparent: true,
    opacity: 0,
    depthWrite: false,
    fog: false,
  });
  const pts = new THREE.Points(geo, mat);
  pts.frustumCulled = false;
  pts.renderOrder = -9;
  return pts;
}

/** Night-factor visibility for the star field. No allocation. */
export function updateStars(stars: THREE.Points, dayF: number): void {
  const mat = stars.material as THREE.PointsMaterial;
  mat.opacity = Math.max(0, (1 - dayF)) * 0.95;
  stars.visible = dayF < 0.4;
}

const sunDirScratch = new THREE.Vector3(0.55, 0.5, 0.35).normalize();
const sunWarm = new THREE.Color(0xffb36b);
const sunNoon = new THREE.Color(0xfff3d6);

/** Warm sun-disc sprite (additive glow texture). */
export function createSunSprite(): THREE.Sprite {
  const m = new THREE.SpriteMaterial({
    map: glowTexture(),
    color: 0xfff3d6,
    transparent: true,
    opacity: 0.9,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    fog: false,
  });
  const s = new THREE.Sprite(m);
  s.scale.set(24, 24, 1);
  s.renderOrder = -8;
  return s;
}

/** Track the camera target at a fixed sun offset; warm at dawn/dusk. */
export function updateSun(
  sprite: THREE.Sprite,
  target: THREE.Vector3,
  dayF: number,
): void {
  sprite.position.set(
    target.x + sunDirScratch.x * 110,
    target.y + 45,
    target.z + sunDirScratch.z * 110,
  );
  const mat = sprite.material as THREE.SpriteMaterial;
  mat.opacity = 0.2 + 0.75 * dayF;
  skyMixScratch.copy(sunWarm).lerp(sunNoon, dayF);
  mat.color.copy(skyMixScratch);
}

// ---------------------------------------------------------------------------
// Combat feel — pooled bursts, level beam, telegraph glow
// ---------------------------------------------------------------------------

/**
 * Pooled death-burst particles: one THREE.Points for every burst in the
 * scene (1 draw call). Ring buffer, preallocated, gravity + additive fade.
 */
export class BurstPool {
  readonly points: THREE.Points;
  private pos: Float32Array;
  private col: Float32Array;
  private vel: Float32Array;
  private life: Float32Array;
  private max: Float32Array;
  private base: Float32Array;
  private next = 0;
  private readonly cap: number;
  private qualityScale = 1;
  private geo: THREE.BufferGeometry;
  private tmpColor = new THREE.Color();

  constructor(capacity = 256) {
    this.cap = Math.max(8, Math.floor(capacity));
    this.pos = new Float32Array(this.cap * 3);
    this.col = new Float32Array(this.cap * 3);
    this.vel = new Float32Array(this.cap * 3);
    this.life = new Float32Array(this.cap);
    this.max = new Float32Array(this.cap);
    this.base = new Float32Array(this.cap * 3);
    for (let i = 0; i < this.cap; i++) this.pos[i * 3 + 1] = -999;
    this.geo = new THREE.BufferGeometry();
    this.geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3));
    this.geo.setAttribute('color', new THREE.BufferAttribute(this.col, 3));
    const mat = new THREE.PointsMaterial({
      size: 0.34,
      vertexColors: true,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    this.points = new THREE.Points(this.geo, mat);
    this.points.frustumCulled = false;
  }

  setQualityScale(s: number): void {
    this.qualityScale = Math.max(0.2, Math.min(1, s));
  }

  /** Spawn a death burst (8 particles). Visual-only randomness. */
  burst(x: number, y: number, z: number, hex = 0xffd27f, count = 8): void {
    const n = Math.max(1, Math.round(count * this.qualityScale));
    this.tmpColor.setHex(hex);
    for (let k = 0; k < n; k++) {
      const i = this.next;
      this.next = (this.next + 1) % this.cap;
      const b = i * 3;
      this.pos[b] = x;
      this.pos[b + 1] = y + 0.7;
      this.pos[b + 2] = z;
      const a = Math.random() * Math.PI * 2;
      const sp = 1.5 + Math.random() * 4;
      this.vel[b] = Math.cos(a) * sp;
      this.vel[b + 1] = 2.5 + Math.random() * 4;
      this.vel[b + 2] = Math.sin(a) * sp;
      const life = 0.45 + Math.random() * 0.3;
      this.life[i] = life;
      this.max[i] = life;
      this.base[b] = this.tmpColor.r;
      this.base[b + 1] = this.tmpColor.g;
      this.base[b + 2] = this.tmpColor.b;
    }
    (this.geo.attributes.position as THREE.BufferAttribute).needsUpdate = true;
  }

  /** Single ember for projectile trails (cheap, 1 slot). */
  ember(x: number, y: number, z: number, hex = 0xffe9a0): void {
    this.burst(x, y, z, hex, 1);
  }

  update(dt: number): void {
    let any = false;
    for (let i = 0; i < this.cap; i++) {
      if (this.life[i] <= 0) continue;
      any = true;
      this.life[i] -= dt;
      const b = i * 3;
      if (this.life[i] <= 0) {
        this.pos[b + 1] = -999;
        this.col[b] = 0;
        this.col[b + 1] = 0;
        this.col[b + 2] = 0;
        continue;
      }
      this.vel[b + 1] -= 9.5 * dt;
      this.pos[b] += this.vel[b] * dt;
      this.pos[b + 1] += this.vel[b + 1] * dt;
      this.pos[b + 2] += this.vel[b + 2] * dt;
      const f = this.life[i] / this.max[i];
      this.col[b] = this.base[b]! * f;
      this.col[b + 1] = this.base[b + 1]! * f;
      this.col[b + 2] = this.base[b + 2]! * f;
    }
    if (any) {
      (this.geo.attributes.position as THREE.BufferAttribute).needsUpdate = true;
      (this.geo.attributes.color as THREE.BufferAttribute).needsUpdate = true;
    }
  }

  /** Live particle count (tests). */
  alive(): number {
    let n = 0;
    for (let i = 0; i < this.cap; i++) if (this.life[i] > 0) n++;
    return n;
  }
}

/** Reusable level-up beam (single additive cylinder, hidden when idle). */
export function createLevelBeam(): THREE.Mesh {
  const G = sharedGeos();
  const mat = new THREE.MeshBasicMaterial({
    color: 0x7fe8ff,
    transparent: true,
    opacity: 0,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    side: THREE.DoubleSide,
    fog: false,
  });
  const m = new THREE.Mesh(G.beam, mat);
  m.visible = false;
  m.renderOrder = 5;
  m.userData.life = 0;
  m.userData.max = 1.2;
  return m;
}

/** Fire the beam at a world position (reuses the single mesh). */
export function triggerLevelBeam(beam: THREE.Mesh, x: number, y: number, z: number): void {
  beam.position.set(x, y + 1.6, z);
  beam.userData.life = 1.2;
  beam.userData.max = 1.2;
  beam.visible = true;
}

/** Fade + spin the beam. No allocation. */
export function updateLevelBeam(beam: THREE.Mesh, dt: number): void {
  if (!beam.visible) return;
  const life = (beam.userData.life as number) - dt;
  beam.userData.life = life;
  if (life <= 0) {
    beam.visible = false;
    (beam.material as THREE.MeshBasicMaterial).opacity = 0;
    return;
  }
  const max = beam.userData.max as number;
  (beam.material as THREE.MeshBasicMaterial).opacity = (life / max) * 0.85;
  beam.rotation.y += dt * 2.2;
  const s = 1 + (1 - life / max) * 0.35;
  beam.scale.set(s, 1, s);
}

/** Soft additive outer glow for telegraph rings (1 extra mesh per ring). */
export function createTelegraphGlow(color = 0xff3b3b): THREE.Mesh {
  const m = new THREE.Mesh(
    new THREE.RingGeometry(1.0, 1.45, 40),
    new THREE.MeshBasicMaterial({
      color,
      transparent: true,
      opacity: 0.22,
      side: THREE.DoubleSide,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      fog: false,
    }),
  );
  m.rotation.x = -Math.PI / 2;
  return m;
}

/** Mean RGB of the ground base colors (for the hemisphere ground tint). */
export function averageGroundColor(base: Float32Array): [number, number, number] {
  const n = Math.floor(base.length / 3);
  if (n === 0) return [0.23, 0.37, 0.23];
  let r = 0;
  let g = 0;
  let b = 0;
  for (let i = 0; i < n; i++) {
    r += base[i * 3]!;
    g += base[i * 3 + 1]!;
    b += base[i * 3 + 2]!;
  }
  return [r / n, g / n, b / n];
}

export { TERR_LAVA, TERR_WATER };
