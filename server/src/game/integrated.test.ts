// integrated: the composition layer — feature flag, chat-command grammar,
// progression XP + talent points, stat aggregation into melee damage, party
// lifecycle + exact XP split, emotes, 10 m proximity chat and the vendor.
//
// Everything here exercises `game/integrated.ts` through its public surface, so
// the suite also pins the wire contract: every `IntegratedOut` must serialise to
// a protocol v1 `{t:'event'}` / `{t:'chat'}` frame.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { damageFor } from './combat.js';
import { countOf, MAX_SLOTS, MAX_STACK } from './inventory.js';
import {
  CHAT_RADIUS_M,
  COMMAND_REFERENCE,
  GAME_SESSION_MARKER,
  INVITE_COOLDOWN_MS,
  MAX_TRADE_QTY,
  MELEE_BASE_DMG,
  PARTY_SYNC_MS,
  SAY_RADIUS,
  START_GOLD,
  applyIntegratedChat,
  createGameSession,
  parseChatCommand,
  systemsEnabledFromEnv,
  tickIntegrated,
  type ChatCommand,
  type GameSession,
  type IntegratedOut,
  type SessionPlayer,
} from './integrated.js';
import { CHAT_RADIUS, PARTY_MAX } from '../systems/social.js';
import { cumulativeXpForLevel, talentPointsForLevel, xpToNextLevel } from '../systems/progression.js';

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/** Monotonic clock: every call is well past CMD_RATE_MS / invite cooldown. */
function clock(): { now: () => number } {
  let t = 1_000_000;
  return { now: () => (t += 10_000) };
}

function newSession(opts: { enabled?: boolean; startGold?: number } = {}): GameSession {
  return createGameSession({ enabled: true, startGold: 1000, ...opts });
}

/** Register N players at one position. */
function party(s: GameSession, ids: number[], at: { x: number; y: number } = { x: 0, y: 0 }): void {
  for (const id of ids) s.addPlayer(id, `p${id}`, at.x, at.y);
}

function view(id: number, x: number, y: number, hp = 100, maxHp = 100): SessionPlayer {
  return { id, name: `p${id}`, x, y, hp, maxHp };
}

/** All events of a kind, with their payload. */
function ofKind(out: IntegratedOut[], kind: string): Array<Record<string, unknown>> {
  const acc: Array<Record<string, unknown>> = [];
  for (const o of out) if (o.type === 'event' && o.kind === kind) acc.push(o.payload);
  return acc;
}

function kinds(out: IntegratedOut[]): string[] {
  return out.filter((o) => o.type === 'event').map((o) => (o as { kind: string }).kind);
}

function text(out: IntegratedOut[]): string[] {
  return ofKind(out, 'sys-msg').map((p) => String(p.text));
}

/**
 * Drive invite -> accept so that ids[0] leads a party of all of them.
 * The target is always addressed by the JOINER's name — inviting yourself is
 * rejected by the session, so a bug here silently produces no party at all.
 */
function formParty(s: GameSession, ids: number[], c: { now: () => number }): void {
  for (let i = 0; i < ids.length - 1; i++) {
    const inviter = ids[i]!;
    for (let j = i + 1; j < ids.length; j++) {
      const joiner = ids[j]!;
      const t = c.now();
      s.invite(inviter, s.player(joiner)!.name, t);
      s.acceptInvite(joiner, t);
    }
  }
}

/** Enough XP to reach `level`, granted in one lump. */
function xpToReach(s: GameSession, pid: number, level: number): void {
  s.awardXp(pid, cumulativeXpForLevel(level), 0);
}

// ---------------------------------------------------------------------------
// feature flag
// ---------------------------------------------------------------------------

describe('integrated: SYSTEMS feature flag', () => {
  it('is on by default and off for an explicit falsy value', () => {
    assert.equal(systemsEnabledFromEnv({}), true);
    assert.equal(systemsEnabledFromEnv({ SYSTEMS: '1' }), true);
    assert.equal(systemsEnabledFromEnv({ SYSTEMS: 'true' }), true);
    assert.equal(systemsEnabledFromEnv({ SYSTEMS: 'yes' }), true);
    assert.equal(systemsEnabledFromEnv({ SYSTEMS: '0' }), false);
    assert.equal(systemsEnabledFromEnv({ SYSTEMS: 'false' }), false);
    assert.equal(systemsEnabledFromEnv({ SYSTEMS: 'off' }), false);
    assert.equal(systemsEnabledFromEnv({ SYSTEMS: ' 0 ' }), false);
  });

  it('falls back on a junk value and honours an explicit fallback', () => {
    assert.equal(systemsEnabledFromEnv({ SYSTEMS: 'banana' }), true);
    assert.equal(systemsEnabledFromEnv({ SYSTEMS: 'banana' }, false), false);
    assert.equal(systemsEnabledFromEnv({}, false), false);
  });

  it('a disabled session is inert: no bootstrap, no chat, no tick output', () => {
    const s = createGameSession({ enabled: false });
    assert.equal(s.enabled, false);
    assert.deepEqual(s.addPlayer(1, 'x', 0, 0), []);
    assert.equal(s.has(1), false);
    assert.deepEqual(s.tick(1000, [view(1, 0, 0)]), []);
    assert.deepEqual(s.awardXp(1, 500, 1000), []);
    const r = applyIntegratedChat(s, 1, '/buy ember-shard', 'say', 1000);
    assert.equal(r.handled, false);
    assert.deepEqual(r.out, []);
    // ...and it still answers the plain stats query for callers that ask.
    assert.equal(s.meleeDamage(1), MELEE_BASE_DMG);
  });

  it('an enabled session emits its bootstrap payload on join', () => {
    const s = newSession();
    const out = s.addPlayer(7, 'hero', 3, 4);
    assert.deepEqual(kinds(out), ['progression', 'talent-tree', 'gold', 'inventory', 'vendor-stock', 'party']);
    for (const o of out) {
      assert.equal(o.type, 'event');
      assert.deepEqual((o as { recipients?: number[] }).recipients, [7], 'bootstrap is private');
    }
    assert.equal(s.has(7), true);
    assert.equal(s.size(), 1);
    assert.equal(s.gold(7), 1000);
    assert.deepEqual(s.player(7), { id: 7, name: 'hero', x: 3, y: 4, hp: 100, maxHp: 100 });
  });

  it('addPlayer is idempotent and safe under re-join', () => {
    const s = newSession();
    s.addPlayer(1, 'a', 0, 0);
    assert.deepEqual(s.addPlayer(1, 'a', 5, 6), []);
    assert.equal(s.player(1)!.x, 5);
    assert.equal(s.size(), 1);
  });
});

// ---------------------------------------------------------------------------
// command grammar
// ---------------------------------------------------------------------------

