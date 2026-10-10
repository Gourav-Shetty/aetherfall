// Content: zones, items/weapons, spawn tables, quest chain, balance (TTK 3-5).
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  ZONE_DEFS,
  ZONE_IDS,
  dungeonTileKind,
  genThemedDungeon,
  genZonedChunk,
  getZone,
  zoneForChunk,
  zoneTileKind,
  type ZoneId,
} from '@aetherfall/engine';
import { mulberry32 } from '@aetherfall/shared';
import {
  ALL_ITEM_IDS,
  ITEMS,
  MOB_SPAWN_TABLE,
  QUEST_CHAIN,
  QUEST_DIALOGUE,
  WEAPONS,
  ZONE_EXPECTED_BONUS,
  chainOnCollect,
  chainOnExplore,
  chainOnKill,
  ensureChainProgress,
  hitsToKill,
  isQuestUnlocked,
  itemDef,
  meleeDamageFor,
  mobMaxHp,
  rollSpawnForZone,
  ttkHits,
  weaponDef,
  xpForKill,
  xpForNextLevel,
} from './content.js';
import { ELDER_MAREN_NODES, dialogueNodeForQuest } from '../ai/dialogue.js';
import { createQuestState } from './quests.js';
import { spawnMobsForChunk } from './spawner.js';
import { MOBS_PER_CHUNK } from './spawner.js';

describe('content zones (engine worldgen)', () => {
  it('has exactly 3 zones', () => {
    assert.deepEqual([...ZONE_IDS].sort(), ['dungeon', 'meadow', 'volcano']);
  });

  it('meadow near spawn, volcano far out (deterministic)', () => {
    assert.equal(getZone(0, 0), 'meadow');
    assert.equal(getZone(10, 10), 'meadow');
    assert.equal(getZone(500, 0), 'volcano');
    assert.equal(getZone(0, 500), 'volcano');
    assert.equal(getZone(0, 0), getZone(0, 0));
  });

  it('zones have distinct walk tiles', () => {
    const seen = new Map<string, string>();
    for (const id of ZONE_IDS) {
      for (const t of ZONE_DEFS[id].tiles) {
        assert.ok(!seen.has(t), `tile ${t} shared between zones`);
        seen.set(t, id);
      }
    }
  });

  it('zoneTileKind deterministic and within the zone palette', () => {
    for (const id of ZONE_IDS) {
      const a = zoneTileKind(7, -3, id, 1337);
      assert.equal(a, zoneTileKind(7, -3, id, 1337));
      assert.ok(ZONE_DEFS[id].tiles.includes(a), `${a} not in ${id} palette`);
    }
    // Distinct across zones for at least one sample point.
    const kinds = new Set(ZONE_IDS.map((z) => zoneTileKind(11, 5, z, 1337)));
    assert.ok(kinds.size >= 2, 'zone palettes never differ');
  });

  it('genZonedChunk variants align with tiles; deterministic', () => {
    const a = genZonedChunk(0, 0, 16, 1337);
    const b = genZonedChunk(0, 0, 16, 1337);
    assert.deepEqual(a, b);
    assert.equal(a.variants.length, 16);
    assert.equal(a.variants[0]!.length, 16);
    assert.equal(a.zone, zoneForChunk(0, 0, 16, 1337));
  });

  it('themed dungeons carry zone variants', () => {
    const d = genThemedDungeon(24, 20, 42, 'volcano');
    assert.equal(d.zone, 'volcano');
    assert.equal(d.variants.length, 20);
    assert.ok(d.rooms.length >= 1);
    assert.ok(ZONE_DEFS.volcano.tiles.includes(dungeonTileKind(3, 4, 'volcano', 42)));
  });
});

describe('content items + weapons', () => {
  it('10 items + 5 weapons with stats', () => {
    assert.equal(ITEMS.length, 10);
    assert.equal(WEAPONS.length, 5);
    for (const w of WEAPONS) {
      assert.ok(w.damage > 0, `${w.id} needs damage`);
      assert.ok(w.levelReq >= 1);
      assert.ok(ZONE_IDS.includes(w.zone));
    }
    // Damage progression: strictly increasing when sorted.
    const dmg = [...WEAPONS].map((w) => w.damage).sort((a, b) => a - b);
    assert.deepEqual(dmg, [4, 6, 8, 10, 12]);
  });

  it('item/weapon lookup covers all loot ids', () => {
    for (const id of ALL_ITEM_IDS) assert.ok(itemDef(id), `missing def ${id}`);
    assert.equal(weaponDef('ward-blade')?.damage, 6);
    assert.equal(weaponDef('nope'), undefined);
  });
});

