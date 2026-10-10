// @aetherfall/client — the four systems UI panels: party HUD, emote bubbles,
// vendor panel and talent tree. Purely additive: each panel owns its own root
// element and its own stylesheet, mounts into the existing `#hud` / `#labels`
// containers, and touches nothing the current HUD already draws.
//
// Every panel renders only when its store's `revision` changes, so a 10 Hz
// snapshot stream costs zero DOM work here.

import {
  EMOTE_GLYPHS,
  lootRuleLabel,
  priceArrow,
  type EmoteStore,
  type PartyViewStore,
  type ProgressionStore,
  type TalentNode,
  type VendorStore,
  esc,
} from './social.js';

export const PANEL_CSS = `
/* ---------- systems panels (additive, dark-fantasy glass) ---------- */
.af-panel{position:absolute;top:10px;right:10px;width:250px;z-index:7;background:rgba(13,19,38,.78);
  backdrop-filter:blur(8px);-webkit-backdrop-filter:blur(8px);
  border:1px solid rgba(232,198,106,.35);border-radius:8px;box-shadow:0 8px 24px rgba(0,0,0,.45);padding:8px 10px;font-size:12px;display:none}
.af-panel.open{display:block}
.af-panel h3{margin:0 0 6px;font-size:11px;letter-spacing:2px;text-transform:uppercase;font-variant:small-caps;color:#e8c66a;display:flex;justify-content:space-between;align-items:center}
.af-panel h3 .af-x{cursor:pointer;color:#8fa3bf;padding:0 4px}
.af-panel h3 .af-x:hover{color:#fff}
#af-talents{width:340px;top:auto}
/* party */
.af-member{display:grid;grid-template-columns:1fr auto;gap:4px;align-items:center;margin-top:5px}
.af-member .af-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.af-member.dead{opacity:.5}
.af-member.dead .af-name{text-decoration:line-through}
.af-member .af-meta{color:#8fa3bf;font-size:10px;text-align:right}
.af-hpbar{position:relative;height:6px;background:#20262f;border:1px solid #10141b;border-radius:3px;overflow:hidden;margin-top:3px}
.af-hpbar>i{display:block;height:100%}
.af-foot{margin-top:6px;color:#8fa3bf;font-size:10px;display:flex;justify-content:space-between}
.af-invite{margin-top:6px;padding:4px 6px;border:1px solid rgba(232,198,106,.5);border-radius:8px;color:#e8c66a;font-size:11px;background:rgba(232,198,106,.08)}
/* vendor */
.af-shop-row{display:grid;grid-template-columns:1fr auto auto;gap:6px;align-items:center;padding:3px 0;border-bottom:1px solid rgba(58,69,87,.5)}
.af-shop-row:last-child{border-bottom:none}
.af-shop-row.blocked{opacity:.45}
.af-shop-row .af-qty{color:#8fa3bf;font-size:10px;text-align:right}
.af-shop-row .af-price{color:#ffe066;font-size:11px;white-space:nowrap}
.af-shop-row .up{color:#7dff9b}
.af-shop-row .down{color:#ff8080}
/* talents */
.af-branch{margin-top:6px}
.af-branch>div:first-child{font-size:10px;letter-spacing:2px;color:#cfe3ff;margin-bottom:3px}
.af-node{display:grid;grid-template-columns:1fr auto;gap:6px;align-items:center;padding:3px 5px;margin-top:3px;
  background:rgba(13,19,38,.7);border:1px solid rgba(232,198,106,.25);border-radius:8px;cursor:pointer;min-height:40px}
.af-node:hover{border-color:#e8c66a}
.af-node.locked{opacity:.45;cursor:not-allowed}
.af-node.maxed{border-color:#e8c66a;box-shadow:0 0 8px rgba(232,198,106,.3)}
.af-node .af-rank{color:#ffe066;font-size:11px;white-space:nowrap}
.af-node .af-desc{color:#8fa3bf;font-size:10px}
/* emote bubbles (world-space overlay, not in the panel stack) */
.af-bubble{position:absolute;transform:translate(-50%,-100%);pointer-events:none;font-size:20px;line-height:1;
  text-shadow:0 1px 3px #000;animation:afBubbleIn .18s ease-out}
.af-bubble .af-tag{display:block;font-size:9px;color:#cfe3ff;text-align:center;margin-top:1px}
@keyframes afBubbleIn{from{transform:translate(-50%,-80%) scale(.7);opacity:0}}
html[data-a11y-motion="reduced"] .af-bubble{animation:none!important;transition:none!important}
`;

let cssInjected = false;

