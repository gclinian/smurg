// THE internal contract of the daemon (ARCHITECTURE §7.2): every service interface, the event map of the bus
// (§7.3), the router/hub surface handlers use, and the FeatureModule shape. Modules talk to each other ONLY through
// these interfaces and `ctx.bus`; a feature engineer implements one or more services and exports a FeatureModule.
//
// Conventions that hold for every service below:
//  * Permissions. The Router has already checked the caller's CAPABILITY (registry + role) before a handler runs.
//    Resource-level checks (ownership, path guard, locks, disk) are the handler's / service's job and are listed per
//    method. Deny with `ctx.deny()` (handlers) or throw AuthorizationError / PathDeniedError (services); both are
//    audited exactly once. Never trust a userId, sessionId owner or path that came from a client payload.
//  * Paths. Every FileRef from a client, a hook or the MCP socket goes through PathGuard before any fs call, and
//    PathGuard is asked again right before every read and write (openRead / writeFileAtomic / revalidate).
//  * Errors. Throw SmurgError (codes of ARCHITECTURE §4.3). Anything else becomes `internal` with a generic message.
//  * Laziness. Services receive the DaemonContext in their module's create(); they may call OTHER services only from
//    their methods (never in create()), because services are created in any order.
//  * No blocking. Never spawnSync/execSync or run long synchronous work on the daemon's event loop (§0 rule 5).
import type {
  AccountInfo,
  Actor,
  AgentPurpose,
  AgentSession,
  AttentionSubject,
  AuditAction,
  AuditEntry,
  BidirectionalType,
  CHANNEL_CLOSED_REASONS,
  Capability,
  CardRef,
  CardWithdrawnReason,
  ChannelPurpose,
  ClientEnvelope,
  ColumnTarget,
  ConflictRecord,
  ConversationEvent,
  ConversationEventInput,
  DaemonInviteKey,
  DiskReport,
  EventType,
  FileEntry,
  FileRef,
  GuestRole,
  HandshakeMode,
  HostSettings,
  HostSettingsPatch,
  InboxItem,
  InviteInfo,
  LockInfo,
  LoginState,
  Member,
  MemberNotification,
  MemberWithDevices,
  MergeRequest,
  MessageOrigin,
  NotifyType,
  PayloadInputOf,
  PayloadOf,
  PermissionMode,
  PermissionRequest,
  PlanInfo,
  PresenceAgent,
  ProjectSettingsState,
  PublicSettings,
  Question,
  RateBucket,
  RememberedRule,
  ReportInfo,
  ReportSummary,
  RequestType,
  ResultInputOf,
  Role,
  RootRef,
  RoutingMember,
  SessionEndReason,
  SessionInfo,
  SmurgPurpose,
  StalledBy,
  StartPreflight,
  StreamingBlock,
  Suggestion,
  ToolView,
  Topic,
  TurnOutcome,
  UserRef,
  Welcome,
  WorkItem,
  WorkspaceInfo,
  WorktreeInfo,
} from '@smurg/protocol';
import type { MessageRef } from '@smurg/protocol/i18n';
import type { FileHandle } from 'node:fs/promises';
import type { z } from 'zod';
import type { Disposable } from './lifecycle.ts';
import type { PathDeniedReason } from './errors.ts';

// =====================================================================================================================
// Identity
// =====================================================================================================================

/** Relay-issued user id: "github:<id>" | "google:<sub>" | "dev:<name>" (ARCHITECTURE §3). */
export type UserId = string;
export type ClientKind = 'web' | 'cli';
export type ChannelClosedReason = (typeof CHANNEL_CLOSED_REASONS)[number];

/**
 * Who is acting, as the daemon sees it. Built by the daemon, never from a payload:
 *  - a member's request: kind 'user', role = their CURRENT role;
 *  - an agent (hook / MCP socket): kind 'agent', userId of the session's OWNER, actor `Claude (<label>)`; the role is
 *    the owner's, except that a session with `pathRights: 'member'` never has the role `host` (MemberDirectory
 *    .agentPrincipal: a handover to the host raises nothing);
 *  - the daemon itself (watcher, timers, stop): kind 'system', userId/role null.
 */
export interface Principal {
  readonly kind: 'user' | 'agent' | 'system';
  readonly actor: Actor;
  readonly userId: UserId | null;
  readonly role: Role | null;
}

// =====================================================================================================================
// Persisted records (state.json, ARCHITECTURE §7.1). Owned by MemberDirectory / InviteService / RootRegistry.
// =====================================================================================================================

export interface MemberRecord {
  readonly userId: UserId;
  readonly displayName: string;
  readonly avatarUrl?: string;
  readonly role: Role;
  /** `#rrggbb`, stable per member (presence cursors). */
  readonly color: string;
  readonly joinedAt: number;
  readonly lastSeenAt: number;
  /** 'kicked' members keep their record (audit, re-invite rule) but have no role in any check. */
  readonly status: 'active' | 'kicked';
  readonly kickedAt?: number;
}

export interface DeviceRecord {
  /** base64url(SHA-256(publicKey)[0..16]); what DeviceInfo.deviceId shows. */
  readonly deviceId: string;
  readonly userId: UserId;
  /** The device's X25519 static key, 64 hex characters. */
  readonly publicKeyHex: string;
  readonly name: string;
  readonly kind: ClientKind;
  readonly addedAt: number;
  readonly lastSeenAt: number;
  readonly revoked: boolean;
  readonly revokedAt?: number;
  /** The invite this device joined through. */
  readonly inviteId?: string;
}

export interface InviteRecord {
  /** Opaque random id shown to the host (unrelated to the Noise invite id). */
  readonly id: string;
  /** The 16-byte invite id (hex) that goes into the Noise prologue. Never sent anywhere, not even to the host. */
  readonly keyIdHex: string;
  /** The 32-byte psk (hex). The invite secret `s` itself is never stored. */
  readonly pskHex: string;
  readonly role: Role;
  /** Only this user may use the invite (the host's own invite). */
  readonly boundUserId?: UserId;
  readonly createdAt: number;
  readonly createdBy: UserId | null;
  readonly expiresAt?: number;
  readonly maxUses?: number;
  readonly uses: number;
  readonly revoked: boolean;
  /** The host's single-use invite printed by `smurg host`. */
  readonly host: boolean;
}

// =====================================================================================================================
// EventBus (ARCHITECTURE §7.3). Synchronous, in-process; listeners must not throw (errors are logged and swallowed)
// and must not block. Emitted AFTER the state change is committed in memory.
// =====================================================================================================================

export type FileChangeKind = 'add' | 'change' | 'unlink' | 'addDir' | 'unlinkDir';

export interface FileChange {
  readonly path: string;
  readonly change: FileChangeKind;
  /** Best-effort attribution (FileService.expectChange, hook events). */
  readonly by?: Actor;
}

export type LockChangeReason =
  | 'acquired'
  | 'touched'
  | 'holder-joined'
  | 'holder-left'
  | 'idle'
  | 'released'
  | 'expired'
  | 'forced'
  | 'session-ended'
  | 'member-removed';

export type ConnectionCloseReason = ChannelClosedReason | 'disconnected' | 'replaced' | 'relay-down' | 'error';

export interface DaemonEvents {
  /** A user was admitted into the workspace for the first time (or again after a kick, through a newer invite). */
  'member.joined': { readonly member: MemberRecord; readonly device: DeviceRecord; readonly inviteId: string };
  /**
   * `channel.leave` (R4). Membership and devices stay. THE CORE runs the teardown of ARCHITECTURE §3 "When a member
   * goes" for this event (admin/teardown.ts; the handler awaits it: R4, within 5 s): ConversationService.memberRemoved,
   * TopicService.memberRemoved, SessionManager.teardownUser, UploadService.abortAllForUser, in that order. Other
   * listeners release everything else they hold for the user (human locks, doc subscriptions, presence, the inbox).
   */
  'member.left': { readonly userId: UserId; readonly by: Actor };
  /**
   * Kick (R2): devices are already revoked and channels closed when this fires. The core runs the same teardown (the
   * console's kick awaits it: R2, within 3 s); other listeners drop every other per-user resource (human locks, doc
   * subscriptions, presence, pending suggestions, stored inbox notes).
   */
  'member.kicked': { readonly userId: UserId; readonly by: Actor; readonly revokedDevices: readonly string[] };
  /**
   * Role changed without a kick. The member's channels were closed with `role-changed` (they reconnect with the new
   * role). When the new role lost `session.drive` or `discuss`, the core runs the teardown for it (what the member put
   * in place goes; with `session.create` gone their terminals and free sessions end and their topic sessions pass to
   * the host).
   */
  'member.role-changed': { readonly userId: UserId; readonly from: Role; readonly to: Role; readonly by: Actor };
  'device.added': { readonly device: DeviceRecord };
  'device.revoked': { readonly device: DeviceRecord; readonly by: Actor };
  /** An admitted channel (interactive or transfer). `resumed`: continues a logical channel (no resync needed). */
  'conn.opened': { readonly conn: ClientConnection; readonly resumed: boolean };
  /** The socket-level connection ended. Its logical channel may still come back resumed (reason 'disconnected'). */
  'conn.closed': { readonly conn: ClientConnection; readonly reason: ConnectionCloseReason };
  /**
   * A logical channel is gone for good (retention expired, replaced by a non-resumed one, kick, role change, stop):
   * drop every piece of per-channel state keyed by `channelId` (doc subscriptions, attached sessions).
   */
  'channel.discarded': { readonly channelId: string; readonly userId: UserId; readonly purpose: ChannelPurpose };
  'settings.changed': { readonly settings: HostSettings; readonly previous: HostSettings; readonly by: Actor };
  /** From the watcher: every event means "re-check this path"; own echoes are detected by content hash. */
  'file.changed': { readonly root: RootRef; readonly changes: readonly FileChange[] };
  /** A human's Yjs update was applied to a doc (drives human locks and the activity feed). `channelId`: the sender's logical channel. */
  'doc.human-edit': { readonly file: FileRef; readonly docId: string; readonly userId: UserId; readonly channelId: string };
  'doc.saved': { readonly file: FileRef; readonly docId: string; readonly hash: string; readonly at: number };
  /** PreToolUse for a modifying tool was decided (granted: the agent lock is held; denied: `holder` blocked it). */
  'agent.tool.pre': {
    readonly sessionId: string;
    readonly ownerUserId: UserId;
    readonly tool: string;
    readonly file: FileRef | null;
    readonly outcome: 'granted' | 'denied';
    readonly holder?: LockInfo;
  };
  'agent.tool.post': {
    readonly sessionId: string;
    readonly ownerUserId: UserId;
    readonly tool: string;
    readonly file: FileRef | null;
    readonly ok: boolean;
  };
  /** FileChanged hook (activity feed only; correctness never depends on it, §7.6). */
  'agent.file-changed': { readonly sessionId: string; readonly ownerUserId: UserId; readonly file: FileRef; readonly change: 'add' | 'change' | 'unlink' };
  /** The tool gate refused a tool call (rows G2–G7). Emitted by hooks; conversation audits `permission.auto-deny`, coalesced. */
  'agent.tool.gate': { readonly sessionId: string; readonly tool: string; readonly row: GateRow; readonly path?: string };
  /**
   * An agent's process answered `initialize`. Emitted by sessions. The RUNNER itself writes what follows from it (the
   * notices `notice.notLoggedIn` and `notice.personalSubscription`, the account state, the host's rules it reported):
   * no other module has to listen.
   */
  'agent.ready': { readonly sessionId: string; readonly claudeVersion: string; readonly login: LoginState; readonly tools: readonly string[] };
  /**
   * `AgentSessionFacts.hasProcess` of a session changed (every change, and nothing else): it got a process
   * (`started`: a start, a message to a parked or failed session, a retry), gave it up while staying idle (`parked`),
   * lost it (`failed`), or ended. Parking moves no `session.updated` (a parked session stays `idle`), so this is how
   * the scheduler learns that a slot is free. Emitted by sessions.
   */
  'agent.process': {
    readonly sessionId: string;
    readonly purpose: AgentPurpose;
    readonly topicId?: string;
    readonly hasProcess: boolean;
    readonly reason: 'started' | 'parked' | 'failed' | 'ended';
  };
  /** The agent asks (AskUserQuestion) or wants permission. Emitted by sessions; conversation makes a card or answers itself. */
  'agent.request': { readonly sessionId: string; readonly request: AgentRequest };
  /**
   * Claude Code withdrew a request: the turn was stopped (`stopped`), the session ended (`ended`) or its process failed
   * (`failed`). `by`: the person who stopped the turn or ended the session, when a person did (`Question.withdrawn.by`).
   * NOT emitted for a restart of the daemon: the runner keeps no request across one; the conversation module withdraws
   * the cards that are open in its own store when it starts (`restarted`).
   */
  'agent.request.withdrawn': { readonly sessionId: string; readonly requestId: string; readonly reason: Exclude<CardWithdrawnReason, 'restarted'>; readonly by?: UserRef };
  'agent.turn.started': { readonly sessionId: string; readonly turnId: string };
  /**
   * A turn ended. `finalText`: the agent's last text block (masked). `stoppedBy`: the person who stopped it (outcome
   * `interrupted`). `messages`: the messages this turn took, oldest first, each with who wrote it: a person's message
   * (`from`, `origin`, and `suggestionId` when it was an accepted suggestion: then `from` is the suggestion's author)
   * or one of smurg's own (`purpose`, and `by` when a member asked for it). `edited`: the files its edit tools
   * changed, each with the `seq` of its tool card. Topics run the plan and report checks, follow-up answers,
   * `lastAgentChange` (who asked: the newest person among `messages`, else the newest `by`) and "stalled" from this.
   */
  'agent.turn.finished': {
    readonly sessionId: string;
    readonly turnId: string;
    readonly outcome: TurnOutcome;
    readonly finalText?: string;
    readonly stoppedBy?: UserRef;
    readonly messages: readonly TurnMessage[];
    readonly edited: readonly { readonly file: FileRef; readonly seq: number }[];
  };
  'lock.changed': { readonly file: FileRef; readonly lock: LockInfo | null; readonly previous: LockInfo | null; readonly reason: LockChangeReason };
  'session.created': { readonly session: SessionInfo };
  /** Any change of SessionInfo other than creation and exit (a terminal's attach count or size; an agent session's status, responsible person, mode, title, …). */
  'session.updated': { readonly session: SessionInfo };
  /** A session ended for good (a terminal exited; an agent session is `ended`). `reason` is also SessionInfo.endReason. */
  'session.exited': { readonly session: SessionInfo; readonly reason: SessionEndReason };
  /** Every change of a question (a vote, a comment, the decider, escalation, the answer, a withdrawal). `previous` null: it was just asked. */
  'question.changed': { readonly question: Question; readonly previous: Question | null };
  /** Every change of a permission request. The host's copy (with `path`). `previous` null: it was just raised. */
  'permission.changed': { readonly request: PermissionRequest; readonly previous: PermissionRequest | null };
  'suggestion.changed': { readonly suggestion: Suggestion; readonly previous: Suggestion | null };
  /** `previous` null: the topic was just created. The hub fan-out (`topic.updated`) is the topics module's. */
  'topic.changed': { readonly topic: Topic; readonly previous: Topic | null };
  /**
   * The topic was deleted. `sessionIds`: every agent session it had. TopicService emits this FIRST (listeners can still
   * map the sessions: the conversation and suggest modules drop their cards, the inbox its notes) and then calls
   * `AgentSessions.forget(sessionIds)` itself; the sessions module does not listen.
   */
  'topic.removed': { readonly topicId: string; readonly sessionIds: readonly string[] };
  'plan.changed': { readonly topicId: string; readonly plan: PlanInfo };
  /** `previous` null: the first version of the report was registered. */
  'report.changed': { readonly topicId: string; readonly itemId: string; readonly report: ReportSummary; readonly previous: ReportSummary | null };
  /** `worktree` null ⇒ removed. */
  'worktree.changed': { readonly worktreeId: string; readonly worktree: WorktreeInfo | null };
  /** Every change of a merge request, drafts included (`draft`, `reviewed`, `topicId`, `itemId`). */
  'merge.changed': { readonly request: MergeRequest };
  /** The attention facts of one source changed: the inbox asks that source's `attention()` again. */
  'attention.changed': { readonly source: AttentionSource };
  /** `AgentSessions.account()` changed. Emitted by sessions, which also sends `session.host` to everyone. */
  'account.changed': { readonly account: AccountInfo };
  /**
   * The activity module recorded an entry (EVERY entry it records). Topics read hand edits from it (and, because the
   * feed has only ONE `human.edit` entry per person and file per minute, typing in the editor from `doc.human-edit` /
   * `doc.saved`), worktree `changes.byHand`. `renamedFrom`: with kind `file.rename`, the path the entry had before,
   * relative to `file.root` (`file.path` is the new one): a rename of SPEC.md or PLAN.md away from its path, or into
   * it, is a hand edit.
   */
  'activity.recorded': {
    readonly entry: { readonly actor: Actor; readonly kind: string; readonly file?: FileRef; readonly at: number; readonly via?: 'bash'; readonly renamedFrom?: string };
  };
  /** The host's decision about a root's project-level Claude Code settings changed, or the files did. */
  'trust.changed': { readonly root: RootRef; readonly state: ProjectSettingsState };
  /** stop() began: finish or abort work; channels are closed right after the listeners ran. */
  'daemon.stopping': { readonly reason: string };
  /**
   * A state document could not be written (ok: false; the store keeps retrying) or was written again after failing
   * (ok: true). Changes made meanwhile are in force but would be lost by a restart: tell the host.
   */
  'state.write': { readonly document: string; readonly ok: boolean };
  /**
   * The relay link of one socket purpose changed state: 'online', 'waiting' (dropped or
   * unreachable, reconnecting), 'auth-rejected' (the relay refused the host's session token: the host must log in
   * again; members cannot connect meanwhile), 'replaced', 'stopped'. `reason` / `status` say why it left `online`.
   */
  'relay.link': { readonly purpose: ChannelPurpose; readonly state: string; readonly reason?: string; readonly status?: number };
}

