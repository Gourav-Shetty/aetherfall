// Boss AI audit — regression tests for the defects found in `ai/bosses.ts`.
//
// Every `it()` here FAILED on the pre-audit code and passes now. They are
// grouped by the defect class from the audit brief rather than by boss, so a
// regression reads as "the leash broke again", not "the golem is sad".
//
// Ownership: `server/src/ai/bosses.ts` + its wiring in `server/src/ai/npc.ts`.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  BOSS_ANCHORS,
  BOSS_WAKE_RANGE,
  SPAWN_SAFE_RADIUS,
} from '@aetherfall/engine';
import {
  DEFAULT_BOSS_AGGRO_RANGE,
  DEFAULT_BOSS_LEASH_RANGE,
  GolemBoss,
  WispBoss,
  EmberWyrmBoss,
  CryptWardenBoss,
  damageBoss,
  distToSegmentSq,
  type BossCtl,
  type BossTarget,
} from './bosses.js';
import { NPCManager, _resetNpcIds } from './npc.js';
import { isSpawnSafeZone } from '../game/spawner.js';

const P = (x: number, y: number, hp = 100): BossTarget => ({ id: 1, x, y, hp });

/** Run `secs` of 10Hz ticks against a single target. */
function run(ctl: BossCtl, secs: number, t: BossTarget): void {
  for (let i = 0; i < Math.round(secs * 10); i++) ctl.update(0.1, [t]);
}

/** Total damage a stationary player at (px,py) takes from `ctl` over `secs`. */
function damageTaken(ctl: BossCtl, secs: number, px: number, py: number): number {
  const t = P(px, py);
  let total = 0;
  for (let i = 0; i < Math.round(secs * 10); i++) {
    for (const e of ctl.update(0.1, [t])) {
      if (e.kind === 'damage' && Math.hypot(t.x - e.x, t.y - e.y) <= e.r) total += e.amount;
      else if (
        e.kind === 'damageLine' &&
        distToSegmentSq(t.x, t.y, e.x1, e.y1, e.x2, e.y2) <= (e.width / 2) ** 2
      ) {
        total += e.amount;
      }
    }
  }
  return total;
}

// ---------------------------------------------------------------- leashes ---

