// @aetherfall/gameplay — integrated: the composition layer for the pure
// systems modules (`server/src/systems/*`). Those modules are fully tested but
// were never wired into the server; this file owns the glue.
//
// Design rules (integration contract):
//
// 1. COMPOSE ALONGSIDE. Nothing in `game/*` is gutted or rewritten. The legacy
//    XP curve (`quests.xpForNextLevel`), the legacy inventory (`inventory.ts`)
//    and the legacy melee curve (`combat.damageFor`) all keep working. This
//    module reads and calls them; it never replaces a file another module owns.
// 2. OWN THE STATE. `GameSession` is the single state holder for progression,
//    parties, invites, wallets, vendor price history and live emotes. It is the
//    only mutable thing here; every systems/* call is pure and returns new state.
// 3. SPEAK PROTOCOL V1. Output is `IntegratedOut[]`:
//      - `{ type:'event', kind, payload, recipients? }` -> `{t:'event',kind,payload}`
//        (`recipients` present = private delivery, absent = broadcast)
//      - `{ type:'chat',  from, text, channel, recipients }` -> `{t:'chat',...}`
//    Both are protocol v1 message shapes. `kind`/`payload` are additive, so the
//    existing client keeps working and simply ignores kinds it does not know.
// 4. FEATURE FLAGGED. `SYSTEMS=1` (default) enables the composed session;
//    `SYSTEMS=0` disables it and the server falls back to the legacy path
//    untouched. See `systemsEnabledFromEnv`.
//
// Wiring summary (see docs/SYSTEMS.md "Integration"):
//
//   XP          progression.addXp + the systems curve; party XP via
//               social.splitPartyXp when the killer is in a party.
//   Talents     talentPointsForLevel on every level-up; `/talent <nodeId>` spends.
//   Stats       progression.aggregateStats -> meleeDamage() -> `bonusDmg` on the
//               legacy Fighter, so hits-to-kill is unchanged with no talents.
//   Party       /invite /accept /party (leave|kick|promote|loot|ready) /p.
//   Emotes      /emote <id> -> social.playEmote, 8 ids, per-emote radius.
//   Chat        `say` becomes 10 m proximity chat (social.nearbyChat).
//   Vendor      /shop /buy /sell against economy's supply/demand pricing, with
//               the legacy inventory as the capacity + ownership gate.

import { BASE_DMG } from './combat.js';
import { maskText } from './chat.js';
import { ITEMS, WEAPONS, itemDef, type ItemDef, type ItemKind, type WeaponDef } from './content.js';
import { noteMaskEquipped, noteSignatureUsed } from './onboarding.js';
import {
  MASKS,
  MASK_TALENT_POINTS,
  THROW_RANGE_BASE,
  extraLootRolls as maskExtraLootRolls,
  finishReach as maskFinishReach,
  hazardDamageTaken as maskHazardTaken,
  isMaskId,
  maskDef,
  maskEquippedEvent,
  maskEquippedItem,
  maskMeleeMult,
  maskMuffles,
  maskUnequippedEvent,
  throwRange as maskThrowRange,
  wallPingDue,
  wallPingIntervalMs,
} from './masks.js';
import {
  addItem,
  canFit,
  countOf,
  createInventory,
  removeItem,
  type Inventory,
} from './inventory.js';

import {
  emptyPriceHistory,
  recordTrade,
  supplyDemandIndex,
  vendorBuy,
  vendorBuyPrice,
  vendorSell,
  vendorSellPrice,
  type PriceHistory,
} from '../systems/economy.js';

import {
  BASE_STATS,
  BRANCHES,
  MAX_LEVEL,
  PER_LEVEL_STATS,
  SKILL_TREE,
  VOCATIONS,
  addXp as addProgressionXp,
  aggregateStats,
  branchRanks,
  createProgression,
  isVocationId,
  learnNode,
  nodesInBranch,
  perLevelFor,
  powerScore,
  respec as respecTalents,
  signatureReady,
  signatureRetryMs,
  skillNode,
  statsForItem,
  talentPointsForLevel,
  talentRankCost,
  vocationDef,
  xpToNextLevel,
  type Branch,
  type EquippedItem,
  type ProgressionState,
  type SignatureEffect,
  type StatBlock,
  type VocationId,
} from '../systems/progression.js';

import {
  CHAT_RADIUS,
  EMOTES,
  PARTY_MAX,
  createParty,
  isLeader,
  joinParty,
  kickParty,
  leaveParty,
  memberOf,
  nearbyChat,
  partyChat,
  playEmote,
  promoteLeader,
  setLootRule,
  setReady,
  splitPartyXp,
  updateMember,
  type ChatAudience,
  type EmoteId,
  type LootRule,
  type Party,
  type PartyMember,
} from '../systems/social.js';

// ---------------------------------------------------------------------------
// Tuning
// ---------------------------------------------------------------------------

/** Env var that gates the whole composed session. */
export const SYSTEMS_ENV = 'SYSTEMS';

/** Identifies this module in diagnostics and cross-module assertions. */
export const GAME_SESSION_MARKER = 'aetherfall/integrated:v1';

/** Gold every player starts with (wallet lives in this module). */
export const START_GOLD = 250;

/** `/buy` and `/sell` quantity ceiling — a spam guard above economy's own checks. */
export const MAX_TRADE_QTY = 999;

/** How long `/invite` stays pending. */
export const INVITE_TTL_MS = 30_000;

/** Per-inviter cooldown so `/invite` cannot be used to flood. */
export const INVITE_COOLDOWN_MS = 2_000;

/** Minimum gap between two accepted chat commands from one player. */
export const CMD_RATE_MS = 250;

/** Party snapshots (HP / level / position) are re-sent at most this often. */
export const PARTY_SYNC_MS = 500;

/** Proximity chat radius, re-exported so the server banner cannot drift. */
export const SAY_RADIUS = CHAT_RADIUS; // 10 m

/**
 * Melee damage floor + per-level slope, mirrored from `combat.damageFor`
 * (`BASE_DMG + (level-1)*3`). The systems curve folds +1 attackPower per level
 * into `aggregateStats`, so we subtract that part again and add the legacy slope
 * back: with no talents and no weapon this is byte-identical to the legacy
 * `damageFor`, which keeps docs/WORLD.md's TTK table valid. Talents and weapons
 * then land on top of it as a strict increase.
 */
export const MELEE_BASE_DMG = BASE_DMG; // 12
export const MELEE_PER_LEVEL_DMG = 3;

// ---------------------------------------------------------------------------
// Feature flag
// ---------------------------------------------------------------------------

const TRUTHY = new Set(['1', 'true', 'yes', 'on', 'enable', 'enabled']);
const FALSY = new Set(['0', 'false', 'no', 'off', 'disable', 'disabled']);

/**
 * Resolve the `SYSTEMS` feature flag.
 *
 * - `SYSTEMS=1|true|yes|on`  -> on
 * - `SYSTEMS=0|false|no|off` -> off
 * - unset / unrecognised    -> `fallback`
 *
 * The default fallback is **on** because `systems/*.test.ts` (154 assertions)
 * and `game/integrated.test.ts` both gate this module. Set `SYSTEMS=0` to run
 * the legacy XP/inventory/chat path verbatim; nothing in `game/*` was removed,
 * so the fallback is complete, not degraded.
 */
export function systemsEnabledFromEnv(
  env: Record<string, string | undefined> = process.env,
  fallback = true,
): boolean {
  const raw = env[SYSTEMS_ENV];
  if (raw === undefined) return fallback;
  const key = String(raw).trim().toLowerCase();
  if (TRUTHY.has(key)) return true;
  if (FALSY.has(key)) return false;
  return fallback;
}

// ---------------------------------------------------------------------------
// Output shapes
// ---------------------------------------------------------------------------

/** Protocol v1 channels (see shared/src/index.ts `ServerMsg`). */
export type ChatChannel = 'global' | 'guild' | 'say';

export type IntegratedOut =
  | {
      type: 'event';
      kind: string;
      payload: Record<string, unknown>;
      /** Present = private delivery to these ids. Absent = broadcast to all. */
      recipients?: number[];
    }
  | { type: 'chat'; from: string; text: string; channel: ChatChannel; recipients: number[] };

export type ChatResult = {
  /** True when the composed session consumed the message (do not fall through). */
  handled: boolean;
  out: IntegratedOut[];
};

function privateEvent(playerId: number, kind: string, payload: Record<string, unknown>): IntegratedOut {
  return { type: 'event', kind, payload, recipients: [playerId] };
}

function reply(playerId: number, text: string): IntegratedOut {
  return privateEvent(playerId, 'sys-msg', { playerId, text });
}

// ---------------------------------------------------------------------------
// Chat command grammar
// ---------------------------------------------------------------------------

export type ChatCommand =
  | { name: 'invite'; target: string }
  | { name: 'accept' }
  | { name: 'decline' }
  | { name: 'party'; sub: 'status' | 'leave' | 'ready' | 'kick' | 'promote' | 'loot'; arg?: string }
  | { name: 'p'; text: string }
  | { name: 'emote'; emote: string }
  | { name: 'buy'; itemId: string; qty: number }
  | { name: 'sell'; itemId: string; qty: number }
  | { name: 'shop' }
  | { name: 'equip'; itemId: string }
  | { name: 'unequip'; itemId: string }
  | { name: 'talents' }
  | { name: 'talent'; nodeId: string }
  | { name: 'respec' }
  | { name: 'stats' }
  | { name: 'mask'; sub: 'list' | 'equip' | 'unequip'; arg?: string }
  | { name: 'vocation'; arg?: string }
  | { name: 'sig' }
  | { name: 'help' }
  | { name: 'unknown'; raw: string };