describe('integrated: chat command grammar', () => {
  it('plain chat is not a command', () => {
    assert.equal(parseChatCommand('hello world'), null);
    assert.equal(parseChatCommand('  /'), null);
    assert.equal(parseChatCommand('/'), null);
  });

  it('parses each documented command', () => {
    assert.deepEqual(parseChatCommand('/invite Maren'), { name: 'invite', target: 'Maren' });
    assert.deepEqual(parseChatCommand('/accept'), { name: 'accept' });
    assert.deepEqual(parseChatCommand('/decline'), { name: 'decline' });
    assert.deepEqual(parseChatCommand('/party'), { name: 'party', sub: 'status' });
    assert.deepEqual(parseChatCommand('/party leave'), { name: 'party', sub: 'leave' });
    assert.deepEqual(parseChatCommand('/party kick Ash'), { name: 'party', sub: 'kick', arg: 'Ash' });
    assert.deepEqual(parseChatCommand('/party promote Ash'), { name: 'party', sub: 'promote', arg: 'Ash' });
    assert.deepEqual(parseChatCommand('/party loot master'), { name: 'party', sub: 'loot', arg: 'master' });
    assert.deepEqual(parseChatCommand('/party ready'), { name: 'party', sub: 'ready' });
    assert.deepEqual(parseChatCommand('/p hi there'), { name: 'p', text: 'hi there' });
    assert.deepEqual(parseChatCommand('/emote wave'), { name: 'emote', emote: 'wave' });
    assert.deepEqual(parseChatCommand('/emote DANCE'), { name: 'emote', emote: 'dance' });
    assert.deepEqual(parseChatCommand('/shop'), { name: 'shop' });
    assert.deepEqual(parseChatCommand('/buy ember-shard'), { name: 'buy', itemId: 'ember-shard', qty: 1 });
    assert.deepEqual(parseChatCommand('/buy ember-shard 12'), { name: 'buy', itemId: 'ember-shard', qty: 12 });
    assert.deepEqual(parseChatCommand('/sell obsidian-chip 3'), { name: 'sell', itemId: 'obsidian-chip', qty: 3 });
    assert.deepEqual(parseChatCommand('/equip ward-blade'), { name: 'equip', itemId: 'ward-blade' });
    assert.deepEqual(parseChatCommand('/unequip ward-blade'), { name: 'unequip', itemId: 'ward-blade' });
    assert.deepEqual(parseChatCommand('/talents'), { name: 'talents' });
    assert.deepEqual(parseChatCommand('/talent might-1'), { name: 'talent', nodeId: 'might-1' });
    assert.deepEqual(parseChatCommand('/respec'), { name: 'respec' });
    assert.deepEqual(parseChatCommand('/stats'), { name: 'stats' });
    assert.deepEqual(parseChatCommand('/help'), { name: 'help' });
  });

  it('folds aliases onto the canonical names', () => {
    assert.deepEqual(parseChatCommand('/inv Ash'), { name: 'invite', target: 'Ash' });
    assert.deepEqual(parseChatCommand('/join'), { name: 'accept' });
    // Party subcommands are also reachable as top-level verbs.
    assert.deepEqual(parseChatCommand('/leave'), { name: 'party', sub: 'leave' });
    assert.deepEqual(parseChatCommand('/quit'), { name: 'party', sub: 'leave' });
    assert.deepEqual(parseChatCommand('/kick Ash'), { name: 'party', sub: 'kick', arg: 'Ash' });
    assert.deepEqual(parseChatCommand('/promote Ash'), { name: 'party', sub: 'promote', arg: 'Ash' });
    assert.deepEqual(parseChatCommand('/loot master'), { name: 'party', sub: 'loot', arg: 'master' });
    assert.deepEqual(parseChatCommand('/p yo'), { name: 'p', text: 'yo' });
    assert.deepEqual(parseChatCommand('/em wave'), { name: 'emote', emote: 'wave' });
    assert.deepEqual(parseChatCommand('/store'), { name: 'shop' });
    assert.deepEqual(parseChatCommand('/tree'), { name: 'talents' });
    assert.deepEqual(parseChatCommand('/stat'), { name: 'stats' });
    assert.deepEqual(parseChatCommand('/?'), { name: 'help' });
  });

  it('reports unknown and incomplete commands instead of swallowing them', () => {
    assert.deepEqual(parseChatCommand('/nope'), { name: 'unknown', raw: '/nope' });
    assert.deepEqual(parseChatCommand('/invite'), { name: 'unknown', raw: '/invite' });
    assert.deepEqual(parseChatCommand('/p'), { name: 'unknown', raw: '/p' });
    assert.deepEqual(parseChatCommand('/party kick'), { name: 'unknown', raw: '/party kick' });
    assert.deepEqual(parseChatCommand('/emote'), { name: 'unknown', raw: '/emote' });
    const s = newSession();
    s.addPlayer(1, 'a', 0, 0);
    assert.match(text(s.runCommand(1, { name: 'unknown', raw: '/nope' }, 1))[0]!, /Unknown command/);
  });

  it('rejects a malformed quantity as 0 (economy then reports bad-qty)', () => {
    assert.equal((parseChatCommand('/buy ember-shard 0') as { qty: number }).qty, 0);
    assert.equal((parseChatCommand('/buy ember-shard -2') as { qty: number }).qty, 0);
    assert.equal((parseChatCommand('/buy ember-shard 1.5') as { qty: number }).qty, 0);
    assert.equal((parseChatCommand('/buy ember-shard abc') as { qty: number }).qty, 0);
    assert.equal((parseChatCommand(`/buy ember-shard ${MAX_TRADE_QTY + 1}`) as { qty: number }).qty, 0);
    assert.equal((parseChatCommand(`/buy ember-shard ${MAX_TRADE_QTY}`) as { qty: number }).qty, MAX_TRADE_QTY);
  });

  it('/help lists every command the reference documents', () => {
    const s = newSession();
    s.addPlayer(1, 'a', 0, 0);
    const lines = text(s.runCommand(1, { name: 'help' }, 1));
    assert.equal(lines.length, COMMAND_REFERENCE.length + 1);
    for (const ref of COMMAND_REFERENCE) {
      const head = ref.split(' ')[0]!;
      assert.ok(lines.some((l) => l.includes(head)), `help mentions ${head}`);
    }
  });
});

// ---------------------------------------------------------------------------
// XP curve + talent points
// ---------------------------------------------------------------------------

describe('integrated: XP uses the progression curve and awards talent points', () => {
  it('levels on the systems curve, not the legacy level*100 curve', () => {
    const s = newSession();
    s.addPlayer(1, 'a', 0, 0);
    const out = s.awardXp(1, xpToNextLevel(1), 0);
    const gained = ofKind(out, 'xp-gain');
    assert.equal(gained.length, 1);
    assert.equal(gained[0]!['amount'], 100);
    assert.equal(gained[0]!['level'], 2, '100 XP is exactly level 1 -> 2');
    assert.equal(gained[0]!['next'], xpToNextLevel(2), 'reports the systems threshold (300)');
    assert.equal(s.level(1), 2);
    // The legacy curve would still be level 1 at 100 XP.
    assert.notEqual(xpToNextLevel(2), 2 * 100);
  });

  it('emits levelup carrying the talent points it just awarded', () => {
    const s = newSession();
    s.addPlayer(1, 'a', 0, 0);
    const out = s.awardXp(1, xpToNextLevel(1), 0);
    const up = ofKind(out, 'levelup');
    assert.equal(up.length, 1);
    assert.equal(up[0]!['level'], 2);
    assert.equal(up[0]!['talentPointsGained'], 1);
    // createProgression(1) already seeded talentPointsForLevel(1) = 1.
    assert.equal(up[0]!['talentPoints'], talentPointsForLevel(2));
    assert.equal(s.talentPoints(1), talentPointsForLevel(2));
  });

  it('handles a multi-level lump and the 5th-level bonus point', () => {
    const s = newSession();
    s.addPlayer(1, 'a', 0, 0);
    const out = s.awardXp(1, cumulativeXpForLevel(5), 0);
    const ups = ofKind(out, 'levelup');
    assert.deepEqual(ups.map((u) => u['level']), [2, 3, 4, 5]);
    assert.equal(s.level(1), 5);
    assert.equal(s.talentPoints(1), talentPointsForLevel(5), '6 = 5 levels + the 5th-level bonus');
  });

  it('emits a private progression snapshot with stats and melee damage', () => {
    const s = newSession();
    s.addPlayer(1, 'a', 0, 0);
    const out = s.awardXp(1, 250, 0);
    const prog = ofKind(out, 'progression');
    assert.equal(prog.length, 1);
    assert.equal(prog[0]!['level'], 2, '250 XP clears level 1 (100) and leaves 150');
    assert.equal(prog[0]!['xp'], 150);
    assert.equal(prog[0]!['xpNeeded'], xpToNextLevel(2));
    assert.equal(prog[0]!['meleeDamage'], s.meleeDamage(1));
    assert.ok(Number(prog[0]!['power']) > 0);
  });

  it('ignores zero and negative XP', () => {
    const s = newSession();
    s.addPlayer(1, 'a', 0, 0);
    assert.deepEqual(s.awardXp(1, 0, 0), []);
    assert.deepEqual(s.awardXp(1, -50, 0), []);
    assert.deepEqual(s.awardXp(99, 100, 0), [], 'unknown player');
    assert.equal(s.level(1), 1);
  });
});

