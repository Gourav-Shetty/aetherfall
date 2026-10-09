// social: party (max 5), loot rules, party XP split, proximity chat, emotes.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mulberry32 } from '@aetherfall/shared';
import {
  CHAT_RADIUS,
  EMOTES,
  LOOT_RULES,
  NEARBY_CHAT_MAX_LEN,
  NEARBY_CHAT_RATE_MS,
  PARTY_MAX,
  PARTY_XP_DEAD_FACTOR,
  PARTY_XP_MAX_LEVEL_GAP,
  PARTY_XP_RADIUS,
  createParty,
  emoteDef,
  expireEmotes,
  isEmote,
  isLootRule,
  isLeader,
  joinParty,
  kickParty,
  leaveParty,
  memberOf,
  nearbyChat,
  normalizeLootRule,
  partyChat,
  partySlots,
  planLoot,
  playEmote,
  promoteLeader,
  setLootRule,
  setReady,
  splitPartyXp,
  updateMember,
  type Party,
  type PartyMember,
} from './social.js';

const NOW = 1_700_000_000_000;

function mem(id: number, over: Partial<PartyMember> = {}): PartyMember {
  return { playerId: id, name: `p${id}`, level: 10, pos: { x: 0, y: 0 }, dead: false, ready: false, ...over };
}

function party(n = 1): Party {
  let p = createParty(mem(1), NOW, 42);
  for (let i = 2; i <= n; i++) {
    const r = joinParty(p, p.leaderId, mem(i));
    assert.equal(r.ok, true);
    if (r.ok) p = r.party;
  }
  return p;
}

describe('social party basics', () => {
  it('a new party has one member and the creator is leader', () => {
    const p = createParty(mem(1), NOW, 1);
    assert.equal(p.leaderId, 1);
    assert.equal(p.members.length, 1);
    assert.equal(p.lootRule, 'freeforst');
    assert.equal(isLeader(p, 1), true);
  });

  it('caps at 5 members', () => {
    assert.equal(PARTY_MAX, 5);
    const p = party(5);
    assert.equal(p.members.length, 5);
    assert.equal(partySlots(p), 0);
    const r = joinParty(p, 1, mem(6));
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.equal(r.reason, 'party-full');
  });

  it('joining is leader-approved and leaves the input party untouched', () => {
    const p = party(2);
    const bad = joinParty(p, 2, mem(3));
    assert.equal(bad.ok, false);
    if (bad.ok) return;
    assert.equal(bad.reason, 'not-leader');
    const ok = joinParty(p, 1, mem(3));
    assert.equal(ok.ok, true);
    assert.equal(ok.party.members.length, 3);
    assert.equal(p.members.length, 2, 'input not mutated');
    assert.equal(ok.events[0]?.type, 'party-joined');
  });

  it('rejects self-join, duplicates and big level gaps', () => {
    const p = party(2);
    assert.equal(joinParty(p, 1, mem(1)).ok, false);
    assert.equal(joinParty(p, 1, mem(2)).ok, false);
    const gap = joinParty(p, 1, mem(3, { level: 10 + PARTY_XP_MAX_LEVEL_GAP + 1 }));
    assert.equal(gap.ok, false);
    if (gap.ok) return;
    assert.equal(gap.reason, 'level-gap');
    const ok = joinParty(p, 1, mem(3, { level: 10 + PARTY_XP_MAX_LEVEL_GAP }));
    assert.equal(ok.ok, true);
  });

  it('members stay sorted by player id', () => {
    const p = party(3);
    assert.deepEqual(p.members.map((m) => m.playerId), [1, 2, 3]);
  });
});

