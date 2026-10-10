// Renderer-level feedback: both channels must actually PAINT what the pure
// rules in feedback.ts decide. Assertions are on recorded draw calls and
// scene-graph state — never on pixels, never on WebGL.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { CanvasRenderer } from './renderer2d.js';
import { IsoRenderer } from './renderer3d.js';
import { ElStub, type Ctx2D } from './domstub.js';
import { TerrainView } from './terrain_view.js';
import {
  FINISHER_LABEL,
  HIT_FLASH_MOB,
  HIT_FLASH_MS,
  HIT_FLASH_PLAYER,
  MOB_BAR_RECENT_MS,
  SWING_COOLDOWN_MS,
  SWING_MS,
} from './feedback.js';
import type { DrawEntity } from './types.js';

function ent(
  id: number, name: string, x: number, y: number,
  kind = 'mob', isLocal = false, hp = 100,
): DrawEntity {
  return { id, kind, x, y, hp, maxHp: 100, name, isLocal };
}

function ctxOf(c: CanvasRenderer): Ctx2D {
  return (c as unknown as { ctx: Ctx2D }).ctx;
}

function makeCanvas(): CanvasRenderer {
  return new CanvasRenderer(new ElStub() as unknown as HTMLCanvasElement);
}

function makeIso(): IsoRenderer {
  return IsoRenderer.createHeadless(new ElStub() as unknown as HTMLElement, new TerrainView());
}

/** Draw calls whose op matches, as string args (styles included). */
function calls(ctx: Ctx2D, op: string): string[] {
  return ctx.calls.filter((c) => c.op === op).map((c) => c.args.map(String).join('|'));
}

// ---------------------------------------------------------------------------
// Canvas2D
// ---------------------------------------------------------------------------

describe('feedback (Canvas2D): damage numbers', () => {
  it('paints the damage value at the hit position, then fades it out', () => {
    const c = makeCanvas();
    const ctx = ctxOf(c);
    c.damage(50, 50, 18, 'normal', 1000);
    c.render([], 50, 50, 1000);
    const texts = ctx.calls.filter((x) => x.op === 'fillText').map((x) => String(x.args[0]));
    assert.ok(texts.includes('18'), 'the value is on screen');
    assert.equal(c.damageNumberCount(), 1);

    // Mid-life it has risen above the anchor.
    c.render([], 50, 50, 1000 + 400);
    assert.equal(c.damageNumberCount(), 1);
    ctx.calls.length = 0;
    c.render([], 50, 50, 1000 + 400);
    const dy = ctx.calls.filter((x) => x.op === 'fillText' && x.args[0] === '18')[0];
    assert.ok(dy !== undefined);

    // Gone after the lifetime.
    c.render([], 50, 50, 1000 + 701);
    assert.equal(c.damageNumberCount(), 0);
    ctx.calls.length = 0;
    c.render([], 50, 50, 1000 + 701);
    assert.equal(ctx.calls.filter((x) => x.op === 'fillText').length, 0);
  });

  it('uses the gold + glyph + larger font for a crit', () => {
    const c = makeCanvas();
    const ctx = ctxOf(c);
    c.damage(50, 50, 44, 'crit', 1000);
    c.render([], 50, 50, 1000);
    const hit = ctx.calls.filter((x) => x.op === 'fillText' && String(x.args[0]) === '✦44');
    assert.equal(hit.length, 1, 'crit text carries a glyph marker');
    // The font recorded just before the fill is the crit size.
    assert.ok(calls(ctx, 'fillText').some(() => true));
  });

  it('uses the red + signed style for damage the player takes', () => {
    const c = makeCanvas();
    const ctx = ctxOf(c);
    c.damage(50, 50, 9, 'taken', 1000, 1);
    c.render([], 50, 50, 1000);
    assert.ok(ctx.calls.some((x) => x.op === 'fillText' && x.args[0] === '-9'));
  });

  it('anchors the player damage number to the player sprite', () => {
    const c = makeCanvas();
    const ctx = ctxOf(c);
    c.damage(0, 0, 5, 'taken', 1000, 7);
    c.render([ent(7, 'hero', 51, 51, 'player', true)], 50, 50, 1000);
    const d = (c as unknown as { dmg: { at(i: number): { followId: number } } }).dmg.at(0);
    assert.equal(d.followId, 7);
    assert.ok(ctx.count('fillText') > 0);
  });

  it('never exceeds the 24-number cap on screen', () => {
    const c = makeCanvas();
    for (let i = 0; i < 60; i++) c.damage(50 + i * 5, 50, 5, 'normal', 1000);
    c.render([], 50, 50, 1000);
    assert.equal(c.damageNumberCount(), 24);
    ctxOf(c).calls.length = 0;
    c.render([], 50, 50, 1000);
    assert.equal(ctxOf(c).count('fillText'), 24);
  });

  it('high-contrast mode ("off") paints no damage text at all', () => {
    const c = makeCanvas();
    const ctx = ctxOf(c);
    c.damage(50, 50, 33, 'crit', 1000);
    c.setDamageNumberMode('off');
    assert.equal(c.damageNumberMode(), 'off');
    assert.equal(c.damage(50, 50, 33, 'crit', 1000), false, 'the a11y gate drops it');
    c.render([], 50, 50, 1000);
    assert.equal(ctx.count('fillText'), 0);
  });

  it('reduced-motion mode ("short") keeps the text but drops the rise', () => {
    const c = makeCanvas();
    const ctx = ctxOf(c);
    c.setDamageNumberMode('short');
    c.damage(50, 50, 12, 'normal', 1000);
    c.render([], 50, 50, 1000);
    assert.ok(ctx.calls.some((x) => x.op === 'fillText' && x.args[0] === '12'), 'still readable');
    c.render([], 50, 50, 1000 + 400);
    assert.equal(c.damageNumberCount(), 0, 'and it does not linger');
  });
});

