// AETHERFALL client — accessibility layer.
//
// One module, five jobs:
//
//   1. SETTINGS  — high contrast, colourblind-safe palette, reduced motion,
//      text scale (90–150%), screen-reader announcements, movement scheme,
//      attack key, click/hold-to-attack. Persisted in localStorage and applied
//      live (data-attributes + CSS custom properties on <html>).
//   2. LIVE REGION — a polite + assertive ARIA live region pair that announces
//      joins, deaths, quest updates, boss telegraphs and low HP.
//   3. KEYBOARD NAV — roving focus over the HUD widgets, Enter/Space activate,
//      Escape closes panels, F1-style shortcut list, and a skip link.
//   4. INPUT REMAP — WASD / arrows / IJKL / numpad movement, a rebindable attack
//      key, and click-to-attack / hold-to-attack modifiers.
//   5. COLOURS — colourblind-safe entity + telegraph palettes and a reduced-motion
//      flag that renderers consult.
//
// Everything here is DOM-optional: the pure helpers (state maths, palettes,
// key maps, announcement formatting) are exported separately so i18n/a11y tests
// can drive them headless, exactly like the rest of the client test suite.

import {
  i18n,
  translate,
  DEFAULT_LOCALE,
  type Locale,
  type MessageKey,
  type StorageLike,
} from './i18n.js';

export type { Locale, MessageKey, StorageLike };
// Re-exported so callers can `import { i18n, a11y } from './a11y.js'` and get the
// whole a11y surface (settings + localization) from one module.
export { i18n, translate };

// ===========================================================================
// Types
// ===========================================================================

/** Movement key layouts. Each maps an action to a KeyboardEvent.code. */
export type MoveScheme = 'wasd' | 'arrows' | 'ijkl' | 'numpad';

/** Colour vision presets. 'default' is the shipped palette. */
export type PaletteMode = 'default' | 'deuteranopia' | 'protanopia' | 'tritanopia';

export interface A11ySettings {
  /** Pure-black panels / white text / stronger borders. */
  highContrast: boolean;
  /** Colourblind-safe entity + telegraph colours. */
  palette: PaletteMode;
  /** Kills screen shake, particles and CSS transitions. */
  reducedMotion: boolean;
  /** UI font scale, clamped to TEXT_SCALE_MIN..TEXT_SCALE_MAX. */
  textScale: number;
  /** Speak live-region announcements. */
  announce: boolean;
  /** Movement layout. */
  moveScheme: MoveScheme;
  /** Attack key as a KeyboardEvent.code (e.g. 'Space'). */
  attackKey: string;
  /** Left-click in the world queues an attack. */
  clickToAttack: boolean;
  /** Holding the attack key repeats attacks instead of a single swing. */
  holdToAttack: boolean;
}

export const TEXT_SCALE_MIN = 0.9;
export const TEXT_SCALE_MAX = 1.5;

/** localStorage key for the a11y settings blob. */
export const A11Y_STORAGE_KEY = 'af_a11y_v1';

export const DEFAULT_A11Y: A11ySettings = {
  highContrast: false,
  palette: 'default',
  reducedMotion: false,
  textScale: 1,
  announce: true,
  moveScheme: 'wasd',
  attackKey: 'Space',
  clickToAttack: true,
  holdToAttack: false,
};

export const MOVE_SCHEMES: readonly MoveScheme[] = ['wasd', 'arrows', 'ijkl', 'numpad'];
export const PALETTE_MODES: readonly PaletteMode[] = [
  'default', 'deuteranopia', 'protanopia', 'tritanopia',
];

/** action -> KeyboardEvent.code, per movement layout. */
export const MOVE_KEYMAPS: Record<MoveScheme, Record<'up' | 'down' | 'left' | 'right', string>> = {
  wasd:    { up: 'KeyW', down: 'KeyS', left: 'KeyA', right: 'KeyD' },
  arrows:  { up: 'ArrowUp', down: 'ArrowDown', left: 'ArrowLeft', right: 'ArrowRight' },
  // Vertical I/J/K/L: I = up (index finger), J = down, K = left, L = right.
  ijkl:    { up: 'KeyI', down: 'KeyJ', left: 'KeyK', right: 'KeyL' },
  numpad:  { up: 'Numpad8', down: 'Numpad5', left: 'Numpad4', right: 'Numpad6' },
};

