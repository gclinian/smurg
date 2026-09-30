// Shared helpers of the files-module tests: a daemon with the files module (and a simulated disk), a scriptable lock
// manager, raw requests that bypass the client SDK's own validation, a client-side upload loop with the ack window,
// downloads into memory or a file, and a daemon restart on the same state directory.
import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  MAIN_ROOT,
  fileRefKey,
  type AuditEntry,
  type ErrorPayload,
  type FileRef,
  type LockInfo,
  type PayloadOf,
  type ResultOf,
  type RootRef,
} from '@smurg/protocol';
import { AckWindow, missingChunks, uploadRootHash, type TransferConnection } from '@smurg/protocol/client';
import type { DaemonContext, FeatureModule } from '../../src/core/context.ts';
import type { LockManager } from '../../src/core/interfaces.ts';
import { silentLogger } from '../../src/core/logger.ts';
import { createDaemon, type Daemon } from '../../src/daemon.ts';
import { createFilesModule, filesInstanceOf, type FilesInstance, type FilesModuleOptions } from '../../src/files/module.ts';
import type { StatfsFunction } from '../../src/files/disk.ts';
import { MEMORY_RELAY_ORIGIN, TEST_HOST_NAME, TEST_HOST_USER, createTestDaemon, waitFor, type TestClient, type TestDaemon, type TestDaemonOptions } from '../../src/testing/index.ts';

export const KiB = 1024;
export const MiB = 1024 * KiB;
export const GiB = 1024 * MiB;

/** A disk whose numbers the test sets (and may change between calls). */
export interface SimulatedDisk {
  totalBytes: number;
  availableBytes: number;
  calls: number;
}

export function simulatedDisk(totalBytes = 1024 * GiB, availableBytes = 500 * GiB): SimulatedDisk {
  return { totalBytes, availableBytes, calls: 0 };
}

export function statfsOf(disk: SimulatedDisk): StatfsFunction {
  return async () => {
    disk.calls++;
    return { bsize: 4096, blocks: BigInt(Math.floor(disk.totalBytes / 4096)), bavail: BigInt(Math.floor(disk.availableBytes / 4096)) };
  };
}

/** A LockManager whose locks the test sets directly (only get / list are used by the files module). */
export class ScriptedLocks {
  private readonly locks = new Map<string, LockInfo>();

  set(lock: LockInfo): void {
    this.locks.set(fileRefKey(lock.file), lock);
  }

  clear(): void {
    this.locks.clear();
  }

  manager(): LockManager {
    const partial: Pick<LockManager, 'get' | 'list'> = {
      get: (file) => this.locks.get(fileRefKey(file)) ?? null,
      list: () => [...this.locks.values()],
    };
    return new Proxy(partial as LockManager, {
      get(target, property) {
        if (property in target) return (target as unknown as Record<string | symbol, unknown>)[property];
        if (property === 'then' || typeof property === 'symbol') return undefined;
        return () => {
          throw new Error(`ScriptedLocks: ${String(property)} is not scripted`);
        };
      },
    });
  }

  module(): FeatureModule {
    return { name: 'scripted-locks', create: () => ({ locks: this.manager() }), register: () => ({ dispose: () => {} }) };
  }
}

export function humanLock(file: FileRef, displayName = 'Amy'): LockInfo {
  const at = Date.now();
  return { kind: 'human', file, holders: [{ userId: `dev:${displayName.toLowerCase()}`, displayName, lastActivityAt: at }], acquiredAt: at };
}

export function agentLock(file: FileRef, owner = 'Ian'): LockInfo {
  const at = Date.now();
  return { kind: 'agent', file, sessionId: 'sess_test_agent', ownerUserId: `dev:${owner.toLowerCase()}`, agentName: `Claude（${owner}）`, acquiredAt: at, expiresAt: at + 60_000 };
}

export interface FilesTestOptions extends Omit<TestDaemonOptions, 'modules'> {
  readonly disk?: SimulatedDisk;
  readonly locks?: ScriptedLocks;
  readonly files?: Omit<FilesModuleOptions, 'statfs'>;
  readonly extraModules?: readonly FeatureModule[];
}

export interface FilesTest {
  readonly t: TestDaemon;
  readonly disk: SimulatedDisk;
  readonly module: FeatureModule;
  readonly modules: readonly FeatureModule[];
  instance(): FilesInstance;
}

/** A test daemon composing the files module (simulated disk: 1 TiB, 500 GiB free, unless given). */
export async function startFilesDaemon(options: FilesTestOptions = {}): Promise<FilesTest> {
  const disk = options.disk ?? simulatedDisk();
  const module = createFilesModule({ ...options.files, statfs: statfsOf(disk) });
  const modules = [...(options.locks ? [options.locks.module()] : []), ...(options.extraModules ?? []), module];
  const { disk: _disk, locks: _locks, files: _files, extraModules: _extra, ...rest } = options;
  const t = await createTestDaemon({ ...rest, modules });
  return { t, disk, module, modules, instance: () => filesInstanceOf(t.ctx) as FilesInstance };
}

