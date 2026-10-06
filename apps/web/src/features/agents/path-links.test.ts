// Clickable file paths in terminal output: candidate extraction, resolution against the SESSION's root, refusal of
// anything outside the tree, and links only for paths that exist.
import { describe, expect, it, vi } from 'vitest';
import { Terminal } from '@xterm/xterm';
import type { ILink } from '@xterm/xterm';
import { MAIN_ROOT, SmurgError, worktreeRoot, type FileEntry, type FileRef } from '@smurg/protocol';
import { makeEntry } from '../../testing/fixtures.ts';
import { createPathExistence, createPathLinkProvider, findPathCandidates, mayAskAbout, normalizeSessionPath, resolveCandidate } from './path-links.ts';


const paths = (line: string) => findPathCandidates(line).map((c) => (c.line === undefined ? c.path : `${c.path}@${c.line}${c.column === undefined ? '' : `:${c.column}`}`));

describe('path candidates in terminal output', () => {
  it('finds relative paths as Claude Code prints them, with :line[:column]', () => {
    expect(paths('⏺ Update(src/app.ts)')).toEqual(['src/app.ts']);
    expect(paths('  ⎿  Updated src/lib/util.ts with 2 additions')).toEqual(['src/lib/util.ts']);
    expect(paths('error at src/app.ts:12:5 and ./lib/x.ts:7')).toEqual(['src/app.ts@12:5', './lib/x.ts@7']);
    expect(paths('see README.md, then docs/中文說明.md。')).toEqual(['README.md', 'docs/中文說明.md']);
    expect(paths('edit .github/workflows/ci.yml and .env')).toEqual(['.github/workflows/ci.yml', '.env']);
    expect(paths('Wrote src/app.ts.')).toEqual(['src/app.ts']);
  });

  it('ignores what is not a path: absolute paths, URLs, versions, abbreviations', () => {
    expect(paths('cat /etc/passwd /Users/ian/.ssh/id_ed25519')).toEqual([]);
    expect(paths('open https://example.com/assets/app.js now')).toEqual([]);
    expect(paths('Claude Code 2.1.283, e.g. this')).toEqual([]);
    expect(paths('1/2 done')).toEqual([]);
  });

  it('reports the UTF-16 range of each match', () => {
    // 「修改 」 is 3 UTF-16 units and 'src/a.ts:3' is 10 more.
    const [candidate] = findPathCandidates('修改 src/a.ts:3');
    expect(candidate).toMatchObject({ start: 3, end: 13, text: 'src/a.ts:3', path: 'src/a.ts', line: 3 });
  });
});

describe('resolution against the session root (refusal of paths outside the tree)', () => {
  it('normalises inside the root and refuses everything that leaves it', () => {
    expect(normalizeSessionPath('src/./app.ts')).toBe('src/app.ts');
    expect(normalizeSessionPath('./src/../lib/x.ts')).toBe('lib/x.ts');
    expect(normalizeSessionPath('../outside.txt')).toBeNull();
    expect(normalizeSessionPath('src/../../outside.txt')).toBeNull();
    expect(normalizeSessionPath('/etc/passwd')).toBeNull();
    expect(normalizeSessionPath('~/.ssh/id_rsa')).toBeNull();
    expect(normalizeSessionPath('a\\b.txt')).toBeNull();
    expect(normalizeSessionPath('src/..')).toBeNull();
    expect(normalizeSessionPath('')).toBeNull();
  });

  it("resolves relative to the session's own root (main workspace or its worktree)", () => {
    expect(resolveCandidate(MAIN_ROOT, { path: 'src/app.ts' })).toEqual({ root: MAIN_ROOT, path: 'src/app.ts' });
    expect(resolveCandidate(worktreeRoot('wt_7'), { path: './src/app.ts' })).toEqual({ root: { kind: 'worktree', worktreeId: 'wt_7' }, path: 'src/app.ts' });
    expect(resolveCandidate(worktreeRoot('wt_7'), { path: '../../main/src/app.ts' })).toBeNull();
  });
});

