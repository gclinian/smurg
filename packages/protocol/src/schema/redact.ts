import { DECODED_MAX_DEPTH } from './limits.ts';
import { parseWireType } from './registry.ts';

// Log-safe views of Envelope payloads. Debug logs and audit detail must never contain file contents, terminal data,
// keys or invite secrets (registry `sensitive` / `resultSensitive`). This produces a copy in which:
//  - every Uint8Array becomes `{ bytes: <length> }`;
//  - every string under a key listed in the type's `redact` becomes `"[redacted <n> chars]"`;
//  - payloads of unknown types are not copied at all.

export type RedactedBytes = { readonly bytes: number };

function isByteArray(value: unknown): value is Uint8Array {
  return (
    value instanceof Uint8Array ||
    (ArrayBuffer.isView(value) && Object.prototype.toString.call(value) === '[object Uint8Array]')
  );
}

function redactValue(value: unknown, keys: ReadonlySet<string>, depth: number): unknown {
  if (isByteArray(value)) return { bytes: value.byteLength } satisfies RedactedBytes;
  if (value === null || typeof value !== 'object') return value;
  if (depth >= DECODED_MAX_DEPTH) return '[too deep]';
  if (Array.isArray(value)) return value.map((item) => redactValue(item, keys, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    // defineProperty, not assignment: a `__proto__` key must stay a plain data property of the copy.
    const redacted =
      keys.has(key) && typeof item === 'string' ? `[redacted ${item.length} chars]` : redactValue(item, keys, depth + 1);
    Object.defineProperty(out, key, { value: redacted, enumerable: true, writable: true, configurable: true });
  }
  return out;
}

/**
 * Returns a copy of `payload` that is safe to write to a log. `type` is an Envelope type (a message type, `X.ok` or
 * `error`). The redaction is the same for sensitive and non-sensitive types, so a type that forgets its `redact`
 * list still never leaks bytes.
 */
export function redactForLog(type: string, payload: unknown): unknown {
  const parsed = parseWireType(type);
  if (parsed === null) return '[unknown message type: payload not logged]';
  return redactValue(payload, new Set(parsed.spec.redact), 0);
}

/** Whether an Envelope of this type carries data that must never be logged or audited verbatim. */
export function isSensitiveWireType(type: string): boolean {
  const parsed = parseWireType(type);
  if (parsed === null) return true; // unknown: assume the worst
  return parsed.kind === 'response' ? parsed.spec.resultSensitive : parsed.spec.sensitive;
}