const ALIASES: Record<string, string> = {
  inv: 'invite',
  join: 'accept',
  agree: 'accept',
  leave: 'leave',
  quit: 'leave',
  kick: 'kick',
  promote: 'promote',
  loot: 'loot',
  p: 'p',
  partychat: 'p',
  pc: 'p',
  em: 'emote',
  emotes: 'emote',
  vendor: 'shop',
  store: 'shop',
  equip: 'equip',
  unequip: 'unequip',
  tree: 'talents',
  talent: 'talent',
  spend: 'talent',
  respec: 'respec',
  retrain: 'respec',
  stat: 'stats',
  stats: 'stats',
  mask: 'mask',
  masks: 'mask',
  vocation: 'vocation',
  voc: 'vocation',
  calling: 'vocation',
  sig: 'sig',
  signature: 'sig',
  help: 'help',
  '?': 'help',
  commands: 'help',
};

/** `/help` body — the single source of truth for docs/SYSTEMS.md. */
export const COMMAND_REFERENCE: string[] = [
  '/invite <name> — invite to your party (creates one if needed)',
  '/accept — accept the newest invite   ·   /decline — drop it',
  '/party — party status (members, HP, loot rule)',
  '/party leave · /party kick <name> · /party promote <name> · /party ready',
  '/party loot <ffa|leader|master> — leader only',
  '/p <text> — party chat',
  '/emote <wave|cheer|bow|laugh|cry|sit|point|dance> — 8 emotes',
  '/shop — vendor stock with live prices',
  '/buy <itemId> [qty] · /sell <itemId> [qty]',
  '/equip <itemId> · /unequip <itemId> — weapon damage feeds melee',
  '/talents — the 3x5 tree · /talent <nodeId> — spend 1 point',
  '/respec — wipe talents, refunds every point (gold)',
  '/stats — aggregated stat block',
  '/mask — list the 8 masks · /mask equip <id> · /mask unequip (one slot)',
  '/vocation — list the callings · /vocation <id> (starting kit + favored branch 20% off)',
  '/sig — unleash your signature (12s cooldown; skill slot 1 also fires it)',
  '/help — this list',
];

/** Parse a quantity token. Anything not a positive integer becomes 0 (rejected). */
function parseQty(token: string | undefined): number {
  if (token === undefined) return 1;
  if (!/^\d{1,6}$/.test(token)) return 0;
  const n = Number(token);
  if (!Number.isInteger(n) || n < 1 || n > MAX_TRADE_QTY) return 0;
  return n;
}

/**
 * Parse one chat line into a command. Returns `null` for plain chat (no leading
 * slash) and a `{name:'unknown'}` command for an unrecognised slash word, so
 * the caller can answer "unknown command" instead of silently swallowing it.
 */
export function parseChatCommand(raw: string): ChatCommand | null {
  const text = raw.trim();
  if (!text.startsWith('/')) return null;
  const parts = text.slice(1).split(/\s+/);
  const head = (parts[0] ?? '').toLowerCase();
  const args = parts.slice(1).filter((s) => s.length > 0);
  // A bare "/" has no command word at all — plain text, not a bad command.
  if (head.length === 0) return null;
  const name = ALIASES[head] ?? head;

  switch (name) {
    case 'invite':
      return args.length === 0 ? { name: 'unknown', raw: text } : { name: 'invite', target: args.join(' ') };
    case 'accept':
      return { name: 'accept' };
    case 'decline':
      return { name: 'decline' };
    case 'party': {
      // Bare `/party` is a status query; `/party <sub> [arg]` is an action.
      const sub = args.length === 0 ? 'status' : (ALIASES[args[0]!.toLowerCase()] ?? args[0]!.toLowerCase());
      const rest = args.slice(1).join(' ');
      switch (sub) {
        case 'status':
          return { name: 'party', sub: 'status' };
        case 'leave':
          return { name: 'party', sub: 'leave' };
        case 'ready':
          return { name: 'party', sub: 'ready' };
        case 'kick':
          return rest ? { name: 'party', sub: 'kick', arg: rest } : { name: 'unknown', raw: text };
        case 'promote':
          return rest ? { name: 'party', sub: 'promote', arg: rest } : { name: 'unknown', raw: text };
        case 'loot':
          return rest ? { name: 'party', sub: 'loot', arg: rest } : { name: 'unknown', raw: text };
        default:
          return { name: 'unknown', raw: text };
      }
    }
    case 'p':
      return args.length === 0 ? { name: 'unknown', raw: text } : { name: 'p', text: args.join(' ') };
    case 'emote':
      return args.length === 0 ? { name: 'unknown', raw: text } : { name: 'emote', emote: args[0]!.toLowerCase() };
    case 'buy':
      return args.length === 0 ? { name: 'unknown', raw: text } : { name: 'buy', itemId: args[0]!, qty: parseQty(args[1]) };
    case 'sell':
      return args.length === 0 ? { name: 'unknown', raw: text } : { name: 'sell', itemId: args[0]!, qty: parseQty(args[1]) };
    case 'shop':
      return { name: 'shop' };
    case 'equip':
      return args.length === 0 ? { name: 'unknown', raw: text } : { name: 'equip', itemId: args[0]! };
    case 'unequip':
      return args.length === 0 ? { name: 'unknown', raw: text } : { name: 'unequip', itemId: args[0]! };
    case 'talents':
      return { name: 'talents' };
    case 'talent':
      return args.length === 0 ? { name: 'unknown', raw: text } : { name: 'talent', nodeId: args[0]!.toLowerCase() };
    case 'respec':
      return { name: 'respec' };
    case 'stats':
      return { name: 'stats' };
    case 'mask': {
      // Bare `/mask` lists; `/mask equip <id>` wears, `/mask unequip` doffs.
      const sub = args.length === 0 ? 'list' : args[0]!.toLowerCase();
      if (sub === 'list' && args.length === 0) return { name: 'mask', sub: 'list' };
      if (sub === 'equip') return args[1] ? { name: 'mask', sub: 'equip', arg: args[1] } : { name: 'unknown', raw: text };
      if (sub === 'unequip') return { name: 'mask', sub: 'unequip' };
      return { name: 'unknown', raw: text };
    }
    case 'vocation':
      // Bare `/vocation` lists the four callings; `/vocation <id>` takes one up.
      return args.length === 0 ? { name: 'vocation' } : { name: 'vocation', arg: args[0]!.toLowerCase() };
    case 'sig':
      return { name: 'sig' };
    case 'help':
      return { name: 'help' };
    // Party subcommands also work as top-level verbs (`/leave`, `/kick Ash`).
    case 'leave':
      return { name: 'party', sub: 'leave' };
    case 'kick':
      return args.length === 0 ? { name: 'unknown', raw: text } : { name: 'party', sub: 'kick', arg: args.join(' ') };
    case 'promote':
      return args.length === 0 ? { name: 'unknown', raw: text } : { name: 'party', sub: 'promote', arg: args.join(' ') };
    case 'loot':
      return args.length === 0 ? { name: 'unknown', raw: text } : { name: 'party', sub: 'loot', arg: args.join(' ') };
    default:
      return { name: 'unknown', raw: text };
  }
}

// ---------------------------------------------------------------------------
// Session types
// ---------------------------------------------------------------------------

/** Minimal authoritative view of a player that the session needs. */
export type SessionPlayer = {
  id: number;
  name: string;
  x: number;
  y: number;
  hp: number;
  maxHp: number;
};

export type ActiveEmote = {
  seq: number;
  fromId: number;
  name: string;
  emote: EmoteId;
  x: number;
  y: number;
  radius: number;
  expiresAt: number;
};

export type Invite = {
  fromId: number;
  fromName: string;
  partyId: number;
  expiresAt: number;
};

export type VendorRow = {
  itemId: string;
  name: string;
  kind: ItemKind;
  basePrice: number;
  /** What the player pays per unit right now (dynamic + 15% spread). */
  buy: number;
  /** What the vendor pays per unit right now (dynamic - 35% spread). 0 = unsellable. */
  sell: number;
  /** Supply/demand index in [-1, 1], for the client's trend arrow. */
  index: number;
};

export type TalentNodeView = {
  id: string;
  branch: Branch;
  tier: number;
  name: string;
  description: string;
  maxRank: number;
  costPerRank: number;
  requires: { nodeId: string; rank: number }[];
};

export type GameSessionOptions = {
  /** Feature flag result (see `systemsEnabledFromEnv`). */
  enabled?: boolean;
  /** Starting wallet. Defaults to START_GOLD. */
  startGold?: number;
  /** Invite time-to-live. Defaults to INVITE_TTL_MS. */
  inviteTtlMs?: number;
};

function defPrice(id: string): number {
  const def = itemDef(id);
  return def ? def.price : 0;
}

function defKind(id: string): ItemKind {
  const def = itemDef(id);
  return def ? def.kind : 'material';
}

function defLabel(id: string): string {
  const def: ItemDef | undefined = itemDef(id);
  return def ? def.name : id;
}

// ---------------------------------------------------------------------------
// GameSession
// ---------------------------------------------------------------------------

/**
 * The composed systems state holder + per-tick pipeline.
 *
 * One instance per shard. Pure-systems calls are threaded through here: state
 * in, new state adopted, events returned as protocol v1 `IntegratedOut`.
 */
export class GameSession {
  readonly enabled: boolean;
  private readonly startGold: number;
  private readonly inviteTtlMs: number;

  private readonly players = new Map<number, SessionPlayer>();
  private readonly prog = new Map<number, ProgressionState>();
  private readonly wallets = new Map<number, number>();
  private readonly inv = new Map<number, Inventory>();
  private readonly loadout = new Map<number, EquippedItem[]>();
  /** The single worn mask per player (mask id; exactly one slot). */
  private readonly masks = new Map<number, string>();
  /** Unspent talent-boon points granted by the worn mask. */
  private readonly maskBonus = new Map<number, number>();
  /** Players who already consumed their boon grant (anti-farm latch). */
  private readonly boonUsed = new Set<number>();
  /** Chosen vocation per player (in-memory only, never persisted). */
  private readonly vocations = new Map<number, VocationId>();
  /** Players already handed a vocation starting kit (kits grant once). */
  private readonly kitGranted = new Set<number>();
  /** Last signature timestamp per player (12s cooldown). */
  private readonly sigAt = new Map<number, number>();
  /** Last wall-ping timestamp per player (1/s cadence). */
  private readonly pingAt = new Map<number, number>();
  private readonly partyOf = new Map<number, Party>();
  private readonly invites = new Map<number, Invite>();
  private readonly inviteAt = new Map<number, number>();
  private readonly cmdAt = new Map<number, number>();
  private readonly sayAt = new Map<number, number>();
  private readonly statsCache = new Map<number, StatBlock>();

