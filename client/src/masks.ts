// @aetherfall/client — mask + vocation view models for the avatar hook.
// PURE state holders over the server's `event` payloads: no DOM, no
// rendering, no networking. `panels.ts` draws the pickers; `main.ts` stamps
// the overlay onto `DrawEntity`; both renderers draw it.
//
// Every helper is defensive about shape: unknown mask/vocation ids degrade
// to "no overlay" rather than throwing during a render frame.

import type { PaletteMode } from './a11y.js';

// ---------------------------------------------------------------------------
// mask glyphs (mirror server/src/game/masks.ts; client-owned copy so the
// renderers never import server code)
// ---------------------------------------------------------------------------

/** Mask id -> glyph drawn above the avatar. */
export const MASK_GLYPHS: Record<string, string> = {
  'seraph-shard': '◈',
  'dusk-maw': '◉',
  'gallow-beak': '➶',
  'choir-horn': '❖',
  'vesper-plume': '◍',
  'tithe-scale': '⬟',
  'cinder-hide': '⬢',
  'halo-rind': '✧',
};

/** Glyph for a mask id, or '' when bare-faced/unknown (renders nothing). */
export function maskGlyphFor(maskId: string | null | undefined): string {
  if (!maskId) return '';
  return MASK_GLYPHS[maskId] ?? '';
}

/** Nametag text with the worn mask's glyph above it (`glyph name`). */
export function nametagFor(name: string, maskId: string | null | undefined): string {
  const g = maskGlyphFor(maskId);
  return g ? `${g} ${name}` : name;
}

// ---------------------------------------------------------------------------
// vocation disc colours (reuse the a11y palette system: one set per mode)
// ---------------------------------------------------------------------------

export type VocationId = 'dawnwarden' | 'galehunter' | 'pyrecantor' | 'vesperal';

export const VOCATION_IDS: VocationId[] = ['dawnwarden', 'galehunter', 'pyrecantor', 'vesperal'];

export const VOCATION_NAMES: Record<VocationId, string> = {
  dawnwarden: 'Dawnwarden',
  galehunter: 'Galehunter',
  pyrecantor: 'Pyrecantor',
  vesperal: 'Vesperal',
};

/**
 * Class-coloured base-disc colours, one set per colourblind-safe palette
 * mode. Hues are original to AETHERFALL (amber tank, sky skirmisher, ember
 * caster, violet support); each mode shifts them off the deficiency axis
 * the same way PALETTES shifts entity colours.
 */
export const VOCATION_COLORS: Record<PaletteMode, Record<VocationId, string>> = {
  default: {
    dawnwarden: '#ffb84d',
    galehunter: '#4dc3ff',
    pyrecantor: '#ff6b4d',
    vesperal: '#c58bff',
  },
  deuteranopia: {
    dawnwarden: '#ffb000',
    galehunter: '#56b4e9',
    pyrecantor: '#cc79a7',
    vesperal: '#f0e442',
  },
  protanopia: {
    dawnwarden: '#ffa000',
    galehunter: '#009e73',
    pyrecantor: '#0072b2',
    vesperal: '#f0e442',
  },
  tritanopia: {
    dawnwarden: '#e69f00',
    galehunter: '#009e73',
    pyrecantor: '#d55e00',
    vesperal: '#cc79a7',
  },
};

/** Base-disc colour for a vocation under a palette mode ('' when unknown). */
export function vocationDiscColor(mode: PaletteMode, vocation: string | null | undefined): string {
  if (!vocation) return '';
  return VOCATION_COLORS[mode]?.[vocation as VocationId] ?? '';
}

export function isVocationId(v: string): v is VocationId {
  return (VOCATION_IDS as string[]).includes(v);
}

// ---------------------------------------------------------------------------
// overlay store (playerId -> worn mask + sworn vocation)
// ---------------------------------------------------------------------------

export type AvatarOverlay = {
  playerId: number;
  mask: string | null;
  vocation: string | null;
};

function num(v: unknown, fallback = 0): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

function str(v: unknown, fallback = ''): string {
  return typeof v === 'string' ? v : fallback;
}

function rec(v: unknown): Record<string, unknown> | null {
  return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

/**
 * Tracks who wears what. Fed by `mask-equipped` / `mask-unequipped` /
 * `vocation` events plus the `maskId`/`vocation` fields of the `progression`
 * snapshot (so a join bootstrap and a reconnect both converge). Unknown
 * kinds return false so `SystemsView` keeps routing them elsewhere.
 */
export class AvatarOverlayStore {
  private overlays = new Map<number, AvatarOverlay>();
  revision = 0;

  apply(kind: string, payload: unknown): boolean {
    const p = rec(payload);
    if (!p) return false;
    if (kind === 'mask-equipped') {
      const playerId = num(p['playerId'], -1);
      const maskId = str(p['maskId']);
      if (playerId < 0 || !maskId || !MASK_GLYPHS[maskId]) return false;
      const cur = this.overlays.get(playerId) ?? { playerId, mask: null, vocation: null };
      this.overlays.set(playerId, { ...cur, mask: maskId });
      this.revision++;
      return true;
    }
    if (kind === 'mask-unequipped') {
      const playerId = num(p['playerId'], -1);
      if (playerId < 0) return false;
      const cur = this.overlays.get(playerId);
      if (!cur?.mask) return true; // idempotent: already bare
      this.overlays.set(playerId, { ...cur, mask: null });
      this.revision++;
      return true;
    }
    if (kind === 'vocation') {
      const playerId = num(p['playerId'], -1);
      const vocation = str(p['vocation']);
      if (playerId < 0 || !isVocationId(vocation)) return false;
      const cur = this.overlays.get(playerId) ?? { playerId, mask: null, vocation: null };
      this.overlays.set(playerId, { ...cur, vocation });
      this.revision++;
      return true;
    }
    if (kind === 'progression') {
      const playerId = num(p['playerId'], -1);
      if (playerId < 0) return false;
      const mask = str(p['maskId']) || null;
      const vocation = str(p['vocation']) || null;
      if ((mask && !MASK_GLYPHS[mask]) || (vocation && !isVocationId(vocation))) return false;
      const cur = this.overlays.get(playerId) ?? { playerId, mask: null, vocation: null };
      if (cur.mask === mask && cur.vocation === vocation) return true; // no-op sync
      this.overlays.set(playerId, { playerId, mask, vocation });
      this.revision++;
      return true;
    }
    return false;
  }

  forPlayer(playerId: number): AvatarOverlay | undefined {
    return this.overlays.get(playerId);
  }

  get size(): number {
    return this.overlays.size;
  }

  reset(): void {
    this.overlays.clear();
    this.revision++;
  }
}
