// The message-catalog toolkit behind `@smurg/protocol/i18n`: how a message is defined (`message`), how a reference
// to one travels (`MessageRef` = `{ id, params }`), and how a reference is turned into text (`createCatalog().render`).
//
// A message is a pair of functions of typed parameters, one per locale, written side by side. No fragment
// concatenation across messages: plurals, lists and variants are decided inside the form.
//
// `render` treats a reference as untrusted input (it comes off the wire): every parameter is checked against the
// message's declared spec, and anything unexpected gives `undefined` (the caller then shows its English fallback).
// It never throws and never prints "undefined".
//
// No import besides ../locale (types only): this module is loaded by the web app, the CLI, the daemon and the relay.
import type { Locale } from '../locale/index.ts';

// ---------------------------------------------------------------------------------------------------------------
// Parameter specs
// ---------------------------------------------------------------------------------------------------------------

/** What a parameter is. `list` is a list of strings (names, paths), already capped by the sender. `?` = optional. */
export type ParamKind = 'string' | 'number' | 'boolean' | 'list' | 'string?' | 'number?' | 'boolean?' | 'list?';
export type ParamSpec = Readonly<Record<string, ParamKind>>;

type ValueOfKind<K> = K extends 'string' | 'string?'
  ? string
  : K extends 'number' | 'number?'
    ? number
    : K extends 'boolean' | 'boolean?'
      ? boolean
      : K extends 'list' | 'list?'
        ? readonly string[]
        : never;
type OptionalKeys<S> = { [K in keyof S]: S[K] extends `${string}?` ? K : never }[keyof S];
type RequiredKeys<S> = Exclude<keyof S, OptionalKeys<S>>;

/** The parameter object a message's forms receive (and that `msg()` takes) for spec `S`. */
export type ParamsOf<S extends ParamSpec> = { readonly [K in RequiredKeys<S>]: ValueOfKind<S[K]> } & {
  readonly [K in OptionalKeys<S>]?: ValueOfKind<S[K]>;
};

/** One form per locale. Both get the same parameters. */
export type MessageForms<S extends ParamSpec> = { readonly [L in Locale]: (params: ParamsOf<S>) => string };

export interface MessageDef<S extends ParamSpec = ParamSpec> {
  readonly params: S;
  readonly forms: MessageForms<S>;
}
/** A message of any spec (a catalog holds messages of different specs). */
export type AnyMessageDef = MessageDef<any>;

/** Limits shared with the wire schema (`messageRefSchema`, src/schema/message-ref.ts). */
export const MESSAGE_ID_MAX_CHARS = 80;
export const MESSAGE_ID_PATTERN = /^[a-z][A-Za-z0-9.]*$/;
export const MESSAGE_PARAM_NAME_MAX_CHARS = 32;
export const MESSAGE_PARAM_MAX_KEYS = 16;
export const MESSAGE_PARAM_STRING_MAX_CHARS = 1000;
export const MESSAGE_PARAM_LIST_MAX_ITEMS = 10;
export const MESSAGE_PARAM_LIST_ITEM_MAX_CHARS = 500;

const PARAM_NAME_PATTERN = /^[a-z][A-Za-z0-9]*$/;
const PARAM_KINDS: ReadonlySet<string> = new Set(['string', 'number', 'boolean', 'list', 'string?', 'number?', 'boolean?', 'list?']);
/** Same three keys as FORBIDDEN_RECORD_KEYS (src/errors.ts); repeated here so this module imports nothing. */
const FORBIDDEN_KEYS: ReadonlySet<string> = new Set(['__proto__', 'constructor', 'prototype']);

export class MessageCatalogError extends Error {
  override readonly name = 'MessageCatalogError';
}

/**
 * Defines one message: its parameters and its two forms.
 *
 *     'worktree.inUse': message({ name: 'string', holders: 'list', count: 'number' }, {
 *       en: (p) => `${p.name} is in use by ${joinList('en', p.holders)}`,
 *       'zh-TW': (p) => `...`,
 *     }),
 *
 * A message without parameters: `message({}, { en: () => 'Host', 'zh-TW': () => '...' })`.
 */
