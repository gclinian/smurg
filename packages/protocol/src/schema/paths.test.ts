import { describe, expect, it } from 'vitest';
import { PATH_SEGMENT_MAX_UNITS, REL_PATH_MAX_CHARS } from './limits.ts';
import {
  MAIN_ROOT,
  type RelPathProblem,
  baseNameOfRelPath,
  checkRelPath,
  entryPathSchema,
  fileRefEquals,
  fileRefKey,
  fileRefSchema,
  foldPathName,
  isHiddenTempName,
  isHostOnlyPath,
  isHostPrivatePath,
  isRelPathWithin,
  isSmurgDirName,
  isValidRelPath,
  joinRelPath,
  parentRelPath,
  parseFileRefKey,
  pathSegmentSchema,
  relPathSchema,
  relPathSegments,
  rootRefEquals,
  rootRefKey,
  worktreeRoot,
} from './paths.ts';

// Lexical rules of ARCHITECTURE §7.4 (and transfer.md §1.8), table-driven.
const REJECTED: readonly (readonly [string, unknown, RelPathProblem])[] = [
  ['non-string', 42, 'not-string'],
  ['NUL', 'a\u0000b', 'control-character'],
  ['newline', 'a\nb', 'control-character'],
  ['DEL', 'a\u007fb', 'control-character'],
  ['C1 CSI', 'a\u009bb', 'control-character'],
  ['RLO bidi override', 'invoice\u202etxt.exe', 'bidi-character'],
  ['LRI isolate', 'a\u2066b', 'bidi-character'],
  ['RLM mark', 'a\u200fb', 'bidi-character'],
  ['lone high surrogate', 'a\ud800b', 'lone-surrogate'],
  ['lone low surrogate', '\udc00', 'lone-surrogate'],
  ['backslash', 'a\\b', 'backslash'],
  ['windows traversal', '..\\..\\x', 'backslash'],
  ['drive letter', 'C:/Windows', 'drive-letter'],
  ['drive letter, no slash', 'c:x', 'drive-letter'],
  ['a one-letter name with a colon looks like a drive letter', 'a:b/c', 'drive-letter'],
  ['absolute', '/etc/passwd', 'absolute'],
  ['double slash', 'a//b', 'empty-segment'],
  ['trailing slash', 'a/', 'empty-segment'],
  ['dot', 'a/./b', 'dot-segment'],
  ['dot-dot', 'a/../../b', 'dot-segment'],
  ['only dot-dot', '..', 'dot-segment'],
  ['only dot', '.', 'dot-segment'],
  ['segment too long', 'a'.repeat(PATH_SEGMENT_MAX_UNITS + 1), 'segment-too-long'],
  ['path too long', Array.from({ length: 2000 }, () => 'abc').join('/'), 'too-long'],
  ['root when not allowed', '', 'root-not-allowed'],
];

const ACCEPTED: readonly (readonly [string, string, string])[] = [
  ['plain', 'src/app.ts', 'src/app.ts'],
  ['dotfile', '.gitignore', '.gitignore'],
  ['dots inside names', 'a..b/c...d', 'a..b/c...d'],
  ['CJK', '文件/讀我.md', '文件/讀我.md'],
  ['emoji', 'pics/😀.png', 'pics/😀.png'],
  ['spaces and #%', 'my dir/50% #1.txt', 'my dir/50% #1.txt'],
  ['colon later in the path', 'a/c:d', 'a/c:d'],
  ['NFD is normalised to NFC', 'cafe\u0301/menu.txt', 'caf\u00e9/menu.txt'],
  ['255 CJK characters (APFS counts UTF-16 units)', '中'.repeat(255), '中'.repeat(255)],
];

describe('checkRelPath', () => {
  it.each(REJECTED)('rejects %s', (_label, input, problem) => {
    expect(checkRelPath(input)).toEqual({ ok: false, problem });
    expect(isValidRelPath(input)).toBe(false);
  });

  it.each(ACCEPTED)('accepts %s', (_label, input, normalised) => {
    expect(checkRelPath(input)).toEqual({ ok: true, path: normalised });
  });

  it('accepts the root only when asked', () => {
    expect(checkRelPath('', { allowRoot: true })).toEqual({ ok: true, path: '' });
    expect(isValidRelPath('', { allowRoot: true })).toBe(true);
  });

  it('bounds the total length after NFC', () => {
    const head = Array.from({ length: 20 }, () => 'a'.repeat(200)).join('/');
    const exact = `${head}/${'b'.repeat(REL_PATH_MAX_CHARS - head.length - 1)}`;
    expect(exact.length).toBe(REL_PATH_MAX_CHARS);
    expect(checkRelPath(exact).ok).toBe(true);
    expect(checkRelPath(`${exact}c`)).toEqual({ ok: false, problem: 'too-long' });
  });
});