/** Inject the panel stylesheet once, into whichever document owns the root. */
function injectCss(parent: HTMLElement): void {
  if (cssInjected) return;
  cssInjected = true;
  try {
    const doc = parent.ownerDocument;
    if (!doc) return;
    const style = doc.createElement('style');
    style.textContent = PANEL_CSS;
    doc.head.appendChild(style);
  } catch {
    /* a detached document: styles are optional, the markup still renders */
  }
}

/**
 * Element factory. Resolves through the parent's own document (the same
 * indirection `hud.ts` uses for style injection) so panels construct in a real
 * browser and in the headless DOM stub alike, with no module-level `document`
 * reference that would throw under `node --test`.
 */
function makeEl(parent: HTMLElement, tag: string, className = ''): HTMLElement {
  const doc = parent.ownerDocument;
  if (!doc) throw new Error('panels: root has no ownerDocument');
  const el = doc.createElement(tag);
  if (className) el.className = className;
  return el;
}

/** Build one collapsible panel shell as real DOM nodes. */
function panelShell(parent: HTMLElement, id: string, title: string): HTMLElement {
  const root = makeEl(parent, 'div', 'af-panel');
  root.id = id;
  const head = makeEl(parent, 'h3');
  const label = makeEl(parent, 'span');
  label.textContent = title;
  const close = makeEl(parent, 'span', 'af-x');
  close.textContent = '✕';
  close.setAttribute('data-close', id);
  head.appendChild(label);
  head.appendChild(close);
  root.appendChild(head);
  return root;
}

/** A labelled value row, used for the panel footers. */
function footRow(parent: HTMLElement, id: string, right = ''): HTMLElement {
  const row = makeEl(parent, 'div', 'af-foot');
  const left = makeEl(parent, 'span');
  left.id = id;
  const r = makeEl(parent, 'span');
  r.textContent = right;
  row.appendChild(left);
  row.appendChild(r);
  return row;
}

// ---------------------------------------------------------------------------
// party HUD
// ---------------------------------------------------------------------------

/**
 * Party roster: one row per member with a live HP bar, plus the loot rule and
 * the pending-invite banner. Members arrive from the private `party` event.
 */
export class PartyPanel {
  readonly el: HTMLElement;
  private list: HTMLElement;
  private foot: HTMLElement;
  private inviteEl: HTMLElement;
  private lootEl: HTMLElement;
  private lastRevision = -1;

  constructor(parent: HTMLElement, private store: PartyViewStore, private selfId: () => number) {
    injectCss(parent);
    const root = panelShell(parent, 'af-party', 'PARTY');
    this.el = root;
    parent.appendChild(root);

    this.inviteEl = makeEl(parent, 'div', 'af-invite');
    this.inviteEl.id = 'af-party-invite';
    this.inviteEl.style.display = 'none';
    root.appendChild(this.inviteEl);

    this.list = makeEl(parent, 'div');
    this.list.id = 'af-party-list';
    root.appendChild(this.list);

    const foot = footRow(parent, 'af-party-loot', '');
    this.lootEl = foot.children[0] as HTMLElement;
    this.foot = foot.children[1] as HTMLElement;
    root.appendChild(foot);
  }

  /** Re-render if the store moved. Returns true when the DOM was touched. */
  render(): boolean {
    if (this.store.revision === this.lastRevision) return false;
    this.lastRevision = this.store.revision;
    const v = this.store.state;

    if (this.store.invite) {
      this.inviteEl.style.display = 'block';
      this.inviteEl.textContent = `✉ ${this.store.invite.fromName} invited you — /accept`;
    } else {
      this.inviteEl.style.display = 'none';
      this.inviteEl.textContent = '';
    }

    if (!v.inParty) {
      this.el.classList.remove('open');
      this.list.innerHTML = '';
      this.lootEl.textContent = '';
      this.foot.textContent = '';
      return true;
    }
    this.el.classList.add('open');
    const self = this.selfId();
    // Roster HTML is assembled as a string then handed to innerHTML once: the
    // values are escaped, and one write beats N node appends per sync.
    this.list.innerHTML = this.store
      .ordered(self)
      .map((m) => {
        const frac = m.maxHp > 0 ? Math.max(0, Math.min(1, m.hp / m.maxHp)) : 0;
        const colour = frac > 0.5 ? '#59d98c' : frac > 0.2 ? '#ffe066' : '#ff5252';
        const me = m.playerId === self ? ' <span class="af-meta">(you)</span>' : '';
        const lead = m.leader ? '★ ' : '';
        const ready = m.ready ? '✓' : '';
        const cls = m.dead ? 'af-member dead' : 'af-member';
        return (
          `<div class="${cls}">` +
          `<div class="af-name">${lead}${esc(m.name)}${me}</div>` +
          `<div class="af-meta">Lv${m.level} ${ready}${m.online ? '' : ' ⚠'}</div>` +
          `</div><div class="af-hpbar"><i style="width:${(frac * 100).toFixed(1)}%;background:${colour}"></i></div>`
        );
      })
      .join('');
    this.lootEl.textContent = `loot ${lootRuleLabel(v.lootRule)}`;
    this.foot.textContent = `${v.memberCount}/${v.maxMembers} · /party`;
    return true;
  }
}

