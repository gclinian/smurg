import { z } from 'zod';

// Error codes and the error Envelope payload (ARCHITECTURE §4.3): request X is answered by `X.ok` or by `error` with
// the same id and payload `{ code, message, detail? }`.
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
});
export type ErrorPayload = z.infer<typeof errorPayloadSchema>;

const DEFAULT_MESSAGES_ZH_TW: Readonly<Record<ErrorCode, string>> = Object.freeze({
  bad_request: '請求格式不正確',
  unauthorized: '尚未通過身分驗證',
  forbidden: '你沒有權限執行這個動作',
  not_found: '找不到指定的項目',
  conflict: '與目前的狀態衝突，請重新整理後再試',
  locked: '這個檔案目前被鎖定',
  path_denied: '不允許存取這個路徑',
  insufficient_disk: '主人的磁碟空間不足',
  too_large: '內容太大',
  host_only: '只有主人可以執行這個動作',
  internal: '主人端發生內部錯誤',
});

/** A generic, user-facing (zh-TW) message for `code`, used when no specific message is given. */
export function defaultErrorMessage(code: ErrorCode): string {
  return isErrorCode(code) ? DEFAULT_MESSAGES_ZH_TW[code] : DEFAULT_MESSAGES_ZH_TW.internal;
}

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
 */
export class SmurgError extends Error {
  readonly code: ErrorCode;
  readonly detail: ErrorDetail | undefined;

  constructor(code: ErrorCode, message?: string, detail?: ErrorDetail, options?: { cause?: unknown }) {
    super(message ?? defaultErrorMessage(code), options);
    this.name = 'SmurgError';
    this.code = isErrorCode(code) ? code : 'internal';
    this.detail = detail;
  }

  /** The `error` Envelope payload. The message is clamped to ERROR_MESSAGE_MAX_CHARS. */
  toPayload(): ErrorPayload {
    const payload: ErrorPayload = { code: this.code, message: clampMessage(this.message) };
    if (this.detail !== undefined) payload.detail = this.detail;
    return payload;
  }

  static fromPayload(payload: ErrorPayload): SmurgError {
    return new SmurgError(payload.code, payload.message, payload.detail);
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
