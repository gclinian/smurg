// One DocSession per open document: the local replica (Y.Doc + Awareness) and the provider that keeps it in sync,
// driven by the docs store's OpenDoc (lib/stores/docs.ts). No DOM and no Monaco: the Monaco view binds to
// `session.ytext` / `session.awareness` when `replicaSynced` is true and re-binds whenever `replica` changes.
//
// Rules (yjs-monaco.md Q1, gotchas 3, 4 and 28; ARCHITECTURE §5.3):
//  - a replica is bound ONCE, after its first sync step 2: `replicaSynced` turns true then and stays true across
//    reconnects (a reconnect emits 'synced' again; binding twice throws "Cannot add model because it already exists");
//  - a new EPOCH (daemon restarted / re-created its Y.Doc: doc.reset or a reopen) drops the replica and starts from a
//    fresh Y.Doc: syncing two separately loaded Y.Docs duplicates the whole text;
//  - the same epoch after a reconnect (new docId or new channel) keeps the replica: a new provider on the same Y.Doc
//    merges offline edits through step 1 / step 2, and the editor binding stays;
//  - doc.rejected 'read-only' / 'forbidden' / 'file-unavailable': the daemon DROPPED our update, so our replica holds text nobody else has
//    and would re-send it with every step 2: drop the replica (a fresh Y.Doc re-syncs from the daemon). 'agent-locked'
//    was applied-then-reverted by the daemon, so the revert reaches us like any update and nothing more is needed.
//  - text typed while the host was unreachable is never thrown away with a dropped replica (review REL-07): a new epoch
//    (daemon restart, or a host outage long enough for the daemon to discard the channel and the room) or a divergence
//    drops a replica that may hold edits the daemon never received. The session keeps that replica's text L and the
//    text B from before the first of those edits. Once the new replica has synced to the daemon's text N:
//      N === L → nothing was lost;  N === B (and the file is editable) → L is applied again (the daemon still had
//      exactly what we started from, so our text is the merge);  otherwise → `recovery` holds L and the editor offers
//      to copy it or to put it back (DocumentPane) — the text is kept until the user decides.
//    An edit counts as confirmed (B moves on) only through a doc.saved that arrived SAVE_CONFIRM_MARGIN_MS or more
//    after it: a save the daemon made before our last keystroke reached it confirms nothing.
//
// The registry reacts to the docs store SYNCHRONOUSLY (a plain store subscription, never a React effect): after a
// doc.reset the daemon's next sync step 1 is dispatched right behind it and must reach the NEW replica.
import { DOC_TEXT_NAME, errorReasonOf, isSmurgError, type ErrorCode } from '@smurg/protocol';
import { isTerminalState, type ConnectionState } from '@smurg/protocol/client';
import * as awarenessProtocol from 'y-protocols/awareness';
import * as Y from 'yjs';
import { createStore, type ReadableStore, type WritableStore } from '../../lib/store.ts';
import { isDocEditable, type DocsState, type DocsStore, type OpenDoc } from '../../lib/stores/docs.ts';
import { EnvelopeYjsProvider, type DocTransport, type ProviderEvent } from './yjs-provider.ts';

export type ReplicaDropReason = 'epoch' | 'rejected' | 'diverged';

/**
 * What became of local text a dropped replica may have held: `none` (no unconfirmed edits, or the daemon had them all),
 * `checking` (waiting for the new replica's first sync), `restored` (applied again), `recovery` (kept in `recovery`).
 */
export type DropOutcome = 'none' | 'checking' | 'restored' | 'recovery';

/** A doc.saved received at least this long after the last local edit confirms the edits before it (see header). */
export const SAVE_CONFIRM_MARGIN_MS = 1_500;

/** Origin of the transaction that puts recovered text back (a local edit: it is sent and saved like typing). */
export const RECOVERY_ORIGIN = Symbol('smurg-recovery');

export interface OpenFailure {
  readonly code: ErrorCode | 'unknown';
  /** `detail.reason` of the daemon's error (e.g. 'binary', 'invalid-utf8', 'too-large'). */
  readonly reason: string | null;
}

