import type { z } from 'zod';
import { errorPayloadSchema } from '../errors.ts';
import { can, type Capability, type Role } from '../roles.ts';
import * as admin from './messages/admin.ts';
import * as channel from './messages/channel.ts';
import * as docs from './messages/docs.ts';
import * as files from './messages/files.ts';
import * as presence from './messages/presence.ts';
import * as sessions from './messages/sessions.ts';
import * as suggestions from './messages/suggestions.ts';
import * as transfer from './messages/transfer.ts';
import * as worktrees from './messages/worktrees.ts';

// THE message catalog (ARCHITECTURE §5): one entry per message type, and the only place that says, for each type,
// which way it flows, what its payload (and, for requests, its result) looks like, who may send or receive it, which
// socket carries it and whether it may ever be logged. Router, codec, client SDK and tests all read this table.
//
// Conventions (ARCHITECTURE §4.3):
//  - A request `X` (dir c2d, `result` ≠ null) is answered by `X.ok` (payload = `result`) or by `error`, same `id`.
//  - A one-way c2d message (`result` = null: doc.sync, exec.input, file.download.ack, …) gets no `.ok`; if the daemon
//    refuses it, it answers `error` with the same `id`.
//  - d2c events use a fresh `id`.

export type MessageDirection = 'c2d' | 'd2c' | 'both';
export type MessageChannel = 'interactive' | 'transfer' | 'both';

/**
 * What the Router checks before a handler runs (for d2c events: what a recipient must have).
 *  - a Capability, or a list meaning "any of them" (session.create: host → .host, runner → .sandboxed);
 *  - 'none': any admitted member;
 *  - 'owner-checked-in-handler': no capability applies; the handler MUST perform the ownership checks listed in
 *    `checks` (e.g. exec.input: caller owns the session).
 */
export type MessageAccess = Capability | readonly Capability[] | 'none' | 'owner-checked-in-handler';

/**
 * Resource-level checks a handler (or, for events, the fan-out) must perform in addition to `capability`. They are
 * part of the contract, so reviewers can tick them off per handler (ARCHITECTURE §2 rule 1, §3).
 */
export const HANDLER_CHECKS = [
  'path-guard', // every FileRef/path through PathGuard before any fs call (§7.4)
  'host-only-paths', // non-hosts may not write host-only paths (§5.2, isHostOnlyPath)
  'not-locked', // refused with `locked` while the file has any lock
  'disk-check', // R7 disk reserve before accepting bytes (DiskReport)
  'transfer-connection', // only the connection that began/resumed this upload/download
  'doc-subscriber', // only a connection that opened this docId
  'doc-content-needs-file.write', // content-carrying sync messages from members without file.write are dropped + audited
  'session-owner', // caller owns the session (host: admin.session.terminate instead)
  'sandbox-by-role', // the role decides sandboxed vs host session; the client never chooses
  'api-key-sandboxed-only', // session.create.apiKey only for sandboxed sessions
  'login-own-guest-only', // session.create kind 'login': the caller's own login, sandboxed roles only, fixed command (D-12)
  'own-guest-dir', // writes only into the caller's own guest config dir
  'target-session-not-own', // suggest.create: the target session belongs to someone else
  'suggestion-author-pending', // caller authored the suggestion and it is still pending
  'suggestion-session-owner', // caller owns the suggestion's session and it is still pending
  'worktree-owner', // caller owns the worktree
  'worktree-owner-or-host', // caller owns the worktree, or is the host
  'merge-request-owner-or-host', // caller owns the request's worktree, or is the host
  'human-lock-holder', // caller is one of the human lock's holders
  'recipients:all', // fan-out to every admitted member holding `capability`
  'recipients:self', // only the member (or connection) concerned
  'recipients:requester', // the connection that sent the request
  'recipients:host', // host connections only
  'recipients:doc-subscribers', // connections that opened the doc
  'recipients:attached-viewers', // connections attached to the session
  'recipients:suggestion-parties', // session owner, suggestion author and host
  'recipients:transfer-connection', // the transfer connection of that download
  'recipients:notified-member', // the connections of the member being notified
] as const;
export type HandlerCheck = (typeof HANDLER_CHECKS)[number];

export interface MessageSpec<
  P extends z.ZodType = z.ZodType,
  R extends z.ZodType | null = z.ZodType | null,
  D extends MessageDirection = MessageDirection,
