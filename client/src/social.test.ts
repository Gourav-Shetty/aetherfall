// The client-side systems view models: party roster, emote bubbles, progression +
// talent tree, and the vendor list. All pure over server `event` payloads.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  EMOTE_GLYPHS,
  EmoteStore,
  PartyViewStore,
  ProgressionStore,
  SystemsView,
  VendorStore,
  esc,
  lootRuleGlyph,
  lootRuleLabel,
  num,
  priceArrow,
  rec,
  str,
} from './social.js';

// ---------------------------------------------------------------------------
// fixtures — the exact payloads server/src/game/integrated.ts emits
// ---------------------------------------------------------------------------

function partyEvent(members: unknown[], extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    playerId: 1,
    partyId: 1,
    inParty: members.length > 0,
    leaderId: 1,
    lootRule: 'freeforst',
    memberCount: members.length,
    maxMembers: 5,
    members,
    ...extra,
  };
}

const MEMBER = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  playerId: 1,
  name: 'Ash',
  level: 3,
  hp: 60,
  maxHp: 100,
  dead: false,
  ready: false,
  leader: true,
  x: 0,
  y: 0,
  online: true,
  ...over,
});

const NODE = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: 'might-1',
  branch: 'might',
  tier: 1,
  name: 'Braced Stance',
  description: 'Steady the feet.',
  maxRank: 3,
  costPerRank: 1,
  requires: [],
  ...over,
});

function treeEvent(nodes: unknown[]): Record<string, unknown> {
  return { branches: ['might', 'guile', 'will'], nodes };
}

function progressionEvent(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    playerId: 1,
    level: 4,
    xp: 120,
    xpNeeded: 1000,
    maxLevel: 60,
    talentPoints: 3,
    spentPoints: 1,
    respecCount: 0,
    talents: { 'might-1': 1 },
    stats: { attackPower: 3 },
    power: 320,
    meleeDamage: 24,
    gold: 750,
    ...over,
  };
}

function stockEvent(items: unknown[]): Record<string, unknown> {
  return { items };
}

const ITEM = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  itemId: 'ember-shard',
  name: 'Ember Shard',
  kind: 'material',
  basePrice: 5,
  buy: 6,
  sell: 3,
  index: 0,
  ...over,
});

// ---------------------------------------------------------------------------
// payload narrowing
// ---------------------------------------------------------------------------

describe('payload narrowing helpers', () => {
  it('num only accepts finite numbers', () => {
    assert.equal(num(5), 5);
    assert.equal(num(-2), -2);
    assert.equal(num(0), 0);
    assert.equal(num('5'), 0);
    assert.equal(num(NaN), 0);
    assert.equal(num(Infinity), 0);
    assert.equal(num(undefined, 7), 7);
    assert.equal(num(null, 7), 7);
  });

  it('str only accepts strings', () => {
    assert.equal(str('hi'), 'hi');
    assert.equal(str(5), '');
    assert.equal(str(undefined, 'x'), 'x');
    assert.equal(str(null), '');
  });

  it('rec rejects arrays and null', () => {
    assert.deepEqual(rec({ a: 1 }), { a: 1 });
    assert.equal(rec(null), null);
    assert.equal(rec(undefined), null);
    assert.equal(rec([1, 2]), null);
    assert.equal(rec('x'), null);
  });

  it('esc neutralises the HTML metacharacters', () => {
    assert.equal(esc('<b>&"x"'), '&lt;b&gt;&amp;"x"');
    assert.equal(esc("o'brien"), "o'brien");
    assert.equal(esc('<script>alert(1)</script>'), '&lt;script&gt;alert(1)&lt;/script&gt;');
  });
});

// ---------------------------------------------------------------------------
// party
// ---------------------------------------------------------------------------

