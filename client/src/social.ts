// @aetherfall/client — social + progression view models for the composed-systems
// integration. PURE state holders over the server's `event` payloads: no DOM,
// no rendering, no networking. `panels.ts` draws them; `main.ts` feeds them.
//
// Every class is defensive about shape. The server is authoritative and older
// builds simply do not send these events, so an unknown kind or a missing field
// must degrade to "no data" rather than throw during a render frame.

import { AvatarOverlayStore } from './masks.js';

/** Protocol v1 event kinds this module consumes. */
export const EV = {
  PARTY: 'party',
  PARTY_INVITE: 'party-invite',
  EMOTE: 'emote',
  EMOTE_END: 'emote-end',
  PROGRESSION: 'progression',
  TALENT_TREE: 'talent-tree',
  TALENT_LEARNED: 'talent-learned',
  TALENT_DENIED: 'talent-denied',
  RESPEC: 'respec',
  VENDOR_STOCK: 'vendor-stock',
  VENDOR_TRADE: 'vendor-trade',
  GOLD: 'gold',
  INVENTORY: 'inventory',
  XP_GAIN: 'xp-gain',
  LEVELUP: 'levelup',
  SYS_MSG: 'sys-msg',
  MASK_EQUIPPED: 'mask-equipped',
  MASK_UNEQUIPPED: 'mask-unequipped',
  VOCATION: 'vocation',
} as const;

// ---------------------------------------------------------------------------
// payload narrowing
// ---------------------------------------------------------------------------

/** Read a finite number out of an untrusted payload. */
export function num(v: unknown, fallback = 0): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

/** Read a string out of an untrusted payload. */
export function str(v: unknown, fallback = ''): string {
  return typeof v === 'string' ? v : fallback;
}

/** Read a plain record out of an untrusted payload. */
export function rec(v: unknown): Record<string, unknown> | null {
  return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

/**
 * Read a choice catalog (vocations / masks) out of an untrusted payload.
 * Keeps only entries carrying every `need` key as a non-empty string; all
 * other fields degrade to blanks/zeros. Anything malformed yields [].
 */
export function readChoices(v: unknown, need: string[]): Array<Record<string, unknown>> {
  if (!Array.isArray(v)) return [];
  const out: Array<Record<string, unknown>> = [];
  for (const e of v) {
    const r = rec(e);
    if (!r) continue;
    if (!need.every((k) => str(r[k]).length > 0)) continue;
    out.push(r);
  }
  return out;
}

/** HTML-escape helper for the panel templates. */
export function esc(s: string): string {
  return s.replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]!));
}

// ---------------------------------------------------------------------------
// party
// ---------------------------------------------------------------------------

export type PartyMemberView = {
  playerId: number;
  name: string;
  level: number;
  hp: number;
  maxHp: number;
  dead: boolean;
  ready: boolean;
  leader: boolean;
  online: boolean;
};

export type PartyView = {
  inParty: boolean;
  partyId: number | null;
  leaderId: number;
  lootRule: string;
  memberCount: number;
  maxMembers: number;
  members: PartyMemberView[];
};

/** Loot rule -> arrow glyph, matching the server's `freeforst` wire spelling. */
export function lootRuleGlyph(rule: string): string {
  if (rule === 'leader') return '★';
  if (rule === 'master') return '◈';
  return '◇';
}

export function lootRuleLabel(rule: string): string {
  if (rule === 'leader') return 'Leader';
  if (rule === 'master') return 'Master';
  if (rule === 'freeforst') return 'Free-for-all';
  return rule || 'unknown';
}

/**
 * Party roster state. Fed by the private `party` event the session emits on
 * join, on every membership change, and on the throttled sync tick.
 */
export class PartyViewStore {
  private view: PartyView = {
    inParty: false,
    partyId: null,
    leaderId: 0,
    lootRule: 'freeforst',
    memberCount: 0,
    maxMembers: 5,
    members: [],
  };

  /** Latest pending invite aimed at the local player, if any. */
  invite: { fromId: number; fromName: string; expiresAt: number } | null = null;
  /** Bumped on every accepted payload so panels can skip redundant re-renders. */
  revision = 0;