> {
  readonly dir: D;
  readonly payload: P;
  /** Schema of the `.ok` payload; non-null exactly for c2d requests. */
  readonly result: R;
  readonly capability: MessageAccess;
  readonly checks: readonly HandlerCheck[];
  readonly channel: MessageChannel;
  /** The payload must never be written to logs or audit detail (file contents, terminal data, keys, secrets). */
  readonly sensitive: boolean;
  /** Same for the `.ok` payload of a request. */
  readonly resultSensitive: boolean;
  /** Object keys (at any depth) whose string values redactForLog hides; bytes are always reduced to their length. */
  readonly redact: readonly string[];
  /** Why this type is not in ARCHITECTURE §5 (null for catalog types); listed as a deviation. */
  readonly addition: string | null;
}

type SpecOptions = {
  readonly checks?: readonly HandlerCheck[];
  readonly channel?: MessageChannel;
  readonly sensitive?: boolean;
  readonly resultSensitive?: boolean;
  readonly redact?: readonly string[];
  readonly addition?: string;
};

function spec<P extends z.ZodType, R extends z.ZodType | null, D extends MessageDirection>(
  dir: D,
  payload: P,
  result: R,
  capability: MessageAccess,
  options: SpecOptions,
): MessageSpec<P, R, D> {
  return Object.freeze({
    dir,
    payload,
    result,
    capability: Array.isArray(capability) ? Object.freeze([...capability]) : capability,
    checks: Object.freeze([...(options.checks ?? [])]),
    channel: options.channel ?? 'interactive',
    sensitive: options.sensitive ?? false,
    resultSensitive: options.resultSensitive ?? false,
    redact: Object.freeze([...(options.redact ?? [])]),
    addition: options.addition ?? null,
  });
}

/** c→d request answered by `X.ok` or `error`. */
function request<P extends z.ZodType, R extends z.ZodType>(
  payload: P,
  result: R,
  capability: MessageAccess,
  options: SpecOptions = {},
): MessageSpec<P, R, 'c2d'> {
  return spec('c2d', payload, result, capability, options);
}

/** c→d one-way message (no `.ok`; a refusal is answered with `error`). */
function notify<P extends z.ZodType>(payload: P, capability: MessageAccess, options: SpecOptions = {}): MessageSpec<P, null, 'c2d'> {
  return spec('c2d', payload, null, capability, options);
}

/** d→c event; `recipients` is what a receiving member must hold. */
function event<P extends z.ZodType>(payload: P, recipients: MessageAccess, options: SpecOptions = {}): MessageSpec<P, null, 'd2c'> {
  return spec('d2c', payload, null, recipients, options);
}

/** One-way message that flows both ways. */
function both<P extends z.ZodType>(payload: P, capability: MessageAccess, options: SpecOptions = {}): MessageSpec<P, null, 'both'> {
  return spec('both', payload, null, capability, options);
}

const OWNER = 'owner-checked-in-handler';
const TRANSFER = 'transfer';

