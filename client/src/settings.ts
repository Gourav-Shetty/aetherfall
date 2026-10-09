// AETHERFALL client settings — persisted to localStorage, applied live.
export type RendererPref = 'auto' | 'three' | 'canvas';
export type Quality = 'low' | 'med' | 'high';

export interface Settings {
  renderer: RendererPref;
  renderDistance: number; // ortho view size for three (15..50), zoom driver for canvas
  quality: Quality;
  showFps: boolean;
  muted: boolean;
}

const KEY = 'af_settings_v1';

export const DEFAULTS: Settings = {
  renderer: 'auto',
  renderDistance: 30,
  quality: 'high',
  showFps: true,
  muted: false,
};

export function qualityCaps(q: Quality): { pixelRatio: number; particles: number; flashes: number } {
  switch (q) {
    case 'low': return { pixelRatio: 1, particles: 100, flashes: 12 };
    case 'med': return { pixelRatio: 1.5, particles: 250, flashes: 30 };
    default: return { pixelRatio: 2, particles: 400, flashes: 60 };
  }
}

export class SettingsStore {
  settings: Settings;
  onChange: (s: Settings) => void = () => {};

  constructor() {
    this.settings = { ...DEFAULTS };
    try {
      const raw = localStorage.getItem(KEY);
      if (raw) {
        const p = JSON.parse(raw) as Partial<Settings>;
        if (p.renderer === 'auto' || p.renderer === 'three' || p.renderer === 'canvas') {
          this.settings.renderer = p.renderer;
        }
        if (typeof p.renderDistance === 'number' && Number.isFinite(p.renderDistance)) {
          this.settings.renderDistance = Math.max(15, Math.min(50, p.renderDistance));
        }
        if (p.quality === 'low' || p.quality === 'med' || p.quality === 'high') {
          this.settings.quality = p.quality;
        }
        if (typeof p.showFps === 'boolean') this.settings.showFps = p.showFps;
        if (typeof p.muted === 'boolean') this.settings.muted = p.muted;
      }
      // Mute has a legacy key (sound.ts); migrate it in.
      if (localStorage.getItem('af_muted') === '1') this.settings.muted = true;
      if (localStorage.getItem('af_muted') === '0') this.settings.muted = false;
    } catch {
      /* ignore */
    }
  }

  set(patch: Partial<Settings>) {
    this.settings = { ...this.settings, ...patch };
    if (typeof patch.renderDistance === 'number') {
      this.settings.renderDistance = Math.max(15, Math.min(50, this.settings.renderDistance));
    }
    try {
      localStorage.setItem(KEY, JSON.stringify(this.settings));
      localStorage.setItem('af_muted', this.settings.muted ? '1' : '0');
    } catch {
      /* ignore */
    }
    this.onChange(this.settings);
  }
}
