import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { FOG_CHUNK, FogOfWar, fogChunkKey } from './fog.js';

// Minimal sessionStorage stub so fog.ts persistence is exercised in node.
class MemStore {
  private m = new Map<string, string>();
  getItem(k: string) { return this.m.has(k) ? this.m.get(k)! : null; }
  setItem(k: string, v: string) { this.m.set(k, v); }
  removeItem(k: string) { this.m.delete(k); }
  clear() { this.m.clear(); }
}
const g = globalThis as unknown as { sessionStorage?: MemStore };

beforeEach(() => {
  g.sessionStorage = new MemStore();
});

describe('fogChunkKey', () => {
  it('buckets world coords into FOG_CHUNK cells', () => {
    assert.equal(fogChunkKey(0, 0), '0,0');
    assert.equal(fogChunkKey(7.9, 7.9), '0,0');
    assert.equal(fogChunkKey(8, 0), '1,0');
    assert.equal(fogChunkKey(-0.5, -0.5), '-1,-1');
  });
});

describe('FogOfWar', () => {
  it('reveals chunks around a point and reports newly explored count', () => {
    const f = new FogOfWar();
    assert.equal(f.exploredCount(), 0);
    const first = f.markAround(50, 50);
    assert.ok(first > 0, 'first mark should reveal chunks');
    assert.equal(f.markAround(50, 50), 0, 're-marking same spot reveals nothing new');
    assert.equal(f.isExploredWorld(50, 50), true);
    assert.equal(f.isExploredWorld(50 + FOG_CHUNK * 40, 50), false);
  });

  it('isExploredWorld agrees with chunk indices', () => {
    const f = new FogOfWar();
    f.markAround(20, 20);
    assert.equal(f.isExploredWorld(20.5, 20.5), true);
    assert.equal(f.isExploredChunk(Math.floor(20.5 / FOG_CHUNK), Math.floor(20.5 / FOG_CHUNK)), true);
    assert.equal(f.isExploredChunk(99, 99), false);
  });

  it('never reveals chunks outside the requested radius', () => {
    const f = new FogOfWar();
    f.markAround(50, 50, 4);
    // 4m radius + chunk slack (8*0.75) — a far cell stays unknown.
    assert.equal(f.isExploredWorld(95, 50), false);
  });

  it('persists explored chunks to sessionStorage across instances', () => {
    const a = new FogOfWar();
    const n = a.markAround(10, 10);
    assert.ok(n > 0);
    // Second mark within the 2s save throttle; flush() bypasses it so a
    // reload cannot lose the newest chunks.
    assert.ok(a.markAround(90, 90, 4) > 0);
    a.flush();
    const b = new FogOfWar();
    assert.equal(b.exploredCount(), a.exploredCount());
    assert.equal(b.isExploredWorld(10, 10), true);
    assert.equal(b.isExploredWorld(90, 90), true);
  });

  it('survives corrupt session storage', () => {
    const store = new MemStore();
    store.setItem('af_fog_v1', '{not json');
    g.sessionStorage = store;
    const f = new FogOfWar();
    assert.equal(f.exploredCount(), 0);
    assert.ok(f.markAround(50, 50) > 0);
  });

  it('drops non-string / malformed entries on load', () => {
    const store = new MemStore();
    store.setItem('af_fog_v1', JSON.stringify(['1,1', 42, null, 'a,b', { x: 1 }]));
    g.sessionStorage = store;
    const f = new FogOfWar();
    assert.equal(f.exploredCount(), 1);
    assert.equal(f.isExploredChunk(1, 1), true);
  });
});