export const MESSAGE_REGISTRY = Object.freeze({
  // ---- channel.* (§5.1) --------------------------------------------------------------------------------------
  'channel.memberUpdated': event(channel.channelMemberUpdatedPayloadSchema, 'none', { checks: ['recipients:self'] }),
  'channel.settingsUpdated': event(channel.channelSettingsUpdatedPayloadSchema, 'none', {
    checks: ['recipients:all'],
    addition: 'PublicSettings reach clients only in the Welcome; after admin.settings.set connected clients kept stale values',
  }),
  'channel.closed': event(channel.channelClosedPayloadSchema, 'none', { channel: 'both', checks: ['recipients:self'] }),
  'channel.ack': both(channel.channelAckPayloadSchema, 'none'),
  'channel.leave': request(channel.channelLeavePayloadSchema, channel.channelLeaveResultSchema, 'none', {
    addition: 'SPEC R4: a guest who leaves is logged out and their temp dir deleted within 5 s; a disconnect must not do that',
  }),
  error: event(errorPayloadSchema, 'none', { channel: 'both', checks: ['recipients:requester'] }),

  // ---- file.* (§5.2, interactive) ------------------------------------------------------------------------------
  'file.tree': request(files.fileTreePayloadSchema, files.fileTreeResultSchema, 'file.read', { checks: ['path-guard'] }),
  'file.stat': request(files.fileStatPayloadSchema, files.fileStatResultSchema, 'file.read', { checks: ['path-guard'] }),
  'file.create': request(files.fileCreatePayloadSchema, files.fileCreateResultSchema, 'file.write', {
    checks: ['path-guard', 'host-only-paths'],
  }),
  'file.rename': request(files.fileRenamePayloadSchema, files.fileRenameResultSchema, 'file.write', {
    checks: ['path-guard', 'host-only-paths', 'not-locked'],
  }),
  'file.delete': request(files.fileDeletePayloadSchema, files.fileDeleteResultSchema, 'file.write', {
    checks: ['path-guard', 'host-only-paths', 'not-locked'],
  }),
  'file.read': request(files.fileReadPayloadSchema, files.fileReadResultSchema, 'file.read', {
    checks: ['path-guard'],
    resultSensitive: true,
  }),
  'file.write': request(files.fileWritePayloadSchema, files.fileWriteResultSchema, 'file.write', {
    checks: ['path-guard', 'host-only-paths', 'not-locked'],
    sensitive: true,
  }),
  'file.changed': event(files.fileChangedPayloadSchema, 'file.read', { checks: ['recipients:all'] }),

  // ---- file.upload.* / file.download.* (§5.2, transfer channel) --------------------------------------------------
  'file.upload.plan': request(transfer.fileUploadPlanPayloadSchema, transfer.fileUploadPlanResultSchema, 'file.write', {
    channel: TRANSFER,
    checks: ['path-guard', 'host-only-paths', 'disk-check'],
  }),
  'file.upload.begin': request(transfer.fileUploadBeginPayloadSchema, transfer.fileUploadBeginResultSchema, 'file.write', {
    channel: TRANSFER,
    checks: ['path-guard', 'host-only-paths', 'not-locked', 'disk-check'],
  }),
  'file.upload.hashes': request(transfer.fileUploadHashesPayloadSchema, transfer.fileUploadHashesResultSchema, 'file.write', {
    channel: TRANSFER,
    checks: ['transfer-connection'],
  }),
  'file.upload.chunk': request(transfer.fileUploadChunkPayloadSchema, transfer.fileUploadChunkResultSchema, 'file.write', {
    channel: TRANSFER,
    checks: ['transfer-connection'],
    sensitive: true,
  }),
  'file.upload.commit': request(transfer.fileUploadCommitPayloadSchema, transfer.fileUploadCommitResultSchema, 'file.write', {
    channel: TRANSFER,
    checks: ['transfer-connection', 'path-guard', 'host-only-paths', 'not-locked'],
  }),
  'file.upload.abort': request(transfer.fileUploadAbortPayloadSchema, transfer.fileUploadAbortResultSchema, 'file.write', {
    channel: TRANSFER,
    checks: ['transfer-connection'],
  }),
  'file.download.begin': request(
    transfer.fileDownloadBeginPayloadSchema,
    transfer.fileDownloadBeginResultSchema,
    'file.download',
    { channel: TRANSFER, checks: ['path-guard'] },
  ),
  'file.download.chunk': event(transfer.fileDownloadChunkPayloadSchema, 'file.download', {
    channel: TRANSFER,
    checks: ['recipients:transfer-connection'],
    sensitive: true,
  }),
  'file.download.ack': notify(transfer.fileDownloadAckPayloadSchema, 'file.download', {
    channel: TRANSFER,
    checks: ['transfer-connection'],
  }),
  'file.download.end': event(transfer.fileDownloadEndPayloadSchema, 'file.download', {
    channel: TRANSFER,
    checks: ['recipients:transfer-connection'],
  }),
  'file.download.cancel': notify(transfer.fileDownloadCancelPayloadSchema, 'file.download', {
    channel: TRANSFER,
    checks: ['transfer-connection'],
  }),

  // ---- doc.* (§5.3) --------------------------------------------------------------------------------------------
  'doc.open': request(docs.docOpenPayloadSchema, docs.docOpenResultSchema, 'file.read', { checks: ['path-guard'] }),
  'doc.reset': event(docs.docResetPayloadSchema, 'file.read', { checks: ['recipients:doc-subscribers'] }),
  'doc.sync': both(docs.docSyncPayloadSchema, 'none', {
    checks: ['doc-subscriber', 'doc-content-needs-file.write', 'recipients:doc-subscribers'],
    sensitive: true,
  }),
  'doc.awareness': both(docs.docAwarenessPayloadSchema, 'none', {
    checks: ['doc-subscriber', 'recipients:doc-subscribers'],
  }),
  'doc.close': notify(docs.docClosePayloadSchema, 'none', { checks: ['doc-subscriber'] }),
  'doc.saved': event(docs.docSavedPayloadSchema, 'file.read', { checks: ['recipients:doc-subscribers'] }),
  'doc.rejected': event(docs.docRejectedPayloadSchema, 'file.read', { checks: ['recipients:self'] }),
  'doc.conflict': event(docs.docConflictPayloadSchema, 'file.read', {
    checks: ['recipients:all'],
    sensitive: true,
    redact: ['humanText', 'agentText', 'baseText'],
  }),
  'doc.conflict.list': request(docs.docConflictListPayloadSchema, docs.docConflictListResultSchema, 'file.read', {
    resultSensitive: true,
    redact: ['humanText', 'agentText', 'baseText'],
  }),
  'doc.conflict.resolve': request(docs.docConflictResolvePayloadSchema, docs.docConflictResolveResultSchema, 'file.write', {
    checks: ['path-guard', 'host-only-paths'],
    resultSensitive: true,
    redact: ['humanText', 'agentText', 'baseText'],
  }),
  'doc.conflict.get': request(docs.docConflictGetPayloadSchema, docs.docConflictGetResultSchema, 'file.read', {
    resultSensitive: true,
    redact: ['humanText', 'agentText', 'baseText'],
    addition: "the agent's full version can be a whole document (> msgpack's 1 MiB string limit), so it is not inline in ConflictRecord",
  }),

  // ---- lock.*, presence.*, activity.* (§5.4) -------------------------------------------------------------------
  'lock.state': event(presence.lockStatePayloadSchema, 'file.read', { checks: ['recipients:all'] }),
  'lock.list': request(presence.lockListPayloadSchema, presence.lockListResultSchema, 'file.read'),
  'lock.release': request(presence.lockReleasePayloadSchema, presence.lockReleaseResultSchema, 'file.write', {
    checks: ['path-guard', 'human-lock-holder'],
  }),
  'lock.forceRelease': request(
    presence.lockForceReleasePayloadSchema,
    presence.lockForceReleaseResultSchema,
    'lock.force-release',
    { checks: ['path-guard'] },
  ),
  'presence.heartbeat': event(presence.presenceHeartbeatPayloadSchema, 'none', { checks: ['recipients:all'] }),
  'presence.state': event(presence.presenceStatePayloadSchema, 'none', { checks: ['recipients:all'] }),
  'presence.update': notify(presence.presenceUpdatePayloadSchema, 'none', { checks: ['path-guard'] }),
  'activity.event': event(presence.activityEventPayloadSchema, 'file.read', { checks: ['recipients:all'] }),
  'activity.list': request(presence.activityListPayloadSchema, presence.activityListResultSchema, 'file.read'),
  'activity.notify': event(presence.activityNotifyPayloadSchema, 'none', {
    checks: ['recipients:notified-member'],
    addition: "SPEC R8: the coordination MCP tool 「通知某位組員」 needs a way to reach the member's clients",
  }),

  // ---- session.* and exec.* (§5.5) -----------------------------------------------------------------------------
  'session.create': request(
    sessions.sessionCreatePayloadSchema,
    sessions.sessionCreateResultSchema,
    ['session.create.host', 'session.create.sandboxed'],
    { checks: ['sandbox-by-role', 'api-key-sandboxed-only', 'login-own-guest-only'], sensitive: true, redact: ['apiKey'] },
  ),
  'session.list': request(sessions.sessionListPayloadSchema, sessions.sessionListResultSchema, 'session.view'),
  'session.loginStatus': request(
    sessions.sessionLoginStatusPayloadSchema,
    sessions.sessionLoginStatusResultSchema,
    OWNER,
    { checks: ['session-owner'] },
  ),
  'session.attach': request(sessions.sessionAttachPayloadSchema, sessions.sessionAttachResultSchema, 'session.view', {
    resultSensitive: true,
  }),
  'session.detach': notify(sessions.sessionDetachPayloadSchema, 'none'),
  'session.end': request(sessions.sessionEndPayloadSchema, sessions.sessionEndResultSchema, OWNER, {
    checks: ['session-owner'],
  }),
  'session.state': event(sessions.sessionStatePayloadSchema, 'session.view', { checks: ['recipients:all'] }),
  'session.importConfig': request(
    sessions.sessionImportConfigPayloadSchema,
    sessions.sessionImportConfigResultSchema,
    'session.create.sandboxed',
    { checks: ['own-guest-dir'], sensitive: true },
  ),
  'exec.output': event(sessions.execOutputPayloadSchema, 'session.view', {
    checks: ['recipients:attached-viewers'],
    sensitive: true,
  }),
  'exec.input': notify(sessions.execInputPayloadSchema, OWNER, { checks: ['session-owner'], sensitive: true }),
  'exec.resize': both(sessions.execResizePayloadSchema, OWNER, {
    checks: ['session-owner', 'recipients:attached-viewers'],
  }),

  // ---- suggest.* (§5.6) ----------------------------------------------------------------------------------------
  'suggest.create': request(suggestions.suggestCreatePayloadSchema, suggestions.suggestionResultSchema, 'suggest.create', {
    checks: ['target-session-not-own'],
  }),
  'suggest.edit': request(suggestions.suggestEditPayloadSchema, suggestions.suggestionResultSchema, OWNER, {
    checks: ['suggestion-author-pending'],
  }),
  'suggest.withdraw': request(suggestions.suggestWithdrawPayloadSchema, suggestions.suggestionResultSchema, OWNER, {
    checks: ['suggestion-author-pending'],
  }),
  'suggest.accept': request(suggestions.suggestAcceptPayloadSchema, suggestions.suggestionResultSchema, OWNER, {
    checks: ['suggestion-session-owner'],
  }),
  'suggest.reject': request(suggestions.suggestRejectPayloadSchema, suggestions.suggestionResultSchema, OWNER, {
    checks: ['suggestion-session-owner'],
  }),
  'suggest.list': request(suggestions.suggestListPayloadSchema, suggestions.suggestListResultSchema, 'session.view'),
  'suggest.updated': event(suggestions.suggestUpdatedPayloadSchema, 'session.view', {
    checks: ['recipients:suggestion-parties'],
  }),

  // ---- worktree.* (§5.7) ---------------------------------------------------------------------------------------
  'worktree.list': request(worktrees.worktreeListPayloadSchema, worktrees.worktreeListResultSchema, 'file.read'),
  'worktree.remove': request(worktrees.worktreeRemovePayloadSchema, worktrees.worktreeRemoveResultSchema, OWNER, {
    checks: ['worktree-owner-or-host'],
  }),
  'worktree.merge.request': request(
    worktrees.worktreeMergeRequestPayloadSchema,
    worktrees.mergeRequestResultSchema,
    'worktree.merge.request',
    { checks: ['worktree-owner'] },
  ),
  'worktree.merge.list': request(worktrees.worktreeMergeListPayloadSchema, worktrees.worktreeMergeListResultSchema, 'file.read'),
  'worktree.merge.diff': request(worktrees.worktreeMergeDiffPayloadSchema, worktrees.worktreeMergeDiffResultSchema, OWNER, {
    checks: ['merge-request-owner-or-host'],
    resultSensitive: true,
    redact: ['diff'],
  }),
  'worktree.merge.fileDiff': request(
    worktrees.worktreeMergeFileDiffPayloadSchema,
    worktrees.worktreeMergeFileDiffResultSchema,
    OWNER,
    {
      checks: ['merge-request-owner-or-host'],
      resultSensitive: true,
      redact: ['diff'],
      addition: 'R9 「主人看到完整 diff」: worktree.merge.diff is capped at 1 MiB, so every file must be reviewable on its own',
    },
  ),
  'worktree.merge.approve': request(
    worktrees.worktreeMergeApprovePayloadSchema,
    worktrees.mergeRequestResultSchema,
    'worktree.merge.decide',
  ),
  'worktree.merge.reject': request(
    worktrees.worktreeMergeRejectPayloadSchema,
    worktrees.mergeRequestResultSchema,
    'worktree.merge.decide',
  ),
  'worktree.updated': event(worktrees.worktreeUpdatedPayloadSchema, 'file.read', { checks: ['recipients:all'] }),
  'worktree.merge.updated': event(worktrees.worktreeMergeUpdatedPayloadSchema, 'file.read', {
    checks: ['recipients:all'],
  }),
  'worktree.removed': event(worktrees.worktreeRemovedPayloadSchema, 'file.read', {
    checks: ['recipients:all'],
    addition: 'R9: file trees that show a worktree must learn that it is gone; worktree.updated cannot express removal',
  }),

  // ---- admin.* (§5.8) ------------------------------------------------------------------------------------------
  'admin.invite.create': request(admin.adminInviteCreatePayloadSchema, admin.adminInviteCreateResultSchema, 'admin', {
    resultSensitive: true,
    redact: ['url'],
  }),
  'admin.invite.list': request(admin.adminInviteListPayloadSchema, admin.adminInviteListResultSchema, 'admin'),
  'admin.invite.revoke': request(admin.adminInviteRevokePayloadSchema, admin.adminInviteRevokeResultSchema, 'admin'),
  'admin.member.list': request(admin.adminMemberListPayloadSchema, admin.adminMemberListResultSchema, 'admin'),
  'admin.member.setRole': request(admin.adminMemberSetRolePayloadSchema, admin.adminMemberSetRoleResultSchema, 'admin'),
  'admin.member.kick': request(admin.adminMemberKickPayloadSchema, admin.adminMemberKickResultSchema, 'admin'),
  'admin.session.terminate': request(
    admin.adminSessionTerminatePayloadSchema,
    admin.adminSessionTerminateResultSchema,
    'admin',
  ),
  'admin.audit.query': request(admin.adminAuditQueryPayloadSchema, admin.adminAuditQueryResultSchema, 'admin'),
  'admin.audit.entry': event(admin.adminAuditEntryPayloadSchema, 'admin', { checks: ['recipients:host'] }),
  'admin.settings.get': request(admin.adminSettingsGetPayloadSchema, admin.hostSettingsResultSchema, 'admin'),
  'admin.settings.set': request(admin.adminSettingsSetPayloadSchema, admin.hostSettingsResultSchema, 'admin'),
});

