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
  Actor,
  AuditAction,
  AuditEntry,
  BidirectionalType,
  CHANNEL_CLOSED_REASONS,
  Capability,
  ChannelPurpose,
  ClientEnvelope,
  ConflictRecord,
  DaemonInviteKey,
  DiskReport,
  EventType,
  FileEntry,
  FileRef,
  GuestRole,
  HandshakeMode,
  HostSettings,
  HostSettingsPatch,
  InviteInfo,
  LockInfo,
  LoginState,
  Member,
  MemberNotification,
  MemberWithDevices,
  MergeRequest,
  NotifyType,
  PayloadInputOf,
  PayloadOf,
  PresenceAgent,
  PublicSettings,
  RequestType,
  ResultInputOf,
  Role,
  RootRef,
  SessionEndReason,
  SessionInfo,
  Suggestion,
  Welcome,
  WorkspaceInfo,
  WorktreeInfo,
} from '@smurg/protocol';
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
 *  - an agent (hook / MCP socket): kind 'agent', userId/role of the session OWNER, actor 「Claude（owner）」;
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
   * `channel.leave` (R4). Membership and devices stay. The core runs SessionManager.killAllForUser + removeGuestDir
   * and UploadService.abortAllForUser for this event (the handler awaits them: R4, within 5 s); other listeners
   * release everything else they hold for the user (human locks, doc subscriptions, presence).
   */
  'member.left': { readonly userId: UserId; readonly by: Actor };
  /**
   * Kick (R2): devices are already revoked and channels closed when this fires. The core runs
   * SessionManager.killAllForUser + removeGuestDir and UploadService.abortAllForUser for this event (the console's
   * kick awaits them: R2, within 3 s); other listeners drop every other per-user resource (human locks, doc
   * subscriptions, presence, pending suggestions).
   */
  'member.kicked': { readonly userId: UserId; readonly by: Actor; readonly revokedDevices: readonly string[] };
  /**
   * Role changed without a kick. The member's channels were closed with `role-changed` (they reconnect with the new
   * role). When the new role may not own sessions any more, the core runs killAllForUser('role-changed') for it.
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
  'lock.changed': { readonly file: FileRef; readonly lock: LockInfo | null; readonly previous: LockInfo | null; readonly reason: LockChangeReason };
  'session.created': { readonly session: SessionInfo };
  /** Any change of SessionInfo other than creation and exit (attach count, login state, size). */
  'session.updated': { readonly session: SessionInfo };
  /** `reason` is also what SessionInfo.endReason carries to clients (WEB-12). */
  'session.exited': { readonly session: SessionInfo; readonly reason: SessionEndReason };
  'suggestion.changed': { readonly suggestion: Suggestion; readonly previous: Suggestion | null };
  /** `worktree` null ⇒ removed. */
  'worktree.changed': { readonly worktreeId: string; readonly worktree: WorktreeInfo | null };
  'merge.changed': { readonly request: MergeRequest };
  /** stop() began: finish or abort work; channels are closed right after the listeners ran. */
  'daemon.stopping': { readonly reason: string };
  /**
   * A state document could not be written (ok: false; the store keeps retrying) or was written again after failing
   * (ok: true). Changes made meanwhile are in force but would be lost by a restart: tell the host (review REL-14).
   */
  'state.write': { readonly document: string; readonly ok: boolean };
  /**
   * The relay link of one socket purpose changed state (reviews CLI-10, REL-08): 'online', 'waiting' (dropped or
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
   * Top-level `detail` keys whose string values are kept whole up to SUGGESTION_TEXT_MAX_CHARS instead of being cut
   * at 2,000 characters: the suggestion module lists `text` and `finalText` so R6.3 logs the content that reached the
   * PTY. Never list a key that can carry file contents or secrets (the key-based redaction still applies first:
   * `content`, `data`, `diff`, … are replaced whatever this says).
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
  flush(): Promise<void>;
}

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

export interface BroadcastOptions {
  /** Default 'interactive'. */
  readonly purpose?: ChannelPurpose;
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
   * channel and kept until acknowledged, so it is replayed after a resume (sent even while disconnected). Transfer:
   * sent now or dropped. Refused (returns false, logged) when the recipient's CURRENT role may not receive the type
   * (registry `mayReceive`): fan-out fails closed.
   */
  send<T extends OutboundType>(target: ClientConnection | string, type: T, payload: PayloadInputOf<T>): boolean;
  /** To every recipient of `userId` (interactive: including disconnected logical channels that can still resume). */
  sendToUser<T extends OutboundType>(userId: UserId, type: T, payload: PayloadInputOf<T>, options?: { readonly purpose?: ChannelPurpose }): number;
  /** To every recipient allowed to receive `type` and passing `options`. Returns the number of recipients. */
  broadcast<T extends OutboundType>(type: T, payload: PayloadInputOf<T>, options?: BroadcastOptions): number;
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
 * relay: the socket is 0600 inside the 0700 run dir, so the host's OS account is the credential. Everything else is
 * the same as for a relay client: the same logical channel (seq, outbox, resume), Router, audit (auth.connect /
 * auth.disconnect with mode 'local') and fan-out.
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
}

