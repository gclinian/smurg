// The page catalog (src/lib/strings.ts): both languages have the same keys and the same parameters, English holds no
// CJK and zh-TW is Chinese, and no rendering leaks `undefined` or an unfilled placeholder.
import { LOCALES } from '@smurg/protocol/locale';
import { describe, expect, it } from 'vitest';
import { LANGUAGE_NAMES, STRINGS, type PageStrings } from '../src/lib/strings.ts';

const CJK = /[　-〿㐀-鿿＀-￯]/;
/** Sample arguments, by parameter position, for every function in the catalog. */
const SAMPLES: { readonly [K in keyof PageStrings]?: readonly unknown[][] } = {
  loginWith: [['Google']],
  relayNote: [['https://relay.example']],
  accountHtml: [['Ada', 'google:1']],
  loggedInAsHtml: [['<strong>Ada</strong>']],
  tooManyWrongCodes: [[1], [2], [10]],
  confirmIntroHtml: [['https://relay.example']],
  requestOrigin: [['203.0.113.7', 'Taipei'], [null, 'Taipei']],
  placeCityCountry: [['Taipei', 'TW']],
  age: [[0, '2026-10-01 08:15 UTC'], [1, '2026-10-01 08:15 UTC'], [25, '2026-10-01 08:15 UTC']],
  providerNotConfigured: [['GitHub']],
  cannotConfirmIdentity: [['Google']],
};
/** zh-TW values that are legitimately free of Chinese characters. */
const SAME_IN_BOTH: readonly (keyof PageStrings)[] = [];

function renderings(locale: (typeof LOCALES)[number], key: keyof PageStrings): string[] {
  const value: unknown = STRINGS[locale][key];
  if (typeof value === 'string') return [value];
  const samples = SAMPLES[key];
  if (samples === undefined) throw new Error(`no sample arguments for ${key}`);
  return samples.map((args) => (value as (...args: unknown[]) => string)(...args));
}

describe('the relay pages catalog', () => {
  const keys = Object.keys(STRINGS.en).sort() as (keyof PageStrings)[];

  it('has exactly the two locales, with the same keys, kinds and parameter counts', () => {
    expect(Object.keys(STRINGS).sort()).toEqual([...LOCALES].sort());
    expect(Object.keys(STRINGS['zh-TW']).sort()).toEqual(keys);
    for (const key of keys) {
      const english: unknown = STRINGS.en[key];
      const chinese: unknown = STRINGS['zh-TW'][key];
      expect(typeof chinese, key).toBe(typeof english);
      if (typeof english === 'function' && typeof chinese === 'function') expect(chinese.length, key).toBe(english.length);
    }
    // Every function has samples, and no sample names a key that is not a function.
    for (const key of Object.keys(SAMPLES) as (keyof PageStrings)[]) expect(typeof STRINGS.en[key], key).toBe('function');
  });

  it('renders every key in both languages without leftovers; English has no CJK, zh-TW is Chinese', () => {
    for (const key of keys) {
      for (const locale of LOCALES) {
        for (const text of renderings(locale, key)) {
          expect(text, `${locale} ${key}`).not.toBe('');
          expect(text, `${locale} ${key}`).not.toMatch(/undefined|\[object|\{|\}|\bnull\b|NaN/);
          if (locale === 'en') expect(text, `en ${key}`).not.toMatch(CJK);
          else if (!SAME_IN_BOTH.includes(key)) expect(text, `zh-TW ${key}`).toMatch(CJK);
        }
      }
    }
  });

  it('uses real English plural forms and none in zh-TW', () => {
    expect(STRINGS.en.tooManyWrongCodes(1)).toBe('Too many wrong codes. Try again in 1 minute.');
    expect(STRINGS.en.tooManyWrongCodes(7)).toBe('Too many wrong codes. Try again in 7 minutes.');
    expect(STRINGS.en.age(1, 'T')).toBe('1 minute ago (T)');
    expect(STRINGS.en.age(2, 'T')).toBe('2 minutes ago (T)');
    expect(STRINGS['zh-TW'].tooManyWrongCodes(1)).toBe('輸入錯誤的次數太多，請在 1 分鐘後再試。');
    expect(STRINGS['zh-TW'].age(2, 'T')).toBe('2 分鐘前（T）');
  });

  it('names each language in its own language', () => {
    expect(LANGUAGE_NAMES).toEqual({ en: 'English', 'zh-TW': '繁體中文' });
  });
});
