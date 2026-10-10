import { NetClient, asTelegraph } from './net.js';
// PROTO2: NetClientV2 is the default (tries v2, falls back to v1 JSON when the
// server declines). `?proto=1` forces the legacy v1 NetClient. Both clients
// expose the same game-loop surface (entities/id/tick/lastAckSeq/rttMs/
// connect/sendInput/sendChat/on*), so the renderers below work unchanged on
// either wire format.
import { NetClientV2, protoFromSearch } from './net2.js';
import { Predictor } from './predict.js';
import { Interp } from './interp.js';
import { CanvasRenderer } from './renderer2d.js';
import { IsoRenderer } from './renderer3d.js';
import type { DrawEntity } from './types.js';
import { HUD } from './hud.js';
import { Editor } from './editor.js';
import { Sound } from './sound.js';
import { SettingsStore, qualityCaps } from './settings.js';
import { Joystick, blendMove } from './joystick.js';
import { FOG_RADIUS, FogOfWar, fogChunkKey, installFogPersistence } from './fog.js';
import { ChainTracker } from './quests.js';
import { bossBars } from './bosses.js';
// SYSTEMS-HOOK (systems integration): additive panels over the server's composed
// systems events (party / emotes / vendor / talents). Nothing existing is
// replaced; see docs/SYSTEMS.md#Integration for the chat-command reference.
import { SystemsView } from './social.js';
import { EmoteBubbleLayer, PartyPanel, TalentPanel, VendorPanel } from './panels.js';
import { TerrainView, zVisual } from './terrain_view.js';
import { AssetLoader, DEFAULT_ART } from './assets.js';
import {
  a11y, i18n, MOVE_KEYMAPS, moveVector, keyLabel, movementConflicts, isValidKeyCode, hexToRgb,
  type Locale, type MoveScheme, type PaletteMode,
} from './a11y.js';

const qs = new URLSearchParams(location.search);
const DEFAULT_SERVER = qs.get('server') ?? 'ws://localhost:8081';

// ---- DOM ----
const view = document.getElementById('view')!;
const canvas = document.getElementById('c') as HTMLCanvasElement;
const labelsEl = document.getElementById('labels')!;
const statusEl = document.getElementById('status')!;
const loginEl = document.getElementById('login')!;
const nameInput = document.getElementById('name') as HTMLInputElement;
const serverInput = document.getElementById('server') as HTMLInputElement | null;
const joinBtn = document.getElementById('join') as HTMLButtonElement;
const loadingEl = document.getElementById('loading')!;
const loadingText = document.getElementById('loading-text')!;
const deathEl = document.getElementById('death')!;
const respawnBtn = document.getElementById('respawn-btn') as HTMLButtonElement;
const vignetteEl = document.getElementById('vignette')!;
const fpsEl = document.getElementById('fps')!;
const toastEl = document.getElementById('toast')!;
const settingsEl = document.getElementById('settings')!;
const btnSettings = document.getElementById('btn-settings')!;
const btnSound = document.getElementById('btn-sound')!;
const btnLb = document.getElementById('btn-lb')!;
const touchEl = document.getElementById('touch')!;
const joyBase = document.getElementById('joy-base')!;
const joyKnob = document.getElementById('joy-knob')!;
const btnAttack = document.getElementById('btn-attack')!;

if (serverInput && qs.get('server')) serverInput.value = qs.get('server')!;
else if (serverInput && !serverInput.value) serverInput.value = DEFAULT_SERVER;

// ---- stores ----
const settings = new SettingsStore();
const sound = new Sound();
sound.setMuted(settings.settings.muted);
const joy = new Joystick(joyBase, joyKnob);

// Show touch controls on coarse pointers / touch devices.
function touchMode(): boolean {
  return !!(window.matchMedia?.('(pointer: coarse)').matches || 'ontouchstart' in window);
}
if (touchMode()) {
  touchEl.classList.add('show');
}

const net: NetClient | NetClientV2 = protoFromSearch(location.search) === 1 ? new NetClient() : new NetClientV2();
if (net instanceof NetClientV2) {
  // Dev token passthrough (?token=...) for shards that require one.
  const token = qs.get('token');
  if (token) net.token = token;
  // Auto-negotiate: the server may still answer in v1 JSON (PROTO=1, or an old
  // build). The game keeps running on JSON; say so instead of going silent.
  net.onFallback = (reason) => toast(`proto v1 fallback (${reason})`);
}
const pred = new Predictor();
const interp = new Interp();
const hud = new HUD(document.getElementById('hud')!);
const editor = new Editor();
editor.mount(document.getElementById('editor')!);

// ---- systems panels (additive) ----
// Pure view models fed by `event` payloads; the panels re-render only when a
// store's revision moves, so this costs nothing on a quiet tick.
const systems = new SystemsView();
const partyPanel = new PartyPanel(document.getElementById('hud')!, systems.party, () => net.id);
const vendorPanel = new VendorPanel(document.getElementById('hud')!, systems.vendor);
const talentPanel = new TalentPanel(document.getElementById('hud')!, systems.progression, (nodeId) => {
  sound.click();
  net.sendChat(`/talent ${nodeId}`, 'say');
});
// Bubbles live in #labels (the world-space overlay), not #hud (screen space).
const bubbleLayer = new EmoteBubbleLayer(labelsEl, systems.emotes);

/** World -> screen for whichever renderer is live. `iso`/`c2d`/`cam` are read at
 *  call time, and `cam` is declared further down with the frame loop. */
function projectWorld(x: number, y: number): { sx: number; sy: number } {
  if (iso && activeMode === 'three') {
    const p = iso.project(x, y);
    return { sx: p.sx, sy: p.sy - 18 };
  }
  if (c2d) {
    const p = c2d.worldToScreen(x, y, cam.x, cam.y);
    return { sx: p.sx, sy: p.sy - 18 };
  }
  return { sx: 0, sy: 0 };
}

/** Panels open on demand so they never obscure the HUD by default. */
function openPanel(id: 'af-party' | 'af-vendor' | 'af-talents'): void {
  const el = document.getElementById(id);
  if (el) el.classList.add('open');
}
// a11y: roving-tabindex keyboard navigation over the HUD widgets.
hud.nav.attach(view);

// ---- renderer management (three-iso primary, canvas2d fallback) ----
let iso: IsoRenderer | null = null;
let c2d: CanvasRenderer | null = null;
let activeMode: 'three' | 'canvas' = 'canvas';
let autoFallbackDone = false;
// TERRAIN: one shared view of the engine height/slope/hazard field (seed 1337,
// matching the shard) handed to whichever renderer is live and to the minimap.
// Its arena grid is built once, lazily (~3ms), then every tile lookup is an
// array index.
const terrain = new TerrainView();
// ASSETS: content-addressed art catalog (tools/manifest/build.mjs). Best-effort:
// boot works identically when manifest.json is absent (loader falls back to
// inline SVG placeholders and never throws).
const assets = new AssetLoader();
void assets.loadManifest().catch(() => null);

