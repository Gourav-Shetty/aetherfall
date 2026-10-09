// @aetherfall/systems — social: parties (max 5), loot rules, party XP split,
// proximity chat (10m radius) and 8 emotes.
//
// Design contract: PURE functions. State in -> new state + events out.
// No mutation of inputs, no clocks (callers pass `now`), no RNG.

// ---------------------------------------------------------------------------
// Tuning constants
// ---------------------------------------------------------------------------

export const PARTY_MAX = 5;

/** XP is only shared with members within this radius of the killer. */
export const PARTY_XP_RADIUS = 30;

/** Dead members take this fraction of a party XP share. */
export const PARTY_XP_DEAD_FACTOR = 0.5;

/** Members more than `PARTY_XP_MAX_LEVEL_GAP` levels BELOW the killer get none. */
export const PARTY_XP_MAX_LEVEL_GAP = 10;

/** Proximity ("nearby") chat radius, metres. */
export const CHAT_RADIUS = 10;

/** Chat limits reused by the proximity channel. */
export const NEARBY_CHAT_MAX_LEN = 200;
export const NEARBY_CHAT_RATE_MS = 1000;

/** Emotes: exactly 8, each with a visibility bubble and a duration. */
export const EMOTES = [
  { id: 'wave', label: 'Wave', durationMs: 2000, radius: 10 },
  { id: 'cheer', label: 'Cheer', durationMs: 2000, radius: 12 },
  { id: 'bow', label: 'Bow', durationMs: 2500, radius: 10 },
  { id: 'laugh', label: 'Laugh', durationMs: 2000, radius: 12 },
  { id: 'cry', label: 'Cry', durationMs: 3000, radius: 8 },
  { id: 'sit', label: 'Sit', durationMs: 4000, radius: 6 },
  { id: 'point', label: 'Point', durationMs: 2000, radius: 12 },
  { id: 'dance', label: 'Dance', durationMs: 4000, radius: 14 },
] as const;

export type EmoteId = (typeof EMOTES)[number]['id'];

/**
 * Local geometry alias. Deliberately NOT exported: `combat_ext.ts` owns the
 * canonical `Vec2` for the systems layer, so the barrel in `index.ts` stays
 * unambiguous.
 */
type Vec2 = { x: number; y: number };

// ---------------------------------------------------------------------------
// Loot rules
// ---------------------------------------------------------------------------

/**
 * Loot distribution rules.
 *  - `freeforst` — free-for-all (the game's wire spelling, kept stable so the
 *    client string never changes); `normalizeLootRule` also accepts
 *    'freeforall' / 'ffa'.
 *  - `leader` — everything goes to the party leader.
 *  - `master`  — master looter per member; the leader may hand items over.
 */
export const LOOT_RULES = ['freeforst', 'leader', 'master'] as const;
export type LootRule = (typeof LOOT_RULES)[number];

export function isLootRule(r: string): r is LootRule {
  return (LOOT_RULES as readonly string[]).includes(r);
}

const LOOT_ALIASES: Record<string, LootRule> = {
  ffa: 'freeforst',
  freeforall: 'freeforst',
  'free-for-all': 'freeforst',
  free: 'freeforst',
  lootmaster: 'master',
  ml: 'master',
};

export function normalizeLootRule(r: string): LootRule | null {
  const key = r.trim().toLowerCase();
  if (isLootRule(key)) return key;
  return LOOT_ALIASES[key] ?? null;
}

// ---------------------------------------------------------------------------
// Party
// ---------------------------------------------------------------------------

export type PartyMember = {
  playerId: number;
  name: string;
  level: number;
  pos: Vec2;
  /** Dead members earn PARTY_XP_DEAD_FACTOR of a share. */
  dead: boolean;
  /** True while the member is a candidate to roll/master-roll loot. */
  ready: boolean;
};

export type Party = {
  id: number;
  leaderId: number;
  lootRule: LootRule;
  members: PartyMember[];
  createdAt: number;
};