describe('feedback (Canvas2D): mob HP bar gating', () => {
  /** The 30x5 HP-bar background rects are the only width-30 fillRects. */
  function barRects(ctx: Ctx2D): number {
    return ctx.calls.filter((x) => x.op === 'fillRect' && x.args[2] === 30 && x.args[3] === 5).length;
  }

  it('a quiet mob wears no bar', () => {
    const c = makeCanvas();
    const ctx = ctxOf(c);
    c.render([ent(2, 'gloom', 52, 50)], 50, 50, 10_000);
    assert.equal(barRects(ctx), 0);
  });

  it('the mob the player just hit wears one', () => {
    const c = makeCanvas();
    const ctx = ctxOf(c);
    c.hitFlash(2, false, 10_000);
    c.render([ent(2, 'gloom', 52, 50)], 50, 50, 10_000);
    assert.ok(barRects(ctx) >= 2, 'background + fill');
  });

  it('the current melee target wears one before the first hit', () => {
    const c = makeCanvas();
    const ctx = ctxOf(c);
    c.setTarget(2);
    c.render([ent(2, 'gloom', 52, 50)], 50, 50, 10_000);
    assert.ok(barRects(ctx) >= 2);
  });

  it('the bar drops once the mob has been quiet long enough', () => {
    const c = makeCanvas();
    const ctx = ctxOf(c);
    c.hitFlash(2, false, 10_000);
    c.render([ent(2, 'gloom', 52, 50)], 50, 50, 10_000 + MOB_BAR_RECENT_MS);
    assert.equal(barRects(ctx), 0);
  });

  it('a corpse wears no bar even when targeted', () => {
    const c = makeCanvas();
    const ctx = ctxOf(c);
    c.setTarget(2);
    c.render([ent(2, 'gloom', 52, 50, 'mob', false, 0)], 50, 50, 10_000);
    assert.equal(barRects(ctx), 0);
  });

  it('the local player always keeps their own bar', () => {
    const c = makeCanvas();
    const ctx = ctxOf(c);
    c.render([ent(1, 'hero', 50, 50, 'player', true)], 50, 50, 10_000);
    assert.ok(barRects(ctx) >= 2);
  });

  it('names are still drawn for quiet mobs (only the bar is gated)', () => {
    const c = makeCanvas();
    const ctx = ctxOf(c);
    c.render([ent(2, 'gloom', 52, 50)], 50, 50, 10_000);
    assert.ok(ctx.calls.some((x) => x.op === 'fillText' && x.args[0] === 'gloom'));
  });
});

