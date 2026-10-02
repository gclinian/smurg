// `@smurg/protocol/locale`: the two display languages and the ONE rule that maps a language tag to them.
//
// This entry has no import at all (no zod, no crypto, no Node built-in): the relay Worker, the web app, the CLI and
// the daemon's tools all load it (test/entry-boundaries.test.ts keeps it that way).
//
// The language is the viewer's: a process picks a language only for text it shows to its own user. The daemon and the
// relay's JSON API never pick one; they send message references (`@smurg/protocol/i18n`).
//
// The installer (`scripts/install.sh`, POSIX sh) implements the same rule a second time; both are checked against the
// shared table in `test-table.ts`.

export const LOCALES = ['en', 'zh-TW'] as const;
export type Locale = (typeof LOCALES)[number];
export const DEFAULT_LOCALE: Locale = 'en';

/** Name of the language cookie (shared by the web app and the relay's HTML pages) and of the web's localStorage key. */
export const LOCALE_COOKIE = 'smurg_lang';
export const LOCALE_STORAGE_KEY = 'smurg.lang';
/** The CLI's and the installer's override variable. */
export const LOCALE_ENV = 'SMURG_LANG';

/** Longest tag / header this module looks at; anything longer is "unsupported" (inputs come from headers and env). */
const TAG_MAX_CHARS = 64;
const HEADER_MAX_CHARS = 2_000;
const LIST_MAX_ENTRIES = 32;

export function isLocale(value: unknown): value is Locale {
  return value === 'en' || value === 'zh-TW';
}

/**
 * An explicit choice (the cookie, localStorage, `SMURG_LANG`, `?lang=`): exactly `en` or `zh-TW`, in any letter case,
 * `_` accepted for `-`. Everything else (including `zh-Hant`, `en-US`, `zh_TW.UTF-8`) is `undefined`: a stored choice
 * is one of the two ids, never a language tag.
 */
export function parseLocale(value: unknown): Locale | undefined {
  if (typeof value !== 'string' || value.length > TAG_MAX_CHARS) return undefined;
  const id = value.trim().toLowerCase().replaceAll('_', '-');
  if (id === 'en') return 'en';
  if (id === 'zh-tw') return 'zh-TW';
  return undefined;
}

/** `zh_TW.UTF-8@x` -> `{ subtags: ['zh','tw'], codeset: 'utf-8' }`. */
function splitTag(tag: string): { subtags: string[]; codeset: string | undefined } | undefined {
  if (typeof tag !== 'string' || tag.length > TAG_MAX_CHARS) return undefined;
  let text = tag.trim().toLowerCase();
  const at = text.indexOf('@');
  if (at !== -1) text = text.slice(0, at);
  let codeset: string | undefined;
  const dot = text.indexOf('.');
  if (dot !== -1) {
    codeset = text.slice(dot + 1);
    text = text.slice(0, dot);
  }
  const subtags = text.replaceAll('_', '-').split('-');
  return { subtags, codeset };
}

/**
 * The rule (DESIGN A.2): lower-case; `_` -> `-`; strip `.codeset` and `@modifier`; split on `-`.
 * Traditional Chinese iff the first subtag is `zh` AND (`hant` is a subtag OR (`hans` is not AND one of
 * `tw` / `hk` / `mo` is)). English iff the first subtag is `en`. Everything else (bare `zh`, `zh-CN`, `zh-Hans-TW`,
 * `ja`, `C`, `POSIX`, the empty string) is unsupported: `undefined`.
 */
export function matchLanguageTag(tag: string): Locale | undefined {
  const parts = splitTag(tag);
  if (parts === undefined) return undefined;
  const { subtags } = parts;
  if (subtags[0] === 'en') return 'en';
  if (subtags[0] !== 'zh') return undefined;
  const rest = subtags.slice(1);
  if (rest.includes('hant')) return 'zh-TW';
  if (rest.includes('hans')) return undefined;
  return rest.some((subtag) => subtag === 'tw' || subtag === 'hk' || subtag === 'mo') ? 'zh-TW' : undefined;
}

/** Browser: the first entry of `navigator.languages` that is English or Traditional Chinese; else English. */
export function localeFromLanguages(tags: readonly string[] | null | undefined): Locale {
  if (!Array.isArray(tags)) return DEFAULT_LOCALE;
  for (const tag of tags.slice(0, LIST_MAX_ENTRIES)) {
    if (typeof tag !== 'string') continue;
    const locale = matchLanguageTag(tag);
    if (locale !== undefined) return locale;
  }
  return DEFAULT_LOCALE;
}

/**
 * Relay HTML pages: the first supported entry of `Accept-Language` in q order (highest q first; equal q keeps the
 * header's order; `q=0` means "not acceptable" and is skipped; `*` matches nothing). Malformed parts are skipped.
 */