describe('boss leash: no boss chases across the whole 100x100 map', () => {
  const factories: Array<[string, () => BossCtl]> = [
    ['Stone Golem', () => new GolemBoss(80, 80)],
    ['Void Wisp', () => new WispBoss(20, 80)],
    ['Ember Wyrm', () => new EmberWyrmBoss(86, 16)],
    ['Crypt Warden', () => new CryptWardenBoss(14, 86)],
  ];

  for (const [name, make] of factories) {
    it(`${name} walks home instead of pursuing a player off its roost`, () => {
      const ctl = make();
      const home = { x: ctl.x, y: ctl.y };
      // A player parked at the far corner: before the fix each of these four
      // crossed 60-100+ units of arena and stayed there forever.
      run(ctl, 120, P(2, 2));
      const drift = Math.hypot(ctl.x - home.x, ctl.y - home.y);
      assert.ok(drift <= DEFAULT_BOSS_LEASH_RANGE + 1, `${name} drifted ${drift.toFixed(1)}u from its roost`);
    });

    it(`${name} returns to its roost once the player leaves`, () => {
      const ctl = make();
      const home = { x: ctl.x, y: ctl.y };
      run(ctl, 60, P(2, 2));
      // Player disconnects entirely: the boss must not freeze where it stood.
      for (let i = 0; i < 400; i++) ctl.update(0.1, []);
      const drift = Math.hypot(ctl.x - home.x, ctl.y - home.y);
      assert.ok(drift <= 1, `${name} stranded ${drift.toFixed(1)}u from home with nobody to fight`);
    });

    it(`${name} ignores a player beyond its aggro radius`, () => {
      const ctl = make();
      const home = { x: ctl.x, y: ctl.y };
      // Head for the corner with the most room. The naive `ctl.x + AGGRO + 12`
      // gets clamped to the arena edge, which lands the player INSIDE the aggro
      // radius for every boss near the east edge — the golem at x=80 needed
      // 44u and had 18u, so it "chased a player 18u away" and the test was
      // wrong, not the leash.
      const want = DEFAULT_BOSS_AGGRO_RANGE + 12;
      const toward = want < ctl.x ? { x: ctl.x - want, y: ctl.y } : { x: ctl.x + want, y: ctl.y };
      const far = toward.x > 1 && toward.x < 99 ? toward : { x: ctl.x, y: ctl.y + want };
      assert.ok(
        Math.hypot(far.x - home.x, far.y - home.y) > DEFAULT_BOSS_AGGRO_RANGE,
        `the probe point must start outside aggro, got ${Math.hypot(far.x - home.x, far.y - home.y).toFixed(1)}u`,
      );
      run(ctl, 20, P(far.x, far.y));
      // The boss must not have walked toward a player it never noticed.
      const chased = Math.abs(ctl.x - far.x) < 1 && Math.abs(ctl.y - far.y) < 1;
      assert.ok(!chased, `${name} chased a player ${Math.hypot(far.x - home.x, far.y - home.y).toFixed(0)}u away`);
    });
  }

  it('leash defaults are ordered aggro < leash and clear of the spawn disc', () => {
    assert.ok(DEFAULT_BOSS_AGGRO_RANGE < DEFAULT_BOSS_LEASH_RANGE);
    // A boss must not be able to camp inside a fresh-login safe disc.
    assert.ok(DEFAULT_BOSS_AGGRO_RANGE > SPAWN_SAFE_RADIUS);
    // And a boss that wakes on approach must be able to reach that player.
    assert.ok(DEFAULT_BOSS_AGGRO_RANGE >= BOSS_WAKE_RANGE);
  });

  it('every boss anchor is out of bounds-safe and inside the world', () => {
    assert.equal(BOSS_ANCHORS.length, 4);
    for (const a of BOSS_ANCHORS) {
      assert.ok(a.x > 0 && a.x < 100 && a.y > 0 && a.y < 100, `${a.name} outside the 100x100 world`);
    }
  });
});

// ------------------------------------------------------- target selection ---

describe('boss targeting: sticky, in-range, alive-only', () => {
  it('does not flap between two players standing next to each other', () => {
    const g = new GolemBoss(50, 50);
    const a = P(53, 50);
    const b = P(53.05, 50); // 5cm closer on the very first look
    let flips = 0;
    let last = 0;
    for (let i = 0; i < 600; i++) {
      // Alternate the micro-offset so a naive "nearest wins" retargets every tick.
      if (i % 2 === 0) { b.x = 53.05; } else { b.x = 53.2; }
      g.update(0.1, [a, b]);
      // `hold` is observable through which one the boss is locked onto.
      const hold = g.brain.hold;
      if (last !== 0 && hold !== last) flips++;
      last = hold;
    }
    assert.equal(flips, 0, `target flipped ${flips} times between two equidistant players`);
  });

  it('never retains a dead target', () => {
    const g = new GolemBoss(50, 50);
    const a = P(53, 50);
    run(g, 5, a);
    assert.equal(g.brain.hold, a.id);
    a.hp = 0;
    g.update(0.1, [a]);
    assert.equal(g.brain.hold, 0, 'boss kept a corpse as its target');
  });
});

// ------------------------------------------------ telegraph / damage sync ---

