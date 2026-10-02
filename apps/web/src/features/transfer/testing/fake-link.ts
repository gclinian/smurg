// TEST ONLY. A TransferLink backed by an in-memory fake daemon that follows the daemon's upload/download contract
// (ARCHITECTURE §5.2; packages/daemon/src/files/upload.ts and download.ts): plan / begin / hashes / chunk / commit /
// abort, bitmap resume by uploadId or identity, conflicts, the disk rule, and downloads with offset resume.
//
// Every payload and result goes through the protocol registry's zod schemas (like src/testing/fake-connection.ts),
// so the engine cannot rely on anything the real encoder would refuse. The root hash is checked with node:crypto
// (the daemon's own definition), independently of the protocol helper the engine uses.
import { createHash } from 'node:crypto';
import {
  SmurgError,
  getMessageSpec,
  parentRelPath,
  relPathSegments,
  rootRefKey,
  type DiskReport,
  type FileEntry,
  type PayloadInputOf,
  type PayloadOf,
  type ResultInputOf,
  type ResultOf,
  type RootRef,
} from '@smurg/protocol';
import { msg } from '@smurg/protocol/i18n';
import {
  ClientRequestError,
  isTerminalState,
  waitForBufferedAmount,
  type ActiveDownload,
  type BufferedAmountOptions,
  type ConnectionState,
  type DownloadOptions,
  type RequestOptions,
  type TransferNotifyType,
  type TransferRequestType,
} from '@smurg/protocol/client';
import type { TransferLink } from '../engine/link.ts';

const WELCOME_SETTINGS = { humanLockIdleMs: 30_000, agentLockTimeoutMs: 60_000, uploadChunkSize: 4 * 1024 * 1024, sharedDirs: [] as string[] };

export interface FakeUpload {
  readonly uploadId: string;
  readonly root: RootRef;
  readonly path: string;
  readonly size: number;
  readonly chunkSize: number;
  readonly lastModified: number;
  readonly chunkCount: number;
  readonly have: Uint8Array;
  readonly hashes: Uint8Array;
  readonly data: Map<number, Uint8Array>;
  onConflict: 'fail' | 'overwrite' | 'rename';
  bound: boolean;
}

export interface LoggedRequest {
  readonly type: TransferRequestType;
  readonly payload: unknown;
  readonly at: number;
}

type Injected = { readonly type: TransferRequestType; readonly when: (payload: never) => boolean; readonly error: unknown; remaining: number };

function sha256(data: Uint8Array): Uint8Array {
  return new Uint8Array(createHash('sha256').update(data).digest());
}

/** The daemon's definition, written out with node:crypto: SHA-256(u64be size ‖ u32be chunkSize ‖ h0 … hn-1). */
export function daemonRootHash(size: number, chunkSize: number, hashes: Uint8Array): Uint8Array {
  const header = Buffer.alloc(12);
  header.writeBigUInt64BE(BigInt(size), 0);
  header.writeUInt32BE(chunkSize, 8);
  return new Uint8Array(createHash('sha256').update(header).update(hashes).digest());
}

function bitSet(bitmap: Uint8Array, index: number): boolean {
  return ((bitmap[index >> 3] ?? 0) & (1 << (index & 7))) !== 0;
}

function numbered(name: string, n: number): string {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? `${name.slice(0, dot)} (${n})${name.slice(dot)}` : `${name} (${n})`;
}

export function okDisk(requestedBytes = 0): DiskReport {
  const totalBytes = 1024 ** 4;
  const availableBytes = 500 * 1024 ** 3;
  const reserveBytes = 50 * 1024 ** 3;
  return { totalBytes, availableBytes, reserveBytes, pendingBytes: 0, requestedBytes, freeAfterBytes: availableBytes - requestedBytes, ok: true };
}

