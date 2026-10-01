// The hook + MCP socket (ARCHITECTURE §7.7): a Unix socket at config.runPaths.hook (0600, inside the 0700 run dir).
// Newline-delimited JSON; see wire.ts for the format.
//
// Everything that arrives here is a claim from a process inside a session, and the agent can read its own token:
//  * identity = the token (hashed lookup) → the registered session and its owner; never the payload;
//  * every line is bounded (HOOK_REQUEST_MAX_BYTES) and validated (schemas.ts) before anything else;
//  * requests are rate-limited per token, connections and requests in flight are capped, idle connections dropped;
//  * paths go through PathGuard and must lie in the session's root (hook-events.ts);
//  * a PreToolUse is always answered within HOOK_SERVER_DECISION_MS, with a deny when anything is uncertain;
//  * a Bash PreToolUse / PostToolUse (the Bash ACTIVITY hook, §11 D-13) is never a decision: it opens / closes the
//    session's Bash window (rate-limited separately, ignored when config.activity.attributeBashEdits is off) and is
//    answered with null, whatever happens.
// Events of one session are handled in arrival order (a Post event must not overtake the Pre it belongs to).
import { createHash, randomBytes } from 'node:crypto';
import { chmod, lstat, unlink } from 'node:fs/promises';
import { createConnection, createServer, type Server, type Socket } from 'node:net';
import { SmurgError, fileRefKey, opaqueIdSchema, rootRefSchema, type FileRef, type RootRef } from '@smurg/protocol';
import type { DaemonContext } from '../core/context.ts';
import type { HookServer, HookSessionCredentials, HookSessionRegistration, Principal } from '../core/interfaces.ts';
import { SYSTEM_ACTOR, SYSTEM_PRINCIPAL } from '../core/permissions.ts';
import { assertSocketPath } from '../core/sockets.ts';
import { TokenBucket } from '../net/rate-limit.ts';
import {
  HOOK_DENY_REASONS,
  closeBashWindows,
  handleBashEvent,
  handleOtherEvent,
  handlePreToolUse,
  isBashActivityEvent,
  type HookSessionState,
  type PreToolUseOutcome,
} from './hook-events.ts';
import { McpToolError, runMcpTool } from './mcp-tools.ts';
import { hookSocketRequestSchema, requestEnvelopeSchema, type HookInput, type ParsedHookSocketRequest } from './schemas.ts';
import {
  removeAllSessionFiles,
  removeSessionFiles,
  watchableTopLevelNames,
  writeSessionFiles,
  type SessionFiles,
} from './settings-writer.ts';
import {
  HOOK_ENV,
  HOOK_REQUEST_MAX_BYTES,
  HOOK_RESPONSE_MAX_BYTES,
  HOOK_SERVER_DECISION_MS,
  preToolUseDeny,
  type JsonObject,
} from './wire.ts';

/** Limits of the socket. Tunable for tests; the defaults are generous for a real agent and small for a flood. */
export interface HookServerLimits {
  /** Requests per token per minute (a busy agent sends ~4 per edit: Pre, PermissionRequest, Post, FileChanged). */
  readonly requestsPerMinute: number;
  /** Burst allowance of the per-token bucket. */
  readonly requestBurst: number;
  /** notify_member calls per session per minute (and burst). */
  readonly notifyPerMinute: number;
  readonly notifyBurst: number;
  /** MCP calls in progress at once per session (wait_for_lock holds one for its whole wait). */
  readonly mcpInFlightPerSession: number;
  /** Open connections to the socket (all sessions together). */
  readonly maxConnections: number;
  /** Requests in progress at once on one connection. */
  readonly inFlightPerConnection: number;
  /** A connection with nothing in progress that sends nothing for this long is closed. */
  readonly idleTimeoutMs: number;
  /** `authz.denied` entries written per minute for unknown tokens (the rest are only counted in the log). */
  readonly unknownTokenAuditsPerMinute: number;
  /**
   * Bash activity events (§11 D-13) per session per minute, and burst: each shell command sends two. Beyond that they
   * are ignored (no window: the changes stay 「外部程式」), so a session flooding forged ones cannot keep a window open.
   */
  readonly bashEventsPerMinute: number;
  readonly bashEventsBurst: number;
}