export interface DocSessionState {
  readonly key: string;
  /** Increments whenever the Y.Doc is replaced: the view disposes its model + binding and binds the new one. */
  readonly replica: number;
  /** The current replica received its first sync step 2 (stays true across reconnects). */
  readonly replicaSynced: boolean;
  /** A provider is attached to the current docId and connected. */
  readonly live: boolean;
  readonly epoch: string | null;
  /** A local edit that no doc.saved has followed yet. */
  readonly pendingSave: boolean;
  /** Local clock (session `now()`) of the last local edit / the last doc.saved that reached us. */
  readonly lastLocalEditAt: number | null;
  readonly lastSavedAt: number | null;
  /** Why the replica was last dropped while bound, when, and what became of local text it may have held. */
  readonly dropped: { readonly reason: ReplicaDropReason; readonly at: number; readonly outcome: DropOutcome } | null;
  /**
   * Local text of a dropped replica that could not be merged into the daemon's new text automatically (REL-07): kept
   * until the user copies it, puts it back (applyRecovery) or discards it.
   */
  readonly recovery: { readonly text: string; readonly reason: Exclude<ReplicaDropReason, 'rejected'>; readonly at: number } | null;
  /** The structured error of the last failed doc.open (the store keeps only a sentence). */
  readonly openFailure: OpenFailure | null;
}

export interface DocSession extends ReadableStore<DocSessionState> {
  readonly key: string;
  /** The current replica. Replaced (see `replica`) on epoch changes and rejections. */
  readonly doc: Y.Doc;
  readonly ytext: Y.Text;
  readonly awareness: awarenessProtocol.Awareness;
  setOpenFailure(error: unknown): void;
  /**
   * Replaces the document's text with `recovery.text` (a local edit, sent and saved like typing) and clears it. False
   * (nothing changes) when there is no recovery, or the replica is not synced / the file is not editable right now.
   */
  applyRecovery(): boolean;
  /** Forgets `recovery`. */
  discardRecovery(): void;
}

export interface DocSessionOptions {
  readonly now?: () => number;
}

class DocSessionImpl implements DocSession {
  readonly key: string;
  private readonly transport: DocTransport;
  private readonly now: () => number;
  private readonly state: WritableStore<DocSessionState>;
  private replicaDoc: Y.Doc;
  private replicaAwareness: awarenessProtocol.Awareness;
  private provider: EnvelopeYjsProvider | null = null;
  private recovering = false;
  private offProvider: (() => void) | null = null;
  private attachedDocId: string | null = null;
  private attachedGeneration = -1;
  private lastDoc: OpenDoc | null = null;
  private disposed = false;
  /** Text of the current replica before its first local edit that is not confirmed yet; null: nothing unconfirmed. */
  private unconfirmedBase: string | null = null;
  /** A dropped replica's text (and its base) waiting for the new replica's first sync. */
  private carried: { readonly text: string; readonly base: string; readonly reason: Exclude<ReplicaDropReason, 'rejected'> } | null = null;

  constructor(key: string, transport: DocTransport, options: DocSessionOptions) {
    this.key = key;
    this.transport = transport;
    this.now = options.now ?? Date.now;
    this.state = createStore<DocSessionState>({
      key,
      replica: 0,
      replicaSynced: false,
      live: false,
      epoch: null,
      pendingSave: false,
      lastLocalEditAt: null,
      lastSavedAt: null,
      dropped: null,
      recovery: null,
      openFailure: null,
    });
    const replica = this.createReplica();
    this.replicaDoc = replica.doc;
    this.replicaAwareness = replica.awareness;
  }

  getState = (): DocSessionState => this.state.getState();
  subscribe = (listener: () => void): (() => void) => this.state.subscribe(listener);

  get doc(): Y.Doc {
    return this.replicaDoc;
  }

  get ytext(): Y.Text {
    return this.replicaDoc.getText(DOC_TEXT_NAME);
  }

  get awareness(): awarenessProtocol.Awareness {
    return this.replicaAwareness;
  }

  setOpenFailure(error: unknown): void {
    const failure: OpenFailure = isSmurgError(error) ? { code: error.code, reason: errorReasonOf(error) } : { code: 'unknown', reason: null };
    this.patch({ openFailure: failure });
  }

