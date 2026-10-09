// AETHERFALL sound stub — WebAudio bleeps, no assets, mutable.
// All sounds are tiny oscillator envelopes so the client stays dependency-free.
export class Sound {
  muted = false;
  private ctx: AudioContext | null = null;

  constructor() {
    try {
      this.muted = localStorage.getItem('af_muted') === '1';
    } catch {
      this.muted = false;
    }
  }

  setMuted(m: boolean) {
    this.muted = m;
    try {
      localStorage.setItem('af_muted', m ? '1' : '0');
    } catch {
      /* ignore */
    }
  }

  toggle(): boolean {
    this.setMuted(!this.muted);
    return this.muted;
  }

  private ensure(): AudioContext | null {
    if (this.muted) return null;
    try {
      if (!this.ctx) {
        const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
        if (!AC) return null;
        this.ctx = new AC();
      }
      if (this.ctx.state === 'suspended') void this.ctx.resume();
      return this.ctx;
    } catch {
      return null;
    }
  }

  /** Generic blip: freq Hz, dur seconds, optional slide to freq2. */
  blip(freq = 440, dur = 0.08, type: OscillatorType = 'square', vol = 0.06, freq2?: number) {
    const ctx = this.ensure();
    if (!ctx) return;
    try {
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.type = type;
      o.frequency.setValueAtTime(freq, ctx.currentTime);
      if (freq2 !== undefined) o.frequency.exponentialRampToValueAtTime(Math.max(20, freq2), ctx.currentTime + dur);
      g.gain.setValueAtTime(vol, ctx.currentTime);
      g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + dur);
      o.connect(g).connect(ctx.destination);
      o.start();
      o.stop(ctx.currentTime + dur + 0.02);
    } catch {
      /* ignore */
    }
  }

  click() { this.blip(660, 0.05, 'square', 0.04); }
  attack() { this.blip(520, 0.07, 'sawtooth', 0.05, 220); }
  hit() { this.blip(180, 0.12, 'sawtooth', 0.07, 90); }
  death() { this.blip(220, 0.5, 'sawtooth', 0.08, 55); }
  respawn() { this.blip(330, 0.18, 'sine', 0.07, 660); }
  join() { this.blip(440, 0.1, 'sine', 0.05, 880); }
  chat() { this.blip(880, 0.05, 'sine', 0.03); }
  quest() { this.blip(523, 0.12, 'triangle', 0.06, 784); }
  kill() { this.blip(150, 0.2, 'square', 0.06, 60); }
}