export type DaemonEventName = keyof DaemonEvents;

export interface EventBus {
  on<K extends DaemonEventName>(name: K, listener: (event: DaemonEvents[K]) => void): Disposable;
  once<K extends DaemonEventName>(name: K, listener: (event: DaemonEvents[K]) => void): Disposable;
  emit<K extends DaemonEventName>(name: K, event: DaemonEvents[K]): void;
  listenerCount(name: DaemonEventName): number;
}

// =====================================================================================================================
// StateStore: atomic JSON documents under ~/.smurg/workspaces/<id>/ (0700 dir, 0600 files)
// =====================================================================================================================

/**
 * One JSON file, validated with its schema on load (an invalid file stops the daemon: it is never silently reset).
 * The in-memory copy is authoritative; update() changes it synchronously and schedules one serialized atomic write
 * (tmp + fsync + rename). Several updates in a row coalesce into one write of the latest value.
 */
export interface PersistentDocument<T> {
  readonly name: string;
  get(): Readonly<T>;
  /** `mutator` gets a deep copy; return the new value (or mutate the copy and return nothing). Validated before commit. */
  update(mutator: (draft: T) => T | void): Readonly<T>;
  /**
   * Resolves when everything updated so far is on disk. If it is not, a write is attempted now; rejects with that
   * attempt's error. A document whose write failed stays unsaved and is re-written (backoff) until the disk takes it.
   */
  flush(): Promise<void>;
}

export interface StateStore {
  /** `~/.smurg/workspaces/<workspaceId>` */
  readonly dir: string;
  /**
   * Opens (or creates with `init()`) `<dir>/<name>.json`. `name` is `[a-z0-9-]{1,40}`; `state` is reserved for the
   * core (members, devices, invites, settings, roots). Feature modules keep their own documents here
   * (`conflicts`, `suggestions`, `worktrees`, …). Opening the same name twice returns the same document.
   */
  document<S extends z.ZodType>(name: string, schema: S, init: () => z.output<S>): Promise<PersistentDocument<z.output<S>>>;
  /** Absolute path of a private sub-directory (created 0700), e.g. `uploads`. */
  privateDir(name: string): Promise<string>;
  flush(): Promise<void>;
}

// =====================================================================================================================
// AuditLog (R11): append-only JSONL, newest-first queries, live feed for the host console.
// =====================================================================================================================

export interface AuditInput {
  readonly actor: Actor;
  readonly action: AuditAction;
  readonly outcome: 'ok' | 'denied' | 'error';
  /** Usually a path, an id or a message type. Clamped to the schema's length. */
  readonly target?: string;
  /**
   * Machine-readable facts. SANITISED before it is written: bytes become `{ bytes: n }`, and values under keys that
   * can carry secrets or content (content, data, apiKey, token, identityToken, secret, psk, url, hookInput, …) are
   * replaced. Never pass a sensitive message payload here; use auditDetailForMessage() for payload-derived detail.
   */
  readonly detail?: Readonly<Record<string, unknown>>;
  /**
   * Top-level `detail` keys that carry a FULL TEXT a person or an agent wrote (a message, a suggestion, a command, a
   * note): the entry keeps the first AUDIT_FULL_TEXT_HEAD_CHARS characters under the key, the text's SHA-256 under
   * `<key>Sha256` and its length under `<key>Chars`; the whole text goes to the full-text store (`audit-text`, 3 ×
   * 32 MiB, keyed by that hash; AuditLog.fullText reads it back). So a member who loops suggestions cannot rotate
   * role changes and permission decisions out of the core log. Never list a key that can carry file contents or
   * secrets (the key-based redaction applies first: `content`, `data`, `diff`, … are replaced whatever this says).
   */
  readonly fullText?: readonly string[];
}

export interface AuditQuery {
  /** Default 100, at most `limits.auditPageMax`. */
  readonly limit?: number;
  /** Only entries with `at < before` (epoch ms; `at` is strictly increasing, so this is an exact cursor). */
  readonly before?: number;
}

export interface AuditLog {
  /**
   * Assigns id and a strictly increasing `at`, validates, queues the append and notifies subscribers. Synchronous:
   * safe to call inside admit(). A failing disk write is logged; the entry is still delivered live. Bounded: `denied`
   * entries beyond limits.auditDeniedPerActorPerMinute for one actor (a user, or an agent's owner) are only counted
   * (one entry marks the start, one summary entry the count), and are neither written nor delivered live.
   */
  record(input: AuditInput): AuditEntry;
  /** Newest first, across the current file and its rotated predecessors (audit.1.jsonl, audit.2.jsonl). */
  query(query?: AuditQuery): Promise<AuditEntry[]>;
  /** Live feed (admin.audit.entry). */
  subscribe(listener: (entry: AuditEntry) => void): Disposable;
  /** The whole text an entry's `<key>Sha256` names, or null when the full-text store no longer holds it. */
  fullText(sha256: string): Promise<string | null>;
  flush(): Promise<void>;
}

/** Characters of a full text an audit entry itself keeps (AuditInput.fullText). */
export const AUDIT_FULL_TEXT_HEAD_CHARS = 1_024;

// =====================================================================================================================
// Hub: admitted connections, logical channels (resume), fan-out
// =====================================================================================================================

/**
 * An admitted channel. Interactive channels belong to a logical channel that survives reconnects (resume):
 * per-client state that must survive a resume (doc subscriptions, attached terminals) MUST be keyed by `channelId`,
 * not by `id`. A client that resumes (Welcome.resumed = true) does not re-open anything, so the daemon keeps sending
 * to its channelId while it is away (queued, replayed) until `channel.discarded`.
 */
/** How a connection was admitted: a Noise handshake through the relay, or the host's local control socket. */
export type ConnectionMode = HandshakeMode | 'local';

/** deviceId of every local (control socket) connection: the host's OS account is the credential, not a key. */
export const LOCAL_DEVICE_ID = 'local';

export interface ClientConnection {
  /** Daemon-local id (`conn_…`), stable for this socket session only. */
  readonly id: string;
  readonly purpose: ChannelPurpose;
  /** The relay's connection id (u32) on the host socket of this purpose; null for a local connection. */
  readonly relayConn: number | null;
  readonly userId: UserId;
  /** The device's id (DeviceInfo.deviceId), or LOCAL_DEVICE_ID. */
  readonly deviceId: string;
  readonly clientKind: ClientKind;
  readonly deviceName: string;
  readonly mode: ConnectionMode;
  /** Welcome.channelId: the logical channel (interactive) or a per-socket id (transfer). */
  readonly channelId: string;
  readonly openedAt: number;
  readonly isOpen: boolean;
  /** Bytes queued on the daemon's relay socket of this purpose (download flow control). */
  readonly bufferedAmount: number;
  /** Runs once when this connection closes (immediately, asynchronously, if it already has). */
  onClose(listener: (reason: ConnectionCloseReason) => void): Disposable;
}

/** d→c types a module may send unsolicited (responses are the router's business). */
export type OutboundType = Exclude<EventType, 'error'> | Exclude<BidirectionalType, 'channel.ack'> | 'error';

/**
 * A fan-out recipient: an interactive logical channel (connected or waiting for a resume) or an open transfer
 * connection. `conn` is null while the logical channel is disconnected.
 */
export interface Recipient {
  readonly channelId: string;
  readonly userId: UserId;
  readonly purpose: ChannelPurpose;
  readonly conn: ClientConnection | null;
}

export interface BroadcastOptions<T extends OutboundType = OutboundType> {
  /** Default 'interactive'. */
  readonly purpose?: ChannelPurpose;
  /** What a recipient who is the HOST gets instead of `payload` (a permission request's absolute `path`). */
  readonly hostPayload?: PayloadInputOf<T>;
  /** Recipients must also hold this capability (on top of the registry's receive rule, which always applies). */
  readonly capability?: Capability;
  /** Extra recipient filter (e.g. doc subscribers, attached viewers, suggestion parties). */
  readonly filter?: (recipient: Recipient, role: Role) => boolean;
  /** Skip this channelId (typically the sender of an update). */
  readonly exclude?: string;
}

export interface Hub {
  connection(id: string): ClientConnection | null;
  connections(filter?: { readonly userId?: UserId; readonly purpose?: ChannelPurpose }): ClientConnection[];
  /** Every recipient (see Recipient) of a purpose, optionally of one user. */
  recipients(filter?: { readonly userId?: UserId; readonly purpose?: ChannelPurpose }): Recipient[];
  isOnline(userId: UserId): boolean;
  onlineUserIds(): ReadonlySet<UserId>;
  /**
   * One d→c message to one recipient: a ClientConnection or a channelId. Interactive: sequenced on the logical
   * channel and kept until acknowledged, so it is replayed after a resume (sent even while disconnected); a volatile
   * type is sent now or not at all (see sendToChannels). Transfer: sent now or dropped. Refused (returns false,
   * logged) when the recipient's CURRENT role may not receive the type (registry `mayReceive`): fan-out fails closed.
   */
  send<T extends OutboundType>(target: ClientConnection | string, type: T, payload: PayloadInputOf<T>): boolean;
  /** To every recipient of `userId` (interactive: including disconnected logical channels that can still resume). */
  sendToUser<T extends OutboundType>(userId: UserId, type: T, payload: PayloadInputOf<T>, options?: { readonly purpose?: ChannelPurpose }): number;
  /** To every recipient allowed to receive `type` and passing `options`. Returns the number of recipients. */
  broadcast<T extends OutboundType>(type: T, payload: PayloadInputOf<T>, options?: BroadcastOptions<T>): number;
  /**
   * To the given logical channels (the watchers of a session), each checked like send(). `hostPayload`: what a channel
   * of the host gets instead. A VOLATILE type (registry `volatile`: session.delta) is never queued for a disconnected
   * channel, is skipped while the host socket has more than VOLATILE_SKIP_BUFFERED_BYTES buffered, and travels
   * unsequenced. Returns the number of channels it was sent to (or queued for).
   */
  sendToChannels<T extends OutboundType>(channelIds: Iterable<string>, type: T, payload: PayloadInputOf<T>, options?: { readonly hostPayload?: PayloadInputOf<T> }): number;
  /** channel.closed{reason} → close the channel → ask the relay to drop the socket (peer.kick). */
  close(target: ClientConnection | string, reason: ChannelClosedReason, message?: string): void;
  /** close() for every connection of a user and discard their logical channels (no resume after a kick). */
  closeUser(userId: UserId, reason: ChannelClosedReason, message?: string): number;
}

// =====================================================================================================================
// Lifecycle and the host's local control socket (ARCHITECTURE §7.1 run/<short>.ctl, §8)
// =====================================================================================================================

/**
 * A host-local client of the control socket (`smurg attach` on the host's own machine). There is no Noise and no
 * relay: the socket is 0600 inside the 0700 run dir, so the host's OS account is the credential. The same logical
 * channel (seq, outbox, resume), Router and fan-out as a relay client, with two differences (review F1: every session
 * runs as that OS account): the router accepts only what `smurg attach` sends (src/local/local-channel.ts
 * LOCAL_CHANNEL_TYPES), and every audit entry the connection causes (auth.connect / auth.disconnect with mode 'local'
 * included) carries `detail.via: 'control-socket'`.
 */
export interface LocalAttachInput {
  /** Must be the host (anything else is refused with `forbidden`). */
  readonly userId: UserId;
  readonly deviceName: string;
  /** Continue a logical channel after the local client reconnected (ClientHello.resume semantics). */
  readonly resume?: { readonly channelId: string; readonly lastSeq: number };
  /** One encoded daemon→client Envelope (msgpack): write it to the socket as one envelope frame. */
  send(bytes: Uint8Array): void;
  /** The daemon ended the connection (stop, protocol error): close the socket. */
  close(): void;
}

export interface LocalAttachment {
  readonly connection: ClientConnection;
  /** What a relay client receives in its verdict. Send it first, then call open(). */
  readonly welcome: Welcome;
  /** Starts delivering daemon messages through `send` (a resumed channel's replay first). */
  open(): void;
  /** One encoded client→daemon Envelope (msgpack) read from the socket. */
  receive(bytes: Uint8Array): void;
  /** The local socket closed. */
  end(): void;
}

/** Counters of the handshake responder (status, tests). */
export interface HandshakeStats {
  readonly handshakes: number;
  readonly accepted: number;
  readonly failed: number;
  /** HELLOs refused by the handshake budget (per user, global, in flight). */
  readonly refusedByRateLimit: number;
  /** Relay connections dropped after too many failed handshakes. */
  readonly kickedForFailures: number;
  /** Relay connections dropped because they never completed a handshake (or stayed after their channel ended). */
  readonly kickedIdle: number;
}

