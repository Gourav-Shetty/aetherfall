// @aetherfall/shared — weapon-aware mob AI profiles (Phase 3: The Hotline Miami insight).
//
// Mobs are no longer homogenous sponges. Mob loadout determines:
// - Walk speed & chase speed
// - Search radius & patrol radius
// - Alert threshold & sight pull
// - Which FSM states the mob can enter (e.g. unarmed flees at low HP; melee never flees)
// - Combat engagement tactics:
//   * Ranged: holds distance (kites) and repositions
//   * Melee: charges at speed and flanks tangentially
//   * Unarmed: aggressive brawler at high HP; flees when HP <= 35%

export type MobLoadoutKind = 'melee' | 'ranged' | 'unarmed';

export type MobAiState =
  | 'idle'
  | 'patrol'
  | 'chase'
  | 'attack'
  | 'flee'
  | 'dead'
  | 'suspicious'
  | 'search'
  | 'surrender';

export interface MobLoadoutProfile {
  /** Weapon ID from the catalog or missile registry */
  weaponId: string;
  /** Archetype classification */
  kind: MobLoadoutKind;
  /** Leisurely walk / patrol speed (u/s) */
  patrolSpeed: number;
  /** Standard pursuit speed (u/s) */
  chaseSpeed: number;
  /** High-speed combat maneuver speed (charge, flank, reposition, or flee) (u/s) */
  combatSpeed: number;
  /** Vision cone / aggro detection range (units) */
  sightRange: number;
  /** Search sweep radius when investigating last-seen position (units) */
  searchRadius: number;
  /** Alert threshold factor (multiplier on sneak tolerance: lower = spots sooner) */
  alertThreshold: number;
  /** Primary attack reach (units) */
  attackRange: number;
  /** Preferred distance band min for ranged kiting (units) */
  preferredRangeMin?: number;
  /** Preferred distance band max for ranged holding (units) */
  preferredRangeMax?: number;
  /** HP fraction at which mob breaks off and enters flee state (0 = never flees) */
  fleeThreshold: number;
  /** Set of allowable states for this loadout */
  allowedStates: ReadonlyArray<MobAiState>;
}