  apply(kind: string, payload: unknown): boolean {
    const p = rec(payload);
    if (!p) return false;
    if (kind === EV.PARTY_INVITE) {
      this.invite = {
        fromId: num(p['fromId']),
        fromName: str(p['fromName'], `#${num(p['fromId'])}`),
        expiresAt: num(p['expiresAt']),
      };
      this.revision++;
      return true;
    }
    if (kind !== EV.PARTY) return false;
    const raw = Array.isArray(p['members']) ? (p['members'] as unknown[]) : [];
    const members: PartyMemberView[] = [];
    for (const m of raw) {
      const r = rec(m);
      if (!r) continue;
      const playerId = num(r['playerId'], -1);
      if (playerId < 0) continue;
      members.push({
        playerId,
        name: str(r['name'], `#${playerId}`),
        level: Math.max(1, num(r['level'], 1)),
        hp: Math.max(0, num(r['hp'])),
        maxHp: Math.max(1, num(r['maxHp'], 1)),
        dead: r['dead'] === true,
        ready: r['ready'] === true,
        leader: r['leader'] === true,
        online: r['online'] !== false,
      });
    }
    members.sort((a, b) => a.playerId - b.playerId);
    const inParty = p['inParty'] === true && members.length > 0;
    this.view = {
      inParty,
      partyId: inParty ? num(p['partyId'], -1) : null,
      leaderId: num(p['leaderId']),
      lootRule: str(p['lootRule'], 'freeforst'),
      memberCount: inParty ? members.length : 0,
      maxMembers: Math.max(1, num(p['maxMembers'], 5)),
      members: inParty ? members : [],
    };
    // An accepted invite is consumed by the party update.
    if (inParty && this.invite) this.invite = null;
    this.revision++;
    return true;
  }

  get state(): PartyView {
    return this.view;
  }

  member(playerId: number): PartyMemberView | undefined {
    return this.view.members.find((m) => m.playerId === playerId);
  }

  isLeader(playerId: number): boolean {
    return this.view.inParty && this.view.leaderId === playerId;
  }

  /** Local player row first, then leader, then everyone else by id. */
  ordered(selfId: number): PartyMemberView[] {
    return [...this.view.members].sort((a, b) => {
      if (a.playerId === selfId) return -1;
      if (b.playerId === selfId) return 1;
      if (a.leader !== b.leader) return a.leader ? -1 : 1;
      return a.playerId - b.playerId;
    });
  }

  reset(): void {
    this.view = { inParty: false, partyId: null, leaderId: 0, lootRule: 'freeforst', memberCount: 0, maxMembers: 5, members: [] };
    this.invite = null;
    this.revision++;
  }
}

// ---------------------------------------------------------------------------
// emotes
// ---------------------------------------------------------------------------

export type EmoteBubble = {
  seq: number;
  fromId: number;
  name: string;
  /** Human label from the server ("Wave"). */
  label: string;
  /** Canonical emote id from the server ("wave"). */
  emote: string;
  x: number;
  y: number;
  expiresAt: number;
};

/** Emote id -> the glyph shown in the bubble. */
export const EMOTE_GLYPHS: Record<string, string> = {
  wave: '👋',
  cheer: '🎉',
  bow: '🙇',
  laugh: '😂',
  cry: '😢',
  sit: '🪑',
  point: '👉',
  dance: '💃',
};

/**
 * Live emote bubbles. The server is the expiry authority (`expiresAt`), and the
 * client prunes on its own so a dropped `emote-end` frame cannot leave a bubble
 * stuck on screen forever.
 */
export class EmoteStore {
  private bubbles = new Map<number, EmoteBubble>();
  private nextSeq = 1;
  revision = 0;

