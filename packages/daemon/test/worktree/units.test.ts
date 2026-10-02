// Pure parts of the worktree module: git -z parsers, names, the symlink policy, the version gate, the serializer.
import { describe, expect, it } from 'vitest';
import { GIT_HARDENING, GIT_MIN_VERSION, gitVersionAtLeast, parseGitVersion } from '../../src/worktree/git.ts';
import {
  UnsupportedPathError,
  cutAtFileBoundary,
  decodeGitPath,
  diffText,
  parseMergeTree,
  parseNameOnly,
  parseNameStatus,
  parseNumstat,
  parseRawDiff,
  parseStatusPaths,
} from '../../src/worktree/git-parse.ts';
import { excludePattern, gitIdentity, mergeRef, newMergeId, newWorktreeId, ownerSlug, worktreeBranch } from '../../src/worktree/names.ts';
import { symlinkEscapes } from '../../src/worktree/review.ts';
import { KeyedSerializer } from '../../src/worktree/serial.ts';

const A = 'a'.repeat(40);
const B = 'b'.repeat(40);
const Z = '0'.repeat(40);
const nul = (...parts: string[]): Buffer => Buffer.from(`${parts.join('\0')}\0`, 'utf8');

describe('git -z parsers', () => {
  it('parseRawDiff: statuses, renames with two paths, modes and object ids', () => {
    const out = nul(`:100644 100644 ${A} ${B} M`, 'src/app.ts', `:000000 100644 ${Z} ${B} A`, 'new file.txt', `:100644 100644 ${A} ${A} R100`, 'old.txt', 'new.txt', `:100644 120000 ${A} ${B} T`, 'link', `:100644 000000 ${A} ${Z} D`, 'gone.md');
    const entries = parseRawDiff(out);
    expect(entries.map((entry) => [entry.status, entry.path.path, entry.oldPath?.path])).toEqual([
      ['modified', 'src/app.ts', undefined],
      ['added', 'new file.txt', undefined],
      ['renamed', 'new.txt', 'old.txt'],
      ['type-changed', 'link', undefined],
      ['deleted', 'gone.md', undefined],
    ]);
    expect(entries[3]).toMatchObject({ srcMode: '100644', dstMode: '120000', dstOid: B });
    expect(parseRawDiff(Buffer.alloc(0))).toEqual([]);
  });

  it('parseRawDiff refuses output it does not understand and paths it cannot show', () => {
    expect(() => parseRawDiff(nul('garbage', 'x'))).toThrow();
    expect(() => parseRawDiff(nul(`:100644 100644 ${A} ${B} M`))).toThrow();
    expect(() => parseRawDiff(Buffer.concat([Buffer.from(`:100644 100644 ${A} ${B} M\0`), Buffer.from([0x66, 0xff, 0x00])]))).toThrow(UnsupportedPathError);
    expect(() => parseRawDiff(nul(`:100644 100644 ${A} ${B} M`, '../escape'))).toThrow(UnsupportedPathError);
    expect(() => parseRawDiff(nul(`:100644 100644 ${A} ${B} M`, 'back\\slash'))).toThrow(UnsupportedPathError);
  });

  it('parseNumstat: counts, binary files and renames', () => {
    const out = nul('3\t1\tsrc/app.ts', '-\t-\timage.png', '0\t0\t', 'old.txt', 'new.txt');
    expect(parseNumstat(out).map((entry) => [entry.additions, entry.deletions, entry.path.path, entry.oldPath?.path])).toEqual([
      [3, 1, 'src/app.ts', undefined],
      [null, null, 'image.png', undefined],
      [0, 0, 'new.txt', 'old.txt'],
    ]);
    expect(() => parseNumstat(nul('x\t1\tfile'))).toThrow();
  });

  it('parseMergeTree: the tree, then each conflicted path once', () => {
    const result = parseMergeTree(nul(A, 'b.txt', 'b.txt', 'a/c.txt'));
    expect(result.tree).toBe(A);
    expect(result.conflicted.map((path) => path.path)).toEqual(['b.txt', 'a/c.txt']);
    expect(parseMergeTree(nul(A)).conflicted).toEqual([]);
    expect(() => parseMergeTree(nul('not-a-tree'))).toThrow();
  });

  it('parseStatusPaths: both names of a rename, untracked files, and a placeholder for undecodable names', () => {
    const out = nul(' M src/app.ts', 'R  new.txt', 'old.txt', '?? draft.md');
    expect(parseStatusPaths(out)).toEqual(['src/app.ts', 'new.txt', 'old.txt', 'draft.md']);
    const odd = Buffer.concat([Buffer.from('?? '), Buffer.from([0x66, 0xff]), Buffer.from([0])]);
    expect(parseStatusPaths(odd)).toEqual(['\u0000undecodable']);
  });

  it('parseNameStatus: letters, renames with two paths, garbage refused', () => {
    const out = nul('A', '.env', 'M', 'src/app.ts', 'R087', 'old.txt', 'new.txt', 'D', 'gone.md', 'T', 'link');
    expect(parseNameStatus(out).map((entry) => [entry.letter, entry.path.path, entry.oldPath?.path])).toEqual([
      ['A', '.env', undefined],
      ['M', 'src/app.ts', undefined],
      ['R', 'new.txt', 'old.txt'],
      ['D', 'gone.md', undefined],
      ['T', 'link', undefined],
    ]);
    expect(() => parseNameStatus(nul('added', 'x'))).toThrow();
    expect(() => parseNameStatus(nul('A'))).toThrow();
    expect(() => parseNameStatus(nul('A', '../escape'))).toThrow(UnsupportedPathError);
  });

  it('parseNameOnly and decodeGitPath normalise to NFC (what clients send back)', () => {
    const decomposed = 'café.txt';
    expect(parseNameOnly(nul(decomposed)).map((path) => path.path)).toEqual(['café.txt']);
    expect(decodeGitPath(Buffer.from(decomposed)).raw).toBe(decomposed);
  });

  it('cutAtFileBoundary cuts before the last whole section; diffText never carries NUL', () => {
    const diff = Buffer.from('diff --git a/a b/a\n+1\ndiff --git a/b b/b\n+22222\ndiff --git a/c b/c\n+3\n');
    const second = diff.indexOf('diff --git a/b');
    const third = diff.indexOf('diff --git a/c');
    expect(cutAtFileBoundary(diff, diff.length)).toBe(diff.length);
    expect(cutAtFileBoundary(diff, third + 5)).toBe(third);
    expect(cutAtFileBoundary(diff, second + 3)).toBe(second);
    expect(cutAtFileBoundary(diff, 5)).toBe(5); // the first section alone is too long: a raw cut
    expect(diffText(Buffer.from([0x61, 0x00, 0xff, 0x62]))).toBe('a��b');
  });
});

