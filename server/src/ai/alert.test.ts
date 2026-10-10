// Alert chain + surrender tests — `npm test --workspace=@aetherfall/server`.
//
// Covers the Hotline Miami loop through NPCManager.tick (10Hz):
// PATROL -> SUSPICIOUS (noise) -> ALERT (chase+attack + TAUNT) ->
// SEARCH (last-seen + 2 neighbors, 6s) -> PATROL, plus solo surrender
// (40% roll, seeded bounds) and pure-FSM state coverage for the new states.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mulberry32 } from '@aetherfall/shared';
import { NPCFSM, nextState, type FSMPerception } from './fsm.js';
import { NPCManager, _resetNpcIds, shouldSurrender, type PlayerView } from './npc.js';

const DT = 0.1; // NPC tick rate
const P = (id: number, x: number, y: number, hp = 100, vx?: number, vy?: number): PlayerView =>
  vx === undefined ? { id, x, y, hp } : { id, x, y, hp, vx, vy };

/** Fresh manager + one isolated probe at (50,50) facing +X. */
function probeWorld() {
  _resetNpcIds();
  const npcs = new NPCManager();
  const probe = npcs.spawnMinion('probe', 50, 50, [{ x: 50, y: 50 }, { x: 60, y: 50 }]);
  return { npcs, probe };
}

describe('noise -> SUSPICIOUS -> PATROL', () => {
  it('a patrol hearing a shot turns toward it for 1.5s, then stands down', () => {
    const { npcs, probe } = probeWorld();
    npcs.notifyNoise(55, 55); // ~7u away, inside the 18u earshot
    npcs.tick(DT, []);
    let dbg = npcs.debugMinion(probe)!;
    assert.equal(dbg.state, 'suspicious');
    assert.ok(Math.abs(dbg.facing - Math.PI / 4) < 0.02, `facing ${dbg.facing} looks at (55,55)`);
    // holds the stare while the timer runs (no movement either)
    const px = dbg.x;
    const py = dbg.y;
    for (let i = 0; i < 5; i++) npcs.tick(DT, []);
    dbg = npcs.debugMinion(probe)!;
    assert.equal(dbg.state, 'suspicious');
    assert.equal(dbg.x, px);
    assert.equal(dbg.y, py);
    // ...then stands down to patrol after 1.5s
    for (let i = 0; i < 15; i++) npcs.tick(DT, []);
    assert.equal(npcs.debugMinion(probe)!.state, 'patrol');
  });

  it('a far-off shot is ignored', () => {
    const { npcs, probe } = probeWorld();
    npcs.notifyNoise(90, 90); // ~57u away, outside the 18u earshot
    npcs.tick(DT, []);
    assert.equal(npcs.debugMinion(probe)!.state, 'idle');
  });

  it('melee swings are loud: a miss still turns nearby patrols', () => {
    const { npcs, probe } = probeWorld();
    // swing at open ground near the probe: hits nothing (returns -1)...
    assert.equal(npcs.damageFromPlayer(56, 56, 12), -1);
    // ...but the probe heard it.
    npcs.tick(DT, []);
    assert.equal(npcs.debugMinion(probe)!.state, 'suspicious');
  });
});

describe('vision acquisition + TAUNT', () => {
  it('a still target beyond 4u is unseen (sneak works)', () => {
    const { npcs, probe } = probeWorld();
    const ev = npcs.tick(DT, [P(1, 55, 50)]); // 5u ahead, frozen
    assert.equal(npcs.debugMinion(probe)!.state, 'idle');
    assert.ok(!ev.some((e) => e.kind === 'emote'), 'no taunt for unseen targets');
  });

  it('a moving target in the cone is chased with exactly one TAUNT', () => {
    const { npcs, probe } = probeWorld();
    const ev = npcs.tick(DT, [P(1, 55, 50, 100, 3, 0)]);
    assert.equal(npcs.debugMinion(probe)!.state, 'chase');
    const taunts = ev.filter((e) => e.kind === 'emote');
    assert.equal(taunts.length, 1);
    const t = taunts[0]!;
    assert.equal(t.fromId, probe);
    assert.equal(t.emote, 'laugh', 'reuses a known emote id (existing broadcast renders it)');
    assert.equal(t.label, 'Taunt');
    assert.ok(Number.isFinite(t.expiresAt) && t.expiresAt > 0);
    assert.ok(Number.isFinite(t.seq));
    // no repeat taunt while the chase continues
    const ev2 = npcs.tick(DT, [P(1, 55, 50, 100, 3, 0)]);
    assert.ok(!ev2.some((e) => e.kind === 'emote'), 'taunt fires once per acquisition');
  });

  it('a target outside the cone is unseen even at full sprint', () => {
    const { npcs, probe } = probeWorld();
    npcs.tick(DT, [P(1, 45, 50, 100, -8, 0)]); // 5u behind, sprinting
    assert.equal(npcs.debugMinion(probe)!.state, 'idle');
  });

  it('a wall between viewer and target blocks acquisition', () => {
    const { npcs, probe } = probeWorld();
    npcs.setWalls([{ x: 52, y: 45, w: 1, h: 10 }]); // vertical barrier ahead
    const ev = npcs.tick(DT, [P(1, 55, 50, 100, 3, 0)]);
    assert.equal(npcs.debugMinion(probe)!.state, 'idle');
    assert.ok(!ev.some((e) => e.kind === 'emote'));
  });
});

