// zh-TW descriptions of transfer state: progress with speed and time left, the disk refusal with its numbers, the
// honest storage messages, zip notes.
import { describe, expect, it } from 'vitest';
import { RateMeter, remainingMs } from '../engine/rate.ts';
import type { JobSnapshot } from '../engine/types.ts';
import { describeDuration, describeFailure, describeProgress, describeSkip, describeStatus, describeTarget } from './describe.ts';

const GiB = 1024 ** 3;
const MiB = 1024 ** 2;

function job(patch: Partial<JobSnapshot> = {}): JobSnapshot {
  return {
    id: 'j',
    kind: 'upload',
    name: 'data.bin',
    root: { kind: 'main' },
    path: 'in',
    totalBytes: 10 * GiB,
    doneBytes: 2.5 * GiB,
    files: 1,
    filesDone: 0,
    status: 'running',
    pause: null,
    verifying: false,
    bytesPerSecond: 40 * MiB,
    failure: null,
    fileFailures: [],
    rejected: [],
    conflict: null,
    download: null,
    startedAt: 0,
    ...patch,
  };
}

describe('describeProgress', () => {
  it('shows bytes, speed and the time left while running', () => {
    expect(describeProgress(job())).toEqual({ bytes: '2.5 GB／10 GB', files: null, speed: '40 MB/秒', remaining: '剩餘約 3 分鐘', percent: 25 });
  });

  it('shows the file count for folders, no speed while paused, and an unknown total for zips', () => {
    expect(describeProgress(job({ files: 12, filesDone: 5, status: 'paused', pause: 'offline' }))).toMatchObject({ files: '5／12 個檔案', speed: null, remaining: null });
    expect(describeProgress(job({ kind: 'download', totalBytes: null, doneBytes: 3 * MiB }))).toMatchObject({ bytes: '已完成 3 MB', percent: null, remaining: null });
    expect(describeProgress(job({ totalBytes: 0, doneBytes: 0, status: 'done' })).percent).toBe(100);
  });
});

describe('describeFailure', () => {
  it('explains a disk refusal with the numbers and points the host to the setting', () => {
    const text = describeFailure({
      kind: 'disk',
      midway: false,
      disk: { totalBytes: 460 * GiB, availableBytes: 29 * GiB, reserveBytes: 23 * GiB, pendingBytes: 1 * GiB, requestedBytes: 10 * GiB, freeAfterBytes: 18 * GiB, ok: false },
    });
    expect(text).toBe('主人的磁碟空間不足，上傳尚未開始：需要 10 GB，上傳後只剩 18 GB，低於保留空間 23 GB（目前可用 29 GB，其他進行中的上傳預留 1 GB）。主人可以在設定中調整保留空間。');
    expect(describeFailure({ kind: 'disk', midway: true, disk: null })).toContain('騰出空間後按「重試」');
  });

  it('is honest about what the browser cannot store', () => {
    expect(describeFailure({ kind: 'storage', reason: 'too-large-for-memory', neededBytes: 2 * GiB, availableBytes: 512 * MiB })).toBe(
      '這個瀏覽器只能在記憶體中暫存 512 MB 以內的下載，而這個檔案有 2 GB。請改用 Chrome（可直接存到磁碟），或以 smurg CLI 下載。',
    );
    expect(describeFailure({ kind: 'storage', reason: 'quota', neededBytes: 12 * GiB, availableBytes: 10 * GiB })).toContain('需要 12 GB，只剩 10 GB');
    expect(describeFailure({ kind: 'storage', reason: 'short-write', neededBytes: 1, availableBytes: 0 })).toContain('儲存空間不足');
  });

  it('keeps the daemon\'s own zh-TW message and never shows an English one', () => {
    expect(describeFailure({ kind: 'daemon', error: { code: 'locked', message: '此檔案正由 Amy 編輯中' } })).toBe('此檔案正由 Amy 編輯中');
    expect(describeFailure({ kind: 'daemon', error: { code: 'internal', message: 'ENOENT: stack trace' } })).toBe('傳輸時發生未預期的錯誤。');
    expect(describeFailure({ kind: 'connection-ended', state: 'closed:kicked' })).toBe('你已被主人移出工作區，傳輸已停止。');
  });
});

describe('the rest', () => {
  it('status, target, durations and zip skip reasons', () => {
    expect(describeStatus(job({ status: 'paused', pause: 'offline' }))).toBe('連線中斷，恢復後會自動繼續');
    expect(describeStatus(job({ verifying: true }))).toBe('正在比對主人電腦上已有的部分');
    expect(describeTarget(job({ path: '' }))).toBe('上傳到專案根目錄');
    expect(describeTarget(job({ kind: 'download', path: 'src/app.ts' }))).toBe('來自 src/app.ts');
    expect(describeDuration(42_000)).toBe('42 秒');
    expect(describeDuration(3 * 3_600_000 + 5 * 60_000)).toBe('3 小時 5 分鐘');
    expect(describeSkip('open:ENOENT')).toContain('內容是空的');
    expect(describeSkip('special-file')).toContain('FIFO');
    expect(describeSkip('symlink-outside-folder')).toContain('連結');
  });
});

describe('RateMeter', () => {
  it('smooths the rate over samples and ignores bursts closer than the minimum interval', () => {
    let now = 0;
    const meter = new RateMeter({ now: () => now, halfLifeMs: 1_000, minIntervalMs: 250 });
    meter.sample(0);
    now = 10;
    meter.sample(100 * MiB); // a burst of acknowledgements: ignored (too close)
    expect(meter.bytesPerSecond).toBe(0);
    now = 1_000;
    meter.sample(40 * MiB);
    expect(meter.bytesPerSecond).toBeCloseTo(40 * MiB, -3);
    now = 2_000;
    meter.sample(60 * MiB); // slower: 20 MiB/s, weighted with a half-life of 1 s
    expect(meter.bytesPerSecond).toBeCloseTo(30 * MiB, -3);
    meter.sample(0); // a restart (zip) resets
    expect(meter.bytesPerSecond).toBe(0);
    expect(remainingMs(100 * MiB, 40 * MiB, 20 * MiB)).toBe(3_000);
    expect(remainingMs(null, 0, 1)).toBeNull();
  });
});

describe('orderTransfers (WEB-15)', () => {
  it('lists running, waiting and interrupted transfers before finished ones, newest first', async () => {
    const { orderTransfers } = await import('../index.tsx');
    const rows = [
      job({ id: 'old-done', status: 'done', startedAt: 1 }),
      job({ id: 'newer-done', status: 'done', startedAt: 5 }),
      job({ id: 'running', status: 'running', startedAt: 3 }),
      job({ id: 'failed-interrupted', status: 'failed', startedAt: 2 }),
      job({ id: 'queued', status: 'queued', startedAt: 4 }),
    ];
    expect(orderTransfers(rows, (row) => row.id === 'failed-interrupted').map((row) => row.id)).toEqual(['queued', 'running', 'failed-interrupted', 'newer-done', 'old-done']);
  });
});