  applyRecovery(): boolean {
    const recovery = this.getState().recovery;
    if (this.disposed || recovery === null || !this.getState().replicaSynced || this.lastDoc === null || !isDocEditable(this.lastDoc)) return false;
    spliceText(this.replicaDoc, recovery.text);
    this.patch({ recovery: null });
    return true;
  }

  discardRecovery(): void {
    if (this.getState().recovery !== null) this.patch({ recovery: null });
  }

  /** Follows the docs store's entry for this document. */
  sync(doc: OpenDoc): void {
    if (this.disposed || doc === this.lastDoc) return;
    const previous = this.lastDoc;
    this.lastDoc = doc;
    if (doc.saved !== null && doc.saved !== previous?.saved) {
      const at = this.now();
      const lastEdit = this.getState().lastLocalEditAt;
      if (lastEdit === null || at - lastEdit >= SAVE_CONFIRM_MARGIN_MS) this.unconfirmedBase = null;
      this.patch({ pendingSave: false, lastSavedAt: at });
    }
    if (doc.status === 'open' && this.getState().openFailure !== null) this.patch({ openFailure: null });

    const rejectedNow = doc.rejected !== null && doc.rejected !== previous?.rejected;
    if (doc.status === 'open' && doc.docId !== null && doc.epoch !== null) {
      const epochChanged = this.getState().epoch !== null && this.getState().epoch !== doc.epoch;
      const mustDrop = epochChanged || (rejectedNow && doc.rejected?.reason !== 'agent-locked');
      if (mustDrop) this.dropReplica(epochChanged ? 'epoch' : 'rejected', { keepRemotePresence: !epochChanged });
      if (this.getState().epoch !== doc.epoch) this.patch({ epoch: doc.epoch });
      if (mustDrop || this.provider === null || this.attachedDocId !== doc.docId || this.attachedGeneration !== doc.generation) {
        this.attach(doc.docId, doc.generation);
      }
    } else {
      // opening / reopening / error: the daemon does not know this subscription (any more).
      this.detach();
    }
    // The change was dropped by the daemon either way (reverted or ignored): nothing is waiting for a save.
    if (rejectedNow) this.patch({ pendingSave: false });
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.detach();
    // The (destroyed) replica stays readable: a view that unmounts after this may still touch it.
    this.destroyReplica(this.replicaDoc, this.replicaAwareness);
  }

  // ---- internals

  private patch(partial: Partial<DocSessionState>): void {
    this.state.setState((previous) => ({ ...previous, ...partial }));
  }

  private createReplica(): { doc: Y.Doc; awareness: awarenessProtocol.Awareness } {
    const doc = new Y.Doc();
    const awareness = new awarenessProtocol.Awareness(doc);
    doc.on('beforeTransaction', this.onBeforeTransaction);
    doc.on('update', this.onLocalUpdate);
    return { doc, awareness };
  }

  /**
   * The text before a local transaction while nothing is unconfirmed: it becomes the base of a later recovery if the
   * transaction changes anything (onLocalUpdate).
   */
  private beforeLocal: string | null = null;

  private readonly onBeforeTransaction = (transaction: Y.Transaction, doc: Y.Doc): void => {
    this.beforeLocal = null;
    if (this.unconfirmedBase !== null || transaction.origin instanceof EnvelopeYjsProvider || doc !== this.replicaDoc) return;
    this.beforeLocal = doc.getText(DOC_TEXT_NAME).toString();
  };

  private readonly onLocalUpdate = (_update: Uint8Array, origin: unknown): void => {
    // Updates from the daemon carry the provider as origin; everything else is typed here (y-monaco's binding).
    if (origin instanceof EnvelopeYjsProvider) return;
    if (this.unconfirmedBase === null) this.unconfirmedBase = this.beforeLocal ?? '';
    this.beforeLocal = null;
    this.patch({ pendingSave: true, lastLocalEditAt: this.now() });
  };

