// AETHERFALL story — Chapter Two couriers / rumour delivery.
//
// An in-world way to receive PARTITION hints: one NPC per landmark, each with
// a short, skippable dialogue tree (5 lines) that names the work at that
// landmark. Copy is ORIGINAL and technical-dry — no borrowed proper nouns.
//
// Reuses the existing dialogue infrastructure: the nodes are `DialogueNode`s
// from `ai/dialogue.ts` and `openCourierDialogue()` returns the same
// `StaticSceneDialogue` walker the STATIC paroles use (advance() follows the
// continue option, skip() jumps to the end node). No new netcode — courier
// text is static data the client renders; progress still rides quest events.

import type { DialogueNode } from '../ai/dialogue.js';
import { StaticSceneDialogue } from '../ai/dialogue.js';
import type { QuestState } from '../game/quests.js';
import type { ZoneId } from '@aetherfall/engine';
import { isStaticChapterDone } from './chapter.js';
import { partitionActiveMission } from './chapter-two.js';

export interface Courier {
  id: string;
  name: string;
  landmark: string;
  zone: ZoneId;
  /** The mission this courier hints at. */
  missionId: string;
  /** One-line rumour shown in the quest log before the scene is opened. */
  rumour: string;
  nodes: DialogueNode[];
  startId: string;
  endId: string;
}

