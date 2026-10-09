// Headless tests for the accessibility layer.
//
// The a11y module is DOM-heavy, so the parts under test here are the pure
// helpers it exposes specifically so they *can* be tested headless (same
// approach the rest of the client suite uses with domstub.ts):
//   * settings sanitisation / clamping / persistence
//   * keymap tables, movement vectors and attack-key binding
//   * colourblind palette separation and contrast
//   * announcement formatting and the polite/assertive priority queue
//   * low-HP edge detection
//   * roving-tabindex navigation maths and key-filtering rules

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  A11y,
  A11Y_STORAGE_KEY,
  AnnounceQueue,
} from './a11y.js';
import {
  A11ySettings,
  AnnounceInput,
  DEFAULT_A11Y,
  DEFAULT_LOCALE,
  FOCUSABLE_SELECTOR,
  HudNav,
  KeyLike,
  LOW_HP_THRESHOLD,
  MOVE_KEYMAPS,
  MOVE_SCHEMES,
  NAV_PASS_THROUGH,
  PALETTES,
  PALETTE_MODES,
  TEXT_SCALE_MAX,
  TEXT_SCALE_MIN,
  colorForKind,
  formatAnnouncement,
  isLowHp,
  isTextEntry,
  isValidKeyCode,
  keyLabel,
  movementConflicts,
  UI_HOTKEYS,
  moveVector,
  paletteFor,
  rovingStep,
  sanitizeSettings,
  shouldAnnounceLowHp,
  shouldIgnoreKey,
} from './a11y.js';
import { i18n as globalI18n, type Locale, type StorageLike } from './i18n.js';

function memStore(seed: Record<string, string> = {}): StorageLike & { dump(): Record<string, string> } {
  const m = new Map(Object.entries(seed));
  return {
    getItem: (k) => (m.has(k) ? m.get(k)! : null),
    setItem: (k, v) => { m.set(k, v); },
    removeItem: (k) => { m.delete(k); },
    dump: () => Object.fromEntries(m),
  };
}

/** Relative luminance per WCAG 2.x, for contrast checks. */
function luminance(hex: string): number {
  const m = /^#([0-9a-f]{6})$/i.exec(hex.trim());
  assert.ok(m, `not a #rrggbb colour: ${hex}`);
  const n = parseInt(m[1]!, 16);
  const chan = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * chan[0]! + 0.7152 * chan[1]! + 0.0722 * chan[2]!;
}

