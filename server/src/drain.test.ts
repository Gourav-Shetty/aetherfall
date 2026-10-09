// @aetherfall/server — SIGTERM drain-mode tests.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DRAIN_TIMEOUT_MS, DrainController, drainTimeoutMs, type DrainState } from './drain.js';
import { OpsLog } from './opslog.js';

/** Drain controller with no process signal handlers and a silent sink. */
function make(opts: Partial<ConstructorParameters<typeof DrainController>[0]> = {}) {
  const states: DrainState[] = [];
  const exits: number[] = [];
  const drain = new DrainController({
    install: false,
    exit: (code) => exits.push(code),
    log: new OpsLog({ json: true, write: () => undefined }),
    onState: (s) => states.push(s),
    ...opts,
  });
  return { drain, states, exits };
}

test('DRAIN_TIMEOUT_MS defaults to 5s and honours the env override', () => {
  assert.equal(DRAIN_TIMEOUT_MS, 5000);
  assert.equal(drainTimeoutMs({}), 5000);
  assert.equal(drainTimeoutMs({ DRAIN_TIMEOUT_MS: '1500' }), 1500);
  assert.equal(drainTimeoutMs({ DRAIN_TIMEOUT_MS: '0' }), 5000);
  assert.equal(drainTimeoutMs({ DRAIN_TIMEOUT_MS: 'nonsense' }), 5000);
});

test('starts running and accepting', () => {
  const { drain } = make();
  assert.equal(drain.state, 'running');
  assert.equal(drain.accepting, true);
  assert.equal(drain.drainMs, 0);
  assert.equal(drain.tickInFlight, false);
});

test('steps run in registration order and the report lists them', async () => {
  const order: string[] = [];
  const { drain, states } = make();
  drain.addStep('stop-accepting', () => {
    order.push('stop-accepting');
  });
  drain.addStep('flush-db', async () => {
    order.push('flush-db');
  });
  const report = await drain.shutdown('SIGTERM');
  assert.deepEqual(order, ['stop-accepting', 'flush-db']);
  assert.deepEqual(report.steps, ['stop-accepting', 'flush-db']);
  assert.equal(report.reason, 'SIGTERM');
  assert.equal(report.timedOut, false);
  assert.deepEqual(report.failed, {});
  assert.equal(drain.state, 'stopped');
  assert.equal(drain.accepting, false);
  assert.deepEqual(states, ['draining', 'stopped']);
});

test('addSteps registers from an object in key order', async () => {
  const order: string[] = [];
  const { drain } = make();
  drain.addSteps({
    a: () => void order.push('a'),
    b: () => void order.push('b'),
  });
  const report = await drain.shutdown('test');
  assert.deepEqual(order, ['a', 'b']);
  assert.deepEqual(report.steps, ['a', 'b']);
});

test('a failing step is recorded and does not stop the others', async () => {
  const reached: string[] = [];
  const { drain } = make();
  drain.addStep('boom', () => {
    throw new Error('db exploded');
  });
  drain.addStep('after', () => {
    reached.push('after');
  });
  const report = await drain.shutdown('test');
  assert.deepEqual(reached, ['after']);
  assert.equal(report.failed.boom, 'db exploded');
  assert.deepEqual(report.steps, ['after']);
  assert.equal(drain.state, 'stopped');
});

test('an in-flight tick is waited for before the report resolves', async () => {
  const { drain } = make();
  const seen: string[] = [];
  drain.addStep('stop-accepting', () => void seen.push('stop-accepting'));
  drain.tickStart();
  assert.equal(drain.tickInFlight, true);
  const promise = drain.shutdown('SIGTERM');
  // The tick finishes 20ms later, exactly like a real 50ms tick mid-flight.
  setTimeout(() => {
    seen.push('tick-end');
    drain.tickEnd();
  }, 20);
  const report = await promise;
  assert.deepEqual(seen, ['stop-accepting', 'tick-end']);
  assert.equal(report.timedOut, false);
  assert.ok(report.waitedMs >= 10, `waitedMs=${report.waitedMs}`);
});

test('a tick that never finishes trips the timeout flag and still stops', async () => {
  const { drain } = make({ timeoutMs: 40 });
  drain.tickStart();
  const report = await drain.shutdown('SIGTERM');
  assert.equal(report.timedOut, true);
  assert.equal(drain.state, 'stopped');
  assert.ok(report.waitedMs >= 30, `waitedMs=${report.waitedMs}`);
});

test('a wedged step hits the hard timeout and exits the process', async () => {
  const { drain, exits } = make({ timeoutMs: 30 });
  drain.addStep('hang', () => new Promise<void>(() => undefined));
  // Fire and forget: the step never resolves, so the shutdown promise never
  // settles — exactly the wedged-deploy case the hard deadline exists for.
  void drain.shutdown('SIGTERM');
  await new Promise((r) => setTimeout(r, 90));
  assert.deepEqual(exits, [0], 'hard deadline must exit even with a step still pending');
  assert.equal(drain.state, 'stopped');
});

test('the hard deadline exits exactly once', async () => {
  const { drain, exits } = make({ timeoutMs: 20 });
  drain.addStep('hang', () => new Promise<void>(() => undefined));
  void drain.shutdown('SIGTERM');
  await new Promise((r) => setTimeout(r, 80));
  assert.deepEqual(exits, [0]);
});

test('repeated signals join the in-flight shutdown', async () => {
  const runs: string[] = [];
  const { drain } = make();
  drain.addStep('flush', () => void runs.push('flush'));
  const a = drain.shutdown('SIGTERM');
  const b = drain.shutdown('SIGINT');
  assert.equal(a, b, 'the same shutdown promise is returned');
  await a;
  assert.deepEqual(runs, ['flush'], 'steps run exactly once');
});

test('whenIdle resolves immediately when nothing is running', async () => {
  const { drain } = make();
  await drain.whenIdle();
  drain.tickStart();
  drain.tickStart();
  let resolved = false;
  const p = drain.whenIdle().then(() => {
    resolved = true;
  });
  drain.tickEnd();
  assert.equal(resolved, false, 'still one tick in flight');
  drain.tickEnd();
  await p;
  assert.equal(resolved, true);
});

test('tickEnd is clamped at zero so extra calls cannot go negative', () => {
  const { drain } = make();
  drain.tickEnd();
  drain.tickEnd();
  assert.equal(drain.tickInFlight, false);
});

test('onState failures never block the drain', async () => {
  const { drain } = make({
    onState: () => {
      throw new Error('gauge exploded');
    },
  });
  drain.addStep('flush', () => undefined);
  const report = await drain.shutdown('test');
  assert.equal(drain.state, 'stopped');
  assert.deepEqual(report.steps, ['flush']);
});

test('the drain-begin/drain-complete events are logged', async () => {
  const lines: string[] = [];
  const { drain } = make({
    log: new OpsLog({ json: true, write: (line) => lines.push(line) }),
  });
  drain.addStep('flush', () => undefined);
  await drain.shutdown('SIGTERM');
  const events = lines.map((l) => (JSON.parse(l) as { event?: string }).event).filter(Boolean);
  assert.deepEqual(events, ['drain-begin', 'drain-complete']);
});