describe('PartyViewStore', () => {
  it('starts empty and hidden', () => {
    const s = new PartyViewStore();
    assert.equal(s.state.inParty, false);
    assert.deepEqual(s.state.members, []);
    assert.equal(s.member(1), undefined);
    assert.equal(s.isLeader(1), false);
  });

  it('reads a roster with HP, level, leader and loot rule', () => {
    const s = new PartyViewStore();
    assert.equal(s.apply('party', partyEvent([MEMBER(), MEMBER({ playerId: 2, name: 'Maren', level: 4, hp: 100, maxHp: 120, leader: false })])), true);
    const v = s.state;
    assert.equal(v.inParty, true);
    assert.equal(v.partyId, 1);
    assert.equal(v.leaderId, 1);
    assert.equal(v.lootRule, 'freeforst');
    assert.equal(v.memberCount, 2);
    assert.equal(v.maxMembers, 5);
    assert.equal(v.members[0]!.hp, 60);
    assert.equal(v.members[1]!.level, 4);
    assert.equal(v.members[1]!.leader, false);
    assert.equal(s.isLeader(1), true);
    assert.equal(s.isLeader(2), false);
  });

  it('clears the roster when the party is gone', () => {
    const s = new PartyViewStore();
    s.apply('party', partyEvent([MEMBER()]));
    assert.equal(s.state.inParty, true);
    s.apply('party', { playerId: 1, partyId: null, inParty: false, members: [] });
    assert.equal(s.state.inParty, false);
    assert.equal(s.state.partyId, null);
    assert.deepEqual(s.state.members, []);
  });

  it('sorts members by id and orders self first, then leader', () => {
    const s = new PartyViewStore();
    s.apply('party', partyEvent([
      MEMBER({ playerId: 3, name: 'C', leader: false }),
      MEMBER({ playerId: 1, name: 'A', leader: false }),
      MEMBER({ playerId: 2, name: 'B', leader: true }),
    ]));
    assert.deepEqual(s.state.members.map((m) => m.playerId), [1, 2, 3]);
    assert.deepEqual(s.ordered(1).map((m) => m.playerId), [1, 2, 3], 'self, then leader');
    assert.deepEqual(s.ordered(3).map((m) => m.playerId), [3, 2, 1], 'self first even when last by id');
  });

  it('records a pending invite and clears it once you join', () => {
    const s = new PartyViewStore();
    assert.equal(s.apply('party-invite', { fromId: 2, fromName: 'Maren', partyId: 1, expiresAt: 5000 }), true);
    assert.equal(s.invite?.fromName, 'Maren');
    assert.equal(s.invite?.expiresAt, 5000);
    s.apply('party', partyEvent([MEMBER(), MEMBER({ playerId: 2, leader: false })]));
    assert.equal(s.invite, null, 'joining consumes the invite');
  });

  it('falls back to a synthetic name when the invite omits one', () => {
    const s = new PartyViewStore();
    s.apply('party-invite', { fromId: 7 });
    assert.equal(s.invite?.fromName, '#7');
  });

  it('ignores junk payloads and unknown kinds without throwing', () => {
    const s = new PartyViewStore();
    assert.equal(s.apply('party', null), false);
    assert.equal(s.apply('party', 'nope'), false);
    assert.equal(s.apply('party', []), false);
    assert.equal(s.apply('something-else', partyEvent([MEMBER()])), false);
    // A member with no id is skipped; a member with no hp reads as 0.
    s.apply('party', partyEvent([MEMBER({ playerId: -1 }), MEMBER({ hp: undefined, maxHp: undefined, name: undefined })]));
    assert.equal(s.state.members.length, 1);
    assert.equal(s.state.members[0]!.hp, 0);
    assert.equal(s.state.members[0]!.maxHp, 1, 'maxHp floors at 1 so the bar cannot divide by zero');
    assert.equal(s.state.members[0]!.name, '#1');
  });

  it('treats inParty:true with zero members as not in a party', () => {
    const s = new PartyViewStore();
    s.apply('party', { inParty: true, partyId: 4, members: [] });
    assert.equal(s.state.inParty, false);
  });

  it('bumps the revision on every accepted payload only', () => {
    const s = new PartyViewStore();
    const r0 = s.revision;
    assert.equal(s.apply('unrelated', {}), false);
    assert.equal(s.revision, r0);
    s.apply('party', partyEvent([MEMBER()]));
    assert.equal(s.revision, r0 + 1);
  });

  it('reset() clears the roster and any invite', () => {
    const s = new PartyViewStore();
    s.apply('party', partyEvent([MEMBER()]));
    s.apply('party-invite', { fromId: 2, fromName: 'B' });
    s.reset();
    assert.equal(s.state.inParty, false);
    assert.equal(s.invite, null);
  });

  it('labels and glyphs every loot rule, defaulting safely', () => {
    assert.equal(lootRuleLabel('freeforst'), 'Free-for-all');
    assert.equal(lootRuleLabel('leader'), 'Leader');
    assert.equal(lootRuleLabel('master'), 'Master');
    assert.equal(lootRuleLabel('banana'), 'banana');
    assert.equal(lootRuleLabel(''), 'unknown');
    assert.equal(lootRuleGlyph('freeforst'), '◇');
    assert.equal(lootRuleGlyph('leader'), '★');
    assert.equal(lootRuleGlyph('master'), '◈');
  });
});

