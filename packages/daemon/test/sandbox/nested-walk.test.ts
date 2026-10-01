// The Linux walk for EXISTING host-only entries below the top of a session root (SandboxServiceImpl
// nestedHostOnlyPaths; ARCHITECTURE §7.6 / §12). It runs on every wrap(): review RCR-7 measured ~2 s per 50,000
// directories one listing after the other; it now keeps several listings in flight with the same result. Nothing is
// skipped but node_modules (skipping build / vendor trees or bounding the depth would leave an existing nested `.git`
// writable by guests).
import { mkdir, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { nestedHostOnlyPaths } from '../../src/sandbox/service.ts';
import { createTempDir, removeTempDir } from '../../src/testing/index.ts';

const temps: string[] = [];
afterEach(async () => {
  for (const dir of temps.splice(0)) await removeTempDir(dir);
});

describe('nestedHostOnlyPaths (Linux nested host-only entries)', () => {
  it('finds every existing host-only name below the top at any depth, the same with one listing or sixteen at a time; skips node_modules, enters no match, follows no link', async () => {
    const root = await createTempDir('nested-walk');
    temps.push(root);
    const expected: string[] = [];
    // A tree wider and deeper than the pool: 6 × 6 × 4 directories, host-only names scattered through it.
    for (let a = 0; a < 6; a++) {
      for (let b = 0; b < 6; b++) {
        for (let c = 0; c < 4; c++) {
          const dir = join(root, `a${a}`, `b${b}`, `c${c}`);
          await mkdir(dir, { recursive: true });
          if ((a + b + c) % 5 === 0) {
            await mkdir(join(dir, '.git', 'hooks'), { recursive: true }); // a nested repository: denied whole, not entered
            await writeFile(join(dir, '.git', 'hooks', '.envrc'), 'x');
            expected.push(join(dir, '.git'));
          }
          if ((a * b + c) % 7 === 0) {
            await writeFile(join(dir, '.mcp.json'), '{}');
            expected.push(join(dir, '.mcp.json'));
          }
        }
      }
    }
    await mkdir(join(root, 'target', 'deep', 'er', 'still', 'deeper'), { recursive: true });
    await mkdir(join(root, 'target', 'deep', 'er', 'still', 'deeper', '.claude'));
    expected.push(join(root, 'target', 'deep', 'er', 'still', 'deeper', '.claude'));
    // top-level names are the policy's own literal denies, not this walk's
    await mkdir(join(root, '.vscode'));
    await writeFile(join(root, '.envrc'), 'x');
    // skipped: node_modules at any depth; not followed: a symlink to a directory holding host-only names
    await mkdir(join(root, 'node_modules', 'pkg', '.vscode'), { recursive: true });
    await mkdir(join(root, 'a1', 'node_modules', '.claude'), { recursive: true });
    const outside = await createTempDir('nested-walk-outside');
    temps.push(outside);
    await mkdir(join(outside, '.idea'));
    await symlink(outside, join(root, 'a2', 'linked'));
    expected.sort();
    for (const concurrency of [1, 16, 64]) expect(await nestedHostOnlyPaths(root, concurrency)).toEqual({ deny: expected, unprotected: [] });
  });

  it('a path srt cannot be given (glob characters) is reported as unprotected, not denied; control characters are denied literally (review attack F1)', async () => {
    const root = await createTempDir('nested-walk-odd');
    temps.push(root);
    const made = async (...rel: string[]): Promise<string> => {
      const path = join(root, ...rel);
      await mkdir(path, { recursive: true });
      return path;
    };
    const evil = await made('ev*il', '.git');
    const bracket = join(await made('brack[et]'), '.mcp.json');
    await writeFile(bracket, '{}');
    const question = await made('a', 'q?', '.vscode');
    const control = await made('ctl\u0001x', '.claude');
    const newline = await made('nl\nline', 'deeper', '.git');
    const sane = await made('sane', '.idea');
    // nothing below a glob-named directory is lost either: its host-only entries are found (and unprotected)
    const below = await made('ev*il', 'sub', '.claude');
    for (const concurrency of [1, 16]) {
      expect(await nestedHostOnlyPaths(root, concurrency)).toEqual({
        deny: [control, newline, sane].sort(),
        unprotected: [evil, bracket, question, below].sort().map((path) => ({ path, reason: 'glob-characters' })),
      });
    }
  });

  it.runIf(process.platform === 'linux')('Linux: below a name that is not UTF-8 (no string spells the path) the entries are found and reported as unprotected', async () => {
    const root = await createTempDir('nested-walk-bytes');
    temps.push(root);
    const odd = Buffer.concat([Buffer.from(`${root}/`), Buffer.from([0xff, 0x2d]), Buffer.from('dir')]);
    await mkdir(Buffer.concat([odd, Buffer.from('/.git')]), { recursive: true });
    await mkdir(join(root, 'ok', '.git'), { recursive: true });
    const result = await nestedHostOnlyPaths(root);
    expect(result?.deny).toEqual([join(root, 'ok', '.git')]);
    expect(result?.unprotected).toEqual([{ path: `${root}/�-dir/.git`, reason: 'not-utf8' }]);
  });

  it('more than 1000 existing entries: null (the session is refused), however many listings are in flight', async () => {
    const root = await createTempDir('nested-walk-many');
    temps.push(root);
    for (let i = 0; i < 1001; i++) {
      await mkdir(join(root, `d${i % 40}`, `e${i}`), { recursive: true });
      await writeFile(join(root, `d${i % 40}`, `e${i}`, '.envrc'), 'x');
    }
    expect(await nestedHostOnlyPaths(root)).toBeNull();
    expect(await nestedHostOnlyPaths(root, 1)).toBeNull();
    expect(await nestedHostOnlyPaths(join(root, 'missing'))).toEqual({ deny: [], unprotected: [] });
  }, 60_000);
});