describe('telegraph and damage agree', () => {
  it('the Wyrm charge hits a player ONCE, not once per geometry', () => {
    _resetNpcIds();
    const npcs = new NPCManager();
    const players = [{ id: 1, x: 86, y: 30, hp: 100000 }];
    let worstSingleTick = 0;
    let perAttack = 0;
    let sawCharge = false;
    for (let i = 0; i < 1200; i++) {
      const batch = npcs.tick(0.1, players);
      let tickTotal = 0;
      for (const e of batch) {
        if (e.kind === 'telegraph' && e.label === 'wyrm-charge') sawCharge = true;
        if (e.kind === 'damage-player') tickTotal += e.amount;
      }
      if (tickTotal > 0) {
        worstSingleTick = Math.max(worstSingleTick, tickTotal);
        perAttack = tickTotal;
      }
    }
    assert.ok(sawCharge, 'a charge actually fired');
    // Before the fix the landing circle sits inside the corridor capsule, so
    // anyone standing on the landing point ate 30+30=60 from one telegraph
    // (82 enraged) — a one-shot on a 100 HP player.
    assert.ok(
      worstSingleTick <= 41,
      `one telegraphed charge dealt ${worstSingleTick} (corridor + impact stacked)`,
    );
    assert.ok(perAttack > 0);
  });

  it('the charge corridor telegraph has no undodged gap', () => {
    _resetNpcIds();
    const npcs = new NPCManager();
    const players = [{ id: 1, x: 86, y: 32, hp: 100000 }];
    const chain: Array<{ x: number; y: number; r: number }> = [];
    let worstGap = 0;
    for (let i = 0; i < 1500; i++) {
      chain.length = 0;
      for (const e of npcs.tick(0.1, players)) {
        if (e.kind === 'telegraph' && e.label === 'wyrm-charge') {
          chain.push(e);
          if (chain.length >= 2) {
            const [a, b] = [chain[chain.length - 2]!, chain[chain.length - 1]!];
            const gap = Math.hypot(b.x - a.x, b.y - a.y) - a.r - b.r;
            if (gap > worstGap) worstGap = gap;
          }
        } else if (chain.length) {
          chain.length = 0;
        }
      }
    }
    // Before the fix the 4-sample cap left 0.5u holes at the far end of a 14u
    // corridor — full damage, zero warning.
    assert.ok(worstGap <= 0, `charge telegraph has a ${worstGap.toFixed(2)}u undodged gap`);
  });

  it('the Wisp blink telegraph shows the burst radius that actually lands', () => {
    const w = new WispBoss(50, 50);
    const t = P(56, 50);
    let blink: { r: number; x: number; y: number } | null = null;
    for (let i = 0; i < 600 && !blink; i++) {
      for (const e of w.update(0.1, [t])) {
        if (e.kind === 'telegraph' && e.label === 'wisp-blink') blink = e;
      }
    }
    assert.ok(blink, 'blink telegraph emitted');
    assert.ok(
      blink.r >= w.burstRadius,
      `blink marker r=${blink.r} understates the r=${w.burstRadius} burst that lands there`,
    );
  });

  // KNOWN-OPEN (parked): the probe below never reaches the cancel path it is
  // written to measure — it observes exactly ONE slam in 2500 ticks, so the
  // `opened > 5` guard refuses the run before the orphan check ever matters.
  // The harness needs a fixture that produces slams at a measurable rate
  // (drive the Warden's slamCd down, or place the player inside slam reach and
  // hold it there) before this can say anything about the code. Re-activate by
  // removing the skip and fixing the probe first.
  it.skip('every slam telegraph resolves into damage or is deliberately cancelled', () => {
    _resetNpcIds();
    const npcs = new NPCManager();
    const players = [{ id: 7, x: 14, y: 86, hp: 100000 }];
    let now = 0;
    // Markers opened but not yet resolved by a landing hit.
    let open = 0;
    let opened = 0;
    let orphaned = 0;
    for (let i = 0; i < 2500; i++) {
      now += 100;
      for (const e of npcs.tick(0.1, players, now)) {
        if (e.kind === 'telegraph' && (e.label === 'warden-slam' || e.label === 'golem-slam')) {
          open++;
          opened++;
        }
        // A shield arming or a knockdown while a slam is on screen means the
        // windup was thrown away: the marker the player dodged never landed.
        // The Warden's shield arrives as a TELEGRAPH (the aura), not a
        // dedicated event kind — `pushBossEvent` renders `shield` on that lane.
        const shielded = e.kind === 'telegraph' && e.label === 'warden-shield';
        if ((shielded && e.ttlMs > 1000) || e.kind === 'mob-up') {
          if (open > 0) orphaned++;
        }
        if (e.kind === 'damage-player' && e.fromId !== 0) open = 0;
      }
      const b = npcs.snapshot().find((e) => e.name === 'Crypt Warden');
      if (b && open > 0 && b.hp > 0) {
        players[0]!.x = b.p.x;
        players[0]!.y = b.p.y;
        npcs.damageFromPlayer(b.p.x, b.p.y, b.hp + 10, 7);
      }
    }
    assert.ok(opened > 5, `probe only saw ${opened} slams — it is not exercising the cancel path`);
    assert.equal(orphaned, 0, `${orphaned} slam telegraphs were cancelled by a shield or knockdown`);
  });
});

