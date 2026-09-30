// The registry of open documents (SPEC R7/R8, ARCHITECTURE §5.3, yjs-monaco.md Q1). It owns the doc.* control
// messages (open, close, reset, saved, rejected) and routes the Yjs traffic (doc.sync / doc.awareness) to whoever
// binds the document (onDocMessages) — the editor feature's Yjs provider. It does NOT hold Y.Docs itself.
//
// Rules the editor relies on:
//  - doc.sync / doc.awareness for a docId are BUFFERED until someone subscribes (the daemon sends sync step 1 and an
//    awareness snapshot right after doc.open.ok, yjs-monaco.md gotcha 5), then delivered in arrival order.
//  - `generation` of an OpenDoc increments whenever its docId or epoch changes (a reopen after a full resync, or
//    doc.reset). The editor then disposes its binding and subscribes again with the new docId; if the EPOCH differs
//    it must also drop its Y.Doc and start from a fresh one (two separately loaded Y.Docs duplicate the text, gotcha 4).
//  - The active document is reported as presence (presence.update) automatically.
//  - An open document whose file is deleted or moved away (file.changed 'unlink' of it, 'unlinkDir' of a folder above
//    it) is marked `removed` (review WEB-01): the editor turns read-only and says so instead of letting people type
//    into a document nobody can save. A rename the local user made re-points the tab (followRename); someone else's
//    rename is recognised from its activity event and offered as `removed.movedTo`. The file coming back ('add')
//    clears the mark.
import {
  can,
  fileRefEquals,
  fileRefKey,
  isRelPathWithin,
  rootRefEquals,
  rootRefKey,
  type Actor,
  type ActivityEvent,
  type FileRef,
  type LockInfo,
  type PayloadOf,
  type ResultOf,
  type RootRef,
} from '@smurg/protocol';
import { createStore, type ReadableStore } from '../store.ts';
import { describeError } from '../errors.ts';
import { tStores } from '../../strings/stores.ts';
import type { AreaLifecycle, StoreContext } from './base.ts';
import type { PresenceStore } from './presence.ts';

export type DocMeta = ResultOf<'doc.open'>['meta'];

/** The open document's file was deleted or moved away (see the header). */
export interface DocRemoval {
  readonly at: number;
  /** Who did it, when the daemon attributed the change. */
  readonly by: Actor | null;
  /** Its new path in the same root, when it was renamed or moved (or a folder above it was). */
  readonly movedTo: string | null;
}
export type DocRejectReason = PayloadOf<'doc.rejected'>['reason'];

export type DocStatus =
  /** doc.open in flight (first time). */
  | 'opening'
  /** Bound on the current channel. */
  | 'open'
  /** doc.open again after a full resync; docId/epoch still the old ones. */
  | 'reopening'
  /** doc.open failed (too large, binary, not UTF-8, forbidden, …): `error` says why. */
  | 'error';

export interface OpenDoc {
  /** fileRefKey(file) */
  readonly key: string;
  readonly file: FileRef;
  readonly status: DocStatus;
  readonly docId: string | null;
  readonly epoch: string | null;
  /**
   * Whether this member may type here when no agent holds the file: from doc.open (role, read-only shared dir), with
   * an agent lock at open time not counted against it.
   */
  readonly editableBase: boolean;
  /** Current lock of the file (live from lock.state and doc.rejected). */
  readonly lock: LockInfo | null;
  readonly meta: DocMeta | null;
  readonly generation: number;
  readonly error: string | null;
  readonly saved: { readonly hash: string; readonly at: number } | null;
  readonly rejected: { readonly reason: DocRejectReason; readonly at: number } | null;
  /** The file is gone from its path (deleted, renamed, moved); null while it is there. */
  readonly removed: DocRemoval | null;
}

export interface DocsState {
  /** By key. */
  readonly docs: ReadonlyMap<string, OpenDoc>;
  /** Tab order. */
  readonly order: readonly string[];
  readonly activeKey: string | null;
}

export interface DocMessageHandler {
  sync(data: Uint8Array): void;
  awareness(data: Uint8Array): void;
}