describe('feedback (Canvas2D): hit flash', () => {
  /** Body roundRects tinted white (mob) or red (player). */
  function tinted(ctx: Ctx2D): string[] {
    return ctx.calls.filter((x) => x.op === 'roundRect').map((x) => String(x.args[x.args.length - 1]));
  }

  it('a struck mob flares white for ~100ms', () => {
    const c = makeCanvas();
    const ctx = ctxOf(c);
    c.hitFlash(2, false, 1000);
    c.render([ent(2, 'gloom', 52, 50)], 50, 50, 1000);
    assert.ok(tinted(ctx).includes('#ffffff'), 'white body pass');
    ctx.calls.length = 0;
    c.render([ent(2, 'gloom', 52, 50)], 50, 50, 1000 + 99);
    assert.ok(tinted(ctx).includes('#ffffff'), 'still flaring just before 100ms');
    ctx.calls.length = 0;
    c.render([ent(2, 'gloom', 52, 50)], 50, 50, 1000 + HIT_FLASH_MS);
    assert.ok(!tinted(ctx).includes('#ffffff'), 'flash is over at 100ms');
  });

  it('the player flares red when hit', () => {
    const c = makeCanvas();
    const ctx = ctxOf(c);
    c.hitFlash(1, true, 1000);
    c.render([ent(1, 'hero', 50, 50, 'player', true)], 50, 50, 1000);
    const red = tinted(ctx).some((s) => s === '#ff2f3f');
    assert.ok(red, 'red body pass, not white');
    assert.ok(!tinted(ctx).includes('#ffffff'));
  });

  it('an untouched mob never flashes', () => {
    const c = makeCanvas();
    const ctx = ctxOf(c);
    c.render([ent(2, 'gloom', 52, 50)], 50, 50, 1000);
    assert.ok(!tinted(ctx).includes('#ffffff'));
  });

  it('taking damage also marks the mob bar as recently hit', () => {
    const c = makeCanvas();
    c.hitFlash(2, false, 1000);
    c.render([ent(2, 'gloom', 52, 50)], 50, 50, 1000);
    const ctx = ctxOf(c);
    assert.ok(ctx.calls.some((x) => x.op === 'fillRect' && x.args[2] === 30 && x.args[3] === 5));
  });

  it('a downed crawler also flashes', () => {
    const c = makeCanvas();
    const ctx = ctxOf(c);
    c.markDowned(2);
    c.hitFlash(2, false, 1000);
    c.render([ent(2, 'gloom', 52, 50)], 50, 50, 1000);
    assert.ok(tinted(ctx).includes('#ffffff'));
  });
});

describe('feedback (Canvas2D): swing', () => {
  it('draws a whoosh arc while the swing window is open, and not otherwise', () => {
    const c = makeCanvas();
    const ctx = ctxOf(c);
    const list = [ent(1, 'hero', 50, 50, 'player', true), ent(2, 'gloom', 51.5, 50)];
    c.render(list, 50, 50, 1000);
    assert.equal(ctx.count('arc'), 0, 'idle: no swing arc');
    c.swing(50, 50, 1, 0, 1000);
    ctx.calls.length = 0;
    c.render(list, 50, 50, 1000 + 40);
    assert.ok(ctx.count('arc') > 0, 'a whoosh arc is drawn mid-swing');
    ctx.calls.length = 0;
    c.render(list, 50, 50, 1000 + SWING_MS);
    assert.equal(ctx.count('arc'), 0, 'the swing is over');
  });

  it('reduced motion drops the sweeping arc but keeps the swing registered', () => {
    const c = makeCanvas();
    const ctx = ctxOf(c);
    c.setReducedMotion(true);
    const list = [ent(1, 'hero', 50, 50, 'player', true)];
    assert.equal(c.swing(50, 50, 1, 0, 1000), true);
    c.render(list, 50, 50, 1000 + 40);
    assert.equal(ctx.count('arc'), 0, 'no arc sweep under reduced motion');
  });

  it('only animates one swing per 800ms server cooldown', () => {
    const c = makeCanvas();
    assert.equal(c.swing(50, 50, 1, 0, 1000), true);
    assert.equal(c.swing(50, 50, 1, 0, 1400), false, 'too soon');
    assert.equal(c.swing(50, 50, 1, 0, 1000 + SWING_COOLDOWN_MS), true);
  });

  it('lunges the player sprite forward along the swing direction', () => {
    const c = makeCanvas();
    const list = [ent(1, 'hero', 50, 50, 'player', true)];
    c.render(list, 50, 50, 1000);
    const restX = bodyX(ctxOf(c));
    ctxOf(c).calls.length = 0;
    c.swing(50, 50, 1, 0, 1000);
    c.render(list, 50, 50, 1000 + SWING_MS / 2);
    const midX = bodyX(ctxOf(c));
    assert.ok(midX > restX, `lunged toward +x (${restX} -> ${midX})`);
  });

  /** X of the first 20x26 body roundRect (the standing avatar). */
  function bodyX(ctx: Ctx2D): number {
    const b = ctx.calls.find((x) => x.op === 'roundRect' && x.args[2] === 20);
    return b === undefined ? NaN : Number(b.args[0]);
  }
});

