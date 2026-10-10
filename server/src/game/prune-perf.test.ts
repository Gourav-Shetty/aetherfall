// PERF regression: the spawn-safe prune runs on the 20Hz gameplay hot path and
// must not scale with the size of the world or with the player count.
//
// It shipped once as `for (const m of [...this.mobs.values()])` called from
// inside tickGameplay's per-player loop — a full copy of the mob map, once per
// player, per tick. A soak with 18 players measured gameplay=54.46ms on a
// 62.86ms tick because of it.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Spawner, SPAWN_SAFE_POINTS, SPAWN_SAFE_RADIUS } from './spawner.js';
import { createGameState, ensurePlayer, tickGameplay } from './index.js';

describe('spawn-safe prune: cost does not scale with world size', () => {
  it('a populated world prunes in well under a millisecond', () => {
    const s = new Spawner(1337);
    // Populate a world far larger than anything a real shard holds: 12x12
    // chunks of 32u is ~1400 mobs before pruning removes the disc hits.
    for (let cy = 0; cy < 12; cy++) {
      for (let cx = 0; cx < 12; cx++) s.ensureAround(cx * 32 + 16, cy * 32 + 16, 0);
    }
    const total = s.mobCount();
    assert.ok(total > 400, `expected a populated world, got ${total} mobs`);

    // Warm the JIT, then measure the steady-state cost.
    s.pruneSpawnSafe();
    const t0 = process.hrtime.bigint();
    let removed = 0;
    for (let i = 0; i < 200; i++) removed += s.pruneSpawnSafe().length;
    const perCallMs = Number(process.hrtime.bigint() - t0) / 1e6 / 200;
    assert.equal(removed, 0, 'nothing left inside a disc after the first pass');

    // A full-map scan over this world costs ~O(total); the indexed version is
    // ~O(anchors). 0.5ms is a generous ceiling that a full scan would blow
    // through by a wide margin at this mob count.
    assert.ok(perCallMs < 0.5, `prune took ${perCallMs.toFixed(3)}ms/call over ${total} mobs`);
  });

  it('still removes a mob that was pushed inside a disc', () => {
    const s = new Spawner(1337);
    s.ensureAround(0, 0, 0);
    const anchor = SPAWN_SAFE_POINTS[0]!;
    const mob = s.mobsList()[0]!;
    // Knockback: shove a mob into the middle of the disc.
    assert.equal(s.moveMob(mob.id, anchor.x, anchor.y), true);
    assert.equal(s.pruneSpawnSafe().includes(mob.id), true, 'the mob was pruned');
    assert.equal(s.mobsList().some((m) => m.id === mob.id), false, 'and is gone from the index');
  });

  it('tickGameplay prunes once per tick, not once per player', () => {
    const game = createGameState(1337);
    // 12 players spread across the anchors. If pruneSpawnSafe were called
    // inside the player loop this is 12x the work; the guard here is that the
    // whole tick stays comfortably inside its budget at that player count.
    SPAWN_SAFE_POINTS.forEach((a, i) => ensurePlayer(game, 1000 + i, `bot${i}`, a.x, a.y));
    ensurePlayer(game, 2001, 'extra', 40, 40);
    for (const p of game.players.values()) game.spawner.ensureAround(p.x, p.y, 1);

    tickGameplay(game, 1000); // warm
    const t0 = process.hrtime.bigint();
    for (let i = 1; i <= 100; i++) tickGameplay(game, 1000 + i * 50);
    const perTickMs = Number(process.hrtime.bigint() - t0) / 1e6 / 100;
    assert.ok(perTickMs < 2, `tickGameplay took ${perTickMs.toFixed(3)}ms/tick with ${game.players.size} players`);
  });
});
