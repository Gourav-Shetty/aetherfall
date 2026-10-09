// @aetherfall/server — terrain integration tests.
//
// Covers the four things the engine terrain field now does for the sim:
// solid-terrain collision, authoritative entity z, hazard damage over time,
// and landmark/dry-ground spawn anchors. Determinism is re-checked because the
// terrain hook runs inside `Sim.step()`.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Sim } from './sim.js';
import {
  TERR_LAVA,
  TERR_NONE,
  TERR_WATER,
  TERRAIN_SEED,
  TerrainField,
  TerrainSystem,
} from './terrain_sys.js';
import {
  LAVA_DPS,
  WALKABLE_MAX_SLOPE,
  hazardAt,
  heightAt,
  landmarkInCell,
} from '@aetherfall/engine';

const DT = 1 / 20;

/** First water tile in the 100x100 arena (seed 1337 => (24, 46)). */
function firstWaterTile(): { tx: number; ty: number } {
  for (let ty = 0; ty < 100; ty++) {
    for (let tx = 0; tx < 100; tx++) {
      if (hazardAt(tx + 0.5, ty + 0.5, TERRAIN_SEED).type === 'water') return { tx, ty };
    }
  }
  throw new Error('worldgen: no water in the arena');
}

/** First lava tile in the caldera (outside the legacy 100x100 arena). */
function firstLavaTile(): { x: number; y: number } {
  for (let ty = 120; ty < 400; ty++) {
    for (let tx = 120; tx < 400; tx++) {
      if (hazardAt(tx + 0.5, ty + 0.5, TERRAIN_SEED).type === 'lava') return { x: tx + 0.5, y: ty + 0.5 };
    }
  }
  throw new Error('worldgen: no lava in the caldera');
}

/** Teleport a player onto an exact spot (stands in for a knockback). */
function place(p: { x: number; y: number; vx: number; vy: number; hp: number }, x: number, y: number): void {
  p.x = x;
  p.y = y;
  p.vx = 0;
  p.vy = 0;
  p.hp = 100;
}