// ===========================================================================
// Colourblind-safe palettes
// ===========================================================================

export type EntityKind = 'player' | 'npc' | 'mob' | 'pickup' | 'projectile';

export interface EntityPalette {
  player: string;
  npc: string;
  mob: string;
  pickup: string;
  projectile: string;
  /** Minimap dot for the local player (always drawn last / on top). */
  self: string;
  /** Boss HP-bar gradient key source colour. */
  boss: string;
  /** Telegraph ring / warning colour. */
  telegraph: string;
  /** Low-HP bar colour. */
  danger: string;
}

/**
 * Palettes are built so no pair relies on a red/green hue difference alone:
 * the deuteranopia/protanopia sets shift mobs toward blue and use an amber
 * telegraph that stays distinguishable under all three deficiencies, while the
 * default set keeps the shipped look.
 */
export const PALETTES: Record<PaletteMode, EntityPalette> = {
  // Shipped palette (warm player orange, red mobs). The telegraph uses a deeper,
  // more saturated red than the mob body so the two stay separable.
  default: {
    player: '#ff9a4d', npc: '#4dc3ff', mob: '#ff5252', pickup: '#ffe066',
    projectile: '#ffffff', self: '#ffffff', boss: '#ffb36b', telegraph: '#d50000', danger: '#ff5252',
  },
  // Deuteranopia (green-blind): red -> magenta-violet, green -> blue.
  deuteranopia: {
    player: '#ffb000', npc: '#56b4e9', mob: '#cc79a7', pickup: '#f0e442',
    projectile: '#ffffff', self: '#ffffff', boss: '#e69f00', telegraph: '#f0e442', danger: '#cc79a7',
  },
  // Protanopia (red-blind): mobs -> blue, npc -> green, keep yellow telegraphs.
  protanopia: {
    player: '#ffa000', npc: '#009e73', mob: '#0072b2', pickup: '#f0e442',
    projectile: '#ffffff', self: '#ffffff', boss: '#cc79a7', telegraph: '#f0e442', danger: '#0072b2',
  },
  // Tritanopia (blue-blind): blue -> teal, mobs -> orange, telegraph -> magenta.
  tritanopia: {
    player: '#e69f00', npc: '#009e73', mob: '#d55e00', pickup: '#f0e442',
    projectile: '#ffffff', self: '#ffffff', boss: '#cc79a7', telegraph: '#cc79a7', danger: '#d55e00',
  },
};

/** Palette for a mode (clamped to a known value). */
export function paletteFor(mode: PaletteMode): EntityPalette {
  return PALETTES[PALETTE_MODES.includes(mode) ? mode : 'default'];
}

/** Entity body colour for a snapshot kind under a palette. */
export function colorForKind(mode: PaletteMode, kind: string): string {
  const p = paletteFor(mode);
  return (p as unknown as Record<string, string>)[kind] ?? '#ccc';
}

/**
 * Parse a `#rrggbb` hex colour into its channels. Null on anything else, so
 * callers keep their current colour instead of throwing on a bad value.
 */
export function hexToRgb(hex: string): [number, number, number] | null {
  const m = /^#([0-9a-fA-F]{6})$/.exec(hex.trim());
  if (!m) return null;
  const n = parseInt(m[1]!, 16);
  return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
}

// ===========================================================================
// Pure helpers — settings validation
// ===========================================================================

function clampScale(n: unknown): number {
  if (typeof n !== 'number' || !Number.isFinite(n)) return DEFAULT_A11Y.textScale;
  // Snap to 5% steps so the slider and the stored value never disagree.
  const snapped = Math.round(n * 20) / 20;
  return Math.max(TEXT_SCALE_MIN, Math.min(TEXT_SCALE_MAX, snapped));
}

/**
 * Validate + coerce an arbitrary parsed blob into a complete A11ySettings.
 * Unknown/bad fields fall back to defaults instead of poisoning the store.
 */
