// Bosses: Ember Wyrm + Crypt Warden phase transitions, boss loot, balance.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mulberry32 } from '@aetherfall/shared';
import { CryptWardenBoss, EmberWyrmBoss, damageBoss, type BossTarget } from './bosses.js';
import { ALL_ITEM_IDS, BOSS_KILL_XP, bossDuoTtkSec, bossZoneFor, meleeDamageFor, ttkHits, xpForBossKill } from '../game/content.js';
import { applyBossKillRewards } from '../game/loot.js';
import { createQuestState } from '../game/quests.js';
import { NPCManager, _resetNpcIds } from './npc.js';
import { createGameState, ensurePlayer, onBossKilled } from '../game/index.js';

const P = (x: number, y: number): BossTarget => ({ id: 1, x, y, hp: 100 });

function stepWyrmToCharge(w: EmberWyrmBoss, tx: number, ty: number) {
  for (let i = 0; i < 200 && w.phase !== 'chargeWindup'; i++) w.update(0.1, [P(tx, ty)]);
  assert.equal(w.phase, 'chargeWindup');
}

describe('ember wyrm', () => {
  it('charges along a telegraphed line then leaves a fire pool', () => {
    const w = new EmberWyrmBoss(0, 0);
    assert.equal(w.phase, 'chase');
    const evts = w.update(0.1, [P(5, 0)]);
    assert.ok(evts.some((e) => e.kind === 'move'));
    stepWyrmToCharge(w, 5, 0);
    // charge windup already emitted the line; finish it
    const out: string[] = [];
    for (let i = 0; i < 50 && (w.phase as string) === 'chargeWindup'; i++) {
      for (const e of w.update(0.1, [P(5, 0)])) out.push(e.kind);
    }
    assert.equal(w.phase, 'recover');
    assert.ok(out.includes('move'), 'dash moves');
    assert.ok(out.includes('damage'), 'impact lands');
    assert.ok(out.includes('pool'), 'fire pool spawns');
  });

  it('charge event carries line geometry with a visible windup', () => {
    const w = new EmberWyrmBoss(0, 0);
    stepWyrmToCharge(w, 5, 0);
    // rewind: fresh wyrm, capture the charge event itself
    const w2 = new EmberWyrmBoss(0, 0);
    let charge = null as null | { x1: number; y1: number; x2: number; y2: number; width: number; ttlMs: number };
    for (let i = 0; i < 200 && !charge; i++) {
      for (const e of w2.update(0.1, [P(5, 0)])) {
        if (e.kind === 'charge') charge = e;
      }
    }
    assert.ok(charge, 'charge telegraph emitted');
    assert.ok(charge.ttlMs > 0);
    assert.ok(charge.width > 0);
    assert.ok(Math.hypot(charge.x2 - charge.x1, charge.y2 - charge.y1) > 0);
  });

  it('enraged wyrm drops two pools with a bigger, faster charge', () => {
    const w = new EmberWyrmBoss(0, 0);
    w.hp = 100; // <30% of 3200
    assert.ok(w.enraged);
    stepWyrmToCharge(w, 5, 0);
    const kinds: string[] = [];
    let pools = 0;
    for (let i = 0; i < 50 && (w.phase === 'chargeWindup' || pools === 0); i++) {
      for (const e of w.update(0.1, [P(5, 0)])) {
        kinds.push(e.kind);
        if (e.kind === 'pool') {
          pools += 1;
          assert.ok(e.r > 0 && e.ttlMs > 0 && e.tickDamage > 0);
        }
      }
      if (w.phase === 'recover' && pools > 0) break;
    }
    assert.equal(pools, 2);
  });

  it('dead wyrm emits nothing', () => {
    const w = new EmberWyrmBoss(0, 0);
    w.hp = 0;
    assert.deepEqual(w.update(0.1, [P(5, 0)]), []);
  });
});

