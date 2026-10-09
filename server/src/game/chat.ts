// @aetherfall/gameplay — chat: channels global/guild/say + 1/sec rate limit + profanity stub.
// Channel names match shared protocol v1: 'global' | 'guild' | 'say'.

export type ChatChannel = 'global' | 'guild' | 'say';

export const CHAT_RATE_LIMIT_MS = 1000;
export const CHAT_MAX_LEN = 200;

const CHANNELS: ChatChannel[] = ['global', 'guild', 'say'];

export function isChannel(c: string): c is ChatChannel {
  return (CHANNELS as string[]).includes(c);
}

// Profanity stub: tiny built-in list + pluggable extra words.
// Real moderation (ML/regex service) can replace maskText() later.
const BASE_BAD_WORDS = ['badword', 'curse', 'slur1'];

const extraBad = new Set<string>();

export function addBannedWords(words: string[]): void {
  for (const w of words) extraBad.add(w.toLowerCase());
}

export function _resetBannedWords(): void {
  extraBad.clear();
}

function allBadWords(): string[] {
  return [...BASE_BAD_WORDS, ...extraBad];
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Replace whole-word profanity with asterisks (case-insensitive). Stub. */
export function maskText(text: string): string {
  let out = text;
  for (const w of allBadWords()) {
    if (!w) continue;
    out = out.replace(new RegExp(`\\b${escapeRegExp(w)}\\b`, 'gi'), '*'.repeat(w.length));
  }
  return out;
}

export type ChatIn = { from: string; text: string; channel: ChatChannel };
export type ChatOut = { from: string; text: string; channel: ChatChannel };

/** Validate + sanitize an outgoing message. Returns null when rejected. */
export function sanitizeChat(m: ChatIn): ChatOut | null {
  if (!isChannel(m.channel)) return null;
  const from = m.from.slice(0, 16);
  if (from.length === 0) return null;
  const text = maskText(m.text.slice(0, CHAT_MAX_LEN)).trim();
  if (text.length === 0) return null;
  return { from, text, channel: m.channel };
}

export class ChatRateLimiter {
  private last = new Map<number | string, number>();

  /** 1 msg/sec per sender. Returns true if allowed (and records), false if limited. */
  trySend(sender: number | string, now: number): boolean {
    const prev = this.last.get(sender) ?? -Infinity;
    if (now - prev < CHAT_RATE_LIMIT_MS) return false;
    this.last.set(sender, now);
    return true;
  }

  /** Test helper: clear one sender or all. */
  reset(sender?: number | string): void {
    if (sender === undefined) this.last.clear();
    else this.last.delete(sender);
  }
}
