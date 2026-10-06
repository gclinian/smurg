// The daemon's control socket (ARCHITECTURE §7.1 `run/<short>.ctl`, §8): `smurg stop`, `smurg status` and the host's
// local `smurg attach`, speaking the frames of ./protocol.ts. There is no Noise here: the socket is 0600 inside the
// 0700 run dir, so the host's OS account is the credential, and a local attach is a logical channel of the host
// (DaemonLifecycle.attachLocal: same seq/outbox/resume and router as a relay client) that may send only what `smurg
// attach` sends (./local-channel.ts LOCAL_CHANNEL_TYPES; every session runs as that OS account, so whoever drives one
// can connect here) and whose audit entries say `via: 'control-socket'`.
//
// Robustness rules this file keeps:
//  - One client cannot stall another: every connection is handled on its own, nothing awaits a client, a client that
//    stops reading is dropped once its unsent backlog passes a bound (an attached one can come back resumed), and a
//    client that never sends its request is dropped after a deadline.
//  - Bounded memory: at most `maxConnections` sockets; before the request only one control frame may be buffered.
//  - Start refuses (fail closed) when another live daemon answers on the path; a stale socket file (nobody listening)
//    is replaced; anything at the path that is not a socket is left alone and refused.
//  - stop(): the stop request is answered BEFORE the daemon stops (the reply is flushed first), and the socket file and
//    pid file are removed when the server closes.
import { randomBytes } from 'node:crypto';
import { lstat, readFile, rename, rm, unlink, writeFile, chmod } from 'node:fs/promises';
import { createConnection, createServer, type Server, type Socket } from 'node:net';
import { SmurgError, type ErrorPayload } from '@smurg/protocol';
import { msg } from '@smurg/protocol/i18n';
import type { DaemonLifecycle, LocalAttachment } from '../core/interfaces.ts';
import type { Logger } from '../core/logger.ts';
import {
  CTL_CONTROL_MAX_BYTES,
  CTL_FRAME_KIND,
  CTL_STOP_REASON,
  CtlFrameDecoder,
  CtlProtocolError,
  encodeCtlControl,
  encodeCtlFrame,
  parseCtlRequest,
  type CtlFrame,
  type CtlRequest,
  type CtlResponse,
} from './protocol.ts';

export interface ControlServerLimits {
  /** Sockets served at the same time; more are closed at once. */
  readonly maxConnections: number;
  /** A client must send its request within this. */
  readonly requestTimeoutMs: number;
  /** Unsent bytes queued for one client before it is dropped (a slow reader must not grow the daemon's memory). */
  readonly maxQueuedBytes: number;
  /** After the daemon ends a connection (or on stop), how long the peer gets to read the rest and close. */
  readonly closeGraceMs: number;
  /** How long the start-up probe waits for a connect to the existing socket. */
  readonly probeTimeoutMs: number;
}

export const DEFAULT_CONTROL_LIMITS: ControlServerLimits = Object.freeze({
  maxConnections: 32,
  requestTimeoutMs: 10_000,
  maxQueuedBytes: 32 * 1024 * 1024,
  closeGraceMs: 1_000,
  probeTimeoutMs: 2_000,
});

export type ControlSocketErrorCode = 'daemon-running' | 'not-a-socket' | 'insecure-socket' | 'listen-failed';

/** Why the control socket could not be opened (the daemon refuses to start). */
export class ControlSocketError extends Error {
  readonly code: ControlSocketErrorCode;
  readonly path: string;

  constructor(code: ControlSocketErrorCode, path: string, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'ControlSocketError';
    this.code = code;
    this.path = path;
  }
}

