// Local collector for the relay's R3 byte tap (RELAY_TAP_URL). Listens on 127.0.0.1 only and stores every frame the
// relay code received or sent, verbatim, plus the request line and headers of every HTTP request.
import { createServer, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { TAP_HEADERS, type TapDirection, type TapKind, type TapRole, type TapSource } from '../src/lib/tap.ts';

export type TapFrame = {
  source: TapSource;
  direction: TapDirection;
  role: TapRole;
  conn: number;
  kind: TapKind;
  workspaceId: string;
  seq: number;
  /** Relay-side timestamp (ms since epoch). */
  at: number;
  /** Exactly the bytes the relay code saw (UTF-8 for text frames, JSON of method/url/headers for requests). */
  data: Buffer;
};

export type RelayTap = {
  /** The RELAY_TAP_URL given to the relay. */
  url: string;
  /** Snapshot of everything collected since the start or the last reset(). */
  frames(): TapFrame[];
  reset(): void;
  /** Resolves once `predicate(frames())` holds; rejects after `timeoutMs`. */
  waitFor(predicate: (frames: TapFrame[]) => boolean, timeoutMs?: number): Promise<void>;
  /** Resolves when nothing new has arrived for `quietMs` and no upload is in progress. */
  waitForQuiet(quietMs?: number, timeoutMs?: number): Promise<void>;
};

/** Frames are at most MAX_RELAY_FRAME, text below 32 MiB; anything larger is not from the relay. */
const MAX_TAP_BODY = 40 * 1024 * 1024;

export async function startTapCollector(): Promise<RelayTap & { close(): Promise<void> }> {
  let frames: TapFrame[] = [];
  let inFlight = 0;
  let lastActivity = Date.now();
  const listeners = new Set<() => void>();
  const notify = () => {
    lastActivity = Date.now();
    for (const listener of listeners) listener();
  };

  const server = createServer((req, res) => {
    if (req.method !== 'POST' || req.url !== '/tap') {
      res.writeHead(404).end();
      return;
    }
    inFlight++;
    lastActivity = Date.now();
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size <= MAX_TAP_BODY) chunks.push(chunk);
    });
    req.on('end', () => {
      inFlight--;
      if (size <= MAX_TAP_BODY) frames.push(toFrame(req, Buffer.concat(chunks)));
      res.writeHead(204).end();
      notify();
    });
    req.on('error', () => {
      inFlight--;
      notify();
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const { port } = server.address() as AddressInfo;

  const waitUntil = (check: () => boolean, timeoutMs: number, what: string, pollMs?: number) =>
    new Promise<void>((resolve, reject) => {
      const done = () => {
        if (!check()) return false;
        cleanup();
        resolve();
        return true;
      };
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error(`tap: timed out after ${timeoutMs} ms waiting for ${what} (${frames.length} frames collected)`));
      }, timeoutMs);
      const poll = pollMs === undefined ? undefined : setInterval(done, pollMs);
      const listener = () => void done();
      const cleanup = () => {
        clearTimeout(timer);
        if (poll) clearInterval(poll);
        listeners.delete(listener);
      };
      listeners.add(listener);
      done();
    });

  return {
    url: `http://127.0.0.1:${port}/tap`,
    frames: () => [...frames],
    reset: () => {
      frames = [];
    },
    waitFor: (predicate, timeoutMs = 10_000) => waitUntil(() => predicate([...frames]), timeoutMs, 'a tap condition'),
    waitForQuiet: (quietMs = 200, timeoutMs = 10_000) =>
      waitUntil(() => inFlight === 0 && Date.now() - lastActivity >= quietMs, timeoutMs, 'the tap to go quiet', 25),
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}

function header(req: IncomingMessage, name: string): string {
  const value = req.headers[name];
  return Array.isArray(value) ? (value[0] ?? '') : (value ?? '');
}

function toFrame(req: IncomingMessage, data: Buffer): TapFrame {
  return {
    source: header(req, TAP_HEADERS.source) as TapSource,
    direction: header(req, TAP_HEADERS.direction) as TapDirection,
    role: header(req, TAP_HEADERS.role) as TapRole,
    conn: Number(header(req, TAP_HEADERS.conn)),
    kind: header(req, TAP_HEADERS.kind) as TapKind,
    workspaceId: header(req, TAP_HEADERS.workspaceId),
    seq: Number(header(req, TAP_HEADERS.seq)),
    at: Number(header(req, TAP_HEADERS.at)),
    data,
  };
}