export interface DaemonStatus {
  readonly workspaceId: string;
  readonly started: boolean;
  readonly stopped: boolean;
  /** Per socket purpose: the relay link's state ('idle' | 'connecting' | 'online' | 'waiting' | 'replaced' | 'stopped'), or 'none'. */
  readonly relay: Readonly<Record<ChannelPurpose, string>>;
  readonly connections: number;
  readonly onlineMembers: number;
  readonly power: PowerStatus;
  readonly handshakes: HandshakeStats;
  /**
   * What the host's terminal no longer explains at the start (`smurg host` prints only the two links; `smurg status`
   * shows these, ARCHITECTURE §8): the daemon key's fingerprint as members compare it (Daemon.fingerprint), the relay,
   * the switch of §11 D-13 as the daemon runs with it, and whether the share is a git repository (worktrees need one).
   */
  readonly fingerprint: string;
  readonly relayUrl: string | null;
  readonly switches: { readonly attributeBashEdits: boolean };
  readonly isGitRepo: boolean;
  /**
   * What `smurg status` shows about agents (ARCHITECTURE §8); each is absent while its module is not there or has
   * nothing to say. `claude`: from the daemon's last check (absent: not checked yet).
   */
  readonly claude?: { readonly version: string | null; readonly verdict: 'verified' | 'unverified' | 'too-old' | 'unknown'; readonly login: LoginState };
  readonly agents?: { readonly running: number; readonly waiting: number; readonly stalled: number; readonly idle: number };
  readonly topics?: { readonly total: number; readonly paused: number };
  readonly projectSettings?: ProjectSettingsState;
  /** How many of the host's own Claude Code allow rules apply to agent sessions. */
  readonly hostRules?: { readonly count: number };
}

/**
 * What only the composition root can do, for the local control server module (`smurg stop`, `smurg status`, local
 * `smurg attach`). stop() also stops every module, the caller included: answer the client first, then call it
 * without awaiting it from inside the module.
 */
export interface DaemonLifecycle {
  stop(reason?: string): Promise<void>;
  status(): DaemonStatus;
  attachLocal(input: LocalAttachInput): LocalAttachment;
}

// =====================================================================================================================
// Router: decode → validate → capability → handler (ARCHITECTURE §2 rule 1)
// =====================================================================================================================

export interface RequestContext {
  readonly type: string;
  /** Envelope id of the request (responses echo it). */
  readonly requestId: string;
  readonly conn: ClientConnection;
  /** The caller, with their role as of THIS message (role changes apply immediately). */
  readonly principal: Principal;
  readonly userId: UserId;
  readonly role: Role;
  readonly member: MemberRecord;
  /**
   * Audits `authz.denied` (target = the message type unless given) and returns the error to throw. For ownership and
   * other resource-level refusals; capability refusals are the router's.
   */
  deny(reason: string, options?: { readonly target?: string; readonly detail?: Readonly<Record<string, unknown>>; readonly code?: 'forbidden' | 'host_only' }): Error;
  /** Throws an audited `forbidden` unless the caller is `ownerUserId`. */
  requireOwner(ownerUserId: UserId | null | undefined, what: string): void;
  /** Throws an audited `forbidden` unless the caller is `ownerUserId` or the host. */
  requireOwnerOrHost(ownerUserId: UserId | null | undefined, what: string): void;
  /** Runs after the `.ok` went out (e.g. doc.open → sync step 1; file.download.begin → first chunks). */
  afterReply(fn: () => void): void;
}

export type DaemonRequestHandler<T extends RequestType> = (
  payload: PayloadOf<T>,
  ctx: RequestContext,
) => ResultInputOf<T> | Promise<ResultInputOf<T>>;

/** One-way client messages (and both-way ones other than channel.ack, which the hub consumes). */
export type InboundNotifyType = NotifyType | Exclude<BidirectionalType, 'channel.ack'>;

/** A refusal is answered with `error` (same id) by the router when the handler throws. */
export type DaemonNotifyHandler<T extends InboundNotifyType> = (payload: PayloadOf<T>, ctx: RequestContext) => void | Promise<void>;

export interface Router {
  /** Registers the handler of a request type. Registering a type twice throws (one owner per type). */
  handle<T extends RequestType>(type: T, handler: DaemonRequestHandler<T>): Disposable;
  on<T extends InboundNotifyType>(type: T, handler: DaemonNotifyHandler<T>): Disposable;
  has(type: string): boolean;
  /** Entry point used by the hub for every decoded, de-duplicated client Envelope. */
  dispatch(conn: ClientConnection, envelope: ClientEnvelope): Promise<void>;
}

// =====================================================================================================================
// Roots and PathGuard (ARCHITECTURE §7.4)
// =====================================================================================================================

/** A read-only symlink the daemon created inside a worktree (D12). */
export interface SharedLink {
  /** Location of the symlink inside the worktree root. */
  readonly path: string;
  /** The shared directory it points to, relative to the main root. */
  readonly mainPath: string;
  /** realpath of that directory when the link was registered. */
  readonly targetRealPath: string;
}

export interface RootInfo {
  readonly ref: RootRef;
  /** rootRefKey(ref): 'main' | 'wt:<id>' */
  readonly key: string;
  /** realpath of the root directory when it was registered; re-checked on every resolve. */
  readonly realPath: string;
  /** Worktree owner (null for the main root). */
  readonly ownerUserId: UserId | null;
  readonly sharedLinks: readonly SharedLink[];
  readonly registeredAt: number;
  /**
   * The worktree of one work item of a topic. PathGuard then refuses EVERY write under `specs/<topicSlug>/` in this
   * root through file.*, doc.* and uploads (`read-only`): the copy of the spec and plan is what the agent was started
   * from, and the report file belongs to the agent.
   */
  readonly item?: { readonly topicId: string; readonly topicSlug: string; readonly itemId: string };
}

export interface RegisterWorktreeRootInput {
  readonly worktreeId: string;
  /** Must be `<share>/.smurg/worktrees/<worktreeId>` (checked with realpath). */
  readonly dir: string;
  readonly ownerUserId: UserId;
  /** Symlinks the WorktreeManager already created in `dir`, each pointing at `<main>/<mainPath>`. */
  readonly sharedLinks: readonly { readonly path: string; readonly mainPath: string }[];
  /** An item worktree (RootInfo.item). */
  readonly item?: { readonly topicId: string; readonly topicSlug: string; readonly itemId: string };
}

export interface RootRegistry {
  readonly main: RootInfo;
  /** realpath of `<share>/.smurg/worktrees` (where WorktreeManager creates worktrees). */
  readonly worktreesDir: string;
  get(ref: RootRef): RootInfo | null;
  list(): RootInfo[];
  /** Validates (realpaths, link targets inside the main root) and persists; PathGuard trusts only what is here. */
  registerWorktree(input: RegisterWorktreeRootInput): Promise<RootInfo>;
  /** Resolves once the listeners of the removal have finished (bounded): the root's watcher subscription is released. */
  unregisterWorktree(worktreeId: string): Promise<void>;
  /**
   * A listener may return a promise for a removal: unregisterWorktree waits for it (at most ROOT_REMOVED_WAIT_MS), so
   * whoever deletes the directory afterwards does so after the file watcher let go of it.
   */
  onChange(listener: (change: { readonly kind: 'added' | 'removed'; readonly root: RootInfo }) => void | Promise<void>): Disposable;
}

/** lstat facts of a checked object; compared again right before use (TOCTOU detection). */
export interface FileIdentity {
  readonly dev: number;
  readonly ino: number;
  readonly kind: 'file' | 'dir' | 'symlink' | 'other';
  readonly size: number;
  readonly mtimeMs: number;
  readonly mode: number;
  readonly nlink: number;
}

export interface ResolveOptions {
  /** Who is asking: host-only / hidden / hard-link rules and the audit entry of a denial. */
  readonly principal: Principal;
  /** The caller will create, modify, rename or delete at this path. Refuses read-only, host-only (non-host) paths. */
  readonly forWrite?: boolean;
  /**
   * With `forWrite`: the caller moves, removes or puts in place the WHOLE entry with everything below it (both ends of
   * a rename, a delete). A folder that holds a path this principal may not write is then refused like that path: the
   * folder above an item worktree's `specs/<slug>` (people: read-only), a folder with a script the trust gate
   * recorded or with a host-only name anywhere below it (non-host: host-only).
   */
  readonly subtree?: boolean;
  /** Refuse with not_found when nothing exists at the path. */
  readonly mustExist?: boolean;
  /** Accept `""` (the root itself). */
  readonly allowRoot?: boolean;
  /**
   * What to do when the final component is a symlink: 'follow' (default for reads; the target must stay inside the
   * root), 'self' (operate on the link itself: delete / rename / lstat), 'deny' (default for writes).
   */
  readonly finalSymlink?: 'follow' | 'self' | 'deny';
  /** Write the `path.denied` audit entry here (default true). */
  readonly audit?: boolean;
  /**
   * Linux (normalisation-sensitive file systems): the directory listings of ONE operation for the NFC → on-disk
   * mapping (workspace/fs-util.ts SpellingIndex). A zip download, a watcher batch and an upload plan each pass one, so a
   * directory is listed once per operation instead of once per missed name. Never kept across
   * operations: a listing is a snapshot.
   */
  readonly spellings?: SpellingLookup;
}

/** fs-util otherSpellings(dir, name), answered from one listing of `dir` per lookup object (ResolveOptions.spellings). */
export interface SpellingLookup {
  otherSpellings(dir: string, name: string): Promise<string[]>;
}

/**
 * A resolved request. `ref` is spelled as requested (NFC); `name`, `realPath` and `parentRealPath` are spelled the way
 * the file system stores them (native realpath: the stored case and Unicode normalisation of every existing component,
 * missing names as requested), so every read, write, rename and post-move check works on the on-disk spelling. On a
 * normalisation-sensitive file system (Linux) a missed NFC segment is mapped onto the ONE entry of its directory whose
 * NFC form equals it (ARCHITECTURE §7.4). Exception: when the final component is a followed symlink, `realPath` and
 * `parentRealPath` are the link's target and `name` is the requested last segment (the link's name).
 */
export interface ResolvedPath {
  /** The request, NFC-normalised. */
  readonly ref: FileRef;
  readonly root: RootInfo;
  /** Last path segment ('' for the root), in its on-disk spelling (see above). */
  readonly name: string;
  /**
   * Symlink-free absolute path of the target in its on-disk spelling (for a missing target: realpath of its parent +
   * the missing names as requested).
   */
  readonly realPath: string;
  /** Symlink-free absolute path of the directory holding the target, in its on-disk spelling. */
  readonly parentRealPath: string;
  readonly exists: boolean;
  /** lstat of `realPath` at resolution time (null when it does not exist). With finalSymlink 'self': of the link. */
  readonly identity: FileIdentity | null;
  /** Inside a shared read-only link, or under `specs/<slug>/` of an item worktree. */
  readonly readOnly: boolean;
  /** A host-only path (lexically, after resolution, or a file the trust gate records: ProjectTrust.protectedPaths). */
  readonly hostOnly: boolean;
  /** Reached through a registered shared link: the same object's FileRef in the main root. */
  readonly mainRef: FileRef | null;
}

/** An open, verified file (read-only). Always close it. */
export interface GuardedFile {
  readonly handle: FileHandle;
  readonly identity: FileIdentity;
  close(): Promise<void>;
}

export interface PathGuard {
  /** Lexical layer only (no fs): throws PathDeniedError('lexical' | 'too-long'); returns the NFC path. */
  lexical(path: unknown, options?: { readonly allowRoot?: boolean }): string;
  /** Resolve a FileRef or throw PathDeniedError (audited unless `audit: false`) / SmurgError not_found. */
  resolve(ref: FileRef, options: ResolveOptions): Promise<ResolvedPath>;
  /**
   * Absolute path (from a hook, the watcher, git) → FileRef in the most specific root that contains it, or null when
   * it is outside every root. Symlinks are resolved; a path through a shared link maps to the main root.
   */
  toFileRef(absPath: string): Promise<FileRef | null>;
  /** Resolve again and require the same object (dev, ino, kind) as before: call right before using a path. */
  revalidate(resolved: ResolvedPath, options: ResolveOptions): Promise<ResolvedPath>;
  /** Re-validates, opens with O_NOFOLLOW (+O_NONBLOCK), and checks fstat against the fresh lstat. Regular files only. */
  openRead(resolved: ResolvedPath, options: ResolveOptions): Promise<GuardedFile>;
  /** openRead + read up to `maxBytes` (default: whole file). */
  readFile(ref: FileRef, options: ResolveOptions & { readonly maxBytes?: number }): Promise<{ readonly bytes: Uint8Array; readonly identity: FileIdentity; readonly truncated: boolean }>;
  /**
   * Atomic write: `.<name>.smurg-<hex>.tmp` in the checked parent (wx, O_NOFOLLOW, mode of the file it replaces or
   * 0666 & ~umask), fsync, parent re-validated, rename (or link+unlink with `noClobber`), post-move check, dir fsync.
   * `expect`: the identity the caller last saw (null = must not exist); a mismatch is `conflict`.
   */
  writeFileAtomic(
    ref: FileRef,
    data: Uint8Array,
    options: ResolveOptions & { readonly noClobber?: boolean; readonly expect?: FileIdentity | null; readonly mode?: number },
  ): Promise<FileIdentity>;
  /**
   * Post-move check (ARCHITECTURE §7.4) for anything that moves a file into place outside writeFileAtomic (upload
   * commit, merges): the object at `resolved` must still be inside its root and be `placed` (same dev/ino). If it
   * landed outside, it is removed and PathDeniedError('outside-root') is thrown.
   */
  checkPlaced(resolved: ResolvedPath, placed: FileIdentity, options: ResolveOptions): Promise<void>;
}

// =====================================================================================================================
// Members, invites, settings, power (implemented by daemon-core)
// =====================================================================================================================

