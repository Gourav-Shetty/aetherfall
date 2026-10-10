import { ChunkCache } from './tiles.js';
import type { ChatChannel } from './net.js';
import type { DrawEntity } from './types.js';
import { FOG_CHUNK, FOG_RADIUS, type FogLike } from './fog.js';
import { MAX_BOSS_BARS, bossGradient, type BossBar } from './bosses.js';
import type { TerrainMapLike } from './terrain_view.js';
import { a11y, HudNav, i18n, type AnnounceInput } from './a11y.js';

const MAX_CHAT = 120;
export const BOSS_CSS = `
.hud-tc{position:absolute;top:10px;left:50%;transform:translateX(-50%);width:min(420px,60vw);display:flex;flex-direction:column;gap:6px;pointer-events:none}
.hud-bc{position:absolute;left:50%;bottom:12px;transform:translateX(-50%);width:min(440px,72vw);display:flex;flex-direction:column;gap:6px;pointer-events:none}
.hud-vitals{background:rgba(13,19,38,.78);backdrop-filter:blur(8px);border:1px solid rgba(232,198,106,.35);border-radius:8px;padding:8px 10px}
.vitals-row{display:flex;gap:10px;align-items:center}
.vitals-bars{flex:1;display:flex;flex-direction:column;gap:5px;min-width:0}
.level-badge{flex:none;width:44px;height:44px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-weight:800;font-size:16px;color:#1a1200;background:radial-gradient(circle at 30% 30%,#f5d98a,#e8c66a 60%,#9a7a2e);border:1px solid #f5d98a}
.bar.hp>i{background:linear-gradient(180deg,#ff7a6b,#b81e2c)}
.bar.xp{height:8px}
.bar.xp>i{background:linear-gradient(90deg,#c39bff,#6d28d9)}
#hud-bosses{display:flex;flex-direction:column;gap:6px}
.boss{background:rgba(13,19,38,.78);backdrop-filter:blur(8px);border:1px solid rgba(232,198,106,.35);border-radius:8px;padding:5px 8px}
.boss .boss-name{font-size:11px;letter-spacing:2px;text-transform:uppercase;color:#e8c66a;text-shadow:0 1px 2px #000;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.boss .boss-bar{position:relative;height:10px;background:#20262f;border:1px solid #10141b;border-radius:4px;margin-top:4px;overflow:hidden}
.boss .boss-bar>i{display:block;height:100%;transition:width .2s}
.feed-item{animation:feedIn .25s ease-out}
@keyframes feedIn{from{transform:translateX(16px);opacity:0}}
.chat-line{animation:chatIn .2s ease-out}
@keyframes chatIn{from{transform:translateY(4px);opacity:0}}
.chan-global{color:#4dc3ff} .chan-say{color:#59d98c} .chan-guild{color:#e8c66a}
html[data-a11y-motion="reduced"] .feed-item,html[data-a11y-motion="reduced"] .chat-line{animation:none!important;transition:none!important}
`;
let bossCssInjected = false;

export type { BossBar } from './bosses.js';
/**
 * Snapshot-kind -> minimap dot colour. Seeded from the a11y palette so the
 * colourblind-safe presets apply to the minimap too; `refreshPalette()`
 * re-reads it whenever the player changes the palette setting.
 */
let KIND_COLOR: Record<string, string> = {
  player: '#ff9a4d', npc: '#4dc3ff', mob: '#ff5252', pickup: '#ffe066', projectile: '#ffffff',
};
function refreshPalette(): void {
  const p = a11y.palette();
  KIND_COLOR = {
    player: p.player, npc: p.npc, mob: p.mob, pickup: p.pickup, projectile: p.projectile,
  };
}
refreshPalette();

