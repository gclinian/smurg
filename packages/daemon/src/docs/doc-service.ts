// DocService (SPEC R7, R8, D13; ARCHITECTURE §5.3, §7.5): rooms and subscriptions over doc.*, the human-edit rules,
// and the conflict panel's requests. Disk work (autosave, disk → Yjs) is DiskSync's; I/O checks are disk-io.ts's.
//
//  * Rooms are keyed by the RESOLVED file (native realpath): `README.md` and `readme.md` on APFS, or a file and an
//    in-share link to it, are one room, and its disk I/O always uses the canonical reference.
//  * Subscriptions are keyed by the logical channel (channelId), so they survive a resume; channel.discarded, a kick
//    or a leave ends them. A room outlives its last subscriber for a grace period, so a short disconnect merges
//    offline edits into the same Y.Doc (same epoch).
//  * Content from a member without file.write (or on a read-only / host-only path) is dropped, audited and answered
//    with doc.rejected. A human update while an agent holds the file's lock is applied, then reverted, so every
//    replica converges, and the sender gets doc.rejected (agent-locked).
import { realpath } from 'node:fs/promises';
import {
  AUTOSAVE_DEBOUNCE_MS,
  AUTOSAVE_MAX_WAIT_MS,
  MAX_DOC_BYTES,
  SmurgError,
  awarenessUserSchema,
  fileRefKey,
  type AwarenessUser,
  type ConflictRecord,
  type FileRef,
  type LockInfo,
  type PayloadOf,
  type ResultInputOf,
} from '@smurg/protocol';
import * as awarenessProtocol from 'y-protocols/awareness';
import * as Y from 'yjs';
import type { DaemonContext } from '../core/context.ts';
import { AuthorizationError, PathDeniedError } from '../core/errors.ts';
import type { ClientConnection, DocOpenStart, DocService, Principal, ResolvedPath, UserId } from '../core/interfaces.ts';
import { toDisposable, type Disposable } from '../core/lifecycle.ts';
import type { Logger } from '../core/logger.ts';
import { principalCan } from '../core/permissions.ts';
import { DocAccess, agentActorOf, foldedFileKey } from './access.ts';
import { applyCompactOps, inverseOfDelta, type TextDeltaItem } from './apply-ops.ts';
import { encodeAwarenessEntries, filterAwarenessUpdate } from './awareness-filter.ts';
import { DocCompute } from './compute.ts';
import { ConflictPanel, auditTarget } from './conflict-panel.ts';
import { mayWrite, readBounded, sha256Hex } from './disk-io.ts';
import { DiskSync, PAUSED_REJECT_REASON } from './disk-sync.ts';
import { DocRoom, HumanOrigin, REVERT_ORIGIN, Subscription, subscriptionKey, type PauseReason } from './room.ts';
import { encodeStep2, isEmptyUpdate, parseSyncMessage, type SyncMessage } from './sync-messages.ts';
import { classifyText, unsupportedMessage, type UnsupportedReason } from './text-codec.ts';

/** How long a room outlives its last subscriber, so a short disconnect merges offline edits (yjs-monaco.md Q1). */
export const DOC_ROOM_GRACE_MS = 60_000;
/** A disk change within this long after an agent's lock ended (or its PostToolUse) is attributed to that agent. */
export const AGENT_ATTRIBUTION_WINDOW_MS = 10_000;
/** Attempts of apply-agent-version while humans keep typing (a replacement must replace exactly what is there). */
const REPLACE_ATTEMPTS = 6;
/** stop() waits at most this long for unsaved documents. */
const STOP_FLUSH_TIMEOUT_MS = 10_000;

export interface DocServiceOptions {
  readonly debounceMs?: number;
  readonly maxWaitMs?: number;
  readonly graceMs?: number;
  readonly maxDocBytes?: number;
  readonly attributionWindowMs?: number;
  /** How long a paused document waits before its unsaved text is kept aside and its editors are told (tests). */
  readonly pauseConfirmMs?: number;
  /** Worker entry of the compute pool (null: inline, for tests of the fallback). */
  readonly computeWorkerUrl?: URL | null;
}

type DocSendType = 'doc.sync' | 'doc.awareness' | 'doc.reset' | 'doc.saved' | 'doc.rejected';