describe('social party membership changes', () => {
  it('leader departure promotes the lowest remaining id', () => {
    const p = party(4);
    const r = leaveParty(p, 1);
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.equal(r.party.leaderId, 2);
    assert.equal(r.party.members.length, 3);
    assert.ok(r.events.some((e) => e.type === 'party-leader-changed' && e.leaderId === 2));
    assert.equal(r.value.disbanded, false);
  });

  it('the last member leaving disbands', () => {
    const p = party(1);
    const r = leaveParty(p, 1, 'quit');
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.equal(r.value.disbanded, true);
    assert.equal(r.party.members.length, 0);
    assert.ok(r.events.some((e) => e.type === 'party-disbanded' && e.reason === 'quit'));
  });

  it('a non-leader leaving does not change leadership', () => {
    const p = party(3);
    const r = leaveParty(p, 3);
    if (!r.ok) return;
    assert.equal(r.party.leaderId, 1);
    assert.equal(leaveParty(p, 99).ok, false);
  });

  it('promotion requires the current leader and an existing member', () => {
    const p = party(3);
    assert.equal(promoteLeader(p, 2, 3).ok, false);
    assert.equal(promoteLeader(p, 1, 99).ok, false);
    assert.equal(promoteLeader(p, 1, 1).ok, false);
    const r = promoteLeader(p, 1, 3);
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.equal(r.party.leaderId, 3);
  });

  it('leader kicks non-leaders only', () => {
    const p = party(3);
    assert.equal(kickParty(p, 2, 3).ok, false);
    assert.equal(kickParty(p, 1, 1).ok, false);
    assert.equal(kickParty(p, 1, 99).ok, false);
    const r = kickParty(p, 1, 3);
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.equal(r.party.members.length, 2);
    assert.equal(memberOf(r.party, 3), undefined);
  });

  it('updateMember syncs level/pos/alive without mutating the input', () => {
    const p = party(2);
    const r = updateMember(p, 2, { level: 12.7, pos: { x: 4, y: -2 }, dead: true });
    assert.equal(r.ok, true);
    if (!r.ok) return;
    const m = memberOf(r.party, 2)!;
    assert.equal(m.level, 12);
    assert.deepEqual(m.pos, { x: 4, y: -2 });
    assert.equal(m.dead, true);
    assert.deepEqual(memberOf(p, 2)!.pos, { x: 0, y: 0 });
    assert.equal(updateMember(p, 99, { level: 1 }).ok, false);
  });
});

describe('social loot rules', () => {
  it('exactly three rules, leader-only to change', () => {
    assert.deepEqual([...LOOT_RULES], ['freeforst', 'leader', 'master']);
    assert.equal(isLootRule('leader'), true);
    assert.equal(isLootRule('nope'), false);
    const p = party(3);
    assert.equal(setLootRule(p, 2, 'leader').ok, false);
    const r = setLootRule(p, 1, 'leader');
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.equal(r.party.lootRule, 'leader');
  });

  it('accepts aliases and rejects nonsense', () => {
    assert.equal(normalizeLootRule('FFA'), 'freeforst');
    assert.equal(normalizeLootRule('free-for-all'), 'freeforst');
    assert.equal(normalizeLootRule('LootMaster'), 'master');
    assert.equal(normalizeLootRule('MASTER'), 'master');
    assert.equal(normalizeLootRule('whatever'), null);
    assert.equal(setLootRule(party(2), 1, 'whatever').ok, false);
  });

  it('freeforst spreads stacks across members', () => {
    const p = party(3);
    const plan = planLoot(p, [{ itemId: 'a', qty: 1 }, { itemId: 'b', qty: 2 }], mulberry32(5));
    assert.equal(plan.rule, 'freeforst');
    assert.equal(plan.rolls.length, 2);
    for (const r of plan.rolls) assert.ok([1, 2, 3].includes(r.playerId));
  });

  it('leader gives everything to the leader', () => {
    const p = party(3);
    const set = setLootRule(p, 1, 'leader');
    if (!set.ok) return;
    const plan = planLoot(set.party, [{ itemId: 'a', qty: 1 }, { itemId: 'b', qty: 2 }]);
    assert.equal(plan.rule, 'leader');
    assert.deepEqual(plan.rolls.map((r) => r.playerId), [1, 1]);
  });

  it('master only rolls for ready members', () => {
    const p = party(3);
    const set = setLootRule(p, 1, 'master');
    if (!set.ok) return;
    const ready = setReady(set.party, 2, true);
    if (!ready.ok) return;
    const plan = planLoot(ready.party, [{ itemId: 'a', qty: 1 }, { itemId: 'b', qty: 1 }], mulberry32(3));
    assert.equal(plan.rule, 'master');
    for (const r of plan.rolls) assert.equal(r.playerId, 2, 'only the ready member rolls');
    // nobody ready -> everything pends for the master looter
    const noneReady = planLoot(set.party, [{ itemId: 'c', qty: 1 }], mulberry32(3));
    if (noneReady.rule !== 'master') throw new Error('expected master rule');
    assert.equal(noneReady.pending.length, 1);
    assert.equal(noneReady.rolls.length, 0);
  });

  it('setReady is per-member and rejects outsiders', () => {
    const p = party(2);
    const r = setReady(p, 2, true);
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.equal(memberOf(r.party, 2)!.ready, true);
    assert.equal(memberOf(p, 2)!.ready, false);
    assert.equal(setReady(p, 99, true).ok, false);
  });
});