describe('content spawn tables + XP/HP curves', () => {
  it('every zone has a weighted mob table', () => {
    for (const z of ZONE_IDS) {
      const t = MOB_SPAWN_TABLE[z];
      assert.ok(t.length >= 3, `${z} table too small`);
      assert.ok(t.every((e) => e.weight > 0 && e.levelMin <= e.levelMax));
    }
  });

  it('rollSpawnForZone stays in-band and deterministic', () => {
    for (const z of ZONE_IDS) {
      const r1 = mulberry32(99);
      const a = rollSpawnForZone(r1, z);
      const r2 = mulberry32(99);
      assert.deepEqual(a, rollSpawnForZone(r2, z));
      const band = MOB_SPAWN_TABLE[z].find((e) => e.name === a.name)!;
      assert.ok(a.level >= band.levelMin && a.level <= band.levelMax);
    }
  });

  it('XP curve is level*100; kills pay 20+10/lvl+zone bonus', () => {
    assert.equal(xpForNextLevel(1), 100);
    assert.equal(xpForNextLevel(3), 300);
    assert.equal(xpForKill('meadow', 1), 30);
    assert.equal(xpForKill('dungeon', 3), 60);
    assert.equal(xpForKill('volcano', 5), 95);
  });

  it('mob HP scales up by zone tier', () => {
    assert.ok(mobMaxHp('meadow', 1) < mobMaxHp('dungeon', 3));
    assert.ok(mobMaxHp('dungeon', 4) < mobMaxHp('volcano', 6));
    assert.ok(mobMaxHp('meadow', 1) < mobMaxHp('meadow', 2));
  });

  it('TTK is 3-5 hits for same-zone matchups', () => {
    const cases: Array<[ZoneId, number, number]> = [
      ['meadow', 1, 0],
      ['meadow', 2, 2],
      ['dungeon', 3, 5],
      ['dungeon', 4, 6],
      ['volcano', 5, 8],
      ['volcano', 8, 12],
    ];
    for (const [zone, mobLvl, bonus] of cases) {
      const ttk = ttkHits(zone, mobLvl, mobLvl, bonus);
      assert.ok(ttk >= 3 && ttk <= 5, `${zone} lvl${mobLvl}+${bonus}: TTK=${ttk}`);
    }
    // Default expected bonuses also hold.
    for (const z of ZONE_IDS) {
      const lvl = ZONE_DEFS[z].levelMin;
      const ttk = ttkHits(z, lvl, lvl, ZONE_EXPECTED_BONUS[z]);
      assert.ok(ttk >= 3 && ttk <= 5, `${z}: TTK=${ttk}`);
    }
    void meleeDamageFor;
    void hitsToKill;
  });
});

describe('content quest chain + Maren dialogue hooks', () => {
  it('5 quests in linear prerequisite order', () => {
    assert.equal(QUEST_CHAIN.length, 5);
    assert.equal(QUEST_CHAIN[0]!.prerequisite, undefined);
    for (let i = 1; i < QUEST_CHAIN.length; i++) {
      assert.equal(QUEST_CHAIN[i]!.prerequisite, QUEST_CHAIN[i - 1]!.id);
    }
    // Mixed kinds across the chain.
    const kinds = new Set(QUEST_CHAIN.map((q) => q.kind));
    assert.ok(kinds.has('kill') && kinds.has('collect') && kinds.has('explore'));
  });

  it('every chain quest hooks to an Elder Maren node', () => {
    const nodeIds = new Set(ELDER_MAREN_NODES.map((n) => n.id));
    for (const q of QUEST_CHAIN) {
      assert.ok(nodeIds.has(q.dialogueNode), `${q.id} -> missing node ${q.dialogueNode}`);
      assert.equal(QUEST_DIALOGUE[q.id], q.dialogueNode);
      assert.equal(dialogueNodeForQuest(q.id), q.dialogueNode);
    }
  });

  it('chain progress is prerequisite-gated', () => {
    const s = createQuestState();
    ensureChainProgress(s);
    // Locked quests accrue nothing even while the chain start completes.
    const first = chainOnKill(s, 6);
    assert.ok(first.some((e) => e.type === 'complete' && (e as { questId: string }).questId === 'ward-spark'));
    assert.equal(s.progress['deep-delvers']!.count, 0);
    assert.equal(s.progress['heart-of-fall']!.count, 0);
    assert.equal(isQuestUnlocked('deep-delvers', (id) => !!s.progress[id]?.done), false);
    // Chain start advances and completes with XP.
    chainOnKill(s, 3);
    assert.equal(s.progress['ward-spark']!.done, true);
    assert.equal(s.xp, 40);
    assert.equal(isQuestUnlocked('ember-road', (id) => !!s.progress[id]?.done), true);
    chainOnCollect(s, 5);
    assert.equal(s.progress['ember-road']!.done, true);
    // Now unlocked: deep-delvers accrues.
    chainOnKill(s, 6);
    assert.equal(s.progress['deep-delvers']!.done, true);
  });

  it('chain explore mirrors distinct-chunk semantics', () => {
    const s = createQuestState();
    ensureChainProgress(s);
    const seen = new Set<string>();
    // Locked while prereqs incomplete.
    assert.deepEqual(chainOnExplore(s, seen, '9,0'), []);
    // Fast-forward prereqs.
    chainOnKill(s, 3);
    chainOnCollect(s, 5);
    chainOnKill(s, 6);
    const seen2 = new Set<string>(['0,0']);
    chainOnExplore(s, seen2, '1,0');
    chainOnExplore(s, seen2, '2,0');
    chainOnExplore(s, seen2, '1,0'); // repeat ignored
    assert.equal(s.progress['chart-the-fall']!.count, 2);
    chainOnExplore(s, seen2, '3,0');
    chainOnExplore(s, seen2, '4,0');
    assert.equal(s.progress['chart-the-fall']!.done, true);
  });
});

describe('content spawner wiring', () => {
  it('chunk mobs use zone tables + zone-scaled HP, deterministic', () => {
    const a = spawnMobsForChunk(0, 0, { seed: 1337 });
    const b = spawnMobsForChunk(0, 0, { seed: 1337 });
    assert.deepEqual(a, b);
    // The count is the world's mob density, not a fixed 4 — assert it against
    // the exported constant so retuning density never breaks this test again.
    assert.equal(a.length, MOBS_PER_CHUNK);
  });

  it('spawned mob HP equals mobMaxHp(zone, level)', () => {
    const mobs = spawnMobsForChunk(0, 0, { seed: 1337 });
    for (const m of mobs) {
      const zone = getZone(m.pos.x, m.pos.y, 1337);
      assert.equal(m.maxHp, mobMaxHp(zone, m.level));
      assert.equal(m.hp, m.maxHp);
      assert.ok(MOB_SPAWN_TABLE[zone].some((e) => e.name === m.name), `${m.name} not in ${zone} table`);
    }
  });
});
