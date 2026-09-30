// The zh-TW string catalogue: one registry, many namespaces. Every user-facing string of the web app lives in a
// namespace defined with defineStrings(); nothing in a component is a string literal that a person reads.
//
// Convention (so nobody edits a shared index):
//   - app-wide namespaces live in src/strings/<namespace>.ts;
//   - a feature's strings live in src/features/<feature>/strings.ts and import ONLY this module:
//
//       // src/features/files/strings.ts
//       import { defineStrings } from '../../strings/catalog.ts';
//       export const t = defineStrings('files', {
//         empty: '這個資料夾是空的',
//         uploading: '正在上傳 {name}（{percent}%）',
//       });
//
//   - src/strings/index.ts loads every features/*/strings.ts eagerly (import.meta.glob), so the catalogue is complete
//     at startup even when the feature's code is lazy-loaded.
//
// `t('uploading', { name, percent })` is typed per namespace: an unknown key is a compile error.

export type StringVars = Readonly<Record<string, string | number>>;

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

const catalogue = new Map<string, string>();
const namespaces = new Set<string>();

export class StringCatalogueError extends Error {
  override readonly name = 'StringCatalogueError';
}

/** Replaces `{name}` placeholders; a missing variable stays visible as `{name}` (a bug, but never a crash). */
export function interpolate(template: string, vars?: StringVars): string {
  if (!vars) return template;
  return template.replace(PLACEHOLDER, (whole, name: string) => {
    const value = Object.hasOwn(vars, name) ? vars[name] : undefined;
    return value === undefined ? whole : String(value);
  });
}

/**
 * Registers `table` under `namespace` and returns its typed translator. A namespace may be defined once (a second
 * definition is a programming error: two features claiming one name).
 */
export function defineStrings<const T extends Readonly<Record<string, string>>>(namespace: string, table: T): Translator<keyof T & string> {
  if (!NAMESPACE_PATTERN.test(namespace)) throw new StringCatalogueError(`invalid string namespace: ${namespace}`);
  // Hot module replacement (the dev server only; vitest also exposes import.meta.hot) evaluates an edited strings
  // file again.
  const hotReload = import.meta.hot !== undefined && import.meta.env.MODE !== 'test';
  if (namespaces.has(namespace) && !hotReload) throw new StringCatalogueError(`string namespace defined twice: ${namespace}`);
  const keys = Object.keys(table) as (keyof T & string)[];
  for (const key of keys) {
    if (!KEY_PATTERN.test(key)) throw new StringCatalogueError(`invalid string key: ${namespace}.${key}`);
    const value = table[key];
    if (typeof value !== 'string' || value.length === 0) throw new StringCatalogueError(`empty string: ${namespace}.${key}`);
  }
  namespaces.add(namespace);
  // Vite's dev server re-evaluates an edited strings file: drop the namespace's old keys first.
  for (const existing of [...catalogue.keys()]) if (existing.startsWith(`${namespace}.`)) catalogue.delete(existing);
  for (const key of keys) catalogue.set(`${namespace}.${key}`, table[key] as string);
  const translate = (key: keyof T & string, vars?: StringVars): string => {
    const value = Object.hasOwn(table, key) ? table[key] : undefined;
    return typeof value === 'string' ? interpolate(value, vars) : `${namespace}.${key}`;
  };
  return Object.assign(translate, { namespace, keys: Object.freeze([...keys]) });
}

/**
 * Global lookup by full key (`files.empty`), for code that only knows the key at run time. Prefer the namespace's
 * typed translator. An unknown key returns the key itself, so a missing string is visible instead of blank.
 */
export function t(fullKey: string, vars?: StringVars): string {
  const value = catalogue.get(fullKey);
  return value === undefined ? fullKey : interpolate(value, vars);
}

/** Whether `fullKey` exists (tests, dynamic keys). */
export function hasString(fullKey: string): boolean {
  return catalogue.has(fullKey);
}

/** Every registered namespace (tests: all features registered, no duplicates). */
export function registeredNamespaces(): readonly string[] {
  return [...namespaces].sort();
}

/** A copy of the whole catalogue (tests: every value is zh-TW, placeholders well-formed). */
export function catalogueEntries(): readonly (readonly [string, string])[] {
  return [...catalogue.entries()];
}