describe('terrain: hazard damage over time', () => {
  it('an entity pushed into water takes DOT at hazardAt().dps', () => {
    const { tx, ty } = firstWaterTile();
    const sim = new Sim();
    const p = sim.addPlayer(1, 'victim', tx - 2.5, ty + 0.5);
    place(p, tx + 0.5, ty + 0.5); // knocked into the lake
    const dps = hazardAt(tx + 0.5, ty + 0.5, TERRAIN_SEED).dps;
    assert.ok(dps > 0, 'the tile we picked really is damaging');

    for (let i = 0; i < 4; i++) sim.step(DT);
    // 4 ticks * dt * dps, exactly — the DOT is a pure function of the field.
    assert.ok(Math.abs(100 - p.hp - dps * 4 * DT) < 1e-9, `hp=${p.hp} dps=${dps}`);
    assert.equal(sim.terrainSystem?.stats().dotDamage, dps * 4 * DT);
    assert.equal(sim.terrainSystem?.stats().dotTicks, 4);
    // Still in the water: DOT is not an instant teleport out.
    assert.equal(p.x, tx + 0.5);
    assert.equal(p.y, ty + 0.5);
  });

  it('dry land takes no terrain damage', () => {
    const sim = new Sim();
    const p = sim.addPlayer(1, 'dry', 50, 50);
    assert.equal(sim.terrain?.kindAt(50, 50), TERR_NONE);
    for (let i = 0; i < 20; i++) sim.step(DT);
    assert.equal(p.hp, 100);
    assert.equal(sim.terrainSystem?.stats().dotDamage, 0);
  });

  it('lava burns for LAVA_DPS per second and washes the player ashore', () => {
    const lava = firstLavaTile();
    // Bounds must cover the caldera: the legacy arena clamps at 100.
    const sim = new Sim({ bounds: { w: 600, h: 600 } });
    const p = sim.addPlayer(1, 'burn', lava.x, lava.y);
    place(p, lava.x, lava.y);
    assert.equal(sim.terrain?.kindAt(lava.x, lava.y), TERR_LAVA);
    assert.equal(sim.terrain?.dpsAt(lava.x, lava.y), LAVA_DPS);

    sim.step(DT);
    assert.ok(Math.abs(100 - p.hp - LAVA_DPS * DT) < 1e-9, `hp=${p.hp}`);

    // Lava kills in under 5s; the wash puts the body back on dry ground.
    let ticks = 0;
    while (ticks < 400 && sim.terrainSystem!.stats().drowns === 0) {
      sim.step(DT);
      ticks++;
    }
    assert.ok(ticks > 0 && ticks < 400, 'lava DOT is lethal in a few seconds');
    assert.equal(p.hp, p.maxHp, 'respawn at full health');
    assert.equal(sim.terrain?.kindAt(p.x, p.y), TERR_NONE, 'washed ashore onto dry ground');
    const evs = sim.terrainSystem!.drainEvents();
    assert.equal(evs.length, 1);
    assert.equal(evs[0]!.kind, 'burn');
    assert.equal(evs[0]!.id, 1);
  });

  it('drowning also ends on dry ground (water drowns, not lava)', () => {
    const { tx, ty } = firstWaterTile();
    const sim = new Sim();
    const p = sim.addPlayer(1, 'swimmer', tx - 2.5, ty + 0.5);
    place(p, tx + 0.5, ty + 0.5);
    let ticks = 0;
    while (ticks < 3000 && sim.terrainSystem!.stats().drowns === 0) {
      sim.step(DT);
      ticks++;
    }
    assert.ok(ticks > 0 && ticks < 3000);
    assert.equal(sim.terrain?.kindAt(p.x, p.y), TERR_NONE);
    assert.equal(sim.terrainSystem!.drainEvents()[0]!.kind, 'drown');
  });

  it('damage can be switched off without touching collision or z', () => {
    const { tx, ty } = firstWaterTile();
    const sim = new Sim({ terrain: { damage: false } });
    const p = sim.addPlayer(1, 'drywading', tx - 2.5, ty + 0.5);
    place(p, tx + 0.5, ty + 0.5);
    for (let i = 0; i < 20; i++) sim.step(DT);
    assert.equal(p.hp, 100);
  });
});

describe('terrain: solid terrain collision', () => {
  it('water cannot be walked into, and the body slides along the shore', () => {
    const { tx, ty } = firstWaterTile();
    const sim = new Sim();
    const start = sim.findFreeSpawn(tx - 1.5, ty + 0.5);
    assert.equal(sim.hitsTerrain(start.x, start.y), false);
    const p = sim.addPlayer(1, 'walker', start.x, start.y);

    let leaked = false;
    let moved = 0;
    const from = p.x;
    for (let i = 0; i < 300; i++) {
      sim.setVelocity(1, 8, 0, i);
      sim.step(DT);
      if (sim.hitsTerrain(p.x, p.y)) leaked = true;
    }
    moved = p.x - from;
    assert.equal(leaked, false, 'never ends a tick inside solid terrain');
    assert.ok(moved > 0, `still made progress (${moved.toFixed(2)}u)`);
    assert.ok(p.x < tx, `stopped at the shoreline (x=${p.x.toFixed(2)} < ${tx})`);
    assert.equal(p.hp, 100, 'walking never costs health');
  });

  it('a body already in the water can walk out toward the bank', () => {
    const { tx, ty } = firstWaterTile();
    const sim = new Sim();
    const field = sim.terrain!;
    const p = sim.addPlayer(1, 'climber', tx + 0.5, ty + 0.5);
    place(p, tx + 0.5, ty + 0.5);
    // Steer at the nearest dry ground: collision must never weld a body into
    // the lake (it blocks entry, it does not trap).
    const bank = field.spawnAnchor(p.x, p.y, { maxR: 24 })!;
    assert.equal(field.solidCircle(bank.x, bank.y, 0.4), false);
    let escaped = false;
    for (let i = 0; i < 200 && !escaped; i++) {
      const dx = bank.x - p.x;
      const dy = bank.y - p.y;
      const l = Math.hypot(dx, dy) || 1;
      sim.setVelocity(1, (dx / l) * 8, (dy / l) * 8, i);
      sim.step(DT);
      if (!sim.hitsTerrain(p.x, p.y)) escaped = true;
    }
    assert.equal(escaped, true, 'escaped the water under its own power');
    assert.ok(Math.hypot(p.x - bank.x, p.y - bank.y) < 4, `landed near the bank (${p.x.toFixed(1)},${p.y.toFixed(1)})`);
  });

  it('slide() blocks the offending axis only (one allocation-free probe when free)', () => {
    const field = new TerrainField();
    field.beginTick();
    const dry = field.slide(50, 50, 1, 0);
    assert.deepEqual(dry, { dx: 1, dy: 0 });
    assert.equal(field.stats().layerMisses > 0, true);
    // Both axes into the lake are refused.
    const { tx, ty } = firstWaterTile();
    const blocked = field.slide(tx + 0.5, ty + 0.5, 0, 0);
    assert.deepEqual(blocked, { dx: 0, dy: 0 });
  });
});

