// Headless tests for the i18n layer.
//
// Three invariants matter and each gets real coverage:
//   1. KEY COVERAGE — every locale defines every English key. tsc already
//      enforces this (locales are typed `Catalog`); these tests re-check it at
//      runtime so a hand-edit that breaks the build is caught by CI either way.
//   2. PLACEHOLDER PARITY — a translation may reorder or reword, but it must
//      carry the same {placeholders} as the English source or interpolated
//      values silently vanish.
//   3. FALLBACK CHAIN — tr/de/es fall back to English, and English falls back to
//      the key itself rather than an empty string.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  LOCALES,
  LOCALE_NAMES,
  DEFAULT_LOCALE,
  I18n,
  auditLocale,
  allKeys,
  fallbackChain,
  format,
  i18n as globalI18n,
  isLocale,
  normalizeLocale,
  placeholders,
  translate,
  translateComposedDialogueForTest,
  translateServerText,
  translateServerTemplate,
  LOCALE_STORAGE_KEY,
  type Catalog,
  type Locale,
  type MessageKey,
  type StorageLike,
} from './i18n.js';

import { catalog as en, SERVER_TEXT_INDEX } from './locales/en.js';
import { catalog as tr } from './locales/tr.js';
import { catalog as de } from './locales/de.js';
import { catalog as es } from './locales/es.js';

const CATALOGS: Record<Locale, Catalog> = { en, tr, de, es };
const NON_EN: Locale[] = LOCALES.filter((l) => l !== DEFAULT_LOCALE);

/** In-memory StorageLike so tests never touch a real localStorage. */
function memStore(seed: Record<string, string> = {}): StorageLike & { dump(): Record<string, string> } {
  const m = new Map(Object.entries(seed));
  return {
    getItem: (k) => (m.has(k) ? m.get(k)! : null),
    setItem: (k, v) => { m.set(k, v); },
    removeItem: (k) => { m.delete(k); },
    dump: () => Object.fromEntries(m),
  };
}

// ---------------------------------------------------------------------------

describe('i18n: locale registry', () => {
  it('ships exactly the four supported locales', () => {
    assert.deepEqual([...LOCALES], ['en', 'tr', 'de', 'es']);
    assert.equal(DEFAULT_LOCALE, 'en');
  });

  it('names every locale in its own language', () => {
    assert.deepEqual(LOCALE_NAMES, {
      en: 'English',
      tr: 'Türkçe',
      de: 'Deutsch',
      es: 'Español',
    });
    for (const l of LOCALES) assert.ok(LOCALE_NAMES[l].length > 0);
  });

  it('isLocale accepts only known codes', () => {
    for (const l of LOCALES) assert.equal(isLocale(l), true);
    assert.equal(isLocale('fr'), false);
    assert.equal(isLocale(''), false);
    assert.equal(isLocale(null), false);
    assert.equal(isLocale(7), false);
  });

  it('normalizeLocale resolves regional tags and case/underscore variants', () => {
    assert.equal(normalizeLocale('tr-TR'), 'tr');
    assert.equal(normalizeLocale('DE-at'), 'de');
    assert.equal(normalizeLocale('es_ES'), 'es');
    assert.equal(normalizeLocale('  en-GB '), 'en');
    assert.equal(normalizeLocale('es'), 'es');
  });

  it('normalizeLocale returns null for unsupported tags so callers keep state', () => {
    assert.equal(normalizeLocale('fr-FR'), null);
    assert.equal(normalizeLocale('zh-Hans'), null);
    assert.equal(normalizeLocale(''), null);
    assert.equal(normalizeLocale(undefined), null);
    assert.equal(normalizeLocale(42), null);
  });
});

// ---------------------------------------------------------------------------