function toast(msg: string, ms = 2600) {
  const d = document.createElement('div');
  d.className = 'toast-msg';
  d.textContent = msg;
  toastEl.appendChild(d);
  while (toastEl.children.length > 3) toastEl.removeChild(toastEl.firstChild!);
  setTimeout(() => d.remove(), ms);
}

function showCanvas(): CanvasRenderer {
  if (iso) {
    try { iso.dispose(); } catch { /* ignore */ }
    iso = null;
  }
  labelsEl.style.display = 'none';
  labelsEl.innerHTML = '';
  labelPool.clear();
  canvas.style.display = 'block';
  if (!c2d) c2d = new CanvasRenderer(canvas, terrain);
  c2d.setTerrain(terrain);
  c2d.fitToContainer();
  activeMode = 'canvas';
  applyPalette();
  return c2d;
}

function showThree(): IsoRenderer | null {
  try {
    const created = IsoRenderer.tryCreate(view, terrain);
    if (!created) return null;
    if (c2d) {
      // Keep the 2d renderer instance for instant fallback; just hide its canvas.
    }
    canvas.style.display = 'none';
    labelsEl.style.display = 'block';
    iso = created;
    activeMode = 'three';
    applySettings();
    applyPalette();
    return iso;
  } catch {
    return null;
  }
}

function initRenderer() {
  const pref = settings.settings.renderer;
  if (pref === 'canvas') {
    showCanvas();
  } else if (pref === 'three') {
    if (!showThree()) {
      showCanvas();
      toast(i18n.t('toast.noWebgl'));
    }
  } else {
    // auto: prefer three, fall back silently
    if (!showThree()) showCanvas();
  }
  applySettings();
}

function applySettings() {
  const s = settings.settings;
  const caps = qualityCaps(s.quality);
  if (iso) {
    iso.setQuality(caps.pixelRatio, caps.flashes);
    iso.setViewDistance(s.renderDistance);
  }
  if (c2d) {
    c2d.setParticleCap(caps.particles);
    c2d.setViewDistance(s.renderDistance);
    c2d.fitToContainer();
  }
  fpsEl.style.display = s.showFps ? 'block' : 'none';
  sound.setMuted(s.muted);
  btnSound.textContent = s.muted ? '🔇' : '🔊';
  btnSound.classList.toggle('on', !s.muted);
  syncSettingsPanel();
}

settings.onChange = () => applySettings();

// ---- starter HUD state ----
hud.setInventory(['🗡 Sword', '🧪 Potion x3']);
let xp = 0, xpNext = 100, level = 1;
const levels = new Map<number, number>();
// Elder Maren 5-quest chain (ward-spark -> heart-of-fall, see server content.ts).
const chain = new ChainTracker();
hud.setQuests(chain.toHud());
const fog = new FogOfWar();
installFogPersistence(fog);
/** Chunks already credited to the 'Chart the Fall' explore quest. */
const exploreSeen = new Set<string>();
let shrineVisited = false;
let firstBlood = false;
let lastExploreKey = '';

/**
 * Boss entities snapshot as kind:'mob' named 'Stone Golem' / 'Ember Wyrm' /
 * 'Void Wisp' / 'Crypt Warden' (server/src/ai/npc.ts). Roster + ordering live
 * in bosses.ts so the HUD bar logic stays unit tested.
 */

// ---- screen shake ----
// Renderers own their own decay; main.ts only accumulates the impulses.
function shake(amount: number) {
  // a11y: reduced motion disables screen shake entirely.
  if (!a11y.motionEnabled()) return;
  const s = Math.max(0, Math.min(1.6, amount));
  if (s === 0) return;
  if (iso && activeMode === 'three') iso.shake(s);
  else if (c2d) c2d.shake(s * 12);
}

// ---- first-join tutorial (sessionStorage so a reload does not re-teach) ----
const TUTORIAL_KEY = 'af_tutorial_v1';
function maybeTutorial() {
  let seen = false;
  try { seen = sessionStorage.getItem(TUTORIAL_KEY) === '1'; } catch { seen = false; }
  if (seen) return;
  try { sessionStorage.setItem(TUTORIAL_KEY, '1'); } catch { /* ignore */ }
  // a11y: the tutorial names the movement scheme the player actually chose, so an
  // IJKL player is never told to press WASD.
  const scheme = a11y.get().moveScheme;
  const mk = MOVE_KEYMAPS[scheme];
  const moveHint = scheme === 'wasd' || scheme === 'arrows'
    ? i18n.t('tut.move')
    : `${keyLabel(mk.up)} / ${keyLabel(mk.left)} / ${keyLabel(mk.down)} / ${keyLabel(mk.right)}`;
  const steps = touchMode()
    ? [
        i18n.t('tut.move.touch'),
        i18n.t('tut.maren.touch'),
        i18n.t('tut.rings.touch'),
      ]
    : [
        `${moveHint} · ${keyLabel(a11y.get().attackKey)}`,
        i18n.t('tut.chat'),
        i18n.t('tut.maren'),
        i18n.t('tut.rings'),
      ];
  steps.forEach((s, i) => window.setTimeout(() => toast('✦ ' + s, 4200), 900 + i * 2600));
}

// ---- input (20Hz) ----
const keys = new Set<string>();
let seq = 0;
let attackQueued = false;
const lastMove = { x: 0, y: 1 };

addEventListener('keydown', (e) => {
  const t = e.target as HTMLElement | null;
  if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT')) return;
  // a11y: Escape closes the accessibility panel before anything else claims it.
  if (e.code === 'Escape' && a11yPanelOpen()) {
    closeA11yPanel();
    return;
  }
  keys.add(e.code);
  const map = MOVE_KEYMAPS[a11y.get().moveScheme];
  if (Object.values(map).includes(e.code as never) || e.code === a11y.get().attackKey) e.preventDefault();
  // a11y: the attack key is rebindable; hold-to-attack repeats while held.
  if (e.code === a11y.get().attackKey) {
    attackQueued = true;
    if (a11y.get().holdToAttack) startHoldAttack();
  }
  if (e.code === 'Enter') hud.focusChat();
  if (e.code === 'KeyL' && !e.repeat) toggleLeaderboard();
  if (e.code === 'KeyM' && !e.repeat) toggleMute();
  if (e.code === 'KeyE' && editor.active && !e.repeat) editor.togglePaint();
});
addEventListener('keyup', (e) => {
  keys.delete(e.code);
  if (e.code === a11y.get().attackKey) stopHoldAttack();
});