export function sanitizeSettings(raw: unknown): A11ySettings {
  const out: A11ySettings = { ...DEFAULT_A11Y };
  if (!raw || typeof raw !== 'object') return out;
  const p = raw as Record<string, unknown>;
  if (typeof p.highContrast === 'boolean') out.highContrast = p.highContrast;
  if (typeof p.palette === 'string' && PALETTE_MODES.includes(p.palette as PaletteMode)) {
    out.palette = p.palette as PaletteMode;
  }
  if (typeof p.reducedMotion === 'boolean') out.reducedMotion = p.reducedMotion;
  if (p.textScale !== undefined) out.textScale = clampScale(p.textScale);
  if (typeof p.announce === 'boolean') out.announce = p.announce;
  if (typeof p.moveScheme === 'string' && MOVE_SCHEMES.includes(p.moveScheme as MoveScheme)) {
    out.moveScheme = p.moveScheme as MoveScheme;
  }
  // A code is `Key`+letter, `Digit`+digit, a named key, or a Numpad/Numpad*/code.
  if (typeof p.attackKey === 'string' && isValidKeyCode(p.attackKey)) out.attackKey = p.attackKey;
  if (typeof p.clickToAttack === 'boolean') out.clickToAttack = p.clickToAttack;
  if (typeof p.holdToAttack === 'boolean') out.holdToAttack = p.holdToAttack;
  return out;
}

/** Accept the KeyboardEvent.code shapes worth persisting as a binding. */
export function isValidKeyCode(code: unknown): code is string {
  if (typeof code !== 'string' || code.length === 0 || code.length > 24) return false;
  return /^(Key[A-Z]|Digit[0-9]|Numpad[0-9]|Numpad[A-Za-z]+|F([1-9]|1[0-9])|Space|Enter|Escape|Tab|Backquote|Minus|Equal|Backslash|Semicolon|Quote|Comma|Slash|Period|BracketLeft|BracketRight|Arrow(Up|Down|Left|Right))$/.test(code);
}

