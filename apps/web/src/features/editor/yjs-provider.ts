// The Yjs provider of one open document over the encrypted Envelope channel (yjs-monaco.md Q1, ported from the
// verified spike `src/client/EnvelopeYjsProvider.ts`). No DOM, no Monaco: the doc-session layer and the tests drive it.
//
// Wire: `doc.sync` carries exactly the bytes y-protocols' sync protocol produces (step 1, step 2, update);
// `doc.awareness` an encoded awareness update. The transport is the docs store (lib/stores/docs.ts), which BUFFERS
// both per docId until someone subscribes (the daemon sends sync step 1 and an awareness snapshot right behind
// doc.open.ok, gotcha 5), so subscribing late never loses the initial state.
//
// Differences from the spike, each for a reason:
//  - the Awareness belongs to the caller (the doc session), not to the provider: after a reconnect the session puts a
//    NEW provider on the SAME Y.Doc and Awareness, so y-monaco's binding (which holds the awareness) stays valid;
//  - destroy() never sends anything: after doc.close / a channel change the daemon has forgotten the subscription
//    and would answer an awareness removal with an error (refused requests count towards a disconnect);
//  - connect() re-announces the local awareness state with a NEW clock (setLocalState), because a peer that removed
//    our state keeps the old clock and would ignore a re-send of the same one;
//  - every send and every receive is guarded: a throw inside a Y.Doc 'update' handler would break y-monaco.
import * as decoding from 'lib0/decoding';
import * as encoding from 'lib0/encoding';
import * as awarenessProtocol from 'y-protocols/awareness';
import * as syncProtocol from 'y-protocols/sync';
import type * as Y from 'yjs';

/** What the provider needs from the connection: exactly the docs store's routing API. */
export interface DocTransport {
  onDocMessages(docId: string, handler: { sync(data: Uint8Array): void; awareness(data: Uint8Array): void }): () => void;
  sendSync(docId: string, data: Uint8Array): void;
  sendAwareness(docId: string, data: Uint8Array): void;
}

export type ProviderEvent =
  /** The first sync step 2 from the daemon since connect(): the replica holds the daemon's text. */
  | { readonly type: 'synced' }
  /** A message could not be sent (connection closed, payload refused): the daemon did not get a local change. */
  | { readonly type: 'send-failed'; readonly error: unknown }
  /** A message from the daemon could not be applied: the replica can no longer be trusted. */
  | { readonly type: 'receive-failed'; readonly error: unknown };

interface AwarenessChange {
  readonly added: readonly number[];
  readonly updated: readonly number[];
  readonly removed: readonly number[];
}

export class EnvelopeYjsProvider {
  readonly docId: string;
  readonly doc: Y.Doc;
  readonly awareness: awarenessProtocol.Awareness;
  private readonly transport: DocTransport;
  private readonly listeners = new Set<(event: ProviderEvent) => void>();
  private unsubscribe: (() => void) | null;
  private connectedFlag = false;
  private syncedFlag = false;
  private destroyedFlag = false;

  constructor(docId: string, doc: Y.Doc, awareness: awarenessProtocol.Awareness, transport: DocTransport) {
    if (awareness.doc !== doc) throw new Error('EnvelopeYjsProvider: the awareness must belong to the same Y.Doc');
    this.docId = docId;
    this.doc = doc;
    this.awareness = awareness;
    this.transport = transport;
    doc.on('update', this.onDocUpdate);
    awareness.on('update', this.onAwarenessUpdate);
    // Subscribe last: buffered messages are delivered synchronously, and they need the listeners above in place.
    this.unsubscribe = transport.onDocMessages(docId, { sync: this.onSync, awareness: this.onAwareness });
  }

  get connected(): boolean {
    return this.connectedFlag;
  }

  /** True after the first sync step 2 since the last connect(). */
  get synced(): boolean {
    return this.syncedFlag;
  }

  get destroyed(): boolean {
    return this.destroyedFlag;
  }