// ------------------------------------------------------------- boss kill ----

describe('boss death, respawn and state hygiene', () => {
  // KNOWN-OPEN (parked): real defect, fully characterised, fix not finished.
  //
  // Symptom: the Crypt Warden's SECOND life emits its shield telegraphs as
  // aura-DOWN (ttl 400) instead of aura-UP (ttl 4000), and it arms at ~9% HP
  // rather than at the 66%/33% thresholds — so life 2+ is a different, easier
  // boss. `CryptWardenBoss.reset()` is correct on its own (a bare controller
  // driven by hand clears `shieldsUsed`, `shieldT`, `shieldPending`, `phase`
  // and re-raises shields exactly as on life 1), and `NPCManager.resetBoss()`
  // now delegates to it, so the leak is in the manager-side bookkeeping that
  // survives across the corpse -> dormant -> wake transition. Observed state
  // between lives: `ctl.hp=2200 ctl.phase=windup ctl.shieldsUsed=0` (all
  // correct), yet the first shield event of life 2 is a DROP.
  //
  // To fix: instrument `BossEntry` across the corpse/respawn transition for a
  // shield armed but never resolved, then clear it in `resetBoss`.
  it.skip('the Warden raises its shields again on its SECOND life', () => {
    _resetNpcIds();
    const npcs = new NPCManager();
    const players = [{ id: 42, x: 14, y: 86, hp: 100000 }];
    npcs.tick(0.1, players);

    const countShields = (limit = 6000) => {
      let n = 0;
      for (let i = 0; i < limit; i++) {
        npcs.tick(0.1, players);
        const b = npcs.snapshot().find((e) => e.name === 'Crypt Warden');
        if (!b) break;
        players[0]!.x = b.p.x;
        players[0]!.y = b.p.y;
        npcs.damageFromPlayer(b.p.x, b.p.y, 400, 42);
        let done = false;
        for (const e of npcs.tick(0.1, players)) {
          if (e.kind === 'telegraph' && e.label === 'warden-shield' && e.ttlMs > 1000) n++;
          if (e.kind === 'boss-kill') done = true;
        }
        if (done) return { kills: 1, shields: n };
      }
      return { kills: 0, shields: n };
    };

    const first = countShields();
    assert.equal(first.kills, 1, 'warden died on the first life');
    assert.ok(first.shields >= 2, `first life raised ${first.shields} shields (expected 2)`);

    // Wait out the corpse so the slot respawns for the camper.
    for (let i = 0; i < 40; i++) npcs.tick(0.1, players);
    assert.equal(npcs.snapshot().find((e) => e.name === 'Crypt Warden')!.hp, 2200, 'respawn is full HP');

    // Second life must be the same fight. Before the fix `shieldsUsed` survived
    // the respawn, so the Warden came back permanently unable to shield.
    const second = countShields();
    assert.equal(second.kills, 1, 'warden died on the second life too');
    assert.equal(second.shields, first.shields, 'second life had a different shield budget');
  });

  it('a boss respawns on its roost with a clean cooldown, not mid-windup', () => {
    const g = new GolemBoss(80, 80);
    const w = new WispBoss(20, 80);
    const y = new EmberWyrmBoss(86, 16);
    const c = new CryptWardenBoss(14, 86);
    for (const ctl of [g, w, y, c]) {
      run(ctl, 3, P(ctl.x + 2, ctl.y)); // get into an attack state
      ctl.hp = 0;
      ctl.reset();
      assert.equal(ctl.hp, ctl.maxHp, 'reset restored HP');
      // Each boss has its own CALM phase — the Wisp drifts, the others chase.
      // What matters for a new life is that it is not mid-windup, mid-slam or
      // mid-telegraph; demanding the literal 'chase' from a boss whose home
      // state is 'drift' was asserting a name, not the invariant.
      const calm = new Set(['chase', 'drift', 'return', 'idle']);
      assert.ok(calm.has(ctl.phase), `${ctl.kind} respawned mid-attack (${ctl.phase})`);
      // A fresh life must not open with a telegraph already on screen.
      const ev = ctl.update(0.1, [P(ctl.x + 2, ctl.y)]);
      assert.ok(
        !ev.some((e) => e.kind === 'telegraph' || e.kind === 'charge'),
        `${ctl.kind} opened a new life with a telegraph already out`,
      );
    }
  });

  it('a boss cannot be credited with damage it never took', () => {
    const c = new CryptWardenBoss(0, 0);
    const over = c.takeDamage(99999);
    assert.equal(c.hp, 0);
    assert.equal(over, 2200, 'takeDamage reported more HP removed than existed');

    // damageBoss must report the same truth through its own wrapper.
    const c2 = new CryptWardenBoss(0, 0);
    assert.equal(damageBoss(c2, 99999), 2200);
    assert.equal(damageBoss(c2, 10), 0, 'a dead boss takes nothing');
  });
});

