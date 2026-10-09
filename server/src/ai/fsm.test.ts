// FSM transition tests — `npm test --workspace=@aetherfall/server`.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { NPCFSM, nextState, type FSMPerception } from './fsm.js';

const base: FSMPerception = {
  hp: 100,
  maxHp: 100,
  targetVisible: false,
  distToTarget: Infinity,
  attackRange: 1.8,
  aggroRange: 14,
  fleeThreshold: 0.25,
};

const seen = (dist: number): FSMPerception => ({
  ...base, targetVisible: true, distToTarget: dist,
});

describe('fsm transitions', () => {
  it('idle -> patrol after dwell expires', () => {
    assert.equal(nextState('idle', { ...base, idleTime: 0 }), 'idle');
    assert.equal(nextState('idle', { ...base, idleTime: 2.0 }), 'patrol');
  });

  it('idle/patrol acquire targets: chase, or attack when adjacent', () => {
    assert.equal(nextState('idle', seen(10)), 'chase');
    assert.equal(nextState('idle', seen(1.0)), 'attack');
    assert.equal(nextState('patrol', seen(5)), 'chase');
    assert.equal(nextState('patrol', seen(1.5)), 'attack');
  });

  it('chase -> attack in range, -> patrol when target lost', () => {
    assert.equal(nextState('chase', seen(1.2)), 'attack');
    assert.equal(nextState('chase', { ...base }), 'patrol'); // no target
    assert.equal(nextState('chase', seen(40)), 'patrol'); // beyond leash
    assert.equal(nextState('chase', seen(8)), 'chase'); // closing
  });

  it('attack sticks until target clearly escapes', () => {
    assert.equal(nextState('attack', seen(2.0)), 'attack');
    assert.equal(nextState('attack', seen(8)), 'chase');
    assert.equal(nextState('attack', { ...base }), 'patrol');
  });

  it('low hp flees under threat, recovers when safe', () => {
    const weak = { ...seen(6), hp: 10 };
    assert.equal(nextState('chase', weak), 'flee');
    assert.equal(nextState('attack', weak), 'flee');
    assert.equal(nextState('flee', { ...base, hp: 10 }), 'patrol'); // threat gone
    assert.equal(nextState('flee', { ...seen(30), hp: 10 }), 'patrol'); // far enough
    assert.equal(nextState('flee', weak), 'flee'); // still threatened
  });

  it('any living state -> dead at 0 hp, dead is terminal', () => {
    for (const s of ['idle', 'patrol', 'chase', 'attack', 'flee'] as const) {
      assert.equal(nextState(s, { ...seen(1), hp: 0 }), 'dead');
    }
    assert.equal(nextState('dead', base), 'dead');
  });

  it('NPCFSM integrates dwell + transitions over updates', () => {
    const fsm = new NPCFSM('idle', 1.0);
    assert.equal(fsm.update(0.5, base), 'idle');
    assert.equal(fsm.update(0.6, base), 'patrol');
    assert.equal(fsm.update(0.1, seen(3)), 'chase');
    assert.equal(fsm.update(0.1, seen(1)), 'attack');
    assert.equal(fsm.update(0.1, { ...seen(1), hp: 0 }), 'dead');
    assert.ok(fsm.dead);
  });
});