/** Hold-to-attack: re-queue a swing on a short interval while the key is down. */
let holdTimer = 0;
function startHoldAttack() {
  if (holdTimer) return;
  holdTimer = window.setInterval(() => { attackQueued = true; }, 180);
}
function stopHoldAttack() {
  if (!holdTimer) return;
  window.clearInterval(holdTimer);
  holdTimer = 0;
}

function readMove(): { x: number; y: number } {
  // a11y: WASD / arrows / IJKL / numpad all funnel through MOVE_KEYMAPS.
  const { x: kx, y: ky } = moveVector(keys, a11y.get().moveScheme);
  // Touch joystick blends in (analog, already normalized).
  return blendMove(kx, ky, joy.vec.x, joy.vec.y);
}

setInterval(() => {
  if (net.ws?.readyState !== 1) return;
  const { x, y } = readMove();
  if (x !== 0 || y !== 0) {
    const l = Math.hypot(x, y) || 1;
    lastMove.x = x / l;
    lastMove.y = y / l;
  }
  const atk = attackQueued;
  attackQueued = false;
  net.sendInput(++seq, x, y, atk ? { attack: true } : undefined);
  pred.applyInput(seq, x, y, 1 / 20);
  if (atk) swingFx();
}, 50);

function swingFx() {
  sound.attack();
  // a11y: reduced motion suppresses particle bursts (the audio cue remains).
  if (!a11y.motionEnabled()) return;
  const px = pred.pos.x + lastMove.x * 0.9, py = pred.pos.y + lastMove.y * 0.9;
  if (c2d && activeMode === 'canvas') c2d.burst(px, py, '#fff2b0', 6);
  if (iso && activeMode === 'three') iso.flash(px, py, 0xfff2b0);
}

// Mobile attack button.
btnAttack.addEventListener('pointerdown', (e) => {
  e.preventDefault();
  attackQueued = true;
  view.focus();
});

// ---- vignette + death ----
let vignetteTimer = 0;
function damageVignette(strength = 1) {
  vignetteEl.style.transition = 'none';
  vignetteEl.style.opacity = String(Math.min(0.95, 0.45 + strength * 0.25));
  window.clearTimeout(vignetteTimer);
  vignetteTimer = window.setTimeout(() => {
    vignetteEl.style.transition = 'opacity .45s ease-out';
    vignetteEl.style.opacity = '0';
  }, 60);
}

let deathShownAt = 0;
function showDeath(reason: string) {
  deathEl.classList.add('show');
  deathShownAt = performance.now();
  const sub = document.getElementById('death-sub');
  // Localize the death copy; announce() speaks it through the live region.
  if (sub) sub.textContent = i18n.t('death.sub');
  a11y.announce({ type: 'deathSelf' });
  damageVignette(2);
  sound.death();
  // Move focus to Respawn so a keyboard user is never stranded on the overlay.
  try { respawnBtn.focus(); } catch { /* stub DOM */ }
}
function hideDeath() {
  if (!deathEl.classList.contains('show')) return;
  deathEl.classList.remove('show');
  sound.respawn();
  // Predictor snaps to the authoritative pos on the next snapshot; nudge now.
  const self = net.entities.get(net.id);
  if (self) pred.reset(self.p.x, self.p.y);
  a11y.resetHealthLatch();
  a11y.announce({ type: 'respawnSelf' });
  view.focus();
}
respawnBtn.onclick = () => {
  sound.click();
  hideDeath();
};

// ---- leaderboard ----
let lbVisible = false;
function toggleLeaderboard() {
  lbVisible = !lbVisible;
  hud.setLeaderboardVisible(lbVisible);
  btnLb.classList.toggle('on', lbVisible);
}
btnLb.onclick = () => { sound.click(); toggleLeaderboard(); };

// ---- sound / settings buttons ----
function toggleMute() {
  const muted = sound.toggle();
  settings.set({ muted });
  btnSound.textContent = muted ? '🔇' : '🔊';
  if (!muted) sound.click();
}
btnSound.onclick = () => toggleMute();
btnSettings.onclick = () => {
  sound.click();
  settingsEl.style.display = settingsEl.style.display === 'block' ? 'none' : 'block';
};
document.getElementById('settings-close')!.onclick = () => {
  sound.click();
  settingsEl.style.display = 'none';
};

// ---- accessibility panel (a11y.ts) ----
// The panel owns the persisted a11y settings and the live locale. Everything
// else (HUD strings, announcements, palettes, input) reads from these two
// stores, so a change here re-renders the whole client.
const a11yPanel = document.getElementById('a11y-panel') as HTMLElement | null;
const btnA11y = document.getElementById('btn-a11y') as HTMLButtonElement | null;
const el = <T extends HTMLElement = HTMLElement>(id: string): T | null =>
  document.getElementById(id) as T | null;

function a11yPanelOpen(): boolean {
  return !!a11yPanel?.classList.contains('show');
}
function closeA11yPanel() {
  a11yPanel?.classList.remove('show');
  btnA11y?.setAttribute('aria-expanded', 'false');
  view.focus();
}
btnA11y?.addEventListener('click', () => {
  sound.click();
  const open = !a11yPanelOpen();
  a11yPanel?.classList.toggle('show', open);
  btnA11y.setAttribute('aria-expanded', String(open));
  if (open) {
    syncA11yPanel();
    el<HTMLSelectElement>('a11y-locale')?.focus();
  } else {
    view.focus();
  }
});
el('a11y-close')?.addEventListener('click', () => { sound.click(); closeA11yPanel(); });

// Live regions + theme attributes on <html>.
a11y.install(document);
// A palette change must reach the HUD colour table AND both renderers
// immediately (entity bodies + telegraph rings, not just the minimap).
a11y.onChange = () => { applyPalette(); hud.relocalize(); syncA11yPanel(); };

/** Push the active colourblind-safe palette into whichever renderer is live. */
function applyPalette(): void {
  const p = a11y.palette();
  c2d?.setEntityColors({
    player: p.player, npc: p.npc, mob: p.mob, pickup: p.pickup, projectile: p.projectile,
  });
  c2d?.setTelegraphColor(p.telegraph);
  if (iso) {
    iso.setEntityColors({
      player: hexNum(p.player, 0xff9a4d),
      npc: hexNum(p.npc, 0x4dc3ff),
      mob: hexNum(p.mob, 0xff5252),
      pickup: hexNum(p.pickup, 0xffe066),
      projectile: hexNum(p.projectile, 0xffffff),
    });
    iso.setTelegraphColor(hexNum(p.telegraph, 0xff3b3b));
  }
}