export type SocialEvent =
  | { type: 'party-created'; partyId: number; leaderId: number }
  | { type: 'party-joined'; partyId: number; playerId: number; memberCount: number }
  | { type: 'party-left'; partyId: number; playerId: number; memberCount: number }
  | { type: 'party-kicked'; partyId: number; playerId: number; byId: number }
  | { type: 'party-leader-changed'; partyId: number; leaderId: number; previous: number }
  | { type: 'party-loot-rule'; partyId: number; lootRule: LootRule }
  | { type: 'party-disbanded'; partyId: number; reason: string }
  | { type: 'party-ready'; partyId: number; playerId: number; ready: boolean }
  | { type: 'party-member-update'; partyId: number; playerId: number }
  | { type: 'party-chat'; partyId: number; fromId: number; text: string; recipients: number[] }
  | { type: 'nearby-chat'; fromId: number; name: string; text: string; recipients: number[] }
  | { type: 'emote'; fromId: number; name: string; emote: EmoteId; pos: Vec2; radius: number; expiresAt: number; recipients: number[] };

export type SocialResult<T> = { ok: true; party: Party; events: SocialEvent[]; value: T } | { ok: false; reason: string };

function cloneParty(p: Party): Party {
  return { ...p, members: p.members.map((m) => ({ ...m, pos: { ...m.pos } })) };
}

export function createParty(leader: PartyMember, now: number, partyId: number): Party {
  return { id: partyId, leaderId: leader.playerId, lootRule: 'freeforst', members: [{ ...leader, pos: { ...leader.pos } }], createdAt: now };
}

export function memberOf(party: Party, playerId: number): PartyMember | undefined {
  return party.members.find((m) => m.playerId === playerId);
}

export function isLeader(party: Party, playerId: number): boolean {
  return party.leaderId === playerId;
}

/** Free slot count (max 5). */
export function partySlots(party: Party): number {
  return PARTY_MAX - party.members.length;
}

/**
 * Add a member. Rejects non-leaders, duplicates, level gaps > PARTY_XP_MAX_LEVEL_GAP
 * and full parties. On success returns a NEW party.
 */
export function joinParty(
  party: Party,
  actorId: number,
  member: PartyMember,
): SocialResult<{ playerId: number }> {
  if (!isLeader(party, actorId)) return { ok: false, reason: 'not-leader' };
  if (member.playerId === actorId) return { ok: false, reason: 'self-join' };
  if (memberOf(party, member.playerId)) return { ok: false, reason: 'already-in-party' };
  if (party.members.length >= PARTY_MAX) return { ok: false, reason: 'party-full' };
  const leader = memberOf(party, actorId);
  if (leader && Math.abs(leader.level - member.level) > PARTY_XP_MAX_LEVEL_GAP) {
    return { ok: false, reason: 'level-gap' };
  }
  const next = cloneParty(party);
  next.members.push({ ...member, pos: { ...member.pos } });
  next.members.sort((a, b) => a.playerId - b.playerId);
  const events: SocialEvent[] = [
    { type: 'party-joined', partyId: party.id, playerId: member.playerId, memberCount: next.members.length },
    { type: 'party-member-update', partyId: party.id, playerId: member.playerId },
  ];
  return { ok: true, party: next, events, value: { playerId: member.playerId } };
}

/** Transfer leadership to an existing member. */
export function promoteLeader(party: Party, actorId: number, newLeaderId: number): SocialResult<{ leaderId: number }> {
  if (!isLeader(party, actorId)) return { ok: false, reason: 'not-leader' };
  if (!memberOf(party, newLeaderId)) return { ok: false, reason: 'not-in-party' };
  if (newLeaderId === actorId) return { ok: false, reason: 'already-leader' };
  const next = cloneParty(party);
  const prev = next.leaderId;
  next.leaderId = newLeaderId;
  const events: SocialEvent[] = [{ type: 'party-leader-changed', partyId: party.id, leaderId: newLeaderId, previous: prev }];
  return { ok: true, party: next, events, value: { leaderId: newLeaderId } };
}

/**
 * Remove a member. The leader cannot leave without handing over leadership
 * (promote to the lowest-id remaining member first). Emits `party-disbanded`
 * when the last member leaves.
 */
