// Who acts on a document, and what the other modules say about a file. The docs module calls LockManager, the
// session manager and the member directory lazily through here; a module that is not composed (a stub) is tolerated
// so documents keep working, but locks are then unavailable (logged once).
import { foldPathName, normalized, relPathSegments, rootRefKey, type Actor, type FileRef, type LockInfo } from '@smurg/protocol';
import type { DaemonContext } from '../core/context.ts';
import type { HumanTouchResult, LockManager, Principal, UserId } from '../core/interfaces.ts';
import type { Logger } from '../core/logger.ts';
import { agentDisplayName, principalCan } from '../core/permissions.ts';
import { isStubService } from '../core/stubs.ts';
import type { DocRoom } from './room.ts';

/** Prefer a non-host: a background read or write must be allowed for everyone whose content it carries. */
export function leastPrivileged(principals: readonly Principal[]): Principal | null {
  return principals.find((p) => p.role !== 'host') ?? principals[0] ?? null;
}

export function agentActorOf(lock: Extract<LockInfo, { kind: 'agent' }>): Extract<Actor, { kind: 'agent' }> {
  return { kind: 'agent', sessionId: lock.sessionId, ownerUserId: lock.ownerUserId, displayName: lock.agentName };
}

/**
 * A case- and normalisation-folded key: the lock manager reports a lock under the spelling that created it, which on a
 * case-insensitive file system may differ from the room's canonical one. Folding merges more names than a
 * case-sensitive file system would; it is only a fallback after the exact key.
 */
export function foldedFileKey(ref: FileRef): string {
  return `${rootRefKey(ref.root)}:${relPathSegments(normalized(ref.path, 'NFC')).map(foldPathName).join('/')}`;
}

export class DocAccess {
  private readonly ctx: DaemonContext;
  private readonly log: Logger;
  private warnedNoLocks = false;

  constructor(ctx: DaemonContext, log: Logger) {
    this.ctx = ctx;
    this.log = log;
  }

  locks(): LockManager | null {
    const locks = this.ctx.services.locks;
    if (!isStubService(locks)) return locks;
    if (!this.warnedNoLocks) {
      this.warnedNoLocks = true;
      this.log.warn('no lock manager: documents run without file locks');
    }
    return null;
  }

  lockOf(file: FileRef): LockInfo | null {
    try {
      return this.locks()?.get(file) ?? null;
    } catch (err) {
      this.log.error('lock lookup failed', { error: err instanceof Error ? err.name : 'unknown' });
      return null;
    }
  }

  /** null: no lock manager (or it failed). */
  touchHuman(file: FileRef, userId: UserId): HumanTouchResult | null {
    const locks = this.locks();
    if (!locks) return null;
    try {
      return locks.touchHuman(file, { userId, displayName: this.ctx.members.get(userId)?.displayName ?? userId });
    } catch (err) {
      this.log.error('touchHuman failed', { error: err instanceof Error ? err.name : 'unknown' });
      return null;
    }
  }

  leaveHuman(file: FileRef, userId: UserId, reason: 'closed' | 'disconnected'): void {
    try {
      this.locks()?.leaveHuman(file, userId, reason);
    } catch (err) {
      this.log.error('leaveHuman failed', { error: err instanceof Error ? err.name : 'unknown' });
    }
  }

  /** `Claude (owner)` of a session, from the session manager when it knows it. */
  agentActor(sessionId: string, ownerUserId: UserId): Extract<Actor, { kind: 'agent' }> {
    try {
      const sessions = this.ctx.services.sessions;
      if (!isStubService(sessions)) {
        const actor = sessions.agentActor(sessionId);
        if (actor?.kind === 'agent') return actor;
      }
    } catch {
      // fall back to the owner's name
    }
    const owner = this.ctx.members.get(ownerUserId);
    return { kind: 'agent', sessionId, ownerUserId, displayName: agentDisplayName(owner?.displayName ?? ownerUserId) };
  }

  /**
   * The colour the agent session has in presence.state (so its caret in the editor matches the presence list), else
   * its owner's colour, else amber.
   */
  agentColor(sessionId: string, ownerUserId: UserId): string {
    try {
      const presence = this.ctx.services.presence;
      if (!isStubService(presence)) {
        const color = presence.snapshot().agents.find((a) => a.sessionId === sessionId)?.color;
        if (color) return color;
      }
    } catch {
      // fall through
    }
    return this.ctx.members.get(ownerUserId)?.color ?? '#f59e0b';
  }

  /** A member's principal as of now, if they may still write files. */
  private writer(userId: UserId): Principal | null {
    const principal = this.ctx.members.principalOf(userId);
    return principal && principalCan(principal, 'file.write') ? principal : null;
  }

  /** Reads carry content to every subscriber: the least privileged one's principal. */
  readPrincipal(room: DocRoom): Principal {
    const principals: Principal[] = [];
    for (const sub of room.subs.values()) {
      const principal = this.ctx.members.principalOf(sub.userId);
      if (principal) principals.push(principal);
    }
    return leastPrivileged(principals) ?? room.lastWritePrincipal;
  }

  /**
   * Writes carry the editors' content: the least privileged editor who may still write, else the human lock holders,
   * else subscribers who may edit. null: nobody may write it now (the room stays dirty; content of editors who lost
   * the right to write is not saved on their behalf).
   */
  writePrincipal(room: DocRoom): Principal | null {
    const pick = (userIds: Iterable<UserId>): Principal | null =>
      leastPrivileged([...userIds].map((id) => this.writer(id)).filter((p): p is Principal => p !== null));
    if (room.editors.size > 0) return pick(room.editors.keys());
    const lock = this.lockOf(room.ref);
    if (lock?.kind === 'human') {
      const holder = pick(lock.holders.map((h) => h.userId));
      if (holder) return holder;
    }
    const subscriber = pick([...room.subs.values()].filter((s) => s.canWrite).map((s) => s.userId));
    if (subscriber) return subscriber;
    const last = room.lastWritePrincipal.userId;
    return last === null ? null : this.writer(last);
  }

  /** The people whose text a conflict protected: lock holders, else recent editors, else subscribers who may edit. */
  conflictHumans(room: DocRoom): UserId[] {
    const lock = this.lockOf(room.ref);
    if (lock?.kind === 'human') return lock.holders.map((h) => h.userId);
    if (room.editors.size > 0) return [...room.editors.keys()];
    return [...new Set([...room.subs.values()].filter((s) => s.canWrite).map((s) => s.userId))];
  }
}