export function message<const S extends ParamSpec>(params: S, forms: MessageForms<S>): MessageDef<S> {
  return Object.freeze({ params: Object.freeze({ ...params }) as S, forms: Object.freeze({ ...forms }) });
}

// ---------------------------------------------------------------------------------------------------------------
// Helpers used inside forms
// ---------------------------------------------------------------------------------------------------------------

/** `a, b, c` in English; the ideographic comma between items in zh-TW. An empty list gives an empty string. */
export function joinList(locale: Locale, items: readonly string[]): string {
  return items.join(locale === 'zh-TW' ? '\u3001' : ', ');
}

/** English only: `plural(n, 'file', 'files')`; `${n} ${plural(n, 'file', 'files')}`. zh-TW has no plural forms. */
export function plural(n: number, one: string, other: string): string {
  return n === 1 ? one : other;
}

// ---------------------------------------------------------------------------------------------------------------
// References
// ---------------------------------------------------------------------------------------------------------------

export type MessageParamValue = string | number | boolean | string[];
export type MessageParams = Record<string, MessageParamValue>;

/** The wire shape of "this message, with these parameters" (schema: `messageRefSchema`). */
export interface MessageRef {
  readonly id: string;
  readonly params?: MessageParams;
}

type SpecOf<D> = D extends MessageDef<infer S> ? S : never;
/** `msg()`'s rest arguments for a message: none, an optional object (every parameter optional) or a required one. */
export type ParamsArgOf<D> = [keyof SpecOf<D>] extends [never]
  ? []
  : [RequiredKeys<SpecOf<D>>] extends [never]
    ? [params?: ParamsOf<SpecOf<D>>]
    : [params: ParamsOf<SpecOf<D>>];