describe('names', () => {
  it('worktree and merge ids are lowercase hex (safe as directory and ref names on case-insensitive file systems)', () => {
    for (let i = 0; i < 20; i++) {
      expect(newWorktreeId()).toMatch(/^wt_[0-9a-f]{24}$/);
      expect(newMergeId()).toMatch(/^mr_[0-9a-f]{24}$/);
    }
    expect(() => mergeRef('mr_ABC')).toThrow();
    expect(mergeRef('mr_0123456789abcdef01234567')).toBe('refs/smurg/merge/mr_0123456789abcdef01234567');
  });

  it('branch smurg/<owner>/<id> from any user id, always a valid ref name', () => {
    const id = 'wt_0123456789abcdef01234567';
    expect(worktreeBranch('github:12345', id)).toBe(`smurg/github-12345/${id}`);
    expect(worktreeBranch('dev:amy', id)).toBe(`smurg/dev-amy/${id}`);
    for (const userId of ['google:..hidden', 'dev:a..b', 'dev:x.lock', 'dev:~^:?*[\\', 'dev:.', 'dev:-leading', `dev:${'x'.repeat(200)}`, 'dev:名字']) {
      const branch = worktreeBranch(userId, id);
      expect(branch).toMatch(/^smurg\/[A-Za-z0-9_][A-Za-z0-9._-]*\/wt_/);
      expect(branch).not.toContain('..');
      expect(branch).not.toMatch(/\.lock\//);
    }
    expect(ownerSlug('dev:名字')).toBe('dev');
    expect(ownerSlug('::')).toBe('user');
  });

  it('git identities never carry characters git refuses', () => {
    expect(gitIdentity('dev:amy', 'Amy <admin>')).toEqual({ name: 'Amy  admin', email: 'dev-amy@users.smurg.invalid' });
    expect(gitIdentity('github:1', '   ').name).toBe('github-1');
    // Names git would strip to nothing ("crud" only) fall back to the user id's slug; anything else is kept.
    for (const crud of ['...', ',;:', '"\'', '. .']) expect(gitIdentity('dev:dot', crud).name).toBe('dev-dot');
    expect(gitIdentity('dev:x', '.Amy.').name).toBe('.Amy.');
    expect(gitIdentity('dev:x', '小明').name).toBe('小明');
  });

  it('exclude patterns are anchored and escape glob characters', () => {
    expect(excludePattern('data')).toBe('/data');
    expect(excludePattern('models/checkpoints')).toBe('/models/checkpoints');
    expect(excludePattern('a*b?[c]')).toBe('/a\\*b\\?\\[c\\]');
    expect(excludePattern('!keep')).toBe('/\\!keep');
    expect(excludePattern('trailing ')).toBe('/trailing\\ ');
  });
});

describe('symlink policy', () => {
  it('a link escapes when absolute or when .. climbs above the repository root', () => {
    expect(symlinkEscapes('src/app.ts', '/etc/passwd')).toBe(true);
    expect(symlinkEscapes('src/app.ts', '../../etc/passwd')).toBe(true);
    expect(symlinkEscapes('app.ts', '../x')).toBe(true);
    expect(symlinkEscapes('src/app.ts', '')).toBe(true);
    expect(symlinkEscapes('src/app.ts', 'a\\..\\..\\x')).toBe(true);
    expect(symlinkEscapes('src/app.ts', '../README.md')).toBe(false);
    expect(symlinkEscapes('src/deep/app.ts', '../../lib/./x')).toBe(false);
    expect(symlinkEscapes('src/app.ts', 'sub/../../../README.md')).toBe(true);
  });

  it('`..` after a name is refused (that name may be a link: a chain climbs above the root), and so is a target on a host-only path', () => {
    // d1/d2/b -> ../.. names the root; d1/d2/a -> b/../x is "inside" lexically but really <parent of share>/x.
    expect(symlinkEscapes('d1/d2/b', '../..')).toBe(false);
    expect(symlinkEscapes('d1/d2/a', 'b/../x')).toBe(true);
    // Formerly judged lexically ("sub/.." cancels): refused now for the same reason.
    expect(symlinkEscapes('src/app.ts', 'sub/../../README.md')).toBe(true);
    expect(symlinkEscapes('src/app.ts', './sub/./x/../y')).toBe(true);
    // Leading `..` climbs through the link's own parent directories: still fine inside the root.
    expect(symlinkEscapes('a/b/c/link', '../../x/y')).toBe(false);
    expect(symlinkEscapes('a/link', '..')).toBe(false);
    // Onto what only the host may change (the host's unsandboxed agent would write through the link).
    expect(symlinkEscapes('notes', '.claude/settings.json')).toBe(true);
    expect(symlinkEscapes('src/cfg', '../.git/config')).toBe(true);
    expect(symlinkEscapes('src/env', '../.envrc')).toBe(true);
    expect(symlinkEscapes('src/x', '../.smurg/worktrees')).toBe(true);
    expect(symlinkEscapes('src/x', '../.VScode')).toBe(true);
  });
});

describe('git version gate and hardening', () => {
  it('parses git versions (Apple builds included) and requires merge-tree --write-tree and --attr-source', () => {
    expect(parseGitVersion('git version 2.49.0\n')).toEqual([2, 49, 0]);
    expect(parseGitVersion('git version 2.50.1 (Apple Git-155)')).toEqual([2, 50, 1]);
    expect(parseGitVersion('git version 2.42')).toEqual([2, 42, 0]);
    expect(parseGitVersion('hub version 2.14.2')).toBeNull();
    expect(gitVersionAtLeast([2, 49, 0], GIT_MIN_VERSION)).toBe(true);
    expect(gitVersionAtLeast([2, 42, 0], GIT_MIN_VERSION)).toBe(true);
    expect(gitVersionAtLeast([2, 41, 9], GIT_MIN_VERSION)).toBe(false);
    expect(gitVersionAtLeast([3, 0, 0], GIT_MIN_VERSION)).toBe(true);
  });

  it('every daemon git command turns hooks, fsmonitor, signing, background gc and non-file transports off', () => {
    for (const setting of ['core.hooksPath=/dev/null', 'core.fsmonitor=false', 'commit.gpgSign=false', 'gc.auto=0', 'gc.autoDetach=false', 'maintenance.auto=false', 'protocol.allow=never', 'protocol.file.allow=always', 'credential.helper=']) {
      expect(GIT_HARDENING).toContain(setting);
    }
  });
});

describe('KeyedSerializer', () => {
  it('runs work for one key one at a time, in order, and keys independently; a failure does not block the queue', async () => {
    const serial = new KeyedSerializer();
    const log: string[] = [];
    const step = (name: string, ms: number, fail = false) => async (): Promise<string> => {
      log.push(`start ${name}`);
      await new Promise((resolve) => setTimeout(resolve, ms));
      log.push(`end ${name}`);
      if (fail) throw new Error(name);
      return name;
    };
    const a1 = serial.run('a', step('a1', 20, true));
    const a2 = serial.run('a', step('a2', 1));
    const b1 = serial.run('b', step('b1', 1));
    await expect(a1).rejects.toThrow('a1');
    expect(await a2).toBe('a2');
    expect(await b1).toBe('b1');
    expect(log.indexOf('end a1')).toBeLessThan(log.indexOf('start a2'));
    expect(log.indexOf('start b1')).toBeLessThan(log.indexOf('end a1'));
    await serial.idle();
  });
});