// ---------------------------------------------------------------------------
// stat aggregation -> melee damage
// ---------------------------------------------------------------------------

describe('integrated: talent spend changes melee damage', () => {
  it('matches the legacy melee curve exactly while nothing is spent', () => {
    const s = newSession();
    s.addPlayer(1, 'a', 0, 0);
    for (const level of [1, 2, 3, 5, 8]) {
      xpToReach(s, 1, level);
      assert.equal(s.level(1), level);
      assert.equal(
        s.meleeDamage(1),
        damageFor(level, 0),
        `level ${level}: aggregated damage equals combat.damageFor with no bonuses`,
      );
    }
  });

  it('spending a talent point on attackPower strictly increases damage', () => {
    const s = newSession();
    s.addPlayer(1, 'a', 0, 0);
    xpToReach(s, 1, 6);
    const before = s.meleeDamage(1);
    const statsBefore = s.stats(1);

    // might-4 (Bonebreaker, +3 attackPower/rank) needs might-3 at rank 2.
    for (const node of ['might-1', 'might-2', 'might-3', 'might-3', 'might-4']) {
      const out = s.spendTalent(1, node);
      assert.ok(kinds(out).includes('talent-learned'), `learned ${node}`);
    }
    const after = s.meleeDamage(1);
    const statsAfter = s.stats(1);

    assert.equal(statsBefore.attackPower, 5, 'level 6 contributes (6-1)*1 attackPower');
    assert.equal(statsAfter.attackPower, 8, 'Bonebreaker rank 1 adds +3');
    assert.equal(after, before + 3, 'melee damage rises by exactly the attackPower gained');
    assert.equal(s.talentPoints(1), talentPointsForLevel(6) - 5);
  });

  it('a talent without attackPower changes survivability, not damage', () => {
    const s = newSession();
    s.addPlayer(1, 'a', 0, 0);
    xpToReach(s, 1, 4);
    const before = s.meleeDamage(1);
    const hpBefore = s.stats(1).maxHp;
    s.spendTalent(1, 'might-1'); // +2 might, +10 maxHp — no attackPower
    assert.equal(s.meleeDamage(1), before, 'no attackPower -> damage unchanged');
    assert.equal(s.stats(1).maxHp, hpBefore + 10);
  });

  it('crit and move-speed talents are reflected in the aggregated block', () => {
    const s = newSession();
    s.addPlayer(1, 'a', 0, 0);
    xpToReach(s, 1, 6);
    s.spendTalent(1, 'guile-1');
    s.spendTalent(1, 'guile-2'); // +0.02 critChance
    assert.equal(s.stats(1).critChance, 0.05 + 0.02);
    s.spendTalent(1, 'guile-3');
    assert.ok(s.stats(1).attackSpeed > 1, 'Duelist raises attack speed');
  });

  it('refuses to spend without points and enforces prerequisites + rank caps', () => {
    const s = newSession();
    s.addPlayer(1, 'a', 0, 0);
    s.spendTalent(1, 'might-1'); // the single starting point
    assert.equal(s.talentPoints(1), 0);
    const denied = s.spendTalent(1, 'might-1');
    assert.deepEqual(ofKind(denied, 'talent-denied')[0], { playerId: 1, nodeId: 'might-1', reason: 'no-points' });
    assert.match(text(denied)[0]!, /No talent points/);

    const locked = s.spendTalent(1, 'might-4');
    assert.equal(ofKind(locked, 'talent-denied')[0]!['reason'], 'prereq');
    assert.match(text(locked)[0]!, /Locked/);

    const unknown = s.spendTalent(1, 'no-such-node');
    assert.equal(ofKind(unknown, 'talent-denied')[0]!['reason'], 'unknown-node');
  });

  it('enforces the rank cap and reports the new rank', () => {
    const s = newSession();
    s.addPlayer(1, 'a', 0, 0);
    xpToReach(s, 1, 8);
    for (let i = 0; i < 3; i++) s.spendTalent(1, 'might-1'); // maxRank 3
    assert.equal(s.progression(1)!.talents['might-1'], 3);
    const out = s.spendTalent(1, 'might-1');
    assert.equal(ofKind(out, 'talent-denied')[0]!['reason'], 'maxed');
  });

  it('an equipped weapon adds its damage to the aggregated melee damage', () => {
    const s = newSession();
    s.addPlayer(1, 'a', 0, 0);
    assert.equal(s.meleeDamage(1), MELEE_BASE_DMG);
    s.buy(1, 'wisp-touched-dagger', 1, 1000);
    assert.equal(countOf(s.inventory(1), 'wisp-touched-dagger'), 1);
    s.equip(1, 'wisp-touched-dagger'); // +4 attackPower
    assert.equal(s.meleeDamage(1), MELEE_BASE_DMG + 4);
    s.unequip(1, 'wisp-touched-dagger');
    assert.equal(s.meleeDamage(1), MELEE_BASE_DMG);
  });

  it('equipping needs the item in the bag and refuses non-weapons', () => {
    const s = newSession();
    s.addPlayer(1, 'a', 0, 0);
    assert.match(text(s.equip(1, 'ember-axe'))[0]!, /do not carry/);
    s.buy(1, 'ember-shard', 1, 1000);
    assert.match(text(s.equip(1, 'ember-shard'))[0]!, /not a weapon/);
    assert.match(text(s.equip(1, 'ember-axe'))[0]!, /do not carry/);
  });

  it('/respec refunds every spent point and charges gold', () => {
    const s = createGameSession({ enabled: true, startGold: 100_000 });
    s.addPlayer(1, 'a', 0, 0);
    xpToReach(s, 1, 4);
    s.spendTalent(1, 'might-1');
    s.spendTalent(1, 'might-2');
    assert.equal(s.talentPoints(1), talentPointsForLevel(4) - 2);
    const dmg = s.meleeDamage(1);
    const gold = s.gold(1);
    const out = s.respec(1);
    const ev = ofKind(out, 'respec')[0]!;
    assert.equal(ev['refundedPoints'], 2);
    assert.equal(s.talentPoints(1), talentPointsForLevel(4));
    assert.equal(s.gold(1), gold - Number(ev['cost']));
    assert.equal(s.meleeDamage(1), dmg, 'Iron Skin granted no attack power, so damage is unchanged');
  });

  it('/respec with nothing spent and respec beyond the wallet both fail', () => {
    const s = newSession();
    s.addPlayer(1, 'a', 0, 0);
    assert.equal(ofKind(s.respec(1), 'talent-denied')[0]!['reason'], 'maxed');
    xpToReach(s, 1, 5);
    s.spendTalent(1, 'might-1');
    const broke = createGameSession({ enabled: true, startGold: 0 });
    broke.addPlayer(2, 'b', 0, 0);
    xpToReach(broke, 2, 5);
    broke.spendTalent(2, 'might-1');
    const out = broke.respec(2);
    assert.equal(ofKind(out, 'talent-denied')[0]!['reason'], 'no-points');
    assert.match(text(out)[0]!, /gold/);
  });

  it('/stats and /talents describe the live build', () => {
    const s = newSession();
    s.addPlayer(1, 'a', 0, 0);
    const st = text(s.runCommand(1, { name: 'stats' }, 10_000));
    assert.match(st[0]!, /Lv1 · 1 talent point\(s\) · melee 12 · 1000g/);
    assert.equal(st.length, 1 + Object.keys(s.stats(1)).length);
    // Distinct timestamps: CMD_RATE_MS throttles a burst to silence.
    const tl = text(s.runCommand(1, { name: 'talents' }, 11_000));
    assert.match(tl[0]!, /Lv1 — 1 talent point\(s\) unspent/);
    assert.equal(tl.filter((l) => l.includes('── might')).length, 1);
    assert.equal(tl.filter((l) => l.includes('── guile')).length, 1);
    assert.equal(tl.filter((l) => l.includes('── will')).length, 1);
    assert.ok(tl.some((l) => l.includes('Bonebreaker') && l.includes('(locked)')));
  });
});