  private prices: PriceHistory = emptyPriceHistory();
  private emotes: ActiveEmote[] = [];
  private nextPartyId = 1;
  private nextEmoteSeq = 1;
  private lastPartySync = -Infinity;

  constructor(opts: GameSessionOptions = {}) {
    this.enabled = opts.enabled ?? systemsEnabledFromEnv();
    this.startGold = opts.startGold ?? START_GOLD;
    this.inviteTtlMs = opts.inviteTtlMs ?? INVITE_TTL_MS;
  }

  // ---------------------------------------------------------------- lifecycle

  has(playerId: number): boolean {
    return this.players.has(playerId);
  }

  size(): number {
    return this.players.size;
  }

  player(playerId: number): SessionPlayer | undefined {
    return this.players.get(playerId);
  }

  /**
   * Register a player. Idempotent. Returns the bootstrap payload the client
   * needs on join: progression (+ talent tree), wallet, inventory, vendor stock.
   */
  addPlayer(playerId: number, name: string, x = 0, y = 0): IntegratedOut[] {
    if (!this.enabled) return [];
    const safeName = name.slice(0, 16) || `player-${playerId}`;
    const existing = this.players.get(playerId);
    if (existing) {
      existing.name = safeName;
      existing.x = x;
      existing.y = y;
      return [];
    }
    this.players.set(playerId, { id: playerId, name: safeName, x, y, hp: 100, maxHp: 100 });
    this.prog.set(playerId, createProgression(1));
    this.wallets.set(playerId, this.startGold);
    this.inv.set(playerId, createInventory());
    this.loadout.set(playerId, []);
    return [
      privateEvent(playerId, 'progression', this.progressionPayload(playerId)),
      privateEvent(playerId, 'talent-tree', this.treePayload()),
      privateEvent(playerId, 'gold', this.walletPayload(playerId)),
      privateEvent(playerId, 'inventory', this.inventoryPayload(playerId)),
      privateEvent(playerId, 'vendor-stock', { items: this.vendorStock(Date.now()) }),
      privateEvent(playerId, 'party', this.partyPayload(undefined)),
    ];
  }

  /** Drop a player: leaves any party, cancels both invite directions. */
  removePlayer(playerId: number): IntegratedOut[] {
    const out: IntegratedOut[] = [];
    const party = this.partyOf.get(playerId);
    if (party) out.push(...this.doLeaveParty(playerId, 'disconnected'));
    // Drop the invites they sent (target keeps no stale pointer) and received.
    for (const [targetId, invite] of [...this.invites]) {
      if (invite.fromId === playerId) this.invites.delete(targetId);
      else if (targetId === playerId) this.invites.delete(playerId);
    }
    this.players.delete(playerId);
    this.prog.delete(playerId);
    this.wallets.delete(playerId);
    this.inv.delete(playerId);
    this.loadout.delete(playerId);
    this.masks.delete(playerId);
    this.maskBonus.delete(playerId);
    this.boonUsed.delete(playerId);
    this.vocations.delete(playerId);
    this.kitGranted.delete(playerId);
    this.sigAt.delete(playerId);
    this.pingAt.delete(playerId);
    this.statsCache.delete(playerId);
    this.inviteAt.delete(playerId);
    this.cmdAt.delete(playerId);
    this.sayAt.delete(playerId);
    this.emotes = this.emotes.filter((e) => e.fromId !== playerId);
    return out;
  }

  // ------------------------------------------------------------------ queries

  gold(playerId: number): number {
    return this.wallets.get(playerId) ?? 0;
  }

  inventory(playerId: number): Inventory {
    let inv = this.inv.get(playerId);
    if (!inv) {
      inv = createInventory();
      this.inv.set(playerId, inv);
    }
    return inv;
  }

  progression(playerId: number): ProgressionState | undefined {
    return this.prog.get(playerId);
  }

  level(playerId: number): number {
    return this.prog.get(playerId)?.level ?? 1;
  }

  talentPoints(playerId: number): number {
    return (this.prog.get(playerId)?.talentPoints ?? 0) + (this.maskBonus.get(playerId) ?? 0);
  }

  /** The worn mask id, or null when bare-faced. */
  activeMask(playerId: number): string | null {
    return this.masks.get(playerId) ?? null;
  }

  /** The chosen vocation id, or null when unsworn. */
  vocation(playerId: number): VocationId | null {
    return this.vocations.get(playerId) ?? null;
  }

  /** Extra loot rolls from the worn mask (tithe scale). */
  extraLootRolls(playerId: number): number {
    return maskExtraLootRolls(this.activeMask(playerId));
  }

  /** Extra finish reach from the worn mask (gallow-beak). */
  finishBonus(playerId: number): number {
    return maskFinishReach(0, this.activeMask(playerId));
  }

  /** Throw reach with the worn mask applied (choir horn: +4u). */
  throwReach(playerId: number): number {
    return maskThrowRange(THROW_RANGE_BASE, this.activeMask(playerId));
  }

  /** True while footsteps emit no noise events (dusk maw). */
  muffles(playerId: number): boolean {
    return maskMuffles(this.activeMask(playerId));
  }

  /** Hazard damage taken with the worn mask applied (cinder hide). */
  hazardTaken(playerId: number, base: number): number {
    return maskHazardTaken(base, this.activeMask(playerId));
  }

  party(playerId: number): Party | undefined {
    return this.partyOf.get(playerId);
  }

  partyMembers(playerId: number): number[] {
    const party = this.partyOf.get(playerId);
    return party ? party.members.map((m) => m.playerId) : [];
  }

  /** Live emotes (bubbles still within their TTL). */
  activeEmotes(): ActiveEmote[] {
    return this.emotes.map((e) => ({ ...e }));
  }

  priceHistory(): PriceHistory {
    return { ...this.prices };
  }

  /** Everyone within the `say`/emote radius of the session's player view. */
  audience(): ChatAudience[] {
    const out: ChatAudience[] = [];
    for (const p of this.players.values()) out.push({ id: p.id, pos: { x: p.x, y: p.y }, name: p.name });
    return out;
  }

  /**
   * Aggregated stat block for a player: `base + perLevel + talents + items`.
   * The worn mask rides along as an `EquippedItem` and the vocation swaps the
   * per-level curve — with neither, this is byte-identical to the legacy call.
   * Memoised; invalidated whenever level, talents or the loadout change.
   */
  stats(playerId: number): StatBlock {
    const cached = this.statsCache.get(playerId);
    if (cached) return cached;
    const st = this.prog.get(playerId);
    const items = [...(this.loadout.get(playerId) ?? [])];
    const mask = this.masks.get(playerId);
    if (mask) items.push(maskEquippedItem(mask));
    const computed = aggregateStats(
      st ? st.level : 1,
      st ? st.talents : {},
      items,
      BASE_STATS,
      perLevelFor(this.vocations.get(playerId) ?? null),
    );
    this.statsCache.set(playerId, computed);
    return computed;
  }

  /**
   * Melee damage = legacy `combat.damageFor(level)` curve + the attackPower that
   * talents and equipped weapons contribute, times the worn mask's multiplier
   * (seraph shard: x1.15). Identical to the legacy number when nothing is
   * spent and no mask is worn; strictly greater once a build invests.
   */
  meleeDamage(playerId: number): number {
    const st = this.prog.get(playerId);
    const level = st ? st.level : 1;
    const stats = this.stats(playerId);
    const perLevelPart = PER_LEVEL_STATS.attackPower * Math.max(0, level - 1);
    const buildBonus = Math.max(0, stats.attackPower - perLevelPart);
    const base = MELEE_BASE_DMG + (level - 1) * MELEE_PER_LEVEL_DMG + buildBonus;
    return Math.round(base * maskMeleeMult(this.activeMask(playerId)));
  }

  /** Vendor quotes for the whole catalogue (items + weapons + masks). */
  vendorStock(now: number): VendorRow[] {
    const ids = [...ITEMS.map((i) => i.id), ...WEAPONS.map((w) => w.id), ...MASKS.map((m) => m.id)];
    return ids.map((itemId) => {
      const base = defPrice(itemId);
      return {
        itemId,
        name: defLabel(itemId),
        kind: defKind(itemId),
        basePrice: base,
        buy: vendorBuyPrice(base, this.prices, itemId, now),
        sell: base > 0 ? vendorSellPrice(base, this.prices, itemId, now) : 0,
        index: Math.round(supplyDemandIndex(this.prices, itemId, now) * 100) / 100,
      };
    });
  }

  // ---------------------------------------------------------------- payloads

  private progressionPayload(playerId: number): Record<string, unknown> {
    const st = this.prog.get(playerId) ?? createProgression(1);
    const stats = this.stats(playerId);
    return {
      playerId,
      level: st.level,
      xp: st.xp,
      xpNeeded: xpToNextLevel(st.level),
      maxLevel: MAX_LEVEL,
      talentPoints: st.talentPoints,
      spentPoints: st.spentPoints,
      respecCount: st.respecCount,
      talents: { ...st.talents },
      stats,
      power: powerScore(stats),
      meleeDamage: this.meleeDamage(playerId),
      gold: this.gold(playerId),
      // Masks + vocations ride the same snapshot (additive; older clients ignore).
      maskId: this.activeMask(playerId),
      maskBonus: this.maskBonus.get(playerId) ?? 0,
      vocation: this.vocation(playerId),
    };
  }

