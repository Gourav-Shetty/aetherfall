// Combat feel: hit-stop freeze, blood decals (cap + fade) and the downed
// crawl mark on both renderers. Headless via the recording DOM stub; asserts
// on draw calls and renderer state, never on pixels.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { BLOOD_MAX, BLOOD_TTL_MS, CanvasRenderer } from './renderer2d.js';
import { IsoRenderer, BLOOD_MAX as BLOOD_MAX_3D, BLOOD_TTL_MS as BLOOD_TTL_3D } from './renderer3d.js';
import { ElStub, type Ctx2D } from './domstub.js';
import { TerrainView } from './terrain_view.js';
import type { DrawEntity } from './types.js';

function ent(id: number, name: string, x: number, y: number, kind = 'mob', isLocal = false): DrawEntity {
  return { id, kind, x, y, hp: 100, maxHp: 100, name, isLocal };
}

function ctxOf(c: CanvasRenderer): Ctx2D {
  return (c as unknown as { ctx: Ctx2D }).ctx;
}

describe('combat feel: hit-stop freezes the CanvasRenderer', () => {
  it('render() emits nothing new while frozen, resumes after', () => {
    const c = new CanvasRenderer(new ElStub() as unknown as HTMLCanvasElement);
    const ctx = ctxOf(c);
    const list = [ent(1, 'hero', 50, 50, 'player', true), ent(2, 'gloom', 52, 50)];
    c.render(list, 50, 50, 1000);
    const before = ctx.calls.length;
    assert.ok(before > 0);

    c.hitStop(90, 1000);
    assert.equal(c.isHitStopped(1000), true);
    assert.equal(c.isHitStopped(1089), true);
    assert.equal(c.isHitStopped(1090), false, 'freeze ends exactly at 90ms');
    c.render(list, 50, 50, 1050);
    assert.equal(ctx.calls.length, before, 'frozen frame draws nothing');

    c.render(list, 50, 50, 1200);
    assert.ok(ctx.calls.length > before, 'sim resumes after the freeze');
  });

  it('zero / negative / NaN durations are a no-op', () => {
    const c = new CanvasRenderer(new ElStub() as unknown as HTMLCanvasElement);
    c.hitStop(0, 1000);
    c.hitStop(-5, 1000);
    c.hitStop(NaN, 1000);
    assert.equal(c.isHitStopped(1000), false);
  });
});

describe('combat feel: CanvasRenderer blood decals', () => {
  it('caps at 200 splats and draws them as floor ellipses', () => {
    assert.equal(BLOOD_MAX, 200);
    const c = new CanvasRenderer(new ElStub() as unknown as HTMLCanvasElement);
    for (let i = 0; i < 205; i++) c.addBlood(50 + i * 0.01, 50, 1000);
    assert.equal(c.bloodCount(), 200, 'oldest splats fall off');
    const ctx = ctxOf(c);
    c.render([], 50, 50, 1100);
    assert.ok(ctx.count('ellipse') >= 2, 'splats drawn under the (empty) entity layer');
  });

  it('splats fade and prune after the TTL', () => {
    const c = new CanvasRenderer(new ElStub() as unknown as HTMLCanvasElement);
    c.addBlood(50, 50, 1000);
    assert.equal(c.bloodCount(), 1);
    c.render([], 50, 50, 1000 + BLOOD_TTL_MS + 1);
    assert.equal(c.bloodCount(), 0, 'expired splats pruned');
  });

  it('non-finite input is ignored', () => {
    const c = new CanvasRenderer(new ElStub() as unknown as HTMLCanvasElement);
    c.addBlood(NaN, 50, 1000);
    c.addBlood(50, Infinity, 1000);
    assert.equal(c.bloodCount(), 0);
  });
});