// ---------------------------------------------------------------------------
// party lifecycle
// ---------------------------------------------------------------------------

describe('integrated: party invite / join / leave over chat commands', () => {
  it('invite -> accept puts both players in one party', () => {
    const s = newSession();
    const c = clock();
    s.addPlayer(1, 'Ash', 0, 0);
    s.addPlayer(2, 'Maren', 0, 0);
    const invited = s.invite(1, 'Maren', c.now());
    const push = ofKind(invited, 'party-invite')[0]!;
    assert.equal(push['fromId'], 1);
    assert.equal(push['fromName'], 'Ash');
    assert.equal(push['partyId'], s.party(1)!.id);
    assert.deepEqual(s.partyMembers(2), [], 'the invitee is not a member yet');

    s.acceptInvite(2, c.now());
    assert.deepEqual(s.partyMembers(1).sort(), [1, 2]);
    assert.deepEqual(s.partyMembers(2).sort(), [1, 2]);
    assert.equal(s.party(1)!.leaderId, 1);
    assert.equal(s.party(2)!.lootRule, 'freeforst');
  });

  it('matches names case-insensitively and by unique prefix', () => {
    const s = newSession();
    const c = clock();
    s.addPlayer(1, 'Ash', 0, 0);
    s.addPlayer(2, 'Maren', 0, 0);
    const exact = ofKind(s.invite(1, 'maren', c.now()), 'party-invite');
    assert.equal(exact.length, 1, 'case-insensitive exact match');
    assert.equal(Number(exact[0]!['fromId']), 1);

    const s2 = newSession();
    const c2 = clock();
    s2.addPlayer(1, 'Ash', 0, 0);
    s2.addPlayer(2, 'Maren', 0, 0);
    s2.invite(1, 'Mar', c2.now());
    s2.acceptInvite(2, c2.now());
    assert.equal(s2.partyMembers(2).length, 2, 'unique prefix resolves to the one Maren');
  });

  it('rejects unknown names, self-invites and a rate-limited inviter', () => {
    const s = newSession();
    s.addPlayer(1, 'Ash', 0, 0);
    s.addPlayer(2, 'Maren', 0, 0);
    s.addPlayer(3, 'Bryn', 0, 0);
    assert.match(text(s.invite(1, 'Nobody', 1000))[0]!, /No player named/);
    assert.match(text(s.invite(1, 'Ash', 2000))[0]!, /cannot invite yourself/);
    s.invite(1, 'Maren', 3000);
    s.acceptInvite(2, 3000);
    // A second invite inside INVITE_COOLDOWN_MS is throttled before any lookup.
    assert.match(text(s.invite(1, 'Bryn', 3100))[0]!, /Slow down/);
    assert.ok(0 < INVITE_COOLDOWN_MS);
    // Past the cooldown the real reason surfaces: Maren is already grouped.
    assert.match(text(s.invite(1, 'Maren', 5000))[0]!, /already in a party/);
  });

  it('accepting without an invite, or an expired one, is refused', () => {
    const s = newSession();
    const c = clock();
    s.addPlayer(1, 'Ash', 0, 0);
    s.addPlayer(2, 'Maren', 0, 0);
    assert.match(text(s.acceptInvite(2, c.now()))[0]!, /No pending invite/);
    const t = c.now();
    s.invite(1, 'Maren', t);
    assert.match(text(s.acceptInvite(2, t + 60_000))[0]!, /expired/);
  });

  it('/decline drops the invite and tells both sides', () => {
    const s = newSession();
    const c = clock();
    s.addPlayer(1, 'Ash', 0, 0);
    s.addPlayer(2, 'Maren', 0, 0);
    const t = c.now();
    s.invite(1, 'Maren', t);
    const out = s.declineInvite(2);
    assert.match(text(out).join(' '), /Declined Ash's invite/);
    assert.match(text(s.acceptInvite(2, c.now()))[0]!, /No pending invite/);
  });

  it('caps the party at PARTY_MAX members', () => {
    const s = newSession();
    const c = clock();
    const ids = [1, 2, 3, 4, 5, 6];
    party(s, ids);
    formParty(s, ids, c);
    assert.equal(s.party(1)!.members.length, PARTY_MAX);
    assert.equal(s.party(6), undefined, 'the 6th player was never added');
    assert.match(text(s.invite(5, 'p6', c.now()))[0]!, /full/);
  });

  it('the leader passes leadership on leaving and disbands when last', () => {
    const s = newSession();
    const c = clock();
    party(s, [1, 2, 3]);
    formParty(s, [1, 2, 3], c);
    s.partyCommand(1, 'leave');
    assert.equal(s.party(1), undefined);
    assert.equal(s.party(2)!.leaderId, 2, 'leadership passed to the lowest remaining id');
    assert.deepEqual(s.partyMembers(2).sort(), [2, 3]);
    s.partyCommand(2, 'leave');
    s.partyCommand(3, 'leave');
    assert.equal(s.party(3), undefined);
  });

  it('/party status lists every member with HP and level', () => {
    const s = newSession();
    const c = clock();
    party(s, [1, 2]);
    formParty(s, [1, 2], c);
    s.tick(c.now(), [view(1, 0, 0, 80, 100), view(2, 1, 0, 100, 100)]);
    const out = text(s.runCommand(1, { name: 'party', sub: 'status' }, c.now()));
    assert.match(out[0]!, /Party #1 — 2\/5, loot freeforst/);
    assert.match(out[1]!, /★ p1 Lv1 80\/100HP/);
    assert.match(out[2]!, /· p2 Lv1 100\/100HP/);
  });

  it('/party kick and /party promote are leader-only', () => {
    const s = newSession();
    const c = clock();
    party(s, [1, 2, 3]);
    formParty(s, [1, 2, 3], c);
    assert.match(text(s.partyCommand(2, 'kick', 'p3'))[0]!, /Cannot kick: not-leader/);
    assert.equal(s.partyMembers(1)!.length, 3);
    assert.match(text(s.partyCommand(2, 'promote', 'p3'))[0]!, /Cannot promote: not-leader/);
    s.partyCommand(1, 'kick', 'p3');
    assert.deepEqual(s.partyMembers(1)!.sort(), [1, 2]);
    assert.equal(s.party(3), undefined);
    s.partyCommand(1, 'promote', 'p2');
    assert.equal(s.party(1)!.leaderId, 2);
  });

  it('/party loot accepts the aliases and rejects junk', () => {
    const s = newSession();
    const c = clock();
    party(s, [1, 2]);
    formParty(s, [1, 2], c);
    assert.match(text(s.partyCommand(1, 'loot', 'banana'))[0]!, /unknown-loot-rule/);
    s.partyCommand(1, 'loot', 'ml');
    assert.equal(s.party(1)!.lootRule, 'master');
    s.partyCommand(1, 'loot', 'ffa');
    assert.equal(s.party(1)!.lootRule, 'freeforst');
    assert.match(text(s.partyCommand(2, 'loot', 'leader'))[0]!, /not-leader/);
  });

  it('/party ready toggles the member flag', () => {
    const s = newSession();
    const c = clock();
    party(s, [1, 2]);
    formParty(s, [1, 2], c);
    s.partyCommand(1, 'ready');
    assert.equal(s.party(1)!.members.find((m) => m.playerId === 1)!.ready, true);
    s.partyCommand(1, 'ready');
    assert.equal(s.party(1)!.members.find((m) => m.playerId === 1)!.ready, false);
  });

  it('party chat reaches only the party', () => {
    const s = newSession();
    const c = clock();
    party(s, [1, 2, 3]);
    formParty(s, [1, 2, 3], c);
    const out = s.partyChatCmd(1, 'pull left');
    const chats = out.filter((o) => o.type === 'chat');
    assert.equal(chats.length, 2, 'the other two members');
    for (const o of chats) assert.equal((o as { recipients: number[] }).recipients.length, 1);
    assert.match(text(out)[0]!, /\[party\] you: pull left/);
    const outsider = newSession();
    outsider.addPlayer(9, 'solo', 0, 0);
    assert.match(text(outsider.partyChatCmd(9, 'hi'))[0]!, /not in a party/);
  });

  it('party chat is profanity-masked', () => {
    const s = newSession();
    const c = clock();
    party(s, [1, 2]);
    formParty(s, [1, 2], c);
    const out = s.partyChatCmd(1, 'badword');
    assert.match(text(out)[0]!, /\*\*\*\*\*\*\*/);
    assert.equal(s.partyChatCmd(9, 'x').length, 1);
  });

  it('the party snapshot carries HP, level, leader and loot rule', () => {
    const s = newSession();
    const c = clock();
    party(s, [1, 2]);
    formParty(s, [1, 2], c);
    s.tick(c.now(), [view(1, 0, 0, 42, 100), view(2, 1, 0, 100, 100)]);
    const snap = ofKind(s.tick(c.now() + PARTY_SYNC_MS, []), 'party').find((p) => p['partyId'] === 1)!;
    assert.equal(snap['inParty'], true);
    assert.equal(snap['lootRule'], 'freeforst');
    assert.equal(snap['maxMembers'], PARTY_MAX);
    const members = snap['members'] as Array<Record<string, unknown>>;
    assert.equal(members.length, 2);
    assert.equal(members[0]!['leader'], true);
    assert.equal(members[0]!['hp'], 42);
    assert.equal(members[0]!['online'], true);
  });

  it('removing a player cleans up their party, invites and emotes', () => {
    const s = newSession();
    const c = clock();
    party(s, [1, 2, 3]);
    formParty(s, [1, 2, 3], c);
    s.emote(2, 'wave', c.now());
    assert.equal(s.activeEmotes().length, 1);
    s.removePlayer(2);
    assert.deepEqual(s.partyMembers(1).sort(), [1, 3]);
    assert.equal(s.has(2), false);
    assert.equal(s.gold(2), 0);
    assert.deepEqual(s.activeEmotes(), []);
    assert.equal(s.party(2), undefined);
    assert.match(text(s.acceptInvite(3, c.now()))[0]!, /No pending invite/);
  });
});

// ---------------------------------------------------------------------------
// party XP split
// ---------------------------------------------------------------------------

describe('integrated: party XP split sums exactly', () => {
  function formedParty(count: number) {
    const s = newSession();
    const c = clock();
    const ids = Array.from({ length: count }, (_, i) => i + 1);
    party(s, ids);
    formParty(s, ids, c);
    s.tick(c.now(), ids.map((id, i) => view(id, i, 0)));
    return { s, c, ids };
  }

  it('splits between exactly the eligible members and sums to the total', () => {
    for (const total of [10, 11, 12, 100, 101, 999, 12_345]) {
      const { s } = formedParty(3);
      const awards = ofKind(s.awardXp(1, total, 0), 'xp-gain');
      const sum = awards.reduce((n, p) => n + Number(p['amount']), 0);
      assert.equal(sum, total, `a ${total} XP split must not lose or invent XP`);
      assert.equal(awards.length, 3, 'all three members were in range');
    }
  });

  it('splits evenly between identical members', () => {
    const { s } = formedParty(2);
    const awards = ofKind(s.awardXp(1, 120, 0), 'xp-gain');
    assert.deepEqual(awards.map((p) => Number(p['amount'])).sort(), [60, 60]);
  });

  it('a dead member takes half and the sum still holds', () => {
    const s = newSession();
    const c = clock();
    party(s, [1, 2]);
    formParty(s, [1, 2], c);
    s.tick(c.now(), [view(1, 0, 0, 100), view(2, 0, 0, 0, 100)]);
    const awards = ofKind(s.awardXp(1, 100, 0), 'xp-gain');
    const byId = new Map(awards.map((p) => [Number(p['playerId']), Number(p['amount'])]));
    assert.equal(byId.get(1), 67, 'alive member takes 10/15 of the pool, plus the remainder');
    assert.equal(byId.get(2), 33, 'dead member takes 5/15 (PARTY_XP_DEAD_FACTOR)');
    assert.equal([...byId.values()].reduce((a, b) => a + b, 0), 100);
  });

  it('a member beyond the XP radius is excluded and the rest still sum exactly', () => {
    const s = newSession();
    const c = clock();
    party(s, [1, 2]);
    formParty(s, [1, 2], c);
    s.tick(c.now(), [view(1, 0, 0), view(2, 40, 0)]);
    const awards = ofKind(s.awardXp(1, 50, 0), 'xp-gain');
    assert.deepEqual(awards.map((p) => Number(p['playerId'])), [1]);
    assert.equal(Number(awards[0]!['amount']), 50, 'the far member forfeits their share to the killer');
  });

  it('a solo killer with no party banks the whole award', () => {
    const s = newSession();
    s.addPlayer(1, 'solo', 0, 0);
    const awards = ofKind(s.awardXp(1, 77, 0), 'xp-gain');
    assert.equal(awards.length, 1);
    assert.equal(Number(awards[0]!['amount']), 77);
    assert.equal(s.level(1), 1, '77 XP is below the level 1 threshold of 100');
  });

  it('every recipient of a split advances on the same curve', () => {
    const { s } = formedParty(3);
    const out = s.awardXp(1, 300, 0);
    assert.equal(s.level(1), 2);
    assert.equal(s.level(2), 2);
    assert.equal(s.level(3), 2);
    assert.equal(ofKind(out, 'levelup').length, 3, 'each member got its own levelup');
    for (const up of ofKind(out, 'levelup')) {
      assert.equal(up['talentPointsGained'], 1);
      assert.equal(up['talentPoints'], talentPointsForLevel(2));
    }
  });

  it('party levels stay in sync so the radius / level-gap filters are accurate', () => {
    const { s } = formedParty(3);
    s.awardXp(1, cumulativeXpForLevel(7), 0);
    for (const id of [1, 2, 3]) {
      const m = s.party(1)!.members.find((x) => x.playerId === id)!;
      assert.equal(m.level, s.level(id), `member ${id} level mirrors progression`);
    }
  });
});

// ---------------------------------------------------------------------------
// emotes
// ---------------------------------------------------------------------------

describe('integrated: emotes', () => {
  it('only the players inside the emote radius receive the bubble', () => {
    const s = newSession();
    const c = clock();
    s.addPlayer(1, 'Ash', 0, 0);
    s.addPlayer(2, 'near', 5, 0);
    s.addPlayer(3, 'far', 30, 0);
    const t = c.now();
    const out = s.emote(1, 'wave', t);
    const ev = ofKind(out, 'emote')[0]!;
    assert.equal(ev['emote'], 'wave');
    assert.equal(ev['label'], 'Wave');
    assert.equal(ev['fromId'], 1);
    assert.equal(ev['x'], 0);
    assert.equal(ev['radius'], 10);
    assert.ok(Number(ev['expiresAt']) > t);
    assert.deepEqual((out[0] as { recipients: number[] }).recipients.sort(), [1, 2]);
  });

  it('dance reaches further than cry', () => {
    const s = newSession();
    const c = clock();
    s.addPlayer(1, 'Ash', 0, 0);
    s.addPlayer(2, 'mid', 9, 0);
    const cry = s.emote(1, 'cry', c.now()); // radius 8 -> the 9 m player cannot see it
    assert.deepEqual((cry[0] as { recipients: number[] }).recipients, [1]);
    const dance = s.emote(1, 'dance', c.now()); // radius 14
    assert.deepEqual((dance[0] as { recipients: number[] }).recipients.sort(), [1, 2]);
  });

  it('an unknown emote is refused and names the problem', () => {
    const s = newSession();
    s.addPlayer(1, 'Ash', 0, 0);
    const out = s.emote(1, 'moonwalk', 1000);
    assert.equal(ofKind(out, 'emote').length, 0, 'no bubble is broadcast');
    assert.match(text(out)[0]!, /Unknown emote/);
    assert.deepEqual(s.activeEmotes(), []);
  });

  it('re-emoting replaces the previous bubble instead of stacking it', () => {
    const s = newSession();
    const c = clock();
    s.addPlayer(1, 'Ash', 0, 0);
    s.emote(1, 'wave', c.now());
    s.emote(1, 'bow', c.now());
    const live = s.activeEmotes();
    assert.equal(live.length, 1);
    assert.equal(live[0]!.emote, 'bow');
  });

  it('bubbles expire on their own TTL and the tick emits emote-end', () => {
    const s = newSession();
    s.addPlayer(1, 'Ash', 0, 0);
    const out = s.emote(1, 'wave', 10_000);
    const expiresAt = Number(ofKind(out, 'emote')[0]!['expiresAt']);
    assert.deepEqual(s.tick(expiresAt - 1), []);
    const ended = s.tick(expiresAt + 1);
    assert.deepEqual(kinds(ended), ['emote-end']);
    assert.equal(ofKind(ended, 'emote-end')[0]!['label'], 'Wave');
    assert.deepEqual(s.activeEmotes(), []);
  });

  it('a stale invite expires on the tick', () => {
    const s = newSession();
    s.addPlayer(1, 'Ash', 0, 0);
    s.addPlayer(2, 'Maren', 0, 0);
    const t = 1_000_000;
    s.invite(1, 'Maren', t);
    assert.equal(s.party(2), undefined, 'the invitee has not joined yet');
    // Before the TTL the tick has nothing to say beyond the throttled party row.
    assert.deepEqual(kinds(s.tick(t + 1000)).filter((k) => k !== 'party'), []);
    assert.match(text(s.tick(t + 31_000)).join(' '), /expired/);
    assert.match(text(s.acceptInvite(2, t + 32_000))[0]!, /No pending invite/);
  });
});

// ---------------------------------------------------------------------------
// proximity chat
// ---------------------------------------------------------------------------

describe('integrated: proximity chat radius', () => {
  function two(at: { x: number; y: number }): GameSession {
    const s = newSession();
    s.addPlayer(1, 'Ash', 0, 0);
    s.addPlayer(2, 'Maren', at.x, at.y);
    return s;
  }

  it('the radius is 10 m', () => {
    assert.equal(SAY_RADIUS, 10);
    assert.equal(SAY_RADIUS, CHAT_RADIUS);
    assert.equal(CHAT_RADIUS_M, 10);
  });

  it('delivers to everyone inside the radius, including the sender', () => {
    const s = two({ x: 5, y: 0 });
    const out = s.say(1, 'hello', 10_000);
    assert.equal(out.length, 1);
    const msg = out[0] as { type: 'chat'; from: string; text: string; channel: string; recipients: number[] };
    assert.equal(msg.type, 'chat');
    assert.equal(msg.from, 'Ash');
    assert.equal(msg.text, 'hello');
    assert.equal(msg.channel, 'say');
    assert.deepEqual(msg.recipients.sort(), [1, 2]);
  });

  it('delivers at exactly 10 m and drops just past it (inclusive boundary)', () => {
    const on = two({ x: 10, y: 0 });
    const out = on.say(1, 'edge', 10_000);
    assert.deepEqual((out[0] as { recipients: number[] }).recipients.sort(), [1, 2]);
    // Just outside: the listener is excluded but the speaker still hears
    // themselves, so the message goes out with a single recipient.
    const off = two({ x: 10.5, y: 0 });
    const missed = off.say(1, 'edge', 10_000);
    assert.deepEqual((missed[0] as { recipients: number[] }).recipients, [1]);
    // Diagonals use true Euclidean distance, not a box test.
    const diag = newSession();
    diag.addPlayer(1, 'a', 0, 0);
    diag.addPlayer(2, 'b', 6, 6); // 8.49 m -> inside
    assert.equal((diag.say(1, 'x', 10_000)[0] as { recipients: number[] }).recipients.length, 2);
    diag.addPlayer(3, 'c', 8, 8); // 11.31 m from the origin -> outside
    assert.deepEqual((diag.say(1, 'y', 20_000)[0] as { recipients: number[] }).recipients, [1, 2]);
  });

  it('a lone player always hears their own message', () => {
    const s = newSession();
    s.addPlayer(1, 'alone', 50, 50);
    const out = s.say(1, 'anyone there', 10_000);
    assert.deepEqual((out[0] as { recipients: number[] }).recipients, [1]);
  });

  it('rate limits to one message per second', () => {
    const s = two({ x: 1, y: 0 });
    assert.equal(s.say(1, 'one', 10_000).length, 1);
    assert.match(text(s.say(1, 'two', 10_500))[0]!, /too fast/);
    assert.equal(s.say(1, 'three', 11_000).length, 1);
  });

  it('masks profanity and caps the length at 200 characters', () => {
    const s = two({ x: 1, y: 0 });
    assert.equal((s.say(1, 'badword', 10_000)[0] as { text: string }).text, '*******');
    assert.match(text(s.say(1, 'x'.repeat(201), 20_000))[0]!, /200 characters/);
    assert.match(text(s.say(1, '   ', 30_000))[0]!, /Say something/);
  });

  it('handleChat only consumes `say`; global and guild fall through to the legacy lane', () => {
    const s = two({ x: 1, y: 0 });
    assert.equal(applyIntegratedChat(s, 1, 'hi', 'global', 10_000).handled, false);
    assert.equal(applyIntegratedChat(s, 1, 'hi', 'guild', 10_000).handled, false);
    const say = applyIntegratedChat(s, 1, 'hi', 'say', 10_000);
    assert.equal(say.handled, true);
    assert.equal(say.out.length, 1);
    const cmdResult = applyIntegratedChat(s, 1, '/stats', 'global', 20_000);
    assert.equal(cmdResult.handled, true, 'commands are accepted on any channel');
  });

  it('an unknown player is never handled', () => {
    const s = newSession();
    assert.equal(applyIntegratedChat(s, 42, 'hi', 'say', 1000).handled, false);
  });

  it('the CMD_RATE_MS guard drops a command burst without an error', () => {
    const s = newSession();
    s.addPlayer(1, 'Ash', 0, 0);
    assert.ok(s.runCommand(1, { name: 'help' }, 10_000).length > 1);
    assert.deepEqual(s.runCommand(1, { name: 'help' }, 10_100), [], 'throttled to nothing');
    assert.ok(s.runCommand(1, { name: 'help' }, 10_300).length > 1);
  });
});

// ---------------------------------------------------------------------------
// vendor
// ---------------------------------------------------------------------------

describe('integrated: vendor buy/sell respects gold and inventory', () => {
  it('lists every catalogue item with dynamic buy and sell prices', () => {
    const s = newSession();
    const stock = s.vendorStock(1000);
    assert.equal(stock.length, 15, '10 items + 5 weapons');
    const shard = stock.find((r) => r.itemId === 'ember-shard')!;
    assert.equal(shard.basePrice, 5);
    assert.equal(shard.buy, 6, 'base 5 * 1.15, ceil');
    assert.equal(shard.sell, 3, 'base 5 * 0.65, floor');
    const token = stock.find((r) => r.itemId === 'ward-token')!;
    assert.equal(token.sell, 0, 'a 0-base quest token is unsellable');
    assert.ok(stock.find((r) => r.itemId === 'caldera-greatsword')!.buy > 0);
    for (const row of stock) assert.ok(row.sell <= row.buy, `${row.itemId}: sell never exceeds buy`);
  });

  it('a successful buy debits exactly the quoted total and credits the bag', () => {
    const s = newSession();
    s.addPlayer(1, 'Ash', 0, 0);
    const before = s.gold(1);
    const out = s.buy(1, 'minor-potion', 2, 1000);
    const ev = ofKind(out, 'vendor-trade')[0]!;
    assert.equal(ev['ok'], true);
    assert.equal(Number(ev['unitPrice']), 18, 'base 15 * 1.15, ceil');
    assert.equal(Number(ev['total']), 36);
    assert.equal(s.gold(1), before - 36);
    assert.equal(countOf(s.inventory(1), 'minor-potion'), 2);
    assert.equal(Number(ofKind(out, 'gold')[0]!['gold']), before - 36);
    assert.equal(ofKind(out, 'inventory')[0]!['gold'], before - 36);
    assert.ok(kinds(out).includes('vendor-stock'), 'the panel refreshes its prices');
  });

  it('refuses a buy the player cannot afford and changes nothing', () => {
    const s = createGameSession({ enabled: true, startGold: 5 });
    s.addPlayer(1, 'poor', 0, 0);
    // The dagger needs level 1, so this fails on gold rather than level.
    const out = s.buy(1, 'wisp-touched-dagger', 1, 1000);
    const ev = ofKind(out, 'vendor-trade')[0]!;
    assert.equal(ev['ok'], false);
    assert.equal(ev['reason'], 'insufficient-gold');
    assert.equal(s.gold(1), 5, 'gold untouched');
    assert.equal(countOf(s.inventory(1), 'wisp-touched-dagger'), 0);
    assert.match(text(out).join(' '), /Not enough gold/);
    // A failed trade must not move the market.
    assert.equal(s.vendorStock(1000).find((r) => r.itemId === 'wisp-touched-dagger')!.buy, 23);
  });

  it('refuses a buy with no room and changes nothing', () => {
    const s = createGameSession({ enabled: true, startGold: 100_000 });
    s.addPlayer(1, 'Ash', 0, 0);
    s.buy(1, 'minor-potion', MAX_SLOTS * MAX_STACK, 1000); // every slot stacked to 99
    const before = s.gold(1);
    assert.equal(s.inventory(1).slots.filter(Boolean).length, MAX_SLOTS);
    assert.equal(countOf(s.inventory(1), 'minor-potion'), MAX_SLOTS * MAX_STACK);
    const out = s.buy(1, 'minor-potion', 1, 2000);
    assert.equal(ofKind(out, 'vendor-trade')[0]!['reason'], 'inventory-full');
    assert.equal(s.gold(1), before, 'no gold was taken for a rejected trade');
    assert.equal(countOf(s.inventory(1), 'minor-potion'), MAX_SLOTS * MAX_STACK);
  });

  it('refuses an unknown item, a bad quantity and an over-level weapon', () => {
    const s = newSession();
    s.addPlayer(1, 'Ash', 0, 0);
    assert.equal(ofKind(s.buy(1, 'sword-of-doom', 1, 1000), 'vendor-trade')[0]!['reason'], 'unknown-item');
    assert.equal(ofKind(s.buy(1, 'ember-shard', 0, 1000), 'vendor-trade')[0]!['reason'], 'bad-qty');
    assert.equal(ofKind(s.buy(1, 'ember-shard', -3, 1000), 'vendor-trade')[0]!['reason'], 'bad-qty');
    // caldera-greatsword needs level 5; the player is level 1.
    assert.equal(ofKind(s.buy(1, 'caldera-greatsword', 1, 1000), 'vendor-trade')[0]!['reason'], 'level-too-low');
    xpToReach(s, 1, 5);
    assert.equal(ofKind(s.buy(1, 'caldera-greatsword', 1, 1000), 'vendor-trade')[0]!['ok'], true);
  });

  it('a successful sell credits the quoted total and removes the stack', () => {
    const s = newSession();
    s.addPlayer(1, 'Ash', 0, 0);
    s.buy(1, 'ember-shard', 10, 1000);
    const before = s.gold(1);
    // Read the live quote first: the earlier buy already moved the market, so
    // the sell price is whatever supply/demand says at this instant.
    const quote = s.vendorStock(2000).find((r) => r.itemId === 'ember-shard')!.sell;
    const out = s.sell(1, 'ember-shard', 4, 2000);
    const ev = ofKind(out, 'vendor-trade')[0]!;
    assert.equal(ev['ok'], true);
    assert.equal(Number(ev['unitPrice']), quote);
    assert.equal(Number(ev['total']), quote * 4);
    assert.equal(s.gold(1), before + quote * 4);
    assert.equal(countOf(s.inventory(1), 'ember-shard'), 6);
  });

  it('refuses to sell what the player does not carry', () => {
    const s = newSession();
    s.addPlayer(1, 'Ash', 0, 0);
    const before = s.gold(1);
    const out = s.sell(1, 'obsidian-chip', 1, 1000);
    assert.equal(ofKind(out, 'vendor-trade')[0]!['reason'], 'player-lacks-item');
    assert.equal(s.gold(1), before);
    s.buy(1, 'obsidian-chip', 1, 2000);
    assert.equal(ofKind(s.sell(1, 'obsidian-chip', 5, 3000), 'vendor-trade')[0]!['reason'], 'player-lacks-item');
    assert.equal(countOf(s.inventory(1), 'obsidian-chip'), 1, 'the rejected sale kept the item');
  });

  it('refuses to sell an unsellable quest token', () => {
    const s = newSession();
    s.addPlayer(1, 'Ash', 0, 0);
    assert.equal(ofKind(s.sell(1, 'ward-token', 1, 2000), 'vendor-trade')[0]!['reason'], 'unsellable');
  });

  it('prices move with demand and with supply, and never cross over', () => {
    const s = newSession();
    s.addPlayer(1, 'whale', 0, 0);
    const ore = () => s.vendorStock(1000).find((r) => r.itemId === 'iron-ore')!;
    const flat = ore();
    assert.deepEqual([flat.index, flat.buy, flat.sell], [0, 7, 3], 'no history = base price');

    // A real buy through the bag moves the market end to end.
    s.buy(1, 'iron-ore', 20, 1000);
    const demanded = ore();
    assert.ok(demanded.buy > flat.buy, 'demand pushes the buy price up');
    assert.ok(demanded.index > 0, 'the demand index is positive');
    assert.ok(demanded.buy <= Math.ceil(6 * 2.5 * 1.15), 'clamped at 250% of base');

    // Seed supply pressure (the same recordTrade the sell path writes).
    for (let i = 0; i < 20; i++) s.recordMarketTrade('iron-ore', 'sell', 20, 3, 2000 + i);
    const flooded = ore();
    assert.ok(flooded.index < 0, 'the supply index is negative');
    assert.ok(flooded.sell < demanded.sell, 'supply pushes the sell price down');
    assert.ok(flooded.sell <= flooded.buy, 'the spread never inverts');
    assert.ok(flooded.sell >= Math.floor(6 * 0.5 * 0.65), 'clamped at 50% of base');
  });

  it('/shop sends the full stock plus a readable price list', () => {
    const s = newSession();
    s.addPlayer(1, 'Ash', 0, 0);
    const out = s.runCommand(1, { name: 'shop' }, 1000);
    assert.equal(ofKind(out, 'vendor-stock').length, 1);
    assert.equal((ofKind(out, 'vendor-stock')[0]!['items'] as unknown[]).length, 15);
    const lines = text(out);
    assert.match(lines[0]!, /you hold 1000g/);
    assert.match(lines.join('\n'), /Ember Shard \(ember-shard\) buy 6g \/ sell 3g/);
    assert.match(lines.join('\n'), /Ward Token \(ward-token\) buy 0g \/ sell n\/a/);
  });

  it('/buy and /sell drive the same economy path', () => {
    const s = newSession();
    s.addPlayer(1, 'Ash', 0, 0);
    assert.equal(ofKind(s.runCommand(1, parseChatCommand('/buy minor-potion 3')!, 1000), 'vendor-trade')[0]!['ok'], true);
    assert.equal(countOf(s.inventory(1), 'minor-potion'), 3);
    assert.equal(ofKind(s.runCommand(1, parseChatCommand('/sell minor-potion 3')!, 2000), 'vendor-trade')[0]!['ok'], true);
    assert.equal(countOf(s.inventory(1), 'minor-potion'), 0);
  });
});

// ---------------------------------------------------------------------------
// tick pipeline + wire contract
// ---------------------------------------------------------------------------

describe('integrated: tick pipeline and the protocol v1 wire contract', () => {
  it('syncs the authoritative view and mirrors the aggregated maxHp', () => {
    const s = newSession();
    s.addPlayer(1, 'Ash', 0, 0);
    xpToReach(s, 1, 3);
    s.spendTalent(1, 'might-1'); // +10 maxHp/rank
    s.spendTalent(1, 'might-2'); // +8 maxHp/rank
    const maxHp = s.stats(1).maxHp;
    assert.equal(maxHp, 100 + 12 * 2 + 10 + 8);
    s.tick(1000, [view(1, 7, 8, 55, maxHp)]);
    assert.deepEqual(s.player(1), { id: 1, name: 'p1', x: 7, y: 8, hp: 55, maxHp });
  });

  it('ignores a player the session never registered', () => {
    const s = newSession();
    s.addPlayer(1, 'Ash', 0, 0);
    s.tick(1000, [view(1, 0, 0), view(2, 1, 1)]);
    assert.equal(s.has(1), true);
    assert.equal(s.has(2), false, 'registration stays addPlayer-only');
  });

  it('is silent on a still world and speaks when a member moves', () => {
    const s = newSession();
    const c = clock();
    party(s, [1, 2]);
    formParty(s, [1, 2], c);
    const t = c.now();
    s.tick(t, [view(1, 0, 0), view(2, 1, 0)]);
    assert.deepEqual(s.tick(t + 1, [view(1, 0, 0), view(2, 1, 0)]), [], 'nothing changed, nothing sent');
    const moved = s.tick(t + 2, [view(1, 0, 0), view(2, 6, 0)]);
    assert.ok(kinds(moved).includes('party'));
  });

  it('a member who dies is flagged dead in the party row', () => {
    const s = newSession();
    const c = clock();
    party(s, [1, 2]);
    formParty(s, [1, 2], c);
    s.tick(c.now(), [view(1, 0, 0), view(2, 1, 0, 0)]);
    assert.equal(s.party(1)!.members.find((m) => m.playerId === 2)!.dead, true);
  });

  it('tickIntegrated is the functional wrapper around GameSession.tick', () => {
    const s = newSession();
    s.addPlayer(1, 'Ash', 0, 0);
    assert.deepEqual(tickIntegrated(s, 5000, [view(1, 1, 1)]), []);
    assert.equal(s.player(1)!.x, 1);
  });

  it('every output is a protocol v1 event or chat frame', () => {
    const s = newSession();
    const c = clock();
    party(s, [1, 2]);
    formParty(s, [1, 2], c);
    s.buy(1, 'ember-shard', 3, c.now());
    s.sell(1, 'ember-shard', 1, c.now());
    s.emote(1, 'cheer', c.now());
    s.awardXp(1, 400, c.now());
    s.spendTalent(1, 'might-1');
    s.say(1, 'hello', c.now());
    s.runCommand(1, { name: 'shop' }, c.now());
    const all: IntegratedOut[] = [
      ...s.addPlayer(9, 'newbie', 0, 0),
      ...s.tick(c.now(), [view(1, 0, 0), view(2, 1, 0)]),
    ];
    assert.ok(all.length > 0);
    for (const o of all) {
      const wire = o.type === 'chat'
        ? { t: 'chat', from: o.from, text: o.text, channel: o.channel }
        : { t: 'event', kind: o.kind, payload: o.payload };
      const json = JSON.parse(JSON.stringify(wire)) as { t: string; kind?: string; channel?: string };
      assert.ok(json.t === 'event' || json.t === 'chat');
      if (json.t === 'event') {
        assert.equal(typeof json.kind, 'string');
        assert.ok(json.kind!.length > 0);
      } else {
        assert.ok(json.channel === 'say' || json.channel === 'global' || json.channel === 'guild');
      }
      if (o.type === 'event' && o.recipients) {
        assert.ok(o.recipients.every((r) => Number.isInteger(r) && r > 0), 'recipient ids are player ids');
      }
    }
  });

  it('exposes the tuning constants the docs and the server banner quote', () => {
    assert.equal(START_GOLD, 250);
    assert.equal(MELEE_BASE_DMG, 12);
    assert.equal(PARTY_SYNC_MS, 500);
    assert.equal(typeof GAME_SESSION_MARKER, 'string');
    assert.ok(COMMAND_REFERENCE.length >= 14);
    // The command grammar the client mirrors is the same object: every
    // documented command line must parse to a real command, not `unknown`.
    // Probe the usage half of each line (before the "—" description) with the
    // `<placeholder>` slots filled in, because `/invite`, `/p`, `/emote`,
    // `/buy` and `/equip` all reject a bare invocation with no argument —
    // handing the parser only the head verb would test nothing but that.
    const probe = (line: string): ChatCommand | null => {
      const usage = (line.split('—')[0] ?? '').trim();
      const filled = usage
        .split(/\s+/)
        .filter((t) => t.length > 0 && t !== '·')
        .map((t) => (/^<.+>$/.test(t) ? 'x' : t))
        .join(' ');
      return parseChatCommand(filled);
    };
    const unknown = COMMAND_REFERENCE.map((l) => ({ line: l, cmd: probe(l) })).filter(
      (p) => p.cmd === null || p.cmd.name === 'unknown',
    );
    assert.deepEqual(
      unknown.map((p) => p.line),
      [],
      'every documented command parses',
    );
  });
});
