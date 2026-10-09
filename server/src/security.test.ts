// @aetherfall/server — security: fuzz/robustness tests. Malformed
// hello/input/chat traffic (NaN, huge, null proto, wrong types) must be
// dropped without crashing. Plus auth blacklist, walls admin guards, audit.
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  clearRevokedTokens,
  issueToken,
  isTokenRevoked,
  maxPlayersPerShard,
  queuePositionEvent,
  resolveIdentity,
 revokeToken,
  sanitizeName,
  validateHello,
  verifyToken,
} from './auth.js';
import {
  AntiCheat,
  MAX_MSG_BYTES,
  safeParseClientMsg,
  sanitizeChatText,
  sanitizeInputDt,
  sanitizeMoveAxis,
} from './anticheat.js';
import { MAX_SPEED } from './sim.js';
import {
  _resetAdminWarn,
  adminTokenIsDefault,
  checkWallsRateLimit,
  isAdminAllowed,
  isAdminRequest,
  MAX_WALLS_BODY_BYTES,
  parseWallsBody,
  resetWallsRateLimit,
} from './walls.js';
import { audit, auditPath, rotateAuditIfNeeded, AUDIT_MAX_BYTES } from './audit.js';

describe('sec: sanitizeName (16 char alnum+_-)', () => {
  it('strips spaces and punctuation', () => {
    assert.equal(sanitizeName('a b!c@d e'), 'abcde');
    assert.equal(sanitizeName('hero_01-x'), 'hero_01-x');
  });
  it('caps at 16 chars', () => {
    assert.equal(sanitizeName('abcdefghijklmnopqr').length, 16);
  });
  it('never throws on non-string fuzz', () => {
    for (const v of [null, undefined, 42, NaN, Infinity, {}, [], true] as unknown[]) {
      assert.doesNotThrow(() => sanitizeName(v as string));
      assert.ok(typeof sanitizeName(v as string) === 'string');
    }
  });
  it('empty/symbol-only falls back to hero', () => {
    assert.equal(sanitizeName(''), 'hero');
    assert.equal(sanitizeName('!!!'), 'hero');
    assert.equal(sanitizeName(null as unknown as string), 'hero');
  });
});

describe('sec: token blacklist on kick', () => {
  beforeEach(() => clearRevokedTokens());
  afterEach(() => clearRevokedTokens());
  it('verified token verifies; revoked token does not', () => {
    const tok = issueToken('alice');
    assert.ok(verifyToken(tok)?.name === 'alice');
    assert.equal(revokeToken(tok), true);
    assert.equal(isTokenRevoked(tok), true);
    assert.equal(verifyToken(tok), null);
    // resolveIdentity falls back to guest after revocation
    assert.equal(resolveIdentity('alice', tok).guest, true);
  });
  it('revoke rejects garbage without throwing', () => {
    assert.equal(revokeToken(undefined), false);
    assert.equal(revokeToken(''), false);
    assert.equal(revokeToken('x'.repeat(600)), false);
  });
});

describe('sec: MAX_PLAYERS_PER_SHARD default 500 + queue event', () => {
  it('defaults to 500 when unset/invalid', () => {
    assert.equal(maxPlayersPerShard({} as NodeJS.ProcessEnv), 500);
    assert.equal(maxPlayersPerShard({ MAX_PLAYERS_PER_SHARD: '' } as unknown as NodeJS.ProcessEnv), 500);
    assert.equal(maxPlayersPerShard({ MAX_PLAYERS_PER_SHARD: 'nan' } as unknown as NodeJS.ProcessEnv), 500);
    assert.equal(maxPlayersPerShard({ MAX_PLAYERS_PER_SHARD: '-3' } as unknown as NodeJS.ProcessEnv), 500);
    assert.equal(maxPlayersPerShard({ MAX_PLAYERS_PER_SHARD: '200' } as unknown as NodeJS.ProcessEnv), 200);
  });
  it('queue event carries position + cap (protocol v1 envelope)', () => {
    const e = queuePositionEvent(7, 500);
    assert.equal(e.t, 'event');
    assert.equal((e as { kind: string }).kind, 'queue');
    assert.deepEqual((e as { payload: unknown }).payload, { position: 7, max: 500 });
  });
});