  private treePayload(): Record<string, unknown> {
    return {
      branches: [...BRANCHES],
      nodes: SKILL_TREE.map<TalentNodeView>((n) => ({
        id: n.id,
        branch: n.branch,
        tier: n.tier,
        name: n.name,
        description: n.description,
        maxRank: n.maxRank,
        costPerRank: n.costPerRank,
        requires: n.requires.map((r) => ({ ...r })),
      })),
      // Choice catalogs for the mask + vocation pickers (additive).
      vocations: VOCATIONS.map((v) => ({
        id: v.id,
        name: v.name,
        role: v.role,
        description: v.description,
        favoredBranch: v.favoredBranch,
        startingWeapon: v.startingWeapon,
        startingMask: v.startingMask,
        signature: { id: v.signature.id, name: v.signature.name, description: v.signature.description, cooldownMs: v.signature.cooldownMs },
      })),
      masks: MASKS.map((m) => ({
        id: m.id,
        name: m.name,
        theme: m.theme,
        perk: m.perk,
        description: m.description,
        price: m.price,
        glyph: m.glyph,
      })),
    };
  }

  private walletPayload(playerId: number): Record<string, unknown> {
    return { playerId, gold: this.gold(playerId) };
  }

  private inventoryPayload(playerId: number): Record<string, unknown> {
    const inv = this.inventory(playerId);
    return {
      playerId,
      gold: this.gold(playerId),
      equipped: (this.loadout.get(playerId) ?? []).map((e) => e.itemId),
      slots: inv.slots.map((s, i) => (s ? { slot: i, itemId: s.itemId, count: s.count } : { slot: i, itemId: null, count: 0 })),
    };
  }

  /** Full party snapshot; `undefined` means "you are not in a party". */
  private partyPayload(playerId: number | undefined): Record<string, unknown> {
    const party = playerId === undefined ? undefined : this.partyOf.get(playerId);
    if (!party) return { playerId: playerId ?? null, partyId: null, inParty: false, members: [] };
    return {
      playerId,
      partyId: party.id,
      inParty: true,
      leaderId: party.leaderId,
      lootRule: party.lootRule,
      memberCount: party.members.length,
      maxMembers: PARTY_MAX,
      members: party.members.map((m) => this.memberPayload(party, m)),
    };
  }

  private memberPayload(party: Party, m: PartyMember): Record<string, unknown> {
    const view = this.players.get(m.playerId);
    return {
      playerId: m.playerId,
      name: m.name,
      level: m.level,
      hp: Math.max(0, Math.round(view ? view.hp : 0)),
      maxHp: Math.max(1, Math.round(view ? view.maxHp : 1)),
      dead: m.dead,
      ready: m.ready,
      leader: party.leaderId === m.playerId,
      x: view ? view.x : m.pos.x,
      y: view ? view.y : m.pos.y,
      online: view !== undefined,
    };
  }

  // ------------------------------------------------------------------- party

  /** The party's PartyMember view of a session player. */
  private memberView(playerId: number): PartyMember | null {
    const view = this.players.get(playerId);
    if (!view) return null;
    return {
      playerId,
      name: view.name,
      level: this.level(playerId),
      pos: { x: view.x, y: view.y },
      dead: view.hp <= 0,
      ready: false,
    };
  }

  /** Rebind every member to the (possibly new) party object. */
  private bindParty(party: Party | null, unbind: number[] = []): void {
    for (const id of unbind) this.partyOf.delete(id);
    if (!party) return;
    for (const m of party.members) this.partyOf.set(m.playerId, party);
  }

  /**
   * Refresh one party member's level / position / alive flag from the session
   * view. `updateMember` returns a NEW party, so the caller must re-read
   * `partyOf` after every call — holding a stale reference silently drops the
   * change. That is why this returns the live party rather than void.
   */
  private refreshMember(playerId: number): Party | undefined {
    const party = this.partyOf.get(playerId);
    const view = this.players.get(playerId);
    if (!party || !view) return party;
    const member = memberOf(party, playerId);
    const level = this.level(playerId);
    const dead = view.hp <= 0;
    if (member && member.level === level && member.dead === dead && member.pos.x === view.x && member.pos.y === view.y) {
      return party;
    }
    const res = updateMember(party, playerId, { level, pos: { x: view.x, y: view.y }, dead });
    if (!res.ok) return party;
    this.bindParty(res.party);
    return res.party;
  }

  /**
   * Refresh every member of the party `playerId` belongs to. Iterates by id (not
   * by party reference) so each re-read sees the previous member's new party.
   */
  private refreshPartyOf(playerId: number): void {
    for (const id of this.partyMembers(playerId)) this.refreshMember(id);
  }

  /** Fan the current party snapshot out to all its members. */
  private broadcastParty(party: Party | null, extra: number[] = []): IntegratedOut[] {
    const ids = party ? party.members.map((m) => m.playerId) : [];
    return [...ids, ...extra]
      .filter((id, i, arr) => arr.indexOf(id) === i)
      .map((id) => privateEvent(id, 'party', this.partyPayload(id)));
  }

  /** Find the party for a player, creating a one-man party on demand. */
  private ensureParty(playerId: number): Party {
    const existing = this.partyOf.get(playerId);
    if (existing) return existing;
    const leader = this.memberView(playerId);
    if (!leader) throw new Error('integrated: ensureParty for unknown player ' + playerId);
    const party = createParty(leader, Date.now(), this.nextPartyId++);
    this.bindParty(party);
    return party;
  }

  findPlayerByName(name: string): SessionPlayer | undefined {
    const key = name.trim().toLowerCase();
    if (key.length === 0) return undefined;
    for (const p of this.players.values()) {
      if (p.name.toLowerCase() === key) return p;
    }
    for (const p of this.players.values()) {
      if (p.name.toLowerCase().startsWith(key)) return p;
    }
    return undefined;
  }

  private memberByName(party: Party, name: string): PartyMember | undefined {
    const key = name.trim().toLowerCase();
    return party.members.find((m) => m.name.toLowerCase() === key);
  }

  invite(playerId: number, targetName: string, now: number): IntegratedOut[] {
    if (!this.players.has(playerId)) return [];
    const out: IntegratedOut[] = [];
    const prev = this.inviteAt.get(playerId);
    if (prev !== undefined && now - prev < INVITE_COOLDOWN_MS) {
      return [reply(playerId, `Slow down — one invite every ${INVITE_COOLDOWN_MS / 1000}s.`)];
    }
    const target = this.findPlayerByName(targetName);
    if (!target) return [reply(playerId, `No player named "${targetName}".`)];
    if (target.id === playerId) return [reply(playerId, 'You cannot invite yourself.')];
    if (this.partyOf.has(target.id)) return [reply(playerId, `${target.name} is already in a party.`)];
    const party = this.ensureParty(playerId);
    if (party.members.length >= PARTY_MAX) {
      return [reply(playerId, `Your party is full (${PARTY_MAX}/${PARTY_MAX}).`)];
    }
    this.inviteAt.set(playerId, now);
    const invite: Invite = {
      fromId: playerId,
      fromName: this.players.get(playerId)!.name,
      partyId: party.id,
      expiresAt: now + this.inviteTtlMs,
    };
    this.invites.set(target.id, invite);
    out.push(
      privateEvent(target.id, 'party-invite', {
        fromId: playerId,
        fromName: invite.fromName,
        partyId: party.id,
        expiresAt: invite.expiresAt,
      }),
    );
    out.push(reply(playerId, `Invited ${target.name} (expires in ${Math.round(this.inviteTtlMs / 1000)}s).`));
    out.push(...this.broadcastParty(party));
    return out;
  }

  acceptInvite(playerId: number, now: number): IntegratedOut[] {
    const invite = this.invites.get(playerId);
    this.invites.delete(playerId);
    if (!invite) return [reply(playerId, 'No pending invite.')];
    if (invite.expiresAt <= now) return [reply(playerId, 'That invite expired.')];
    const party = this.partyOf.get(invite.fromId);
    if (!party) return [reply(playerId, `${invite.fromName} is no longer in a party.`)];
    const member = this.memberView(playerId);
    if (!member) return [reply(playerId, 'You are not in the world yet.')];
    if (party.leaderId !== invite.fromId) {
      return [reply(playerId, 'Only the party leader may add members.')];
    }
    const res = joinParty(party, invite.fromId, member);
    if (!res.ok) return [reply(playerId, `Cannot join: ${res.reason}.`)];
    this.bindParty(res.party);
    const out: IntegratedOut[] = [
      privateEvent(playerId, 'party', this.partyPayload(playerId)),
      reply(playerId, `Joined ${invite.fromName}'s party.`),
    ];
    for (const id of res.party.members.map((m) => m.playerId)) {
      if (id === playerId) continue;
      out.push(reply(id, `${member.name} joined the party.`));
      out.push(privateEvent(id, 'party', this.partyPayload(id)));
    }
    return out;
  }

  declineInvite(playerId: number): IntegratedOut[] {
    const invite = this.invites.get(playerId);
    this.invites.delete(playerId);
    if (!invite) return [reply(playerId, 'No pending invite.')];
    return [
      reply(playerId, `Declined ${invite.fromName}'s invite.`),
      reply(invite.fromId, `${this.players.get(playerId)?.name ?? 'Someone'} declined your invite.`),
    ];
  }

  /** Leave a party; leadership passes to the lowest remaining id. */
  private doLeaveParty(playerId: number, reason: string): IntegratedOut[] {
    const party = this.partyOf.get(playerId);
    if (!party) return [];
    const res = leaveParty(party, playerId, reason);
    if (!res.ok) return [reply(playerId, `Cannot leave: ${res.reason}.`)];
    const out: IntegratedOut[] = [reply(playerId, 'You left the party.')];
    if (res.value.disbanded) {
      this.bindParty(null, party.members.map((m) => m.playerId));
      for (const id of party.members.map((m) => m.playerId)) {
        if (id === playerId) continue;
        out.push(reply(id, 'The party has disbanded.'));
        out.push(privateEvent(id, 'party', this.partyPayload(undefined)));
      }
      return out;
    }
    this.bindParty(res.party, [playerId]);
    out.push(...this.broadcastParty(res.party));
    return out;
  }