describe('lost sight -> SEARCH -> PATROL', () => {
  it('losing the chase sweeps last-seen + 2 neighbors for 6s', () => {
    const { npcs, probe } = probeWorld();
    npcs.tick(DT, [P(1, 55, 50, 100, 3, 0)]);
    assert.equal(npcs.debugMinion(probe)!.state, 'chase');
    // target vanishes (out of the world)
    npcs.tick(DT, []);
    const dbg = npcs.debugMinion(probe)!;
    assert.equal(dbg.state, 'search');
    assert.deepEqual(dbg.searchPts, [
      { x: 55, y: 50 },
      { x: 58, y: 50 },
      { x: 55, y: 53 },
    ]);
    // sweeps, then gives up back to patrol after 6s
    for (let i = 0; i < 65; i++) npcs.tick(DT, []);
    assert.equal(npcs.debugMinion(probe)!.state, 'patrol');
  });

  it('spotting the target mid-search re-acquires (taunts again)', () => {
    const { npcs, probe } = probeWorld();
    npcs.tick(DT, [P(1, 55, 50, 100, 3, 0)]);
    npcs.tick(DT, []);
    assert.equal(npcs.debugMinion(probe)!.state, 'search');
    const ev = npcs.tick(DT, [P(1, 55, 50, 100, 3, 0)]);
    assert.equal(npcs.debugMinion(probe)!.state, 'chase');
    assert.ok(ev.some((e) => e.kind === 'emote'), 're-acquisition taunts again');
  });
});

describe('shouldSurrender (pure gate)', () => {
  it('needs solo + <=25% HP + a won roll', () => {
    assert.equal(shouldSurrender(15, 60, false, 0.0), true);
    assert.equal(shouldSurrender(15, 60, false, 0.399), true);
    assert.equal(shouldSurrender(15, 60, false, 0.4), false);
    assert.equal(shouldSurrender(16, 60, false, 0.0), false, 'above 25% never surrenders');
    assert.equal(shouldSurrender(15, 60, true, 0.0), false, 'allies nearby: fights on');
    assert.equal(shouldSurrender(0, 60, false, 0.0), true, '0 HP still elects (death wins first)');
    assert.equal(shouldSurrender(15, 0, false, 0.0), false);
  });

  it('seeded rolls land inside probability bounds (~40%)', () => {
    const rng = mulberry32(7);
    let wins = 0;
    const N = 2000;
    for (let i = 0; i < N; i++) {
      if (shouldSurrender(10, 60, false, rng())) wins++;
    }
    const frac = wins / N;
    assert.ok(frac > 0.3 && frac < 0.5, `surrender rate ${frac} outside 30-50%`);
  });
});

