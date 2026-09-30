// The disk-space rule of uploads (SPEC R7 / D15, ARCHITECTURE §5.2, transfer.md §1.5):
//
//   reserve = max(diskReserveBytes, diskReservePercent % × total)
//   accept  ⇔ available − pendingOther − requested ≥ reserve
//
// `available` is statfs bavail × bsize (what an unprivileged process may use), `pendingOther` the bytes other uploads
// on the same volume still have to write (planned batches included), never the upload being checked (the spike
// charged a resumed upload twice). statfs is injectable so tests can simulate a nearly full disk.
import { stat, statfs } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { DiskReport } from '@smurg/protocol';
import { errnoCode } from '../workspace/fs-util.ts';
import { formatBytes } from './util.ts';

export interface StatfsResult {
  /** Unit of `blocks` and `bavail`. */
  readonly bsize: number | bigint;
  readonly blocks: number | bigint;
  readonly bavail: number | bigint;
}

/** `fs.statfs` or a test double. */
export type StatfsFunction = (path: string) => Promise<StatfsResult>;

export const nodeStatfs: StatfsFunction = (path) => statfs(path, { bigint: true });

export interface DiskSettings {
  readonly diskReserveBytes: number;
  readonly diskReservePercent: number;
}

/** The deepest existing ancestor of `absPath` (the upload target does not exist yet) and its device. */
export async function probeVolume(absPath: string): Promise<{ readonly path: string; readonly dev: number }> {
  let probe = absPath;
  for (;;) {
    try {
      const st = await stat(probe);
      return { path: probe, dev: st.dev };
    } catch (err) {
      const code = errnoCode(err);
      const parent = dirname(probe);
      if ((code !== 'ENOENT' && code !== 'ENOTDIR') || parent === probe) throw err;
      probe = parent;
    }
  }
}

function toSafeNumber(value: bigint): number {
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) return Number.MAX_SAFE_INTEGER;
  if (value < BigInt(Number.MIN_SAFE_INTEGER)) return Number.MIN_SAFE_INTEGER;
  return Number(value);
}

/** The decision itself, on one statfs snapshot (pure, so it can be tested exactly). */
export function diskReport(snapshot: StatfsResult, settings: DiskSettings, pendingBytes: number, requestedBytes: number): DiskReport {
  const bsize = BigInt(snapshot.bsize);
  const total = BigInt(snapshot.blocks) * bsize;
  const available = BigInt(snapshot.bavail) * bsize;
  // Percent with two decimals, in integer arithmetic (a 460 GiB disk × 5 % must not drift by a float rounding).
  const percentReserve = (total * BigInt(Math.round(settings.diskReservePercent * 100))) / 10_000n;
  const fixedReserve = BigInt(Math.max(0, Math.floor(settings.diskReserveBytes)));
  const reserve = fixedReserve > percentReserve ? fixedReserve : percentReserve;
  const pending = BigInt(Math.max(0, Math.floor(pendingBytes)));
  const requested = BigInt(Math.max(0, Math.floor(requestedBytes)));
  const freeAfter = available - pending - requested;
  return {
    totalBytes: toSafeNumber(total),
    availableBytes: toSafeNumber(available),
    reserveBytes: toSafeNumber(reserve),
    pendingBytes: toSafeNumber(pending),
    requestedBytes: toSafeNumber(requested),
    freeAfterBytes: toSafeNumber(freeAfter),
    ok: freeAfter >= reserve,
  };
}

/** The zh-TW explanation shown with `insufficient_disk` (the numbers are also in `detail.disk`). */
export function insufficientDiskMessage(report: DiskReport): string {
  return (
    `主人的磁碟空間不足，上傳尚未開始：需要 ${formatBytes(report.requestedBytes)}，` +
    `上傳後只剩 ${formatBytes(report.freeAfterBytes)}，低於保留空間 ${formatBytes(report.reserveBytes)}` +
    `（目前可用 ${formatBytes(report.availableBytes)}，其他進行中的上傳預留 ${formatBytes(report.pendingBytes)}）。` +
    '主人可以在設定中調整保留空間。'
  );
}
