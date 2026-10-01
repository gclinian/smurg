// The activity feed (SPEC R8 「每一次 agent 的修改都出現在活動動態中」, R11; ARCHITECTURE §5.4, §7.3). This module ALONE
// turns bus events into activity entries and their audit entries (contract review C13; mapping in ActivityFeed,
// core/interfaces.ts), so nothing is missing or recorded twice:
//   agent.tool.post (ok, with a file)      → agent.edit       + audit agent.edit      (actor: the agent)
//   file.changed, change by an agent       → agent.edit       + audit agent.edit      (not again within the window)
//   file.changed, change by nobody known   → attributed (below), else external.change + audit external.change
//   doc.saved (per file and human, windowed) → human.edit     + audit doc.edit
//   agent.tool.pre denied                  → lock.denied      + audit lock.denied
// A change that carries a user / system `by` (doc autosave, upload commit, merge) is recorded by whoever made it,
// through record(), together with its own audit entry; record() itself never audits.
//
// Attribution of an unattributed disk change (the watcher saw it, nobody announced it): the agent session holding the
// agent lock on that file at that time (or releasing it moments before: the watcher lags the write), else a session
// whose PostToolUse (or FileChanged hook) named the file within the window (then it is that edit's echo); in a
// worktree root, where normally only the sessions running in it write (review SPEC-01: an agent's Bash `sed`, a
// formatter), the one agent session running there, else its owner; else 'external'.
//   agent.file-changed (FileChanged hook)  → agent.edit       + audit agent.edit      (ARCHITECTURE D-6)
//
// Bash windows (ARCHITECTURE §11 D-13, config.activity.attributeBashEdits): the Bash activity hook reports when a
// session starts and finishes a shell command (agent.tool.pre / agent.tool.post with tool 'Bash' and no file). A change
// nobody claimed (no lock, no Post echo, no announced writer) that falls inside the Bash window of EXACTLY ONE session
// (every session runs unsandboxed, §11 D-15: any of them could have written anywhere), with a grace of
// BASH_WINDOW_GRACE_MS after the command finished for the watcher's latency, and whose root contains the file, is that
// agent's: agent.edit, via 'bash' (「…透過 shell 指令修改了…」). Two or more such windows, or none, or a writer in
// another root: 「外部程式」 as before. Never guess. The decision is then announced as agent.tool.post (tool 'Bash',
// the file), so the file tree badge (files module) and the conflict record's source (docs module) follow this rule.
import {
  PAGE_LIMIT_MAX,
  SmurgError,
  activityEventSchema,
  baseNameOfRelPath,
  fileRefKey,
  isHiddenTempName,
  isValidRelPath,
  memberNotificationSchema,
  rootRefEquals,
  rootRefKey,
  type Actor,
  type ActivityEvent,
  type FileRef,
  type LockInfo,
  type MemberNotification,
  type PayloadOf,
  type ResultInputOf,
} from '@smurg/protocol';
import type { ActivityFeed, AuditLog, DaemonEvents, EventBus, FileChangeKind, Hub, LockManager, MemberDirectory, Principal, SessionManager, UserId } from '../core/interfaces.ts';
import { DisposableStack, newId, type Clock, type Disposable } from '../core/lifecycle.ts';
import type { Logger } from '../core/logger.ts';
import { SYSTEM_ACTOR, isHostPrincipal } from '../core/permissions.ts';
import type { ActivityLogFile } from './activity-log.ts';
import { isHiddenFromGuests, lockKeyOf } from './keys.ts';
import {
  agentChangeSummary,
  agentEditSummary,
  bashBurstSummary,
  bashChangeSummary,
  agentNameFor,
  externalBurstSummary,
  externalChangeSummary,
  worktreeBurstSummary,
  worktreeChangeSummary,
  humanEditSummary,
  lockDeniedSummary,
  safeToolName,
  summary as cleanSummary,
} from './text.ts';

type ActivityKind = ActivityEvent['kind'];
type AgentActor = Extract<Actor, { kind: 'agent' }>;