export interface Catalog<M extends Readonly<Record<string, AnyMessageDef>>> {
  /** The messages, as given. */
  readonly messages: M;
  /** Every id, in definition order. */
  readonly ids: readonly (keyof M & string)[];
  /** Whether `id` is a message of this catalog. */
  has(id: unknown): id is keyof M & string;
  /** Typed constructor of a reference. Compile-time checked; lists are copied. */
  msg<I extends keyof M & string>(id: I, ...params: ParamsArgOf<M[I]>): MessageRef;
  /**
   * The text of `ref` in `locale`, or `undefined` when the reference cannot be rendered: unknown id, a parameter that
   * is missing or of the wrong type, a list longer than 10, a form that fails. Never throws. An unknown `locale`
   * renders English. `ref` may be `undefined` (an optional wire field): the result is `undefined`.
   */
  render(locale: Locale, ref: MessageRef | null | undefined): string | undefined;
  /** The English text of a reference made with `msg()` (the daemon's fallback text). Always a string. */
  renderEnglish(ref: MessageRef): string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validValue(kind: string, value: unknown): boolean {
  switch (kind) {
    case 'string':
      return typeof value === 'string' && value.length <= MESSAGE_PARAM_STRING_MAX_CHARS;
    case 'number':
      return typeof value === 'number' && Number.isFinite(value);
    case 'boolean':
      return typeof value === 'boolean';
    case 'list':
      return (
        Array.isArray(value) &&
        value.length <= MESSAGE_PARAM_LIST_MAX_ITEMS &&
        value.every((item) => typeof item === 'string' && item.length <= MESSAGE_PARAM_LIST_ITEM_MAX_CHARS)
      );
    default:
      return false;
  }
}

/** The parameters a form may see: exactly the declared ones, type-checked. `undefined` = do not render. */
function checkedParams(spec: ParamSpec, params: unknown): Record<string, unknown> | undefined {
  if (params !== undefined && !isRecord(params)) return undefined;
  const checked: Record<string, unknown> = {};
  for (const name of Object.keys(spec)) {
    const kind = spec[name] as string;
    const optional = kind.endsWith('?');
    const value = params !== undefined && Object.hasOwn(params, name) ? params[name] : undefined;
    if (value === undefined) {
      if (optional) continue;
      return undefined;
    }
    if (!validValue(optional ? kind.slice(0, -1) : kind, value)) return undefined;
    checked[name] = Array.isArray(value) ? [...value] : value;
  }
  return checked;
}

function checkDefinition(id: string, def: AnyMessageDef): void {
  if (id.length > MESSAGE_ID_MAX_CHARS || !MESSAGE_ID_PATTERN.test(id)) throw new MessageCatalogError(`invalid message id: ${id}`);
  if (!isRecord(def) || !isRecord(def.params) || !isRecord(def.forms)) throw new MessageCatalogError(`not a message(): ${id}`);
  const names = Object.keys(def.params);
  if (names.length > MESSAGE_PARAM_MAX_KEYS) throw new MessageCatalogError(`too many parameters: ${id}`);
  for (const name of names) {
    if (name.length > MESSAGE_PARAM_NAME_MAX_CHARS || !PARAM_NAME_PATTERN.test(name) || FORBIDDEN_KEYS.has(name)) {
      throw new MessageCatalogError(`invalid parameter name: ${id} ${name}`);
    }
    if (!PARAM_KINDS.has(def.params[name] as string)) throw new MessageCatalogError(`invalid parameter kind: ${id} ${name}`);
  }
  if (typeof def.forms.en !== 'function' || typeof def.forms['zh-TW'] !== 'function') {
    throw new MessageCatalogError(`a message needs an en and a zh-TW form: ${id}`);
  }
}

/**
 * Builds a catalog from a table of `message()`s. Ids are `area.thing[.variant]` (`^[a-z][A-Za-z0-9.]*$`, at most 80
 * characters); parameter names are camelCase, at most 16 per message. A table that breaks these rules throws here,
 * at module load (a programming error), so every reference `msg()` can make fits the wire schema's shape.
 */
export function createCatalog<const M extends Readonly<Record<string, AnyMessageDef>>>(messages: M): Catalog<M> {
  const ids = Object.keys(messages) as (keyof M & string)[];
  for (const id of ids) checkDefinition(id, messages[id] as AnyMessageDef);

  const has = (id: unknown): id is keyof M & string => typeof id === 'string' && Object.hasOwn(messages, id);

  const render = (locale: Locale, ref: MessageRef | null | undefined): string | undefined => {
    try {
      if (!isRecord(ref) || !has(ref.id)) return undefined;
      const def = messages[ref.id] as AnyMessageDef;
      const params = checkedParams(def.params as ParamSpec, ref.params);
      if (params === undefined) return undefined;
      const forms = def.forms as Record<string, (params: Record<string, unknown>) => unknown>;
      const candidates = locale === 'zh-TW' ? [forms['zh-TW'], forms.en] : [forms.en];
      for (const form of candidates) {
        if (typeof form !== 'function') continue;
        try {
          const text = form(params);
          if (typeof text === 'string' && text.length > 0) return text;
        } catch {
          // A failing form: try the English one, then give up.
        }
      }
      return undefined;
    } catch {
      return undefined;
    }
  };

  const msg = <I extends keyof M & string>(id: I, ...rest: ParamsArgOf<M[I]>): MessageRef => {
    const given = (rest as readonly unknown[])[0];
    if (!isRecord(given)) return { id };
    const params: MessageParams = {};
    let count = 0;
    for (const name of Object.keys(given)) {
      const value = given[name];
      if (value === undefined || FORBIDDEN_KEYS.has(name)) continue;
      params[name] = Array.isArray(value) ? [...(value as string[])] : (value as MessageParamValue);
      count += 1;
    }
    return count === 0 ? { id } : { id, params };
  };

  const renderEnglish = (ref: MessageRef): string => {
    const text = render('en', ref);
    if (text !== undefined) return text;
    return isRecord(ref) && typeof ref.id === 'string' && ref.id.length > 0 ? ref.id : 'message';
  };

  return Object.freeze({ messages, ids: Object.freeze([...ids]), has, msg, render, renderEnglish });
}
