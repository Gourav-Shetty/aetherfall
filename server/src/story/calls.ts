// AETHERFALL story — Chapter "STATIC" voicemail calls.
//
// Five voicemail-style messages from "UNKNOWN NUMBER", one per mission, plus
// the mission-5 twist reveal. All copy is ORIGINAL neon-noir written for
// AETHERFALL (the Fall, shards, ward-stones, Elder Maren). Nothing is copied
// from any other work; only the delivery shape (cryptic call -> job) nods to
// the genre.
//
// Protocol-safe: plain data only. The phone-booth UI (client) renders these;
// the server never sends new netcode kinds for them — mission progress still
// flows through the existing `quest-progress` / `quest-complete` events.

import { STATIC_CALLER_IDENTITY } from './chapter.js';

export const UNKNOWN_CALLER = 'UNKNOWN NUMBER';

export interface StaticCall {
  missionId: string;
  seq: number;
  from: string;
  subject: string;
  /** Voicemail body, read top to bottom in the booth. */
  lines: string[];
  /** Booth metadata (flavor only). */
  durationSec: number;
  signal: string;
  landmark: string;
}

export const STATIC_CALLS: StaticCall[] = [
  {
    missionId: 'static-porchlight',
    seq: 1,
    from: UNKNOWN_CALLER,
    subject: 'MSG 01 — PORCHLIGHT (1:12, cutting in and out)',
    lines: [
      '— click — hiss — "Do not say your name. The line remembers names."',
      '"South gate. Brazen Porch. The ward-stones went dark and something nested in the glow they left."',
      '"Four of them. Quiet work. No torches — the shards hear torches."',
      '"When the porch burns blue again, lift any receiver. I will know. I always know."',
      '— dial tone, then rain —',
    ],
    durationSec: 72,
    signal: 'weak // ward-line bleed',
    landmark: 'Brazen Porch',
  },
  {
    missionId: 'static-kiosk',
    seq: 2,
    from: UNKNOWN_CALLER,
    subject: 'MSG 02 — KIOSK TITHE (0:58, clearer, close to the mic)',
    lines: [
      '— coins falling, somewhere far off — "Good. You pick up. Most do not."',
      '"Flicker Kiosk Row. The dead booths ate my tithe when the Fall came — six ember-shards, still in their slots."',
      '"Prise them out. The booths bite, so bring cloth. Do not spend them. Bring them to the static."',
      '"Six. Count them on the line so I can hear the glass."',
      '— a breath, held too long —',
    ],
    durationSec: 58,
    signal: 'fair // kiosk-row echo',
    landmark: 'Flicker Kiosk Row',
  },
  {
    missionId: 'static-arcade',
    seq: 3,
    from: UNKNOWN_CALLER,
    subject: 'MSG 03 — ARCADE SWEEP (1:31, water dripping behind the voice)',
    lines: [
      '— dripping water, a distant bell — "You are being followed. Not by me. Walk faster."',
      '"Sunken Arcade, under the Deep. The stalls drowned standing up and the delvers moved into the dry spots."',
      '"Six. Sweep them out of the arcade the way you would sweep glass off a counter."',
      '"Someone will offer you coin to stop. Do not stop. Coin spends. Echoes keep."',
      '— the bell again, closer —',
    ],
    durationSec: 91,
    signal: 'fair // hollow-deep reverb',
    landmark: 'Sunken Arcade',
  },
  {
    missionId: 'static-meridian',
    seq: 4,
    from: UNKNOWN_CALLER,
    subject: 'MSG 04 — MERIDIAN WALK (1:05, wind, glass humming)',
    lines: [
      '— wind across glass — "This one is walking, not killing. Do you remember how?"',
      '"Glass Meridian. Maren\'s old survey line, past the highlands. Four points still sing when you stand on them."',
      '"Stand on all four. Let the map-table hear your boots. Then come back to the booths."',
      '"One message left after this. I am counting the same as you."',
      '— humming fades as if a hand covered the mic —',
    ],
    durationSec: 65,
    signal: 'strong // meridian resonance',
    landmark: 'Glass Meridian',
  },
  {
    missionId: 'static-exchange',
    seq: 5,
    from: UNKNOWN_CALLER,
    subject: 'MSG 05 — EXCHANGE SILENCE (2:04, clear at last)',
    lines: [
      '— no hiss. A room. A chair scraping. — "No more booths after this. Come to the Ashfall Exchange."',
      '"Eight horrors nest in my relay hall, fat on shard-heat. Silence them, and the static ends."',
      `"${STATIC_CALLER_IDENTITY.revealLine}"`,
      '"Maren told you the stones went dark. She never told you who she left holding the switchboard."',
      '"Finish it, and take my receiver with you. Wear it. Let Emberfall stare. — Wren."',
      '— the line stays open. She is waiting. —',
    ],
    durationSec: 124,
    signal: 'clear // exchange direct',
    landmark: 'Ashfall Exchange',
  },
];

export function callForMission(missionId: string): StaticCall | undefined {
  return STATIC_CALLS.find((c) => c.missionId === missionId);
}

export function callsInOrder(): StaticCall[] {
  return [...STATIC_CALLS].sort((a, b) => a.seq - b.seq);
}

/** Missions 1..4 hide the caller; mission 5 names her. */
export function isTwistCall(missionId: string): boolean {
  return missionId === 'static-exchange';
}

/** Every pre-twist call must read as anonymous; the twist must name the caller. */
export function callerShownIn(call: StaticCall): string {
  return isTwistCall(call.missionId) ? STATIC_CALLER_IDENTITY.name : UNKNOWN_CALLER;
}