/** Audit entries written so far (flushed first). */
export async function auditEntries(ctx: DaemonContext, filter: (entry: AuditEntry) => boolean = () => true): Promise<AuditEntry[]> {
  await ctx.audit.flush();
  return (await ctx.audit.query({ limit: 500 })).filter(filter).reverse();
}

/**
 * Sends an Envelope straight to the router, past the client SDK and the decoder (both would refuse an invalid path
 * before it leaves the client): what a forged client that also got past the decoder would reach. Returns the error
 * the daemon answered, or 'answered' when a response (not an error) went back.
 */
let rawCounter = 0;
interface ErrorSource {
  on(type: 'error', handler: (payload: ErrorPayload, meta: { readonly id: string }) => void): () => void;
}
export async function rawRequest(
  t: TestDaemon,
  client: TestClient,
  type: string,
  payload: unknown,
  transfer?: TransferConnection,
): Promise<ErrorPayload | 'answered'> {
  const purpose = transfer ? 'transfer' : 'interactive';
  const conn = t.ctx.hub.connections({ userId: client.userId, purpose })[0];
  if (!conn) throw new Error(`no ${purpose} connection of ${client.userId}`);
  const id = `raw_${++rawCounter}`;
  const errors: ErrorPayload[] = [];
  const source = (transfer ?? client.conn) as unknown as ErrorSource;
  const off = source.on('error', (p, meta) => {
    if (meta.id === id) errors.push(p);
  });
  try {
    await t.ctx.router.dispatch(conn, { type, id, seq: 0, payload } as never);
    await waitFor(() => errors.length > 0, { timeoutMs: 1_500 }).catch(() => {});
  } finally {
    off();
  }
  return errors[0] ?? 'answered';
}

