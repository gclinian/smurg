// @vitest-environment node
// Download writers (transfer.md §1.7, gotcha 20): the storage estimate first, every write's return value, the final
// size; simulated quota exhaustion and short writes; the in-memory limit; the save-picker writable.
import { describe, expect, it } from 'vitest';
import { BOGUS_WRITE_COUNT, FakeOpfs, FakeSaveHandle } from '../testing/fake-storage.ts';
import { StorageError } from './failures.ts';
import { syntheticBytes } from './synthetic-source.ts';
import { MemoryWriter, OPFS_MARGIN_BYTES, OpfsWriter, PickerWriter, openAutoWriter, sweepOpfsDownloads } from './writers.ts';

const KiB = 1024;
const MiB = 1024 * KiB;

async function writeAll(writer: { write(offset: number, data: Uint8Array): Promise<void> }, bytes: Uint8Array, chunk = 256 * KiB): Promise<void> {
  for (let at = 0; at < bytes.byteLength; at += chunk) await writer.write(at, bytes.subarray(at, at + chunk));
}

async function blobBytes(blob: Blob): Promise<Uint8Array> {
  return new Uint8Array(await blob.arrayBuffer());
}

describe('OpfsWriter (Firefox / Safari fallback)', () => {
  it('stages the download in OPFS and returns a File of exactly the expected size', async () => {
    const opfs = new FakeOpfs();
    const writer = new OpfsWriter(opfs, 'dl_1-report.pdf');
    const bytes = syntheticBytes(1, 0, MiB + 5);
    await writer.prepare(bytes.byteLength);
    await writeAll(writer, bytes);
    const output = await writer.finish(bytes.byteLength);
    expect(output.kind).toBe('blob');
    expect(output.kind === 'blob' ? await blobBytes(output.blob) : null).toEqual(bytes);
  });

  it('refuses before the first byte when the storage estimate is too small', async () => {
    const opfs = new FakeOpfs({ quota: 100 * MiB, usage: 0 });
    const writer = new OpfsWriter(opfs, 'big');
    const error = await writer.prepare(100 * MiB - OPFS_MARGIN_BYTES + 1).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(StorageError);
    expect(error).toMatchObject({ reason: 'quota', neededBytes: 100 * MiB - OPFS_MARGIN_BYTES + 1, availableBytes: 100 * MiB });
    expect(opfs.files.size).toBe(0);
  });

  it('detects quota exhaustion that does not throw (write() returns 2^32 − 8, the file stops growing)', async () => {
    // A zip (size unknown) cannot be checked up front: the per-write check must catch it.
    const opfs = new FakeOpfs({ capacity: 600 * KiB });
    const writer = new OpfsWriter(opfs, 'archive.zip');
    await writer.prepare(null);
    const bytes = syntheticBytes(2, 0, MiB);
    const error = await writeAll(writer, bytes).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(StorageError);
    expect(error).toMatchObject({ reason: 'short-write', neededBytes: 768 * KiB, availableBytes: 512 * KiB });
    expect(opfs.writes).toBe(3);
    await writer.abort();
    expect(opfs.files.size).toBe(0); // the partial copy is removed
    expect(BOGUS_WRITE_COUNT).toBe(2 ** 32 - 8);
  });

  it('detects a short write (fewer bytes stored than handed over)', async () => {
    const opfs = new FakeOpfs({ shortBy: 1 });
    const writer = new OpfsWriter(opfs, 'x');
    await writer.prepare(10);
    await expect(writer.write(0, new Uint8Array(10))).rejects.toMatchObject({ reason: 'short-write', availableBytes: 9 });
  });

  it('maps a thrown QuotaExceededError to a quota failure', async () => {
    const opfs = new FakeOpfs({ capacity: 100, throwOnFull: true });
    const writer = new OpfsWriter(opfs, 'x');
    await writer.prepare(null);
    await expect(writer.write(0, new Uint8Array(200))).rejects.toMatchObject({ name: 'StorageError', reason: 'quota' });
  });

  it('checks the final size against what the daemon said it sent', async () => {
    const opfs = new FakeOpfs();
    const writer = new OpfsWriter(opfs, 'x');
    await writer.prepare(null);
    await writer.write(0, new Uint8Array(100));
    await expect(writer.finish(101)).rejects.toMatchObject({ reason: 'size-mismatch', neededBytes: 101, availableBytes: 100 });
  });

  it('refuses a gap between writes instead of saving a file with holes', async () => {
    const writer = new OpfsWriter(new FakeOpfs(), 'x');
    await writer.prepare(null);
    await writer.write(0, new Uint8Array(10));
    await expect(writer.write(20, new Uint8Array(10))).rejects.toMatchObject({ reason: 'write-failed' });
  });

  it('reset() starts a restarted zip from zero in the same file', async () => {
    const opfs = new FakeOpfs();
    const writer = new OpfsWriter(opfs, 'z.zip');
    await writer.prepare(null);
    await writer.write(0, new Uint8Array([1, 2, 3]));
    await writer.reset();
    await writer.write(0, new Uint8Array([4, 5]));
    const output = await writer.finish(2);
    expect(output.kind === 'blob' ? await blobBytes(output.blob) : null).toEqual(new Uint8Array([4, 5]));
  });

  it('removes staged copies older than an hour at start, and leaves recent or open ones alone', async () => {
    let now = 1_000_000;
    const opfs = new FakeOpfs({ now: () => now });
    const old = new OpfsWriter(opfs, 'old');
    await old.prepare(null);
    await old.write(0, new Uint8Array(1));
    await old.finish(1);
    const open = new OpfsWriter(opfs, 'open');
    await open.prepare(null);
    now += 2 * 60 * 60 * 1000;
    const recent = new OpfsWriter(opfs, 'recent');
    await recent.prepare(null);
    await recent.write(0, new Uint8Array(1));
    await recent.finish(1);
    expect(await sweepOpfsDownloads(opfs, now)).toBe(1);
    expect([...opfs.files.keys()].sort()).toEqual(['open', 'recent']);
  });
});

