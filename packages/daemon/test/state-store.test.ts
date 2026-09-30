// StateStore (ARCHITECTURE §7.1): 0700 directory, 0600 files regardless of the umask, atomic serialized writes,
// schema validation on load, and refusal (never repair) of anything insecure or corrupt.
import { chmod, lstat, mkdir, readFile, readdir, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { silentLogger } from '../src/core/logger.ts';
import { FileStateStore, StateFileError } from '../src/core/state-store.ts';
import { createTempDir, removeTempDir } from '../src/testing/temp.ts';

const schema = z.strictObject({ count: z.int().min(0), names: z.array(z.string()) });
const init = () => ({ count: 0, names: [] as string[] });

let base: string;
let previousUmask: number;

beforeEach(async () => {
  base = await createTempDir('state');
  // A permissive umask must not produce world-readable state (forks pool: this process only).
  previousUmask = process.umask(0);
});

afterEach(async () => {
  process.umask(previousUmask);
  await removeTempDir(base);
});

const mode = async (path: string): Promise<string> => ((await lstat(path)).mode & 0o777).toString(8);

describe('FileStateStore', () => {
  it('creates the directory 0700 and documents 0600, even under umask 000', async () => {
    const dir = join(base, 'smurg', 'workspaces', 'ws_test_0123456789');
    const store = await FileStateStore.open(dir, silentLogger);
    const doc = await store.document('things', schema, init);
    doc.update((d) => {
      d.count = 1;
    });
    await doc.flush();
    expect(await mode(dir)).toBe('700');
    expect(await mode(join(base, 'smurg'))).toBe('700');
    expect(await mode(join(dir, 'things.json'))).toBe('600');
    expect(JSON.parse(await readFile(join(dir, 'things.json'), 'utf8'))).toEqual({ count: 1, names: [] });
    const dirMode = await store.privateDir('uploads');
    expect(await mode(dirMode)).toBe('700');
  });

  it('serializes and coalesces writes; the file always ends with the latest value and no temp files remain', async () => {
    const store = await FileStateStore.open(join(base, 's'), silentLogger);
    const doc = await store.document('things', schema, init);
    for (let i = 1; i <= 200; i++) {
      doc.update((d) => {
        d.count = i;
        d.names.push(`n${i}`);
      });
    }
    await store.flush();
    const onDisk = JSON.parse(await readFile(join(base, 's', 'things.json'), 'utf8'));
    expect(onDisk.count).toBe(200);
    expect(onDisk.names).toHaveLength(200);
    expect((await readdir(join(base, 's'))).filter((n) => n.endsWith('.tmp'))).toEqual([]);
  });

  it('returns frozen snapshots and refuses an update that breaks the schema', async () => {
    const store = await FileStateStore.open(join(base, 's'), silentLogger);
    const doc = await store.document('things', schema, init);
    expect(Object.isFrozen(doc.get())).toBe(true);
    expect(() => doc.update((d) => ({ ...d, count: -1 }))).toThrow(StateFileError);
    expect(doc.get().count).toBe(0);
  });

  it('reloads what it wrote, validated', async () => {
    const dir = join(base, 's');
    const store = await FileStateStore.open(dir, silentLogger);
    (await store.document('things', schema, init)).update((d) => {
      d.names.push('kept');
    });
    await store.flush();
    const again = await FileStateStore.open(dir, silentLogger);
    expect((await again.document('things', schema, init)).get()).toEqual({ count: 0, names: ['kept'] });
  });

  it('refuses (and never rewrites) a corrupt or schema-mismatched file', async () => {
    const dir = join(base, 's');
    await mkdir(dir, { mode: 0o700 });
    await writeFile(join(dir, 'bad.json'), '{"count": ', { mode: 0o600 });
    await writeFile(join(dir, 'odd.json'), '{"count": 1, "names": [], "extra": true}', { mode: 0o600 });
    const store = await FileStateStore.open(dir, silentLogger);
    await expect(store.document('bad', schema, init)).rejects.toThrow(/not valid JSON/);
    await expect(store.document('odd', schema, init)).rejects.toThrow(/does not match its schema/);
    expect(await readFile(join(dir, 'bad.json'), 'utf8')).toBe('{"count": ');
  });

  it('refuses a group/other-readable file, a symlinked file and an insecure directory', async () => {
    const dir = join(base, 's');
    await mkdir(dir, { mode: 0o700 });
    await writeFile(join(dir, 'open.json'), JSON.stringify(init()), { mode: 0o644 });
    await chmod(join(dir, 'open.json'), 0o644);
    await writeFile(join(base, 'elsewhere.json'), JSON.stringify(init()), { mode: 0o600 });
    await symlink(join(base, 'elsewhere.json'), join(dir, 'linked.json'));
    const store = await FileStateStore.open(dir, silentLogger);
    await expect(store.document('open', schema, init)).rejects.toThrow(/grants group\/other access/);
    await expect(store.document('linked', schema, init)).rejects.toThrow(/symlink/);
    const loose = join(base, 'loose');
    await mkdir(loose, { mode: 0o755 });
    await chmod(loose, 0o755);
    await expect(FileStateStore.open(loose, silentLogger)).rejects.toThrow(/group\/other/);
  });

  describe('a write the disk refuses (review REL-14: disk full, EIO, permissions)', () => {
    const until = async (predicate: () => Promise<boolean>, timeoutMs = 5_000): Promise<void> => {
      const deadline = Date.now() + timeoutMs;
      while (!(await predicate())) {
        if (Date.now() > deadline) throw new Error('timed out');
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    };
    const onDisk = async (dir: string): Promise<unknown> => JSON.parse(await readFile(join(dir, 'things.json'), 'utf8'));

    it('is re-written by itself once the disk takes it, without any further update', async () => {
      const dir = join(base, 's');
      const store = await FileStateStore.open(dir, silentLogger);
      const doc = await store.document('things', schema, init);
      const health: string[] = [];
      store.onHealthChange((e) => health.push(`${e.document}:${e.ok}`));
      await chmod(dir, 0o500); // "disk full"
      try {
        doc.update((d) => {
          d.names.push('kicked');
        });
        await expect(doc.flush()).rejects.toMatchObject({ code: 'EACCES' });
        expect(store.unsaved()).toEqual([expect.objectContaining({ name: 'things', error: 'EACCES' })]);
        expect(doc.get().names).toEqual(['kicked']); // in force in memory (fail closed while running)
      } finally {
        await chmod(dir, 0o700); // space freed
      }
      // Nothing else changes the document: the store's own retry must write it.
      // Wait for the store's verdict, then look at the disk - not the other way round. The file appears at the
      // rename, but the store reports the document as saved only once the write is durable (the directory fsync
      // follows the rename); checking unsaved() the moment the file shows up failed under load.
      await until(async () => store.unsaved().length === 0);
      expect(((await onDisk(dir)) as { names: string[] }).names).toEqual(['kicked']);
      expect(health).toEqual(['things:false', 'things:true']);
      await doc.flush();
      const again = await FileStateStore.open(dir, silentLogger);
      expect((await again.document('things', schema, init)).get().names).toEqual(['kicked']);
      store.close();
    });

    it('flush() attempts the write again every time and reports each failure, not a stale error once', async () => {
      const dir = join(base, 's');
      const store = await FileStateStore.open(dir, silentLogger);
      const doc = await store.document('things', schema, init);
      await chmod(dir, 0o500);
      try {
        doc.update((d) => {
          d.count = 7;
        });
        await expect(doc.flush()).rejects.toMatchObject({ code: 'EACCES' });
        // The old code reported the error to the first caller only; a second flush then "succeeded" without writing.
        await expect(doc.flush()).rejects.toMatchObject({ code: 'EACCES' });
        await expect(store.flush()).rejects.toMatchObject({ code: 'EACCES' });
      } finally {
        await chmod(dir, 0o700);
      }
      await doc.flush(); // writes now, without waiting for the backoff
      expect(await onDisk(dir)).toEqual({ count: 7, names: [] });
      expect(store.unsaved()).toEqual([]);
      store.close();
    });
  });

  it('rejects invalid document names (no path tricks)', async () => {
    const store = await FileStateStore.open(join(base, 's'), silentLogger);
    await expect(store.document('../escape', schema, init)).rejects.toThrow(TypeError);
    await expect(store.privateDir('a/b')).rejects.toThrow(TypeError);
  });
});