export interface MemberDirectory {
  /** Any status. */
  get(userId: UserId): MemberRecord | null;
  /** Active members only (the only ones with a role). */
  active(userId: UserId): MemberRecord | null;
  list(options?: { readonly includeKicked?: boolean }): MemberRecord[];
  roleOf(userId: UserId): Role | null;
  hostUserId(): UserId;
  /** Wire form with `online` from the hub. */
  toMember(record: MemberRecord): Member;
  toMemberWithDevices(record: MemberRecord): MemberWithDevices;
  /** Principal of an active member (role as of now), or null. */
  principalOf(userId: UserId): Principal | null;
  /**
   * Principal of an agent session whose daemon-internal owner is `ownerUserId`. `pathRights` (the session's, fixed at
   * its creation: AgentSessionFacts / HookSessionRegistration) decides host-only paths, NOT the owner's role: with
   * `'member'` the principal's role is never `host` (it is `agent` when the owner is the host, as after a handover),
   * so PathGuard, the lock path and every other consumer refuse host-only writes; with `'host'` it is the owner's
   * role. `agentName`: the session's agent name (HookSessionRegistration.agentName); default `Claude (<owner>)`.
   */
  agentPrincipal(sessionId: string, ownerUserId: UserId, options: { readonly agentName?: string; readonly pathRights: 'member' | 'host' }): Principal | null;
  /** The active members with their CURRENT roles: the input of routing.ts (deciderOf, reviewersOf, …). */
  routing(): RoutingMember[];
  /** `{ userId, displayName }` of a member (any status), or null. */
  userRef(userId: UserId): UserRef | null;
  device(deviceId: string): DeviceRecord | null;
  deviceByKey(publicKey: Uint8Array): DeviceRecord | null;
  devicesOf(userId: UserId): DeviceRecord[];
  /** Host only; host role cannot be changed. Closes the member's channels with `role-changed`; emits the event. */
  setRole(userId: UserId, role: GuestRole, by: Principal): Member;
  /** R2 kick: revoke every device, close channels (`kicked` + peer.kick), audit, emit member.kicked. */
  kick(userId: UserId, by: Principal): void;
  onChange(listener: (userId: UserId) => void): Disposable;
  // ---- used only by the channel server inside admit() (synchronous, in-memory authoritative) ----
  /** Creates or re-activates a member. Existing active members keep their role. */
  admitMember(input: { readonly userId: UserId; readonly displayName: string; readonly avatarUrl?: string; readonly role: Role; readonly at: number }): { readonly member: MemberRecord; readonly joined: boolean };
  addDevice(input: { readonly userId: UserId; readonly publicKey: Uint8Array; readonly name: string; readonly kind: ClientKind; readonly inviteId: string; readonly at: number }): DeviceRecord;
  touch(userId: UserId, deviceId: string, at: number): void;
}

export interface InviteService {
  /** Host only (router checks `admin`). The URL contains the secret: return it once, never log or audit it. */
  create(input: { readonly role: GuestRole; readonly expiresInSec?: number; readonly maxUses?: number }, by: Principal): { readonly invite: InviteInfo; readonly url: string };
  /** The host's own single-use invite, bound to the host's userId; revokes older unused host invites. */
  createHostInvite(): { readonly invite: InviteInfo; readonly url: string };
  list(): InviteInfo[];
  revoke(inviteId: string, by: Principal): void;
  get(inviteId: string): InviteRecord | null;
  byKeyId(keyId: Uint8Array): InviteRecord | null;
  /** Every invite on file, including expired / used-up / revoked ones (precise verdicts), for daemonAccept. */
  handshakeKeys(): DaemonInviteKey[];
  /** Why an invite cannot be used right now, or null. */
  unusableReason(record: InviteRecord, now: number): 'revoked' | 'expired' | 'used-up' | null;
  /** Synchronous check-and-consume (inside admit()); throws if unusable. */
  consume(inviteId: string, now: number): InviteRecord;
}

export interface SettingsService {
  get(): HostSettings;
  public(): PublicSettings;
  /**
   * Validated with the protocol schema plus the semantic rules (shared dirs must be existing, non-host-only
   * directories of the main root), persisted, audited `settings.change`, emits settings.changed.
   */
  update(patch: HostSettingsPatch, by: Principal): Promise<HostSettings>;
}

/** Why keep-awake is not active (PowerStatus.reason). Codes: the CLI words them in the host's language. */
export const POWER_REASONS = [
  'disabled', // switched off (--no-keep-awake)
  'not-started', // the daemon has not started it yet
  'stopped', // the daemon stopped it
  'unsupported-platform', // neither macOS nor Linux
  'systemd-inhibit-not-found', // Linux without systemd-inhibit
  'spawn-failed', // the inhibitor could not be spawned at all
  'start-failed', // it was spawned but did not start
  'exited', // it ended by itself later
  'refused', // the system refused the sleep block (polkit, e.g. over SSH)
] as const;
export type PowerReason = (typeof POWER_REASONS)[number];

export interface PowerStatus {
  readonly active: boolean;
  readonly mechanism: 'caffeinate' | 'systemd-inhibit' | 'none';
  readonly pid: number | null;
  /** Why it is not active; null while it is. */
  readonly reason: PowerReason | null;
}

/** Keeps the machine awake while hosting (R1), tied to the daemon's lifetime; releases on stop() or daemon death. */
export interface PowerService {
  start(): Promise<PowerStatus>;
  stop(): Promise<void>;
  status(): PowerStatus;
}

// =====================================================================================================================
// Feature services (implemented by the feature engineers; stubs until then)
// =====================================================================================================================

/** The validated payload a handler receives, and the `.ok` payload it returns. */
export type Req<T extends RequestType> = PayloadOf<T>;
export type Res<T extends RequestType> = ResultInputOf<T>;

/** file.* on the interactive channel (R1, R7) plus the watcher. Module: src/files/. */
export interface FileService {
  /** path-guard; entries hide temp files (isHiddenTempName) and, for non-hosts, `.smurg` in the main root. */
  tree(input: Req<'file.tree'>, principal: Principal): Promise<Res<'file.tree'>>;
  stat(ref: FileRef, principal: Principal): Promise<FileEntry>;
  /** path-guard forWrite (host-only for non-hosts). */
  create(input: Req<'file.create'>, principal: Principal): Promise<FileEntry>;
  /** path-guard forWrite on both ends; `locked` if either side has a lock. */
  rename(input: Req<'file.rename'>, principal: Principal): Promise<FileEntry>;
  delete(ref: FileRef, principal: Principal): Promise<void>;
  read(input: Req<'file.read'>, principal: Principal): Promise<Res<'file.read'>>;
  /** Refused with `locked` while the file has ANY lock (LockManager.get); `conflict` on ifMatchHash mismatch. */
  write(input: Req<'file.write'>, principal: Principal): Promise<Res<'file.write'>>;
  /** FileEntry of an existing file with lock / lastModifiedBy decorations, or null. */
  entryFor(ref: FileRef): Promise<FileEntry | null>;
  /**
   * Attributes the next watcher change of `ref` (within `ttlMs`, default 5 s) to `by`: doc autosave, upload commit,
   * merges, hook-reported agent edits. Also used as the tree badge (lastModifiedBy).
   */
  expectChange(ref: FileRef, by: Actor, ttlMs?: number): void;
  /** Who last changed the file (tree badge; R11 "recently modified by guests"). */
  lastModifiedBy(ref: FileRef): Actor | null;
}

/** Transfer channel uploads (R7, transfer.md §1.3–1.5). Module: src/files/upload.ts. */
export interface UploadService {
  plan(input: Req<'file.upload.plan'>, conn: ClientConnection, principal: Principal): Promise<Res<'file.upload.plan'>>;
  /** disk-check (excluding this upload from pendingBytes), path-guard forWrite, not-locked; binds the upload to `conn`. */
  begin(input: Req<'file.upload.begin'>, conn: ClientConnection, principal: Principal): Promise<Res<'file.upload.begin'>>;
  hashes(input: Req<'file.upload.hashes'>, conn: ClientConnection): Promise<Res<'file.upload.hashes'>>;
  /** Only from the connection that began / resumed the upload. */
  chunk(input: Req<'file.upload.chunk'>, conn: ClientConnection): Promise<Res<'file.upload.chunk'>>;
  commit(input: Req<'file.upload.commit'>, conn: ClientConnection, principal: Principal): Promise<Res<'file.upload.commit'>>;
  abort(input: Req<'file.upload.abort'>, conn: ClientConnection): Promise<void>;
  /** Kick: abort every upload of the user (partials deleted). */
  abortAllForUser(userId: UserId): Promise<void>;
  /** Bytes still to be written by active uploads (disk rule), optionally excluding one upload. */
  pendingBytes(options?: { readonly excludeUploadId?: string }): number;
  /** The disk check of ARCHITECTURE §5.2 for `requestedBytes` more bytes on the volume holding `ref`. */
  checkDisk(ref: FileRef, requestedBytes: number, options?: { readonly excludeUploadId?: string }): Promise<DiskReport>;
}

/** An accepted download: send `.ok`, then call start() (ctx.afterReply) to stream chunks with the ack window. */
export interface DownloadStart {
  readonly result: Res<'file.download.begin'>;
  start(): void;
}

/** Transfer channel downloads (R7). Module: src/files/download.ts. */
export interface DownloadService {
  begin(input: Req<'file.download.begin'>, conn: ClientConnection, principal: Principal): Promise<DownloadStart>;
  /** Grants credit (only from the downloading connection). */
  ack(input: PayloadOf<'file.download.ack'>, conn: ClientConnection): void;
  cancel(input: PayloadOf<'file.download.cancel'>, conn: ClientConnection): void;
  /** Transfer connections have no resume: downloads are per socket, keyed by ClientConnection.id. */
  cancelAllForConnection(connId: string): void;
}

/** doc.open accepted: send `.ok`, then call afterReply() (sync step 1 + awareness snapshot). */
export interface DocOpenStart {
  readonly result: Res<'doc.open'>;
  afterReply(): void;
}

/**
 * Yjs documents (R7, R8; ARCHITECTURE §7.5). Module: src/docs/.
 * Lock contract: on the first human update DocService calls LockManager.touchHuman(); when that returns
 * `acquired: true` it MUST capture `lockBase` = the disk text at that moment, and drop it when lock.changed reports
 * the human lock gone. While an agent lock is held (lock.changed), every replica is canEdit=false and a human update
 * is applied-then-reverted with doc.rejected to the sender.
 */
export interface DocService {
  open(file: FileRef, conn: ClientConnection, principal: Principal): Promise<DocOpenStart>;
  /** doc.sync from a client; content from members without file.write is dropped and audited (doc-content rule). */
  sync(input: PayloadOf<'doc.sync'>, conn: ClientConnection, principal: Principal): void;
  /** doc.awareness: decoded, validated (sanitizeAwarenessSelection), user field overwritten, re-encoded. */
  awareness(input: PayloadOf<'doc.awareness'>, conn: ClientConnection, principal: Principal): void;
  close(input: PayloadOf<'doc.close'>, conn: ClientConnection): void;
  /** Every subscription of a logical channel (channel.discarded); keyed by channelId so they survive a resume. */
  closeAllForChannel(channelId: string): void;
  isOpen(file: FileRef): boolean;
  /** lockBase of the current human lock on `file` (tests, reconcile), or null. */
  lockBase(file: FileRef): string | null;
  listConflicts(principal: Principal): ConflictRecord[];
  /**
   * doc.conflict.get: the record and the agent's full version (up to 5 MiB, read from the conflicts dir when it is no
   * longer cached). PathGuard read access to the file is checked again (audited when refused).
   */
  getConflict(conflictId: string, principal: Principal): Promise<Res<'doc.conflict.get'>>;
  resolveConflict(input: Req<'doc.conflict.resolve'>, principal: Principal): Promise<ConflictRecord>;
  /** Agent caret at the end of its last applied change (ARCHITECTURE §7.5 agent presence). */
  setAgentPresence(file: FileRef, agent: { readonly sessionId: string; readonly ownerUserId: UserId; readonly displayName: string; readonly color: string }, caretOffset: number | null): void;
  clearAgentPresence(sessionId: string): void;
  /** Write every dirty doc to disk (stop, before a merge). */
  flushAll(): Promise<void>;
}

export type HumanTouchResult =
  | { readonly ok: true; readonly lock: Extract<LockInfo, { kind: 'human' }>; readonly acquired: boolean }
  | { readonly ok: false; readonly lock: Extract<LockInfo, { kind: 'agent' }> };

export type AgentLockResult =
  | { readonly granted: true; readonly lock: Extract<LockInfo, { kind: 'agent' }> }
  /** `reason`: zh-TW text naming the holder, readable after Claude's "PreToolUse:Edit hook error:" prefix. */
  | { readonly granted: false; readonly holder: LockInfo | null; readonly reason: string };

/**
 * File locks (R8, D14). Module: src/locks/. Emits `lock.changed` on the bus for EVERY change (the module that owns
 * the handlers turns it into `lock.state` broadcasts). Humans share one lock per file; agents hold exclusive ones.
 */
export interface LockManager {
  get(file: FileRef): LockInfo | null;
  list(): LockInfo[];
  /** A human edited (first update takes the lock, later ones refresh it). Refused when an agent holds the file. */
  touchHuman(file: FileRef, holder: { readonly userId: UserId; readonly displayName: string }): HumanTouchResult;
  /** A holder leaves: closed the file, "Let the agent go first" (lock.release, checks the caller is a holder), disconnect. */
  leaveHuman(file: FileRef, userId: UserId, reason: 'closed' | 'yield' | 'disconnected'): void;
  /** Kick / leave: drop the user from every human lock. */
  leaveAllHuman(userId: UserId): void;
  /**
   * PreToolUse (hook). Granted only for files inside `sessionRoot`, capped per session, TTL = agentLockTimeoutMs.
   * A session's previous lock is released when it asks again. Denied when a human or another agent holds the file.
   */
  requestAgent(input: {
    readonly file: FileRef;
    readonly sessionId: string;
    readonly ownerUserId: UserId;
    readonly agentName: string;
    readonly sessionRoot: RootRef;
  }): AgentLockResult;
  /** PermissionRequest: the edit waits for the owner's approval (informational; the TTL still applies). */
  markAwaitingApproval(sessionId: string, file: FileRef): void;
  /** PostToolUse / PostToolUseFailure / PermissionDenied for one file (or the session's current lock). */
  releaseAgent(sessionId: string, file?: FileRef): void;
  /** UserPromptSubmit, Stop, SessionEnd, session exit, kick. */
  releaseAllForSession(sessionId: string, reason: 'prompt' | 'stop' | 'session-ended' | 'kicked'): void;
  /** lock.forceRelease (host). */
  forceRelease(file: FileRef, by: Principal): LockInfo | null;
  /** MCP `who_is_editing` / `lock_status`. */
  whoIsEditing(file: FileRef): { readonly humans: readonly { readonly userId: UserId; readonly displayName: string; readonly lastActivityAt: number }[]; readonly agent: Extract<LockInfo, { kind: 'agent' }> | null };
  /** MCP `wait_for_lock`: resolves with null once `file` has no lock, or with the lock still held at the timeout. */
  waitForRelease(file: FileRef, options: { readonly timeoutMs: number; readonly signal?: AbortSignal }): Promise<LockInfo | null>;
}

/** Presence (R7, R11). Module: src/locks/presence.ts. */
export interface PresenceService {
  snapshot(): PayloadInputOf<'presence.state'>;
  /** presence.update from a client (activeFile goes through PathGuard first). */
  update(conn: ClientConnection, activeFile: FileRef | null): void;
  setAgent(agent: PresenceAgent): void;
  removeAgent(sessionId: string): void;
}

/**
 * Activity feed (R8, R11). Module: src/locks/activity.ts. Persists activity.jsonl; broadcasts activity.event.
 *
 * Ownership (contract review C13): the activity module ALONE turns bus events into activity entries and the matching
 * audit entries; every other module only emits the events, so nothing is missing or doubled (R8.5, R11.2):
 *  - agent.tool.post (ok, with a file)            → kind 'agent.edit',     audit 'agent.edit'   (actor: the agent)
 *  - file.changed whose change has an agent `by`  → kind 'agent.edit',     audit 'agent.edit'   (not again if an
 *    agent.tool.post for the same session + file came within the attribution window)
 *  - file.changed without an agent `by`           → kind 'external.change', audit 'external.change'
 *  - doc.saved (debounced per file and human)     → kind 'human.edit',     audit 'doc.edit'
 *  - agent.tool.pre denied                        → kind 'lock.denied',    audit 'lock.denied'
 *  - doc.conflict (DocService calls record())     → kind 'conflict'  (DocService audits 'doc.conflict' itself)
 * file.create / rename / delete / upload entries come from FileService / UploadService through record() together
 * with their own audit entry (they know the actor directly).
 */
