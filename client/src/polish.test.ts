// UI polish: dark-fantasy CSS variables + HUD/panel classes + landing.
// Headless (ElStub + string checks, no browser) so `npm run test` stays green.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ElStub } from './domstub.js';
import { HUD, BOSS_CSS } from './hud.js';
import { PANEL_CSS } from './panels.js';

function indexHtml(): string {
  // dist-test/polish.test.js -> ../index.html == client/index.html
  return readFileSync(new URL('../index.html', import.meta.url), 'utf8');
}

describe('polish: global CSS variables', () => {
  it('defines the dark-fantasy palette on :root', () => {
    const html = indexHtml();
    assert.ok(html.includes('--af-gold:#e8c66a'), 'parchment gold accent');
    assert.ok(html.includes('--af-panel:#0d1326'), 'deep slate panel');
    assert.ok(html.includes('--af-hp1') && html.includes('--af-hp2'), 'hp gradient vars');
    assert.ok(html.includes('--af-xp1') && html.includes('--af-xp2'), 'xp gradient vars');
    assert.ok(html.includes('backdrop-filter:blur(8px)'), 'glass blur');
    assert.ok(html.includes('border-radius:8px'), '8px radius');
  });
});

describe('polish: HUD structure (same DOM ids + ARIA)', () => {
  it('keeps every HUD id/ARIA and adds the level badge + bottom-center vitals', () => {
    const root = new ElStub();
    const hud = new HUD(root as unknown as HTMLElement);
    const html = root.innerHTML;
    for (const id of [
      'hud-hpbar', 'hud-hpf', 'hud-hpt', 'hud-xpbar', 'hud-xpf', 'hud-xpt',
      'hud-inv', 'hud-quests', 'hud-map', 'hud-feed', 'hud-bosses',
      'hud-chat', 'hud-chan', 'hud-input', 'hud-level',
    ]) {
      assert.ok(html.includes(`id="${id}"`), `missing #${id}`);
    }
    for (const role of ['role="progressbar"', 'role="list"', 'role="log"', 'role="group"', 'role="img"']) {
      assert.ok(html.includes(role), `missing ${role}`);
    }
    assert.ok(html.includes('hud-bc'), 'bottom-center vitals container');
    assert.ok(html.includes('level-badge'), 'level badge circle');
    assert.ok(html.includes('hud-tl') && html.includes('hud-tr'), 'quest top-left + map top-right shells');
    // Level badge tracks setXp without touching ARIA semantics.
    hud.setXp(50, 100, 7);
    const badge = (hud as unknown as { levelBadge: ElStub }).levelBadge;
    assert.equal(badge.textContent, '7');
  });
});

describe('polish: HUD CSS (boss gold + gradients + motion gate)', () => {
  it('golds the boss name, red/violet bars, slide-in feed gated by reduced-motion', () => {
    assert.ok(BOSS_CSS.includes('#e8c66a'), 'boss gold name');
    assert.ok(BOSS_CSS.includes('.level-badge'), 'level badge style');
    assert.ok(BOSS_CSS.includes('.bar.hp') || BOSS_CSS.includes('#ff7a6b'), 'hp red gradient');
    assert.ok(BOSS_CSS.includes('.bar.xp') || BOSS_CSS.includes('#c39bff'), 'xp violet gradient');
    assert.ok(BOSS_CSS.includes('feedIn'), 'kill-feed slide-in');
    assert.ok(
      BOSS_CSS.includes('data-a11y-motion="reduced"'),
      'animations gated behind the existing reduced-motion setting',
    );
  });
});

describe('polish: systems panels stay glass', () => {
  it('uses translucent dark glass + small-caps headers + motion gate', () => {
    assert.ok(PANEL_CSS.includes('backdrop-filter:blur(8px)'), 'glass blur');
    assert.ok(PANEL_CSS.includes('border-radius:8px'), '8px radius');
    assert.ok(PANEL_CSS.includes('232,198,106'), 'gold-tinted border');
    assert.ok(PANEL_CSS.includes('small-caps'), 'section headers small-caps');
    assert.ok(PANEL_CSS.includes('data-a11y-motion="reduced"'), 'bubble animation gated');
  });
});

describe('polish: landing page', () => {
  it('hero + unicode feature icons + zoomable shots + zebra controls + badges', () => {
    const html = indexHtml();
    assert.ok(html.includes('id="join"'), 'Join button kept');
    assert.ok(html.includes('class="feat-icon"'), 'CSS/unicode feature icons');
    assert.ok(!html.includes('<h3>⚡'), 'no emoji in feature cards');
    assert.ok(html.includes('.shot:hover img'), 'hover zoom');
    assert.ok(html.includes('tbody tr:nth-child(even)'), 'zebra-striped controls');
    assert.ok(html.includes('ver-badge') && html.includes('proto-badge'), 'version + protocol badge');
    assert.ok(html.includes('proto v2'), 'protocol badge names v2');
  });
});