/** `#rrggbb` -> 0xrrggbb for the three.js renderer; fallback on garbage. */
function hexNum(hex: string, fallback: number): number {
  const rgb = hexToRgb(hex);
  return rgb ? (rgb[0]! << 16) | (rgb[1]! << 8) | rgb[2]! : fallback;
}

function syncA11yPanel() {
  const s = a11y.get();
  const setBox = (id: string, v: boolean) => {
    const e = el<HTMLInputElement>(id);
    if (e) e.checked = v;
  };
  setBox('a11y-contrast', s.highContrast);
  setBox('a11y-motion', s.reducedMotion);
  setBox('a11y-announce', s.announce);
  setBox('a11y-click', s.clickToAttack);
  setBox('a11y-hold', s.holdToAttack);
  const sel = (id: string, v: string) => {
    const e = el<HTMLSelectElement>(id);
    if (e) e.value = v;
  };
  sel('a11y-locale', i18n.getLocale());
  sel('a11y-palette', s.palette);
  sel('a11y-scheme', s.moveScheme);
  const scale = el<HTMLInputElement>('a11y-scale');
  const pct = String(Math.round(s.textScale * 100));
  if (scale && scale.value !== pct) scale.value = pct;
  const scaleVal = el('a11y-scale-val');
  if (scaleVal) scaleVal.textContent = `${pct}%`;
  const atk = el('a11y-attackkey');
  if (atk) atk.textContent = keyLabel(s.attackKey);
  // Warn when a movement scheme shadows a client hotkey (IJKL steals L).
  const warn = el('a11y-scheme-warn');
  const conflicts = movementConflicts(s.moveScheme);
  if (warn) {
    warn.hidden = conflicts.length === 0;
    warn.textContent = conflicts.length
      ? conflicts.map((c) => `${keyLabel(c.code)} also toggles ${c.action}`).join(' · ')
      : '';
  }
}

el<HTMLSelectElement>('a11y-locale')?.addEventListener('change', (e) => {
  i18n.setLocale((e.target as HTMLSelectElement).value as Locale);
});
el<HTMLSelectElement>('a11y-palette')?.addEventListener('change', (e) => {
  a11y.set({ palette: (e.target as HTMLSelectElement).value as PaletteMode });
});
el<HTMLSelectElement>('a11y-scheme')?.addEventListener('change', (e) => {
  a11y.set({ moveScheme: (e.target as HTMLSelectElement).value as MoveScheme });
});
el('a11y-contrast')?.addEventListener('change', (e) => {
  a11y.set({ highContrast: (e.target as HTMLInputElement).checked });
});
el('a11y-motion')?.addEventListener('change', (e) => {
  a11y.set({ reducedMotion: (e.target as HTMLInputElement).checked });
});
el('a11y-announce')?.addEventListener('change', (e) => {
  a11y.set({ announce: (e.target as HTMLInputElement).checked });
});
el('a11y-click')?.addEventListener('change', (e) => {
  a11y.set({ clickToAttack: (e.target as HTMLInputElement).checked });
});
el('a11y-hold')?.addEventListener('change', (e) => {
  a11y.set({ holdToAttack: (e.target as HTMLInputElement).checked });
});
el<HTMLInputElement>('a11y-scale')?.addEventListener('input', (e) => {
  a11y.set({ textScale: Number((e.target as HTMLInputElement).value) / 100 });
});
el('a11y-reset')?.addEventListener('click', () => { sound.click(); a11y.reset(); });

// Attack-key rebinding: click the button, then press a key.
let capturingAttack = false;
el('a11y-attackkey')?.addEventListener('click', () => {
  capturingAttack = true;
  el('a11y-attackkey')!.textContent = i18n.t('a11y.capturing', { action: i18n.t('a11y.attackKey') });
});
addEventListener('keydown', (e) => {
  if (!capturingAttack) return;
  if (e.code === 'Escape') {
    capturingAttack = false;
    syncA11yPanel();
    return;
  }
  if (isValidKeyCode(e.code)) {
    capturingAttack = false;
    a11y.set({ attackKey: e.code });
  }
}, true);

// Skip link: move focus to the game view so keyboard users bypass the HUD.
el('a11y-skip')?.addEventListener('click', (e) => {
  e.preventDefault();
  view.focus();
  a11y.announce({ type: 'panelOpen', panel: i18n.t('a11y.skipGame') });
});

// Re-render HUD + panel strings whenever the locale changes.
i18n.onChange(() => {
  hud.relocalize();
  syncA11yPanel();
  a11y.syncLocale(i18n.getLocale());
});

function syncSettingsPanel() {
  const s = settings.settings;
  const sel = (id: string, on: boolean) => {
    const el = document.getElementById(id);
    if (el) el.classList.toggle('sel', on);
  };
  sel('set-r-auto', s.renderer === 'auto');
  sel('set-r-three', s.renderer === 'three');
  sel('set-r-canvas', s.renderer === 'canvas');
  sel('set-q-low', s.quality === 'low');
  sel('set-q-med', s.quality === 'med');
  sel('set-q-high', s.quality === 'high');
  const dist = document.getElementById('set-distance') as HTMLInputElement | null;
  const distVal = document.getElementById('set-distance-val');
  if (dist && dist.value !== String(s.renderDistance)) dist.value = String(s.renderDistance);
  if (distVal) distVal.textContent = String(s.renderDistance);
  const fpsBox = document.getElementById('set-fps') as HTMLInputElement | null;
  if (fpsBox && fpsBox.checked !== s.showFps) fpsBox.checked = s.showFps;
  const muteBox = document.getElementById('set-mute') as HTMLInputElement | null;
  if (muteBox && muteBox.checked !== s.muted) muteBox.checked = s.muted;
}

function switchRenderer(pref: 'auto' | 'three' | 'canvas', silent = false) {
  settings.set({ renderer: pref });
  if (pref === 'canvas' && activeMode !== 'canvas') {
    showCanvas();
    applySettings();
    if (!silent) toast(i18n.t('toast.canvasOn'));
  } else if (pref === 'three' && activeMode !== 'three') {
    if (!showThree()) {
      showCanvas();
      applySettings();
      toast(i18n.t('toast.noWebglStay'));
      return;
    }
    if (!silent) toast(i18n.t('toast.threeOn'));
  } else if (pref === 'auto') {
    if (!iso && activeMode !== 'three') {
      if (showThree() && !silent) toast(i18n.t('toast.autoThree'));
    }
  }
  applySettings();
}

