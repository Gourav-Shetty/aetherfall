// @aetherfall/engine — archetype-ish ECS with sparse-set component storage.
//
// Design:
// - Each component type (by string name) lives in its own SparseSet:
//   dense arrays (entities + data) + sparse EntityId->denseIndex map.
//   add/remove/get are O(1) amortized; remove is swap-remove.
// - Entities are integer ids with a freelist for recycling. `alive` guards
//   stale access. (No generation counter in v1 — ids are never reused while
//   observed remotely; server maps engine ids to network ids.)
// - Queries pick the smallest involved store and test membership in the rest.
// - Systems scheduler: named systems with priority ordering, per-system
//   enable flag, runIf predicate, and last-run timing stats.
// - Snapshot: plain-JSON serialize/deserialize of all components.

export type EntityId = number;
export type Component = Record<string, unknown>;
export type SystemFn = (world: World, dt: number) => void;

export interface SystemOptions {
  /** Lower runs first. Default 0. */
  priority?: number;
  /** Skip the system when this returns false. */
  runIf?: (world: World) => boolean;
  /** Register disabled. Default false (enabled). */
  disabled?: boolean;
}

export interface SystemStats {
  name: string;
  priority: number;
  enabled: boolean;
  runs: number;
  lastMs: number;
  totalMs: number;
}

export interface QueryOptions {
  /** Exclude entities having ANY of these components. */
  exclude?: string[];
  /** Extra predicate applied after component matching. */
  filter?: (id: EntityId) => boolean;
}

export interface WorldSnapshot {
  version: 1;
  next: number;
  entities: Array<{ id: EntityId; comps: Record<string, Component> }>;
}

/** Sparse-set storage for one component type. */
export class SparseSet<T> {
  private denseEntities: EntityId[] = [];
  private denseData: T[] = [];
  private sparse = new Map<EntityId, number>();

  get size(): number {
    return this.denseEntities.length;
  }

  has(entity: EntityId): boolean {
    return this.sparse.has(entity);
  }

  get(entity: EntityId): T | undefined {
    const i = this.sparse.get(entity);
    return i === undefined ? undefined : this.denseData[i];
  }

  add(entity: EntityId, value: T): void {
    const i = this.sparse.get(entity);
    if (i !== undefined) {
      this.denseData[i] = value;
      return;
    }
    this.sparse.set(entity, this.denseEntities.length);
    this.denseEntities.push(entity);
    this.denseData.push(value);
  }

  remove(entity: EntityId): boolean {
    const i = this.sparse.get(entity);
    if (i === undefined) return false;
    const last = this.denseEntities.length - 1;
    const lastEntity = this.denseEntities[last];
    this.denseEntities[i] = lastEntity;
    this.denseData[i] = this.denseData[last];
    this.sparse.set(lastEntity, i);
    this.denseEntities.pop();
    this.denseData.pop();
    this.sparse.delete(entity);
    return true;
  }

  clear(): void {
    this.denseEntities.length = 0;
    this.denseData.length = 0;
    this.sparse.clear();
  }

  *entities(): IterableIterator<EntityId> {
    yield* this.denseEntities;
  }

  *entries(): IterableIterator<[EntityId, T]> {
    for (let i = 0; i < this.denseEntities.length; i++) {
      yield [this.denseEntities[i], this.denseData[i]];
    }
  }
}

interface SystemEntry {
  name: string;
  fn: SystemFn;
  priority: number;
  runIf?: (world: World) => boolean;
  enabled: boolean;
  runs: number;
  lastMs: number;
  totalMs: number;
}

export class World {
  private nextId = 1;
  private free: EntityId[] = [];
  private aliveSet = new Set<EntityId>();
  private stores = new Map<string, SparseSet<Component>>();
  private systems: SystemEntry[] = [];

  // -- entities -----------------------------------------------------------

  /** Spawn an entity with an initial component bundle. */
  spawn(comps: Record<string, Component> = {}): EntityId {
    const id = this.free.length > 0 ? this.free.pop()! : this.nextId++;
    this.aliveSet.add(id);
    for (const [name, c] of Object.entries(comps)) {
      this.store(name).add(id, c);
    }
    return id;
  }

  /** Spawn an entity with no components. */
  spawnEmpty(): EntityId {
    return this.spawn();
  }

  despawn(id: EntityId): void {
    if (!this.aliveSet.has(id)) return;
    for (const s of this.stores.values()) s.remove(id);
    this.aliveSet.delete(id);
    this.free.push(id);
  }

  alive(id: EntityId): boolean {
    return this.aliveSet.has(id);
  }

  count(): number {
    return this.aliveSet.size;
  }

  clear(): void {
    for (const s of this.stores.values()) s.clear();
    this.aliveSet.clear();
    this.free.length = 0;
    this.nextId = 1;
  }

  entities(): EntityId[] {
    return [...this.aliveSet];
  }

  // -- components ----------------------------------------------------------

  private store(name: string): SparseSet<Component> {
    let s = this.stores.get(name);
    if (!s) {
      s = new SparseSet<Component>();
      this.stores.set(name, s);
    }
    return s;
  }

  private assertAlive(id: EntityId): void {
    if (!this.aliveSet.has(id)) throw new Error(`entity ${id} is not alive`);
  }

  /** Attach (or replace) a component. Throws when the entity is dead. */
  add<T extends Component>(id: EntityId, name: string, c: T): void {
    this.assertAlive(id);
    this.store(name).add(id, c as Component);
  }

  /**
   * Upsert a component. Back-compat with the v0 stub: silently ignores
   * dead entities instead of throwing (use add() for strict behavior).
   */
  set(id: EntityId, name: string, c: Component): void {
    if (!this.aliveSet.has(id)) return;
    this.store(name).add(id, c);
  }