export class DocServiceImpl implements DocService {
  readonly compute: DocCompute;
  readonly panel: ConflictPanel;
  private readonly ctx: DaemonContext;
  private readonly log: Logger;
  private readonly access: DocAccess;
  private readonly disk: DiskSync;
  private readonly graceMs: number;
  private readonly maxDocBytes: number;
  /** Rooms by native realpath of the file. */
  private readonly rooms = new Map<string, DocRoom>();
  private readonly loading = new Map<string, Promise<DocRoom>>();
  private readonly subs = new Map<string, Subscription>();
  private readonly byChannel = new Map<string, Set<Subscription>>();
  private stopped = false;

  constructor(ctx: DaemonContext, options: DocServiceOptions = {}) {
    this.ctx = ctx;
    this.log = ctx.log.child({ module: 'docs' });
    this.graceMs = options.graceMs ?? DOC_ROOM_GRACE_MS;
    this.maxDocBytes = options.maxDocBytes ?? MAX_DOC_BYTES;
    this.access = new DocAccess(ctx, this.log);
    this.compute = new DocCompute({ log: this.log, ...(options.computeWorkerUrl !== undefined ? { workerUrl: options.computeWorkerUrl } : {}) });
    this.panel = new ConflictPanel(ctx, this.log);
    this.disk = new DiskSync({
      ctx,
      log: this.log,
      access: this.access,
      compute: this.compute,
      panel: this.panel,
      isStopped: () => this.stopped,
      send: (channelId: string, type: 'doc.saved' | 'doc.rejected', payload: Record<string, unknown>) => this.send(channelId, type, payload),
      options: {
        debounceMs: options.debounceMs ?? AUTOSAVE_DEBOUNCE_MS,
        maxWaitMs: options.maxWaitMs ?? AUTOSAVE_MAX_WAIT_MS,
        maxDocBytes: this.maxDocBytes,
        attributionWindowMs: options.attributionWindowMs ?? AGENT_ATTRIBUTION_WINDOW_MS,
        ...(options.pauseConfirmMs !== undefined ? { pauseConfirmMs: options.pauseConfirmMs } : {}),
      },
    });
  }

  // =================================================================================================================
  // Lifecycle (module start / register / stop)
  // =================================================================================================================

  start(): Promise<void> {
    return this.panel.open();
  }

  listen(): Disposable {
    const bus = this.ctx.bus;
    const subscriptions = [
      bus.on('channel.discarded', (e) => this.closeAllForChannel(e.channelId)),
      bus.on('member.left', (e) => this.closeAllForUser(e.userId)),
      bus.on('member.kicked', (e) => this.closeAllForUser(e.userId)),
      bus.on('file.changed', (e) => this.disk.onFileChanged(this.rooms.values(), e.root, e.changes)),
      bus.on('lock.changed', (e) => this.onLockChanged(e.file, e.lock, e.previous)),
      bus.on('agent.tool.post', (e) => {
        if (e.file) this.onAgentWrote(e.file, this.access.agentActor(e.sessionId, e.ownerUserId));
      }),
      bus.on('session.exited', (e) => this.clearAgentPresence(e.session.id)),
    ];
    return toDisposable(() => {
      for (const subscription of subscriptions) subscription.dispose();
    });
  }

  async stop(): Promise<void> {
    // Write unsaved text first (the watcher is still running: docs stops before files), but never hang the daemon's
    // stop behind a stuck job: after the bound, what is still unsaved is logged and dropped.
    let expire: (value: 'timeout') => void = () => {};
    const bound = new Promise<'timeout'>((resolve) => {
      expire = resolve;
    });
    const timer = setTimeout(() => expire('timeout'), STOP_FLUSH_TIMEOUT_MS);
    const outcome = await Promise.race([this.flushAll().then(() => 'flushed' as const), bound]);
    clearTimeout(timer);
    if (outcome === 'timeout') this.log.error('documents not saved before stop', { rooms: [...this.rooms.values()].filter((r) => r.dirty).length });
    this.stopped = true;
    for (const room of [...this.rooms.values()]) {
      if (room.paused !== null) this.disk.settlePause(room); // unsaved text of a paused room is kept, not dropped
      this.destroyRoom(room);
    }
    this.subs.clear();
    this.byChannel.clear();
    await this.compute.close();
    await this.panel.flush();
  }

  /** Writes every unsaved document now (stop, before a merge). */
  async flushAll(): Promise<void> {
    await Promise.all([...this.rooms.values()].map((room) => this.disk.saveSoon(room)));
  }

