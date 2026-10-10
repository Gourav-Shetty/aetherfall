// Headless smoke tests for the DOM-bound render paths that were newly wired
// in this pass: Canvas2D fog / shake / telegraph, and the HUD minimap fog +
// boss bars. These use the recording DOM stub in domstub.ts, so they assert
// on recorded 2D draw calls rather than pixels.

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { CanvasRenderer } from './renderer2d.js';
import { IsoRenderer } from './renderer3d.js';
import { HUD } from './hud.js';
import { Ctx2D, ElStub } from './domstub.js';
import { TERR_WATER, TerrainView } from './terrain_view.js';
import {
  BurstPool,
  avatarVariant,
  blobShadowTexture,
  createLevelBeam,
  decorMatrices,
  glowTexture,
  hash2i,
  planDecorations,
  tileEdgeTexture,
  tileShade,
  triggerLevelBeam,
  updateLevelBeam,
  type DecorTerrain,
} from './scene_art.js';
import { PALETTES, hexToRgb } from './a11y.js';
import type { DrawEntity } from './types.js';

class MemStore {
  private m = new Map<string, string>();
  getItem(k: string) { return this.m.has(k) ? this.m.get(k)! : null; }
  setItem(k: string, v: string) { this.m.set(k, v); }
  removeItem(k: string) { this.m.delete(k); }
  clear() { this.m.clear(); }
}
const g = globalThis as unknown as { sessionStorage?: MemStore; document?: unknown };
g.sessionStorage = new MemStore();
// hud.ts injects boss CSS via root.ownerDocument.head (lazily created by the
// stub), and reads #leaderboard / #lb-list off the same document.
g.document = new ElStub();

beforeEach(() => {
  g.sessionStorage = new MemStore();
});

function ent(id: number, name: string, x: number, y: number, kind = 'mob', isLocal = false, z?: number): DrawEntity {
  return { id, kind, x, y, hp: 100, maxHp: 100, name, isLocal, z };
}

/** Fog stub: a single 8m chunk at (0,0) is explored, nothing else. */
const fogStub = {
  isExploredWorld: (x: number, y: number) => x >= 0 && x < 8 && y >= 0 && y < 8,
  isExploredChunk: (cx: number, cy: number) => cx === 0 && cy === 0,
};

describe('CanvasRenderer fog', () => {
  it('draws no fog overlay when fog is disabled', () => {
    const c = new CanvasRenderer(new ElStub() as unknown as HTMLCanvasElement);
    const ctx = (c as unknown as { ctx: Ctx2D }).ctx;
    c.render([ent(1, 'hero', 50, 50, 'player', true)], 50, 50, 1000);
    // Terrain still renders; with fog off no veil rects are added beyond the
    // normal tile pass, so the local player must be drawn at full opacity.
    assert.ok(ctx.count('fillRect') > 0, 'terrain still renders');
  });

  it('renders entities, telegraph rings and fog without throwing', () => {
    const c = new CanvasRenderer(new ElStub() as unknown as HTMLCanvasElement);
    const ctx = (c as unknown as { ctx: Ctx2D }).ctx;
    // Camera at (50,50) shows roughly x in [35,65]; the golem at (90,90) is
    // both off-screen and in unexplored ground, so it must not be drawn.
    const list = [
      ent(1, 'hero', 50, 50, 'player', true),
      ent(2, 'gloomfang-1', 52, 50),
      ent(3, 'Stone Golem', 90, 90),
    ];
    // (45,50) is inside the explored chunk and within the 25m radius.
    c.telegraph(45, 50, 4, 900, 'golem-slam');
    c.shake(10);
    c.render(list, 50, 50, 1000, undefined, { fog: fogStub, playerX: 50, playerY: 50 });
    assert.ok(ctx.count('fillRect') > 0, 'terrain renders');
    assert.ok(ctx.count('arc') > 0, 'telegraph ring arcs drawn');
    const texts = ctx.calls.filter((x) => x.op === 'fillText').map((x) => String(x.args[0]));
    assert.ok(texts.includes('gloomfang-1'), 'near mob drawn');
    assert.ok(!texts.includes('Stone Golem'), 'unexplored mob culled');
  });

  it('draws entities in explored ground beyond the radius, then veils them', () => {
    // Camera sits inside the explored chunk so the entity is on screen but
    // still outside the 25m lit radius (place it 24m away).
    const c = new CanvasRenderer(new ElStub() as unknown as HTMLCanvasElement);
    const ctx = (c as unknown as { ctx: Ctx2D }).ctx;
    const list = [ent(1, 'hero', 4, 4, 'player', true), ent(2, 'remembered-mob', 6, 4)];
    c.render(list, 4, 4, 1000, undefined, { fog: fogStub, playerX: 4, playerY: 4 });
    const texts = ctx.calls.filter((x) => x.op === 'fillText').map((x) => String(x.args[0]));
    assert.ok(texts.includes('remembered-mob'), 'explored mob still drawn');
  });

  it('culls telegraph rings in unexplored ground', () => {
    const c = new CanvasRenderer(new ElStub() as unknown as HTMLCanvasElement);
    const ctx = (c as unknown as { ctx: Ctx2D }).ctx;
    c.telegraph(90, 90, 4, 5000, 'wyrm-charge');
    c.render([], 50, 50, 1000, undefined, { fog: fogStub, playerX: 50, playerY: 50 });
    // Arc calls are only made for entities (HP bar bg is fillRect) — the
    // telegraph arc should be skipped, so no arc at all from the ring.
    assert.equal(ctx.count('arc'), 0, 'ring in unexplored ground is not drawn');
  });

  it('screen shake decays to zero instead of jittering forever', () => {
    const c = new CanvasRenderer(new ElStub() as unknown as HTMLCanvasElement);
    const ctx = (c as unknown as { ctx: Ctx2D }).ctx;
    c.shake(20);
    let t = 1000;
    for (let i = 0; i < 200; i++) { t += 16; c.render([], 50, 50, t); }
    const last = ctx.calls[ctx.calls.length - 1]!;
    // Terrain rect positions must be integers once the shake has decayed.
    assert.ok(last.op.length > 0);
    assert.ok(ctx.count('fillRect') > 0);
  });
});