/**
 * An agent's edit is recorded once, from whichever source reports it first (the watcher, or PostToolUse); the other
 * report of the SAME edit (same session, file and PreToolUse grant) within this window is its echo. A new grant starts
 * a new edit, so every tool call is recorded (R8.5 「每一次」).
 */
export const AGENT_EDIT_WINDOW_MS = 5_000;
/** A disk change this soon after an agent lock was released is still that agent's (the watcher lags the write). */
export const LOCK_RELEASE_GRACE_MS = 3_000;
/** An external change of the same file is recorded at most once per this window (a log file written continuously). */
export const EXTERNAL_WINDOW_MS = 10_000;
/** A disk change this soon after a doc autosave of the same file is the save's echo. */
export const SAVE_ECHO_WINDOW_MS = 2_000;
/** One human.edit per person and file per this window (autosave runs every few hundred ms while typing). */
export const HUMAN_EDIT_WINDOW_MS = 60_000;
/** More unattributed changes than this in one watcher batch (git checkout, rm -rf) become one aggregate entry. */
export const EXTERNAL_BURST_MAX = 20;
/** lock.denied entries per session per minute (forged PreToolUse floods); the rest are only counted in the audit log. */
export const LOCK_DENIED_PER_SESSION_PER_MINUTE = 30;
/** A change this soon after a session's Bash command finished is still inside its window (watcher latency, D-13). */
export const BASH_WINDOW_GRACE_MS = 3_000;
/** A Bash window without its end counts for at most this long (Claude Code's longest Bash timeout, 10 minutes). */
export const BASH_WINDOW_MAX_MS = 10 * 60_000;
/** The tool name of the Bash activity hook's events (hooks/wire.ts BASH_TOOL_NAME). */
const BASH_TOOL = 'Bash';

const MINUTE_MS = 60_000;
/** Bound of every per-file / per-session bookkeeping map. */
const TRACKED_MAX = 10_000;
const AUDIT_SAMPLE = 10;

const MODIFYING_KINDS: ReadonlySet<ActivityKind> = new Set(['agent.edit', 'human.edit', 'file.create', 'file.rename', 'file.upload', 'external.change']);

export interface ActivityDeps {
  readonly clock: Clock;
  readonly log: Logger;
  readonly audit: Pick<AuditLog, 'record'>;
  readonly hub: Pick<Hub, 'broadcast' | 'sendToUser'>;
  readonly members: Pick<MemberDirectory, 'get' | 'active'>;
  /** Read lazily: services are created in any order. */
  readonly locks: () => Pick<LockManager, 'get'>;
  /** Read lazily: which sessions run in a worktree root (attribution of changes nobody announced). */
  readonly sessions?: () => Pick<SessionManager, 'list'>;
  readonly file: ActivityLogFile;
  /** config.activity.attributeBashEdits (§11 D-13). Default true. */
  readonly attributeBashEdits?: boolean;
}

/** One session's Bash commands (§11 D-13): how many are running, since when, and when the last one ended. */
interface BashWindow {
  open: number;
  openedAt: number;
  closedAt: number | null;
}

interface AgentMark {
  readonly sessionId: string;
  readonly ownerUserId: UserId;
  readonly agentName: string;
  readonly at: number;
}

/** A Map that forgets its oldest entries beyond TRACKED_MAX (insertion order; set() refreshes). */
class BoundedMap<K, V> extends Map<K, V> {
  override set(key: K, value: V): this {
    super.delete(key);
    super.set(key, value);
    while (this.size > TRACKED_MAX) {
      const oldest = this.keys().next();
      if (oldest.done === true) break;
      super.delete(oldest.value);
    }
    return this;
  }
}

function userFallbackName(userId: UserId): string {
  const name = userId.slice(userId.indexOf(':') + 1);
  return name.length > 0 ? name : 'member';
}