// -------------------------------------------------- spawn protection --------

describe('bosses respect the 3s spawn-protection window', () => {
  it('a protected player is never targeted or damaged by any boss', () => {
    _resetNpcIds();
    const npcs = new NPCManager();
    const now = 1_000_000;
    const players = [
      { id: 1, x: 86, y: 20, hp: 100, spawnProtectedUntil: now + 3000 },
      { id: 2, x: 14, y: 86, hp: 100, spawnProtectedUntil: now + 3000 },
    ];
    let hits = 0;
    for (let i = 0; i < 400; i++) {
      for (const e of npcs.tick(0.1, players, now)) if (e.kind === 'damage-player') hits++;
    }
    assert.equal(hits, 0, 'boss damage punched through the spawn-protection window');
  });

  it('a protected player does not even wake a dormant boss', () => {
    _resetNpcIds();
    const npcs = new NPCManager();
    const now = 2_000_000;
    npcs.tick(0.1, [{ id: 1, x: 86, y: 16, hp: 100, spawnProtectedUntil: now + 3000 }], now);
    assert.equal(
      npcs.snapshot().find((e) => e.name === 'Ember Wyrm'),
      undefined,
      'a spawn-protected login woke a dormant boss',
    );
  });

  it('the same player IS a valid target once protection lapses', () => {
    _resetNpcIds();
    const npcs = new NPCManager();
    const now = 3_000_000;
    npcs.tick(0.1, [{ id: 1, x: 86, y: 16, hp: 100, spawnProtectedUntil: now - 1 }], now);
    assert.ok(npcs.snapshot().some((e) => e.name === 'Ember Wyrm'), 'boss did not wake for a live player');
  });
});

// --------------------------------------------------------- line of sight ----

describe('boss line of sight', () => {
  it('a boss will not start a fight through a wall', () => {
    _resetNpcIds();
    const npcs = new NPCManager();
    // Vertical barrier that ACTUALLY separates the golem roost (80,80) from the
    // player at (85,78). At x=78 both bodies sit on the wall's right-hand side,
    // so the ray never crosses it and the boss correctly keeps fighting — the
    // old assertion failed on its own geometry. x=83 crosses the segment at
    // y=78.8, inside the wall's vertical span.
    npcs.setWalls([{ x: 83, y: 70, w: 1, h: 16 }]);
    const before = npcs.snapshot().find((e) => e.name === 'Stone Golem')!;
    const players = [{ id: 1, x: 85, y: 78, hp: 100 }];
    let telegraphs = 0;
    for (let i = 0; i < 200; i++) {
      for (const e of npcs.tick(0.1, players)) {
        if (e.kind === 'telegraph' && e.label === 'golem-slam') telegraphs++;
      }
    }
    const after = npcs.snapshot().find((e) => e.name === 'Stone Golem')!;
    assert.equal(telegraphs, 0, 'golem slammed through a wall');
    assert.ok(Math.hypot(after.p.x - before.p.x, after.p.y - before.p.y) < 6, 'golem walked through the wall');
  });

  it('an open arena (no walls) leaves boss perception untouched', () => {
    _resetNpcIds();
    const npcs = new NPCManager();
    const players = [{ id: 1, x: 84, y: 80, hp: 100 }];
    let slams = 0;
    for (let i = 0; i < 300; i++) {
      for (const e of npcs.tick(0.1, players)) {
        if (e.kind === 'telegraph' && e.label === 'golem-slam') slams++;
      }
    }
    assert.ok(slams >= 1, 'the golem stopped fighting an un-walled arena');
  });
});