export interface ControlServerOptions {
  /** config.runPaths.ctl (already length-checked by resolveConfig). */
  readonly path: string;
  /** config.runPaths.pid: written while the server runs, removed on stop. */
  readonly pidPath?: string;
  /** The only user a local attach is for (config.hostUserId); attachLocal re-checks it. */
  readonly hostUserId: string;
  /**
   * The origin of the web app (./protocol.ts namedWebOrigin), sent with every `status` answer: an agent session is a
   * conversation, and `smurg attach` tells the person where the workspace opens. null: there is none to name.
   */
  readonly webOrigin?: string | null;
  readonly lifecycle: DaemonLifecycle;
  readonly log: Logger;
  /**
   * Carries out a `stop` request after its reply was flushed. Default: lifecycle.stop(reason), not awaited (it stops
   * this server too).
   */
  readonly requestStop?: (reason: string) => void;
  readonly limits?: Partial<ControlServerLimits>;
}

export type ProbeResult = 'live' | 'absent' | 'stale';

/**
 * Is a daemon listening on `path`? `absent`: nothing there. `stale`: a socket file nobody listens on. `live`: a connect
 * succeeded, or failed in a way that does not prove the socket dead (fail closed: better refuse than steal a live
 * daemon's socket).
 */
export function probeControlSocket(path: string, timeoutMs: number = DEFAULT_CONTROL_LIMITS.probeTimeoutMs): Promise<ProbeResult> {
  return new Promise((resolve) => {
    let settled = false;
    const socket = createConnection({ path });
    const done = (result: ProbeResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(result);
    };
    const timer = setTimeout(() => done('live'), timeoutMs);
    timer.unref?.();
    socket.once('connect', () => done('live'));
    socket.once('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'ENOENT') done('absent');
      else if (err.code === 'ECONNREFUSED') done('stale');
      else done('live');
    });
  });
}

type ConnState = 'awaiting-request' | 'attached' | 'closing';

/** One client of the control socket. */
class ControlConnection {
  private readonly server: ControlServer;
  private readonly socket: Socket;
  private readonly decoder = new CtlFrameDecoder();
  private state: ConnState = 'awaiting-request';
  private attachment: LocalAttachment | null = null;
  private requestTimer: ReturnType<typeof setTimeout> | undefined;
  private graceTimer: ReturnType<typeof setTimeout> | undefined;
  private destroyed = false;

  constructor(server: ControlServer, socket: Socket) {
    this.server = server;
    this.socket = socket;
    this.requestTimer = setTimeout(() => this.destroy('request-timeout'), server.limits.requestTimeoutMs);
    this.requestTimer.unref?.();
    socket.on('data', (chunk: Buffer) => this.onData(chunk));
    socket.on('error', (err: NodeJS.ErrnoException) => server.log.debug('control client socket error', { code: err.code ?? 'unknown' }));
    socket.on('close', () => this.onClose());
  }