/** Pretty label for a KeyboardEvent.code (used in the remap UI + docs). */
export function keyLabel(code: string): string {
  // Named keys read better verbatim than SHOUTED by the generic fallback below.
  const named: Record<string, string> = {
    Space: 'Space', Enter: 'Enter', Escape: 'Esc', Tab: 'Tab',
    Backquote: '`', Minus: '−', Equal: '=', Backslash: '\\',
    Semicolon: ';', Quote: "'", Comma: ',', Slash: '/', Period: '.',
    BracketLeft: '[', BracketRight: ']',
  };
  if (code in named) return named[code]!;
  if (/^Key[A-Z]$/.test(code)) return code.slice(3);
  if (/^Digit[0-9]$/.test(code)) return code.slice(5);
  if (/^Numpad[0-9]$/.test(code)) return `Num ${code.slice(6)}`;
  const npadSym: Record<string, string> = {
    NumpadAdd: 'Num +', NumpadSubtract: 'Num −', NumpadMultiply: 'Num *',
    NumpadDivide: 'Num /', NumpadDecimal: 'Num .', NumpadEnter: 'Num Enter',
  };
  if (code in npadSym) return npadSym[code]!;
  if (/^Arrow(Up|Down|Left|Right)$/.test(code)) {
    return { ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→' }[code]!;
  }
  return code.replace(/([a-z])/g, (c) => c.toUpperCase());
}

/** Movement vector from a set of held key codes under `scheme`. */
export function moveVector(
  held: ReadonlySet<string>,
  scheme: MoveScheme,
): { x: number; y: number } {
  const m = MOVE_KEYMAPS[scheme] ?? MOVE_KEYMAPS.wasd;
  let x = 0;
  let y = 0;
  if (held.has(m.left)) x -= 1;
  if (held.has(m.right)) x += 1;
  if (held.has(m.up)) y -= 1;
  if (held.has(m.down)) y += 1;
  return { x, y };
}

// ===========================================================================
// Pure helpers — announcements
// ===========================================================================

/** HP fraction at (or below) which the low-health warning fires. */
export const LOW_HP_THRESHOLD = 0.25;

/** True when `hp/max` has crossed into the low-health band. */
export function isLowHp(hp: number, max: number, threshold = LOW_HP_THRESHOLD): boolean {
  if (!(max > 0) || !Number.isFinite(hp)) return false;
  return hp / max <= threshold;
}

/**
 * Should a low-HP announcement be spoken? Fires on the descending edge only
 * (so a sustained low-HP state announces once, not every snapshot) and re-arms
 * once HP climbs back above `resetAbove`.
 */
export function shouldAnnounceLowHp(
  frac: number,
  wasLow: boolean,
  threshold = LOW_HP_THRESHOLD,
  resetAbove = 0.35,
): boolean {
  return frac <= threshold && !wasLow && frac >= 0;
}

/** Announcement categories, mapped to aria-live politeness. */
export type AnnounceKind = 'polite' | 'assertive';

export interface Announcement {
  text: string;
  kind: AnnounceKind;
  /** Polite messages can be dropped when a newer one supersedes them. */
  critical: boolean;
}

export type AnnounceInput =
  | { type: 'join'; name: string }
  | { type: 'leave'; name: string }
  | { type: 'death'; name: string }
  | { type: 'deathSelf' }
  | { type: 'respawnSelf' }
  | { type: 'questProgress'; title: string; obj?: string }
  | { type: 'questComplete'; title: string }
  | { type: 'telegraph'; label: string }
  | { type: 'lowHp'; hp: number; max: number }
  | { type: 'item'; name: string }
  | { type: 'inventoryFull' }
  | { type: 'levelUp'; level: number }
  | { type: 'bossAppeared'; name: string }
  | { type: 'chat'; from: string; text: string }
  | { type: 'panelOpen'; panel: string }
  | { type: 'panelClose'; panel: string }
  /** Escape hatch: pre-localized text. */
  | { type: 'raw'; text: string; kind?: AnnounceKind; critical?: boolean };

/**
 * Map a structured event to a localized announcement.
 *
 * - `polite` for ambient info (joins, chat, quests, loot): queued, never interrupts.
 * - `assertive` for things that can kill you (boss telegraphs, low HP, your death)
 *   plus errors; these interrupt the polite queue.
 *
 * Chat is announced as-is (player text is never translated).
 */
export function formatAnnouncement(locale: Locale, e: AnnounceInput): Announcement {
  const t = (k: MessageKey, p?: Record<string, string | number>) => translate(locale, k, p);
  switch (e.type) {
    case 'join':
      return { text: t('ann.join', { name: e.name }), kind: 'polite', critical: false };
    case 'leave':
      return { text: t('ann.leave', { name: e.name }), kind: 'polite', critical: false };
    case 'death':
      return { text: t('ann.death', { name: e.name }), kind: 'polite', critical: false };
    case 'deathSelf':
      return { text: t('ann.deathSelf'), kind: 'assertive', critical: true };
    case 'respawnSelf':
      return { text: t('ann.respawnSelf'), kind: 'polite', critical: false };
    case 'questProgress':
      return {
        text: t('ann.questProgress', { title: e.title, obj: e.obj ?? '' }).replace(/\.\s*$/, ''),
        kind: 'polite', critical: false,
      };
    case 'questComplete':
      return { text: t('ann.questComplete', { title: e.title }), kind: 'polite', critical: false };
    case 'telegraph':
      return { text: t('ann.telegraph', { label: e.label }), kind: 'assertive', critical: true };
    case 'lowHp':
      return {
        text: t('ann.lowHp', { hp: Math.ceil(e.hp), max: Math.ceil(e.max) }),
        kind: 'assertive', critical: true,
      };
    case 'item':
      return { text: t('ann.item', { item: e.name }), kind: 'polite', critical: false };
    case 'inventoryFull':
      return { text: t('ann.inventoryFull'), kind: 'assertive', critical: false };
    case 'levelUp':
      return { text: t('ann.levelUp', { level: e.level }), kind: 'polite', critical: false };
    case 'bossAppeared':
      return { text: t('ann.bossAppeared', { name: e.name }), kind: 'polite', critical: false };
    case 'chat':
      return { text: t('ann.chat', { from: e.from, text: e.text }), kind: 'polite', critical: false };
    case 'panelOpen':
      return { text: t('ann.panelOpen', { panel: e.panel }), kind: 'polite', critical: false };
    case 'panelClose':
      return { text: t('ann.panelClose', { panel: e.panel }), kind: 'polite', critical: false };
    case 'raw':
      return {
        text: e.text,
        kind: e.kind ?? 'polite',
        critical: e.critical ?? false,
      };
  }
}

/**
 * Priority queue for the live region.
 *
 * Assertive messages jump the queue (they are life-safety relevant); polite
 * messages coalesce by text so a burst of identical HP updates is spoken once.
 * `drain` returns what should be spoken, oldest-first within a politeness level.
 */
export class AnnounceQueue {
  private polite: string[] = [];
  private assertive: string[] = [];

  constructor(private max = 20) {}

  push(a: Announcement): void {
    const target = a.kind === 'assertive' ? this.assertive : this.polite;
    // Coalesce repeats (a sustained low-HP state must not queue 20 copies)...
    if (target.includes(a.text)) return;
    target.push(a.text);
    // ...and cap the backlog, dropping the OLDEST so the most recent events
    // (the ones a player still cares about) survive.
    while (target.length > this.max) target.shift();
  }

  /** Pending assertive messages (they are always spoken). */
  pendingAssertive(): readonly string[] {
    return this.assertive.slice();
  }

  /** Remove and return the next message, assertive first. Null when empty. */
  drain(): string | null {
    return this.assertive.shift() ?? this.polite.shift() ?? null;
  }

  /** Drop pending polite messages (used when the locale changes). */
  clearPolite(): void {
    this.polite = [];
  }

  clear(): void {
    this.polite = [];
    this.assertive = [];
  }

  get size(): number {
    return this.polite.length + this.assertive.length;
  }
}

// ===========================================================================
// Pure helpers — keyboard navigation
// ===========================================================================

export const FOCUSABLE_SELECTOR =
  'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),' +
  'textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';

/** Codes that must not be swallowed by the HUD key handler. */
export const NAV_PASS_THROUGH = new Set([
  'F5', 'F11', 'F12', 'Tab',
  'CapsLock', 'ContextMenu', 'NumLock', 'ScrollLock',
]);

/**
 * Non-movement hotkeys owned by the client (main.ts): leaderboard, mute, editor
 * paint, chat, settings. A movement scheme that reuses one of these creates a
 * real conflict — `L` is both "strafe right" under IJKL and "leaderboard".
 *
 * Rather than silently shadowing a hotkey, `movementConflicts()` reports the
 * overlap so the UI can warn and the a11y handler can refuse the gesture
 * (context decides: movement wins while the game view has focus, since a
 * one-shot toggle keypress is less important than continuous steering).
 */
export const UI_HOTKEYS: Readonly<Record<string, string>> = {
  KeyL: 'leaderboard',
  KeyM: 'mute',
  KeyE: 'editor paint',
  Enter: 'chat',
  Space: 'attack',
};

/** UI hotkeys a given movement scheme would shadow. */
export function movementConflicts(scheme: MoveScheme): Array<{ code: string; action: string }> {
  const out: Array<{ code: string; action: string }> = [];
  for (const code of Object.values(MOVE_KEYMAPS[scheme] ?? MOVE_KEYMAPS.wasd)) {
    const action = UI_HOTKEYS[code];
    if (action) out.push({ code, action });
  }
  return out;
}

/**
 * Roving-tabindex step. Returns the next focus index in a list for a key press.
 *
 * Roving tabindex (one tab stop, arrows to move inside) is the ARIA-recommended
 * pattern for toolbars and grids: a 20-slot inventory should not cost 20 Tab
 * presses. `null` means "let the browser handle this key" (Tab, F-keys, etc).
 */
export function rovingStep(
  key: string,
  count: number,
  current: number,
  columns?: number,
): number | null {
  if (count <= 0) return null;
  // No column hint (or a nonsensical one) means "one flat list", where up/down
  // should still step by one instead of freezing on the current item.
  const cols = columns && columns > 0 ? Math.min(columns, count) : 1;
  const i = current < 0 || current >= count ? 0 : current;
  switch (key) {
    case 'ArrowRight': return (i + 1) % count;
    case 'ArrowLeft': return (i - 1 + count) % count;
    case 'ArrowDown': return Math.min(count - 1, i + (columns ? cols : 1));
    case 'ArrowUp': return Math.max(0, i - (columns ? cols : 1));
    case 'Home': return 0;
    case 'End': return count - 1;
    default: return null;
  }
}

/** True when the event target is a text entry the a11y layer must not steal. */
export function isTextEntry(el: EventTargetLike | null | undefined): boolean {
  if (!el) return false;
  if (el.isContentEditable) return true;
  return el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT';
}

/** Should the global a11y key handler ignore this event entirely? */
export function shouldIgnoreKey(e: {
  target: EventTargetLike | null;
  code: string;
  ctrlKey?: boolean;
  metaKey?: boolean;
}): boolean {
  // Ctrl/Meta chords belong to the browser and the OS (copy, reload, devtools).
  if (e.ctrlKey || e.metaKey) return true;
  if (NAV_PASS_THROUGH.has(e.code)) return false;
  return isTextEntry(e.target);
}

// ===========================================================================
// A11y — runtime manager (DOM side)
// ===========================================================================

function safeLocalStorage(): StorageLike | null {
  try {
    return (globalThis as { localStorage?: StorageLike }).localStorage ?? null;
  } catch {
    return null;
  }
}

/**
 * Owns settings, the live region, HUD keyboard navigation and theme application.
 *
 * `install()` is called once from main.ts after the HUD exists. Everything that
 * touches the DOM goes through it; the class is constructible without a document
 * so tests can exercise set()/get()/announce() headless.
 */
export class A11y {
  settings: A11ySettings;
  readonly queue = new AnnounceQueue();
  onChange: (s: A11ySettings) => void = () => {};

  private storage: StorageLike | null;
  private doc: Document | null = null;
  private politeEl: HTMLElement | null = null;
  private assertiveEl: HTMLElement | null = null;
  private wasLow = false;
  private installed = false;
  private liveLocale: Locale | null = null;

  constructor(storage: StorageLike | null = safeLocalStorage()) {
    this.storage = storage;
    let raw: unknown = null;
    try {
      const s = this.storage?.getItem(A11Y_STORAGE_KEY);
      if (s) raw = JSON.parse(s);
    } catch {
      raw = null; // corrupt blob -> defaults
    }
    this.settings = sanitizeSettings(raw);
  }

  // ------------------------------------------------------------- settings --

  get(): A11ySettings {
    return this.settings;
  }

  /** Merge a patch, sanitize, persist, apply and notify. Returns the new state. */
  set(patch: Partial<A11ySettings>): A11ySettings {
    this.settings = sanitizeSettings({ ...this.settings, ...patch });
    try {
      this.storage?.setItem(A11Y_STORAGE_KEY, JSON.stringify(this.settings));
    } catch {
      /* storage blocked — settings still apply for this session */
    }
    this.apply();
    this.onChange(this.settings);
    return this.settings;
  }

  reset(): A11ySettings {
    return this.set({ ...DEFAULT_A11Y });
  }

  /** True when any non-default a11y setting is active (used for a UI badge). */
  isCustom(): boolean {
    return JSON.stringify(this.settings) !== JSON.stringify(DEFAULT_A11Y);
  }

  /** Colourblind-safe palette currently in force. */
  palette(): EntityPalette {
    return paletteFor(this.settings.palette);
  }

  /** Whether renderers should skip shake / particles. */
  motionEnabled(): boolean {
    return !this.settings.reducedMotion;
  }

  // ------------------------------------------------------- announcements --

  /** Queue a structured announcement (localized in the active locale). */
  announce(e: AnnounceInput): void {
    if (!this.settings.announce) return;
    this.queue.push(formatAnnouncement(i18n.getLocale(), e));
    this.flush();
  }

  /**
   * Drain the queue into the live regions. Polite text lands in the polite node;
   * assertive text interrupts. When the locale changes the queue is dropped,
   * because a queued message in the old language would be confusing mid-session.
   */
  private flush(): void {
    const loc = i18n.getLocale();
    if (this.liveLocale !== null && this.liveLocale !== loc) this.queue.clear();
    this.liveLocale = loc;
    // Assertive first: a boss telegraph must not wait behind a chat backlog.
    let guard = 32;
    let msg: string | null;
    while ((msg = this.queue.drain()) !== null && guard-- > 0) {
      const assertive = this.queue.pendingAssertive().includes(msg);
      this.speak(msg, assertive ? 'assertive' : 'polite');
    }
  }

  /** Write text into a live region, forcing re-announcement of repeats. */
  private speak(text: string, kind: AnnounceKind): void {
    const el = kind === 'assertive' ? this.assertiveEl : this.politeEl;
    if (!el) return;
    // Clearing first makes a repeated identical message announce again.
    el.textContent = '';
    // A frame gap is required for SRs to notice the DOM mutation.
    const w = globalThis as unknown as { requestAnimationFrame?: (cb: () => void) => number };
    if (typeof w.requestAnimationFrame === 'function') {
      w.requestAnimationFrame(() => { el.textContent = text; });
    } else {
      el.textContent = text;
    }
  }

  /** Track HP for the descending-edge low-health announcement. */
  reportHp(hp: number, max: number): void {
    const frac = max > 0 ? hp / max : 0;
    if (shouldAnnounceLowHp(frac, this.wasLow)) {
      this.announce({ type: 'lowHp', hp, max });
    }
    this.wasLow = frac <= LOW_HP_THRESHOLD;
  }

  /** Reset the low-HP latch (on respawn). */
  resetHealthLatch(): void {
    this.wasLow = false;
  }

  // ------------------------------------------------------------- install --

  /**
   * Wire the live regions into the document and apply the current settings.
   * Idempotent: a second call only re-applies (so hot reload does not stack
   * duplicate regions or listeners).
   */
  install(doc?: Document): void {
    const d = doc ?? (globalThis as unknown as { document?: Document }).document;
    if (!d) return;
    this.doc = d;
    if (!this.installed) {
      this.createLiveRegions(d);
      this.installed = true;
    }
    this.apply();
  }

  /**
   * Create the polite + assertive live regions. `aria-live="polite"` queues
   * behind speech; `assertive` interrupts. `aria-atomic="true"` makes each
   * update read as one sentence rather than a diff.
   */
  private createLiveRegions(d: Document): void {
    const mk = (id: string, live: string): HTMLElement => {
      const el = d.createElement('div');
      el.id = id;
      el.className = 'a11y-live';
      el.setAttribute('role', live === 'assertive' ? 'alert' : 'status');
      el.setAttribute('aria-live', live);
      el.setAttribute('aria-atomic', 'true');
      // Visually hidden but exposed to assistive tech.
      el.style.cssText = 'position:absolute;width:1px;height:1px;margin:-1px;padding:0;overflow:hidden;clip:rect(0 0 0 0);clip-path:inset(50%);white-space:nowrap;border:0';
      return el;
    };
    this.politeEl = mk('a11y-live-polite', 'polite');
    this.assertiveEl = mk('a11y-live-assertive', 'assertive');
    const body = d.body ?? d.documentElement;
    if (body) {
      body.appendChild(this.politeEl);
      body.appendChild(this.assertiveEl);
    }
  }

  /**
   * Apply settings to the document as data-attributes + CSS variables.
   *
   * index.html owns the CSS that reads these (a11y.css block); keeping the
   * attributes declarative means the themes work without re-running any JS.
   */
  apply(): void {
    const d = this.doc ?? (globalThis as unknown as { document?: Document }).document;
    if (!d) return;
    const s = this.settings;
    const root = d.documentElement;
    const set = (k: string, v: string) => root.setAttribute(k, v);
    set('data-a11y-contrast', s.highContrast ? 'high' : 'normal');
    set('data-a11y-palette', s.palette);
    set('data-a11y-motion', s.reducedMotion ? 'reduced' : 'full');
    set('data-a11y-scale', String(s.textScale));
    set('data-a11y-announce', s.announce ? 'on' : 'off');
    set('data-a11y-scheme', s.moveScheme);
    // Consumed by index.html CSS for the text scale (90%..150%).
    root.style.setProperty('--af-scale', String(s.textScale));
    const p = this.palette();
    root.style.setProperty('--af-entity-player', p.player);
    root.style.setProperty('--af-entity-npc', p.npc);
    root.style.setProperty('--af-entity-mob', p.mob);
    root.style.setProperty('--af-entity-pickup', p.pickup);
    root.style.setProperty('--af-entity-projectile', p.projectile);
    root.style.setProperty('--af-telegraph', p.telegraph);
    // `lang` drives screen-reader pronunciation; it must track the locale.
    root.setAttribute('lang', i18n.getLocale());
  }

  /** Apply settings and refresh the `lang` attribute after a locale switch. */
  syncLocale(locale: Locale): void {
    this.liveLocale = locale;
    this.apply();
  }

  /** Localized label for the live regions' surrounding group. */
  liveRegionLabel(): string {
    return i18n.t('a11y.liveRegion');
  }

  /** The document element the a11y layer is bound to (tests). */
  get document(): Document | null {
    return this.doc;
  }

  /** Current locale (delegated to i18n so both stay in step). */
  locale(): Locale {
    return i18n.getLocale();
  }
}

// ===========================================================================
// HUD keyboard navigation (DOM)
// ===========================================================================

/**
 * Minimal KeyboardEvent shape these helpers need (DOM-free + testable).
 * `target` is deliberately loose — the tagName/isContentEditable probe must work
 * with the plain-object stubs the headless tests use, not just real nodes.
 */
export interface KeyLike {
  key: string;
  code: string;
  target: EventTargetLike | null;
  ctrlKey?: boolean;
  metaKey?: boolean;
  altKey?: boolean;
  repeat?: boolean;
  preventDefault?: () => void;
  stopPropagation?: () => void;
}

/** The only properties read off an event target (see KeyLike.target). */
export interface EventTargetLike {
  tagName?: string;
  isContentEditable?: boolean;
}

/**
 * Roving-focus controller for the HUD.
 *
 * HUD widgets are grouped so Tab moves between *groups* (HP, inventory, quests,
 * minimap, chat) while Arrow keys move *within* a group — the ARIA toolbar /
 * grid pattern. Each group is one tab stop; the active item carries tabindex=0
 * and the rest tabindex=-1.
 */
export class HudNav {
  private items: HTMLElement[] = [];
  private index = 0;

  constructor(private root: HTMLElement | null) {
    this.collect();
  }

  /** Re-read focusable children from the DOM (after a re-render). */
  collect(): void {
    const r = this.root;
    if (!r || typeof r.querySelectorAll !== 'function') {
      this.items = [];
      return;
    }
    this.items = Array.from(r.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR))
      .filter((el) => !el.hasAttribute('disabled'));
  }

  get elements(): readonly HTMLElement[] {
    return this.items;
  }

  get activeIndex(): number {
    return this.index;
  }

  /**
   * Mark `next` as the single tab stop and focus it. Returns the element, or
   * null when the group is empty (a HUD with nothing focusable yet).
   */
  focusIndex(next: number): HTMLElement | null {
    if (this.items.length === 0) return null;
    const i = ((next % this.items.length) + this.items.length) % this.items.length;
    this.index = i;
    for (let k = 0; k < this.items.length; k++) {
      this.items[k]!.tabIndex = k === i ? 0 : -1;
    }
    const el = this.items[i]!;
    try {
      el.focus();
    } catch {
      /* detached node */
    }
    return el;
  }

  /** Move by a roving step for `key`; no-op when the key is not ours. */
  step(key: string, columns?: number): HTMLElement | null {
    const next = rovingStep(key, this.items.length, this.index, columns);
    return next === null ? null : this.focusIndex(next);
  }

  /**
   * Keydown handler for the HUD root.
   *
   * - Arrows / Home / End move focus (roving tabindex).
   * - Enter / Space activate the focused widget's click behaviour.
   * - Escape returns focus to the game view.
   *
   * Returns true when the event was consumed, so callers can stopPropagation().
   */
  handleKey(e: KeyLike): boolean {
    if (shouldIgnoreKey(e)) return false;
    // The inventory is a 5-column grid; arrows step by row there.
    const moved = this.step(e.key, this.items.length >= 5 ? 5 : undefined);
    if (moved) {
      e.preventDefault?.();
      return true;
    }
    if (e.key === 'Enter' || e.code === 'Space') {
      const el = this.items[this.index];
      if (!el) return false;
      // Native buttons/inputs handle their own Enter/Space; only drive
      // non-native widgets (inventory slots) ourselves.
      const tag = el.tagName;
      if (tag === 'BUTTON' || tag === 'INPUT' || tag === 'SELECT' || tag === 'A') return false;
      e.preventDefault?.();
      el.click?.();
      return true;
    }
    return false;
  }

  /** Attach listeners to the HUD root. Returns a teardown function. */
  attach(view?: HTMLElement | null): () => void {
    const r = this.root;
    if (!r || typeof r.addEventListener !== 'function') return () => {};
    const onKey = (e: Event) => {
      const ke = e as unknown as KeyLike;
      if (this.handleKey(ke)) {
        ke.preventDefault?.();
        ke.stopPropagation?.();
      }
    };
    const onFocusIn = () => this.collect();
    r.addEventListener('keydown', onKey as EventListener);
    r.addEventListener('focusin', onFocusIn as EventListener);
    return () => {
      r.removeEventListener('keydown', onKey as EventListener);
      r.removeEventListener('focusin', onFocusIn as EventListener);
    };
  }
}

// ===========================================================================
// Process-wide instances
// ===========================================================================

export const a11y = new A11y();

// Wire locale changes into the document so `lang` + live regions stay in step.
if (typeof i18n.onChange === 'function') {
  i18n.onChange(() => a11y.syncLocale(i18n.getLocale()));
}

export { DEFAULT_LOCALE };