/** Escape text destined for innerHTML (server-supplied names/chat are untrusted). */
function escapeHtml(s: string): string {
  return s.replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]!));
}
/** Escape a value destined for a double-quoted HTML attribute. */
function escapeAttr(s: string): string {
  return escapeHtml(s).replace(/"/g, '&quot;');
}
/**
 * Write an ARIA attribute defensively. The HUD is also driven headless by the
 * recording DOM stub (domstub.ts), whose elements do not implement
 * setAttribute — accessibility metadata must never break a render path.
 */
function setAttr(el: HTMLElement | null | undefined, k: string, v: string): void {
  try {
    el?.setAttribute(k, v);
  } catch {
    /* non-DOM element (test stub) — ARIA metadata is best-effort */
  }
}

/** DOM HUD: HP/XP bars, 20-slot inventory, quests, chat, minimap, kill feed. */
export class HUD {
  onSendChat: (text: string, channel: ChatChannel) => void = () => {};
  private hpFill: HTMLElement;
  private hpText: HTMLElement;
  private xpFill: HTMLElement;
  private xpText: HTMLElement;
  private inv: HTMLElement;
  private questsEl: HTMLElement;
  private chatLog: HTMLElement;
  private chatInput: HTMLInputElement;
  private chatChan: HTMLSelectElement;
  private feed: HTMLElement;
  private map: HTMLCanvasElement;
  private bossesEl: HTMLElement;
  private hpBar: HTMLElement;
  private xpBar: HTMLElement;
  private levelBadge: HTMLElement;
  private items: string[] = [];
  private quests: Array<{ title: string; obj: string; done?: boolean }> = [];
  private tiles = new ChunkCache();
  private lbEl: HTMLElement | null = null;
  private lbList: HTMLElement | null = null;
  /** Bosses already announced this session (so "boss appeared" fires once). */
  private seenBosses = new Set<string>();
  private root: HTMLElement;
  /** Roving-focus controller (arrow keys inside the HUD, Tab between widgets). */
  nav: HudNav;
  /** Hook for the a11y layer so gameplay events can be announced. */
  onAnnounce: (e: AnnounceInput) => void = (e) => a11y.announce(e);

  constructor(root: HTMLElement) {
    this.root = root;
    const t = (k: Parameters<typeof i18n.t>[0]) => i18n.t(k);
    root.innerHTML = `
      <div class="hud-tl hud-quest-card"><div id="hud-quests" role="list" tabindex="0" aria-label="${t('hud.quests')}"></div></div>
      <div class="hud-tr"><canvas id="hud-map" width="128" height="128" role="img" aria-label="${t('hud.minimap')}"></canvas><div id="hud-feed" role="log" aria-live="off" aria-label="${t('hud.killFeed')}"></div></div>
      <div class="hud-tc"><div id="hud-bosses" role="group" aria-label="${t('hud.bossBar')}"></div></div>
      <div class="hud-bc"><div class="hud-vitals"><div class="vitals-row"><div class="level-badge" id="hud-level" aria-hidden="true">1</div><div class="vitals-bars">
        <div class="bar hp" id="hud-hpbar" role="progressbar" aria-valuemin="0" aria-valuemax="100"
             aria-valuenow="100" aria-label="${t('hud.hp')}"><i id="hud-hpf"></i><span id="hud-hpt"></span></div>
        <div class="bar xp" id="hud-xpbar" role="progressbar" aria-valuemin="0" aria-valuemax="100"
             aria-valuenow="0" aria-label="${t('hud.xp')}"><i id="hud-xpf"></i><span id="hud-xpt"></span></div>
      </div></div><div id="hud-inv" role="list" tabindex="0" aria-label="${t('hud.inventory')}"></div></div></div>
      <div class="hud-bl"><div id="hud-chat" role="log" aria-live="off" aria-label="${t('hud.chat')}"></div>
        <div class="chat-row"><select id="hud-chan" aria-label="${t('hud.channel')}">
          <option value="global">${t('hud.channel.global')}</option>
          <option value="say">${t('hud.channel.say')}</option>
          <option value="guild">${t('hud.channel.guild')}</option>
        </select><input id="hud-input" placeholder="${t('hud.chatPlaceholder')}" maxlength="200" autocomplete="off"
             aria-label="${t('hud.chat')}"/></div>
      </div>`;
    const el = <T extends HTMLElement>(s: string): T => {
      const e = root.querySelector<T>(s);
      if (!e) throw new Error('hud: missing ' + s);
      return e;
    };
    this.hpFill = el('#hud-hpf'); this.hpText = el('#hud-hpt');
    this.xpFill = el('#hud-xpf'); this.xpText = el('#hud-xpt');
    this.inv = el('#hud-inv'); this.questsEl = el('#hud-quests');
    this.chatLog = el('#hud-chat'); this.feed = el('#hud-feed');
    this.chatInput = el<HTMLInputElement>('#hud-input');
    this.chatChan = el<HTMLSelectElement>('#hud-chan');
    this.map = el<HTMLCanvasElement>('#hud-map');
    this.bossesEl = el('#hud-bosses');
    this.hpBar = el('#hud-hpbar');
    this.xpBar = el('#hud-xpbar');
    this.levelBadge = el('#hud-level');
    // Roving-tabindex keyboard nav: arrow keys move within the HUD, Tab moves
    // between widgets, Enter/Space activate the focused one.
    this.nav = new HudNav(root);
    if (!bossCssInjected) {
      bossCssInjected = true;
      try {
        const st = root.ownerDocument.createElement('style');
        st.textContent = BOSS_CSS;
        root.ownerDocument.head.appendChild(st);
      } catch {
        /* ignore */
      }
    }
    // Leaderboard panel is optional (index.html provides #leaderboard/#lb-list).
    try {
      this.lbEl = root.ownerDocument.getElementById('leaderboard');
      this.lbList = root.ownerDocument.getElementById('lb-list');
    } catch {
      this.lbEl = null;
      this.lbList = null;
    }
    this.chatInput.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter' && this.chatInput.value.trim()) {
        this.onSendChat(this.chatInput.value.trim(), this.chatChan.value as ChatChannel);
        this.chatInput.value = '';
      }
    });
    this.setHp(100, 100);
    this.setXp(0, 100, 1);
    this.renderInv();
  }

  setHp(hp: number, max: number) {
    const frac = max > 0 ? Math.max(0, Math.min(1, hp / max)) : 0;
    this.hpFill.style.width = (frac * 100).toFixed(1) + '%';
    this.hpText.textContent = `${i18n.t('hud.hp')} ${Math.ceil(hp)}/${max}`;
    // progressbar semantics: aria-valuenow/max carry the numbers a screen reader
    // announces, so the bar is meaningful without seeing the fill.
    setAttr(this.hpBar, 'aria-valuenow', String(Math.ceil(hp)));
    setAttr(this.hpBar, 'aria-valuemax', String(max));
    setAttr(this.hpBar, 'aria-valuetext', `${Math.ceil(hp)}/${max}`);
    // Low-HP warning fires on the descending edge only (latched in a11y.ts).
    a11y.reportHp(hp, max);
  }

  setXp(xp: number, next: number, level: number) {
    const frac = next > 0 ? Math.max(0, Math.min(1, xp / next)) : 0;
    this.xpFill.style.width = (frac * 100).toFixed(1) + '%';
    this.xpText.textContent = `${i18n.t('hud.level')} ${level} ${xp}/${next} ${i18n.t('hud.xp')}`;
    try { this.levelBadge.textContent = String(level); } catch { /* stub DOM */ }
    setAttr(this.xpBar, 'aria-valuenow', String(Math.floor(xp)));
    setAttr(this.xpBar, 'aria-valuemax', String(next));
    setAttr(this.xpBar, 'aria-valuetext', `${level} ${xp}/${next}`);
  }

  setInventory(items: string[]) {
    this.items = items.slice(0, 20);
    this.renderInv();
  }

  addItem(s: string): boolean {
    if (this.items.length >= 20) return false;
    this.items.push(s);
    this.renderInv();
    return true;
  }

  private renderInv() {
    // Each slot is a labelled listitem in a 5-column grid: roving tabindex means
    // the whole inventory costs one Tab stop, with arrows to move inside it.
    let html = '';
    for (let i = 0; i < 20; i++) {
      const raw = this.items[i];
      const name = raw ? i18n.tServer(raw) : '';
      const label = name
        ? i18n.t('hud.slot.item', { name }) + ` (${i + 1})`
        : i18n.t('hud.slot.empty') + ` (${i + 1})`;
      html += `<div class="slot" role="listitem" tabindex="-1" aria-label="${escapeAttr(label)}">${escapeHtml(name)}</div>`;
    }
    this.inv.innerHTML = html;
    this.inv.title = i18n.t('hud.slots', { used: this.items.length });
    setAttr(this.inv, 'aria-label',
      `${i18n.t('hud.inventory')} — ${i18n.t('hud.slots', { used: this.items.length })}`);
  }

  setQuests(q: Array<{ title: string; obj: string; done?: boolean }>) {
    this.quests = q;
    this.renderQuests();
  }

  completeQuest(i: number) {
    if (this.quests[i] && !this.quests[i].done) {
      this.quests[i].done = true;
      this.renderQuests();
    }
  }

  /**
   * Boss HP bars for every live boss in the snapshot: Stone Golem, Ember Wyrm,
   * Void Wisp, Crypt Warden (roster in bosses.ts). Dead bosses and an empty
   * list hide the bars.
   */
  setBosses(bosses: BossBar[]) {
    const list = bosses.filter((b) => b.maxHp > 0 && b.hp > 0).slice(0, MAX_BOSS_BARS);
    if (list.length === 0) {
      if (this.bossesEl.innerHTML !== '') this.bossesEl.innerHTML = '';
      return;
    }
    // Announce a boss the first time it appears so telegraphs have context.
    const names = new Set(list.map((b) => b.name));
    for (const n of names) {
      if (!this.seenBosses.has(n)) {
        this.seenBosses.add(n);
        this.onAnnounce({ type: 'bossAppeared', name: i18n.tServer(n) });
      }
    }
    for (const n of [...this.seenBosses]) if (!names.has(n)) this.seenBosses.delete(n);

    this.bossesEl.innerHTML = list.map((b) => {
      const frac = Math.max(0, Math.min(1, b.hp / b.maxHp));
      const name = i18n.tServer(b.name);
      const hp = Math.ceil(Math.max(0, b.hp));
      return `<div class="boss"><div class="boss-name">💀 ${escapeHtml(name)} — ${hp}/${b.maxHp}</div>` +
        `<div class="boss-bar" role="progressbar" aria-valuemin="0" aria-valuemax="${b.maxHp}"` +
        ` aria-valuenow="${hp}" aria-label="${escapeAttr(`${name}: ${i18n.t('hud.bossHp', { hp, max: b.maxHp })}`)}">` +
        `<i style="width:${(frac * 100).toFixed(1)}%;background:${bossGradient(b.name)}"></i></div></div>`;
    }).join('');
  }

  /**
   * Announce a boss telegraph (called from main.ts on the `telegraph` event).
   * Assertive: a boss slam is life-safety information.
   */
  announceTelegraph(label: string): void {
    this.onAnnounce({ type: 'telegraph', label: i18n.tServer(label) });
  }

  /** Announce a quest progress/complete change to screen readers. */
  announceQuest(kind: 'progress' | 'complete', title: string, obj?: string): void {
    const t = i18n.tServer(title);
    this.onAnnounce(kind === 'complete'
      ? { type: 'questComplete', title: t }
      : { type: 'questProgress', title: t, obj: obj ? i18n.tServer(obj) : undefined });
  }

  private renderQuests() {
    this.questsEl.innerHTML = `<b>${escapeHtml(i18n.t('hud.quests'))}</b>` + this.quests.map((q, i) => {
      // Quest titles arrive pre-formatted ("▶ Ember Road (2/5)"); tServer maps the
      // name + counters onto the localized template, keeping the state markers.
      const title = i18n.tServer(q.title);
      const status = q.done ? i18n.t('hud.quest.done') : i18n.t('hud.quest.active');
      return `<div class="quest${q.done ? ' done' : ''}" role="listitem" aria-label="${escapeAttr(`${title}. ${status}`)}">◆ ${escapeHtml(title)}<br/><span>${escapeHtml(i18n.tServer(q.obj))}</span></div>`;
    }).join('');
    setAttr(this.questsEl, 'aria-label', i18n.t('hud.quests'));
  }

  addChat(from: string, text: string, channel: string) {
    const d = document.createElement('div');
    d.className = 'chat-line';
    // Channel is server-controlled, so guard the key lookup: an unknown channel
// falls back to its raw name rather than rendering a bare `hud.channel.x` key.
const chanKey = `hud.channel.${channel}` as Parameters<typeof i18n.t>[0];
const chan = i18n.t(chanKey) === chanKey ? channel : i18n.t(chanKey);
    // Channel-tinted tab: class is sanitised to [a-z] so a hostile channel name
    // cannot inject markup; styling lives in BOSS_CSS + index.html (.chan-*).
    const chanCls = `chan chan-${String(channel).replace(/[^a-z]/gi, '').toLowerCase() || 'global'}`;
    // Only server *prose* is translated; player-authored text stays verbatim.
    const shownFrom = from === 'server' || from === 'system' ? i18n.tServer(from) : from;
    d.innerHTML = `<span class="${chanCls}">[${escapeHtml(chan)}]</span> <b>${escapeHtml(shownFrom)}:</b> ${escapeHtml(text)}`;
    this.chatLog.appendChild(d);
    while (this.chatLog.children.length > MAX_CHAT) this.chatLog.removeChild(this.chatLog.firstChild!);
    this.chatLog.scrollTop = this.chatLog.scrollHeight;
    // Join/leave notices arrive as system chat; they are announced as events.
    const body = text.trim();
    const join = /^(.+?) joined$/.exec(body);
    if (join && from === 'server') this.onAnnounce({ type: 'join', name: join[1]! });
    else this.onAnnounce({ type: 'chat', from: shownFrom, text });
  }

  addKill(text: string) {
    const d = document.createElement('div');
    d.className = 'feed-item';
    // Server prose ("<name> slain") is translated; plain local copy passes through.
    d.textContent = '☠ ' + i18n.tServer(text);
    this.feed.prepend(d);
    while (this.feed.children.length > 8) this.feed.removeChild(this.feed.lastChild!);
    setTimeout(() => d.remove(), 6000);
    // Deaths are announced so a screen-reader player knows a mob died.
    const fallen = /^(.+?) (?:slain|has fallen)$/.exec(text.trim());
    if (fallen) this.onAnnounce({ type: 'death', name: fallen[1]! });
  }

  focusChat() { this.chatInput.focus(); }
  isChatting(): boolean { return document.activeElement === this.chatInput; }

  /** Leaderboard from the latest snapshot: players sorted by level, then HP. */
  updateLeaderboard(ents: DrawEntity[], selfId: number, levels?: Map<number, number>) {
    if (!this.lbList) return;
    const players = ents.filter((e) => e.kind === 'player');
    players.sort((a, b) => {
      const la = levels?.get(a.id) ?? 1;
      const lb = levels?.get(b.id) ?? 1;
      if (lb !== la) return lb - la;
      return b.hp - a.hp;
    });
    const top = players.slice(0, 8);
    this.lbList.innerHTML = top.map((e, i) => {
      const lv = levels?.get(e.id) ?? 1;
      const dead = e.hp <= 0 ? ' 💀' : '';
      const me = e.id === selfId ? ' class="me"' : '';
      const name = escapeHtml(e.name);
      const hp = `${i18n.t('hud.level')}${lv} · ${Math.ceil(e.hp)}/${e.maxHp}${dead}`;
      return `<div${me} aria-label="${escapeAttr(i18n.t('hud.lbRow', {
        name: e.name, level: lv, hp: Math.ceil(e.hp), max: e.maxHp,
      }))}"><span class="rank">#${i + 1}</span> <b>${name}</b>` +
        `<span class="lb-meta">${escapeHtml(hp)}</span></div>`;
    }).join('') || `<div class="lb-empty">${escapeHtml(i18n.t('hud.noSouls'))}</div>`;
  }

  /**
   * Re-render every localized string in place after a locale switch. Called by
   * main.ts via i18n.onChange; returns true when there is a DOM to update.
   */
  relocalize(): void {
    refreshPalette();
    // Re-render the HP label from the last known values (the game loop is the
    // source of truth; this only refreshes the localized text).
    try {
      const now = Number(this.hpBar.getAttribute('aria-valuenow'));
      const max = Number(this.hpBar.getAttribute('aria-valuemax'));
      if (Number.isFinite(now) && Number.isFinite(max) && max > 0) this.setHp(now, max);
    } catch {
      /* stub DOM: nothing to re-read */
    }
    this.renderInv();
    this.renderQuests();
    this.inv.title = i18n.t('hud.slots', { used: this.items.length });
    this.chatInput.placeholder = i18n.t('hud.chatPlaceholder');
    setAttr(this.chatInput, 'aria-label', i18n.t('hud.chat'));
    setAttr(this.chatChan, 'aria-label', i18n.t('hud.channel'));
    setAttr(this.bossesEl, 'aria-label', i18n.t('hud.bossBar'));
    // Re-label existing chat lines with the newly localized channel names.
    for (const el of Array.from(this.chatLog.children) as HTMLElement[]) {
      const chan = el.querySelector('.chan');
      const from = el.querySelector('b');
      if (chan && from) chan.textContent = `[${i18n.t('hud.channel.global')}]`;
    }
  }

  setLeaderboardVisible(v: boolean) {
    if (this.lbEl) this.lbEl.style.display = v ? 'block' : 'none';
  }

  isLeaderboardVisible(): boolean {
    return !!this.lbEl && this.lbEl.style.display !== 'none';
  }

  /**
   * 128px minimap: whole 100x100 arena + entity dots + editor walls.
   * Fog-of-war overlay (optional): chunks never explored are near-black,
   * explored chunks beyond FOG_RADIUS (25m) from (px, py) are dimmed.
   *
   * `terrain` (optional) adds the hazard/landmark overlay: water and lava are
   * painted as field cells (2x2 blocks, so the map reads at 128px) and
   * landmarks as diamonds. It is drawn *before* the fog veils so unexplored
   * water stays hidden, and every lookup goes through the client's cached
   * ground grid, so the 4Hz refresh costs no field sampling at all.
   */
  drawMinimap(
    ents: DrawEntity[],
    editorWalls?: Set<string>,
    fog?: FogLike | null,
    px?: number,
    py?: number,
    terrain?: TerrainMapLike | null,
  ) {
    const ctx = this.map.getContext('2d');
    if (!ctx) return;
    const S = 128, k = S / 100;
    ctx.fillStyle = '#0d1f16';
    ctx.fillRect(0, 0, S, S);
    const fogOn = !!fog && typeof px === 'number' && typeof py === 'number';
    // Hazard cells, 2x2 tiles each: 50x50 samples over the whole arena.
    if (terrain) {
      const STEP = 2;
      for (let ty = 0; ty < 100; ty += STEP) {
        for (let tx = 0; tx < 100; tx += STEP) {
          const kind = terrain.kindAtTile(tx, ty);
          if (kind === 0) continue;
          if (fogOn && !fog!.isExploredWorld(tx + STEP / 2, ty + STEP / 2)
              && Math.hypot(tx - px!, ty - py!) > FOG_RADIUS) continue;
          ctx.fillStyle = kind === 1 ? '#1d5f9e' : '#d24a12';
          ctx.fillRect(tx * k, ty * k, Math.max(1, STEP * k), Math.max(1, STEP * k));
        }
      }
    }
    if (editorWalls) {
      ctx.fillStyle = '#b266ff';
      for (const w of editorWalls) {
        const [x, y] = w.split(',').map(Number);
        ctx.fillRect(x * k, y * k, Math.max(1, k), Math.max(1, k));
      }
    }
    // Landmarks: diamond outline + centre dot, kind-coloured.
    if (terrain && typeof px === 'number' && typeof py === 'number') {
      for (const lm of terrain.landmarksNear(px, py, 200)) {
        if (lm.x < 0 || lm.y < 0 || lm.x > 100 || lm.y > 100) continue;
        if (fogOn && !fog!.isExploredWorld(lm.x, lm.y) && Math.hypot(lm.x - px!, lm.y - py!) > FOG_RADIUS) continue;
        const sx = lm.x * k, sy = lm.y * k, r = Math.max(2, lm.radius * k * 0.8);
        ctx.strokeStyle = lm.kind === 'obelisk' ? '#c39bff' : lm.kind === 'ruin' ? '#d8d2c4' : '#ffd27a';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(sx, sy - r);
        ctx.lineTo(sx + r, sy);
        ctx.lineTo(sx, sy + r);
        ctx.lineTo(sx - r, sy);
        ctx.closePath();
        ctx.stroke();
      }
    }
    for (const e of ents) {
      // Undiscovered ground stays blank on the map too.
      if (fogOn && !fog!.isExploredWorld(e.x, e.y)
          && Math.hypot(e.x - px!, e.y - py!) > FOG_RADIUS) continue;
      ctx.fillStyle = e.isLocal ? '#ffffff' : (KIND_COLOR[e.kind] ?? '#ccc');
      const s = e.isLocal ? 3 : 2;
      ctx.fillRect(e.x * k - s / 2, e.y * k - s / 2, s, s);
    }
    if (fogOn) {
      const step = FOG_CHUNK * k;
      const n = Math.ceil(100 / FOG_CHUNK);
      for (let cy = 0; cy < n; cy++) {
        for (let cx = 0; cx < n; cx++) {
          const explored = fog!.isExploredChunk(cx, cy);
          const wx = (cx + 0.5) * FOG_CHUNK;
          const wy = (cy + 0.5) * FOG_CHUNK;
          if (explored) {
            if (Math.hypot(wx - px!, wy - py!) <= FOG_RADIUS) continue;
            ctx.fillStyle = 'rgba(4,6,12,0.45)';
          } else {
            ctx.fillStyle = 'rgba(2,3,6,0.82)';
          }
          ctx.fillRect(cx * FOG_CHUNK * k, cy * FOG_CHUNK * k, step + 0.5, step + 0.5);
        }
      }
    }
    ctx.strokeStyle = '#3a4557';
    ctx.strokeRect(0.5, 0.5, S - 1, S - 1);
  }
}