  get<T extends Component>(id: EntityId, name: string): T | undefined {
    return this.stores.get(name)?.get(id) as T | undefined;
  }

  has(id: EntityId, name: string): boolean {
    return this.stores.get(name)?.has(id) ?? false;
  }

  remove(id: EntityId, name: string): boolean {
    if (!this.aliveSet.has(id)) return false;
    return this.stores.get(name)?.remove(id) ?? false;
  }

  /** Component names attached to an entity. */
  componentNames(id: EntityId): string[] {
    const out: string[] = [];
    for (const [name, s] of this.stores) if (s.has(id)) out.push(name);
    return out;
  }

  // -- queries -------------------------------------------------------------

  /**
   * Ids of alive entities having ALL named components.
   * Iterates the smallest store for efficiency.
   */
  query(...names: string[]): EntityId[] {
    return this.queryWith(names);
  }

  queryWith(include: string[], opts: QueryOptions = {}): EntityId[] {
    const exclude = opts.exclude ?? [];
    if (include.length === 0) {
      const out: EntityId[] = [];
      for (const id of this.aliveSet) {
        if (exclude.some((n) => this.has(id, n))) continue;
        if (opts.filter && !opts.filter(id)) continue;
        out.push(id);
      }
      return out;
    }
    // Drive iteration from the smallest store.
    let smallest: SparseSet<Component> | undefined;
    for (const n of include) {
      const s = this.stores.get(n);
      if (!s || s.size === 0) return [];
      if (!smallest || s.size < smallest.size) smallest = s;
    }
    const rest = include.filter((n) => this.stores.get(n) !== smallest);
    const out: EntityId[] = [];
    for (const id of smallest!.entities()) {
      let ok = true;
      for (const n of rest) {
        if (!this.stores.get(n)!.has(id)) {
          ok = false;
          break;
        }
      }
      if (!ok) continue;
      for (const n of exclude) {
        if (this.has(id, n)) {
          ok = false;
          break;
        }
      }
      if (!ok) continue;
      if (opts.filter && !opts.filter(id)) continue;
      out.push(id);
    }
    return out;
  }

  /** Ids + component payloads for entities having ALL named components. */
  view(...names: string[]): Array<{ id: EntityId; comps: Component[] }> {
    const ids = this.query(...names);
    return ids.map((id) => ({
      id,
      comps: names.map((n) => this.get(id, n) as Component),
    }));
  }

  /** Run a callback for every entity having ALL named components. */
  forEach(names: string[], fn: (id: EntityId, ...comps: Component[]) => void): void {
    for (const id of this.query(...names)) {
      fn(id, ...names.map((n) => this.get(id, n) as Component));
    }
  }

  // -- systems scheduler ----------------------------------------------------

  addSystem(name: string, fn: SystemFn, opts: SystemOptions = {}): void {
    if (this.systems.some((s) => s.name === name)) {
      throw new Error(`system "${name}" already registered`);
    }
    this.systems.push({
      name,
      fn,
      priority: opts.priority ?? 0,
      runIf: opts.runIf,
      enabled: !(opts.disabled ?? false),
      runs: 0,
      lastMs: 0,
      totalMs: 0,
    });
    this.systems.sort((a, b) => a.priority - b.priority);
  }

  removeSystem(name: string): boolean {
    const i = this.systems.findIndex((s) => s.name === name);
    if (i < 0) return false;
    this.systems.splice(i, 1);
    return true;
  }

  enableSystem(name: string, enabled = true): void {
    const s = this.systems.find((x) => x.name === name);
    if (!s) throw new Error(`system "${name}" not registered`);
    s.enabled = enabled;
  }

  systemNames(): string[] {
    return this.systems.map((s) => s.name);
  }

  systemStats(): SystemStats[] {
    return this.systems.map((s) => ({
      name: s.name,
      priority: s.priority,
      enabled: s.enabled,
      runs: s.runs,
      lastMs: s.lastMs,
      totalMs: s.totalMs,
    }));
  }

  /** Run all enabled systems in priority order. */
  tick(dt: number): void {
    for (const s of this.systems) {
      if (!s.enabled) continue;
      if (s.runIf && !s.runIf(this)) continue;
      const t0 = performance.now();
      s.fn(this, dt);
      const ms = performance.now() - t0;
      s.runs++;
      s.lastMs = ms;
      s.totalMs += ms;
    }
  }

  // -- snapshot ---------------------------------------------------------------

  /** Plain-JSON snapshot of every entity + its components. */
  serialize(): WorldSnapshot {
    const entities: WorldSnapshot['entities'] = [];
    for (const id of this.aliveSet) {
      const comps: Record<string, Component> = {};
      for (const [name, s] of this.stores) {
        const c = s.get(id);
        if (c !== undefined) comps[name] = structuredClone(c);
      }
      entities.push({ id, comps });
    }
    entities.sort((a, b) => a.id - b.id);
    return { version: 1, next: this.nextId, entities };
  }

  /** Replace world contents from a snapshot produced by serialize(). */
  deserialize(snap: WorldSnapshot): void {
    if (snap.version !== 1) throw new Error(`unsupported snapshot version ${snap.version}`);
    for (const s of this.stores.values()) s.clear();
    this.aliveSet.clear();
    this.free.length = 0;
    let max = 0;
    for (const e of snap.entities) {
      this.aliveSet.add(e.id);
      if (e.id > max) max = e.id;
      for (const [name, c] of Object.entries(e.comps)) {
        this.store(name).add(e.id, structuredClone(c));
      }
    }
    this.nextId = Math.max(snap.next, max + 1);
  }
}
