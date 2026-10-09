import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  baselineFromEntities,
  decodeInputBinary,
  diffSnapshot,
  encodeAckBinary,
  encodeChatBinary,
  encodeEventBinary,
  encodeInputBinary,
  encodeSnapshotBinary,
  encodeWelcomeBinary,
  type P2Entity,
} from '@aetherfall/shared/dist/protocol2.js';
import { NetClientV2, PROTO, frameTypeOf, p2ToV1, protoFromSearch, toFrameBytes, type NetV2Transport } from './net2.js';

const EPS = 1e-3;

function ent(id: number, x: number, y: number, over: Partial<P2Entity> = {}): P2Entity {
  return { id, kind: 'mob', p: { x, y }, v: { x: 0, y: 0 }, hp: 100, maxHp: 100, ...over };
}

function world(n: number, tick: number): P2Entity[] {
  return Array.from({ length: n }, (_, i) =>
    ent(i + 1, 50 + Math.sin((tick + i) / 7) * 20, 50 + Math.cos((tick + i) / 5) * 20, {
      kind: i % 2 === 0 ? 'player' : 'mob',
      v: { x: Math.sin((tick + i) / 3) * 4, y: Math.cos((tick + i) / 3) * 4 },
      hp: 80 + (i % 7),
      name: i % 3 === 0 ? `mob-${i}` : undefined,
      level: 1 + (i % 5),
    }),
  );
}

/** Recording transport: everything the client puts on the wire lands here. */
class FakeTransport implements NetV2Transport {
  readonly sent: Array<string | Uint8Array> = [];
  closed = false;
  send(data: string | Uint8Array): void {
    this.sent.push(typeof data === 'string' ? data : data.slice());
  }
  close(): void {
    this.closed = true;
  }
  get json(): unknown[] {
    return this.sent.filter((s): s is string => typeof s === 'string').map((s) => JSON.parse(s) as unknown);
  }
  get binary(): Uint8Array[] {
    return this.sent.filter((s): s is Uint8Array => typeof s !== 'string');
  }
}

function connect(): { c: NetClientV2; t: FakeTransport } {
  const c = new NetClientV2();
  const t = new FakeTransport();
  c.attach(t, 'hero');
  return { c, t };
}

function welcomeFrame(tick: number, entities: P2Entity[], id = 7): Uint8Array {
  return encodeWelcomeBinary({ t: 'welcome', proto: 2, id, tick, name: 'hero', snapshot: entities });
}

describe('NetClientV2 handshake', () => {
  it('advertises proto 2 + the binary capability in a JSON hello', () => {
    const { t } = connect();
    assert.equal(t.sent.length, 1);
    const hello = t.json[0] as { t: string; name: string; proto: number; caps: Record<string, unknown> };
    assert.equal(hello.t, 'hello');
    assert.equal(hello.name, 'hero');
    assert.equal(hello.proto, PROTO);
    assert.equal(hello.caps['binary'], true);
    assert.equal(hello.caps['deltas'], true);
    assert.equal(hello.caps['keyframe'], 50);
  });

  it('includes the dev token only when one is set', () => {
    const c = new NetClientV2();
    const t = new FakeTransport();
    c.attach(t, 'hero');
    assert.equal('token' in (t.json[0] as object), false);
    c.token = 'tok';
    c.sendHello('hero');
    assert.equal((t.json[1] as { token: string }).token, 'tok');
  });

  it('upgrades to proto 2 on a binary welcome', () => {
    const { c } = connect();
    let welcomed = 0;
    let snaps = 0;
    c.onWelcome = () => welcomed++;
    c.onSnapshot = () => snaps++;
    assert.equal(c.proto, 1);
    c.handleData(welcomeFrame(3, world(5, 3)));
    assert.equal(c.proto, 2);
    assert.equal(c.id, 7);
    assert.equal(c.tick, 3);
    assert.equal(c.entities.size, 5);
    assert.equal(welcomed, 1);
    assert.equal(snaps, 1);
    assert.equal(c.entities.get(1)!.kind, 'player');
    assert.equal(c.entities.get(4)!.name, 'mob-3');
  });

  it('falls back to v1 JSON when the server answers in JSON', () => {
    const { c } = connect();
    const reasons: string[] = [];
    c.onFallback = (r) => reasons.push(r);
    c.handleData(JSON.stringify({ t: 'welcome', id: 9, tick: 11, snapshot: [{ id: 1, kind: 'mob', p: { x: 1, y: 2 }, v: { x: 0, y: 0 }, hp: 5, maxHp: 5 }] }));
    assert.equal(c.proto, 1);
    assert.equal(c.id, 9);
    assert.equal(c.tick, 11);
    assert.equal(c.entities.size, 1);
    assert.deepEqual(reasons, ['server-declined-binary']);
  });

  it('keeps working on v1 JSON after the fallback', () => {
    const { c, t } = connect();
    c.handleData(JSON.stringify({ t: 'welcome', id: 9, tick: 11, snapshot: [] }));
    let snaps = 0;
    c.onSnapshot = () => snaps++;
    c.handleData(JSON.stringify({ t: 'snapshot', tick: 12, entities: [{ id: 2, kind: 'mob', p: { x: 3, y: 4 }, v: { x: 0, y: 0 }, hp: 1, maxHp: 1 }], removed: [8] }));
    assert.equal(c.tick, 12);
    assert.equal(c.entities.size, 1);
    assert.equal(c.entities.has(8), false);
    assert.equal(snaps, 1);
    c.sendInput(1, 0.5, -0.5);
    const input = t.json[t.json.length - 1] as { t: string; input: { seq: number; dt: number } };
    assert.equal(input.t, 'input');
    assert.equal(input.input.seq, 1);
    assert.ok(Math.abs(input.input.dt - 0.05) < 1e-9);
    c.sendChat('hello');
    assert.equal((t.json[t.json.length - 1] as { t: string }).t, 'chat');
  });
});