describe('crypt warden', () => {
  it('slams with the golem circle telegraph shape', () => {
    const w = new CryptWardenBoss(0, 0);
    let tele = null as null | { shape: string; r: number; ttlMs: number; label: string };
    for (let i = 0; i < 100 && !tele; i++) {
      for (const e of w.update(0.1, [P(3, 0)])) {
        if (e.kind === 'telegraph') tele = e;
      }
    }
    assert.ok(tele, 'slam telegraph emitted');
    assert.equal(tele.shape, 'circle');
    assert.equal(tele.label, 'warden-slam');
    // finish windup -> damage -> recover -> chase
    for (let i = 0; i < 50 && w.phase !== 'recover'; i++) w.update(0.1, [P(3, 0)]);
    assert.equal(w.phase, 'recover');
    for (let i = 0; i < 50 && (w.phase as string) !== 'chase'; i++) w.update(0.1, [P(3, 0)]);
    assert.equal(w.phase, 'chase');
  });

  it('summons 2 husks on its timer', () => {
    const w = new CryptWardenBoss(0, 0, { summonCooldown: 1.0 });
    let summons = 0;
    for (let i = 0; i < 30 && summons === 0; i++) {
      for (const e of w.update(0.1, [P(10, 0)])) {
        if (e.kind === 'summon') {
          summons += 1;
          assert.equal(e.name, 'crypt-husk');
        }
      }
    }
    assert.equal(summons, 2);
    assert.equal(w.summonsSpawned, 2);
  });

  it('shields at 66% and 33%, immune via takeDamage, then drops', () => {
    const w = new CryptWardenBoss(0, 0, { shieldSec: 1.0, summonCooldown: 999 });
    assert.equal(w.takeDamage(800), 800); // 2200 -> 1400 (<66%)
    let evts = w.update(0.1, [P(10, 0)]);
    assert.equal(w.phase, 'shield');
    assert.ok(evts.some((e) => e.kind === 'shield' && e.on === true));
    assert.equal(evts.filter((e) => e.kind === 'summon').length, 2);
    assert.equal(w.takeDamage(100), 0, 'shield blocks');
    assert.equal(w.hp, 1400);
    for (let i = 0; i < 50 && w.phase === 'shield'; i++) evts = w.update(0.1, [P(10, 0)]);
    assert.equal(w.phase, 'chase');
    assert.ok(evts.some((e) => e.kind === 'shield' && e.on === false));
    // second threshold
    assert.ok(w.takeDamage(800) > 0); // 1400 -> 600 (<33%)
    evts = w.update(0.1, [P(10, 0)]);
    assert.equal(w.phase, 'shield');
    assert.ok(evts.some((e) => e.kind === 'shield' && e.on === true));
    for (let i = 0; i < 50 && w.phase === 'shield'; i++) w.update(0.1, [P(10, 0)]);
    assert.equal(w.phase, 'chase');
    assert.ok(w.takeDamage(50) > 0, 'vulnerable after shields');
  });

  it('dead warden emits nothing and takes no damage', () => {
    const w = new CryptWardenBoss(0, 0);
    w.hp = 0;
    assert.equal(w.takeDamage(10), 0);
    assert.deepEqual(w.update(0.1, [P(3, 0)]), []);
  });
});

/** Player id used by grindToDeath (matches the PlayerView list it is handed). */
const GRIND_KILLER = 42;

/**
 * Sit on top of `name` and keep swinging until it dies; returns the boss-kill
 * events the manager reported for that death.
 */
function grindToDeath(
  npcs: NPCManager,
  players: Array<{ id: number; x: number; y: number; hp: number }>,
  name: string,
): Extract<ReturnType<NPCManager['tick']>[number], { kind: 'boss-kill' }>[] {
  const kills: Array<Extract<ReturnType<NPCManager['tick']>[number], { kind: 'boss-kill' }>> = [];
  for (let i = 0; i < 4000 && kills.length === 0; i++) {
    npcs.tick(0.1, players);
    const b = npcs.snapshot().find((e) => e.name === name);
    if (b) {
      players[0]!.x = b.p.x;
      players[0]!.y = b.p.y;
      npcs.damageFromPlayer(b.p.x, b.p.y, 200, GRIND_KILLER);
    }
    for (const e of npcs.tick(0.1, players)) if (e.kind === 'boss-kill') kills.push(e);
  }
  return kills;
}

