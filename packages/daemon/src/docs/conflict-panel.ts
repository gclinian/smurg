// The conflict panel (SPEC R8 「重疊部分出現在衝突面板並通知雙方」; ARCHITECTURE §5.3): turning the overlapping hunks of
// a merge into a ConflictRecord, telling everyone (the humans and the agent's owner are among them), auditing
// `doc.conflict` (DocService's own action) and recording the activity entry; listing, reading and closing records.
import {
  CONFLICT_TEXT_MAX_BYTES,
  LIST_MAX_ITEMS,
  SmurgError,
  conflictRecordSchema,
  isHostPrivatePath,
  isSmurgDirName,
  relPathSegments,
  rootRefKey,
  truncateToUtf8Bytes,
  type Actor,
  type ConflictRecord,
  type FileRef,
  type ResultInputOf,
} from '@smurg/protocol';
import type { DaemonContext } from '../core/context.ts';
import { newId } from '../core/lifecycle.ts';
import type { Logger } from '../core/logger.ts';
import type { Principal, UserId } from '../core/interfaces.ts';
import type { ComputeResult } from './compute-job.ts';
import { ConflictStore } from './conflicts.ts';

/**
 * `<share>/.smurg` (main root) and the host's private data (.git, .envrc, the host's personal Claude Code files; review
 * SEC-D-03) are not readable for non-hosts (ARCHITECTURE §5.2, §7.4): nor are their conflicts, which carry file text.
 */
export function hiddenForGuests(ref: FileRef): boolean {
  if (isHostPrivatePath(ref.path)) return true;
  const first = relPathSegments(ref.path)[0];
  return ref.root.kind === 'main' && first !== undefined && isSmurgDirName(first);
}

export function auditTarget(ref: FileRef): string {
  return `${rootRefKey(ref.root)}:${ref.path}`;
}

/** Hunk text for the wire: no NUL (largeTextSchema refuses it), at most 64 KiB of UTF-8. */
function hunkText(text: string): { readonly text: string; readonly cut: boolean } {
  const clean = text.includes('\u0000') ? text.replace(/\u0000/g, '\ufffd') : text;
  const cut = truncateToUtf8Bytes(clean, CONFLICT_TEXT_MAX_BYTES);
  return { text: cut, cut: cut.length !== clean.length };
}

function summary(ref: FileRef, count: number): string {
  const path = ref.path.length > 200 ? `…${ref.path.slice(-199)}` : ref.path;
  return `「${path}」有 ${count} 處修改與正在編輯的內容重疊，已保留編輯中的內容，另一個版本在衝突面板`;
}

function recoverySummary(ref: FileRef, reason: string): string {
  const path = ref.path.length > 200 ? `…${ref.path.slice(-199)}` : ref.path;
  const what = reason === 'deleted' ? '在編輯中被刪除或移走' : reason === 'unsupported' ? '變成無法在編輯器中開啟的內容' : '已無法安全寫入';
  return `「${path}」${what}，尚未儲存的內容已保留在衝突面板`;
}

export class ConflictPanel {
  readonly store: ConflictStore;
  private readonly ctx: DaemonContext;
  private readonly log: Logger;

  constructor(ctx: DaemonContext, log: Logger) {
    this.ctx = ctx;
    this.log = log;
    this.store = new ConflictStore(log);
  }

  open(): Promise<void> {
    return this.store.open(this.ctx.state);
  }

  /** A merge kept human text over overlapping agent text: record, audit, feed and announce it. */
  record(input: { readonly file: FileRef; readonly docId: string; readonly source: Actor; readonly humans: readonly UserId[]; readonly result: ComputeResult; readonly agentBytes: Uint8Array }): void {
    if (!this.store.ready) {
      this.log.error('conflict store not open; conflict not recorded', { docId: input.docId });
      return;
    }
    let truncated = 0;
    const hunks = input.result.conflicts.map((c) => {
      const human = hunkText(c.ours);
      const agent = hunkText(c.theirs);
      const base = hunkText(c.base);
      const cut = human.cut || agent.cut || base.cut;
      if (cut) truncated += 1;
      return { humanText: human.text, agentText: agent.text, baseText: base.text, startLine: c.mergedStartLine + 1, ...(cut ? { truncated: true } : {}) };
    });
    const parsed = conflictRecordSchema.safeParse({
      id: newId('conflict'),
      file: input.file,
      createdAt: this.ctx.clock.now(),
      source: input.source,
      humans: input.humans.slice(0, LIST_MAX_ITEMS).map((userId) => ({ userId, displayName: this.ctx.members.get(userId)?.displayName ?? userId })),
      hunks,
      ...(input.result.conflictsOmitted > 0 ? { hunksOmitted: input.result.conflictsOmitted } : {}),
      agentVersionBytes: input.agentBytes.byteLength,
      status: 'open',
    });
    if (!parsed.success) {
      this.log.error('conflict record failed validation', { docId: input.docId });
      return;
    }
    const record = parsed.data;
    const count = hunks.length + input.result.conflictsOmitted;
    this.store.add(record, input.agentBytes);
    this.ctx.audit.record({
      actor: input.source,
      action: 'doc.conflict',
      outcome: 'ok',
      target: auditTarget(input.file),
      detail: { conflictId: record.id, hunks: count, truncated, docId: input.docId },
    });
    try {
      this.ctx.services.activity.record({ actor: input.source, kind: 'conflict', file: input.file, summary: summary(input.file, count) });
    } catch {
      // No activity feed (yet): the audit entry and doc.conflict still record it.
    }
    this.announce(record);
  }

