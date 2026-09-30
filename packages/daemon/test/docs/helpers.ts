// TEST ONLY helpers for the docs module: a fake LockManager (the real one is built by another engineer against the
// same interface), a fake ActivityFeed that records calls, and DocClient: a client-side y-protocols provider over the
// real client SDK Connection (what the web app's provider does, without Monaco).
import {
  DOC_TEXT_NAME,
  fileRefKey,
  type FileRef,
  type LockInfo,
  type PayloadOf,
  type ResultOf,
} from '@smurg/protocol';
import type { Connection } from '@smurg/protocol/client';
import * as decoding from 'lib0/decoding';
import * as encoding from 'lib0/encoding';
import * as awarenessProtocol from 'y-protocols/awareness';
import * as syncProtocol from 'y-protocols/sync';
import * as Y from 'yjs';
import type { DaemonContext, FeatureModule } from '../../src/core/context.ts';
import type { ActivityFeed, AgentLockResult, EventBus, HumanTouchResult, LockChangeReason, LockManager, UserId } from '../../src/core/interfaces.ts';
import { toDisposable } from '../../src/core/lifecycle.ts';

type HumanLock = Extract<LockInfo, { kind: 'human' }>;
type AgentLock = Extract<LockInfo, { kind: 'agent' }>;

/** In-memory LockManager with the contract's semantics (shared human lock, exclusive agent lock, lock.changed). */
export class FakeLockManager implements LockManager {
  bus: EventBus | null = null;
  private readonly locks = new Map<string, LockInfo>();
  readonly touches: { file: FileRef; userId: UserId; result: HumanTouchResult }[] = [];

  get(file: FileRef): LockInfo | null {
    return this.locks.get(fileRefKey(file)) ?? null;
  }

  list(): LockInfo[] {
    return [...this.locks.values()];
  }

  touchHuman(file: FileRef, holder: { readonly userId: UserId; readonly displayName: string }): HumanTouchResult {
    const current = this.get(file);
    let result: HumanTouchResult;
    if (current?.kind === 'agent') result = { ok: false, lock: current };
    else {
      const now = Date.now();
      if (!current) {
        const lock: HumanLock = { kind: 'human', file, holders: [{ ...holder, lastActivityAt: now }], acquiredAt: now };
        this.set(file, lock, null, 'acquired');
        result = { ok: true, lock, acquired: true };
      } else {
        const joined = !current.holders.some((h) => h.userId === holder.userId);
        const holders = joined
          ? [...current.holders, { ...holder, lastActivityAt: now }]
          : current.holders.map((h) => (h.userId === holder.userId ? { ...h, lastActivityAt: now } : h));
        const lock: HumanLock = { ...current, holders };
        this.set(file, lock, current, joined ? 'holder-joined' : 'touched');
        result = { ok: true, lock, acquired: false };
      }
    }
    this.touches.push({ file, userId: holder.userId, result });
    return result;
  }

  leaveHuman(file: FileRef, userId: UserId): void {
    const current = this.get(file);
    if (current?.kind !== 'human' || !current.holders.some((h) => h.userId === userId)) return;
    const holders = current.holders.filter((h) => h.userId !== userId);
    if (holders.length === 0) this.set(file, null, current, 'released');
    else this.set(file, { ...current, holders }, current, 'holder-left');
  }

  leaveAllHuman(userId: UserId): void {
    for (const lock of this.list()) if (lock.kind === 'human') this.leaveHuman(lock.file, userId);
  }

  requestAgent(input: Parameters<LockManager['requestAgent']>[0]): AgentLockResult {
    const current = this.get(input.file);
    if (current) return { granted: false, holder: current, reason: '此檔案正由其他人編輯中，請先處理其他檔案或稍後再試' };
    const now = Date.now();
    const lock: AgentLock = { kind: 'agent', file: input.file, sessionId: input.sessionId, ownerUserId: input.ownerUserId, agentName: input.agentName, acquiredAt: now, expiresAt: now + 60_000 };
    this.set(input.file, lock, null, 'acquired');
    return { granted: true, lock };
  }

  markAwaitingApproval(): void {}

  releaseAgent(sessionId: string, file?: FileRef): void {
    for (const lock of this.list()) {
      if (lock.kind === 'agent' && lock.sessionId === sessionId && (!file || fileRefKey(file) === fileRefKey(lock.file))) this.set(lock.file, null, lock, 'released');
    }
  }