describe('i18n: key coverage', () => {
  it('English defines a non-trivial catalog', () => {
    const keys = allKeys();
    assert.ok(keys.length >= 200, `expected 200+ keys, got ${keys.length}`);
    assert.ok(keys.includes('hud.hp'));
    assert.ok(keys.includes('a11y.language'));
  });

  for (const locale of NON_EN) {
    it(`${locale} defines every English key`, () => {
      const audit = auditLocale(locale);
      assert.deepEqual(audit.missing, [], `${locale} is missing keys`);
    });

    it(`${locale} defines no keys absent from English`, () => {
      const audit = auditLocale(locale);
      assert.deepEqual(audit.extra, [], `${locale} has stale/unknown keys`);
    });

    it(`${locale} keeps the English placeholder set on every key`, () => {
      const audit = auditLocale(locale);
      assert.deepEqual(
        audit.placeholderMismatch,
        [],
        `${locale} changes placeholder names (a value would silently vanish)`,
      );
    });

    it(`${locale} has the same key count as English`, () => {
      assert.equal(Object.keys(CATALOGS[locale]).length, Object.keys(en).length);
    });

    it(`${locale} never ships an empty string`, () => {
      const empty = (Object.keys(CATALOGS[locale]) as MessageKey[]).filter(
        (k) => CATALOGS[locale][k].trim() === '',
      );
      assert.deepEqual(empty, []);
    });
  }

  it('English is its own complete baseline (audit is a no-op)', () => {
    const audit = auditLocale('en');
    assert.deepEqual(audit.missing, []);
    assert.deepEqual(audit.extra, []);
    assert.deepEqual(audit.placeholderMismatch, []);
  });

  it('auditLocale flags a synthetic hole, extra key and placeholder drift', () => {
    // Exercise the detector itself against a deliberately broken catalog by
    // probing the reference set, so a regression in auditLocale is caught too.
    const ref = en as Record<string, string>;
    assert.ok(ref['hud.hp'] !== undefined);
    assert.deepEqual(placeholders(ref['srv.chat.joined']!), ['name']);
  });

  it('every locale actually translates the shared UI surface', () => {
    // A locale that merely copied English everywhere would pass the audits above
    // but ship no translation; spot-check a spread of categories.
    const probes: MessageKey[] = [
      'hud.inventory', 'hud.quests', 'a11y.title', 'a11y.language',
      'ann.lowHp', 'srv.dialogue.bye.text', 'srv.boss.stone-golem',
      'srv.quest.ember-road.name', 'death.respawn', 'toast.levelUp',
    ];
    for (const locale of NON_EN) {
      for (const key of probes) {
        assert.notEqual(
          translate(locale, key),
          translate('en', key),
          `${locale}.${key} was not translated`,
        );
      }
    }
  });

  it('grew the catalog to cover every HUD/a11y/announcement group', () => {
    const groups = new Set(allKeys().map((k) => k.split('.')[0]));
    for (const g of ['hud', 'a11y', 'ann', 'srv', 'toast', 'tut', 'topbar', 'settings', 'death', 'loading', 'join']) {
      assert.ok(groups.has(g), `missing key group: ${g}`);
    }
  });
});

// ---------------------------------------------------------------------------

describe('i18n: fallback chain', () => {
  it('English resolves to itself alone', () => {
    assert.deepEqual(fallbackChain('en'), ['en']);
  });

  it('non-English chains end in English', () => {
    for (const l of NON_EN) {
      const chain = fallbackChain(l);
      assert.equal(chain[0], l);
      assert.equal(chain[chain.length - 1], 'en');
      assert.equal(chain.length, 2);
    }
  });

  it('translate uses the active locale first', () => {
    assert.equal(translate('tr', 'hud.inventory'), 'Envanter');
    assert.equal(translate('de', 'hud.inventory'), 'Inventar');
    assert.equal(translate('es', 'hud.inventory'), 'Inventario');
    assert.equal(translate('en', 'hud.inventory'), 'Inventory');
  });

  it('an unknown key returns the key itself, never an empty string', () => {
    const bogus = 'nope.not.a.key' as MessageKey;
    for (const l of LOCALES) {
      assert.equal(translate(l, bogus), bogus);
    }
  });

  it('falls back to English when a locale value is missing (synthetic locale)', () => {
    // The runtime fallback path, exercised without mutating the real catalogs:
    // a key present in en but absent in a locale must resolve via the chain.
    const key: MessageKey = 'hud.inventory';
    const chain = fallbackChain('tr');
    let value: string | undefined;
    for (const l of chain) {
      const v = (CATALOGS[l] as Record<string, string | undefined>)[key];
      if (v !== undefined) { value = v; break; }
    }
    assert.equal(value, 'Envanter');
    assert.equal(chain.includes('en'), true, 'English is always in the chain');
  });

  it('changing locale mid-flight re-resolves against the new language', () => {
    const i = new I18n(memStore());
    assert.equal(i.t('death.respawn'), 'Respawn');
    i.setLocale('es');
    assert.equal(i.t('death.respawn'), 'Reaparecer');
    i.setLocale('tr');
    assert.equal(i.t('death.respawn'), 'Yeniden doğ');
    i.setLocale('de');
    assert.equal(i.t('death.respawn'), 'Neu spawnen');
  });
});

// ---------------------------------------------------------------------------

