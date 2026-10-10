// Pooled DOM damage-number overlay used by the three.js channel. Drives real
// pooled elements through the recording DOM stub: no createElement per hit,
// no allocation per frame, hard cap, and the a11y mode gate.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { FloatTextLayer } from './floaters.js';
import { ElStub } from './domstub.js';
import { DMG_MAX, DMG_TTL_MS, FINISHER_LABEL } from './feedback.js';
import type { DrawEntity } from './types.js';

function layer(): { floaters: FloatTextLayer; root: ElStub } {
  const root = new ElStub();
  return { floaters: new FloatTextLayer(root as unknown as HTMLElement), root };
}

/** Flat projection: world units map 1:1 to pixels around the origin. */
const project = (x: number, y: number, _z: number) => ({ sx: 100 + x, sy: 100 + y });

/** Visible (not display:none) pool nodes, in creation order. */
function visible(root: ElStub): ElStub[] {
  return root.children.filter((c) => c.style['display'] !== 'none');
}

function ent(id: number, x: number, y: number, isLocal = false): DrawEntity {
  return { id, kind: isLocal ? 'player' : 'mob', x, y, hp: 100, maxHp: 100, name: 'e', isLocal };
}

describe('FloatTextLayer: pooling', () => {
  it('creates one node per number and reuses them afterwards', () => {
    const { floaters, root } = layer();
    floaters.update(1000, [], project);
    assert.equal(root.children.length, 0, 'no nodes before the first hit');

    floaters.spawn(0, 0, 7, 'normal', 1000);
    floaters.update(1000, [], project);
    assert.equal(root.children.length, 1);
    assert.equal(root.children[0]!.textContent, '7');

    floaters.update(1000 + DMG_TTL_MS, [], project);
    assert.equal(root.children.length, 1, 'the node is kept, not destroyed');

    floaters.spawn(0, 0, 8, 'normal', 2000);
    floaters.update(2000, [], project);
    assert.equal(root.children.length, 1, 'the next hit reuses the same node');
    assert.equal(root.children[0]!.textContent, '8');
  });

  it('never exceeds DMG_MAX nodes, no matter how many hits land', () => {
    const { floaters, root } = layer();
    for (let i = 0; i < DMG_MAX * 4; i++) floaters.spawn(i * 5, 0, 5, 'normal', 1000);
    floaters.update(1000, [], project);
    assert.equal(floaters.liveCount(), DMG_MAX);
    assert.ok(root.children.length <= DMG_MAX, 'the DOM is bounded');
    assert.equal(root.children.length, DMG_MAX);
  });

  it('hides idle nodes and reuses them on the next hit', () => {
    const { floaters, root } = layer();
    for (let i = 0; i < 3; i++) floaters.spawn(i * 5, 0, 5, 'normal', 1000);
    floaters.update(1000, [], project);
    assert.equal(visible(root).length, 3);
    floaters.update(1000 + DMG_TTL_MS, [], project);
    assert.equal(visible(root).length, 0, 'all hidden once they expire');
    floaters.spawn(0, 0, 5, 'normal', 3000);
    floaters.update(3000, [], project);
    assert.equal(root.children.length, 3, 'no new nodes were created');
    assert.equal(visible(root).length, 1);
  });

  it('reset() forgets the nodes after the host layer is wiped', () => {
    const { floaters, root } = layer();
    floaters.spawn(0, 0, 5, 'normal', 1000);
    floaters.update(1000, [], project);
    assert.equal(root.children.length, 1);
    floaters.reset();
    assert.equal(floaters.liveCount(), 0);
    floaters.spawn(0, 0, 6, 'normal', 2000);
    floaters.update(2000, [], project);
    assert.equal(root.children.length, 2, 'a fresh node was built after the reset');
  });
});

