// createTempRunDir must hand out a directory in which EVERY socket of a daemon fits, whatever TMPDIR is. The real
// sandbox tests passed under a short TMPDIR and refused to start under macOS's default one (/var/folders/…/T plus the
// test runner's per-run root), because the budget covered the daemon's hook socket but not srt's longer proxy sockets.
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { assertSocketPath, SOCKET_PATH_MAX_BYTES } from '../src/core/sockets.ts';
import { srtSocketDirProblem } from '../src/sandbox/checks.ts';
import { createTempRunDir, removeTempRunDir } from '../src/testing/index.ts';

const LARGEST_PID = 9_999_999;
const HOOK_SOCKET = 'abcdefghijkl.hook';
const RUN_DIR_NAME = 'smurg-run-XXXXXX';
const BASE_PREFIX = 'smurg-test-tmpdir-';

describe('createTempRunDir', () => {
  const previousTmp = process.env['TMPDIR'];
  const runDirs: string[] = [];
  const bases: string[] = [];

  /** A directory whose path is exactly `bytes` long, to stand in for TMPDIR. Under /tmp so the length is ours to choose. */
  async function tmpdirOfLength(bytes: number): Promise<string> {
    const base = await mkdtemp(join(await realpath('/tmp'), BASE_PREFIX));
    bases.push(base);
    const padding = bytes - Buffer.byteLength(base) - 1;
    expect(padding).toBeGreaterThan(0);
    const dir = join(base, 'p'.repeat(padding));
    await mkdir(dir, { recursive: true });
    expect(Buffer.byteLength(dir)).toBe(bytes);
    return dir;
  }

  function expectEverySocketFits(dir: string): void {
    expect(() => assertSocketPath(join(dir, HOOK_SOCKET))).not.toThrow();
    expect(srtSocketDirProblem(dir, LARGEST_PID)).toBeNull();
  }

  afterEach(async () => {
    if (previousTmp === undefined) delete process.env['TMPDIR'];
    else process.env['TMPDIR'] = previousTmp;
    for (const dir of runDirs.splice(0)) await removeTempRunDir(dir);
    for (const base of bases.splice(0)) {
      // Only what this test created: a direct child of /tmp with our prefix.
      if (!base.startsWith(join(await realpath('/tmp'), BASE_PREFIX))) throw new Error(`refusing to remove ${base}`);
      await rm(base, { recursive: true, force: true });
    }
  });

  it('fits the daemon sockets and srt’s proxy sockets under the current TMPDIR', async () => {
    const dir = await createTempRunDir();
    runDirs.push(dir);
    expectEverySocketFits(dir);
  });

  it('does not use a TMPDIR where the hook socket would fit but srt’s proxy sockets would not', async () => {
    // The depth that bit us: a run dir below it holds `<short>.hook` with room to spare, and srt's sockets do not fit.
    const tmp = await tmpdirOfLength(SOCKET_PATH_MAX_BYTES - Buffer.byteLength(`/${RUN_DIR_NAME}/${HOOK_SOCKET}`) - 3);
    expect(() => assertSocketPath(join(tmp, RUN_DIR_NAME, HOOK_SOCKET))).not.toThrow();
    expect(srtSocketDirProblem(join(tmp, RUN_DIR_NAME), LARGEST_PID)).not.toBeNull();
    process.env['TMPDIR'] = tmp;

    const dir = await createTempRunDir();
    runDirs.push(dir);
    expect(dir.startsWith(tmp)).toBe(false);
    expectEverySocketFits(dir);
  });

  it('does not use a TMPDIR that is too deep for any socket', async () => {
    const tmp = await tmpdirOfLength(SOCKET_PATH_MAX_BYTES - 8);
    expect(srtSocketDirProblem(tmp, LARGEST_PID)).not.toBeNull();
    process.env['TMPDIR'] = tmp;

    const dir = await createTempRunDir();
    runDirs.push(dir);
    expect(dir.startsWith(tmp)).toBe(false);
    expectEverySocketFits(dir);
  });
});