export class FakeDaemonState {
  /** "Disk": rootKey:path → bytes, or 'dir'. */
  readonly files = new Map<string, Uint8Array | 'dir'>();
  readonly uploads = new Map<string, FakeUpload>();
  /** Committed upload ids (the daemon remembers them for a while: packages/daemon/src/files/upload.ts). */
  readonly committed = new Map<string, { root: RootRef; path: string }>();
  /** Returns a refusing DiskReport (→ insufficient_disk) or an accepting one. */
  disk: (requestedBytes: number) => DiskReport = okDisk;
  /** Download ETags by file key (changes when the file changes). */
  readonly etags = new Map<string, string>();
  /** Zip bytes and end info returned for `file.download.begin { zip: true }` of a folder. */
  zips = new Map<string, { bytes: Uint8Array; skipped: { path: string; reason: string }[]; zip64: boolean }>();
  private nextId = 1;
  readonly downloadChunkSize: number;

  constructor(options: { downloadChunkSize?: number } = {}) {
    this.downloadChunkSize = options.downloadChunkSize ?? 1024 * 1024;
  }

  key(root: RootRef, path: string): string {
    return `${rootRefKey(root)}:${path}`;
  }

  id(prefix: string): string {
    return `${prefix}_${this.nextId++}`;
  }

  put(root: RootRef, path: string, content: Uint8Array | 'dir'): void {
    this.files.set(this.key(root, path), content);
    if (content !== 'dir') this.etags.set(this.key(root, path), `e${this.nextId++}`);
  }

  get(root: RootRef, path: string): Uint8Array | 'dir' | undefined {
    return this.files.get(this.key(root, path));
  }

  entryOf(root: RootRef, path: string): FileEntry {
    const content = this.get(root, path);
    const name = path.slice(path.lastIndexOf('/') + 1);
    return { name, path, kind: content === 'dir' ? 'dir' : 'file', size: content === 'dir' || content === undefined ? 0 : content.byteLength, mtime: 1_780_000_000_000 };
  }

  mkdirs(root: RootRef, path: string): void {
    let prefix: string | null = path;
    const dirs: string[] = [];
    while (prefix !== null && prefix !== '') {
      dirs.push(prefix);
      prefix = parentRelPath(prefix);
    }
    for (const dir of dirs.reverse()) if (this.get(root, dir) === undefined) this.put(root, dir, 'dir');
  }
}

export interface FakeLinkOptions {
  readonly daemon?: FakeDaemonState;
  /** Answer chunk requests automatically (default) or only when the test calls releaseChunks(). */
  readonly ackChunks?: 'auto' | 'manual';
  /** Start online (default) or idle. */
  readonly online?: boolean;
  /** PublicSettings.uploadChunkSize in the Welcome (default 4 MiB). */
  readonly uploadChunkSize?: number;
}

interface HeldChunk {
  readonly index: number;
  readonly bytes: number;
  readonly answer: () => void;
}

export class FakeTransferLink implements TransferLink {
  readonly daemon: FakeDaemonState;
  readonly log: LoggedRequest[] = [];
  readonly notifications: { type: string; payload: unknown }[] = [];
  /** Download acks in the order they were sent. */
  readonly acks: { downloadId: string; index: number }[] = [];
  readonly events: string[] = [];
  bufferedAmountValue = 0;
  started = 0;
  closed = 0;
  /** Largest number of chunk requests the daemon held unanswered at once. */
  maxChunksInFlight = 0;
  /** Largest bytes of chunk data the daemon held unanswered at once. */
  maxChunkBytesInFlight = 0;
  /** Bytes of chunk data delivered to the daemon and not yet answered. */
  chunkBytesInFlight = 0;
  /** Bytes of chunk data the daemon has answered (success), cumulative: tests derive "held by the client" from it. */
  answeredChunkBytes = 0;
  private ackMode: 'auto' | 'manual';
  private state: ConnectionState;
  private readonly listeners = new Set<(state: ConnectionState) => void>();
  private readonly pending = new Set<{ reject: (error: unknown) => void }>();
  private readonly held: HeldChunk[] = [];
  private readonly injected: Injected[] = [];
  private readonly releaseWaiters: (() => void)[] = [];
  private seq = 1;
  private readonly chunkSize: number;