export async function settleError(promise: Promise<unknown>): Promise<{ code: string; reason?: string; detail?: Record<string, unknown>; message: string } | null> {
  try {
    await promise;
    return null;
  } catch (err) {
    const e = err as { code?: string; message?: string; detail?: Record<string, unknown> };
    const reason = e.detail?.['reason'];
    return { code: e.code ?? 'unknown', message: e.message ?? '', ...(typeof reason === 'string' ? { reason } : {}), ...(e.detail ? { detail: e.detail } : {}) };
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Uploads (the client side, as the web Worker / CLI do it: ack window of 4, hash per chunk, hash-list root)
// ---------------------------------------------------------------------------------------------------------------

export type ChunkSource = (index: number, offset: number, length: number) => Uint8Array;

export function bytesSource(data: Uint8Array): ChunkSource {
  return (_index, offset, length) => data.subarray(offset, offset + length);
}

/** Deterministic, cheap content: each chunk is a 64-byte pattern derived from its index, repeated. */
export function patternSource(seed: string): ChunkSource {
  return (index, _offset, length) => {
    const pattern = createHash('sha256').update(`${seed}:${index}`).digest();
    const out = Buffer.alloc(length);
    out.fill(Buffer.concat([pattern, pattern]));
    return out;
  };
}

export function sha256Hex(data: Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

/** SHA-256 of the whole file a ChunkSource describes (computed chunk by chunk, never whole in memory). */
export function sourceHash(source: ChunkSource, size: number, chunkSize: number): string {
  const hash = createHash('sha256');
  for (let index = 0, offset = 0; offset < size; index++, offset += chunkSize) hash.update(source(index, offset, Math.min(chunkSize, size - offset)));
  return hash.digest('hex');
}

export interface UploadRun {
  readonly begin: ResultOf<'file.upload.begin'>;
  /** Chunk indexes this run sent (and the daemon acknowledged). */
  readonly sent: number[];
  readonly entry: ResultOf<'file.upload.commit'>['entry'] | null;
}

export interface UploadParams {
  readonly root?: RootRef;
  readonly path: string;
  readonly size: number;
  readonly chunkSize?: number;
  readonly lastModified?: number;
  readonly source: ChunkSource;
  readonly uploadId?: string;
  readonly onConflict?: 'fail' | 'overwrite' | 'rename';
  /** Stop (without committing) after this many chunks of this run were acknowledged. */
  readonly stopAfter?: number;
  /** Called after each acknowledged chunk. */
  readonly onAck?: (index: number) => void;
}

export async function upload(xfer: TransferConnection, params: UploadParams): Promise<UploadRun> {
  const chunkSize = params.chunkSize ?? MiB;
  const root = params.root ?? MAIN_ROOT;
  const begin = await xfer.request('file.upload.begin', {
    root,
    path: params.path,
    size: params.size,
    chunkSize,
    lastModified: params.lastModified ?? 1_760_000_000_000,
    ...(params.uploadId ? { uploadId: params.uploadId } : {}),
    ...(params.onConflict ? { onConflict: params.onConflict } : {}),
  });
  const window = new AckWindow();
  const sent: number[] = [];
  let failure: unknown = null;
  // Hashes are computed as chunks are read (the chunk is dropped right after it was sent), like the web Worker does.
  const hashes: (Uint8Array | null)[] = new Array<Uint8Array | null>(begin.chunkCount).fill(null);
  const hashOf = (index: number): Uint8Array => {
    const offset = index * chunkSize;
    return createHash('sha256').update(params.source(index, offset, Math.min(chunkSize, params.size - offset))).digest();
  };
  for (const index of missingChunks(begin.have, begin.chunkCount)) {
    if (params.stopAfter !== undefined && sent.length + window.inFlight >= params.stopAfter) break;
    await window.acquire();
    if (failure) {
      window.release();
      break;
    }
    const offset = index * chunkSize;
    const data = params.source(index, offset, Math.min(chunkSize, params.size - offset));
    const hash = createHash('sha256').update(data).digest();
    hashes[index] = hash;
    xfer
      .request('file.upload.chunk', { uploadId: begin.uploadId, index, hash, data })
      .then(
        () => {
          sent.push(index);
          params.onAck?.(index);
        },
        (err: unknown) => {
          failure ??= err;
        },
      )
      .finally(() => window.release());
  }
  await window.idle();
  if (failure) throw failure;
  if (params.stopAfter !== undefined) return { begin, sent, entry: null };
  // Chunks stored before this run (a resume) are hashed locally, never uploaded again.
  const all = hashes.map((hash, index) => hash ?? hashOf(index));
  const commit = await xfer.request('file.upload.commit', { uploadId: begin.uploadId, rootHash: uploadRootHash(params.size, chunkSize, all) });
  return { begin, sent, entry: commit.entry };
}

// ---------------------------------------------------------------------------------------------------------------
// Downloads
// ---------------------------------------------------------------------------------------------------------------

export async function downloadToBuffer(
  xfer: TransferConnection,
  payload: PayloadOf<'file.download.begin'>,
  onChunk?: (index: number) => Promise<void> | void,
): Promise<{ info: ResultOf<'file.download.begin'>; data: Buffer; end: PayloadOf<'file.download.end'> }> {
  const parts: Buffer[] = [];
  const download = await xfer.download(payload, {
    onChunk: async (chunk) => {
      parts.push(Buffer.from(chunk.data));
      await onChunk?.(chunk.index);
    },
  });
  const end = await download.done;
  return { info: download.info, data: Buffer.concat(parts), end };
}

export async function downloadToFile(xfer: TransferConnection, payload: PayloadOf<'file.download.begin'>, file: string): Promise<PayloadOf<'file.download.end'>> {
  const out = createWriteStream(file);
  const download = await xfer.download(payload, {
    onChunk: (chunk) =>
      new Promise<void>((resolve, reject) => {
        out.write(Buffer.from(chunk.data), (err) => (err ? reject(err) : resolve()));
      }),
  });
  try {
    return await download.done;
  } finally {
    await new Promise<void>((resolve) => out.end(resolve));
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Restart: a second daemon on the same state dir, share, workspace id and relay (the first one must be stopped).
// ---------------------------------------------------------------------------------------------------------------

export async function restartDaemon(t: TestDaemon, modules: readonly FeatureModule[]): Promise<Daemon> {
  const daemon = await createDaemon({
    config: {
      stateDir: t.stateDir,
      runDir: t.runDir,
      shareDir: t.root,
      workspaceId: t.workspaceId,
      hostUserId: TEST_HOST_USER,
      hostName: TEST_HOST_NAME,
      relayUrl: MEMORY_RELAY_ORIGIN,
      webOrigin: MEMORY_RELAY_ORIGIN,
      keepAwake: false,
    },
    relay: { token: 'test-host-token', socketFactory: t.relay.hostSocketFactory() },
    identityKeys: { get: (kid) => (kid === t.issuer.kid ? t.issuer.publicKey : null), refresh: async () => {} },
    modules,
    clock: t.clock,
    log: silentLogger,
    homeDir: join(dirname(t.stateDir), 'home'),
    random: () => 0.5,
  });
  await daemon.start();
  await waitFor(() => t.relay.hostOnline('ws') && t.relay.hostOnline('xfer'), { timeoutMs: 10_000, what: 'the restarted daemon to reach the relay' });
  return daemon;
}