  // =================================================================================================================
  // doc.open / doc.close
  // =================================================================================================================

  async open(file: FileRef, conn: ClientConnection, principal: Principal): Promise<DocOpenStart> {
    if (this.stopped) throw new SmurgError('internal', undefined, { reason: 'stopping' });
    const userId = principal.userId;
    if (userId === null || principal.kind !== 'user') throw new SmurgError('forbidden');
    if (conn.purpose !== 'interactive') throw new SmurgError('bad_request', undefined, { reason: 'wrong-channel' });
    const paths = this.ctx.paths;
    const requested = await paths.resolve(file, { principal, mustExist: true });
    if (requested.identity === null || requested.identity.kind !== 'file') throw new SmurgError('bad_request', '只能在編輯器中開啟一般檔案', { reason: 'not-a-file' });
    // The room's key: the native realpath (symlinks resolved, on-disk case), mapped back to its most specific root.
    const realPath = await realpath(requested.realPath).catch(() => null);
    if (realPath === null) throw new SmurgError('not_found');
    const canonical = await paths.toFileRef(realPath);
    if (canonical === null) throw this.deny(principal, file, 'outside-root');
    const target = fileRefKey(canonical) === fileRefKey(requested.ref) ? requested : await paths.resolve(canonical, { principal, mustExist: true });
    if (target.realPath !== realPath || target.identity === null || target.identity.kind !== 'file') throw this.deny(principal, file, 'changed');
    if (target.identity.size > this.maxDocBytes) throw unsupported('too-large');
    const canWrite = principalCan(principal, 'file.write') && !requested.readOnly && !target.readOnly && (await mayWrite(paths, canonical, principal));

    const room = await this.roomFor(realPath, canonical, target, principal);
    room.holds += 1;
    try {
      if (room.destroyed || this.stopped) throw new SmurgError('internal', undefined, { reason: 'stopping' });
      room.aliases.add(fileRefKey(file));
      const sub = this.subscribe(room, conn.channelId, userId, canWrite);
      const lock = this.access.lockOf(room.ref);
      return {
        result: { docId: room.id, epoch: room.epoch, canEdit: canWrite && lock?.kind !== 'agent', ...(lock ? { lock } : {}), meta: room.meta },
        afterReply: () => {
          if (room.destroyed || this.subs.get(sub.key) !== sub) return;
          room.sendStep1(sub);
          room.sendAwarenessSnapshot(sub);
        },
      };
    } finally {
      room.holds -= 1;
    }
  }

  close(input: PayloadOf<'doc.close'>, conn: ClientConnection): void {
    const sub = this.subs.get(subscriptionKey(conn.channelId, input.docId));
    if (sub) this.unsubscribe(sub, 'closed');
  }

  closeAllForChannel(channelId: string): void {
    const set = this.byChannel.get(channelId);
    if (!set) return;
    for (const sub of [...set]) this.unsubscribe(sub, 'disconnected');
  }

  isOpen(file: FileRef): boolean {
    return this.findRoom(file) !== null;
  }

  lockBase(file: FileRef): string | null {
    return this.findRoom(file)?.lockBase ?? null;
  }

  private async roomFor(realPath: string, canonical: FileRef, target: ResolvedPath, principal: Principal): Promise<DocRoom> {
    for (;;) {
      const existing = this.rooms.get(realPath);
      if (existing && !existing.destroyed) {
        this.cancelGrace(existing);
        existing.holds += 1;
        try {
          // Catch up with the disk before a new member sees the text (the watcher may lag): cheap when unchanged.
          await existing.enqueue(() => this.disk.recheck(existing));
        } finally {
          existing.holds -= 1;
        }
        if (existing.destroyed) continue;
        if (existing.paused) throw this.pausedError(existing.paused, principal, canonical);
        return existing;
      }
      const pending = this.loading.get(realPath);
      if (pending) {
        await pending.catch(() => null);
        continue;
      }
      const load = this.load(realPath, canonical, target, principal);
      this.loading.set(realPath, load);
      try {
        return await load;
      } finally {
        this.loading.delete(realPath);
      }
    }
  }