describe('NetClientV2 delta snapshots', () => {
  it('applies a keyframe then 60 deltas to the same state the server had', () => {
    const { c } = connect();
    const first = world(12, 0);
    c.handleData(encodeWelcomeBinary({ t: 'welcome', proto: 2, id: 7, tick: 0, name: 'hero', snapshot: first }));
    let baseline = baselineFromEntities(first);
    let snaps = 0;
    c.onSnapshot = () => snaps++;
    for (let t = 1; t <= 60; t++) {
      const next = world(12, t);
      const keyframe = t % 50 === 0;
      const { updates, next: nextBaseline } = diffSnapshot(baseline, next);
      const frame = encodeSnapshotBinary(
        { t: 'snapshot', tick: t, baseTick: keyframe ? 0 : t - 1, keyframe, entities: keyframe ? next : updates, removed: [] },
        baseline,
      );
      c.handleData(frame);
      assert.equal(c.tick, t);
      assert.equal(c.entities.size, 12, `tick ${t} entity count`);
      for (const e of next) {
        const got = c.entities.get(e.id);
        assert.ok(got, `tick ${t} missing ${e.id}`);
        if (!got) continue;
        assert.ok(Math.abs(got.p.x - e.p.x) <= 1 / 16 + EPS, `t${t} p.x #${e.id}`);
        assert.ok(Math.abs(got.p.y - e.p.y) <= 1 / 16 + EPS, `t${t} p.y #${e.id}`);
        assert.ok(Math.abs(got.v.x - e.v.x) <= 1 / 256 + EPS, `t${t} v.x #${e.id}`);
        assert.equal(got.kind, e.kind);
        assert.equal(got.level, e.level);
        assert.equal(got.name, e.name);
      }
      baseline = nextBaseline;
    }
    assert.equal(c.droppedSnapshots, 0);
    assert.equal(c.decodeErrors, 0);
    assert.equal(snaps, 60);
  });

  it('drops a delta that does not line up with its baseline instead of guessing', () => {
    const { c } = connect();
    c.handleData(welcomeFrame(0, world(4, 0)));
    let snaps = 0;
    c.onSnapshot = () => snaps++;
    // tick 3 arrives while the client still holds the tick-0 baseline
    const frame = encodeSnapshotBinary(
      { t: 'snapshot', tick: 3, baseTick: 2, keyframe: false, entities: world(4, 3), removed: [] },
      new Map(),
    );
    c.handleData(frame);
    assert.equal(c.droppedSnapshots, 1);
    assert.equal(snaps, 0);
    assert.equal(c.entities.size, 4, 'entities stay at the last good state');
    // the next keyframe resyncs
    c.handleData(encodeSnapshotBinary({ t: 'snapshot', tick: 4, baseTick: 0, keyframe: true, entities: world(4, 4), removed: [] }));
    assert.equal(c.droppedSnapshots, 1);
    assert.equal(snaps, 1);
    assert.ok(Math.abs(c.entities.get(1)!.p.x - world(4, 4)[0]!.p.x) <= 1 / 16 + EPS);
  });

  it('applies removals and despawn events', () => {
    const { c } = connect();
    c.handleData(welcomeFrame(0, world(6, 0)));
    const frame = encodeSnapshotBinary(
      { t: 'snapshot', tick: 1, baseTick: 0, keyframe: false, entities: [], removed: [2, 3] },
      new Map(),
    );
    c.handleData(frame);
    assert.equal(c.entities.size, 4);
    assert.equal(c.entities.has(2), false);

    let kind = '';
    c.onEvent = (k) => (kind = k);
    c.handleData(encodeEventBinary({ t: 'event', kind: 'despawn', payload: JSON.stringify({ id: 5 }) }));
    assert.equal(kind, 'despawn');
    assert.equal(c.entities.has(5), false);
    assert.equal(c.entities.size, 3);
  });
});

