import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { BOSS_NAMES, MAX_BOSS_BARS, bossBars, bossGradient, bossOrder, isBossEntity } from './bosses.js';
import type { DrawEntity } from './types.js';

function ent(name: string, hp: number, maxHp = 100, id = 1, kind = 'mob'): DrawEntity {
  return { id, kind, x: 0, y: 0, hp, maxHp, name, isLocal: false };
}

describe('isBossEntity', () => {
  it('recognizes every boss in the roster', () => {
    assert.equal(BOSS_NAMES.length, 4);
    for (const n of ['Stone Golem', 'Ember Wyrm', 'Void Wisp', 'Crypt Warden']) {
      assert.equal(isBossEntity(ent(n, 100)), true, n);
    }
  });

  it('is case-insensitive and substring based', () => {
    assert.equal(isBossEntity(ent('ancient void wisp', 10)), true);
    assert.equal(isBossEntity(ent('STONE GOLEM', 10)), true);
  });

  it('rejects minions and players', () => {
    assert.equal(isBossEntity(ent('gloomfang-1', 40)), false);
    assert.equal(isBossEntity(ent('hero', 100, 100, 1, 'player')), false);
    assert.equal(isBossEntity(ent('', 1)), false);
  });
});

describe('bossBars', () => {
  it('returns an empty list when no boss is visible', () => {
    assert.deepEqual(bossBars([ent('gloomfang-1', 40), ent('hero', 100, 100, 1, 'player')]), []);
  });

  it('collects all four bosses in a stable roster order', () => {
    const list = [ent('Crypt Warden', 50, 400, 4), ent('Void Wisp', 184, 220, 3),
      ent('Ember Wyrm', 300, 300, 2), ent('Stone Golem', 400, 400, 1)];
    assert.deepEqual(bossBars(list).map((b) => b.name),
      ['Stone Golem', 'Ember Wyrm', 'Void Wisp', 'Crypt Warden']);
  });

  it('is order-independent (sort is applied, not input order)', () => {
    const a = bossBars([ent('Void Wisp', 1), ent('Stone Golem', 1)]);
    const b = bossBars([ent('Stone Golem', 1), ent('Void Wisp', 1)]);
    assert.deepEqual(a, b);
  });

  it('drops dead and degenerate bosses', () => {
    assert.deepEqual(bossBars([ent('Stone Golem', 0, 400)]), []);
    assert.deepEqual(bossBars([ent('Stone Golem', -5, 400)]), []);
    assert.deepEqual(bossBars([ent('Stone Golem', 10, 0)]), []);
  });

  it('clamps to MAX_BOSS_BARS', () => {
    const many = BOSS_NAMES.map((n, i) => ent(n, 100, 100, i));
    assert.equal(bossBars(many).length, MAX_BOSS_BARS);
  });

  it('passes hp/maxHp through unchanged for the HUD bar', () => {
    assert.deepEqual(bossBars([ent('Void Wisp', 184, 220)]), [{ name: 'Void Wisp', hp: 184, maxHp: 220 }]);
  });
});

describe('bossOrder / bossGradient', () => {
  it('sorts roster members ahead of unknown names', () => {
    assert.ok(bossOrder('Stone Golem') < bossOrder('Unknown Thing'));
    assert.equal(bossOrder('nonsense'), BOSS_NAMES.length);
  });

  it('gives every roster member a distinct gradient', () => {
    const seen = new Set<string>();
    for (const n of BOSS_NAMES) seen.add(bossGradient(n));
    assert.equal(seen.size, BOSS_NAMES.length);
  });

  it('falls back to a neutral gradient for unknown bosses', () => {
    assert.ok(bossGradient('Some New Boss').startsWith('linear-gradient'));
  });
});