export class ActivityFeedImpl implements ActivityFeed {
  private readonly clock: Clock;
  private readonly log: Logger;
  private readonly audit: Pick<AuditLog, 'record'>;
  private readonly hub: ActivityDeps['hub'];
  private readonly members: ActivityDeps['members'];
  private readonly locks: ActivityDeps['locks'];
  private readonly sessions: ActivityDeps['sessions'];
  private readonly file: ActivityLogFile;
  private readonly attributeBashEdits: boolean;
  private bus: Pick<EventBus, 'emit'> | null = null;
  private lastAt = 0;
  /** sessionId → its Bash window (D-13). */
  private readonly bashWindows = new BoundedMap<string, BashWindow>();
  /** `${sessionId}|${fileKey}` → when that session's edit of the file was last recorded, and for which grant. */
  private readonly agentEdits = new BoundedMap<string, { readonly at: number; readonly grant: number }>();
  /** `${sessionId}|${fileKey}` → how many agent locks the session was granted on the file (one per tool call). */
  private readonly grants = new BoundedMap<string, number>();
  /** fileKey → the last PostToolUse that named the file. */
  private readonly posts = new BoundedMap<string, AgentMark>();
  /** fileKey → the agent lock released last (and when). */
  private readonly releasedLocks = new BoundedMap<string, AgentMark>();
  /** fileKey → when an external change of it was last recorded. */
  private readonly externals = new BoundedMap<string, number>();
  /** fileKey → last doc.saved. */
  private readonly saves = new BoundedMap<string, number>();
  /** docId → people whose edits the next doc.saved of that doc writes. */
  private readonly pendingHumans = new BoundedMap<string, Set<UserId>>();
  /** `${userId}|${fileKey}` → when that person's edit of the file was last recorded. */
  private readonly humanEdits = new BoundedMap<string, number>();
  /** sessionId → lock.denied entries in the current minute. */
  private readonly denials = new BoundedMap<string, { start: number; count: number }>();
  /** fileKey → who changed the file last (the file tree's badge). */
  private readonly lastModified = new BoundedMap<string, Actor>();

  constructor(deps: ActivityDeps) {
    this.clock = deps.clock;
    this.log = deps.log;
    this.audit = deps.audit;
    this.hub = deps.hub;
    this.members = deps.members;
    this.locks = deps.locks;
    this.sessions = deps.sessions;
    this.file = deps.file;
    this.attributeBashEdits = deps.attributeBashEdits ?? true;
  }

  /** Opens activity.jsonl; `at` keeps increasing across restarts. */
  async start(): Promise<void> {
    this.lastAt = Math.max(this.lastAt, await this.file.open());
  }

  async stop(): Promise<void> {
    await this.file.close();
  }

  flush(): Promise<void> {
    return this.file.flush();
  }

  // ---------------------------------------------------------------------------------------------------------------
  // ActivityFeed
  // ---------------------------------------------------------------------------------------------------------------

  record(input: {
    readonly actor: Actor;
    readonly kind: ActivityKind;
    readonly file?: FileRef;
    readonly summary: string;
    readonly via?: 'bash';
  }): PayloadOf<'activity.event'>['event'] {
    const at = Math.max(this.clock.now(), this.lastAt + 1);
    this.lastAt = at;
    const parsed = activityEventSchema.safeParse({
      id: newId('act'),
      at,
      actor: input.actor,
      kind: input.kind,
      ...(input.file ? { file: { root: input.file.root, path: input.file.path } } : {}),
      summary: cleanSummary(input.summary),
      ...(input.via !== undefined ? { via: input.via } : {}),
    });
    if (!parsed.success) throw new SmurgError('internal', undefined, { reason: 'invalid-activity' });
    const event = parsed.data;
    this.file.append(event);
    if (event.file) {
      const key = lockKeyOf(event.file);
      if (event.kind === 'file.delete') this.lastModified.delete(key);
      else if (MODIFYING_KINDS.has(event.kind)) this.lastModified.set(key, event.actor);
    }
    const hidden = event.file !== undefined && isHiddenFromGuests(event.file);
    try {
      this.hub.broadcast('activity.event', { event }, hidden ? { filter: (_recipient, role) => role === 'host' } : {});
    } catch (err) {
      this.log.error('activity broadcast failed', { error: err instanceof Error ? err.name : 'unknown' });
    }
    return event;
  }