describe('combat feel: CanvasRenderer downed crawl mark', () => {
  it('marks, queries and clears; downed mobs render flattened', () => {
    const c = new CanvasRenderer(new ElStub() as unknown as HTMLCanvasElement);
    const ctx = ctxOf(c);
    assert.equal(c.isDowned(7), false);
    c.markDowned(7);
    assert.equal(c.isDowned(7), true);
    c.render([ent(7, 'gloom', 50, 50)], 50, 50, 1000);
    assert.ok(ctx.count('roundRect') > 0, 'crawl body drawn');
    c.clearDowned(7);
    assert.equal(c.isDowned(7), false);
  });
});

describe('combat feel: hit-stop freezes the IsoRenderer', () => {
  function makeIso() {
    const container = new ElStub();
    const iso = IsoRenderer.createHeadless(container as unknown as HTMLElement, new TerrainView());
    return { iso };
  }

  function demoList(): DrawEntity[] {
    return [ent(1, 'hero', 50, 50, 'player', true), ent(2, 'gloom', 52, 50)];
  }

  it('update() holds the scene while frozen, resumes after', () => {
    const { iso } = makeIso();
    try {
      iso.update(demoList(), 50, 50, 1000);
      const steady = iso.childCount();
      iso.hitStop(90, 1000);
      assert.equal(iso.isHitStopped(1089), true);
      assert.equal(iso.isHitStopped(1090), false);
      iso.update(demoList(), 55, 55, 1050);
      assert.equal(iso.childCount(), steady, 'frozen frame adds/removes nothing');
      iso.update(demoList(), 55, 55, 1200);
      assert.equal(iso.childCount(), steady, 'steady again after the freeze');
    } finally {
      iso.dispose();
    }
  });

  it('zero / negative durations are a no-op', () => {
    const { iso } = makeIso();
    try {
      iso.hitStop(0, 1000);
      assert.equal(iso.isHitStopped(1000), false);
    } finally {
      iso.dispose();
    }
  });
});

describe('combat feel: IsoRenderer blood decals', () => {
  it('caps at 200 splats (one mesh each) and prunes after the TTL', () => {
    assert.equal(BLOOD_MAX_3D, 200);
    assert.equal(BLOOD_TTL_3D, BLOOD_TTL_MS);
    const container = new ElStub();
    const iso = IsoRenderer.createHeadless(container as unknown as HTMLElement, new TerrainView());
    try {
      iso.update([], 50, 50, 1000);
      const base = iso.childCount();
      for (let i = 0; i < 205; i++) iso.addBlood(50 + i * 0.01, 50, 1000);
      assert.equal(iso.bloodCount(), 200, 'oldest splats fall off');
      assert.equal(iso.childCount(), base + 200, 'one scene child per splat');
      iso.update([], 50, 50, 1000 + BLOOD_TTL_3D + 1);
      assert.equal(iso.bloodCount(), 0, 'expired splats pruned');
      assert.equal(iso.childCount(), base, 'meshes freed with the splats');
    } finally {
      iso.dispose();
    }
  });
});

describe('combat feel: IsoRenderer downed crawl mark', () => {
  it('flattens downed avatars, restores on clear', () => {
    const container = new ElStub();
    const iso = IsoRenderer.createHeadless(container as unknown as HTMLElement, new TerrainView());
    try {
      const list = [ent(9, 'gloom', 50, 50)];
      iso.update(list, 50, 50, 1000);
      const bodies = (iso as unknown as { bodies: Map<number, { refs: { group: { scale: { y: number } } } }> }).bodies;
      assert.equal(bodies.get(9)!.refs.group.scale.y, 1);
      iso.markDowned(9);
      assert.equal(iso.isDowned(9), true);
      iso.update(list, 50, 50, 1016);
      assert.equal(bodies.get(9)!.refs.group.scale.y, 0.45, 'crawl flatten');
      iso.clearDowned(9);
      iso.update(list, 50, 50, 1032);
      assert.equal(bodies.get(9)!.refs.group.scale.y, 1, 'standing restores');
    } finally {
      iso.dispose();
    }
  });
});