document.getElementById('set-r-auto')!.onclick = () => switchRenderer('auto');
document.getElementById('set-r-three')!.onclick = () => switchRenderer('three');
document.getElementById('set-r-canvas')!.onclick = () => switchRenderer('canvas');
document.getElementById('set-q-low')!.onclick = () => settings.set({ quality: 'low' });
document.getElementById('set-q-med')!.onclick = () => settings.set({ quality: 'med' });
document.getElementById('set-q-high')!.onclick = () => settings.set({ quality: 'high' });
(document.getElementById('set-distance') as HTMLInputElement).oninput = (e) => {
  const v = Number((e.target as HTMLInputElement).value);
  settings.set({ renderDistance: v });
};
(document.getElementById('set-fps') as HTMLInputElement).onchange = (e) => {
  settings.set({ showFps: (e.target as HTMLInputElement).checked });
};
(document.getElementById('set-mute') as HTMLInputElement).onchange = (e) => {
  const m = (e.target as HTMLInputElement).checked;
  sound.setMuted(m);
  settings.set({ muted: m });
  btnSound.textContent = m ? '🔇' : '🔊';
};

// ---- net events ----
const prevHp = new Map<number, number>();
const nameMap = new Map<number, string>();
const kindMap = new Map<number, string>();
/** Ids whose death was already announced (mob-die event or snapshot removal). */
const announcedDeaths = new Set<number>();
let welcomed = false;
let firstSnapshot = false;

net.onChat = (from, text, channel) => {
  hud.addChat(from, text, channel);
  sound.chat();
};
hud.onSendChat = (text, channel) => {
  net.sendChat(text, channel);
  // SYSTEMS-HOOK: a command's answer is usually the panel it concerns, so open
  // it on the way out rather than making the player hunt for the toggle.
  const cmd = text.trim().toLowerCase();
  if (cmd.startsWith('/party') || cmd === '/inv' || cmd === '/invite' || cmd === '/accept' || cmd.startsWith('/kick') || cmd.startsWith('/promote')) {
    openPanel('af-party');
  } else if (cmd.startsWith('/shop') || cmd.startsWith('/buy') || cmd.startsWith('/sell') || cmd === '/store' || cmd === '/vendor') {
    openPanel('af-vendor');
  } else if (cmd.startsWith('/talent') || cmd === '/tree' || cmd.startsWith('/respec') || cmd.startsWith('/stats')) {
    openPanel('af-talents');
  }
};

net.onWelcome = () => {
  welcomed = true;
  loadingText.textContent = i18n.t('loading.world');
  const self = net.entities.get(net.id);
  if (self) {
    pred.reset(self.p.x, self.p.y);
    hud.setHp(self.hp, self.maxHp);
  }
  sound.join();
};

net.onSnapshot = () => {
  const self = net.entities.get(net.id);
  if (self) {
    if (!pred.initialized) pred.reset(self.p.x, self.p.y);
    else pred.reconcile(self.p.x, self.p.y, net.lastAckSeq);
    hud.setHp(self.hp, self.maxHp);
    if (typeof self.level === 'number') {
      level = self.level;
      levels.set(self.id, self.level);
      hud.setXp(xp, xpNext, level);
    }
    // Death fallback: some builds send a 0-hp snapshot before respawn.
    if (self.hp <= 0 && !deathEl.classList.contains('show')) {
      showDeath('The ether claims another soul. You wake at the shrine…');
    }
    // Shrine quest: proximity to (50,50).
    const d = Math.hypot(self.p.x - 50, self.p.y - 50);
    if (d < 3 && !shrineVisited) {
      shrineVisited = true;
      hud.addKill('Quest complete: Touch the Sky');
      sound.quest();
    }
    // Fog-of-war: reveal chunks around the player (sessionStorage-backed).
    fog.markAround(self.p.x, self.p.y, FOG_RADIUS);
    // Explore quest fallback: a newly entered chunk credits 'Chart the Fall'.
    // Authoritative `quest-progress` still wins because its count is absolute.
    const key = fogChunkKey(self.p.x, self.p.y);
    if (key !== lastExploreKey) {
      lastExploreKey = key;
      if (!exploreSeen.has(key)) {
        exploreSeen.add(key);
        // Skip the very first chunk (spawn) so the count means "new ground".
        if (exploreSeen.size > 1 && chain.onExploreStep()) hud.setQuests(chain.toHud());
      }
    }
  }
  const alive = new Set<number>();
  for (const [id, e] of net.entities) {
    alive.add(id);
    if (typeof e.level === 'number') levels.set(id, e.level);
    const prev = prevHp.get(id);
    if (prev !== undefined && e.hp < prev) {
      const dmgAmt = prev - e.hp;
      const pos = id === net.id ? pred.pos : e.p;
      if (activeMode === 'canvas' && c2d) {
        c2d.damage(pos.x, pos.y, `-${dmgAmt}`);
        c2d.burst(pos.x, pos.y, '#ff6b6b', 8);
      } else if (iso) {
        iso.flash(pos.x, pos.y, 0xff5252);
        floatText(pos.x, pos.y, `-${dmgAmt}`, '#ff8080');
      }
      if (id === net.id) {
        damageVignette(Math.min(2, dmgAmt / 12));
        shake(Math.min(0.7, dmgAmt / 22));
        sound.hit();
      }
    }
    prevHp.set(id, e.hp);
    nameMap.set(id, e.name ?? ('#' + id));
    kindMap.set(id, e.kind);
    // A live sighting clears any stale death-mark, so a respawned mob that
    // dies again still reports.
    if (e.hp > 0) announcedDeaths.delete(id);
  }
  for (const id of [...prevHp.keys()]) {
    if (!alive.has(id)) {
      const nm = nameMap.get(id) ?? ('#' + id);
      const wasMob = kindMap.get(id) === 'mob';
      // A genuine kill: the mob was a mob, we saw it at 0 HP, and no
      // authoritative `mob-die` already claimed it. A mob that simply left
      // the interest radius is still at full HP, so it is never counted.
      const killed = wasMob && (prevHp.get(id) ?? 1) <= 0 && !announcedDeaths.has(id);
      if (id !== net.id && wasMob) {
        announcedDeaths.add(id);
        if (killed) {
          hud.addKill(`${nm} has fallen`);
          // `mob-die` is the authoritative kill source when the server sends
          // it; this is the fallback for the NPC minions that simply vanish.
          if (chain.onMobDie(true, null)) hud.setQuests(chain.toHud());
          if (!firstBlood) {
            firstBlood = true;
            sound.quest();
          } else {
            sound.kill();
          }
        }
      }
      prevHp.delete(id);
      nameMap.delete(id);
      kindMap.delete(id);
      levels.delete(id);
    }
  }
  // Bound the death-mark set (entity ids are recycled over a long session).
  if (announcedDeaths.size > 512) announcedDeaths.clear();
  interp.push([...net.entities.values()], net.id);
  interp.prune(alive);
  if (welcomed && !firstSnapshot) {
    firstSnapshot = true;
    loadingEl.classList.remove('show');
    loginEl.style.display = 'none';
    view.focus();
    maybeTutorial();
  }
};