// ---------------------------------------------------------------------------
// emotes
// ---------------------------------------------------------------------------

describe('EmoteStore', () => {
  it('adds a bubble with a glyph for each of the 8 emotes', () => {
    assert.equal(Object.keys(EMOTE_GLYPHS).length, 8);
    for (const id of Object.keys(EMOTE_GLYPHS)) {
      const s = new EmoteStore();
      assert.equal(s.apply('emote', { seq: 1, fromId: 1, name: 'Ash', emote: id, label: id, x: 1, y: 2, expiresAt: 5000 }), true, id);
      const b = s.forPlayer(1)!;
      assert.equal(b.emote, id);
      assert.equal(b.x, 1);
      assert.equal(b.y, 2);
    }
  });

  it('rejects an emote the client does not know', () => {
    const s = new EmoteStore();
    assert.equal(s.apply('emote', { seq: 1, fromId: 1, emote: 'moonwalk', expiresAt: 100 }), false);
    assert.equal(s.size, 0);
  });

  it('keeps one bubble per player (a new emote replaces the old)', () => {
    const s = new EmoteStore();
    s.apply('emote', { seq: 1, fromId: 1, emote: 'wave', expiresAt: 1000 });
    s.apply('emote', { seq: 2, fromId: 1, emote: 'bow', expiresAt: 2000 });
    assert.equal(s.size, 1);
    assert.equal(s.forPlayer(1)!.emote, 'bow');
  });

  it('tracks several players independently', () => {
    const s = new EmoteStore();
    s.apply('emote', { seq: 1, fromId: 1, emote: 'wave', expiresAt: 1000 });
    s.apply('emote', { seq: 2, fromId: 2, emote: 'dance', expiresAt: 2000 });
    assert.equal(s.size, 2);
    assert.equal(s.forPlayer(1)!.emote, 'wave');
    assert.equal(s.forPlayer(2)!.emote, 'dance');
    assert.equal(s.forPlayer(3), undefined);
  });

  it('expires on the server clock, independent of emote-end frames', () => {
    const s = new EmoteStore();
    s.apply('emote', { seq: 1, fromId: 1, emote: 'wave', expiresAt: 1000 });
    assert.equal(s.size, 1);
    assert.equal(s.prune(999), false, 'still alive');
    assert.equal(s.prune(1000), true, 'expiresAt is inclusive');
    assert.equal(s.size, 0);
    // A late duplicate emote-end must not throw or resurrect anything.
    assert.equal(s.apply('emote-end', { seq: 1, fromId: 1 }), false);
  });

  it('emote-end drops the bubble by seq', () => {
    const s = new EmoteStore();
    s.apply('emote', { seq: 7, fromId: 1, emote: 'wave', expiresAt: 9999 });
    assert.equal(s.apply('emote-end', { seq: 7, fromId: 1 }), true);
    assert.equal(s.size, 0);
  });

  it('list() prunes and returns the survivors', () => {
    const s = new EmoteStore();
    s.apply('emote', { seq: 1, fromId: 1, emote: 'wave', expiresAt: 1000 });
    s.apply('emote', { seq: 2, fromId: 2, emote: 'bow', expiresAt: 5000 });
    assert.deepEqual(s.list(2000).map((b) => b.fromId), [2]);
    assert.equal(s.size, 1);
  });

  it('reset() clears everything', () => {
    const s = new EmoteStore();
    s.apply('emote', { seq: 1, fromId: 1, emote: 'wave', expiresAt: 9999 });
    s.reset();
    assert.equal(s.size, 0);
  });

  it('falls back to a synthetic name', () => {
    const s = new EmoteStore();
    s.apply('emote', { seq: 1, fromId: 9, emote: 'wave', expiresAt: 100 });
    assert.equal(s.forPlayer(9)!.name, '#9');
  });
});