describe('NetClientV2 outbound + side channels', () => {
  it('sends binary input/chat once proto 2 is negotiated', () => {
    const { c, t } = connect();
    c.sendInput(1, 0.5, -0.25, { attack: true });
    assert.equal(t.binary.length, 0, 'still v1 before the welcome');
    assert.equal((t.json[1] as { t: string }).t, 'input');

    c.handleData(welcomeFrame(0, world(2, 0)));
    c.sendInput(2, 0.5, -0.25, { attack: true, chat: 'hi' });
    c.sendChat('yo', 'guild');
    assert.equal(t.binary.length, 2);
    const input = decodeInputBinary(t.binary[0]!);
    assert.equal(input.input.seq, 2);
    assert.equal(input.input.attack, true);
    assert.equal(input.input.chat, 'hi');
    assert.ok(Math.abs(input.input.move.x - 0.5) < 1e-6);
    assert.ok(Math.abs(input.input.move.y + 0.25) < 1e-6);
  });

  it('caps in-flight input samples like net.ts', () => {
    const { c, t } = connect();
    c.handleData(welcomeFrame(0, [], 3));
    for (let seq = 1; seq <= 260; seq++) c.sendInput(seq, 0, 0);
    // the local player's echoed seq drives the ack + rtt bookkeeping
    c.handleData(
      encodeSnapshotBinary(
        { t: 'snapshot', tick: 1, baseTick: 0, keyframe: true, entities: [{ id: 3, kind: 'player', p: { x: 0, y: 0 }, v: { x: 0, y: 0 }, hp: 10, maxHp: 10, seq: 5 }], removed: [] },
      ),
    );
    assert.equal(c.lastAckSeq, 5);
    assert.equal(c.entities.get(3)!.seq, 5);
  });

  it('accepts ack frames and chat frames', () => {
    const { c } = connect();
    c.handleData(welcomeFrame(0, world(3, 0)));
    c.handleData(encodeAckBinary({ t: 'ack', tick: 4, baseTick: 4, lastInputSeq: 42, rttMs: 21 }));
    assert.equal(c.lastAckSeq, 42);
    assert.equal(c.rttMs, 21);
    let chat = '';
    c.onChat = (from, text, channel) => (chat = `${from}/${text}/${channel}`);
    c.handleData(encodeChatBinary({ t: 'chat', from: 'Elder Maren', text: 'welcome', channel: 'global' }));
    assert.equal(chat, 'Elder Maren/welcome/global');
  });

  it('counts hostile frames instead of throwing', () => {
    const { c } = connect();
    const before = c.decodeErrors;
    for (const junk of [new Uint8Array(0), new Uint8Array([0, 1, 2, 3]), new Uint8Array(64).fill(0xff), '{bad json', 42, null, undefined]) {
      assert.doesNotThrow(() => c.handleData(junk));
    }
    assert.ok(c.decodeErrors >= before + 6, `decodeErrors=${c.decodeErrors}`);
    assert.equal(c.proto, 1);
  });

  it('survives a transport that throws', () => {
    const c = new NetClientV2();
    c.attach({ send: () => {}, close: () => {} }, 'hero');
    c.handleData(welcomeFrame(0, world(1, 0)));
    c.attach(
      {
        send: () => {
          throw new Error('socket gone');
        },
        close: () => {},
      },
      'hero',
    );
    assert.doesNotThrow(() => c.sendInput(1, 0, 0));
    assert.doesNotThrow(() => c.sendChat('x'));
    assert.ok(c.decodeErrors > 0);
  });
});