  private async load(realPath: string, canonical: FileRef, target: ResolvedPath, principal: Principal): Promise<DocRoom> {
    const file = await this.ctx.paths.openRead(target, { principal });
    let bytes: Uint8Array | null;
    try {
      bytes = await readBounded(file.handle, file.identity.size, this.maxDocBytes);
    } finally {
      await file.close();
    }
    if (bytes === null) throw unsupported('too-large');
    const classified = classifyText(bytes, this.maxDocBytes);
    if (!classified.ok) throw unsupported(classified.reason);
    if (this.stopped) throw new SmurgError('internal', undefined, { reason: 'stopping' });
    const room = new DocRoom({
      ref: canonical,
      realPath,
      text: classified.text,
      meta: classified.meta,
      hash: sha256Hex(bytes),
      identity: file.identity,
      principal,
      log: this.log,
      send: (channelId, type, payload) => this.send(channelId, type, payload),
    });
    this.rooms.set(realPath, room);
    return room;
  }

  private subscribe(room: DocRoom, channelId: string, userId: UserId, canWrite: boolean): Subscription {
    const existing = this.subs.get(subscriptionKey(channelId, room.id));
    if (existing) {
      existing.canWrite = canWrite; // re-opened on the same channel: path rights as of now
      return existing;
    }
    const sub = new Subscription(room, channelId, userId, canWrite);
    room.subs.set(sub.key, sub);
    this.subs.set(sub.key, sub);
    let set = this.byChannel.get(channelId);
    if (!set) {
      set = new Set();
      this.byChannel.set(channelId, set);
    }
    set.add(sub);
    return sub;
  }

  private unsubscribe(sub: Subscription, reason: 'closed' | 'disconnected'): void {
    const room = sub.room;
    if (this.subs.get(sub.key) !== sub) return;
    this.subs.delete(sub.key);
    room.subs.delete(sub.key);
    const set = this.byChannel.get(sub.channelId);
    set?.delete(sub);
    if (set?.size === 0) this.byChannel.delete(sub.channelId);
    if (room.destroyed) return;
    room.removeAwarenessOf(sub);
    const stillThere = (): boolean => [...room.subs.values()].some((s) => s.userId === sub.userId);
    if (!stillThere()) {
      // Save what this member typed before they leave the human lock (the lock is what protects unsaved text).
      void this.disk.saveSoon(room).finally(() => {
        if (!stillThere()) this.access.leaveHuman(room.ref, sub.userId, reason);
      });
    }
    if (room.subs.size === 0) {
      if (this.access.locks() === null) room.lockBase = null; // no lock manager: the edit session ends with the last member
      this.startGrace(room);
    }
  }

  private closeAllForUser(userId: UserId): void {
    for (const sub of [...this.subs.values()]) if (sub.userId === userId) this.unsubscribe(sub, 'disconnected');
  }

  private startGrace(room: DocRoom): void {
    this.cancelGrace(room);
    const timer = setTimeout(() => {
      room.graceTimer = null;
      room
        .enqueue(async () => {
          await this.disk.save(room);
          if (room.subs.size === 0 && room.holds === 0) {
            if (room.paused !== null) this.disk.settlePause(room); // could not be saved: keep the text aside
            this.destroyRoom(room);
          }
        })
        .catch(() => {});
    }, this.graceMs);
    timer.unref();
    room.graceTimer = timer;
  }

  private cancelGrace(room: DocRoom): void {
    if (!room.graceTimer) return;
    clearTimeout(room.graceTimer);
    room.graceTimer = null;
  }

  private destroyRoom(room: DocRoom): void {
    if (this.rooms.get(room.realPath) === room) this.rooms.delete(room.realPath);
    for (const sub of room.subs.values()) {
      this.subs.delete(sub.key);
      this.byChannel.get(sub.channelId)?.delete(sub);
    }
    room.destroy();
  }

  /** The room of `file`: its canonical reference, a spelling it was opened under, or (fallback) a case-folded match. */
  private findRoom(file: FileRef): DocRoom | null {
    const key = fileRefKey(file);
    let alias: DocRoom | null = null;
    for (const room of this.rooms.values()) {
      if (room.destroyed) continue;
      if (fileRefKey(room.ref) === key) return room;
      if (alias === null && room.aliases.has(key)) alias = room;
    }
    if (alias) return alias;
    const folded = foldedFileKey(file);
    for (const room of this.rooms.values()) if (!room.destroyed && foldedFileKey(room.ref) === folded) return room;
    return null;
  }

  // =================================================================================================================
  // doc.sync / doc.awareness
  // =================================================================================================================