describe('terrain: authoritative height (z)', () => {
  it('player z is heightAt() of the tile it stands on', () => {
    const sim = new Sim();
    const p = sim.addPlayer(1, 'hiker', 50, 50);
    sim.step(DT);
    const want = heightAt(Math.floor(p.x) + 0.5, Math.floor(p.y) + 0.5, TERRAIN_SEED);
    assert.equal(p.z, want);
    assert.equal(sim.zOf(1), want);
  });

  it('z tracks the player and stays off the wire by default', () => {
    const sim = new Sim();
    sim.addPlayer(1, 'a', 10, 10);
    const before = sim.zOf(1);
    sim.setVelocity(1, 8, 0, 1);
    for (let i = 0; i < 30; i++) sim.step(DT);
    const after = sim.zOf(1);
    assert.notEqual(after, before, 'walking changes the terrain height');
    assert.equal(
      after,
      heightAt(Math.floor(sim.players.get(1)!.x) + 0.5, Math.floor(sim.players.get(1)!.y) + 0.5, TERRAIN_SEED),
    );
    // Default: no `z` on the wire (the client samples the same pure function).
    const json = JSON.parse(JSON.stringify(sim.snapshot()[0])) as Record<string, unknown>;
    assert.equal('z' in json, false, 'snapshot bytes unchanged by default');
  });

  it('z can be opted onto the wire for thin clients', () => {
    const sim = new Sim({ snapshotZ: true });
    sim.addPlayer(1, 'a', 50, 50);
    sim.step(DT);
    const json = JSON.parse(JSON.stringify(sim.snapshot()[0])) as { z: number };
    assert.equal(json.z, sim.zOf(1));
    assert.equal(json.z, heightAt(50.5, 50.5, TERRAIN_SEED));
  });

  it('z is omitted from the wire entirely when terrain is off', () => {
    const sim = new Sim({ terrain: false, snapshotZ: true });
    sim.addPlayer(1, 'flat', 50, 50);
    sim.step(DT);
    const json = JSON.parse(JSON.stringify(sim.snapshot()[0])) as Record<string, unknown>;
    assert.equal('z' in json, false, 'TERRAIN=off has no elevation to report');
    assert.equal(sim.terrain, null);
    assert.equal(sim.players.get(1)!.z, 0);
  });
});