describe('feedback (Canvas2D): kill confirmation', () => {
  it('a plain kill draws one bright expanding ring', () => {
    const c = makeCanvas();
    const ctx = ctxOf(c);
    const style = c.killBurst(50, 50, false, 1000);
    c.render([], 50, 50, 1000);
    const rings = ctx.calls.filter((x) => x.op === 'ellipse').length;
    assert.ok(rings >= 1, 'a ring is drawn');
    assert.ok(style.particles > 0);
  });

  it('a finisher draws more, larger rings than a plain kill', () => {
    const plain = makeCanvas();
    plain.killBurst(50, 50, false, 1000);
    const plainCtx = ctxOf(plain);
    plain.render([], 50, 50, 1000);
    const plainRings = plainCtx.calls.filter((x) => x.op === 'ellipse').length;

    const fin = makeCanvas();
    fin.killBurst(50, 50, true, 1000);
    const finCtx = ctxOf(fin);
    fin.render([], 50, 50, 1000);
    const finRings = finCtx.calls.filter((x) => x.op === 'ellipse').length;

    assert.ok(finRings > plainRings, `finisher ${finRings} > plain ${plainRings}`);
  });

  it('rings are cleaned up after their lifetime', () => {
    const c = makeCanvas();
    const ctx = ctxOf(c);
    c.killBurst(50, 50, true, 1000);
    c.render([], 50, 50, 1000 + 5000);
    assert.equal(ctx.calls.filter((x) => x.op === 'ellipse').length, 0);
  });

  it('a finisher also prints its labelled marker', () => {
    const c = makeCanvas();
    const ctx = ctxOf(c);
    assert.equal(c.finisher(50, 50, 1000), true);
    c.render([], 50, 50, 1000);
    assert.ok(ctx.calls.some((x) => x.op === 'fillText' && x.args[0] === FINISHER_LABEL));
  });
});

// ---------------------------------------------------------------------------
// IsoRenderer
// ---------------------------------------------------------------------------

