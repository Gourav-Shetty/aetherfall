// ops/scripts/lib/smoke-probe.mjs — join / input / anticheat / drain probe.
//
// PowerShell 5.1 makes a WebSocket client awkward (async/await inside the PS
// pipeline), so the live-protocol half of the smoke test lives here and
// ops/scripts/smoke-test.ps1 owns the HTTP half (health + metrics assertions).
//
// Usage:
//   node ops/scripts/lib/smoke-probe.mjs --server ws://localhost:8081
//   node ops/scripts/lib/smoke-probe.mjs --server ws://localhost:8081 \
//        --control http://localhost:9190 --expect-kill --log .ops/run/shard-0.log
//
// Checks, each printed in TAP style:
//   1 join       hello -> welcome with my entity in the snapshot
//   2 snapshots  >= --min-snapshots frames arrive inside --timeout
//   3 input      honest 20Hz input is accepted (authoritative seq advances)
//   4 anticheat  a teleport attempt is clamped, not obeyed
//   5 kill       POST /drain stops acceptance (1013 on a late join) and the
//                shard log contains drain-begin + drain-complete
//
// Exits non-zero when any check fails.

import WebSocket from 'ws';
import { readFileSync, existsSync } from 'node:fs';

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0 && i + 1 < process.argv.length) return process.argv[i + 1];
  const pref = `--${name}=`;
  const hit = process.argv.find((a) => a.startsWith(pref));
  return hit ? hit.slice(pref.length) : fallback;
}
const has = (name) => process.argv.includes(`--${name}`);

const SERVER = arg('server', 'ws://localhost:8081');
const CONTROL = arg('control', '');
const MIN_SNAPSHOTS = Number(arg('min-snapshots', '3'));
const TIMEOUT_MS = Number(arg('timeout', '20000'));
const LOG_FILE = arg('log', '');
const NAME = arg('name', `smoke-${process.pid}`);

let failures = 0;
let step = 0;

function check(name, ok, detail = '') {
  step++;
  if (!ok) failures++;
  console.log(`${ok ? 'ok' : 'not ok'} ${step} - ${name}${detail ? ` :: ${detail}` : ''}`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Open one socket, run `onWelcome`, then wait for `minSnapshots` frames. */
function probe(kind, onWelcome, minSnapshots = MIN_SNAPSHOTS) {
  return new Promise((done) => {
    const ws = new WebSocket(SERVER);
    const seen = { welcome: null, snapshots: 0, events: [], start: null, seq: -1, reason: 'none' };
    const finish = (reason) => {
      clearTimeout(timer);
      try { ws.close(); } catch { /* noop */ }
      seen.reason = reason;
      done(seen);
    };
    const timer = setTimeout(() => finish('timeout'), TIMEOUT_MS);
    ws.on('open', () => ws.send(JSON.stringify({ t: 'hello', name: `${NAME}-${kind}`, proto: 1 })));
    ws.on('error', (e) => finish(`ws-error:${String(e.message ?? e).slice(0, 80)}`));
    ws.on('close', () => { seen.closed = true; });
    ws.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(String(raw)); } catch { return; }
      if (msg.t === 'welcome') {
        seen.welcome = msg;
        seen.start = msg.snapshot.find((e) => e.id === msg.id) ?? null;
        if (onWelcome) onWelcome(ws, msg, seen);
        return;
      }
      if (msg.t === 'snapshot') {
        seen.snapshots++;
        const me = msg.entities.find((e) => e.id === seen.welcome?.id);
        if (me && typeof me.seq === 'number') seen.seq = me.seq;
        if (seen.snapshots >= minSnapshots) finish('done');
        return;
      }
      if (msg.t === 'event') {
        seen.events.push(msg.kind);
        if (seen.events.includes('kicked')) finish('kicked');
      }
    });
  });
}