  async list(input: PayloadOf<'activity.list'>, principal: Principal): Promise<ResultInputOf<'activity.list'>> {
    const limit = Math.max(1, Math.min(input.limit ?? 100, PAGE_LIMIT_MAX));
    const host = isHostPrincipal(principal) || principal.kind === 'system';
    const events = await this.file.query({
      limit,
      ...(input.before === undefined ? {} : { before: input.before }),
      ...(host ? {} : { accept: (event: ActivityEvent) => event.file === undefined || !isHiddenFromGuests(event.file) }),
    });
    return { events };
  }

  notify(userId: UserId, notification: Omit<MemberNotification, 'id' | 'at'>): void {
    const member = this.members.active(userId);
    if (!member) throw new SmurgError('not_found', '找不到這位成員', { reason: 'member' });
    const file = notification.file && (member.role === 'host' || !isHiddenFromGuests(notification.file)) ? notification.file : undefined;
    const parsed = memberNotificationSchema.safeParse({
      id: newId('ntf'),
      at: this.clock.now(),
      from: notification.from,
      text: notification.text,
      ...(file ? { file } : {}),
    });
    if (!parsed.success) throw new SmurgError('bad_request', '通知內容不正確', { reason: 'notification' });
    this.hub.sendToUser(userId, 'activity.notify', { notification: parsed.data });
  }