export function leaveParty(party: Party, actorId: number, reason = 'left'): SocialResult<{ disbanded: boolean }> {
  if (!memberOf(party, actorId)) return { ok: false, reason: 'not-in-party' };
  const next = cloneParty(party);
  const events: SocialEvent[] = [];
  let promotedFrom = party.leaderId;
  if (isLeader(party, actorId)) {
    const others = next.members.filter((m) => m.playerId !== actorId).sort((a, b) => a.playerId - b.playerId);
    if (others.length === 0) {
      next.members = [];
      events.push({ type: 'party-disbanded', partyId: party.id, reason });
      return { ok: true, party: next, events, value: { disbanded: true } };
    }
    next.leaderId = others[0]!.playerId;
    events.push({ type: 'party-leader-changed', partyId: party.id, leaderId: next.leaderId, previous: promotedFrom });
  }
  next.members = next.members.filter((m) => m.playerId !== actorId);
  if (next.members.length === 0) {
    events.push({ type: 'party-disbanded', partyId: party.id, reason });
    return { ok: true, party: next, events, value: { disbanded: true } };
  }
  events.push({ type: 'party-left', partyId: party.id, playerId: actorId, memberCount: next.members.length });
  return { ok: true, party: next, events, value: { disbanded: false } };
}

/** Leader/officer kick. Target must not be the leader. */
export function kickParty(party: Party, actorId: number, targetId: number): SocialResult<{ playerId: number }> {
  if (!isLeader(party, actorId)) return { ok: false, reason: 'not-leader' };
  if (targetId === actorId) return { ok: false, reason: 'cannot-kick-self' };
  if (isLeader(party, targetId)) return { ok: false, reason: 'cannot-kick-leader' };
  if (!memberOf(party, targetId)) return { ok: false, reason: 'not-in-party' };
  const next = cloneParty(party);
  next.members = next.members.filter((m) => m.playerId !== targetId);
  const events: SocialEvent[] = [{ type: 'party-kicked', partyId: party.id, playerId: targetId, byId: actorId }];
  return { ok: true, party: next, events, value: { playerId: targetId } };
}

/** Leader-only loot rule change. Accepts aliases ('ffa' -> 'freeforst'). */
export function setLootRule(party: Party, actorId: number, rule: string): SocialResult<{ lootRule: LootRule }> {
  if (!isLeader(party, actorId)) return { ok: false, reason: 'not-leader' };
  const normalized = normalizeLootRule(rule);
  if (!normalized) return { ok: false, reason: 'unknown-loot-rule' };
  const next = cloneParty(party);
  next.lootRule = normalized;
  const events: SocialEvent[] = [{ type: 'party-loot-rule', partyId: party.id, lootRule: normalized }];
  return { ok: true, party: next, events, value: { lootRule: normalized } };
}

/** Toggle a member's loot readiness. Any member may toggle their own. */
export function setReady(party: Party, actorId: number, ready: boolean): SocialResult<{ ready: boolean }> {
  const m = memberOf(party, actorId);
  if (!m) return { ok: false, reason: 'not-in-party' };
  const next = cloneParty(party);
  const target = next.members.find((x) => x.playerId === actorId)!;
  target.ready = ready;
  const events: SocialEvent[] = [{ type: 'party-ready', partyId: party.id, playerId: actorId, ready }];
  return { ok: true, party: next, events, value: { ready } };
}

/** Sync a member's level/position/alive flag (called by the tick). */
export function updateMember(
  party: Party,
  playerId: number,
  patch: Partial<Pick<PartyMember, 'level' | 'pos' | 'dead' | 'name' | 'ready'>>,
): SocialResult<{ member: PartyMember }> {
  if (!memberOf(party, playerId)) return { ok: false, reason: 'not-in-party' };
  const next = cloneParty(party);
  const target = next.members.find((x) => x.playerId === playerId)!;
  if (patch.level !== undefined) target.level = Math.max(1, Math.floor(patch.level));
  if (patch.pos !== undefined) target.pos = { ...patch.pos };
  if (patch.dead !== undefined) target.dead = patch.dead;
  if (patch.name !== undefined) target.name = patch.name.slice(0, 16);
  if (patch.ready !== undefined) target.ready = patch.ready;
  const events: SocialEvent[] = [{ type: 'party-member-update', partyId: party.id, playerId }];
  return { ok: true, party: next, events, value: { member: { ...target, pos: { ...target.pos } } } };
}

// ---------------------------------------------------------------------------
// Loot distribution
// ---------------------------------------------------------------------------

export type LootRoll = { playerId: number; itemId: string; qty: number };

