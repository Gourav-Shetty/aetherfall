// BT selector (+sequence) tests — `npm test --workspace=@aetherfall/server`.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  Blackboard,
  action,
  condition,
  selector,
  sequence,
} from './behavior.js';

const ok = (name = 'ok') => action(name, () => 'success');
const fail = (name = 'no') => action(name, () => 'failure');
const run = (name = 'run') => action(name, () => 'running');

describe('selector', () => {
  it('picks the first succeeding child', () => {
    const bb = new Blackboard();
    const order: string[] = [];
    const root = selector(
      'root',
      action('a', () => { order.push('a'); return 'failure'; }),
      action('b', () => { order.push('b'); return 'success'; }),
      action('c', () => { order.push('c'); return 'success'; }),
    );
    assert.equal(root.tick(bb), 'success');
    assert.deepEqual(order, ['a', 'b']); // short-circuits, c never runs
  });

  it('fails only when every child fails', () => {
    const bb = new Blackboard();
    const root = selector('root', fail('a'), fail('b'));
    assert.equal(root.tick(bb), 'failure');
  });

  it('propagates running without advancing', () => {
    const bb = new Blackboard();
    let n = 0;
    const root = selector(
      'root',
      action('r', () => { n++; return n < 2 ? 'running' : 'success'; }),
      ok('fallback'),
    );
    assert.equal(root.tick(bb), 'running');
    assert.equal(root.tick(bb), 'success'); // resumed, fallback untouched
    assert.equal(n, 2);
  });

  it('conditions gate branches', () => {
    const bb = new Blackboard();
    bb.set('threat', true);
    const root = selector(
      'root',
      sequence('flee?', condition('low-hp', () => false), ok('flee')),
      sequence('fight?', condition('threat?', (b) => b.get('threat') === true), ok('fight')),
    );
    assert.equal(root.tick(bb), 'success');
  });
});

describe('sequence', () => {
  it('fails fast on first failure', () => {
    const bb = new Blackboard();
    const order: string[] = [];
    const root = sequence(
      'root',
      action('a', () => { order.push('a'); return 'success'; }),
      action('b', () => { order.push('b'); return 'failure'; }),
      action('c', () => { order.push('c'); return 'success'; }),
    );
    assert.equal(root.tick(bb), 'failure');
    assert.deepEqual(order, ['a', 'b']);
  });

  it('succeeds when all children succeed', () => {
    assert.equal(sequence('root', ok(), ok()).tick(new Blackboard()), 'success');
  });

  it('resumes a running child', () => {
    const bb = new Blackboard();
    void run;
    let n = 0;
    const root = sequence(
      'root',
      action('step', () => (++n < 2 ? 'running' : 'success')),
      ok('next'),
    );
    assert.equal(root.tick(bb), 'running');
    assert.equal(root.tick(bb), 'success');
  });
});