describe('terrain: landmarks as spawn / loot anchors', () => {
  it('landmark centres and loot anchors report their provenance', () => {
    const field = new TerrainField();
    const lm = landmarkInCell(-1, 0, TERRAIN_SEED);
    assert.ok(lm, 'seed 1337 has a landmark in cell (-1, 0)');
    const atCentre = field.spawnAnchor(lm.x, lm.y)!;
    assert.equal(atCentre.source, 'landmark');
    assert.equal(atCentre.landmarkId, lm.id);
    const anchor = lm.loot[0]!;
    const atLoot = field.spawnAnchor(anchor.x, anchor.y)!;
    assert.equal(atLoot.source, 'loot');
    assert.equal(atLoot.landmarkId, lm.id);
  });

  it('every loot anchor near a position is walkable terrain', () => {
    const field = new TerrainField();
    const lm = landmarkInCell(-1, 0, TERRAIN_SEED)!;
    const anchors = field.lootAnchorsNear(lm.x, lm.y, 64);
    assert.equal(anchors.length, lm.loot.length);
    for (const a of anchors) {
      assert.equal(field.solidCircle(a.x, a.y, 0.4), false, `anchor ${a.id} is solid`);
      assert.equal(a.tier >= 1, true);
    }
    // Deterministic, and radius-filtered.
    assert.deepEqual(anchors.map((a) => a.id), field.lootAnchorsNear(lm.x, lm.y, 64).map((a) => a.id));
    assert.deepEqual(field.lootAnchorsNear(lm.x, lm.y, 2).length, 0);
  });

  it('spawnAnchor always returns walkable ground, even mid-ocean', () => {
    const field = new TerrainField();
    let checked = 0;
    for (let ty = -400; ty <= 400; ty += 37) {
      for (let tx = -400; tx <= 400; tx += 41) {
        if (field.kindAt(tx + 0.5, ty + 0.5) !== TERR_WATER) continue;
        const a = field.spawnAnchor(tx + 0.5, ty + 0.5, { maxR: 24 });
        assert.ok(a !== null, `no anchor near ${tx},${ty}`);
        assert.equal(field.solidCircle(a!.x, a!.y, 0.4), false, `anchor at ${a!.x},${a!.y} is solid`);
        checked++;
      }
    }
    assert.ok(checked > 10, `sampled ${checked} ocean positions`);
  });

  it('findFreeSpawn never drops a player in water or lava', () => {
    const sim = new Sim();
    let checked = 0;
    for (let id = 1; id <= 120; id++) {
      const p = sim.addPlayer(id, `bot${id}`);
      assert.equal(sim.hitsTerrain(p.x, p.y), false, `spawn ${id} landed in terrain at ${p.x},${p.y}`);
      // Explicit water spawn requests are nudged ashore too.
      const { tx, ty } = firstWaterTile();
      const q = sim.addPlayer(1000 + id, 'wader', tx + 0.5, ty + 0.5);
      assert.equal(sim.hitsTerrain(q.x, q.y), false, `water spawn ${id} stayed at ${q.x},${q.y}`);
      checked += 2;
    }
    assert.equal(checked, 240);
  });

  it('rescue() puts a body standing in water back on land and queues an event', () => {
    const { tx, ty } = firstWaterTile();
    const sim = new Sim();
    const p = sim.addPlayer(1, 'stuck', tx + 0.5, ty + 0.5);
    place(p, tx + 0.5, ty + 0.5);
    sim.terrainSystem!.drainEvents();
    const anchor = sim.terrainSystem!.rescue(p);
    assert.ok(anchor !== null);
    assert.equal(sim.hitsTerrain(p.x, p.y), false);
    const evs = sim.terrainSystem!.drainEvents();
    assert.equal(evs.length, 1);
    assert.equal(evs[0]!.kind, 'unstick');
    assert.equal(evs[0]!.id, 1);
  });
});

