// TEST ONLY: a raw client of the control socket (frames of src/local/protocol.ts) and a daemon with only the local
// control module (plus whatever a test adds), started with createDaemon on a private temp state dir, a short run dir
// and a fake home. Nothing here touches ~/.smurg.
import { join } from 'node:path';
import { createConnection, type Socket } from 'node:net';
import { decodeEnvelope, encodeEnvelope, type AnyEnvelope } from '@smurg/protocol';
import { createDaemon, type Daemon } from '../../src/daemon.ts';
import type { LimitsConfig } from '../../src/core/config.ts';
import type { FeatureModule } from '../../src/core/context.ts';
import { silentLogger } from '../../src/core/logger.ts';
import type { LocalControlModule } from '../../src/local/module.ts';
import { CTL_FRAME_KIND, CtlFrameDecoder, encodeCtlControl, encodeCtlFrame, parseCtlResponse, type CtlFrame, type CtlRequest, type CtlResponse } from '../../src/local/protocol.ts';
import { createTempDir, createTempProject, createTempRunDir, removeTempDir, removeTempRunDir, waitFor } from '../../src/testing/index.ts';

export interface RawCtlClient {
  readonly socket: Socket;
  readonly frames: CtlFrame[];
  /** Daemon Envelopes received after an attach, decoded. */
  readonly envelopes: AnyEnvelope[];
  closed: boolean;
  /** The socket errored (e.g. reset by the daemon). */
  errored: boolean;
  send(frame: Uint8Array): void;
  request(message: CtlRequest): void;
  /** Waits for the first control response. */
  response(timeoutMs?: number): Promise<CtlResponse>;
  /** Sends a client Envelope (next seq). */
  sendEnvelope(type: string, payload: unknown, id?: string): string;
  /** Sends a request Envelope and waits for its answer. */
  call(type: string, payload: unknown): Promise<AnyEnvelope>;
  waitClosed(timeoutMs?: number): Promise<void>;
  close(): void;
}

export async function connectRaw(path: string): Promise<RawCtlClient> {
  const socket = createConnection({ path });
  await new Promise<void>((resolve, reject) => {
    socket.once('connect', resolve);
    socket.once('error', reject);
  });
  const decoder = new CtlFrameDecoder();
  let seq = 0;
  let ids = 0;
  const client: RawCtlClient = {
    socket,
    frames: [],
    envelopes: [],
    closed: false,
    errored: false,
    send: (frame) => {
      socket.write(frame);
    },
    request: (message) => {
      socket.write(encodeCtlControl(message));
    },
    response: async (timeoutMs = 5_000) => {
      await waitFor(() => client.frames.some((f) => f.kind === CTL_FRAME_KIND.control), { timeoutMs, what: 'a control response' });
      return parseCtlResponse((client.frames.find((f) => f.kind === CTL_FRAME_KIND.control) as CtlFrame).body);
    },
    sendEnvelope: (type, payload, id) => {
      seq += 1;
      const envelopeId = id ?? `raw-${++ids}`;
      const bytes = encodeEnvelope({ type, id: envelopeId, seq, payload } as never, { from: 'client', channel: 'interactive' });
      socket.write(encodeCtlFrame(CTL_FRAME_KIND.envelope, bytes));
      return envelopeId;
    },
    call: async (type, payload) => {
      const id = client.sendEnvelope(type, payload);
      await waitFor(() => client.envelopes.some((e) => e.id === id), { what: `the answer to ${type}` });
      return client.envelopes.find((e) => e.id === id) as AnyEnvelope;
    },
    waitClosed: (timeoutMs = 5_000) => waitFor(() => client.closed, { timeoutMs, what: 'the daemon to close the socket' }),
    close: () => {
      socket.destroy();
    },
  };
  socket.on('data', (chunk: Buffer) => {
    for (const frame of decoder.push(new Uint8Array(chunk))) {
      client.frames.push(frame);
      if (frame.kind === CTL_FRAME_KIND.envelope) {
        const decoded = decodeEnvelope(frame.body, { from: 'daemon', channel: 'interactive' });
        if (decoded.ok) client.envelopes.push(decoded.envelope as AnyEnvelope);
      }
    }
  });
  socket.on('error', () => {
    client.errored = true;
  });
  socket.on('close', () => {
    client.closed = true;
  });
  return client;
}

export interface LocalDaemon {
  readonly daemon: Daemon;
  readonly stateDir: string;
  readonly runDir: string;
  readonly root: string;
  readonly workspaceId: string;
  readonly ctlPath: string;
  cleanup(): Promise<void>;
}

export const LOCAL_HOST_USER = 'dev:host';

/** A daemon without a relay (only local connections), composed of `modules`, started. */
export async function startLocalDaemon(options: {
  readonly modules: readonly FeatureModule[];
  readonly workspaceId?: string;
  /** Reuse another daemon's run dir (two daemons for one workspace). */
  readonly runDir?: string;
  readonly start?: boolean;
  /** config.webOrigin: where the daemon's links point (without it and without a relay there is no web app to name). */
  readonly webOrigin?: string;
  /** config.limits (a test that is refused more often than a connection's denial budget allows raises it). */
  readonly limits?: Partial<LimitsConfig>;
}): Promise<LocalDaemon> {
  const base = await createTempDir('local');
  const ownRunDir = options.runDir === undefined;
  const runDir = options.runDir ?? (await createTempRunDir());
  const workspaceId = options.workspaceId ?? `ws_local_${Math.random().toString(36).slice(2, 12)}`;
  const root = await createTempProject(base, 'project', { files: { 'README.md': '# local\n' } });
  const stateDir = join(base, 'state');
  const cleanupDirs = async (): Promise<void> => {
    await removeTempDir(base);
    if (ownRunDir) await removeTempRunDir(runDir);
  };
  let daemon: Daemon;
  try {
    daemon = await createDaemon({
      config: { stateDir, runDir, shareDir: root, workspaceId, hostUserId: LOCAL_HOST_USER, hostName: 'Host', relayUrl: null, keepAwake: false, ...(options.webOrigin === undefined ? {} : { webOrigin: options.webOrigin }), ...(options.limits === undefined ? {} : { limits: options.limits }) },
      modules: options.modules,
      log: silentLogger,
      homeDir: join(base, 'home'),
    });
    if (options.start !== false) await daemon.start();
  } catch (err) {
    await cleanupDirs().catch(() => {});
    throw err;
  }
  return {
    daemon,
    stateDir,
    runDir,
    root,
    workspaceId,
    ctlPath: daemon.config.runPaths.ctl,
    cleanup: async () => {
      await daemon.stop();
      // The control socket closes just after the daemon's stop (see src/local/module.ts): wait for it too.
      for (const module of options.modules) await (module as Partial<LocalControlModule>).whenClosed?.();
      await cleanupDirs();
    },
  };
}
