/**
 * Level editor: enabled with ?editormode=1.
 * Left-drag paints wall tiles, Shift+drag (or right-drag) erases.
 * Walls sync with the authoritative server (GET/POST /walls on the metrics
 * port, default http://<host>:9090) and export aetherfall-walls/v1 JSON for
 * tools/level-editor. Room/corridor/dungeon stamps reuse engine worldgen.
 */
import {
  WALLS_FORMAT,
  WALLS_VERSION,
  tileKeysToWalls,
  validateWalls,
} from '@aetherfall/shared';
import { genDungeon } from '@aetherfall/engine';

const ARENA = 100;

export class Editor {
  readonly active: boolean;
  readonly walls = new Set<string>();
  paintMode = true;
  private countEl: HTMLElement | null = null;
  private outEl: HTMLTextAreaElement | null = null;
  private paintBtn: HTMLButtonElement | null = null;
  private statusEl: HTMLElement | null = null;
  private fileInput: HTMLInputElement | null = null;
  private pushTimer = 0;
  private lastWorld = { x: 50, y: 50 };

  constructor() {
    this.active = new URLSearchParams(window.location.search).has('editormode');
  }

  mount(root: HTMLElement) {
    if (!this.active) return;
    root.innerHTML = `
      <div class="ed-panel">
        <b>EDITOR</b> <span id="ed-count">0</span> walls <span id="ed-status">…</span><br/>
        <button id="ed-paint">paint: on</button>
        <button id="ed-room">+room</button>
        <button id="ed-corridor">+corridor</button>
        <button id="ed-dungeon">+dungeon</button><br/>
        <button id="ed-export">export JSON</button>
        <button id="ed-import">import</button>
        <button id="ed-sync">sync ↑</button>
        <button id="ed-reload">reload ↓</button>
        <button id="ed-clear">clear</button>
        <input id="ed-file" type="file" accept="application/json,.json" style="display:none"/>
        <div class="ed-hint">drag: paint · shift/right-drag: erase · E: toggle · auto-syncs to server (:9090)</div>
        <textarea id="ed-out" rows="2" cols="40" placeholder="exported JSON appears here"></textarea>
      </div>`;
    const q = <T extends HTMLElement>(s: string): T => {
      const e = root.querySelector<T>(s);
      if (!e) throw new Error('editor: missing ' + s);
      return e;
    };
    this.countEl = q('#ed-count');
    this.statusEl = q('#ed-status');
    this.outEl = q<HTMLTextAreaElement>('#ed-out');
    this.paintBtn = q<HTMLButtonElement>('#ed-paint');
    this.fileInput = q<HTMLInputElement>('#ed-file');
    this.paintBtn.onclick = () => this.togglePaint();
    q<HTMLButtonElement>('#ed-export').onclick = () => this.exportJSON();
    q<HTMLButtonElement>('#ed-import').onclick = () => this.fileInput?.click();
    q<HTMLButtonElement>('#ed-sync').onclick = () => void this.pushToServer();
    q<HTMLButtonElement>('#ed-reload').onclick = () => void this.pullFromServer();
    q<HTMLButtonElement>('#ed-clear').onclick = () => {
      this.walls.clear();
      this.sync();
      this.schedulePush();
    };
    q<HTMLButtonElement>('#ed-room').onclick = () => this.stampRoomAt(this.lastWorld.x, this.lastWorld.y);
    q<HTMLButtonElement>('#ed-corridor').onclick = () => this.stampCorridorAt(this.lastWorld.x, this.lastWorld.y);
    q<HTMLButtonElement>('#ed-dungeon').onclick = () => this.stampDungeonAt(this.lastWorld.x, this.lastWorld.y);
    this.fileInput.onchange = () => void this.importFile();
    // Fetch authoritative walls on join (server is source of truth).
    void this.pullFromServer();
  }

  togglePaint() {
    this.paintMode = !this.paintMode;
    if (this.paintBtn) this.paintBtn.textContent = 'paint: ' + (this.paintMode ? 'on' : 'off');
  }

