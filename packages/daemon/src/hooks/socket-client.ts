// One request / one reply over the hook socket (ARCHITECTURE §7.7), for the two processes Claude Code starts inside a
// session: the hook (hook-cli.ts) and the coordination MCP server (../mcp/coord-server.ts). node:net only, so both
// start fast (test/composition.test.ts checks their import graph).
//
// Every failure is an error with a `kind`; the callers decide what failing closed means for them (the hook prints a
// deny, the MCP server answers the tool call with an error). A connection carries exactly one request.
import { createConnection } from 'node:net';
import { HOOK_RESPONSE_MAX_BYTES, isJsonObject, type JsonObject } from './wire.ts';

/** macOS limits Unix socket paths to 104 bytes including the NUL (core/sockets.ts; the daemon refuses longer ones). */
const SOCKET_PATH_MAX_BYTES = 103;

export type HookSocketErrorKind = 'no-socket' | 'connect' | 'timeout' | 'closed' | 'too-large' | 'malformed' | 'aborted';

export class HookSocketError extends Error {
  readonly kind: HookSocketErrorKind;

  constructor(kind: HookSocketErrorKind, message: string) {
    super(message);
    this.name = 'HookSocketError';
    this.kind = kind;
  }
}

export interface RequestDaemonOptions {
  /** The whole round trip (connect, write, reply) must finish within this. */
  readonly deadlineMs: number;
  readonly signal?: AbortSignal;
}

/** A usable socket path from the environment, or a HookSocketError('no-socket'). */
export function checkSocketPath(value: string | undefined): string {
  if (typeof value !== 'string' || value.length === 0) throw new HookSocketError('no-socket', 'SMURG_HOOK_SOCKET is not set');
  if (!value.startsWith('/') || value.includes('\u0000')) throw new HookSocketError('no-socket', 'SMURG_HOOK_SOCKET is not an absolute path');
  // A longer path would be truncated silently by the kernel and reach another socket (or none): refuse it.
  if (Buffer.byteLength(value, 'utf8') > SOCKET_PATH_MAX_BYTES) throw new HookSocketError('no-socket', 'SMURG_HOOK_SOCKET is too long');
  return value;
}

/** Sends `request` as one JSON line and resolves with the first reply line (a JSON object). */
export function requestDaemon(socketPath: string, request: JsonObject, options: RequestDaemonOptions): Promise<JsonObject> {
  return new Promise<JsonObject>((resolve, reject) => {
    let path: string;
    try {
      path = checkSocketPath(socketPath);
    } catch (err) {
      reject(err);
      return;
    }
    if (options.signal?.aborted) {
      reject(new HookSocketError('aborted', 'request aborted'));
      return;
    }
    const line = `${JSON.stringify(request)}\n`;
    const socket = createConnection({ path });
    const chunks: Buffer[] = [];
    let received = 0;
    let settled = false;

    const finish = (error: HookSocketError | null, value?: JsonObject): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
      socket.destroy();
      if (error) reject(error);
      else resolve(value as JsonObject);
    };
    const onAbort = (): void => finish(new HookSocketError('aborted', 'request aborted'));
    const timer = setTimeout(() => finish(new HookSocketError('timeout', `no reply within ${options.deadlineMs} ms`)), Math.max(1, options.deadlineMs));
    options.signal?.addEventListener('abort', onAbort, { once: true });

    socket.on('connect', () => {
      socket.write(line);
    });
    socket.on('data', (chunk: Buffer) => {
      const newline = chunk.indexOf(0x0a);
      const take = newline === -1 ? chunk : chunk.subarray(0, newline);
      received += take.length;
      if (received > HOOK_RESPONSE_MAX_BYTES) {
        finish(new HookSocketError('too-large', 'reply too large'));
        return;
      }
      chunks.push(take);
      if (newline === -1) return;
      let parsed: unknown;
      try {
        parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch {
        finish(new HookSocketError('malformed', 'reply is not JSON'));
        return;
      }
      if (!isJsonObject(parsed)) finish(new HookSocketError('malformed', 'reply is not a JSON object'));
      else finish(null, parsed);
    });
    socket.on('error', (err: NodeJS.ErrnoException) => {
      finish(new HookSocketError('connect', err.code ?? 'socket error'));
    });
    socket.on('close', () => {
      finish(new HookSocketError('closed', 'connection closed before a reply'));
    });
  });
}
