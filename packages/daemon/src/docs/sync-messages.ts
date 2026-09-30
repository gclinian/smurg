// y-protocols sync messages (the `data` of doc.sync), parsed by hand so the daemon decides BEFORE applying anything:
// step 1 carries a state vector (never content), step 2 and update carry a Yjs update (content). y-protocols' own
// readSyncMessage applies content unconditionally and swallows errors, which is exactly what must not happen for a
// member without file.write.
import * as decoding from 'lib0/decoding';
import * as encoding from 'lib0/encoding';
import * as Y from 'yjs';

export const SYNC_STEP1 = 0;
export const SYNC_STEP2 = 1;
export const SYNC_UPDATE = 2;

export type SyncMessage =
  | { readonly kind: 'step1'; readonly stateVector: Uint8Array }
  | { readonly kind: 'step2' | 'update'; readonly update: Uint8Array };

/** Throws on anything that is not exactly one well-formed sync message. */
export function parseSyncMessage(data: Uint8Array): SyncMessage {
  const decoder = decoding.createDecoder(data);
  const type = decoding.readVarUint(decoder);
  const payload = decoding.readVarUint8Array(decoder);
  if (decoding.hasContent(decoder)) throw new RangeError('trailing bytes after the sync message');
  if (type === SYNC_STEP1) return { kind: 'step1', stateVector: payload };
  if (type === SYNC_STEP2) return { kind: 'step2', update: payload };
  if (type === SYNC_UPDATE) return { kind: 'update', update: payload };
  throw new RangeError('unknown sync message type');
}

/**
 * True when a (v1) update carries no structs and no deletions: what a client with nothing new answers to the
 * daemon's step 1 (`[0, 0]`). Such a message is not an edit, even from a viewer (yjs-monaco.md gotcha 22).
 */
export function isEmptyUpdate(update: Uint8Array): boolean {
  const decoder = decoding.createDecoder(update);
  if (decoding.readVarUint(decoder) !== 0) return false; // clients with structs
  return decoding.readVarUint(decoder) === 0; // clients in the delete set
}

export function encodeStep1(doc: Y.Doc): Uint8Array {
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, SYNC_STEP1);
  encoding.writeVarUint8Array(encoder, Y.encodeStateVector(doc));
  return encoding.toUint8Array(encoder);
}

/** Step 2 answering a peer's state vector: everything the peer is missing. Throws on a malformed state vector. */
export function encodeStep2(doc: Y.Doc, stateVector: Uint8Array): Uint8Array {
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, SYNC_STEP2);
  encoding.writeVarUint8Array(encoder, Y.encodeStateAsUpdate(doc, stateVector));
  return encoding.toUint8Array(encoder);
}

export function encodeUpdateMessage(update: Uint8Array): Uint8Array {
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, SYNC_UPDATE);
  encoding.writeVarUint8Array(encoder, update);
  return encoding.toUint8Array(encoder);
}