  private onData(chunk: Buffer): void {
    if (this.destroyed) return;
    let frames: CtlFrame[];
    try {
      frames = this.decoder.push(new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength));
    } catch (err) {
      this.protocolError(err);
      return;
    }
    // Before the request only one control frame may be buffered: nobody parks an 8 MiB envelope here.
    if (this.state === 'awaiting-request' && frames.length === 0 && this.decoder.pending > 5 + CTL_CONTROL_MAX_BYTES) {
      this.destroy('oversized-request');
      return;
    }
    for (const frame of frames) {
      if (this.destroyed) return;
      this.onFrame(frame);
    }
  }

  private onFrame(frame: CtlFrame): void {
    switch (this.state) {
      case 'awaiting-request': {
        if (this.requestTimer !== undefined) clearTimeout(this.requestTimer);
        this.requestTimer = undefined;
        if (frame.kind !== CTL_FRAME_KIND.control) {
          this.protocolError(new CtlProtocolError('the first frame must be a control request'));
          return;
        }
        let request: CtlRequest;
        try {
          request = parseCtlRequest(frame.body);
        } catch (err) {
          this.server.log.debug('invalid control request', { error: err instanceof Error ? err.message : 'unknown' });
          this.respondAndEnd({ ok: false, error: new SmurgError('bad_request', msg('control.badRequest'), { reason: 'control-request' }).toPayload() });
          return;
        }
        this.onRequest(request);
        return;
      }
      case 'attached':
        if (frame.kind !== CTL_FRAME_KIND.envelope) {
          this.protocolError(new CtlProtocolError('only envelope frames may follow an attach'));
          return;
        }
        this.attachment?.receive(frame.body);
        return;
      case 'closing':
        // The reply went out and the socket is ending: anything else the client sends is ignored.
        return;
    }
  }

  private onRequest(request: CtlRequest): void {
    const server = this.server;
    switch (request.op) {
      case 'status': {
        let status;
        try {
          status = server.lifecycle.status();
        } catch (err) {
          this.respondAndEnd({ ok: false, error: toErrorPayload(err) });
          return;
        }
        this.respondAndEnd({ ok: true, op: 'status', status, ...(server.webOrigin === null ? {} : { webOrigin: server.webOrigin }) });
        return;
      }
      case 'stop': {
        server.log.info('stop requested on the control socket');
        // The requester gets its answer first; the daemon stops once the reply is flushed (or the client is gone).
        // Always the same reason (verification F-2): the client does not choose it.
        this.respondAndEnd({ ok: true, op: 'stop' }, () => server.stopRequested(CTL_STOP_REASON));
        return;
      }
      case 'attach': {
        let attachment: LocalAttachment;
        try {
          attachment = server.lifecycle.attachLocal({
            userId: server.hostUserId,
            deviceName: request.deviceName,
            ...(request.resume ? { resume: request.resume } : {}),
            send: (bytes) => this.sendEnvelope(bytes),
            close: () => this.endFromDaemon(),
          });
        } catch (err) {
          this.respondAndEnd({ ok: false, error: toErrorPayload(err) });
          return;
        }
        this.attachment = attachment;
        this.state = 'attached';
        if (!this.write(encodeCtlControl({ ok: true, op: 'attach', welcome: attachment.welcome }))) return;
        // Everything the hub queued (a resumed channel's replay) goes out after the Welcome.
        attachment.open();
        return;
      }
    }
  }

  /** One daemon → client Envelope (from the hub, through LocalChannel). */
  private sendEnvelope(bytes: Uint8Array): void {
    if (this.destroyed || this.state === 'closing') return;
    let frame: Uint8Array;
    try {
      frame = encodeCtlFrame(CTL_FRAME_KIND.envelope, bytes);
    } catch (err) {
      this.server.log.error('envelope too large for the control socket', { error: err instanceof Error ? err.name : 'unknown' });
      return;
    }
    this.write(frame);
  }

  /** Writes a frame; drops the client when its unsent backlog passes the bound. False when the connection is gone. */
  private write(frame: Uint8Array): boolean {
    if (this.destroyed) return false;
    this.socket.write(frame);
    if (this.socket.writableLength > this.server.limits.maxQueuedBytes) {
      this.server.log.warn('control client does not read; dropped', { queued: this.socket.writableLength });
      this.destroy('slow-reader');
      return false;
    }
    return true;
  }

  private respondAndEnd(response: CtlResponse, afterFlush?: () => void): void {
    let frame: Uint8Array;
    try {
      frame = encodeCtlControl(response);
    } catch (err) {
      this.server.log.error('control response could not be encoded', { error: err instanceof Error ? err.message : 'unknown' });
      frame = encodeCtlControl({ ok: false, error: new SmurgError('internal').toPayload() });
    }
    this.state = 'closing';
    let ran = false;
    const after = (): void => {
      if (ran) return;
      ran = true;
      afterFlush?.();
    };
    // 'finish' (flushed) is the normal path; 'close' covers a client that vanished before reading the answer.
    this.socket.once('close', after);
    this.socket.end(frame, after);
    this.armGrace();
  }

  /** The daemon ended this channel (stop, protocol error): let the client read what is queued, then close. */
  endFromDaemon(): void {
    if (this.destroyed || this.state === 'closing') return;
    this.state = 'closing';
    this.socket.end();
    this.armGrace();
  }

  private armGrace(): void {
    if (this.graceTimer !== undefined) return;
    this.graceTimer = setTimeout(() => this.destroy('close-grace'), this.server.limits.closeGraceMs);
    this.graceTimer.unref?.();
  }

  private protocolError(err: unknown): void {
    this.server.log.debug('control socket protocol error', { error: err instanceof Error ? err.message : 'unknown' });
    this.destroy('protocol-error');
  }

  destroy(why: string): void {
    if (this.destroyed) return;
    this.destroyed = true;
    if (why !== 'close-grace' && why !== 'stopping') this.server.log.debug('control client dropped', { why });
    this.socket.destroy();
  }

  /** stop(): ask the client to go (FIN after what is queued). */
  shutdown(): void {
    if (this.state === 'attached') this.endFromDaemon();
    else if (this.state === 'awaiting-request') this.destroy('stopping');
  }

  private onClose(): void {
    this.destroyed = true;
    if (this.requestTimer !== undefined) clearTimeout(this.requestTimer);
    if (this.graceTimer !== undefined) clearTimeout(this.graceTimer);
    const attachment = this.attachment;
    this.attachment = null;
    if (attachment) {
      try {
        attachment.end();
      } catch (err) {
        this.server.log.error('local attachment end failed', { error: err instanceof Error ? err.name : 'unknown' });
      }
    }
    this.server.forget(this);
  }
}