// ---------------------------------------------------------------------------------------------------------------
// Derived types: the compiler checks both ends of every exchange against the table above.
// ---------------------------------------------------------------------------------------------------------------

export type MessageRegistry = typeof MESSAGE_REGISTRY;
/** Every message type of the catalog (without the derived `X.ok` response types). */
export type MessageType = keyof MessageRegistry;

/** c→d requests (answered by `X.ok` or `error`). */
export type RequestType = {
  [K in MessageType]: MessageRegistry[K]['result'] extends z.ZodType ? K : never;
}[MessageType];
/** c→d one-way messages. */
export type NotifyType = {
  [K in MessageType]: MessageRegistry[K] extends MessageSpec<z.ZodType, null, 'c2d'> ? K : never;
}[MessageType];
/** d→c events (`error` included). */
export type EventType = {
  [K in MessageType]: MessageRegistry[K]['dir'] extends 'd2c' ? K : never;
}[MessageType];
/** One-way messages that flow both ways. */
export type BidirectionalType = {
  [K in MessageType]: MessageRegistry[K]['dir'] extends 'both' ? K : never;
}[MessageType];

/** `X.ok` for every request `X`. */
export type ResponseType = `${RequestType}.ok`;
/** Every `type` that may appear in an Envelope. */
export type WireType = MessageType | ResponseType;