  apply(kind: string, payload: unknown): boolean {
    const p = rec(payload);
    if (!p) return false;
    if (kind === EV.EMOTE_END) return this.drop(num(p['seq'], -1));
    if (kind !== EV.EMOTE) return false;
    const emote = str(p['emote']);
    if (Object.keys(EMOTE_GLYPHS).indexOf(emote) < 0) return false;
    const fromId = num(p['fromId'], -1);
    if (fromId < 0) return false;
    // One bubble per player: a new emote replaces the previous one.
    for (const [seq, b] of this.bubbles) if (b.fromId === fromId) this.bubbles.delete(seq);
    const seq = num(p['seq'], this.nextSeq);
    if (seq >= this.nextSeq) this.nextSeq = seq + 1;
    this.bubbles.set(seq, {
      seq,
      fromId,
      name: str(p['name'], `#${fromId}`),
      label: str(p['label'], emote),
      emote,
      x: num(p['x']),
      y: num(p['y']),
      expiresAt: num(p['expiresAt']),
    });
    this.revision++;
    return true;
  }

  private drop(seq: number): boolean {
    if (!this.bubbles.delete(seq)) return false;
    this.revision++;
    return true;
  }

  /** Drop expired bubbles. Returns true when anything changed (for re-render). */
  prune(now: number): boolean {
    let changed = false;
    for (const [seq, b] of this.bubbles) {
      if (b.expiresAt <= now) {
        this.bubbles.delete(seq);
        changed = true;
      }
    }
    if (changed) this.revision++;
    return changed;
  }

  /** Bubble for one entity, if it currently has one. */
  forPlayer(playerId: number): EmoteBubble | undefined {
    for (const b of this.bubbles.values()) if (b.fromId === playerId) return b;
    return undefined;
  }

  list(now: number): EmoteBubble[] {
    this.prune(now);
    return [...this.bubbles.values()];
  }

  get size(): number {
    return this.bubbles.size;
  }

  reset(): void {
    this.bubbles.clear();
    this.revision++;
  }
}

// ---------------------------------------------------------------------------
// progression + talents
// ---------------------------------------------------------------------------

export type TalentNode = {
  id: string;
  branch: string;
  tier: number;
  name: string;
  description: string;
  maxRank: number;
  costPerRank: number;
  requires: { nodeId: string; rank: number }[];
};

/** One vocation choice from the server's talent-tree catalog. */
export type VocationChoice = {
  id: string;
  name: string;
  role: string;
  description: string;
  favoredBranch: string;
  startingWeapon: string;
  startingMask: string;
  signature: { id: string; name: string; description: string; cooldownMs: number };
};

/** One mask choice from the server's talent-tree catalog. */
export type MaskChoice = {
  id: string;
  name: string;
  theme: string;
  perk: string;
  description: string;
  price: number;
  glyph: string;
};

export type ProgressionView = {
  level: number;
  xp: number;
  xpNeeded: number;
  maxLevel: number;
  talentPoints: number;
  spentPoints: number;
  respecCount: number;
  talents: Record<string, number>;
  meleeDamage: number;
  power: number;
  gold: number;
  /** Worn mask id (null when bare-faced). Drives the mask picker. */
  maskId: string | null;
  /** Sworn vocation id (null when unsworn). Drives the calling picker. */
  vocation: string | null;
};

/** Progression + skill-tree state, driven entirely by the server payloads. */
export class ProgressionStore {
  private nodes: TalentNode[] = [];
  private branches: string[] = [];
  private byId = new Map<string, TalentNode>();
  /** Vocation choices from the talent-tree catalog (empty on older shards). */
  vocations: VocationChoice[] = [];
  /** Mask choices from the talent-tree catalog (empty on older shards). */
  masks: MaskChoice[] = [];
  private prog: ProgressionView = {
    level: 1,
    xp: 0,
    xpNeeded: 100,
    maxLevel: 60,
    talentPoints: 0,
    spentPoints: 0,
    respecCount: 0,
    talents: {},
    meleeDamage: 12,
    power: 0,
    gold: 0,
    maskId: null,
    vocation: null,
  };
  /** Nodes the server refused, with the reason, for a one-shot toast. */
  lastDenial: { nodeId: string; reason: string } | null = null;
  revision = 0;

