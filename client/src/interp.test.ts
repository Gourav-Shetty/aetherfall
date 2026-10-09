import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Interp } from './interp.js';
import type { EntitySnapshot } from '@aetherfall/shared';

function ent(id: number, x: number, y: number, hp = 100): EntitySnapshot {
  return { id, kind: 'mob', p: { x, y }, v: { x: 0, y: 0 }, hp, maxHp: 100 };
}

describe('Interp', () => {
  it('ignores the local player and interpolates between samples', () => {
    const ip = new Interp();
    ip.push([ent(7, 0, 0)], 7, 1000); // self -> skipped
    assert.equal(ip.sample(7, 1500), null);
    ip.push([ent(9, 0, 0)], 7, 1000);
    ip.push([ent(9, 10, 0)], 7, 1100);
    // render at 1050 (now=1150, 100ms delay) -> midpoint
    const s = ip.sample(9, 1150);
    assert.ok(s);
    assert.ok(Math.abs(s.x - 5) < 1e-9, `x=${s.x}`);
  });

  it('holds the latest sample when render time passes it', () => {
    const ip = new Interp();
    ip.push([ent(9, 3, 4)], 7, 1000);
    const s = ip.sample(9, 5000);
    assert.ok(s && s.x === 3 && s.y === 4);
  });

  it('prunes dead entities and forgets stale buffers', () => {
    const ip = new Interp();
    ip.push([ent(9, 0, 0), ent(10, 1, 1)], 7, 1000);
    ip.prune(new Set([9]));
    assert.equal(ip.sample(10, 1100), null);
    assert.ok(ip.sample(9, 1100));
    // 2s without update -> evicted
    ip.push([], 7, 4000);
    assert.equal(ip.sample(9, 4000), null);
  });
});