export const DEFAULT_HOOK_SERVER_LIMITS: HookServerLimits = Object.freeze({
  requestsPerMinute: 600,
  requestBurst: 120,
  notifyPerMinute: 10,
  notifyBurst: 5,
  mcpInFlightPerSession: 4,
  maxConnections: 128,
  inFlightPerConnection: 4,
  idleTimeoutMs: 30_000,
  unknownTokenAuditsPerMinute: 10,
  bashEventsPerMinute: 240,
  bashEventsBurst: 60,
});

interface SessionEntry extends HookSessionState {
  readonly tokenHash: string;
  readonly bucket: TokenBucket;
  readonly notifyBucket: TokenBucket;
  readonly bashBucket: TokenBucket;
  /** Aborted on unregister: ends this session's waits. */
  readonly abort: AbortController;
  /** Hook events of this session, handled one after the other. */
  queue: Promise<void>;
  mcpInFlight: number;
}

function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

function errorName(err: unknown): string {
  return err instanceof Error ? err.name : 'unknown';
}

/** Connection-level state. */
interface Conn {
  readonly socket: Socket;
  readonly abort: AbortController;
  inFlight: number;
  closing: boolean;
}

export class HookServerImpl implements HookServer {
  readonly socketPath: string;
  private readonly ctx: DaemonContext;
  private readonly limits: HookServerLimits;
  private readonly byId = new Map<string, SessionEntry>();
  private readonly byToken = new Map<string, SessionEntry>();
  private readonly conns = new Set<Conn>();
  private readonly unknownTokenAudit: TokenBucket;
  private unknownTokenSuppressed = 0;
  private server: Server | null = null;
  private socketIdentity: { readonly dev: number; readonly ino: number } | null = null;
  private stopped = false;

  constructor(ctx: DaemonContext, limits: Partial<HookServerLimits> = {}) {
    this.ctx = ctx;
    this.limits = { ...DEFAULT_HOOK_SERVER_LIMITS, ...limits };
    this.socketPath = assertSocketPath(ctx.config.runPaths.hook);
    this.unknownTokenAudit = new TokenBucket({ perMinute: this.limits.unknownTokenAuditsPerMinute, clock: ctx.clock });
  }

  // -------------------------------------------------------------------------------------------------------------------
  // HookServer
  // -------------------------------------------------------------------------------------------------------------------

  registerSession(session: HookSessionRegistration): HookSessionCredentials {
    if (this.stopped) throw new SmurgError('internal', 'smurg 正在停止，無法啟動 session', { reason: 'stopping' });
    // The registration comes from the session manager, but it names paths and people: validate it anyway.
    if (!opaqueIdSchema.safeParse(session.sessionId).success || !rootRefSchema.safeParse(session.root).success) {
      throw new SmurgError('internal', undefined, { reason: 'invalid-hook-registration' });
    }
    this.unregisterSession(session.sessionId);
    const token = randomBytes(32).toString('base64url');
    const root: RootRef = session.root.kind === 'main' ? { kind: 'main' } : { kind: 'worktree', worktreeId: session.root.worktreeId };
    const entry: SessionEntry = {
      registration: Object.freeze({ ...session, root }),
      held: new Map<string, FileRef>(),
      bashOpen: new Map<string, number>(),
      tokenHash: hashToken(token),
      bucket: new TokenBucket({ perMinute: this.limits.requestsPerMinute, burst: this.limits.requestBurst, clock: this.ctx.clock }),
      notifyBucket: new TokenBucket({ perMinute: this.limits.notifyPerMinute, burst: this.limits.notifyBurst, clock: this.ctx.clock }),
      bashBucket: new TokenBucket({ perMinute: this.limits.bashEventsPerMinute, burst: this.limits.bashEventsBurst, clock: this.ctx.clock }),
      abort: new AbortController(),
      queue: Promise.resolve(),
      mcpInFlight: 0,
    };
    this.byId.set(session.sessionId, entry);
    this.byToken.set(entry.tokenHash, entry);
    return Object.freeze({
      token,
      env: Object.freeze({ [HOOK_ENV.socket]: this.socketPath, [HOOK_ENV.token]: token, [HOOK_ENV.sessionId]: session.sessionId }),
    });
  }