  apply(kind: string, payload: unknown): boolean {
    const p = rec(payload);
    if (!p) return false;
    if (kind === EV.TALENT_TREE) {
      const raw = Array.isArray(p['nodes']) ? (p['nodes'] as unknown[]) : [];
      const nodes: TalentNode[] = [];
      for (const n of raw) {
        const r = rec(n);
        if (!r) continue;
        const id = str(r['id']);
        if (id.length === 0) continue;
        nodes.push({
          id,
          branch: str(r['branch'], 'might'),
          tier: Math.max(1, num(r['tier'], 1)),
          name: str(r['name'], id),
          description: str(r['description']),
          maxRank: Math.max(1, num(r['maxRank'], 1)),
          costPerRank: Math.max(1, num(r['costPerRank'], 1)),
          requires: Array.isArray(r['requires'])
            ? (r['requires'] as unknown[])
                .map((q) => rec(q))
                .filter((q): q is Record<string, unknown> => q !== null)
                .map((q) => ({ nodeId: str(q['nodeId']), rank: Math.max(1, num(q['rank'], 1)) }))
                .filter((q) => q.nodeId.length > 0)
            : [],
        });
      }
      nodes.sort((a, b) => a.branch.localeCompare(b.branch) || a.tier - b.tier);
      this.nodes = nodes;
      this.byId = new Map(nodes.map((n) => [n.id, n]));
      this.branches = Array.isArray(p['branches'])
        ? (p['branches'] as unknown[]).filter((b): b is string => typeof b === 'string')
        : [...new Set(nodes.map((n) => n.branch))];
      // Choice catalogs for the vocation + mask pickers (additive; older
      // shards omit them and the pickers stay hidden).
      this.vocations = readChoices(p['vocations'], ['id', 'name']).map((r) => {
        const sig = rec(r['signature']) ?? {};
        return {
          id: str(r['id']),
          name: str(r['name'], str(r['id'])),
          role: str(r['role']),
          description: str(r['description']),
          favoredBranch: str(r['favoredBranch']),
          startingWeapon: str(r['startingWeapon']),
          startingMask: str(r['startingMask']),
          signature: {
            id: str(sig['id']),
            name: str(sig['name'], str(sig['id'])),
            description: str(sig['description']),
            cooldownMs: Math.max(0, num(sig['cooldownMs'])),
          },
        };
      });
      this.masks = readChoices(p['masks'], ['id', 'name']).map((r) => ({
        id: str(r['id']),
        name: str(r['name'], str(r['id'])),
        theme: str(r['theme']),
        perk: str(r['perk']),
        description: str(r['description']),
        price: Math.max(0, Math.floor(num(r['price']))),
        glyph: str(r['glyph']),
      }));
      this.revision++;
      return true;
    }
    if (kind === EV.TALENT_DENIED) {
      this.lastDenial = { nodeId: str(p['nodeId']), reason: str(p['reason'], 'unknown') };
      this.revision++;
      return true;
    }
    if (kind === EV.PROGRESSION) {
      const talents = rec(p['talents']) ?? {};
      const clean: Record<string, number> = {};
      for (const [k, v] of Object.entries(talents)) {
        const r = Math.floor(num(v));
        if (r > 0) clean[k] = Math.min(r, 99);
      }
      this.prog = {
        level: Math.max(1, num(p['level'], 1)),
        xp: Math.max(0, num(p['xp'])),
        xpNeeded: Math.max(1, num(p['xpNeeded'], 100)),
        maxLevel: Math.max(1, num(p['maxLevel'], 60)),
        talentPoints: Math.max(0, Math.floor(num(p['talentPoints']))),
        spentPoints: Math.max(0, Math.floor(num(p['spentPoints']))),
        respecCount: Math.max(0, Math.floor(num(p['respecCount']))),
        talents: clean,
        meleeDamage: num(p['meleeDamage'], 12),
        power: num(p['power']),
        gold: Math.max(0, Math.floor(num(p['gold']))),
        maskId: str(p['maskId']) || null,
        vocation: str(p['vocation']) || null,
      };
      this.revision++;
      return true;
    }
    if (kind === EV.GOLD) {
      this.prog = { ...this.prog, gold: Math.max(0, Math.floor(num(p['gold'], this.prog.gold))) };
      this.revision++;
      return true;
    }
    if (kind === EV.XP_GAIN) {
      this.prog = {
        ...this.prog,
        xp: Math.max(0, num(p['xpLeft'], this.prog.xp)),
        xpNeeded: Math.max(1, num(p['next'], this.prog.xpNeeded)),
        level: Math.max(1, num(p['level'], this.prog.level)),
      };
      this.revision++;
      return true;
    }
    if (kind === EV.LEVELUP) {
      this.prog = { ...this.prog, level: Math.max(1, num(p['level'], this.prog.level)) };
      this.revision++;
      return true;
    }
    return false;
  }