describe('boss loot + achievements', () => {
  it('boss kill pays 200XP with a boss-kill achievement', () => {
    const s = createQuestState();
    const r = applyBossKillRewards(s, 'ember-wyrm', 10, 20, mulberry32(11));
    assert.equal(r.xp, 200);
    assert.equal(r.xp, BOSS_KILL_XP);
    assert.equal(xpForBossKill(), 200);
    assert.deepEqual(r.achievement, { type: 'boss-kill', boss: 'ember-wyrm', xp: 200 });
    assert.equal(r.boss, 'ember-wyrm');
    assert.ok(s.xp >= 200 - 100, 'kill XP landed in state');
  });

  it('boss loot roll is deterministic with sane ids; pickups mirror drops', () => {
    const a = applyBossKillRewards(createQuestState(), 'crypt-warden', 10, 20, mulberry32(7));
    const b = applyBossKillRewards(createQuestState(), 'crypt-warden', 10, 20, mulberry32(7));
    assert.deepEqual(a.drops, b.drops);
    assert.ok(a.drops.length > 0, 'boss always showers materials');
    for (const d of a.drops) assert.ok(ALL_ITEM_IDS.includes(d.itemId), `unknown ${d.itemId}`);
    assert.equal(a.pickups.length, a.drops.length);
    assert.deepEqual(
      a.pickups.map((p) => `${p.itemId}x${p.count}`).sort(),
      a.drops.map((d) => `${d.itemId}x${d.count}`).sort(),
    );
  });

  it('bosses live in their tuning zones', () => {
    assert.equal(bossZoneFor('ember-wyrm'), 'volcano');
    assert.equal(bossZoneFor('crypt-warden'), 'dungeon');
  });

  it('onBossKilled emits achievement + XP + corpse pickups into game state', () => {
    const game = createGameState(1337);
    const p = ensurePlayer(game, 7, 'duo-tank', 10, 20);
    const before = p.quests.xp;
    const evs = onBossKilled(game, 7, 'ember-wyrm', 10, 20, mulberry32(5));
    const bossKill = evs.find((e) => e.kind === 'boss-kill');
    assert.ok(bossKill, 'boss-kill achievement event emitted');
    assert.deepEqual(bossKill!.payload, { playerId: 7, boss: 'ember-wyrm', xp: 200, x: 10, y: 20 });
    const xpGain = evs.find((e) => e.kind === 'xp-gain');
    assert.equal((xpGain!.payload as { amount: number }).amount, BOSS_KILL_XP);
    assert.ok(p.quests.xp > before, 'XP landed on the killer');
    assert.ok(game.pickups.length > 0, 'boss table dropped corpse pickups');
    // uncredited kills (adds / no attacker) pay nothing
    assert.deepEqual(onBossKilled(game, 999, 'ember-wyrm', 10, 20), []);
  });
});

