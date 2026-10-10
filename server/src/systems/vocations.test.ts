// Vocations: 4 original callings (melee tank / ranged skirmisher / fire
// caster / holy support). Stat curves monotonic per level, signature
// cooldown (12s) enforced, starting kits valid, favored-branch discount.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { weaponDef } from '../game/content.js';
import { maskDef } from '../game/masks.js';
import { createGameSession, parseChatCommand, type GameSession, type IntegratedOut } from '../game/integrated.js';
import { countOf } from '../game/inventory.js';
import {
  BASE_STATS,
  MAX_LEVEL,
  PER_LEVEL_STATS,
  SIGNATURE_COOLDOWN_MS,
  STAT_KEYS,
  VOCATION_DISCOUNT,
  VOCATIONS,
  aggregateStats,
  branchRanks,
  cumulativeXpForLevel,
  isVocationId,
  perLevelFor,
  signatureReady,
  signatureRetryMs,
  skillNode,
  talentPointsForLevel,
  talentRankCost,
  vocationDef,
} from './progression.js';

function ofKind(out: IntegratedOut[], kind: string): Array<Record<string, unknown>> {
  const acc: Array<Record<string, unknown>> = [];
  for (const o of out) if (o.type === 'event' && o.kind === kind) acc.push(o.payload);
  return acc;
}

function text(out: IntegratedOut[]): string[] {
  return ofKind(out, 'sys-msg').map((p) => String(p.text));
}

function newSession(): GameSession {
  return createGameSession({ enabled: true, startGold: 5000 });
}

function clock(): { now: () => number } {
  let t = 1_000_000;
  return { now: () => (t += 10_000) };
}

/** Enough XP to reach `level`, granted in one lump. */
function xpToReach(s: GameSession, pid: number, level: number): void {
  s.awardXp(pid, cumulativeXpForLevel(level), 0);
}

describe('vocations: 4 original callings', () => {
  it('has the four roles with distinct ids, names and favored branches', () => {
    assert.equal(VOCATIONS.length, 4);
    assert.deepEqual(
      VOCATIONS.map((v) => v.role).sort(),
      ['fire caster', 'holy support', 'melee tank', 'ranged skirmisher'],
    );
    assert.equal(new Set(VOCATIONS.map((v) => v.id)).size, 4);
    assert.equal(new Set(VOCATIONS.map((v) => v.name)).size, 4);
    for (const v of VOCATIONS) {
      assert.ok(['might', 'guile', 'will'].includes(v.favoredBranch), `${v.id}: bad branch`);
      assert.ok(v.description.length >= 8, `${v.id} needs a real description`);
      assert.equal(v.signature.cooldownMs, SIGNATURE_COOLDOWN_MS);
      assert.ok(v.signature.id.length > 0 && v.signature.name.length > 0);
      assert.equal(vocationDef(v.id)?.name, v.name);
      assert.ok(isVocationId(v.id));
    }
    assert.equal(vocationDef('nope'), undefined);
    assert.equal(isVocationId('might-1'), false);
    assert.equal(SIGNATURE_COOLDOWN_MS, 12_000);
    assert.equal(VOCATION_DISCOUNT, 0.2);
  });

  it('starting kits resolve to a real weapon and a real mask', () => {
    for (const v of VOCATIONS) {
      assert.ok(weaponDef(v.startingWeapon), `${v.id}: unknown weapon ${v.startingWeapon}`);
      assert.ok(maskDef(v.startingMask), `${v.id}: unknown mask ${v.startingMask}`);
    }
  });

  it('signature effects are well-formed', () => {
    const kinds = VOCATIONS.map((v) => v.signature.effect.kind).sort();
    assert.deepEqual(kinds, ['heal', 'heal', 'smite', 'volley']);
    for (const v of VOCATIONS) {
      const e = v.signature.effect;
      if (e.kind === 'heal') assert.ok(e.amount > 0);
      if (e.kind === 'volley') assert.ok(e.range > 0 && e.bonusDmg >= 0);
      if (e.kind === 'smite') assert.ok(e.bonusDmg > 0);
    }
  });
});

