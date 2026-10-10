// Minimal DOM + Canvas2D recorder stubs.
//
// Enough surface for HUD and CanvasRenderer to run headless: a recording 2D
// context, a canvas, and an element stub whose querySelector always resolves
// (HUD builds its subtree via innerHTML, which we do not parse).

export interface DrawCall { op: string; args: unknown[] }

export class Ctx2D {
  calls: DrawCall[] = [];
  fillStyle: unknown = '';
  strokeStyle: unknown = '';
  lineWidth = 1;
  font = '';
  textAlign = '';
  globalAlpha = 1;
  private rec(op: string, ...args: unknown[]) { this.calls.push({ op, args }); }
  /**
   * `fillRect` records the active `fillStyle` as a trailing argument so tests
   * can assert on colour without replaying the whole call sequence (terrain
   * hazard tiles are identified by their fill).
   */
  fillRect(...a: unknown[]) { this.rec('fillRect', ...a, this.fillStyle); }
  strokeRect(...a: unknown[]) { this.rec('strokeRect', ...a, this.strokeStyle); }
  clearRect(...a: unknown[]) { this.rec('clearRect', ...a); }
  beginPath() { this.rec('beginPath'); }
  closePath() { this.rec('closePath'); }
  arc(...a: unknown[]) { this.rec('arc', ...a); }
  ellipse(...a: unknown[]) { this.rec('ellipse', ...a); }
  fill() { this.rec('fill'); }
  stroke() { this.rec('stroke'); }
  fillText(...a: unknown[]) { this.rec('fillText', ...a); }
  strokeText(...a: unknown[]) { this.rec('strokeText', ...a); }
  save() { this.rec('save'); }
  restore() { this.rec('restore'); }
  translate(...a: unknown[]) { this.rec('translate', ...a); }
  rotate(...a: unknown[]) { this.rec('rotate', ...a); }
  moveTo(...a: unknown[]) { this.rec('moveTo', ...a); }
  lineTo(...a: unknown[]) { this.rec('lineTo', ...a); }
  beginPath2() { /* unused */ }
  /**
   * `roundRect` records the active `globalAlpha` and `fillStyle` as trailing
   * arguments, mirroring `fillRect`, so tests can identify a tinted body pass
   * (the combat hit flash) without replaying the whole call sequence.
   */
  roundRect(...a: unknown[]) { this.rec('roundRect', ...a, this.globalAlpha, this.fillStyle); }
  measureText(t: string) { return { width: t.length * 6 }; }
  count(op: string): number { return this.calls.filter((c) => c.op === op).length; }
}

export class ElStub {
  style: Record<string, string> = { display: '' };
  children: ElStub[] = [];
  textContent = '';
  innerHTML = '';
  title = '';
  width = 960;
  height = 600;
  clientWidth = 960;
  clientHeight = 600;
  parentElement: ElStub | null = null;
  ownerDocument: ElStub | null = null;
  /** Lazily created to avoid recursive construction in field initializers. */
  headEl: ElStub | null = null;
  readonly ctx2d = new Ctx2D();
  /** Class names, so classList-driven visibility can be asserted headless. */
  classes = new Set<string>();
  /** Element attributes, so `data-*` hooks are readable in tests. */
  attrs: Record<string, string> = {};
  createElement(_tag: string): ElStub { return new ElStub(); }
  onclick: (() => void) | null = null;
  value = '';
  checked = false;
  constructor() { this.ownerDocument = this; }
  get head(): ElStub {
    if (!this.headEl) this.headEl = new ElStub();
    return this.headEl;
  }

  getContext(kind: string): Ctx2D | null {
    return kind === '2d' ? this.ctx2d : null;
  }
  getBoundingClientRect() {
    return { left: 0, top: 0, width: this.clientWidth, height: this.clientHeight } as DOMRect;
  }
  get firstChild(): ElStub | null { return this.children[0] ?? null; }
  get lastChild(): ElStub | null { return this.children[this.children.length - 1] ?? null; }
  appendChild(c: ElStub) { this.children.push(c); return c; }
  prepend(c: ElStub) { this.children.unshift(c); return c; }
  setAttribute(k: string, v: string) { this.attrs[k] = v; }
  getAttribute(k: string): string | null { return this.attrs[k] ?? null; }
  hasAttribute(k: string): boolean { return k in this.attrs; }
  removeChild(c: ElStub) {
    const i = this.children.indexOf(c);
    if (i >= 0) this.children.splice(i, 1);
    return c;
  }
  remove() {
    if (this.parentElement) this.parentElement.removeChild(this);
  }
  querySelector<T = ElStub>(_sel: string): T { return new ElStub() as unknown as T; }
  querySelectorAll(): ElStub[] { return []; }
  addEventListener(): void { /* noop */ }
  focus(): void { /* noop */ }
  setPointerCapture(): void { /* noop */ }
  /** Real set semantics: the systems panels toggle `open` to show/hide. */
  classList = {
    add: (c: string): void => { this.classes.add(c); },
    remove: (c: string): void => { this.classes.delete(c); },
    toggle: (c: string, force?: boolean): void => {
      const on = force === undefined ? !this.classes.has(c) : force;
      if (on) this.classes.add(c);
      else this.classes.delete(c);
    },
    contains: (c: string): boolean => this.classes.has(c),
  };
  /** Class attribute, kept in sync with `classList` for template-built markup. */
  get className(): string {
    return [...this.classes].join(' ');
  }
  set className(v: string) {
    this.classes = new Set(v.split(/\s+/).filter((s) => s.length > 0));
  }
}