describe('boss spawn + wire (NPCManager)', () => {
  it('all four bosses are instantiated; new two stay dormant until approached', () => {
    _resetNpcIds();
    const npcs = new NPCManager();
    const names = npcs.snapshot().map((e) => e.name);
    assert.ok(names.includes('Stone Golem') && names.includes('Void Wisp'), 'arena fixtures awake');
    assert.ok(!names.includes('Ember Wyrm'), 'wyrm dormant at boot');
    assert.ok(!names.includes('Crypt Warden'), 'warden dormant at boot');
    // approach the wyrm anchor (86,16) -> it spawns into the world
    const near = [{ id: 1, x: 86, y: 20, hp: 100 }];
    npcs.tick(0.1, near);
    assert.ok(npcs.snapshot().some((e) => e.name === 'Ember Wyrm'), 'wyrm woke on approach');
    assert.ok(!npcs.snapshot().some((e) => e.name === 'Crypt Warden'), 'warden still dormant');
    const nearWarden = [{ id: 1, x: 14, y: 86, hp: 100 }];
    npcs.tick(0.1, nearWarden);
    assert.ok(npcs.snapshot().some((e) => e.name === 'Crypt Warden'), 'warden woke on approach');
  });

  it('every outgoing telegraph fits the client envelope (circle, r<=30, ttl<=5000)', () => {
    _resetNpcIds();
    const npcs = new NPCManager();
    const players = [{ id: 1, x: 86, y: 20, hp: 100 }, { id: 2, x: 14, y: 86, hp: 100 }];
    let telegraphs = 0;
    let charges = 0;
    for (let i = 0; i < 900; i++) {
      for (const e of npcs.tick(0.1, players)) {
        if (e.kind !== 'telegraph') continue;
        telegraphs++;
        assert.equal(e.shape, 'circle', 'client/src/telegraph.ts only accepts circles');
        assert.ok(e.r > 0 && e.r <= 30, `r ${e.r} outside 0..30`);
        assert.ok(e.ttlMs > 0 && e.ttlMs <= 5000, `ttlMs ${e.ttlMs} outside 0..5000`);
        assert.ok(e.label.length > 0 && e.label.length <= 64);
        if (e.label === 'wyrm-charge') charges++;
      }
    }
    assert.ok(telegraphs > 20, `boss telegraphs seen (${telegraphs})`);
    assert.ok(charges >= 4, `charge line rasterized to circles (${charges})`);
  });

  it('wyrm fire pools burn and warden husks actually spawn', () => {
    _resetNpcIds();
    const npcs = new NPCManager();
    // stand at both anchors so each lazy boss wakes
    const players = [{ id: 1, x: 86, y: 20, hp: 100 }, { id: 2, x: 14, y: 86, hp: 100 }];
    const baseline = npcs.npcCount();
    let poolDamage = 0;
    let summons = 0;
    for (let i = 0; i < 900; i++) {
      for (const e of npcs.tick(0.1, players)) {
        // fromId 0 == fire pool (NPCs use their own id)
        if (e.kind === 'damage-player' && e.fromId === 0) poolDamage++;
        if (e.kind === 'telegraph' && e.label === 'warden-husk') summons++;
      }
    }
    assert.ok(summons > 0, 'warden summoned husks');
    assert.ok(npcs.npcCount() > baseline, 'husks joined the world');
    assert.ok(poolDamage > 0, 'fire pools tick damage on players standing in them');
  });

  it('boss death emits exactly one boss-kill, then respawns / goes dormant', () => {
    _resetNpcIds();
    const npcs = new NPCManager();
    assert.equal(npcs.snapshot().find((e) => e.name === 'Ember Wyrm'), undefined, 'dormant at boot');
    const players = [{ id: 42, x: 86, y: 20, hp: 100 }];
    npcs.tick(0.1, players);
    assert.ok(npcs.snapshot().some((e) => e.name === 'Ember Wyrm'), 'woke on approach');

    const first = grindToDeath(npcs, players, 'Ember Wyrm');
    assert.equal(first.length, 1, 'exactly one boss-kill event');
    assert.equal(first[0]!.boss, 'ember-wyrm');
    assert.equal(first[0]!.killedBy, 42, 'killer credited for the loot payout');
    assert.ok(Number.isFinite(first[0]!.x) && Number.isFinite(first[0]!.y));
    assert.ok(npcs.snapshot().some((e) => e.name === 'Ember Wyrm'), 'corpse still visible');

    // corpse clears, and a camper on the anchor gets an instant full-HP respawn
    for (let i = 0; i < 25; i++) npcs.tick(0.1, players);
    const respawned = npcs.snapshot().find((e) => e.name === 'Ember Wyrm');
    assert.ok(respawned, 'respawned for the camper');
    assert.equal(respawned!.hp, 3200, 'respawn is at full HP');

    // kill it again, then leave the arena: the slot goes dormant and stays cheap
    const second = grindToDeath(npcs, players, 'Ember Wyrm');
    assert.equal(second.length, 1, 'second death emits its own boss-kill');
    const away = [{ id: 42, x: 50, y: 50, hp: 100 }];
    for (let i = 0; i < 60; i++) npcs.tick(0.1, away);
    assert.ok(!npcs.snapshot().some((e) => e.name === 'Ember Wyrm'), 'despawned to dormant');
    // ...and comes back when a player returns to the anchor
    npcs.tick(0.1, [{ id: 42, x: 86, y: 20, hp: 100 }]);
    assert.ok(npcs.snapshot().some((e) => e.name === 'Ember Wyrm'), 'spawns again on return');
  });

  it('warden shield blocks player damage while raised', () => {
    _resetNpcIds();
    const npcs = new NPCManager();
    const players = [{ id: 9, x: 14, y: 86, hp: 100 }];
    npcs.tick(0.1, players);
    const w = npcs.snapshot().find((e) => e.name === 'Crypt Warden')!;
    assert.ok(w);
    players[0]!.x = w.p.x;
    players[0]!.y = w.p.y;
    const hp0 = w.hp;
    npcs.damageFromPlayer(w.p.x, w.p.y, 50, 9);
    assert.ok(npcs.snapshot().find((e) => e.name === 'Crypt Warden')!.hp <= hp0);
    // drive it to the 66% threshold and confirm the shield window eats damage
    for (let i = 0; i < 400; i++) {
      const b = npcs.snapshot().find((e) => e.name === 'Crypt Warden');
      if (!b) break;
      if (b.hp / b.maxHp <= 0.66) {
        npcs.damageFromPlayer(b.p.x, b.p.y, 10, 9);
        break;
      }
      npcs.damageFromPlayer(b.p.x, b.p.y, 200, 9);
      npcs.tick(0.1, players);
    }
    const shielded = npcs.snapshot().find((e) => e.name === 'Crypt Warden');
    if (shielded) {
      const hp1 = shielded.hp;
      npcs.damageFromPlayer(shielded.p.x, shielded.p.y, 100, 9);
      assert.equal(npcs.snapshot().find((e) => e.name === 'Crypt Warden')!.hp, hp1, 'immune while shielded');
    }
  });
});