describe('path schemas', () => {
  it('normalise to NFC and reject what checkRelPath rejects', () => {
    expect(relPathSchema.parse('')).toBe('');
    expect(relPathSchema.parse('cafe\u0301')).toBe('caf\u00e9');
    expect(entryPathSchema.safeParse('').success).toBe(false);
    for (const [, input] of REJECTED) if (typeof input === 'string' && input !== '') expect(relPathSchema.safeParse(input).success).toBe(false);
  });

  it('reports the problem but never the path in the issue', () => {
    const result = relPathSchema.safeParse('/Users/ian/.ssh/id_rsa');
    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error?.issues)).not.toContain('/Users/ian');
    expect(result.error?.issues[0]?.message).toContain('absolute');
  });

  it('a segment is one name', () => {
    expect(pathSegmentSchema.parse('a.txt')).toBe('a.txt');
    expect(pathSegmentSchema.safeParse('a/b').success).toBe(false);
    expect(pathSegmentSchema.safeParse('..').success).toBe(false);
    expect(pathSegmentSchema.safeParse('').success).toBe(false);
  });

  it('FileRef is strict', () => {
    expect(fileRefSchema.safeParse({ root: MAIN_ROOT, path: 'a' }).success).toBe(true);
    expect(fileRefSchema.safeParse({ root: MAIN_ROOT, path: 'a', abs: '/a' }).success).toBe(false);
    expect(fileRefSchema.safeParse({ root: { kind: 'main', worktreeId: 'x' }, path: 'a' }).success).toBe(false);
    expect(fileRefSchema.safeParse({ root: { kind: 'worktree', worktreeId: '../x' }, path: 'a' }).success).toBe(false);
  });
});

describe('path helpers', () => {
  it('split, join and navigate', () => {
    expect(relPathSegments('')).toEqual([]);
    expect(relPathSegments('a/b')).toEqual(['a', 'b']);
    expect(parentRelPath('a/b')).toBe('a');
    expect(parentRelPath('a')).toBe('');
    expect(parentRelPath('')).toBeNull();
    expect(baseNameOfRelPath('a/b.txt')).toBe('b.txt');
    expect(joinRelPath('', 'a')).toBe('a');
    expect(joinRelPath('a', 'b')).toBe('a/b');
    expect(joinRelPath('a', '..')).toBeNull();
    expect(joinRelPath('a', 'b/../c')).toBeNull();
    expect(isRelPathWithin('a/b', 'a')).toBe(true);
    expect(isRelPathWithin('a', 'a')).toBe(true);
    expect(isRelPathWithin('ab', 'a')).toBe(false);
    expect(isRelPathWithin('x', '')).toBe(true);
  });
});

describe('FileRef / RootRef keys and equality', () => {
  const wt = worktreeRoot('wt_1');

  it('are stable and distinguish roots', () => {
    expect(rootRefKey(MAIN_ROOT)).toBe('main');
    expect(rootRefKey(wt)).toBe('wt:wt_1');
    expect(fileRefKey({ root: MAIN_ROOT, path: 'a:b' })).toBe('main:a:b');
    expect(fileRefKey({ root: wt, path: 'a' })).toBe('wt:wt_1:a');
    expect(rootRefEquals(MAIN_ROOT, { kind: 'main' })).toBe(true);
    expect(rootRefEquals(MAIN_ROOT, wt)).toBe(false);
    expect(fileRefEquals({ root: MAIN_ROOT, path: 'a' }, { root: wt, path: 'a' })).toBe(false);
  });

  it('treat NFC and NFD spellings as the same file', () => {
    expect(fileRefEquals({ root: MAIN_ROOT, path: 'caf\u00e9' }, { root: MAIN_ROOT, path: 'cafe\u0301' })).toBe(true);
  });

  it('round-trip through parseFileRefKey', () => {
    for (const ref of [
      { root: MAIN_ROOT, path: '' },
      { root: MAIN_ROOT, path: 'x/a:b/c' },
      { root: wt, path: '文件/x.md' },
    ]) {
      expect(parseFileRefKey(fileRefKey(ref))).toEqual(ref);
    }
    for (const bad of ['', 'main', 'wt:', 'wt:bad id:x', 'main:../x', 'other:x', 'wt:wt_1']) expect(parseFileRefKey(bad)).toBeNull();
  });

  it('MAIN_ROOT is frozen', () => {
    expect(Object.isFrozen(MAIN_ROOT)).toBe(true);
  });
});