  /**
   * An open document can no longer be saved (its file was deleted or moved away, turned binary, or now leads outside
   * the share) while it holds text that is not on disk: keep that text as a recoverable version. The record's one
   * hunk shows the unsaved text against nothing, and its stored "version" is that text in the file's own encoding, so
   * doc.conflict.get returns it in full and apply-agent-version writes it back at the old path (a restore).
   */
  recordRecovery(input: {
    readonly file: FileRef;
    readonly docId: string;
    readonly source: Actor;
    readonly humans: readonly UserId[];
    readonly text: string;
    readonly bytes: Uint8Array;
    readonly reason: string;
  }): ConflictRecord | null {
    if (!this.store.ready) {
      this.log.error('conflict store not open; unsaved document text not recorded', { docId: input.docId });
      return null;
    }
    const human = hunkText(input.text);
    const parsed = conflictRecordSchema.safeParse({
      id: newId('conflict'),
      file: input.file,
      createdAt: this.ctx.clock.now(),
      source: input.source,
      humans: input.humans.slice(0, LIST_MAX_ITEMS).map((userId) => ({ userId, displayName: this.ctx.members.get(userId)?.displayName ?? userId })),
      hunks: [{ humanText: human.text, agentText: '', baseText: '', startLine: 1, ...(human.cut ? { truncated: true } : {}) }],
      agentVersionBytes: input.bytes.byteLength,
      status: 'open',
    });
    if (!parsed.success) {
      this.log.error('recovery record failed validation', { docId: input.docId });
      return null;
    }
    const record = parsed.data;
    this.store.add(record, input.bytes);
    this.ctx.audit.record({
      actor: input.source,
      action: 'doc.conflict',
      outcome: 'ok',
      target: auditTarget(input.file),
      detail: { conflictId: record.id, kind: 'unsaved-text', reason: input.reason, bytes: input.bytes.byteLength, docId: input.docId },
    });
    try {
      this.ctx.services.activity.record({ actor: input.source, kind: 'conflict', file: input.file, summary: recoverySummary(input.file, input.reason) });
    } catch {
      // No activity feed (yet): the audit entry and doc.conflict still record it.
    }
    this.announce(record);
    return record;
  }

  /** doc.conflict to every member who may see the file (the humans and the agent's owner included). */
  announce(conflict: ConflictRecord): void {
    const hidden = hiddenForGuests(conflict.file);
    try {
      this.ctx.hub.broadcast('doc.conflict', { conflict }, { capability: 'file.read', filter: (_recipient, role) => !hidden || role === 'host' });
    } catch (err) {
      this.log.error('doc.conflict broadcast failed', { error: err instanceof Error ? err.name : 'unknown' });
    }
  }

  visibleTo(conflict: ConflictRecord, principal: Principal): boolean {
    return principal.role === 'host' || !hiddenForGuests(conflict.file);
  }

  list(principal: Principal): ConflictRecord[] {
    return this.store
      .list()
      .filter((c) => this.visibleTo(c, principal))
      .slice(-LIST_MAX_ITEMS);
  }

  /** A record this member may see, or not_found (the same answer for "does not exist" and "hidden"). */
  find(conflictId: string, principal: Principal): ConflictRecord {
    const conflict = this.store.get(conflictId);
    if (!conflict || !this.visibleTo(conflict, principal)) throw new SmurgError('not_found');
    return conflict;
  }

  async read(conflictId: string, principal: Principal): Promise<ResultInputOf<'doc.conflict.get'>> {
    const conflict = this.find(conflictId, principal);
    // Still a path this member may read (audited if not); the file itself may be gone by now.
    await this.ctx.paths.resolve(conflict.file, { principal });
    const agentVersion = await this.store.version(conflictId);
    if (!agentVersion) throw new SmurgError('not_found', undefined, { reason: 'agent-version-missing' });
    return { conflict, agentVersion };
  }

  /** Closes a record after the action succeeded: status, audit `doc.conflict-resolve`, announcement. */
  close(conflict: ConflictRecord, action: 'dismiss' | 'apply-agent-version', principal: Principal): ConflictRecord {
    const updated = this.store.setStatus(conflict.id, action === 'dismiss' ? 'dismissed' : 'applied');
    if (!updated) throw new SmurgError('not_found');
    this.ctx.audit.record({
      actor: principal.actor,
      action: 'doc.conflict-resolve',
      outcome: 'ok',
      target: auditTarget(conflict.file),
      detail: { conflictId: conflict.id, action },
    });
    this.announce(updated);
    return updated;
  }

  flush(): Promise<void> {
    return this.store.flush();
  }
}