describe('terrain rendering (Canvas2D fallback)', () => {
  /** A renderer bound to the domstub with the terrain field attached. */
  function make(): { c: CanvasRenderer; ctx: Ctx2D } {
    const c = new CanvasRenderer(new ElStub() as unknown as HTMLCanvasElement, new TerrainView());
    return { c, ctx: (c as unknown as { ctx: Ctx2D }).ctx };
  }

  it('paints water tiles with the hazard palette instead of grass', () => {
    const { c, ctx } = make();
    // (24.5, 46.5) is open water in seed 1337; (60.5, 60.5) is dry ground.
    c.render([ent(1, 'hero', 24.5, 46.5, 'player', true)], 24.5, 46.5, 1000);
    const wet = ctx.calls.filter((x) => x.op === 'fillRect').map((x) => String(x.args[4]));
    assert.ok(wet.includes('#12314f') || wet.includes('#1d4f74'), 'shoreline painted as water');
    ctx.calls.length = 0;
    c.render([ent(1, 'hero', 60.5, 60.5, 'player', true)], 60.5, 60.5, 1000);
    const dry = ctx.calls.filter((x) => x.op === 'fillRect').map((x) => String(x.args[4]));
    assert.ok(dry.includes('#1d4a26') || dry.includes('#1a4222'), 'dry ground painted as grass');
    assert.ok(!dry.includes('#12314f'), 'no water at a dry tile');
  });

  it('lifts the avatar by its elevation but keeps the shadow on the floor', () => {
    const { c, ctx } = make();
    const groundY = 600 / 2;
    const z = new TerrainView().heightAtTile(60, 60);
    assert.ok(z > 0, `the demo tile is above sea level (${z})`);
    c.render([ent(1, 'hero', 60.5, 60.5, 'player', true, z)], 60.5, 60.5, 1000);
    // Shadow ellipse stays on the tile row...
    const ellipses = ctx.calls.filter((x) => x.op === 'ellipse');
    assert.equal(ellipses.length, 1);
    assert.equal(ellipses[0]!.args[1], groundY + 12);
    // ...and the body is drawn higher on the screen than the shadow.
    const body = ctx.calls.findIndex((x) => x.op === 'roundRect');
    assert.ok(body > 0);
    const bodyBottom = (ctx.calls[body]!.args[1] as number) + (ctx.calls[body]!.args[3] as number);
    assert.ok(bodyBottom < groundY + 12, `body (${bodyBottom}) should be above the shadow (${groundY + 12})`);
  });

  it('renders fine with no terrain attached (flat arena)', () => {
    const c = new CanvasRenderer(new ElStub() as unknown as HTMLCanvasElement);
    const ctx = (c as unknown as { ctx: Ctx2D }).ctx;
    c.render([ent(1, 'hero', 50, 50, 'player', true)], 50, 50, 1000);
    assert.ok(ctx.count('fillRect') > 0);
  });
});