describe('host-only paths (ARCHITECTURE §5.2)', () => {
  it.each([
    '.claude',
    '.claude/settings.json',
    '.claude/settings.local.json',
    '.claude/hooks/pre.sh',
    '.Claude/settings.json',
    'packages/web/.claude/commands/x.md',
    '.mcp.json',
    'sub/.mcp.json',
    '.git/config',
    '.git/hooks/pre-commit',
    '.smurg/worktrees/wt_1/x',
    '.envrc',
    'app/.envrc',
    '.vscode/tasks.json',
    '.idea/workspace.xml',
  ])('%s is host-only', (path) => {
    expect(isHostOnlyPath(path)).toBe(true);
  });

  it.each(['', 'src/app.ts', 'CLAUDE.md', 'docs/claude.md', '.github/workflows/ci.yml', '.gitignore', 'a.mcp.json', '.envrc.example'])(
    '%s is not host-only',
    (path) => {
      expect(isHostOnlyPath(path)).toBe(false);
    },
  );

  // Spellings a case-insensitive file system resolves to a host-only entry (security review F1: on APFS `.vſcode`
  // IS `.vscode`, and toLowerCase() leaves U+017F alone).
  const cp = (...points: number[]): string => String.fromCodePoint(...points);
  const LONG_S = cp(0x17f);
  const KELVIN = cp(0x212a);
  const DOTLESS_I = cp(0x131);
  const ZWNJ = cp(0x200c);
  it.each([
    [`.v${LONG_S}code/tasks.json`, 'long s'],
    [`.mcp.j${LONG_S}on`, 'long s in a file name'],
    [`.${LONG_S}murg/uploads/x.part`, 'long s in .smurg'],
    [`.${LONG_S.toUpperCase()}MURG/x`, 'upper case'],
    [`.${DOTLESS_I}dea/workspace.xml`, 'dotless i (exFAT/NTFS upcase)'],
    [`.g${ZWNJ}it/config`, 'HFS+ ignorable code point'],
    ['sub/.MCP.JSON', 'upper case file'],
  ])('%s is host-only (%s)', (path) => {
    expect(isHostOnlyPath(path)).toBe(true);
  });

  // SEC-D-03: host-private files are refused to every non-host through file.* (no guest sandbox since §11 D-15).
  it.each([
    '.claude/settings.local.json',
    'packages/web/.claude/settings.local.json',
    '.CLAUDE/Settings.Local.JSON',
    'CLAUDE.local.md',
    'docs/claude.LOCAL.md',
    '.git',
    '.git/config',
    '.git/logs/HEAD',
    'vendor/lib/.git/config',
    `.g${ZWNJ}it/config`,
    `.GIT/FETCH_HEAD`,
    '.envrc',
    'app/.ENVRC',
  ])('%s is host-private', (path) => {
    expect(isHostPrivatePath(path)).toBe(true);
  });

  it.each(['', 'src/app.ts', 'CLAUDE.md', '.claude/settings.json', '.claude/commands/x.md', 'settings.local.json', '.gitignore', '.github/x.yml', '.envrc.example', 'CLAUDE.local.md.bak', 'git/config'])(
    '%s is not host-private',
    (path) => {
      expect(isHostPrivatePath(path)).toBe(false);
    },
  );

  it('foldPathName folds what APFS folds and keeps ordinary names apart', () => {
    expect(foldPathName(`.v${LONG_S}code`)).toBe('.vscode');
    expect(foldPathName(`${KELVIN}ey`)).toBe('key');
    expect(foldPathName('報告（草稿）.md')).toBe('報告(草稿).md');
    expect(foldPathName('README.md')).toBe('readme.md');
    expect(isSmurgDirName(`.${LONG_S}murg`)).toBe(true);
    expect(isSmurgDirName('.SMURG')).toBe(true);
    expect(isSmurgDirName('.smurgx')).toBe(false);
    // NFKC folding more names together only makes them more protected; ordinary project names are unaffected.
    expect(isHostOnlyPath('報告（草稿）.md')).toBe(false);
  });
});

describe('hidden temp files', () => {
  it.each(['app.ts.tmp.12345.0123456789ab', '.app.ts.smurg-0123456789ab.tmp'])('%s is hidden', (name) => {
    expect(isHiddenTempName(name)).toBe(true);
  });
  it.each(['app.ts', 'notes.tmp', 'x.tmp.12.abc', '.smurg-0123456789ab.tmp', 'app.ts.smurg-0123456789ab.tmp'])('%s is shown', (name) => {
    expect(isHiddenTempName(name)).toBe(false);
  });
});