describe('sec: walls admin guards', () => {
  beforeEach(() => {
    resetWallsRateLimit();
    _resetAdminWarn();
  });
  afterEach(() => {
    resetWallsRateLimit();
    delete process.env.ADMIN_TOKEN;
    delete process.env.NODE_ENV;
  });
  it('prod + dev default token denies admin (fail closed)', () => {
    process.env.NODE_ENV = 'production';
    delete process.env.ADMIN_TOKEN;
    assert.equal(adminTokenIsDefault(), true);
    assert.equal(isAdminAllowed(), false);
  });
  it('prod + real token allows admin check', () => {
    process.env.NODE_ENV = 'production';
    process.env.ADMIN_TOKEN = 's3cret';
    assert.equal(isAdminAllowed(), true);
    assert.equal(isAdminRequest({ authorization: 'Bearer s3cret' }), true);
    assert.equal(isAdminRequest({ authorization: 'Bearer wrong' }), false);
  });
  it('query-string token allowed in dev, rejected in prod (secret in logs)', () => {
    process.env.ADMIN_TOKEN = 's3cret';
    delete process.env.NODE_ENV;
    assert.equal(isAdminRequest({}, '/walls?token=s3cret'), true);
    process.env.NODE_ENV = 'production';
    assert.equal(isAdminRequest({}, '/walls?token=s3cret'), false);
    assert.equal(isAdminRequest({}, '/walls?adminToken=s3cret'), false);
    assert.equal(isAdminRequest({ 'x-admin-token': 's3cret' }), true);
  });
  it('rate limit: 10/min/IP then limited, window slides', () => {
    const ip = '10.0.0.99';
    for (let i = 0; i < 10; i++) assert.equal(checkWallsRateLimit(ip, 1000 + i), true);
    assert.equal(checkWallsRateLimit(ip, 1000 + 10), false);
    // window slides: 61s later allowed again
    assert.equal(checkWallsRateLimit(ip, 1000 + 61_001), true);
  });
  it('rate limit: per-IP isolation (no cross-IP bleed)', () => {
    resetWallsRateLimit();
    for (let i = 0; i < 10; i++) assert.equal(checkWallsRateLimit('10.0.0.1', 2000 + i), true);
    assert.equal(checkWallsRateLimit('10.0.0.1', 2010), false);
    assert.equal(checkWallsRateLimit('10.0.0.2', 2010), true);
    assert.equal(checkWallsRateLimit(undefined, 2010), true);
    assert.equal(checkWallsRateLimit('x'.repeat(500), 2011), true);
  });
  it('bodies over 1MB rejected with 413', () => {
    assert.ok(MAX_WALLS_BODY_BYTES === 1_000_000);
    assert.throws(() => parseWallsBody('x'.repeat(MAX_WALLS_BODY_BYTES + 1)), /too large/);
    try {
      parseWallsBody('x'.repeat(MAX_WALLS_BODY_BYTES + 1));
      assert.fail('should throw');
    } catch (err) {
      assert.equal((err as { status?: number }).status, 413);
    }
  });
  it('invalid bodies still rejected with status errors', () => {
    assert.throws(() => parseWallsBody('not json'));
    assert.throws(() => parseWallsBody(JSON.stringify({ format: 'nope', walls: [] })));
  });
});

