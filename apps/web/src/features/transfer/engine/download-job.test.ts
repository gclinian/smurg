// @vitest-environment node
// DownloadJob against the fake transfer link: single file and folder-as-zip, the writers, resume by offset after a
// reconnect, zip restart, changed-on-host, storage failures, cancel, the skipped list and the zip64 flag.
import { SmurgError } from '@smurg/protocol';
import { describe, expect, it } from 'vitest';
import { FakeDaemonState, FakeTransferLink } from '../testing/fake-link.ts';
import { FakeOpfs, FakeSaveHandle } from '../testing/fake-storage.ts';
import { DownloadJob, type DownloadJobSpec } from './download-job.ts';
import { Semaphore } from './limits.ts';
import { syntheticBytes } from './synthetic-source.ts';
import type { WriterEnv } from './writers.ts';

const KiB = 1024;
const MAIN = { kind: 'main' } as const;

function setup(writers: WriterEnv = { opfs: null }) {
  const daemon = new FakeDaemonState({ downloadChunkSize: 256 * KiB });
  const link = new FakeTransferLink({ daemon });
  const outputs: Blob[] = [];
  const job = (spec: Partial<DownloadJobSpec> & Pick<DownloadJobSpec, 'file'>): DownloadJob =>
    new DownloadJob(
      { id: 'dl1', zip: false, name: spec.file.path, ...spec },
      { link, slots: new Semaphore(2), writers, onChange: () => {}, onOutput: (_job, output) => outputs.push(output.blob) },
    );
  return { daemon, link, outputs, job };
}

async function bytesOf(blob: Blob | undefined): Promise<Uint8Array> {
  if (!blob) throw new Error('no output');
  return new Uint8Array(await blob.arrayBuffer());
}