  sync(input: PayloadOf<'doc.sync'>, conn: ClientConnection, principal: Principal): void {
    const sub = this.subscriptionOf(conn, input.docId);
    const room = sub.room;
    let message: SyncMessage;
    try {
      message = parseSyncMessage(input.data);
    } catch {
      throw new SmurgError('bad_request', undefined, { reason: 'bad-sync-message' });
    }
    if (message.kind === 'step1') {
      let reply: Uint8Array;
      try {
        reply = encodeStep2(room.doc, message.stateVector);
      } catch {
        throw new SmurgError('bad_request', undefined, { reason: 'bad-state-vector' });
      }
      room.sendTo(sub, reply);
      return;
    }
    let empty: boolean;
    try {
      empty = isEmptyUpdate(message.update);
    } catch {
      throw new SmurgError('bad_request', undefined, { reason: 'bad-update' });
    }
    if (empty) return; // "I have nothing you lack" (a viewer's answer to our step 1): not an edit
    const refusal = !principalCan(principal, 'file.write') ? 'forbidden' : !sub.canWrite ? 'read-only' : null;
    if (refusal !== null) {
      this.ctx.audit.record({
        actor: principal.actor,
        action: 'authz.denied',
        outcome: 'denied',
        target: auditTarget(room.ref),
        detail: { type: 'doc.sync', reason: 'doc-content-needs-file.write', refusal, docId: room.id },
      });
      this.send(sub.channelId, 'doc.rejected', { docId: room.id, reason: refusal });
      const error = new AuthorizationError('沒有編輯這個檔案的權限', { reason: 'doc-content-needs-file.write' });
      error.audited = true;
      throw error;
    }
    this.applyHumanUpdate(room, sub, principal, message.update);
  }

  awareness(input: PayloadOf<'doc.awareness'>, conn: ClientConnection, principal: Principal): void {
    const sub = this.subscriptionOf(conn, input.docId);
    const room = sub.room;
    const member = this.ctx.members.get(sub.userId);
    if (!member || principal.userId !== sub.userId) throw new SmurgError('forbidden');
    const user: AwarenessUser = { name: member.displayName, color: member.color, kind: 'human', userId: member.userId };
    let filtered: ReturnType<typeof filterAwarenessUpdate>;
    try {
      filtered = filterAwarenessUpdate(input.data, user, (clientId) => room.mayUseClientId(sub, clientId));
    } catch {
      throw new SmurgError('bad_request', undefined, { reason: 'bad-awareness' });
    }
    if (filtered.dropped.length > 0) this.log.debug('awareness entries dropped', { docId: room.id, count: filtered.dropped.length, reason: filtered.dropped[0]?.reason });
    if (filtered.entries.length === 0) return;
    awarenessProtocol.applyAwarenessUpdate(room.awareness, encodeAwarenessEntries(filtered.entries), sub);
  }

  private subscriptionOf(conn: ClientConnection, docId: string): Subscription {
    const sub = this.subs.get(subscriptionKey(conn.channelId, docId));
    if (!sub || sub.room.destroyed) throw new SmurgError('not_found', '這份文件沒有開啟', { reason: 'doc-not-open' });
    return sub;
  }

