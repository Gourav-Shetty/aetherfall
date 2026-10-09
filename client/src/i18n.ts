// AETHERFALL client — i18n runtime.
//
// Layered on top of locales/*.ts:
//
//   1. `Catalog` typing makes every locale compile-time complete: a missing key
//      in tr/de/es is a tsc error. i18n.test.ts re-checks the same invariant at
//      runtime (plus placeholder parity), so a bad hand-edit cannot slip past.
//   2. `t()` resolves a key through a per-locale fallback chain
//      (exact -> base language -> regional -> English -> the key itself).
//   3. `translateServerText()` maps authored content that arrives over the wire
//      as raw English (Elder Maren dialogue, chat system lines, item/boss/mob
//      names) onto a catalog key via SERVER_TEXT_INDEX, so it can be localized
//      client-side. See docs/A11Y.md "Known gaps" for the limits of this:
//      templated lines ("{name} joined") and player-authored chat are matched
//      with patterns, and anything outside the index passes through untranslated.
//
// The active locale is persisted in localStorage ('af_locale_v1') and broadcast
// to subscribers so the HUD + a11y panel re-render live. No DOM access here —
// a11y.ts owns the wiring — which keeps this module unit-testable headless.

import { catalog as en, SERVER_TEXT_INDEX } from './locales/en.js';
import { catalog as tr } from './locales/tr.js';
import { catalog as de } from './locales/de.js';
import { catalog as es } from './locales/es.js';

/** Every key the client knows about. `keyof typeof en` = the English catalog. */
export type MessageKey = keyof typeof en;

/** A locale's messages. Typed against the English key set, so it is total. */
export type Catalog = Record<MessageKey, string>;

export const LOCALES = ['en', 'tr', 'de', 'es'] as const;
export type Locale = (typeof LOCALES)[number];

/** Locale used when nothing else matches. English is the authored language. */
export const DEFAULT_LOCALE: Locale = 'en';

/** Endonyms — a language picker shows these in the user's own language. */
export const LOCALE_NAMES: Record<Locale, string> = {
  en: 'English',
  tr: 'Türkçe',
  de: 'Deutsch',
  es: 'Español',
};

const CATALOGS: Record<Locale, Catalog> = { en, tr, de, es };

/** localStorage key for the persisted locale. */
export const LOCALE_STORAGE_KEY = 'af_locale_v1';

export function isLocale(v: unknown): v is Locale {
  return typeof v === 'string' && (LOCALES as readonly string[]).includes(v);
}

/**
 * Normalize a free-form language tag onto a supported locale.
 * 'tr-TR' -> 'tr'; 'de-AT' -> 'de'; 'fr' -> null (caller keeps current).
 */
export function normalizeLocale(raw: unknown): Locale | null {
  if (isLocale(raw)) return raw;
  if (typeof raw !== 'string') return null;
  const base = raw.trim().toLowerCase().replace(/_/g, '-').split('-')[0];
  return isLocale(base) ? base : null;
}

/**
 * Fallback chain for a locale, most specific first, always ending in English.
 * e.g. tr -> ['tr', 'en']. Kept explicit (rather than a generic base-strip) so
 * the resolution order is a documented, testable contract.
 */
export function fallbackChain(locale: Locale): Locale[] {
  return locale === DEFAULT_LOCALE ? [DEFAULT_LOCALE] : [locale, DEFAULT_LOCALE];
}

/** Placeholder names in a template, in first-appearance order. */
export function placeholders(template: string): string[] {
  const out: string[] = [];
  const re = /\{(\w+)\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(template)) !== null) if (!out.includes(m[1]!)) out.push(m[1]!);
  return out;
}

/** Substitute {name}-style placeholders. Unknown names are left untouched. */
export function format(template: string, params?: Record<string, string | number>): string {
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (whole, key: string) => {
    const v = params[key];
    return v === undefined || v === null ? whole : String(v);
  });
}

/**
 * Pure translator. Falls back through `fallbackChain(locale)`, then returns the
 * key itself so a missing string is visible rather than blank.
 */
export function translate(
  locale: Locale,
  key: MessageKey,
  params?: Record<string, string | number>,
): string {
  for (const l of fallbackChain(locale)) {
    const hit = CATALOGS[l][key];
    if (typeof hit === 'string') return format(hit, params);
  }
  return key;
}

/** Every key in the English catalog (the completeness reference set). */
export function allKeys(): MessageKey[] {
  return Object.keys(en) as MessageKey[];
}