  releaseAllForSession(sessionId: string): void {
    this.releaseAgent(sessionId);
  }

  forceRelease(file: FileRef): LockInfo | null {
    const current = this.get(file);
    if (current) this.set(file, null, current, 'forced');
    return current;
  }

  whoIsEditing(file: FileRef): ReturnType<LockManager['whoIsEditing']> {
    const lock = this.get(file);
    return { humans: lock?.kind === 'human' ? lock.holders : [], agent: lock?.kind === 'agent' ? lock : null };
  }

  async waitForRelease(file: FileRef): Promise<LockInfo | null> {
    return this.get(file);
  }

  private set(file: FileRef, lock: LockInfo | null, previous: LockInfo | null, reason: LockChangeReason): void {
    if (lock) this.locks.set(fileRefKey(file), lock);
    else this.locks.delete(fileRefKey(file));
    this.bus?.emit('lock.changed', { file, lock, previous, reason });
  }
}

export class FakeActivity implements ActivityFeed {
  readonly records: Parameters<ActivityFeed['record']>[0][] = [];

  record(input: Parameters<ActivityFeed['record']>[0]): ReturnType<ActivityFeed['record']> {
    this.records.push(input);
    return { id: `act_${this.records.length}`, at: Date.now(), actor: input.actor, kind: input.kind, ...(input.file ? { file: input.file } : {}), summary: input.summary };
  }

  async list(): Promise<{ events: [] }> {
    return { events: [] };
  }

  notify(): void {}
}

/** A module filling the `locks` and `activity` slots with the fakes. */
export function fakeLocksModule(locks: FakeLockManager, activity: FakeActivity = new FakeActivity()): FeatureModule {
  return {
    name: 'fake-locks',
    create: (ctx: DaemonContext) => {
      locks.bus = ctx.bus;
      return { locks, activity };
    },
    register: () => toDisposable(() => {}),
  };
}

// ---------------------------------------------------------------------------------------------------------------
// DocClient
// ---------------------------------------------------------------------------------------------------------------

type DocEventType = 'doc.sync' | 'doc.awareness' | 'doc.rejected' | 'doc.saved' | 'doc.reset';

/** Per-Connection dispatch of doc.* events by docId; buffers events that arrive before the DocClient exists. */
class DocRouter {
  private readonly clients = new Map<string, DocClient>();
  private readonly buffered = new Map<string, { type: DocEventType; payload: { docId: string } }[]>();

  constructor(conn: Connection) {
    for (const type of ['doc.sync', 'doc.awareness', 'doc.rejected', 'doc.saved', 'doc.reset'] as const) {
      conn.on(type, (payload) => this.dispatch(type, payload as { docId: string }));
    }
  }

  attach(docId: string, client: DocClient): void {
    this.clients.set(docId, client);
    const pending = this.buffered.get(docId) ?? [];
    this.buffered.delete(docId);
    for (const event of pending) client.handle(event.type, event.payload as never);
  }

  detach(docId: string): void {
    this.clients.delete(docId);
  }

  private dispatch(type: DocEventType, payload: { docId: string }): void {
    const client = this.clients.get(payload.docId);
    if (client) client.handle(type, payload as never);
    else {
      const list = this.buffered.get(payload.docId) ?? [];
      list.push({ type, payload });
      this.buffered.set(payload.docId, list);
    }
  }
}

const routers = new WeakMap<Connection, DocRouter>();
function routerFor(conn: Connection): DocRouter {
  let router = routers.get(conn);
  if (!router) {
    router = new DocRouter(conn);
    routers.set(conn, router);
  }
  return router;
}

const liveClients = new Set<DocClient>();

/** Destroys every DocClient created so far (timers of Awareness): call from afterEach. */
export function destroyDocClients(): void {
  for (const client of [...liveClients]) client.destroy();
}

export class DocClient {
  readonly conn: Connection;
  readonly opened: ResultOf<'doc.open'>;
  readonly doc = new Y.Doc();
  readonly text: Y.Text;
  readonly awareness: awarenessProtocol.Awareness;
  readonly rejected: PayloadOf<'doc.rejected'>[] = [];
  readonly saved: PayloadOf<'doc.saved'>[] = [];
  readonly resets: PayloadOf<'doc.reset'>[] = [];
  synced = false;
  private destroyed = false;

