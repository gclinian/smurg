import { z } from 'zod';
import { defaultErrorRef, renderEnglish, type MessageRef } from './i18n/index.ts';
import { messageRefSchema } from './schema/message-ref.ts';

// Error codes and the error Envelope payload (ARCHITECTURE §4.3): request X is answered by `X.ok` or by `error` with
// the same id and payload `{ code, message, detail?, text? }`.
//
// `message` is ENGLISH (logs, the audit log, agents, clients that do not know the id). `text` is a message reference
// (`@smurg/protocol/i18n`): the client renders it in the viewer's language and falls back to `message`. Every error the
// daemon makes carries `text` (the default of its code when nothing more specific was said); the field is optional in
// the schema because an error rebuilt from a payload without it, or made from a plain string, has none.
//
// `detail` is a small record for machines (the UI never has to parse `message`). Conventions used across the protocol:
//   detail.reason  — a kebab-case sub-reason, e.g. 'hash-mismatch' / 'incomplete' (uploads), 'unknown-type' (codec)
//   detail.disk    — a DiskReport (with `insufficient_disk`)
//   detail.lock    — a LockInfo (with `locked`)
//   detail.issues  — `{ path, code, message }[]` from schema validation (never the offending values)
// Sensitive values (file contents, keys, tokens, terminal data) never go into `message` or `detail`.

export const ERROR_CODES = [
  'bad_request',
  'unauthorized',
  'forbidden',
  'not_found',
  'conflict',
  'locked',
  'path_denied',
  'insufficient_disk',
  'too_large',
  'host_only',
  'rate_limited',
  'internal',
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];

export const errorCodeSchema = z.enum(ERROR_CODES);

export function isErrorCode(value: unknown): value is ErrorCode {
  return typeof value === 'string' && (ERROR_CODES as readonly string[]).includes(value);
}

export const ERROR_MESSAGE_MAX_CHARS = 2_000;
export const ERROR_DETAIL_MAX_KEYS = 64;
export const ERROR_DETAIL_KEY_MAX_CHARS = 64;

/**
 * Keys that can change an object's prototype or shadow its constructor when a decoded record is copied or merged.
 * msgpack already rejects `__proto__`; records reject all three, and the codec rejects them at any depth.
 */
export const FORBIDDEN_RECORD_KEYS: ReadonlySet<string> = new Set(['__proto__', 'constructor', 'prototype']);

export const errorDetailSchema = z
  .record(z.string().min(1).max(ERROR_DETAIL_KEY_MAX_CHARS), z.unknown())
  .refine((detail) => Object.keys(detail).length <= ERROR_DETAIL_MAX_KEYS, `at most ${ERROR_DETAIL_MAX_KEYS} keys`)
  .refine((detail) => Object.keys(detail).every((key) => !FORBIDDEN_RECORD_KEYS.has(key)), 'forbidden key');
export type ErrorDetail = z.infer<typeof errorDetailSchema>;

export const errorPayloadSchema = z.strictObject({
  code: errorCodeSchema,
  message: z.string().max(ERROR_MESSAGE_MAX_CHARS),
  detail: errorDetailSchema.optional(),
  text: messageRefSchema.optional(),
});
export type ErrorPayload = z.infer<typeof errorPayloadSchema>;

function clampMessage(message: string): string {
  if (message.length <= ERROR_MESSAGE_MAX_CHARS) return message;
  // Do not cut a surrogate pair in half: a lone surrogate would make the payload fail its own schema elsewhere.
  let end = ERROR_MESSAGE_MAX_CHARS;
  const last = message.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end -= 1;
  return message.slice(0, end);
}

/**
 * The one error type that crosses the wire. `toPayload()` / `SmurgError.fromPayload()` round-trip through the
 * `error` Envelope; anything else thrown inside the daemon is converted with `SmurgError.wrap()` so internal details
 * (absolute host paths in fs errors, stack traces) never reach a client.
 *
 * The second argument says what happened:
 *  - a message reference (`msg('worktree.inUse', {...})`): `.text` is the reference, `.message` its English rendering;
 *  - nothing: the default reference of the code (`error.default.<code>`);
 *  - a plain string: `.message` is that string and there is no `.text` (tests, and text that is not ours to translate).
 */
export class SmurgError extends Error {
  readonly code: ErrorCode;
  readonly detail: ErrorDetail | undefined;
  /** The message as a reference a client renders in its own language (see above). */
  readonly text: MessageRef | undefined;

  constructor(code: ErrorCode, message?: string | MessageRef, detail?: ErrorDetail, options?: { cause?: unknown; text?: MessageRef }) {
    const known = isErrorCode(code) ? code : 'internal';
    const text = typeof message === 'string' ? options?.text : (message ?? defaultErrorRef(known));
    super(typeof message === 'string' ? message : renderEnglish(text as MessageRef), options?.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'SmurgError';
    this.code = known;
    this.detail = detail;
    this.text = text;
  }

  /** The `error` Envelope payload. The message is clamped to ERROR_MESSAGE_MAX_CHARS. */
  toPayload(): ErrorPayload {
    const payload: ErrorPayload = { code: this.code, message: clampMessage(this.message) };
    if (this.detail !== undefined) payload.detail = this.detail;
    if (this.text !== undefined) payload.text = this.text;
    return payload;
  }

  static fromPayload(payload: ErrorPayload): SmurgError {
    return new SmurgError(payload.code, payload.message, payload.detail, payload.text === undefined ? undefined : { text: payload.text });
  }

  /**
   * Returns `err` itself when it is a SmurgError, otherwise an `internal` error with a generic message. The original
   * error is kept as `cause` for local logging only; it is never serialised.
   */
  static wrap(err: unknown): SmurgError {
    if (err instanceof SmurgError) return err;
    return new SmurgError('internal', undefined, undefined, { cause: err });
  }
}

export function isSmurgError(value: unknown): value is SmurgError {
  return value instanceof SmurgError;
}