// ---------------------------------------------------------------------------
// emote bubbles
// ---------------------------------------------------------------------------

/**
 * Emote bubbles above players. Positioning is the caller's job — it supplies a
 * `project(worldX, worldY) -> screen` function, so the same layer works for the
 * three.js projector and for a plain canvas camera. Bubbles self-expire on the
 * server's `expiresAt`, so a dropped frame cannot strand one on screen.
 */
export class EmoteBubbleLayer {
  private nodes = new Map<number, HTMLElement>();
  private lastRevision = -1;

  constructor(private parent: HTMLElement, private store: EmoteStore) {
    injectCss(parent);
  }

  get size(): number {
    return this.nodes.size;
  }

  node(playerId: number): HTMLElement | undefined {
    return this.nodes.get(playerId);
  }

  /**
   * Sync the DOM to the store, then place every live bubble.
   * `project` returns screen pixels; `now` drives expiry.
   */
  render(now: number, project: (x: number, y: number) => { sx: number; sy: number }): boolean {
    const changed = this.store.revision !== this.lastRevision;
    this.lastRevision = this.store.revision;
    const live = this.store.list(now);

    const seen = new Set<number>();
    for (const b of live) {
      seen.add(b.fromId);
      let el = this.nodes.get(b.fromId);
      if (!el) {
        el = makeEl(this.parent, 'div', 'af-bubble');
        this.parent.appendChild(el);
        this.nodes.set(b.fromId, el);
      }
      const glyph = EMOTE_GLYPHS[b.emote] ?? EMOTE_GLYPHS[b.label.toLowerCase()] ?? '💬';
      const tag = b.label;
      const want = `${glyph}<span class="af-tag">${esc(tag)}</span>`;
      if (el.innerHTML !== want) el.innerHTML = want;
      const p = project(b.x, b.y);
      el.style.left = `${Math.round(p.sx)}px`;
      el.style.top = `${Math.round(p.sy)}px`;
    }
    for (const [id, el] of [...this.nodes]) {
      if (seen.has(id)) continue;
      el.remove();
      this.nodes.delete(id);
    }
    return changed;
  }

  clear(): void {
    for (const el of this.nodes.values()) el.remove();
    this.nodes.clear();
    this.lastRevision = -1;
  }
}

// ---------------------------------------------------------------------------
// vendor panel
// ---------------------------------------------------------------------------

/**
 * Buy/sell list with live prices. Rows carry the current buy price, sell price,
 * supply/demand arrow and how many the player holds; a rejected row is dimmed
 * until the next successful trade clears it.
 */
export class VendorPanel {
  readonly el: HTMLElement;
  private list: HTMLElement;
  private head: HTMLElement;
  private lastRevision = -1;

  constructor(parent: HTMLElement, private store: VendorStore) {
    injectCss(parent);
    const root = panelShell(parent, 'af-vendor', 'VENDOR');
    this.el = root;
    parent.appendChild(root);
    const foot = footRow(parent, 'af-vendor-gold', '/buy · /sell');
    this.head = foot.children[0] as HTMLElement;
    root.appendChild(foot);
    this.list = makeEl(parent, 'div');
    this.list.id = 'af-vendor-list';
    root.appendChild(this.list);
  }

  render(): boolean {
    if (this.store.revision === this.lastRevision) return false;
    this.lastRevision = this.store.revision;
    const rows = this.store.stock;
    if (rows.length === 0) {
      this.el.classList.remove('open');
      this.list.innerHTML = '';
      this.head.textContent = '';
      return true;
    }
    this.el.classList.add('open');
    this.head.textContent = `${this.store.gold}g`;
    this.list.innerHTML = rows
      .map((r) => {
        const cls = r.blocked ? 'af-shop-row blocked' : 'af-shop-row';
        const arrowCls = r.index > 0.05 ? 'up' : r.index < -0.05 ? 'down' : '';
        const sell = r.sell > 0 ? `${r.sell}g` : 'n/a';
        const title = r.blocked ? `${r.itemId} — ${r.blocked}` : `${r.itemId} — base ${r.basePrice}g`;
        return (
          `<div class="${cls}" title="${esc(title)}">` +
          `<span>${esc(r.name)} <span class="af-qty">x${r.held}</span></span>` +
          `<span class="af-price ${arrowCls}">${r.buy}g ${priceArrow(r.index)}</span>` +
          `<span class="af-price">sell ${sell}</span>` +
          '</div>'
        );
      })
      .join('');
    return true;
  }
}

