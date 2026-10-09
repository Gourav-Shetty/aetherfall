import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Sim } from './sim.js';
import { TICK_HZ } from '@aetherfall/shared';

function runScenario(seedOffset: number): string {
  const sim = new Sim();
  sim.addPlayer(1, 'a', 10 + seedOffset, 10);
  sim.addPlayer(2, 'b', 20, 20);
  sim.setVelocity(1, 8, 0, 1);
  sim.setVelocity(2, 0, -8, 1);
  const dt = 1 / TICK_HZ;
  for (let i = 0; i < 60; i++) sim.step(dt);
  // round to avoid float-string noise; determinism means identical strings
  return JSON.stringify(sim.snapshot().map((e) => [e.id, +e.p.x.toFixed(6), +e.p.y.toFixed(6), +e.v.x.toFixed(6), +e.v.y.toFixed(6)]));
}

describe('sim tick determinism', () => {
  it('same inputs produce identical snapshots', () => {
    assert.equal(runScenario(0), runScenario(0));
  });

  it('integrates velocity and clamps arena bounds', () => {
    const sim = new Sim();
    sim.addPlayer(7, 'edge', 99, 99);
    sim.setVelocity(7, 8, 8, 1);
    for (let i = 0; i < 120; i++) sim.step(1 / TICK_HZ);
    const p = sim.players.get(7);
    assert.ok(p);
    assert.ok(p!.x <= 100 && p!.y <= 100);
    assert.equal(sim.tick, 120);
  });

  it('gameplay hooks run as extension points', () => {
    const sim = new Sim();
    let calls = 0;
    sim.registerSystem(() => {
      calls++;
    });
    sim.step(1 / TICK_HZ);
    assert.equal(calls, 1);
  });
});
