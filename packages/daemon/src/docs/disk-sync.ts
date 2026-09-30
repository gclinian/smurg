// Keeps each room and its file in step (SPEC R8 「唯一的真實來源是主人磁碟上的檔案」, D13; ARCHITECTURE §7.5):
//
//  * human edit → debounce (300 ms, at most 2 s after the first unsaved edit) → the room's serialised queue: read +
//    SHA-256 the file (never trust size/mtime/ino, V3), merge an unseen external change FIRST, then an atomic write
//    that keeps mode, BOM and EOL → doc.saved.
//  * file.changed (or an agent lock ending) → the same queue: read + hash; our own echo is recognised by the hash
//    alone. No human lock: two-way. Human lock held (or unsaved human text): three-way against lockBase (V4). The
//    worker merges and diffs on a fork and returns one Yjs update, applied with the actor as the origin; overlapping
//    hunks keep the human text and go to the conflict panel; a merge that is not the disk's text is written back.
//  * A file that vanished, became binary / huge, or no longer resolves to the room's real path PAUSES the room:
//    nothing is read into it or written from it until the file is back as text at the same place. A pause that
//    outlasts PAUSE_CONFIRM_MS (not a `git checkout` deleting and re-creating the file) is SETTLED: text that is not on
//    disk goes to the conflict panel as a recoverable version, every subscriber gets doc.rejected (its editor stops
//    accepting input), and later human updates are refused. Nothing a human typed is dropped silently.
//  * A read or write that fails for lack of permission (EACCES / EPERM: a chmod, a file left root-owned) is retried
//    with a growing delay until it works; the unsaved text is written as soon as it can be.
import { SmurgError, awarenessUserSchema, fileRefKey, isRelPathWithin, rootRefKey, type Actor, type FileRef } from '@smurg/protocol';
import * as Y from 'yjs';
import type { DaemonContext } from '../core/context.ts';
import { isPathDeniedError } from '../core/errors.ts';
import type { FileChange, FileIdentity, UserId } from '../core/interfaces.ts';
import type { Logger } from '../core/logger.ts';
import { SYSTEM_ACTOR } from '../core/permissions.ts';
import { agentActorOf, type DocAccess } from './access.ts';
import type { ComputeResult } from './compute-job.ts';
import type { DocCompute } from './compute.ts';
import { auditTarget, type ConflictPanel } from './conflict-panel.ts';
import { readDocFile, sha256Hex, type DiskRead } from './disk-io.ts';
import { DiskOrigin, type DocRoom, type PauseReason } from './room.ts';
import { classifyText, encodeText } from './text-codec.ts';

/** Attempts when a doc.reset (new epoch) invalidated a computed update. */
const RECONCILE_ATTEMPTS = 3;
/** Next try after a merge or write that could not finish (worker failure, file changed under the write). */
const RETRY_DELAY_MS = 250;
/** Longest delay between retries while a file stays unreadable / unwritable. */
const RETRY_MAX_DELAY_MS = 2_000;
/** A pause still in place after this long is settled (see the header). */
export const PAUSE_CONFIRM_MS = 1_500;
/**
 * What paused-room subscribers are told (review REL-01): the file is gone or unusable on disk; clients stop editing and
 * re-sync, and say that the text not yet saved is in the conflict panel (the recovery record), not discarded.
 */
export const PAUSED_REJECT_REASON = 'file-unavailable';

export interface DiskSyncOptions {
  readonly debounceMs: number;
  readonly maxWaitMs: number;
  readonly maxDocBytes: number;
  /** A disk change this long after an agent's lock ended (or its PostToolUse) is attributed to that agent. */
  readonly attributionWindowMs: number;
  /** How long a pause must last before it is settled (default PAUSE_CONFIRM_MS). */
  readonly pauseConfirmMs?: number;
}

export interface DiskSyncDeps {
  readonly ctx: DaemonContext;
  readonly log: Logger;
  readonly access: DocAccess;
  readonly compute: DocCompute;
  readonly panel: ConflictPanel;
  readonly options: DiskSyncOptions;
  readonly isStopped: () => boolean;
  readonly send: {
    (channelId: string, type: 'doc.saved', payload: { docId: string; file: FileRef; hash: string; at: number }): void;
    (channelId: string, type: 'doc.rejected', payload: { docId: string; reason: typeof PAUSED_REJECT_REASON }): void;
  };
}

