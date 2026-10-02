// An upgrade of the single executable leaves the old build's extracted native dir behind; a start of the new
// build removes other builds' dirs that were unused for NATIVE_KEEP_DAYS, and stale extraction temp dirs, and nothing
// else (not the current build, not a recently used one, not a file, not a symlink, not an unrelated name).
import { mkdir, readdir, symlink, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createTempDir, removeTempDir } from '@smurg/daemon/testing';
import { NATIVE_KEEP_DAYS, pruneNativeCache } from '../src/sea/native.ts';

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await removeTempDir(dir);
});

describe('pruneNativeCache', () => {
  it('removes old builds and stale temp dirs only', async () => {
    const root = await createTempDir('native-cache');
    dirs.push(root);
    const now = Date.now();
    const day = 86_400_000;
    const make = async (name: string, ageDays: number): Promise<void> => {
      await mkdir(join(root, name, 'node-pty'), { recursive: true });
      await writeFile(join(root, name, 'node-pty', 'pty.node'), 'x');
      const t = new Date(now - ageDays * day);
      await utimes(join(root, name), t, t);
    };
    await make('native-00000000000000aa', NATIVE_KEEP_DAYS + 5); // the current build, even if old: kept
    await make('native-11111111111111bb', NATIVE_KEEP_DAYS + 1); // an old build: removed
    await make('native-22222222222222cc', 2); // used recently: kept
    await make('.native-33333333333333dd-Ab12Cd', 3); // interrupted extraction: removed
    await make('.native-44444444444444ee-Zz99', 0); // an extraction running now: kept
    await make('other-thing', 400); // not ours: kept
    await writeFile(join(root, 'native-55555555555555ff'), 'a file'); // not a directory: kept
    const target = join(root, 'other-thing');
    await symlink(target, join(root, 'native-66666666666666aa')); // a symlink: kept (and never followed)
    const removed = pruneNativeCache(root, join(root, 'native-00000000000000aa'), now);
    expect(removed.sort()).toEqual(['.native-33333333333333dd-Ab12Cd', 'native-11111111111111bb']);
    expect((await readdir(root)).sort()).toEqual(
      ['.native-44444444444444ee-Zz99', 'native-00000000000000aa', 'native-22222222222222cc', 'native-55555555555555ff', 'native-66666666666666aa', 'other-thing'].sort(),
    );
    expect(await readdir(target)).toEqual(['node-pty']);
    expect(pruneNativeCache(join(root, 'missing'), 'x', now)).toEqual([]);
  });
});