  /** Who changed the file last (file tree badge, R11 「最近被客人修改過的檔案」), or null. */
  lastModifiedBy(file: FileRef): Actor | null {
    return this.lastModified.get(lockKeyOf(file)) ?? null;
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Bus → activity (the mapping above)
  // ---------------------------------------------------------------------------------------------------------------

  attach(bus: Pick<EventBus, 'on' | 'emit'>): Disposable {
    this.bus = bus;
    const stack = new DisposableStack();
    stack.add(bus.on('agent.tool.post', (event) => this.onToolPost(event)));
    stack.add(bus.on('agent.tool.pre', (event) => this.onToolPre(event)));
    stack.add(bus.on('agent.file-changed', (event) => this.onAgentFileChanged(event)));
    stack.add(bus.on('file.changed', (event) => this.onFileChanged(event)));
    stack.add(bus.on('lock.changed', (event) => this.onLockChanged(event)));
    stack.add(bus.on('doc.human-edit', (event) => this.onHumanEdit(event)));
    stack.add(bus.on('doc.saved', (event) => this.onDocSaved(event)));
    return stack;
  }

  private onToolPost(event: DaemonEvents['agent.tool.post']): void {
    if (event.file === null) {
      if (event.tool === BASH_TOOL) this.bashEnded(event.sessionId);
      return;
    }
    const now = this.clock.now();
    const key = lockKeyOf(event.file);
    const actor = this.agentActor(event.sessionId, event.ownerUserId);
    this.posts.set(key, { sessionId: event.sessionId, ownerUserId: event.ownerUserId, agentName: actor.displayName, at: now });
    if (!event.ok || this.agentEditSeen(event.sessionId, key, now)) return;
    const tool = safeToolName(event.tool);
    this.recordAgentEdit(actor, event.file, agentEditSummary(actor.displayName, event.file.path, tool), { tool: tool ?? 'unknown', via: 'hook' });
  }

  /** FileChanged hook (D-6): the agent names a file it changed; the watcher's report of it is then an echo. */
  private onAgentFileChanged(event: DaemonEvents['agent.file-changed']): void {
    if (!isValidRelPath(event.file.path) || isHiddenTempName(baseNameOfRelPath(event.file.path)) || isHiddenFromGuests(event.file)) return;
    const now = this.clock.now();
    const actor = this.agentActor(event.sessionId, event.ownerUserId);
    this.posts.set(lockKeyOf(event.file), { sessionId: event.sessionId, ownerUserId: event.ownerUserId, agentName: actor.displayName, at: now });
    this.agentChange(actor, event.file, event.change, now);
  }

  private onToolPre(event: DaemonEvents['agent.tool.pre']): void {
    if (event.outcome === 'granted') {
      if (event.file === null) {
        if (event.tool === BASH_TOOL) this.bashStarted(event.sessionId);
        return;
      }
      const editKey = `${event.sessionId}|${lockKeyOf(event.file)}`;
      this.grants.set(editKey, (this.grants.get(editKey) ?? 0) + 1);
      return;
    }
    const now = this.clock.now();
    const window = this.denials.get(event.sessionId);
    const current = window && now - window.start < MINUTE_MS ? window : { start: now, count: 0 };
    current.count++;
    this.denials.set(event.sessionId, current);
    const actor = this.agentActor(event.sessionId, event.ownerUserId);
    const holder = event.holder ?? null;
    const holderNames = holderNamesOf(holder);
    const tool = safeToolName(event.tool) ?? 'unknown';
    // The audit log bounds denied entries per actor by itself; the feed is bounded here.
    this.recordAudit(actor, 'lock.denied', 'denied', event.file, {
      sessionId: event.sessionId,
      tool,
      holderKind: holder?.kind ?? 'none',
      ...(holderNames ? { holders: holderNames } : {}),
    });
    if (current.count > LOCK_DENIED_PER_SESSION_PER_MINUTE) return;
    this.safeRecord({
      actor,
      kind: 'lock.denied',
      ...(event.file ? { file: event.file } : {}),
      summary: lockDeniedSummary(actor.displayName, event.file?.path ?? null, holderNames, holder?.kind === 'agent'),
    });
  }

  private onFileChanged(event: DaemonEvents['file.changed']): void {
    const now = this.clock.now();
    const external: { readonly file: FileRef; readonly change: FileChangeKind }[] = [];
    const viaBash: { readonly file: FileRef; readonly change: FileChangeKind }[] = [];
    /** The Bash writer of this root right now (same for every file of the batch), computed when first needed. */
    let bash: AgentActor | 'ambiguous' | null | undefined;
    for (const change of event.changes) {
      if (!isValidRelPath(change.path) || isHiddenTempName(baseNameOfRelPath(change.path))) continue;
      const file: FileRef = { root: event.root, path: change.path };
      if (isHiddenFromGuests(file)) continue;
      const by = change.by;
      if (by?.kind === 'user' || by?.kind === 'system') continue; // recorded by whoever made it
      if (by?.kind === 'agent') {
        this.agentChange(by, file, change.change, now);
        continue;
      }
      const key = lockKeyOf(file);
      const attributed = this.attribute(file, key, now);
      if (attributed === 'echo') continue;
      if (attributed !== null) {
        this.agentChange(attributed, file, change.change, now);
        continue;
      }
      const lastSave = this.saves.get(key);
      if (lastSave !== undefined && now - lastSave <= SAVE_ECHO_WINDOW_MS) continue;
      if (bash === undefined) bash = this.bashWriter(event.root, now);
      if (bash !== null && bash !== 'ambiguous') {
        viaBash.push({ file, change: change.change });
        continue;
      }
      const lastExternal = this.externals.get(key);
      if (lastExternal !== undefined && now - lastExternal < EXTERNAL_WINDOW_MS) continue;
      this.externals.set(key, now);
      external.push({ file, change: change.change });
    }
    if (bash !== undefined && bash !== null && bash !== 'ambiguous' && viaBash.length > 0) this.recordBashChanges(bash, viaBash, now);
    if (external.length === 0) return;
    // In a worktree only its owner's sessions can write: name them instead of 「外部程式」 (SPEC-01) — unless a shell
    // command of another session that could have written there was running (D-13): then nobody is named.
    const writer = event.root.kind === 'worktree' && bash !== 'ambiguous' ? this.worktreeWriter(event.root.worktreeId) : null;
    const worktreeDetail = event.root.kind === 'worktree' && writer !== null ? { worktreeId: event.root.worktreeId } : {};
    if (external.length > EXTERNAL_BURST_MAX) {
      const actor: Actor = writer ?? SYSTEM_ACTOR;
      const paths = external.map((c) => c.file.path);
      for (const c of external) this.lastModified.set(lockKeyOf(c.file), actor);
      const text = writer === null ? externalBurstSummary(external.length, paths) : worktreeBurstSummary(writer.displayName, external.length, paths);
      if (writer?.kind === 'agent') {
        this.recordAudit(writer, 'agent.edit', 'ok', null, { sessionId: writer.sessionId, ownerUserId: writer.ownerUserId, via: 'watcher', root: rootRefKey(event.root), count: external.length, sample: paths.slice(0, AUDIT_SAMPLE) });
        this.safeRecord({ actor: writer, kind: 'agent.edit', summary: text });
        return;
      }
      this.recordAudit(actor, 'external.change', 'ok', null, { root: rootRefKey(event.root), count: external.length, sample: paths.slice(0, AUDIT_SAMPLE), ...worktreeDetail });
      this.safeRecord({ actor, kind: 'external.change', summary: text });
      return;
    }
    for (const c of external) {
      if (writer?.kind === 'agent') {
        this.agentChange(writer, c.file, c.change, now);
        continue;
      }
      const actor: Actor = writer ?? SYSTEM_ACTOR;
      const text = writer === null ? externalChangeSummary(c.file.path, c.change) : worktreeChangeSummary(writer.displayName, c.file.path, c.change);
      this.recordAudit(actor, 'external.change', 'ok', c.file, { change: c.change, ...worktreeDetail });
      this.safeRecord({ actor, kind: 'external.change', file: c.file, summary: text });
    }
  }

  private onLockChanged(event: DaemonEvents['lock.changed']): void {
    const previous = event.previous;
    if (previous?.kind !== 'agent') return;
    const still = event.lock?.kind === 'agent' && event.lock.sessionId === previous.sessionId;
    if (still) return;
    this.releasedLocks.set(lockKeyOf(previous.file), {
      sessionId: previous.sessionId,
      ownerUserId: previous.ownerUserId,
      agentName: previous.agentName,
      at: this.clock.now(),
    });
  }

  private onHumanEdit(event: DaemonEvents['doc.human-edit']): void {
    const pending = this.pendingHumans.get(event.docId) ?? new Set<UserId>();
    pending.add(event.userId);
    this.pendingHumans.set(event.docId, pending);
  }

  private onDocSaved(event: DaemonEvents['doc.saved']): void {
    const now = this.clock.now();
    const key = lockKeyOf(event.file);
    this.saves.set(key, now);
    const people = this.pendingHumans.get(event.docId);
    if (!people) return;
    this.pendingHumans.delete(event.docId);
    for (const userId of people) {
      const member = this.members.get(userId);
      const actor: Actor = { kind: 'user', userId, displayName: member?.displayName ?? userFallbackName(userId) };
      this.lastModified.set(key, actor);
      const seenKey = `${userId}|${key}`;
      const seen = this.humanEdits.get(seenKey);
      if (seen !== undefined && now - seen < HUMAN_EDIT_WINDOW_MS) continue;
      this.humanEdits.set(seenKey, now);
      this.recordAudit(actor, 'doc.edit', 'ok', event.file, { docId: event.docId });
      this.safeRecord({ actor, kind: 'human.edit', file: event.file, summary: humanEditSummary(actor.displayName, event.file.path) });
    }
  }

  // ---------------------------------------------------------------------------------------------------------------

  /** Which agent changed `file` just now, 'echo' when that change was already recorded, or null (external). */
  private attribute(file: FileRef, key: string, now: number): AgentActor | 'echo' | null {
    let lock: LockInfo | null = null;
    try {
      lock = this.locks().get(file);
    } catch {
      lock = null; // no LockManager (stub): attribution by hook events only
    }
    if (lock?.kind === 'agent') return { kind: 'agent', sessionId: lock.sessionId, ownerUserId: lock.ownerUserId, displayName: lock.agentName };
    const released = this.releasedLocks.get(key);
    if (released !== undefined && now - released.at <= LOCK_RELEASE_GRACE_MS) return markActor(released);
    const post = this.posts.get(key);
    if (post !== undefined && now - post.at <= AGENT_EDIT_WINDOW_MS) {
      return this.agentEditSeen(post.sessionId, key, now) ? 'echo' : markActor(post);
    }
    return null;
  }

  // ---- Bash windows (§11 D-13) ---------------------------------------------------------------------------------

  private bashStarted(sessionId: string): void {
    if (!this.attributeBashEdits) return;
    const now = this.clock.now();
    const window = this.bashWindows.get(sessionId) ?? { open: 0, openedAt: now, closedAt: null };
    window.open += 1;
    window.openedAt = now;
    this.bashWindows.set(sessionId, window);
  }

  private bashEnded(sessionId: string): void {
    const window = this.bashWindows.get(sessionId);
    if (window === undefined || window.open === 0) return;
    window.open -= 1;
    window.closedAt = this.clock.now();
  }

  /** The session ran a shell command at `now`, or finished one at most BASH_WINDOW_GRACE_MS ago. */
  private bashCovers(window: BashWindow, now: number): boolean {
    if (window.open > 0 && now - window.openedAt <= BASH_WINDOW_MAX_MS + BASH_WINDOW_GRACE_MS) return true;
    return window.closedAt !== null && now - window.closedAt <= BASH_WINDOW_GRACE_MS;
  }

  /**
   * The ONE agent session whose shell command wrote an unclaimed change in `root` just now (§11 D-13). Every session
   * with a Bash window at `now` counts (all run unsandboxed, §11 D-15: any could have written anywhere). Exactly one
   * such session, an agent session of this very root: that
   * agent. None: null (the other rules apply). Two or more, or one of another root: 'ambiguous' (「外部程式」, and no
   * other rule may name anyone either). A session the session manager does not know (any more) counts as a possible
   * writer and is never the answer.
   */
  private bashWriter(root: FileRef['root'], now: number): AgentActor | 'ambiguous' | null {
    if (!this.attributeBashEdits || this.bashWindows.size === 0) return null;
    const covering = [...this.bashWindows].filter(([, window]) => this.bashCovers(window, now)).map(([sessionId]) => sessionId);
    if (covering.length === 0) return null;
    let infos: ReturnType<SessionManager['list']>;
    try {
      infos = this.sessions?.().list() ?? [];
    } catch {
      return null; // no SessionManager (stub): no roots known, no attribution
    }
    const byId = new Map(infos.map((info) => [info.id, info]));
    // Every session runs unsandboxed (§11 D-15): each one with an open Bash window could have written anywhere.
    if (covering.length !== 1) return 'ambiguous';
    const info = byId.get(covering[0] as string);
    if (info === undefined || info.kind !== 'agent' || !rootRefEquals(info.root, root)) return 'ambiguous';
    return this.agentActor(info.id, info.ownerUserId);
  }

  /** Records the changes of one batch that `actor`'s shell command made, then announces each (badge, conflict source). */
  private recordBashChanges(actor: AgentActor, changes: readonly { readonly file: FileRef; readonly change: FileChangeKind }[], now: number): void {
    const fresh = changes.filter((c) => !this.agentEditSeen(actor.sessionId, lockKeyOf(c.file), now));
    if (fresh.length > EXTERNAL_BURST_MAX) {
      const paths = fresh.map((c) => c.file.path);
      for (const c of fresh) {
        const editKey = `${actor.sessionId}|${lockKeyOf(c.file)}`;
        this.agentEdits.set(editKey, { at: now, grant: this.grants.get(editKey) ?? 0 });
        this.lastModified.set(lockKeyOf(c.file), actor);
      }
      this.recordAudit(actor, 'agent.edit', 'ok', null, { sessionId: actor.sessionId, ownerUserId: actor.ownerUserId, via: 'bash', count: fresh.length, sample: paths.slice(0, AUDIT_SAMPLE) });
      this.safeRecord({ actor, kind: 'agent.edit', summary: bashBurstSummary(actor.displayName, fresh.length, paths), via: 'bash' });
    } else {
      for (const c of fresh) this.recordAgentEdit(actor, c.file, bashChangeSummary(actor.displayName, c.file.path, c.change), { change: c.change, via: 'bash' });
    }
    for (const c of fresh) {
      if (c.change === 'unlink' || c.change === 'unlinkDir') continue;
      this.bus?.emit('agent.tool.post', { sessionId: actor.sessionId, ownerUserId: actor.ownerUserId, tool: BASH_TOOL, file: c.file, ok: true });
    }
  }

  /**
   * Who wrote an unannounced change in worktree `worktreeId`: normally the sessions running in it. The one agent
   * session running there, or its owner when that is ambiguous (a terminal too, or several agents); null when no
   * session of it runs, or sessions of several members do (then it is the host's own doing, or unknown: external).
   */
  private worktreeWriter(worktreeId: string): AgentActor | Extract<Actor, { kind: 'user' }> | null {
    let running: ReturnType<SessionManager['list']>;
    try {
      running = (this.sessions?.().list() ?? []).filter((s) => s.status !== 'exited' && s.root.kind === 'worktree' && s.root.worktreeId === worktreeId);
    } catch {
      return null; // no SessionManager (stub)
    }
    if (running.length === 0) return null;
    const owners = new Set(running.map((s) => s.ownerUserId));
    if (owners.size !== 1) return null;
    const agents = running.filter((s) => s.kind === 'agent');
    if (agents.length === 1 && running.length === 1) return this.agentActor((agents[0] as (typeof running)[number]).id, (agents[0] as (typeof running)[number]).ownerUserId);
    const ownerUserId = running[0]?.ownerUserId as UserId;
    const member = this.members.get(ownerUserId);
    return { kind: 'user', userId: ownerUserId, displayName: member?.displayName ?? userFallbackName(ownerUserId) };
  }

  private agentChange(actor: AgentActor, file: FileRef, change: FileChangeKind, now: number): void {
    if (this.agentEditSeen(actor.sessionId, lockKeyOf(file), now)) return;
    this.recordAgentEdit(actor, file, agentChangeSummary(actor.displayName, file.path, change), { change, via: 'watcher' });
  }

  private recordAgentEdit(actor: AgentActor, file: FileRef, text: string, detail: Readonly<Record<string, unknown>>): void {
    const editKey = `${actor.sessionId}|${lockKeyOf(file)}`;
    this.agentEdits.set(editKey, { at: this.clock.now(), grant: this.grants.get(editKey) ?? 0 });
    this.recordAudit(actor, 'agent.edit', 'ok', file, { sessionId: actor.sessionId, ownerUserId: actor.ownerUserId, ...detail });
    // The feed entry carries how it was attributed when that was the shell window (clients mark it from this field).
    this.safeRecord({ actor, kind: 'agent.edit', file, summary: text, ...(detail['via'] === 'bash' ? { via: 'bash' as const } : {}) });
  }

  /** This edit (the session's current grant on the file) was recorded already, within the window. */
  private agentEditSeen(sessionId: string, key: string, now: number): boolean {
    const editKey = `${sessionId}|${key}`;
    const mark = this.agentEdits.get(editKey);
    return mark !== undefined && mark.grant === (this.grants.get(editKey) ?? 0) && now - mark.at < AGENT_EDIT_WINDOW_MS;
  }

  private agentActor(sessionId: string, ownerUserId: UserId): AgentActor {
    const owner = this.members.get(ownerUserId);
    return { kind: 'agent', sessionId, ownerUserId, displayName: agentNameFor(owner?.displayName ?? userFallbackName(ownerUserId)) };
  }

  private safeRecord(input: Parameters<ActivityFeedImpl['record']>[0]): void {
    try {
      this.record(input);
    } catch (err) {
      this.log.error('activity entry failed', { kind: input.kind, error: err instanceof Error ? err.name : 'unknown' });
    }
  }

  private recordAudit(
    actor: Actor,
    action: 'agent.edit' | 'external.change' | 'doc.edit' | 'lock.denied',
    outcome: 'ok' | 'denied',
    file: FileRef | null,
    detail: Readonly<Record<string, unknown>>,
  ): void {
    try {
      this.audit.record({ actor, action, outcome, ...(file ? { target: fileRefKey(file) } : {}), detail });
    } catch (err) {
      this.log.error('activity audit failed', { action, error: err instanceof Error ? err.name : 'unknown' });
    }
  }
}

function markActor(mark: AgentMark): AgentActor {
  return { kind: 'agent', sessionId: mark.sessionId, ownerUserId: mark.ownerUserId, displayName: mark.agentName };
}

function holderNamesOf(holder: LockInfo | null): string[] | null {
  if (holder === null) return null;
  return holder.kind === 'agent' ? [holder.agentName] : holder.holders.map((h) => h.displayName);
}