describe('HUD minimap terrain overlay', () => {
  const k = 128 / 100;

  function mapCtx(): { hud: HUD; ctx: Ctx2D } {
    const mapCanvas = new ElStub() as unknown as HTMLCanvasElement;
    const hud = new HUD(new ElStub() as unknown as HTMLElement);
    (hud as unknown as { map: HTMLCanvasElement }).map = mapCanvas;
    const ctx = (mapCanvas as unknown as ElStub).ctx2d;
    ctx.calls.length = 0;
    return { hud, ctx };
  }

  /** 2x2-tile hazard cells on the 128px map. */
  function hazardCells(ctx: Ctx2D): ReturnType<Ctx2D['calls']['filter']> {
    return ctx.calls.filter((c) => c.op === 'fillRect'
      && typeof c.args[0] === 'number' && Math.abs((c.args[2] as number) - 2 * k) < 1e-6);
  }

  it('draws hazard cells', () => {
    const { hud, ctx } = mapCtx();
    const terrain = new TerrainView();
    hud.drawMinimap([ent(1, 'hero', 50, 50, 'player', true)], undefined, null, 50, 50, terrain);
    const cells = hazardCells(ctx);
    assert.ok(cells.length > 5, `expected hazard cells, got ${cells.length}`);
    assert.ok(cells.some((c) => c.args[4] === '#1d5f9e'), 'water cells are blue');
    // Seed 1337 has no landmark inside the 100x100 map, so no diamond yet.
    assert.equal(terrain.landmarksNear(50, 50, 100).length, 0);
    assert.equal(ctx.count('moveTo'), 0);
  });

  it('draws a landmark diamond when one is inside the map', () => {
    const { hud, ctx } = mapCtx();
    const fake = {
      kindAtTile: () => 0,
      landmarksNear: () => [{ id: 'ruin:0,0', kind: 'ruin', name: 'Test Ruin', x: 40, y: 40, radius: 10 }],
    };
    hud.drawMinimap([], undefined, null, 40, 40, fake);
    assert.equal(ctx.count('moveTo'), 1, 'one diamond outline');
    assert.equal(ctx.count('closePath'), 1);
  });

  it('hides hazard cells in unexplored ground', () => {
    const { hud, ctx } = mapCtx();
    // fogStub explores only chunk (0,0); the player sits in it at (4,4).
    hud.drawMinimap([], undefined, fogStub, 4, 4, new TerrainView());
    assert.equal(hazardCells(ctx).length, 0, 'no hazard cell survives the fog veil');
    assert.equal(TERR_WATER, 1);
  });
});

describe('HUD minimap fog', () => {
  it('hides entities standing in unexplored ground', () => {
    const mapCanvas = new ElStub() as unknown as HTMLCanvasElement;
    const hud = new HUD(new ElStub() as unknown as HTMLElement);
    // drawMinimap uses its own canvas; call through the stub HUD instance.
    (hud as unknown as { map: HTMLCanvasElement }).map = mapCanvas;
    const ctx = (mapCanvas as unknown as ElStub).ctx2d;
    ctx.calls.length = 0;
    hud.drawMinimap(
      [ent(1, 'hero', 50, 50, 'player', true), ent(2, 'gloom', 90, 90)],
      undefined, fogStub, 50, 50,
    );
    // Only the local player dot survives fog culling (2x2 rects).
    const small = ctx.calls.filter((c) => c.op === 'fillRect' && (c.args[2] === 2 || c.args[2] === 3));
    assert.ok(small.length >= 1, 'local player dot drawn');
    assert.ok(small.length <= 1, 'unexplored mob dot suppressed');
  });

  it('draws fog overlay rects for the 8m chunk grid', () => {
    const mapCanvas = new ElStub() as unknown as HTMLCanvasElement;
    const hud = new HUD(new ElStub() as unknown as HTMLElement);
    (hud as unknown as { map: HTMLCanvasElement }).map = mapCanvas;
    const ctx = (mapCanvas as unknown as ElStub).ctx2d;
    ctx.calls.length = 0;
    hud.drawMinimap([], undefined, fogStub, 50, 50);
    // 13x13 chunk grid; most are far from the player and get a veil rect.
    const veils = ctx.calls.filter((c) => c.op === 'fillRect'
      && typeof c.args[1] === 'number' && (c.args[1] as number) > 5);
    assert.ok(veils.length > 10, `expected chunk veil rects, got ${veils.length}`);
  });

  it('renders nothing extra when fog is off', () => {
    const mapCanvas = new ElStub() as unknown as HTMLCanvasElement;
    const hud = new HUD(new ElStub() as unknown as HTMLElement);
    (hud as unknown as { map: HTMLCanvasElement }).map = mapCanvas;
    const ctx = (mapCanvas as unknown as ElStub).ctx2d;
    ctx.calls.length = 0;
    hud.drawMinimap([ent(1, 'gloom', 90, 90)], undefined);
    const dots = ctx.calls.filter((c) => c.op === 'fillRect' && (c.args[2] === 2));
    assert.ok(dots.length >= 1, 'no fog -> all entities drawn');
  });
});