describe('FloatTextLayer: presentation', () => {
  it('positions a number at the projected anchor (18px above it, like a nametag)', () => {
    const { floaters, root } = layer();
    floaters.spawn(10, 5, 12, 'normal', 1000);
    floaters.update(1000, [], project);
    const t = root.children[0]!.style['transform']!;
    assert.ok(t.includes('110.0px'), `x lands on screen (${t})`);
    assert.ok(t.includes('87.0px'), `y sits above the anchor (${t})`);
    // It rises over its lifetime rather than sitting still.
    floaters.update(1000 + DMG_TTL_MS - 1, [], project);
    assert.ok(root.children[0]!.style['transform']!.includes('53.0px'), 'risen to the top of its travel');
  });

  it('drives opacity + transform from the pool (no CSS keyframe needed)', () => {
    const { floaters, root } = layer();
    floaters.spawn(0, 0, 12, 'normal', 1000);
    floaters.update(1000, [], project);
    assert.equal(root.children[0]!.style['opacity'], '1.000');
    floaters.update(1000 + DMG_TTL_MS - 1, [], project);
    const alpha = Number(root.children[0]!.style['opacity']);
    assert.ok(alpha < 1 && alpha > 0, `fading (${alpha})`);
  });

  it('uses the crit colour and size for a heavy hit', () => {
    const { floaters, root } = layer();
    floaters.spawn(0, 0, 44, 'crit', 1000);
    floaters.update(1000, [], project);
    assert.equal(root.children[0]!.textContent, '✦44');
    assert.equal(root.children[0]!.style['color'], '#ffd24a');
    // `style.fontSize` is the DOM-camel form; the stub records it verbatim.
    assert.equal(root.children[0]!.style['fontSize'], '19px');
  });

  it('prints the finisher label verbatim', () => {
    const { floaters, root } = layer();
    assert.equal(floaters.spawnFinisher(0, 0, 1000), true);
    floaters.update(1000, [], project);
    assert.equal(root.children[0]!.textContent, FINISHER_LABEL);
    assert.equal(root.children[0]!.style['color'], '#ffcf3d');
  });

  it('a following number rides along with its entity', () => {
    const { floaters, root } = layer();
    floaters.spawn(0, 0, 5, 'taken', 1000, 3);
    floaters.update(1000, [ent(3, 40, 20, true)], project);
    assert.ok(root.children[0]!.style['transform']!.includes('140.0px'), 'follows the player');
    floaters.update(1100, [ent(3, 60, 30, true)], project);
    assert.ok(root.children[0]!.style['transform']!.includes('160.0px'), 'and keeps following');
  });

  it('an unanchored number stays where it was spawned', () => {
    const { floaters, root } = layer();
    floaters.spawn(0, 0, 5, 'normal', 1000);
    floaters.update(1000, [ent(3, 60, 30, true)], project);
    assert.ok(root.children[0]!.style['transform']!.includes('100.0px'));
  });
});

describe('FloatTextLayer: a11y gate', () => {
  it('"off" (high contrast) shows nothing at all', () => {
    const { floaters, root } = layer();
    floaters.setMode('off');
    assert.equal(floaters.getMode(), 'off');
    assert.equal(floaters.spawn(0, 0, 10, 'crit', 1000), false);
    floaters.update(1000, [], project);
    assert.equal(visible(root).length, 0);
  });

  it('switching to "off" clears what is already on screen', () => {
    const { floaters, root } = layer();
    floaters.spawn(0, 0, 10, 'crit', 1000);
    floaters.update(1000, [], project);
    assert.equal(visible(root).length, 1);
    floaters.setMode('off');
    assert.equal(visible(root).length, 0);
    assert.equal(floaters.liveCount(), 0);
  });

  it('"short" (reduced motion) still shows the number', () => {
    const { floaters, root } = layer();
    floaters.setMode('short');
    assert.equal(floaters.spawn(0, 0, 10, 'normal', 1000), true);
    floaters.update(1000, [], project);
    assert.equal(visible(root).length, 1);
    assert.equal(root.children[0]!.textContent, '10');
  });
});