  get state(): ProgressionView {
    return this.prog;
  }

  get talentTree(): TalentNode[] {
    return this.nodes;
  }

  get branchOrder(): string[] {
    return this.branches;
  }

  rank(nodeId: string): number {
    return this.prog.talents[nodeId] ?? 0;
  }

  /** Can the local player afford one more rank of this node right now? */
  canSpend(nodeId: string): boolean {
    const node = this.byId.get(nodeId);
    if (!node) return false;
    if (this.rank(nodeId) >= node.maxRank) return false;
    if (this.prog.talentPoints < node.costPerRank) return false;
    return this.lockedBy(nodeId) === null;
  }

  /** The prerequisite blocking `nodeId`, or null when it is unlocked. */
  lockedBy(nodeId: string): { nodeId: string; rank: number; have: number } | null {
    const node = this.byId.get(nodeId);
    if (!node) return null;
    for (const req of node.requires) {
      const have = this.rank(req.nodeId);
      if (have < req.rank) return { nodeId: req.nodeId, rank: req.rank, have };
    }
    return null;
  }

  /** Nodes of one branch, tier 1..5 in order. */
  branch(branch: string): TalentNode[] {
    return this.nodes.filter((n) => n.branch === branch).sort((a, b) => a.tier - b.tier);
  }

  consumeDenial(): { nodeId: string; reason: string } | null {
    const d = this.lastDenial;
    this.lastDenial = null;
    return d;
  }

  reset(): void {
    this.nodes = [];
    this.byId = new Map();
    this.branches = [];
    this.vocations = [];
    this.masks = [];
    this.lastDenial = null;
    this.revision++;
  }
}

// ---------------------------------------------------------------------------
// vendor
// ---------------------------------------------------------------------------

export type VendorRow = {
  itemId: string;
  name: string;
  kind: string;
  basePrice: number;
  buy: number;
  sell: number;
  index: number;
  /** Count in the local bag, from the `inventory` event. */
  held: number;
  /** Last rejection reason, greyed out until the next successful trade. */
  blocked: string | null;
};

/** Supply/demand index -> trend arrow. */
export function priceArrow(index: number): string {
  if (index > 0.05) return '▲';
  if (index < -0.05) return '▼';
  return '▬';
}

/** Vendor stock + the player's bag counts, refreshed on every trade. */
export class VendorStore {
  private rows: VendorRow[] = [];
  private held = new Map<string, number>();
  private blocked = new Map<string, string>();
  gold = 0;
  revision = 0;
  /** Last completed trade, for a one-shot toast. */
  lastTrade: { side: string; itemId: string; qty: number; total: number } | null = null;