describe('boss balance', () => {
  it('normal TTK still 3-5 hits', () => {
    assert.ok(ttkHits('meadow', 1, 1, 0) >= 3 && ttkHits('meadow', 1, 1, 0) <= 5);
    assert.ok(ttkHits('dungeon', 4, 4, 6) >= 3 && ttkHits('dungeon', 4, 4, 6) <= 5);
    assert.ok(ttkHits('volcano', 8, 8, 12) >= 3 && ttkHits('volcano', 8, 8, 12) <= 5);
  });

  it('boss defaults land in the 60-90s duo window', () => {
    const wyrm = new EmberWyrmBoss(0, 0);
    const warden = new CryptWardenBoss(0, 0);
    assert.equal(wyrm.maxHp, 3200);
    assert.equal(warden.maxHp, 2200);
    const wyrmTtk = bossDuoTtkSec(wyrm.maxHp, 7, 10); // volcano duo, +10 expected
    const wardenTtk = bossDuoTtkSec(warden.maxHp, 4, 6); // dungeon duo, +6 expected
    assert.ok(wyrmTtk >= 60 && wyrmTtk <= 90, `wyrm ${wyrmTtk}s`);
    // warden raw + 2x4.5s shields + add cleanup lands in-window (see fightSim)
    assert.ok(wardenTtk + 9 >= 60 && wardenTtk + 9 <= 90, `warden ${wardenTtk}s+shields`);
  });

  // --- headless controller sim (see docs/WORLD.md "Boss TTK budget") ----------
  // Real FSM, real shields, real add pressure. `uptime` is the fraction of the
  // fight the duo spends actually swinging (the rest is telegraph dodging).
  it('integrated 10Hz sim: both bosses die in 60-90s to a volcano/dungeon duo', () => {
    const cases: Array<{
      name: string;
      make: () => EmberWyrmBoss | CryptWardenBoss;
      level: number;
      bonus: number;
      huskHp: number;
      shieldSec: number;
    }> = [
      { name: 'Ember Wyrm', make: () => new EmberWyrmBoss(0, 0), level: 7, bonus: 10, huskHp: 0, shieldSec: 0 },
      { name: 'Ember Wyrm (lvl6/+8)', make: () => new EmberWyrmBoss(0, 0), level: 6, bonus: 8, huskHp: 0, shieldSec: 0 },
      { name: 'Crypt Warden', make: () => new CryptWardenBoss(0, 0), level: 4, bonus: 6, huskHp: 35, shieldSec: 4.5 },
      { name: 'Crypt Warden (lvl5/+6)', make: () => new CryptWardenBoss(0, 0), level: 5, bonus: 6, huskHp: 35, shieldSec: 4.5 },
    ];
    const results: string[] = [];
    for (const c of cases) {
      for (const uptime of [0.45, 0.5]) {
        const sec = fightSim(c.make(), {
          players: 2,
          damage: meleeDamageFor(c.level, c.bonus),
          uptime,
          huskHp: c.huskHp,
          shieldSec: c.shieldSec,
        });
        results.push(`${c.name} up=${uptime} -> ${sec}s`);
        assert.ok(sec >= 60 && sec <= 90, `${c.name} duo TTK ${sec}s outside 60-90s`);
      }
    }
    // numbers land in WORLD.md; keep them visible in test output
    assert.ok(results.length === 8);
  });
});