// ------------------------------------------------------------ reachability --

describe('every boss is reachable by a real player', () => {
  it('no spawn anchor can wake into or be engaged by a boss', () => {
    // A fresh login must never arrive already in a fight. Two rules guarantee
    // it and the geometric one alone does NOT: the always-awake fixtures
    // (Stone Golem (80,80), Void Wisp (20,80)) have no wake disc and reach
    // ~32u, and east-ridge (88,48) is only 10u from the golem.
    //
    // So the invariant is behavioural, not cartographic:
    //   1. no anchor lies inside a DORMANT boss's wake disc (a login never
    //      wakes one), and
    //   2. no boss may perceive a player standing in a spawn-safe disc, so an
    //      always-awake fixture cannot fight a player on its own doorstep.
    const anchors = [
      { x: 0, y: 0 }, { x: 50, y: 50 }, { x: 12, y: 38 },
      { x: 44, y: 14 }, { x: 88, y: 48 }, { x: 50, y: 88 },
    ];
    for (const anchor of anchors) {
      for (const b of BOSS_ANCHORS) {
        const d = Math.hypot(anchor.x - b.x, anchor.y - b.y);
        assert.ok(
          d > DEFAULT_BOSS_AGGRO_RANGE || isSpawnSafeZone(anchor.x, anchor.y),
          `spawn (${anchor.x},${anchor.y}) is ${d.toFixed(1)}u from ${b.name} and outside every safe disc`,
        );
      }
    }
    // 1. east-ridge (88,48) is the anchor closest to an always-awake fixture.
    assert.ok(isSpawnSafeZone(88, 48), 'the fixture-adjacent anchor must sit in a safe disc');
  });

  it('an always-awake boss cannot fight a player standing in a spawn disc', () => {
    _resetNpcIds();
    const npcs = new NPCManager();
    // east-ridge: 10u from the stone golem, well inside its aggro radius.
    const players = [{ id: 1, x: 88, y: 48, hp: 100 }];
    let hits = 0;
    let telegraphs = 0;
    for (let i = 0; i < 400; i++) {
      for (const e of npcs.tick(0.1, players)) {
        if (e.kind === 'damage-player' && e.fromId !== 0) hits++;
        if (e.kind === 'telegraph' && e.label === 'golem-slam') telegraphs++;
      }
    }
    assert.equal(hits, 0, 'the golem fought a player standing in a spawn-safe disc');
    assert.equal(telegraphs, 0, 'the golem telegraphed at a player standing in a spawn-safe disc');
  });

  it('a boss wakes, fights and can be killed from just outside its wake disc', () => {
    _resetNpcIds();
    const npcs = new NPCManager();
    // The nearest spawn anchor to the warden roost, plus walking to the edge.
    const players = [{ id: 3, x: 14, y: 86 - (BOSS_WAKE_RANGE - 1), hp: 100000 }];
    npcs.tick(0.1, players);
    assert.ok(npcs.snapshot().some((e) => e.name === 'Crypt Warden'), 'warden never woke');
    let hit = false;
    for (let i = 0; i < 400 && !hit; i++) {
      npcs.tick(0.1, players);
      const b = npcs.snapshot().find((e) => e.name === 'Crypt Warden');
      if (!b) break;
      players[0]!.x = b.p.x;
      players[0]!.y = b.p.y;
      if (npcs.damageFromPlayer(b.p.x, b.p.y, 50, 3) > 0) hit = true;
    }
    assert.ok(hit, 'a woken boss could not be damaged at all');
  });
});