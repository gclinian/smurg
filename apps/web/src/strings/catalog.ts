// The string catalogue: one registry, many namespaces, two locales (`en`, `zh-TW`). Every user-facing string of the
// web app lives in a namespace defined with defineStrings(); nothing in a component is a string literal that a
// person reads.
//
// Convention (so nobody edits a shared index):
//   - app-wide namespaces live in src/strings/<namespace>.ts (+ <namespace>.zh-TW.ts);
//   - a feature's strings live in src/features/<feature>/strings.ts (English: it defines the keys) and its sibling
//     strings.zh-TW.ts (the same keys in Traditional Chinese), and import ONLY this module and each other:
//
//       // src/features/files/strings.ts
//       import { defineStrings } from '../../strings/catalog.ts';
//       import { zhTW } from './strings.zh-TW.ts';
//       export const t = defineStrings('files', {
//         empty: 'This folder is empty',
//         uploading: 'Uploading {name} ({percent}%)',
//         'selected.count': { one: '{count} file selected', other: '{count} files selected' },
//       }, zhTW);
//
//       // src/features/files/strings.zh-TW.ts
//       export const zhTW = { empty: '...', uploading: '...', 'selected.count': '...' } as const;
//
//   - src/strings/index.ts loads every features/*/strings.ts eagerly (import.meta.glob), so the catalogue is complete
//     at startup even when the feature's code is lazy-loaded.
//
// `t('uploading', { name, percent })` is typed per namespace: an unknown key is a compile error, and the zh-TW table
// must have exactly the English table's keys (compile error for a missing key, StringCatalogueError at load for an
// extra one). The translator reads the current locale at call time, so call sites never mention a language.
//
// A value is a template, or a pair of plural forms `{ one, other }` chosen with Intl.PluralRules on the variable
// named `count` (a key that counts two things is split into two keys). zh-TW has no plural forms: plain strings.
import { DEFAULT_LOCALE, intlTag, type Locale } from '@smurg/protocol/locale';

export type StringVars = Readonly<Record<string, string | number>>;

/** A template, or the two English plural forms of one (selected by the variable `count`). */
export type StringValue = string | { readonly one: string; readonly other: string };
export type StringTable = Readonly<Record<string, StringValue>>;

export interface Translator<K extends string> {
  (key: K, vars?: StringVars): string;
  readonly namespace: string;
  readonly keys: readonly K[];
}

/** Namespace names: lower case, digits and dashes (they prefix keys: `files.empty`). */
const NAMESPACE_PATTERN = /^[a-z][a-z0-9-]{0,31}$/;
/** Keys inside a namespace: identifier-like, dots allowed for grouping (`status.online`). */
const KEY_PATTERN = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/;
const PLACEHOLDER = /\{([A-Za-z][A-Za-z0-9_]*)\}/g;

const catalogue: Readonly<Record<Locale, Map<string, StringValue>>> = { en: new Map(), 'zh-TW': new Map() };
const namespaces = new Set<string>();

// The locale the catalogue renders in. Only the app's locale controller (src/lib/locale.ts) sets it: at boot, on every
// switch, and for the test pin (src/testing/locale.ts). Until someone sets it, it is English.
let currentLocale: Locale = DEFAULT_LOCALE;

/** The locale `t()` and every translator render in right now. */
export function getCatalogLocale(): Locale {
  return currentLocale;
}

/** Sets the locale of every later `t()` call (no notification: the app re-mounts its routes on a switch). */
export function setCatalogLocale(locale: Locale): void {
  currentLocale = locale === 'zh-TW' ? 'zh-TW' : 'en';
}

export class StringCatalogueError extends Error {
  override readonly name = 'StringCatalogueError';
}