function toErrorPayload(err: unknown): ErrorPayload {
  return SmurgError.wrap(err).toPayload();
}

/** The listening side. start() binds (or refuses), stop() closes and removes the socket and pid files. */
export class ControlServer {
  readonly path: string;
  readonly hostUserId: string;
  readonly webOrigin: string | null;
  readonly lifecycle: DaemonLifecycle;
  readonly log: Logger;
  readonly limits: ControlServerLimits;
  private readonly pidPath: string | null;
  private readonly requestStopFn: (reason: string) => void;
  private server: Server | null = null;
  private readonly connections = new Set<ControlConnection>();
  /** dev + ino of the socket file we created (only that file is ever removed). */
  private boundIdentity: { readonly dev: number; readonly ino: number } | null = null;
  private stopRequestedOnce = false;
  private stopping: Promise<void> | null = null;

  constructor(options: ControlServerOptions) {
    this.path = options.path;
    this.hostUserId = options.hostUserId;
    this.webOrigin = options.webOrigin ?? null;
    this.lifecycle = options.lifecycle;
    this.log = options.log;
    this.limits = Object.freeze({ ...DEFAULT_CONTROL_LIMITS, ...options.limits });
    this.pidPath = options.pidPath ?? null;
    const lifecycle = options.lifecycle;
    this.requestStopFn =
      options.requestStop ??
      ((reason) => {
        lifecycle.stop(reason).catch((err: unknown) => this.log.error('stop from the control socket failed', { error: err instanceof Error ? err.name : 'unknown' }));
      });
  }

  get connectionCount(): number {
    return this.connections.size;
  }

  get listening(): boolean {
    return this.server?.listening ?? false;
  }

  async start(): Promise<void> {
    if (this.server) throw new Error('control server already started');
    await this.clearStale();
    let server: Server;
    try {
      server = await this.listen();
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw new ControlSocketError('listen-failed', this.path, 'cannot listen on the control socket', { cause: err });
      // Someone bound the path between our probe and our listen: decide again, once.
      await this.clearStale();
      try {
        server = await this.listen();
      } catch (again) {
        throw new ControlSocketError('listen-failed', this.path, 'cannot listen on the control socket', { cause: again });
      }
    }
    this.server = server;
    try {
      // The run dir is 0700 already; the socket itself is made 0600 and checked (the file mode is the credential).
      await chmod(this.path, 0o600);
      const st = await lstat(this.path);
      if (!st.isSocket() || (st.mode & 0o077) !== 0 || (typeof process.getuid === 'function' && st.uid !== process.getuid())) {
        throw new ControlSocketError('insecure-socket', this.path, 'the control socket is not a private socket of this user');
      }
      this.boundIdentity = { dev: st.dev, ino: st.ino };
      await this.writePidFile();
    } catch (err) {
      await this.stop();
      throw err instanceof ControlSocketError ? err : new ControlSocketError('listen-failed', this.path, 'cannot secure the control socket', { cause: err });
    }
    this.log.info('control socket listening');
  }