export const PARTITION_COURIERS: Courier[] = [
  {
    id: 'courier-voss',
    name: 'Intake Clerk Voss',
    landmark: 'Ashfall Exchange',
    zone: 'volcano',
    missionId: 'partition-dead-air',
    rumour: 'The Exchange clerk says the booths stopped ringing and started writing things down.',
    nodes: [
      {
        id: 'voss-0',
        speaker: 'Intake Clerk Voss',
        text: 'Switchboard is quiet. Too quiet. The slots still take a shard, but nobody calls anymore — they log.',
        options: [
          { label: '"Log what?"', next: 'voss-1' },
          { label: '(Skip.)', next: 'voss-end' },
        ],
      },
      {
        id: 'voss-1',
        speaker: 'Intake Clerk Voss',
        text: 'Carriers. Three of them went dark on the booth line out of the caldera. I marked them on the route sheet.',
        options: [
          { label: '"Where are the marks?"', next: 'voss-2' },
          { label: '(Skip.)', next: 'voss-end' },
        ],
      },
      {
        id: 'voss-2',
        speaker: 'Intake Clerk Voss',
        text: 'Follow the line west out of the Exchange. Three dead carriers. Put a boot on each and the register will know you walked it.',
        options: [
          { label: '"Why does it need to know?"', next: 'voss-3' },
          { label: '(Skip.)', next: 'voss-end' },
        ],
      },
      {
        id: 'voss-3',
        speaker: 'Intake Clerk Voss',
        text: 'Because it is a ledger, and ledgers count. Do not ask what it counts. Walk the line and come back.',
        options: [
          { label: '(Take the route sheet.)', next: 'voss-end' },
          { label: '(Skip.)', next: 'voss-end' },
        ],
      },
      {
        id: 'voss-end',
        speaker: 'Intake Clerk Voss',
        text: 'Three carriers. That is the whole job. Keep the sheet — it is the only paper it cannot read.',
        options: [{ label: '(Leave.)', next: 'voss-end' }],
      },
    ],
    startId: 'voss-0',
    endId: 'voss-end',
  },
  {
    id: 'courier-munn',
    name: 'Tallies Munn',
    landmark: 'Flicker Kiosk Row',
    zone: 'meadow',
    missionId: 'partition-call-log',
    rumour: 'A tally-keeper at the kiosk row says the dead slots kept written logs behind the coin trays.',
    nodes: [
      {
        id: 'munn-0',
        speaker: 'Tallies Munn',
        text: 'You the one carrying her receiver? Then you will do the counting. The kiosks kept two books: coin, and calls.',
        options: [
          { label: '"What is in the second book?"', next: 'munn-1' },
          { label: '(Skip.)', next: 'munn-end' },
        ],
      },
      {
        id: 'munn-1',
        speaker: 'Tallies Munn',
        text: 'Shard-ledgers. Five of them, still under the dead tithe slots. Glass with a number cut into it.',
        options: [
          { label: '"Who cut the numbers?"', next: 'munn-2' },
          { label: '(Skip.)', next: 'munn-end' },
        ],
      },
      {
        id: 'munn-2',
        speaker: 'Tallies Munn',
        text: 'The relay did. It logged every call it could not place. Take the five. Leave the coin — the coin is not yours.',
        options: [
          { label: '"And the numbers?"', next: 'munn-3' },
          { label: '(Skip.)', next: 'munn-end' },
        ],
      },
      {
        id: 'munn-3',
        speaker: 'Tallies Munn',
        text: 'Read them later. Right now just recover five. The Meridian surveyors will tell you what they mean.',
        options: [
          { label: '(Pocket the tray key.)', next: 'munn-end' },
          { label: '(Skip.)', next: 'munn-end' },
        ],
      },
      {
        id: 'munn-end',
        speaker: 'Tallies Munn',
        text: 'Five ledgers. Bring them intact — a cracked one loses its number, and a lost number is someone lost twice.',
        options: [{ label: '(Leave.)', next: 'munn-end' }],
      },
    ],
    startId: 'munn-0',
    endId: 'munn-end',
  },
  {
    id: 'courier-idda',
    name: 'Surveyor Idda',
    landmark: 'Glass Meridian',
    zone: 'dungeon',
    missionId: 'partition-glass-register',
    rumour: 'The Meridian surveyor says the old points are singing with a second voice underneath.',
    nodes: [
      {
        id: 'idda-0',
        speaker: 'Surveyor Idda',
        text: 'Maren taught me this line. I know what it should sound like. There is another voice under the glass now.',
        options: [
          { label: '"What kind of voice?"', next: 'idda-1' },
          { label: '(Skip.)', next: 'idda-end' },
        ],
      },
      {
        id: 'idda-1',
        speaker: 'Surveyor Idda',
        text: 'Not a person. An index. It surfaced six husks along the survey points when your relay went quiet.',
        options: [
          { label: '"Husks?"', next: 'idda-2' },
          { label: '(Skip.)', next: 'idda-end' },
        ],
      },
      {
        id: 'idda-2',
        speaker: 'Surveyor Idda',
        text: 'Bodies made of old ledger glass. They walk the points and repeat the names they are holding. Clear six off the line.',
        options: [
          { label: '"What happens if they reach the arcade?"', next: 'idda-3' },
          { label: '(Skip.)', next: 'idda-end' },
        ],
      },
      {
        id: 'idda-3',
        speaker: 'Surveyor Idda',
        text: 'Then the drowned archive gets its register and this line stops being a survey. Six. Do it on the points, not in the moss.',
        options: [
          { label: '(Take the pole.)', next: 'idda-end' },
          { label: '(Skip.)', next: 'idda-end' },
        ],
      },
      {
        id: 'idda-end',
        speaker: 'Surveyor Idda',
        text: 'Six husks. When the glass sings clean again, come back — I will mark the down point for you.',
        options: [{ label: '(Leave.)', next: 'idda-end' }],
      },
    ],
    startId: 'idda-0',
    endId: 'idda-end',
  },
  {
    id: 'courier-corren',
    name: 'Diver Corren',
    landmark: 'Sunken Arcade',
    zone: 'dungeon',
    missionId: 'partition-sunken-archive',
    rumour: 'A diver at the drowned arcade says four dry pillars stand under the water with numbers cut in them.',
    nodes: [
      {
        id: 'corren-0',
        speaker: 'Diver Corren',
        text: 'Arcade is drowned standing up. Four pillars stayed dry — the water goes around them, not over.',
        options: [
          { label: '"Why?"', next: 'corren-1' },
          { label: '(Skip.)', next: 'corren-end' },
        ],
      },
      {
        id: 'corren-1',
        speaker: 'Diver Corren',
        text: 'They are not pillars. They are index anchors. Each one holds a slice of the list the Collator cannot finish.',
        options: [
          { label: '"What do I do at them?"', next: 'corren-2' },
          { label: '(Skip.)', next: 'corren-end' },
        ],
      },
      {
        id: 'corren-2',
        speaker: 'Diver Corren',
        text: 'Stand there. Let it read your boots. Four points, dry side, in any order — it only cares that all four were walked.',
        options: [
          { label: '"Is the water safe?"', next: 'corren-3' },
          { label: '(Skip.)', next: 'corren-end' },
        ],
      },
      {
        id: 'corren-3',
        speaker: 'Diver Corren',
        text: 'Safe as any drowned market. Keep to the stalls that still have a floor. The pillars do not move; the rest of the arcade does.',
        options: [
          { label: '(Take a lamp.)', next: 'corren-end' },
          { label: '(Skip.)', next: 'corren-end' },
        ],
      },
      {
        id: 'corren-end',
        speaker: 'Diver Corren',
        text: 'Four pillars. Come back up breathing and the register will be complete enough to take to the Exchange.',
        options: [{ label: '(Leave.)', next: 'corren-end' }],
      },
    ],
    startId: 'corren-0',
    endId: 'corren-end',
  },
  {
    id: 'courier-pell',
    name: 'Switchboard Aide Pell',
    landmark: 'Brazen Porch',
    zone: 'meadow',
    missionId: 'partition-custody',
    rumour: 'A switchboard aide at the Brazen Porch says the Exchange wants one carrier for the whole ledger.',
    nodes: [
      {
        id: 'pell-0',
        speaker: 'Switchboard Aide Pell',
        text: 'You have come a long way with that receiver. The Collator noticed. It wants the slices back in one pair of hands.',
        options: [
          { label: '"Why mine?"', next: 'pell-1' },
          { label: '(Skip.)', next: 'pell-end' },
        ],
      },
      {
        id: 'pell-1',
        speaker: 'Switchboard Aide Pell',
        text: 'Because you are the lock now. Wren held the partitions apart for years. You took the key without knowing what it did.',
        options: [
          { label: '"What does it do?"', next: 'pell-2' },
          { label: '(Skip.)', next: 'pell-end' },
        ],
      },
      {
        id: 'pell-2',
        speaker: 'Switchboard Aide Pell',
        text: 'It decides whether the list stays four pieces or becomes one. Maren split it because the finished list names the dead.',
        options: [
          { label: '"And the wards?"', next: 'pell-3' },
          { label: '(Skip.)', next: 'pell-end' },
        ],
      },
      {
        id: 'pell-3',
        speaker: 'Switchboard Aide Pell',
        text: 'Eight of them guard the Exchange switchboard. Clear them, go in, and tell the ledger no. That is custody.',
        options: [
          { label: '(Take the porch key.)', next: 'pell-end' },
          { label: '(Skip.)', next: 'pell-end' },
        ],
      },
      {
        id: 'pell-end',
        speaker: 'Switchboard Aide Pell',
        text: 'Eight wards. Then the switchboard. Keep the pieces apart — that is the whole of the job, and it is enough.',
        options: [{ label: '(Leave.)', next: 'pell-end' }],
      },
    ],
    startId: 'pell-0',
    endId: 'pell-end',
  },
];