net.onEvent = (kind, payload) => {
  // SYSTEMS-HOOK: feed the composed-systems stores first. Whatever they do not
  // recognise falls through to the existing handlers untouched.
  if (systems.apply(kind, payload)) {
    partyPanel.render();
    vendorPanel.render();
    talentPanel.render();
  }
  const p = (payload ?? null) as Record<string, unknown> | null;
  const num = (k: string): number | null => {
    const v = p?.[k];
    return typeof v === 'number' && Number.isFinite(v) ? v : null;
  };
  const str = (k: string): string | null => {
    const v = p?.[k];
    return typeof v === 'string' ? v : null;
  };
  /** Server gameplay events carry playerId; only react to our own. */
  const forMe = (): boolean => {
    const pid = num('playerId');
    return pid === null || pid === net.id;
  };

  switch (kind) {
    // --- boss telegraph ring (server/src/index.ts npcs.tick) ---
    case 'telegraph': {
      const t = asTelegraph(p);
      if (!t) break; // unknown/bad shape -> ignore silently
      if (c2d && activeMode === 'canvas') c2d.telegraph(t.x, t.y, t.r, t.ttlMs, t.label);
      else if (iso) iso.telegraph(t.x, t.y, t.r, t.ttlMs);
      // Impact shake when the landing spot is close to the player.
      const d = Math.hypot(t.x - pred.pos.x, t.y - pred.pos.y);
      // a11y: announce the telegraph (assertive — this can kill you), but only
      // when the ring is near enough to matter so the SR is not spammed.
      if (d <= t.r + 6) hud.announceTelegraph(t.label);
      if (d <= t.r + 6) window.setTimeout(() => shake(0.55 * (1 - Math.min(1, d / (t.r + 6)))), t.ttlMs);
      break;
    }
    // --- XP / level ---
    case 'xp':
    case 'xp-gain': {
      if (!forMe()) break;
      // v1: { playerId, amount, level, xpLeft } — xpLeft is absolute XP into
      // the current level. Legacy builds sent { xp, next, level }.
      const left = num('xpLeft');
      const legacy = num('xp');
      const amount = num('amount');
      if (left !== null) xp = left;
      else if (legacy !== null) xp = legacy;
      else if (amount !== null && kind === 'xp-gain') xp += amount;
      const lv = num('level');
      if (lv !== null) {
        level = lv;
        levels.set(net.id, level);
      }
      // Server curve is level*100 (game/quests.ts xpForNextLevel).
      const next = num('next');
      xpNext = next !== null && next > 0 ? next : Math.max(100, level * 100);
      hud.setXp(xp, xpNext, level);
      break;
    }
    case 'levelup': {
      if (!forMe()) break;
      const lv = num('level');
      if (lv !== null) {
        level = lv;
        levels.set(net.id, level);
        hud.setXp(xp, level * 100, level);
        toast(i18n.t('toast.levelUp', { level }), 3000);
        a11y.announce({ type: 'levelUp', level });
        sound.quest();
        if (iso && activeMode === 'three') iso.shake(0.25);
        else if (c2d) c2d.shake(3);
      }
      break;
    }
    // --- kills ---
    case 'mob-die': {
      const id = num('id');
      if (id !== null) {
        announcedDeaths.add(id);
        // Combat feel: floor blood at the corpse + clear the crawl mark, for
        // every kill no matter who landed it (world-visible decals).
        const corpse = net.entities.get(id);
        if (corpse && Number.isFinite(corpse.p.x) && Number.isFinite(corpse.p.y)) {
          if (c2d) c2d.addBlood(corpse.p.x, corpse.p.y);
          if (iso) iso.addBlood(corpse.p.x, corpse.p.y);
        }
        c2d?.clearDowned(id);
        iso?.clearDowned(id);
      }
      if (!forMe()) break;
      const killedBy = num('killedBy');
      const mine = killedBy === net.id;
      const nm = id !== null ? (nameMap.get(id) ?? '#' + id) : 'a foe';
      if (mine) {
        hud.addKill(`${nm} slain`);
        if (chain.onMobDie(true, null)) hud.setQuests(chain.toHud());
        if (!firstBlood) { firstBlood = true; sound.quest(); } else sound.kill();
      } else {
        hud.addKill(`${nm} has fallen`);
      }
      // Finishers hit harder (gated by reduced motion inside shake()).
      if (p?.['finisher'] === true) shake(1.0);
      break;
    }
    // --- close-quarters finish loop (server game/melee + ai/npc) ---
    case 'mob-downed': {
      const id = num('id');
      if (id !== null) {
        c2d?.markDowned(id);
        iso?.markDowned(id);
      }
      break;
    }
    case 'mob-up': {
      const id = num('id');
      if (id !== null) {
        c2d?.clearDowned(id);
        iso?.clearDowned(id);
      }
      break;
    }
    case 'hit-stop': {
      // Freeze-frame on kills, gated by reduced motion (same gate as shake;
      // audio cues still play).
      if (!a11y.motionEnabled()) break;
      const ms = num('durationMs');
      const dur = ms !== null ? Math.max(0, Math.min(500, ms)) : 90;
      if (dur <= 0) break;
      if (iso && activeMode === 'three') iso.hitStop(dur);
      else if (c2d) c2d.hitStop(dur);
      break;
    }
    case 'mob-spawn':
    case 'mob-respawn':
    case 'mob-aggro':
    case 'pickup-spawn':
      break; // server-authoritative; entities arrive via snapshots
    // --- quest chain (server/src/game/index.ts questEvent) ---
    case 'quest-progress': {
      if (!forMe()) break;
      const qid = str('questId');
      const count = num('count');
      const goal = num('goal');
      if (qid && count !== null && goal !== null && chain.onQuestProgress(qid, count, goal)) {
        hud.setQuests(chain.toHud());
        // a11y: speak the updated objective for screen-reader players.
        const q = chain.questById(qid);
        if (q) hud.announceQuest('progress', `${q.name} (${count}/${goal})`, q.briefing);
      }
      break;
    }
    case 'quest-complete': {
      if (!forMe()) break;
      const qid = str('questId');
      if (!qid) break;
      const done = chain.onQuestComplete(qid);
      hud.setQuests(chain.toHud());
      if (done) {
        hud.addKill(`✔ Quest complete: ${done.name}`);
        toast(i18n.t('toast.questComplete', { name: i18n.tServer(done.name) }), 3600);
        hud.announceQuest('complete', done.name);
        sound.quest();
        if (iso && activeMode === 'three') iso.shake(0.3);
        else if (c2d) c2d.shake(4);
        if (chain.isChainDone()) {
          window.setTimeout(() => toast(i18n.t('toast.chainDone'), 6000), 1200);
        }
      }
      break;
    }
    // --- loot / kill text (older builds) ---
    case 'loot': {
      const item = str('item');
      if (!item) break;
      if (!hud.addItem(item)) {
        hud.addKill('inventory full!');
        a11y.announce({ type: 'inventoryFull' });
      } else {
        hud.addKill(`looted ${item}`);
        a11y.announce({ type: 'item', name: i18n.tServer(item) });
      }
      break;
    }
    case 'kill': {
      const text = str('text');
      if (!text) break;
      hud.addKill(text);
      sound.kill();
      break;
    }
    case 'boss-kill': {
      const boss = str('boss');
      if (boss) {
        const name = i18n.tServer(boss);
        hud.addKill(`🏆 ${name} felled`);
        toast(i18n.t('toast.bossFelled', { name }), 3600);
        a11y.announce({ type: 'raw', text: i18n.t('toast.bossFelled', { name }) });
        sound.kill();
        // Combat feel: blood at the reported position + clear the crawl mark.
        const bx = num('x');
        const by = num('y');
        if (bx !== null && by !== null) {
          if (c2d) c2d.addBlood(bx, by);
          if (iso) iso.addBlood(bx, by);
        }
        const bid = num('id');
        if (bid !== null) {
          c2d?.clearDowned(bid);
          iso?.clearDowned(bid);
        }
        // Finishers hit harder (gated by reduced motion inside shake()).
        if (p?.['finisher'] === true) shake(1.0);
        else if (iso && activeMode === 'three') iso.shake(0.6);
        else if (c2d) c2d.shake(8);
      }
      break;
    }
    // --- respawn / despawn ---
    case 'respawn': {
      const id = num('id');
      if (id === null) break;
      const nm = nameMap.get(id) ?? ('#' + id);
      if (id === net.id) {
        // Server auto-respawns at the shrine; show the death screen briefly.
        showDeath('The ether claims another soul. You wake at the shrine…');
        shake(0.9);
        window.setTimeout(() => hideDeath(), 2500);
        const self = net.entities.get(net.id);
        if (self) pred.reset(self.p.x, self.p.y);
      } else {
        hud.addKill(`${nm} rose again at the shrine`);
      }
      break;
    }
    case 'despawn': {
      // Removal is handled via snapshot `removed`; nothing extra needed.
      break;
    }
    // --- sharding / moderation ---
    case 'redirect': {
      const url = str('url');
      toast(url ? i18n.t('srv.chat.redirect', { url }) : i18n.t('srv.chat.redirectAny'), 5000);
      break;
    }
    case 'queue': {
      const pos = num('position');
      const max = num('max');
      toast(pos !== null
        ? i18n.t('srv.chat.queue', { pos, max: max ?? '?' })
        : i18n.t('srv.chat.queueAny'), 4000);
      break;
    }
    case 'kicked': {
      const reason = str('reason');
      toast(i18n.t('srv.chat.kicked', {
        reason: reason ? i18n.tServer(reason) : i18n.t('srv.chat.kickedDefault'),
      }), 8000);
      break;
    }
    case 'chat-limited': toast(i18n.t('srv.chat.rateLimited'), 2600); break;
    case 'bad-proto': toast(i18n.t('srv.chat.badProto'), 6000); break;
    default:
      // Unknown event kinds are ignored on purpose: the server may ship
      // gameplay/anti-cheat/sharding events this build knows nothing about.
      break;
  }
};

