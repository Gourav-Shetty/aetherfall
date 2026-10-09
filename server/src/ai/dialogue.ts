// AETHERFALL AI — quest-giver dialogue.
// Rule-based tree (deterministic, works offline) with an optional LLM
// flavor hook: if Ollama is reachable at http://localhost:11434 it
// rephrases the node's line; otherwise the local text is used verbatim.
// The hook never blocks gameplay — short timeout, fallback on any error.

export type QuestStage = 'not-started' | 'offered' | 'accepted' | 'complete';

export interface DialogueOption {
  label: string;
  next: string;
  /** quest stage to set when this option is picked */
  setQuest?: QuestStage;
}

export interface DialogueNode {
  id: string;
  speaker: string;
  text: string;
  options: DialogueOption[];
  /** static quest requirement to even see this node (via freeform) */
  questStage?: QuestStage;
}

export interface DialogueState {
  nodeId: string;
  quest: QuestStage;
  playerName: string;
}

/** Elder Maren's "Shattered Ward" errand — the starter quest chain. */
export const ELDER_MAREN_NODES: DialogueNode[] = [
  {
    id: 'greeting',
    speaker: 'Elder Maren',
    text: 'Traveler. The ward-stones south of the gate have gone dark, and gloomfangs nest in the brush. Will you help Emberfall?',
    options: [
      { label: 'Tell me about the ward-stones. (quest)', next: 'quest_offer', setQuest: 'offered' },
      { label: 'What do I get for helping? (reward)', next: 'reward' },
      { label: 'Farewell. (bye)', next: 'bye' },
    ],
  },
  {
    id: 'quest_offer',
    speaker: 'Elder Maren',
    text: 'Three ward-stones line the old road. Touch each one to rekindle it, and drive off the gloomfangs that gather near. Return to me when the road burns blue again.',
    options: [
      { label: 'I accept. (yes)', next: 'accepted', setQuest: 'accepted' },
      { label: 'Not right now. (no)', next: 'greeting' },
      { label: 'Where exactly? (where)', next: 'where' },
    ],
  },
  {
    id: 'where',
    speaker: 'Elder Maren',
    text: 'Follow the old road south past the gate — you will see their cold sockets glowing faintly. Stay on the path; the brush beyond the second stone is thick with fangs.',
    options: [
      { label: 'I accept. (yes)', next: 'accepted', setQuest: 'accepted' },
      { label: 'Back. (bye)', next: 'greeting' },
    ],
  },
  {
    id: 'reward',
    speaker: 'Elder Maren',
    text: 'A ward-forged blade from the armory, and Emberfall remembers its friends. The merchants will trade fair with one who carries my token.',
    options: [
      { label: 'Tell me about the ward-stones. (quest)', next: 'quest_offer', setQuest: 'offered' },
      { label: 'Farewell. (bye)', next: 'bye' },
    ],
  },
  {
    id: 'accepted',
    speaker: 'Elder Maren',
    text: 'Good. The stones wait south of the gate. Come back when all three burn blue — say "done" and I will know you by the light you carry.',
    options: [
      { label: 'Where exactly? (where)', next: 'where' },
      { label: 'Farewell. (bye)', next: 'bye' },
    ],
  },
  {
    id: 'done_check',
    speaker: 'Elder Maren',
    text: 'The road burns blue! You have done what three patrols could not. Take the ward-blade — and my thanks.',
    options: [{ label: 'Thank you. (bye)', next: 'bye', setQuest: 'complete' }],
  },
  {
    id: 'not_done',
    speaker: 'Elder Maren',
    text: 'Not yet — the stones still sleep. South of the gate, traveler. Touch each ward-stone and drive back the gloomfangs.',
    options: [
      { label: 'Where exactly? (where)', next: 'where' },
      { label: 'Farewell. (bye)', next: 'bye' },
    ],
  },
  {
    id: 'bye',
    speaker: 'Elder Maren',
    text: 'Walk in the light, traveler.',
    options: [{ label: 'Greetings again. (hello)', next: 'greeting' }],
  },
  // --- quest-chain offers (hooks for content.ts QUEST_CHAIN) ---
  {
    id: 'ember_road',
    speaker: 'Elder Maren',
    text: 'The ward-stones woke, but their light is hungry. Bring me 5 ember-shards from the road — the merchants will pay, and so will I.',
    options: [
      { label: 'I will gather them. (yes)', next: 'accepted_ember', setQuest: 'accepted' },
      { label: 'What do the shards look like? (where)', next: 'where_shards' },
      { label: 'Back. (bye)', next: 'greeting' },
    ],
  },
  {
    id: 'where_shards',
    speaker: 'Elder Maren',
    text: 'Warm glass, glowing faintly blue at the edges. Gloomfangs hoard them in the brush — check the meadow south of the gate.',
    options: [
      { label: 'I will gather them. (yes)', next: 'accepted_ember', setQuest: 'accepted' },
      { label: 'Back. (bye)', next: 'greeting' },
    ],
  },
  {
    id: 'accepted_ember',
    speaker: 'Elder Maren',
    text: 'Five shards, traveler. Say "done" when your pack glows with them.',
    options: [
      { label: 'Where again? (where)', next: 'where_shards' },
      { label: 'Farewell. (bye)', next: 'bye' },
    ],
  },
  {
    id: 'deep_delvers',
    speaker: 'Elder Maren',
    text: 'The light reached the Hollow Deep — and woke what nests there. Cull 6 delvers: ashcrawlers, thornbacks, hollow-knights. Steel yourself first.',
    options: [
      { label: 'I accept. (yes)', next: 'accepted_deep', setQuest: 'accepted' },
      { label: 'Where is the Deep? (where)', next: 'where_deep' },
      { label: 'Back. (bye)', next: 'greeting' },
    ],
  },
  {
    id: 'where_deep',
    speaker: 'Elder Maren',
    text: 'North-east past the meadow, where grass gives way to moss and cracked stone. Their chitin turns blades — bring the ember-axe if you have it.',
    options: [
      { label: 'I accept. (yes)', next: 'accepted_deep', setQuest: 'accepted' },
      { label: 'Back. (bye)', next: 'greeting' },
    ],
  },
  {
    id: 'accepted_deep',
    speaker: 'Elder Maren',
    text: 'Six delvers. Come back breathing and I will know the Deep fears you.',
    options: [
      { label: 'Where again? (where)', next: 'where_deep' },
      { label: 'Farewell. (bye)', next: 'bye' },
    ],
  },
  {
    id: 'chart_fall',
    speaker: 'Elder Maren',
    text: 'Our maps end at the highlands. Chart 4 new tracts beyond them — walk far, walk wary, and the Fall will be yours on parchment.',
    options: [
      { label: 'I accept. (yes)', next: 'accepted_chart', setQuest: 'accepted' },
      { label: 'How do I chart? (where)', next: 'where_chart' },
      { label: 'Back. (bye)', next: 'greeting' },
    ],
  },
  {
    id: 'where_chart',
    speaker: 'Elder Maren',
    text: 'Just walk. Every new tract you set foot in sings back to my map-table. Four beyond the highlands — the ash on the wind means you are close.',
    options: [
      { label: 'I accept. (yes)', next: 'accepted_chart', setQuest: 'accepted' },
      { label: 'Back. (bye)', next: 'greeting' },
    ],
  },
  {
    id: 'accepted_chart',
    speaker: 'Elder Maren',
    text: 'Four new tracts. Say "done" when the map-table glows.',
    options: [
      { label: 'How again? (where)', next: 'where_chart' },
      { label: 'Farewell. (bye)', next: 'bye' },
    ],
  },
  {
    id: 'heart_fall',
    speaker: 'Elder Maren',
    text: 'Last, traveler, and hardest: the Ashfall Caldera. Fell 8 of its horrors and I will lay the Ward Blade itself in your hands.',
    options: [
      { label: 'I accept. (yes)', next: 'accepted_heart', setQuest: 'accepted' },
      { label: 'What waits there? (where)', next: 'where_heart' },
      { label: 'Back. (bye)', next: 'greeting' },
    ],
  },
  {
    id: 'where_heart',
    speaker: 'Elder Maren',
    text: 'Cinder-imps, wyrms, magma-golems — the mountain\'s fever dreams. Obsidian chips mark their nests. Take a greatsword\'s courage with you.',
    options: [
      { label: 'I accept. (yes)', next: 'accepted_heart', setQuest: 'accepted' },
      { label: 'Back. (bye)', next: 'greeting' },
    ],
  },
  {
    id: 'accepted_heart',
    speaker: 'Elder Maren',
    text: 'Eight horrors. When the caldera quiets, say "done" — and claim the Ward Blade.',
    options: [
      { label: 'What waits there? (where)', next: 'where_heart' },
      { label: 'Farewell. (bye)', next: 'bye' },
    ],
  },
];

