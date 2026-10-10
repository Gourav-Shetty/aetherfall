// PLAYABILITY strike team — attack reliability acceptance.
// A level-1 bot with the starting Sword walks up to a meadow mob and must
// land a kill within 8 swings (cooldown-honored, finish flow included).
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ATTACK_COOLDOWN_MS } from './combat.js';
import {
  createGameState,
  ensurePlayer,
  playerMeleeAttack,
  setPlayerPos,
} from './index.js';
import { mobMaxHp } from './content.js';

const NO_CRIT = { crit: false as const, rand: () => 0.99 };

/** Swing (honoring cooldown) until killed or the swing budget is spent. */
function swingsToKill(
  game: ReturnType<typeof createGameState>,
  playerId: number,
  startAt: number,
  budget: number,
): { killed: boolean; swings: number } {
  let now = startAt;
  let swings = 0;
  for (let i = 0; i < budget; i++) {
    const r = playerMeleeAttack(game, playerId, now, NO_CRIT);
    if (r.ok) {
      swings++;
      if (r.killed) return { killed: true, swings };
    }
    now += ATTACK_COOLDOWN_MS;
  }
  return { killed: false, swings };
}

describe('attack reliability: level-1 starting Sword kills in <=8 swings', () => {
  it('kills the nearest real spawner mob within 8 swings', () => {
    const game = createGameState(1337);
    ensurePlayer(game, 1, 'hero', 16, 16);
    game.spawner.ensureAround(16, 16, 0);
    const mob = game.spawner.mobsList().find((m) => m.alive)!;
    assert.ok(mob, 'spawner produced a mob');
    // Walk up: park 1.0u away (inside MELEE_RANGE 2.2 + FINISH_RANGE 2.2).
    setPlayerPos(game, 1, mob.pos.x + 1.0, mob.pos.y);
    const { killed, swings } = swingsToKill(game, 1, 1000, 8);
    assert.equal(killed, true, `no kill in 8 swings vs ${mob.name} lvl${mob.level} hp${mob.maxHp}`);
    assert.ok(swings <= 8, `${swings} swings`);
  });

  it('every meadow matchup dies in <=8 swings (worst-case coverage)', () => {
    const cases: Array<{ name: string; level: number }> = [
      { name: 'gloomfang', level: 1 },
      { name: 'gloomfang', level: 2 },
      { name: 'mistwisp', level: 1 },
      { name: 'mistwisp', level: 2 },
      { name: 'thornback', level: 1 },
      { name: 'thornback', level: 2 },
      { name: 'meadow-sprite', level: 1 },
    ];
    for (const c of cases) {
      const game = createGameState(1337);
      ensurePlayer(game, 1, 'hero', 40, 40);
      game.spawner.ensureAround(40, 40, 0);
      const mob = game.spawner.mobsList().find((m) => m.alive)!;
      // Forge the matchup: name/level/HP as cased, at a fixed test tile.
      game.spawner.moveMob(mob.id, 40, 40);
      mob.name = c.name;
      mob.level = c.level;
      mob.maxHp = mobMaxHp('meadow', c.level);
      mob.hp = mob.maxHp;
      setPlayerPos(game, 1, 41, 40);
      const { killed, swings } = swingsToKill(game, 1, 1000, 8);
      assert.equal(killed, true, `${c.name} lvl${c.level} hp${mob.maxHp}: no kill in 8`);
      assert.ok(swings <= 8, `${c.name} lvl${c.level}: ${swings} swings`);
    }
  });

  it('a downed victim is finished even with a healthy mob nearer (no shadow)', () => {
    const game = createGameState(1337);
    ensurePlayer(game, 1, 'hero', 40, 40);
    game.spawner.ensureAround(40, 40, 0);
    const live = game.spawner.mobsList().filter((m) => m.alive);
    assert.ok(live.length >= 2, 'need two mobs for the shadow test');
    const [victim, other] = live;
    // Victim downed at the player's feet, healthy mob even nearer.
    game.spawner.moveMob(victim!.id, 40, 40);
    game.spawner.moveMob(other!.id, 40.2, 40);
    setPlayerPos(game, 1, 40.5, 40);
    // Down the victim directly (bypasses targeting): victim 0.5u, other 0.3u.
    const now = 1000;
    assert.ok(game.spawner.downMob(victim!.id, now), 'setup down failed');
    // Next swing must finish the victim, not chip the nearer healthy mob.
    const fin = playerMeleeAttack(game, 1, now + ATTACK_COOLDOWN_MS, NO_CRIT);
    assert.equal(fin.ok, true);
    assert.equal((fin as { finished?: boolean }).finished, true, 'downed victim finished first');
    assert.equal((fin as { mobId: number }).mobId, victim!.id);
  });
});