// ---------------------------------------------------------------------------
// progression + talents
// ---------------------------------------------------------------------------

describe('ProgressionStore', () => {
  it('starts with no tree and level 1', () => {
    const s = new ProgressionStore();
    assert.equal(s.state.level, 1);
    assert.equal(s.state.talentPoints, 0);
    assert.equal(s.talentTree.length, 0);
    assert.equal(s.canSpend('might-1'), false, 'no tree -> nothing is spendable');
  });

  it('reads the skill tree and groups it by branch and tier', () => {
    const s = new ProgressionStore();
    assert.equal(s.apply('talent-tree', treeEvent([
      NODE({ id: 'might-2', tier: 2, name: 'Iron Skin', requires: [{ nodeId: 'might-1', rank: 1 }] }),
      NODE({ id: 'might-1' }),
      NODE({ id: 'guile-1', branch: 'guile', name: 'Light Step' }),
    ])), true);
    assert.equal(s.talentTree.length, 3);
    assert.deepEqual(s.branchOrder, ['might', 'guile', 'will']);
    assert.deepEqual(s.branch('might').map((n) => n.id), ['might-1', 'might-2'], 'tier order');
    assert.deepEqual(s.branch('will'), []);
  });

  it('reads progression: level, xp, points, talents, melee and gold', () => {
    const s = new ProgressionStore();
    assert.equal(s.apply('progression', progressionEvent()), true);
    assert.equal(s.state.level, 4);
    assert.equal(s.state.xp, 120);
    assert.equal(s.state.xpNeeded, 1000);
    assert.equal(s.state.talentPoints, 3);
    assert.equal(s.state.meleeDamage, 24);
    assert.equal(s.state.gold, 750);
    assert.equal(s.rank('might-1'), 1);
    assert.equal(s.rank('might-4'), 0);
  });

  it('strips non-positive and absurd talent ranks', () => {
    const s = new ProgressionStore();
    s.apply('progression', progressionEvent({ talents: { 'might-1': 2, 'might-2': 0, 'might-3': -1, 'will-5': 999 } }));
    assert.deepEqual(s.state.talents, { 'might-1': 2, 'will-5': 99 });
  });

  it('tracks xp-gain and levelup without a full progression frame', () => {
    const s = new ProgressionStore();
    s.apply('progression', progressionEvent());
    s.apply('xp-gain', { playerId: 1, amount: 80, level: 4, xpLeft: 200, next: 1000 });
    assert.equal(s.state.xp, 200);
    s.apply('levelup', { playerId: 1, level: 5 });
    assert.equal(s.state.level, 5);
  });

  it('gold frames update the wallet only', () => {
    const s = new ProgressionStore();
    s.apply('progression', progressionEvent());
    s.apply('gold', { playerId: 1, gold: 120 });
    assert.equal(s.state.gold, 120);
    assert.equal(s.state.level, 4, 'a gold frame must not disturb progression');
  });

  describe('spendability', () => {
    function tree(): ProgressionStore {
      const s = new ProgressionStore();
      s.apply('talent-tree', treeEvent([
        NODE({ id: 'might-1', maxRank: 3, costPerRank: 1 }),
        NODE({ id: 'might-2', tier: 2, maxRank: 1, costPerRank: 2, requires: [{ nodeId: 'might-1', rank: 2 }] }),
        NODE({ id: 'will-5', branch: 'will', tier: 5, maxRank: 1, costPerRank: 2, requires: [{ nodeId: 'will-4', rank: 2 }] }),
      ]));
      return s;
    }

    it('allows an affordable, unlocked, non-maxed node', () => {
      const s = tree();
      s.apply('progression', progressionEvent({ talentPoints: 3, talents: {} }));
      assert.equal(s.canSpend('might-1'), true);
      assert.equal(s.lockedBy('might-1'), null);
    });

    it('refuses without points', () => {
      const s = tree();
      s.apply('progression', progressionEvent({ talentPoints: 0, talents: {} }));
      assert.equal(s.canSpend('might-1'), false);
      assert.equal(s.canSpend('might-2'), false);
    });

    it('refuses when the node is maxed', () => {
      const s = tree();
      s.apply('progression', progressionEvent({ talentPoints: 5, talents: { 'might-1': 3 } }));
      assert.equal(s.canSpend('might-1'), false);
      assert.equal(s.lockedBy('might-1'), null, 'maxed is not the same as locked');
    });

    it('reports the exact prerequisite that is blocking a node', () => {
      const s = tree();
      s.apply('progression', progressionEvent({ talentPoints: 9, talents: { 'might-1': 1 } }));
      const lock = s.lockedBy('might-2');
      assert.deepEqual(lock, { nodeId: 'might-1', rank: 2, have: 1 });
      assert.equal(s.canSpend('might-2'), false);
      s.apply('progression', progressionEvent({ talentPoints: 9, talents: { 'might-1': 2 } }));
      assert.equal(s.lockedBy('might-2'), null);
      assert.equal(s.canSpend('might-2'), true, 'unlocked, affordable (cost 2 of 9)');
    });

    it('refuses an unknown node id', () => {
      const s = tree();
      s.apply('progression', progressionEvent({ talentPoints: 9 }));
      assert.equal(s.canSpend('no-such-node'), false);
      assert.equal(s.lockedBy('no-such-node'), null);
    });
  });

  it('surfaces a server denial once for a toast', () => {
    const s = new ProgressionStore();
    s.apply('talent-denied', { playerId: 1, nodeId: 'might-2', reason: 'prereq' });
    assert.deepEqual(s.consumeDenial(), { nodeId: 'might-2', reason: 'prereq' });
    assert.equal(s.consumeDenial(), null, 'consumed exactly once');
  });

  it('ignores junk and unknown kinds', () => {
    const s = new ProgressionStore();
    assert.equal(s.apply('progression', null), false);
    assert.equal(s.apply('progression', 42), false);
    assert.equal(s.apply('nope', progressionEvent()), false);
    assert.equal(s.apply('talent-tree', {}), true, 'a tree frame with no nodes is still a tree');
    assert.equal(s.talentTree.length, 0);
  });

  it('reset() drops the tree but keeps a sane level', () => {
    const s = new ProgressionStore();
    s.apply('talent-tree', treeEvent([NODE()]));
    s.apply('progression', progressionEvent());
    s.reset();
    assert.equal(s.talentTree.length, 0);
    assert.equal(s.branchOrder.length, 0);
  });
});