export interface ActivityFeed {
  /**
   * `via: 'bash'`: an agent.edit attributed through the agent's shell-command window (§11 D-13). `text`: the sentence
   * as a message reference (`activity.*` of `@smurg/protocol/i18n`, parameters already clipped); the feed stores it
   * with its English rendering as `summary`. `renamedFrom`: on a rename, the previous path, relative to `file.root`.
   * Every recorded entry is also emitted on the bus as `activity.recorded` (with `renamedFrom`).
   */
  record(input: {
    readonly actor: Actor;
    readonly kind: PayloadInputOf<'activity.event'>['event']['kind'];
    readonly file?: FileRef;
    readonly text: MessageRef;
    readonly via?: 'bash';
    readonly renamedFrom?: string;
  }): PayloadOf<'activity.event'>['event'];
  list(input: Req<'activity.list'>, principal: Principal): Promise<Res<'activity.list'>>;
  /** activity.notify to that member's connections only: MCP `notify_member` (`text`), or a daemon notice (`msg` + `fallback`). */
  notify(userId: UserId, notification: Omit<MemberNotification, 'id' | 'at'>): void;
}

export interface SessionAttachStart {
  readonly result: Res<'session.attach'>;
  /** Marks the viewer live after the `.ok` (no gap, no duplicate output). */
  afterReply(): void;
}

// =====================================================================================================================
// Rates (ARCHITECTURE §5.9 "Rates"): per-member token buckets. Implemented by daemon-core (core/rates.ts).
// =====================================================================================================================

/** The registry's buckets (taken by the Router per message type, `mention` by handlers) plus an agent's `notify_member`. */
export type RateBucketName = RateBucket | 'agent-notify';

export interface RateLimiter {
  /**
   * Takes `count` tokens (default 1) of `bucket` for `key`: a user id, or a session id for `agent-notify`. False when
   * the bucket does not hold that many (nothing is taken then). Buckets refill continuously to their per-minute size.
   */
  take(bucket: RateBucketName, key: string, count?: number): boolean;
  /** take(), or throws SmurgError `rate_limited`. */
  require(bucket: RateBucketName, key: string, count?: number): void;
}

// =====================================================================================================================
// Agent sessions: shared types (ARCHITECTURE §7.2). Daemon-internal; nothing here is on the wire as such.
// =====================================================================================================================

export type { CardRef, MessageOrigin, StalledBy };
/**
 * One message a turn took (`agent.turn.finished.messages`). `person`: `from` wrote it (for an accepted suggestion
 * its author, with `suggestionId`). `smurg`: `purpose`, and `by` when a member asked for it.
 */
export interface TurnMessage {
  readonly messageId: string;
  readonly kind: 'person' | 'smurg';
  readonly origin?: MessageOrigin;
  readonly from?: UserRef;
  readonly by?: UserRef;
  readonly purpose?: SmurgPurpose;
  readonly suggestionId?: string;
}
/** The rows of the tool gate that deny (ARCHITECTURE §7.7). */
export type GateRow = 'G2' | 'G3' | 'G4' | 'G5' | 'G6' | 'G7';
export type AttentionSource = 'topics' | 'sessions' | 'trust' | 'host-rules';

/**
 * What goes to an agent. The runner allocates the message id, appends the `message` / `smurg` event, and writes
 * header + text to the process (or queues it while there is no process).
 *  - `person`: `text` went through `agentText()` already (the runner applies it once more: it is idempotent);
 *    `cleaned` is what that reported. With `suggestion` the header says who accepted it.
 *  - `smurg`: `text` is built by topics/prompts.ts from fixed sentences; `by`: the member who asked, when one did.
 */
export type OutboundMessage =
  | {
      readonly kind: 'person';
      readonly from: Principal;
      readonly text: string;
      readonly cleaned: boolean;
      readonly origin: MessageOrigin;
      readonly mentions?: readonly UserId[];
      readonly suggestion?: { readonly id: string; readonly acceptedBy: UserRef; readonly modified: boolean };
    }
  | { readonly kind: 'smurg'; readonly purpose: SmurgPurpose; readonly text: string; readonly by?: UserRef };

/** What another module may append to a conversation (no `seq`, no `at`): lines, notices, card and pointer events. */
export type AppendableEvent = Extract<ConversationEventInput, { kind: 'line' | 'notice' | 'card' | 'pointer' }>;

/** One page of a conversation. `cardRefs`: the cards these events point to. `bytes`: encodedSize of `events`. */
export interface EventsPage {
  readonly events: ConversationEvent[];
  /** `seq` of the first event (0: the page is empty). */
  readonly firstSeq: number;
  /** `seq` the next live event will have. */
  readonly nextSeq: number;
  /**
   * Events exist before the first event of the page / after its last. For an EMPTY page: asked with `haveSeq` or
   * `afterSeq`, `hasEarlier` says events exist at or before it and `hasMore` is false; asked with `beforeSeq`,
   * `hasMore` says events exist at or after it and `hasEarlier` is false.
   */
  readonly hasEarlier: boolean;
  readonly hasMore: boolean;
  readonly cardRefs: CardRef[];
  readonly bytes: number;
}

export interface WatchStart extends EventsPage {
  readonly session: AgentSession;
  readonly streaming: StreamingBlock[];
  /** Marks the channel live after the `.ok` went out: no gap, no duplicate. */
  afterReply(): void;
}

/** The facts of an agent session other modules need. */
export interface AgentSessionFacts {
  readonly sessionId: string;
  readonly purpose: AgentPurpose;
  readonly topicId?: string;
  readonly itemId?: string;
  readonly attempt: number;
  readonly root: RootRef;
  readonly worktreeId?: string;
  readonly openedBy: UserRef;
  /** The daemon-internal owner: whose identity the agent's file locks use; starts as the opener, may pass to the host. */
  readonly ownerUserId: UserId;
  /** Fixed at creation; never raised by a handover. */
  readonly pathRights: 'member' | 'host';
  /** The opener / starter until cleared for good (routing.ts `deciderOf`). */
  readonly fallbackDecider: UserId | null;
  /** Who loosened the permission mode from its default, if anyone. */
  readonly modeChangedBy?: UserId;
  readonly hasProcess: boolean;
}

/**
 * A request an agent raised on its own pipe (`can_use_tool`). `id` is what answerQuestion / decidePermission take: the
 * RUNNER allocates it (Claude Code's own request id never leaves the runner), unique in the workspace across
 * sessions and across restarts of the daemon, so the conversation module may use it as the card's id.
 *
 * `question`: the runner GUARANTEES that `parts` passes `questionPartsSchema` (1 to 4 parts, each within the wire's
 * limits, their texts distinct). An AskUserQuestion that does not is refused by the runner itself with a fixed English
 * sentence asking the agent to word it differently: no bus event, no card. Nothing is ever clipped to make it pass
 * (the answer is keyed by the question texts and names the labels).
 *
 * `permission`: no Claude Code input shape has to be read outside the runner. `view` is the ToolView of THIS request's
 * input, the input an allow lets run (`verb`; `target`: the command, the URL, the path relative to the root; `file`;
 * `outside`; it is what the tool card of the same call shows unless a hook rewrote the input in between):
 * `permissionWhat(view)` gives `PermissionRequest.what`. `absPath`: the absolute path the
 * tool names, when it names one (the host's copy of an `outside` request, the host-only check). `edit`: what an edit
 * tool would write, normalised (absent for a tool that edits no file, and for an edit the runner cannot normalise,
 * e.g. NotebookEdit: the card then shows the whole input). `input`: Claude Code's raw input, for the whole-input card
 * (`PermissionRequest.input`, pretty-printed) only.
 */
export type AgentRequest =
  | { readonly id: string; readonly kind: 'question'; readonly toolUseId: string; readonly parts: Question['parts'] }
  | {
      readonly id: string;
      readonly kind: 'permission';
      readonly toolUseId: string;
      readonly tool: string;
      readonly view: ToolView;
      readonly absPath?: string;
      readonly edit?:
        | { readonly kind: 'replace'; readonly replacements: readonly { readonly oldText: string; readonly newText: string; readonly all: boolean }[] }
        | { readonly kind: 'write'; readonly text: string };
      readonly input: unknown;
      /** Claude Code's own English reason and its type (`safetyCheck`, …). */
      readonly reason?: string;
      readonly reasonType?: string;
      /** The absolute path Claude Code named as blocked, when it did. */
      readonly blockedPath?: string;
      /** The rule Claude Code suggests (`{ tool: 'Bash', pattern: 'pnpm test *' }`), when the request suggests exactly ONE (a compound command suggests one per sub-command: then none). Never echoed back as it came. */
      readonly suggestedRule?: { readonly tool: string; readonly pattern: string };
    };

/**
 * Work that stopped and has no card. `id` is stable: the inbox key is `attention:<subject>:<id>`. `recipients`: whose
 * inbox holds it. The inbox copies these fields into the item as they are (INBOX_KIND_FIELDS `attention`):
 *  - `item`: with `itemId`, the item's number and title (the row names the item from it);
 *  - `excerpt`: the topic's name for `plan-paused` and `discussion-lost`, '' otherwise; never a sentence;
 *  - `count`: the sessions an account problem stops; the items of a paused plan; the host's rules found;
 *  - `target`: the session or the plan for the item subjects and `plan-paused`, the topic's discussion session for
 *    `discussion-lost`, and for the host's subjects a section of the console (CONSOLE_SECTIONS): `account` and
 *    `storage` → `{ kind: 'console', section: 'sessions' }`, `project-settings` → `'claude-config'`, `host-rules` →
 *    `'host-rules'`.
 */
export interface AttentionFact {
  readonly subject: AttentionSubject;
  readonly id: string;
  readonly at: number;
  readonly recipients: readonly UserId[];
  readonly topicId?: string;
  readonly sessionId?: string;
  readonly itemId?: string;
  readonly item?: { readonly number: number; readonly title: string };
  readonly target: ColumnTarget;
  readonly count?: number;
  readonly excerpt: string;
}

/** Who calls an MCP tool: known from the session's token, never from an argument. */
export interface McpToolContext {
  readonly sessionId: string;
  readonly purpose: AgentPurpose;
  readonly topic?: { readonly id: string; readonly slug: string };
  readonly itemId?: string;
  readonly root: RootRef;
  readonly agent: Actor;
}

// =====================================================================================================================
// AgentSessions (module sessions/, P1): Claude Code in structured mode, one process per live session
// =====================================================================================================================

export interface AgentStartInput {
  readonly purpose: AgentPurpose;
  /** A topic's session: the topic. `name` becomes `AgentSession.topicName` (kept current with `setLabels`). */
  readonly topic?: { readonly id: string; readonly slug: string; readonly name: string };
  /** A work item's session: `number` and `title` become `AgentSession.item` (kept current with `setLabels`). */
  readonly item?: { readonly id: string; readonly number: number; readonly title: string; readonly attempt: number };
  /** The first owner and the fallback decider; `pathRights` is `host` when this is the host, else `member`. */
  readonly openedBy: Principal;
  readonly responsible: UserRef | null;
  /**
   * A title a PERSON typed (`session.create.title`); never passed for a topic's session. Without it a free session
   * with a `firstMessage` of a person gets `titleFromFirstMessage(text)`; any other session has no title and every
   * client names it with `sessionTitleRef(session)`.
   */
  readonly title?: string;
  /** The caller acquired the worktree. */
  readonly workspace: { readonly mode: 'main' } | { readonly mode: 'worktree'; readonly worktreeId: string };
  /** What the session starts with: `defaultPermissionMode(purpose, root)` unless the caller has a reason. */
  readonly mode: PermissionMode;
  /** Called once with the session's tag (and branch); the result is stored and used, byte for byte, at every process start. */
  rolePrompt(facts: { readonly smurgTag: string; readonly branch?: string }): string;
  /**
   * The system line that opens the conversation (its first event, before `firstMessage`), worded by the caller:
   * `conversation.started.free` (SessionManager.create), `conversation.started.discussion`,
   * `conversation.discussion.restarted`, `conversation.started.item`, `conversation.retry` (TopicService / PlanService).
   */
  readonly opening?: MessageRef;
  readonly firstMessage?: OutboundMessage;
}

/**
 * The agent runtime (ARCHITECTURE §7.6). WHO WRITES WHICH LINE AND AUDIT ENTRY is part of each method's contract
 * below, so no line is missing or written twice; the fakes append the same lines. The runner itself also writes, with
 * no caller: `conversation.interrupted.restart`, `session.resume.lost`, `session.projectSettings.untrusted`, and every
 * `notice.*` (among them the login notices after `agent.ready`).
 *
 * The agent's display name (locks, presence, the activity feed, the audit log) is
 * `agentDisplayName(agentSafeName(label))`, the label being the item's title, else the topic's name, else the
 * opener's display name; `setLabels` refreshes it.
 */
export interface AgentSessions {
  /**
   * Record, hook registration, launch files, process; then `opening` (a line) and `firstMessage`. Refuses: Claude
   * Code older than the floor (`session.claude.tooOld`), logged out (`session.claude.notLoggedIn`), and its OWN two
   * limits: `maxAgentSessions` (`session.limit.agents`) and `maxAgentProcesses` (`session.limit.processes`, after
   * parking the longest-idle session). It does NOT know the host setting `maxLiveAgents`: that one is the
   * scheduler's (PlanService), which counts the item sessions whose `facts().hasProcess` is true and starts an item
   * only below it. A person's message always gets a process. Emits session.created, agent.process `started`.
   */
  start(input: AgentStartInput): Promise<AgentSession>;
  get(sessionId: string): AgentSession | null;
  /** Agent sessions, oldest first: those of topics that are not archived and free sessions; with `topicId` every session of that topic. */
  list(filter?: { readonly topicId?: string }): AgentSession[];
  facts(sessionId: string): AgentSessionFacts | null;

  /**
   * Appends the `message` / `smurg` event (and its `delivery` events) and audits `session.message` (a person's, with
   * the full text) / `smurg.message`. Refused once the session ended (`conflict`, `session.ended.noMessages`, reason
   * `ended`). A `failed` or parked session is started by it (agent.process `started`). A line that explains a
   * `smurg` message (`conversation.specRequested`, …) is the caller's, appended before it.
   */
  send(sessionId: string, message: OutboundMessage): Promise<{ readonly messageId: string; readonly seq: number }>;
  /** Drops messages of that member that are still queued in the runner (no process yet): a `delivery` `cancelled` each. */
  cancelQueued(fromUserId: UserId): { readonly sessionId: string; readonly messageIds: readonly string[] }[];
  /** Sessions whose running turn holds a message of that member that Claude Code has not started yet. */
  holdingUndelivered(fromUserId: UserId): string[];
  /**
   * "Stop". By a person: the line `conversation.stopped`, audit `session.interrupt`; the turn ends `interrupted`
   * with `stoppedBy`, and the open requests are withdrawn with `by` (agent.request.withdrawn). By the system (a kick):
   * no line: the teardown writes `conversation.owner.handover.kicked`.
   */
  interrupt(sessionId: string, by: Actor): Promise<void>;
  /**
   * `failed` → starting (anything else: `conflict`, `session.retry.notFailed`, reason `not-failed`). Throws
   * `forbidden` `session.retry.hostOnly` (reason `host-only`) after three failed starts when `by` is not the host.
   * The line `conversation.retry.resumed`, audit `session.retry`.
   */
  retry(sessionId: string, by: Principal): Promise<AgentSession>;