describe('social party XP split', () => {
  const killer = { playerId: 1, pos: { x: 0, y: 0 }, level: 10 };

  it('splits evenly and exactly (no gold/xp lost)', () => {
    const p = party(4);
    const awards = splitPartyXp(p, 100, killer);
    assert.equal(awards.length, 4);
    assert.equal(awards.reduce((s, a) => s + a.xp, 0), 100);
    for (const a of awards) assert.equal(a.xp, 25);
  });

  it('keeps indivisible remainders on the lowest ids', () => {
    const p = party(3);
    const awards = splitPartyXp(p, 10, killer);
    assert.deepEqual(awards, [
      { playerId: 1, xp: 4 },
      { playerId: 2, xp: 3 },
      { playerId: 3, xp: 3 },
    ]);
  });

  it('excludes members beyond PARTY_XP_RADIUS', () => {
    const p = party(3);
    const far = updateMember(p, 3, { pos: { x: PARTY_XP_RADIUS + 1, y: 0 } });
    if (!far.ok) return;
    const awards = splitPartyXp(far.party, 90, killer);
    assert.deepEqual(awards.map((a) => a.playerId), [1, 2]);
  });

  it('includes members exactly on the radius', () => {
    const p = party(2);
    const edge = updateMember(p, 2, { pos: { x: PARTY_XP_RADIUS, y: 0 } });
    if (!edge.ok) return;
    assert.equal(splitPartyXp(edge.party, 100, killer).length, 2);
  });

  it('dead members take half', () => {
    const p = party(2);
    const dead = updateMember(p, 2, { dead: true });
    if (!dead.ok) return;
    const awards = splitPartyXp(dead.party, 100, killer);
    const total = awards.reduce((s, a) => s + a.xp, 0);
    assert.equal(total, 100);
    const deadShare = awards.find((a) => a.playerId === 2)!;
    assert.ok(deadShare.xp < 50, 'dead member earns less');
    assert.equal(PARTY_XP_DEAD_FACTOR, 0.5);
  });

  it('members more than PARTY_XP_MAX_LEVEL_GAP below the killer get nothing', () => {
    const highKiller = { playerId: 1, pos: { x: 0, y: 0 }, level: 30 };
    const p = party(2);
    const gap = updateMember(p, 2, { level: 30 - PARTY_XP_MAX_LEVEL_GAP - 1 });
    assert.equal(gap.ok, true);
    if (!gap.ok) return;
    assert.deepEqual(splitPartyXp(gap.party, 100, highKiller), [{ playerId: 1, xp: 100 }], 'only the killer earns');
    // exactly on the gap still earns
    const edge = updateMember(p, 2, { level: 30 - PARTY_XP_MAX_LEVEL_GAP });
    if (!edge.ok) return;
    assert.equal(splitPartyXp(edge.party, 100, highKiller).length, 2);
  });

  it('members ABOVE the killer still earn (no downward penalty)', () => {
    const p = party(2);
    const gap = updateMember(p, 2, { level: 40 });
    assert.equal(gap.ok, true);
    if (!gap.ok) return;
    assert.deepEqual(splitPartyXp(gap.party, 100, killer).map((a) => a.playerId), [1, 2]);
  });

  it('nobody in range: the killer banks it solo', () => {
    const p = createParty(mem(1, { pos: { x: 100, y: 0 } }), NOW, 1);
    assert.deepEqual(splitPartyXp(p, 77, killer), [{ playerId: 1, xp: 77 }]);
  });

  it('zero and negative xp award nothing', () => {
    assert.deepEqual(splitPartyXp(party(3), 0, killer), []);
    assert.deepEqual(splitPartyXp(party(3), -5, killer), []);
  });

  it('a solo party gets the whole amount', () => {
    assert.deepEqual(splitPartyXp(party(1), 33, killer), [{ playerId: 1, xp: 33 }]);
  });
});

