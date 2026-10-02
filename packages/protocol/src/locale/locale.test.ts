import { describe, expect, it } from 'vitest';
import {
  DEFAULT_LOCALE,
  LOCALES,
  intlTag,
  isLocale,
  localeFromAcceptLanguage,
  localeFromEnv,
  localeFromLanguages,
  matchLanguageTag,
  parseAppleLanguages,
  parseLocale,
} from './index.ts';
import { ACCEPT_LANGUAGE_CASES, ENV_CASES, LANGUAGE_LIST_CASES, NOT_ZH_TW_IN_ENV, NOT_ZH_TW_TAGS, ZH_TW_TAGS } from './test-table.ts';

describe('locales', () => {
  it('are exactly en and zh-TW, English by default', () => {
    expect(LOCALES).toEqual(['en', 'zh-TW']);
    expect(DEFAULT_LOCALE).toBe('en');
    expect(isLocale('en')).toBe(true);
    expect(isLocale('zh-TW')).toBe(true);
    expect(isLocale('zh-tw')).toBe(false);
    expect(isLocale(undefined)).toBe(false);
    expect(intlTag('en')).toBe('en');
    expect(intlTag('zh-TW')).toBe('zh-Hant-TW');
  });
});

describe('parseLocale (an explicit choice)', () => {
  it.each([
    ['en', 'en'],
    ['EN', 'en'],
    [' en ', 'en'],
    ['zh-TW', 'zh-TW'],
    ['zh_TW', 'zh-TW'],
    ['ZH-tw', 'zh-TW'],
    ['zh_tw', 'zh-TW'],
  ])('%j -> %s', (value, expected) => {
    expect(parseLocale(value)).toBe(expected);
  });

  it.each(['', 'zh', 'zh-Hant', 'zh-Hant-TW', 'en-US', 'zh_TW.UTF-8', 'fr', 'C', 'x'.repeat(100), null, undefined, 1, {}, ['en']])(
    '%j is not a choice',
    (value) => {
      expect(parseLocale(value)).toBeUndefined();
    },
  );
});

describe('matchLanguageTag (the shared table)', () => {
  it.each(ZH_TW_TAGS)('%j is Traditional Chinese', (tag) => {
    expect(matchLanguageTag(tag)).toBe('zh-TW');
  });

  it.each(NOT_ZH_TW_TAGS)('%j is not Traditional Chinese', (tag) => {
    expect(matchLanguageTag(tag)).not.toBe('zh-TW');
  });

  it.each(NOT_ZH_TW_IN_ENV)('%j is Traditional Chinese by tag (the codeset only matters in the environment rule)', (tag) => {
    expect(matchLanguageTag(tag)).toBe('zh-TW');
  });

  it.each(['en', 'en-GB', 'en_US.UTF-8', 'EN-us', 'en-Latn-US'])('%j is English', (tag) => {
    expect(matchLanguageTag(tag)).toBe('en');
  });

  it.each(['zh', 'zh-CN', 'zh-Hans', 'zh-Hans-TW', 'zh-SG', 'ja', 'C', 'POSIX', '', 'eng', 'english', 'zht', '-en', 'x-en', 'tw'])(
    '%j is unsupported',
    (tag) => {
      expect(matchLanguageTag(tag)).toBeUndefined();
    },
  );

  it('handles modifiers, codesets and odd input without throwing', () => {
    expect(matchLanguageTag('zh_TW.UTF-8@stroke')).toBe('zh-TW');
    expect(matchLanguageTag('zh_TW@radical')).toBe('zh-TW');
    expect(matchLanguageTag('zh-Hant-CN')).toBe('zh-TW');
    expect(matchLanguageTag('zh-hant_hk')).toBe('zh-TW');
    expect(matchLanguageTag('zh-'.repeat(40))).toBeUndefined();
    expect(matchLanguageTag(undefined as unknown as string)).toBeUndefined();
    expect(matchLanguageTag(42 as unknown as string)).toBeUndefined();
  });
});

describe('localeFromLanguages (browser)', () => {
  it.each(LANGUAGE_LIST_CASES)('%j -> %s', (tags, expected) => {
    expect(localeFromLanguages(tags)).toBe(expected);
  });

  it('is English for anything that is not a list of strings', () => {
    expect(localeFromLanguages(undefined)).toBe('en');
    expect(localeFromLanguages(null)).toBe('en');
    expect(localeFromLanguages('zh-TW' as unknown as string[])).toBe('en');
    expect(localeFromLanguages([null, 7, 'zh-TW'] as unknown as string[])).toBe('zh-TW');
  });
});