  constructor(options: FakeLinkOptions = {}) {
    this.daemon = options.daemon ?? new FakeDaemonState();
    this.chunkSize = options.uploadChunkSize ?? WELCOME_SETTINGS.uploadChunkSize;
    this.ackMode = options.ackChunks ?? 'auto';
    this.state = options.online === false ? { kind: 'idle' } : this.onlineState();
  }

  // ---------------------------------------------------------------------------------------------------------------
  // TransferLink
  // ---------------------------------------------------------------------------------------------------------------

  start(): this {
    this.started++;
    return this;
  }

  close(): void {
    this.closed++;
    this.setState({ kind: 'closed', reason: 'local' });
  }

  getState = (): ConnectionState => this.state;

  subscribe = (listener: (state: ConnectionState) => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  get welcome() {
    return this.state.kind === 'online' ? this.state.welcome : null;
  }

  get bufferedAmount(): number {
    return this.bufferedAmountValue;
  }

  waitForDrain(options?: BufferedAmountOptions): Promise<void> {
    return waitForBufferedAmount(this, { pollMs: 1, ...options });
  }

  request<T extends TransferRequestType>(type: T, payload: PayloadInputOf<T>, options?: RequestOptions): Promise<ResultOf<T>> {
    if (isTerminalState(this.state)) return Promise.reject(new ClientRequestError('closed'));
    if (this.state.kind !== 'online') return Promise.reject(new ClientRequestError('not-connected'));
    const spec = getMessageSpec(type);
    if (!spec || spec.result === null) return Promise.reject(new SmurgError('bad_request', `${type} is not a request`));
    const parsed = spec.payload.safeParse(payload);
    if (!parsed.success) return Promise.reject(new SmurgError('bad_request', `invalid ${type}: ${parsed.error.message}`));
    const input = parsed.data as PayloadOf<T>;
    this.log.push({ type, payload: input, at: Date.now() });
    const resultSchema = spec.result;
    return new Promise<ResultOf<T>>((resolve, reject) => {
      let settled = false;
      const entry = {
        reject: (error: unknown) => {
          if (settled) return;
          settled = true;
          this.pending.delete(entry);
          reject(error);
        },
      };
      const succeed = (result: ResultInputOf<T>): void => {
        if (settled) return;
        settled = true;
        this.pending.delete(entry);
        const checked = resultSchema.safeParse(result);
        if (checked.success) resolve(checked.data as ResultOf<T>);
        else reject(new Error(`fake daemon produced an invalid ${type}.ok: ${checked.error.message}`));
      };
      this.pending.add(entry);
      options?.signal?.addEventListener('abort', () => entry.reject(new ClientRequestError('cancelled')), { once: true });
      if (options?.signal?.aborted) {
        entry.reject(new ClientRequestError('cancelled'));
        return;
      }
      const injected = this.takeInjected(type, input);
      queueMicrotask(() => {
        if (settled) return;
        if (injected !== undefined) {
          entry.reject(injected);
          return;
        }
        let result: ResultInputOf<T>;
        try {
          result = this.handle(type, input) as ResultInputOf<T>;
        } catch (error) {
          entry.reject(error);
          return;
        }
        if (type === 'file.upload.commit' && this.loseNextCommitAnswer) {
          this.loseNextCommitAnswer = false;
          this.goOffline();
          entry.reject(new ClientRequestError('connection-lost'));
          return;
        }
        if (type === 'file.upload.chunk') {
          const chunk = input as PayloadOf<'file.upload.chunk'>;
          this.chunkBytesInFlight += chunk.data.byteLength;
          const heldChunk: HeldChunk = {
            index: chunk.index,
            bytes: chunk.data.byteLength,
            answer: () => {
              this.chunkBytesInFlight -= chunk.data.byteLength;
              this.answeredChunkBytes += chunk.data.byteLength;
              succeed(result);
            },
          };
          this.held.push(heldChunk);
          this.maxChunksInFlight = Math.max(this.maxChunksInFlight, this.held.length);
          this.maxChunkBytesInFlight = Math.max(this.maxChunkBytesInFlight, this.chunkBytesInFlight);
          for (const wake of this.releaseWaiters.splice(0)) wake();
          if (this.ackMode === 'auto') queueMicrotask(() => this.answerHeld(heldChunk));
          return;
        }
        succeed(result);
      });
    });
  }

  notify<T extends TransferNotifyType>(type: T, payload: PayloadInputOf<T>): boolean {
    if (this.state.kind !== 'online') return false;
    const spec = getMessageSpec(type);
    if (!spec) throw new Error(`unknown ${type}`);
    this.notifications.push({ type, payload: spec.payload.parse(payload) });
    return true;
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Test controls
  // ---------------------------------------------------------------------------------------------------------------

  /** The next `times` requests of `type` (matching `when`) fail with `error` instead of reaching the daemon. */
  failNext<T extends TransferRequestType>(type: T, error: unknown, options: { when?: (payload: PayloadOf<T>) => boolean; times?: number } = {}): void {
    this.injected.push({ type, when: (options.when ?? (() => true)) as (payload: never) => boolean, error, remaining: options.times ?? 1 });
  }

  setAckMode(mode: 'auto' | 'manual'): void {
    this.ackMode = mode;
    if (mode === 'auto') this.releaseChunks();
  }

  /** Chunks the daemon received and has not answered yet (manual ack mode). */
  get heldChunks(): readonly { index: number; bytes: number }[] {
    return this.held.map(({ index, bytes }) => ({ index, bytes }));
  }

  /** Answers the oldest `count` held chunk requests (all by default). */
  releaseChunks(count = Number.POSITIVE_INFINITY): number {
    let n = 0;
    while (n < count && this.held.length > 0) {
      this.answerHeld(this.held[0] as HeldChunk);
      n++;
    }
    return n;
  }

  /** Resolves once at least `count` chunks are held (manual mode). */
  async waitForHeld(count: number, timeoutMs = 5_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (this.held.length < count) {
      if (Date.now() > deadline) throw new Error(`waited for ${count} held chunks, have ${this.held.length}`);
      await new Promise<void>((resolve) => {
        this.releaseWaiters.push(resolve);
        setTimeout(resolve, 20);
      });
    }
  }

  /** The socket drops: every pending request fails with connection-lost, the daemon unbinds this connection. */
  goOffline(kind: 'relay-unreachable' | 'host-offline' = 'relay-unreachable'): void {
    for (const upload of this.daemon.uploads.values()) upload.bound = false;
    this.held.splice(0);
    this.chunkBytesInFlight = 0;
    this.setState(kind === 'host-offline' ? { kind, reason: 'relay', since: Date.now() } : { kind, attempt: 1, retryAt: Date.now() + 1_000, cause: 'closed' });
    for (const entry of [...this.pending]) entry.reject(new ClientRequestError('connection-lost'));
  }

  goOnline(): void {
    this.setState(this.onlineState());
  }

  end(state: ConnectionState): void {
    this.setState(state);
    for (const entry of [...this.pending]) entry.reject(new ClientRequestError('closed'));
  }

  requestsOf<T extends TransferRequestType>(type: T): PayloadOf<T>[] {
    return this.log.filter((entry) => entry.type === type).map((entry) => entry.payload as PayloadOf<T>);
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Downloads (the SDK's TransferConnection.download contract: chunks in order, each acknowledged after onChunk)
  // ---------------------------------------------------------------------------------------------------------------

  /** Deliver at most this many chunks, then drop the connection (resume tests). */
  dropDownloadAfter: number | null = null;
  /** The next commit is applied on the daemon, then the socket drops before its answer arrives. */
  loseNextCommitAnswer = false;
  /** Deliver this many chunks, then wait until releaseDownloads() (cancel tests). */
  holdDownloadsAfter: number | null = null;
  private downloadGate: { promise: Promise<void>; open: () => void } | null = null;

  releaseDownloads(): void {
    this.holdDownloadsAfter = null;
    this.downloadGate?.open();
    this.downloadGate = null;
  }

  private async downloadHold(delivered: number): Promise<void> {
    if (this.holdDownloadsAfter === null || delivered < this.holdDownloadsAfter) return;
    if (!this.downloadGate) {
      let open: () => void = () => {};
      const promise = new Promise<void>((resolve) => {
        open = resolve;
      });
      this.downloadGate = { promise, open };
    }
    await this.downloadGate.promise;
  }

  async download(payload: PayloadInputOf<'file.download.begin'>, options: DownloadOptions): Promise<ActiveDownload> {
    const info = await this.request('file.download.begin', payload, options.signal ? { signal: options.signal } : {});
    const input = getMessageSpec('file.download.begin')!.payload.parse(payload) as PayloadOf<'file.download.begin'>;
    const plan = this.downloadPlan(input);
    let cancelled = false;
    let rejectDone: (error: unknown) => void = () => {};
    const done = new Promise<PayloadOf<'file.download.end'>>((resolve, reject) => {
      rejectDone = reject;
      const run = async (): Promise<void> => {
        let delivered = 0;
        for (let index = 0; index < plan.chunks.length; index++) {
          await this.downloadHold(delivered);
          if (cancelled) return;
          if (this.state.kind !== 'online') throw new ClientRequestError('connection-lost');
          if (this.dropDownloadAfter !== null && delivered >= this.dropDownloadAfter) {
            this.dropDownloadAfter = null;
            this.goOffline();
            throw new ClientRequestError('connection-lost');
          }
          const chunk = plan.chunks[index] as { offset: number; data: Uint8Array };
          this.events.push(`deliver ${index}`);
          await options.onChunk({ index, offset: chunk.offset, data: chunk.data });
          this.events.push(`handled ${index}`);
          if (cancelled) return;
          this.acks.push({ downloadId: info.downloadId, index });
          this.events.push(`ack ${index}`);
          delivered++;
        }
        if (plan.error) throw plan.error;
        resolve({ downloadId: info.downloadId, totalBytes: plan.total, skipped: plan.skipped, zip64: plan.zip64 });
      };
      queueMicrotask(() => {
        run().catch((error: unknown) => reject(error));
      });
    });
    done.catch(() => {});
    const onAbort = (): void => {
      cancelled = true;
      this.notifications.push({ type: 'file.download.cancel', payload: { downloadId: info.downloadId } });
      rejectDone(new ClientRequestError('cancelled'));
    };
    options.signal?.addEventListener('abort', onAbort, { once: true });
    return { info, done, cancel: onAbort };
  }

  /** Injected failure of a download after N chunks (end.error). */
  downloadErrorAfterChunks: { after: number; error: SmurgError } | null = null;

  private downloadPlan(input: PayloadOf<'file.download.begin'>): {
    chunks: { offset: number; data: Uint8Array }[];
    total: number;
    skipped: { path: string; reason: string }[];
    zip64: boolean;
    error: SmurgError | null;
  } {
    const size = this.daemon.downloadChunkSize;
    const split = (bytes: Uint8Array, base: number) => {
      const chunks: { offset: number; data: Uint8Array }[] = [];
      for (let at = 0; at < bytes.byteLength; at += size) chunks.push({ offset: base + at, data: bytes.slice(at, at + size) });
      return chunks;
    };
    if (input.zip === true) {
      const zip = this.daemon.zips.get(this.daemon.key(input.file.root, input.file.path));
      if (!zip) throw new Error('fake daemon: no zip prepared');
      let chunks = split(zip.bytes, 0);
      let error: SmurgError | null = null;
      if (this.downloadErrorAfterChunks) {
        chunks = chunks.slice(0, this.downloadErrorAfterChunks.after);
        error = this.downloadErrorAfterChunks.error;
      }
      return { chunks, total: zip.bytes.byteLength, skipped: zip.skipped, zip64: zip.zip64, error };
    }
    const content = this.daemon.get(input.file.root, input.file.path) as Uint8Array;
    const offset = input.offset ?? 0;
    const rest = content.subarray(offset);
    return { chunks: split(rest, offset), total: rest.byteLength, skipped: [], zip64: false, error: null };
  }

  // ---------------------------------------------------------------------------------------------------------------
  // The fake daemon
  // ---------------------------------------------------------------------------------------------------------------

  private handle(type: TransferRequestType, input: unknown): unknown {
    switch (type) {
      case 'file.upload.plan':
        return this.plan(input as PayloadOf<'file.upload.plan'>);
      case 'file.upload.begin':
        return this.begin(input as PayloadOf<'file.upload.begin'>);
      case 'file.upload.hashes':
        return this.hashes(input as PayloadOf<'file.upload.hashes'>);
      case 'file.upload.chunk':
        return this.chunk(input as PayloadOf<'file.upload.chunk'>);
      case 'file.upload.commit':
        return this.commit(input as PayloadOf<'file.upload.commit'>);
      case 'file.upload.abort':
        this.daemon.uploads.delete((input as PayloadOf<'file.upload.abort'>).uploadId);
        return {};
      case 'file.download.begin':
        return this.downloadBegin(input as PayloadOf<'file.download.begin'>);
      default:
        throw new SmurgError('bad_request', `fake daemon does not handle ${type}`);
    }
  }

  private plan(input: PayloadOf<'file.upload.plan'>): ResultInputOf<'file.upload.plan'> {
    const d = this.daemon;
    const problems: { path: string; reason: string }[] = [];
    const seen = new Set<string>();
    for (const entry of input.entries) {
      const key = entry.path.toLowerCase();
      if (seen.has(key) && entry.kind === 'file') problems.push({ path: entry.path, reason: 'duplicate' });
      seen.add(key);
    }
    if (problems.length > 0) throw new SmurgError('conflict', msg('upload.nameConflicts'), { reason: 'batch-collision', paths: problems });
    const renamed: { from: string; to: string }[] = [];
    for (const entry of input.entries) {
      const existing = d.get(input.root, entry.path);
      if (existing === undefined) continue;
      if (entry.kind === 'dir') {
        if (existing !== 'dir') problems.push({ path: entry.path, reason: 'not-a-directory' });
        continue;
      }
      if (existing === 'dir') problems.push({ path: entry.path, reason: 'not-a-file' });
      else if (input.onConflict === 'fail') problems.push({ path: entry.path, reason: 'exists' });
      else if (input.onConflict === 'rename') {
        let n = 1;
        while (d.get(input.root, this.sibling(entry.path, n)) !== undefined) n++;
        renamed.push({ from: entry.path, to: this.sibling(entry.path, n) });
      }
    }
    if (problems.length > 0) {
      throw new SmurgError('conflict', msg('upload.nameConflicts'), {
        reason: problems.every((p) => p.reason === 'exists') ? 'exists' : 'conflict',
        paths: problems.slice(0, 100),
      });
    }
    const total = input.entries.reduce((sum, e) => sum + (e.size ?? 0), 0);
    const disk = d.disk(total);
    if (!disk.ok) throw new SmurgError('insufficient_disk', undefined, { disk });
    for (const entry of input.entries) d.mkdirs(input.root, entry.kind === 'dir' ? entry.path : (parentRelPath(entry.path) ?? ''));
    this.events.push(`plan ${input.entries.length}`);
    return { disk, renamed };
  }

  private sibling(path: string, n: number): string {
    const parent = parentRelPath(path) ?? '';
    const name = relPathSegments(path).at(-1) as string;
    return parent === '' ? numbered(name, n) : `${parent}/${numbered(name, n)}`;
  }

  private begin(input: PayloadOf<'file.upload.begin'>): ResultInputOf<'file.upload.begin'> {
    const d = this.daemon;
    const done = input.uploadId !== undefined ? d.committed.get(input.uploadId) : undefined;
    if (done) throw new SmurgError('conflict', msg('upload.alreadyDone'), { reason: 'committed', path: done.path, entry: d.entryOf(done.root, done.path) });
    const matches = (u: FakeUpload): boolean =>
      rootRefKey(u.root) === rootRefKey(input.root) && u.path === input.path && u.size === input.size && u.chunkSize === input.chunkSize && u.lastModified === input.lastModified;
    let upload = input.uploadId !== undefined ? d.uploads.get(input.uploadId) : [...d.uploads.values()].find(matches);
    if (upload && !matches(upload)) upload = undefined;
    const onConflict = input.onConflict ?? upload?.onConflict ?? 'fail';
    const existing = d.get(input.root, input.path);
    if (existing === 'dir') throw new SmurgError('conflict', msg('upload.folderInTheWay'), { reason: 'not-a-file' });
    if (existing !== undefined && onConflict === 'fail') throw new SmurgError('conflict', msg('file.nameTaken'), { reason: 'exists' });
    const remaining = upload ? upload.size - [...upload.data.values()].reduce((s, b) => s + b.byteLength, 0) : input.size;
    const disk = d.disk(remaining);
    if (!disk.ok) throw new SmurgError('insufficient_disk', undefined, { disk });
    if (upload) {
      upload.onConflict = onConflict;
      upload.bound = true;
      this.events.push(`begin-resume ${input.path}`);
      return { uploadId: upload.uploadId, chunkCount: upload.chunkCount, have: upload.have.slice(), received: upload.data.size, resumed: true, disk };
    }
    const chunkCount = input.size === 0 ? 0 : Math.ceil(input.size / input.chunkSize);
    const created: FakeUpload = {
      uploadId: d.id('up'),
      root: input.root,
      path: input.path,
      size: input.size,
      chunkSize: input.chunkSize,
      lastModified: input.lastModified,
      chunkCount,
      have: new Uint8Array(Math.ceil(chunkCount / 8)),
      hashes: new Uint8Array(chunkCount * 32),
      data: new Map(),
      onConflict,
      bound: true,
    };
    d.uploads.set(created.uploadId, created);
    this.events.push(`begin ${input.path}`);
    return { uploadId: created.uploadId, chunkCount, have: created.have.slice(), received: 0, resumed: false, disk };
  }

  private bound(uploadId: string): FakeUpload {
    const upload = this.daemon.uploads.get(uploadId);
    if (!upload) throw new SmurgError('not_found', msg('upload.notFound'), { reason: 'unknown-upload' });
    if (!upload.bound) throw new SmurgError('conflict', msg('upload.beginFirst'), { reason: 'not-bound' });
    return upload;
  }

  private hashes(input: PayloadOf<'file.upload.hashes'>): ResultInputOf<'file.upload.hashes'> {
    const upload = this.bound(input.uploadId);
    const from = Math.min(input.from, upload.chunkCount);
    const count = Math.min(input.count, upload.chunkCount - from);
    return { hashes: upload.hashes.slice(from * 32, (from + count) * 32) };
  }

  private chunk(input: PayloadOf<'file.upload.chunk'>): ResultInputOf<'file.upload.chunk'> {
    const upload = this.bound(input.uploadId);
    if (input.index >= upload.chunkCount) throw new SmurgError('bad_request', msg('upload.chunkIndex'), { reason: 'index' });
    const expected = input.index === upload.chunkCount - 1 ? upload.size - input.index * upload.chunkSize : upload.chunkSize;
    if (input.data.byteLength !== expected) throw new SmurgError('bad_request', msg('upload.chunkLength'), { reason: 'chunk-length' });
    const digest = sha256(input.data);
    if (Buffer.compare(Buffer.from(digest), Buffer.from(input.hash)) !== 0) throw new SmurgError('bad_request', msg('upload.chunkHashMismatch'), { reason: 'hash-mismatch', index: input.index });
    if (bitSet(upload.have, input.index)) {
      const stored = upload.hashes.subarray(input.index * 32, input.index * 32 + 32);
      if (Buffer.compare(Buffer.from(stored), Buffer.from(digest)) !== 0) throw new SmurgError('conflict', msg('upload.chunkDiffers'), { reason: 'chunk-differs', index: input.index });
      return { index: input.index };
    }
    upload.data.set(input.index, input.data.slice());
    upload.hashes.set(digest, input.index * 32);
    upload.have[input.index >> 3] = (upload.have[input.index >> 3] ?? 0) | (1 << (input.index & 7));
    return { index: input.index };
  }

  private commit(input: PayloadOf<'file.upload.commit'>): ResultInputOf<'file.upload.commit'> {
    const d = this.daemon;
    const upload = this.bound(input.uploadId);
    if (upload.data.size !== upload.chunkCount) throw new SmurgError('bad_request', msg('upload.incomplete'), { reason: 'incomplete' });
    const root = daemonRootHash(upload.size, upload.chunkSize, upload.hashes);
    if (Buffer.compare(Buffer.from(root), Buffer.from(input.rootHash)) !== 0) throw new SmurgError('bad_request', msg('upload.fileHashMismatch'), { reason: 'hash-mismatch' });
    let path = upload.path;
    const existing = d.get(upload.root, path);
    if (existing !== undefined) {
      if (upload.onConflict === 'fail') throw new SmurgError('conflict', msg('file.nameTaken'), { reason: 'exists' });
      if (upload.onConflict === 'rename') {
        let n = 1;
        while (d.get(upload.root, this.sibling(path, n)) !== undefined) n++;
        path = this.sibling(path, n);
      }
    }
    const content = new Uint8Array(upload.size);
    for (const [index, bytes] of upload.data) content.set(bytes, index * upload.chunkSize);
    d.mkdirs(upload.root, parentRelPath(path) ?? '');
    d.put(upload.root, path, content);
    d.uploads.delete(upload.uploadId);
    d.committed.set(upload.uploadId, { root: upload.root, path });
    this.events.push(`commit ${path}`);
    return { entry: d.entryOf(upload.root, path) };
  }

  private downloadBegin(input: PayloadOf<'file.download.begin'>): ResultInputOf<'file.download.begin'> {
    const d = this.daemon;
    const key = d.key(input.file.root, input.file.path);
    const name = input.file.path === '' ? 'workspace' : (relPathSegments(input.file.path).at(-1) as string);
    if (input.zip === true) {
      if (!d.zips.has(key)) throw new SmurgError('bad_request', msg('download.zipNeedsFolder'), { reason: 'not-a-directory' });
      return { downloadId: d.id('dl'), name: `${name}.zip`, zip: true };
    }
    const content = d.get(input.file.root, input.file.path);
    if (content === undefined) throw new SmurgError('not_found');
    if (content === 'dir') throw new SmurgError('bad_request', msg('download.folderNeedsZip'), { reason: 'not-a-file' });
    const etag = d.etags.get(key) as string;
    if (input.ifMatch !== undefined && input.ifMatch !== etag) throw new SmurgError('conflict', msg('download.changedSinceLast'), { reason: 'changed', etag });
    return { downloadId: d.id('dl'), name, size: content.byteLength, etag, zip: false };
  }

  // ---------------------------------------------------------------------------------------------------------------

  private answerHeld(chunk: HeldChunk): void {
    const index = this.held.indexOf(chunk);
    if (index < 0) return;
    this.held.splice(index, 1);
    chunk.answer();
  }

  private takeInjected(type: TransferRequestType, payload: unknown): unknown {
    const found = this.injected.find((entry) => entry.type === type && entry.remaining > 0 && entry.when(payload as never));
    if (!found) return undefined;
    found.remaining--;
    if (found.remaining === 0) this.injected.splice(this.injected.indexOf(found), 1);
    return found.error;
  }

  private onlineState(): ConnectionState {
    return {
      kind: 'online',
      resumed: false,
      welcome: {
        channelId: `ch_${this.seq++}`,
        resumed: false,
        member: { userId: 'dev:amy', displayName: 'Amy', role: 'editor', color: '#3366ff', online: true, joinedAt: 1_780_000_000_000 },
        workspace: { id: 'ws_test_transfer_000001', name: 'Test project', hostUserId: 'dev:host', hostName: 'Host', platform: 'darwin', isGitRepo: false },
        settings: { ...WELCOME_SETTINGS, uploadChunkSize: this.chunkSize },
        serverTime: 1_780_000_000_000,
      },
    };
  }

  private setState(state: ConnectionState): void {
    this.state = state;
    for (const listener of [...this.listeners]) listener(state);
  }
}
