// The four systems panels: party HUD, emote bubbles, vendor panel, talent tree.
// DOM tests run against the ElStub recorder from domstub.ts, which records the
// innerHTML each panel writes — enough to assert the rendered markup without a
// real browser. Panels are exercised through their public render() surface.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ElStub } from './domstub.js';
import { EMOTE_GLYPHS, EmoteStore, PartyViewStore, ProgressionStore, VendorStore } from './social.js';
import { EmoteBubbleLayer, PartyPanel, TalentPanel, VendorPanel } from './panels.js';

/**
 * Panels resolve element creation through `parent.ownerDocument` (the same
 * indirection hud.ts uses), so an ElStub is a complete stand-in here: its
 * `classList` has real set semantics and it records every `innerHTML` write.
 */
function mountPanel<T>(make: (parent: ElStub) => T): { panel: T; parent: ElStub } {
  const parent = new ElStub();
  const panel = make(parent);
  return { panel, parent };
}

/** Reach a panel's private child element for markup assertions. */
function inner<T = ElStub>(panel: unknown, key: string): T {
  return (panel as unknown as Record<string, T>)[key]!;
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

// ---------------------------------------------------------------------------
// party HUD
// ---------------------------------------------------------------------------

describe('PartyPanel', () => {
  it('renders nothing visible while the player is solo', () => {
    const store = new PartyViewStore();
    const { panel } = mountPanel((p) => new PartyPanel(p as unknown as HTMLElement, store, () => 1));
    assert.equal(panel.render(), true, 'first render always writes');
    assert.equal(panel.render(), false, 'no store change -> no DOM work');
    assert.equal(panel.el.classList.contains('open'), false);
  });

  it('draws one row per member with an HP bar sized to the fraction', () => {
    const store = new PartyViewStore();
    store.apply('party', {
      inParty: true,
      partyId: 1,
      leaderId: 1,
      lootRule: 'freeforst',
      maxMembers: 5,
      members: [MEMBER(), MEMBER({ playerId: 2, name: 'Maren', leader: false, hp: 10, maxHp: 100 })],
    });
    const { panel } = mountPanel((p) => new PartyPanel(p as unknown as HTMLElement, store, () => 1));
    assert.equal(panel.render(), true);
    assert.equal(panel.el.classList.contains('open'), true);
    const html = inner<ElStub>(panel, 'list').innerHTML;
    assert.equal((html.match(/af-hpbar/g) ?? []).length, 2, 'one HP bar per member');
    assert.ok(html.includes('width:60.0%'), 'the 60/100 bar');
    assert.ok(html.includes('width:10.0%'), 'the 10/100 bar');
    assert.ok(html.includes('Maren'));
    assert.ok(html.includes('(you)'), 'the local player is marked');
    assert.ok(html.includes('★'), 'the leader is starred');
    assert.ok(inner<ElStub>(panel, 'lootEl').textContent.includes('Free-for-all'), 'loot rule in the footer');
    assert.ok(inner<ElStub>(panel, 'foot').textContent.includes('2/5'), 'member count in the footer');
  });

  it('closes itself when the party disbands', () => {
    const store = new PartyViewStore();
    store.apply('party', { inParty: true, partyId: 1, members: [MEMBER()] });
    const { panel } = mountPanel((p) => new PartyPanel(p as unknown as HTMLElement, store, () => 1));
    panel.render();
    assert.equal(panel.el.classList.contains('open'), true);
    store.apply('party', { inParty: false, partyId: null, members: [] });
    assert.equal(panel.render(), true);
    assert.equal(panel.el.classList.contains('open'), false);
  });

  it('re-renders only when the store revision moves', () => {
    const store = new PartyViewStore();
    const { panel } = mountPanel((p) => new PartyPanel(p as unknown as HTMLElement, store, () => 1));
    panel.render();
    assert.equal(panel.render(), false);
    store.apply('party', { inParty: true, partyId: 1, members: [MEMBER()] });
    assert.equal(panel.render(), true);
    assert.equal(panel.render(), false);
  });

  it('survives a store with no members and a null-ish payload', () => {
    const store = new PartyViewStore();
    const { panel } = mountPanel((p) => new PartyPanel(p as unknown as HTMLElement, store, () => 1));
    assert.equal(panel.render(), true);
    assert.doesNotThrow(() => store.apply('party', null));
    assert.doesNotThrow(() => panel.render());
  });

  it('shows and hides the pending-invite banner', () => {
    const store = new PartyViewStore();
    const { panel } = mountPanel((p) => new PartyPanel(p as unknown as HTMLElement, store, () => 1));
    panel.render();
    const banner = inner<ElStub>(panel, 'inviteEl');
    assert.equal(banner.style.display, 'none');

    store.apply('party-invite', { fromId: 2, fromName: 'Maren', expiresAt: 5000 });
    assert.equal(panel.render(), true);
    assert.equal(banner.style.display, 'block');
    assert.ok(banner.textContent.includes('Maren'));
    assert.ok(banner.textContent.includes('/accept'), 'the banner names the command');

    // Joining consumes the invite, so the banner retracts on the party frame.
    store.apply('party', {
      inParty: true, partyId: 1, leaderId: 1, lootRule: 'freeforst', maxMembers: 5,
      members: [MEMBER(), MEMBER({ playerId: 2, name: 'Maren', leader: false })],
    });
    panel.render();
    assert.equal(banner.style.display, 'none');
  });

  it('strikes through a dead member and dims the row', () => {
    const store = new PartyViewStore();
    store.apply('party', { inParty: true, partyId: 1, leaderId: 1, lootRule: 'freeforst', maxMembers: 5, members: [MEMBER({ dead: true, hp: 0 })] });
    const { panel } = mountPanel((p) => new PartyPanel(p as unknown as HTMLElement, store, () => 1));
    panel.render();
    assert.ok(inner<ElStub>(panel, 'list').innerHTML.includes('af-member dead'));
  });
});

// ---------------------------------------------------------------------------
// emote bubbles
// ---------------------------------------------------------------------------

describe('EmoteBubbleLayer', () => {
  const project = (x: number, y: number) => ({ sx: x * 10, sy: y * 10 });

  it('creates no nodes while there are no emotes', () => {
    const store = new EmoteStore();
    const { panel } = mountPanel((p) => new EmoteBubbleLayer(p as unknown as HTMLElement, store));
    assert.equal(panel.size, 0);
    assert.equal(panel.render(1000, project), true, 'first pass reports a change');
    assert.equal(panel.render(1000, project), false, 'quiet second pass');
    assert.equal(panel.size, 0);
  });

  it('adds one positioned node per emote and reuses it', () => {
    const store = new EmoteStore();
    const { panel } = mountPanel((p) => new EmoteBubbleLayer(p as unknown as HTMLElement, store));
    store.apply('emote', { seq: 1, fromId: 1, name: 'Ash', emote: 'wave', label: 'Wave', x: 3, y: 4, expiresAt: 9000 });
    panel.render(1000, project);
    assert.equal(panel.size, 1);
    const node = panel.node(1)!;
    assert.equal(node.className, 'af-bubble');
    assert.equal(node.style.left, '30px', 'projected x');
    assert.equal(node.style.top, '40px', 'projected y');
    assert.ok(node.innerHTML.includes('Wave'), 'the bubble carries the emote label');

    // Same player emoting again reuses the node rather than adding one.
    store.apply('emote', { seq: 2, fromId: 1, emote: 'bow', label: 'Bow', x: 5, y: 6, expiresAt: 9000 });
    panel.render(1000, project);
    assert.equal(panel.size, 1);
    assert.equal(panel.node(1), node, 'the DOM node is reused');
    assert.equal(node.style.left, '50px');
  });

  it('shows a distinct glyph per emote id', () => {
    const store = new EmoteStore();
    const { panel } = mountPanel((p) => new EmoteBubbleLayer(p as unknown as HTMLElement, store));
    const glyphs: string[] = [];
    for (const id of Object.keys(EMOTE_GLYPHS)) {
      store.reset();
      store.apply('emote', { seq: 1, fromId: 1, emote: id, label: id, x: 0, y: 0, expiresAt: 99999 });
      panel.render(1000, project);
      glyphs.push(panel.node(1)!.innerHTML.split('<')[0]!);
    }
    assert.equal(new Set(glyphs).size, 8, 'every emote renders its own glyph');
  });

  it('tracks several players at once', () => {
    const store = new EmoteStore();
    const { panel } = mountPanel((p) => new EmoteBubbleLayer(p as unknown as HTMLElement, store));
    store.apply('emote', { seq: 1, fromId: 1, emote: 'wave', x: 1, y: 1, expiresAt: 9000 });
    store.apply('emote', { seq: 2, fromId: 2, emote: 'dance', x: 2, y: 2, expiresAt: 9000 });
    panel.render(1000, project);
    assert.equal(panel.size, 2);
    assert.equal(panel.node(1)!.style.left, '10px');
    assert.equal(panel.node(2)!.style.left, '20px');
  });

  it('removes the node once the server clock passes expiresAt', () => {
    const store = new EmoteStore();
    const { panel } = mountPanel((p) => new EmoteBubbleLayer(p as unknown as HTMLElement, store));
    store.apply('emote', { seq: 1, fromId: 1, emote: 'wave', x: 1, y: 1, expiresAt: 5000 });
    panel.render(1000, project);
    assert.equal(panel.size, 1);
    panel.render(4999, project);
    assert.equal(panel.size, 1, 'still alive at 4999');
    panel.render(5000, project);
    assert.equal(panel.size, 0, 'expiresAt is inclusive');
    assert.equal(panel.node(1), undefined);
  });

  it('drops a node on an emote-end frame', () => {
    const store = new EmoteStore();
    const { panel } = mountPanel((p) => new EmoteBubbleLayer(p as unknown as HTMLElement, store));
    store.apply('emote', { seq: 4, fromId: 1, emote: 'sit', x: 0, y: 0, expiresAt: 99999 });
    panel.render(1000, project);
    assert.equal(panel.size, 1);
    store.apply('emote-end', { seq: 4, fromId: 1 });
    panel.render(1000, project);
    assert.equal(panel.size, 0);
  });

  it('repositions a live bubble every frame without touching the DOM tree', () => {
    const store = new EmoteStore();
    const { panel } = mountPanel((p) => new EmoteBubbleLayer(p as unknown as HTMLElement, store));
    store.apply('emote', { seq: 1, fromId: 1, emote: 'cry', x: 1, y: 1, expiresAt: 99999 });
    panel.render(1000, project);
    const node = panel.node(1)!;
    panel.render(1001, (x, y) => ({ sx: x * 100, sy: y * 100 }));
    assert.equal(panel.size, 1);
    assert.equal(panel.node(1), node);
    assert.equal(node.style.left, '100px', 'moved with the projection');
  });

  it('clear() removes every node and forces the next render to redraw', () => {
    const store = new EmoteStore();
    const { panel } = mountPanel((p) => new EmoteBubbleLayer(p as unknown as HTMLElement, store));
    store.apply('emote', { seq: 1, fromId: 1, emote: 'point', x: 0, y: 0, expiresAt: 99999 });
    panel.render(1000, project);
    assert.equal(panel.size, 1);
    panel.clear();
    assert.equal(panel.size, 0);
    assert.equal(panel.render(1000, project), true, 'revision reset -> redraw');
  });

  it('ignores an unknown emote id (no node, no crash)', () => {
    const store = new EmoteStore();
    const { panel } = mountPanel((p) => new EmoteBubbleLayer(p as unknown as HTMLElement, store));
    store.apply('emote', { seq: 1, fromId: 1, emote: 'moonwalk', x: 0, y: 0, expiresAt: 99999 });
    panel.render(1000, project);
    assert.equal(panel.size, 0);
  });
});

// ---------------------------------------------------------------------------
// vendor panel
// ---------------------------------------------------------------------------

describe('VendorPanel', () => {
  it('stays closed until stock arrives', () => {
    const store = new VendorStore();
    const { panel } = mountPanel((p) => new VendorPanel(p as unknown as HTMLElement, store));
    assert.equal(panel.render(), true);
    assert.equal(panel.el.classList.contains('open'), false);
  });

  it('opens on the first stock frame and re-renders only on change', () => {
    const store = new VendorStore();
    const { panel } = mountPanel((p) => new VendorPanel(p as unknown as HTMLElement, store));
    store.apply('vendor-stock', {
      items: [
        { itemId: 'ember-shard', name: 'Ember Shard', kind: 'material', basePrice: 5, buy: 6, sell: 3, index: 0 },
      ],
    });
    assert.equal(panel.render(), true);
    assert.equal(panel.el.classList.contains('open'), true);
    assert.equal(panel.render(), false);
    store.apply('vendor-stock', {
      items: [
        { itemId: 'ember-shard', name: 'Ember Shard', kind: 'material', basePrice: 5, buy: 9, sell: 5, index: 0.6 },
      ],
    });
    assert.equal(panel.render(), true, 'the price moved');
  });

  it('renders a row with buy price, sell price, arrow and bag count', () => {
    const store = new VendorStore();
    store.apply('vendor-stock', {
      items: [{ itemId: 'ember-shard', name: 'Ember Shard', kind: 'material', basePrice: 5, buy: 6, sell: 3, index: 0 }],
    });
    store.apply('inventory', { playerId: 1, gold: 250, slots: [{ slot: 0, itemId: 'ember-shard', count: 4 }] });
    const { panel } = mountPanel((p) => new VendorPanel(p as unknown as HTMLElement, store));
    panel.render();
    const html = inner<ElStub>(panel, 'list').innerHTML;
    assert.ok(html.includes('Ember Shard'));
    assert.ok(html.includes('x4'), 'bag count');
    assert.ok(html.includes('6g ▬'), 'buy price with a flat arrow');
    assert.ok(html.includes('sell 3g'));
    assert.equal(inner<ElStub>(panel, 'head').textContent, '250g');
  });

  it('marks a rising price and dims a rejected row', () => {
    const store = new VendorStore();
    store.apply('vendor-stock', {
      items: [
        { itemId: 'ember-shard', name: 'Ember Shard', kind: 'material', basePrice: 5, buy: 9, sell: 5, index: 0.7 },
        { itemId: 'iron-ore', name: 'Iron Ore', kind: 'material', basePrice: 6, buy: 7, sell: 3, index: -0.6 },
      ],
    });
    store.apply('vendor-trade', { playerId: 1, side: 'buy', itemId: 'iron-ore', qty: 1, ok: false, reason: 'insufficient-gold', gold: 3 });
    const { panel } = mountPanel((p) => new VendorPanel(p as unknown as HTMLElement, store));
    panel.render();
    const html = inner<ElStub>(panel, 'list').innerHTML;
    assert.ok(html.includes('9g ▲'), 'rising demand');
    assert.ok(html.includes('7g ▼'), 'falling demand');
    assert.ok(html.includes('af-shop-row blocked'), 'the refused row is dimmed');
    assert.ok(html.includes('insufficient-gold'), 'and the tooltip says why');
  });

  it('renders an unsellable row without inventing a price', () => {
    const store = new VendorStore();
    const { panel } = mountPanel((p) => new VendorPanel(p as unknown as HTMLElement, store));
    store.apply('vendor-stock', {
      items: [{ itemId: 'ward-token', name: 'Ward Token', kind: 'quest', basePrice: 0, buy: 0, sell: 0, index: 0 }],
    });
    assert.equal(panel.render(), true);
    assert.equal(panel.el.classList.contains('open'), true);
    assert.ok(inner<ElStub>(panel, 'list').innerHTML.includes('sell n/a'));
  });

  it('survives an empty or malformed stock frame', () => {
    const store = new VendorStore();
    const { panel } = mountPanel((p) => new VendorPanel(p as unknown as HTMLElement, store));
    assert.equal(panel.render(), true);
    assert.doesNotThrow(() => store.apply('vendor-stock', null));
    assert.doesNotThrow(() => panel.render());
    assert.doesNotThrow(() => store.apply('vendor-stock', { items: 'not-an-array' }));
  });
});

// ---------------------------------------------------------------------------
// talent tree panel
// ---------------------------------------------------------------------------

describe('TalentPanel', () => {
  function build(): { store: ProgressionStore; spent: string[]; panel: TalentPanel } {
    const store = new ProgressionStore();
    const spent: string[] = [];
    store.apply('talent-tree', {
      branches: ['might', 'guile', 'will'],
      nodes: [
        NODE({ id: 'might-1', name: 'Braced Stance' }),
        NODE({ id: 'might-2', tier: 2, name: 'Iron Skin', requires: [{ nodeId: 'might-1', rank: 1 }] }),
        NODE({ id: 'guile-1', branch: 'guile', name: 'Light Step' }),
      ],
    });
    store.apply('progression', {
      playerId: 1,
      level: 4,
      xp: 0,
      xpNeeded: 1000,
      talentPoints: 3,
      talents: {},
      meleeDamage: 21,
      gold: 100,
    });
    const panel = new TalentPanel(new ElStub() as unknown as HTMLElement, store, (id) => spent.push(id));
    return { store, spent, panel };
  }

  it('stays closed until the tree arrives', () => {
    const store = new ProgressionStore();
    const panel = new TalentPanel(new ElStub() as unknown as HTMLElement, store, () => {});
    assert.equal(panel.render(), true);
    assert.equal(panel.el.classList.contains('open'), false);
  });

  it('opens once the tree is present and re-renders only on change', () => {
    const { store, panel } = build();
    assert.equal(panel.render(), true);
    assert.equal(panel.el.classList.contains('open'), true);
    assert.equal(panel.render(), false);
    store.apply('progression', { playerId: 1, level: 5, xp: 0, xpNeeded: 1500, talentPoints: 4, talents: {}, meleeDamage: 24, gold: 100 });
    assert.equal(panel.render(), true);
  });

  it('renders one column per branch with a rank count and the build summary', () => {
    const { panel } = build();
    panel.render();
    const html = inner<ElStub>(panel, 'body').innerHTML;
    assert.equal((html.match(/af-branch/g) ?? []).length, 2, 'might and guile have nodes, will does not');
    assert.ok(html.includes('MIGHT · 0 ranks'));
    assert.ok(html.includes('GUILE · 0 ranks'));
    assert.equal((html.match(/data-node=/g) ?? []).length, 3, 'one clickable row per node');
    const head = inner<ElStub>(panel, 'head').textContent;
    assert.ok(head.includes('3 pt'), 'unspent points in the header');
    assert.ok(head.includes('melee 21'), 'aggregated melee damage in the header');
  });

  it('locks a node in the markup when its prerequisite is unmet', () => {
    const { panel } = build();
    panel.render();
    const html = inner<ElStub>(panel, 'body').innerHTML;
    assert.ok(html.includes('data-node="might-2"'));
    assert.ok(html.includes('af-node locked'), 'the locked row is not clickable');
    assert.ok(html.includes('needs might-1 1'), 'the blocker is spelled out');
  });

  it('unlocks the row once the server reports the prerequisite rank', () => {
    const { store, panel } = build();
    store.apply('progression', { playerId: 1, level: 4, xp: 0, xpNeeded: 1000, talentPoints: 3, talents: { 'might-1': 1 }, meleeDamage: 21, gold: 100 });
    panel.render();
    const html = inner<ElStub>(panel, 'body').innerHTML;
    assert.ok(!html.includes('needs might-1 1'), 'no longer blocked');
    assert.ok(html.includes('1/3'), 'the learned rank shows on might-1');
  });

  it('marks a maxed node and stops offering it', () => {
    const { store, panel } = build();
    store.apply('progression', { playerId: 1, level: 4, xp: 0, xpNeeded: 1000, talentPoints: 9, talents: { 'might-1': 3 }, meleeDamage: 21, gold: 100 });
    panel.render();
    const html = inner<ElStub>(panel, 'body').innerHTML;
    assert.ok(html.includes('af-node maxed'));
    assert.ok(html.includes('3/3'));
    assert.ok(html.includes('MAX'));
  });

  it('dims every node when the player has spent all their points', () => {
    const { store, panel } = build();
    store.apply('progression', { playerId: 1, level: 4, xp: 0, xpNeeded: 1000, talentPoints: 0, talents: {}, meleeDamage: 21, gold: 100 });
    panel.render();
    const html = inner<ElStub>(panel, 'body').innerHTML;
    assert.equal((html.match(/af-node locked/g) ?? []).length, 3, 'all three nodes locked');
    assert.ok(html.includes('no points'));
  });

  it('escapes node names and descriptions', () => {
    const store = new ProgressionStore();
    store.apply('talent-tree', { branches: ['might'], nodes: [NODE({ name: '<img src=x>', description: '"><b>bad</b>' })] });
    store.apply('progression', { playerId: 1, level: 1, xp: 0, xpNeeded: 100, talentPoints: 2, talents: {}, meleeDamage: 12, gold: 0 });
    const panel = new TalentPanel(new ElStub() as unknown as HTMLElement, store, () => {});
    panel.render();
    const html = inner<ElStub>(panel, 'body').innerHTML;
    assert.ok(!html.includes('<img'), 'no raw tag leaked');
    assert.ok(html.includes('&lt;img src=x&gt;'));
  });

  it('calls onSpend with the node id for an affordable node', () => {
    const { store, spent, panel } = build();
    panel.render();
    assert.equal(store.canSpend('might-1'), true);
    inner<(id: string) => void>(panel, 'onSpend')('might-1');
    assert.deepEqual(spent, ['might-1']);
  });

  it('does not offer a locked node', () => {
    const { store, panel } = build();
    panel.render();
    assert.equal(store.canSpend('might-2'), false);
    assert.deepEqual(store.lockedBy('might-2'), { nodeId: 'might-1', rank: 1, have: 0 });
  });

  it('survives a tree with malformed nodes', () => {
    const store = new ProgressionStore();
    const panel = new TalentPanel(new ElStub() as unknown as HTMLElement, store, () => {});
    assert.doesNotThrow(() => store.apply('talent-tree', { branches: 'not-an-array', nodes: [NODE(), 'junk', null, { id: '' }] }));
    assert.doesNotThrow(() => panel.render());
    assert.equal(store.talentTree.length, 1, 'only the well-formed node is kept');
  });

  it('derives the branch order from the nodes when the frame omits it', () => {
    const store = new ProgressionStore();
    store.apply('talent-tree', { nodes: [NODE({ branch: 'will' }), NODE({ branch: 'might', tier: 2 })] });
    // Sorted alphabetically so the columns stay stable between frames.
    assert.deepEqual(store.branchOrder, ['might', 'will']);
    assert.equal(store.branch('will').length, 1);
    assert.equal(store.branch('will')[0]!.branch, 'will');
  });
});
