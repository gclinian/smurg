// Every awareness update from a client is decoded, checked and re-encoded before it reaches the room (ARCHITECTURE
// §7.5, yjs-monaco.md Q1 + V5). A client may only speak for the client ids bound to its subscription, only its
// `selection` survives (validated with the strict RelativePosition schema and normalised through Yjs), and `user`
// is always the daemon's view of the member. A malformed selection never reaches a peer: payloads such as
// `{item:{client:1,clock:-5}}` would make Y.createAbsolutePositionFromRelativePosition throw on every peer
// (y-monaco calls it without try/catch).
//
// Wire format (y-protocols awareness): varUint count, then per entry varUint clientID, varUint clock, varString JSON.
import { awarenessStateSchema, sanitizeAwarenessSelection, type AwarenessState, type AwarenessUser } from '@smurg/protocol';
import * as decoding from 'lib0/decoding';
import * as encoding from 'lib0/encoding';

/** Entries accepted in one update (a client speaks for one id; a few more cover reloads). */
export const MAX_AWARENESS_ENTRIES = 16;

export interface AwarenessEntry {
  readonly clientId: number;
  readonly clock: number;
  /** null: the client removed its state. */
  readonly state: AwarenessState | null;
}

export type AwarenessDropReason = 'client-id' | 'malformed-state' | 'selection';

export interface FilteredAwareness {
  readonly entries: readonly AwarenessEntry[];
  readonly dropped: readonly { readonly clientId: number; readonly reason: AwarenessDropReason }[];
}

/**
 * Decodes `data`, keeps what is acceptable and rewrites it. `mayUse(clientId)` decides (and records) the binding of
 * a client id to the sender. Throws on bytes that are not an awareness update at all.
 */
export function filterAwarenessUpdate(data: Uint8Array, user: AwarenessUser, mayUse: (clientId: number) => boolean): FilteredAwareness {
  const decoder = decoding.createDecoder(data);
  const count = decoding.readVarUint(decoder);
  if (count > MAX_AWARENESS_ENTRIES) throw new RangeError('too many awareness entries');
  const entries: AwarenessEntry[] = [];
  const dropped: { clientId: number; reason: AwarenessDropReason }[] = [];
  for (let i = 0; i < count; i++) {
    const clientId = decoding.readVarUint(decoder);
    const clock = decoding.readVarUint(decoder);
    const json = decoding.readVarString(decoder);
    let raw: unknown;
    try {
      raw = JSON.parse(json);
    } catch {
      dropped.push({ clientId, reason: 'malformed-state' });
      continue;
    }
    if (raw !== null && (typeof raw !== 'object' || Array.isArray(raw))) {
      dropped.push({ clientId, reason: 'malformed-state' });
      continue;
    }
    let state: AwarenessState | null = null;
    if (raw !== null) {
      const selection = Object.hasOwn(raw, 'selection') ? (raw as Record<string, unknown>)['selection'] : null;
      const sanitized = sanitizeAwarenessSelection(selection);
      if (!sanitized.ok) {
        dropped.push({ clientId, reason: 'selection' });
        continue;
      }
      const parsed = awarenessStateSchema.safeParse({ user, selection: sanitized.selection });
      if (!parsed.success) {
        dropped.push({ clientId, reason: 'malformed-state' });
        continue;
      }
      state = parsed.data;
    }
    // Bind only after the entry proved acceptable: garbage must not use up the sender's client-id budget.
    if (!mayUse(clientId)) {
      dropped.push({ clientId, reason: 'client-id' });
      continue;
    }
    entries.push({ clientId, clock, state });
  }
  return { entries, dropped };
}

/** Re-encodes accepted entries in the y-protocols format (for applyAwarenessUpdate on the room's Awareness). */
export function encodeAwarenessEntries(entries: readonly AwarenessEntry[]): Uint8Array {
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, entries.length);
  for (const entry of entries) {
    encoding.writeVarUint(encoder, entry.clientId);
    encoding.writeVarUint(encoder, entry.clock);
    encoding.writeVarString(encoder, JSON.stringify(entry.state));
  }
  return encoding.toUint8Array(encoder);
}