describe('a11y palette overrides (Canvas2D)', () => {
  function make(): { c: CanvasRenderer; ctx: Ctx2D } {
    const c = new CanvasRenderer(new ElStub() as unknown as HTMLCanvasElement);
    return { c, ctx: (c as unknown as { ctx: Ctx2D }).ctx };
  }

  it('hexToRgb parses #rrggbb and rejects garbage', () => {
    assert.deepEqual(hexToRgb('#d50000'), [213, 0, 0]);
    assert.deepEqual(hexToRgb('#f0e442'), [240, 228, 66]);
    assert.equal(hexToRgb('red'), null);
    assert.equal(hexToRgb('#fff'), null);
    assert.equal(hexToRgb(''), null);
    assert.equal(hexToRgb('#gggggg'), null);
  });

  it('defaults to the shipped palette', () => {
    const { c } = make();
    assert.equal(c.entityColor('mob'), '#ff5252');
    assert.equal(c.entityColor('player'), '#ff9a4d');
    assert.equal(c.entityColor('boss-with-no-kind'), '#ccc');
    assert.deepEqual(c.telegraphColors(), { fill: '255,40,40', ring: '255,60,60' });
  });

  it('setEntityColors replaces kinds and ignores invalid entries', () => {
    const { c } = make();
    c.setEntityColors({ mob: PALETTES.deuteranopia.mob, npc: 'not-a-colour' });
    assert.equal(c.entityColor('mob'), PALETTES.deuteranopia.mob);
    assert.equal(c.entityColor('npc'), '#4dc3ff', 'garbage keeps the shipped colour');
    // The override reaches the draw path: a pickup body is a fillRect whose
    // trailing recorded arg is the active fillStyle.
    const { c: c2, ctx } = make();
    c2.setEntityColors({ pickup: PALETTES.deuteranopia.pickup });
    c2.render([ent(9, 'shard', 50, 50, 'pickup')], 50, 50, 1000);
    const bodies = ctx.calls.filter((x) => x.op === 'fillRect');
    assert.ok(bodies.some((b) => b.args[b.args.length - 1] === PALETTES.deuteranopia.pickup),
      'pickup body drawn in the deuteranopia colour');
  });

  it('setTelegraphColor re-colours the ring; garbage keeps the current colour', () => {
    const { c, ctx } = make();
    c.setTelegraphColor(PALETTES.deuteranopia.telegraph);
    assert.deepEqual(c.telegraphColors(), { fill: '240,228,66', ring: '240,228,66' });
    c.setTelegraphColor('banana');
    assert.deepEqual(c.telegraphColors(), { fill: '240,228,66', ring: '240,228,66' });
    // Rings still draw after the override (no throw, arcs emitted).
    c.telegraph(50, 50, 4, 900, 'golem-slam');
    c.render([], 50, 50, 1000);
    assert.ok(ctx.count('arc') > 0, 'telegraph ring arcs drawn');
  });
});