describe('net2 helpers', () => {
  it('toFrameBytes accepts every WS binary shape and nothing else', () => {
    const bytes = new Uint8Array([1, 2, 3]);
    assert.equal(toFrameBytes(bytes), bytes);
    assert.deepEqual(Array.from(toFrameBytes(bytes.buffer)!), [1, 2, 3]);
    const padded = new Uint8Array(5);
    padded.set(bytes, 2);
    assert.deepEqual(Array.from(toFrameBytes(padded.subarray(2))!), [1, 2, 3]);
    assert.deepEqual(Array.from(toFrameBytes(Buffer.from(padded.buffer, 2, 3))!), [1, 2, 3]);
    assert.equal(toFrameBytes('hello'), null);
    assert.equal(toFrameBytes(null), null);
  });

  it('frameTypeOf reports the frame code or -1', () => {
    assert.equal(frameTypeOf(welcomeFrame(0, [])), 1);
    assert.equal(frameTypeOf(encodeSnapshotBinary({ t: 'snapshot', tick: 1, baseTick: 0, keyframe: true, entities: [], removed: [] })), 2);
    assert.equal(frameTypeOf(encodeInputBinary({ t: 'input', input: { seq: 1, dt: 0.05, move: { x: 0, y: 0 } } })), 17);
    assert.equal(frameTypeOf(new Uint8Array(2)), -1);
    assert.equal(frameTypeOf(new Uint8Array([9, 9, 9, 9, 9])), -1);
  });

  it('p2ToV1 keeps the v1 entity shape', () => {
    const m = p2ToV1(world(3, 1));
    assert.equal(m.size, 3);
    assert.equal(m.get(1)!.kind, 'player');
    assert.equal(m.get(2)!.name, undefined);
  });

  it('protoFromSearch defaults to v2; only ?proto=1 forces v1', () => {
    assert.equal(protoFromSearch(''), 2, 'default tries v2 (fallback keeps it safe)');
    assert.equal(protoFromSearch('?proto=2'), 2);
    assert.equal(protoFromSearch('?proto=v2'), 2);
    assert.equal(protoFromSearch('?server=ws%3A%2F%2Flocalhost%3A8081&proto=2&name=hero'), 2);
    assert.equal(protoFromSearch('?server=ws%3A%2F%2Flocalhost%3A8081&name=hero'), 2, 'no flag still tries v2');
    for (const q of ['?proto=1', '?proto=v1', '?proto=json', '?proto=V1', '?proto=JSON', '?proto=%20v1%20']) {
      assert.equal(protoFromSearch(q), 1, q);
    }
    // Unknown / empty / future values try v2 first: the JSON-welcome fallback
    // keeps the session working, so a stray link can never break the client.
    for (const q of ['?proto=3', '?proto=yes', '?proto=', '?proto=binary', '?PROTO=2', 'not a query %%%']) {
      assert.equal(protoFromSearch(q), 2, q);
    }
  });
});

describe('v2 default negotiation matrix (client view)', () => {
  it('2->2: default client offer upgrades on a binary welcome', () => {
    assert.equal(protoFromSearch(''), 2);
    const { c } = connect();
    c.handleData(welcomeFrame(1, world(4, 1)));
    assert.equal(c.proto, 2);
    assert.equal(c.entities.size, 4);
  });

  it('2->1 fallback: the same default client keeps working on a JSON welcome', () => {
    const { c, t } = connect();
    const reasons: string[] = [];
    c.onFallback = (r) => reasons.push(r);
    c.handleData(JSON.stringify({ t: 'welcome', id: 5, tick: 2, snapshot: [] }));
    assert.equal(c.proto, 1);
    assert.deepEqual(reasons, ['server-declined-binary']);
    // ...and stays on v1 JSON afterwards (unknown/old server path untouched)
    c.handleData(JSON.stringify({ t: 'snapshot', tick: 3, entities: [], removed: [] }));
    assert.equal(c.tick, 3);
    c.sendInput(1, 0, 0);
    assert.equal(typeof t.json[t.json.length - 1], 'object');
  });

  it('1->1: ?proto=1 selects the legacy v1 client (no binary offer)', () => {
    assert.equal(protoFromSearch('?proto=1'), 1);
    assert.equal(protoFromSearch('?proto=v1'), 1);
  });

  it('v2/v1 byte-parity on the same sim: binary decodes what JSON describes', () => {
    const { c } = connect();
    const first = world(10, 7);
    c.handleData(encodeWelcomeBinary({ t: 'welcome', proto: 2, id: 7, tick: 7, name: 'hero', snapshot: first }));
    const v1json = JSON.stringify({ t: 'snapshot', tick: 8, entities: first, removed: [] });
    const frame = encodeSnapshotBinary(
      { t: 'snapshot', tick: 8, baseTick: 7, keyframe: false, entities: first, removed: [] },
      baselineFromEntities(first),
    );
    assert.ok(frame.length < Buffer.byteLength(v1json) / 4, `v2 ${frame.length}B vs v1 ${Buffer.byteLength(v1json)}B`);
    c.handleData(frame);
    assert.equal(c.entities.size, 10);
    for (const e of first) {
      const got = c.entities.get(e.id)!;
      assert.ok(Math.abs(got.p.x - e.p.x) <= 1 / 16 + EPS);
      assert.equal(got.kind, e.kind);
    }
  });
});