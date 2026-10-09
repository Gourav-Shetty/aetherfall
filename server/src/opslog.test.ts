// @aetherfall/server — structured logging tests (LOG_JSON=1 contract).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MAX_VALUE_CHARS, OpsLog, logJsonEnabled, nextRequestId, sanitizeFields } from './opslog.js';

type Line = { line: string; level: string };

function capture(json: boolean, minLevel?: 'debug' | 'info' | 'warn' | 'error'): { lines: Line[]; log: OpsLog } {
  const lines: Line[] = [];
  const log = new OpsLog({
    json,
    base: { shard: 'shard-2' },
    minLevel,
    write: (line, level) => lines.push({ line, level }),
  });
  return { lines, log };
}

function parse(line: string): Record<string, unknown> {
  return JSON.parse(line) as Record<string, unknown>;
}

test('LOG_JSON enables JSON output', () => {
  assert.equal(logJsonEnabled({ LOG_JSON: '1' }), true);
  assert.equal(logJsonEnabled({ LOG_JSON: 'true' }), true);
  assert.equal(logJsonEnabled({ LOG_JSON: 'YES' }), true);
  assert.equal(logJsonEnabled({ LOG_JSON: 'on' }), true);
  assert.equal(logJsonEnabled({ LOG_JSON: ' 1 ' }), true);
  assert.equal(logJsonEnabled({ LOG_JSON: '0' }), false);
  assert.equal(logJsonEnabled({ LOG_JSON: '' }), false);
  assert.equal(logJsonEnabled({}), false);
});

test('JSON mode emits one parsable object per line with ts/level/msg', () => {
  const { lines, log } = capture(true);
  log.info('server booted', { port: 8081 });
  assert.equal(lines.length, 1);
  const rec = parse(lines[0]!.line);
  assert.equal(rec.level, 'info');
  assert.equal(rec.msg, 'server booted');
  assert.equal(rec.port, 8081);
  assert.equal(rec.shard, 'shard-2');
  assert.equal(rec.pid, process.pid);
  assert.match(String(rec.ts), /^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/);
  assert.equal(lines[0]!.level, 'info');
});

test('warn and error route to the error sink with the right level', () => {
  const { lines, log } = capture(true);
  log.warn('slow tick', { ms: 80 });
  log.error('tick failed', { err: new Error('boom') });
  assert.equal(lines[0]!.level, 'warn');
  assert.equal(lines[1]!.level, 'error');
  const err = parse(lines[1]!.line).err as { name: string; message: string };
  assert.equal(err.name, 'Error');
  assert.equal(err.message, 'boom');
});

test('minLevel drops debug by default and keeps everything at debug', () => {
  const info = capture(true);
  info.log.debug('hidden');
  info.log.info('shown');
  assert.equal(info.lines.length, 1);

  const all = capture(true, 'debug');
  all.log.debug('shown');
  assert.equal(all.lines.length, 1);
});

test('tick correlation is attached automatically and refreshed per tick', () => {
  const { lines, log } = capture(true);
  log.setTick(41);
  assert.equal(log.tick, 41);
  log.info('sim step');
  assert.equal(parse(lines[0]!.line).tick, 41);
  log.setTick(42);
  log.info('sim step');
  assert.equal(parse(lines[1]!.line).tick, 42);
  log.setTick(null);
  log.info('after drain');
  assert.equal(parse(lines[2]!.line).tick, undefined);
});

test('child loggers inherit base fields and share the live tick', () => {
  const { lines, log } = capture(true);
  const conn = log.child({ requestId: 'r-abc' });
  log.setTick(7);
  conn.info('join', { pid: 3 });
  const rec = parse(lines[0]!.line);
  assert.equal(rec.requestId, 'r-abc');
  assert.equal(rec.shard, 'shard-2');
  assert.equal(rec.pid, 3);
  assert.equal(rec.tick, 7);
  // A per-call tick still overrides the shared one.
  conn.info('join', { tick: 99 });
  assert.equal(parse(lines[1]!.line).tick, 99);
  // The parent is unaffected by child fields.
  log.info('tick done');
  const parent = parse(lines[2]!.line);
  assert.equal(parent.requestId, undefined);
  assert.equal(parent.tick, 7);
});

test('event() stamps a structured event name', () => {
  const { lines, log } = capture(true);
  log.event('join', { pid: 1 }, 'warn');
  const rec = parse(lines[0]!.line);
  assert.equal(rec.event, 'join');
  assert.equal(rec.msg, 'join');
  assert.equal(rec.level, 'warn');
});

test('request ids are unique and stable-shaped', () => {
  const a = nextRequestId(1_700_000_000_000);
  const b = nextRequestId(1_700_000_000_000);
  assert.match(a, /^r-[0-9a-z]+-[0-9a-z]+$/);
  assert.notEqual(a, b);
});

test('fields are sanitized: undefined dropped, errors shaped, cycles guarded', () => {
  const cyclic: Record<string, unknown> = { name: 'loop' };
  cyclic.self = cyclic;
  const out = sanitizeFields({
    nothing: undefined,
    keep: 1,
    err: new TypeError('bad'),
    when: new Date('2026-01-02T03:04:05.000Z'),
    fn: () => 1,
    sym: Symbol('x'),
    nan: Number.NaN,
    cyclic,
    list: [1, 2, 3],
  });
  assert.ok(!('nothing' in out));
  assert.equal(out.keep, 1);
  assert.equal((out.err as { name: string }).name, 'TypeError');
  assert.equal(out.when, '2026-01-02T03:04:05.000Z');
  assert.equal(out.fn, '[function]');
  assert.equal(out.sym, '[symbol]');
  assert.equal(out.nan, 'NaN');
  assert.deepEqual((out.cyclic as { self: string }).self, '[circular]');
  assert.deepEqual(out.list, [1, 2, 3]);
});

test('long strings are truncated with a visible marker', () => {
  const long = 'x'.repeat(MAX_VALUE_CHARS + 50);
  const out = sanitizeFields({ long });
  const v = String(out.long);
  assert.ok(v.startsWith('x'.repeat(10)));
  assert.ok(v.endsWith('...[+50]'));
  assert.ok(v.length < long.length);
});

test('a JSON-mode line with an exotic field still parses', () => {
  const { lines, log } = capture(true);
  log.info('edge', { big: 12345678901234567890n, arr: [{ a: 1 }], nested: { deep: { deeper: [1, 2] } } });
  const rec = parse(lines[0]!.line);
  assert.equal(rec.big, '12345678901234567890');
  assert.deepEqual((rec.nested as { deep: { deeper: number[] } }).deep.deeper, [1, 2]);
});

test('text mode keeps human-readable key=value output', () => {
  const { lines, log } = capture(false);
  log.setTick(5);
  log.info('server booted', { port: 8081, db: 'json' });
  const line = lines[0]!.line;
  assert.match(line, /^\[info\] server booted /);
  assert.match(line, /port=8081/);
  assert.match(line, /shard=shard-2/);
  assert.match(line, /tick=5/);
  // Strings containing spaces are quoted so the line stays parseable.
  log.info('m', { note: 'hello world' });
  assert.match(lines[1]!.line, /note="hello world"/);
});

test('a throwing sink never propagates into the caller', () => {
  const log = new OpsLog({
    json: true,
    write: () => {
      throw new Error('EPIPE');
    },
  });
  assert.doesNotThrow(() => log.info('still fine'));
});