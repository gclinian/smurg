// DownloadService (SPEC R7: download one file, or a folder the daemon streams as a zip; ARCHITECTURE §5.2 transfer
// channel; transfer.md §1.6). A single file streams from a guarded handle by offset (resumable with offset + ifMatch);
// a folder streams as a zip built while it is sent. Both honour the end-to-end credit window (TRANSFER_WINDOW_CHUNKS
// unacknowledged chunks per download) and the daemon's own socket buffer, so nothing is ever read further ahead than
// the client consumes. Downloads belong to their transfer connection and end with it.
import type { BigIntStats } from 'node:fs';
import {
  SmurgError,
  TRANSFER_BUFFERED_AMOUNT_MAX,
  TRANSFER_BUFFERED_POLL_MS,
  TRANSFER_WINDOW_CHUNKS,
  pathSegmentSchema,
  type PayloadOf,
} from '@smurg/protocol';
import { msg } from '@smurg/protocol/i18n';
import type { DaemonContext } from '../core/context.ts';
import type { ClientConnection, DownloadService, DownloadStart, GuardedFile, Principal, ResolvedPath } from '../core/interfaces.ts';
import { newId } from '../core/lifecycle.ts';
import { isHostPrincipal } from '../core/permissions.ts';
import { createZipSource, type ZipSource } from './zip.ts';
import { refLabel } from './util.ts';

/** A download whose `.ok` never went out (the reply failed) is dropped after this long. */
const START_TIMEOUT_MS = 30_000;
const ZIP32_LIMIT = 0xffff_ffff;

interface ActiveDownload {
  readonly id: string;
  readonly conn: ClientConnection;
  readonly outstanding: Set<number>;
  wake: (() => void) | null;
  /** Bytes sent so far (reported in an `end` that carries an error). */
  bytes: number;
  cancelled: boolean;
  started: boolean;
  startTimer: ReturnType<typeof setTimeout> | null;
  cleanup: () => void;
}

/** size + mtime (ns) + inode: changes whenever the file's content can have changed (transfer.md §1.6). */
export function etagOf(st: BigIntStats): string {
  return `${st.size.toString(36)}.${st.mtimeNs.toString(36)}.${st.ino.toString(36)}`;
}

