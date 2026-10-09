import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Sim, MAX_SPEED } from './sim.js';
import { TICK_HZ, validateWalls } from '@aetherfall/shared';
import { loadWallsFile, parseWallsBody, saveWallsFile } from './walls.js';

const dt = 1 / TICK_HZ;

describe('sim wall collision (slide, not stick)', () => {
  it('vertical wall blocks X but preserves Y slide', () => {
    const sim = new Sim();
    // vertical barrier x in [10,11], spanning y 0..20
    sim.setWalls([{ x: 10, y: 0, w: 1, h: 20 }]);
    sim.addPlayer(1, 'slider', 9, 5);
    sim.setVelocity(1, MAX_SPEED, MAX_SPEED, 1); // diagonal into the wall
    for (let i = 0; i < 30; i++) sim.step(dt);
    const p = sim.players.get(1)!;
    assert.ok(p.x < 10, `expected X blocked before wall, got ${p.x}`);
    assert.ok(p.y > 5.5, `expected Y to keep sliding, got ${p.y}`);
  });

  it('open arena movement is unchanged (no walls = no collision)', () => {
    const sim = new Sim();
    sim.setWalls([]);
    sim.addPlayer(1, 'free', 10, 10);
    sim.setVelocity(1, MAX_SPEED, 0, 1);
    for (let i = 0; i < 20; i++) sim.step(dt);
    const p = sim.players.get(1)!;
    assert.ok(p.x > 10, `expected free movement, got ${p.x}`);
  });

  it('spawn inside a wall is nudged to free space', () => {
    const sim = new Sim();
    sim.setWalls([{ x: 9, y: 9, w: 3, h: 3 }]);
    const p = sim.addPlayer(1, 'stuck', 10, 10);
    assert.equal(sim.hitsWall(p.x, p.y), false);
  });

  it('wall state survives a determinism run (same walls, same trace)', () => {
    const run = (): string => {
      const sim = new Sim();
      sim.setWalls([{ x: 20, y: 0, w: 1, h: 100 }]);
      sim.addPlayer(1, 'a', 10, 50);
      sim.setVelocity(1, MAX_SPEED, 0, 1);
      for (let i = 0; i < 60; i++) sim.step(dt);
      const p = sim.players.get(1)!;
      return `${p.x.toFixed(6)},${p.y.toFixed(6)}`;
    };
    assert.equal(run(), run());
  });
});

describe('walls file round-trip (editor JSON -> server file -> sim)', () => {
  let dir = '';
  let prevWallsPath: string | undefined;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'aetherfall-walls-'));
    prevWallsPath = process.env.WALLS_PATH;
    process.env.WALLS_PATH = join(dir, 'walls.json');
  });

  afterEach(() => {
    if (prevWallsPath === undefined) delete process.env.WALLS_PATH;
    else process.env.WALLS_PATH = prevWallsPath;
    rmSync(dir, { recursive: true, force: true });
  });

  it('editor export shape loads, saves, and reloads identically', () => {
    // shape the client editor produces (canonical rects + legacy tuples)
    const editorExport = JSON.stringify({
      format: 'aetherfall-walls/v1',
      tile: 1,
      version: 1,
      count: 3,
      walls: [
        { x: 12, y: 7, w: 1, h: 1 },
        [13, 7],
        { x: 20, y: 20, w: 2, h: 1 },
      ],
    });
    const walls = parseWallsBody(editorExport);
    assert.equal(walls.length, 3);
    const file = saveWallsFile(walls);
    assert.equal(file, join(dir, 'walls.json'));
    const reloaded = loadWallsFile();
    assert.deepEqual(reloaded, walls);
    const sim = new Sim();
    sim.setWalls(reloaded);
    assert.equal(sim.walls.length, 3);
    const onDisk = JSON.parse(readFileSync(file, 'utf8')) as unknown;
    assert.equal(validateWalls(onDisk).ok, true);
  });

  it('invalid POST bodies are rejected with status errors', () => {
    assert.throws(() => parseWallsBody('not json'), /invalid JSON/);
    assert.throws(() => parseWallsBody(JSON.stringify({ format: 'nope', walls: [] })), /bad format/);
    assert.throws(
      () => parseWallsBody(JSON.stringify({ format: 'aetherfall-walls/v1', walls: [[NaN, 0]] })),
      /invalid entry/,
    );
  });
});