  paintAtWorld(wx: number, wy: number, erase: boolean) {
    const tx = Math.floor(wx), ty = Math.floor(wy);
    this.lastWorld = { x: wx, y: wy };
    if (tx < 0 || ty < 0 || tx >= ARENA || ty >= ARENA) return;
    const k = tx + ',' + ty;
    if (erase) this.walls.delete(k);
    else this.walls.add(k);
    this.sync();
    this.schedulePush();
  }

  /** Hollow room stamp; dimensions sampled from engine worldgen for variety. */
  stampRoomAt(wx: number, wy: number, seed = (Math.random() * 0x7fffffff) | 0) {
    let w = 8, h = 6;
    try {
      const d = genDungeon(24, 18, seed >>> 0);
      const r = d.rooms[(seed >>> 0) % Math.max(1, d.rooms.length)];
      if (r) { w = Math.max(4, Math.min(20, r.w)); h = Math.max(4, Math.min(14, r.h)); }
    } catch { /* fall back to defaults */ }
    const x0 = Math.floor(wx) - Math.floor(w / 2), y0 = Math.floor(wy) - Math.floor(h / 2);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const tx = x0 + x, ty = y0 + y;
        if (tx < 0 || ty < 0 || tx >= ARENA || ty >= ARENA) continue;
        if (x === 0 || y === 0 || x === w - 1 || y === h - 1) this.walls.add(tx + ',' + ty);
        else this.walls.delete(tx + ',' + ty);
      }
    }
    // Door gap in the middle of the south wall.
    this.walls.delete(x0 + Math.floor(w / 2) + ',' + (y0 + h - 1));
    this.sync();
    this.schedulePush();
  }

  /** Straight hallway stamp: carved floor flanked by wall lines. */
  stampCorridorAt(wx: number, wy: number, len = 10, horizontal = true) {
    const cx = Math.floor(wx), cy = Math.floor(wy);
    for (let i = -Math.floor(len / 2); i <= Math.floor(len / 2); i++) {
      const ax = horizontal ? cx + i : cx, ay = horizontal ? cy : cy + i;
      const bx = horizontal ? cx + i : cx - 1, by = horizontal ? cy - 1 : cy + i;
      const ex = horizontal ? cx + i : cx + 1, ey = horizontal ? cy + 1 : cy + i;
      if (ax >= 0 && ay >= 0 && ax < ARENA && ay < ARENA) this.walls.delete(ax + ',' + ay);
      if (bx >= 0 && by >= 0 && bx < ARENA && by < ARENA) this.walls.add(bx + ',' + by);
      if (ex >= 0 && ey >= 0 && ex < ARENA && ey < ARENA) this.walls.add(ex + ',' + ey);
    }
    this.sync();
    this.schedulePush();
  }

  /** Paste an engine-generated dungeon chunk (walls + carved floors). */
  stampDungeonAt(wx: number, wy: number, seed = (Math.random() * 0x7fffffff) | 0) {
    let d;
    try {
      d = genDungeon(24, 18, seed >>> 0);
    } catch {
      this.setStatus('dungeon gen failed');
      return;
    }
    const ox = Math.floor(wx) - 12, oy = Math.floor(wy) - 9;
    for (let y = 0; y < d.height; y++) {
      for (let x = 0; x < d.width; x++) {
        const tx = ox + x, ty = oy + y;
        if (tx < 0 || ty < 0 || tx >= ARENA || ty >= ARENA) continue;
        if (d.tiles[y]![x] === 1) this.walls.add(tx + ',' + ty);
        else this.walls.delete(tx + ',' + ty);
      }
    }
    this.sync();
    this.schedulePush();
  }

  /** Canonical doc for export / POST (1x1 rects from the tile set). */
  toWallsDoc() {
    const walls = tileKeysToWalls(this.walls);
    return { format: WALLS_FORMAT, tile: 1 as const, version: WALLS_VERSION, count: walls.length, walls };
  }

  /** Replace the tile set from an untrusted doc (fetch/import path). */
  loadWallsDoc(doc: unknown): boolean {
    const v = validateWalls(doc);
    if (!v.ok) {
      this.setStatus('invalid walls: ' + v.error);
      return false;
    }
    this.walls.clear();
    for (const r of v.walls) {
      const x0 = Math.floor(r.x), y0 = Math.floor(r.y);
      const x1 = Math.ceil(r.x + r.w), y1 = Math.ceil(r.y + r.h);
      for (let ty = y0; ty < y1; ty++) {
        for (let tx = x0; tx < x1; tx++) {
          if (tx >= 0 && ty >= 0 && tx < ARENA && ty < ARENA) this.walls.add(tx + ',' + ty);
        }
      }
    }
    this.sync();
    return true;
  }

  private metricsBase(): string {
    const qs = new URLSearchParams(window.location.search);
    const override = qs.get('walls') ?? qs.get('wallsUrl');
    if (override) return override.replace(/\/walls\/?$/, '');
    const srv = qs.get('server');
    if (srv) {
      try {
        const u = new URL(srv);
        const proto = u.protocol === 'wss:' ? 'https:' : 'http:';
        return `${proto}//${u.hostname}:9090`;
      } catch { /* fall through */ }
    }
    try {
      if (window.location.hostname) return `${window.location.protocol}//${window.location.hostname}:9090`;
    } catch { /* fall through */ }
    return 'http://localhost:9090';
  }

  private adminToken(): string {
    const qs = new URLSearchParams(window.location.search);
    return qs.get('admintoken') ?? qs.get('token') ?? window.localStorage.getItem('af_admin_token') ?? 'dev';
  }

  async pullFromServer(): Promise<void> {
    this.setStatus('loading…');
    try {
      const res = await fetch(this.metricsBase() + '/walls');
      if (!res.ok) throw new Error('GET /walls ' + res.status);
      const ok = this.loadWallsDoc(await res.json());
      this.setStatus(ok ? `synced ↓ (${this.walls.size})` : 'invalid walls');
    } catch (err) {
      this.setStatus('offline (local only)');
    }
  }

  private schedulePush() {
    window.clearTimeout(this.pushTimer);
    this.pushTimer = window.setTimeout(() => void this.pushToServer(), 800);
  }

  async pushToServer(): Promise<void> {
    window.clearTimeout(this.pushTimer);
    if (!this.active) return;
    this.setStatus('syncing…');
    try {
      const res = await fetch(this.metricsBase() + '/walls', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: 'Bearer ' + this.adminToken() },
        body: JSON.stringify(this.toWallsDoc()),
      });
      if (res.status === 401) {
        this.setStatus('need admin token (?admintoken=…)');
        return;
      }
      if (!res.ok) throw new Error('POST /walls ' + res.status);
      const body = (await res.json()) as { count?: number };
      this.setStatus(`saved ↑ (${body.count ?? this.walls.size})`);
    } catch {
      this.setStatus('sync failed (local only)');
    }
  }

  private async importFile(): Promise<void> {
    const f = this.fileInput?.files?.[0];
    this.fileInput!.value = '';
    if (!f) return;
    try {
      const ok = this.loadWallsDoc(JSON.parse(await f.text()));
      if (ok) {
        this.setStatus(`imported ${f.name}`);
        void this.pushToServer();
      }
    } catch {
      this.setStatus('import failed (bad JSON)');
    }
  }

  private setStatus(s: string) {
    if (this.statusEl) this.statusEl.textContent = s;
  }

  private sync() {
    if (this.countEl) this.countEl.textContent = String(this.walls.size);
  }

  private exportJSON() {
    const doc = this.toWallsDoc();
    if (this.outEl) this.outEl.value = JSON.stringify(doc);
    const pretty = JSON.stringify(doc, null, 2);
    const blob = new Blob([pretty], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'walls.json';
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  }
}