  /**
   * A human's Yjs update (known to carry content and to come from someone allowed to write). The human lock is
   * touched first; an agent lock turns the update into apply-then-revert.
   */
  private applyHumanUpdate(room: DocRoom, sub: Subscription, principal: Principal, update: Uint8Array): void {
    const userId = principal.userId as UserId;
    // A settled pause (the file is gone, binary, or leads elsewhere): nothing typed now could ever be saved.
    const paused = room.paused !== null && room.pauseSettled;
    const touch = paused ? null : this.access.touchHuman(room.ref, userId);
    const agentLock = touch !== null && !touch.ok ? touch.lock : null;
    // lockBase = the disk text when the human lock was taken (LockManager contract). Also taken when the lock is held
    // but we have no base, or when there is no lock manager at all: a base that is too old only adds conflicts, a
    // missing one loses autosaved human text to a stale-copy write (yjs-monaco.md V4).
    if (agentLock === null && !paused) {
      if (touch?.ok === true && touch.acquired) room.lockBase = room.diskText;
      else if (room.lockBase === null) room.lockBase = room.diskText;
    }
    // Growth in UTF-16 units is bounded by the update's size: only a large update needs the text before it.
    const mayGrow = room.text.length + update.byteLength > this.maxDocBytes;
    const before = agentLock !== null || paused || mayGrow ? room.text.toString() : null;
    let delta: TextDeltaItem[] | null = null;
    const observer = (event: Y.YTextEvent, transaction: Y.Transaction): void => {
      if (transaction.origin === sub) delta = event.delta as TextDeltaItem[];
    };
    room.text.observe(observer);
    try {
      Y.applyUpdate(room.doc, update, sub);
    } catch {
      throw new SmurgError('bad_request', undefined, { reason: 'bad-update' });
    } finally {
      room.text.unobserve(observer);
    }
    const change = delta as TextDeltaItem[] | null;
    if (change === null) return; // nothing in the text changed (a duplicate, or another shared type)
    if (agentLock !== null && before !== null) {
      this.revert(room, before, change);
      this.send(sub.channelId, 'doc.rejected', { docId: room.id, reason: 'agent-locked', lock: agentLock });
      return;
    }
    if (paused && before !== null) {
      this.revert(room, before, change);
      this.send(sub.channelId, 'doc.rejected', { docId: room.id, reason: PAUSED_REJECT_REASON });
      return;
    }
    if (before !== null && room.text.length > this.maxDocBytes) {
      this.revert(room, before, change);
      this.send(sub.channelId, 'doc.rejected', { docId: room.id, reason: 'forbidden' });
      return;
    }
    room.editors.set(userId, principal);
    this.disk.markDirty(room);
    this.ctx.bus.emit('doc.human-edit', { file: room.ref, docId: room.id, userId, channelId: sub.channelId });
  }

  /** Accept-then-revert: every replica (the sender's too) converges back to `before`. */
  private revert(room: DocRoom, before: string, delta: readonly TextDeltaItem[]): void {
    applyCompactOps(room.text, inverseOfDelta(delta, before), REVERT_ORIGIN);
    if (room.text.toString() !== before) {
      // Cannot happen with a correct delta; if it does, a new epoch is the only safe state.
      this.log.error('revert did not restore the text; resetting the document', { docId: room.id });
      room.reset(before);
    }
  }

  // =================================================================================================================
  // Locks, agents, presence
  // =================================================================================================================

  private onLockChanged(file: FileRef, lock: LockInfo | null, previous: LockInfo | null): void {
    // The agent is done with the file: its write follows (or already happened); attribute it and pick it up now.
    if (previous?.kind === 'agent' && lock?.kind !== 'agent') this.onAgentWrote(file, agentActorOf(previous));
    const room = this.findRoom(file);
    if (room && previous?.kind === 'human' && lock?.kind !== 'human') room.lockBase = null;
  }

  private onAgentWrote(file: FileRef, actor: ReturnType<DocAccess['agentActor']>): void {
    this.disk.noteAgentWrite(file, actor);
    const room = this.findRoom(file);
    if (room) this.disk.queueRecheck(room, actor);
  }

  setAgentPresence(file: FileRef, agent: { readonly sessionId: string; readonly ownerUserId: UserId; readonly displayName: string; readonly color: string }, caretOffset: number | null): void {
    const room = this.findRoom(file);
    if (!room) return;
    const user = awarenessUserSchema.safeParse({ name: agent.displayName, color: agent.color, kind: 'agent', userId: agent.ownerUserId });
    if (user.success) room.agentPresence(agent.sessionId, user.data).setCaret(caretOffset);
  }

  clearAgentPresence(sessionId: string): void {
    for (const room of this.rooms.values()) if (!room.destroyed) room.removeAgentPresence(sessionId);
  }

  // =================================================================================================================
  // Conflict panel
  // =================================================================================================================

  listConflicts(principal: Principal): ConflictRecord[] {
    return this.panel.list(principal);
  }

  /** doc.conflict.get: an agent version that is no longer cached is read from disk. */
  getConflict(conflictId: string, principal: Principal): Promise<ResultInputOf<'doc.conflict.get'>> {
    return this.panel.read(conflictId, principal);
  }