/** Types a client may send (daemon side: what a decoded client Envelope can be). */
export type ClientMessageType = RequestType | NotifyType | BidirectionalType;
/** Types the daemon may send (client side: what a decoded daemon Envelope can be). */
export type DaemonMessageType = EventType | BidirectionalType | ResponseType;

/** Validated payload of a message type (what a handler receives). */
export type PayloadOf<T extends MessageType> = z.output<MessageRegistry[T]['payload']>;
/** What a sender passes before validation (identical to PayloadOf except where a schema normalises, e.g. NFC paths). */
export type PayloadInputOf<T extends MessageType> = z.input<MessageRegistry[T]['payload']>;
/** Validated `.ok` payload of a request. */
export type ResultOf<T extends RequestType> = z.output<Extract<MessageRegistry[T]['result'], z.ZodType>>;
export type ResultInputOf<T extends RequestType> = z.input<Extract<MessageRegistry[T]['result'], z.ZodType>>;

/** The request a response type answers (`'file.tree.ok'` → `'file.tree'`). */
export type RequestOfResponse<T extends ResponseType> = T extends `${infer R extends RequestType}.ok` ? R : never;

/** Payload type of any wire type. */
export type WirePayloadOf<T extends WireType> = T extends MessageType
  ? PayloadOf<T>
  : T extends ResponseType
    ? ResultOf<RequestOfResponse<T>>
    : never;