// ---------------------------------------------------------------------------
// talent tree panel
// ---------------------------------------------------------------------------

/** Branch -> display colour for the tree column headers. */
const BRANCH_COLOUR: Record<string, string> = {
  might: '#ff9a4d',
  guile: '#4dc3ff',
  will: '#c58bff',
};

/**
 * The 3-branch talent tree. Clicking a node calls `onSpend(nodeId)` — the
 * caller sends `/talent <nodeId>`; the server is the only authority, so the
 * panel never mutates ranks locally. Locked and maxed nodes render as
 * non-actionable so the click target matches the server's own rules.
 */
export class TalentPanel {
  readonly el: HTMLElement;
  private body: HTMLElement;
  private head: HTMLElement;
  private lastRevision = -1;

  constructor(
    parent: HTMLElement,
    private store: ProgressionStore,
    private onSpend: (nodeId: string) => void,
  ) {
    injectCss(parent);
    const root = panelShell(parent, 'af-talents', 'TALENTS');
    this.el = root;
    parent.appendChild(root);
    const foot = footRow(parent, 'af-talent-head', '/talent <nodeId>');
    this.head = foot.children[0] as HTMLElement;
    root.appendChild(foot);
    this.body = makeEl(parent, 'div');
    this.body.id = 'af-talent-body';
    root.appendChild(this.body);
    this.el.addEventListener('click', (e) => {
      const hit = e.target as HTMLElement | null;
      const target = hit?.closest?.('[data-node]') as HTMLElement | null;
      const id = target?.getAttribute('data-node');
      if (!id || !target) return;
      // Mirrors the server's rules so a click on a locked node is a no-op rather
      // than a round trip that comes back "no points".
      if (target.classList.contains('locked') || target.classList.contains('maxed')) return;
      this.onSpend(id);
    });
  }

  render(): boolean {
    if (this.store.revision === this.lastRevision) return false;
    this.lastRevision = this.store.revision;
    const tree = this.store.talentTree;
    if (tree.length === 0) {
      this.el.classList.remove('open');
      this.body.innerHTML = '';
      this.head.textContent = '';
      return true;
    }
    this.el.classList.add('open');
    const p = this.store.state;
    this.head.textContent = `${p.talentPoints} pt · melee ${p.meleeDamage} · Lv${p.level}`;
    const branches = this.store.branchOrder.length > 0 ? this.store.branchOrder : [...new Set(tree.map((n) => n.branch))];
    this.body.innerHTML = branches
      .map((branch) => {
        const nodes = this.store.branch(branch);
        if (nodes.length === 0) return '';
        const colour = BRANCH_COLOUR[branch] ?? '#cfe3ff';
        const spent = nodes.reduce((n, node) => n + this.store.rank(node.id), 0);
        return (
          `<div class="af-branch">` +
          `<div style="color:${colour}">${esc(branch.toUpperCase())} · ${spent} ranks</div>` +
          nodes.map((n) => this.nodeHtml(n)).join('') +
          '</div>'
        );
      })
      .join('');
    return true;
  }

  private nodeHtml(node: TalentNode): string {
    const rank = this.store.rank(node.id);
    const maxed = rank >= node.maxRank;
    const lock = this.store.lockedBy(node.id);
    const affordable = this.store.state.talentPoints >= node.costPerRank;
    const cls = maxed ? 'af-node maxed' : lock || !affordable ? 'af-node locked' : 'af-node';
    const status = maxed
      ? 'MAX'
      : lock
        ? `needs ${esc(lock.nodeId)} ${lock.rank}`
        : affordable
          ? 'click to learn'
          : 'no points';
    return (
      `<div class="${cls}" data-node="${esc(node.id)}" title="${esc(node.description)}">` +
      `<span>${esc(node.name)}<br/><span class="af-desc">T${node.tier} · ${esc(node.description)}</span></span>` +
      `<span class="af-rank">${rank}/${node.maxRank}<br/><span class="af-desc">${status}</span></span>` +
      '</div>'
    );
  }
}
