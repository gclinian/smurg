// The Router (ARCHITECTURE §2 rule 1): every inbound Envelope has already been decoded and schema-validated by the
// hub (decodeEnvelope rejects unknown types, wrong directions and wrong channels). Here: member still active →
// a local (control-socket) channel sends only what `smurg attach` needs (local/local-channel.ts) → capability of the
// CURRENT role (registry mayInvoke) → handler. Ownership and path checks stay in handlers.
// Every refusal is audited exactly once: capability denials here, handler denials through ctx.deny() /
// PathDeniedError, and any forbidden / host_only / path_denied error a handler threw without auditing.
import {
  SmurgError,
  getMessageSpec,
  mayInvoke,
  responseTypeOf,
  type ClientEnvelope,
  type RequestType,
} from '@smurg/protocol';
import { localChannelAllows, localChannelRefusal } from '../local/local-channel.ts';
import { AuthorizationError, isAuthorizationError, isPathDeniedError, notImplemented } from './errors.ts';
import type {
  AuditLog,
  ClientConnection,
  DaemonNotifyHandler,
  DaemonRequestHandler,
  InboundNotifyType,
  MemberDirectory,
  MemberRecord,
  Principal,
  RateLimiter,
  RequestContext,
  Router,
  UserId,
} from './interfaces.ts';
import { toDisposable, type Disposable } from './lifecycle.ts';
import type { Logger } from './logger.ts';
import { userPrincipal } from './permissions.ts';

/** How the router answers; implemented by the hub. */
export interface ReplySink {
  reply(conn: ClientConnection, requestId: string, type: string, payload: unknown): void;
  protocolError(conn: ClientConnection): void;
  /** A request of `conn` was refused and audited (after the refusal was answered): the per-connection budget. */
  denied(conn: ClientConnection): void;
}

export interface RouterOptions {
  readonly sink: ReplySink;
  readonly members: Pick<MemberDirectory, 'active'>;
  readonly audit: AuditLog;
  readonly log: Logger;
  /** The per-member token buckets: one token of a type's registry `rate` bucket is taken before its handler runs. */
  readonly rates: RateLimiter;
}

type AnyHandler = (payload: unknown, ctx: RequestContext) => unknown;

class Context implements RequestContext {
  readonly type: string;
  readonly requestId: string;
  readonly conn: ClientConnection;
  readonly principal: Principal;
  readonly userId: UserId;
  readonly role: RequestContext['role'];
  readonly member: MemberRecord;
  readonly after: (() => void)[] = [];
  private readonly audit: AuditLog;

  constructor(type: string, requestId: string, conn: ClientConnection, member: MemberRecord, principal: Principal, audit: AuditLog) {
    this.type = type;
    this.requestId = requestId;
    this.conn = conn;
    this.member = member;
    this.principal = principal;
    this.userId = member.userId;
    this.role = member.role;
    this.audit = audit;
  }

  deny(
    reason: string,
    options: { readonly target?: string; readonly detail?: Readonly<Record<string, unknown>>; readonly code?: 'forbidden' | 'host_only' } = {},
  ): Error {
    this.audit.record({
      actor: this.principal.actor,
      action: 'authz.denied',
      outcome: 'denied',
      target: options.target ?? this.type,
      detail: { type: this.type, reason, ...options.detail },
    });
    const error = new AuthorizationError(undefined, { reason }, options.code ?? 'forbidden');
    error.audited = true;
    return error;
  }

  requireOwner(ownerUserId: UserId | null | undefined, what: string): void {
    if (ownerUserId === undefined || ownerUserId === null || ownerUserId !== this.userId) throw this.deny(`not-owner:${what}`);
  }

  requireOwnerOrHost(ownerUserId: UserId | null | undefined, what: string): void {
    if (this.role === 'host') return;
    this.requireOwner(ownerUserId, what);
  }

  afterReply(fn: () => void): void {
    this.after.push(fn);
  }
}

export class RouterImpl implements Router {
  private readonly requests = new Map<string, AnyHandler>();
  private readonly notifies = new Map<string, AnyHandler>();
  private readonly sink: ReplySink;
  private readonly members: Pick<MemberDirectory, 'active'>;
  private readonly audit: AuditLog;
  private readonly log: Logger;
  private readonly rates: RateLimiter;

  constructor(options: RouterOptions) {
    this.sink = options.sink;
    this.members = options.members;
    this.audit = options.audit;
    this.log = options.log;
    this.rates = options.rates;
  }

  handle<T extends RequestType>(type: T, handler: DaemonRequestHandler<T>): Disposable {
    const spec = getMessageSpec(type);
    if (!spec || spec.result === null || spec.dir !== 'c2d') throw new TypeError(`${type} is not a request type`);
    if (this.requests.has(type)) throw new Error(`a handler for ${type} is already registered`);
    const entry = handler as unknown as AnyHandler;
    this.requests.set(type, entry);
    return toDisposable(() => {
      if (this.requests.get(type) === entry) this.requests.delete(type);
    });
  }

  on<T extends InboundNotifyType>(type: T, handler: DaemonNotifyHandler<T>): Disposable {
    const spec = getMessageSpec(type);
    if (!spec || spec.result !== null || spec.dir === 'd2c' || (type as string) === 'channel.ack') throw new TypeError(`${type} is not a one-way client message`);
    if (this.notifies.has(type)) throw new Error(`a handler for ${type} is already registered`);
    const entry = handler as unknown as AnyHandler;
    this.notifies.set(type, entry);
    return toDisposable(() => {
      if (this.notifies.get(type) === entry) this.notifies.delete(type);
    });
  }

  has(type: string): boolean {
    return this.requests.has(type) || this.notifies.has(type);
  }