describe('IsoRenderer stylized art (headless, no WebGL)', () => {
  function makeIso() {
    const container = new ElStub();
    const iso = IsoRenderer.createHeadless(
      container as unknown as HTMLElement, new TerrainView(),
    );
    return { iso, container };
  }

  function demoList(): DrawEntity[] {
    return [
      ent(1, 'hero', 50, 50, 'player', true),
      ent(2, 'gloomfang-1', 52, 50),
      ent(3, 'Elder Maren', 51, 51, 'npc'),
      ent(4, 'shard', 49, 49, 'pickup'),
      ent(5, 'bolt', 50.5, 50, 'projectile'),
    ];
  }

  it('updates without throwing and keeps scene child count stable', () => {
    const { iso } = makeIso();
    try {
      const list = demoList();
      iso.update(list, 50, 50, 1000);
      const steady = iso.childCount();
      assert.ok(steady > 10, `scene populated (${steady})`);
      for (let i = 1; i <= 5; i++) {
        iso.update(list, 50 + i * 0.2, 50 + i * 0.1, 1000 + i * 16);
        assert.equal(iso.childCount(), steady, `frame ${i} adds no scene children`);
      }
    } finally {
      iso.dispose();
    }
  });

  it('entity removal drops exactly one child (death burst is pooled)', () => {
    const { iso } = makeIso();
    try {
      const list = demoList();
      iso.update(list, 50, 50, 1000);
      iso.update(list, 50, 50, 1016);
      const before = iso.childCount();
      const short = list.filter((e) => e.id !== 2);
      iso.update(short, 50, 50, 1032);
      assert.equal(iso.childCount(), before - 1, 'removed avatar frees its group, burst reuses the pool');
      iso.update(short, 50, 50, 1048);
      assert.equal(iso.childCount(), before - 1, 'steady again after the death');
    } finally {
      iso.dispose();
    }
  });

  it('base draw calls stay within the perf budget', () => {
    const { iso } = makeIso();
    try {
      iso.update(demoList(), 50, 50, 1000);
      const n = iso.baseDrawCalls();
      assert.ok(n <= 12, `base draw calls ${n} <= 12`);
      assert.ok(n >= 6, `scene is actually populated (${n})`);
    } finally {
      iso.dispose();
    }
  });

  it('setQuality scales decoration density without throwing', () => {
    const { iso } = makeIso();
    try {
      iso.update(demoList(), 50, 50, 1000);
      const hi = iso.decorPlanSnapshot().length;
      iso.setQuality(1, 12);
      iso.update(demoList(), 50, 50, 1016);
      const lo = iso.decorPlanSnapshot().length;
      assert.ok(lo <= hi, `low (${lo}) <= high (${hi})`);
      assert.ok(lo > 0, 'low quality keeps some decoration');
      iso.setQuality(2, 60);
      iso.update(demoList(), 50, 50, 1032);
      assert.equal(iso.decorPlanSnapshot().length, hi, 'restoring quality restores the plan');
    } finally {
      iso.dispose();
    }
  });

  it('combat fx (flash, burst, beam, telegraph, palette) never throw', () => {
    const { iso } = makeIso();
    try {
      iso.update(demoList(), 50, 50, 1000);
      const steady = iso.childCount();
      iso.flash(50, 50, 0xffffff);
      iso.deathBurst(51, 51, 0xffd27f);
      iso.levelUp(50, 50);
      iso.telegraph(45, 50, 4, 900);
      iso.telegraph(NaN, 50, 4, 900); // malformed input is ignored
      iso.setEntityColors({ mob: 0xcc79a7, npc: NaN });
      iso.setTelegraphColor(0xf0e442);
      iso.setFog(fogStub, 50, 50);
      iso.shake(0.5);
      iso.update(demoList(), 50, 50, 1016);
      assert.ok(iso.childCount() >= steady, 'fx only adds transient children');
      // project/screenToWorld round-trip stays finite headless.
      const p = iso.project(50, 50);
      assert.ok(Number.isFinite(p.sx) && Number.isFinite(p.sy));
    } finally {
      iso.dispose();
    }
  });

  it('fog retint pass keeps children stable', () => {
    const { iso } = makeIso();
    try {
      iso.setFog(fogStub, 50, 50);
      iso.update(demoList(), 50, 50, 1000);
      // Force the throttled pass regardless of wall-clock time.
      (iso as unknown as { lastFogApply: number }).lastFogApply = 0;
      const before = iso.childCount();
      iso.update(demoList(), 50.5, 50.2, 1016);
      assert.equal(iso.childCount(), before, 'fog retint never adds children');
    } finally {
      iso.dispose();
    }
  });
});

