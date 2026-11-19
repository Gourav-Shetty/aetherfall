import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  WEAPON_PROFILES,
  getWeaponProfile,
  computeContactPoint,
  inWeaponRange,
  inWeaponCone,
  HitstopCancelBuffer,
  HITSTOP_DEFAULT_MS,
  DASH_IFRAME_MS,
  SDI_NUDGE_DIST,
} from './combat_specs.js';

describe('Weapon Combat Profiles', () => {
  it('every weapon from catalog has distinct reach, timing, and arc', () => {
    const ids = [
      'unarmed',
      'wisp-touched-dagger',
      'ward-blade',
      'ember-axe',
      'deep-halberd',
      'caldera-greatsword',
    ];

    const reaches = new Set<number>();
    const windups = new Set<number>();
    const recoveries = new Set<number>();
    const cooldowns = new Set<number>();
    const arcs = new Set<number>();

    for (const id of ids) {
      const p = getWeaponProfile(id);
      assert.ok(p, `profile exists for ${id}`);
      assert.ok(p.reach > 0, 'reach is positive');
      assert.ok(p.arcDeg > 0, 'arc is positive');
      assert.ok(p.windupMs > 0, 'windup is positive');
      assert.ok(p.recoveryMs > 0, 'recovery is positive');
      assert.ok(p.cooldownMs >= p.windupMs + p.recoveryMs, 'cooldown accommodates windup + recovery');
      assert.ok(p.hitstopMs >= 90, 'hitstop >= 90ms');

      reaches.add(p.reach);
      windups.add(p.windupMs);
      recoveries.add(p.recoveryMs);
      cooldowns.add(p.cooldownMs);
      arcs.add(p.arcDeg);
    }

    // Every weapon has distinct values
    assert.equal(reaches.size, ids.length, 'all weapons have distinct reach');
    assert.equal(windups.size, ids.length, 'all weapons have distinct windup');
    assert.equal(recoveries.size, ids.length, 'all weapons have distinct recovery');
    assert.equal(arcs.size, ids.length, 'all weapons have distinct arc');

    // Deep Halberd has the longest reach and narrowest thrust
    const halberd = getWeaponProfile('deep-halberd');
    assert.equal(halberd.reach, 3.2);
    assert.equal(halberd.arcDeg, 45);

    // Caldera Greatsword has wide sweep and heavy windup
    const greatsword = getWeaponProfile('caldera-greatsword');
    assert.equal(greatsword.reach, 2.8);
    assert.equal(greatsword.arcDeg, 150);
    assert.equal(greatsword.windupMs, 420);

    // Wisp-touched Dagger is fast with wide arc
    const dagger = getWeaponProfile('wisp-touched-dagger');
    assert.equal(dagger.reach, 1.6);
    assert.equal(dagger.windupMs, 110);
  });

  it('falls back to unarmed for unknown or null weapon IDs', () => {
    const def = getWeaponProfile(null);
    assert.equal(def.id, 'unarmed');
    const unk = getWeaponProfile('nonexistent-laser-cannon');
    assert.equal(unk.id, 'unarmed');
  });
});

describe('Contact Point & Geometry', () => {
  it('computes true point of contact on target boundary towards attacker', () => {
    const attacker = { x: 10, y: 10 };
    const target = { x: 13, y: 10 }; // 3 units away along +X
    const r = 0.4;
    const contact = computeContactPoint(attacker, target, r);

    assert.equal(contact.dist, 3);
    assert.equal(contact.x, 12.6); // 13 - 0.4
    assert.equal(contact.y, 10);
    assert.equal(contact.nx, -1);
    assert.equal(contact.ny, -0);
  });

  it('inWeaponCone validates both reach and angular arc', () => {
    const blade = getWeaponProfile('ward-blade'); // reach 2.2, arc 90deg (+/- 45deg)
    const origin = { x: 10, y: 10 };
    const facing = { x: 1, y: 0 }; // facing +X

    // 1. Directly ahead within reach -> hit
    assert.equal(inWeaponCone(origin, facing, { x: 12.0, y: 10.0 }, blade), true);

    // 2. Directly ahead beyond reach (2.5u) -> miss
    assert.equal(inWeaponCone(origin, facing, { x: 12.5, y: 10.0 }, blade), false);

    // 3. At 30 degrees (inside 45 deg half-arc) within reach -> hit
    const rad30 = (30 * Math.PI) / 180;
    const p30 = { x: 10 + 2.0 * Math.cos(rad30), y: 10 + 2.0 * Math.sin(rad30) };
    assert.equal(inWeaponCone(origin, facing, p30, blade), true);

    // 4. At 60 degrees (outside 45 deg half-arc) within reach -> miss
    const rad60 = (60 * Math.PI) / 180;
    const p60 = { x: 10 + 2.0 * Math.cos(rad60), y: 10 + 2.0 * Math.sin(rad60) };
    assert.equal(inWeaponCone(origin, facing, p60, blade), false);

    // 5. Behind attacker (-X) -> miss
    assert.equal(inWeaponCone(origin, facing, { x: 8.5, y: 10.0 }, blade), false);
  });
});

describe('Hitstop Cancel Buffer (SF2 Cancel Insight)', () => {
  it('queues input during hitstop freeze and executes immediately when hitstop ends', () => {
    const buf = new HitstopCancelBuffer<string>();
    const t0 = 1000;

    // During hitstop:
    buf.queue('attack', t0 + 20);
    assert.equal(buf.hasQueued(), true);
    assert.equal(buf.peek(), 'attack');

    // While still in hitstop, consume returns null (held in buffer)
    assert.equal(buf.consume(true, t0 + 50), null);
    assert.equal(buf.hasQueued(), true);

    // When hitstop ends (isHitStopped = false), queued action resolves immediately
    const action = buf.consume(false, t0 + 100);
    assert.equal(action, 'attack');
    assert.equal(buf.hasQueued(), false);
  });

  it('discards stale queued inputs exceeding TTL', () => {
    const buf = new HitstopCancelBuffer<string>(200);
    buf.queue('dash', 1000);
    // After 250ms (> 200ms TTL), expires
    assert.equal(buf.consume(false, 1250), null);
    assert.equal(buf.hasQueued(), false);
  });
});