// ---------------------------------------------------------------------------
// vendor
// ---------------------------------------------------------------------------

describe('VendorStore', () => {
  it('reads stock with buy, sell and the demand index', () => {
    const s = new VendorStore();
    assert.equal(s.apply('vendor-stock', stockEvent([ITEM(), ITEM({ itemId: 'minor-potion', name: 'Minor Potion', buy: 18, sell: 9, index: -0.4 })])), true);
    assert.equal(s.stock.length, 2);
    assert.equal(s.row('ember-shard')!.buy, 6);
    assert.equal(s.row('minor-potion')!.sell, 9);
    assert.equal(s.row('minor-potion')!.index, -0.4);
  });

  it('sorts rows by kind then name so the list is stable', () => {
    const s = new VendorStore();
    s.apply('vendor-stock', stockEvent([
      ITEM({ itemId: 'zzz', name: 'Zeta', kind: 'material' }),
      ITEM({ itemId: 'aaa', name: 'Alpha', kind: 'material' }),
      ITEM({ itemId: 'mmm', name: 'Mid', kind: 'consumable' }),
    ]));
    assert.deepEqual(s.stock.map((r) => r.name), ['Mid', 'Alpha', 'Zeta']);
  });

  it('skips rows with no itemId', () => {
    const s = new VendorStore();
    s.apply('vendor-stock', stockEvent([ITEM(), ITEM({ itemId: '' }), 'junk', null]));
    assert.equal(s.stock.length, 1);
  });

  it('carries bag counts from the inventory event onto the rows', () => {
    const s = new VendorStore();
    s.apply('vendor-stock', stockEvent([ITEM()]));
    assert.equal(s.row('ember-shard')!.held, 0);
    s.apply('inventory', {
      playerId: 1,
      gold: 900,
      equipped: [],
      slots: [
        { slot: 0, itemId: 'ember-shard', count: 4 },
        { slot: 1, itemId: 'ember-shard', count: 6 },
        { slot: 2, itemId: 'minor-potion', count: 2 },
        { slot: 3, itemId: null, count: 0 },
      ],
    });
    assert.equal(s.row('ember-shard')!.held, 10, 'stacks are summed');
    assert.equal(s.gold, 900);
  });

  it('buy/sell viability follows gold, holdings and rejection state', () => {
    const s = new VendorStore();
    s.apply('vendor-stock', stockEvent([ITEM(), ITEM({ itemId: 'ward-token', name: 'Ward Token', basePrice: 0, buy: 0, sell: 0 })]));
    s.apply('inventory', {
      playerId: 1,
      gold: 20,
      slots: [{ slot: 0, itemId: 'ember-shard', count: 3 }, { slot: 1, itemId: 'ward-token', count: 1 }],
    });
    const shard = s.row('ember-shard')!;
    assert.equal(s.canBuy(shard), true, '6g of 20g');
    assert.equal(s.canBuy(shard, 4), false, '24g of 20g');
    assert.equal(s.canSell(shard), true, '3 held');
    assert.equal(s.canSell(shard, 4), false);
    assert.equal(s.proceeds(shard, 2), 6);
    // A 0-price quest token is neither buyable nor sellable.
    const token = s.row('ward-token')!;
    assert.equal(s.canBuy(token), false);
    assert.equal(s.canSell(token), false);
    assert.equal(s.proceeds(token), 0);
  });

  it('records a successful trade and clears the row rejection', () => {
    const s = new VendorStore();
    s.apply('vendor-stock', stockEvent([ITEM()]));
    s.apply('vendor-trade', { playerId: 1, side: 'buy', itemId: 'ember-shard', qty: 2, unitPrice: 6, total: 12, gold: 488, ok: false, reason: 'inventory-full' });
    assert.equal(s.row('ember-shard')!.blocked, 'inventory-full');
    assert.equal(s.canBuy(s.row('ember-shard')!), false, 'a rejected row is not clickable');
    s.apply('vendor-trade', { playerId: 1, side: 'buy', itemId: 'ember-shard', qty: 2, unitPrice: 6, total: 12, gold: 488, ok: true });
    assert.equal(s.row('ember-shard')!.blocked, null);
    assert.equal(s.canBuy(s.row('ember-shard')!), true);
    assert.deepEqual(s.consumeTrade(), { side: 'buy', itemId: 'ember-shard', qty: 2, total: 12 });
    assert.equal(s.consumeTrade(), null);
  });

  it('preserves held counts and rejections across a price refresh', () => {
    const s = new VendorStore();
    s.apply('vendor-stock', stockEvent([ITEM()]));
    s.apply('inventory', { playerId: 1, gold: 500, slots: [{ slot: 0, itemId: 'ember-shard', count: 5 }] });
    s.apply('vendor-trade', { playerId: 1, side: 'sell', itemId: 'ember-shard', qty: 1, ok: false, reason: 'player-lacks-item' });
    s.apply('vendor-stock', stockEvent([ITEM({ buy: 9, sell: 5, index: 0.5 })]));
    const row = s.row('ember-shard')!;
    assert.equal(row.held, 5, 'the bag survived the refresh');
    assert.equal(row.blocked, 'player-lacks-item');
    assert.equal(row.buy, 9, 'but the price moved');
  });

  it('gold frames update the wallet', () => {
    const s = new VendorStore();
    s.apply('gold', { playerId: 1, gold: 42 });
    assert.equal(s.gold, 42);
  });

  it('arrows reflect the demand index with a dead band', () => {
    assert.equal(priceArrow(0.5), '▲');
    assert.equal(priceArrow(0.06), '▲');
    assert.equal(priceArrow(0.05), '▬');
    assert.equal(priceArrow(0), '▬');
    assert.equal(priceArrow(-0.4), '▼');
    assert.equal(priceArrow(-0.05), '▬');
  });

  it('reset() clears the list', () => {
    const s = new VendorStore();
    s.apply('vendor-stock', stockEvent([ITEM()]));
    s.reset();
    assert.equal(s.stock.length, 0);
  });
});

