// The shared locale test table (DESIGN A.2). Every implementation of the rule is checked against it:
// `matchLanguageTag` / `localeFromEnv` here, `pick_lang` in scripts/install.sh, the web's boot locale, the relay's
// `pageLocale`. Tests import it as `@smurg/protocol/locale/test-table` (copy the rows verbatim only where a test cannot
// import TypeScript, e.g. inside a shell script).
//
// This file is data for tests; nothing in `src/` outside tests imports it.

/** Tags that are Traditional Chinese under the tag rule. */
export const ZH_TW_TAGS = ['zh-TW', 'zh_TW.UTF-8', 'zh-Hant', 'zh-Hant-HK', 'zh-HK', 'zh-MO', 'ZH-tw'] as const;

/** Tags that are NOT Traditional Chinese under the tag rule (English or unsupported). */
export const NOT_ZH_TW_TAGS = ['zh', 'zh-CN', 'zh-Hans', 'zh-Hans-TW', 'zh-SG', 'en', 'en-GB', 'ja', 'C', 'POSIX', ''] as const;

/** Traditional Chinese by tag, but NOT in the environment rule (the codeset is not UTF-8). */
export const NOT_ZH_TW_IN_ENV = ['zh_TW.Big5'] as const;

/** `navigator.languages` -> locale. */
export const LANGUAGE_LIST_CASES: readonly (readonly [readonly string[], 'en' | 'zh-TW'])[] = [
  [['en-US', 'zh-TW'], 'en'],
  [['ja', 'zh-TW', 'en'], 'zh-TW'],
  [['zh-CN'], 'en'],
  [['zh-HK'], 'zh-TW'],
  [['zh', 'zh-Hant'], 'zh-TW'],
  [[], 'en'],
];

/** `Accept-Language` -> locale. */
export const ACCEPT_LANGUAGE_CASES: readonly (readonly [string | null, 'en' | 'zh-TW'])[] = [
  [null, 'en'],
  ['', 'en'],
  ['*', 'en'],
  ['zh-TW', 'zh-TW'],
  ['zh-TW,zh;q=0.9,en-US;q=0.8,en;q=0.7', 'zh-TW'],
  ['en-US,en;q=0.9,zh-TW;q=0.8', 'en'],
  ['en;q=0.5, zh-TW;q=0.9', 'zh-TW'],
  ['ja, zh-Hant-HK;q=0.8, en;q=0.7', 'zh-TW'],
  ['zh-CN,zh;q=0.9', 'en'],
  ['zh-TW;q=0, en;q=0.1', 'en'],
  ['zh-TW;q=0', 'en'],
  ['ja;q=1, zh-Hans-TW;q=0.9', 'en'],
  ['zh-TW;q=abc, ja', 'en'],
];

/** Environment -> locale (the CLI and the installer; no system-language reader). */
export const ENV_CASES: readonly (readonly [Readonly<Record<string, string>>, 'en' | 'zh-TW'])[] = [
  [{}, 'en'],
  [{ LANG: 'zh_TW.UTF-8' }, 'zh-TW'],
  [{ LANG: 'zh_TW.utf8' }, 'zh-TW'],
  [{ LANG: 'zh_TW' }, 'zh-TW'],
  [{ LANG: 'zh_HK.UTF-8' }, 'zh-TW'],
  [{ LANG: 'zh_TW.Big5' }, 'en'],
  [{ LANG: 'zh_CN.UTF-8' }, 'en'],
  [{ LANG: 'en_US.UTF-8' }, 'en'],
  [{ LANG: 'C' }, 'en'],
  [{ LC_ALL: 'C', LANG: 'zh_TW.UTF-8' }, 'en'],
  [{ LC_ALL: '', LANG: 'zh_TW.UTF-8' }, 'zh-TW'],
  [{ LC_MESSAGES: 'zh_TW.UTF-8', LANG: 'en_US.UTF-8' }, 'zh-TW'],
  [{ LC_MESSAGES: 'en_US.UTF-8', LANG: 'zh_TW.UTF-8' }, 'en'],
  [{ LC_ALL: 'zh_TW.UTF-8', LC_MESSAGES: 'C', LANG: 'C' }, 'zh-TW'],
  [{ SMURG_LANG: 'zh-TW', LANG: 'en_US.UTF-8' }, 'zh-TW'],
  [{ SMURG_LANG: 'ZH_tw', LC_ALL: 'C' }, 'zh-TW'],
  [{ SMURG_LANG: 'en', LANG: 'zh_TW.UTF-8' }, 'en'],
  [{ SMURG_LANG: 'EN', LC_ALL: 'zh_TW.UTF-8' }, 'en'],
  [{ SMURG_LANG: 'fr', LANG: 'zh_TW.UTF-8' }, 'zh-TW'],
  [{ SMURG_LANG: 'zh-Hant', LANG: 'en_US.UTF-8' }, 'en'],
  [{ SMURG_LANG: '', LANG: 'zh_TW.UTF-8' }, 'zh-TW'],
];