/** Runtime completeness + placeholder audit, used by tests and the a11y panel. */
export function auditLocale(locale: Locale): { missing: MessageKey[]; extra: string[]; placeholderMismatch: MessageKey[] } {
  const ref = en as Record<string, string>;
  const cat = CATALOGS[locale] as unknown as Record<string, string>;
  const missing: MessageKey[] = [];
  const extra: string[] = [];
  const placeholderMismatch: MessageKey[] = [];
  for (const k of allKeys()) {
    const v = cat[k];
    if (v === undefined) {
      if (locale !== DEFAULT_LOCALE) missing.push(k);
      continue;
    }
    const want = placeholders(ref[k]!).slice().sort().join(',');
    const got = placeholders(v).slice().sort().join(',');
    if (want !== got) placeholderMismatch.push(k);
  }
  for (const k of Object.keys(cat)) {
    if (!(k in ref)) extra.push(k);
  }
  return { missing, extra, placeholderMismatch };
}

// --------------------------------------------------------------------------
// Server / authored prose → catalog keys
// --------------------------------------------------------------------------

/**
 * Pattern rules for templated server lines. Keys are looked up against
 * SERVER_TEXT_INDEX so the pattern's canonical English form stays in one place.
 * `re` must capture the variable parts as named groups matching the placeholders
 * in the mapped template.
 */
const SERVER_PATTERNS: Array<{ re: RegExp; key: MessageKey }> = [
  // server/src/index.ts: broadcastGlobal('server', `${p.name} joined`, pid)
  { re: /^(.+?) joined$/, key: 'srv.chat.joined' },
  // net.ts client-side: onChat('system', 'disconnected — reload to rejoin')
  { re: /^Redirecting to shard (\S+)$/, key: 'srv.chat.redirect' },
  { re: /^Queued — position (\d+)(?:\/(\d+))?$/, key: 'srv.chat.queue' },
  { re: /^Kicked: (.+)$/, key: 'srv.chat.kicked' },
  // main.ts kill feed
  { re: /^(.+?) slain$/, key: 'srv.kill.slain' },
  { re: /^(.+?) has fallen$/, key: 'srv.kill.fallen' },
  { re: /^(.+?) rose again at the shrine$/, key: 'srv.kill.rose' },
  { re: /^(.+?) felled$/, key: 'srv.kill.boss' },
  { re: /^Quest complete: (.+)$/, key: 'srv.kill.quest' },
  { re: /^looted (.+)$/, key: 'srv.kill.looted' },
  // HUD quest title: "Ward-Spark (1/3)" with an optional active marker.
  { re: /^(?:▶\s*)?(.+?) \((\d+)\/(\d+)\)$/, key: 'srv.quest.progress' },
];

/**
 * Translate a raw English string that came from the server or from a local
 * string builder.
 *
 * Resolution order:
 *   1. exact match in SERVER_TEXT_INDEX (dialogue nodes, items, bosses, ...)
 *   2. pattern rules for templated lines ("<name> joined", "<name> slain", ...)
 *   3. the composed Elder Maren wire format `<node text> 1. <opt> 2. <opt>`
 *   4. the raw string, unchanged
 *
 * Anything unrecognised passes through in English — see docs/A11Y.md.
 */
export function translateServerText(locale: Locale, raw: string): string {
  const text = raw.trim();
  if (!text) return raw;

  // 3. Composed dialogue: server appends "1. label 2. label" to the node text.
  const composed = translateComposedDialogue(locale, text);
  if (composed !== null) return composed;

  // 1. Exact index hit.
  const exactKey = SERVER_TEXT_INDEX[text];
  if (exactKey) return translate(locale, exactKey as MessageKey);

  // 2. Templated line: match by shape, then map captured groups onto the
  //    template's placeholders in first-appearance order.
  for (const rule of SERVER_PATTERNS) {
    const m = rule.re.exec(text);
    if (!m) continue;
    const params: Record<string, string> = {};
    const names = placeholders(en[rule.key]);
    names.forEach((n, i) => {
      const v = m[i + 1];
      if (v === undefined) return;
      // Captures are themselves authored prose ("<name> slain" where <name> is
      // "Ember Wyrm"), so localize them too — otherwise a translated template
      // ends up half English. `raw` preserves the untranslated form.
      params[n] = n === 'raw' ? v : translateServerText(locale, v);
    });
    return translate(locale, rule.key, params);
  }
  return raw;
}