  async resolveConflict(input: PayloadOf<'doc.conflict.resolve'>, principal: Principal): Promise<ConflictRecord> {
    const conflict = this.panel.find(input.conflictId, principal);
    // Resolving touches the file's content (apply) or its record (dismiss): both need the right to write it.
    await this.ctx.paths.resolve(conflict.file, { principal, forWrite: true });
    if (input.action === 'apply-agent-version') {
      const bytes = await this.panel.store.version(conflict.id);
      if (!bytes) throw new SmurgError('not_found', undefined, { reason: 'agent-version-missing' });
      await this.applyAgentVersion(conflict, bytes, principal);
    }
    return this.panel.close(conflict, input.action, principal);
  }

  /** The member chose the agent's version: a human edit of the whole open document, or a plain write. */
  private async applyAgentVersion(conflict: ConflictRecord, bytes: Uint8Array, principal: Principal): Promise<void> {
    const userId = principal.userId as UserId;
    const room = this.findRoom(conflict.file);
    if (!room || room.paused === 'deleted') {
      // No open document, or one whose file is gone: this is a plain write (for a recovery record, a restore).
      if (this.access.lockOf(conflict.file)?.kind === 'agent') throw agentLocked();
      await this.ctx.paths.writeFileAtomic(conflict.file, bytes, { principal, ...(room ? { noClobber: true } : {}) });
      if (room) this.disk.queueRecheck(room, principal.actor);
      try {
        this.ctx.services.files.expectChange(conflict.file, principal.actor);
      } catch {
        // best effort
      }
      return;
    }
    const classified = classifyText(bytes, this.maxDocBytes);
    if (!classified.ok) throw unsupported(classified.reason);
    await room.enqueue(async () => {
      if (room.destroyed || room.paused) throw new SmurgError('conflict', '檔案目前無法寫入', { reason: 'doc-paused' });
      const touch = this.access.touchHuman(room.ref, userId);
      if (touch !== null && !touch.ok) throw agentLocked();
      if (touch?.ok === true && touch.acquired) room.lockBase = room.diskText;
      for (let attempt = 0; attempt < REPLACE_ATTEMPTS; attempt++) {
        const epoch = room.epoch;
        const updates = room.updates;
        const result = await this.compute.run({ mode: 'replace', snapshot: Y.encodeStateAsUpdate(room.doc), diskText: room.diskText, lockBase: null, theirs: classified.text });
        if (room.destroyed) return;
        // Merged with concurrent typing, a replacement would not BE the agent's version: start over on the new text.
        if (room.epoch !== epoch || room.updates !== updates) continue;
        if (result.update) Y.applyUpdate(room.doc, result.update, new HumanOrigin(userId));
        room.editors.set(userId, principal);
        room.dirty = true;
        room.dirtySeq += 1;
        if (room.saveTimer) {
          clearTimeout(room.saveTimer);
          room.saveTimer = null;
        }
        this.ctx.bus.emit('doc.human-edit', { file: room.ref, docId: room.id, userId, channelId: '' });
        await this.disk.save(room);
        return;
      }
      throw new SmurgError('conflict', '文件正在變動，請再試一次', { reason: 'busy' });
    });
  }

  // =================================================================================================================
  // Errors and sending
  // =================================================================================================================

  private send(channelId: string, type: DocSendType, payload: Record<string, unknown>): void {
    try {
      this.ctx.hub.send(channelId, type, payload as never);
    } catch (err) {
      this.log.error('document message not sent', { type, error: err instanceof Error ? err.message.slice(0, 120) : 'unknown' });
    }
  }

  private pausedError(reason: PauseReason, principal: Principal, ref: FileRef): Error {
    if (reason === 'deleted') return new SmurgError('not_found');
    if (reason === 'unsupported') return new SmurgError('bad_request', '檔案內容目前無法在編輯器中開啟', { reason: 'unsupported' });
    return this.deny(principal, ref, 'changed');
  }

  /** An audited path denial of our own (PathGuard audits its own denials). */
  private deny(principal: Principal, ref: FileRef, reason: 'outside-root' | 'changed'): PathDeniedError {
    const error = new PathDeniedError(reason, ref.path);
    error.audited = true;
    this.ctx.audit.record({ actor: principal.actor, action: 'path.denied', outcome: 'denied', target: auditTarget(ref), detail: { reason, type: 'doc.open' } });
    return error;
  }
}

function unsupported(reason: UnsupportedReason): SmurgError {
  const { code, message } = unsupportedMessage(reason);
  return new SmurgError(code, message, { reason });
}

function agentLocked(): SmurgError {
  return new SmurgError('locked', '此檔案正由 agent 修改中，請稍後再試', { reason: 'agent-locked' });
}