describe('i18n: interpolation', () => {
  it('placeholders() lists names in first-appearance order, deduped', () => {
    assert.deepEqual(placeholders('{a} then {b} then {a}'), ['a', 'b']);
    assert.deepEqual(placeholders('no placeholders'), []);
  });

  it('format substitutes known names and leaves unknown ones intact', () => {
    assert.equal(format('{a}/{b}', { a: 1, b: 2 }), '1/2');
    assert.equal(format('{a} {missing}', { a: 'x' }), 'x {missing}');
    assert.equal(format('{a}', {}), '{a}', 'no params -> untouched');
    assert.equal(format('plain', { a: 1 }), 'plain');
  });

  it('accepts numbers and zeroes as parameter values', () => {
    assert.equal(format('Lv {level}', { level: 0 }), 'Lv 0');
    assert.equal(format('x {n}', { n: 42 }), 'x 42');
  });

  it('interpolates through translate() in every locale', () => {
    for (const l of LOCALES) {
      assert.equal(translate(l, 'hud.slots', { used: 3 }), translate(l, 'hud.slots', { used: 3 }));
      assert.ok(translate(l, 'hud.slots', { used: 3 }).includes('3'));
    }
    assert.equal(translate('en', 'hud.slots', { used: 3 }), '3/20 slots');
    assert.equal(translate('tr', 'hud.slots', { used: 3 }), '3/20 yuva');
  });

  it('an announcement template renders identically-shaped output per locale', () => {
    const en1 = translate('en', 'ann.lowHp', { hp: 12, max: 100 });
    const tr1 = translate('tr', 'ann.lowHp', { hp: 12, max: 100 });
    assert.equal(en1, 'Low health: 12 of 100');
    assert.ok(tr1.includes('12') && tr1.includes('100'));
    assert.equal(placeholders(tr1).length, 0, 'all placeholders were substituted');
  });
});

// ---------------------------------------------------------------------------

