// Faction reputation: original names, five ranks each, one perk apiece, and
// pure earn/spend transitions. No state passed in is ever mutated.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { ReputationAwardView } from '@aetherfall/shared';
import {
  FACTIONS,
  MAX_REPUTATION,
  RANK_COUNT,
  awardFor,
  buyPerk,
  canBuyPerk,
  createReputation,
  factionDef,
  grantReputation,
  hasPerk,
  hasRank,
  isFactionId,
  perkBlocker,
  rankFor,
  rankIndexFor,
  rankProgress,
  type ReputationState,
} from './reputation.js';

const award = (v: number, c: number, l: number): ReputationAwardView => ({
  'ashen-vigil': v,
  'hollow-choir': c,
  'fault-ledger': l,
});

function richEnough(): ReputationState {
  // Earned >= the rank-2 threshold AND balance >= the perk cost.
  return {
    earned: { 'ashen-vigil': 200, 'hollow-choir': 200, 'fault-ledger': 200 },
    balance: { 'ashen-vigil': 200, 'hollow-choir': 200, 'fault-ledger': 200 },
    perks: [],
  };
}

describe('faction definitions', () => {
  it('has exactly three original factions with unique ids and perks', () => {
    assert.deepEqual(FACTIONS.map((f) => f.id), ['ashen-vigil', 'hollow-choir', 'fault-ledger']);
    assert.equal(new Set(FACTIONS.map((f) => f.name)).size, 3);
    assert.equal(new Set(FACTIONS.map((f) => f.perk.id)).size, 3);
    for (const f of FACTIONS) {
      assert.equal(f.ranks.length, RANK_COUNT);
      assert.equal(new Set(f.ranks.map((r) => r.name)).size, RANK_COUNT);
      assert.equal(f.ranks[0]!.threshold, 0);
      for (let i = 1; i < f.ranks.length; i++) {
        assert.ok(f.ranks[i]!.threshold > f.ranks[i - 1]!.threshold, `${f.id} rank ${i} threshold rises`);
      }
      assert.ok(f.perk.cost > 0);
      assert.equal(f.perk.rankRequired, 2);
      assert.ok(f.perk.name && f.perk.description);
    }
  });

  it('resolves faction ids safely', () => {
    for (const f of FACTIONS) {
      assert.equal(isFactionId(f.id), true);
      assert.equal(factionDef(f.id)?.name, f.name);
    }
    assert.equal(isFactionId('not-a-faction'), false);
    assert.equal(factionDef('not-a-faction'), undefined);
  });
});

describe('rank lookup', () => {
  it('returns the exact rank at every threshold boundary', () => {
    for (const f of FACTIONS) {
      for (let i = 0; i < f.ranks.length; i++) {
        const threshold = f.ranks[i]!.threshold;
        assert.equal(rankIndexFor(f.id, threshold - 1), Math.max(0, i - 1));
        assert.equal(rankFor(f.id, threshold).name, f.ranks[i]!.name);
        assert.equal(rankFor(f.id, threshold).index, i);
        assert.equal(rankFor(f.id, threshold).threshold, threshold);
      }
    }
  });

  it('answers threshold checks and shows progress to the next rank', () => {
    const f = FACTIONS[0]!;
    assert.equal(hasRank(f.id, 0, 0), true);
    assert.equal(hasRank(f.id, 0, 1), false);
    assert.equal(hasRank(f.id, 50, 1), true);
    assert.equal(hasRank(f.id, 800, 9), true); // index clamps to the top rank

    const p = rankProgress(f.id, 60); // rank 1 (50), next at 150
    assert.equal(p.rank.index, 1);
    assert.equal(p.intoRank, 10);
    assert.equal(p.toNext, 90);
    assert.equal(p.next?.name, f.ranks[2]!.name);

    const maxed = rankProgress(f.id, 1000);
    assert.equal(maxed.next, null);
    assert.equal(maxed.toNext, 0);
    assert.equal(rankFor(f.id, -50).index, 0);
  });
});

describe('earning', () => {
  it('pays tier-appropriate, faction-weighted awards', () => {
    const t1 = awardFor(1, 'kill');
    const t4 = awardFor(4, 'kill');
    const q4 = awardFor(4, 'quest');
    for (const f of FACTIONS) {
      assert.ok(t4[f.id] > t1[f.id]);
      assert.ok(q4[f.id] > t4[f.id]);
    }
    assert.deepEqual(t1, award(2, 1, 2));
    assert.deepEqual(t4, award(11, 6, 8));
    assert.deepEqual(awardFor(9, 'kill'), t4);
  });

  it('credits reputation purely and announces rank-ups once', () => {
    const before = createReputation();
    const { state, events } = grantReputation(before, award(60, 45, 60));
    assert.deepEqual(before, createReputation(), 'input state untouched');
    assert.deepEqual(state.balance, award(60, 45, 60));
    assert.deepEqual(state.earned, award(60, 45, 60));
    assert.equal(events.filter((e) => e.type === 'rep-gained').length, 3);
    assert.deepEqual(events.filter((e) => e.type === 'rank-up').map((e) => (e.type === 'rank-up' ? e.rankIndex : -1)), [1, 1, 1]);

    const again = grantReputation(state, award(1, 1, 1));
    assert.equal(again.events.some((e) => e.type === 'rank-up'), false);
    assert.equal(again.state.earned['ashen-vigil'], 61);
  });

  it('clamps junk and the lifetime ceiling', () => {
    const { state } = grantReputation(createReputation(), award(Infinity, -20, NaN));
    assert.equal(state.balance['ashen-vigil'], MAX_REPUTATION);
    assert.equal(state.balance['hollow-choir'], 0);
    assert.equal(state.balance['fault-ledger'], 0);
  });
});

describe('spending on the one perk', () => {
  it('blocks too-low rank and insufficient balance, then buys exactly once', () => {
    const poor = createReputation();
    assert.equal(perkBlocker(poor, 'ashen-vigil'), 'rank');
    assert.equal(canBuyPerk(poor, 'ashen-vigil'), false);
    assert.equal(buyPerk(poor, 'ashen-vigil').ok, false);

    const ranked = { ...poor, earned: { ...poor.earned, 'ashen-vigil': 200 } };
    assert.equal(perkBlocker(ranked, 'ashen-vigil'), 'balance');

    const rich = richEnough();
    const result = buyPerk(rich, 'ashen-vigil');
    assert.equal(result.ok, true);
    assert.equal(rich.perks.length, 0, 'input untouched');
    if (!result.ok) return;
    assert.equal(result.event.type, 'perk-bought');
    assert.equal(result.state.balance['ashen-vigil'], 80);
    assert.equal(result.state.earned['ashen-vigil'], 200, 'lifetime rank is not spent');
    assert.equal(hasPerk(result.state, 'ashen-vigil'), true);
    assert.deepEqual(buyPerk(result.state, 'ashen-vigil'), { ok: false, reason: 'owned' });
  });

  it('exposes each faction\'s single concrete perk', () => {
    for (const f of FACTIONS) {
      assert.match(f.perk.description, /\+|off every vendor/);
      assert.equal(buyPerk(richEnough(), f.id).ok, true);
    }
  });
});
