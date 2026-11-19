import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  MOB_LOADOUT_PROFILES,
  getDefaultMobWeapon,
  getMobLoadout,
} from './mob_ai_specs.js';

describe('Mob AI Loadout Specs (Phase 3)', () => {
  it('defines distinct profiles for unarmed, melee, and ranged archetypes', () => {
    const unarmed = MOB_LOADOUT_PROFILES['unarmed'];
    assert.ok(unarmed);
    assert.equal(unarmed.kind, 'unarmed');
    assert.equal(unarmed.fleeThreshold, 0.35, 'unarmed flees at <= 35% HP');
    assert.ok(unarmed.allowedStates.includes('flee'), 'unarmed has flee state');
    assert.equal(unarmed.attackRange, 1.4);

    const dagger = MOB_LOADOUT_PROFILES['wisp-touched-dagger'];
    assert.ok(dagger);
    assert.equal(dagger.kind, 'melee');
    assert.equal(dagger.fleeThreshold, 0, 'melee never flees');
    assert.ok(!dagger.allowedStates.includes('flee'), 'melee does not have flee state');
    assert.ok(dagger.combatSpeed > dagger.chaseSpeed, 'melee charges/flanks faster than chase speed');

    const halberd = MOB_LOADOUT_PROFILES['deep-halberd'];
    assert.ok(halberd);
    assert.equal(halberd.kind, 'melee');
    assert.equal(halberd.attackRange, 3.2, 'deep halberd has 3.2u reach');

    const wispBolt = MOB_LOADOUT_PROFILES['wisp-bolt'];
    assert.ok(wispBolt);
    assert.equal(wispBolt.kind, 'ranged');
    assert.equal(wispBolt.fleeThreshold, 0);
    assert.ok(wispBolt.preferredRangeMin! >= 4.0, 'ranged keeps distance');
    assert.ok(wispBolt.preferredRangeMax! <= 8.5, 'ranged upper hold limit');
    assert.ok(wispBolt.sightRange >= 13.0, 'ranged has keen sight pull');
    assert.ok(wispBolt.searchRadius >= 6.0, 'ranged has wide search radius');
    assert.ok(wispBolt.alertThreshold < 0.7, 'ranged is alert sooner');
  });

  it('resolves mob default weapons from catalog taxonomy and loot drops', () => {
    assert.equal(getDefaultMobWeapon('mistwisp'), 'wisp-touched-dagger');
    assert.equal(getDefaultMobWeapon('void-wisp'), 'wisp-bolt');
    assert.equal(getDefaultMobWeapon('cinder-imp'), 'ember-spit');
    assert.equal(getDefaultMobWeapon('meadow-sprite'), 'unarmed');
    assert.equal(getDefaultMobWeapon('hollow-knight'), 'ember-axe');
    assert.equal(getDefaultMobWeapon('caldera-wyrm'), 'deep-halberd');
    assert.equal(getDefaultMobWeapon('magma-golem'), 'caldera-greatsword');
    assert.equal(getDefaultMobWeapon('ashcrawler'), 'ward-blade');
    assert.equal(getDefaultMobWeapon('thornback'), 'ward-blade');
    assert.equal(getDefaultMobWeapon('gloomfang'), 'wisp-touched-dagger');
    assert.equal(getDefaultMobWeapon(null), 'unarmed');
  });

  it('getMobLoadout seamlessly prioritizes explicit weapon over mob default', () => {
    // Explicit weapon override
    const customHalberd = getMobLoadout('deep-halberd', 'meadow-sprite');
    assert.equal(customHalberd.weaponId, 'deep-halberd');
    assert.equal(customHalberd.kind, 'melee');
    assert.equal(customHalberd.attackRange, 3.2);

    // Mob default lookup
    const spriteDefault = getMobLoadout(null, 'meadow-sprite');
    assert.equal(spriteDefault.weaponId, 'unarmed');
    assert.equal(spriteDefault.kind, 'unarmed');
    assert.equal(spriteDefault.fleeThreshold, 0.35);

    const wispDefault = getMobLoadout(null, 'void-wisp');
    assert.equal(wispDefault.weaponId, 'wisp-bolt');
    assert.equal(wispDefault.kind, 'ranged');
    assert.equal(wispDefault.attackRange, 8.0);
  });
});