export interface DocsStore extends ReadableStore<DocsState> {
  /** Opens (or activates, if already open) the document of `file`. Resolves when doc.open answered. */
  open(file: FileRef, options?: { activate?: boolean }): Promise<OpenDoc>;
  /** Closes the document (doc.close) and removes it from the registry. */
  close(key: string): void;
  activate(key: string | null): void;
  /** New tab order (must be a permutation of the open keys). */
  reorder(keys: readonly string[]): void;
  /**
   * Receives doc.sync / doc.awareness of `docId`, starting with everything buffered since doc.open. One receiver per
   * docId (the editor's Yjs provider); a second one replaces the first.
   */
  onDocMessages(docId: string, handler: DocMessageHandler): () => void;
  /** Sends a y-protocols sync message (step 1, step 2 or update). */
  sendSync(docId: string, data: Uint8Array): void;
  /** Sends an encoded awareness update. */
  sendAwareness(docId: string, data: Uint8Array): void;
  /**
   * The local user renamed `from` (a file or a folder) to `to` in `root`: every open document at or below `from` is
   * closed and its new path opened in the same tab position (the active one stays active).
   */
  followRename(root: RootRef, from: string, to: string): void;
}

/** Whether the local user may type into `doc` right now (UI only; the daemon enforces). */
export function isDocEditable(doc: OpenDoc | undefined): boolean {
  return doc !== undefined && doc.status === 'open' && doc.removed === null && doc.editableBase && doc.lock?.kind !== 'agent';
}

/** How long a rename's activity event is remembered to pair it with the watcher's 'unlink' of the old path. */
export const RENAME_MEMORY_MS = 30_000;

const RENAME_PREFIX = '重新命名 ';
const RENAME_ARROW = ' → ';

/**
 * The old path of a file.rename activity event. The protocol carries only the new path (`file`); the daemon's summary
 * is exactly 「重新命名 {from} → {to}」 (packages/daemon/src/files/file-service.ts). Anything else (a cut summary, another
 * wording) yields null and the document is shown as deleted rather than guessed at.
 */
export function renamedFrom(event: ActivityEvent): string | null {
  if (event.kind !== 'file.rename' || event.file === undefined) return null;
  const suffix = `${RENAME_ARROW}${event.file.path}`;
  const { summary } = event;
  if (!summary.startsWith(RENAME_PREFIX) || !summary.endsWith(suffix)) return null;
  const from = summary.slice(RENAME_PREFIX.length, summary.length - suffix.length);
  return from.length > 0 && !from.includes(RENAME_ARROW) ? from : null;
}

/** Where `path` ends up when `from` is renamed to `to` (itself, or something below a renamed folder). */
function movedPath(path: string, from: string, to: string): string | null {
  if (path === from) return to;
  return from !== '' && isRelPathWithin(path, from) ? `${to}${path.slice(from.length)}` : null;
}

export const selectActiveDoc = (state: DocsState): OpenDoc | undefined => (state.activeKey === null ? undefined : state.docs.get(state.activeKey));
export const selectOpenDocs = (state: DocsState): OpenDoc[] => state.order.map((key) => state.docs.get(key)).filter((doc): doc is OpenDoc => doc !== undefined);
export function selectDocByFile(state: DocsState, file: FileRef): OpenDoc | undefined {
  return state.docs.get(fileRefKey(file));
}

/** Guard against a subscriber that never comes: beyond this the document is marked failed and must be reopened. */
export const DOC_BUFFER_MAX_MESSAGES = 1024;
export const DOC_BUFFER_MAX_BYTES = 16 * 1024 * 1024;
/**
 * Messages for a docId the registry does not know YET: the daemon sends sync step 1 right behind doc.open.ok, and the
 * SDK may dispatch it before the doc.open promise continuation recorded the docId. Kept this long, then dropped.
 */
export const DOC_ORPHAN_TTL_MS = 10_000;
export const DOC_ORPHAN_MAX_MESSAGES = 64;

interface Buffer {
  messages: { kind: 'sync' | 'awareness'; data: Uint8Array }[];
  bytes: number;
  createdAt: number;
}

export const INITIAL_DOCS_STATE: DocsState = Object.freeze({ docs: new Map(), order: [], activeKey: null });

