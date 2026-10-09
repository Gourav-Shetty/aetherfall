// AETHERFALL client — boss telegraph wire type + parse helper.
//
// Server broadcasts (server/src/index.ts, from ai/bosses.ts via ai/npc.ts):
//   { t:'event', kind:'telegraph',
//     payload:{ shape:'circle', x, y, r, ttlMs, label } }
// Labels seen in a live capture: 'golem-slam', 'wisp-blink', 'wisp-burst',
// 'warden-slam', 'wyrm-charge', 'wyrm-fire'. Renderers draw an expanding red
// circle over ttlMs, then flash once when the hit lands. The label is kept for
// debugging only — rendering is intentionally label-agnostic so a new boss
// skill needs no client change.

export interface TelegraphPayload {
  shape: 'circle';
  x: number;
  y: number;
  r: number;
  ttlMs: number;
  label: string;
}

/** Active telegraph with client receipt time (ms, performance.now basis). */
export interface ActiveTelegraph extends TelegraphPayload {
  t0: number;
}

function isFiniteNum(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

/** Validate an untrusted event payload. Returns null when not a telegraph. */
export function asTelegraph(p: unknown): TelegraphPayload | null {
  if (p === null || typeof p !== 'object') return null;
  const o = p as Record<string, unknown>;
  if (o['shape'] !== 'circle') return null;
  const { x, y, r, ttlMs, label } = o;
  if (!isFiniteNum(x) || !isFiniteNum(y) || !isFiniteNum(r)) return null;
  if (!isFiniteNum(ttlMs) || (ttlMs as number) <= 0 || (ttlMs as number) > 5000) return null;
  if (typeof label !== 'string' || label.length === 0 || label.length > 64) return null;
  if ((r as number) <= 0 || (r as number) > 30) return null;
  return {
    shape: 'circle',
    x: x as number,
    y: y as number,
    r: r as number,
    ttlMs: Math.round(ttlMs as number),
    label,
  };
}

/** Fraction of the windup elapsed in [0, 1+). */
export function telegraphFrac(t: ActiveTelegraph, now: number): number {
  if (t.ttlMs <= 0) return 1;
  return (now - t.t0) / t.ttlMs;
}