  /**
   * Answers of the conversation module to requests it got through `agent.request`. `answers` maps each question text
   * to the chosen label(s) or the free text, `notes` each question text to the note the daemon composed. Throw
   * `conflict` when the request was withdrawn.
   */
  answerQuestion(sessionId: string, requestId: string, answer: { readonly answers: Readonly<Record<string, string>>; readonly notes: Readonly<Record<string, string>> }): void;
  /**
   * `sessionRule`: also remember this rule in the running process (destination `session`). `{ allow: false, message }`
   * refuses a request of EITHER kind (a question too: the agent reads `message` as the tool's refusal). Throws
   * `conflict` when the request was withdrawn.
   */
  decidePermission(
    sessionId: string,
    requestId: string,
    decision: { readonly allow: true; readonly sessionRule?: { readonly tool: string; readonly pattern: string } } | { readonly allow: false; readonly message: string },
  ): void;

  /**
   * By a person (`session.mode.set`): the line `conversation.mode.changed`, audit `session.mode`; remembers them as
   * `modeChangedBy` while the mode is not the default. By the system (ConversationService.memberRemoved putting it
   * back to `defaultPermissionMode`): the line `conversation.mode.reset` naming who had changed it; `modeChangedBy`
   * is cleared. Emits session.updated.
   */
  setMode(sessionId: string, mode: PermissionMode, by: Actor): Promise<void>;
  /**
   * Replaces the session's own remembered rules (a topic's rules are read from TopicService.rules at each process
   * start). For each rule that WENT: by a person the line `conversation.rule.removed` and audit `session.rule.remove`;
   * by the system `conversation.rule.removed.member`, naming who had added it; then the process restarts at its next
   * idle moment (as `restartProcess(…, 'rules')`). For a rule that was ADDED: nothing: the caller (the conversation
   * module, on `allow-always`) writes `conversation.rule.added` / `.added.topic`. Emits session.updated (`ruleCount`).
   */
  setRules(sessionId: string, rules: readonly RememberedRule[], by: Actor): Promise<void>;
  /** The session's own remembered rules. */
  rules(sessionId: string): readonly RememberedRule[];
  /**
   * THE place the fact lives once a session exists. By a person (`session.responsible.set`, `plan.assign`): the line
   * `conversation.responsible.changed` / `.cleared`, audit `session.responsible`. By the system (the teardown): no
   * line: SessionManager.teardownUser writes `conversation.responsible.fallback`. Emits session.updated.
   */
  setResponsible(sessionId: string, responsible: UserRef | null, by: Actor): void;
  /**
   * Clears `fallbackDecider` wherever it is that member, for good. Returns the sessions it changed. No line. Emits bus
   * `session.updated` for each of them (the wire's session did not change, so nothing is sent to clients): an open
   * question's decider and the inbox follow at once.
   */
  clearFallbackDecider(userId: UserId): string[];
  /** Handover: the locks' identity changes; `pathRights` never does. No line (teardownUser writes it). */
  setOwner(sessionId: string, ownerUserId: UserId, by: Actor): void;
  /**
   * Topics tell an execution session what its item's state is; the wire status `done` / `stalled` derives from it.
   * `stalled`: all four causes travel to the wire (`WorkItem.stalledBy`).
   */
  setItemState(sessionId: string, state: { readonly reportRegistered: boolean; readonly stalled?: StalledBy }): void;
  /** `AgentSession.title` by `session.rename` only (a person's words). No line. Emits session.updated. */
  setTitle(sessionId: string, title: string, by: Actor): void;
  /**
   * `AgentSession.topicName` and `AgentSession.item` (what clients name a topic's session with), and the agent's
   * display name with them. TopicService calls it for every session of a renamed topic; PlanService when a re-parse
   * changed an item's number or title. No line. Emits session.updated.
   */
  setLabels(sessionId: string, labels: { readonly topicName?: string; readonly item?: { readonly number: number; readonly title: string } }): void;

  /**
   * Ends the session for good. By a person: the line `conversation.ended`. Open requests are withdrawn (`ended`, with
   * `by`); agent.process `ended`; session.exited. It audits nothing: SessionManager.end / terminate audit
   * `session.end` / `session.terminate`, and a module that ends sessions itself has its own entry (`topic.archive`,
   * `topic.discussion.restart`, a merge). `keepWorktree` matters for a FREE session only (`false`: its worktree goes
   * with it). The worktree of a work item is never released by its session's end: PlanService calls
   * `WorktreeManager.releaseItem` (merged and reviewed, or archived), so callers pass `true` for a topic's session.
   */
  end(sessionId: string, input: { readonly by: Actor; readonly reason: SessionEndReason; readonly keepWorktree: boolean }): Promise<void>;
  /**
   * Park now when idle, else at the next idle moment (never with an open request); the next message resumes with
   * fresh launch files. Why: `rules` (a remembered rule went), `project-settings` (the host decided about the root),
   * `host` (a host setting that shapes the launch changed: `agentMcp`), `asked` (`session.restart`: a member pressed
   * "Restart this session's agent now"; the handler audits `session.restart`), `slot` (the scheduler needs the
   * process slot of an idle item session). Writes the line `conversation.agent.restarting`, except for `slot`
   * (parking is invisible). Emits agent.process `parked` when the process is gone.
   */
  restartProcess(sessionId: string, reason: 'rules' | 'project-settings' | 'host' | 'asked' | 'slot'): Promise<void>;
  /** Interrupt and park every session of a root (its project settings changed); the notice `session.projectSettings.changed` in each. */
  parkRoot(root: RootRef, reason: 'project-settings-changed'): Promise<void>;

  /** Appends a line, a notice, a card or a pointer event; returns its `seq`. */
  append(sessionId: string, event: AppendableEvent): number;
  /** Replaces one event by the notice `conversation.redacted` under the same `seq`, on disk and for watchers (the admin handler audits `transcript.redact`). */
  redact(sessionId: string, seq: number, by: Principal): Promise<void>;
  /**
   * One page for `session.watch`: the events after `haveSeq`; the NEWEST page without `haveSeq` or when it is more than
   * EVENTS_CATCH_UP_MAX events behind.
   */
  watch(input: Req<'session.watch'>, conn: ClientConnection): Promise<WatchStart>;
  unwatch(sessionId: string, channelId: string): void;
  history(input: Req<'session.history'>): Promise<EventsPage>;
  /**
   * A card update to the session's watching channels. `hostPayload`: what the host gets instead (a request's `path`).
   * (`session.delta` is the runner's own: a delta the hub could not send to any channel is sent again with the next
   * one, from the same offset.)
   */
  toWatchers<T extends OutboundType>(sessionId: string, type: T, payload: PayloadInputOf<T>, hostPayload?: PayloadInputOf<T>): void;
  /** The user ids of the members whose channels watch the session right now. */
  watchers(sessionId: string): UserId[];
  /** A private directory of the session next to its transcript (the conversation module keeps cards.json there). */
  storageDir(sessionId: string): Promise<string>;
  /**
   * Removes the records and transcripts of sessions for good. Called by TopicService.delete AFTER it emitted
   * `topic.removed { topicId, sessionIds }`; nothing else calls it and the sessions module does not listen.
   */
  forget(sessionIds: readonly string[]): Promise<void>;

  /**
   * One account state per workspace. `sessions`: how many it stops. A change emits `account.changed` and
   * `attention.changed { source: 'sessions' }`, and the sessions module sends `session.host` to everyone.
   */
  account(): AccountInfo;
  /** Claude Code on the host as of the daemon's last check (`smurg status`); null: not checked yet. */
  claude(): NonNullable<DaemonStatus['claude']> | null;
  /** Subjects `account`, `storage` (both open the console's `sessions` section). */
  attention(): AttentionFact[];
}

/**
 * The trust gate for a root's project-level Claude Code settings (sessions/agent/project-settings.ts, P1). A change of
 * a root's state emits `trust.changed`; for the MAIN root the sessions module also sends `session.host` to everyone
 * (`HostState.mainProjectSettings`).
 */
export interface ProjectTrust {
  state(root: RootRef): ProjectSettingsState;
  /** For the session.create audit entry. */
  hashes(root: RootRef): { readonly path: string; readonly hash: string }[];
  /** One list-rule page of roots after `after` (`rootRefKey`). */
  describe(input: Req<'admin.claudeConfig.get'>): Promise<Res<'admin.claudeConfig.get'>>;
  /** Throws `conflict` claudeConfig.changed / `bad_request` claudeConfig.ackNeeded. Audits `claude-config.decide`. */
  decide(input: Req<'admin.claudeConfig.decide'>, by: Principal): Promise<void>;
  /** Root-relative paths that are host-only for writes while the root's content is trusted (the recorded scripts). */
  protectedPaths(root: RootRef): ReadonlySet<string>;
  /** Subject `project-settings`. */
  attention(): AttentionFact[];
}

/**
 * The host's own Claude Code allow rules (sessions/agent/host-rules.ts, P1). They APPLY to agent sessions (every
 * session runs as the host): smurg does not ask for what they already allow, and never mirrors them. The host is told
 * once which rules apply (information, no decision).
 */
export interface HostRules {
  /** `admin.hostRules.get`: the rules as agent sessions last reported them, masked. */
  view(): Res<'admin.hostRules.get'>;
  /** `admin.hostRules.seen`: the host has the list on screen; the `host-rules` attention item leaves. */
  markSeen(by: Principal): Promise<void>;
  /** The complete list as rule strings, masked (`session.rules.get` for members with session.drive); [] when none. */
  applied(): readonly string[];
  /** Subject `host-rules`: rules were found and the host has not seen them. */
  attention(): AttentionFact[];
}

// =====================================================================================================================
// Terminal sessions and the registry of both kinds (module sessions/, P1)
// =====================================================================================================================

/** What teardownUser did, for the `session.handover` audit entries the core writes. */
export interface UserTeardown {
  /** Terminals and free sessions that ended. */
  readonly ended: readonly string[];
  /** Topic sessions that passed to the host; `stopped`: its turn was interrupted and its open cards withdrawn (a kick). */
  readonly handedOver: readonly { readonly sessionId: string; readonly topicId: string; readonly stopped: boolean }[];
  /** Sessions whose responsible person or fallback decider was cleared. */
  readonly cleared: readonly string[];
}

/**
 * The registry of sessions of BOTH kinds (R4; ARCHITECTURE §7.6, §11 D-15). Module: src/sessions/. Every session runs
 * like the host's own (the host's OS user, unsandboxed, the host's environment and Claude Code login), whoever opened
 * it. Terminals are PTYs (attach / input / resize); agent sessions are conversations (AgentSessions).
 *
 * End of life:
 *  - session.end {keepWorktree: false} of a terminal or a FREE agent session is the ONLY path that removes the
 *    session's worktree with it. `keepWorktree` does not apply to a work item's session: its worktree is the item's,
 *    released only by PlanService (`WorktreeManager.releaseItem`: merged and reviewed, or archived); the registry
 *    passes `keepWorktree: true` to AgentSessions.end for every topic session whatever the request said;
 *  - a terminal's natural exit, session.end without keepWorktree, admin.session.terminate and stopAll() KEEP it;
 *  - stopAll() (`smurg stop`) ends every terminal and every agent PROCESS; agent session records stay (idle);
 *  - a disconnect keeps sessions (R4); what a kick, a leave and a demotion do is teardownUser.
 */
export interface SessionManager {
  /**
   * `session.create`: a terminal, or a free agent session (through AgentSessions.start with the opening line
   * `conversation.started.free`, the mode `defaultPermissionMode('free', root)` and the caller's `title`). The caller
   * is `openedBy`. Audits `session.create`.
   */
  create(input: Req<'session.create'>, conn: ClientConnection, principal: Principal): Promise<SessionInfo>;
  /**
   * Oldest first (by `createdAt`, then id). Without `topicId`: terminals; agent sessions of topics that are not
   * archived; free sessions. With it: every agent session of that topic, archived or not. Everything, unpaged: the
   * `session.list` handler applies THE list rule (`takeWithinBytes(…, LIST_REPLY_MAX_BYTES, { atLeastOne: true,
   * maxItems: LIST_MAX_ITEMS })`, `after`, `hasMore`).
   */
  list(filter?: { readonly topicId?: string }): SessionInfo[];
  /** Any session, also those of archived topics. */
  get(sessionId: string): SessionInfo | null;
  /** Terminals only (`bad_request` reason `not-a-terminal` otherwise). */
  attach(input: Req<'session.attach'>, conn: ClientConnection, principal: Principal): Promise<SessionAttachStart>;
  /** Viewers are keyed by the logical channel (conn.channelId), not the socket: an attach survives a resume. */
  detach(sessionId: string, channelId: string): void;
  /** `session.drive`, any terminal. */
  input(input: PayloadOf<'exec.input'>, conn: ClientConnection, principal: Principal): void;
  /** The member who opened the terminal only (resize policy `owner`). */
  resize(input: PayloadOf<'exec.resize'>, conn: ClientConnection, principal: Principal): void;
  /** routing.ts `mayEndSession`; a discussion: `session.end.discussion`. */
  end(input: Req<'session.end'>, principal: Principal): Promise<void>;
  /** admin.session.terminate: any session, audited `session.terminate`. */
  terminate(sessionId: string, by: Principal): Promise<void>;
  /**
   * A member was kicked, left, or lost a role (ARCHITECTURE §3 "When a member goes"). Decides per session:
   *  - their terminals and free sessions END (when `session.create` is gone: kicked, left, below Agent access);
   *  - their topic sessions pass to the host (AgentSessions.setOwner, HookServer.reassignSession, and for a work
   *    item's session WorktreeManager.setOwner of its worktree; the line `conversation.owner.handover`), STOPPED
   *    first when they were kicked (AgentSessions.interrupt by the system; the line `…handover.kicked`). `pathRights`
   *    is never raised;
   *  - after a kick or a demotion below Agent access every worktree they still own (kept by the sessions that just
   *    ended, or kept earlier) passes to the host (WorktreeManager.setOwner). After a LEAVE those stay theirs: the
   *    member keeps their role and comes back to them. `worktree.remove` is the host's, or the owner's while they
   *    may open sessions (WorktreeManager.remove checks the role itself, whatever the owner record says);
   *  - wherever they are the responsible person or the fallback decider that is cleared, for good (kicked, left,
   *    or now a Viewer): AgentSessions.setResponsible(null, system) / clearFallbackDecider, ONE line
   *    `conversation.responsible.fallback` per session, audit `responsible.fallback`.
   * The `session.handover` audit entries are the core's. Called by the core only (admin/teardown.ts), after
   * ConversationService.memberRemoved and TopicService.memberRemoved.
   */
  teardownUser(userId: UserId, change: MemberChange, to?: Role): Promise<UserTeardown>;
  /** Agent sessions: `claude auth status --json` in the session's environment. */
  loginStatus(sessionId: string, principal: Principal): Promise<LoginState>;
  /** Actor of the session's agent (`Claude (<label>)`), or null for terminals / unknown sessions. */
  agentActor(sessionId: string): Actor | null;
  /** stop(): end every terminal and every agent process (daemon shutdown, `smurg stop`). */
  stopAll(): Promise<void>;
}