describe('surrender integration', () => {
  /** Wound every subject to 25% HP; return ids that surrendered on the next tick. */
  function woundAll(npcs: NPCManager, ids: number[]): { ev: ReturnType<NPCManager['tick']>; surrendered: number[] } {
    for (const id of ids) {
      const d = npcs.debugMinion(id)!;
      npcs.damageFromPlayer(d.x, d.y, 45); // 60 -> 15 HP (25%)
    }
    const ev = npcs.tick(DT, []);
    const surrendered = ev.filter((e) => e.kind === 'surrender').map((e) => (e as { id: number }).id);
    return { ev, surrendered };
  }

  it('a share of solo wounded mobs surrenders (~40%)', () => {
    _resetNpcIds();
    const npcs = new NPCManager();
    // silence the 3 constructor minions as allies: kill them (corpses do not count)
    for (const id of npcs.minionIds()) {
      const d = npcs.debugMinion(id)!;
      npcs.damageFromPlayer(d.x, d.y, 999);
    }
    // 8x5 grid of isolated subjects (12u x 18u spacing, all >10u apart)
    const subjects: number[] = [];
    for (let ix = 0; ix < 8; ix++) {
      for (let iy = 0; iy < 5; iy++) {
        subjects.push(npcs.spawnMinion(`s-${ix}-${iy}`, 4 + ix * 12, 4 + iy * 18, [{ x: 4 + ix * 12, y: 4 + iy * 18 }]));
      }
    }
    const { surrendered } = woundAll(npcs, subjects);
    const frac = surrendered.length / subjects.length;
    assert.ok(surrendered.length > 0, 'at least one mob surrendered');
    assert.ok(frac > 0.15 && frac < 0.65, `surrender share ${frac} outside 15-65%`);
    for (const id of surrendered) {
      assert.equal(npcs.debugMinion(id)!.state, 'surrender');
    }
  });

  it('surrendered mobs stand still, die when attacked, break on non-lethal hits', () => {
    _resetNpcIds();
    const npcs = new NPCManager();
    for (const id of npcs.minionIds()) {
      const d = npcs.debugMinion(id)!;
      npcs.damageFromPlayer(d.x, d.y, 999);
    }
    const subjects: number[] = [];
    for (let i = 0; i < 8; i++) {
      subjects.push(npcs.spawnMinion(`s-${i}`, 10 + i * 11, 50, [{ x: 10 + i * 11, y: 50 }]));
    }
    const { surrendered } = woundAll(npcs, subjects);
    assert.ok(surrendered.length > 0, 'need a surrendered subject');
    const id = surrendered[0]!;
    // stands still with hands up
    const at = npcs.debugMinion(id)!;
    for (let i = 0; i < 10; i++) npcs.tick(DT, []);
    const still = npcs.debugMinion(id)!;
    assert.equal(still.state, 'surrender');
    assert.equal(still.x, at.x);
    assert.equal(still.y, at.y);
    // a lethal hit still kills (downed crawl, then a melee finisher)
    const victim = surrendered[1] ?? surrendered[0]!;
    const v = npcs.debugMinion(victim)!;
    npcs.damageFromPlayer(v.x, v.y, 999); // downs it (0 HP, 3s crawl)
    npcs.tick(DT, []);
    assert.ok(npcs.isNpcDowned(victim), 'lethal hit downs the surrendered mob');
    npcs.damageFromPlayer(v.x, v.y, 1); // melee finisher
    npcs.tick(DT, []);
    assert.equal(npcs.debugMinion(victim)!.state, 'dead');
    // a non-lethal hit breaks the surrender (re-aggro, never re-rolls)
    const b = npcs.debugMinion(id)!;
    npcs.damageFromPlayer(b.x, b.y, 5);
    npcs.tick(DT, []);
    assert.notEqual(npcs.debugMinion(id)!.state, 'surrender');
    for (let i = 0; i < 30; i++) npcs.tick(DT, []);
    assert.notEqual(npcs.debugMinion(id)!.state, 'surrender', 'broken surrenders never re-roll');
  });

  it('surrender holds until the 20s timeout, then patrols', () => {
    _resetNpcIds();
    const npcs = new NPCManager();
    for (const id of npcs.minionIds()) {
      const d = npcs.debugMinion(id)!;
      npcs.damageFromPlayer(d.x, d.y, 999);
    }
    const subjects: number[] = [];
    for (let i = 0; i < 8; i++) {
      subjects.push(npcs.spawnMinion(`s-${i}`, 10 + i * 11, 50, [{ x: 10 + i * 11, y: 50 }]));
    }
    const { surrendered } = woundAll(npcs, subjects);
    assert.ok(surrendered.length > 0);
    const id = surrendered[0]!;
    for (let i = 0; i < 100; i++) npcs.tick(DT, []); // 10s: still holding
    assert.equal(npcs.debugMinion(id)!.state, 'surrender');
    for (let i = 0; i < 110; i++) npcs.tick(DT, []); // past 20s
    assert.equal(npcs.debugMinion(id)!.state, 'patrol');
  });

  it('a mob with allies nearby never surrenders (fights on)', () => {
    _resetNpcIds();
    const npcs = new NPCManager();
    for (const id of npcs.minionIds()) {
      const d = npcs.debugMinion(id)!;
      npcs.damageFromPlayer(d.x, d.y, 999);
    }
    // pair inside the 10u ally radius
    const a = npcs.spawnMinion('pair-a', 50, 50, [{ x: 50, y: 50 }]);
    const b = npcs.spawnMinion('pair-b', 55, 50, [{ x: 55, y: 50 }]);
    const da = npcs.debugMinion(a)!;
    const dbb = npcs.debugMinion(b)!;
    npcs.damageFromPlayer(da.x, da.y, 45);
    npcs.damageFromPlayer(dbb.x, dbb.y, 45);
    for (let i = 0; i < 20; i++) {
      const ev = npcs.tick(DT, []);
      assert.ok(!ev.some((e) => e.kind === 'surrender'), 'allied mobs never elect surrender');
    }
    assert.notEqual(npcs.debugMinion(a)!.state, 'surrender');
  });
});