describe('vocations: stat curves are monotonic per level', () => {
  it('every key stat never decreases from 1 to MAX_LEVEL', () => {
    const keys = ['maxHp', 'maxMp', 'attackPower', 'spellPower', 'might', 'guile', 'will'] as const;
    for (const v of VOCATIONS) {
      let prev: Record<string, number> | null = null;
      for (let level = 1; level <= MAX_LEVEL; level++) {
        const s = aggregateStats(level, {}, [], BASE_STATS, perLevelFor(v.id));
        for (const k of keys) {
          if (prev) assert.ok(s[k] >= prev[k]!, `${v.id} Lv${level}: ${k} regressed`);
        }
        prev = { ...s };
      }
    }
  });

  it('each calling outgrows level 1 in its signature stats', () => {
    const grown = (id: string, key: (typeof STAT_KEYS)[number]): void => {
      const l1 = aggregateStats(1, {}, [], BASE_STATS, perLevelFor(id));
      const cap = aggregateStats(MAX_LEVEL, {}, [], BASE_STATS, perLevelFor(id));
      assert.ok(cap[key] > l1[key], `${id}: ${key} grows overall`);
    };
    grown('dawnwarden', 'maxHp');
    grown('dawnwarden', 'blockChance');
    grown('galehunter', 'attackPower');
    grown('galehunter', 'moveSpeed');
    grown('pyrecantor', 'spellPower');
    grown('pyrecantor', 'maxMp');
    grown('vesperal', 'maxHp');
    grown('vesperal', 'spellPower');
  });

  it('per-level curves are non-negative and vocation-flavored', () => {
    for (const v of VOCATIONS) {
      for (const k of STAT_KEYS) assert.ok(v.perLevel[k] >= 0, `${v.id}: negative ${k}`);
    }
    assert.ok(vocationDef('dawnwarden')!.perLevel.maxHp > vocationDef('pyrecantor')!.perLevel.maxHp, 'tank outgrows caster HP');
    assert.ok(vocationDef('pyrecantor')!.perLevel.spellPower > vocationDef('dawnwarden')!.perLevel.spellPower, 'caster outgrows tank spellpower');
    assert.ok(vocationDef('galehunter')!.perLevel.attackPower > vocationDef('vesperal')!.perLevel.attackPower, 'skirmisher outgrows support attack');
    assert.equal(perLevelFor(null), PER_LEVEL_STATS);
    assert.equal(perLevelFor('nope'), PER_LEVEL_STATS, 'unknown vocation falls back to the legacy curve');
  });
});

describe('vocations: favored-branch discount (20% = every 5th rank free)', () => {
  it('unfavored ranks always cost full price', () => {
    const node = skillNode('might-1')!;
    for (const after of [1, 2, 3, 4, 5, 10]) {
      assert.equal(talentRankCost(node, 'galehunter', after), node.costPerRank, 'guile calling pays full for might');
      assert.equal(talentRankCost(node, null, after), node.costPerRank);
      assert.equal(talentRankCost(node, undefined, after), node.costPerRank);
    }
  });

  it('favored ranks are free exactly every 5th', () => {
    const node = skillNode('might-1')!;
    for (const after of [1, 2, 3, 4, 6, 9]) {
      assert.equal(talentRankCost(node, 'dawnwarden', after), 1, `rank ${after} costs 1`);
    }
    assert.equal(talentRankCost(node, 'dawnwarden', 5), 0, '5th rank free');
    assert.equal(talentRankCost(node, 'dawnwarden', 10), 0, '10th rank free');
    const apex = skillNode('might-5')!;
    assert.equal(talentRankCost(apex, 'dawnwarden', 4), 2);
    assert.equal(talentRankCost(apex, 'dawnwarden', 5), 0, 'the discount applies to apex costs too');
  });

  it('branchRanks counts purchased ranks per branch', () => {
    assert.equal(branchRanks({ 'might-1': 3, 'might-2': 2, 'guile-1': 1 }, 'might'), 5);
    assert.equal(branchRanks({ 'might-1': 3, 'guile-1': 1 }, 'will'), 0);
    assert.equal(branchRanks({}, 'guile'), 0);
  });

  it('five favored ranks cost four points end to end', () => {
    const s = newSession();
    s.addPlayer(1, 'ash', 0, 0);
    s.chooseVocation(1, 'dawnwarden');
    xpToReach(s, 1, 5);
    assert.equal(s.talentPoints(1), talentPointsForLevel(5));
    for (const node of ['might-1', 'might-1', 'might-1', 'might-2', 'might-2']) {
      const out = s.spendTalent(1, node);
      assert.ok(ofKind(out, 'talent-learned').length > 0, `learned ${node}`);
    }
    assert.equal(s.progression(1)!.talents['might-1'], 3);
    assert.equal(s.progression(1)!.talents['might-2'], 2);
    assert.equal(s.talentPoints(1), talentPointsForLevel(5) - 4, '5 ranks for 4 points');
    // Control: an unfavored rank still costs full price.
    const before = s.talentPoints(1);
    const out = s.spendTalent(1, 'guile-1');
    assert.ok(ofKind(out, 'talent-learned').length > 0);
    assert.equal(s.talentPoints(1), before - 1);
  });
});