describe('only paths that exist in the tree become links', () => {
  it('uses a loaded listing without asking the daemon, and asks file.stat once for unknown paths', async () => {
    const stat = vi.fn(async (ref: FileRef): Promise<FileEntry> => {
      if (ref.path === 'lib/known.ts') return makeEntry('lib/known.ts');
      if (ref.path === 'lib') return makeEntry('lib', 'dir');
      if (ref.path === 'link') return makeEntry('link', 'symlink');
      throw new SmurgError('not_found');
    });
    const existence = createPathExistence({
      lookup: (ref) => (ref.path === 'src/app.ts' ? makeEntry('src/app.ts') : ref.path === 'src/gone.ts' ? null : undefined),
      stat,
      now: () => 1000,
    });
    expect(await existence.check({ root: MAIN_ROOT, path: 'src/app.ts' })).toBe('file');
    expect(await existence.check({ root: MAIN_ROOT, path: 'src/gone.ts' })).toBeNull();
    expect(stat).not.toHaveBeenCalled();
    expect(await existence.check({ root: MAIN_ROOT, path: 'lib/known.ts' })).toBe('file');
    expect(await existence.check({ root: MAIN_ROOT, path: 'lib/known.ts' })).toBe('file');
    expect(await existence.check({ root: MAIN_ROOT, path: 'lib' })).toBe('dir');
    expect(await existence.check({ root: MAIN_ROOT, path: 'missing.ts' })).toBeNull();
    expect(await existence.check({ root: MAIN_ROOT, path: 'link' })).toBeNull(); // symlinks: fail closed
    expect(stat.mock.calls.map(([ref]) => ref.path)).toEqual(['lib/known.ts', 'lib', 'missing.ts', 'link']);
  });

  it('the xterm link provider covers the right cells (CJK is two cells wide) and opens the file at the line', async () => {
    const term = new Terminal({ allowProposedApi: true, cols: 80, rows: 5 });
    await new Promise<void>((resolve) => term.write('中文 src/app.ts:12 ../secret.txt /etc/passwd missing.ts\r\n', resolve));
    const activated: unknown[] = [];
    const exists = vi.fn(async (ref: FileRef) => (ref.path === 'src/app.ts' || ref.path === 'secret.txt' ? ('file' as const) : null));
    const provider = createPathLinkProvider(term, {
      root: () => worktreeRoot('wt_1'),
      exists,
      activate: (target) => activated.push(target),
    });
    const links = await new Promise<ILink[] | undefined>((resolve) => provider.provideLinks(1, resolve));
    expect(links).toHaveLength(1);
    const [link] = links!;
    // 「中文 」 takes 5 cells, so the path starts at cell 6 (1-based) and 「src/app.ts:12」 ends at cell 18.
    expect(link!.range).toEqual({ start: { x: 6, y: 1 }, end: { x: 18, y: 1 } });
    expect(link!.text).toBe('src/app.ts:12');
    link!.activate(new MouseEvent('click'), link!.text);
    expect(activated).toEqual([{ ref: { root: { kind: 'worktree', worktreeId: 'wt_1' }, path: 'src/app.ts' }, kind: 'file', line: 12 }]);
    // ../secret.txt climbs out of the root: never even looked up.
    expect(exists.mock.calls.map(([ref]) => ref.path).sort()).toEqual(['missing.ts', 'src/app.ts']);
    term.dispose();
  });

  it('a line without existing paths has no links', async () => {
    const term = new Terminal({ allowProposedApi: true, cols: 40, rows: 3 });
    await new Promise<void>((resolve) => term.write('nothing/here.ts', resolve));
    const provider = createPathLinkProvider(term, { root: () => MAIN_ROOT, exists: async () => null, activate: () => {} });
    expect(await new Promise((resolve) => provider.provideLinks(1, resolve))).toBeUndefined();
    term.dispose();
  });
});

describe('which paths a viewer may ask the host about at all', () => {
  it('never the host-private names or the .smurg folder for anyone but the host', () => {
    const member = { isHost: false };
    for (const path of ['.envrc', 'api/.envrc', '.git/config', 'vendor/lib/.git/HEAD', 'CLAUDE.local.md', 'docs/CLAUDE.local.md', '.claude/settings.local.json', '.Git/config', '.smurg/state.json', '.SMURG/x']) {
      expect(mayAskAbout(path, member), path).toBe(false);
      expect(mayAskAbout(path, { isHost: true }), path).toBe(true);
    }
    // What a member can open is asked about as before: host-ONLY files (only the host writes them) can be read.
    for (const path of ['src/app.ts', 'README.md', '.env', '.github/workflows/ci.yml', 'CLAUDE.md', '.claude/settings.json', 'src/.smurg/x', 'gitignore/.gitignore']) expect(mayAskAbout(path, member), path).toBe(true);
  });
});
