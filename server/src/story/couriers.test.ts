// PARTITION courier dialogue coverage: 5 skippable trees, full option reachability.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createQuestState } from '../game/quests.js';
import { isStaticChapterDone, staticOnCollect, staticOnExplore, staticOnKill } from './chapter.js';
import { PARTITION_MISSION_ORDER } from './chapter-two.js';
import { StaticSceneDialogue } from '../ai/dialogue.js';
import {
  PARTITION_COURIERS,
  PARTITION_DIALOGUE_NODES,
  PARTITION_REVEAL_NODES,
  courierById,
  courierForMission,
  couriersAvailable,
  couriersInOrder,
  nextCourierHint,
  openCourierDialogue,
  openPartitionReveal,
} from './couriers.js';

function finishStatic(): ReturnType<typeof createQuestState> {
  const s = createQuestState();
  staticOnKill(s, 4);
  staticOnCollect(s, 6);
  staticOnKill(s, 6);
  const seen = new Set<string>(['0,0']);
  for (const k of ['1,0', '2,0', '3,0', '4,0']) staticOnExplore(s, seen, k);
  staticOnKill(s, 8);
  assert.equal(isStaticChapterDone(s), true);
  return s;
}

describe('PARTITION couriers', () => {
  it('one courier per mission, original names and landmarks', () => {
    assert.equal(PARTITION_COURIERS.length, 5);
    assert.deepEqual(
      [...couriersInOrder()].map((c) => c.missionId),
      [...PARTITION_MISSION_ORDER],
    );
    const names = new Set(PARTITION_COURIERS.map((c) => c.name));
    assert.equal(names.size, 5);
    assert.equal(new Set(PARTITION_COURIERS.map((c) => c.landmark)).size, 5);
    for (const c of PARTITION_COURIERS) {
      assert.ok(c.rumour.length > 0);
      assert.equal(courierById(c.id)?.name, c.name);
      assert.equal(courierForMission(c.missionId)?.id, c.id);
    }
    assert.equal(courierById('nope'), undefined);
    assert.equal(courierForMission('nope'), undefined);
  });

  it('each tree is 4-6 lines with a skip on every non-end node', () => {
    for (const c of PARTITION_COURIERS) {
      assert.ok(c.nodes.length >= 4 && c.nodes.length <= 6, `${c.id} line count`);
      assert.equal(new Set(c.nodes.map((n) => n.id)).size, c.nodes.length, 'unique node ids');
      for (const n of c.nodes) {
        assert.ok(n.speaker.length > 0);
        assert.ok(n.text.length > 0);
      }
      for (const n of c.nodes.slice(0, -1)) {
        assert.ok(
          n.options.some((o) => o.label.toLowerCase().includes('skip')),
          `${c.id}/${n.id} must offer a skip`,
        );
      }
      assert.equal(c.nodes[c.nodes.length - 1]!.id, c.endId);
    }
  });

  it('all option targets resolve (full tree coverage, no dead links)', () => {
    for (const c of PARTITION_COURIERS) {
      const ids = new Set(c.nodes.map((n) => n.id));
      for (const n of c.nodes) {
        for (const o of n.options) assert.ok(ids.has(o.next), `${n.id} -> missing ${o.next}`);
        // Every branch choice from every node is walkable without throwing.
        for (let i = 0; i < n.options.length; i++) {
          const d = new StaticSceneDialogue(c.nodes, n.id, c.endId);
          d.choose(i);
          assert.ok(d.current().id.length > 0);
        }
      }
    }
  });

  it('advance() reaches the end and skip() jumps straight there', () => {
    for (const c of PARTITION_COURIERS) {
      const d = new StaticSceneDialogue(c.nodes, c.startId, c.endId);
      const seen: string[] = [d.current().id];
      for (let i = 0; i < 8 && !d.isAtEnd; i++) seen.push(d.advance().id);
      assert.equal(d.isAtEnd, true, `${c.id} advance should terminate`);
      assert.ok(seen.includes(c.nodes[1]!.id), `${c.id} second line was read`);
      const quick = openCourierDialogue(c.id)!;
      assert.equal(quick.isAtEnd, false);
      quick.skip();
      assert.equal(quick.isAtEnd, true);
      assert.equal(quick.current().id, c.endId);
    }
    assert.equal(openCourierDialogue('nope'), null);
  });

  it('couriers click in with STATIC and go quiet as their mission completes', () => {
    assert.deepEqual(couriersAvailable(createQuestState()), [], 'no couriers before STATIC');
    assert.equal(nextCourierHint(createQuestState()), null);
    const s = finishStatic();
    const live = couriersAvailable(s);
    assert.equal(live.length, 5);
    assert.equal(nextCourierHint(s)!.missionId, 'partition-dead-air');
    // Mark one mission done: its courier stops offering a hint.
    s.progress['partition-dead-air']!.done = true;
    assert.equal(couriersAvailable(s).length, 4);
    assert.equal(nextCourierHint(s)!.missionId, 'partition-call-log');
    for (const id of PARTITION_MISSION_ORDER) s.progress[id]!.done = true;
    assert.deepEqual(couriersAvailable(s), []);
    assert.equal(nextCourierHint(s), null);
  });

  it('no borrowed proper nouns in courier copy', () => {
    const banned = ['hotline', 'miami', 'tibia', 'bvard', 'richard', 'biker'];
    const blob = PARTITION_COURIERS.flatMap((c) => [
      c.name,
      c.rumour,
      ...c.nodes.flatMap((n) => [n.speaker, n.text, ...n.options.map((o) => o.label)]),
    ])
      .join('\n')
      .toLowerCase();
    for (const b of banned) assert.ok(!blob.includes(b), `borrowed text: ${b}`);
  });
});

describe('PARTITION twist reveal dialogue', () => {
  it('5-line reveal is skippable and fully linked', () => {
    assert.equal(PARTITION_REVEAL_NODES.length, 5);
    const ids = new Set(PARTITION_REVEAL_NODES.map((n) => n.id));
    assert.equal(ids.size, 5);
    for (const n of PARTITION_REVEAL_NODES.slice(0, -1)) {
      assert.ok(n.options.some((o) => o.label.toLowerCase().includes('skip')));
    }
    for (const n of PARTITION_REVEAL_NODES) {
      for (const o of n.options) assert.ok(ids.has(o.next), `${n.id} -> missing ${o.next}`);
    }
  });

  it('names the Collator, Maren and the borrowed-voice twist', () => {
    const blob = PARTITION_REVEAL_NODES.flatMap((n) => [
      n.text,
      ...n.options.map((o) => o.label),
    ]).join(' ');
    assert.ok(blob.includes('Maren'));
    assert.ok(blob.includes('Wren was the lock'));
    assert.ok(blob.includes('first four calls were mine in her voice'));
    const d = openPartitionReveal();
    while (!d.isAtEnd) d.advance();
    assert.match(d.current().text, /Warden of the Quiet/);
    const quick = openPartitionReveal();
    quick.skip();
    assert.equal(quick.isAtEnd, true);
  });

  it('dialogue registry covers couriers + reveal', () => {
    const ids = new Set(PARTITION_DIALOGUE_NODES.map((n) => n.id));
    for (const n of PARTITION_COURIERS.flatMap((c) => c.nodes)) assert.ok(ids.has(n.id));
    for (const n of PARTITION_REVEAL_NODES) assert.ok(ids.has(n.id));
    assert.equal(PARTITION_DIALOGUE_NODES.length, PARTITION_COURIERS.length * 5 + 5);
  });
});