  private attach(docId: string, generation: number): void {
    this.detach();
    const provider = new EnvelopeYjsProvider(docId, this.replicaDoc, this.replicaAwareness, this.transport);
    this.provider = provider;
    this.attachedDocId = docId;
    this.attachedGeneration = generation;
    this.offProvider = provider.on(this.onProviderEvent);
    provider.connect();
    // connect() may have been answered synchronously (a fake transport); only mark live if still attached.
    if (this.provider === provider) this.patch({ live: true });
  }

  private readonly onProviderEvent = (event: ProviderEvent): void => {
    switch (event.type) {
      case 'synced':
        if (!this.getState().replicaSynced) {
          // Before the view binds: it then shows the text as it will stay.
          this.resolveCarried();
          this.patch({ replicaSynced: true });
        }
        return;
      case 'receive-failed':
      case 'send-failed': {
        // The replica and the daemon's document may differ now: start over from the daemon's text, ONCE. If that
        // fails too (the connection is closing, the payload is refused), stay detached until the store changes.
        const docId = this.attachedDocId;
        const generation = this.attachedGeneration;
        if (docId === null || this.recovering) {
          this.detach();
          return;
        }
        this.recovering = true;
        try {
          this.dropReplica('diverged', { keepRemotePresence: true });
          this.attach(docId, generation);
        } finally {
          this.recovering = false;
        }
        return;
      }
    }
  };

  private detach(): void {
    this.offProvider?.();
    this.offProvider = null;
    this.provider?.destroy();
    this.provider = null;
    this.attachedDocId = null;
    this.attachedGeneration = -1;
    if (this.getState().live) this.patch({ live: false });
  }

  private dropReplica(reason: ReplicaDropReason, options: { keepRemotePresence: boolean }): void {
    const old = this.replicaAwareness;
    const wasBound = this.getState().replicaSynced;
    // Other people's cursors point at items of the daemon's document, which a fresh replica of the SAME epoch
    // receives again: carry them over so they do not vanish until those people move.
    const remote = options.keepRemotePresence ? [...old.getStates().keys()].filter((id) => id !== old.clientID) : [];
    const carried = remote.length > 0 ? awarenessProtocol.encodeAwarenessUpdate(old, remote) : null;
    // Local text the daemon may never have received (REL-07). A rejection is different: the daemon refused it on
    // purpose and doc.rejected said so. A replica dropped again before it synced still waits for the earlier text.
    const base = this.unconfirmedBase;
    this.unconfirmedBase = null;
    if (reason === 'rejected') {
      this.carried = null;
    } else if (wasBound && base !== null) {
      const text = this.replicaDoc.getText(DOC_TEXT_NAME).toString();
      this.carried = text === base ? null : { text, base, reason };
    }
    this.detach();
    this.destroyReplica(this.replicaDoc, this.replicaAwareness);
    const { doc, awareness } = this.createReplica();
    this.replicaDoc = doc;
    this.replicaAwareness = awareness;
    if (carried !== null) {
      try {
        awarenessProtocol.applyAwarenessUpdate(awareness, carried, 'carried');
      } catch {
        // presence only
      }
    }
    const previous = this.getState().dropped;
    this.patch({
      replica: this.getState().replica + 1,
      replicaSynced: false,
      pendingSave: false,
      dropped: wasBound
        ? { reason, at: this.now(), outcome: this.carried === null ? 'none' : 'checking' }
        : previous === null || this.carried !== null
          ? previous
          : { ...previous, outcome: previous.outcome === 'checking' ? 'none' : previous.outcome },
    });
  }

  /** The new replica has the daemon's text: decide what happens to the dropped replica's text (see header). */
  private resolveCarried(): void {
    const carried = this.carried;
    this.carried = null;
    if (carried === null) return;
    const current = this.ytext.toString();
    let outcome: DropOutcome;
    if (current === carried.text) {
      outcome = 'none';
    } else if (current === carried.base && this.lastDoc !== null && isDocEditable(this.lastDoc)) {
      spliceText(this.replicaDoc, carried.text);
      outcome = 'restored';
    } else {
      outcome = 'recovery';
      this.patch({ recovery: { text: carried.text, reason: carried.reason, at: this.now() } });
    }
    const dropped = this.getState().dropped;
    if (dropped !== null) this.patch({ dropped: { ...dropped, outcome } });
  }