  unregisterSession(sessionId: string): void {
    const entry = this.byId.get(sessionId);
    if (!entry) return;
    // The token stops working at once (fail closed); waits end; the session's files go.
    this.byId.delete(sessionId);
    this.byToken.delete(entry.tokenHash);
    entry.abort.abort();
    entry.held.clear();
    try {
      closeBashWindows(this.ctx, entry);
    } catch {
      // bus listeners never throw into the emitter; nothing else to undo
    }
    try {
      // Belt and braces: the lock manager also releases on session exit, but a gone session must hold nothing.
      this.ctx.services.locks.releaseAllForSession(sessionId, 'session-ended');
    } catch {
      // the lock service may not be there (stub) or not know the session
    }
    void removeSessionFiles(this.ctx.config.stateDir, this.ctx.config.workspaceId, sessionId).catch((err: unknown) =>
      this.ctx.log.warn('could not remove session files', { session: sessionId, error: errorName(err) }),
    );
  }

  // -------------------------------------------------------------------------------------------------------------------
  // Session launch files (ARCHITECTURE §7.6), for the session manager
  // -------------------------------------------------------------------------------------------------------------------

  /**
   * Writes settings.json + mcp.json of a REGISTERED session and returns their paths and the flags for `claude`. Refuses
   * (fail closed) without config.sessions.selfCommand: a session whose hooks cannot run must not start.
   */
  async writeSessionFiles(sessionId: string): Promise<SessionFiles> {
    const entry = this.byId.get(sessionId);
    if (!entry) throw new SmurgError('internal', undefined, { reason: 'hook-session-not-registered' });
    const command = this.ctx.config.sessions.selfCommand;
    if (command === null) throw new SmurgError('internal', 'smurg 沒有設定 hook 指令，無法啟動 agent session', { reason: 'no-self-command' });
    const reg = entry.registration;
    const root = await this.ctx.paths.resolve({ root: reg.root, path: '' }, { principal: SYSTEM_PRINCIPAL, allowRoot: true, mustExist: true });
    const fileChangedNames = await watchableTopLevelNames(root.realPath);
    return writeSessionFiles({
      stateDir: this.ctx.config.stateDir,
      workspaceId: this.ctx.config.workspaceId,
      sessionId,
      settings: { command, fileChangedNames, bashActivity: this.ctx.config.activity.attributeBashEdits },
    });
  }

  /** Removes a session's launch files (also done by unregisterSession). */
  removeSessionFiles(sessionId: string): Promise<void> {
    return removeSessionFiles(this.ctx.config.stateDir, this.ctx.config.workspaceId, sessionId);
  }

  /** Registered sessions (tests, status). */
  sessionCount(): number {
    return this.byId.size;
  }

  // -------------------------------------------------------------------------------------------------------------------
  // Socket lifecycle
  // -------------------------------------------------------------------------------------------------------------------