// ---- pointer: editor paint or attack ----
function toWorld(clientX: number, clientY: number): { x: number; y: number } {
  if (iso && activeMode === 'three') return iso.screenToWorld(clientX, clientY);
  return c2d!.screenToWorld(clientX, clientY, cam.x, cam.y);
}
let painting = false;
view.addEventListener('contextmenu', (e) => e.preventDefault());
view.addEventListener('mousedown', (e) => {
  if (e.target === nameInput || e.target === joinBtn || e.target === serverInput) return;
  if ((e.target as HTMLElement).closest?.('#settings,#leaderboard,#login,#a11y-panel,.a11y-panel,.tbtn,.sbtn')) return;
  if (editor.active && editor.paintMode && (e.button === 0 || e.button === 2)) {
    painting = true;
    const w = toWorld(e.clientX, e.clientY);
    editor.paintAtWorld(w.x, w.y, e.button === 2 || e.shiftKey);
  } else if (e.button === 0) {
    // a11y: click-to-attack can be disabled (keyboard-only play), and
    // hold-to-attack repeats while the button stays down.
    if (a11y.get().clickToAttack) attackQueued = true;
    if (a11y.get().holdToAttack) startHoldAttack();
  }
});
view.addEventListener('mousemove', (e) => {
  if (!painting) return;
  const w = toWorld(e.clientX, e.clientY);
  editor.paintAtWorld(w.x, w.y, (e.buttons & 2) !== 0 || e.shiftKey);
});
addEventListener('mouseup', () => { painting = false; stopHoldAttack(); });

// ---- join ----
function serverUrl(): string {
  const v = serverInput?.value.trim();
  return v || DEFAULT_SERVER;
}
function join() {
  const name = nameInput.value.trim() || 'hero';
  sound.click();
  loadingEl.classList.add('show');
  loadingText.textContent = `Connecting to ${serverUrl()}…`;
  // ASSETS: preload art in the background with loading-screen progress. Never
  // blocks the net handshake: a missing manifest.json just yields placeholders.
  void (async () => {
    try {
      if (!assets.manifest) await assets.loadManifest().catch(() => null);
      const names = [...DEFAULT_ART];
      await assets.preload(names, (p) => {
        try {
          if (!welcomed && loadingEl.classList.contains('show')) {
            loadingText.textContent = `Connecting to ${serverUrl()}… · art ${p.loaded}/${p.total}`;
          }
        } catch { /* ignore */ }
      }).catch(() => []);
    } catch { /* ignore: boot continues without art */ }
  })();
  try {
    net.connect(serverUrl(), name);
  } catch {
    loadingText.textContent = i18n.t('loading.failed');
    return;
  }
  // Failsafe: never trap the player on the loading screen.
  window.setTimeout(() => {
    if (!firstSnapshot && loadingEl.classList.contains('show')) {
      loadingText.textContent = i18n.t('loading.slow');
    }
  }, 4000);
  view.focus();
}
joinBtn.onclick = join;
nameInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') join(); });
serverInput?.addEventListener('keydown', (e) => {
  e.stopPropagation();
  if (e.key === 'Enter') join();
});
if (qs.has('name') || qs.has('autojoin')) {
  nameInput.value = qs.get('name') ?? 'hero';
  join();
}