export class DiskSync {
  private readonly deps: DiskSyncDeps;
  /** Agents whose lock on a file ended recently (fileRefKey → actor): attribution of the write that follows. */
  private readonly recentAgents = new Map<string, { readonly actor: Extract<Actor, { kind: 'agent' }>; readonly at: number }>();

  constructor(deps: DiskSyncDeps) {
    this.deps = deps;
  }

  // =================================================================================================================
  // Human edit → disk
  // =================================================================================================================

  markDirty(room: DocRoom): void {
    room.dirty = true;
    room.dirtySeq += 1;
    this.scheduleSave(room);
  }

  /** Saves now (in the queue) if there is anything unsaved; never rejects. */
  saveSoon(room: DocRoom): Promise<void> {
    if (!room.dirty) return Promise.resolve();
    if (room.saveTimer) {
      clearTimeout(room.saveTimer);
      room.saveTimer = null;
    }
    return room.enqueue(() => this.save(room)).catch(() => {});
  }

  private scheduleSave(room: DocRoom): void {
    if (room.destroyed || this.deps.isStopped()) return;
    // Real timers only schedule; the clock decides the deadline (contract review C15).
    const now = this.deps.ctx.clock.now();
    if (room.firstDirtyAt === null) room.firstDirtyAt = now;
    if (room.saveTimer) clearTimeout(room.saveTimer);
    const wait = Math.max(0, Math.min(this.deps.options.debounceMs, room.firstDirtyAt + this.deps.options.maxWaitMs - now));
    const timer = setTimeout(() => {
      room.saveTimer = null;
      room.enqueue(() => this.save(room)).catch(() => {});
    }, wait);
    timer.unref();
    room.saveTimer = timer;
  }

  /** Runs inside the room's queue. */
  async save(room: DocRoom): Promise<void> {
    if (room.destroyed || !room.dirty || room.paused) return;
    const { ctx, log } = this.deps;
    room.firstDirtyAt = null;
    const seq = room.dirtySeq;
    const principal = this.deps.access.writePrincipal(room);
    if (principal === null) {
      log.warn('unsaved document has no member who may write it', { docId: room.id });
      return;
    }
    let disk: DiskRead;
    try {
      disk = await readDocFile(ctx.paths, room.ref, room.realPath, principal, this.deps.options.maxDocBytes);
    } catch (err) {
      if (isAccessError(err)) return this.retryLater(room, 'read');
      throw err;
    }
    if (disk.kind === 'ok') room.identity = disk.identity; // what writeFileAtomic must still find (`expect`)
    if (disk.kind !== 'ok' || disk.hash !== room.lastHash) {
      await this.integrate(room, disk, undefined);
      if (room.destroyed || room.paused) return;
      if (disk.kind !== 'ok' || room.lastHash !== disk.hash) {
        this.scheduleRetry(room); // the change could not be merged yet: try again rather than overwrite it
        return;
      }
    }
    const text = room.text.toString();
    const bytes = encodeText(text, room.meta);
    const hash = sha256Hex(bytes);
    if (hash === room.lastHash) {
      room.diskText = text;
      this.markClean(room, seq);
      return;
    }
    let identity: FileIdentity;
    try {
      identity = await ctx.paths.writeFileAtomic(room.ref, bytes, { principal, expect: room.identity, audit: false });
    } catch (err) {
      if (isPathDeniedError(err)) return this.pause(room, 'outside', { op: 'write', reason: err.reason });
      if (err instanceof SmurgError && err.code === 'not_found') return this.pause(room, 'deleted');
      if (isAccessError(err)) return this.retryLater(room, 'write');
      this.scheduleRetry(room); // e.g. `conflict`: the file changed between our read and the rename
      if (err instanceof SmurgError && err.code === 'conflict') return;
      throw err;
    }
    room.identity = identity;
    room.lastHash = hash;
    room.diskText = text;
    room.lastWritePrincipal = principal;
    room.retryDelayMs = 0;
    this.markClean(room, seq);
    try {
      ctx.services.files.expectChange(room.ref, principal.actor);
    } catch {
      // No file service: attribution of the watcher's echo is best effort anyway (we recognise it by hash).
    }
    const at = ctx.clock.now();
    for (const sub of room.subs.values()) this.deps.send(sub.channelId, 'doc.saved', { docId: room.id, file: room.ref, hash, at });
    ctx.bus.emit('doc.saved', { file: room.ref, docId: room.id, hash, at });
  }