  private destroyReplica(doc: Y.Doc, awareness: awarenessProtocol.Awareness): void {
    doc.off('update', this.onLocalUpdate);
    // Awareness.destroy() stops its 3-second timer; nothing is sent (the provider is detached already).
    awareness.destroy();
    doc.destroy();
  }
}

/**
 * Turns the document's text into `target` with one delete + insert around the common prefix and suffix (a local
 * transaction, RECOVERY_ORIGIN). Never splits a surrogate pair: Y.Text counts UTF-16 units.
 */
export function spliceText(doc: Y.Doc, target: string): void {
  const text = doc.getText(DOC_TEXT_NAME);
  const current = text.toString();
  if (current === target) return;
  let start = 0;
  const max = Math.min(current.length, target.length);
  while (start < max && current.charCodeAt(start) === target.charCodeAt(start)) start++;
  if (start > 0 && isHighSurrogate(current.charCodeAt(start - 1))) start--;
  let endCurrent = current.length;
  let endTarget = target.length;
  while (endCurrent > start && endTarget > start && current.charCodeAt(endCurrent - 1) === target.charCodeAt(endTarget - 1)) {
    endCurrent--;
    endTarget--;
  }
  if (endCurrent < current.length && isLowSurrogate(current.charCodeAt(endCurrent))) {
    endCurrent++;
    endTarget++;
  }
  doc.transact(() => {
    if (endCurrent > start) text.delete(start, endCurrent - start);
    if (endTarget > start) text.insert(start, target.slice(start, endTarget));
  }, RECOVERY_ORIGIN);
}

const isHighSurrogate = (code: number): boolean => code >= 0xd800 && code <= 0xdbff;
const isLowSurrogate = (code: number): boolean => code >= 0xdc00 && code <= 0xdfff;

export interface DocSessionRegistry {
  /** The session of an open document (by fileRefKey), created as soon as the docs store lists it. */
  get(key: string): DocSession | undefined;
  /** Stops following the store and disposes every session. */
  dispose(): void;
}

export interface RegistrySources {
  readonly docs: DocsStore;
  /** The connection state: every session is disposed once the connection ended for good. */
  readonly connection?: ReadableStore<ConnectionState>;
}

export function createDocSessionRegistry(sources: RegistrySources, options: DocSessionOptions = {}): DocSessionRegistry {
  const { docs, connection } = sources;
  const sessions = new Map<string, DocSessionImpl>();
  let disposed = false;

  const reconcile = (state: DocsState): void => {
    if (disposed) return;
    for (const doc of state.docs.values()) {
      let session = sessions.get(doc.key);
      if (!session) {
        session = new DocSessionImpl(doc.key, docs, options);
        sessions.set(doc.key, session);
      }
      session.sync(doc);
    }
    for (const [key, session] of sessions) {
      if (state.docs.has(key)) continue;
      sessions.delete(key);
      session.dispose();
    }
  };

  const disposeAll = (): void => {
    if (disposed) return;
    disposed = true;
    offDocs();
    offConnection();
    for (const session of sessions.values()) session.dispose();
    sessions.clear();
  };

  const offDocs = docs.subscribe(() => reconcile(docs.getState()));
  const offConnection = connection
    ? connection.subscribe(() => {
        if (isTerminalState(connection.getState())) disposeAll();
      })
    : () => {};
  reconcile(docs.getState());

  return {
    get: (key) => sessions.get(key),
    dispose: disposeAll,
  };
}

const registries = new WeakMap<DocsStore, DocSessionRegistry>();

/**
 * The registry of a workspace's docs store, created on first use and kept as long as the store lives: open documents
 * must stay subscribed even while the editor area is not mounted (the host console route), or the store's buffers
 * would fill up. It disposes itself when the connection ends for good.
 */
export function docSessionsFor(sources: RegistrySources): DocSessionRegistry {
  let registry = registries.get(sources.docs);
  if (!registry) {
    registry = createDocSessionRegistry(sources);
    registries.set(sources.docs, registry);
  }
  return registry;
}