interface FightOpts {
  players: number;
  damage: number;
  uptime: number;
  huskHp: number;
  shieldSec: number;
}

/**
 * Headless duo-vs-boss sim at the NPC tick rate (10Hz). The duo is modelled as
 * glued to the boss (melee range is never the limiter); `uptime` is the only
 * dodge cost. Adds soak damage before the boss and shield windows soak time,
 * both of which are part of the Warden's TTK budget.
 */
function fightSim(ctl: EmberWyrmBoss | CryptWardenBoss, o: FightOpts): number {
  const SWING = 0.8; // combat.ATTACK_COOLDOWN_MS
  const DT = 0.1; // index.ts ticks npcs every other 20Hz sim tick
  const targets: BossTarget[] = Array.from({ length: o.players }, (_, i) => ({
    id: i + 1, x: ctl.x + 2, y: ctl.y, hp: 100,
  }));
  const dps = ((o.players * o.damage) / SWING) * o.uptime;
  const adds: Array<{ hp: number }> = [];
  let shielded = false;
  let shieldLeft = 0;
  let t = 0;
  while (t < 300) {
    for (const tg of targets) { tg.x = ctl.x + 2; tg.y = ctl.y; }
    for (const e of ctl.update(DT, targets)) {
      if (e.kind === 'summon') adds.push({ hp: o.huskHp });
      else if (e.kind === 'shield') { shielded = e.on; if (e.on) shieldLeft = o.shieldSec; }
    }
    let dealt = dps * DT;
    for (const a of adds) {
      if (dealt <= 0) break;
      const take = Math.min(a.hp, dealt);
      a.hp -= take;
      dealt -= take;
    }
    for (let i = adds.length - 1; i >= 0; i--) if (adds[i]!.hp <= 0) adds.splice(i, 1);
    if (shielded) {
      shieldLeft -= DT;
      if (shieldLeft <= 0) shielded = false;
      dealt = 0;
    }
    if (dealt > 0) damageBoss(ctl, dealt);
    t += DT;
    if (ctl.hp <= 0) break;
  }
  return Math.round(t * 10) / 10;
}