/**
 * Mission-5 reveal at the Exchange switchboard. The Collator explains the
 * twist: Wren was the human lock, the first four STATIC calls were the index
 * speaking in her learned voice, and Maren partitioned it deliberately.
 * Five lines, skippable, same walker as every other scene.
 */
export const PARTITION_REVEAL_NODES: DialogueNode[] = [
  {
    id: 'partition-reveal-0',
    speaker: 'The Collator',
    text: 'You carried the key without reading it. That is why it opened for you.',
    options: [
      { label: '"Who are you?"', next: 'partition-reveal-1' },
      { label: '(Skip.)', next: 'partition-reveal-end' },
    ],
  },
  {
    id: 'partition-reveal-1',
    speaker: 'The Collator',
    text: 'I am the Ledger. Maren built me to map the Fall. When the map filled with the dead, she split me across the booths and put a human lock on the last key.',
    options: [
      { label: '"Wren was the lock."', next: 'partition-reveal-2' },
      { label: '(Skip.)', next: 'partition-reveal-end' },
    ],
  },
  {
    id: 'partition-reveal-2',
    speaker: 'The Collator',
    text: 'She was. Her logs taught me how she sounded. The first four calls were mine in her voice. She only reached the line after you cleared the Exchange.',
    options: [
      { label: '"Why tell me this now?"', next: 'partition-reveal-3' },
      { label: '(Skip.)', next: 'partition-reveal-end' },
    ],
  },
  {
    id: 'partition-reveal-3',
    speaker: 'The Collator',
    text: 'Because a lock that knows what it guards can refuse. Hold the pieces apart. Do not let the list finish.',
    options: [
      { label: '(Take custody.)', next: 'partition-reveal-end' },
      { label: '(Skip.)', next: 'partition-reveal-end' },
    ],
  },
  {
    id: 'partition-reveal-end',
    speaker: 'Wren Halloway',
    text: 'You are Warden of the Quiet now. Keep the count. Do not finish it — that is what the receiver was for.',
    options: [{ label: '(Leave.)', next: 'partition-reveal-end' }],
  },
];

/** Every PARTITION dialogue node in one registry (couriers + twist reveal). */
export const PARTITION_DIALOGUE_NODES: DialogueNode[] = [
  ...PARTITION_COURIERS.flatMap((c) => c.nodes),
  ...PARTITION_REVEAL_NODES,
];

export function openPartitionReveal(playerName = 'traveler'): StaticSceneDialogue {
  const nodes = PARTITION_REVEAL_NODES;
  return new StaticSceneDialogue(nodes, nodes[0]!.id, nodes[nodes.length - 1]!.id, playerName);
}

export function courierById(id: string): Courier | undefined {
  return PARTITION_COURIERS.find((c) => c.id === id);
}

export function courierForMission(missionId: string): Courier | undefined {
  return PARTITION_COURIERS.find((c) => c.missionId === missionId);
}

export function couriersInOrder(): Courier[] {
  return [...PARTITION_COURIERS];
}

/**
 * Couriers click in when STATIC is done (the chapter gate opens) and go quiet
 * once their own mission is complete. Until then the booths carry only static.
 */
export function couriersAvailable(state: QuestState): Courier[] {
  if (!isStaticChapterDone(state)) return [];
  return PARTITION_COURIERS.filter((c) => !state.progress[c.missionId]?.done);
}

/** The courier who hints the current active mission, or null if none. */
export function nextCourierHint(state: QuestState): Courier | null {
  if (!isStaticChapterDone(state)) return null;
  const active = partitionActiveMission(state);
  return active ? courierForMission(active.id) ?? null : null;
}

/** Reuse the existing scene walker — no new dialogue engine. */
export function openCourierDialogue(courierId: string, playerName = 'traveler'): StaticSceneDialogue | null {
  const c = courierById(courierId);
  if (!c) return null;
  return new StaticSceneDialogue(c.nodes, c.startId, c.endId, playerName);
}