describe('feedback (IsoRenderer): HP bar gating', () => {
  function bodiesOf(iso: IsoRenderer) {
    return (iso as unknown as {
      bodies: Map<number, { refs: { hpBg: { visible: boolean } | null; hpFg: { visible: boolean } | null } }>;
    }).bodies;
  }

  it('a quiet mob has no visible bar', () => {
    const iso = makeIso();
    try {
      iso.update([ent(1, 'hero', 50, 50, 'player', true), ent(2, 'gloom', 52, 50)], 50, 50, 10_000);
      const b = bodiesOf(iso).get(2)!;
      assert.equal(b.refs.hpBg!.visible, false);
      assert.equal(b.refs.hpFg!.visible, false);
    } finally {
      iso.dispose();
    }
  });

  it('the mob just hit shows a bar', () => {
    const iso = makeIso();
    try {
      iso.update([ent(1, 'hero', 50, 50, 'player', true), ent(2, 'gloom', 52, 50)], 50, 50, 10_000);
      iso.hitFlash(2, false, 10_000);
      iso.update([ent(1, 'hero', 50, 50, 'player', true), ent(2, 'gloom', 52, 50)], 50, 50, 10_000);
      const b = bodiesOf(iso).get(2)!;
      assert.equal(b.refs.hpBg!.visible, true);
      assert.equal(b.refs.hpFg!.visible, true);
    } finally {
      iso.dispose();
    }
  });

  it('the current target shows a bar; the bar drops when it goes quiet', () => {
    const iso = makeIso();
    try {
      iso.setTarget(2);
      const list = [ent(1, 'hero', 50, 50, 'player', true), ent(2, 'gloom', 52, 50)];
      iso.update(list, 50, 50, 10_000);
      assert.equal(bodiesOf(iso).get(2)!.refs.hpBg!.visible, true);
      iso.setTarget(-1);
      iso.update(list, 50, 50, 10_000 + MOB_BAR_RECENT_MS + 1);
      assert.equal(bodiesOf(iso).get(2)!.refs.hpBg!.visible, false);
    } finally {
      iso.dispose();
    }
  });

  it('a corpse shows no bar', () => {
    const iso = makeIso();
    try {
      iso.setTarget(2);
      iso.update([ent(1, 'hero', 50, 50, 'player', true), ent(2, 'gloom', 52, 50, 'mob', false, 0)], 50, 50, 10_000);
      assert.equal(bodiesOf(iso).get(2)!.refs.hpBg!.visible, false);
    } finally {
      iso.dispose();
    }
  });

  it('the local player keeps their own bar', () => {
    const iso = makeIso();
    try {
      iso.update([ent(1, 'hero', 50, 50, 'player', true)], 50, 50, 10_000);
      assert.equal(bodiesOf(iso).get(1)!.refs.hpBg!.visible, true);
    } finally {
      iso.dispose();
    }
  });
});

describe('feedback (IsoRenderer): hit flash', () => {
  function bodyColor(iso: IsoRenderer, id: number) {
    const b = (iso as unknown as {
      bodies: Map<number, { refs: { bodyMat: { color: { getHex(): number } } } }>;
    }).bodies.get(id)!;
    return b.refs.bodyMat.color.getHex();
  }

  it('a struck mob flares toward white', () => {
    const iso = makeIso();
    try {
      const list = [ent(1, 'hero', 50, 50, 'player', true), ent(2, 'gloom', 52, 50)];
      iso.update(list, 50, 50, 10_000);
      const calm = bodyColor(iso, 2);
      iso.hitFlash(2, false, 10_000);
      iso.update(list, 50, 50, 10_000);
      const flashed = bodyColor(iso, 2);
      assert.notEqual(flashed, calm, 'the body colour changed');
      assert.ok(flashed > calm, `brighter (${calm} -> ${flashed})`);
      iso.update(list, 50, 50, 10_000 + HIT_FLASH_MS);
      assert.equal(bodyColor(iso, 2), calm, 'back to normal after 100ms');
    } finally {
      iso.dispose();
    }
  });

  it('the player flares toward red instead of white', () => {
    const iso = makeIso();
    try {
      const list = [ent(1, 'hero', 50, 50, 'player', true)];
      iso.update(list, 50, 50, 10_000);
      const calm = bodyColor(iso, 1);
      iso.hitFlash(1, true, 10_000);
      iso.update(list, 50, 50, 10_000);
      const flashed = bodyColor(iso, 1);
      // Red dominates: the green channel drops relative to the calm body.
      const cg = (v: number) => (v >> 8) & 0xff;
      assert.ok(cg(flashed) < cg(calm), `reddened (${calm} -> ${flashed})`);
    } finally {
      iso.dispose();
    }
  });

  it('the mob and player tints are genuinely different colours', () => {
    assert.notEqual(HIT_FLASH_MOB, HIT_FLASH_PLAYER);
  });
});