  private markClean(room: DocRoom, seq: number): void {
    if (room.dirtySeq !== seq) {
      if (!room.saveTimer) this.scheduleSave(room); // newer edits arrived during the write
      return;
    }
    room.dirty = false;
    room.firstDirtyAt = null;
    room.editors.clear();
  }

  private scheduleRetry(room: DocRoom, delayMs = RETRY_DELAY_MS): void {
    if (room.retryTimer || room.destroyed || this.deps.isStopped()) return;
    const timer = setTimeout(() => {
      room.retryTimer = null;
      this.queueRecheck(room, undefined);
      if (room.dirty) room.enqueue(() => this.save(room)).catch(() => {});
    }, delayMs);
    timer.unref();
    room.retryTimer = timer;
  }

  /** The file cannot be read or written for lack of permission: keep the text and try again, less and less often. */
  private retryLater(room: DocRoom, op: 'read' | 'write'): void {
    if (room.retryTimer) return; // one retry per round (the re-check and the save of a round both end up here)
    const first = room.retryDelayMs === 0;
    room.retryDelayMs = first ? RETRY_DELAY_MS : Math.min(room.retryDelayMs * 2, RETRY_MAX_DELAY_MS);
    if (first) this.deps.log.warn('document file not accessible; retrying', { docId: room.id, op });
    this.scheduleRetry(room, room.retryDelayMs);
  }

  // =================================================================================================================
  // Disk → Yjs
  // =================================================================================================================

  /** Rooms touched by a watcher batch: the file itself (any spelling case), or a directory above it. */
  onFileChanged(rooms: Iterable<DocRoom>, root: FileRef['root'], changes: readonly FileChange[]): void {
    if (changes.length === 0) return;
    const rootKey = rootRefKey(root);
    const exact = new Map<string, FileChange>();
    const folded = new Set<string>();
    for (const change of changes) {
      exact.set(change.path, change);
      folded.add(change.path.toLowerCase());
    }
    for (const room of rooms) {
      if (room.destroyed || rootRefKey(room.ref.root) !== rootKey) continue;
      let hit = exact.get(room.ref.path);
      let matched = hit !== undefined || folded.has(room.ref.path.toLowerCase());
      if (!matched) {
        // A directory above the file changed (renamed, deleted, swapped for a link): re-check the file too.
        hit = changes.find((change) => isRelPathWithin(room.ref.path, change.path));
        matched = hit !== undefined;
      }
      if (matched) this.queueRecheck(room, hit?.by);
    }
  }

  /** An agent is done with `file` (its lock ended, PostToolUse): remember it for attribution. */
  noteAgentWrite(file: FileRef, actor: Extract<Actor, { kind: 'agent' }>): void {
    const now = this.deps.ctx.clock.now();
    for (const [key, entry] of this.recentAgents) if (now - entry.at > this.deps.options.attributionWindowMs) this.recentAgents.delete(key);
    this.recentAgents.set(fileRefKey(file), { actor, at: now });
  }

  /** Coalesces re-checks: at most one queued per room; the strongest attribution hint wins (an agent). */
  queueRecheck(room: DocRoom, hint: Actor | undefined): void {
    if (room.destroyed || this.deps.isStopped()) return;
    if (hint !== undefined && room.recheckHint?.kind !== 'agent') room.recheckHint = hint;
    if (room.recheckQueued) return;
    room.recheckQueued = true;
    room
      .enqueue(async () => {
        room.recheckQueued = false;
        const queued = room.recheckHint;
        room.recheckHint = undefined;
        await this.recheck(room, queued);
      })
      .catch(() => {});
  }