async function until(predicate: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe('DownloadJob — single file', () => {
  it('downloads a file in chunks, acknowledging each after it was stored, and hands the page a Blob of it', async () => {
    const { daemon, link, outputs, job } = setup();
    const content = syntheticBytes(1, 0, 900 * KiB);
    daemon.put(MAIN, 'report.pdf', content);
    const download = job({ file: { root: MAIN, path: 'report.pdf' } });
    download.start();
    await download.whenSettled();
    expect(download.snapshot()).toMatchObject({ status: 'done', name: 'report.pdf', totalBytes: 900 * KiB, doneBytes: 900 * KiB, download: { savedAs: 'memory', zip64: false, skipped: [] } });
    expect(await bytesOf(outputs[0])).toEqual(content);
    expect(link.acks.map((a) => a.index)).toEqual([0, 1, 2, 3]);
    // Credit is returned only after the chunk was handled.
    expect(link.events.filter((e) => /^(handled|ack) 1$/.test(e))).toEqual(['handled 1', 'ack 1']);
  });

  it('saves through the picker handle when the person chose a file (no Blob for the page)', async () => {
    const { daemon, outputs, job } = setup();
    const content = syntheticBytes(2, 0, 300 * KiB);
    daemon.put(MAIN, 'a.bin', content);
    const handle = new FakeSaveHandle();
    const download = job({ file: { root: MAIN, path: 'a.bin' }, picker: handle });
    download.start();
    await download.whenSettled();
    expect(download.snapshot().download?.savedAs).toBe('picker');
    expect(handle.data).toEqual(content);
    expect(outputs).toHaveLength(0);
  });

  it('stages in OPFS where there is no picker', async () => {
    const opfs = new FakeOpfs();
    const { daemon, outputs, job } = setup({ opfs });
    const content = syntheticBytes(3, 0, 600 * KiB);
    daemon.put(MAIN, 'b.bin', content);
    const download = job({ file: { root: MAIN, path: 'b.bin' } });
    download.start();
    await download.whenSettled();
    expect(download.snapshot().download?.savedAs).toBe('opfs');
    expect(await bytesOf(outputs[0])).toEqual(content);
  });

  it('resumes by offset (with the etag) after the socket dropped, and never repeats what was stored', async () => {
    const { daemon, link, outputs, job } = setup();
    const content = syntheticBytes(4, 0, 1100 * KiB);
    daemon.put(MAIN, 'c.bin', content);
    link.dropDownloadAfter = 2;
    const download = job({ file: { root: MAIN, path: 'c.bin' } });
    download.start();
    await until(() => download.snapshot().status === 'paused', 'paused while offline');
    expect(download.snapshot()).toMatchObject({ pause: 'offline', doneBytes: 512 * KiB });
    link.goOnline();
    await download.whenSettled();
    const begins = link.requestsOf('file.download.begin');
    expect(begins).toHaveLength(2);
    expect(begins[1]).toMatchObject({ offset: 512 * KiB, ifMatch: expect.any(String) });
    expect(await bytesOf(outputs[0])).toEqual(content);
  });

  it('refuses to resume a file that changed on the host meanwhile', async () => {
    const { daemon, link, job } = setup();
    daemon.put(MAIN, 'd.bin', syntheticBytes(5, 0, 800 * KiB));
    link.dropDownloadAfter = 1;
    const download = job({ file: { root: MAIN, path: 'd.bin' } });
    download.start();
    await until(() => download.snapshot().status === 'paused', 'paused while offline');
    daemon.put(MAIN, 'd.bin', syntheticBytes(6, 0, 800 * KiB)); // new etag
    link.goOnline();
    await download.whenSettled();
    expect(download.snapshot()).toMatchObject({ status: 'failed', failure: { kind: 'changed-on-host' } });
  });

  it('fails with an honest storage message when the browser cannot hold the file, and keeps no partial copy', async () => {
    const opfs = new FakeOpfs({ capacity: 300 * KiB }); // the estimate looks fine, the disk fills up midway
    const { daemon, job } = setup({ opfs, memoryLimit: 1024 * KiB });
    daemon.put(MAIN, 'e.bin', syntheticBytes(7, 0, 700 * KiB));
    const download = job({ file: { root: MAIN, path: 'e.bin' } });
    download.start();
    await download.whenSettled();
    expect(download.snapshot()).toMatchObject({ status: 'failed', failure: { kind: 'storage', reason: 'short-write' } });
    expect(opfs.files.size).toBe(0);
  });

  it('cancel stops the download, tells the daemon and discards the partial result', async () => {
    const opfs = new FakeOpfs();
    const { daemon, link, job } = setup({ opfs });
    daemon.put(MAIN, 'f.bin', syntheticBytes(8, 0, 4096 * KiB));
    link.holdDownloadsAfter = 2;
    const download = job({ file: { root: MAIN, path: 'f.bin' } });
    download.start();
    await until(() => download.snapshot().doneBytes === 512 * KiB, 'two chunks');
    await download.cancel();
    link.releaseDownloads();
    expect(download.snapshot().status).toBe('cancelled');
    expect(link.notifications.some((n) => n.type === 'file.download.cancel')).toBe(true);
    expect(opfs.files.size).toBe(0);
  });
});

describe('DownloadJob — folders as zip', () => {
  it('reports the skipped entries and the zip64 flag of a folder download', async () => {
    const { daemon, outputs, job } = setup();
    daemon.put(MAIN, 'proj', 'dir');
    const zip = syntheticBytes(9, 0, 700 * KiB);
    const skipped = [
      { path: 'a-fifo', reason: 'special-file' },
      { path: 'gone.txt', reason: 'open:ENOENT' },
    ];
    daemon.zips.set(daemon.key(MAIN, 'proj'), { bytes: zip, skipped, zip64: true });
    const download = job({ file: { root: MAIN, path: 'proj' }, zip: true });
    download.start();
    await download.whenSettled();
    expect(download.snapshot()).toMatchObject({ status: 'done', name: 'proj.zip', download: { skipped, zip64: true, totalBytes: 700 * KiB } });
    expect(await bytesOf(outputs[0])).toEqual(zip);
  });

  it('starts a zip over from zero after a reconnect (zips are not resumable)', async () => {
    const { daemon, link, outputs, job } = setup();
    daemon.put(MAIN, 'proj', 'dir');
    const zip = syntheticBytes(10, 0, 900 * KiB);
    daemon.zips.set(daemon.key(MAIN, 'proj'), { bytes: zip, skipped: [], zip64: false });
    link.dropDownloadAfter = 2;
    const download = job({ file: { root: MAIN, path: 'proj' }, zip: true });
    download.start();
    await until(() => download.snapshot().status === 'paused', 'paused while offline');
    link.goOnline();
    await download.whenSettled();
    expect(download.zipRestarts).toBe(1);
    expect(link.requestsOf('file.download.begin').map((b) => b.offset)).toEqual([undefined, undefined]);
    expect(await bytesOf(outputs[0])).toEqual(zip);
  });

  it('a zip that failed on the host after it started ends typed (end.error)', async () => {
    const { daemon, link, job } = setup();
    daemon.put(MAIN, 'proj', 'dir');
    daemon.zips.set(daemon.key(MAIN, 'proj'), { bytes: syntheticBytes(11, 0, 900 * KiB), skipped: [], zip64: false });
    link.downloadErrorAfterChunks = { after: 1, error: new SmurgError('internal') };
    const download = job({ file: { root: MAIN, path: 'proj' }, zip: true });
    download.start();
    await download.whenSettled();
    expect(download.snapshot()).toMatchObject({ status: 'failed', failure: { kind: 'daemon', error: { code: 'internal' } } });
  });
});