/** Quest-chain -> Elder Maren dialogue node (mirrors content.ts QUEST_DIALOGUE). */
export const QUEST_DIALOGUE_NODES: Record<string, string> = {
  'ward-spark': 'quest_offer',
  'ember-road': 'ember_road',
  'deep-delvers': 'deep_delvers',
  'chart-the-fall': 'chart_fall',
  'heart-of-fall': 'heart_fall',
};

/** Chain order for the Maren quest line. */
export const MAREN_QUEST_ORDER: string[] = [
  'ward-spark',
  'ember-road',
  'deep-delvers',
  'chart-the-fall',
  'heart-of-fall',
];

/** Dialogue node id that offers `questId` (fallback: 'quest_offer'). */
export function dialogueNodeForQuest(questId: string): string {
  return QUEST_DIALOGUE_NODES[questId] ?? 'quest_offer';
}

export class QuestGiverDialogue {
  private nodes = new Map<string, DialogueNode>();
  state: DialogueState;

  constructor(playerName = 'traveler', nodes: DialogueNode[] = ELDER_MAREN_NODES) {
    for (const n of nodes) this.nodes.set(n.id, n);
    this.state = { nodeId: 'greeting', quest: 'not-started', playerName };
  }

  current(): DialogueNode {
    return this.nodes.get(this.state.nodeId) ?? this.nodes.get('greeting')!;
  }