  async start(): Promise<void> {
    if (this.server !== null || this.stopped) return;
    await this.clearStaleSocket();
    const server = createServer({ allowHalfOpen: false }, (socket) => this.onConnection(socket));
    server.maxConnections = this.limits.maxConnections;
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(this.socketPath, () => {
        server.off('error', reject);
        resolve();
      });
    });
    server.on('error', (err) => this.ctx.log.error('hook socket error', { error: errorName(err) }));
    this.server = server;
    try {
      await chmod(this.socketPath, 0o600);
      const st = await lstat(this.socketPath);
      if (!st.isSocket() || (st.mode & 0o077) !== 0) throw new Error('hook socket is not private');
      this.socketIdentity = { dev: st.dev, ino: st.ino };
    } catch (err) {
      await this.stop();
      throw err;
    }
    // No session survives a daemon restart: settings dirs left by a crash are stale.
    await removeAllSessionFiles(this.ctx.config.stateDir, this.ctx.config.workspaceId).catch((err: unknown) =>
      this.ctx.log.warn('could not remove stale session files', { error: errorName(err) }),
    );
    this.ctx.log.info('hook socket listening', { sessions: this.byId.size });
  }

  async stop(): Promise<void> {
    this.stopped = true;
    for (const entry of this.byId.values()) entry.abort.abort();
    const server = this.server;
    this.server = null;
    for (const conn of this.conns) {
      conn.abort.abort();
      conn.socket.destroy();
    }
    this.conns.clear();
    if (server !== null) await new Promise<void>((resolve) => server.close(() => resolve()));
    // Remove the socket file only if it is still ours (never another daemon's).
    if (this.socketIdentity !== null) {
      const st = await lstat(this.socketPath).catch(() => null);
      if (st !== null && st.isSocket() && st.dev === this.socketIdentity.dev && st.ino === this.socketIdentity.ino) await unlink(this.socketPath).catch(() => {});
      this.socketIdentity = null;
    }
    if (this.unknownTokenSuppressed > 0) this.ctx.log.warn('hook requests with unknown tokens (not audited)', { count: this.unknownTokenSuppressed });
  }

  /** A socket file left by a crashed daemon is removed; a live one (another daemon) or a non-socket stops the start. */
  private async clearStaleSocket(): Promise<void> {
    const st = await lstat(this.socketPath).catch((err: NodeJS.ErrnoException) => {
      if (err.code === 'ENOENT') return null;
      throw err;
    });
    if (st === null) return;
    if (!st.isSocket()) throw new Error('the hook socket path is taken by something that is not a socket');
    const live = await new Promise<boolean>((resolve) => {
      const probe = createConnection({ path: this.socketPath });
      const timer = setTimeout(() => {
        probe.destroy();
        resolve(true);
      }, 1_000);
      probe.once('connect', () => {
        clearTimeout(timer);
        probe.destroy();
        resolve(true);
      });
      probe.once('error', () => {
        clearTimeout(timer);
        probe.destroy();
        resolve(false);
      });
    });
    if (live) throw new Error('another daemon is serving this workspace (its hook socket answers)');
    await unlink(this.socketPath);
  }

  // -------------------------------------------------------------------------------------------------------------------
  // Connections
  // -------------------------------------------------------------------------------------------------------------------

  private onConnection(socket: Socket): void {
    if (this.stopped || this.conns.size >= this.limits.maxConnections) {
      socket.destroy();
      return;
    }
    const conn: Conn = { socket, abort: new AbortController(), inFlight: 0, closing: false };
    this.conns.add(conn);
    let pending: Buffer[] = [];
    let pendingBytes = 0;
    socket.setTimeout(this.limits.idleTimeoutMs);
    socket.on('timeout', () => {
      if (conn.inFlight === 0) socket.destroy();
    });
    socket.on('error', () => {
      // A client that went away; nothing to do.
    });
    socket.on('close', () => {
      conn.abort.abort();
      this.conns.delete(conn);
    });
    socket.on('data', (chunk: Buffer) => {
      if (conn.closing) return;
      let rest = chunk;
      for (;;) {
        const newline = rest.indexOf(0x0a);
        if (newline === -1) {
          pendingBytes += rest.length;
          if (pendingBytes > HOOK_REQUEST_MAX_BYTES) {
            this.protocolError(conn, null, 'too_large', 'request line too long');
            return;
          }
          if (rest.length > 0) pending.push(rest);
          return;
        }
        const piece = rest.subarray(0, newline);
        rest = rest.subarray(newline + 1);
        if (pendingBytes + piece.length > HOOK_REQUEST_MAX_BYTES) {
          this.protocolError(conn, null, 'too_large', 'request line too long');
          return;
        }
        const line = pending.length === 0 ? piece : Buffer.concat([...pending, piece]);
        pending = [];
        pendingBytes = 0;
        if (conn.inFlight >= this.limits.inFlightPerConnection) {
          this.protocolError(conn, null, 'bad_request', 'too many requests in flight on one connection');
          return;
        }
        conn.inFlight += 1;
        this.handleLine(conn, line)
          .catch((err: unknown) => {
            this.ctx.log.error('hook request failed', { error: errorName(err) });
            this.protocolError(conn, null, 'internal', 'internal error');
          })
          .finally(() => {
            conn.inFlight -= 1;
          });
        if (conn.closing) return;
      }
    });
  }

  private send(conn: Conn, reply: JsonObject): void {
    if (conn.socket.destroyed || conn.socket.writableEnded) return;
    let line = JSON.stringify(reply);
    if (Buffer.byteLength(line, 'utf8') > HOOK_RESPONSE_MAX_BYTES) {
      line = JSON.stringify({ id: reply['id'] ?? null, ok: false, error: { code: 'too_large', message: 'The answer is too large.' } });
    }
    conn.socket.write(`${line}\n`);
  }

  /** Answers a request the daemon refuses at the protocol level, then closes the connection. */
  private protocolError(conn: Conn, id: string | null, code: string, message: string): void {
    if (conn.closing) return;
    conn.closing = true;
    this.send(conn, { id, error: { code, message } });
    conn.socket.end();
    // A client that does not read its end must not keep the socket open.
    setTimeout(() => conn.socket.destroy(), 1_000).unref();
  }

  private async handleLine(conn: Conn, line: Buffer): Promise<void> {
    let raw: unknown;
    try {
      raw = JSON.parse(line.toString('utf8'));
    } catch {
      this.protocolError(conn, null, 'bad_request', 'request is not JSON');
      return;
    }
    const parsed = hookSocketRequestSchema.safeParse(raw);
    if (!parsed.success) {
      const envelope = requestEnvelopeSchema.safeParse(raw);
      this.protocolError(conn, envelope.success ? envelope.data.id : null, 'bad_request', 'invalid request');
      return;
    }
    const request = parsed.data;
    const entry = this.byToken.get(hashToken(request.token));
    if (!entry) {
      this.refuseUnknownToken(conn, request);
      return;
    }
    if (!entry.bucket.take()) {
      this.replyRateLimited(conn, request);
      return;
    }
    if (request.op === 'hook') {
      const output = await this.enqueueHook(entry, request.hookInput);
      this.send(conn, { id: request.id, hookOutput: output });
      return;
    }
    const principal = this.principalOf(entry);
    if (principal === null) {
      this.send(conn, { id: request.id, ok: false, error: { code: 'forbidden', message: "This session's owner is no longer a member of the workspace." } });
      return;
    }
    if (entry.mcpInFlight >= this.limits.mcpInFlightPerSession) {
      this.send(conn, { id: request.id, ok: false, error: { code: 'bad_request', message: 'Too many smurg tool calls in progress for this session; wait for one to finish.' } });
      return;
    }
    entry.mcpInFlight += 1;
    const signal = AbortSignal.any([conn.abort.signal, entry.abort.signal, this.ctx.stopping]);
    try {
      const result = await runMcpTool({ ctx: this.ctx, state: entry, principal, signal, notifyBucket: entry.notifyBucket }, request.tool, request.args);
      this.send(conn, { id: request.id, ok: true, result });
    } catch (err) {
      if (err instanceof McpToolError) {
        this.send(conn, { id: request.id, ok: false, error: { code: err.code, message: err.message } });
      } else {
        this.ctx.log.error('smurg tool failed', { tool: request.tool, error: errorName(err) });
        this.send(conn, { id: request.id, ok: false, error: { code: 'internal', message: 'The smurg daemon could not answer this call.' } });
      }
    } finally {
      entry.mcpInFlight -= 1;
    }
  }

  /** Hook events of one session run in order; a PreToolUse is decided within HOOK_SERVER_DECISION_MS or denied. */
  private enqueueHook(entry: SessionEntry, input: HookInput): Promise<JsonObject | null> {
    if (isBashActivityEvent(input)) return this.enqueueBash(entry, input);
    const isPre = input.hook_event_name === 'PreToolUse';
    const run = async (): Promise<PreToolUseOutcome> => {
      // A token of a session that was unregistered while this request waited no longer counts.
      if (!this.isRegistered(entry)) {
        return { output: isPre ? preToolUseDeny(HOOK_DENY_REASONS.unknownSession) : null, granted: null };
      }
      if (!isPre) {
        await handleOtherEvent(this.ctx, entry, input);
        return { output: null, granted: null };
      }
      // The owner's role as of now (a kick while this request waited counts).
      const principal = this.principalOf(entry);
      if (principal === null) return { output: preToolUseDeny(HOOK_DENY_REASONS.ownerGone), granted: null };
      const decision = await handlePreToolUse(this.ctx, entry, principal, input);
      if (decision.granted !== null && !this.isRegistered(entry)) {
        // Unregistered while the lock was being decided: the session is gone, its lock must not wait for the TTL.
        this.releaseLate(entry, decision.granted);
        return { output: preToolUseDeny(HOOK_DENY_REASONS.unknownSession), granted: null };
      }
      return decision;
    };
    const outcome = entry.queue.then(run, run);
    entry.queue = outcome.then(
      () => undefined,
      () => undefined,
    );
    const decided = outcome.then(
      (value) => value.output,
      (err: unknown) => {
        this.ctx.log.error('hook event failed', { event: input.hook_event_name, error: errorName(err) });
        return isPre ? preToolUseDeny(HOOK_DENY_REASONS.locksUnavailable) : null;
      },
    );
    if (!isPre) return decided;
    return new Promise<JsonObject | null>((resolve) => {
      let answered = false;
      const timer = setTimeout(() => {
        answered = true;
        resolve(preToolUseDeny(HOOK_DENY_REASONS.timeout));
        // The hook has been told "deny": a lock granted after that must not linger until its TTL.
        void outcome.then((late) => {
          if (late.granted !== null) this.releaseLate(entry, late.granted);
        }, () => {});
      }, HOOK_SERVER_DECISION_MS);
      void decided.then((output) => {
        if (answered) return;
        clearTimeout(timer);
        resolve(output);
      });
    });
  }

  /**
   * The Bash activity hook's events (§11 D-13): in the session's order (a Post must not overtake its Pre), never a
   * decision. Off (config.activity.attributeBashEdits false) or over the session's Bash budget: ignored.
   */
  private enqueueBash(entry: SessionEntry, input: HookInput): Promise<null> {
    if (!this.ctx.config.activity.attributeBashEdits || !entry.bashBucket.take()) return Promise.resolve(null);
    const run = (): null => (this.isRegistered(entry) ? handleBashEvent(this.ctx, entry, input) : null);
    const outcome = entry.queue.then(run, run);
    entry.queue = outcome.then(
      () => undefined,
      () => undefined,
    );
    return outcome.then(
      () => null,
      (err: unknown) => {
        this.ctx.log.error('bash activity event failed', { error: errorName(err) });
        return null;
      },
    );
  }

  private isRegistered(entry: SessionEntry): boolean {
    return this.byId.get(entry.registration.sessionId) === entry;
  }

  private principalOf(entry: SessionEntry): Principal | null {
    return this.ctx.members.agentPrincipal(entry.registration.sessionId, entry.registration.ownerUserId);
  }

  /** Undoes a lock whose grant the hook never heard of (decided too late, or for a session that is gone). */
  private releaseLate(entry: SessionEntry, file: FileRef): void {
    entry.held.delete(fileRefKey(file));
    try {
      this.ctx.services.locks.releaseAgent(entry.registration.sessionId, file);
    } catch {
      // nothing more to undo
    }
  }

  private refuseUnknownToken(conn: Conn, request: ParsedHookSocketRequest): void {
    if (this.unknownTokenAudit.take()) {
      this.ctx.audit.record({
        actor: SYSTEM_ACTOR,
        action: 'authz.denied',
        outcome: 'denied',
        target: 'hook-socket',
        detail: { reason: 'unknown-token', op: request.op, ...(request.op === 'hook' ? { event: request.hookInput.hook_event_name } : { tool: request.tool }) },
      });
    } else {
      this.unknownTokenSuppressed += 1;
    }
    if (request.op === 'hook') {
      this.send(conn, { id: request.id, hookOutput: request.hookInput.hook_event_name === 'PreToolUse' ? preToolUseDeny(HOOK_DENY_REASONS.unknownSession) : null });
    } else {
      this.send(conn, { id: request.id, ok: false, error: { code: 'unauthorized', message: 'This session is not registered with the smurg daemon.' } });
    }
    conn.closing = true;
    conn.socket.end();
  }

  private replyRateLimited(conn: Conn, request: ParsedHookSocketRequest): void {
    if (request.op === 'hook') {
      this.send(conn, { id: request.id, hookOutput: request.hookInput.hook_event_name === 'PreToolUse' ? preToolUseDeny(HOOK_DENY_REASONS.rateLimited) : null });
    } else {
      this.send(conn, { id: request.id, ok: false, error: { code: 'bad_request', message: 'Too many requests from this session; wait a few seconds.' } });
    }
  }
}
