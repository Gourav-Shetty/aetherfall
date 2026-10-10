// STATIC calls + parole/reveal dialogue coverage.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  STATIC_CALLS,
  UNKNOWN_CALLER,
  callForMission,
  callerShownIn,
  callsInOrder,
  isTwistCall,
} from './calls.js';
import { STATIC_CALLER_IDENTITY, STATIC_MISSION_ORDER } from './chapter.js';
import {
  STATIC_DIALOGUE_NODES,
  STATIC_PAROLE_A_NODES,
  STATIC_PAROLE_B_NODES,
  STATIC_REVEAL_NODES,
  StaticSceneDialogue,
} from '../ai/dialogue.js';

describe('STATIC calls', () => {
  it('5 voicemails, one per mission, in order', () => {
    assert.equal(STATIC_CALLS.length, 5);
    assert.deepEqual(callsInOrder().map((c) => c.missionId), STATIC_MISSION_ORDER);
    for (const id of STATIC_MISSION_ORDER) {
      const c = callForMission(id);
      assert.ok(c, `missing call for ${id}`);
      assert.equal(c!.from, UNKNOWN_CALLER);
      assert.ok(c!.lines.length >= 4, `${id} voicemail too short`);
      assert.ok(c!.durationSec > 0);
    }
    assert.equal(callForMission('nope'), undefined);
  });

  it('all copy is original (no borrowed proper nouns)', () => {
    const banned = ['hotline', 'miami', 'tibia', 'bvard', ' jacket', 'richard', 'biker'];
    const blob = STATIC_CALLS.flatMap((c) => c.lines).join('\n').toLowerCase();
    for (const b of banned) assert.ok(!blob.includes(b), `borrowed text: ${b}`);
  });

  it('pre-twist calls stay anonymous; mission 5 names the caller', () => {
    for (const c of STATIC_CALLS) {
      if (c.missionId === 'static-exchange') {
        assert.equal(isTwistCall(c.missionId), true);
        assert.equal(callerShownIn(c), STATIC_CALLER_IDENTITY.name);
        assert.ok(c.lines.join(' ').includes(STATIC_CALLER_IDENTITY.name));
      } else {
        assert.equal(isTwistCall(c.missionId), false);
        assert.equal(callerShownIn(c), UNKNOWN_CALLER);
        assert.ok(!c.lines.join(' ').includes(STATIC_CALLER_IDENTITY.name), `${c.missionId} leaks the twist`);
      }
    }
  });

  it('twist identity ties to Maren + the Fall (lore-anchored, original)', () => {
    assert.ok(STATIC_CALLER_IDENTITY.name.length > 0);
    assert.ok(STATIC_CALLER_IDENTITY.role.toLowerCase().includes('maren'));
    assert.ok(STATIC_CALLER_IDENTITY.revealLine.includes(STATIC_CALLER_IDENTITY.name));
  });
});

describe('STATIC parole dialogue trees', () => {
  it('each parole is exactly 6 lines with two speakers, skippable', () => {
    for (const [nodes, a, b] of [
      [STATIC_PAROLE_A_NODES, 'Bram Vey', 'Sella Qinn'],
      [STATIC_PAROLE_B_NODES, 'Pale Odo', 'Tilda Vess'],
    ] as const) {
      assert.equal(nodes.length, 6, '6-line tree');
      const speakers = new Set(nodes.map((n) => n.speaker));
      assert.ok(speakers.has(a) && speakers.has(b), 'both NPCs speak');
      for (const n of nodes.slice(0, -1)) {
        assert.ok(n.options.some((o) => o.label.toLowerCase().includes('skip')), `${n.id} must offer a skip`);
      }
    }
  });

  it('parole A walks end to end via advance()', () => {
    const d = new StaticSceneDialogue(STATIC_PAROLE_A_NODES, 'parole-a-0', 'parole-a-end');
    const seen: string[] = [d.current().id];
    for (let i = 0; i < 8 && !d.isAtEnd; i++) seen.push(d.advance().id);
    assert.equal(d.isAtEnd, true);
    assert.ok(seen.includes('parole-a-2'));
    assert.equal(d.current().speaker, 'Sella Qinn');
  });

  it('parole B skip() jumps straight to the end', () => {
    const d = new StaticSceneDialogue(STATIC_PAROLE_B_NODES, 'parole-b-0', 'parole-b-end');
    assert.equal(d.isAtEnd, false);
    d.skip();
    assert.equal(d.isAtEnd, true);
    assert.equal(d.current().id, 'parole-b-end');
  });

  it('every parole option target resolves (full tree coverage)', () => {
    for (const nodes of [STATIC_PAROLE_A_NODES, STATIC_PAROLE_B_NODES, STATIC_REVEAL_NODES]) {
      const ids = new Set(nodes.map((n) => n.id));
      for (const n of nodes) {
        for (const o of n.options) assert.ok(ids.has(o.next), `${n.id} -> missing ${o.next}`);
      }
      // Walk every branch choice from every node without throwing.
      for (const n of nodes) {
        const d = new StaticSceneDialogue(nodes, n.id, nodes[nodes.length - 1]!.id);
        for (let i = 0; i < d.current().options.length; i++) {
          const probe = new StaticSceneDialogue(nodes, n.id, nodes[nodes.length - 1]!.id);
          probe.choose(i);
          assert.ok(probe.current().id.length > 0);
        }
      }
    }
  });

  it('reveal names Wren and grants the mask line', () => {
    assert.equal(STATIC_REVEAL_NODES.length, 4);
    const blob = STATIC_REVEAL_NODES.map((n) => n.text).join(' ');
    assert.ok(blob.includes('Wren Halloway'));
    assert.ok(blob.toLowerCase().includes('receiver'));
    const d = new StaticSceneDialogue(STATIC_REVEAL_NODES, 'reveal-0', 'reveal-end');
    while (!d.isAtEnd) d.advance();
    assert.match(d.current().text, /Callerbound/);
  });

  it('STATIC dialogue registry covers all scenes', () => {
    const ids = new Set(STATIC_DIALOGUE_NODES.map((n) => n.id));
    for (const n of [...STATIC_PAROLE_A_NODES, ...STATIC_PAROLE_B_NODES, ...STATIC_REVEAL_NODES]) {
      assert.ok(ids.has(n.id));
    }
    assert.equal(STATIC_DIALOGUE_NODES.length, 6 + 6 + 4);
  });
});