  /** A stop request was answered: carry it out once, outside the socket handler. */
  stopRequested(reason: string): void {
    if (this.stopRequestedOnce) return;
    this.stopRequestedOnce = true;
    setImmediate(() => {
      try {
        this.requestStopFn(reason);
      } catch (err) {
        this.log.error('stop request failed', { error: err instanceof Error ? err.name : 'unknown' });
      }
    });
  }

  forget(conn: ControlConnection): void {
    this.connections.delete(conn);
  }

  stop(): Promise<void> {
    this.stopping ??= this.doStop();
    return this.stopping;
  }

  private async doStop(): Promise<void> {
    const server = this.server;
    if (server) {
      const closed = new Promise<void>((resolve) => server.close(() => resolve()));
      for (const conn of [...this.connections]) conn.shutdown();
      await Promise.race([closed, delay(this.limits.closeGraceMs)]);
      for (const conn of [...this.connections]) conn.destroy('stopping');
      await closed;
    }
    await this.removeOwnSocketFile();
    await this.removePidFile();
  }

  private listen(): Promise<Server> {
    return new Promise((resolve, reject) => {
      const server = createServer({ allowHalfOpen: false, pauseOnConnect: false }, (socket) => this.onConnection(socket));
      const onError = (err: Error): void => reject(err);
      server.once('error', onError);
      server.listen({ path: this.path, exclusive: true }, () => {
        server.off('error', onError);
        server.on('error', (err) => this.log.error('control socket error', { error: err.name }));
        resolve(server);
      });
    });
  }

  private onConnection(socket: Socket): void {
    if (this.stopping || this.connections.size >= this.limits.maxConnections) {
      socket.destroy();
      return;
    }
    this.connections.add(new ControlConnection(this, socket));
  }

  /** Refuses a live daemon's socket and anything that is not a socket; removes a stale socket file. */
  private async clearStale(): Promise<void> {
    const existing = await lstat(this.path).catch((err: NodeJS.ErrnoException) => {
      if (err.code === 'ENOENT') return null;
      throw err;
    });
    if (existing === null) return;
    if (!existing.isSocket()) {
      throw new ControlSocketError('not-a-socket', this.path, 'something that is not a socket is in the way of the control socket');
    }
    const probe = await probeControlSocket(this.path, this.limits.probeTimeoutMs);
    if (probe === 'live') throw new ControlSocketError('daemon-running', this.path, 'another daemon of this workspace is running');
    if (probe === 'stale') {
      this.log.info('removing a stale control socket');
      await unlink(this.path).catch((err: NodeJS.ErrnoException) => {
        if (err.code !== 'ENOENT') throw err;
      });
    }
  }

  private async removeOwnSocketFile(): Promise<void> {
    const identity = this.boundIdentity;
    this.boundIdentity = null;
    if (!identity) return;
    // libuv already unlinks the path when the server closes; remove it only if it is still OUR socket.
    const st = await lstat(this.path).catch(() => null);
    if (st && st.isSocket() && st.dev === identity.dev && st.ino === identity.ino) await rm(this.path, { force: true }).catch(() => {});
  }

  private async writePidFile(): Promise<void> {
    if (this.pidPath === null) return;
    const tmp = `${this.pidPath}.${randomBytes(6).toString('hex')}.tmp`;
    try {
      await writeFile(tmp, `${process.pid}\n`, { mode: 0o600, flag: 'wx' });
      await rename(tmp, this.pidPath);
    } catch (err) {
      await rm(tmp, { force: true }).catch(() => {});
      // The pid file is informational (status); failing to write it must not stop the daemon.
      this.log.warn('pid file not written', { error: err instanceof Error ? err.name : 'unknown' });
    }
  }

  private async removePidFile(): Promise<void> {
    if (this.pidPath === null) return;
    const content = await readFile(this.pidPath, 'utf8').catch(() => null);
    if (content !== null && content.trim() === String(process.pid)) await rm(this.pidPath, { force: true }).catch(() => {});
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}