  on(listener: (event: ProviderEvent) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /**
   * Starts (or restarts) the exchange: sends our state vector (sync step 1) so the daemon answers with what we lack,
   * and re-announces our presence. Local edits made while disconnected reach the daemon through our answer to its
   * step 1 (step 2), never through replayed updates.
   */
  connect(): void {
    if (this.destroyedFlag) return;
    this.connectedFlag = true;
    this.syncedFlag = false;
    const encoder = encoding.createEncoder();
    syncProtocol.writeSyncStep1(encoder, this.doc);
    this.send('sync', encoding.toUint8Array(encoder));
    const local = this.awareness.getLocalState();
    // A new clock: triggers onAwarenessUpdate, which sends it (see the header).
    if (local !== null) this.awareness.setLocalState(local);
  }

  /** The channel dropped: nothing is sent any more, and other people's presence is stale. */
  disconnect(): void {
    this.connectedFlag = false;
    this.syncedFlag = false;
    const others = [...this.awareness.getStates().keys()].filter((clientId) => clientId !== this.doc.clientID);
    if (others.length > 0) awarenessProtocol.removeAwarenessStates(this.awareness, others, this);
    // removeAwarenessStates keeps a remote client's clock: the daemon's snapshot after the reconnect carries the SAME
    // clock for someone who did not move, and y-protocols would ignore it (their cursor would never come back).
    for (const clientId of others) this.awareness.meta.delete(clientId);
  }

  /** Detaches from the transport and the Y.Doc. Sends nothing; the Y.Doc and the Awareness stay usable. */
  destroy(): void {
    if (this.destroyedFlag) return;
    this.disconnect();
    this.destroyedFlag = true;
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.doc.off('update', this.onDocUpdate);
    this.awareness.off('update', this.onAwarenessUpdate);
    this.listeners.clear();
  }

  private emit(event: ProviderEvent): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(event);
      } catch (error) {
        queueMicrotask(() => {
          throw error;
        });
      }
    }
  }

  private send(kind: 'sync' | 'awareness', data: Uint8Array): void {
    if (this.destroyedFlag) return;
    try {
      if (kind === 'sync') this.transport.sendSync(this.docId, data);
      else this.transport.sendAwareness(this.docId, data);
    } catch (error) {
      // Awareness is best effort; a lost sync message means the daemon lacks a local change.
      if (kind === 'sync') this.emit({ type: 'send-failed', error });
    }
  }

  private readonly onSync = (data: Uint8Array): void => {
    if (this.destroyedFlag) return;
    const encoder = encoding.createEncoder();
    let messageType: number;
    try {
      // Origin `this`: what the daemon sent is not echoed back (onDocUpdate).
      messageType = syncProtocol.readSyncMessage(decoding.createDecoder(data), encoder, this.doc, this);
    } catch (error) {
      this.emit({ type: 'receive-failed', error });
      return;
    }
    if (encoding.length(encoder) > 0) this.send('sync', encoding.toUint8Array(encoder));
    if (messageType === syncProtocol.messageYjsSyncStep2 && !this.syncedFlag && this.connectedFlag) {
      this.syncedFlag = true;
      this.emit({ type: 'synced' });
    }
  };

  private readonly onAwareness = (data: Uint8Array): void => {
    if (this.destroyedFlag) return;
    try {
      awarenessProtocol.applyAwarenessUpdate(this.awareness, data, this);
    } catch {
      // A malformed presence update only costs a cursor; the daemon validates what it forwards anyway.
    }
  };

  private readonly onDocUpdate = (update: Uint8Array, origin: unknown): void => {
    // Offline edits go out with the next connect() (step 1 / step 2).
    if (origin === this || !this.connectedFlag || this.destroyedFlag) return;
    const encoder = encoding.createEncoder();
    syncProtocol.writeUpdate(encoder, update);
    this.send('sync', encoding.toUint8Array(encoder));
  };

  private readonly onAwarenessUpdate = (change: AwarenessChange, origin: unknown): void => {
    if (origin === this || !this.connectedFlag || this.destroyedFlag) return;
    // Only ever publish OUR client id (the daemon enforces this too).
    const mine = [...change.added, ...change.updated, ...change.removed].filter((clientId) => clientId === this.doc.clientID);
    if (mine.length > 0) this.send('awareness', awarenessProtocol.encodeAwarenessUpdate(this.awareness, mine));
  };
}
