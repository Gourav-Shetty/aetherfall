// PLAYABILITY strike team — boss-bar relevance acceptance (client).
// The bar shows only the nearest living boss within 30u, OR a boss currently
// targeting the player; otherwise hidden.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { BOSS_BAR_RANGE, bossBars, relevantBossBars } from './bosses.js';
import type { DrawEntity } from './types.js';

function ent(name: string, x: number, y: number, hp: number, maxHp = 400, id = 1): DrawEntity {
  return { id, kind: 'mob', x, y, hp, maxHp, name, isLocal: false };
}

describe('boss-bar relevance: 30u gating', () => {
  it('exposes the 30u range constant', () => {
    assert.equal(BOSS_BAR_RANGE, 30);
  });

  it('hides a full-HP golem with no golem near (screenshot defect)', () => {
    // Player at spawn, golem at its anchor 113u away.
    const list = [ent('Stone Golem', 80, 80, 400, 400, 7)];
    assert.deepEqual(relevantBossBars(list, 0, 0), [], 'far full-HP bar must hide');
    // The ungated helper still sees it (proves the gate does the work).
    assert.equal(bossBars(list).length, 1);
  });

  it('shows the nearest living boss within 30u', () => {
    const list = [ent('Stone Golem', 80, 80, 400, 400, 7)];
    const bars = relevantBossBars(list, 80, 80);
    assert.equal(bars.length, 1);
    assert.equal(bars[0]!.name, 'Stone Golem');
  });

  it('shows only the nearest when several are in range', () => {
    const list = [
      ent('Stone Golem', 10, 0, 400, 400, 7), // 10u
      ent('Void Wisp', 5, 0, 220, 220, 8), // 5u — nearer
    ];
    const bars = relevantBossBars(list, 0, 0);
    assert.equal(bars.length, 1, 'crowded bars collapse to the nearest');
    assert.equal(bars[0]!.name, 'Void Wisp');
  });

  it('shows a targeting boss even beyond 30u', () => {
    const list = [ent('Stone Golem', 80, 80, 400, 400, 7)];
    const bars = relevantBossBars(list, 0, 0, new Set([7]));
    assert.equal(bars.length, 1, 'targeting boss stays visible while kited out');
  });

  it('hides dead bosses even in range or targeting', () => {
    const dead = [ent('Stone Golem', 0, 1, 0, 400, 7)];
    assert.deepEqual(relevantBossBars(dead, 0, 0), []);
    assert.deepEqual(relevantBossBars(dead, 0, 0, new Set([7])), []);
  });

  it('never shows minions or players', () => {
    const list = [ent('gloomfang-1', 0, 1, 40, 60, 9), ent('hero', 0, 1, 100, 100, 1)];
    (list[1] as DrawEntity).kind = 'player';
    assert.deepEqual(relevantBossBars(list, 0, 0), []);
  });

  it('range edge is inclusive', () => {
    const list = [ent('Stone Golem', BOSS_BAR_RANGE, 0, 400, 400, 7)];
    assert.equal(relevantBossBars(list, 0, 0).length, 1, 'exactly 30u counts');
    const past = [ent('Stone Golem', BOSS_BAR_RANGE + 0.1, 0, 400, 400, 7)];
    assert.deepEqual(relevantBossBars(past, 0, 0), [], 'just past 30u hides');
  });
});