describe('vocations: signature cooldown (12s)', () => {
  it('ready when never used; gated for 12s after firing', () => {
    const t = 1_000_000;
    assert.equal(signatureReady(undefined, t), true);
    assert.equal(signatureRetryMs(undefined, t), 0);
    assert.equal(signatureReady(t, t), false);
    assert.equal(signatureRetryMs(t, t), 12_000);
    assert.equal(signatureReady(t, t + 11_999), false);
    assert.equal(signatureReady(t, t + 12_000), true);
    assert.equal(signatureRetryMs(t, t + 12_000), 0);
    assert.equal(signatureReady(NaN, t), true, 'garbage timestamps fail open');
  });

  it('session: needs a calling, needs slot 1, then enforces the cooldown', () => {
    const s = newSession();
    const c = clock();
    s.addPlayer(1, 'ash', 0, 0);
    assert.match(text(s.useSignature(1, 1, c.now()).out)[0]!, /calling first/);
    s.chooseVocation(1, 'vesperal');
    assert.match(text(s.useSignature(1, 2, c.now()).out)[0]!, /slot 1/);
    const t = c.now();
    const first = s.useSignature(1, 1, t);
    assert.equal(first.ok, true);
    assert.deepEqual(first.effect, { kind: 'heal', amount: 40 });
    const ev = ofKind(first.out, 'signature')[0]!;
    assert.equal(ev['vocation'], 'vesperal');
    assert.equal(ev['signature'], 'vesper-benediction');
    const again = s.useSignature(1, 1, t + 1000);
    assert.equal(again.ok, false);
    assert.equal(ofKind(again.out, 'signature-denied').length, 1);
    assert.match(text(again.out)[0]!, /recharging/);
    const later = s.useSignature(1, 1, t + 12_000);
    assert.equal(later.ok, true, 'cooldown elapsed');
  });

  it('/sig reports readiness without firing', () => {
    const s = newSession();
    const c = clock();
    s.addPlayer(1, 'ash', 0, 0);
    s.chooseVocation(1, 'pyrecantor');
    assert.match(text(s.runCommand(1, { name: 'sig' }, c.now()))[0]!, /ready/);
    s.useSignature(1, 1, c.now());
    assert.match(text(s.runCommand(1, { name: 'sig' }, c.now()))[0]!, /recharging/);
  });
});

describe('vocations: choice, kits and grammar', () => {
  it('choosing grants the starting weapon + mask once', () => {
    const s = newSession();
    const c = clock();
    s.addPlayer(1, 'ash', 0, 0);
    assert.equal(s.vocation(1), null);
    const out = s.chooseVocation(1, 'galehunter');
    assert.equal(s.vocation(1), 'galehunter');
    assert.equal(ofKind(out, 'vocation')[0]!['role'], 'ranged skirmisher');
    assert.equal(countOf(s.inventory(1), 'wisp-touched-dagger'), 1);
    assert.equal(countOf(s.inventory(1), 'gallow-beak'), 1);
    // Re-swearing changes the calling but grants no second kit.
    s.chooseVocation(1, 'dawnwarden');
    assert.equal(s.vocation(1), 'dawnwarden');
    assert.equal(countOf(s.inventory(1), 'wisp-touched-dagger'), 1, 'no duplicate kit');
    assert.equal(countOf(s.inventory(1), 'ward-blade'), 0, 'no second kit at all');
  });

  it('rejects unknown callings and parses the commands', () => {
    const s = newSession();
    s.addPlayer(1, 'ash', 0, 0);
    assert.match(text(s.chooseVocation(1, 'paladin'))[0]!, /No such calling/);
    assert.deepEqual(parseChatCommand('/vocation'), { name: 'vocation' });
    assert.deepEqual(parseChatCommand('/vocation dawnwarden'), { name: 'vocation', arg: 'dawnwarden' });
    assert.deepEqual(parseChatCommand('/voc pyrecantor'), { name: 'vocation', arg: 'pyrecantor' });
    assert.deepEqual(parseChatCommand('/mask'), { name: 'mask', sub: 'list' });
    assert.deepEqual(parseChatCommand('/mask equip seraph-shard'), { name: 'mask', sub: 'equip', arg: 'seraph-shard' });
    assert.deepEqual(parseChatCommand('/mask unequip'), { name: 'mask', sub: 'unequip' });
    assert.deepEqual(parseChatCommand('/sig'), { name: 'sig' });
  });

  it('leaving the world drops the calling (in-memory only)', () => {
    const s = newSession();
    s.addPlayer(1, 'ash', 0, 0);
    s.chooseVocation(1, 'dawnwarden');
    s.removePlayer(1);
    assert.equal(s.vocation(1), null);
  });

  it('vocation curves flow into aggregated stats and melee', () => {
    const s = newSession();
    s.addPlayer(1, 'ash', 0, 0);
    xpToReach(s, 1, 5);
    const bare = s.stats(1).maxHp;
    s.chooseVocation(1, 'dawnwarden');
    assert.ok(s.stats(1).maxHp > bare, 'tank curve raises maxHp');
    assert.ok(s.meleeDamage(1) >= 12 + (5 - 1) * 3, 'damage never below the legacy curve');
  });
});