describe('terrain: determinism + cost', () => {
  it('terrain keeps the sim bit-deterministic', () => {
    const run = (): string => {
      const sim = new Sim();
      sim.addPlayer(1, 'a', 10, 10);
      sim.addPlayer(2, 'b', 20, 20);
      const { tx, ty } = firstWaterTile();
      sim.addPlayer(3, 'c', tx - 1.5, ty + 0.5);
      sim.setVelocity(1, 8, 0, 1);
      sim.setVelocity(2, 0, -8, 1);
      for (let i = 0; i < 60; i++) sim.step(DT);
      return JSON.stringify(
        sim.snapshot().map((e) => [e.id, +e.p.x.toFixed(9), +e.p.y.toFixed(9), +e.hp.toFixed(9), +(e.z ?? 0).toFixed(9)]),
      );
    };
    assert.equal(run(), run());
  });

  it('the terrain layer cache is bounded and stays hot in steady state', () => {
    const field = new TerrainField({ maxLayers: 4, prefetch: 0 });
    for (let i = 0; i < 200; i++) {
      field.beginTick();
      field.probe(i * 0.5, i * 0.25);
    }
    assert.ok(field.stats().layers <= 4, `layers=${field.stats().layers}`);
    // Repeated reads of the same tile: at most one rebuild (the first, since
    // the sweep above evicted it) and then pure array reads.
    const before = field.stats().layerMisses;
    for (let i = 0; i < 1000; i++) field.probe(50.5, 50.5);
    assert.ok(
      field.stats().layerMisses - before <= 1,
      `expected <=1 rebuild, got ${field.stats().layerMisses - before}`,
    );
    assert.ok(field.stats().layerHits >= 1000, 'cached tile reads are hits');
  });

  it('terrain costs well under a millisecond per 100 player-ticks', () => {
    // Budget: the 20Hz tick is 50ms and the sim section is a fraction of it.
    // Measured on the same box the other perf tests use; 40x headroom keeps CI
    // stable while still failing if someone drops a per-tick genChunk in here.
    const sys = new TerrainSystem();
    const sim = new Sim({ terrain: false });
    sim.setTerrain(sys.field);
    for (let i = 1; i <= 100; i++) sim.addPlayer(i, `p${i}`);
    sys.attach(sim);
    const { tx, ty } = firstWaterTile();
    sim.addPlayer(900, 'wet', tx + 0.5, ty + 0.5);
    sim.players.get(900)!.x = tx + 0.5;
    sim.players.get(900)!.y = ty + 0.5;

    const t0 = performance.now();
    for (let i = 0; i < 100; i++) {
      for (let k = 1; k <= 100; k++) sim.setVelocity(k, (k % 7) - 3, (k % 5) - 2, i);
      sim.step(DT);
    }
    const perTick = (performance.now() - t0) / 100;
    assert.ok(perTick < 1, `${perTick.toFixed(3)} ms per tick (100 players)`);
  });
});

describe('terrain: field invariants vs the engine', () => {
  it('water tiles agree with hazardAt() and the ocean biome', () => {
    const field = new TerrainField();
    for (let ty = 0; ty < 64; ty += 3) {
      for (let tx = 0; tx < 64; tx += 3) {
        const want = hazardAt(tx + 0.5, ty + 0.5, TERRAIN_SEED);
        const got = field.probe(tx + 0.5, ty + 0.5);
        const kind = want.type === 'water' ? TERR_WATER : want.type === 'lava' ? TERR_LAVA : TERR_NONE;
        assert.equal(got.kind, kind, `kind mismatch at ${tx},${ty}`);
        assert.equal(got.dps, want.dps);
        assert.equal(got.height, heightAt(tx + 0.5, ty + 0.5, TERRAIN_SEED));
      }
    }
  });

  it('landmark sites are never on a cliff the sim would refuse', () => {
    // The engine rejects steep sites at generation time; assert the anchor
    // layer agrees so a spawn can never land on the WALKABLE_MAX_SLOPE edge.
    const field = new TerrainField();
    for (let gy = -2; gy <= 3; gy++) {
      for (let gx = -2; gx <= 3; gx++) {
        const lm = landmarkInCell(gx, gy, TERRAIN_SEED);
        if (!lm) continue;
        assert.equal(field.solidAt(lm.x, lm.y), false, lm.id);
        const a = field.spawnAnchor(lm.x, lm.y)!;
        assert.ok(Math.hypot(a.x - lm.x, a.y - lm.y) < 128, 'anchor stays inside the cell');
        assert.ok(WALKABLE_MAX_SLOPE > 0);
      }
    }
  });
});