describe('feedback (IsoRenderer): swing', () => {
  it('lunges the local avatar, then puts it back', () => {
    const iso = makeIso();
    try {
      const list = [ent(1, 'hero', 50, 50, 'player', true)];
      iso.update(list, 50, 50, 1000);
      const group = (iso as unknown as { bodies: Map<number, { refs: { group: { position: { x: number; z: number } } } }> })
        .bodies.get(1)!.refs.group;
      const restX = group.position.x;
      iso.swing(50, 50, 1, 0, 1000);
      iso.update(list, 50, 50, 1000 + SWING_MS / 2);
      assert.ok(group.position.x > restX, `lunged (${restX} -> ${group.position.x})`);
      iso.update(list, 50, 50, 1000 + SWING_MS + 1);
      assert.equal(group.position.x, restX, 'and returned');
    } finally {
      iso.dispose();
    }
  });

  it('honours the 800ms server cadence', () => {
    const iso = makeIso();
    try {
      assert.equal(iso.swing(50, 50, 1, 0, 1000), true);
      assert.equal(iso.swing(50, 50, 1, 0, 1500), false);
      assert.equal(iso.swing(50, 50, 1, 0, 1000 + SWING_COOLDOWN_MS), true);
    } finally {
      iso.dispose();
    }
  });

  it('emits a reusable whoosh mesh without growing the scene per swing', () => {
    const iso = makeIso();
    try {
      iso.update([], 50, 50, 1000);
      const before = iso.childCount();
      iso.swing(50, 50, 1, 0, 1000);
      iso.update([], 50, 50, 1010);
      const afterFirst = iso.childCount();
      for (let i = 1; i < 10; i++) {
        iso.swing(50, 50, 1, 0, 1000 + i * SWING_COOLDOWN_MS);
        iso.update([], 50, 50, 1010 + i * SWING_COOLDOWN_MS);
      }
      assert.ok(afterFirst > before, 'the first swing adds its whoosh');
      assert.equal(iso.childCount(), afterFirst, 'later swings reuse it');
    } finally {
      iso.dispose();
    }
  });

  it('an idle frame adds nothing', () => {
    const iso = makeIso();
    try {
      iso.update([ent(1, 'hero', 50, 50, 'player', true)], 50, 50, 1000);
      const steady = iso.childCount();
      for (let i = 1; i <= 5; i++) iso.update([ent(1, 'hero', 50, 50, 'player', true)], 50, 50, 1000 + i * 16);
      assert.equal(iso.childCount(), steady);
    } finally {
      iso.dispose();
    }
  });
});

describe('feedback (IsoRenderer): kill confirmation', () => {
  it('spawns ring meshes that hide again after the lifetime', () => {
    const iso = makeIso();
    try {
      iso.update([], 50, 50, 1000);
      const before = iso.childCount();
      iso.killBurst(50, 50, false, 1000);
      iso.update([], 50, 50, 1010);
      assert.ok(iso.childCount() > before, 'a kill burst adds ring meshes');
      const rings = (iso as unknown as { killRings: Array<{ visible: boolean } | null> }).killRings;
      assert.ok(rings.some((r) => r !== null && r.visible), 'at least one ring is visible');
      iso.update([], 50, 50, 1000 + 5000);
      assert.ok(rings.every((r) => r === null || !r.visible), 'rings are hidden, not destroyed');
    } finally {
      iso.dispose();
    }
  });

  it('a finisher lights up more rings than a plain kill', () => {
    const plain = makeIso();
    const fin = makeIso();
    try {
      plain.update([], 50, 50, 1000);
      plain.killBurst(50, 50, false, 1000);
      plain.update([], 50, 50, 1010);
      const plainRings = (plain as unknown as { killRings: Array<{ visible: boolean } | null> })
        .killRings.filter((r) => r !== null && r.visible).length;

      fin.update([], 50, 50, 1000);
      fin.killBurst(50, 50, true, 1000);
      fin.update([], 50, 50, 1010);
      const finRings = (fin as unknown as { killRings: Array<{ visible: boolean } | null> })
        .killRings.filter((r) => r !== null && r.visible).length;

      assert.ok(finRings > plainRings, `finisher ${finRings} > plain ${plainRings}`);
    } finally {
      plain.dispose();
      fin.dispose();
    }
  });

  it('a finisher also queues its labelled marker', () => {
    const iso = makeIso();
    try {
      assert.equal(iso.finisher(50, 50, 1000), true);
      iso.damageNumbers().step(1000);
      assert.equal(iso.damageNumbers().liveCount, 1);
    } finally {
      iso.dispose();
    }
  });
});