/** How a member went (the bus events `member.kicked` / `member.left` / `member.role-changed`). */
export type MemberChange = 'kicked' | 'left' | 'role-changed';

// =====================================================================================================================
// Hook + MCP socket (module hooks/, P1; the MCP answers in hooks/mcp-tools.ts are P4's)
// =====================================================================================================================

export interface HookSessionRegistration {
  readonly sessionId: string;
  /** The session's daemon-internal owner (whose locks the agent's are). */
  readonly ownerUserId: UserId;
  /** `agentDisplayName(label)`. */
  readonly agentName: string;
  readonly root: RootRef;
  readonly purpose: AgentPurpose;
  readonly topic?: { readonly id: string; readonly slug: string };
  readonly itemId?: string;
  readonly pathRights: 'member' | 'host';
  /** The profile's `--tools` list: the gate refuses anything else that is not `mcp__smurg__*`. */
  readonly tools: readonly string[];
}

export interface HookSessionCredentials {
  readonly token: string;
  /** SMURG_HOOK_SOCKET, SMURG_SESSION_TOKEN, SMURG_SESSION_ID for the session's environment. */
  readonly env: Readonly<Record<string, string>>;
}

/** What the sessions module asks the hooks module to write for one process start (ARCHITECTURE §7.6 "Profiles"). */
export interface LaunchProfile {
  /** Claude Code's own mode. A session in the main workspace is never `acceptEdits`. */
  readonly mode: 'default' | 'acceptEdits';
  readonly tools: readonly string[];
  /** Rules for `permissions.allow` / `ask` / `deny`, one string per element (never parsed as a list). */
  readonly allow: readonly string[];
  readonly ask: readonly string[];
  readonly deny: readonly string[];
  /** `--strict-mcp-config`: only smurg's own MCP server exists. */
  readonly strictMcp: boolean;
  /** `user`: `--setting-sources user` (the root's project settings are not trusted). */
  readonly settingSources: 'all' | 'user';
  /** The exact bytes of role.md. */
  readonly rolePrompt: string;
}

/** The daemon-owned launch files of one agent session (ARCHITECTURE §7.6 "Launch"). */
export interface SessionLaunchFiles {
  /** `<stateDir>/sessions/<workspace key>/<hex(sessionId)>` (0700). */
  readonly dir: string;
  readonly settingsPath: string;
  readonly mcpConfigPath: string;
  readonly rolePromptPath: string;
  /** The profile flags; the sessions module checks them against its allow-list before the spawn (fail closed). */
  readonly claudeArgs: readonly string[];
}

/**
 * Hook + MCP socket (ARCHITECTURE §7.7). Module: src/hooks/. Everything on the socket is a claim: identity comes from
 * the per-session token, paths go through PathGuard.toFileRef + resolve, locks only inside the session root.
 */
export interface HookServer {
  readonly socketPath: string;
  registerSession(session: HookSessionRegistration): HookSessionCredentials;
  /** Handover: whose locks the agent's are. Never touches `pathRights`. */
  reassignSession(sessionId: string, ownerUserId: UserId): void;
  /** Revokes the token, aborts the session's waits, releases its locks and removes its launch files. */
  unregisterSession(sessionId: string): void;
  /**
   * The ONE writer of a registered session's settings.json (the tool gate for every tool, the other hooks, the
   * hardened settings, the profile's rules), mcp.json (smurg's own MCP server) and role.md. Derived data: rewritten at
   * every process start. Refuses (fail closed, `internal` with reason 'no-self-command') without
   * config.sessions.selfCommand.
   */
  writeSessionFiles(sessionId: string, launch: LaunchProfile): Promise<SessionLaunchFiles>;
  removeSessionFiles(sessionId: string): Promise<void>;
}

// =====================================================================================================================
// Conversation: messages, questions, permission requests (module conversation/, P2); suggestions (module suggest/, P2)
// =====================================================================================================================

/** What ARCHITECTURE §3 "When a member goes" removed for one member (the `session.handover` audit detail). */
export interface ConversationRemoval {
  /** The always-allowed kinds they added to sessions, as rule strings. */
  readonly rules: readonly string[];
  /** Sessions whose permission mode they had loosened and that are back at their default. */
  readonly modesReset: readonly string[];
  /** Votes removed from open questions. */
  readonly votes: number;
  /** Queued messages dropped. */
  readonly messages: number;
}

/**
 * Messages, questions and permission requests (ARCHITECTURE §5.9). On `agent.request` it makes a card (the `card`
 * event through AgentSessions.append, the entity to the watchers) or answers by itself. The lines it writes:
 * `conversation.submittedFor` and `conversation.rule.added` / `.added.topic`; everything about modes, removed rules
 * and who is responsible is written by AgentSessions (see there). At its start it withdraws the cards that are still
 * open in its own store (`restarted`): the runner announces no withdrawal for a restart of the daemon.
 */
export interface ConversationService {
  /** `session.message.send`. Mentions: see InboxService.addMention. */
  send(input: Req<'session.message.send'>, principal: Principal): Promise<{ readonly messageId: string }>;
  /**
   * A person's text for an agent session from another module (`topic.revise`, `report.followUp`): a message when the
   * principal holds session.drive, else a suggestion (through SuggestionService.create).
   *
   * The text that is stored, shown and sent is made HERE, before a message is sent or a suggestion is created: with
   * `target` (`topic.revise`) `composeRevise({ target, quote, text }, MESSAGE_TEXT_MAX_CHARS)`; without it
   * `agentTextWithin(text, MESSAGE_TEXT_MAX_CHARS)`. `blank` → `bad_request`; `too-long` → `too_large`. `quote` goes
   * only with `target`.
   */
  sendAs(
    principal: Principal,
    input: {
      readonly sessionId: string;
      readonly text: string;
      readonly origin: MessageOrigin;
      readonly mentions?: readonly UserId[];
      readonly target?: 'spec' | 'plan';
      readonly quote?: { readonly heading?: string; readonly text: string };
      readonly topicId?: string;
      readonly itemId?: string;
    },
  ): Promise<{ readonly messageId: string } | { readonly suggestion: Suggestion }>;

  /** Any member holding `discuss`, `options` or `other` alike (an "Other" vote is for people; the daemon never sends it). */
  vote(input: Req<'question.vote'>, principal: Principal): void;
  comment(input: Req<'question.comment'>, principal: Principal): { readonly commentId: string };
  /**
   * routing.ts `maySubmit`; `other` and `note` need session.drive. Records `onBehalfOf` (the decider) whenever the
   * submitter is someone else; writes the line `conversation.submittedFor` only when the question had escalated.
   * Answers the agent (AgentSessions.answerQuestion; the note composed with `questionTally` / `votersOf`). Audits
   * `question.submit`. A question that is no longer open: `settledError`.
   */
  submit(input: Req<'question.submit'>, principal: Principal): Promise<Question>;
  remind(input: Req<'question.remind'>, principal: Principal): void;
  seen(questionId: string, principal: Principal): void;
  /**
   * The first answer wins (afterwards: `settledError`). `allow-always`: session scope → AgentSessions.setRules and the
   * line `conversation.rule.added`; topic scope → TopicService.rememberRule and `conversation.rule.added.topic` (in
   * the session the card is in). Before allowing an edit: the lock again (`permission.fileBusy`). Audits
   * `permission.decide`.
   */
  decide(input: Req<'permission.decide'>, principal: Principal): Promise<PermissionRequest>;

  question(id: string): Question | null;
  /** `forHost`: with the absolute `path` of an `outside` request. */
  permission(id: string, forHost: boolean): PermissionRequest | null;
  openQuestions(): Question[];
  /** The host's copies. */
  openPermissions(): PermissionRequest[];
  /** Answered questions of a session, oldest first (the quotation of `restart-discussion`). */
  answeredQuestions(sessionId: string): Question[];
  /**
   * The question and permission cards `refs` name, plus (with `includeOpen`) every one of the session that is still
   * open, while they fit `budgetBytes` (encodedSize; with `atLeastOne` the first one always); the rest in `more`.
   */
  cards(
    sessionId: string,
    refs: readonly CardRef[],
    options: { readonly includeOpen: boolean; readonly budgetBytes: number; readonly forHost: boolean; readonly atLeastOne?: boolean },
  ): { readonly questions: Question[]; readonly permissions: PermissionRequest[]; readonly more: CardRef[]; readonly bytes: number };

  /**
   * What §3 removes for a member who was kicked, left or changed role: their votes; the rules they added
   * (AgentSessions.setRules by the system, which writes `conversation.rule.removed.member`); a mode they loosened
   * (AgentSessions.setMode to `defaultPermissionMode(purpose, root)` by the system, which writes
   * `conversation.mode.reset`); their queued messages (AgentSessions.cancelQueued); a kicked member's undelivered
   * message stops its turn. Returns it for the `session.handover` entry. Called by the core only.
   */
  memberRemoved(userId: UserId, change: MemberChange, to?: Role): ConversationRemoval;
}

/**
 * Suggestions (R6). Module: src/suggest/. Persists suggestions.json; emits suggestion.changed; audits every step with
 * the full text. A suggestion's text is the output of `agentText()`: what the card shows and what an accept sends.
 */
export interface SuggestionService {
  /**
   * Agent sessions only (`suggest.terminal`), the author's own included; at most 20 pending per author and session.
   * Appends the `card` event. `cleaned`: the caller (ConversationService.sendAs) already composed and cleaned the
   * text it passes, and something a reader cannot see was removed: the suggestion says so (`Suggestion.cleaned`).
   */
  create(input: Req<'suggest.create'> & { readonly origin?: MessageOrigin; readonly topicId?: string; readonly itemId?: string; readonly cleaned?: boolean }, principal: Principal): Promise<Suggestion>;
  /** Author, pending only. */
  edit(input: Req<'suggest.edit'>, principal: Principal): Promise<Suggestion>;
  withdraw(input: Req<'suggest.withdraw'>, principal: Principal): Promise<Suggestion>;
  /** `session.drive` (any session), pending only; then AgentSessions.send as a message of the author. Never a PTY. */
  accept(input: Req<'suggest.accept'>, principal: Principal): Promise<Suggestion>;
  reject(input: Req<'suggest.reject'>, principal: Principal): Promise<Suggestion>;
  /** One list-rule page (`takeListPage`), newest first, after `after` (the last suggestion's id). */
  list(input: Req<'suggest.list'>, principal: Principal): Res<'suggest.list'>;
  /** Like ConversationService.cards, for suggestion cards. */
  cards(
    sessionId: string,
    refs: readonly CardRef[],
    options: { readonly includeOpen: boolean; readonly budgetBytes: number; readonly atLeastOne?: boolean },
  ): { readonly suggestions: Suggestion[]; readonly more: CardRef[]; readonly bytes: number };
  /** Pending suggestions (the inbox, the host console). */
  pending(): Suggestion[];
}

// =====================================================================================================================
// Topics, plans, reports (module topics/, P4)
// =====================================================================================================================

/** What §3 removes for a member in the topics module (the `session.handover` audit detail). */
export interface TopicRemoval {
  /** The topic rules they added, as rule strings. */
  readonly rules: readonly string[];
  /** Armed items they started that had not started yet. */
  readonly disarmed: readonly { readonly topicId: string; readonly itemId: string }[];
}

export interface TopicService {
  /**
   * In this order: the topic is stored and announced WITHOUT `discussionSessionId` (`topic.changed`, previous null);
   * then the discussion session is started (AgentSessions.start with `topic: { id, slug, name }` and the opening line
   * `conversation.started.discussion`); then the topic is announced again with it. So a listener of `session.created`
   * always finds the session's topic.
   */
  create(input: Req<'topic.create'>, principal: Principal): Promise<{ readonly topic: Topic; readonly session: AgentSession }>;
  /** One list-rule page. */
  list(input: Req<'topic.list'>): Res<'topic.list'>;
  get(topicId: string): Topic | null;
  bySession(sessionId: string): Topic | null;
  /** Also AgentSessions.setLabels({ topicName }) for every session of the topic. */
  rename(input: Req<'topic.rename'>, principal: Principal): Promise<Topic>;
  /**
   * Archiving ends the topic's sessions (`archived`) and releases its item worktrees (WorktreeManager.releaseItem).
   * When `WorktreeManager.unmerged(topicId)` is not empty and the request does not say `deleteUnmerged`: refused with
   * `unmergedError` (`topic.archive.unmerged`), nothing changed; `false` keeps exactly those worktrees, `true`
   * removes them too.
   */
  archive(input: Req<'topic.archive'>, principal: Principal): Promise<Topic>;
  /**
   * Archived topics only. Emits `topic.removed { topicId, sessionIds }` FIRST, then `AgentSessions.forget(sessionIds)`
   * (records and transcripts), then its own records. Never files of the project.
   */
  delete(input: Req<'topic.delete'>, principal: Principal): Promise<void>;
  restartDiscussion(input: Req<'topic.discussion.restart'>, principal: Principal): Promise<{ readonly topic: Topic; readonly session: AgentSession }>;
  /** → ConversationService.sendAs to the discussion session (origin `revise`, with `target` and `quote`: sendAs composes the text). */
  revise(input: Req<'topic.revise'>, principal: Principal): Promise<{ readonly messageId: string } | { readonly suggestion: Suggestion }>;
  requestSpec(input: Req<'topic.spec.request'>, principal: Principal): Promise<void>;
  addRule(input: Req<'topic.rule.add'>, principal: Principal): Promise<Topic>;
  /** Also called by ConversationService for `allow-always` with scope 'topic'. */
  rememberRule(topicId: string, rule: { readonly tool: 'Bash' | 'WebFetch'; readonly pattern: string }, by: Principal): Promise<RememberedRule>;
  removeRule(input: Req<'topic.rule.remove'>, principal: Principal): Promise<Topic>;
  /** The rules a session of this topic starts with (the sessions module reads them at each process start). */
  rules(topicId: string): readonly RememberedRule[];
  /** §3 for a member who was kicked, left or changed role: their topic rules go, items they armed are disarmed, plan records that name them are cleared. Called by the core only. */
  memberRemoved(userId: UserId, change: MemberChange, to?: Role): TopicRemoval;
  /** Subjects item-stalled, item-failed, item-stopped, item-not-started, plan-paused, discussion-lost. */
  attention(): AttentionFact[];
}

export type FileCheck = { readonly ok: true } | { readonly ok: false; readonly errors: readonly { readonly line?: number; readonly message: string }[] };

/**
 * The plan and its scheduler. The host setting `maxLiveAgents` is ENFORCED HERE and nowhere else: `PlanInfo.slots`
 * counts the item sessions whose `AgentSessions.facts().hasProcess` is true (`inUse`), of `max`; a queued item starts
 * only below it. The scheduler runs again on `agent.process` (a slot was freed or taken), and may free a slot itself
 * with `AgentSessions.restartProcess(sessionId, 'slot')` for the longest-idle item session without an open request.
 * A session's start for an item passes `item: { id, number, title, attempt }` and `keepWorktree: true` at its end.
 */