describe('localeFromAcceptLanguage (relay pages)', () => {
  it.each(ACCEPT_LANGUAGE_CASES)('%j -> %s', (header, expected) => {
    expect(localeFromAcceptLanguage(header)).toBe(expected);
  });

  it('ignores an over-long header', () => {
    expect(localeFromAcceptLanguage(`zh-TW,${'ja,'.repeat(1000)}`)).toBe('en');
    expect(localeFromAcceptLanguage(undefined)).toBe('en');
  });
});

describe('localeFromEnv (CLI, installer)', () => {
  it.each(ENV_CASES)('%j -> %s', (env, expected) => {
    expect(localeFromEnv(env)).toBe(expected);
  });

  it.each(ZH_TW_TAGS)('LANG=%s is zh-TW', (tag) => {
    expect(localeFromEnv({ LANG: tag })).toBe('zh-TW');
  });

  it.each(NOT_ZH_TW_TAGS)('LANG=%j is English', (tag) => {
    expect(localeFromEnv({ LANG: tag })).toBe('en');
  });

  it.each(NOT_ZH_TW_IN_ENV)('LANG=%s is English (not a UTF-8 codeset)', (tag) => {
    expect(localeFromEnv({ LANG: tag })).toBe('en');
  });

  it('never throws on an invalid SMURG_LANG and never reads anything but the four variables', () => {
    expect(localeFromEnv({ SMURG_LANG: 'x'.repeat(500), LANGUAGE: 'zh_TW', LC_CTYPE: 'zh_TW.UTF-8' })).toBe('en');
  });

  describe('the system language (macOS without LANG)', () => {
    const zh = () => ['zh-Hant-TW', 'en-TW'];

    it('is asked only when LC_ALL, LC_MESSAGES and LANG are all unset or empty', () => {
      expect(localeFromEnv({}, { systemLanguages: zh })).toBe('zh-TW');
      expect(localeFromEnv({ LC_ALL: '', LANG: '' }, { systemLanguages: zh })).toBe('zh-TW');
      expect(localeFromEnv({ LC_CTYPE: 'UTF-8' }, { systemLanguages: zh })).toBe('zh-TW');
      let asked = 0;
      const counting = () => {
        asked += 1;
        return zh();
      };
      expect(localeFromEnv({ LANG: 'en_US.UTF-8' }, { systemLanguages: counting })).toBe('en');
      expect(localeFromEnv({ LANG: 'C' }, { systemLanguages: counting })).toBe('en');
      expect(localeFromEnv({ LC_ALL: 'C' }, { systemLanguages: counting })).toBe('en');
      expect(localeFromEnv({ SMURG_LANG: 'en' }, { systemLanguages: counting })).toBe('en');
      expect(localeFromEnv({ SMURG_LANG: 'zh-TW' }, { systemLanguages: () => ['en'] })).toBe('zh-TW');
      expect(asked).toBe(0);
    });

    it('takes the first supported entry, and English on failure', () => {
      expect(localeFromEnv({}, { systemLanguages: () => ['en-TW', 'zh-Hant-TW'] })).toBe('en');
      expect(localeFromEnv({}, { systemLanguages: () => ['ja-JP', 'zh-Hant-TW'] })).toBe('zh-TW');
      expect(localeFromEnv({}, { systemLanguages: () => ['zh-Hans-CN'] })).toBe('en');
      expect(localeFromEnv({}, { systemLanguages: () => [] })).toBe('en');
      expect(localeFromEnv({}, { systemLanguages: () => undefined })).toBe('en');
      expect(localeFromEnv({}, { systemLanguages: () => null })).toBe('en');
      expect(
        localeFromEnv({}, {
          systemLanguages: () => {
            throw new Error('defaults: not found');
          },
        }),
      ).toBe('en');
    });
  });
});

describe('parseAppleLanguages (`defaults read -g AppleLanguages`)', () => {
  it('reads the quoted tags in order', () => {
    expect(parseAppleLanguages('(\n    "zh-Hant-TW",\n    "en-TW"\n)\n')).toEqual(['zh-Hant-TW', 'en-TW']);
    expect(localeFromLanguages(parseAppleLanguages('(\n    "zh-Hant-TW",\n    "en-TW"\n)\n'))).toBe('zh-TW');
  });

  it('reads unquoted tags and gives nothing for unreadable output', () => {
    expect(parseAppleLanguages('(\n    en,\n    ja\n)')).toEqual(['en', 'ja']);
    expect(parseAppleLanguages('()')).toEqual([]);
    expect(parseAppleLanguages('')).toEqual([]);
    expect(parseAppleLanguages('x'.repeat(5000))).toEqual([]);
    expect(parseAppleLanguages(undefined as unknown as string)).toEqual([]);
  });
});