  /** Runs inside the room's queue: read + hash the file and integrate what changed. */
  async recheck(room: DocRoom, hint?: Actor): Promise<void> {
    if (room.destroyed) return;
    let disk: DiskRead;
    try {
      disk = await readDocFile(this.deps.ctx.paths, room.ref, room.realPath, this.deps.access.readPrincipal(room), this.deps.options.maxDocBytes);
    } catch (err) {
      // Unreadable for now (chmod 000): nothing to integrate; unsaved text is retried until it can be written.
      if (isAccessError(err)) {
        if (room.dirty) this.retryLater(room, 'read');
        return;
      }
      throw err;
    }
    await this.integrate(room, disk, hint);
  }

  /** Runs inside the room's queue. */
  private async integrate(room: DocRoom, disk: DiskRead, hint: Actor | undefined): Promise<void> {
    if (room.destroyed) return;
    if (disk.kind === 'missing') return this.pause(room, 'deleted');
    if (disk.kind === 'denied') return this.pause(room, 'outside', { op: 'read', reason: disk.reason });
    if (disk.kind === 'too-large') return this.pause(room, 'unsupported');
    room.identity = disk.identity;
    if (disk.hash === room.lastHash) {
      this.resume(room); // our own echo, or back to exactly what we know
      return;
    }
    const classified = classifyText(disk.bytes, this.deps.options.maxDocBytes);
    // Binary / huge / not UTF-8 now: never overwrite it with our text.
    if (!classified.ok) return this.pause(room, 'unsupported');
    this.resume(room);
    const theirs = classified.text;
    if (theirs === room.diskText) {
      // Only the EOL style or BOM changed (a formatter): the next save follows the disk.
      room.meta = classified.meta;
      room.lastHash = disk.hash;
      return;
    }
    const actor = this.attribute(room, hint);
    const result = await this.reconcile(room, theirs, actor);
    if (result === null) return this.scheduleRetry(room);
    room.meta = classified.meta;
    room.diskText = theirs;
    room.lastHash = disk.hash;
    if (result.conflicts.length > 0) {
      this.deps.panel.record({ file: room.ref, docId: room.id, source: actor, humans: this.deps.access.conflictHumans(room), result, agentBytes: disk.bytes });
    }
    if (!result.mergedIsTheirs) this.markDirty(room); // the disk must converge to the merged text (human text kept)
    if (actor.kind === 'agent' && result.caret !== null) this.agentCaret(room, actor, result.caret);
  }

  /**
   * ours → merged in ONE transaction whose origin is the actor. The worker diffs and applies on a fork of the Y.Doc and
   * returns a Yjs update; what humans typed while it ran is merged by Yjs, never overwritten by a stale diff. Only a
   * doc.reset during the job (new epoch) makes the result unusable.
   */
  private async reconcile(room: DocRoom, theirs: string, actor: Actor): Promise<ComputeResult | null> {
    for (let attempt = 0; attempt < RECONCILE_ATTEMPTS; attempt++) {
      const epoch = room.epoch;
      let result: ComputeResult;
      try {
        result = await this.deps.compute.run({ mode: 'reconcile', snapshot: Y.encodeStateAsUpdate(room.doc), diskText: room.diskText, lockBase: room.lockBase, theirs });
      } catch (err) {
        this.deps.log.warn('document reconcile failed', { docId: room.id, error: err instanceof Error ? err.message.slice(0, 120) : 'unknown' });
        return null;
      }
      if (room.destroyed) return null;
      if (room.epoch !== epoch) continue;
      if (result.update) Y.applyUpdate(room.doc, result.update, new DiskOrigin(actor));
      return result;
    }
    return null;
  }

  /** Who changed the file: the agent holding its lock, a watcher attribution, an agent that just finished, or nobody. */
  private attribute(room: DocRoom, hint: Actor | undefined): Actor {
    const lock = this.deps.access.lockOf(room.ref);
    if (lock?.kind === 'agent') return agentActorOf(lock);
    if (hint?.kind === 'agent') return hint;
    const recent = this.recentAgents.get(fileRefKey(room.ref));
    if (recent && this.deps.ctx.clock.now() - recent.at <= this.deps.options.attributionWindowMs) return recent.actor;
    return hint ?? SYSTEM_ACTOR;
  }