export interface PlanService {
  get(topicId: string): PlanInfo | null;
  itemBySession(sessionId: string): { readonly topicId: string; readonly item: WorkItem } | null;
  generate(input: Req<'plan.generate'>, principal: Principal): Promise<void>;
  setMode(input: Req<'plan.mode.set'>, principal: Principal): Promise<PlanInfo>;
  /** Before the item has a session: the plan's own record. Afterwards: AgentSessions.setResponsible. */
  assign(input: Req<'plan.assign'>, principal: Principal): Promise<PlanInfo>;
  suggest(input: Req<'plan.suggest'>, principal: Principal): Promise<PlanInfo>;
  preflight(input: Req<'plan.preflight'>, principal: Principal): Promise<StartPreflight>;
  start(input: Req<'plan.start'>, principal: Principal): Promise<PlanInfo>;
  /**
   * `plan.changes`: SPEC.md and PLAN.md as they are now against the pinned content of the last Start (its blob ids),
   * or against HEAD before the first Start, through WorktreeManager.diffMainPaths (cut at PLAN_CHANGES_DIFF_MAX_BYTES).
   */
  changes(input: Req<'plan.changes'>, principal: Principal): Promise<Res<'plan.changes'>>;
  resume(input: Req<'plan.resume'>, principal: Principal): Promise<PlanInfo>;
  /** A failed item: AgentSessions.retry. A stopped item: a NEW session in the same worktree (opening line `conversation.retry`). */
  retryItem(input: Req<'plan.item.retry'>, principal: Principal): Promise<PlanInfo>;
  continueItem(input: Req<'plan.item.continue'>, principal: Principal): Promise<void>;
  /** → WorktreeManager.updateFromMain, then `resolve-conflict` to the item's session. */
  resolveItem(input: Req<'plan.item.resolve'>, principal: Principal): Promise<void>;
  /** MCP `check_plan` (the session is in `ctx`, never in an argument). Messages are fixed English for the model. */
  checkPlan(ctx: McpToolContext): { readonly ok: true; readonly items: number; readonly warnings: readonly string[] } | Extract<FileCheck, { ok: false }>;
  /** MCP `propose_split`. */
  recordSplit(ctx: McpToolContext, input: { readonly items: readonly { readonly id: string; readonly person: string }[]; readonly reason: string }): { readonly ok: true; readonly assigned: number; readonly unknownPeople: number };
}

export interface ReportService {
  get(topicId: string, itemId: string): ReportInfo | null;
  /** Reports whose state is 'to-review' or 'changed-after-review' (the inbox derives from this). */
  toReview(): { readonly topicId: string; readonly itemId: string; readonly report: ReportSummary }[];
  /** → ConversationService.sendAs to the item's session (origin `follow-up`). */
  followUp(input: Req<'report.followUp'>, principal: Principal): Promise<{ readonly messageId: string } | { readonly suggestion: Suggestion }>;
  /** → WorktreeManager.setReviewed. */
  review(input: Req<'report.review'>, principal: Principal): Promise<ReportSummary>;
  /** MCP `check_report`: validates the file in the caller's root; an ok answer records { sessionId, attempt, contentHash }. */
  checkReport(ctx: McpToolContext): FileCheck;
}

// =====================================================================================================================
// Inbox (module inbox/, P3): derived per member, never stored (except mentions, results and "seen" marks)
// =====================================================================================================================

export interface InboxService {
  /**
   * One list-rule page of the caller's inbox after `after`, in KEY order; an `after` that is no longer in the box
   * continues after where it was.
   */
  list(principal: Principal, input?: Req<'inbox.list'>): Res<'inbox.list'>;
  /**
   * A mention or a result is removed; any other item is marked read until its stamp moves on (a question when
   * everyone has voted, a report's new version, one more suggestion of the author, a merge request's status).
   */
  seen(principal: Principal, keys: readonly string[]): void;
  /** Mentions and results only (`inbox.notDismissable` otherwise). */
  dismiss(principal: Principal, key: string): void;
  /**
   * A stored mention (an inbox item of kind `mention`; `excerpt`: the text around the mention).
   *
   * The CALLER decides which ids count. That is the handler of a request that carries `mentions` (all of them end in
   * the conversation / suggest modules: `session.message.send`, `question.comment`, `suggest.create`, and
   * `topic.revise` / `report.followUp` through `sendAs`): an id is kept only when that member is active and the text
   * contains `@<their display name>`; any other id is DROPPED WITHOUT AN ERROR (the request succeeds, the stored
   * entity lists only the kept ids); one `mention` token per kept id (`ctx.rates`). `'full'`: the member has
   * INBOX_NOTES_PER_MEMBER_MAX unopened notes and this one was not stored: the request STILL SUCCEEDS and the caller
   * tells the sender with `ctx.services.activity.notify(senderUserId, { from: SYSTEM_ACTOR, msg:
   * msg('mention.inboxFull', { name }), fallback })`. The agent-facing `notify_member` (topics) calls this too and
   * tells the agent in the tool's own fixed English answer. The inbox itself never tells anyone.
   *
   * Never throws (nor does addResult): a note that is not valid for the wire is logged and not stored. A member who
   * is not active gets nothing (the answer is `'stored'`).
   */
  addMention(input: { readonly userId: UserId; readonly from: Actor; readonly target: ColumnTarget; readonly anchor?: { readonly cardId?: string; readonly seq?: number }; readonly excerpt: string }): 'stored' | 'full';
  /**
   * A stored result for the author of a suggestion that was rejected, or accepted after an edit (an inbox item of
   * kind `result`: `result` is `outcome`, `from` who decided, `anchor.cardId` the suggestion, `excerpt` its text).
   * One result is kept per suggestion; nothing is stored when the member's notes are full.
   */
  addResult(input: { readonly userId: UserId; readonly from: Actor; readonly suggestionId: string; readonly sessionId: string; readonly outcome: 'rejected' | 'accepted-edited'; readonly excerpt: string }): void;
  /** The items of one member right now (tests, the console). */
  itemsOf(userId: UserId): InboxItem[];
}

// =====================================================================================================================
// Worktrees and merge requests (module worktree/, P5)
// =====================================================================================================================

export interface WorktreeHandle {
  readonly worktree: WorktreeInfo;
  readonly root: RootInfo;
}

export type SnapshotResult =
  | {
      readonly ok: true;
      /** A request in the state `draft`. */
      readonly request: MergeRequest;
      readonly files: number;
      readonly additions: number;
      readonly deletions: number;
      /** Files a person also edited in the worktree (from `activity.recorded`). */
      readonly byHand: readonly { readonly path: string; readonly by: readonly UserRef[] }[];
    }
  | { readonly ok: false; readonly reason: 'host-only-paths' | 'spec-files' | 'conflict-markers'; readonly files: readonly string[] };

/**
 * Worktrees (R9, deviation D-2: `git clone --shared`). Module: src/worktree/. Registers every worktree with the
 * RootRegistry (with its shared read-only links) BEFORE any session or client uses it, and unregisters on removal.
 */
export interface WorktreeManager {
  list(): WorktreeInfo[];
  get(worktreeId: string): WorktreeInfo | null;
  /** session.create {mode:'worktree'}: a new worktree for the owner, or a kept one (`worktreeId`) the owner owns. */
  acquireForSession(input: { readonly owner: Principal; readonly sessionId: string; readonly worktreeId?: string }): Promise<WorktreeHandle>;
  /**
   * A terminal or FREE agent session ended: keep (R9 "ask whether to keep") or remove. Only session.end
   * {keepWorktree: false} passes keep=false. Never called for a work item's worktree (`itemId`): that one outlives its
   * sessions and is released by `releaseItem` alone; an item worktree given here is kept whatever `keep` says.
   */
  releaseFromSession(worktreeId: string, sessionId: string, options: { readonly keep: boolean }): Promise<void>;
  /** worktree-owner-or-host. */
  remove(worktreeId: string, principal: Principal): Promise<void>;
  /**
   * Any member with `worktree.merge.request` (host, Agent access), any worktree (§11 D-15). When the worktree's newest
   * draft already has the commit a fresh snapshot gives, that draft becomes `pending` (same id, `requestedBy` set);
   * otherwise commits the working tree (with `message`) onto its branch, fetches the commit into the main repository
   * as refs/smurg/merge/<requestId>, and records its id in MergeRequest.commit.
   */
  requestMerge(input: Req<'worktree.merge.request'>, principal: Principal): Promise<MergeRequest>;
  /** Every request, drafts included. */
  listMerges(principal: Principal): MergeRequest[];
  /** `file.read`. The whole diff of the request's commit, cut at MERGE_DIFF_MAX_BYTES; host-private files withheld from non-hosts; through `mask()`. */
  diff(input: Req<'worktree.merge.diff'>, principal: Principal): Promise<Res<'worktree.merge.diff'>>;
  /** `file.read`. One file of `diff().files` (refused for any other path; `git … -- <path>`). */
  fileDiff(input: Req<'worktree.merge.fileDiff'>, principal: Principal): Promise<Res<'worktree.merge.fileDiff'>>;
  /** A `pending` request, or a `draft` directly (it implies the request). */
  approve(input: Req<'worktree.merge.approve'>, principal: Principal): Promise<MergeRequest>;
  reject(input: Req<'worktree.merge.reject'>, principal: Principal): Promise<MergeRequest>;

  // ---- work items (daemon-internal: no wire request reaches these directly) ----
  /**
   * The item's own worktree on smurg/<slug>/<item id> at the main workspace's HEAD; a retry reuses it. Removes an
   * existing specs/<slug>/reports/<item id>.md. Registers the root with `item` (PathGuard: nobody writes
   * specs/<slug>/**). Item worktrees do not count toward the per-owner limit.
   */
  acquireForItem(input: { readonly topic: { readonly id: string; readonly slug: string }; readonly itemId: string; readonly owner: Principal }): Promise<WorktreeHandle>;
  /**
   * The first half of requestMerge, run by the daemon: stage, verify, commit, fetch into refs/smurg/merge/<id>, policy
   * check → a draft request (replacing the worktree's older draft), or the reason the policy refused. After
   * updateFromMain the commit has the main HEAD as its second parent.
   */
  snapshot(input: { readonly worktreeId: string; readonly message: string; readonly topicSlug?: string }): Promise<SnapshotResult>;
  /** Emits merge.changed. */
  setReviewed(requestId: string, reviewed: boolean): MergeRequest;
  /** The checkpoint commit in the main workspace: exactly `paths`, with trailers, as `as`. Serialized with merges. */
  commitMainPaths(input: { readonly paths: readonly string[]; readonly message: string; readonly trailers: readonly string[]; readonly as: Principal }): Promise<{
    readonly commit: string;
    /** false: nothing to commit, HEAD already holds this content. */
    readonly created: boolean;
    readonly branch: string;
    /** Blob ids of `paths` at the new HEAD. */
    readonly blobs: Readonly<Record<string, string>>;
  }>;
  /** Blob ids of files at the main workspace's HEAD (null: not in HEAD): the scheduler's pin check. */
  headBlobs(paths: readonly string[]): Promise<Record<string, string | null>>;
  /** `free`: worktrees left before `maxWorktrees`. */
  mainState(): Promise<{ readonly isRepo: boolean; readonly hasCommit: boolean; readonly gitOk: boolean; readonly branch: string | null; readonly busy: boolean; readonly free: number }>;
  /** After a merge conflict: snapshot, merge the main HEAD without committing, record the second parent and the conflicted files. */
  updateFromMain(worktreeId: string): Promise<{ readonly mergeParent: string; readonly conflicted: readonly string[] }>;
  /**
   * `plan.changes`: unified diffs of files of the MAIN workspace as they are in the working tree now, against the
   * blobs given per path (`null`: the file did not exist then), or against HEAD. Only the paths that differ are
   * returned; each diff is cut at `maxBytes` (`truncated`) and passes `mask()`. `[]` when the folder is not a git
   * repository. The hardened git runner; never a path outside `paths`.
   */
  diffMainPaths(input: { readonly paths: readonly string[]; readonly against: 'head' | Readonly<Record<string, string | null>>; readonly maxBytes: number }): Promise<
    { readonly path: string; readonly diff: string; readonly truncated: boolean }[]
  >;
  /**
   * The handover of a worktree (WorktreeInfo.ownerUserId / ownerName; emits worktree.changed): called by
   * SessionManager.teardownUser for a work item's worktree when the session in it passes to the host, and for every
   * other worktree a member who lost agent access still owns, so they no longer own (and may no longer remove) it.
   */
  setOwner(worktreeId: string, owner: Principal): Promise<void>;
  /**
   * Merged and reviewed, or archived: unregister the root, remove the clone. THE only way an item's worktree goes
   * (a session's end never releases it); called by PlanService / TopicService.
   */
  releaseItem(worktreeId: string): Promise<void>;
  /**
   * Item worktrees of a topic that hold changes that were never merged: a newest snapshot that is not merged, or
   * edits since it (the Archive confirmation: `unmergedError`).
   */
  unmerged(topicId: string): WorktreeInfo[];
}

/** Every feature service slot; unimplemented ones hold a stub that throws internal "not implemented: <name>". */
export interface FeatureServices {
  readonly files: FileService;
  readonly uploads: UploadService;
  readonly downloads: DownloadService;
  readonly docs: DocService;
  readonly locks: LockManager;
  readonly presence: PresenceService;
  readonly activity: ActivityFeed;
  readonly sessions: SessionManager;
  readonly agents: AgentSessions;
  readonly projectTrust: ProjectTrust;
  readonly hostRules: HostRules;
  readonly hooks: HookServer;
  readonly conversation: ConversationService;
  readonly suggestions: SuggestionService;
  readonly topics: TopicService;
  readonly plans: PlanService;
  readonly reports: ReportService;
  readonly inbox: InboxService;
  readonly worktrees: WorktreeManager;
}

export type FeatureServiceName = keyof FeatureServices;

export const FEATURE_SERVICE_NAMES: readonly FeatureServiceName[] = Object.freeze([
  'files',
  'uploads',
  'downloads',
  'docs',
  'locks',
  'presence',
  'activity',
  'sessions',
  'agents',
  'projectTrust',
  'hostRules',
  'hooks',
  'conversation',
  'suggestions',
  'topics',
  'plans',
  'reports',
  'inbox',
  'worktrees',
]);

/** Human-readable service names used in "not implemented: <service>". */
export const FEATURE_SERVICE_LABELS: Readonly<Record<FeatureServiceName, string>> = Object.freeze({
  files: 'FileService',
  uploads: 'UploadService',
  downloads: 'DownloadService',
  docs: 'DocService',
  locks: 'LockManager',
  presence: 'PresenceService',
  activity: 'ActivityFeed',
  sessions: 'SessionManager',
  agents: 'AgentSessions',
  projectTrust: 'ProjectTrust',
  hostRules: 'HostRules',
  hooks: 'HookServer',
  conversation: 'ConversationService',
  suggestions: 'SuggestionService',
  topics: 'TopicService',
  plans: 'PlanService',
  reports: 'ReportService',
  inbox: 'InboxService',
  worktrees: 'WorktreeManager',
});

/** What the daemon knows about its workspace (the Welcome's WorkspaceInfo plus host paths). */
export interface WorkspaceDescriptor {
  readonly info: WorkspaceInfo;
  /** realpath of the shared folder. */
  readonly shareRealPath: string;
  /** The daemon's static public key and its fingerprint (`k`) for display. */
  readonly daemonPublicKey: Uint8Array;
  readonly fingerprint: string;
}

/** Re-exported for modules that reference the reason type from the contract. */
export type { PathDeniedReason };