// ---------------------------------------------------------------------------
// composite
// ---------------------------------------------------------------------------

describe('SystemsView', () => {
  it('routes each event to exactly one store', () => {
    const s = new SystemsView();
    assert.equal(s.apply('party', partyEvent([MEMBER()])), true);
    assert.equal(s.party.state.inParty, true);
    assert.equal(s.apply('emote', { seq: 1, fromId: 2, emote: 'wave', expiresAt: 1000 }), true);
    assert.equal(s.emotes.size, 1);
    assert.equal(s.apply('talent-tree', treeEvent([NODE()])), true);
    assert.equal(s.progression.talentTree.length, 1);
    assert.equal(s.apply('vendor-stock', stockEvent([ITEM()])), true);
    assert.equal(s.vendor.stock.length, 1);
  });

  it('reports false for events no store wants', () => {
    const s = new SystemsView();
    assert.equal(s.apply('mob-die', { id: 5 }), false);
    assert.equal(s.apply('telegraph', { x: 1, y: 2, r: 3 }), false);
    assert.equal(s.apply('', null), false);
  });

  it('a full session bootstrap wires every panel', () => {
    const s = new SystemsView();
    s.apply('progression', progressionEvent());
    s.apply('talent-tree', treeEvent([NODE(), NODE({ id: 'might-2', tier: 2, requires: [{ nodeId: 'might-1', rank: 1 }] })]));
    s.apply('gold', { playerId: 1, gold: 800 });
    s.apply('inventory', { playerId: 1, gold: 800, slots: [{ slot: 0, itemId: 'ember-shard', count: 2 }] });
    s.apply('vendor-stock', stockEvent([ITEM()]));
    s.apply('party', partyEvent([MEMBER(), MEMBER({ playerId: 2, leader: false, hp: 12, dead: true })]));
    s.apply('party-invite', { fromId: 3, fromName: 'Bryn', expiresAt: 900 });
    s.apply('emote', { seq: 1, fromId: 2, emote: 'laugh', label: 'Laugh', x: 4, y: 5, expiresAt: 9000 });

    assert.equal(s.progression.state.level, 4);
    assert.equal(s.progression.state.gold, 800);
    assert.equal(s.vendor.gold, 800);
    assert.equal(s.vendor.row('ember-shard')!.held, 2);
    assert.equal(s.party.state.members.length, 2);
    assert.equal(s.party.state.members[1]!.dead, true);
    assert.equal(s.party.invite?.fromName, 'Bryn');
    assert.equal(s.emotes.forPlayer(2)!.emote, 'laugh');
    assert.equal(s.emotes.list(1000)[0]!.x, 4);

    s.reset();
    assert.equal(s.party.state.inParty, false);
    assert.equal(s.emotes.size, 0);
    assert.equal(s.vendor.stock.length, 0);
    assert.equal(s.progression.talentTree.length, 0);
  });
});
