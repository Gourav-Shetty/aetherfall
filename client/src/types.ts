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
   * Terrain elevation of the tile under the entity, in world units (0 = water
   * line). Optional: a shard only sends it with `snapshotZ` enabled (off by
   * default — see server/src/sim.ts SimOptions.snapshotZ), so the renderers
   * sample the engine field themselves when it is missing. Both paths are the
   * same pure function of (x, y, seed), so the numbers are identical.
   */
  z?: number;
}
