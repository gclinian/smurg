// The CLI's language: which one (resolveLang), and how a message becomes text (renderText).
//
// A message is described where it happens and rendered where it is printed: throw sites and helpers build a `Text`
// (`m(id, params)`), and only the code that writes to the terminal knows the language (CommandContext.lang, set once
// in runCli). There is no module-level language.
//
// Three kinds of Text:
//  - `m('host.folder.notFound', { folder })`: one of the CLI's own messages (en.ts / zh-TW.ts);
//  - `wireText(...)` / `wireError(...)`: a message the daemon or the client SDK made, carried as a reference into the
//    wire catalog (`@smurg/protocol/i18n`) with its English text as the fallback: rendered in THIS terminal's language;
//  - a plain string: data that is never translated (a path, a name, text a person wrote).
// A string parameter of a message may itself be a Text, and so may each item of a list; it is rendered first (in the
// same language).
import { execFileSync } from 'node:child_process';
import { defaultErrorRef, render, roleRef, type MessageRef } from '@smurg/protocol/i18n';
import { localeFromEnv, parseAppleLanguages, type Locale } from '@smurg/protocol/locale';
import { en } from './en.ts';
import { zhTW } from './zh-TW.ts';

export type { Locale } from '@smurg/protocol/locale';
export type MessageId = keyof typeof en;

export const CATALOGS: Readonly<Record<Locale, typeof en>> = { en, 'zh-TW': zhTW };

/** A message of the wire catalog, with the text to show when this build does not know it. */
export interface WireText {
  readonly wire: MessageRef | undefined;
  /** An error code (`@smurg/protocol` ERROR_CODES): its default text is tried before the fallback. */
  readonly code?: string;
  readonly fallback: string;
}

export interface CatalogText {
  readonly id: MessageId;
  readonly params?: Readonly<Record<string, unknown>>;
}

export type Text = CatalogText | WireText | string;

type ParamsOf<I extends MessageId> = Parameters<(typeof en)[I]>[0];
/** A string parameter, and each item of a list of strings, may be given as a Text (rendered before the message is). */
type Loose<P> = { readonly [K in keyof P]: string extends P[K] ? P[K] | Text : P[K] extends readonly string[] ? readonly Text[] : P[K] };
type ParamsArg<I extends MessageId> = ParamsOf<I> extends undefined ? [] : [params: Loose<NonNullable<ParamsOf<I>>>];

/** A message of the CLI's catalog, to be rendered later. */
export function m<I extends MessageId>(id: I, ...params: ParamsArg<I>): CatalogText {
  return params[0] === undefined ? { id } : { id, params: params[0] as Readonly<Record<string, unknown>> };
}

/** A reference into the wire catalog (`ref` comes off the wire: it may be missing, unknown or malformed). */
export function wireText(ref: MessageRef | undefined, fallback: string): WireText {
  return { wire: ref, fallback };
}

/** A daemon refusal (`{ code, message, text? }`: the `error` Envelope, a control-socket reply) as a Text. */
export function wireError(error: { readonly code?: unknown; readonly message?: unknown; readonly text?: unknown }): WireText {
  return {
    wire: isMessageRef(error.text) ? error.text : undefined,
    ...(typeof error.code === 'string' ? { code: error.code } : {}),
    fallback: typeof error.message === 'string' ? error.message : '',
  };
}

/** A role's label (`Agent access`), from the wire catalog: one wording for the web app and the CLI. */
export function roleText(role: string): WireText {
  return { wire: roleRef(role), fallback: role };
}

function isMessageRef(value: unknown): value is MessageRef {
  return typeof value === 'object' && value !== null && typeof (value as { id?: unknown }).id === 'string';
}

function isText(value: unknown): value is Exclude<Text, string> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  return 'fallback' in value || typeof (value as { id?: unknown }).id === 'string';
}

export function renderText(lang: Locale, text: Text): string {
  if (typeof text === 'string') return text;
  if ('fallback' in text) {
    const shown = render(lang, text.wire) ?? (text.code === undefined ? undefined : render(lang, defaultErrorRef(text.code)));
    return shown ?? text.fallback;
  }
  const form = (CATALOGS[lang] ?? en)[text.id] as (params: Record<string, unknown>) => string;
  const params: Record<string, unknown> = {};
  const inner = (value: unknown): unknown => (isText(value) ? renderText(lang, value) : value);
  for (const [name, value] of Object.entries(text.params ?? {})) params[name] = Array.isArray(value) ? value.map(inner) : inner(value);
  return form(params);
}

// ---- which language

let systemLanguagesMemo: readonly string[] | null | undefined;

/**
 * macOS only: the system's preferred languages (`defaults read -g AppleLanguages`), read at most once per process, no
 * shell, a short timeout. null on any other platform and on every failure (the caller then uses English).
 */
export function systemLanguages(): readonly string[] | null {
  if (systemLanguagesMemo !== undefined) return systemLanguagesMemo;
  systemLanguagesMemo = null;
  if (process.platform !== 'darwin') return null;
  try {
    const output = execFileSync('/usr/bin/defaults', ['read', '-g', 'AppleLanguages'], { encoding: 'utf8', timeout: 2_000, stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 * 1024 });
    systemLanguagesMemo = parseAppleLanguages(output);
  } catch {
    systemLanguagesMemo = null;
  }
  return systemLanguagesMemo;
}

/**
 * The language of this run: SMURG_LANG, then the first non-empty of LC_ALL, LC_MESSAGES, LANG; with none of the three
 * set, `system()` when given (the real process passes systemLanguages; tests pass nothing: the pure environment rule).
 */
export function resolveLang(env: Readonly<Record<string, string | undefined>>, system?: () => readonly string[] | null): Locale {
  return localeFromEnv(env, system === undefined ? undefined : { systemLanguages: system });
}