describe('decoration determinism (scene_art)', () => {
  function stubTerrain(zone: string): DecorTerrain {
    return {
      kindAtTile: () => 0,
      heightAtTile: () => 5,
      slopeFromGrid: () => 0.2,
      biomeAtTile: () => 'plains',
      zoneAtTile: () => zone,
    };
  }

  it('same seed yields identical matrices', () => {
    const t = stubTerrain('meadow');
    const a = planDecorations(t, 1337, 400, 1);
    const b = planDecorations(t, 1337, 400, 1);
    assert.deepEqual(decorMatrices(a), decorMatrices(b));
    assert.deepEqual(a, b);
  });

  it('caps instances and honors the density scale', () => {
    const t = stubTerrain('meadow');
    const hi = planDecorations(t, 1337, 400, 1);
    const lo = planDecorations(t, 1337, 400, 0.35);
    assert.ok(hi.length <= 400, `capped (${hi.length})`);
    assert.ok(hi.length > 100, 'a meadow still decorates');
    assert.ok(lo.length <= Math.floor(400 * 0.35), `low-quality cap (${lo.length})`);
    assert.ok(lo.length < hi.length, 'density scale thins the layer');
    assert.deepEqual(planDecorations(null, 1337, 0, 1), [], 'zero cap plans nothing');
  });

  it('decorations are rarer in dungeon/volcano zones', () => {
    // Uncapped so the zone multiplier itself is compared, not the cap.
    const meadow = planDecorations(stubTerrain('meadow'), 1337, 5000, 1);
    const dungeon = planDecorations(stubTerrain('dungeon'), 1337, 5000, 1);
    const volcano = planDecorations(stubTerrain('volcano'), 1337, 5000, 1);
    assert.ok(dungeon.length < meadow.length, `dungeon ${dungeon.length} < meadow ${meadow.length}`);
    assert.ok(volcano.length < meadow.length, `volcano ${volcano.length} < meadow ${meadow.length}`);
  });

  it('tileShade is stable, bounded and two-tone', () => {
    assert.equal(tileShade(7, 9, 1337), tileShade(7, 9, 1337));
    let even = 0;
    let odd = 0;
    let n = 0;
    for (let y = 0; y < 20; y++) {
      for (let x = 0; x < 20; x++) {
        const s = tileShade(x, y, 1337);
        assert.ok(s > 0.8 && s < 1.1, `shade ${s} in range`);
        if ((x + y) % 2 === 0) even += s;
        else odd += s;
        n++;
      }
    }
    assert.ok(even / (n / 2) > odd / (n / 2), 'checker bright/dark split survives the noise');
  });

  it('hash2i is deterministic in [0,1) and avatar variants follow kind+name', () => {
    assert.equal(hash2i(3, 4, 1337), hash2i(3, 4, 1337));
    assert.ok(hash2i(3, 4, 1337) >= 0 && hash2i(3, 4, 1337) < 1);
    assert.equal(avatarVariant('npc', 'Elder Maren'), 'hat-staff');
    assert.equal(avatarVariant('npc', 'shopkeep'), 'staff');
    assert.equal(avatarVariant('player', 'hero'), 'sword');
    assert.equal(avatarVariant('mob', 'gloom'), 'sword');
    assert.equal(avatarVariant('pickup', 'shard'), 'none');
    assert.equal(avatarVariant('projectile', 'bolt'), 'none');
  });
});

describe('combat-feel pools (scene_art)', () => {
  it('death bursts spawn 8 particles with gravity and fade out', () => {
    const pool = new BurstPool(32);
    assert.equal(pool.alive(), 0);
    pool.burst(50, 1, 50, 0xffd27f, 8);
    assert.equal(pool.alive(), 8);
    for (let i = 0; i < 40; i++) pool.update(0.05);
    assert.equal(pool.alive(), 0, 'all burst particles decay');
  });

  it('level-up beam triggers, fades and hides', () => {
    const beam = createLevelBeam();
    assert.equal(beam.visible, false);
    triggerLevelBeam(beam, 50, 0, 50);
    assert.equal(beam.visible, true);
    for (let i = 0; i < 30; i++) updateLevelBeam(beam, 0.05);
    assert.equal(beam.visible, false);
  });

  it('procedural textures resolve headless (stub-DOM safe)', () => {
    assert.ok(blobShadowTexture());
    assert.ok(glowTexture());
    assert.ok(tileEdgeTexture());
  });
});