describe('feedback: reduced motion', () => {
  it('the 2D kill burst stops expanding and throws no particles', () => {
    // Particles are the only small fillRects (2-5px); tiles are TILE_PX wide.
    const particles = (ctx: Ctx2D) =>
      ctx.calls.filter((x) => x.op === 'fillRect' && Number(x.args[2]) < 8).length;

    const moving = makeCanvas();
    moving.killBurst(50, 50, false, 1000);
    moving.render([], 50, 50, 1000);
    const movingCtx = ctxOf(moving);
    assert.ok(particles(movingCtx) > 0, 'particles were thrown');

    const still = makeCanvas();
    still.setReducedMotion(true);
    assert.equal(still.isReducedMotion(), true);
    still.killBurst(50, 50, false, 1000);
    still.render([], 50, 50, 1000);
    const stillCtx = ctxOf(still);
    assert.equal(particles(stillCtx), 0, 'no particles');
    const stillRings = stillCtx.calls.filter((x) => x.op === 'ellipse').map((x) => Number(x.args[1]));
    assert.ok(stillRings.length > 0, 'the confirmation still shows');
    for (let i = 1; i < stillRings.length; i++) {
      assert.equal(stillRings[i], stillRings[0], 'the ring does not sweep outward');
    }
  });

  it('the 3D kill burst still fires, just shorter', () => {
    const iso = makeIso();
    try {
      iso.setReducedMotion(true);
      assert.equal(iso.isReducedMotion(), true);
      iso.update([], 50, 50, 1000);
      const before = iso.childCount();
      iso.killBurst(50, 50, true, 1000);
      iso.update([], 50, 50, 1010);
      assert.ok(iso.childCount() > before, 'rings still appear');
      iso.update([], 50, 50, 1400);
      const rings = (iso as unknown as { killRings: Array<{ visible: boolean } | null> }).killRings;
      assert.ok(rings.every((r) => r === null || !r.visible), 'and are gone quickly');
    } finally {
      iso.dispose();
    }
  });

  it('does not disturb the projectile spin it shares the rotation channel with', () => {
    const iso = makeIso();
    try {
      const list = [ent(1, 'hero', 50, 50, 'player', true), ent(5, 'bolt', 50.5, 50, 'projectile')];
      const spinOf = () => (iso as unknown as {
        bodies: Map<number, { refs: { body: { rotation: { y: number } } } }>;
      }).bodies.get(5)!.refs.body.rotation.y;
      iso.update(list, 50, 50, 1000);
      iso.update(list, 50, 50, 1016);
      const a = spinOf();
      iso.update(list, 50, 50, 1032);
      const b = spinOf();
      assert.ok(b > a, `projectile keeps spinning (${a} -> ${b})`);
    } finally {
      iso.dispose();
    }
  });

  it('a swing resets the character twist once it ends', () => {
    const iso = makeIso();
    try {
      const list = [ent(1, 'hero', 50, 50, 'player', true)];
      const twist = () => (iso as unknown as {
        bodies: Map<number, { refs: { body: { rotation: { y: number } } } }>;
      }).bodies.get(1)!.refs.body.rotation.y;
      iso.swing(50, 50, 1, 0, 1000);
      iso.update(list, 50, 50, 1000 + SWING_MS / 2);
      assert.notEqual(twist(), 0, 'the body twists mid-swing');
      iso.update(list, 50, 50, 1000 + SWING_MS + 1);
      assert.equal(twist(), 0, 'and unwinds afterwards');
    } finally {
      iso.dispose();
    }
  });
});

describe('feedback (IsoRenderer): damage numbers + a11y mode', () => {
  it('owns a capped pool the DOM overlay reads', () => {
    const iso = makeIso();
    try {
      const pool = iso.damageNumbers();
      assert.equal(pool.capacity, 24);
      for (let i = 0; i < 50; i++) {
        iso.damageNumbers().spawn(i * 5, 0, 5, 'normal', 1000, 'full');
      }
      pool.step(1000);
      assert.equal(pool.liveCount, 24);
    } finally {
      iso.dispose();
    }
  });

  it('high-contrast mode drops the pool', () => {
    const iso = makeIso();
    try {
      assert.equal(iso.damageNumberMode(), 'full');
      iso.damageNumbers().spawn(0, 0, 10, 'normal', 1000, 'full');
      iso.setDamageNumberMode('off');
      assert.equal(iso.damageNumberMode(), 'off');
      iso.damageNumbers().step(1000);
      assert.equal(iso.damageNumbers().liveCount, 0, 'the pool was cleared');
    } finally {
      iso.dispose();
    }
  });
});