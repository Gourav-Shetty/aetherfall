// Renderer-agnostic entity view-model. Both renderers consume DrawEntity[].
export interface DrawEntity {
  id: number;
  kind: string;
  x: number;
  y: number;
  hp: number;
  maxHp: number;
  name: string;
  isLocal: boolean;
  /**
   * Worn mask id (see server/src/game/masks.ts). Stamped client-side from
   * `mask-equipped` events — snapshots never carry it, so protocol v1 is
   * untouched. Renderers draw the mask glyph above the avatar when set.
   */
  mask?: string | null;
  /**
   * Sworn vocation id (see progression.ts VOCATIONS). Stamped client-side
   * from `vocation` events; tints the class-coloured base disc.
   */
  vocation?: string | null;
  /**
   * Terrain elevation of the tile under the entity, in world units (0 = water
   * line). Optional: a shard only sends it with `snapshotZ` enabled (off by
   * default — see server/src/sim.ts SimOptions.snapshotZ), so the renderers
   * sample the engine field themselves when it is missing. Both paths are the
   * same pure function of (x, y, seed), so the numbers are identical.
   */
  z?: number;
}
