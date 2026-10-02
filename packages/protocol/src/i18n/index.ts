// `@smurg/protocol/i18n`: the wire catalog. Every text the daemon (or the client SDK) originates and a client shows
// in the VIEWER's language is a message here; it travels as a reference `{ id, params }` (`MessageRef`) next to an
// English rendering, and each client renders it with `render(locale, ref) ?? <the English fallback>`.
//
// Adding a message: put a `message()` into the file of its area under ./messages (a new area = a new file + one line
// in MESSAGE_GROUPS and one spread in MESSAGES below). English first, then zh-TW, side by side. docs/GLOSSARY.md binds
// the wording. Nothing else changes: `msg('your.id', {...})` is typed from the definition.
//
// Imports nothing but ../locale and its own files (test/entry-boundaries.test.ts): browser, Worker and Node safe.
import type { Locale } from '../locale/index.ts';
import { createCatalog, type MessageRef, type ParamsArgOf } from './define.ts';
import { activity } from './messages/activity.ts';
import { client } from './messages/client.ts';
import { errors } from './messages/errors.ts';
import { files } from './messages/files.ts';
import { notify } from './messages/notify.ts';
import { roles } from './messages/roles.ts';
import { sessions } from './messages/sessions.ts';
import { worktrees } from './messages/worktrees.ts';

export {
  MESSAGE_ID_MAX_CHARS,
  MESSAGE_ID_PATTERN,
  MESSAGE_PARAM_LIST_ITEM_MAX_CHARS,
  MESSAGE_PARAM_LIST_MAX_ITEMS,
  MESSAGE_PARAM_MAX_KEYS,
  MESSAGE_PARAM_NAME_MAX_CHARS,
  MESSAGE_PARAM_STRING_MAX_CHARS,
  MessageCatalogError,
  createCatalog,
  joinList,
  message,
  plural,
  type AnyMessageDef,
  type Catalog,
  type MessageDef,
  type MessageForms,
  type MessageParamValue,
  type MessageParams,
  type MessageRef,
  type ParamKind,
  type ParamSpec,
  type ParamsArgOf,
  type ParamsOf,
} from './define.ts';
export { DEFAULT_LOCALE, LOCALES, type Locale } from '../locale/index.ts';
export { formatBytes } from './format.ts';
export { CONFLICT_RECOVERY_REASONS, FILE_CHANGES, type ConflictRecoveryReason, type FileChange } from './messages/activity.ts';
export { ADMIN_CHANGES, type AdminChange } from './messages/errors.ts';
export { GIT_STEPS, type GitStep } from './messages/worktrees.ts';

/** The message files, by area (tests: no id is defined in two files). */
export const MESSAGE_GROUPS = { errors, files, sessions, worktrees, activity, notify, client, roles } as const;

export const MESSAGES = { ...errors, ...files, ...sessions, ...worktrees, ...activity, ...notify, ...client, ...roles } as const;
export type MessageId = keyof typeof MESSAGES;
/** `msg()`'s rest arguments for message `I`. */
export type ParamsArg<I extends MessageId> = ParamsArgOf<(typeof MESSAGES)[I]>;

const catalog = createCatalog(MESSAGES);

/** Every message id, in definition order. */
export const MESSAGE_IDS: readonly MessageId[] = catalog.ids;

export function isMessageId(id: unknown): id is MessageId {
  return catalog.has(id);
}

/** Typed constructor of a reference (the daemon, the client SDK): `msg('role.agent')`, `msg('x.y', { name })`. */
export function msg<I extends MessageId>(id: I, ...params: ParamsArg<I>): MessageRef {
  return catalog.msg(id, ...params);
}

/**
 * The text of `ref` in `locale`; `undefined` for an unknown id or parameters that do not match the message (the
 * reference is untrusted wire input). Never throws. Use: `render(locale, x.text) ?? x.message`.
 */
export function render(locale: Locale, ref: MessageRef | null | undefined): string | undefined {
  return catalog.render(locale, ref);
}

/** The English text of a reference made with `msg()`: what the daemon writes into `message` / `summary` / `fallback`. */
export function renderEnglish(ref: MessageRef): string {
  return catalog.renderEnglish(ref);
}

// ---------------------------------------------------------------------------------------------------------------
// References for the seed families
// ---------------------------------------------------------------------------------------------------------------

function camelCase(text: string): string {
  return text.replace(/[-_]+([a-z0-9])/g, (_whole, letter: string) => letter.toUpperCase());
}

/**
 * The default message of an error code: `error.default.<code in camelCase>` (`bad_request` -> `error.default.badRequest`).
 * An unknown code gives the `internal` default.
 */
export function defaultErrorRef(code: string): MessageRef {
  const id = typeof code === 'string' ? `error.default.${camelCase(code)}` : '';
  return isMessageId(id) ? { id } : { id: 'error.default.internal' };
}

/** A role's label: `role.host` / `role.agent` / `role.editor` / `role.viewer`. `undefined` for anything else. */
export function roleRef(role: string): MessageRef | undefined {
  const id = typeof role === 'string' ? `role.${role}` : '';
  return isMessageId(id) && id.startsWith('role.') ? { id } : undefined;
}

/** The label of `role` in `locale`; an unknown role is shown as given (never blank). */
export function roleLabel(locale: Locale, role: string): string {
  return render(locale, roleRef(role)) ?? String(role);
}

/**
 * The message of a client-side request failure (CLIENT_REQUEST_FAILURES: `timeout`, `cancelled`, `connection-lost`,
 * `closed`, `not-connected`, `overflow`). `sent: true` with `timeout` / `cancelled` gives the "outcome unknown"
 * wording. `undefined` for an unknown failure.
 */
export function clientFailureRef(failure: string, sent?: boolean): MessageRef | undefined {
  if (typeof failure !== 'string') return undefined;
  const base = `client.${camelCase(failure)}`;
  const unknownOutcome = `${base}OutcomeUnknown`;
  if (sent === true && isMessageId(unknownOutcome)) return { id: unknownOutcome };
  return isMessageId(base) && base.startsWith('client.') && !base.endsWith('OutcomeUnknown') ? { id: base } : undefined;
}