describe('social proximity chat (10m radius)', () => {
  const me = { id: 1, pos: { x: 0, y: 0 }, name: 'me' };

  it('radius is 10m and the sender is always included', () => {
    assert.equal(CHAT_RADIUS, 10);
    const r = nearbyChat(me, [me, { id: 2, pos: { x: 10, y: 0 } }, { id: 3, pos: { x: 10.01, y: 0 } }], 'hi', NOW);
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.deepEqual(r.recipients.sort(), [1, 2]);
    assert.equal(r.events[0]?.type, 'nearby-chat');
  });

  it('rejects empty, over-long, rate-limited and lonely messages', () => {
    assert.deepEqual(nearbyChat(me, [me], '   ', NOW), { ok: false, reason: 'empty' });
    assert.deepEqual(nearbyChat(me, [me], 'x'.repeat(NEARBY_CHAT_MAX_LEN + 1), NOW), { ok: false, reason: 'too-long' });
    assert.deepEqual(nearbyChat(me, [me], 'hi', NOW + 500, NOW), { ok: false, reason: 'rate-limited' });
    assert.deepEqual(nearbyChat(me, [{ id: 9, pos: { x: 99, y: 0 } }], 'hi', NOW), { ok: false, reason: 'nobody-nearby' });
  });

  it('accepts again after the 1s rate window', () => {
    assert.equal(NEARBY_CHAT_RATE_MS, 1000);
    assert.equal(nearbyChat(me, [me], 'hi', NOW + 1000, NOW).ok, true);
  });

  it('trims text and names the sender', () => {
    const r = nearbyChat(me, [me], '  hello  ', NOW);
    assert.equal(r.ok, true);
    if (!r.ok) return;
    const ev = r.events[0];
    assert.equal(ev?.type, 'nearby-chat');
    if (ev?.type === 'nearby-chat') {
      assert.equal(ev.text, 'hello');
      assert.equal(ev.name, 'me');
    }
  });

  it('party chat ignores distance but requires membership', () => {
    const p = party(3);
    const ok = partyChat(p, 2, 'pulling');
    assert.equal(ok.ok, true);
    if (!ok.ok) return;
    assert.deepEqual(ok.events[0]?.type, 'party-chat');
    assert.equal(partyChat(p, 99, 'nope').ok, false);
    assert.equal(partyChat(p, 2, '  ').ok, false);
  });
});

describe('social emotes', () => {
  const me = { id: 1, pos: { x: 0, y: 0 }, name: 'me' };

  it('there are exactly 8 emotes with unique ids', () => {
    assert.equal(EMOTES.length, 8);
    assert.equal(new Set(EMOTES.map((e) => e.id)).size, 8);
    for (const e of EMOTES) {
      assert.ok(e.durationMs > 0 && e.radius > 0, `${e.id} needs a bubble`);
      assert.ok(e.label.length > 0);
    }
  });

  it('isEmote / emoteDef resolve only real emotes', () => {
    for (const e of EMOTES) {
      assert.equal(isEmote(e.id), true);
      assert.equal(emoteDef(e.id)?.id, e.id);
    }
    assert.equal(isEmote('juggle'), false);
    assert.equal(emoteDef('juggle'), undefined);
  });

  it('playing an emote reaches everyone inside its radius with an expiry', () => {
    const r = playEmote(me, 'wave', [me, { id: 2, pos: { x: 9, y: 0 } }, { id: 3, pos: { x: 40, y: 0 } }], NOW);
    assert.equal(r.ok, true);
    if (!r.ok) return;
    const ev = r.events[0];
    assert.equal(ev?.type, 'emote');
    if (ev?.type === 'emote') {
      assert.equal(ev.emote, 'wave');
      assert.equal(ev.expiresAt, NOW + 2000);
      assert.deepEqual(ev.recipients.sort(), [1, 2]);
    }
  });

  it('unknown emotes and empty rooms are rejected', () => {
    assert.deepEqual(playEmote(me, 'juggle', [me], NOW), { ok: false, reason: 'unknown-emote' });
    assert.deepEqual(playEmote(me, 'wave', [{ id: 8, pos: { x: 99, y: 0 } }], NOW), { ok: false, reason: 'nobody-nearby' });
  });

  it('expireEmotes sweeps finished bubbles only', () => {
    const bubbles = [
      { id: 'b1', expiresAt: NOW - 1 },
      { id: 'b2', expiresAt: NOW + 500 },
    ];
    assert.deepEqual(expireEmotes(bubbles, NOW), ['b1']);
    assert.deepEqual(expireEmotes(bubbles, NOW + 500), ['b1', 'b2']);
  });
});