  apply(kind: string, payload: unknown): boolean {
    const p = rec(payload);
    if (!p) return false;
    if (kind === EV.VENDOR_STOCK) {
      const raw = Array.isArray(p['items']) ? (p['items'] as unknown[]) : [];
      const rows: VendorRow[] = [];
      for (const r of raw) {
        const o = rec(r);
        if (!o) continue;
        const itemId = str(o['itemId']);
        if (itemId.length === 0) continue;
        const prev = this.rows.find((x) => x.itemId === itemId);
        rows.push({
          itemId,
          name: str(o['name'], itemId),
          kind: str(o['kind'], 'material'),
          basePrice: Math.max(0, Math.floor(num(o['basePrice']))),
          buy: Math.max(0, Math.floor(num(o['buy']))),
          sell: Math.max(0, Math.floor(num(o['sell']))),
          index: num(o['index']),
          held: this.held.get(itemId) ?? prev?.held ?? 0,
          blocked: this.blocked.get(itemId) ?? null,
        });
      }
      rows.sort((a, b) => a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name));
      this.rows = rows;
      this.revision++;
      return true;
    }
    if (kind === EV.INVENTORY) {
      const raw = Array.isArray(p['slots']) ? (p['slots'] as unknown[]) : [];
      this.held.clear();
      for (const s of raw) {
        const o = rec(s);
        if (!o) continue;
        const itemId = str(o['itemId']);
        if (itemId.length === 0) continue;
        const count = Math.max(0, Math.floor(num(o['count'])));
        this.held.set(itemId, (this.held.get(itemId) ?? 0) + count);
      }
      this.gold = Math.max(0, Math.floor(num(p['gold'], this.gold)));
      this.rows = this.rows.map((r) => ({ ...r, held: this.held.get(r.itemId) ?? 0 }));
      this.revision++;
      return true;
    }
    if (kind === EV.VENDOR_TRADE) {
      const itemId = str(p['itemId']);
      const ok = p['ok'] === true;
      if (ok) {
        this.blocked.delete(itemId);
        this.lastTrade = {
          side: str(p['side'], 'buy'),
          itemId,
          qty: Math.max(1, Math.floor(num(p['qty'], 1))),
          total: Math.max(0, Math.floor(num(p['total']))),
        };
      } else {
        this.blocked.set(itemId, str(p['reason'], 'rejected'));
        this.lastTrade = null;
      }
      this.gold = Math.max(0, Math.floor(num(p['gold'], this.gold)));
      this.rows = this.rows.map((r) => (r.itemId === itemId ? { ...r, blocked: this.blocked.get(itemId) ?? null } : r));
      this.revision++;
      return true;
    }
    if (kind === EV.GOLD) {
      this.gold = Math.max(0, Math.floor(num(p['gold'], this.gold)));
      this.revision++;
      return true;
    }
    return false;
  }

  get stock(): VendorRow[] {
    return this.rows;
  }

  row(itemId: string): VendorRow | undefined {
    return this.rows.find((r) => r.itemId === itemId);
  }

  /** Can the player afford `qty` of this row at the live price? */
  canBuy(row: VendorRow, qty = 1): boolean {
    return row.buy > 0 && row.blocked === null && row.buy * qty <= this.gold;
  }

  canSell(row: VendorRow, qty = 1): boolean {
    return row.sell > 0 && row.blocked === null && row.held >= qty;
  }

  /** Gross proceeds from selling `qty`, 0 when the trade is impossible. */
  proceeds(row: VendorRow, qty = 1): number {
    return this.canSell(row, qty) ? row.sell * qty : 0;
  }

  consumeTrade(): VendorStore['lastTrade'] {
    const t = this.lastTrade;
    this.lastTrade = null;
    return t;
  }

  reset(): void {
    this.rows = [];
    this.held.clear();
    this.blocked.clear();
    this.lastTrade = null;
    this.revision++;
  }
}

// ---------------------------------------------------------------------------
// composite
// ---------------------------------------------------------------------------

/** Every store, driven from one `event` handler. */
export class SystemsView {
  readonly party = new PartyViewStore();
  readonly emotes = new EmoteStore();
  readonly progression = new ProgressionStore();
  readonly vendor = new VendorStore();
  readonly overlay = new AvatarOverlayStore();

  /** True when at least one store consumed the event. */
  apply(kind: string, payload: unknown): boolean {
    const main =
      this.party.apply(kind, payload) ||
      this.emotes.apply(kind, payload) ||
      this.progression.apply(kind, payload) ||
      this.vendor.apply(kind, payload);
    // The overlay syncs from its own kinds plus the progression snapshot
    // (maskId/vocation fields), so it runs even when a main store consumed
    // the frame first.
    return this.overlay.apply(kind, payload) || main;
  }

  reset(): void {
    this.party.reset();
    this.emotes.reset();
    this.progression.reset();
    this.vendor.reset();
    this.overlay.reset();
  }
}