  async dispatch(conn: ClientConnection, envelope: ClientEnvelope): Promise<void> {
    const { type, id, payload } = envelope as { type: string; id: string; payload: unknown };
    const spec = getMessageSpec(type);
    const isRequest = spec !== undefined && spec.result !== null;
    const member = this.members.active(conn.userId);
    const principal = member ? userPrincipal(member) : null;
    if (!member || !principal) {
      // Kicked (or removed) while this message was in flight: nothing reaches a handler.
      this.audit.record({
        actor: { kind: 'system' },
        action: 'authz.denied',
        outcome: 'denied',
        target: type,
        detail: { type, reason: 'not-a-member', userId: conn.userId },
      });
      this.sink.reply(conn, id, 'error', new SmurgError('unauthorized').toPayload());
      this.sink.denied(conn);
      return;
    }
    if (conn.mode === 'local' && !localChannelAllows(type)) {
      // Review F1: the control socket admits the host's OS account, which every session runs as. Only what `smurg
      // attach` sends passes there (local/local-channel.ts LOCAL_CHANNEL_TYPES); the rest is the host's, on the web.
      this.audit.record({
        actor: principal.actor,
        action: 'authz.denied',
        outcome: 'denied',
        target: type,
        detail: { type, reason: 'control-socket', role: member.role },
      });
      this.sink.reply(conn, id, 'error', localChannelRefusal().toPayload());
      this.sink.denied(conn);
      return;
    }
    if (!spec || !mayInvoke(member.role, type)) {
      this.audit.record({
        actor: principal.actor,
        action: 'authz.denied',
        outcome: 'denied',
        target: type,
        detail: { type, reason: 'capability', role: member.role },
      });
      this.sink.reply(conn, id, 'error', new SmurgError('forbidden').toPayload());
      this.sink.denied(conn);
      return;
    }
    if (spec.rate !== null && !this.rates.take(spec.rate, member.userId)) {
      // Rates cap what a member can make everyone else's browser and the relay carry (ARCHITECTURE §5.9). A refusal is
      // audited like every refusal (under the per-actor budget) and counts toward the connection's denial budget.
      this.audit.record({
        actor: principal.actor,
        action: 'authz.denied',
        outcome: 'denied',
        target: type,
        detail: { type, reason: 'rate-limited', bucket: spec.rate, role: member.role },
      });
      this.sink.reply(conn, id, 'error', new SmurgError('rate_limited', undefined, { reason: 'rate-limited', bucket: spec.rate }).toPayload());
      this.sink.denied(conn);
      return;
    }
    const ctx = new Context(type, id, conn, member, principal, this.audit);
    const handler = isRequest ? this.requests.get(type) : this.notifies.get(type);
    try {
      if (!handler) throw notImplemented(type);
      const result = await handler(payload, ctx);
      if (!isRequest) return;
      try {
        this.sink.reply(conn, id, responseTypeOf(type as RequestType), result);
      } catch (err) {
        // The handler produced a result the schema refuses: our bug, never the client's.
        this.log.error('handler result failed validation', { type, error: err instanceof Error ? err.message.slice(0, 200) : 'unknown' });
        this.sink.reply(conn, id, 'error', new SmurgError('internal').toPayload());
        return;
      }
      for (const fn of ctx.after) {
        try {
          fn();
        } catch (err) {
          this.log.error('afterReply failed', { type, error: err instanceof Error ? err.name : 'unknown' });
        }
      }
    } catch (err) {
      this.replyError(conn, ctx, err);
    }
  }

  private replyError(conn: ClientConnection, ctx: Context, err: unknown): void {
    const error = SmurgError.wrap(err);
    const refusal = isPathDeniedError(err) || ['path_denied', 'forbidden', 'host_only', 'unauthorized', 'rate_limited'].includes(error.code);
    if (isPathDeniedError(err)) {
      if (!err.audited) {
        err.audited = true;
        this.audit.record({ actor: ctx.principal.actor, action: 'path.denied', outcome: 'denied', target: err.target, detail: { type: ctx.type, reason: err.reason } });
      }
    } else if (error.code === 'path_denied') {
      this.audit.record({ actor: ctx.principal.actor, action: 'path.denied', outcome: 'denied', target: ctx.type, detail: { type: ctx.type, reason: String(error.detail?.['reason'] ?? 'unspecified') } });
    } else if (error.code === 'forbidden' || error.code === 'host_only' || error.code === 'unauthorized') {
      if (!(isAuthorizationError(err) && err.audited)) {
        this.audit.record({ actor: ctx.principal.actor, action: 'authz.denied', outcome: 'denied', target: ctx.type, detail: { type: ctx.type, reason: String(error.detail?.['reason'] ?? 'handler') } });
      }
    } else if (error.code === 'rate_limited') {
      // A handler's own bucket (mentions, a reminder): audited here, once.
      this.audit.record({ actor: ctx.principal.actor, action: 'authz.denied', outcome: 'denied', target: ctx.type, detail: { type: ctx.type, reason: 'rate-limited', bucket: String(error.detail?.['bucket'] ?? 'handler') } });
    } else if (error.code === 'internal') {
      this.log.error('handler failed', {
        type: ctx.type,
        error: err instanceof SmurgError ? String(err.detail?.['reason'] ?? err.message.slice(0, 120)) : err instanceof Error ? err.name : 'unknown',
      });
    }
    try {
      this.sink.reply(conn, ctx.requestId, 'error', error.toPayload());
    } catch {
      this.sink.reply(conn, ctx.requestId, 'error', new SmurgError('internal').toPayload());
    }
    if (refusal) this.sink.denied(conn);
  }
}
