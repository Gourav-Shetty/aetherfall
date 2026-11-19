// AETHERFALL story — Chapter Two reactive world state (PURE data/helpers).
//
// Finishing PARTITION changes observable server-side facts. Nothing in this
// file touches the tick loop, the sim, or any live server object: it derives a
// small flag view from `QuestState` and exposes typed gates. A future agent
// wires the flags into the places listed in UNWIRED CALL SITES below.
//
// The facts are deliberately few and binary so they are cheap to assert:
//   - the sealed landmark "The Quiet Register" (shrine anchor 50,50) opens;
//   - a new collator roost (72,62) changes from `sealed` to `wakeful`;
//   - courier routes click in as soon as STATIC is done (chapter starts);
//   - the unique Ledger Lens reward becomes stockable on completion.

import type { QuestState } from '../game/quests.js';
import type { ZoneId } from '@aetherfall/engine';
import { isStaticChapterDone } from './chapter.js';
import { isPartitionChapterDone } from './chapter-two.js';

export interface WorldLandmark {
  id: string;
  name: string;
  x: number;
  y: number;
  zone: ZoneId;
  /** Which chapter must be complete before travel is allowed. */
  sealedUntil: 'none' | 'partition';
}

/** Story landmarks. Coordinates reuse anchors/roosts already in docs/WORLD.md. */
export const PARTITION_LANDMARKS: WorldLandmark[] = [
  { id: 'ashfall-exchange', name: 'Ashfall Exchange', x: 88, y: 12, zone: 'volcano', sealedUntil: 'none' },
  { id: 'brazen-porch', name: 'Brazen Porch', x: 44, y: 14, zone: 'meadow', sealedUntil: 'none' },
  { id: 'flicker-kiosk-row', name: 'Flicker Kiosk Row', x: 12, y: 38, zone: 'meadow', sealedUntil: 'none' },
  { id: 'glass-meridian', name: 'Glass Meridian', x: 50, y: 88, zone: 'dungeon', sealedUntil: 'none' },
  { id: 'sunken-arcade', name: 'Sunken Arcade', x: 14, y: 86, zone: 'dungeon', sealedUntil: 'none' },
  // New: the register under the shrine anchor. Sealed until PARTITION ends.
  { id: 'quiet-register', name: 'The Quiet Register', x: 50, y: 50, zone: 'meadow', sealedUntil: 'partition' },
];

export interface BossRoostView {
  id: string;
  name: string;
  x: number;
  y: number;
  zone: ZoneId;
  /** Roost only exists as a controller once PARTITION is complete. */
  requiresPartition: boolean;
}

export const PARTITION_BOSS_ROOSTS: BossRoostView[] = [
  { id: 'collator-roost', name: 'Collator Roost', x: 72, y: 62, zone: 'dungeon', requiresPartition: true },
];

export type RoostPhase = 'sealed' | 'wakeful';

export interface PartitionWorldFlags {
  /** The Quiet Register landmark accepts travel. */
  quietRegisterOpen: boolean;
  /** The collator roost controller is live. */
  collatorRoost: RoostPhase;
  /** Courier NPCs at landmarks begin delivering chapter hints. */
  courierRoutesOpen: boolean;
  /** The unique Ledger Lens payoff may be stocked / granted. */
  ledgerLensStocked: boolean;
}

/** Derive the whole flag view from quest state. Pure; no mutation, no clock. */
export function derivePartitionWorldFlags(state: QuestState): PartitionWorldFlags {
  const started = isStaticChapterDone(state);
  const done = isPartitionChapterDone(state);
  return {
    quietRegisterOpen: done,
    collatorRoost: done ? 'wakeful' : 'sealed',
    courierRoutesOpen: started,
    ledgerLensStocked: done,
  };
}

/** Landmark travel gate (call from travel/teleport validation). */
export function isLandmarkAccessible(flags: PartitionWorldFlags, landmarkId: string): boolean {
  const lm = PARTITION_LANDMARKS.find((x) => x.id === landmarkId);
  if (!lm) return false;
  if (lm.sealedUntil === 'none') return true;
  return lm.sealedUntil === 'partition' ? flags.quietRegisterOpen : false;
}

/** Boss roost phase (call when assembling the NPC controller list). */
export function bossRoostPhase(flags: PartitionWorldFlags, roostId: string): RoostPhase {
  const roost = PARTITION_BOSS_ROOSTS.find((x) => x.id === roostId);
  if (!roost) return 'sealed';
  return roost.requiresPartition ? flags.collatorRoost : 'wakeful';
}

/** Pure overlay: returns a new view, never mutates the supplied world object. */
export function withPartitionWorldFlags<T extends object>(
  world: T,
  state: QuestState,
): T & { partition: PartitionWorldFlags } {
  return { ...world, partition: derivePartitionWorldFlags(state) };
}

/**
 * UNWIRED CALL SITES (future agent, no tick-loop change required):
 *
 *  - server/src/game/index.ts — `GameSession`: hold a `partition` flag view
 *    (from `withPartitionWorldFlags`) and refresh it only when a `complete`
 *    event for a `static-*` or `partition-*` quest is emitted. Emit a private
 *    `world-state` info/event carrying the four booleans if clients need it.
 *  - server/src/index.ts — the travel/teleport/landmark handler: reject a move
 *    to `quiet-register` unless `isLandmarkAccessible(flags, 'quiet-register')`.
 *  - server/src/ai/npc.ts — when building the boss controller list, include
 *    `collator-roost` only when `bossRoostPhase(flags, 'collator-roost') ===
 *    'wakeful'`. Because the controller is added/removed at setup, no 10Hz tick
 *    branch is introduced.
 *  - server/src/game/content.ts — `vendorStock()`: add the `ledger-lens` row
 *    when `flags.ledgerLensStocked`, or grant it directly from
 *    `claimPartitionPayoff(state)` on the `partition-custody` completion event.
 *  - client/src/panels.ts — already surfaced additively through
 *    `QuestLogPanel`'s Chapter Two block fed by `quest-progress` events; no
 *    wire-format change is needed for any of the above.
 */