/** A Chinese character: what a Latin word or a number is set apart from with a space (the zh-TW house style). */
const HAN = /\p{Script=Han}/u;
/** The edge of a value that a Chinese character does not touch: a Latin letter, a digit, or what opens or closes them. */
const NARROW = /[\p{Script=Latin}\p{Nd}()[\]"'+\-#@%]/u;

/**
 * Replaces `{name}` placeholders; a missing variable stays visible as `{name}` (a bug, but never a crash).
 *
 * Where a placeholder stands directly against a Chinese character, a value that begins or ends in Latin letters or
 * digits there gets a space on that side: a zh-TW sentence that names who deleted a file reads with a space on both
 * sides of "Mei" and with none around a Chinese name (the examples are in strings.test.ts). A template cannot write
 * that space itself when its placeholder may hold a name in either script. (English templates hold no Chinese
 * character, so nothing changes for them.)
 */
export function interpolate(template: string, vars?: StringVars): string {
  if (!vars) return template;
  return template.replace(PLACEHOLDER, (whole, name: string, offset: number) => {
    const given = Object.hasOwn(vars, name) ? vars[name] : undefined;
    if (given === undefined) return whole;
    const value = String(given);
    if (value === '') return value;
    const before = template[offset - 1];
    const after = template[offset + whole.length];
    const lead = before !== undefined && HAN.test(before) && NARROW.test(value[0] as string) ? ' ' : '';
    const trail = after !== undefined && HAN.test(after) && NARROW.test(value.at(-1) as string) ? ' ' : '';
    return `${lead}${value}${trail}`;
  });
}

const pluralRules = new Map<Locale, Intl.PluralRules>();

function pluralCategory(locale: Locale, count: number): Intl.LDMLPluralRule {
  let rules = pluralRules.get(locale);
  if (rules === undefined) {
    rules = new Intl.PluralRules(intlTag(locale));
    pluralRules.set(locale, rules);
  }
  return rules.select(count);
}

/** The template of `value` for `vars` in `locale`: the `one` form only when `count` is a number in that category. */
export function selectForm(value: StringValue, vars: StringVars | undefined, locale: Locale): string {
  if (typeof value === 'string') return value;
  const count = vars !== undefined && Object.hasOwn(vars, 'count') ? vars.count : undefined;
  return typeof count === 'number' && pluralCategory(locale, count) === 'one' ? value.one : value.other;
}

function checkValue(namespace: string, key: string, value: unknown): void {
  if (typeof value === 'string') {
    if (value.length === 0) throw new StringCatalogueError(`empty string: ${namespace}.${key}`);
    return;
  }
  const forms = value as { one?: unknown; other?: unknown } | null;
  const ok =
    typeof forms === 'object' &&
    forms !== null &&
    Object.keys(forms).length === 2 &&
    typeof forms.one === 'string' &&
    forms.one.length > 0 &&
    typeof forms.other === 'string' &&
    forms.other.length > 0;
  if (!ok) throw new StringCatalogueError(`not a string or { one, other }: ${namespace}.${key}`);
}

/**
 * Registers a namespace and returns its typed translator. `en` defines the keys; `zhTW` must have exactly the same
 * keys. A namespace may be defined once (a second definition is a programming error: two features claiming one name).
 */
export function defineStrings<const T extends StringTable>(
  namespace: string,
  en: T,
  zhTW: { readonly [K in keyof T]: StringValue },
): Translator<keyof T & string> {
  if (!NAMESPACE_PATTERN.test(namespace)) throw new StringCatalogueError(`invalid string namespace: ${namespace}`);
  // Hot module replacement (the dev server only; vitest also exposes import.meta.hot) evaluates an edited strings
  // file again.
  const hotReload = import.meta.hot !== undefined && import.meta.env.MODE !== 'test';
  if (namespaces.has(namespace) && !hotReload) throw new StringCatalogueError(`string namespace defined twice: ${namespace}`);
  const keys = Object.keys(en) as (keyof T & string)[];
  if (typeof zhTW !== 'object' || zhTW === null) throw new StringCatalogueError(`no zh-TW table: ${namespace}`);
  const tables: Readonly<Record<Locale, StringTable>> = { en, 'zh-TW': zhTW };
  for (const key of keys) {
    if (!KEY_PATTERN.test(key)) throw new StringCatalogueError(`invalid string key: ${namespace}.${key}`);
    checkValue(namespace, key, en[key]);
  }
  for (const key of keys) {
    if (!Object.hasOwn(zhTW, key)) throw new StringCatalogueError(`missing zh-TW string: ${namespace}.${key}`);
    checkValue(namespace, key, zhTW[key]);
  }
  for (const key of Object.keys(zhTW)) {
    if (!Object.hasOwn(en, key)) throw new StringCatalogueError(`zh-TW string without an English one: ${namespace}.${key}`);
  }
  namespaces.add(namespace);
  for (const locale of ['en', 'zh-TW'] as const) {
    const all = catalogue[locale];
    // Vite's dev server re-evaluates an edited strings file: drop the namespace's old keys first.
    for (const existing of [...all.keys()]) if (existing.startsWith(`${namespace}.`)) all.delete(existing);
    for (const key of keys) all.set(`${namespace}.${key}`, tables[locale][key] as StringValue);
  }
  const translate = (key: keyof T & string, vars?: StringVars): string => {
    const table = tables[currentLocale];
    const value = Object.hasOwn(table, key) ? table[key] : undefined;
    return value === undefined ? `${namespace}.${key}` : interpolate(selectForm(value, vars, currentLocale), vars);
  };
  return Object.assign(translate, { namespace, keys: Object.freeze([...keys]) });
}

/**
 * Global lookup by full key (`files.empty`), for code that only knows the key at run time. Prefer the namespace's
 * typed translator. An unknown key returns the key itself, so a missing string is visible instead of blank.
 */
export function t(fullKey: string, vars?: StringVars): string {
  const value = catalogue[currentLocale].get(fullKey);
  return value === undefined ? fullKey : interpolate(selectForm(value, vars, currentLocale), vars);
}

/** Whether `fullKey` exists (tests, dynamic keys). */
export function hasString(fullKey: string): boolean {
  return catalogue.en.has(fullKey);
}

/** Every registered namespace (tests: all features registered, no duplicates). */
export function registeredNamespaces(): readonly string[] {
  return [...namespaces].sort();
}

/** The whole table of one locale, by full key (tests: parity of keys, placeholders and plural forms). */
export function catalogueTable(locale: Locale): ReadonlyMap<string, StringValue> {
  return new Map(catalogue[locale]);
}

/**
 * A copy of the whole catalogue of `locale` (default: the current one) as templates. A plural value gives two
 * entries, `<key>#one` and `<key>#other`.
 */
export function catalogueEntries(locale: Locale = currentLocale): readonly (readonly [string, string])[] {
  const entries: (readonly [string, string])[] = [];
  for (const [key, value] of catalogue[locale]) {
    if (typeof value === 'string') entries.push([key, value]);
    else entries.push([`${key}#one`, value.one], [`${key}#other`, value.other]);
  }
  return entries;
}