/**
 * Handle Elder Maren's wire format: `${node.text} ${opts}` where opts is
 * "1. label 2. label" (server/src/index.ts, `@maren` branch). Each part is
 * translated on its own. Returns null when the string is not in that shape.
 */
function translateComposedDialogue(locale: Locale, text: string): string | null {
  // Trailing "N. label" runs. Scan with the match index recorded so the node
  // text is sliced precisely (indexOf on the label would break if the label
  // text also occurred inside the node text).
  const optRe = /(\d+)\.\s+([^0-9]+?)(?=\s+\d+\.\s+|$)/g;
  const parts: Array<{ n: string; label: string }> = [];
  let firstIndex = -1;
  let m: RegExpExecArray | null;
  while ((m = optRe.exec(text)) !== null) {
    if (firstIndex < 0) firstIndex = m.index;
    parts.push({ n: m[1]!, label: m[2]!.trim() });
  }
  if (parts.length === 0) return null;
  // Require the numbered run to start at 1 and be contiguous.
  if (parts[0]!.n !== '1') return null;
  parts.forEach((p, i) => {
    if (p.n !== String(i + 1)) throw new Error('i18n: non-contiguous dialogue options');
  });
  const head = text.slice(0, firstIndex).trim();
  const headKey = SERVER_TEXT_INDEX[head];
  if (!headKey) return null;
  const opts = parts
    .map((p) => translate(locale, 'srv.dialogue.option', {
      n: p.n,
      label: translateServerText(locale, p.label),
    }))
    .join(' ');
  return `${translate(locale, headKey as MessageKey)} ${opts}`;
}

/** Translate a possibly-templated server line (announcement helper). */
export function translateServerTemplate(
  locale: Locale,
  key: MessageKey,
  params?: Record<string, string | number>,
): string {
  return translate(locale, key, params);
}

/**
 * Test seam for the composed-dialogue branch (returns null when the string is
 * not in the `<node text> 1. <opt>` shape, instead of falling through).
 */
export function translateComposedDialogueForTest(locale: Locale, text: string): string | null {
  return translateComposedDialogue(locale, text);
}

// --------------------------------------------------------------------------
// Reactive locale store (localStorage-backed, no DOM)
// --------------------------------------------------------------------------

type Listener = (locale: Locale) => void;

/** Minimal localStorage surface so tests can inject a fake without a DOM. */
export interface StorageLike {
  getItem(k: string): string | null;
  setItem(k: string, v: string): void;
  removeItem(k: string): void;
}

function safeStorage(): StorageLike | null {
  try {
    const s = (globalThis as { localStorage?: StorageLike }).localStorage;
    return s ?? null;
  } catch {
    return null; // private mode / blocked storage
  }
}

/**
 * Runtime locale holder. Persisted, subscribable, and safe to construct without
 * a DOM (main.ts and a11y.ts both hold one; tests use throwaway instances).
 */
export class I18n {
  private locale: Locale = DEFAULT_LOCALE;
  private listeners = new Set<Listener>();
  private storage: StorageLike | null;

  constructor(storage: StorageLike | null = safeStorage(), initial?: Locale) {
    this.storage = storage;
    const stored = this.readStored();
    this.locale = initial ?? stored ?? DEFAULT_LOCALE;
  }

  private readStored(): Locale | null {
    try {
      return normalizeLocale(this.storage?.getItem(LOCALE_STORAGE_KEY));
    } catch {
      return null;
    }
  }

  /** Current locale. */
  getLocale(): Locale {
    return this.locale;
  }

  /** True when `locale` is the active one. */
  isActive(locale: Locale): boolean {
    return this.locale === locale;
  }

  /** Switch locale. No-op (and no notify) when already active. */
  setLocale(locale: Locale): void {
    if (!isLocale(locale) || this.locale === locale) return;
    this.locale = locale;
    try {
      this.storage?.setItem(LOCALE_STORAGE_KEY, locale);
    } catch {
      /* storage full or blocked — locale still applies for this session */
    }
    for (const fn of this.listeners) {
      try {
        fn(locale);
      } catch {
        /* one bad subscriber must not block the rest */
      }
    }
  }

  /** Subscribe to locale changes; returns an unsubscribe function. */
  onChange(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** Resolve a key in the active locale. */
  t(key: MessageKey, params?: Record<string, string | number>): string {
    return translate(this.locale, key, params);
  }

  /** Translate raw server prose in the active locale. */
  tServer(raw: string): string {
    return translateServerText(this.locale, raw);
  }
}

/** Process-wide instance used by the HUD and the a11y panel. */
export const i18n = new I18n();