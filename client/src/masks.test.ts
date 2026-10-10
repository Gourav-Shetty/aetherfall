// Mask glyphs, vocation disc colours and the avatar overlay store.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  AvatarOverlayStore,
  MASK_GLYPHS,
  VOCATION_COLORS,
  VOCATION_IDS,
  isVocationId,
  maskGlyphFor,
  nametagFor,
  vocationDiscColor,
} from './masks.js';
import { PALETTE_MODES } from './a11y.js';

describe('mask glyphs', () => {
  it('covers all 8 server masks with distinct glyphs', () => {
    const ids = [
      'seraph-shard', 'dusk-maw', 'gallow-beak', 'choir-horn',
      'vesper-plume', 'tithe-scale', 'cinder-hide', 'halo-rind',
    ];
    assert.equal(Object.keys(MASK_GLYPHS).length, 8);
    for (const id of ids) assert.ok(MASK_GLYPHS[id], `missing glyph for ${id}`);
    assert.equal(new Set(Object.values(MASK_GLYPHS)).size, 8);
  });

  it('resolves glyphs and degrades unknown/empty to nothing', () => {
    assert.equal(maskGlyphFor('seraph-shard'), MASK_GLYPHS['seraph-shard']);
    assert.equal(maskGlyphFor(null), '');
    assert.equal(maskGlyphFor(undefined), '');
    assert.equal(maskGlyphFor('sword-of-doom'), '');
    assert.equal(nametagFor('Ash', 'dusk-maw'), `${MASK_GLYPHS['dusk-maw']} Ash`);
    assert.equal(nametagFor('Ash', null), 'Ash');
    assert.equal(nametagFor('Ash', 'nope'), 'Ash');
  });
});

describe('vocation disc colours', () => {
  it('covers 4 vocations in every palette mode with valid hex', () => {
    assert.deepEqual([...VOCATION_IDS].sort(), ['dawnwarden', 'galehunter', 'pyrecantor', 'vesperal']);
    for (const mode of PALETTE_MODES) {
      for (const v of VOCATION_IDS) {
        const c = VOCATION_COLORS[mode][v];
        assert.match(c, /^#[0-9a-f]{6}$/, `${mode}/${v}`);
      }
      assert.equal(new Set(VOCATION_IDS.map((v) => VOCATION_COLORS[mode][v])).size, 4, `${mode} vocations distinct`);
    }
    assert.ok(isVocationId('dawnwarden'));
    assert.equal(isVocationId('paladin'), false);
  });

  it('resolves colours and degrades unknown/empty to nothing', () => {
    assert.equal(vocationDiscColor('default', 'vesperal'), VOCATION_COLORS.default.vesperal);
    assert.equal(vocationDiscColor('deuteranopia', 'galehunter'), VOCATION_COLORS.deuteranopia.galehunter);
    assert.equal(vocationDiscColor('default', null), '');
    assert.equal(vocationDiscColor('default', 'nope'), '');
  });
});

describe('AvatarOverlayStore', () => {
  it('tracks mask equip/unequip per player', () => {
    const s = new AvatarOverlayStore();
    assert.equal(s.apply('mask-equipped', { playerId: 1, maskId: 'seraph-shard' }), true);
    assert.deepEqual(s.forPlayer(1), { playerId: 1, mask: 'seraph-shard', vocation: null });
    assert.equal(s.apply('mask-equipped', { playerId: 1, maskId: 'dusk-maw' }), true);
    assert.equal(s.forPlayer(1)!.mask, 'dusk-maw', 'one slot: replacement wins');
    assert.equal(s.apply('mask-unequipped', { playerId: 1, maskId: 'dusk-maw' }), true);
    assert.equal(s.forPlayer(1)!.mask, null);
    assert.equal(s.forPlayer(9), undefined);
  });

  it('tracks vocations', () => {
    const s = new AvatarOverlayStore();
    assert.equal(s.apply('vocation', { playerId: 2, vocation: 'pyrecantor' }), true);
    assert.equal(s.forPlayer(2)!.vocation, 'pyrecantor');
    assert.equal(s.apply('vocation', { playerId: 2, vocation: 'paladin' }), false, 'unknown calling rejected');
    assert.equal(s.forPlayer(2)!.vocation, 'pyrecantor', 'rejection keeps the old value');
  });

  it('syncs from the progression snapshot (join bootstrap)', () => {
    const s = new AvatarOverlayStore();
    assert.equal(s.apply('progression', { playerId: 3, maskId: 'halo-rind', vocation: 'vesperal' }), true);
    assert.deepEqual(s.forPlayer(3), { playerId: 3, mask: 'halo-rind', vocation: 'vesperal' });
    const rev = s.revision;
    assert.equal(s.apply('progression', { playerId: 3, maskId: 'halo-rind', vocation: 'vesperal' }), true);
    assert.equal(s.revision, rev, 'identical sync bumps nothing');
    assert.equal(s.apply('progression', { playerId: 3, maskId: null, vocation: null }), true);
    assert.deepEqual(s.forPlayer(3), { playerId: 3, mask: null, vocation: null });
  });

  it('ignores junk and unknown kinds', () => {
    const s = new AvatarOverlayStore();
    assert.equal(s.apply('mask-equipped', null), false);
    assert.equal(s.apply('mask-equipped', { playerId: 1, maskId: 'sword-of-doom' }), false);
    assert.equal(s.apply('mask-equipped', { playerId: -1, maskId: 'seraph-shard' }), false);
    assert.equal(s.apply('mob-die', { id: 5 }), false);
    assert.equal(s.apply('', null), false);
    assert.equal(s.size, 0);
    s.apply('mask-equipped', { playerId: 1, maskId: 'seraph-shard' });
    s.reset();
    assert.equal(s.size, 0);
  });
});