describe('fsm state coverage (new states)', () => {
  const base: FSMPerception = {
    hp: 100, maxHp: 100, targetVisible: false, distToTarget: Infinity,
    attackRange: 1.8, aggroRange: 14, fleeThreshold: 0.25,
  };
  const seen = (dist: number): FSMPerception => ({ ...base, targetVisible: true, distToTarget: dist });

  it('patrol/idle hear noise -> suspicious; stare lapses -> patrol', () => {
    assert.equal(nextState('idle', { ...base, heardNoise: true }), 'suspicious');
    assert.equal(nextState('patrol', { ...base, heardNoise: true }), 'suspicious');
    assert.equal(nextState('suspicious', { ...base, suspiciousTime: 0 }), 'suspicious');
    assert.equal(nextState('suspicious', { ...base, suspiciousTime: 1.5 }), 'patrol');
    // combat still wins over staring
    assert.equal(nextState('suspicious', seen(5)), 'chase');
    assert.equal(nextState('suspicious', seen(1)), 'attack');
  });

  it('lost contact routes through search, then patrol after 6s', () => {
    assert.equal(nextState('chase', { ...base }), 'search');
    assert.equal(nextState('attack', { ...base }), 'search');
    assert.equal(nextState('search', { ...base, searchTime: 0 }), 'search');
    assert.equal(nextState('search', { ...base, searchTime: 6 }), 'patrol');
    assert.equal(nextState('search', seen(5)), 'chase');
    assert.equal(nextState('search', seen(1)), 'attack');
  });

  it('surrender holds, breaks on attack, lapses after 20s', () => {
    assert.equal(nextState('chase', { ...seen(5), hp: 10, wantSurrender: true }), 'surrender');
    assert.equal(nextState('attack', { ...seen(1), hp: 10, wantSurrender: true }), 'surrender');
    assert.equal(nextState('flee', { ...seen(5), hp: 10, wantSurrender: true }), 'surrender');
    assert.equal(nextState('patrol', { ...base, hp: 10, wantSurrender: true }), 'surrender');
    const surr: FSMPerception = { ...seen(5), hp: 10, surrenderTime: 0 };
    assert.equal(nextState('surrender', surr), 'surrender');
    assert.equal(nextState('surrender', { ...surr, wasAttacked: true }), 'chase');
    assert.equal(nextState('surrender', { ...surr, wasAttacked: true, targetVisible: false, distToTarget: Infinity }), 'patrol');
    assert.equal(nextState('surrender', { ...surr, surrenderTime: 20 }), 'patrol');
    assert.equal(nextState('surrender', { ...surr, hp: 0 }), 'dead');
  });

  it('NPCFSM integrates the new timers', () => {
    const fsm = new NPCFSM('patrol');
    assert.equal(fsm.update(0.1, { ...base, heardNoise: true }), 'suspicious');
    assert.equal(fsm.update(1.0, base), 'suspicious');
    assert.equal(fsm.update(0.6, base), 'patrol');
    assert.equal(fsm.update(0.1, seen(3)), 'chase');
    assert.equal(fsm.update(0.1, { ...base }), 'search');
    for (let i = 0; i < 61; i++) fsm.update(0.1, base);
    assert.equal(fsm.state, 'patrol');
  });
});
