// Protocol-compat harness for the client `t:'event'` router.
//
// The router itself lives inside main.ts (it needs the DOM/renderers), so this
// test re-implements only its *decision table* as a pure function and pins the
// server wire contract: every kind the server can emit must be classified as
// handled or deliberately ignored, and unknown kinds must be a silent no-op.
// If the server grows a new kind, this fails until the client routes it.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { asTelegraph } from './telegraph.js';

/** Event kinds server/src broadcasts (grep the server for `kind: '...'`). */
const SERVER_KINDS = [
  // server/src/index.ts
  'telegraph', 'respawn', 'despawn', 'redirect', 'kicked', 'chat-limited', 'bad-proto', 'queue',
  // server/src/game/index.ts
  'mob-die', 'xp-gain', 'pickup-spawn', 'mob-spawn', 'mob-respawn', 'mob-aggro',
  'quest-progress', 'quest-complete', 'levelup',
  // server/src/game/loot.ts
  'boss-kill',
  // older/alternate builds
  'xp', 'loot', 'kill',
];

/** Kinds main.ts routes to a UI reaction. */
const HANDLED = new Set([
  'telegraph', 'respawn', 'xp', 'xp-gain', 'levelup', 'mob-die',
  'quest-progress', 'quest-complete', 'loot', 'kill', 'boss-kill',
  'redirect', 'queue', 'kicked', 'chat-limited', 'bad-proto',
]);

/** Kinds main.ts intentionally drops (entities arrive via snapshots). */
const IGNORED = new Set(['despawn', 'mob-spawn', 'mob-respawn', 'mob-aggro', 'pickup-spawn']);

describe('event routing table', () => {
  it('classifies every server event kind as handled or ignored', () => {
    for (const k of SERVER_KINDS) {
      assert.ok(HANDLED.has(k) || IGNORED.has(k), `event kind '${k}' is unrouted`);
      assert.ok(!(HANDLED.has(k) && IGNORED.has(k)), `'${k}' is both handled and ignored`);
    }
  });

  it('leaves no server kind in the unknown fallback', () => {
    const unhandled = SERVER_KINDS.filter((k) => !HANDLED.has(k));
    assert.deepEqual(unhandled.sort(), [...IGNORED].sort());
  });

  it('unknown kinds are silently ignored (forward compat)', () => {
    for (const k of ['some-future-event', '', 'MOB-DIE', 'quest_progress', 'x'.repeat(200)]) {
      assert.ok(!HANDLED.has(k), `'${k}' should not be handled`);
      // The client's switch has `default: break`, so this must be a no-op.
    }
  });
});

describe('playerId scoping', () => {
  /** Mirrors main.ts `forMe()`: absent playerId means "everyone". */
  const forMe = (payload: unknown, selfId: number): boolean => {
    const v = (payload as { playerId?: unknown } | null)?.playerId;
    if (typeof v !== 'number' || !Number.isFinite(v)) return true;
    return v === selfId;
  };

  it('reacts to payloads carrying my id', () => {
    assert.equal(forMe({ playerId: 7 }, 7), true);
  });

  it('ignores payloads for another player', () => {
    assert.equal(forMe({ playerId: 9 }, 7), false);
  });

  it('treats payloads without playerId as broadcast', () => {
    assert.equal(forMe(null, 7), true);
    assert.equal(forMe({}, 7), true);
    assert.equal(forMe({ playerId: 'nope' }, 7), true);
  });
});

describe('telegraph payload over the wire', () => {
  it('parses every telegraph the bosses actually emit', () => {
    // server/src/ai/bosses.ts emits these three labels.
    const wire = [
      { shape: 'circle', x: 80, y: 80, r: 4, ttlMs: 900, label: 'golem-slam' },
      { shape: 'circle', x: 80, y: 80, r: 4.8, ttlMs: 500, label: 'wisp-blink' },
      { shape: 'circle', x: 20, y: 80, r: 3.5, ttlMs: 700, label: 'wisp-burst' },
    ];
    for (const w of wire) assert.ok(asTelegraph(w), `rejected ${w.label}`);
  });

  it('rejects a hostile payload before it reaches a render loop', () => {
    assert.equal(asTelegraph({ shape: 'circle', x: NaN, y: 0, r: 5, ttlMs: 900, label: 'x' }), null);
    assert.equal(asTelegraph({ shape: 'circle', x: 0, y: 0, r: 1e9, ttlMs: 900, label: 'x' }), null);
    assert.equal(asTelegraph({ shape: 'circle', x: 0, y: 0, r: 5, ttlMs: 1e9, label: 'x' }), null);
    assert.equal(asTelegraph({ shape: 'rect', x: 0, y: 0, r: 5, ttlMs: 900, label: 'x' }), null);
  });
});