  /** Pick option by index; applies quest effects, returns the next node. */
  choose(index: number): DialogueNode {
    const cur = this.current();
    const opt = cur.options[index];
    if (!opt) return cur;
    if (opt.setQuest) this.state.quest = opt.setQuest;
    this.state.nodeId = opt.next;
    return this.current();
  }

  /**
   * Rule-based freeform reply: keyword matching routes to a node.
   * `questFlagsDone` lets game code report objective completion
   * (all three ward-stones rekindled) for the "done" branch.
   */
  freeform(input: string, questFlagsDone = false): DialogueNode {
    const s = ` ${input.toLowerCase()} `;
    // Word-boundary matching: bare `includes('no')` would fire inside "know"/"another".
    const has = (...words: string[]) =>
      words.some((w) => s.includes(` ${w} `) || s.includes(` ${w},`) || s.includes(` ${w}.`) || s.includes(` ${w}!`) || s.includes(` ${w}?`));
    let next: string | null = null;

    if (has('bye', 'farewell', 'leave', 'goodbye')) next = 'bye';
    else if (has('done', 'finished', 'complete', 'rekindled', 'all three'))
      next = questFlagsDone ? 'done_check' : 'not_done';
    else if (has('yes', 'accept', 'i will', 'deal', 'ok')) {
      if (this.state.quest === 'complete') next = 'bye';
      else {
        this.state.quest = 'accepted';
        next = 'accepted';
      }
    } else if (has('no', 'decline', 'not now', 'later', 'refuse')) next = 'greeting';
    else if (has('ember', 'shard', 'shards')) next = 'ember_road';
    else if (has('deep', 'delve', 'delver', 'dungeon', 'knight', 'ashcrawler', 'highland')) next = 'deep_delvers';
    else if (has('chart', 'explore', 'survey', 'tract', 'parchment')) next = 'chart_fall';
    else if (has('heart', 'caldera', 'boss', 'wyrm', 'volcano', 'magma', 'cinder')) next = 'heart_fall';
    else if (has('where', 'location', 'south', 'direction', 'map', 'find')) next = 'where';
    else if (has('reward', 'pay', 'gold', 'blade', 'payment', 'get')) next = 'reward';
    else if (has('quest', 'job', 'work', 'help', 'ward', 'stone', 'gloomfang', 'mission', 'task'))
      next = 'quest_offer';
    else if (has('hello', 'hi', 'greet', 'hey')) next = 'greeting';

    if (
      (next === 'quest_offer' ||
        next === 'ember_road' ||
        next === 'deep_delvers' ||
        next === 'chart_fall' ||
        next === 'heart_fall') &&
      this.state.quest === 'not-started'
    )
      this.state.quest = 'offered';
    if (next === 'done_check') this.state.quest = 'complete';
    if (next) this.state.nodeId = next;
    return this.current();
  }
}

// ------------------------- optional Ollama flavor hook -------------------

const OLLAMA_URL = 'http://localhost:11434/api/generate';
const OLLAMA_MODEL = process.env.OLLAMA_MODEL ?? 'llama3.1';

/** True when a local Ollama daemon answers. Never throws. */
export async function isOllamaAvailable(timeoutMs = 600): Promise<boolean> {
  try {
    const res = await fetch('http://localhost:11434/api/tags', {
      signal: AbortSignal.timeout(timeoutMs),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Ask Ollama to rephrase an NPC line in-character. Returns `fallback`
 * on any failure (no daemon, timeout, bad response) — dialogue always
 * works offline.
 */
export async function generateFlavorLine(
  npcName: string,
  line: string,
  fallback: string = line,
  timeoutMs = 900,
): Promise<string> {
  try {
    const res = await fetch(OLLAMA_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: OLLAMA_MODEL,
        prompt: `You are ${npcName}, a quest-giving elder in a fantasy MMO. Rephrase this line in one sentence, staying in character, no quotes: ${line}`,
        stream: false,
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return fallback;
    const data = (await res.json()) as { response?: unknown };
    const text = typeof data.response === 'string' ? data.response.trim() : '';
    return text || fallback;
  } catch {
    return fallback;
  }
}