  private agentCaret(room: DocRoom, actor: Extract<Actor, { kind: 'agent' }>, caret: Record<string, unknown>): void {
    const color = this.deps.access.agentColor(actor.sessionId, actor.ownerUserId);
    const user = awarenessUserSchema.safeParse({ name: actor.displayName, color, kind: 'agent', userId: actor.ownerUserId });
    if (user.success) room.agentPresence(actor.sessionId, user.data).setCaretRelative(caret);
  }

  /** The file is back as text at its place: a paused room works again, and what is unsaved is written. */
  private resume(room: DocRoom): void {
    if (room.paused === null) return;
    room.paused = null;
    room.pauseSettled = false;
    if (room.pauseTimer) {
      clearTimeout(room.pauseTimer);
      room.pauseTimer = null;
    }
    this.deps.log.info('document autosave resumed', { docId: room.id });
    if (room.dirty) this.scheduleSave(room);
  }

  /**
   * Runs inside the room's queue (or when the room is about to be destroyed): the pause is not transient. Text that is
   * not on disk becomes a recoverable version in the conflict panel, and every subscriber is told that its edits are
   * no longer accepted. Idempotent.
   */
  settlePause(room: DocRoom): void {
    if (room.paused === null || room.pauseSettled) return;
    room.pauseSettled = true;
    if (room.pauseTimer) {
      clearTimeout(room.pauseTimer);
      room.pauseTimer = null;
    }
    this.preserveUnsaved(room, room.paused);
    for (const sub of room.subs.values()) this.deps.send(sub.channelId, 'doc.rejected', { docId: room.id, reason: PAUSED_REJECT_REASON });
    this.deps.log.warn('document autosave stopped; unsaved text kept in the conflict panel', { docId: room.id, reason: room.paused });
  }

  /** Records the text that is not on disk (if any) as a recoverable version; the room keeps it as well. */
  private preserveUnsaved(room: DocRoom, reason: PauseReason): void {
    const text = room.text.toString();
    if (text === room.diskText || text === room.recoveredText) return;
    const humans = new Set<UserId>([...room.editors.keys(), ...this.deps.access.conflictHumans(room)]);
    this.deps.panel.recordRecovery({
      file: room.ref,
      docId: room.id,
      source: this.attribute(room, undefined),
      humans: [...humans],
      text,
      bytes: encodeText(text, room.meta),
      reason,
    });
    // A later settle of the same text (the file comes and goes again) does not record it twice. The room stays dirty:
    // if the file comes back, the text is merged and saved as usual.
    room.recoveredText = text;
  }

  private pause(room: DocRoom, reason: PauseReason, detail?: { readonly op: 'read' | 'write'; readonly reason: string }): void {
    if (room.paused === reason) return;
    room.paused = reason;
    if (!room.pauseSettled && room.pauseTimer === null && !this.deps.isStopped()) {
      const timer = setTimeout(() => {
        room.pauseTimer = null;
        room
          .enqueue(async () => {
            await this.recheck(room); // still gone / unsupported / outside?
            if (room.paused !== null) this.settlePause(room);
          })
          .catch(() => {});
      }, this.deps.options.pauseConfirmMs ?? PAUSE_CONFIRM_MS);
      timer.unref();
      room.pauseTimer = timer;
    }
    if (reason === 'outside') {
      // The file's path now leads somewhere else (e.g. a parent swapped for a symlink): refused, and recorded.
      this.deps.ctx.audit.record({
        actor: SYSTEM_ACTOR,
        action: 'path.denied',
        outcome: 'denied',
        target: auditTarget(room.ref),
        detail: { reason: detail?.reason ?? 'changed', op: detail?.op ?? 'read', docId: room.id, context: 'doc' },
      });
    }
    this.deps.log.warn('document autosave paused', { docId: room.id, reason });
  }
}

/** A read or write refused by the file system's permissions (chmod, a root-owned file): worth retrying later. */
function isAccessError(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code;
  return code === 'EACCES' || code === 'EPERM';
}