function contrast(a: string, b: string): number {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/** Distinct hue-ish bucket so "mobs look different from loot" is testable. */
function hueBucket(hex: string): number {
  const m = /^#([0-9a-f]{6})$/i.exec(hex.trim());
  assert.ok(m);
  const n = parseInt(m[1]!, 16);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  if (max === min) return -1; // greyscale
  const d = max - min;
  let h: number;
  if (max === r) h = ((g - b) / d) % 6;
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  h *= 60;
  if (h < 0) h += 360;
  return Math.round(h / 30); // 12 buckets
}

// ===========================================================================

describe('a11y: defaults and sanitisation', () => {
  it('ships a complete, sane default config', () => {
    assert.deepEqual(DEFAULT_A11Y, {
      highContrast: false,
      palette: 'default',
      reducedMotion: false,
      textScale: 1,
      announce: true,
      moveScheme: 'wasd',
      attackKey: 'Space',
      clickToAttack: true,
      holdToAttack: false,
    });
  });

  it('sanitizeSettings passes a valid object through unchanged', () => {
    const input: A11ySettings = {
      highContrast: true,
      palette: 'deuteranopia',
      reducedMotion: true,
      textScale: 1.25,
      announce: false,
      moveScheme: 'ijkl',
      attackKey: 'KeyJ',
      clickToAttack: false,
      holdToAttack: true,
    };
    assert.deepEqual(sanitizeSettings(input), input);
  });

  it('sanitizeSettings returns defaults for garbage input', () => {
    for (const bad of [null, undefined, 42, 'nope', [], true]) {
      assert.deepEqual(sanitizeSettings(bad), DEFAULT_A11Y);
    }
  });

  it('rejects invalid enum values and keeps the default', () => {
    const s = sanitizeSettings({ palette: 'rainbow', moveScheme: 'chess' });
    assert.equal(s.palette, 'default');
    assert.equal(s.moveScheme, 'wasd');
  });

  it('accepts every declared palette and move scheme', () => {
    for (const p of PALETTE_MODES) assert.equal(sanitizeSettings({ palette: p }).palette, p);
    for (const m of MOVE_SCHEMES) assert.equal(sanitizeSettings({ moveScheme: m }).moveScheme, m);
  });

  it('clamps text scale to the documented 90%..150% range', () => {
    assert.equal(sanitizeSettings({ textScale: 0.1 }).textScale, TEXT_SCALE_MIN);
    assert.equal(sanitizeSettings({ textScale: 99 }).textScale, TEXT_SCALE_MAX);
    assert.equal(sanitizeSettings({ textScale: 1.2 }).textScale, 1.2);
  });

  it('snaps text scale to 5% steps so the slider and store never disagree', () => {
    assert.equal(sanitizeSettings({ textScale: 1.234 }).textScale, 1.25);
    assert.equal(sanitizeSettings({ textScale: 0.93 }).textScale, 0.95);
    for (let i = 90; i <= 150; i += 5) {
      assert.equal(sanitizeSettings({ textScale: i / 100 }).textScale, i / 100);
    }
  });

  it('rejects non-numeric and non-finite text scale', () => {
    for (const bad of ['1.5', NaN, Infinity, null, {}]) {
      assert.equal(sanitizeSettings({ textScale: bad }).textScale, DEFAULT_A11Y.textScale);
    }
  });

  it('drops an invalid attack key binding', () => {
    assert.equal(sanitizeSettings({ attackKey: 'Space' }).attackKey, 'Space');
    assert.equal(sanitizeSettings({ attackKey: 'NotAKey' }).attackKey, 'Space');
    assert.equal(sanitizeSettings({ attackKey: 123 }).attackKey, 'Space');
  });

  it('isValidKeyCode accepts the codes worth persisting', () => {
    const good = ['Space', 'Enter', 'KeyJ', 'KeyW', 'Digit1', 'Numpad0', 'Numpad8',
      'NumpadAdd', 'F1', 'F12', 'ArrowUp', 'BracketLeft', 'Minus'];
    for (const c of good) assert.equal(isValidKeyCode(c), true, c);
    const bad = ['', 'Key', 'Key1', 'Letters', 'KeyboardEvent', 'x'.repeat(50),
      null, undefined, 7, {}];
    for (const c of bad) assert.equal(isValidKeyCode(c), false, String(c));
  });

  it('ignores unknown keys rather than dropping known ones', () => {
    // A partial patch must not reset the fields it does not mention.
    const s = sanitizeSettings({ highContrast: true, reducedMotion: true });
    assert.equal(s.highContrast, true);
    assert.equal(s.reducedMotion, true);
    assert.equal(s.palette, DEFAULT_A11Y.palette);
    assert.equal(s.attackKey, DEFAULT_A11Y.attackKey);
  });
});

// ===========================================================================

describe('a11y: settings store', () => {
  it('starts from defaults with empty storage', () => {
    const a = new A11y(memStore());
    assert.deepEqual(a.get(), DEFAULT_A11Y);
  });

  it('restores persisted settings', () => {
    const store = memStore({
      [A11Y_STORAGE_KEY]: JSON.stringify({ highContrast: true, palette: 'protanopia', textScale: 1.4 }),
    });
    const a = new A11y(store);
    assert.equal(a.get().highContrast, true);
    assert.equal(a.get().palette, 'protanopia');
    assert.equal(a.get().textScale, 1.4);
  });

  it('falls back to defaults on a corrupt or partial blob', () => {
    assert.deepEqual(new A11y(memStore({ [A11Y_STORAGE_KEY]: '{oops' })).get(), DEFAULT_A11Y);
    assert.deepEqual(new A11y(memStore({ [A11Y_STORAGE_KEY]: '"a string"' })).get(), DEFAULT_A11Y);
    // Partial blob keeps defaults for the rest.
    const a = new A11y(memStore({ [A11Y_STORAGE_KEY]: '{"muted":true}' }));
    assert.deepEqual(a.get(), DEFAULT_A11Y);
  });

  it('set() merges, sanitizes and persists', () => {
    const store = memStore();
    const a = new A11y(store);
    const next = a.set({ highContrast: true, textScale: 5 });
    assert.equal(next.highContrast, true);
    assert.equal(next.textScale, TEXT_SCALE_MAX, 'out-of-range clamped on write');
    const persisted = JSON.parse(store.dump()[A11Y_STORAGE_KEY]!) as A11ySettings;
    assert.equal(persisted.highContrast, true);
    assert.equal(persisted.textScale, TEXT_SCALE_MAX);
  });

  it('set() ignores unknown keys in the patch', () => {
    const a = new A11y(memStore());
    const next = a.set({ nonsense: true } as unknown as Partial<A11ySettings>);
    assert.deepEqual(next, DEFAULT_A11Y);
    assert.equal('nonsense' in next, false);
  });

  it('onChange fires with the new settings', () => {
    const a = new A11y(memStore());
    const seen: A11ySettings[] = [];
    a.onChange = (s) => seen.push(s);
    a.set({ reducedMotion: true });
    a.set({ reducedMotion: false });
    assert.equal(seen.length, 2);
    assert.equal(seen[0]!.reducedMotion, true);
    assert.equal(seen[1]!.reducedMotion, false);
  });

  it('reset() restores every default', () => {
    const a = new A11y(memStore());
    a.set({ highContrast: true, palette: 'tritanopia', textScale: 1.5, moveScheme: 'numpad' });
    assert.equal(a.isCustom(), true);
    const back = a.reset();
    assert.deepEqual(back, DEFAULT_A11Y);
    assert.equal(a.isCustom(), false);
  });

  it('isCustom detects non-default state', () => {
    const a = new A11y(memStore());
    assert.equal(a.isCustom(), false);
    a.set({ clickToAttack: false });
    assert.equal(a.isCustom(), true);
  });

  it('survives a hostile storage backend', () => {
    const hostile: StorageLike = {
      getItem() { throw new Error('blocked'); },
      setItem() { throw new Error('blocked'); },
      removeItem() { throw new Error('blocked'); },
    };
    const a = new A11y(hostile);
    a.set({ highContrast: true });
    assert.equal(a.get().highContrast, true, 'applies for the session anyway');
  });

  it('palette() and motionEnabled() reflect the settings', () => {
    const a = new A11y(memStore());
    assert.deepEqual(a.palette(), PALETTES.default);
    assert.equal(a.motionEnabled(), true);
    a.set({ palette: 'deuteranopia', reducedMotion: true });
    assert.deepEqual(a.palette(), PALETTES.deuteranopia);
    assert.equal(a.motionEnabled(), false, 'reduced motion disables shake/particles');
  });

  it('constructs and mutates without a document present', () => {
    // main.ts imports this at module scope; there must be no DOM requirement.
    const a = new A11y(memStore());
    a.set({ highContrast: true });
    a.reportHp(1, 100);
    a.announce({ type: 'deathSelf' });
    assert.equal(a.document, null);
  });

  it('locale() tracks the shared i18n instance', () => {
    const a = new A11y(memStore());
    assert.equal(a.locale(), globalI18n.getLocale());
  });
});

// ===========================================================================

describe('a11y: input remapping', () => {
  it('defines four movement schemes with a full four-way keymap', () => {
    assert.deepEqual([...MOVE_SCHEMES], ['wasd', 'arrows', 'ijkl', 'numpad']);
    for (const s of MOVE_SCHEMES) {
      const m = MOVE_KEYMAPS[s];
      assert.ok(m.up && m.down && m.left && m.right, `${s} is incomplete`);
      const codes = new Set(Object.values(m));
      assert.equal(codes.size, 4, `${s} reuses a key`);
    }
  });

  it('binds WASD to the conventional keys', () => {
    assert.deepEqual(MOVE_KEYMAPS.wasd, {
      up: 'KeyW', down: 'KeyS', left: 'KeyA', right: 'KeyD',
    });
  });

  it('binds arrows to ArrowUp/Down/Left/Right', () => {
    assert.deepEqual(MOVE_KEYMAPS.arrows, {
      up: 'ArrowUp', down: 'ArrowDown', left: 'ArrowLeft', right: 'ArrowRight',
    });
  });

  it('binds IJKL as a vertical, home-row hand position', () => {
    assert.deepEqual(MOVE_KEYMAPS.ijkl, {
      up: 'KeyI', down: 'KeyJ', left: 'KeyK', right: 'KeyL',
    });
  });

  it('binds the numeric keypad to the 8/4/5/6 diamond', () => {
    assert.deepEqual(MOVE_KEYMAPS.numpad, {
      up: 'Numpad8', down: 'Numpad5', left: 'Numpad4', right: 'Numpad6',
    });
  });

  it('the default scheme does not collide with chat/UI hotkeys (L/M/E)', () => {
    // L = leaderboard, M = mute, E = editor paint. Movement must not steal them.
    const movement = new Set(Object.values(MOVE_KEYMAPS.wasd));
    for (const hotkey of ['KeyL', 'KeyM', 'KeyE', 'Enter', 'Space']) {
      assert.equal(movement.has(hotkey), false, `${hotkey} is bound to movement`);
    }
  });

  it('the IJKL scheme shadows the L leaderboard hotkey, and says so', () => {
    // `L` is genuinely both "strafe right" under IJKL and "toggle leaderboard".
    // The conflict is reported rather than hidden so the UI can warn.
    const conflicts = movementConflicts('ijkl');
    assert.equal(conflicts.length, 1);
    assert.equal(conflicts[0]!.code, 'KeyL');
    assert.equal(conflicts[0]!.action, 'leaderboard');
  });

  it('WASD, arrows and numpad shadow no UI hotkeys', () => {
    for (const scheme of ['wasd', 'arrows', 'numpad'] as const) {
      assert.deepEqual(movementConflicts(scheme), [], `${scheme} conflicts`);
    }
  });

  it('moveVector reads the held-key set for each scheme', () => {
    assert.deepEqual(moveVector(new Set(['KeyW']), 'wasd'), { x: 0, y: -1 });
    assert.deepEqual(moveVector(new Set(['KeyS']), 'wasd'), { x: 0, y: 1 });
    assert.deepEqual(moveVector(new Set(['KeyA']), 'wasd'), { x: -1, y: 0 });
    assert.deepEqual(moveVector(new Set(['KeyD']), 'wasd'), { x: 1, y: 0 });
  });

  it('moveVector diagonal input stays unnormalised (callers normalise)', () => {
    const v = moveVector(new Set(['KeyW', 'KeyD']), 'wasd');
    assert.deepEqual(v, { x: 1, y: -1 });
    assert.ok(Math.abs(Math.hypot(v.x, v.y) - Math.SQRT2) < 1e-9);
  });

  it('moveVector is zero for an empty or irrelevant key set', () => {
    assert.deepEqual(moveVector(new Set(), 'wasd'), { x: 0, y: 0 });
    assert.deepEqual(moveVector(new Set(['KeyI']), 'wasd'), { x: 0, y: 0 });
  });

  it('moveVector ignores keys from a different scheme', () => {
    // I is "up" under ijkl but must not move under wasd.
    assert.deepEqual(moveVector(new Set(['KeyI']), 'ijkl'), { x: 0, y: -1 });
    assert.deepEqual(moveVector(new Set(['KeyI']), 'wasd'), { x: 0, y: 0 });
    assert.deepEqual(moveVector(new Set(['KeyW']), 'ijkl'), { x: 0, y: 0 });
  });

  it('every scheme produces the same vector for an equivalent held set', () => {
    const wasd = moveVector(new Set(['KeyW', 'KeyD']), 'wasd');
    const ijkl = moveVector(new Set(['KeyI', 'KeyL']), 'ijkl');
    const arrows = moveVector(new Set(['ArrowUp', 'ArrowRight']), 'arrows');
    const numpad = moveVector(new Set(['Numpad8', 'Numpad6']), 'numpad');
    assert.deepEqual(ijkl, wasd);
    assert.deepEqual(arrows, wasd);
    assert.deepEqual(numpad, wasd);
  });

  it('retains WASD semantics while WASD is active', () => {
    // Regression guard: the default scheme must not have been remapped.
    const a = new A11y(memStore());
    assert.equal(a.get().moveScheme, 'wasd');
    assert.deepEqual(moveVector(new Set(['KeyW']), a.get().moveScheme), { x: 0, y: -1 });
  });

  it('click-to-attack and hold-to-attack toggle independently', () => {
    const a = new A11y(memStore());
    assert.equal(a.get().clickToAttack, true);
    a.set({ clickToAttack: false });
    assert.equal(a.get().clickToAttack, false);
    assert.equal(a.get().holdToAttack, false, 'click and hold are independent');
    a.set({ holdToAttack: true });
    assert.equal(a.get().clickToAttack, false);
    assert.equal(a.get().holdToAttack, true);
  });

  it('rebindable attack key accepts and persists an alternative', () => {
    const a = new A11y(memStore());
    assert.equal(a.get().attackKey, 'Space');
    a.set({ attackKey: 'KeyJ' });
    assert.equal(a.get().attackKey, 'KeyJ');
    const restored = new A11y(memStore({ [A11Y_STORAGE_KEY]: JSON.stringify({ attackKey: 'Numpad0' }) }));
    assert.equal(restored.get().attackKey, 'Numpad0');
  });

  it('keyLabel renders codes as human-readable keys', () => {
    assert.equal(keyLabel('KeyJ'), 'J');
    assert.equal(keyLabel('KeyW'), 'W');
    assert.equal(keyLabel('Digit5'), '5');
    assert.equal(keyLabel('Numpad8'), 'Num 8');
    assert.equal(keyLabel('NumpadAdd'), 'Num +');
    assert.equal(keyLabel('ArrowUp'), '↑');
    assert.equal(keyLabel('ArrowLeft'), '←');
    assert.equal(keyLabel('Space'), 'Space');
    assert.equal(keyLabel('Escape'), 'Esc');
    assert.equal(keyLabel('F5'), 'F5');
  });
});

// ===========================================================================

describe('a11y: colourblind-safe palettes', () => {
  it('defines a full palette for every mode', () => {
    for (const mode of PALETTE_MODES) {
      const p = PALETTES[mode];
      for (const key of ['player', 'npc', 'mob', 'pickup', 'projectile',
        'self', 'boss', 'telegraph', 'danger'] as const) {
        assert.match(p[key], /^#[0-9a-f]{6}$/i, `${mode}.${key} is not a hex colour`);
      }
    }
  });

  it('paletteFor clamps an unknown mode to the default', () => {
    assert.deepEqual(paletteFor('nonsense' as never), PALETTES.default);
  });

  it('every non-default mode differs from the shipped palette', () => {
    for (const mode of PALETTE_MODES) {
      if (mode === 'default') continue;
      assert.notDeepEqual(PALETTES[mode], PALETTES.default, `${mode} is a no-op`);
    }
  });

  it('mobs and telegraphs never share a colour (hazard reads as hazard)', () => {
    for (const mode of PALETTE_MODES) {
      const p = PALETTES[mode];
      assert.notEqual(p.mob, p.telegraph, `${mode}: mob and telegraph share a colour`);
    }
  });

  it('pickups never reuse the hostile mob colour (loot vs threat)', () => {
    for (const mode of PALETTE_MODES) {
      assert.notEqual(PALETTES[mode].pickup, PALETTES[mode].mob, `${mode}: loot looks like a mob`);
    }
  });

  it('deuteranopia and protanopia shift mobs off red', () => {
    // The default mob colour is #ff5252 — a red/green confusion problem.
    assert.equal(PALETTES.default.mob, '#ff5252');
    const deutHue = hueBucket(PALETTES.deuteranopia.mob);
    const protHue = hueBucket(PALETTES.protanopia.mob);
    const defaultHue = hueBucket(PALETTES.default.mob);
    assert.notEqual(deutHue, defaultHue, 'deuteranopia mob keeps the default red');
    assert.notEqual(protHue, defaultHue, 'protanopia mob keeps the default red');
  });

  it('every palette separates mob / npc / pickup by hue bucket', () => {
    for (const mode of PALETTE_MODES) {
      const p = PALETTES[mode];
      const hues = [hueBucket(p.mob), hueBucket(p.npc), hueBucket(p.pickup)];
      assert.equal(new Set(hues).size, 3, `${mode}: mob/npc/pickup hues collide (${hues})`);
    }
  });

  it('telegraph colours stay legible against the dark scene background', () => {
    for (const mode of PALETTE_MODES) {
      // The canvas/game background is near-black (#0b0e14-ish).
      const c = contrast(PALETTES[mode].telegraph, '#0d1117');
      assert.ok(c >= 3, `${mode}: telegraph contrast ${c.toFixed(2)} is too low`);
    }
  });

  it('the local player marker is pure white in every palette', () => {
    for (const mode of PALETTE_MODES) {
      assert.equal(PALETTES[mode].self, '#ffffff', `${mode} self dot must stay white`);
    }
  });

  it('entity colours meet 3:1 contrast against the dark background', () => {
    for (const mode of PALETTE_MODES) {
      const p = PALETTES[mode];
      for (const key of ['player', 'npc', 'mob', 'pickup'] as const) {
        const c = contrast(p[key], '#0d1117');
        assert.ok(c >= 3, `${mode}.${key} contrast ${c.toFixed(2)} < 3:1`);
      }
    }
  });

  it('colorForKind maps snapshot kinds and falls back for unknown kinds', () => {
    assert.equal(colorForKind('deuteranopia', 'mob'), PALETTES.deuteranopia.mob);
    assert.equal(colorForKind('default', 'player'), PALETTES.default.player);
    assert.equal(colorForKind('default', 'boss-with-no-kind'), '#ccc');
  });

  it('changing the palette setting changes the resolved colours', () => {
    const a = new A11y(memStore());
    const before = a.palette().mob;
    a.set({ palette: 'tritanopia' });
    assert.notEqual(a.palette().mob, before);
    assert.equal(a.palette().mob, PALETTES.tritanopia.mob);
  });
});

// ===========================================================================

describe('a11y: reduced motion', () => {
  it('motion is on by default and off under reduced motion', () => {
    const a = new A11y(memStore());
    assert.equal(a.motionEnabled(), true);
    a.set({ reducedMotion: true });
    assert.equal(a.motionEnabled(), false);
    a.set({ reducedMotion: false });
    assert.equal(a.motionEnabled(), true);
  });

  it('reduced motion is persisted so it survives a reload', () => {
    const store = memStore();
    new A11y(store).set({ reducedMotion: true });
    assert.equal(new A11y(store).get().reducedMotion, true);
    assert.equal(new A11y(store).motionEnabled(), false);
  });
});

// ===========================================================================

describe('a11y: low-health detection', () => {
  it('fires at or below the threshold and not above it', () => {
    assert.equal(LOW_HP_THRESHOLD, 0.25);
    assert.equal(isLowHp(25, 100), true);
    assert.equal(isLowHp(10, 100), true);
    assert.equal(isLowHp(0, 100), true);
    assert.equal(isLowHp(26, 100), false);
    assert.equal(isLowHp(99, 100), false);
  });

  it('guards against a zero or invalid max', () => {
    assert.equal(isLowHp(0, 0), false);
    assert.equal(isLowHp(5, -1), false);
    assert.equal(isLowHp(NaN, 100), false);
  });

  it('announces on the descending edge only', () => {
    // Fresh state: crossing into the band fires.
    assert.equal(shouldAnnounceLowHp(0.2, false), true);
    // Already low: a sustained low state must stay quiet.
    assert.equal(shouldAnnounceLowHp(0.15, true), false);
    assert.equal(shouldAnnounceLowHp(0.05, true), false);
  });

  it('does not fire above the threshold', () => {
    assert.equal(shouldAnnounceLowHp(0.9, false), false);
    assert.equal(shouldAnnounceLowHp(0.26, false), false);
  });

  it('re-arms after HP recovers above the reset band', () => {
    assert.equal(shouldAnnounceLowHp(0.5, true), false, 'recovering does not announce');
    // Latch clears when comfortably healthy again, so a later dip re-fires.
    assert.equal(shouldAnnounceLowHp(0.1, false), true);
  });

  it('reportHp drives the latch across a full dip-and-recover cycle', () => {
    const a = new A11y(memStore());
    const seen: string[] = [];
    a.announce = (e: AnnounceInput) => {
      if (e.type === 'lowHp') seen.push(`${e.hp}/${e.max}`);
    };
    a.reportHp(100, 100); // healthy
    a.reportHp(20, 100);  // crosses low -> announce
    a.reportHp(15, 100);  // stays low -> silent
    a.reportHp(10, 100);  // stays low -> silent
    a.reportHp(90, 100);  // recovers -> silent
    a.reportHp(20, 100);  // dips again -> announce
    assert.deepEqual(seen, ['20/100', '20/100']);
  });

  it('resetHealthLatch re-arms the warning after a respawn', () => {
    const a = new A11y(memStore());
    let fired = 0;
    a.announce = (e) => { if (e.type === 'lowHp') fired++; };
    a.reportHp(10, 100);
    a.resetHealthLatch();
    a.reportHp(10, 100);
    assert.equal(fired, 2);
  });
});

// ===========================================================================

describe('a11y: announcements', () => {
  const loc = DEFAULT_LOCALE;

  it('keeps the localized announcement shape (kind + critical) stable', () => {
    const cases: Array<[AnnounceInput, RegExp]> = [
      [{ type: 'join', name: 'hero' }, /hero/],
      [{ type: 'leave', name: 'hero' }, /hero/],
      [{ type: 'death', name: 'gloomfang' }, /gloomfang/],
      [{ type: 'deathSelf' }, /died/i],
      [{ type: 'respawnSelf' }, /respawn/i],
      [{ type: 'questProgress', title: 'Ward-Spark', obj: 'kill 3' }, /Ward-Spark/],
      [{ type: 'questComplete', title: 'Ward-Spark' }, /Ward-Spark/],
      [{ type: 'telegraph', label: 'Golem slam' }, /Golem slam/],
      [{ type: 'item', name: 'Ember Shard' }, /Ember Shard/],
      [{ type: 'inventoryFull' }, /inventory/i],
      [{ type: 'levelUp', level: 4 }, /4/],
      [{ type: 'bossAppeared', name: 'Stone Golem' }, /Stone Golem/],
      [{ type: 'chat', from: 'hero', text: 'hi' }, /hero/],
      [{ type: 'panelOpen', panel: 'Settings' }, /Settings/],
      [{ type: 'panelClose', panel: 'Settings' }, /Settings/],
    ];
    for (const [input, re] of cases) {
      const a = formatAnnouncement(loc, input);
      assert.ok(a.text.length > 0, `${input.type} produced empty text`);
      assert.match(a.text, re, `${input.type}: ${a.text}`);
    }
  });

  it('boss telegraphs and low HP are assertive; ambient info is polite', () => {
    assert.equal(formatAnnouncement(loc, { type: 'telegraph', label: 'x' }).kind, 'assertive');
    assert.equal(formatAnnouncement(loc, { type: 'lowHp', hp: 5, max: 100 }).kind, 'assertive');
    assert.equal(formatAnnouncement(loc, { type: 'deathSelf' }).kind, 'assertive');

    assert.equal(formatAnnouncement(loc, { type: 'join', name: 'x' }).kind, 'polite');
    assert.equal(formatAnnouncement(loc, { type: 'chat', from: 'a', text: 'b' }).kind, 'polite');
    assert.equal(formatAnnouncement(loc, { type: 'questComplete', title: 'x' }).kind, 'polite');
    assert.equal(formatAnnouncement(loc, { type: 'levelUp', level: 2 }).kind, 'polite');
  });

  it('life-safety announcements are marked critical', () => {
    assert.equal(formatAnnouncement(loc, { type: 'telegraph', label: 'x' }).critical, true);
    assert.equal(formatAnnouncement(loc, { type: 'lowHp', hp: 1, max: 9 }).critical, true);
    assert.equal(formatAnnouncement(loc, { type: 'deathSelf' }).critical, true);
    assert.equal(formatAnnouncement(loc, { type: 'join', name: 'x' }).critical, false);
  });

  it('low-HP text rounds to whole numbers for clean speech', () => {
    const a = formatAnnouncement(loc, { type: 'lowHp', hp: 12.4, max: 99.6 });
    assert.match(a.text, /13 of 100/);
  });

  it('questProgress without an objective does not end in a dangling period', () => {
    const a = formatAnnouncement(loc, { type: 'questProgress', title: 'Ward-Spark' });
    assert.ok(!a.text.trim().endsWith('.'), a.text);
  });

  it('raw announcements pass through verbatim', () => {
    const a = formatAnnouncement(loc, { type: 'raw', text: 'custom', kind: 'assertive', critical: true });
    assert.equal(a.text, 'custom');
    assert.equal(a.kind, 'assertive');
    assert.equal(a.critical, true);
  });

  it('localizes announcements into the active locale', () => {
    const i18n = globalI18n;
    const before = i18n.getLocale();
    try {
      i18n.setLocale('de');
      assert.equal(formatAnnouncement('de', { type: 'deathSelf' }).text, 'Du bist gestorben');
      assert.equal(formatAnnouncement('es', { type: 'deathSelf' }).text, 'Has muerto');
      assert.equal(formatAnnouncement('tr', { type: 'deathSelf' }).text, 'Öldün');
    } finally {
      i18n.setLocale(before);
    }
  });

  it('every announcement kind renders in every locale with no leftover placeholders', () => {
    const kinds: AnnounceInput[] = [
      { type: 'join', name: 'a' }, { type: 'leave', name: 'a' },
      { type: 'death', name: 'a' }, { type: 'deathSelf' },
      { type: 'respawnSelf' }, { type: 'questProgress', title: 't', obj: 'o' },
      { type: 'questComplete', title: 't' }, { type: 'telegraph', label: 'l' },
      { type: 'lowHp', hp: 1, max: 2 }, { type: 'item', name: 'i' },
      { type: 'inventoryFull' }, { type: 'levelUp', level: 3 },
      { type: 'bossAppeared', name: 'b' }, { type: 'chat', from: 'f', text: 'x' },
      { type: 'panelOpen', panel: 'p' }, { type: 'panelClose', panel: 'p' },
      { type: 'raw', text: 'r' },
    ];
    const locales: Locale[] = ['en', 'tr', 'de', 'es'];
    for (const l of locales) {
      for (const k of kinds) {
        const a = formatAnnouncement(l, k);
        assert.ok(a.text.length > 0, `${l}/${k.type} empty`);
        assert.equal(a.text.includes('{'), false, `${l}/${k.type} left a placeholder: ${a.text}`);
      }
    }
  });
});

// ===========================================================================

describe('a11y: announce queue', () => {
  const a = (text: string, kind: 'polite' | 'assertive', critical = false) =>
    ({ text, kind, critical });

  it('starts empty', () => {
    const q = new AnnounceQueue();
    assert.equal(q.size, 0);
    assert.equal(q.drain(), null);
  });

  it('preserves FIFO order within one politeness level', () => {
    const q = new AnnounceQueue();
    q.push(a('one', 'polite'));
    q.push(a('two', 'polite'));
    q.push(a('three', 'polite'));
    assert.equal(q.drain(), 'one');
    assert.equal(q.drain(), 'two');
    assert.equal(q.drain(), 'three');
  });

  it('assertive messages jump ahead of queued polite ones', () => {
    const q = new AnnounceQueue();
    q.push(a('chat 1', 'polite'));
    q.push(a('chat 2', 'polite'));
    q.push(a('boss telegraph', 'assertive', true));
    assert.equal(q.drain(), 'boss telegraph', 'hazard must not wait behind chat');
    assert.equal(q.drain(), 'chat 1');
  });

  it('coalesces repeated identical messages', () => {
    const q = new AnnounceQueue();
    q.push(a('Low health: 10 of 100', 'assertive'));
    q.push(a('Low health: 10 of 100', 'assertive'));
    q.push(a('Low health: 10 of 100', 'assertive'));
    assert.equal(q.size, 1, 'identical repeats collapse to one');
  });

  it('keeps distinct messages of the same text per politeness level', () => {
    const q = new AnnounceQueue();
    q.push(a('same', 'polite'));
    q.push(a('same', 'assertive'));
    assert.equal(q.size, 2);
  });

  it('bounds the queue so a spam burst cannot grow without limit', () => {
    const q = new AnnounceQueue(3);
    for (let i = 0; i < 20; i++) q.push(a(`msg ${i}`, 'polite'));
    assert.equal(q.size, 3);
    assert.equal(q.drain(), 'msg 17', 'oldest messages are dropped, newest kept');
  });

  it('pendingAssertive() reports without consuming', () => {
    const q = new AnnounceQueue();
    q.push(a('warn', 'assertive', true));
    assert.deepEqual(q.pendingAssertive(), ['warn']);
    assert.deepEqual(q.pendingAssertive(), ['warn']);
    assert.equal(q.size, 1);
  });

  it('clearPolite drops only the polite backlog (locale switch)', () => {
    const q = new AnnounceQueue();
    q.push(a('chat', 'polite'));
    q.push(a('telegraph', 'assertive', true));
    q.clearPolite();
    assert.equal(q.size, 1);
    assert.equal(q.drain(), 'telegraph');
  });

  it('clear() empties both levels', () => {
    const q = new AnnounceQueue();
    q.push(a('a', 'polite'));
    q.push(a('b', 'assertive', true));
    q.clear();
    assert.equal(q.size, 0);
    assert.equal(q.drain(), null);
  });

  it('interleaved hazard + chat traffic drains hazards first', () => {
    const q = new AnnounceQueue();
    q.push(a('chat a', 'polite'));
    q.push(a('LOW HP', 'assertive', true));
    q.push(a('chat b', 'polite'));
    q.push(a('TELEGRAPH', 'assertive', true));
    assert.equal(q.drain(), 'LOW HP');
    assert.equal(q.drain(), 'TELEGRAPH');
    assert.equal(q.drain(), 'chat a');
    assert.equal(q.drain(), 'chat b');
    assert.equal(q.drain(), null);
  });
});

// ===========================================================================

describe('a11y: keyboard navigation maths', () => {
  it('moves right and left with wrapping', () => {
    assert.equal(rovingStep('ArrowRight', 5, 0), 1);
    assert.equal(rovingStep('ArrowRight', 5, 4), 0, 'wraps to the start');
    assert.equal(rovingStep('ArrowLeft', 5, 0), 4, 'wraps to the end');
    assert.equal(rovingStep('ArrowLeft', 5, 3), 2);
  });

  it('moves by a row using the column count', () => {
    // 20 slots in a 5-column grid: index 0 -> 5 -> 10 is one row down.
    assert.equal(rovingStep('ArrowDown', 20, 0, 5), 5);
    assert.equal(rovingStep('ArrowDown', 20, 5, 5), 10);
    assert.equal(rovingStep('ArrowUp', 20, 10, 5), 5);
  });

  it('clamps vertical movement at the ends instead of wrapping', () => {
    assert.equal(rovingStep('ArrowDown', 20, 18, 5), 19, 'clamped to the last slot');
    assert.equal(rovingStep('ArrowUp', 20, 3, 5), 0, 'clamped to the first slot');
    assert.equal(rovingStep('ArrowDown', 5, 0, 5), 4, 'a single row clamps to the end');
  });

  it('Home/End jump to the first and last items', () => {
    assert.equal(rovingStep('Home', 20, 13, 5), 0);
    assert.equal(rovingStep('End', 20, 13, 5), 19);
  });

  it('treats a 1-column group as a plain list', () => {
    assert.equal(rovingStep('ArrowDown', 4, 0, 1), 1, 'explicit 1-column steps by one');
    assert.equal(rovingStep('ArrowDown', 4, 0, undefined), 1, 'no column hint steps by one');
    assert.equal(rovingStep('ArrowUp', 4, 2, undefined), 1);
  });

  it('clamps a column count larger than the item count', () => {
    assert.equal(rovingStep('ArrowDown', 3, 0, 5), 2);
  });

  it('returns null for keys it does not own (Tab, letters, F-keys)', () => {
    for (const k of ['Tab', 'a', 'Enter', 'Space', 'Escape', 'F1', 'PageDown']) {
      assert.equal(rovingStep(k, 20, 3, 5), null, k);
    }
  });

  it('returns null for an empty item list', () => {
    assert.equal(rovingStep('ArrowRight', 0, 0, 5), null);
  });

  it('recovers from an out-of-range current index', () => {
    assert.equal(rovingStep('ArrowRight', 5, 99), 1);
    assert.equal(rovingStep('ArrowLeft', 5, -4), 4);
  });

  it('covers every slot of a 20-slot 5-column grid from slot 0', () => {
    // Simulated walk: arrow keys must be able to reach all 20 slots.
    let i = 0;
    const seen = new Set<number>([i]);
    for (let step = 0; step < 60; step++) {
      const next = rovingStep('ArrowRight', 20, i, 5);
      assert.ok(next !== null);
      i = next!;
      seen.add(i);
    }
    assert.equal(seen.size, 20, 'right-arrow walk never reached every slot');
  });
});

// ===========================================================================

describe('a11y: key filtering', () => {
  const ev = (over: Partial<KeyLike> & { key: string; code: string }): KeyLike => ({
    target: null,
    ...over,
  });

  it('ignores keys while typing in a text field', () => {
    for (const tag of ['INPUT', 'TEXTAREA', 'SELECT']) {
      const target = { tagName: tag };
      assert.equal(shouldIgnoreKey(ev({ key: 'ArrowRight', code: 'ArrowRight', target })), true, tag);
    }
  });

  it('treats contentEditable as a text entry', () => {
    assert.equal(shouldIgnoreKey(ev({ key: 'a', code: 'KeyA', target: { isContentEditable: true } })), true);
  });

  it('does not ignore keys on ordinary elements', () => {
    assert.equal(shouldIgnoreKey(ev({ key: 'ArrowRight', code: 'ArrowRight', target: { tagName: 'DIV' } })), false);
    assert.equal(shouldIgnoreKey(ev({ key: 'a', code: 'KeyA', target: null })), false);
  });

  it('never swallows browser/OS chords', () => {
    assert.equal(shouldIgnoreKey(ev({ key: 'r', code: 'KeyR', ctrlKey: true })), true, 'Ctrl+R reload');
    assert.equal(shouldIgnoreKey(ev({ key: 'c', code: 'KeyC', metaKey: true })), true, 'Cmd+C copy');
  });

  it('lets Tab and the function-key pass through even in a text field', () => {
    // Tab must always reach the browser so focus can leave the chat box.
    for (const code of NAV_PASS_THROUGH) {
      const target = { tagName: 'INPUT' };
      assert.equal(shouldIgnoreKey(ev({ key: code, code, target })), false, code);
    }
    assert.ok(NAV_PASS_THROUGH.has('Tab'));
    assert.ok(NAV_PASS_THROUGH.has('F5'));
    assert.ok(NAV_PASS_THROUGH.has('F11'));
    assert.ok(NAV_PASS_THROUGH.has('F12'));
  });
});

// ===========================================================================

describe('a11y: focusable selector + HudNav (headless)', () => {
  it('the focusable selector covers the standard tab stops', () => {
    for (const part of ['a[href]', 'button', 'input', 'select', 'textarea', '[tabindex]']) {
      assert.ok(FOCUSABLE_SELECTOR.includes(part), part);
    }
    assert.ok(FOCUSABLE_SELECTOR.includes(':not([disabled])'), 'disabled elements are skipped');
    assert.ok(FOCUSABLE_SELECTOR.includes('tabindex="-1"'), 'roving items are excluded');
  });

  it('HudNav tolerates a null root and an empty HUD', () => {
    const nav = new HudNav(null);
    assert.deepEqual(nav.elements, []);
    assert.equal(nav.focusIndex(0), null);
    assert.equal(nav.step('ArrowRight'), null);
  });

  it('HudNav.handleKey returns false when there is nothing to focus', () => {
    const nav = new HudNav(null);
    assert.equal(nav.handleKey({ key: 'ArrowRight', code: 'ArrowRight', target: null }), false);
  });

  it('HudNav.handleKey defers to the browser for keys it does not own', () => {
    const nav = new HudNav(null);
    assert.equal(nav.handleKey({ key: 'F5', code: 'F5', target: null }), false);
    assert.equal(nav.handleKey({ key: 'Enter', code: 'Enter', target: null }), false);
  });

  it('HudNav.handleKey ignores keys typed into a text field', () => {
    const nav = new HudNav(null);
    const target = { tagName: 'INPUT' };
    assert.equal(nav.handleKey({ key: 'ArrowRight', code: 'ArrowRight', target }), false);
    assert.equal(nav.handleKey({ key: 'Enter', code: 'Enter', target }), false);
  });

  it('attach() is a safe no-op without a root and returns a teardown', () => {
    const off = new HudNav(null).attach();
    assert.equal(typeof off, 'function');
    assert.doesNotThrow(() => off());
  });
});