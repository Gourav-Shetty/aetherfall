// World pickups: ageing + geometry sanity.
//
// Two defects pinned here:
//   1. Unbounded growth. Corpse loot carried no age, so `GameState.pickups` only
//      ever shrank when a player actually walked over an item. A player who
//      ignored loot grew the array without bound (~0.5 entries per kill) and it
//      was still there an hour later. `prunePickups` is the owned ageing policy;
//      the per-tick call site lives in `game/index.ts` (see report).
//   2. Pickups must never be born at a NaN/Infinity position or with a
//      non-finite item id — a NaN `x` is un-renderable and, worse, defeats
//      every range check (`d > radius` is false for NaN), so `tryPickup` would
//      happily collect a pickup that is nowhere near the player.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  PICKUP_TTL_MS,
  _resetPickupIds,
  createInventory,
  makePickup,
  prunePickups,
  tryPickup,
  type Pickup,
} from './inventory.js';
import { pickupsForLoot, rollLootForKill } from './loot.js';

describe('pickup ageing', () => {
  it('prunePickups drops rows older than the TTL and keeps fresh ones', () => {
    _resetPickupIds();
    const list: Pickup[] = [
      makePickup('iron-ore', 1, 0, 0, 1_000), // born at t=1000
      makePickup('moss-cap', 1, 5, 5, 9_000),
      makePickup('ember-shard', 1, 9, 9, 100_000),
    ];
    // The first row must land EXACTLY at its TTL, not one TTL plus 99 more
    // seconds: at `100_000 + TTL` all three rows are past the limit, so the
    // assertion was really "everything expires" with a comment claiming
    // otherwise. Age the clock from the oldest row's birth time.
    const oldestId = list[0]!.id;
    const now = 1_000 + PICKUP_TTL_MS;
    const expired = prunePickups(list, now);
    assert.deepEqual(expired, [oldestId], 'only the oldest expired');
    assert.equal(list.length, 2, 'fresh rows must survive');
    assert.deepEqual(list.map((p) => p.itemId), ['moss-cap', 'ember-shard']);
  });

  it('a pickup survives right up to its TTL and dies on it', () => {
    const fresh = makePickup('iron-ore', 1, 0, 0, 0);
    const holder = [fresh];
    prunePickups(holder, PICKUP_TTL_MS - 1);
    assert.equal(holder.length, 1, 'aged out one ms early');
    prunePickups(holder, PICKUP_TTL_MS);
    assert.equal(holder.length, 0, 'not aged out at exactly TTL');
  });

  it('rows with no createdAt are kept, not silently deleted (never lose loot)', () => {
    const legacy = makePickup('ward-token', 1, 0, 0); // no clock supplied
    const holder = [legacy];
    prunePickups(holder, Number.MAX_SAFE_INTEGER);
    assert.equal(holder.length, 1, 'an unstamped pickup must not be deleted');
  });

  it('a long unattended session does not grow the world without bound', () => {
    const list: Pickup[] = [];
    let now = 0;
    // Drop loot every second for 10 minutes; prune once a second, like a tick.
    for (let i = 0; i < 600; i++) {
      now = i * 1000;
      list.push(makePickup('iron-ore', 1, i, 0, now));
      prunePickups(list, now);
    }
    // Without ageing this would be 600 rows; with it, at most TTL seconds' worth.
    assert.ok(list.length <= PICKUP_TTL_MS / 1000 + 1, `unbounded growth: ${list.length} rows`);
  });

  it('prunePickups is a no-op for a junk clock instead of nuking the world', () => {
    const list = [makePickup('iron-ore', 1, 0, 0, 0)];
    assert.deepEqual(prunePickups(list, NaN), []);
    assert.deepEqual(prunePickups(list, 1000, 0), []);
    assert.equal(list.length, 1);
  });
});

describe('pickup geometry sanity', () => {
  it('pickupsForLoot never yields a non-finite position', () => {
    const drops = [
      { itemId: 'iron-ore', count: 1 },
      { itemId: 'moss-cap', count: 2 },
      { itemId: 'ember-shard', count: 1 },
    ];
    // A hostile RNG (NaN, +-Infinity, and the extremes) must not leak into a
    // pickup position.
    for (const bad of [NaN, Infinity, -Infinity, 1e308, -1e308]) {
      const out = pickupsForLoot(drops, 10, 10, () => bad);
      assert.equal(out.length, drops.length, `drop count changed for rand=${bad}`);
      for (const p of out) {
        assert.ok(Number.isFinite(p.x), `NaN/Inf x from rand=${bad}: ${p.x}`);
        assert.ok(Number.isFinite(p.y), `NaN/Inf y from rand=${bad}: ${p.y}`);
      }
    }
  });

  it('a pickup at a NaN position is NOT collectable (range check must reject it)', () => {
    // Guard against the inverse defect too: if a NaN ever reaches the world, the
    // player must not be able to vacuum it up from across the map.
    const inv = createInventory();
    const bad: Pickup = { id: 2_000_001, kind: 'pickup', itemId: 'ward-blade', count: 1, x: NaN, y: 0 };
    const res = tryPickup(inv, bad, { x: 0, y: 0 });
    // Either it is rejected as out of range OR the whole thing is invalid; it
    // must never succeed.
    assert.notEqual(res.ok, true, 'a NaN-position pickup was collectable from anywhere');
  });

  it('rollLootForKill always yields whole, in-range counts', () => {
    for (const rand of [() => 0, () => 0.999999, () => 0.5]) {
      const drops = rollLootForKill('gloomfang', 'meadow', 1, rand);
      for (const d of drops) {
        assert.ok(Number.isInteger(d.count) && d.count >= 1, `bad count ${d.count}`);
        assert.ok(d.count <= 99, `count ${d.count} exceeds MAX_STACK`);
      }
    }
  });
});