export function createDocsArea(presence: PresenceStore): { store: DocsStore; lifecycle: AreaLifecycle } {
  const state = createStore<DocsState>(INITIAL_DOCS_STATE);
  let ctx: StoreContext | null = null;
  const handlers = new Map<string, DocMessageHandler>();
  const buffers = new Map<string, Buffer>();
  const opening = new Map<string, Promise<OpenDoc>>();
  /** Renames from the activity feed (someone else's), until the watcher's 'unlink' of the old path pairs with them. */
  const renames = new Map<string, { readonly root: RootRef; readonly from: string; readonly to: string; readonly by: Actor; readonly at: number }>();

  const context = (): StoreContext => {
    if (!ctx) throw new Error('docs store is not bound to a connection');
    return ctx;
  };

  const update = (key: string, patch: (doc: OpenDoc) => OpenDoc): void => {
    state.setState((previous) => {
      const doc = previous.docs.get(key);
      if (!doc) return previous;
      const docs = new Map(previous.docs);
      docs.set(key, patch(doc));
      return { ...previous, docs };
    });
  };

  const findByDocId = (docId: string): OpenDoc | undefined => {
    for (const doc of state.getState().docs.values()) if (doc.docId === docId) return doc;
    return undefined;
  };

  const forgetDocId = (docId: string | null): void => {
    if (docId === null) return;
    handlers.delete(docId);
    buffers.delete(docId);
  };

  /** Drops buffers of docIds that never became known (a closed doc, an older channel) once they are old enough. */
  const pruneOrphans = (now: number): void => {
    for (const [docId, buffer] of buffers) {
      if (findByDocId(docId) === undefined && now - buffer.createdAt > DOC_ORPHAN_TTL_MS) buffers.delete(docId);
    }
  };

  const deliver = (docId: string, kind: 'sync' | 'awareness', data: Uint8Array): void => {
    const handler = handlers.get(docId);
    if (handler) {
      handler[kind](data);
      return;
    }
    const now = context().scheduler.now();
    pruneOrphans(now);
    const doc = findByDocId(docId);
    let buffer = buffers.get(docId);
    if (!buffer) {
      buffer = { messages: [], bytes: 0, createdAt: now };
      buffers.set(docId, buffer);
    }
    buffer.messages.push({ kind, data });
    buffer.bytes += data.byteLength;
    if (!doc) {
      // Not known (yet): keep only the head of it (step 1 and an awareness snapshot come first).
      if (buffer.messages.length > DOC_ORPHAN_MAX_MESSAGES) buffers.delete(docId);
      return;
    }
    if (buffer.messages.length > DOC_BUFFER_MAX_MESSAGES || buffer.bytes > DOC_BUFFER_MAX_BYTES) {
      buffers.delete(docId);
      update(doc.key, (d) => ({ ...d, status: 'error', error: tStores('docs.bufferOverflow') }));
    }
  };

  /** doc.open for `file`, applied to the registry entry `key` (created by open() / kept by resync). */
  const runOpen = (file: FileRef, key: string): Promise<OpenDoc> => {
    const c = context();
    const generation = c.generation();
    const promise = c.conn
      .request('doc.open', { file })
      .then(
        (result) => {
          const current = state.getState().docs.get(key);
          if (!current || c.generation() !== generation) {
            // Closed meanwhile, or the channel changed again: release the daemon side of this open.
            if (c.generation() === generation) notifyClose(result.docId);
            return current ?? toClosedDoc(file, key);
          }
          forgetDocId(current.docId);
          const roleMayWrite = can(c.role() ?? 'viewer', 'file.write');
          const next: OpenDoc = {
            ...current,
            status: 'open',
            docId: result.docId,
            epoch: result.epoch,
            editableBase: result.canEdit || (result.lock?.kind === 'agent' && roleMayWrite),
            lock: result.lock ?? null,
            meta: result.meta,
            generation: current.generation + 1,
            error: null,
            // doc.open found the file: it is where the tab says.
            removed: null,
          };
          update(key, () => next);
          return next;
        },
        (error: unknown) => {
          // A failure that belongs to an older channel says nothing about the reopen in progress.
          if (c.generation() === generation) update(key, (doc) => ({ ...doc, status: 'error', error: describeError(error) }));
          throw error;
        },
      )
      .finally(() => {
        if (opening.get(key) === promise) opening.delete(key);
      });
    opening.set(key, promise);
    return promise;
  };

  const notifyClose = (docId: string): void => {
    try {
      context().conn.notify('doc.close', { docId }, { whenDisconnected: 'drop' });
    } catch {
      // Connection closed: the daemon drops the subscription with the channel.
    }
  };

  const markRemoved = (key: string, removed: DocRemoval | null): void => {
    update(key, (doc) => ({ ...doc, removed }));
    // Nobody is looking at a file that is not there: presence must not keep saying so (the host console lists it).
    if (state.getState().activeKey === key) {
      const doc = state.getState().docs.get(key);
      presence.setActiveFile(removed === null && doc ? doc.file : null);
    }
  };

  const renameOf = (doc: OpenDoc): { readonly to: string; readonly by: Actor } | null => {
    for (const rename of renames.values()) {
      if (!rootRefEquals(rename.root, doc.file.root)) continue;
      const to = movedPath(doc.file.path, rename.from, rename.to);
      if (to !== null) return { to, by: rename.by };
    }
    return null;
  };

  const onFilesChanged = ({ root, changes }: PayloadOf<'file.changed'>): void => {
    const now = context().scheduler.now();
    for (const [key, rename] of renames) if (now - rename.at > RENAME_MEMORY_MS) renames.delete(key);
    for (const doc of state.getState().docs.values()) {
      if (!rootRefEquals(doc.file.root, root)) continue;
      let removed = doc.removed;
      for (const change of changes) {
        if (change.change === 'add' && change.path === doc.file.path) {
          removed = null;
        } else if ((change.change === 'unlink' && change.path === doc.file.path) || (change.change === 'unlinkDir' && isRelPathWithin(doc.file.path, change.path))) {
          const rename = renameOf(doc);
          removed = { at: now, by: change.by ?? rename?.by ?? null, movedTo: rename?.to ?? null };
        }
      }
      if (removed !== doc.removed) markRemoved(doc.key, removed);
    }
  };

  const onActivity = (event: ActivityEvent): void => {
    const from = renamedFrom(event);
    if (from === null || event.file === undefined) return;
    const rename = { root: event.file.root, from, to: event.file.path, by: event.actor, at: context().scheduler.now() };
    renames.set(`${rootRefKey(rename.root)}\u0000${from}`, rename);
    // The watcher may have reported the old path gone already.
    for (const doc of state.getState().docs.values()) {
      if (doc.removed === null || doc.removed.movedTo !== null || !rootRefEquals(doc.file.root, rename.root)) continue;
      const to = movedPath(doc.file.path, from, rename.to);
      if (to !== null) markRemoved(doc.key, { ...doc.removed, movedTo: to, by: doc.removed.by ?? rename.by });
    }
  };

  const setActive = (key: string | null): void => {
    const current = state.getState();
    if (current.activeKey === key) return;
    state.setState({ ...current, activeKey: key });
    const doc = key === null ? undefined : current.docs.get(key);
    presence.setActiveFile(doc && doc.removed === null ? doc.file : null);
  };

  const store: DocsStore = {
    getState: state.getState,
    subscribe: state.subscribe,
    open(file, options = {}) {
      const key = fileRefKey(file);
      const activate = options.activate !== false;
      const existing = state.getState().docs.get(key);
      if (existing && existing.status !== 'error') {
        if (activate) setActive(key);
        return opening.get(key) ?? Promise.resolve(existing);
      }
      const entry: OpenDoc = existing
        ? { ...existing, status: 'opening', error: null }
        : {
            key,
            file,
            status: 'opening',
            docId: null,
            epoch: null,
            editableBase: false,
            lock: null,
            meta: null,
            generation: 0,
            error: null,
            saved: null,
            rejected: null,
            removed: null,
          };
      state.setState((previous) => {
        const docs = new Map(previous.docs);
        docs.set(key, entry);
        return { ...previous, docs, order: previous.order.includes(key) ? previous.order : [...previous.order, key] };
      });
      if (activate) setActive(key);
      return runOpen(file, key);
    },
    close(key) {
      const current = state.getState();
      const doc = current.docs.get(key);
      if (!doc) return;
      if (doc.docId !== null) notifyClose(doc.docId);
      forgetDocId(doc.docId);
      const docs = new Map(current.docs);
      docs.delete(key);
      const index = current.order.indexOf(key);
      const order = current.order.filter((k) => k !== key);
      state.setState({ docs, order, activeKey: current.activeKey });
      if (current.activeKey === key) setActive(order[Math.min(index, order.length - 1)] ?? null);
    },
    activate: setActive,
    reorder(keys) {
      const current = state.getState();
      if (keys.length !== current.order.length || !keys.every((key) => current.docs.has(key))) return;
      state.setState({ ...current, order: [...keys] });
    },
    onDocMessages(docId, handler) {
      handlers.set(docId, handler);
      const buffered = buffers.get(docId);
      buffers.delete(docId);
      if (buffered) for (const message of buffered.messages) handler[message.kind](message.data);
      return () => {
        if (handlers.get(docId) === handler) handlers.delete(docId);
      };
    },
    sendSync(docId, data) {
      context().conn.notify('doc.sync', { docId, data });
    },
    sendAwareness(docId, data) {
      context().conn.notify('doc.awareness', { docId, data }, { whenDisconnected: 'drop' });
    },
    followRename(root, from, to) {
      for (const key of [...state.getState().order]) {
        const doc = state.getState().docs.get(key);
        if (!doc || !rootRefEquals(doc.file.root, root)) continue;
        const target = movedPath(doc.file.path, from, to);
        if (target === null) continue;
        const file: FileRef = { root, path: target };
        const newKey = fileRefKey(file);
        const wasActive = state.getState().activeKey === key;
        const index = state.getState().order.indexOf(key);
        store.close(key);
        if (state.getState().docs.has(newKey)) {
          if (wasActive) setActive(newKey);
          continue;
        }
        // The tab shows why if the new path cannot be opened (the editor feature records the failure).
        store.open(file, { activate: wasActive }).catch(() => {});
        state.setState((previous) => {
          const order = previous.order.filter((k) => k !== newKey);
          order.splice(Math.min(index, order.length), 0, newKey);
          return { ...previous, order };
        });
      }
    },
  };

  const lifecycle: AreaLifecycle = {
    bind(c) {
      ctx = c;
      const offs = [
        c.conn.on('doc.sync', ({ docId, data }) => deliver(docId, 'sync', data)),
        c.conn.on('doc.awareness', ({ docId, data }) => deliver(docId, 'awareness', data)),
        c.conn.on('doc.reset', ({ docId, epoch }) => {
          const doc = findByDocId(docId);
          if (!doc) return;
          buffers.delete(docId);
          update(doc.key, (d) => ({ ...d, epoch, generation: d.generation + 1 }));
        }),
        c.conn.on('doc.saved', ({ docId, hash, at }) => {
          const doc = findByDocId(docId);
          if (doc) update(doc.key, (d) => ({ ...d, saved: { hash, at } }));
        }),
        c.conn.on('doc.rejected', ({ docId, reason, lock }) => {
          const doc = findByDocId(docId);
          if (!doc) return;
          const at = c.scheduler.now();
          update(doc.key, (d) => ({
            ...d,
            rejected: { reason, at },
            lock: lock ?? d.lock,
            // 'read-only' / 'forbidden' / 'file-unavailable': the daemon will not accept edits from us at all.
            editableBase: reason === 'agent-locked' ? d.editableBase : false,
          }));
        }),
        c.conn.on('file.changed', onFilesChanged),
        c.conn.on('activity.event', ({ event }) => onActivity(event)),
        c.conn.on('lock.state', ({ file, lock }) => {
          const doc = state.getState().docs.get(fileRefKey(file));
          if (doc && fileRefEquals(doc.file, file)) update(doc.key, (d) => ({ ...d, lock }));
        }),
      ];
      return () => {
        for (const off of offs) off();
      };
    },
    reset() {
      // The daemon forgot every subscription with the old channel. Keep the entries (tabs stay), drop the routing.
      handlers.clear();
      buffers.clear();
      opening.clear();
      state.setState((previous) => {
        const docs = new Map<string, OpenDoc>();
        for (const [key, doc] of previous.docs) docs.set(key, { ...doc, status: doc.status === 'error' ? 'error' : 'reopening' });
        return { ...previous, docs };
      });
    },
    async load() {
      const docs = [...state.getState().docs.values()].filter((doc) => doc.status === 'reopening');
      const results = await Promise.allSettled(docs.map((doc) => runOpen(doc.file, doc.key)));
      const failed = results.find((result) => result.status === 'rejected');
      if (failed && failed.status === 'rejected') ctx?.reportError('docs', failed.reason);
    },
    onRoleChange(role) {
      // The daemon checks the role on every message, so open documents follow the new role at once. Demoted: nothing
      // is editable. Promoted: editable again; a read-only file (shared dir of a worktree) answers doc.rejected
      // 'read-only' on the first edit, which turns it back off.
      const mayWrite = can(role, 'file.write');
      state.setState((previous) => {
        const docs = new Map<string, OpenDoc>();
        for (const [key, doc] of previous.docs) docs.set(key, { ...doc, editableBase: mayWrite });
        return { ...previous, docs };
      });
    },
  };

  return { store, lifecycle };
}

function toClosedDoc(file: FileRef, key: string): OpenDoc {
  return {
    key,
    file,
    status: 'error',
    docId: null,
    epoch: null,
    editableBase: false,
    lock: null,
    meta: null,
    generation: 0,
    error: null,
    saved: null,
    rejected: null,
    removed: null,
  };
}