/** Illegal 9999 u/s input must be clamped, not obeyed. */
function anticheatProbe() {
  return new Promise((done) => {
    const ws = new WebSocket(SERVER);
    let id = -1;
    let before = null;
    let snaps = 0;
    const finish = (r) => {
      clearTimeout(timer);
      try { ws.close(); } catch { /* noop */ }
      done(r);
    };
    const timer = setTimeout(() => finish({ ok: false, detail: 'timeout' }), TIMEOUT_MS);
    ws.on('open', () => ws.send(JSON.stringify({ t: 'hello', name: `${NAME}-cheat`, proto: 1 })));
    ws.on('error', (e) => finish({ ok: false, detail: `ws-error:${String(e.message ?? e).slice(0, 60)}` }));
    ws.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(String(raw)); } catch { return; }
      if (msg.t === 'welcome') {
        id = msg.id;
        const me = msg.snapshot.find((e) => e.id === id);
        if (me) before = { x: me.p.x, y: me.p.y };
        ws.send(JSON.stringify({ t: 'input', input: { seq: 1, dt: 0.05, move: { x: 9999, y: 9999 } } }));
        return;
      }
      if (msg.t !== 'snapshot') return;
      snaps++;
      const me = msg.entities.find((e) => e.id === id);
      if (!me || snaps < 4 || !before) return;
      const moved = Math.hypot(me.p.x - before.x, me.p.y - before.y);
      const speed = Math.hypot(me.v.x, me.v.y);
      // Honest bound: 4 snapshots @10Hz ~= 0.4s * 8 u/s = 3.2u + spawn jitter.
      const clamped = moved < 20 && speed <= 8 * Math.SQRT2 + 0.01;
      finish({
        ok: clamped,
        detail: `moved=${moved.toFixed(2)}u speed=${speed.toFixed(2)}u/s snaps=${snaps}`,
      });
    });
  });
}

async function main() {
  console.log(`# smoke-probe server=${SERVER} control=${CONTROL || '(none)'} log=${LOG_FILE || '(none)'}`);

  const join = await probe('join', null);
  check(
    'join: hello -> welcome with my entity in the snapshot',
    !!join.welcome && !!join.start && join.snapshots >= MIN_SNAPSHOTS,
    `id=${join.welcome?.id ?? '-'} snapshots=${join.snapshots} reason=${join.reason}`,
  );
  check(`snapshots: >= ${MIN_SNAPSHOTS} frames inside ${TIMEOUT_MS}ms`, join.snapshots >= MIN_SNAPSHOTS, `got=${join.snapshots}`);

  const input = await probe('input', (ws) => {
    let seq = 0;
    const iv = setInterval(() => {
      if (ws.readyState !== 1) { clearInterval(iv); return; }
      seq++;
      ws.send(JSON.stringify({ t: 'input', input: { seq, dt: 0.05, move: { x: 1, y: 0 } } }));
    }, 50);
    setTimeout(() => clearInterval(iv), 2000);
  }, 5);
  check(
    'input: honest 20Hz input is accepted (authoritative seq advances)',
    input.seq > 0,
    `seq=${input.seq} snapshots=${input.snapshots} reason=${input.reason}`,
  );

  const cheat = await anticheatProbe();
  check('anticheat: teleport attempt is clamped', cheat.ok, cheat.detail);

  if (has('expect-kill')) {
    if (!CONTROL) {
      check('kill: drain control endpoint requested', false, '--control was not provided');
    } else {
      let status = 'no-response';
      try {
        const res = await fetch(`${CONTROL}/drain`, { method: 'POST' });
        status = String(res.status);
      } catch (e) {
        status = `throw:${String(e.message ?? e).slice(0, 60)}`;
      }
      check('kill: POST /drain accepted', status === '200' || status === '202', `status=${status}`);

      await sleep(300);
      const refused = await new Promise((done) => {
        const ws = new WebSocket(SERVER);
        const finish = (r) => {
          clearTimeout(timer);
          try { ws.close(); } catch { /* noop */ }
          done(r);
        };
        const timer = setTimeout(() => finish('accepted'), 4000);
        ws.on('open', () => ws.send(JSON.stringify({ t: 'hello', name: `${NAME}-late`, proto: 1 })));
        ws.on('close', (code) => finish(String(code)));
        ws.on('error', () => { /* close carries the verdict */ });
        ws.on('message', (raw) => {
          try {
            const m = JSON.parse(String(raw));
            if (m.t === 'welcome') finish('accepted');
            if (m.t === 'event' && m.kind === 'server-draining') finish('draining-event');
          } catch { /* ignore */ }
        });
      });
      check(
        'kill: a late join is not admitted (socket closed, never welcomed)',
        refused !== 'accepted',
        `close=${refused}`,
      );

      if (LOG_FILE && existsSync(LOG_FILE)) {
        let log = '';
        try { log = readFileSync(LOG_FILE, 'utf8'); } catch { /* ignore */ }
        check('kill: drain-begin logged', log.includes('drain-begin'), LOG_FILE);
        check('kill: drain-complete logged', log.includes('drain-complete'), LOG_FILE);
      }
    }
  }

  console.log(`# smoke-probe ${failures === 0 ? 'PASS' : 'FAIL'} (${step - failures}/${step})`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('# smoke-probe fatal', e);
  process.exit(1);
});