// AETHERFALL client — boss roster + HP-bar derivation.
//
// Bosses arrive in snapshots as ordinary `kind:'mob'` entities with a display
// name and a `level` (server/src/ai/npc.ts). Keeping the roster + ordering in
// its own module makes the HUD bar logic testable without a DOM.

import type { DrawEntity } from './types.js';

export interface BossBar {
  name: string;
  hp: number;
  maxHp: number;
}

/**
 * Known bosses, strongest first. Matching is case-insensitive substring on
 * the entity name so a display-name tweak does not silently drop a bar.
 */
export const BOSS_NAMES: readonly string[] = [
  'stone golem',
  'ember wyrm',
  'void wisp',
  'crypt warden',
];

/** Max simultaneous bars (matches BOSS_NAMES.length today). */
export const MAX_BOSS_BARS = 4;

export function isBossEntity(e: DrawEntity): boolean {
  const n = (e.name ?? '').toLowerCase();
  return BOSS_NAMES.some((b) => n.includes(b));
}

/** Sort key: roster order, then name, so bars never jump rows. */
export function bossOrder(name: string): number {
  const i = BOSS_NAMES.findIndex((b) => name.toLowerCase().includes(b));
  return i < 0 ? BOSS_NAMES.length : i;
}

/**
 * Live boss bars from a draw list. Drops dead/degenerate bosses and clamps to
 * MAX_BOSS_BARS. An empty list means "hide the bars" — the caller only ever
 * sees bosses inside the server interest radius.
 */
export function bossBars(list: DrawEntity[]): BossBar[] {
  const out: BossBar[] = [];
  for (const e of list) {
    if (!isBossEntity(e) || e.maxHp <= 0 || e.hp <= 0) continue;
    out.push({ name: e.name, hp: e.hp, maxHp: e.maxHp });
  }
  out.sort((a, b) => bossOrder(a.name) - bossOrder(b.name) || a.name.localeCompare(b.name));
  return out.slice(0, MAX_BOSS_BARS);
}

/** Bar gradient per boss; unknown bosses get a neutral ramp. */
const GRADIENTS: Record<string, string> = {
  'stone golem': 'linear-gradient(#ffcf8a,#b25a1e)',
  'ember wyrm': 'linear-gradient(#ffb36b,#c0392b)',
  'void wisp': 'linear-gradient(#d3a6ff,#7a3fd4)',
  'crypt warden': 'linear-gradient(#9fd8ff,#2b6ec0)',
};

export function bossGradient(name: string): string {
  const n = (name ?? '').toLowerCase();
  for (const k of Object.keys(GRADIENTS)) if (n.includes(k)) return GRADIENTS[k]!;
  return 'linear-gradient(#e8eef7,#7a8698)';
}