describe('sec: fuzz — malformed hello/input/chat never crash', () => {
  it('validateHello drops null proto, NaN, huge, wrong types', () => {
    const bad: unknown[] = [
      null, undefined, 42, 'hello', [],
      { t: 'hello', name: 'x', proto: null },
      { t: 'hello', name: 'x', proto: NaN },
      { t: 'hello', name: 'x', proto: Infinity },
      { t: 'hello', name: 'x', proto: '1' },
      { t: 'hello', name: null, proto: 1 },
      { t: 'hello', name: 'x'.repeat(100000), proto: 1 },
      { t: 'hello', name: 'x', proto: 1, token: 42 },
      { t: 'hello', name: 'x', proto: 1, token: 'y'.repeat(600) },
    ];
    for (const b of bad) assert.equal(validateHello(b), null, JSON.stringify(b)?.slice(0, 80));
    assert.ok(validateHello({ t: 'hello', name: 'bob', proto: 1 }));
  });

  it('safeParseClientMsg drops fuzz without throwing', () => {
    const fuzz: unknown[] = [
      '', '{', '{{{{', 'null', '[]', '42',
      JSON.stringify({ t: 'hello', name: 'x', proto: null }),
      JSON.stringify({ t: 'hello', name: 'x', proto: NaN }),
      JSON.stringify({ t: 'input', input: null }),
      JSON.stringify({ t: 'input', input: { seq: NaN, dt: NaN, move: { x: NaN, y: Infinity } } }),
      JSON.stringify({ t: 'input', input: { seq: 1, dt: 1e308, move: { x: 1e308, y: -1e308 } } }),
      JSON.stringify({ t: 'chat', text: null, channel: 'say' }),
      JSON.stringify({ t: 'chat', text: 'hi', channel: 'nope' }),
      JSON.stringify({ t: 'chat', text: 'x'.repeat(5000), channel: 'say' }),
      JSON.stringify({ t: 'weird', x: 1 }),
      'x'.repeat(MAX_MSG_BYTES + 1),
    ];
    for (const f of fuzz) {
      let out = 'unreached';
      assert.doesNotThrow(() => {
        out = String(safeParseClientMsg(f));
      });
      assert.equal(out, 'null', String(f).slice(0, 80));
    }
  });

  it('safeParseClientMsg keeps honest traffic intact', () => {
    assert.deepEqual(safeParseClientMsg(JSON.stringify({ t: 'hello', name: 'bob', proto: 1 })), {
      t: 'hello', name: 'bob', token: undefined, proto: 1,
    });
    const inp = safeParseClientMsg(JSON.stringify({
      t: 'input', input: { seq: 3, dt: 0.05, move: { x: 1, y: 0 }, attack: true },
    }));
    assert.equal(inp?.t, 'input');
    const chat = safeParseClientMsg(JSON.stringify({ t: 'chat', text: 'hello', channel: 'say' }));
    assert.deepEqual(chat, { t: 'chat', text: 'hello', channel: 'say' });
  });

  it('wrong-proto hello is passed through untrusted (bad-proto signal, no identity)', () => {
    const out = safeParseClientMsg(JSON.stringify({ t: 'hello', name: 'eve', proto: 999 }));
    // Must NOT be dropped silently (caller needs to answer bad-proto) and must
    // NOT carry the untrusted name/token into an identity.
    assert.equal(out?.t, 'hello');
    assert.equal((out as { proto: number }).proto, 999);
    assert.equal((out as { name: string }).name, '');
    // validateHello keeps it well-formed; index.ts rejects it on proto before
    // resolveIdentity() ever sees it.
    assert.equal(validateHello(out)?.proto, 999);
    // Non-integer / non-finite protos are still hard drops.
    assert.equal(safeParseClientMsg(JSON.stringify({ t: 'hello', name: 'eve', proto: 1.5 })), null);
    assert.equal(safeParseClientMsg('{"t":"hello","name":"eve","proto":NaN}'), null);
  });

  it('chat frames are trimmed + capped once (sanitizeChatText is the source of truth)', () => {
    assert.deepEqual(safeParseClientMsg(JSON.stringify({ t: 'chat', text: '  hi  ', channel: 'say' })), {
      t: 'chat', text: 'hi', channel: 'say',
    });
    assert.equal(sanitizeChatText('  hi  '), 'hi');
    assert.equal(sanitizeChatText('    '), null);
    assert.equal(safeParseClientMsg(JSON.stringify({ t: 'chat', text: '   ', channel: 'say' })), null);
    const capped = safeParseClientMsg(JSON.stringify({ t: 'chat', text: 'x'.repeat(300), channel: 'say' })) as { text: string };
    assert.equal(capped.text.length, 200);
    // input-frame chat: whitespace-only drops the field, movement survives.
    const inp = safeParseClientMsg(JSON.stringify({
      t: 'input', input: { seq: 1, dt: 0.05, move: { x: 1, y: 0 }, chat: '   ' },
    })) as { input: { chat?: string } };
    assert.equal(inp.input.chat, undefined);
    const inp2 = safeParseClientMsg(JSON.stringify({
      t: 'input', input: { seq: 1, dt: 0.05, move: { x: 1, y: 0 }, chat: '  yo  ' },
    })) as { input: { chat?: string } };
    assert.equal(inp2.input.chat, 'yo');
    // oversized input-frame chat drops the whole frame
    assert.equal(safeParseClientMsg(JSON.stringify({
      t: 'input', input: { seq: 1, dt: 0.05, move: { x: 0, y: 0 }, chat: 'x'.repeat(3000) },
    })), null);
  });

  it('honest bot traffic produces zero anticheat violations', () => {
    // 20Hz for 20s of wall time, ±4ms jitter (what tools/bots sends), plus the
    // occasional double-dequeue (rate-drop path). Nothing may strike.
    const ac = new AntiCheat();
    const perTick = 8 * MAX_SPEED * (1 / 20); // 8u/s at 20Hz
    let t = 1_000_000;
    let p = { x: 0, y: 0 };
    for (let i = 0; i < 400; i++) {
      t += 50 + (i % 3); // 50/51/52ms spacing
      const req = ac.moveToVelocity(1, 0); // diagonal-free honest stick
      const ok = ac.checkInputBurst(7, i, t);
      assert.equal(ok, true, `burst trip at i=${i}`);
      ac.checkInputRate(7, i, t);
      const v = ac.checkVelocity(7, i, req.vx, req.vy);
      assert.equal(v.ok, true, `speed clamp at i=${i}`);
      const predicted = { x: p.x + v.vx * (1 / 20), y: p.y + v.vy * (1 / 20) };
      assert.equal(ac.checkTeleport(7, i, p, predicted), true, `teleport at i=${i}`);
      assert.equal(ac.checkTeleportBurst(7, i, predicted, t), true, `teleport-burst at i=${i}`);
      p = predicted;
    }
    assert.ok(perTick > 0);
    assert.equal(ac.violationsFor(7).length, 0);
    assert.equal(ac.getStrikes(7), 0);
    assert.equal(ac.isShadowBanned(7), false);
  });

  it('honest rate-drop (queueing artifact) never strikes or bans', () => {
    const ac = new AntiCheat();
    // Honest 20Hz where ONE extra input arrives in the same millisecond (the
    // queueing artifact): the rate check drops it — that is backpressure, not
    // abuse, so no strike may ever accumulate.
    let t = 5_000;
    for (let i = 0; i < 300; i++) {
      t += 50;
      assert.equal(ac.checkInputBurst(9, i, t), true, `burst tripped at i=${i}`);
      ac.checkInputRate(9, i, t);
      ac.checkInputRate(9, i, t); // same-ms re-dequeue -> dropped, no strike
    }
    assert.equal(ac.violationsFor(9).length > 0, true, 'rate drops are still recorded');
    assert.equal(ac.violationsFor(9).every((v) => v.kind === 'input-rate'), true);
    assert.equal(ac.getStrikes(9), 0);
    assert.equal(ac.shouldKick(9), false);
    assert.equal(ac.isShadowBanned(9), false);
  });

  it('burst flood strikes 3x -> shadowban kick', () => {
    const ac = new AntiCheat();
    let now = 9_000;
    for (let i = 0; i < 100 && !ac.shouldKick(3); i++) {
      now += 1;
      ac.checkInputBurst(3, i, now);
    }
    assert.equal(ac.shouldKick(3), true);
    assert.equal(ac.isShadowBanned(3), true);
    assert.equal(ac.getStrikes(3) >= 3, true);
    assert.equal(ac.violationsFor(3).filter((v) => v.kind === 'burst').length >= 3, true);
  });

  it('malformed marker never strikes (robustness, not cheat)', () => {
    const ac = new AntiCheat();
    for (let i = 0; i < 50; i++) ac.checkMalformed(4, i, 'fuzz probe');
    assert.equal(ac.violationsFor(4).length, 50);
    assert.equal(ac.getStrikes(4), 0);
    assert.equal(ac.shouldKick(4), false);
  });

  it('sanitizers clamp NaN/huge instead of poisoning state', () => {
    assert.equal(sanitizeMoveAxis(NaN), 0);
    assert.equal(sanitizeMoveAxis(Infinity), 0);
    assert.equal(sanitizeMoveAxis(999), 1);
    assert.equal(sanitizeMoveAxis(-999), -1);
    assert.ok(sanitizeInputDt(NaN) > 0 && sanitizeInputDt(NaN) <= 0.25);
    assert.equal(sanitizeInputDt(99), 0.25);
    assert.equal(sanitizeInputDt(-5), 0);
    assert.equal(sanitizeChatText(null), null);
    assert.equal(sanitizeChatText(42), null);
    assert.equal(sanitizeChatText('x'.repeat(5000)), null);
  });

  it('anticheat survives fuzz velocities without throwing', () => {
    const ac = new AntiCheat({ maxSpeed: 8 });
    for (const [x, y] of [[NaN, 0], [0, Infinity], [1e308, -1e308], [0, 0]] as const) {
      assert.doesNotThrow(() => ac.checkVelocity(1, 0, x, y));
      assert.doesNotThrow(() => ac.moveToVelocity(x, y));
    }
    assert.doesNotThrow(() => ac.checkMalformed(1, 0, 'fuzz probe'));
    assert.equal(ac.violationsFor(1).some((v) => v.kind === 'malformed'), true);
  });
});

