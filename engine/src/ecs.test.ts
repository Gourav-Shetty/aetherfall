import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { World } from './ecs.js';

describe('ecs basic crud', () => {
  it('spawn/get/set/query/count', () => {
    const w = new World();
    const a = w.spawn({ pos: { x: 1, y: 2 }, hp: { v: 10 } });
    const b = w.spawn({ pos: { x: 3, y: 4 } });
    assert.equal(w.count(), 2);
    assert.deepEqual(w.get(a, 'pos'), { x: 1, y: 2 });
    w.set(a, 'pos', { x: 9, y: 9 });
    assert.deepEqual(w.get(a, 'pos'), { x: 9, y: 9 });
    assert.deepEqual(w.query('pos').sort((x, y) => x - y), [a, b].sort((x, y) => x - y));
    assert.deepEqual(w.query('pos', 'hp'), [a]);
    assert.equal(w.get(b, 'hp'), undefined);
  });

  it('despawn recycles and drops components', () => {
    const w = new World();
    const a = w.spawn({ pos: { x: 1, y: 1 } });
    w.despawn(a);
    assert.equal(w.count(), 0);
    assert.equal(w.alive(a), false);
    assert.equal(w.get(a, 'pos'), undefined);
    assert.deepEqual(w.query('pos'), []);
    w.despawn(a); // double-despawn is a no-op
  });

  it('add/remove/has/componentNames', () => {
    const w = new World();
    const e = w.spawnEmpty();
    assert.equal(w.has(e, 'pos'), false);
    w.add(e, 'pos', { x: 5, y: 5 });
    assert.equal(w.has(e, 'pos'), true);
    assert.deepEqual(w.componentNames(e), ['pos']);
    assert.equal(w.remove(e, 'pos'), true);
    assert.equal(w.remove(e, 'pos'), false);
    assert.equal(w.has(e, 'pos'), false);
    assert.throws(() => w.add(9999, 'pos', { x: 0, y: 0 }), /not alive/);
  });
});

describe('ecs query filters', () => {
  it('exclude + filter predicate', () => {
    const w = new World();
    const a = w.spawn({ pos: { x: 0, y: 0 }, mob: { v: 1 } });
    const b = w.spawn({ pos: { x: 0, y: 0 }, player: { v: 1 } });
    const c = w.spawn({ pos: { x: 0, y: 0 } });
    assert.deepEqual(w.queryWith(['pos'], { exclude: ['mob'] }).sort(), [b, c].sort());
    assert.deepEqual(w.queryWith(['pos'], { filter: (id) => id === c }), [c]);
    assert.deepEqual(w.queryWith([]).sort(), [a, b, c].sort());
    assert.deepEqual(w.queryWith([], { exclude: ['pos'] }), []);
    void a;
  });

  it('view and forEach', () => {
    const w = new World();
    w.spawn({ pos: { x: 1, y: 1 }, hp: { v: 5 } });
    w.spawn({ pos: { x: 2, y: 2 } });
    const v = w.view('pos', 'hp');
    assert.equal(v.length, 1);
    assert.deepEqual(v[0].comps, [{ x: 1, y: 1 }, { v: 5 }]);
    let n = 0;
    w.forEach(['pos'], () => n++);
    assert.equal(n, 2);
  });
});

describe('ecs systems scheduler', () => {
  it('runs in priority order, honors runIf/enable', () => {
    const w = new World();
    const order: string[] = [];
    w.addSystem('late', () => order.push('late'), { priority: 10 });
    w.addSystem('early', () => order.push('early'), { priority: -10 });
    w.addSystem('mid', () => order.push('mid'));
    w.tick(0.05);
    assert.deepEqual(order, ['early', 'mid', 'late']);

    let count = 0;
    w.addSystem('gated', () => count++, { runIf: () => false });
    w.tick(0.05);
    assert.equal(count, 0);
    w.enableSystem('gated', false);
    w.tick(0.05);
    assert.equal(count, 0);
    assert.deepEqual(w.systemNames(), ['early', 'mid', 'gated', 'late']);
    assert.equal(w.removeSystem('gated'), true);
    assert.equal(w.removeSystem('gated'), false);
    assert.throws(() => w.addSystem('early', () => {}), /already registered/);
  });

  it('collects timing stats', () => {
    const w = new World();
    w.addSystem('s', () => {});
    w.tick(0.016);
    const [st] = w.systemStats();
    assert.equal(st.runs, 1);
    assert.ok(st.lastMs >= 0 && st.totalMs >= 0);
  });
});

describe('ecs snapshot', () => {
  it('serialize/deserialize round-trip', () => {
    const w = new World();
    const a = w.spawn({ pos: { x: 1, y: 2 }, hp: { v: 7 } });
    w.spawn({ tag: { name: 'mob' } });
    const snap = w.serialize();
    // Snapshot must be JSON-safe and deep-copied.
    const json = JSON.parse(JSON.stringify(snap));
    snap.entities[0].comps['pos'] = { x: -999, y: -999 };
    assert.notDeepEqual(json.entities[0].comps['pos'], { x: -999, y: -999 });

    const w2 = new World();
    w2.deserialize(json);
    assert.equal(w2.count(), 2);
    assert.deepEqual(w2.get(a, 'pos'), { x: 1, y: 2 });
    assert.deepEqual(w2.query('hp'), [a]);
    // New spawns must not collide with restored ids.
    const fresh = w2.spawn({});
    assert.ok(!json.entities.some((e: { id: number }) => e.id === fresh));
  });
});

describe('ecs performance', () => {
  it('10k entities: spawn + query under budget', () => {
    const w = new World();
    const N = 10_000;
    let t0 = performance.now();
    for (let i = 0; i < N; i++) {
      w.spawn({ pos: { x: i, y: i }, vel: { x: 1, y: 0 }, hp: { v: 100 } });
    }
    const spawnMs = performance.now() - t0;
    t0 = performance.now();
    const all = w.query('pos', 'vel', 'hp');
    const queryMs = performance.now() - t0;
    t0 = performance.now();
    w.forEach(['pos', 'vel'], (id, pos, vel) => {
      const p = pos as { x: number; y: number };
      const v = vel as { x: number; y: number };
      p.x += v.x;
      void id;
    });
    const iterMs = performance.now() - t0;
    console.log(`ecs perf: spawn10k=${spawnMs.toFixed(1)}ms query=${queryMs.toFixed(1)}ms iterate=${iterMs.toFixed(1)}ms`);
    assert.equal(all.length, N);
    assert.ok(spawnMs < 5000, `spawn too slow: ${spawnMs}ms`);
    assert.ok(queryMs < 1000, `query too slow: ${queryMs}ms`);
  });
});