export type WirePayloadInputOf<T extends WireType> = T extends MessageType
  ? PayloadInputOf<T>
  : T extends ResponseType
    ? ResultInputOf<RequestOfResponse<T>>
    : never;

/** Client side: `request('file.tree', payload)` resolves with the typed `.ok` payload or rejects with SmurgError. */
export type RequestFn = <T extends RequestType>(type: T, payload: PayloadInputOf<T>) => Promise<ResultOf<T>>;

/** Daemon side: a handler for request `T`; returns the `.ok` payload or throws SmurgError. */
export type RequestHandler<T extends RequestType, Ctx> = (
  payload: PayloadOf<T>,
  ctx: Ctx,
) => ResultInputOf<T> | Promise<ResultInputOf<T>>;

/** A complete handler table: the compiler reports every request without a handler. */
export type RequestHandlerMap<Ctx> = { readonly [T in RequestType]: RequestHandler<T, Ctx> };

// ---------------------------------------------------------------------------------------------------------------
// Runtime helpers
// ---------------------------------------------------------------------------------------------------------------

export type AnyMessageSpec = MessageSpec;

/** Every message type, in catalog order. */
export const MESSAGE_TYPES: readonly MessageType[] = Object.freeze(Object.keys(MESSAGE_REGISTRY) as MessageType[]);

