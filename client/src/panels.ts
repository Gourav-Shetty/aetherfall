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
import { MASK_GLYPHS } from './masks.js';
import {
  DeathExplain,
  LevelUpBanner,
  ObjectiveTracker,
  TutorialTracker,
  esc as escText,
} from './onboarding.js';

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
/* vocation + mask pickers (choice UI inside the talent panel) */
.af-pickhead{font-size:10px;letter-spacing:2px;color:#e8c66a;margin:6px 0 3px}
.af-pick{display:grid;grid-template-columns:1fr auto;gap:6px;align-items:center;padding:3px 5px;margin-top:3px;
  background:rgba(13,19,38,.7);border:1px solid rgba(77,195,255,.25);border-radius:8px;cursor:pointer;min-height:32px}
.af-pick:hover{border-color:#4dc3ff}
.af-pick.sel{border-color:#e8c66a;box-shadow:0 0 8px rgba(232,198,106,.3)}
.af-pick.noclick{cursor:default}
.af-pick .af-desc{color:#8fa3bf;font-size:10px}
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
        // Mask rows wear their glyph (see client/src/masks.ts).
        const glyph = r.kind === 'mask' ? `${MASK_GLYPHS[r.itemId] ?? '◇'} ` : '';
        return (
          `<div class="${cls}" title="${esc(title)}">` +
          `<span>${glyph}${esc(r.name)} <span class="af-qty">x${r.held}</span></span>` +
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
 * The 3-branch talent tree, plus the calling + mask pickers. Clicking a node
 * calls `onSpend(nodeId)` — the caller sends `/talent <nodeId>`; the server
 * is the only authority, so the panel never mutates ranks locally. Locked and
 * maxed nodes render as non-actionable so the click target matches the
 * server's own rules. Picker clicks call `onAction` (`/vocation <id>` or
 * `/mask equip <id>`); without it the pickers render as read-only.
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
    private onAction?: (command: string) => void,
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
      const pick = hit?.closest?.('[data-voc],[data-mask]') as HTMLElement | null;
      if (pick) {
        if (!this.onAction) return;
        const voc = pick.getAttribute('data-voc');
        const mask = pick.getAttribute('data-mask');
        if (voc) this.onAction(`/vocation ${voc}`);
        else if (mask) this.onAction(`/mask equip ${mask}`);
        return;
      }
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
    this.body.innerHTML =
      this.pickerHtml() +
      branches
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

  /**
   * Calling + mask pickers. Empty on older shards (no catalogs) so the tree
   * renders exactly as before. Uses `af-pick`/`data-voc`/`data-mask` — never
   * the `af-node`/`data-node` selectors the tree tests pin.
   */
  private pickerHtml(): string {
    let html = '';
    if (this.store.vocations.length > 0) {
      const cur = this.store.state.vocation;
      html +=
        `<div class="af-pickhead">CALLING · ${esc(cur ?? 'unsworn')} — /vocation &lt;id&gt;</div>` +
        this.store.vocations
          .map((v) => {
            const sel = v.id === cur ? ' sel' : '';
            const click = this.onAction ? '' : ' noclick';
            return (
              `<div class="af-pick${sel}${click}" data-voc="${esc(v.id)}" title="${esc(v.description)}">` +
              `<span>${esc(v.name)}<br/><span class="af-desc">${esc(v.role)} · favors ${esc(v.favoredBranch)} · ${esc(v.signature.name)}</span></span>` +
              `<span class="af-rank">${v.id === cur ? 'YOU' : 'take up'}</span>` +
              '</div>'
            );
          })
          .join('');
    }
    if (this.store.masks.length > 0) {
      const cur = this.store.state.maskId;
      html +=
        `<div class="af-pickhead">MASK · ${esc(cur ?? 'bare')} — /mask equip &lt;id&gt;</div>` +
        this.store.masks
          .map((m) => {
            const sel = m.id === cur ? ' sel' : '';
            const click = this.onAction ? '' : ' noclick';
            return (
              `<div class="af-pick${sel}${click}" data-mask="${esc(m.id)}" title="${esc(m.description)}">` +
              `<span>${esc(m.glyph)} ${esc(m.name)}<br/><span class="af-desc">${esc(m.perk)} · ${m.price}g</span></span>` +
              `<span class="af-rank">${m.id === cur ? 'WORN' : 'wear'}</span>` +
              '</div>'
            );
          })
          .join('');
    }
    return html;
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

// ---------------------------------------------------------------------------
// Chapter "STATIC" panels (ADDITIVE): phone booth, quest log, VHS intro cards.
// ---------------------------------------------------------------------------
// Same conventions as the panels above: own roots + own stylesheet, revision
// gated renders, `ownerDocument` element factory (headless-safe), escaped
// server text. Nothing above is modified.

import type { StaticChapterTracker } from './quests.js';

export const STATIC_PANEL_CSS = `
/* ---------- STATIC chapter panels (phone booth / quest log / VHS cards) --- */
.af-booth{position:absolute;left:10px;bottom:10px;width:300px;z-index:8;background:rgba(8,12,24,.88);
  border:1px solid rgba(77,195,255,.45);border-radius:8px;box-shadow:0 8px 24px rgba(0,0,0,.5);padding:8px 10px;font-size:12px;display:none}
.af-booth.open{display:block}
.af-booth h3{margin:0 0 6px;font-size:11px;letter-spacing:2px;color:#4dc3ff}
.af-booth .af-caller{color:#ffe066;font-size:11px;letter-spacing:1px}
.af-booth .af-subject{color:#8fa3bf;font-size:10px;margin:2px 0 6px}
.af-booth .af-lines{color:#d8e6ff;font-size:12px;line-height:1.5;white-space:pre-wrap}
.af-booth .af-act{margin-top:6px;color:#59d98c;font-size:11px}
.af-questlog{position:absolute;left:10px;top:10px;width:300px;z-index:7;background:rgba(13,19,38,.8);
  border:1px solid rgba(232,198,106,.35);border-radius:8px;padding:8px 10px;font-size:12px;display:none}
.af-questlog.open{display:block}
.af-questlog h3{margin:0 0 6px;font-size:11px;letter-spacing:2px;color:#e8c66a}
.af-qrow{padding:3px 0;border-bottom:1px solid rgba(58,69,87,.5)}
.af-qrow:last-child{border-bottom:none}
.af-qrow.done{opacity:.65}.af-qrow.done .af-qlabel{text-decoration:line-through}
.af-qrow .af-qlabel{color:#e8efff}
.af-qrow .af-qdetail{color:#8fa3bf;font-size:10px}
.af-archive{margin-top:6px;color:#8fa3bf;font-size:10px}
.af-vhs{position:absolute;inset:0;z-index:30;display:none;align-items:center;justify-content:center;
  background:rgba(2,4,10,.72);pointer-events:auto}
.af-vhs.open{display:flex}
.af-vhs .af-vhs-card{font-family:monospace;font-size:22px;letter-spacing:4px;color:#e8efff;
  text-shadow:0 0 8px #4dc3ff,2px 0 0 rgba(255,0,80,.5),-2px 0 0 rgba(0,255,200,.5);
  border-top:2px solid rgba(232,239,255,.4);border-bottom:2px solid rgba(232,239,255,.4);padding:12px 24px}
.af-vhs .af-vhs-hint{position:absolute;bottom:18px;font-size:11px;color:#8fa3bf;font-family:monospace}
.af-vhs .af-vhs-skip{position:absolute;top:14px;right:14px;font-size:11px;color:#e8c66a;cursor:pointer;font-family:monospace}
@media (prefers-reduced-motion:reduce){.af-vhs .af-vhs-card{text-shadow:none}}
html[data-a11y-motion="reduced"] .af-vhs .af-vhs-card{text-shadow:none!important}
`;

let staticCssInjected = false;

function injectStaticCss(parent: HTMLElement): void {
  if (staticCssInjected) return;
  staticCssInjected = true;
  try {
    const doc = parent.ownerDocument;
    if (!doc) return;
    const style = doc.createElement('style');
    style.textContent = STATIC_PANEL_CSS;
    doc.head.appendChild(style);
  } catch {
    /* detached document: markup still renders */
  }
}

function makeStaticEl(parent: HTMLElement, tag: string, className = ''): HTMLElement {
  const doc = parent.ownerDocument;
  if (!doc) throw new Error('static panels: root has no ownerDocument');
  const el = doc.createElement(tag);
  if (className) el.className = className;
  return el;
}

/**
 * Phone-booth UI: voicemail-style messages from UNKNOWN NUMBER (pre-twist)
 * or Wren Halloway (mission 5). Shows the ACTIVE mission's call only, with
 * its landmark act + return hint. Skippable/dismissable; never blocks input.
 */
export class PhoneBoothPanel {
  readonly el: HTMLElement;
  private body: HTMLElement;
  private lastRevision = -1;
  private dismissed = false;

  constructor(parent: HTMLElement, private tracker: StaticChapterTracker) {
    injectStaticCss(parent);
    const root = makeStaticEl(parent, 'div', 'af-booth');
    root.id = 'af-booth';
    const head = makeStaticEl(parent, 'h3');
    head.textContent = '☎ CALL-BOOTH';
    root.appendChild(head);
    this.body = makeStaticEl(parent, 'div');
    this.body.id = 'af-booth-body';
    root.appendChild(this.body);
    parent.appendChild(root);
    this.el = root;
  }

  /** Dismiss the booth for this session (player hung up). */
  hangUp(): void {
    this.dismissed = true;
    this.el.classList.remove('open');
  }

  /** Re-open after a hang-up (a new message clicks in). */
  pickUp(): void {
    this.dismissed = false;
    this.lastRevision = -1;
  }

  get isDismissed(): boolean {
    return this.dismissed;
  }

  render(): boolean {
    if (this.tracker.revision === this.lastRevision && !this.dismissed) return false;
    this.lastRevision = this.tracker.revision;
    const active = this.tracker.active();
    if (this.dismissed || !active) {
      this.el.classList.remove('open');
      this.body.innerHTML = '';
      return true;
    }
    this.el.classList.add('open');
    const isTwist = active.id === 'static-exchange';
    const caller = isTwist ? 'Wren Halloway' : 'UNKNOWN NUMBER';
    const subject = isTwist ? 'MSG 05 — EXCHANGE SILENCE' : `MSG 0${active.seq} — ${active.name.toUpperCase()}`;
    this.body.innerHTML =
      `<div class="af-caller">${esc(caller)}</div>` +
      `<div class="af-subject">${esc(subject)} · ${esc(active.landmark)}</div>` +
      `<div class="af-lines">${esc(active.briefing)}</div>` +
      `<div class="af-act">${esc(active.returnHint)}</div>`;
    return true;
  }
}

/**
 * Quest-log panel: active chapter, mission checklist with live counts (fed by
 * the same `quest-progress` / `quest-complete` events as the Maren chain),
 * plus a completed archive. Revision-gated like every other panel.
 */
export class QuestLogPanel {
  readonly el: HTMLElement;
  private list: HTMLElement;
  private archiveEl: HTMLElement;
  private head: HTMLElement;
  private lastRevision = -1;

  constructor(parent: HTMLElement, private tracker: StaticChapterTracker) {
    injectStaticCss(parent);
    const root = makeStaticEl(parent, 'div', 'af-questlog');
    root.id = 'af-questlog';
    const head = makeStaticEl(parent, 'h3');
    head.textContent = 'STATIC — QUEST LOG';
    root.appendChild(head);
    this.head = makeStaticEl(parent, 'div', 'af-archive');
    this.head.id = 'af-questlog-head';
    root.appendChild(this.head);
    this.list = makeStaticEl(parent, 'div');
    this.list.id = 'af-questlog-list';
    root.appendChild(this.list);
    this.archiveEl = makeStaticEl(parent, 'div', 'af-archive');
    this.archiveEl.id = 'af-questlog-archive';
    root.appendChild(this.archiveEl);
    parent.appendChild(root);
    this.el = root;
  }

  render(): boolean {
    if (this.tracker.revision === this.lastRevision) return false;
    this.lastRevision = this.tracker.revision;
    this.el.classList.add('open');
    const rows = this.tracker.toChecklist();
    const pct = Math.round(this.tracker.chapterProgress() * 100);
    this.head.textContent = `Chapter STATIC · ${pct}%`;
    this.list.innerHTML = rows
      .map((r) => {
        const cls = r.done ? 'af-qrow done' : 'af-qrow';
        return (
          `<div class="${cls}" data-mission="${esc(r.id)}">` +
          `<div class="af-qlabel">${esc(r.label)}</div>` +
          `<div class="af-qdetail">${esc(r.detail)}</div>` +
          '</div>'
        );
      })
      .join('');
    const done = this.tracker.archive();
    this.archiveEl.textContent =
      done.length === 0 ? 'Archive: —' : `Archive: ${done.map((m) => m.name).join(', ')}`;
    return true;
  }
}

/**
 * VHS-style chapter intro cards (overlay text, skippable, reduced-motion
 * safe). `reducedMotion` (or the `data-a11y-motion="reduced"` / media query
 * CSS above) strips the chromatic-aberration shadow; `skip()` dismisses all
 * cards at once for players and tests alike.
 */
export class IntroCardOverlay {
  readonly el: HTMLElement;
  private card: HTMLElement;
  private lastKey = '';
  dismissed = false;

  constructor(parent: HTMLElement, private tracker: StaticChapterTracker, private reducedMotion = false) {
    injectStaticCss(parent);
    const root = makeStaticEl(parent, 'div', 'af-vhs');
    root.id = 'af-vhs';
    if (reducedMotion) root.setAttribute('data-motion', 'reduced');
    const skip = makeStaticEl(parent, 'div', 'af-vhs-skip');
    skip.textContent = '[ SKIP ]';
    skip.setAttribute('data-skip', 'vhs');
    root.appendChild(skip);
    this.card = makeStaticEl(parent, 'div', 'af-vhs-card');
    this.card.id = 'af-vhs-card';
    root.appendChild(this.card);
    const hint = makeStaticEl(parent, 'div', 'af-vhs-hint');
    hint.textContent = 'ENTER ▸ next · ESC ▸ skip · tracking auto';
    root.appendChild(hint);
    parent.appendChild(root);
    this.el = root;
  }

  setReducedMotion(v: boolean): void {
    this.reducedMotion = v;
    if (v) this.el.setAttribute('data-motion', 'reduced');
  }

  get isReducedMotion(): boolean {
    return this.reducedMotion;
  }

  /** Advance one card (ENTER). Dismisses the overlay past the last card. */
  next(): void {
    this.tracker.advanceIntro();
    if (this.tracker.currentIntroCard() === null) this.dismissed = true;
    this.lastKey = '';
  }

  /** Dismiss every remaining card (ESC / SKIP). */
  skip(): void {
    this.tracker.skipIntro();
    this.dismissed = true;
    this.lastKey = '';
  }

  render(): boolean {
    const text = this.dismissed ? null : this.tracker.currentIntroCard();
    const key = `${this.dismissed}:${text ?? '-'}`;
    if (key === this.lastKey) return false;
    this.lastKey = key;
    if (text === null) {
      this.el.classList.remove('open');
      this.card.innerHTML = '';
      return true;
    }
    this.el.classList.add('open');
    this.card.textContent = text;
    return true;
  }
}

// ---------------------------------------------------------------------------
// Onboarding panels (ADDITIVE): objective tracker, level-up banner, death card
// ---------------------------------------------------------------------------
// Same conventions as every panel above: own root, own stylesheet, revision-
// gated render, `ownerDocument` element factory (headless-safe), escaped
// server text. Nothing above is modified.
//
// Layout is deliberately NOT a redesign: the tracker docks to the bottom-left
// strip next to the existing quest card, the banner is centred over the vitals
// for a couple of seconds, and the death card sits in the same corner as the
// existing death overlay. All three degrade to plain text, so the animation is
// the only thing reduced-motion removes.

export const ONBOARDING_PANEL_CSS = `
/* ---------- onboarding: objective tracker / level-up / death ---------- */
.af-objectives{position:absolute;left:10px;bottom:120px;width:290px;max-width:38vw;z-index:7;
  background:rgba(13,19,38,.8);backdrop-filter:blur(8px);-webkit-backdrop-filter:blur(8px);
  border:1px solid rgba(232,198,106,.4);border-left:3px solid #e8c66a;border-radius:8px;
  box-shadow:0 8px 24px rgba(0,0,0,.45);padding:7px 10px;font-size:12px;display:none}
.af-objectives.open{display:block}
.af-obj-track{font-size:10px;letter-spacing:2px;color:#8fa3bf;text-transform:uppercase}
.af-obj-head{display:flex;justify-content:space-between;align-items:baseline;gap:8px;margin-top:2px}
.af-obj-name{color:#e8efff;font-weight:700;font-size:13px;line-height:1.25}
.af-obj-count{color:#ffe066;font-size:12px;white-space:nowrap;font-variant-numeric:tabular-nums}
.af-obj-hint{color:#cfe3ff;font-size:11px;line-height:1.35;margin-top:3px}
.af-obj-bar{margin-top:5px;height:4px;background:#20262f;border:1px solid #10141b;border-radius:2px;overflow:hidden}
.af-obj-bar>i{display:block;height:100%;background:linear-gradient(90deg,#e8c66a,#ffe066);transition:width .25s}
.af-obj-next{margin-top:5px;font-size:10px;color:#8fa3bf}
.af-obj-next b{color:#59d98c;font-weight:600}
.af-obj-steps{margin-top:5px;border-top:1px solid rgba(58,69,87,.6);padding-top:4px}
.af-obj-step{display:grid;grid-template-columns:14px 1fr;gap:5px;font-size:11px;color:#8fa3bf;padding:1px 0}
.af-obj-step.done{opacity:.55;text-decoration:line-through}
.af-obj-step.active{color:#e8efff}
.af-obj-step .af-obj-dot{color:#e8c66a}
/* level-up banner */
.af-levelup{position:absolute;left:50%;top:96px;transform:translateX(-50%);z-index:12;pointer-events:none;
  background:linear-gradient(180deg,rgba(28,22,6,.94),rgba(13,19,38,.94));
  border:1px solid #e8c66a;border-radius:10px;padding:10px 22px;text-align:center;display:none;
  box-shadow:0 0 24px rgba(232,198,106,.35),0 10px 30px rgba(0,0,0,.5)}
.af-levelup.open{display:block}
.af-levelup.enter{animation:afLevelIn .28s cubic-bezier(.2,.9,.3,1)}
.af-levelup .af-lu-title{font-size:24px;font-weight:800;letter-spacing:3px;color:#ffe066;text-shadow:0 2px 0 rgba(0,0,0,.6)}
.af-levelup .af-lu-detail{margin-top:3px;font-size:12px;color:#cfe3ff}
.af-levelup .af-lu-rule{height:1px;background:linear-gradient(90deg,transparent,#e8c66a,transparent);margin:6px 0}
/* death card — informational only: it never steals a click from the death
   overlay's Respawn button, and it sits clear of the overlay's centre. */
.af-deathcard{position:absolute;left:50%;top:150px;transform:translateX(-50%);z-index:11;width:min(400px,80vw);
  pointer-events:none;background:rgba(8,10,20,.92);border:1px solid rgba(255,82,82,.55);border-radius:10px;
  padding:12px 16px;box-shadow:0 12px 40px rgba(0,0,0,.6);display:none}
.af-deathcard.open{display:block}
.af-deathcard h3{margin:0 0 6px;font-size:14px;letter-spacing:3px;color:#ff8080}
.af-deathcard .af-dc-body{font-size:12px;line-height:1.5;color:#e8efff}
.af-deathcard .af-dc-where{margin-top:6px;font-size:12px;color:#59d98c}
.af-deathcard .af-dc-penalty{margin-top:4px;font-size:11px;color:#8fa3bf}
/* reduced motion: state stays, movement goes */
@keyframes afLevelIn{from{opacity:0;transform:translate(-50%,-14px)}}
html[data-a11y-motion="reduced"] .af-levelup.enter{animation:none!important}
html[data-a11y-motion="reduced"] .af-obj-bar>i{transition:none!important}
@media (prefers-reduced-motion:reduce){.af-levelup.enter{animation:none}.af-obj-bar>i{transition:none}}
`;

let onboardingCssInjected = false;

function injectOnboardingCss(parent: HTMLElement): void {
  if (onboardingCssInjected) return;
  onboardingCssInjected = true;
  try {
    const doc = parent.ownerDocument;
    if (!doc) return;
    const style = doc.createElement('style');
    style.textContent = ONBOARDING_PANEL_CSS;
    doc.head.appendChild(style);
  } catch {
    /* detached document: markup still renders */
  }
}

function makeOnboardingEl(parent: HTMLElement, tag: string, className = ''): HTMLElement {
  const doc = parent.ownerDocument;
  if (!doc) throw new Error('onboarding panels: root has no ownerDocument');
  const el = doc.createElement(tag);
  if (className) el.className = className;
  return el;
}

/** Defensive attribute write — the headless DOM stub has no setAttribute. */
function setAttr(el: HTMLElement | null | undefined, k: string, v: string): void {
  try {
    el?.setAttribute(k, v);
  } catch {
    /* non-DOM element (test stub) */
  }
}

/**
 * The persistent objective tracker.
 *
 * Always visible while a track is running (it is the "what do I do next"
 * answer, not a menu), compact enough to sit under the quest card, and
 * readable at a glance: track name, the objective, the live count, and the
 * control that achieves it. Reduced motion drops the bar's width transition;
 * the numbers stay.
 */
export class ObjectiveTrackerPanel {
  readonly el: HTMLElement;
  private trackEl: HTMLElement;
  private nameEl: HTMLElement;
  private countEl: HTMLElement;
  private hintEl: HTMLElement;
  private barEl: HTMLElement;
  private nextEl: HTMLElement;
  private stepsEl: HTMLElement;
  private lastRevision = -1;
  private lastKey = '';
  /** Expanded step list (tutorial only); off by default for compactness. */
  showSteps = false;

  constructor(
    parent: HTMLElement,
    private tracker: ObjectiveTracker,
    private tutorial?: TutorialTracker,
    private reducedMotion = false,
  ) {
    injectOnboardingCss(parent);
    const root = makeOnboardingEl(parent, 'div', 'af-objectives');
    root.id = 'af-objectives';
    this.trackEl = makeOnboardingEl(parent, 'div', 'af-obj-track');
    root.appendChild(this.trackEl);

    const head = makeOnboardingEl(parent, 'div', 'af-obj-head');
    this.nameEl = makeOnboardingEl(parent, 'div', 'af-obj-name');
    this.countEl = makeOnboardingEl(parent, 'div', 'af-obj-count');
    head.appendChild(this.nameEl);
    head.appendChild(this.countEl);
    root.appendChild(head);

    this.hintEl = makeOnboardingEl(parent, 'div', 'af-obj-hint');
    root.appendChild(this.hintEl);

    const bar = makeOnboardingEl(parent, 'div', 'af-obj-bar');
    this.barEl = makeOnboardingEl(parent, 'i');
    bar.appendChild(this.barEl);
    root.appendChild(bar);

    this.nextEl = makeOnboardingEl(parent, 'div', 'af-obj-next');
    root.appendChild(this.nextEl);

    this.stepsEl = makeOnboardingEl(parent, 'div', 'af-obj-steps');
    this.stepsEl.id = 'af-obj-steps';
    root.appendChild(this.stepsEl);

    parent.appendChild(root);
    this.el = root;
    this.applyMotion();
  }

  setReducedMotion(on: boolean): void {
    this.reducedMotion = on;
    this.tracker.setReducedMotion(on);
    this.tutorial?.setReducedMotion(on);
    this.applyMotion();
    this.lastKey = '';
  }

  private applyMotion(): void {
    if (this.reducedMotion) this.el.setAttribute('data-motion', 'reduced');
    else if (this.el.removeAttribute) this.el.removeAttribute('data-motion');
  }

  toggleSteps(): void {
    this.showSteps = !this.showSteps;
    this.lastKey = '';
  }

  render(): boolean {
    const body = this.tracker.body();
    const next = this.tracker.next();
    const ahead = this.tracker.upcoming(1)[0];
    const key = `${body.heading}|${body.headline}|${body.detail}|${ahead?.id ?? '-'}|${this.showSteps ? 1 : 0}|${this.tutorial?.revision ?? 0}`;
    if (key === this.lastKey && this.tracker.revision === this.lastRevision) return false;
    this.lastKey = key;
    this.lastRevision = this.tracker.revision;
    this.el.classList.add('open');
    this.trackEl.textContent = body.heading;
    this.nameEl.textContent = body.headline;
    this.countEl.textContent = body.progress;
    this.hintEl.textContent = body.detail;
    const frac = next && next.goal > 0 ? Math.max(0, Math.min(1, next.count / next.goal)) : 1;
    this.barEl.style.width = `${(frac * 100).toFixed(1)}%`;
    this.nextEl.innerHTML = ahead
      ? `next · <b>${escText(ahead.name)}</b> — ${escText(ahead.hint)}`
      : 'next · keep hunting — every beast feeds Elder Maren at the shrine (50, 50)';
    this.renderSteps();
    return true;
  }

  /** The expanded tutorial checklist (toggle; off by default). */
  private renderSteps(): void {
    if (!this.showSteps || !this.tutorial) {
      if (this.stepsEl.innerHTML !== '') this.stepsEl.innerHTML = '';
      return;
    }
    const html = this.tutorial
      .toRows()
      .map(
        (r) =>
          `<div class="af-obj-step${r.done ? ' done' : ''}${r.active ? ' active' : ''}">` +
          `<span class="af-obj-dot">${r.done ? '✔' : r.active ? '▶' : '·'}</span>` +
          `<span>${escText(r.label)} — ${escText(r.detail)}</span>` +
          '</div>',
      )
      .join('');
    if (this.stepsEl.innerHTML !== html) this.stepsEl.innerHTML = html;
  }

  /** Screen-reader line for the current objective. */
  narrate(): string {
    return this.tutorial?.narrate() ?? this.tracker.body().detail;
  }
}

/**
 * The level-up banner.
 *
 * Deliberately loud: a big centred plate with the level, the numbers that
 * produced it, and the talent point when the systems path reports one. It
 * holds for `banner.holdMs` and then hides itself — the caller drives the
 * clock through `banner.tick(now)`, so the panel never owns a timer.
 */
export class LevelUpPanel {
  readonly el: HTMLElement;
  private titleEl: HTMLElement;
  private detailEl: HTMLElement;
  private lastKey = '';
  private reducedMotion: boolean;

  constructor(parent: HTMLElement, private banner: LevelUpBanner, reducedMotion = false) {
    injectOnboardingCss(parent);
    const root = makeOnboardingEl(parent, 'div', 'af-levelup');
    root.id = 'af-levelup';
    root.setAttribute('role', 'status');
    root.setAttribute('aria-live', 'polite');
    this.titleEl = makeOnboardingEl(parent, 'div', 'af-lu-title');
    root.appendChild(this.titleEl);
    root.appendChild(makeOnboardingEl(parent, 'div', 'af-lu-rule'));
    this.detailEl = makeOnboardingEl(parent, 'div', 'af-lu-detail');
    root.appendChild(this.detailEl);
    parent.appendChild(root);
    this.el = root;
    this.reducedMotion = reducedMotion;
    this.banner.setReducedMotion(reducedMotion);
    this.applyMotion();
  }

  setReducedMotion(on: boolean): void {
    this.reducedMotion = on;
    this.banner.setReducedMotion(on);
    this.applyMotion();
    this.lastKey = '';
  }

  private applyMotion(): void {
    if (this.reducedMotion) this.el.setAttribute('data-motion', 'reduced');
    else if (this.el.removeAttribute) this.el.removeAttribute('data-motion');
    this.el.classList.toggle('enter', !this.reducedMotion);
  }

  render(): boolean {
    const v = this.banner.current();
    const key = `${v.show}:${v.level}:${v.detail}`;
    if (key === this.lastKey) return false;
    const wasShown = this.el.classList.contains('open');
    this.lastKey = key;
    if (!v.show) {
      this.el.classList.remove('open');
      this.titleEl.textContent = '';
      this.detailEl.textContent = '';
      return wasShown;
    }
    this.el.classList.add('open');
    this.titleEl.textContent = v.headline;
    this.detailEl.textContent = v.detail;
    setAttr(this.el, 'aria-label', `${v.headline}. ${v.detail}`);
    if (this.reducedMotion) this.el.classList.remove('enter');
    return true;
  }
}

/**
 * The death card: what happened, where you wake, what it cost.
 *
 * The respawn itself is untouched (the server still moves the player and
 * broadcasts `respawn`); this only adds the sentence that was missing. It
 * auto-hides after `explain.holdMs`, driven by `explain.tick(now)`.
 */
export class DeathPanel {
  readonly el: HTMLElement;
  private bodyEl: HTMLElement;
  private whereEl: HTMLElement;
  private penaltyEl: HTMLElement;
  private lastKey = '';

  constructor(parent: HTMLElement, private explain: DeathExplain) {
    injectOnboardingCss(parent);
    const root = makeOnboardingEl(parent, 'div', 'af-deathcard');
    root.id = 'af-deathcard';
    root.setAttribute('role', 'alertdialog');
    const head = makeOnboardingEl(parent, 'h3');
    head.textContent = 'YOU FELL';
    root.appendChild(head);
    this.bodyEl = makeOnboardingEl(parent, 'div', 'af-dc-body');
    root.appendChild(this.bodyEl);
    this.whereEl = makeOnboardingEl(parent, 'div', 'af-dc-where');
    root.appendChild(this.whereEl);
    this.penaltyEl = makeOnboardingEl(parent, 'div', 'af-dc-penalty');
    root.appendChild(this.penaltyEl);
    parent.appendChild(root);
    this.el = root;
  }

  render(): boolean {
    const v = this.explain.current();
    const key = `${v.show}:${v.body}`;
    if (key === this.lastKey) return false;
    this.lastKey = key;
    if (!v.show) {
      this.el.classList.remove('open');
      this.bodyEl.textContent = '';
      this.whereEl.textContent = '';
      this.penaltyEl.textContent = '';
      return true;
    }
    this.el.classList.add('open');
    this.bodyEl.textContent = v.body;
    this.whereEl.textContent = v.respawnLabel;
    this.penaltyEl.textContent = v.penalty;
    setAttr(this.el, 'aria-label', `${v.title}. ${v.body} ${v.respawnLabel} ${v.penalty}`);
    return true;
  }
}

/**
 * One-call bundle for the game shell: builds the three panels plus the tracker
 * they share, and exposes a single `handleEvent` the event pump can call.
 *
 * This exists so wiring the onboarding UI into a live client is one import and
 * one line rather than a dozen, and so the whole surface can be driven headless
 * in tests through the same entry point.
 */
export interface OnboardingUi {
  objectives: ObjectiveTrackerPanel;
  levelUp: LevelUpPanel;
  death: DeathPanel;
  tutorial: TutorialTracker;
  tracker: ObjectiveTracker;
  banner: LevelUpBanner;
  explain: DeathExplain;
  /** Feed a server `event` frame. Returns true when the onboarding UI used it. */
  handleEvent(kind: string, payload: Record<string, unknown> | null, selfId?: number): boolean;
  /** Drive the auto-dismiss clocks + repaint. */
  render(now: number): boolean;
  setReducedMotion(on: boolean): void;
}

export function mountOnboardingUi(
  parent: HTMLElement,
  opts: { selfId?: () => number; reducedMotion?: boolean } = {},
): OnboardingUi {
  const reduced = opts.reducedMotion ?? false;
  const tutorial = new TutorialTracker();
  const tracker = new ObjectiveTracker();
  const banner = new LevelUpBanner();
  const explain = new DeathExplain();
  const objectives = new ObjectiveTrackerPanel(parent, tracker, tutorial, reduced);
  const levelUp = new LevelUpPanel(parent, banner, reduced);
  const death = new DeathPanel(parent, explain);
  const selfId = opts.selfId ?? (() => -1);

  return {
    objectives,
    levelUp,
    death,
    tutorial,
    tracker,
    banner,
    explain,
    handleEvent(kind, payload, id = selfId()) {
      const p = payload ?? {};
      const owner = typeof p['playerId'] === 'number' ? (p['playerId'] as number) : null;
      if (owner !== null && id >= 0 && owner !== id) return false;
      let used = false;
      if (kind === 'quest-progress' || kind === 'quest-complete') {
        const qid = typeof p['questId'] === 'string' ? (p['questId'] as string) : '';
        if (qid) {
          const count = typeof p['count'] === 'number' ? (p['count'] as number) : 0;
          const goal = typeof p['goal'] === 'number' ? (p['goal'] as number) : 0;
          if (tracker.applyEvent(kind, qid, count, goal)) used = true;
          if (tutorial.applyEvent(kind, qid, count, goal)) used = true;
        }
      } else if (kind === 'levelup') {
        if (banner.raise(p)) used = true;
      } else if (kind === 'respawn') {
        const target = typeof p['id'] === 'number' ? (p['id'] as number) : -1;
        if (target === id || target === -1) {
          explain.raise(typeof p['killer'] === 'string' ? (p['killer'] as string) : undefined);
          used = true;
        }
      }
      return used;
    },
    render(now: number) {
      let touched = false;
      if (banner.tick(now)) touched = true;
      if (explain.tick(now)) touched = true;
      return objectives.render() || levelUp.render() || death.render() || touched;
    },
    setReducedMotion(on: boolean) {
      objectives.setReducedMotion(on);
      levelUp.setReducedMotion(on);
      tutorial.setReducedMotion(on);
      tracker.setReducedMotion(on);
    },
  };
}