/** Coalesces a byte stream into messages of exactly `size` bytes (the last one shorter), pulling as it goes. */
export async function* rechunk(stream: AsyncIterable<Buffer | Uint8Array>, size: number): AsyncGenerator<Buffer> {
  let parts: Buffer[] = [];
  let length = 0;
  for await (const piece of stream) {
    const buffer = Buffer.isBuffer(piece) ? piece : Buffer.from(piece.buffer, piece.byteOffset, piece.byteLength);
    parts.push(buffer);
    length += buffer.byteLength;
    while (length >= size) {
      const all = parts.length === 1 ? (parts[0] as Buffer) : Buffer.concat(parts, length);
      yield all.subarray(0, size);
      const rest = all.subarray(size);
      parts = rest.byteLength > 0 ? [Buffer.from(rest)] : [];
      length = rest.byteLength;
    }
  }
  if (length > 0) yield parts.length === 1 ? (parts[0] as Buffer) : Buffer.concat(parts, length);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class DownloadServiceImpl implements DownloadService {
  private readonly ctx: DaemonContext;
  private readonly active = new Map<string, ActiveDownload>();

  constructor(ctx: DaemonContext) {
    this.ctx = ctx;
  }

  async begin(input: PayloadOf<'file.download.begin'>, conn: ClientConnection, principal: Principal): Promise<DownloadStart> {
    const zip = input.zip === true;
    if (!zip && input.file.path === '') throw new SmurgError('bad_request', msg('download.pickFile'), { reason: 'not-a-file' });
    const resolved = await this.ctx.paths.resolve(input.file, { principal, mustExist: true, allowRoot: zip });
    const kind = resolved.identity?.kind;
    if (zip) {
      if (kind !== 'dir') throw new SmurgError('bad_request', msg('download.zipNeedsFolder'), { reason: 'not-a-directory' });
      return this.beginZip(resolved, conn, principal);
    }
    if (kind !== 'file') throw new SmurgError('bad_request', msg('download.folderNeedsZip'), { reason: 'not-a-file' });
    return this.beginFile(resolved, input, conn, principal);
  }

  ack(input: PayloadOf<'file.download.ack'>, conn: ClientConnection): void {
    const state = this.active.get(input.downloadId);
    // Unknown (already finished) or someone else's download: nothing to grant, and nothing to reveal.
    if (!state || state.conn.id !== conn.id) return;
    if (state.outstanding.delete(input.index)) this.wake(state);
  }

  cancel(input: PayloadOf<'file.download.cancel'>, conn: ClientConnection): void {
    const state = this.active.get(input.downloadId);
    if (!state || state.conn.id !== conn.id) return;
    this.finish(state);
  }

  cancelAllForConnection(connId: string): void {
    for (const state of [...this.active.values()]) if (state.conn.id === connId) this.finish(state);
  }

  /** Daemon stop. */
  stopAll(): void {
    for (const state of [...this.active.values()]) this.finish(state);
  }

  /** Downloads in progress (tests). */
  activeCount(): number {
    return this.active.size;
  }

  // ---------------------------------------------------------------------------------------------------------------

  private async beginFile(resolved: ResolvedPath, input: PayloadOf<'file.download.begin'>, conn: ClientConnection, principal: Principal): Promise<DownloadStart> {
    const file = await this.ctx.paths.openRead(resolved, { principal, mustExist: true });
    let st: BigIntStats;
    try {
      st = await file.handle.stat({ bigint: true });
    } catch (err) {
      await file.close();
      throw err;
    }
    const etag = etagOf(st);
    const size = Number(st.size);
    const offset = input.offset ?? 0;
    if (input.ifMatch !== undefined && input.ifMatch !== etag) {
      await file.close();
      throw new SmurgError('conflict', msg('download.changedSinceLast'), { reason: 'changed', etag });
    }
    if (offset > size) {
      await file.close();
      throw new SmurgError('bad_request', msg('download.offsetBeyondEnd'), { reason: 'offset' });
    }
    const state = this.register(conn, () => void file.close().catch(() => {}));
    this.audit(principal, resolved, { zip: false, offset, size });
    return {
      result: { downloadId: state.id, name: this.nameFor(resolved, false), size, etag, zip: false },
      start: () => this.run(state, () => this.pumpFile(state, file, offset, size, etag)),
    };
  }

  private beginZip(resolved: ResolvedPath, conn: ClientConnection, principal: Principal): DownloadStart {
    let source: ZipSource | null = null;
    const state = this.register(conn, () => source?.cancel());
    this.audit(principal, resolved, { zip: true });
    return {
      result: { downloadId: state.id, name: this.nameFor(resolved, true), zip: true },
      start: () =>
        this.run(state, async () => {
          const privileged = principal.kind === 'system' || isHostPrincipal(principal);
          source = createZipSource({
            paths: this.ctx.paths,
            principal,
            base: resolved,
            excludeTopSmurg: resolved.ref.root.kind === 'main' && resolved.ref.path === '',
            privileged,
          });
          await this.pumpZip(state, source);
        }),
    };
  }

  private register(conn: ClientConnection, cleanup: () => void): ActiveDownload {
    const state: ActiveDownload = { id: newId('dl'), conn, outstanding: new Set(), wake: null, bytes: 0, cancelled: false, started: false, startTimer: null, cleanup };
    state.startTimer = setTimeout(() => {
      if (!state.started) this.finish(state);
    }, START_TIMEOUT_MS);
    state.startTimer.unref?.();
    this.active.set(state.id, state);
    return state;
  }

  /** Runs a pump after `.ok` went out; any failure after that ends the download with a typed `end.error`. */
  private run(state: ActiveDownload, pump: () => Promise<void>): void {
    if (state.cancelled || state.started) return;
    state.started = true;
    if (state.startTimer !== null) clearTimeout(state.startTimer);
    state.startTimer = null;
    void pump()
      .catch((err: unknown) => {
        if (state.cancelled) return;
        const error = SmurgError.wrap(err);
        if (error.code === 'internal') this.ctx.log.warn('download failed', { error: err instanceof Error ? err.name : 'unknown' });
        this.ctx.hub.send(state.conn, 'file.download.end', { downloadId: state.id, totalBytes: state.bytes, skipped: [], zip64: false, error: error.toPayload() });
      })
      .finally(() => this.finish(state));
  }

  private async pumpFile(state: ActiveDownload, file: GuardedFile, offset: number, size: number, etag: string): Promise<void> {
    const chunkSize = this.ctx.settings.get().uploadChunkSize;
    let position = offset;
    let index = 0;
    while (position < size) {
      if (!(await this.waitForCredit(state))) return;
      const want = Math.min(chunkSize, size - position);
      const buffer = Buffer.allocUnsafe(want);
      let filled = 0;
      while (filled < want) {
        const { bytesRead } = await file.handle.read(buffer, filled, want - filled, position + filled);
        if (bytesRead === 0) break;
        filled += bytesRead;
      }
      if (filled === 0) throw new SmurgError('conflict', msg('download.shrunk'), { reason: 'changed' });
      if (!this.sendChunk(state, index, position, buffer.subarray(0, filled))) return;
      position += filled;
      index++;
    }
    const after = await file.handle.stat({ bigint: true });
    if (etagOf(after) !== etag) throw new SmurgError('conflict', msg('download.changedDuring'), { reason: 'changed' });
    this.ctx.hub.send(state.conn, 'file.download.end', { downloadId: state.id, totalBytes: position - offset, skipped: [], zip64: false });
  }

  private async pumpZip(state: ActiveDownload, source: ZipSource): Promise<void> {
    const chunkSize = this.ctx.settings.get().uploadChunkSize;
    let total = 0;
    let index = 0;
    for await (const chunk of rechunk(source.output, chunkSize)) {
      if (!(await this.waitForCredit(state))) return;
      if (!this.sendChunk(state, index, total, chunk)) return;
      total += chunk.byteLength;
      index++;
    }
    if (state.cancelled) return;
    this.ctx.hub.send(state.conn, 'file.download.end', {
      downloadId: state.id,
      totalBytes: total,
      skipped: source.skipped.map((s) => ({ path: s.path, reason: s.reason })),
      zip64: source.zip64 || total > ZIP32_LIMIT,
    });
  }

  private sendChunk(state: ActiveDownload, index: number, offset: number, data: Uint8Array): boolean {
    if (state.cancelled) return false;
    state.outstanding.add(index);
    const sent = this.ctx.hub.send(state.conn, 'file.download.chunk', { downloadId: state.id, index, offset, data });
    if (sent) state.bytes += data.byteLength;
    else this.finish(state); // the connection is gone (or may no longer receive downloads)
    return sent;
  }

  /** Waits for the client's credit (ack window) and for the daemon's socket buffer to drain. */
  private async waitForCredit(state: ActiveDownload): Promise<boolean> {
    while (!state.cancelled && state.outstanding.size >= TRANSFER_WINDOW_CHUNKS) {
      await new Promise<void>((resolve) => {
        state.wake = resolve;
      });
    }
    while (!state.cancelled && state.conn.bufferedAmount > TRANSFER_BUFFERED_AMOUNT_MAX) await sleep(TRANSFER_BUFFERED_POLL_MS);
    return !state.cancelled && state.conn.isOpen;
  }

  private wake(state: ActiveDownload): void {
    const wake = state.wake;
    state.wake = null;
    wake?.();
  }

  private finish(state: ActiveDownload): void {
    if (this.active.get(state.id) !== state) return;
    this.active.delete(state.id);
    state.cancelled = true;
    if (state.startTimer !== null) clearTimeout(state.startTimer);
    state.startTimer = null;
    this.wake(state);
    try {
      state.cleanup();
    } catch {
      // closing twice is harmless
    }
  }

  private nameFor(resolved: ResolvedPath, zip: boolean): string {
    let base = resolved.name;
    if (base === '') base = resolved.ref.root.kind === 'main' ? this.ctx.workspace.info.name : `worktree-${resolved.ref.root.worktreeId}`;
    const name = zip ? `${base}.zip` : base;
    const checked = pathSegmentSchema.safeParse(name);
    return checked.success ? checked.data : zip ? 'download.zip' : 'download';
  }

  private audit(principal: Principal, resolved: ResolvedPath, detail: Readonly<Record<string, unknown>>): void {
    this.ctx.audit.record({ actor: principal.actor, action: 'file.download', outcome: 'ok', target: refLabel(resolved.ref), detail });
  }
}