export const RESPONSE_SUFFIX = '.ok';

export function isMessageType(value: unknown): value is MessageType {
  return typeof value === 'string' && Object.hasOwn(MESSAGE_REGISTRY, value);
}

export function getMessageSpec(type: string): AnyMessageSpec | undefined {
  return isMessageType(type) ? (MESSAGE_REGISTRY[type] as AnyMessageSpec) : undefined;
}

export function isRequestType(value: unknown): value is RequestType {
  return isMessageType(value) && MESSAGE_REGISTRY[value].result !== null;
}

export function responseTypeOf<T extends RequestType>(type: T): `${T}.ok` {
  return `${type}${RESPONSE_SUFFIX}` as `${T}.ok`;
}

export type ParsedWireType =
  | { readonly kind: 'message'; readonly type: MessageType; readonly spec: AnyMessageSpec }
  | { readonly kind: 'response'; readonly type: ResponseType; readonly request: RequestType; readonly spec: AnyMessageSpec };

/** Classifies an Envelope `type`; null for anything that is not in the catalog (including `.ok` of a non-request). */
export function parseWireType(type: string): ParsedWireType | null {
  if (isMessageType(type)) return { kind: 'message', type, spec: MESSAGE_REGISTRY[type] as AnyMessageSpec };
  if (type.endsWith(RESPONSE_SUFFIX)) {
    const request = type.slice(0, -RESPONSE_SUFFIX.length);
    if (isRequestType(request)) {
      return { kind: 'response', type: type as ResponseType, request, spec: MESSAGE_REGISTRY[request] as AnyMessageSpec };
    }
  }
  return null;
}

export function isWireType(value: unknown): value is WireType {
  return typeof value === 'string' && parseWireType(value) !== null;
}

function accessAllows(role: Role, access: MessageAccess): boolean {
  if (access === 'none' || access === 'owner-checked-in-handler') return true;
  if (typeof access === 'string') return can(role, access);
  return access.some((capability) => can(role, capability));
}

/**
 * Router-level check for a message a client sent: known c→d (or both-way) type and the role holds its capability.
 * For 'owner-checked-in-handler' types this returns true and the handler must do the ownership checks.
 */
export function mayInvoke(role: Role, type: string): boolean {
  const spec = getMessageSpec(type);
  if (spec === undefined || spec.dir === 'd2c') return false;
  return accessAllows(role, spec.capability);
}

/**
 * Fan-out check for a d→c message: whether a member with `role` may receive it at all (the `recipients:*` checks
 * narrow it further). Responses (`X.ok`, `error`) go to the requester and are always allowed.
 */
export function mayReceive(role: Role, type: string): boolean {
  const parsed = parseWireType(type);
  if (parsed === null) return false;
  if (parsed.kind === 'response') return true;
  if (parsed.spec.dir === 'c2d') return false;
  return accessAllows(role, parsed.spec.capability);
}
