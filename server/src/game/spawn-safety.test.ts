// PLAYABILITY strike team — spawn safety acceptance.
// Fresh bot at the world spawn must see no hostiles within 12u (pruned by
// tickGameplay) and must survive 30s idle in >80% of trials.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Sim, SPAWN_PROTECTION_MS } from '../sim.js';
import {
  createGameState,
  ensurePlayer,
  setPlayerPos,
  tickGameplay,
} from './index.js';
import { SPAWN_SAFE_POINTS, SPAWN_SAFE_RADIUS, isSpawnSafeZone } from './spawner.js';
import { NPCManager, _resetNpcIds } from '../ai/npc.js';

function mobsNear(game: ReturnType<typeof createGameState>, x: number, y: number, r: number) {
  return game.spawner.mobsList().filter((m) => Math.hypot(m.pos.x - x, m.pos.y - y) <= r);
}

describe('spawn safety: no hostiles within 12u of spawn', () => {
  it('spawn anchors are (0,0) + (50,50) with a 12u safe radius', () => {
    assert.equal(SPAWN_SAFE_RADIUS, 12);
    assert.ok(SPAWN_SAFE_POINTS.some((p) => p.x === 0 && p.y === 0), 'world spawn covered');
    assert.ok(SPAWN_SAFE_POINTS.some((p) => p.x === 50 && p.y === 50), 'shrine covered');
    assert.equal(isSpawnSafeZone(0, 0), true);
    assert.equal(isSpawnSafeZone(3, 7), true, 'the old 7.6u gloomfang spot is inside');
    assert.equal(isSpawnSafeZone(30, 30), false);
  });

  it('tickGameplay leaves zero mobs within 12u of either anchor', () => {
    const game = createGameState(1337);
    ensurePlayer(game, 1, 'bot', 0, 0);
    tickGameplay(game, 1000);
    // Spawn a wide ring so every chunk around the anchors exists.
    game.spawner.ensureAround(0, 0, 1);
    game.spawner.ensureAround(50, 50, 1);
    tickGameplay(game, 2000);
    for (const a of SPAWN_SAFE_POINTS) {
      const near = mobsNear(game, a.x, a.y, SPAWN_SAFE_RADIUS);
      assert.equal(near.length, 0, `anchor ${a.x},${a.y} has ${near.length} mob(s) inside 12u`);
      // 15u is the MEASUREMENT radius (density + aggro watch): mobs may exist
      // in the 12-15u band, but none may have aggro on a fresh bot at anchor.
      const watch = mobsNear(game, a.x, a.y, 15);
      for (const m of watch) {
        assert.equal(m.targetId, null, `${m.name} has aggro inside the 15u watch ring`);
      }
    }
  });

  it('a single tick never spawns into the disc (spawnChunk filters)', () => {
    const game = createGameState(1337);
    ensurePlayer(game, 1, 'bot', 0, 0);
    const fresh = game.spawner.ensureAround(0, 0, 0);
    for (const m of fresh) {
      assert.equal(isSpawnSafeZone(m.pos.x, m.pos.y), false, `${m.name} spawned inside the safe disc`);
    }
  });

  it('spawn HP is full (Sim 100/100)', () => {
    const sim = new Sim();
    const p = sim.addPlayer(1, 'bot', 0, 0, 1000);
    assert.equal(p.hp, 100);
    assert.equal(p.maxHp, 100);
    assert.equal(p.hp, p.maxHp);
  });

  it('3s spawn protection blocks damage then lapses', () => {
    const sim = new Sim();
    sim.addPlayer(1, 'bot', 0, 0, 1000);
    assert.equal(sim.isSpawnProtected(1, 1000), true);
    assert.equal(sim.damagePlayer(1, 50, 2000), false, 'no damage inside the window');
    assert.equal(sim.players.get(1)!.hp, 100);
    assert.equal(sim.isSpawnProtected(1, 1000 + SPAWN_PROTECTION_MS), false, 'expired at exactly 3s');
    assert.equal(sim.isSpawnProtected(1, 1000 + SPAWN_PROTECTION_MS + 1), false);
    assert.equal(sim.damagePlayer(1, 50, 1000 + SPAWN_PROTECTION_MS + 1), true);
    assert.equal(sim.players.get(1)!.hp, 50);
    assert.equal(sim.spawnProtectionLeft(1, 1000), SPAWN_PROTECTION_MS);
    assert.equal(sim.spawnProtectionLeft(1, 99999), 0);
  });

  it('respawn restores full HP with fresh protection', () => {
    const sim = new Sim();
    sim.addPlayer(1, 'bot', 0, 0, 0);
    sim.damagePlayer(1, 999, 5000);
    sim.players.get(1)!.hp = 10;
    assert.equal(sim.respawnPlayer(1, 50, 50, 6000), true);
    const p = sim.players.get(1)!;
    assert.equal(p.hp, p.maxHp);
    assert.equal(p.x, 50);
    assert.equal(p.y, 50);
    assert.equal(sim.isSpawnProtected(1, 6000), true);
  });
});

describe('spawn safety: fresh bot survives 30s idle in >80% of trials', () => {
  it('10 idle trials at spawn, 10Hz NPC + gameplay ticks, >=8 survive', () => {
    let survived = 0;
    const TRIALS = 10;
    for (let t = 0; t < TRIALS; t++) {
      _resetNpcIds();
      const game = createGameState(1337);
      const px = (t % 3) * 2; // tiny spawn jitter: (0,0),(2,0),(4,0) — all inside the disc
      const py = 0;
      ensurePlayer(game, t + 1, `bot-${t}`, px, py);
      setPlayerPos(game, t + 1, px, py);
      const npcs = new NPCManager();
      const now0 = 100_000 + t * 1000;
      let hp = 100;
      let dead = false;
      // 30s at 10Hz = 300 NPC ticks; gameplay tick each step too.
      for (let i = 0; i < 300; i++) {
        const now = now0 + i * 100;
        tickGameplay(game, now);
        const ev = npcs.tick(0.1, [
          {
            id: t + 1,
            x: px,
            y: py,
            hp,
            spawnProtectedUntil: now0 + SPAWN_PROTECTION_MS,
          },
        ], now);
        for (const e of ev) {
          if (e.kind === 'damage-player' && (e as { targetId: number }).targetId === t + 1) {
            hp = Math.max(0, hp - (e as { amount: number }).amount);
          }
        }
        if (hp <= 0) {
          dead = true;
          break;
        }
      }
      if (!dead && hp > 0) survived++;
    }
    assert.ok(survived >= 8, `only ${survived}/${TRIALS} fresh bots survived 30s idle (need >=8)`);
  });
});