describe('MemoryWriter (last resort)', () => {
  it('assembles a Blob up to the limit', async () => {
    const writer = new MemoryWriter(MiB);
    const bytes = syntheticBytes(3, 0, MiB);
    await writer.prepare(bytes.byteLength);
    await writeAll(writer, bytes);
    const output = await writer.finish(MiB);
    expect(output.kind === 'blob' ? await blobBytes(output.blob) : null).toEqual(bytes);
  });

  it('refuses a file above the limit before the first byte, and a zip that grows above it midway', async () => {
    await expect(new MemoryWriter(MiB).prepare(MiB + 1)).rejects.toMatchObject({ reason: 'too-large-for-memory', neededBytes: MiB + 1, availableBytes: MiB });
    const zip = new MemoryWriter(MiB);
    await zip.prepare(null);
    await expect(writeAll(zip, new Uint8Array(MiB + 10))).rejects.toMatchObject({ reason: 'too-large-for-memory' });
  });
});

describe('openAutoWriter', () => {
  it('uses OPFS when it has room', async () => {
    expect((await openAutoWriter({ opfs: new FakeOpfs() }, 'a', 10)).savedAs).toBe('opfs');
  });

  it('falls back to memory when OPFS is too small and the file fits the in-memory limit', async () => {
    const writer = await openAutoWriter({ opfs: new FakeOpfs({ quota: 10 * MiB }), memoryLimit: 64 * MiB }, 'a', 20 * MiB);
    expect(writer.savedAs).toBe('memory');
  });

  it('says honestly that it cannot store a file bigger than both', async () => {
    const error = await openAutoWriter({ opfs: new FakeOpfs({ quota: 10 * MiB }), memoryLimit: 64 * MiB }, 'a', 65 * MiB).catch((e: unknown) => e);
    expect(error).toMatchObject({ reason: 'quota', neededBytes: 65 * MiB });
    const noOpfs = await openAutoWriter({ opfs: null, memoryLimit: 64 * MiB }, 'a', 65 * MiB).catch((e: unknown) => e);
    expect(noOpfs).toMatchObject({ reason: 'too-large-for-memory', neededBytes: 65 * MiB, availableBytes: 64 * MiB });
  });
});

describe('PickerWriter (showSaveFilePicker + createWritable)', () => {
  it('writes each chunk at its offset into the chosen file and checks the saved size', async () => {
    const handle = new FakeSaveHandle();
    const writer = new PickerWriter(handle);
    const bytes = syntheticBytes(4, 0, MiB + 3);
    await writer.prepare(bytes.byteLength);
    await writeAll(writer, bytes);
    expect(await writer.finish(bytes.byteLength)).toEqual({ kind: 'saved' });
    expect(handle.data).toEqual(bytes);
  });

  it('maps a full disk (QuotaExceededError) to a quota failure and discards the writable on abort', async () => {
    const handle = new FakeSaveHandle();
    handle.capacity = 100;
    const writer = new PickerWriter(handle);
    await writer.prepare(null);
    await expect(writer.write(0, new Uint8Array(200))).rejects.toMatchObject({ reason: 'quota' });
    await writer.abort();
    expect(handle.aborted).toBe(1);
    expect(handle.closed).toBe(0);
  });
});
