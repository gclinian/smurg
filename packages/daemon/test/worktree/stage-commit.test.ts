// The verifier that stands between a staged merge-request commit and the guest-readable clone (stage-commit.ts): a
// blob is published only if the worktree still holds exactly those bytes at that name, reached without a symlink on
// the way, through a file with a single hard link.
import { createHash } from 'node:crypto';
import { link, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTempDir, removeTempDir } from '../../src/testing/index.ts';
import type { RawDiffEntry } from '../../src/worktree/git-parse.ts';
import { verifyBlobFile, verifyBlobLink, verifyStagedEntries } from '../../src/worktree/stage-commit.ts';

let root = '';
let outside = '';

beforeEach(async () => {
  root = await createTempDir('stage-root');
  outside = await createTempDir('stage-outside');
});

afterEach(async () => {
  await removeTempDir(root);
  await removeTempDir(outside);
});

const oidOf = (bytes: string | Buffer, algo: 'sha1' | 'sha256' = 'sha1'): string => {
  const data = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  return createHash(algo).update(`blob ${data.length}\0`).update(data).digest('hex');
};

async function reason(promise: Promise<unknown>): Promise<string | null> {
  try {
    await promise;
    return null;
  } catch (err) {
    return String((err as { detail?: Record<string, unknown> }).detail?.['reason'] ?? 'unknown');
  }
}

function entry(path: string, dstMode: string, dstOid: string, letter = 'M'): RawDiffEntry {
  return { srcMode: '100644', dstMode, srcOid: '0'.repeat(40), dstOid, letter, status: 'modified', path: { raw: path, path } };
}

describe('verifying a staged commit against the worktree', () => {
  it('accepts exactly the bytes at that name (sha1 and sha256 object ids)', async () => {
    await mkdir(join(root, 'src'));
    await writeFile(join(root, 'src', 'app.ts'), 'export const answer = 43;\n');
    await verifyBlobFile(root, 'src/app.ts', oidOf('export const answer = 43;\n'));
    await verifyBlobFile(root, 'src/app.ts', oidOf('export const answer = 43;\n', 'sha256'));
    await writeFile(join(root, 'empty'), '');
    await verifyBlobFile(root, 'empty', oidOf(''));
  });

  it('refuses a file whose bytes differ from what git staged (edited meanwhile, or read elsewhere)', async () => {
    await writeFile(join(root, 'a.txt'), 'now\n');
    expect(await reason(verifyBlobFile(root, 'a.txt', oidOf('what git read\n')))).toBe('worktree-changed');
    expect(await reason(verifyBlobFile(root, 'missing.txt', oidOf('x')))).toBe('worktree-changed');
  });

  it('never reads through a symlink: not on the way, not at the end', async () => {
    await writeFile(join(outside, 'id_rsa'), 'SECRET\n');
    // What a lost race looks like at verification time: the directory git walked is now a link to a host dir.
    await symlink(outside, join(root, 'keys'));
    expect(await reason(verifyBlobFile(root, 'keys/id_rsa', oidOf('SECRET\n')))).toBe('worktree-changed');
    await mkdir(join(root, 'dir'));
    await symlink(join(outside, 'id_rsa'), join(root, 'dir', 'file'));
    expect(await reason(verifyBlobFile(root, 'dir/file', oidOf('SECRET\n')))).toBe('worktree-changed');
  });

  it('refuses a file with more than one hard link (it could be a host file under a worktree name)', async () => {
    await writeFile(join(outside, 'secret'), 'SECRET\n');
    await link(join(outside, 'secret'), join(root, 'innocent.txt'));
    expect(await reason(verifyBlobFile(root, 'innocent.txt', oidOf('SECRET\n')))).toBe('hard-link');
  });

  it('symlinks are checked by their target text', async () => {
    await symlink('../README.md', join(root, 'alias'));
    await verifyBlobLink(root, 'alias', oidOf('../README.md'));
    expect(await reason(verifyBlobLink(root, 'alias', oidOf('/etc/passwd')))).toBe('worktree-changed');
    await writeFile(join(root, 'plain'), '../README.md');
    expect(await reason(verifyBlobLink(root, 'plain', oidOf('../README.md')))).toBe('worktree-changed');
  });

  it('verifyStagedEntries: deletions read nothing, nested repositories are refused, unknown modes fail closed', async () => {
    await writeFile(join(root, 'ok.txt'), 'ok\n');
    await verifyStagedEntries(root, [entry('ok.txt', '100644', oidOf('ok\n')), entry('gone.txt', '000000', '0'.repeat(40), 'D')]);
    expect(await reason(verifyStagedEntries(root, [entry('vendor/lib', '160000', 'a'.repeat(40), 'A')]))).toBe('nested-repository');
    expect(await reason(verifyStagedEntries(root, [entry('odd', '100664', oidOf('x'))]))).toBe('worktree-changed');
    await rm(join(root, 'ok.txt'));
    expect(await reason(verifyStagedEntries(root, [entry('ok.txt', '100755', oidOf('ok\n'))]))).toBe('worktree-changed');
  });
});
