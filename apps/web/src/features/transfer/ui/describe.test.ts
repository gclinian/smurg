// Descriptions of transfer state: progress with speed and time left, the disk refusal with its numbers, the
// honest storage messages, zip notes.
import { msg, renderEnglish } from '@smurg/protocol/i18n';
import { describe, expect, it } from 'vitest';
import { applyLocale } from '../../../lib/locale.ts';
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
    expect(describeProgress(job())).toEqual({ bytes: '2.5 GB of 10 GB', files: null, speed: '40 MB/s', remaining: 'About 4 minutes left', percent: 25 });
  });

  it('shows the file count for folders, no speed while paused, and an unknown total for zips', () => {
    expect(describeProgress(job({ files: 12, filesDone: 5, status: 'paused', pause: 'offline' }))).toMatchObject({ files: '5 of 12 files', speed: null, remaining: null });
    expect(describeProgress(job({ kind: 'download', totalBytes: null, doneBytes: 3 * MiB }))).toMatchObject({ bytes: '3 MB done', percent: null, remaining: null });
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
    expect(text).toBe("The host's disk does not have enough space, so the upload did not start: it needs 10 GB, which would leave only 18 GB, less than the reserved 23 GB (29 GB available now, 1 GB set aside for other uploads in progress). The host can change the reserved space in the settings.");
    expect(describeFailure({ kind: 'disk', midway: true, disk: null })).toContain('Once space is freed, press "Retry"');
  });

  it('is honest about what the browser cannot store', () => {
    expect(describeFailure({ kind: 'storage', reason: 'too-large-for-memory', neededBytes: 2 * GiB, availableBytes: 512 * MiB })).toBe(
      'This browser can only keep downloads of up to 512 MB in memory, and this file is 2 GB. Use Chrome (it saves straight to disk), or download with the smurg CLI.',
    );
    expect(describeFailure({ kind: 'storage', reason: 'quota', neededBytes: 12 * GiB, availableBytes: 10 * GiB })).toContain('12 GB needed, 10 GB left');
    expect(describeFailure({ kind: 'storage', reason: 'short-write', neededBytes: 1, availableBytes: 0 })).toContain('out of storage');
  });

  it('shows the host\'s own words: its message reference in the language of the viewer, else its English message', () => {
    const locked = { code: 'locked', message: 'Amy is editing this file.', text: msg('file.lockedByPeople', { names: ['Amy'] }) } as const;
    expect(describeFailure({ kind: 'daemon', error: locked })).toBe(renderEnglish(locked.text));
    applyLocale('zh-TW');
    expect(describeFailure({ kind: 'daemon', error: locked })).toBe('Amy 正在編輯這個檔案');
    applyLocale('en');
    // A reference this build does not know (a newer host): the English message it came with.
    expect(describeFailure({ kind: 'daemon', error: { code: 'locked', message: 'A newer sentence.', text: { id: 'file.notInThisBuild' } } })).toBe('A newer sentence.');
    expect(describeFailure({ kind: 'daemon', error: { code: 'internal', message: 'Something went wrong on the host.' } })).toBe('Something went wrong on the host.');
    expect(describeFailure({ kind: 'connection-ended', state: 'closed:kicked' })).toBe('The host removed you from the workspace; the transfer was stopped.');
  });
});

describe('the rest', () => {
  it('status, target, durations and zip skip reasons', () => {
    expect(describeStatus(job({ status: 'paused', pause: 'offline' }))).toBe('Connection lost; continues by itself when it is back');
    expect(describeStatus(job({ verifying: true }))).toBe("Checking what the host's computer already has");
    expect(describeTarget(job({ path: '' }))).toBe('Upload to the project root');
    expect(describeTarget(job({ kind: 'download', path: 'src/app.ts' }))).toBe('From src/app.ts');
    expect(describeDuration(42_000)).toBe('42 seconds');
    expect(describeDuration(3 * 3_600_000 + 5 * 60_000)).toBe('4 hours');
    expect(describeDuration(400)).toBe('1 second');
    expect(describeSkip('open:ENOENT')).toContain('but empty');
    expect(describeSkip('special-file')).toContain('FIFO');
    expect(describeSkip('symlink-outside-folder')).toContain('Link that points outside the folder');
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

describe('orderTransfers', () => {
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