export type LootPlan =
  | { rule: 'freeforst'; rolls: LootRoll[] }
  | { rule: 'leader'; rolls: LootRoll[] }
  | { rule: 'master'; rolls: LootRoll[]; pending: LootRoll[] };

/**
 * Decide who gets each drop stack.
 *  - freeforst: one roll per stack, distributed round-robin across eligible
 *    members (deterministic; a real roll would use the seeded RNG the caller
 *    feeds to `randomLootPlan`).
 *  - leader:    every stack goes to the leader.
 *  - master:    only members with `ready` roll; drops beyond one-per-member are
 *    held pending for the master looter.
 */
export function planLoot(
  party: Party,
  drops: { itemId: string; qty: number }[],
  rand: () => number = Math.random,
): LootPlan {
  const rule = party.lootRule;
  if (rule === 'leader') {
    const leader = memberOf(party, party.leaderId);
    if (!leader) return { rule, rolls: [] };
    return { rule, rolls: drops.map((d) => ({ playerId: leader.playerId, ...d })) };
  }
  if (rule === 'master') {
    const ready = party.members.filter((m) => m.ready);
    const rolls: LootRoll[] = [];
    const pending: LootRoll[] = [];
    for (const d of drops) {
      if (ready.length === 0) {
        pending.push({ playerId: party.leaderId, ...d });
        continue;
      }
      const winner = ready[Math.floor(rand() * ready.length) % ready.length]!;
      rolls.push({ playerId: winner.playerId, ...d });
    }
    return { rule, rolls, pending };
  }
  // free-for-all: everyone rolls; ties broken by playerId for determinism.
  const rolls: LootRoll[] = [];
  const ids = party.members.map((m) => m.playerId);
  for (const d of drops) {
    const pick = ids[Math.floor(rand() * ids.length) % Math.max(1, ids.length)];
    if (pick === undefined) continue;
    rolls.push({ playerId: pick, ...d });
  }
  return { rule, rolls };
}

// ---------------------------------------------------------------------------
// Party XP split
// ---------------------------------------------------------------------------

export type XpAward = { playerId: number; xp: number };

/**
 * Split `totalXp` across eligible members: within PARTY_XP_RADIUS of the
 * killer, not more than PARTY_XP_MAX_LEVEL_GAP below the killer's level.
 * The killer is always eligible for their own kill. Dead members earn
 * PARTY_XP_DEAD_FACTOR. Remainders (integer division) go to the lowest player
 * ids, so the split is exact and deterministic.
 */
export function splitPartyXp(
  party: Party,
  totalXp: number,
  killer: { playerId: number; pos: Vec2; level: number },
  radius: number = PARTY_XP_RADIUS,
): XpAward[] {
  if (totalXp <= 0) return [];
  const eligible = party.members
    .filter((m) => Math.hypot(m.pos.x - killer.pos.x, m.pos.y - killer.pos.y) <= radius)
    .filter((m) => m.playerId === killer.playerId || killer.level - m.level <= PARTY_XP_MAX_LEVEL_GAP)
    .sort((a, b) => a.playerId - b.playerId);
  if (eligible.length === 0) {
    // nobody in range: the killer banks it solo
    return [{ playerId: killer.playerId, xp: Math.floor(totalXp) }];
  }
  // Split in tenths so the dead-member discount stays integral.
  const unitsPerMember = 10;
  const unitsPerDead = Math.round(unitsPerMember * PARTY_XP_DEAD_FACTOR);
  const weights = eligible.map((m) => (m.dead ? unitsPerDead : unitsPerMember));
  const totalWeight = weights.reduce((a, b) => a + b, 0);
  const totalUnits = Math.floor(totalXp) * unitsPerMember;
  const awards: XpAward[] = [];
  let handedOut = 0;
  eligible.forEach((m, i) => {
    const units = Math.floor((totalUnits * weights[i]!) / totalWeight);
    const xp = Math.floor(units / unitsPerMember);
    if (xp > 0) {
      awards.push({ playerId: m.playerId, xp });
      handedOut += xp;
    }
  });
  // hand the integer remainder out to the first members, in id order
  let leftover = Math.floor(totalXp) - handedOut;
  for (const a of awards) {
    if (leftover <= 0) break;
    a.xp += 1;
    leftover -= 1;
  }
  if (leftover > 0 && awards.length > 0) {
    // more leftover than members: dump the rest on the first member
    awards[0]!.xp += leftover;
  }
  return awards.filter((a) => a.xp > 0);
}