  leavePartyCmd(playerId: number): IntegratedOut[] {
    if (!this.partyOf.has(playerId)) return [reply(playerId, 'You are not in a party.')];
    return this.doLeaveParty(playerId, 'left');
  }

  partyCommand(playerId: number, sub: 'status' | 'leave' | 'ready' | 'kick' | 'promote' | 'loot', arg?: string): IntegratedOut[] {
    const party = this.partyOf.get(playerId);
    if (sub === 'leave') return this.leavePartyCmd(playerId);
    if (!party) return [reply(playerId, 'You are not in a party. Use /invite <name> to start one.')];
    const me = memberOf(party, playerId);

    switch (sub) {
      case 'status': {
        const lines = party.members.map((m) => {
          const r = this.memberPayload(party, m);
          const lead = r.leader === true ? '★' : '·';
          const dead = r.dead === true ? ' ☠' : '';
          return `${lead} ${String(r.name)} Lv${String(r.level)} ${String(r.hp)}/${String(r.maxHp)}HP${dead}`;
        });
        return [
          reply(playerId, `Party #${party.id} — ${party.members.length}/${PARTY_MAX}, loot ${party.lootRule}`),
          ...lines.map((l) => reply(playerId, l)),
        ];
      }
      case 'ready': {
        const res = setReady(party, playerId, !(me?.ready ?? false));
        if (!res.ok) return [reply(playerId, `Cannot toggle readiness: ${res.reason}.`)];
        this.bindParty(res.party);
        return [reply(playerId, res.value.ready ? 'Ready for loot.' : 'Not ready.'), ...this.broadcastParty(res.party)];
      }
      case 'kick': {
        const target = arg ? this.memberByName(party, arg) : undefined;
        if (!target) return [reply(playerId, `No party member named "${arg ?? ''}".`)];
        const res = kickParty(party, playerId, target.playerId);
        if (!res.ok) return [reply(playerId, `Cannot kick: ${res.reason}.`)];
        this.bindParty(res.party, [target.playerId]);
        return [
          reply(playerId, `Kicked ${target.name}.`),
          privateEvent(target.playerId, 'party', this.partyPayload(undefined)),
          reply(target.playerId, 'You were removed from the party.'),
          ...this.broadcastParty(res.party),
        ];
      }
      case 'promote': {
        const target = arg ? this.memberByName(party, arg) : undefined;
        if (!target) return [reply(playerId, `No party member named "${arg ?? ''}".`)];
        const res = promoteLeader(party, playerId, target.playerId);
        if (!res.ok) return [reply(playerId, `Cannot promote: ${res.reason}.`)];
        this.bindParty(res.party);
        return [
          reply(playerId, `${target.name} is now the party leader.`),
          reply(target.playerId, 'You are now the party leader.'),
          ...this.broadcastParty(res.party),
        ];
      }
      case 'loot': {
        const res = setLootRule(party, playerId, arg ?? '');
        if (!res.ok) return [reply(playerId, `Cannot set loot rule: ${res.reason}.`)];
        this.bindParty(res.party);
        return [reply(playerId, `Loot rule set to ${res.value.lootRule}.`), ...this.broadcastParty(res.party)];
      }
      default:
        return [reply(playerId, 'Unknown /party subcommand.')];
    }
  }

  partyChatCmd(playerId: number, text: string): IntegratedOut[] {
    const party = this.partyOf.get(playerId);
    if (!party) return [reply(playerId, 'You are not in a party.')];
    const res = partyChat(party, playerId, maskText(text));
    if (!res.ok) return [reply(playerId, `Party chat rejected: ${res.reason}.`)];
    const ev = res.events[0];
    if (ev.type !== 'party-chat') return [];
    const view = this.players.get(playerId);
    const out: IntegratedOut[] = ev.recipients
      .filter((id) => id !== playerId)
      .map((id) => ({ type: 'chat' as const, from: `[party] ${view?.name ?? ''}`, text: ev.text, channel: 'say' as const, recipients: [id] }));
    out.push(reply(playerId, `[party] you: ${ev.text}`));
    return out;
  }

  // ------------------------------------------------------------------ emotes

  emote(playerId: number, emoteId: string, now: number): IntegratedOut[] {
    const view = this.players.get(playerId);
    if (!view) return [];
    const res = playEmote({ id: playerId, pos: { x: view.x, y: view.y }, name: view.name }, emoteId, this.audience(), now);
    if (!res.ok) {
      const text = res.reason === 'unknown-emote' ? `Unknown emote "${emoteId}".` : 'Nobody is close enough to see that.';
      return [reply(playerId, text)];
    }
    const ev = res.events[0];
    if (ev.type !== 'emote') return [];
    const active: ActiveEmote = {
      seq: this.nextEmoteSeq++,
      fromId: ev.fromId,
      name: ev.name,
      emote: ev.emote,
      x: ev.pos.x,
      y: ev.pos.y,
      radius: ev.radius,
      expiresAt: ev.expiresAt,
    };
    // Replace this player's previous bubble so spamming does not stack them.
    this.emotes = this.emotes.filter((e) => e.fromId !== playerId);
    this.emotes.push(active);
    const label = EMOTES.find((e) => e.id === ev.emote)?.label ?? ev.emote;
    return [{ type: 'event', kind: 'emote', payload: { ...active, label }, recipients: ev.recipients }];
  }

  // --------------------------------------------------------------------- xp

  /**
   * Grant XP. With a party the award is split through `splitPartyXp`, which is
   * exact: the integer remainder is distributed so `sum(awards) === amount`.
   * Every recipient goes through the systems curve and gets talent points on
   * level-up.
   */
  awardXp(playerId: number, amount: number, now: number): IntegratedOut[] {
    const view = this.players.get(playerId);
    if (!view || amount <= 0) return [];
    const total = Math.floor(amount);
    const out: IntegratedOut[] = [];
    const killer = { playerId, pos: { x: view.x, y: view.y }, level: this.level(playerId) };
    // Refresh rows first: `splitPartyXp` filters on the member levels and the
    // dead flag, so a stale party object would hand out XP nobody qualifies for.
    if (this.partyOf.has(playerId)) this.refreshPartyOf(playerId);
    const party = this.partyOf.get(playerId);
    const awards = party ? splitPartyXp(party, total, killer) : [{ playerId, xp: total }];

    for (const award of awards) {
      const st = this.prog.get(award.playerId);
      if (!st || award.xp <= 0) continue;
      const res = addProgressionXp(st, award.xp);
      this.prog.set(award.playerId, res.state);
      this.statsCache.delete(award.playerId);
      out.push(
        privateEvent(award.playerId, 'xp-gain', {
          playerId: award.playerId,
          amount: award.xp,
          level: res.state.level,
          xpLeft: res.state.xp,
          next: xpToNextLevel(res.state.level),
        }),
      );
      for (const e of res.events) {
        if (e.type !== 'level-up') continue;
        out.push(
          privateEvent(award.playerId, 'levelup', {
            playerId: award.playerId,
            level: e.level,
            talentPointsGained: e.talentPointsGained,
            talentPoints: res.state.talentPoints,
          }),
        );
      }
      out.push(privateEvent(award.playerId, 'progression', this.progressionPayload(award.playerId)));
    }
    // Members may have levelled (or died) -> refresh their party rows so the
    // HUD, the XP radius filter and the level-gap filter all stay accurate.
    if (this.partyOf.has(playerId)) {
      this.refreshPartyOf(playerId);
      const finalParty = this.partyOf.get(playerId);
      if (finalParty) out.push(...this.broadcastParty(finalParty));
    }
    void now;
    return out;
  }

  // ---------------------------------------------------------------- talents

  /**
   * Spend talent points on one rank of `nodeId`. Vocation dollars go further
   * here: the favored branch's every-5th rank is free (20% off), and an
   * unspent talent-boon point (halo rind) is spent before pool points. With
   * no vocation and no boon this delegates to `learnNode` untouched.
   */
  spendTalent(playerId: number, nodeId: string): IntegratedOut[] {
    const st = this.prog.get(playerId);
    if (!st) return [];
    const node = skillNode(nodeId);
    if (!node) {
      return [reply(playerId, `No such talent "${nodeId}".`), privateEvent(playerId, 'talent-denied', { playerId, nodeId, reason: 'unknown-node' })];
    }
    const rank = st.talents[nodeId] ?? 0;
    if (rank >= node.maxRank) {
      return [
        reply(playerId, `${node.name} is already maxed (rank ${st.talents[nodeId] ?? 0}/${node.maxRank}).`),
        privateEvent(playerId, 'talent-denied', { playerId, nodeId, reason: 'maxed' }),
      ];
    }
    for (const req of node.requires) {
      if ((st.talents[req.nodeId] ?? 0) < req.rank) {
        return [
          reply(playerId, `Locked — needs ${req.nodeId} rank ${req.rank}.`),
          privateEvent(playerId, 'talent-denied', { playerId, nodeId, reason: 'prereq' }),
        ];
      }
    }
    const voc = this.vocations.get(playerId) ?? null;
    const cost = talentRankCost(node, voc, branchRanks(st.talents, node.branch) + 1);
    const bonus = this.maskBonus.get(playerId) ?? 0;
    if (st.talentPoints + bonus < cost) {
      return [reply(playerId, 'No talent points left.'), privateEvent(playerId, 'talent-denied', { playerId, nodeId, reason: 'no-points' })];
    }
    let next: ProgressionState;
    if (cost === node.costPerRank && bonus === 0) {
      // Fast path: byte-identical to the legacy `learnNode` call.
      const res = learnNode(st, nodeId);
      if (!res.ok) {
        return [reply(playerId, 'No talent points left.'), privateEvent(playerId, 'talent-denied', { playerId, nodeId, reason: res.reason })];
      }
      next = res.state;
    } else {
      // Discounted or boon-funded rank: same validation, custom charge, and
      // the boon point is spent first. A spent boon latches `boonUsed` so
      // re-wearing the rind cannot mint infinite points.
      const fromBonus = Math.min(bonus, cost);
      const fromPool = cost - fromBonus;
      if (fromBonus > 0) {
        this.maskBonus.set(playerId, bonus - fromBonus);
        this.boonUsed.add(playerId);
      }
      next = {
        ...st,
        talents: { ...st.talents, [nodeId]: rank + 1 },
        talentPoints: st.talentPoints - fromPool,
        spentPoints: st.spentPoints + fromPool,
      };
    }
    this.prog.set(playerId, next);
    this.statsCache.delete(playerId);
    const remaining = next.talentPoints + (this.maskBonus.get(playerId) ?? 0);
    return [
      privateEvent(playerId, 'talent-learned', {
        playerId,
        nodeId,
        rank: next.talents[nodeId] ?? 0,
        maxRank: node.maxRank,
        branch: node.branch,
        remainingPoints: remaining,
        meleeDamage: this.meleeDamage(playerId),
      }),
      privateEvent(playerId, 'progression', this.progressionPayload(playerId)),
      reply(playerId, `${node.name} ${next.talents[nodeId]}/${node.maxRank} — ${node.description}`),
    ];
  }