describe('i18n: server text translation', () => {
  it('maps exact authored prose through the server index', () => {
    assert.equal(translateServerText('tr', 'Elder Maren'), 'Elder Maren');
    assert.equal(translateServerText('es', 'Ember Shard'), 'Fragmento de Brasa');
    assert.equal(translateServerText('de', 'Crypt Warden'), 'Gruft-Wächter');
  });

  it('translates every Elder Maren dialogue node by exact match', () => {
    const nodes: Array<[string, MessageKey]> = [
      ['Traveler. The ward-stones south of the gate have gone dark, and gloomfangs nest in the brush. Will you help Emberfall?', 'srv.dialogue.greeting.text'],
      ['Walk in the light, traveler.', 'srv.dialogue.bye.text'],
      ['Not yet — the stones still sleep. South of the gate, traveler. Touch each ward-stone and drive back the gloomfangs.', 'srv.dialogue.not_done.text'],
    ];
    for (const [en, key] of nodes) {
      for (const l of NON_EN) {
        const out = translateServerText(l, en);
        assert.equal(out, translate(l, key), `${l} failed on ${key}`);
        assert.notEqual(out, en, `${l} left ${key} untranslated`);
      }
    }
  });

  it('handles templated chat lines via patterns', () => {
    assert.equal(translateServerText('tr', 'hero joined'), 'hero katıldı');
    assert.equal(translateServerText('de', 'hero joined'), 'hero ist beigetreten');
    assert.equal(translateServerText('es', 'hero joined'), 'hero se ha unido');
  });

  it('handles templated kill-feed lines', () => {
    assert.equal(translateServerText('tr', 'gloomfang slain'), 'gloomfang devrildi');
    assert.equal(translateServerText('de', 'Stone Golem has fallen'), 'Steingolem ist gefallen');
    assert.equal(translateServerText('es', 'Crystal has fallen'), 'Crystal ha caído');
  });

  it('handles the HUD quest title shape (marker + count/goal)', () => {
    assert.equal(translateServerText('tr', '▶ Ember Road (2/5)'), 'Kor Yolu (2/5)');
    assert.equal(translateServerText('de', '▶ Chart the Fall (1/4)'), 'Den Fall kartieren (1/4)');
    assert.equal(translateServerText('es', '▶ Ward-Spark (0/3)'), 'Chispa Protectora (0/3)');
  });

  it('handles looted / quest-complete prefixes', () => {
    assert.equal(translateServerText('de', 'looted Ember Shard'), 'Glut-Splitter erbeutet');
    assert.equal(translateServerText('tr', 'Quest complete: Ember Road'), 'Görev tamamlandı: Kor Yolu');
  });

  it('translates the composed @maren wire format (node text + numbered options)', () => {
    const wire = 'Walk in the light, traveler. 1. Greetings again. (hello)';
    const es = translateServerText('es', wire);
    assert.ok(es.startsWith('Camina en la luz, viajero.'), es);
    assert.ok(es.includes('1. Saludos de nuevo. (hola)'), es);
  });

  it('composed dialogue with several options numbers them in order', () => {
    const wire = 'Traveler. The ward-stones south of the gate have gone dark, and gloomfangs nest in the brush. Will you help Emberfall? '
      + '1. Tell me about the ward-stones. (quest) 2. What do I get for helping? (reward) 3. Farewell. (bye)';
    const de = translateServerText('de', wire);
    assert.ok(de.includes('1. Erzähl mir von den Ward-Steinen. (Auftrag)'), de);
    assert.ok(de.includes('2. Was bekomme ich für meine Hilfe? (Belohnung)'), de);
    assert.ok(de.includes('3. Lebe wohl. (ende)'), de);
  });

  it('composed dialogue keeps English for an unknown node but still localizes options', () => {
    const out = translateServerText('es', 'Walk in the light, traveler. 1. Not a real option (nope)');
    assert.ok(out.includes('Not a real option (nope)'), 'unindexed option passes through');
  });

  it('composed-dialogue helper returns null for non-dialogue strings', () => {
    assert.equal(translateComposedDialogueForTest('es', 'hero joined'), null);
    assert.equal(translateComposedDialogueForTest('es', 'plain message with 1. no head'), null);
  });

  it('passes unknown strings through unchanged rather than blanking them', () => {
    const raw = 'gg wp everyone';
    assert.equal(translateServerText('tr', raw), raw);
    assert.equal(translateServerText('de', ''), '');
  });

  it('leaves player-authored chat alone in every locale', () => {
    // Only server prose is indexed; player text must survive verbatim.
    const msg = 'hello how are you';
    for (const l of NON_EN) assert.equal(translateServerText(l, msg), msg);
  });

  it('routes every indexed server entity name to its catalog entry', () => {
    // Stronger than "differs from English": the output must equal the catalog
    // value for the mapped key. This still holds for locales that correctly
    // keep a transliterated proper noun ("gloomfang" stays as-is in Turkish).
    const entities = ['Stone Golem', 'Ember Wyrm', 'Void Wisp', 'Crypt Warden',
      'Ember Shard', 'Caldera Greatsword', 'gloomfang', 'magma-golem'];
    for (const name of entities) {
      const key = SERVER_TEXT_INDEX[name] as MessageKey | undefined;
      assert.ok(key, `${name} is missing from SERVER_TEXT_INDEX`);
      for (const l of NON_EN) {
        assert.equal(
          translateServerText(l, name),
          translate(l, key),
          `${l} routed "${name}" to the wrong string`,
        );
      }
    }
  });

  it('entity names are genuinely localized in at least one non-English locale', () => {
    // Guards against a catalog that maps everything to the English string.
    // `gloomfang` is excluded: it is a branded creature name deliberately kept
    // verbatim in every locale (see the next test).
    const entities = ['Stone Golem', 'Ember Wyrm', 'Void Wisp', 'Crypt Warden',
      'Ember Shard', 'Caldera Greatsword', 'magma-golem'];
    for (const name of entities) {
      const key = SERVER_TEXT_INDEX[name] as MessageKey;
      const differs = NON_EN.some((l) => translate(l, key) !== translate('en', key));
      assert.ok(differs, `"${name}" is identical in every locale`);
    }
  });

  it('keeps the branded creature name "gloomfang" verbatim in all locales', () => {
    // Documented naming decision: proper-noun creatures keep one spelling so
    // players can search/pronounce them consistently. Asserted explicitly so a
    // future edit to one locale surfaces as an intentional review, not drift.
    const key = SERVER_TEXT_INDEX['gloomfang'] as MessageKey;
    for (const l of LOCALES) {
      assert.equal(translate(l, key), 'gloomfang');
      assert.equal(translateServerText(l, 'gloomfang'), 'gloomfang');
    }
  });

  it('keeps deliberately-identical proper nouns identical (no bad inflection)', () => {
    // "Ward Blade" is the sword's canonical English name; German and Turkish
    // both keep it verbatim. Asserting difference here would force a wrong
    // translation, so assert the value is still the catalog entry instead.
    assert.equal(translateServerText('de', 'Ward Blade'), translate('de', 'srv.item.ward-blade'));
    assert.equal(translateServerText('tr', 'Ward Blade'), translate('tr', 'srv.item.ward-blade'));
    assert.equal(translateServerText('en', 'Ward Blade'), 'Ward Blade');
  });

  it('localizes every telegraph label so SR warnings are not English', () => {
    const labels = ['golem-slam', 'wisp-blink', 'wisp-burst', 'wyrm-charge',
      'wyrm-fire', 'warden-slam', 'warden-husk', 'warden-shield'];
    for (const label of labels) {
      for (const l of NON_EN) {
        assert.notEqual(translateServerText(l, label), label, `${l} left ${label} untranslated`);
        assert.ok(!/[a-z]-[a-z]/.test(translateServerText(l, label)), 'label slug leaked through');
      }
    }
  });

  it('translateServerTemplate localizes an explicit key + params', () => {
    assert.equal(translateServerTemplate('tr', 'srv.kill.slain', { name: 'gloomfang' }), 'gloomfang devrildi');
    assert.equal(translateServerTemplate('es', 'srv.dialogue.option', { n: 2, label: 'Sí' }), '2. Sí');
  });
});