describe('sec: audit log + rotation stub', () => {
  let dir = '';
  let prevAudit: string | undefined;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'aetherfall-audit-'));
    prevAudit = process.env.AUDIT_PATH;
    process.env.AUDIT_PATH = join(dir, 'audit.log');
  });
  afterEach(() => {
    if (prevAudit === undefined) delete process.env.AUDIT_PATH;
    else process.env.AUDIT_PATH = prevAudit;
    rmSync(dir, { recursive: true, force: true });
  });
  it('appends JSON lines for joins/kicks/wall-changes/redirects', () => {
    assert.equal(auditPath(), join(dir, 'audit.log'));
    assert.equal(audit('join', { pid: 1, name: 'bob' }), true);
    assert.equal(audit('kick', { pid: 2, reason: 'shadowban' }), true);
    assert.equal(audit('wall-change', { count: 3 }), true);
    assert.equal(audit('redirect', { pid: 4, shard: 'shard-1' }), true);
    const lines = readFileSync(join(dir, 'audit.log'), 'utf8').trim().split('\n');
    assert.equal(lines.length, 4);
    for (const [i, kind] of ['join', 'kick', 'wall-change', 'redirect'].entries()) {
      const rec = JSON.parse(lines[i]!) as { event: string; at: string };
      assert.equal(rec.event, kind);
      assert.ok(typeof rec.at === 'string');
    }
  });
  it('rotation stub: tiny maxBytes rotates to audit.log.1', () => {
    assert.equal(audit('join', { pid: 1 }), true);
    assert.equal(rotateAuditIfNeeded(10), true); // 10B limit forces rotation in test
    assert.equal(rotateAuditIfNeeded(10), false); // fresh file under limit
    assert.equal(audit('join', { pid: 2 }), true);
    const lines = readFileSync(join(dir, 'audit.log'), 'utf8').trim().split('\n');
    assert.equal(lines.length, 1);
  });
  it('audit() self-rotates past AUDIT_MAX_BYTES (no caller can forget)', () => {
    const p = join(dir, 'audit.log');
    // Push the log past the real 1MB cap with fat records (rotation is wired
    // into audit(), so this must rotate with zero external calls).
    const perRec = 2048;
    const n = Math.ceil(AUDIT_MAX_BYTES / perRec) + 50;
    for (let i = 0; i < n; i++) assert.equal(audit('join', { pid: i, pad: 'x'.repeat(perRec) }), true);
    assert.ok(existsSync(`${p}.1`), 'rotation happened without any external call');
    assert.ok(statSync(p).size <= AUDIT_MAX_BYTES, 'active log is back under the cap');
    const rotated = readFileSync(`${p}.1`, 'utf8').trim().split('\n');
    const cur = readFileSync(p, 'utf8').trim().split('\n');
    assert.ok(rotated.length > 1, 'rotated generation holds history');
    assert.equal(rotated.length + cur.length, n, 'no record lost to rotation');
  });
  it('audit never throws on unserializable details or unwritable path', () => {
    const cyclic: Record<string, unknown> = { pid: 1 };
    cyclic['self'] = cyclic;
    assert.equal(audit('join', cyclic), true);
    const bad = new Error('nope') as Error & { pid: number };
    bad.pid = 1;
    assert.equal(audit('kick', { err: bad }), true);
    const lines = readFileSync(join(dir, 'audit.log'), 'utf8').trim().split('\n');
    assert.equal(JSON.parse(lines[0]!).unserializable, true);
    // Unusable path (a file where a directory must be) must degrade to a
    // boolean, never an exception that would break the game loop.
    const prev = process.env.AUDIT_PATH;
    process.env.AUDIT_PATH = join(dir, 'audit.log', 'nested', 'audit.log');
    let ok: unknown;
    assert.doesNotThrow(() => {
      ok = audit('join', { pid: 9 });
    });
    assert.equal(typeof ok, 'boolean');
    if (prev === undefined) delete process.env.AUDIT_PATH;
    else process.env.AUDIT_PATH = prev;
  });
  it('AUDIT_MAX_BYTES default is sane', () => {
    assert.ok(AUDIT_MAX_BYTES >= 1024);
  });
});