  /** Wipe every talent, refunding all points for `respecCost` gold. */
  respec(playerId: number): IntegratedOut[] {
    const st = this.prog.get(playerId);
    if (!st) return [];
    const res = respecTalents(st, this.gold(playerId));
    if (!res.ok) {
      const why = res.detail === 'no-talents'
        ? 'You have no talents to reset.'
        : `Respec costs more than your ${this.gold(playerId)} gold.`;
      return [reply(playerId, why), privateEvent(playerId, 'talent-denied', { playerId, nodeId: 'respec', reason: res.reason })];
    }
    const ev = res.events[0];
    if (ev.type !== 'respec') return [];
    this.prog.set(playerId, res.state);
    this.statsCache.delete(playerId);
    this.wallets.set(playerId, this.gold(playerId) - ev.cost);
    return [
      privateEvent(playerId, 'respec', { playerId, cost: ev.cost, refundedPoints: ev.refundedPoints, clearedNodes: ev.clearedNodes }),
      privateEvent(playerId, 'progression', this.progressionPayload(playerId)),
      privateEvent(playerId, 'gold', this.walletPayload(playerId)),
      reply(playerId, `Reset ${ev.clearedNodes.length} talent(s) for ${ev.cost}g — ${ev.refundedPoints} point(s) back.`),
    ];
  }

  /** Human-readable talent tree for `/talents`. */
  talentSummary(playerId: number): string[] {
    const st = this.prog.get(playerId) ?? createProgression(1);
    const lines = [`Lv${st.level} — ${st.talentPoints} talent point(s) unspent`];
    const voc = this.vocations.get(playerId);
    if (voc) {
      const def = vocationDef(voc)!;
      lines.push(`Calling: ${def.name} (${def.role}; ${def.favoredBranch} ranks 20% off)`);
    }
    const mask = this.masks.get(playerId);
    if (mask) {
      const def = maskDef(mask)!;
      lines.push(`Mask: ${def.name} ${def.glyph} (${def.perk})`);
    }
    for (const branch of BRANCHES) {
      const rows = nodesInBranch(branch);
      const spent = rows.reduce((n, node) => n + (st.talents[node.id] ?? 0), 0);
      lines.push(`── ${branch} (${spent} ranks) ──`);
      for (const node of rows) {
        const rank = st.talents[node.id] ?? 0;
        const locked = node.requires.some((r) => (st.talents[r.nodeId] ?? 0) < r.rank);
        lines.push(`  T${node.tier} ${node.name} ${rank}/${node.maxRank}${locked ? ' (locked)' : ''} — ${node.description}`);
      }
    }
    return lines;
  }

  // ----------------------------------------------------------------- vendor

  /** Vendor shop view (`/shop`). */
  shopMessage(playerId: number, now: number): IntegratedOut[] {
    const stock = this.vendorStock(now);
    const out: IntegratedOut[] = [privateEvent(playerId, 'vendor-stock', { items: stock })];
    const gold = this.gold(playerId);
    out.push(reply(playerId, `Vendor — you hold ${gold}g. Buy = market+15%, sell = market-35%.`));
    for (const row of stock) {
      const arrow = row.index > 0.05 ? '▲' : row.index < -0.05 ? '▼' : '▬';
      const sell = row.sell > 0 ? `${row.sell}g` : 'n/a';
      out.push(reply(playerId, `  ${row.name} (${row.itemId}) buy ${row.buy}g / sell ${sell} ${arrow}`));
    }
    return out;
  }

  /** `/buy <itemId> [qty]`. Gold, inventory space and level requirement all gate it. */
  buy(playerId: number, itemId: string, qty: number, now: number): IntegratedOut[] {
    const st = this.prog.get(playerId);
    if (!st) return [];
    const def = itemDef(itemId);
    if (!def) return this.tradeFail(playerId, 'buy', itemId, qty, 'unknown-item');
    if (qty <= 0) return this.tradeFail(playerId, 'buy', itemId, qty, 'bad-qty');
    const weapon = WEAPONS.find((w) => w.id === itemId);
    if (weapon && st.level < weapon.levelReq) {
      return this.tradeFail(playerId, 'buy', itemId, qty, 'level-too-low');
    }
    const inv = this.inventory(playerId);
    if (!canFit(inv, itemId, qty)) return this.tradeFail(playerId, 'buy', itemId, qty, 'inventory-full');
    const gold = this.gold(playerId);
    const res = vendorBuy(def.price, this.prices, itemId, qty, gold, now);
    if (!res.ok) return this.tradeFail(playerId, 'buy', itemId, qty, res.reason);
    if (!addItem(inv, itemId, qty)) return this.tradeFail(playerId, 'buy', itemId, qty, 'inventory-full');
    this.prices = res.history;
    this.wallets.set(playerId, gold - res.total);
    return this.tradeOk(playerId, 'buy', { itemId, qty, unitPrice: res.unitPrice, total: res.total });
  }

  /** `/sell <itemId> [qty]`. Inventory ownership is the gate; economy prices it. */
  sell(playerId: number, itemId: string, qty: number, now: number): IntegratedOut[] {
    const def = itemDef(itemId);
    if (!def) return this.tradeFail(playerId, 'sell', itemId, qty, 'unknown-item');
    if (qty <= 0) return this.tradeFail(playerId, 'sell', itemId, qty, 'bad-qty');
    const inv = this.inventory(playerId);
    const owned = countOf(inv, itemId);
    const res = vendorSell(def.price, this.prices, itemId, qty, owned, now);
    if (!res.ok) return this.tradeFail(playerId, 'sell', itemId, qty, res.reason);
    if (!removeItem(inv, itemId, qty)) return this.tradeFail(playerId, 'sell', itemId, qty, 'player-lacks-item');
    this.prices = res.history;
    this.wallets.set(playerId, this.gold(playerId) + res.total);
    return this.tradeOk(playerId, 'sell', { itemId, qty, unitPrice: res.unitPrice, total: res.total });
  }

  /**
   * Rejected trade. Emits the machine-readable `vendor-trade` (the client greys
   * the row out) plus a human line. Nothing in the wallet, inventory or price
   * history is touched — economy only records the trade when we adopt it.
   */
  private tradeFail(playerId: number, side: 'buy' | 'sell', itemId: string, qty: number, reason: string): IntegratedOut[] {
    const text: Record<string, string> = {
      'unknown-item': `The vendor does not stock "${itemId}".`,
      'bad-qty': 'Quantity must be a whole number of 1..999.',
      'insufficient-gold': `Not enough gold — you hold ${this.gold(playerId)}g.`,
      'inventory-full': 'No room in your inventory.',
      'player-lacks-item': `You do not carry ${qty}x ${itemId}.`,
      unsellable: `${defLabel(itemId)} cannot be sold.`,
      'level-too-low': `${defLabel(itemId)} needs a higher level.`,
      'out-of-stock': 'The vendor is out of that.',
    };
    return [
      privateEvent(playerId, 'vendor-trade', { playerId, side, itemId, qty, ok: false, reason, gold: this.gold(playerId) }),
      reply(playerId, text[reason] ?? `Trade rejected: ${reason}.`),
    ];
  }

  private tradeOk(
    playerId: number,
    side: 'buy' | 'sell',
    trade: { itemId: string; qty: number; unitPrice: number; total: number },
  ): IntegratedOut[] {
    const gold = this.gold(playerId);
    const verb = side === 'buy' ? 'Bought' : 'Sold';
    return [
      privateEvent(playerId, 'vendor-trade', {
        playerId,
        side,
        itemId: trade.itemId,
        qty: trade.qty,
        unitPrice: trade.unitPrice,
        total: trade.total,
        gold,
        ok: true,
      }),
      privateEvent(playerId, 'gold', { playerId, gold }),
      privateEvent(playerId, 'inventory', this.inventoryPayload(playerId)),
      privateEvent(playerId, 'vendor-stock', { items: this.vendorStock(Date.now()) }),
      reply(playerId, `${verb} ${trade.qty}x ${defLabel(trade.itemId)} for ${trade.total}g — ${gold}g left.`),
    ];
  }

  /** Keep a hand-recorded trade in the price history (server-side market seed). */
  recordMarketTrade(itemId: string, side: 'buy' | 'sell', qty: number, unitPrice: number, at: number): void {
    this.prices = recordTrade(this.prices, { itemId, side, qty, unitPrice, at });
  }

  // ----------------------------------------------------------------- loadout