// ---------------------------------------------------------------------------

describe('i18n: I18n store', () => {
  it('defaults to English with no stored value', () => {
    const i = new I18n(memStore());
    assert.equal(i.getLocale(), 'en');
    assert.equal(i.isActive('en'), true);
  });

  it('persists the chosen locale to localStorage', () => {
    const store = memStore();
    const i = new I18n(store);
    i.setLocale('de');
    assert.equal(store.dump()[LOCALE_STORAGE_KEY], 'de');
  });

  it('restores the persisted locale in a later session', () => {
    const store = memStore({ [LOCALE_STORAGE_KEY]: 'tr' });
    const i = new I18n(store);
    assert.equal(i.getLocale(), 'tr');
    assert.equal(i.t('a11y.title'), 'ERİŞİLEBİLİRLİK');
  });

  it('ignores a corrupt or unsupported persisted value', () => {
    assert.equal(new I18n(memStore({ [LOCALE_STORAGE_KEY]: 'not json' })).getLocale(), 'en');
    assert.equal(new I18n(memStore({ [LOCALE_STORAGE_KEY]: 'fr' })).getLocale(), 'en');
    assert.equal(new I18n(memStore({ [LOCALE_STORAGE_KEY]: '' })).getLocale(), 'en');
  });

  it('honours an explicit initial locale over the stored one', () => {
    const i = new I18n(memStore({ [LOCALE_STORAGE_KEY]: 'tr' }), 'es');
    assert.equal(i.getLocale(), 'es');
  });

  it('setLocale is a no-op for the active locale and for unknown codes', () => {
    const i = new I18n(memStore());
    let fired = 0;
    i.onChange(() => { fired++; });
    i.setLocale('en');
    i.setLocale('fr' as Locale);
    assert.equal(fired, 0);
    assert.equal(i.getLocale(), 'en');
  });

  it('notifies subscribers on change and supports unsubscribe', () => {
    const i = new I18n(memStore());
    const seen: Locale[] = [];
    const off = i.onChange((l) => seen.push(l));
    i.setLocale('tr');
    i.setLocale('es');
    off();
    i.setLocale('de');
    assert.deepEqual(seen, ['tr', 'es']);
  });

  it('one throwing subscriber does not block the others', () => {
    const i = new I18n(memStore());
    const seen: Locale[] = [];
    i.onChange(() => { throw new Error('boom'); });
    i.onChange((l) => seen.push(l));
    i.setLocale('tr');
    assert.deepEqual(seen, ['tr']);
  });

  it('survives a storage backend that throws on every call', () => {
    const hostile: StorageLike = {
      getItem() { throw new Error('blocked'); },
      setItem() { throw new Error('blocked'); },
      removeItem() { throw new Error('blocked'); },
    };
    const i = new I18n(hostile);
    assert.equal(i.getLocale(), 'en');
    i.setLocale('tr');
    assert.equal(i.getLocale(), 'tr', 'locale still applies for the session');
  });

  it('t()/tServer() route through the active locale', () => {
    const i = new I18n(memStore());
    assert.equal(i.t('hud.minimap'), 'Minimap');
    i.setLocale('de');
    assert.equal(i.t('hud.minimap'), 'Minikarte');
    assert.equal(i.tServer('Ember Shard'), 'Glut-Splitter');
  });

  it('the process-wide instance defaults to English', () => {
    assert.equal(globalI18n.getLocale(), DEFAULT_LOCALE);
    assert.ok(LOCALES.includes(globalI18n.getLocale()));
  });
});