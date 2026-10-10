// PLAYABILITY strike team — NPC visibly-alive acceptance.
// Patrols move, a bot 8u ahead in the cone is acquired in <=3s and hit in
// <=10s, and kited minions leash home.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { NPCManager, _resetNpcIds, type PlayerView } from './npc.js';
import { LEASH_RANGE } from './npc.js';

const DT = 0.1;

/** Fresh manager + an isolated probe at (50,50) facing +X (patrol -> +X). */
function probeWorld() {
  _resetNpcIds();
  const npcs = new NPCManager();
  const probe = npcs.spawnMinion('probe', 50, 50, [{ x: 50, y: 50 }, { x: 60, y: 50 }]);
  return { npcs, probe };
}

describe('npc visibly alive: patrols move and face travel', () => {
  it('minions leave their spawn on patrol with a live facing', () => {
    _resetNpcIds();
    const npcs = new NPCManager();
    const ids = npcs.minionIds();
    assert.ok(ids.length >= 3);
    const before = new Map(ids.map((id) => [id, npcs.debugMinion(id)!]));
    for (let i = 0; i < 50; i++) npcs.tick(DT, []); // 5s, no players
    for (const id of ids) {
      const a = before.get(id)!;
      const b = npcs.debugMinion(id)!;
      const moved = Math.hypot(b.x - a.x, b.y - a.y);
      assert.ok(moved > 2, `minion ${id} patrol-moved only ${moved.toFixed(2)}u in 5s`);
      assert.ok(Number.isFinite(b.facing), 'facing is a real angle');
      assert.ok(b.state === 'patrol' || b.state === 'idle', `state ${b.state} is a calm state`);
    }
  });
});

describe('npc visibly alive: 8u cone acquisition in 3s, hit in 10s', () => {
  it('acquires and lands a hit (bot holds 8u ahead, shifting weight)', () => {
    const { npcs, probe } = probeWorld();
    const m = npcs.debugMinion(probe)!;
    // 8u dead ahead of the initial facing. The bot holds position (stands)
    // but shifts weight (vx 0.6 > MOVE_SPEED_EPS 0.5) so the moving-or-close
    // leg sees it — a perfectly frozen statue beyond 4u is sneak-hidden by
    // design (see alert.test.ts "sneak works").
    const bx = m.x + Math.cos(m.facing) * 8;
    const by = m.y + Math.sin(m.facing) * 8;
    const bot: PlayerView = { id: 1, x: bx, y: by, hp: 100, vx: 0.6, vy: 0 };
    let acquiredAt = -1;
    let hitAt = -1;
    let hitAmount = 0;
    for (let i = 0; i < 100; i++) {
      const ev = npcs.tick(DT, [{ ...bot }]);
      const st = npcs.debugMinion(probe)!.state;
      if (acquiredAt < 0 && (st === 'chase' || st === 'attack')) acquiredAt = i;
      for (const e of ev) {
        if (e.kind === 'damage-player' && (e as { targetId: number }).targetId === 1) {
          if (hitAt < 0) {
            hitAt = i;
            hitAmount = (e as { amount: number }).amount;
          }
        }
      }
      if (hitAt >= 0) break;
    }
    assert.ok(acquiredAt >= 0, 'never acquired the 8u target');
    assert.ok(acquiredAt * DT <= 3, `acquired in ${(acquiredAt * DT).toFixed(1)}s (>3s)`);
    assert.ok(hitAt >= 0, 'acquired but never landed a hit');
    assert.ok(hitAt * DT <= 10, `first hit in ${(hitAt * DT).toFixed(1)}s (>10s)`);
    assert.ok(hitAmount >= 6 && hitAmount <= 14, `hit ${hitAmount} outside 6-14`);
  });

  it('spawn-protected bots are never targeted nor hit', () => {
    const { npcs, probe } = probeWorld();
    const m = npcs.debugMinion(probe)!;
    const bx = m.x + Math.cos(m.facing) * 8;
    const by = m.y + Math.sin(m.facing) * 8;
    const now = 50_000;
    for (let i = 0; i < 30; i++) {
      const ev = npcs.tick(
        DT,
        [{ id: 1, x: bx, y: by, hp: 100, vx: 0.6, vy: 0, spawnProtectedUntil: now + 60_000 }],
        now + i * 100,
      );
      assert.ok(!ev.some((e) => e.kind === 'damage-player'), 'protected bot took a hit');
      assert.ok(npcs.debugMinion(probe)!.state !== 'chase', 'protected bot was chased');
      assert.ok(npcs.debugMinion(probe)!.state !== 'attack', 'protected bot was attacked');
    }
  });
});

describe('npc visibly alive: leash returns home', () => {
  it(`a minion ${LEASH_RANGE}u+ from home drops aggro and walks back`, () => {
    _resetNpcIds();
    const npcs = new NPCManager();
    // Kited spawn: body 30u from its anchor (home 50,50), target adjacent.
    const kited = npcs.spawnMinion('kited', 80, 50, [{ x: 50, y: 50 }, { x: 60, y: 50 }]);
    const d0 = Math.hypot(80 - 50, 50 - 50);
    assert.ok(d0 > LEASH_RANGE, 'setup is beyond the leash');
    const bot: PlayerView = { id: 1, x: 82, y: 50, hp: 100, vx: 1, vy: 0 };
    for (let i = 0; i < 20; i++) {
      const ev = npcs.tick(DT, [{ ...bot }]);
      assert.ok(!ev.some((e) => e.kind === 'damage-player'), 'leashed minion must not hit');
      const st = npcs.debugMinion(kited)!.state;
      assert.ok(st !== 'chase' && st !== 'attack', `leashed state ${st} still hunting`);
    }
    const mid = npcs.debugMinion(kited)!;
    // Walks home over the next 10s (patrol branch drives to the anchor).
    for (let i = 0; i < 100; i++) npcs.tick(DT, []);
    const end = npcs.debugMinion(kited)!;
    const dMid = Math.hypot(mid.x - 50, mid.y - 50);
    const dEnd = Math.hypot(end.x - 50, end.y - 50);
    assert.ok(dEnd < dMid, `leash did not return home (${dMid.toFixed(1)}u -> ${dEnd.toFixed(1)}u)`);
  });
});