// Auto-hide death overlay if the player already respawned (failsafe).
setInterval(() => {
  if (deathEl.classList.contains('show') && performance.now() - deathShownAt > 6000) hideDeath();
}, 1000);

// ---- frame loop ----
const cam = { x: 50, y: 50 };
const labelPool = new Map<number, HTMLElement>();
let lastFrame = performance.now();
let fpsEma = 60, lastStatus = 0, lastMap = 0, lastLb = 0, lastBoss = 0;
let fpsFrames = 0, fpsWindowStart = performance.now(), lowFpsWindows = 0;

function floatText(x: number, y: number, text: string, color: string) {
  if (!iso || activeMode !== 'three') return;
  const p = iso.project(x, y);
  const d = document.createElement('div');
  d.className = 'float';
  d.textContent = text;
  d.style.color = color;
  d.style.left = p.sx + 'px';
  d.style.top = p.sy + 'px';
  labelsEl.appendChild(d);
  setTimeout(() => d.remove(), 950);
}

function updateLabels(list: DrawEntity[]) {
  if (!iso || activeMode !== 'three') return;
  const seen = new Set<number>();
  for (const e of list) {
    if (e.kind === 'pickup' || e.kind === 'projectile') continue;
    seen.add(e.id);
    let d = labelPool.get(e.id);
    if (!d) {
      d = document.createElement('div');
      d.className = 'nametag';
      labelsEl.appendChild(d);
      labelPool.set(e.id, d);
    }
    const p = iso.project(e.x, e.y, zVisual(terrain.tileHeightAt(e.x, e.y)));
    d.style.left = p.sx + 'px';
    d.style.top = (p.sy - 8) + 'px';
    if (d.textContent !== e.name) d.textContent = e.name;
  }
  for (const [id, d] of [...labelPool]) {
    if (!seen.has(id)) { d.remove(); labelPool.delete(id); }
  }
}

function currentDrawList(now: number): DrawEntity[] {
  const list: DrawEntity[] = [];
  for (const e of net.entities.values()) {
    if (e.id === net.id) {
      list.push({ id: e.id, kind: e.kind, x: pred.pos.x, y: pred.pos.y, hp: e.hp, maxHp: e.maxHp, name: e.name ?? ('#' + e.id), isLocal: true, z: e.z });
    } else {
      const s = interp.sample(e.id, now);
      list.push({
        id: e.id, kind: e.kind, x: s ? s.x : e.p.x, y: s ? s.y : e.p.y,
        hp: s ? s.hp : e.hp, maxHp: e.maxHp, name: e.name ?? ('#' + e.id), isLocal: false,
        // TERRAIN: the shard's authoritative elevation when `snapshotZ` is on;
        // the renderers sample the same pure field when it is absent.
        z: e.z,
      });
    }
  }
  return list;
}

/** FPS meter + auto-fallback: 1s windows; <30fps for 5 straight windows → Canvas2D. */
function fpsTrack(now: number) {
  fpsFrames++;
  if (now - fpsWindowStart >= 1000) {
    const fps = (fpsFrames * 1000) / Math.max(1, now - fpsWindowStart);
    fpsFrames = 0;
    fpsWindowStart = now;
    if (settings.settings.showFps) {
      fpsEl.textContent = `${activeMode === 'three' ? 'three-iso' : 'canvas2d'} · ${Math.round(fps)} fps`;
    }
    if (activeMode === 'three' && !autoFallbackDone && settings.settings.renderer === 'auto') {
      if (fps < 30) {
        lowFpsWindows++;
        if (lowFpsWindows >= 5) {
          autoFallbackDone = true;
          showCanvas();
          applySettings();
          toast(i18n.t('toast.lowFps'));
        }
      } else {
        lowFpsWindows = 0;
      }
    } else if (activeMode !== 'three') {
      lowFpsWindows = 0;
    }
  }
}

function frame(now: number) {
  const dt = Math.min(0.1, (now - lastFrame) / 1000);
  lastFrame = now;
  if (dt > 0) fpsEma += (1 / dt - fpsEma) * 0.05;
  fpsTrack(now);

  const ck = 1 - Math.exp(-dt * 8);
  cam.x += (pred.pos.x - cam.x) * ck;
  cam.y += (pred.pos.y - cam.y) * ck;

  const list = currentDrawList(now);
  // Fog-of-war follows the *predicted* position so the revealed circle does
  // not lag behind the camera by a reconciliation step.
  const fogOpts = { fog, playerX: pred.pos.x, playerY: pred.pos.y };

  if (iso && activeMode === 'three') {
    iso.setFog(fog, pred.pos.x, pred.pos.y);
    iso.update(list, cam.x, cam.y, now);
    updateLabels(list);
  } else if (c2d) {
    c2d.render(list, cam.x, cam.y, now, editor.active ? editor.walls : undefined, fogOpts);
  }

  if (now - lastMap > 250) {
    lastMap = now;
    hud.drawMinimap(list, editor.active ? editor.walls : undefined, fog, pred.pos.x, pred.pos.y, terrain);
  }
  if (now - lastBoss > 200) {
    lastBoss = now;
    hud.setBosses(bossBars(list));
  }
  if (lbVisible && now - lastLb > 1000) {
    lastLb = now;
    hud.updateLeaderboard(list, net.id, levels);
  }
  // SYSTEMS-HOOK: emote bubbles ride the same frame loop as the nametags. Only
  // #labels is displayed in three mode, so bubbles follow that switch.
  labelsEl.style.display = iso && activeMode === 'three' ? 'block' : 'none';
  bubbleLayer.render(now, projectWorld);
  if (now - lastStatus > 500) {
    lastStatus = now;
    // Surface the negotiated wire protocol so the v2 default can be verified live
    // (?proto=1 forces v1; v1 clients have no `proto` field and always report 1).
    const wire = net instanceof NetClientV2 ? net.proto : 1;
    statusEl.textContent =
      `${activeMode === 'three' ? 'three-iso' : 'canvas2d'} · proto ${wire} · ping ${Math.round(net.rttMs)}ms · ${Math.round(fpsEma)}fps · ` +
      `pos (${pred.pos.x.toFixed(1)}, ${pred.pos.y.toFixed(1)}) · ` +
      `ent ${list.length} · seq ${seq}/ack ${net.lastAckSeq}`;
  }
  requestAnimationFrame(frame);
}

initRenderer();
window.addEventListener('resize', () => {
  if (c2d && activeMode === 'canvas') c2d.fitToContainer();
  if (iso && activeMode === 'three') iso.resize();
});
requestAnimationFrame(frame);