export interface RegisterWorktreeRootInput {
  readonly worktreeId: string;
  /** Must be `<share>/.smurg/worktrees/<worktreeId>` (checked with realpath). */
  readonly dir: string;
  readonly ownerUserId: UserId;
  /** Symlinks the WorktreeManager already created in `dir`, each pointing at `<main>/<mainPath>`. */
  readonly sharedLinks: readonly { readonly path: string; readonly mainPath: string }[];
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
}

export interface ResolvedPath {
  /** The request, NFC-normalised. */
  readonly ref: FileRef;
  readonly root: RootInfo;
  /** Last path segment ('' for the root). */
  readonly name: string;
  /** Symlink-free absolute path of the target (for a missing target: realpath of its parent + name). */
  readonly realPath: string;
  /** Symlink-free absolute path of the directory holding the target. */
  readonly parentRealPath: string;
  readonly exists: boolean;
  /** lstat of `realPath` at resolution time (null when it does not exist). With finalSymlink 'self': of the link. */
  readonly identity: FileIdentity | null;
  /** Inside a shared read-only link. */
  readonly readOnly: boolean;
  /** A host-only path (lexically or after resolution). */
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
  /** Principal of an agent session owned by `ownerUserId` (actor 「Claude（owner）」). */
  agentPrincipal(sessionId: string, ownerUserId: UserId): Principal | null;
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

export interface PowerStatus {
  readonly active: boolean;
  readonly mechanism: 'caffeinate' | 'systemd-inhibit' | 'none';
  readonly pid: number | null;
  /** Why it is not active (unsupported platform, spawn failure). */
  readonly reason: string | null;
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

type Req<T extends RequestType> = PayloadOf<T>;
type Res<T extends RequestType> = ResultInputOf<T>;

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
  /** A holder leaves: closed the file, 「讓 agent 先改」 (lock.release, checks the caller is a holder), disconnect. */
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
  /** `via: 'bash'`: an agent.edit attributed through the agent's shell-command window (§11 D-13). */
  record(input: { readonly actor: Actor; readonly kind: PayloadInputOf<'activity.event'>['event']['kind']; readonly file?: FileRef; readonly summary: string; readonly via?: 'bash' }): PayloadOf<'activity.event'>['event'];
  list(input: Req<'activity.list'>, principal: Principal): Promise<Res<'activity.list'>>;
  /** MCP `notify_member`: activity.notify to that member's connections only. */
  notify(userId: UserId, notification: Omit<MemberNotification, 'id' | 'at'>): void;
}

export interface SessionAttachStart {
  readonly result: Res<'session.attach'>;
  /** Marks the viewer live after the `.ok` (no gap, no duplicate output). */
  afterReply(): void;
}

/**
 * PTY sessions (R4; ARCHITECTURE §7.6). Module: src/sessions/. The core calls killAllForUser + removeGuestDir itself
 * on kick, leave and a demotion (and awaits them), so the session manager does not need to act on those events; it
 * listens to channel.discarded (detach viewers keyed by channelId) and daemon.stopping.
 *
 * Launch inputs come from ctx.config.sessions (hostHome, claudePath, claudeMinVersion, selfCommand, testGuestEnv) and
 * the hook socket path from ctx.config.runPaths.hook; nothing reads os.homedir() or process.env for them.
 *
 * End of life (contract review C17):
 *  - session.end {keepWorktree: false} is the ONLY path that removes the session's worktree with it;
 *  - a natural exit (/exit, crash), session.end without keepWorktree, admin.session.terminate, a kick and stopAll()
 *    all KEEP the worktree (WorktreeInfo.kept = true); the UI offers 「刪除 worktree」 through worktree.remove (R9.4);
 *  - stopAll() (`smurg stop`, ARCHITECTURE §8) ends every session AND runs removeGuestDir for every guest, so no guest
 *    credential stays on the host after a stop.
 *  - a disconnect keeps sessions and the guest dir (R4); an explicit channel.leave removes them (the core calls
 *    removeGuestDir). Retention (ARCHITECTURE §11 D-9): at start and daily, removeGuestDir for every member whose last
 *    connection (MemberRecord.lastSeenAt) is older than 7 days and who has no running session.
 */
export interface SessionManager {
  /** sandbox-by-role: the role decides (host → unsandboxed, runner → SandboxService); apiKey only when sandboxed. */
  create(input: Req<'session.create'>, conn: ClientConnection, principal: Principal): Promise<SessionInfo>;
  /**
   * Every agent / terminal session. Sessions of kind 'login' (a guest's Claude login, §11 D-12) are private to their
   * owner and left out here and in get(): no other module (suggestions, presence, the console) ever sees one.
   */
  list(): SessionInfo[];
  /** session.list for one member: list() plus that member's OWN login sessions. */
  listFor(userId: UserId | null): SessionInfo[];
  /** An agent / terminal session; null for a login session (see list()). */
  get(sessionId: string): SessionInfo | null;
  attach(input: Req<'session.attach'>, conn: ClientConnection, principal: Principal): Promise<SessionAttachStart>;
  /** Viewers are keyed by the logical channel (conn.channelId), not the socket: an attach survives a resume. */
  detach(sessionId: string, channelId: string): void;
  /** Owner only (throws AuthorizationError otherwise). */
  input(input: PayloadOf<'exec.input'>, conn: ClientConnection, principal: Principal): void;
  resize(input: PayloadOf<'exec.resize'>, conn: ClientConnection, principal: Principal): void;
  /** Owner only. */
  end(input: Req<'session.end'>, principal: Principal): Promise<void>;
  /** admin.session.terminate: any session, audited `session.terminate`. */
  terminate(sessionId: string, by: Principal): Promise<void>;
  killAllForUser(userId: UserId, reason: 'kicked' | 'left' | 'role-changed'): Promise<void>;
  /** Kill sessions, `rm -rf` the guest dir, best-effort `claude auth logout` (1 s), keychain cleanup. */
  removeGuestDir(userId: UserId): Promise<void>;
  loginStatus(sessionId: string, principal: Principal): Promise<LoginState>;
  importConfig(input: Req<'session.importConfig'>, principal: Principal): Promise<Res<'session.importConfig'>>;
  /**
   * The ONLY function that writes suggestion text into a PTY (R6): bracketed paste + Enter. Called by
   * SuggestionService.accept after the ownership check; there is no auto-accept path.
   */
  pasteSuggestion(sessionId: string, text: string, acceptedBy: Principal): void;
  /** Actor of the session's agent (「Claude（owner）」), or null for terminals / unknown sessions. */
  agentActor(sessionId: string): Actor | null;
  /** stop(): end every session and remove every guest dir (daemon shutdown, `smurg stop`). */
  stopAll(): Promise<void>;
}

export type SandboxPreflight =
  | { readonly ok: true; readonly platform: 'darwin' | 'linux' }
  | { readonly ok: false; readonly reason: string; readonly detail?: string };

/**
 * What one guest process may touch (ARCHITECTURE §7.6). The wrapper builds srt's policy from it: broad denyRead
 * regions (config.sessions.hostHome, other users' homes, temp regions), then the allowRead / allowWrite carve-outs
 * below.
 *
 * Worktree mode (R9.1, contract review C7): `rootPath` is the worktree, and the policy MUST ALSO deny reading and
 * writing the main share and every sibling worktree, wherever the share lives (it may be outside every broad deny
 * region, e.g. /srv/proj): denyReadPaths and denyWritePaths contain `<share>` and `<share>/.smurg/worktrees`, with
 * allowRead carve-outs for the session's worktree, `<share>/.git` (read-only: shared-clone objects) and the shared
 * read-only dirs, and allowWrite only for the worktree and the guest dir. Main-workspace mode denies
 * `<share>/.smurg` for reading and writing. The host-only paths of ARCHITECTURE §5.2 are denyWrite in both modes,
 * and they must hold against every spelling a case-insensitive file system folds onto them (`.vſcode`, see
 * foldPathName in @smurg/protocol): verify srt/seatbelt matching with such a spelling before relying on it.
 */
export interface SandboxSpec {
  readonly sessionId: string;
  /** Shell command to run inside the sandbox (e.g. `exec claude --settings …`). */
  readonly command: string;
  /** Session root (main share or worktree dir): read + write. */
  readonly rootPath: string;
  /** The guest's private dir (HOME, CLAUDE_CONFIG_DIR, TMPDIR): read + write. */
  readonly guestDir: string;
  /** Daemon-owned settings dir of the session: read only. */
  readonly settingsDir: string;
  /** Shared read-only dirs (D12). */
  readonly readOnlyPaths: readonly string[];
  /** Extra read-only paths (the claude binary's directory). */
  readonly extraReadPaths: readonly string[];
  /**
   * Host-only paths (denyWrite), hidden ones (deny read+write, e.g. <share>/.smurg) and, in worktree mode, the main
   * share and the sibling worktrees (see above). Not only paths inside rootPath.
   */
  readonly denyWritePaths: readonly string[];
  readonly denyReadPaths: readonly string[];
  /** The hook socket (the only Unix socket reachable from inside). */
  readonly hookSocketPath: string;
  /** Clean allow-list environment (ARCHITECTURE §7.6), never the host's. */
  readonly env: Readonly<Record<string, string>>;
  /**
   * A guest's Claude LOGIN process (session kind 'login', ARCHITECTURE §7.6, §11 D-12): sandbox mode 'login'.
   * `rootPath` is then the guest's home inside `guestDir`; nothing of the share is readable, the env carries no hook
   * token, and the one extra right (bind + accept on loopback) is added by the profile hardening. Only the sessions
   * module's login launch sets it.
   */
  readonly loginProcess?: true;
  /**
   * With `loginProcess`: the only programs the process may exec besides the sandbox's shell (macOS exec allow-list):
   * the claude binary, the no-op BROWSER, /usr/bin/security. Absolute, existing files outside every guest-writable
   * or daemon-state path; an empty or missing list is refused.
   */
  readonly loginPrograms?: readonly string[];
}

export interface WrappedCommand {
  readonly file: string;
  readonly args: readonly string[];
  readonly env: Readonly<Record<string, string>>;
  readonly cwd: string;
}

/** srt wrapper for guest processes (R5; ARCHITECTURE §7.6). Module: src/sandbox/. Fails closed: no fallback. */
export interface SandboxService {
  /** Platform, dependencies, profile hardening and the canary self-test. */
  preflight(): Promise<SandboxPreflight>;
  /** Throws SmurgError('sandbox_unavailable') (and audits `sandbox.refused`) when anything is off. */
  wrap(spec: SandboxSpec): Promise<WrappedCommand>;
  /** settings.changed → allowedDomains. */
  setAllowedDomains(domains: readonly string[]): Promise<void>;
}

export interface HookSessionRegistration {
  readonly sessionId: string;
  readonly ownerUserId: UserId;
  /** 「Claude（owner）」 */
  readonly agentName: string;
  readonly root: RootRef;
  readonly sandboxed: boolean;
}

export interface HookSessionCredentials {
  readonly token: string;
  /** SMURG_HOOK_SOCKET, SMURG_SESSION_TOKEN, SMURG_SESSION_ID for the session's environment. */
  readonly env: Readonly<Record<string, string>>;
}

/** The daemon-owned launch files of one agent session (ARCHITECTURE §7.6 "Launch"). */
export interface SessionLaunchFiles {
  /** `<stateDir>/sessions/<workspace key>/<hex(sessionId)>` (0700): the sandbox's read-only SandboxSpec.settingsDir. */
  readonly dir: string;
  readonly settingsPath: string;
  readonly mcpConfigPath: string;
  /** `--settings <…> --mcp-config <…>` (+ `--strict-mcp-config` when sandboxed); never a permission flag. */
  readonly claudeArgs: readonly string[];
}

/**
 * Hook + MCP socket (ARCHITECTURE §7.7). Module: src/hooks/. Everything on the socket is a claim: identity comes from
 * the per-session token, paths go through PathGuard.toFileRef + resolve, locks only inside the session root.
 */
export interface HookServer {
  readonly socketPath: string;
  registerSession(session: HookSessionRegistration): HookSessionCredentials;
  /** Revokes the token, aborts the session's waits, releases its locks and removes its launch files. */
  unregisterSession(sessionId: string): void;
  /**
   * The ONE writer of a registered session's settings.json (hooks, kill-switch neutralizers, permissions) and mcp.json
   * (the coordination MCP server): the guest variant for sandboxed sessions, the host variant otherwise. Refuses
   * (fail closed, `internal` with reason 'no-self-command') without config.sessions.selfCommand.
   */
  writeSessionFiles(sessionId: string): Promise<SessionLaunchFiles>;
  removeSessionFiles(sessionId: string): Promise<void>;
}

/** Suggestions (R6). Module: src/suggest/. Persists suggestions.json; emits suggestion.changed; audits every step. */
export interface SuggestionService {
  /** target-session-not-own: the session must belong to someone else. */
  create(input: Req<'suggest.create'>, principal: Principal): Promise<Suggestion>;
  /** Author, pending only. */
  edit(input: Req<'suggest.edit'>, principal: Principal): Promise<Suggestion>;
  withdraw(input: Req<'suggest.withdraw'>, principal: Principal): Promise<Suggestion>;
  /** Session owner, pending only; then SessionManager.pasteSuggestion (the only path into a PTY). */
  accept(input: Req<'suggest.accept'>, principal: Principal): Promise<Suggestion>;
  reject(input: Req<'suggest.reject'>, principal: Principal): Promise<Suggestion>;
  list(input: Req<'suggest.list'>, principal: Principal): Suggestion[];
  /** Pending suggestions (host console). */
  pending(): Suggestion[];
}

export interface WorktreeHandle {
  readonly worktree: WorktreeInfo;
  readonly root: RootInfo;
}

/**
 * Worktrees (R9, deviation D-2: `git clone --shared`). Module: src/worktree/. Registers every worktree with the
 * RootRegistry (with its shared read-only links) BEFORE any session or client uses it, and unregisters on removal.
 */
export interface WorktreeManager {
  list(): WorktreeInfo[];
  get(worktreeId: string): WorktreeInfo | null;
  /** session.create {mode:'worktree'}: a new worktree for the owner, or a kept one (`worktreeId`) the owner owns. */
  acquireForSession(input: { readonly owner: Principal; readonly sessionId: string; readonly worktreeId?: string }): Promise<WorktreeHandle>;
  /** Session ended: keep (R9 "ask whether to keep") or remove. Only session.end {keepWorktree: false} passes keep=false. */
  releaseFromSession(worktreeId: string, sessionId: string, options: { readonly keep: boolean }): Promise<void>;
  /** worktree-owner-or-host. */
  remove(worktreeId: string, principal: Principal): Promise<void>;
  /**
   * worktree-owner. Commits the worktree's working tree (as the owner, with `message`; nothing to commit is fine) onto
   * smurg/<owner>/<id>, fetches that commit into the main repository as refs/smurg/merge/<requestId>, and records its
   * id in MergeRequest.commit. diff / fileDiff / approve work on exactly that commit (contract review C6).
   */
  requestMerge(input: Req<'worktree.merge.request'>, principal: Principal): Promise<MergeRequest>;
  listMerges(principal: Principal): MergeRequest[];
  /** merge-request-owner-or-host. The whole diff of the request's commit, cut at MERGE_DIFF_MAX_BYTES (`truncated`). */
  diff(input: Req<'worktree.merge.diff'>, principal: Principal): Promise<Res<'worktree.merge.diff'>>;
  /** merge-request-owner-or-host. One file of `diff().files` (refused for any other path; `git … -- <path>`). */
  fileDiff(input: Req<'worktree.merge.fileDiff'>, principal: Principal): Promise<Res<'worktree.merge.fileDiff'>>;
  approve(input: Req<'worktree.merge.approve'>, principal: Principal): Promise<MergeRequest>;
  reject(input: Req<'worktree.merge.reject'>, principal: Principal): Promise<MergeRequest>;
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
  readonly sandbox: SandboxService;
  readonly hooks: HookServer;
  readonly suggestions: SuggestionService;
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
  'sandbox',
  'hooks',
  'suggestions',
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
  sandbox: 'SandboxService',
  hooks: 'HookServer',
  suggestions: 'SuggestionService',
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
