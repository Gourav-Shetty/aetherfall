import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { AntiCheat } from './anticheat.js';

describe('anticheat', () => {
  it('rejects input above rate limit and logs violation', () => {
    const ac = new AntiCheat({ minInputIntervalMs: 15 });
    assert.equal(ac.checkInputRate(1, 0, 1000), true);
    assert.equal(ac.checkInputRate(1, 1, 1005), false); // 5ms later
    assert.equal(ac.checkInputRate(1, 2, 1020), true);
    assert.equal(ac.violations.filter((v) => v.kind === 'input-rate').length, 1);
  });

  it('clamps speed to max and logs violation', () => {
    const ac = new AntiCheat({ maxSpeed: 8 });
    const ok = ac.checkVelocity(2, 0, 6, 0);
    assert.equal(ok.ok, true);
    const bad = ac.checkVelocity(2, 1, 30, 0);
    assert.equal(bad.ok, false);
    assert.ok(Math.hypot(bad.vx, bad.vy) <= 8 + 1e-9);
    assert.equal(ac.violationsFor(2).length, 1);
  });

  it('flags teleports beyond max step', () => {
    const ac = new AntiCheat({ maxStepDist: 5 });
    assert.equal(ac.checkTeleport(3, 0, { x: 0, y: 0 }, { x: 1, y: 1 }), true);
    assert.equal(ac.checkTeleport(3, 1, { x: 0, y: 0 }, { x: 50, y: 0 }), false);
    assert.equal(ac.violationsFor(3)[0]?.kind, 'teleport');
  });

  it('tolerates float dust on honest normalized moves (no log-spam clamp)', () => {
    const ac = new AntiCheat({ maxSpeed: 8 });
    ac.warnThrottleMs = 0; // count every violation if any were logged
    // Honest diagonal: normalized (1,1)/sqrt(2) scaled by 8 -> mag 8.0000001-ish.
    const d = 1 / Math.SQRT2;
    const req = ac.moveToVelocity(d, d);
    const mag = Math.hypot(req.vx, req.vy);
    assert.ok(mag <= 8 + 0.011, `mag=${mag}`);
    const checked = ac.checkVelocity(4, 0, req.vx, req.vy);
    assert.equal(checked.ok, true);
    assert.equal(ac.violationsFor(4).length, 0);
  });

  it('normalizes overlong diagonal sticks to the unit-circle budget', () => {
    const ac = new AntiCheat({ maxSpeed: 8 });
    const v = ac.moveToVelocity(1, 1);
    assert.ok(Math.hypot(v.vx, v.vy) <= 8 + 1e-9);
    assert.equal(ac.checkVelocity(5, 0, v.vx, v.vy).ok, true);
  });

  it('rejects non-finite velocity instead of poisoning the sim', () => {
    const ac = new AntiCheat({ maxSpeed: 8 });
    for (const bad of [[NaN, 0], [0, Infinity], [NaN, NaN]] as const) {
      const r = ac.checkVelocity(6, 0, bad[0], bad[1]);
      assert.equal(r.ok, false);
      assert.deepEqual([r.vx, r.vy], [0, 0]);
    }
    const v = ac.moveToVelocity(NaN, 1);
    assert.deepEqual([v.vx, v.vy], [0, 0]);
  });

  it('records every violation but throttles console warnings', () => {
    const ac = new AntiCheat({ maxSpeed: 8 });
    ac.warnThrottleMs = 60_000;
    let warns = 0;
    const orig = console.warn;
    console.warn = () => { warns++; };
    try {
      for (let i = 0; i < 10; i++) ac.checkVelocity(7, i, 30, 0);
    } finally {
      console.warn = orig;
    }
    assert.equal(ac.violationsFor(7).length, 10); // all recorded
    assert.equal(warns, 1); // ...but logged once
  });

  it('clumped inputs during a flagged slow tick drop without striking', () => {
    // Slow-tick catch-up window (saturated event loop dequeues honest 20Hz
    // inputs as a clump): the burst trip must still DROP (backpressure) but
    // accrue zero strikes, so honest bots are never kicked for server lag.
    const ac = new AntiCheat({ burstWindowMs: 200, burstMaxInputs: 20 });
    const t = 1_000_000;
    let dropped = 0;
    for (let i = 0; i < 30; i++) {
      if (!ac.checkInputBurst(1, i, t, true)) dropped++;
    }
    assert.ok(dropped > 0, 'clump still dropped (backpressure)');
    assert.equal(ac.getStrikes(1), 0);
    assert.equal(ac.shouldKick(1), false);
    assert.equal(ac.isShadowBanned(1), false);
    // Repeat the stall many times: exemptions never accumulate into a kick.
    for (let round = 0; round < 10; round++) {
      for (let i = 0; i < 30; i++) ac.checkInputBurst(1, 100 + round * 30 + i, t + round * 1000, true);
    }
    assert.equal(ac.getStrikes(1), 0);
    assert.equal(ac.shouldKick(1), false);
  });

  it('same clump on healthy ticks strikes to kick (real floods contained)', () => {
    // Identical traffic with slowTick=false (the default): trips strike, and
    // 3 strikes inside the decay window kick — the chaos-probe flood contract.
    const ac = new AntiCheat({ burstWindowMs: 200, burstMaxInputs: 20 });
    let now = 2_000_000;
    for (let i = 0; i < 100 && !ac.shouldKick(2); i++) {
      now += 1;
      ac.checkInputBurst(2, i, now);
    }
    assert.equal(ac.shouldKick(2), true);
    assert.equal(ac.isShadowBanned(2), true);
    assert.ok(ac.getStrikes(2) >= 3);
  });
});