export const MOB_LOADOUT_PROFILES: Readonly<Record<string, MobLoadoutProfile>> = {
  // --- UNARMED ARCHETYPE (Skittish brawler: flees at low HP) ---
  unarmed: {
    weaponId: 'unarmed',
    kind: 'unarmed',
    patrolSpeed: 1.5,
    chaseSpeed: 5.0,
    combatSpeed: 6.2, // fast panic flee speed
    sightRange: 10.0,
    searchRadius: 3.5,
    alertThreshold: 1.0,
    attackRange: 1.4,
    preferredRangeMin: 1.0,
    preferredRangeMax: 1.4,
    fleeThreshold: 0.35, // flees when HP drops <= 35%
    allowedStates: ['idle', 'patrol', 'chase', 'attack', 'flee', 'search', 'dead'],
  },

  // --- MELEE ARCHETYPE (Aggressive vanguard: charges and flanks) ---
  'wisp-touched-dagger': {
    weaponId: 'wisp-touched-dagger',
    kind: 'melee',
    patrolSpeed: 1.8,
    chaseSpeed: 5.8,
    combatSpeed: 7.2, // rapid flank/lunge
    sightRange: 12.0,
    searchRadius: 4.5,
    alertThreshold: 0.75,
    attackRange: 1.6,
    preferredRangeMin: 1.2,
    preferredRangeMax: 1.6,
    fleeThreshold: 0, // brave: never flees
    allowedStates: ['idle', 'patrol', 'chase', 'attack', 'search', 'dead'],
  },
  'ward-blade': {
    weaponId: 'ward-blade',
    kind: 'melee',
    patrolSpeed: 1.6,
    chaseSpeed: 5.4,
    combatSpeed: 6.8, // aggressive charge
    sightRange: 12.0,
    searchRadius: 4.5,
    alertThreshold: 0.8,
    attackRange: 2.2,
    preferredRangeMin: 1.6,
    preferredRangeMax: 2.2,
    fleeThreshold: 0,
    allowedStates: ['idle', 'patrol', 'chase', 'attack', 'search', 'dead'],
  },
  'ember-axe': {
    weaponId: 'ember-axe',
    kind: 'melee',
    patrolSpeed: 1.5,
    chaseSpeed: 5.2,
    combatSpeed: 6.5,
    sightRange: 11.5,
    searchRadius: 4.5,
    alertThreshold: 0.85,
    attackRange: 2.0,
    preferredRangeMin: 1.5,
    preferredRangeMax: 2.0,
    fleeThreshold: 0,
    allowedStates: ['idle', 'patrol', 'chase', 'attack', 'search', 'dead'],
  },
  'deep-halberd': {
    weaponId: 'deep-halberd',
    kind: 'melee',
    patrolSpeed: 1.4,
    chaseSpeed: 5.0,
    combatSpeed: 6.4,
    sightRange: 12.5,
    searchRadius: 5.0,
    alertThreshold: 0.8,
    attackRange: 3.2, // longest melee reach
    preferredRangeMin: 2.4,
    preferredRangeMax: 3.2,
    fleeThreshold: 0,
    allowedStates: ['idle', 'patrol', 'chase', 'attack', 'search', 'dead'],
  },
  'caldera-greatsword': {
    weaponId: 'caldera-greatsword',
    kind: 'melee',
    patrolSpeed: 1.3,
    chaseSpeed: 4.8,
    combatSpeed: 6.0,
    sightRange: 11.0,
    searchRadius: 4.0,
    alertThreshold: 0.9,
    attackRange: 2.8,
    preferredRangeMin: 2.0,
    preferredRangeMax: 2.8,
    fleeThreshold: 0,
    allowedStates: ['idle', 'patrol', 'chase', 'attack', 'search', 'dead'],
  },

  // --- RANGED ARCHETYPE (Tactical marksman: holds distance and repositions) ---
  'wisp-bolt': {
    weaponId: 'wisp-bolt',
    kind: 'ranged',
    patrolSpeed: 1.4,
    chaseSpeed: 4.6,
    combatSpeed: 4.8, // nimble back-pedal / lateral strafe
    sightRange: 14.0, // keen sight
    searchRadius: 7.0, // wide awareness sweep
    alertThreshold: 0.6, // sensitive detection
    attackRange: 8.0,
    preferredRangeMin: 5.0, // kites if closer than 5u
    preferredRangeMax: 8.0, // holds between 5u and 8u
    fleeThreshold: 0,
    allowedStates: ['idle', 'patrol', 'chase', 'attack', 'search', 'dead'],
  },
  'ember-spit': {
    weaponId: 'ember-spit',
    kind: 'ranged',
    patrolSpeed: 1.3,
    chaseSpeed: 4.4,
    combatSpeed: 4.6,
    sightRange: 13.5,
    searchRadius: 6.5,
    alertThreshold: 0.65,
    attackRange: 7.5,
    preferredRangeMin: 4.5,
    preferredRangeMax: 7.5,
    fleeThreshold: 0,
    allowedStates: ['idle', 'patrol', 'chase', 'attack', 'search', 'dead'],
  },
};

/** Default weapon mapping derived from mob taxonomy and loot drops in catalog */
export function getDefaultMobWeapon(mobName?: string | null): string {
  if (!mobName) return 'unarmed';
  const name = mobName.toLowerCase().trim();
  switch (name) {
    // Ranged spellcasters / spitters
    case 'void-wisp':
      return 'wisp-bolt';
    case 'cinder-imp':
      return 'ember-spit';

    // Melee armed / aggressive beasts
    case 'hollow-knight':
      return 'ember-axe';
    case 'caldera-wyrm':
      return 'deep-halberd';
    case 'magma-golem':
      return 'caldera-greatsword';
    case 'ashcrawler':
    case 'thornback':
      return 'ward-blade';
    case 'gloomfang':
    case 'mistwisp':
      return 'wisp-touched-dagger';

    // Unarmed sprites / fauna
    case 'meadow-sprite':
      return 'unarmed';

    default:
      return 'ward-blade'; // default armed encounter
  }
}

/** Resolve complete combat AI profile for a given weapon or mob name */
export function getMobLoadout(weaponId?: string | null, mobName?: string | null): MobLoadoutProfile {
  if (weaponId && MOB_LOADOUT_PROFILES[weaponId]) {
    return MOB_LOADOUT_PROFILES[weaponId]!;
  }
  const fallbackWeapon = getDefaultMobWeapon(mobName);
  return MOB_LOADOUT_PROFILES[fallbackWeapon] ?? MOB_LOADOUT_PROFILES['unarmed']!;
}