  equip(playerId: number, itemId: string): IntegratedOut[] {
    if (!this.prog.has(playerId)) return [];
    const weapon = weaponDefFor(itemId);
    if (!weapon) {
      if (isMaskId(itemId)) return [reply(playerId, `${defLabel(itemId)} is a mask — wear it with /mask equip ${itemId}.`)];
      return [reply(playerId, `${defLabel(itemId)} is not a weapon.`)];
    }
    if (countOf(this.inventory(playerId), itemId) <= 0) {
      return [reply(playerId, `You do not carry a ${defLabel(itemId)}.`)];
    }
    const loadout = this.loadout.get(playerId) ?? [];
    if (loadout.some((e) => e.itemId === itemId)) return [reply(playerId, `${defLabel(itemId)} is already equipped.`)];
    this.loadout.set(playerId, [...loadout, { itemId, stats: statsForItem(weapon) }]);
    this.statsCache.delete(playerId);
    return [
      privateEvent(playerId, 'inventory', this.inventoryPayload(playerId)),
      privateEvent(playerId, 'progression', this.progressionPayload(playerId)),
      reply(playerId, `Equipped ${defLabel(itemId)} — melee ${this.meleeDamage(playerId)}.`),
    ];
  }

  unequip(playerId: number, itemId: string): IntegratedOut[] {
    if (isMaskId(itemId) && this.masks.get(playerId) === itemId) {
      return this.unequipMask(playerId);
    }
    const loadout = this.loadout.get(playerId) ?? [];
    const next = loadout.filter((e) => e.itemId !== itemId);
    if (next.length === loadout.length) return [reply(playerId, `${defLabel(itemId)} is not equipped.`)];
    this.loadout.set(playerId, next);
    this.statsCache.delete(playerId);
    return [
      privateEvent(playerId, 'inventory', this.inventoryPayload(playerId)),
      privateEvent(playerId, 'progression', this.progressionPayload(playerId)),
      reply(playerId, `Unequipped ${defLabel(itemId)} — melee ${this.meleeDamage(playerId)}.`),
    ];
  }

  // ------------------------------------------------------- masks + vocations

  /** Lines describing the 8 masks (`/mask`), with owned counts. */
  maskList(playerId: number): string[] {
    const lines = ['Masks — one slot; wear with /mask equip <id>:'];
    for (const m of MASKS) {
      const worn = this.masks.get(playerId) === m.id ? ' (worn)' : '';
      const owned = countOf(this.inventory(playerId), m.id);
      lines.push(`  ${m.glyph} ${m.name} (${m.id}) — ${m.perk}, ${m.price}g, owned x${owned}${worn}`);
    }
    return lines;
  }

  /** Lines describing the 4 callings (`/vocation`). */
  vocationList(): string[] {
    const lines = ['Callings — take one up with /vocation <id>:'];
    for (const v of VOCATIONS) {
      lines.push(`  ${v.name} (${v.id}) — ${v.role}; favors ${v.favoredBranch} (20% off); kit ${v.startingWeapon} + ${v.startingMask}; signature ${v.signature.name} (${v.signature.cooldownMs / 1000}s)`);
    }
    return lines;
  }

  /**
   * Wear a mask (exactly one slot — replaces whatever is worn). The mask
   * must be in the bag (loot: bosses 25%, elites 5%; or vendor-bought).
   * Perks apply immediately through aggregation + events; see masks.ts.
   */
  equipMask(playerId: number, maskId: string): IntegratedOut[] {
    if (!this.prog.has(playerId)) return [];
    const def = maskDef(maskId);
    if (!def) return [reply(playerId, `${defLabel(maskId)} is not a mask.`)];
    if (countOf(this.inventory(playerId), maskId) <= 0) {
      return [reply(playerId, `You do not carry a ${def.name}.`)];
    }
    const prev = this.masks.get(playerId) ?? null;
    if (prev === maskId) return [reply(playerId, `${def.name} is already worn.`)];
    this.masks.set(playerId, maskId);
    // Talent boon: granted while worn, unless the grant was already spent
    // (the anti-farm latch — re-wearing cannot mint infinite points).
    this.maskBonus.set(playerId, def.perk === 'talent-boon' && !this.boonUsed.has(playerId) ? MASK_TALENT_POINTS : 0);
    this.statsCache.delete(playerId);
    // ONBOARDING: tutorial step 5 ("wear a mask"). The mask is only wearable
    // through this method, so observing it here makes the predicate exact —
    // it fires on the real equip, never on a UI click that was rejected.
    noteMaskEquipped(playerId, maskId);
    const ev = maskEquippedEvent(playerId, maskId, prev);
    return [
      privateEvent(playerId, 'inventory', this.inventoryPayload(playerId)),
      privateEvent(playerId, 'progression', this.progressionPayload(playerId)),
      { type: 'event', kind: ev.kind, payload: ev.payload as unknown as Record<string, unknown>, recipients: [playerId] },
      reply(playerId, `You don the ${def.name} ${def.glyph} — ${def.description}`),
    ];
  }

  /** Doff the worn mask; every perk deactivates immediately. */
  unequipMask(playerId: number): IntegratedOut[] {
    const worn = this.masks.get(playerId);
    if (!worn) return [reply(playerId, 'You wear no mask.')];
    const def = maskDef(worn);
    this.masks.delete(playerId);
    this.maskBonus.set(playerId, 0);
    this.statsCache.delete(playerId);
    const ev = maskUnequippedEvent(playerId, worn);
    return [
      privateEvent(playerId, 'inventory', this.inventoryPayload(playerId)),
      privateEvent(playerId, 'progression', this.progressionPayload(playerId)),
      { type: 'event', kind: ev.kind, payload: ev.payload as unknown as Record<string, unknown>, recipients: [playerId] },
      reply(playerId, `You doff the ${def?.name ?? worn} — its gift fades.`),
    ];
  }

  /** Route `/mask equip|unequip|list`. */
  maskCommand(playerId: number, sub: 'list' | 'equip' | 'unequip', arg?: string): IntegratedOut[] {
    switch (sub) {
      case 'equip':
        return arg ? this.equipMask(playerId, arg) : [reply(playerId, 'Wear which mask? /mask equip <id> — /mask lists them.')];
      case 'unequip':
        return this.unequipMask(playerId);
      default:
        return this.maskList(playerId).map((l) => reply(playerId, l));
    }
  }

  /**
   * Take up a calling. Grants the starting weapon + mask once (in-memory;
   * never persisted), swaps the per-level stat curve, and unlocks the
   * signature. Re-swearing is allowed but grants no second kit.
   */
  chooseVocation(playerId: number, vocationId: string): IntegratedOut[] {
    if (!this.prog.has(playerId)) return [];
    const def = vocationDef(vocationId);
    if (!def || !isVocationId(vocationId)) {
      return [reply(playerId, `No such calling "${vocationId}". Choose: ${VOCATIONS.map((v) => v.id).join(', ')}.`)];
    }
    this.vocations.set(playerId, def.id);
    this.statsCache.delete(playerId);
    const out: IntegratedOut[] = [
      privateEvent(playerId, 'vocation', {
        playerId,
        vocation: def.id,
        name: def.name,
        role: def.role,
        favoredBranch: def.favoredBranch,
        signature: { id: def.signature.id, name: def.signature.name, description: def.signature.description, cooldownMs: def.signature.cooldownMs },
      }),
      privateEvent(playerId, 'progression', this.progressionPayload(playerId)),
    ];
    if (!this.kitGranted.has(playerId)) {
      this.kitGranted.add(playerId);
      const inv = this.inventory(playerId);
      const got: string[] = [];
      if (addItem(inv, def.startingWeapon, 1)) got.push(defLabel(def.startingWeapon));
      if (addItem(inv, def.startingMask, 1)) got.push(defLabel(def.startingMask));
      out.push(privateEvent(playerId, 'inventory', this.inventoryPayload(playerId)));
      out.push(reply(playerId, `You walk the ${def.name} path (${def.role}; ${def.favoredBranch} talents 20% cheaper). Starting kit: ${got.length > 0 ? got.join(' + ') : 'nothing fit'}. Signature: ${def.signature.name} — /sig or skill slot 1 (${def.signature.cooldownMs / 1000}s).`));
    } else {
      out.push(reply(playerId, `You walk the ${def.name} path now (${def.role}). No second kit — the first was gift enough.`));
    }
    return out;
  }

  /**
   * Fire the vocation signature from the `input.skill` slot (or `/sig` for
   * its status line). Enforces the 12s cooldown; returns the effect for the
   * caller to apply (heals land on the sim player, strikes reuse the melee
   * and NPC damage paths — see server/src/index.ts).
   */
  useSignature(playerId: number, slot: number, now: number): { out: IntegratedOut[]; ok: boolean; effect?: SignatureEffect } {
    if (!this.players.has(playerId)) return { out: [], ok: false };
    const voc = this.vocations.get(playerId);
    if (!voc) return { out: [reply(playerId, 'Choose a calling first: /vocation <id>.')], ok: false };
    const def = vocationDef(voc)!;
    if (!Number.isInteger(slot) || slot !== 1) {
      return { out: [reply(playerId, `Your signature is slot 1 — ${def.signature.name} (${def.signature.description})`)], ok: false };
    }
    const last = this.sigAt.get(playerId);
    if (!signatureReady(last, now)) {
      const ms = signatureRetryMs(last, now);
      return {
        out: [
          reply(playerId, `${def.signature.name} is recharging — ready in ${(ms / 1000).toFixed(1)}s.`),
          privateEvent(playerId, 'signature-denied', { playerId, signature: def.signature.id, retryMs: ms }),
        ],
        ok: false,
      };
    }
    this.sigAt.set(playerId, now);
    const effect = def.signature.effect;
    // ONBOARDING: tutorial step 6. Latched only on the `ok` path, i.e. after
    // the 12s cooldown has actually elapsed and the signature really fired.
    noteSignatureUsed(playerId, def.signature.id);
    return {
      out: [
        privateEvent(playerId, 'signature', { playerId, vocation: voc, signature: def.signature.id, name: def.signature.name, effect: { ...effect } }),
        reply(playerId, `${def.signature.name}! ${def.signature.description}`),
      ],
      ok: true,
      effect,
    };
  }