// ---------------------------------------------------------------------------
// Proximity chat (10m radius)
// ---------------------------------------------------------------------------

export type ChatAudience = { id: number; pos: Vec2; name?: string };

export type NearbyChatResult =
  | { ok: true; events: SocialEvent[]; recipients: number[] }
  | { ok: false; reason: 'empty' | 'too-long' | 'rate-limited' | 'nobody-nearby' };

/**
 * Broadcast a proximity message to everyone inside CHAT_RADIUS, including the
 * sender. `lastSentAt` is the sender's previous message time (NaN/-Infinity =
 * never). Pure: no state mutated, the caller stores `now` itself.
 */
export function nearbyChat(
  from: ChatAudience,
  audience: ChatAudience[],
  text: string,
  now: number,
  lastSentAt = -Infinity,
): NearbyChatResult {
  const clean = text.slice(0, NEARBY_CHAT_MAX_LEN).trim();
  if (clean.length === 0) return { ok: false, reason: 'empty' };
  if (text.length > NEARBY_CHAT_MAX_LEN) return { ok: false, reason: 'too-long' };
  if (now - lastSentAt < NEARBY_CHAT_RATE_MS) return { ok: false, reason: 'rate-limited' };
  const recipients = audience
    .filter((a) => Math.hypot(a.pos.x - from.pos.x, a.pos.y - from.pos.y) <= CHAT_RADIUS)
    .map((a) => a.id);
  if (recipients.length === 0) return { ok: false, reason: 'nobody-nearby' };
  const events: SocialEvent[] = [
    { type: 'nearby-chat', fromId: from.id, name: from.name ?? `player-${from.id}`, text: clean, recipients },
  ];
  return { ok: true, events, recipients };
}

/** Party chat: fan out to the party, no radius involved. */
export function partyChat(party: Party, fromId: number, text: string): { ok: true; events: SocialEvent[] } | { ok: false; reason: string } {
  const clean = text.slice(0, NEARBY_CHAT_MAX_LEN).trim();
  if (clean.length === 0) return { ok: false, reason: 'empty' };
  if (!memberOf(party, fromId)) return { ok: false, reason: 'not-in-party' };
  const recipients = party.members.map((m) => m.playerId);
  return {
    ok: true,
    events: [{ type: 'party-chat', partyId: party.id, fromId, text: clean, recipients }],
  };
}

// ---------------------------------------------------------------------------
// Emotes
// ---------------------------------------------------------------------------

export type EmoteDef = { id: EmoteId; label: string; durationMs: number; radius: number };

const EMOTE_BY_ID = new Map<string, EmoteDef>(EMOTES.map((e) => [e.id, e as EmoteDef]));

export function isEmote(id: string): id is EmoteId {
  return EMOTE_BY_ID.has(id);
}

export function emoteDef(id: string): EmoteDef | undefined {
  return EMOTE_BY_ID.get(id);
}

/** Perform an emote; every listener within the emote's radius sees it. */
export function playEmote(
  from: ChatAudience,
  emoteId: string,
  audience: ChatAudience[],
  now: number,
): { ok: true; events: SocialEvent[] } | { ok: false; reason: 'unknown-emote' | 'nobody-nearby' } {
  const def = EMOTE_BY_ID.get(emoteId);
  if (!def) return { ok: false, reason: 'unknown-emote' };
  const recipients = audience
    .filter((a) => Math.hypot(a.pos.x - from.pos.x, a.pos.y - from.pos.y) <= def.radius)
    .map((a) => a.id);
  if (recipients.length === 0) return { ok: false, reason: 'nobody-nearby' };
  const events: SocialEvent[] = [
    {
      type: 'emote',
      fromId: from.id,
      name: from.name ?? `player-${from.id}`,
      emote: def.id,
      pos: { ...from.pos },
      radius: def.radius,
      expiresAt: now + def.durationMs,
      recipients,
    },
  ];
  return { ok: true, events };
}

/** Drop emote bubbles whose `expiresAt` has passed. Returns expired ids. */
export function expireEmotes(emotes: { id: string; expiresAt: number }[], now: number): string[] {
  return emotes.filter((e) => e.expiresAt <= now).map((e) => e.id);
}