  static async open(conn: Connection, file: FileRef, options: { readonly awareness?: boolean } = {}): Promise<DocClient> {
    const router = routerFor(conn);
    const opened = await conn.request('doc.open', { file });
    const client = new DocClient(conn, opened, options.awareness ?? true);
    router.attach(opened.docId, client);
    client.connect();
    return client;
  }

  private constructor(conn: Connection, opened: ResultOf<'doc.open'>, withAwareness: boolean) {
    this.conn = conn;
    this.opened = opened;
    this.text = this.doc.getText(DOC_TEXT_NAME);
    this.awareness = new awarenessProtocol.Awareness(this.doc);
    if (!withAwareness) this.awareness.setLocalState(null);
    liveClients.add(this);
    this.doc.on('update', (update: Uint8Array, origin: unknown) => {
      if (origin === this || this.destroyed) return;
      const encoder = encoding.createEncoder();
      syncProtocol.writeUpdate(encoder, update);
      this.notify('doc.sync', { docId: this.opened.docId, data: encoding.toUint8Array(encoder) });
    });
    this.awareness.on('update', ({ added, updated, removed }: { added: number[]; updated: number[]; removed: number[] }, origin: unknown) => {
      if (origin === this || this.destroyed) return;
      const mine = [...added, ...updated, ...removed].filter((id) => id === this.doc.clientID);
      if (mine.length > 0) this.sendAwareness(mine);
    });
  }

  get docId(): string {
    return this.opened.docId;
  }

  /** Sync step 1 and our own awareness (what a provider does on every (re)connect). */
  connect(): void {
    const encoder = encoding.createEncoder();
    syncProtocol.writeSyncStep1(encoder, this.doc);
    this.notify('doc.sync', { docId: this.docId, data: encoding.toUint8Array(encoder) });
    if (this.awareness.getLocalState() !== null) this.sendAwareness([this.doc.clientID]);
  }

  handle(type: DocEventType, payload: never): void {
    if (this.destroyed) return;
    switch (type) {
      case 'doc.sync': {
        const { data } = payload as PayloadOf<'doc.sync'>;
        const encoder = encoding.createEncoder();
        const kind = syncProtocol.readSyncMessage(decoding.createDecoder(data), encoder, this.doc, this);
        if (encoding.length(encoder) > 0) this.notify('doc.sync', { docId: this.docId, data: encoding.toUint8Array(encoder) });
        if (kind === syncProtocol.messageYjsSyncStep2) this.synced = true;
        break;
      }
      case 'doc.awareness':
        awarenessProtocol.applyAwarenessUpdate(this.awareness, (payload as PayloadOf<'doc.awareness'>).data, this);
        break;
      case 'doc.rejected':
        this.rejected.push(payload);
        break;
      case 'doc.saved':
        this.saved.push(payload);
        break;
      case 'doc.reset':
        this.resets.push(payload);
        break;
    }
  }

  /** The cursor as y-monaco publishes it: a relative position in the text. */
  setCursor(index: number): void {
    const position = Y.relativePositionToJSON(Y.createRelativePositionFromTypeIndex(this.text, index));
    this.awareness.setLocalStateField('selection', { anchor: position, head: position });
  }

  /** Remote awareness states, excluding our own. */
  remoteStates(): Map<number, Record<string, unknown>> {
    const out = new Map<number, Record<string, unknown>>();
    for (const [id, state] of this.awareness.getStates()) if (id !== this.doc.clientID) out.set(id, state);
    return out;
  }

  close(): void {
    this.notify('doc.close', { docId: this.docId });
    this.destroy();
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    liveClients.delete(this);
    routers.get(this.conn)?.detach(this.docId);
    this.awareness.destroy();
    this.doc.destroy();
  }

  private sendAwareness(clients: number[]): void {
    this.notify('doc.awareness', { docId: this.docId, data: awarenessProtocol.encodeAwarenessUpdate(this.awareness, clients) });
  }

  /** A closed connection (the test closed it on purpose) drops what we send instead of throwing. */
  private notify(type: 'doc.sync' | 'doc.awareness' | 'doc.close', payload: { docId: string; data?: Uint8Array }): void {
    try {
      this.conn.notify(type, payload as never);
    } catch {
      // closed
    }
  }
}

/** A position in `text` that does not split a surrogate pair. */
export function safeIndex(text: string, index: number): number {
  const code = text.charCodeAt(index - 1);
  return index > 0 && code >= 0xd800 && code <= 0xdbff ? index - 1 : index;
}

export const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