  /** Status line for `/sig` (the firing itself rides the skill input). */
  sigStatus(playerId: number, now: number): IntegratedOut[] {
    if (!this.players.has(playerId)) return [];
    const voc = this.vocations.get(playerId);
    if (!voc) return [reply(playerId, 'Choose a calling first: /vocation <id>.')];
    const def = vocationDef(voc)!;
    const last = this.sigAt.get(playerId);
    if (signatureReady(last, now)) {
      return [reply(playerId, `${def.signature.name} is ready — slot 1. ${def.signature.description}`)];
    }
    const ms = signatureRetryMs(last, now);
    return [reply(playerId, `${def.signature.name} is recharging — ready in ${(ms / 1000).toFixed(1)}s.`)];
  }

  // ------------------------------------------------------------------ chat

  /**
   * Route one outgoing chat line.
   *
   * - leading `/` -> command (never rate-limited by the legacy chat limiter;
   *   `CMD_RATE_MS` and the invite cooldown are the spam guards instead)
   * - channel `say` -> 10 m proximity chat through `social.nearbyChat`
   * - anything else -> `handled: false` so the caller keeps its legacy path
   */
  handleChat(playerId: number, text: string, channel: ChatChannel, now: number): ChatResult {
    if (!this.enabled) return { handled: false, out: [] };
    if (!this.players.has(playerId)) return { handled: false, out: [] };
    const cmd = parseChatCommand(text);
    if (cmd) return { handled: true, out: this.runCommand(playerId, cmd, now) };
    if (channel !== 'say') return { handled: false, out: [] };
    return { handled: true, out: this.say(playerId, text, now) };
  }

  /** Proximity `say` chat: everyone inside SAY_RADIUS (10 m) hears it. */
  say(playerId: number, text: string, now: number): IntegratedOut[] {
    const view = this.players.get(playerId);
    if (!view) return [];
    const res = nearbyChat(
      { id: playerId, pos: { x: view.x, y: view.y }, name: view.name },
      this.audience(),
      maskText(text),
      now,
      this.sayAt.get(playerId) ?? -Infinity,
    );
    if (!res.ok) {
      const why =
        res.reason === 'rate-limited'
          ? 'You are talking too fast.'
          : res.reason === 'too-long'
            ? 'Chat is limited to 200 characters.'
            : res.reason === 'nobody-nearby'
              ? `Nobody is within ${SAY_RADIUS}m to hear you.`
              : 'Say something.';
      return [reply(playerId, why)];
    }
    this.sayAt.set(playerId, now);
    const ev = res.events[0];
    if (ev.type !== 'nearby-chat') return [];
    return [{ type: 'chat', from: ev.name, text: ev.text, channel: 'say', recipients: ev.recipients }];
  }

  runCommand(playerId: number, cmd: ChatCommand, now: number): IntegratedOut[] {
    if (cmd.name === 'unknown') return [reply(playerId, `Unknown command "${cmd.raw}". Try /help.`)];
    const prev = this.cmdAt.get(playerId);
    if (prev !== undefined && now - prev < CMD_RATE_MS) return [];
    this.cmdAt.set(playerId, now);

    switch (cmd.name) {
      case 'invite':
        return this.invite(playerId, cmd.target, now);
      case 'accept':
        return this.acceptInvite(playerId, now);
      case 'decline':
        return this.declineInvite(playerId);
      case 'party':
        return this.partyCommand(playerId, cmd.sub, cmd.arg);
      case 'p':
        return this.partyChatCmd(playerId, cmd.text);
      case 'emote':
        return this.emote(playerId, cmd.emote, now);
      case 'buy':
        return this.buy(playerId, cmd.itemId, cmd.qty, now);
      case 'sell':
        return this.sell(playerId, cmd.itemId, cmd.qty, now);
      case 'shop':
        return this.shopMessage(playerId, now);
      case 'equip':
        return this.equip(playerId, cmd.itemId);
      case 'unequip':
        return this.unequip(playerId, cmd.itemId);
      case 'talents':
        return this.talentSummary(playerId).map((l) => reply(playerId, l));
      case 'talent':
        return this.spendTalent(playerId, cmd.nodeId);
      case 'respec':
        return this.respec(playerId);
      case 'mask':
        return this.maskCommand(playerId, cmd.sub, cmd.arg);
      case 'vocation':
        return cmd.arg ? this.chooseVocation(playerId, cmd.arg) : this.vocationList().map((l) => reply(playerId, l));
      case 'sig':
        return this.sigStatus(playerId, now);
      case 'stats': {
        const stats = this.stats(playerId);
        return [
          reply(playerId, `Lv${this.level(playerId)} · ${this.talentPoints(playerId)} talent point(s) · melee ${this.meleeDamage(playerId)} · ${this.gold(playerId)}g`),
          ...(Object.keys(stats) as (keyof StatBlock)[]).map((k) => reply(playerId, `  ${k}: ${stats[k]}`)),
        ];
      }
      case 'help':
        return [reply(playerId, 'Commands:'), ...COMMAND_REFERENCE.map((l) => reply(playerId, '  ' + l))];
      default:
        return [reply(playerId, 'Unknown command. Try /help.')];
    }
  }

  // ------------------------------------------------------------------- tick

  /**
   * The per-tick pipeline. `players` is the authoritative view from the server
   * (positions + HP); pass it every tick and the session keeps party rows,
   * proximity chat and the talent/stat mirrors in sync. Returns protocol v1
   * events; empty most ticks by design (throttled + change-driven only).
   */
  tick(now: number, players?: Iterable<SessionPlayer>): IntegratedOut[] {
    if (!this.enabled) return [];
    if (players) this.syncPlayers(players);
    const out: IntegratedOut[] = [];

    // 1. expire invites
    for (const [targetId, invite] of [...this.invites]) {
      if (invite.expiresAt <= now) {
        this.invites.delete(targetId);
        if (this.players.has(targetId)) out.push(reply(targetId, `${invite.fromName}'s invite expired.`));
      }
    }

    // 2. expire emote bubbles (the client prunes on `expiresAt` too)
    if (this.emotes.length > 0) {
      const live = this.emotes.filter((e) => e.expiresAt > now);
      if (live.length !== this.emotes.length) {
        for (const e of this.emotes) {
          if (e.expiresAt > now) continue;
          const label = EMOTES.find((x) => x.id === e.emote)?.label ?? e.emote;
          out.push({ type: 'event', kind: 'emote-end', payload: { seq: e.seq, fromId: e.fromId, emote: e.emote, label }, recipients: [e.fromId] });
        }
        this.emotes = live;
      }
    }

    // 2b. wall pings (vesper plume): one private ping per second per wearer.
    for (const [pid, maskId] of this.masks) {
      const view = this.players.get(pid);
      if (!view) continue;
      if (wallPingIntervalMs(maskId) <= 0) continue;
      if (!wallPingDue(this.pingAt.get(pid) ?? -Infinity, now, maskId)) continue;
      this.pingAt.set(pid, now);
      out.push(privateEvent(pid, 'wall-ping', { playerId: pid, maskId, x: view.x, y: view.y, at: now }));
    }

    // 3. party rows follow level + position + alive; snapshots are throttled.
    // The dirty check compares the whole party, and each `refreshMember` call
    // replaces the party object, so re-derive the member list every pass.
    const ids = [...this.partyOf.keys()];
    if (ids.length > 0) {
      let changed = false;
      for (const id of ids) {
        const before = this.partyOf.get(id);
        if (!before) continue;
        const after = this.refreshMember(id);
        if (!after || after === before) continue;
        const a = before.members.map((m) => `${m.playerId}:${m.level}:${m.dead}:${m.pos.x},${m.pos.y}`).join('|');
        const b = after.members.map((m) => `${m.playerId}:${m.level}:${m.dead}:${m.pos.x},${m.pos.y}`).join('|');
        if (a !== b) changed = true;
      }
      if (changed || now - this.lastPartySync >= PARTY_SYNC_MS) {
        this.lastPartySync = now;
        for (const p of new Set(this.partyOf.values())) out.push(...this.broadcastParty(p));
      }
    }
    return out;
  }

  /**
   * Copy the authoritative server view into the session. Players the session
   * has never seen are skipped: registration is `addPlayer` only (the hello
   * handler calls it, which is also where the bootstrap payload goes out), so
   * the tick can never silently create a player with no bootstrap.
   */
  syncPlayers(players: Iterable<SessionPlayer>): void {
    for (const p of players) {
      const view = this.players.get(p.id);
      if (!view) continue;
      view.x = p.x;
      view.y = p.y;
      view.hp = p.hp;
      view.maxHp = p.maxHp;
      view.name = p.name.slice(0, 16) || view.name;
    }
  }
}

/** Weapon lookup that keeps the `WeaponDef` narrowing local to this module. */
function weaponDefFor(itemId: string): WeaponDef | undefined {
  return WEAPONS.find((w) => w.id === itemId);
}

// ---------------------------------------------------------------------------
// Functional wrappers (the shape the server tick calls)
// ---------------------------------------------------------------------------

export function createGameSession(opts: GameSessionOptions = {}): GameSession {
  return new GameSession(opts);
}

export function tickIntegrated(session: GameSession, now: number, players?: Iterable<SessionPlayer>): IntegratedOut[] {
  return session.tick(now, players);
}

export function applyIntegratedChat(
  session: GameSession,
  playerId: number,
  text: string,
  channel: ChatChannel,
  now: number,
): ChatResult {
  return session.handleChat(playerId, text, channel, now);
}

/** Re-exported so the docs/table and the server banner have one source. */
export const LOOT_RULE_CHEAT: LootRule[] = ['freeforst', 'leader', 'master'];
export const TALENT_BRANCHES: Branch[] = [...BRANCHES];
export const TALENT_TREE = SKILL_TREE;
export const EMOTE_IDS: EmoteId[] = EMOTES.map((e) => e.id);
export const CHAT_RADIUS_M = SAY_RADIUS;
export const isPartyLeader = isLeader;
export const playerTalentPointsForLevel = talentPointsForLevel;
