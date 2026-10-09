import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  WALLS_FORMAT,
  WALLS_VERSION,
  circleHitsWalls,
  encodeWallsDoc,
  moveWithSlide,
  tileKeysToWalls,
  validateWalls,
  wallsToTileKeys,
  type WallRect,
} from './index.js';

describe('validateWalls', () => {
  it('accepts canonical rect docs', () => {
    const v = validateWalls({
      format: WALLS_FORMAT,
      tile: 1,
      version: WALLS_VERSION,
      count: 2,
      walls: [
        { x: 1, y: 2, w: 1, h: 1 },
        { x: 5, y: 5, w: 3, h: 2 },
      ],
    });
    assert.equal(v.ok, true);
    if (v.ok) assert.equal(v.walls.length, 2);
  });

  it('accepts legacy tuple walls (old client-overlay export)', () => {
    const v = validateWalls({ format: 'aetherfall-walls/v1', tile: 1, count: 2, walls: [[3, 4], [9, 9]] });
    assert.equal(v.ok, true);
    if (v.ok) assert.deepEqual(v.walls, [{ x: 3, y: 4, w: 1, h: 1 }, { x: 9, y: 9, w: 1, h: 1 }]);
  });

  it('rejects NaN / Infinity entries', () => {
    for (const bad of [
      { format: WALLS_FORMAT, walls: [[NaN, 1]] },
      { format: WALLS_FORMAT, walls: [[1, Infinity]] },
      { format: WALLS_FORMAT, walls: [{ x: NaN, y: 1, w: 1, h: 1 }] },
      { format: WALLS_FORMAT, walls: [{ x: 1, y: 1, w: Infinity, h: 1 }] },
    ]) {
      const v = validateWalls(bad);
      assert.equal(v.ok, false, `should reject ${JSON.stringify(bad)}`);
    }
  });

  it('rejects huge coords / extents and oversized files', () => {
    assert.equal(validateWalls({ format: WALLS_FORMAT, walls: [[100000, 1]] }).ok, false);
    assert.equal(validateWalls({ format: WALLS_FORMAT, walls: [{ x: 0, y: 0, w: 1000, h: 1 }] }).ok, false);
    assert.equal(validateWalls({ format: WALLS_FORMAT, walls: [{ x: -1, y: 0, w: 1, h: 1 }] }).ok, false);
    const many: WallRect[] = Array.from({ length: 10001 }, (_, i) => ({ x: i % 1000, y: (i / 1000) | 0, w: 1, h: 1 }));
    assert.equal(validateWalls({ format: WALLS_FORMAT, walls: many }).ok, false);
  });

  it('rejects wrong format and non-object docs', () => {
    assert.equal(validateWalls({ format: 'nope', walls: [] }).ok, false);
    assert.equal(validateWalls(null).ok, false);
    assert.equal(validateWalls({ format: WALLS_FORMAT }).ok, false);
  });
});

describe('wall collision helpers', () => {
  const wall: WallRect[] = [{ x: 5, y: 0, w: 1, h: 10 }]; // vertical barrier x in [5,6]

  it('circleHitsWalls detects body overlap', () => {
    assert.equal(circleHitsWalls(4.5, 5, 0.4, wall), false);
    assert.equal(circleHitsWalls(4.8, 5, 0.4, wall), true);
    assert.equal(circleHitsWalls(5.5, 5, 0.4, wall), true);
  });

  it('moveWithSlide blocks the wall axis but keeps sliding', () => {
    // diagonal into the vertical wall: X must stop, Y must keep moving
    const m = moveWithSlide(4.5, 5, 1.0, 1.0, 0.4, wall);
    assert.equal(m.x, 4.5);
    assert.equal(m.y, 6.0);
  });

  it('open movement is untouched', () => {
    const m = moveWithSlide(1, 1, 0.4, 0.2, 0.4, wall);
    assert.deepEqual(m, { x: 1.4, y: 1.2 });
  });

  it('tile keys round-trip through rects', () => {
    const keys = new Set(['1,2', '3,4']);
    const rects = tileKeysToWalls(keys);
    assert.deepEqual(rects, [{ x: 1, y: 2, w: 1, h: 1 }, { x: 3, y: 4, w: 1, h: 1 }]);
    assert.deepEqual([...wallsToTileKeys(rects)].sort(), ['1,2', '3,4']);
    const doc = encodeWallsDoc(rects);
    assert.equal(doc.format, WALLS_FORMAT);
    assert.equal(doc.count, 2);
    assert.equal(validateWalls(JSON.parse(JSON.stringify(doc))).ok, true);
  });
});