export function localeFromAcceptLanguage(header: string | null | undefined): Locale {
  if (typeof header !== 'string' || header.length > HEADER_MAX_CHARS) return DEFAULT_LOCALE;
  const entries: { tag: string; q: number; index: number }[] = [];
  const parts = header.split(',').slice(0, LIST_MAX_ENTRIES);
  for (let index = 0; index < parts.length; index++) {
    const [rawTag, ...rawParams] = (parts[index] as string).split(';');
    const tag = (rawTag ?? '').trim();
    if (tag === '' || tag === '*') continue;
    let q = 1;
    for (const param of rawParams) {
      const match = /^\s*q\s*=(.*)$/i.exec(param);
      if (match === null) continue;
      const text = (match[1] as string).trim();
      const value = /^[0-9]+(\.[0-9]*)?$/.test(text) ? Number(text) : Number.NaN;
      // A weight that is not a number between 0 and 1 makes the entry unusable (never "best").
      q = value >= 0 && value <= 1 ? value : 0;
    }
    if (q > 0) entries.push({ tag, q, index });
  }
  entries.sort((a, b) => b.q - a.q || a.index - b.index);
  for (const entry of entries) {
    const locale = matchLanguageTag(entry.tag);
    if (locale !== undefined) return locale;
  }
  return DEFAULT_LOCALE;
}

/** The POSIX locale variables, in POSIX precedence. */
export const LOCALE_ENV_PRECEDENCE = ['LC_ALL', 'LC_MESSAGES', 'LANG'] as const;

export interface LocaleFromEnvOptions {
  /**
   * The operating system's preferred languages (macOS: `AppleLanguages`), asked ONLY when `SMURG_LANG` gives no
   * locale and `LC_ALL`, `LC_MESSAGES` and `LANG` are all unset or empty (a macOS terminal started without `LANG`).
   * The first entry that is English or Traditional Chinese wins, as in a browser. The function may return nothing
   * and may throw: both mean English. This module never runs a program itself; the CLI passes a cached reader
   * (see `parseAppleLanguages`).
   */
  readonly systemLanguages?: () => readonly string[] | null | undefined;
}

/**
 * CLI: `SMURG_LANG` (`en` / `zh-TW`, case-insensitive, `_` accepted; any other value is ignored, never an error),
 * then the FIRST NON-EMPTY of `LC_ALL`, `LC_MESSAGES`, `LANG`: zh-TW iff it is Traditional Chinese and its codeset is
 * UTF-8 / utf8 or absent; any other value there is English (`LC_ALL=C LANG=zh_TW.UTF-8` is English, `zh_TW.Big5` is
 * English). With none of the three set: `options.systemLanguages`, else English.
 */
export function localeFromEnv(env: Readonly<Record<string, string | undefined>>, options?: LocaleFromEnvOptions): Locale {
  const explicit = parseLocale(env[LOCALE_ENV]);
  if (explicit !== undefined) return explicit;
  for (const name of LOCALE_ENV_PRECEDENCE) {
    const value = env[name];
    if (typeof value !== 'string' || value === '') continue;
    const parts = splitTag(value);
    if (parts === undefined) return DEFAULT_LOCALE;
    if (matchLanguageTag(value) !== 'zh-TW') return DEFAULT_LOCALE;
    const codeset = parts.codeset;
    return codeset === undefined || codeset === 'utf-8' || codeset === 'utf8' ? 'zh-TW' : DEFAULT_LOCALE;
  }
  if (options?.systemLanguages === undefined) return DEFAULT_LOCALE;
  try {
    return localeFromLanguages(options.systemLanguages());
  } catch {
    return DEFAULT_LOCALE;
  }
}

/**
 * The language tags in the output of `defaults read -g AppleLanguages` (an old-style property list:
 * `(\n    "zh-Hant-TW",\n    "en-TW"\n)`; a tag without special characters may be unquoted). Pure text handling:
 * the caller runs the program. Unreadable output gives an empty list.
 */
export function parseAppleLanguages(output: string): string[] {
  if (typeof output !== 'string' || output.length > HEADER_MAX_CHARS) return [];
  const tags: string[] = [];
  for (const match of output.matchAll(/"([^"\\]{1,64})"|([A-Za-z][A-Za-z0-9_-]{0,63})/g)) {
    const tag = match[1] ?? match[2];
    if (tag !== undefined && tags.length < LIST_MAX_ENTRIES) tags.push(tag);
  }
  return tags;
}

/** The BCP 47 tag for `Intl.*` and `<html lang>`. */
export function intlTag(locale: Locale): 'en' | 'zh-Hant-TW' {
  return locale === 'zh-TW' ? 'zh-Hant-TW' : 'en';
}
