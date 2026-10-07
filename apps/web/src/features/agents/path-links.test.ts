// Clickable file paths in terminal output: candidate extraction, resolution against the SESSION's root, refusal of
// anything outside the tree, and links only for paths that exist.
import { describe, expect, it, vi } from 'vitest';
import { Terminal } from '@xterm/xterm';
import type { ILink } from '@xterm/xterm';
import { MAIN_ROOT, SmurgError, worktreeRoot, type FileEntry, type FileRef } from '@smurg/protocol';
import { makeEntry } from '../../testing/fixtures.ts';
import { MAX_LOOKUPS_IN_FLIGHT, REFUSAL_QUIET_MS, createPathExistence, createPathGate, createPathLinkProvider, findPathCandidates, mayAskAbout, normalizeSessionPath, pathGateOf, resolveCandidate } from './path-links.ts';


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

describe('finding candidates costs in proportion to the text (review R4-03: it runs while a conversation renders)', () => {
  /** The quickest of three runs: one pause of a busy machine is not the text's cost. */
  const quickest = (run: () => void): number => {
    let best = Number.POSITIVE_INFINITY;
    for (let round = 0; round < 3; round += 1) {
      const started = performance.now();
      run();
      best = Math.min(best, performance.now() - started);
    }
    return best;
  };

  it('a long run of dots inside a name, or any other run, does not hold the page', () => {
    const size = 200_000;
    for (const line of [
      `a${'.'.repeat(size)}b`,
      `src/a${'.'.repeat(size)}b and src/app.ts`,
      `${'a/'.repeat(size / 2)}!`,
      `${'../'.repeat(size / 3)}!`,
      `${'./'.repeat(size / 2)}!`,
      'a.'.repeat(size / 2),
      `${'a:1:1 '.repeat(size / 6)}`,
      '.'.repeat(size),
      `${'a'.repeat(size)}.ts`,
      `${'-'.repeat(size)}/a.ts`,
    ]) {
      expect(quickest(() => void findPathCandidates(line)), line.slice(0, 16)).toBeLessThan(250);
    }
  });

  it('still cuts the sentence punctuation off a path, and only that', () => {
    expect(paths('Wrote src/app.ts... and lib/a.b.ts.')).toEqual(['src/app.ts', 'lib/a.b.ts']);
    const [candidate] = findPathCandidates('see src/app.ts...');
    expect(candidate).toMatchObject({ start: 4, end: 14, text: 'src/app.ts' });
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

describe("the gate every lookup of a path in someone's text goes through (review R4-04, second round)", () => {
  const MEMBER = { isHost: false };
  const ref = (path: string): FileRef => ({ root: MAIN_ROOT, path });

  /** A host that answers when the test says so. */
  function host() {
    const pending: { path: string; resolve(entry: FileEntry): void; reject(error: unknown): void }[] = [];
    const asked: string[] = [];
    let now = 1_000;
    const gate = createPathGate({
      stat: (file) =>
        new Promise<FileEntry>((resolve, reject) => {
          asked.push(file.path);
          pending.push({ path: file.path, resolve, reject });
        }),
      now: () => now,
    });
    const settle = async (): Promise<void> => {
      for (let round = 0; round < 8; round += 1) await Promise.resolve();
    };
    return {
      gate,
      asked,
      inFlight: () => pending.length,
      advance: (ms: number) => void (now += ms),
      async answer(code?: 'path_denied' | 'not_found' | 'rate_limited'): Promise<void> {
        const next = pending.shift()!;
        if (code === undefined) next.resolve(makeEntry(next.path));
        else next.reject(new SmurgError(code));
        await settle();
      },
      /** The outcome of a lookup: the entry's path, or 'no' when it was refused, missing or never asked. */
      ask: (path: string, viewer = MEMBER): Promise<string> => gate.stat(ref(path), viewer).then((entry) => entry.path, () => 'no'),
    };
  }

  it('asks about one path first and about at most a few at a time afterwards', async () => {
    const h = host();
    const all = Array.from({ length: 12 }, (_, index) => h.ask(`src/f${index}.ts`));
    expect(h.asked).toEqual(['src/f0.ts']);
    await h.answer();
    expect(h.inFlight()).toBe(MAX_LOOKUPS_IN_FLIGHT);
    await h.answer();
    expect(h.inFlight()).toBe(MAX_LOOKUPS_IN_FLIGHT);
    while (h.inFlight() > 0) await h.answer();
    expect(h.asked).toHaveLength(12);
    expect(await Promise.all(all)).toEqual(Array.from({ length: 12 }, (_, index) => `src/f${index}.ts`));
  });

  it('a refusal answers everything that waited, is remembered for that path, and nothing is asked for a while', async () => {
    const h = host();
    const all = Array.from({ length: 40 }, (_, index) => h.ask(`README.md/a${index}`));
    expect(h.asked).toEqual(['README.md/a0']);
    await h.answer('path_denied');
    expect(await Promise.all(all)).toEqual(Array.from({ length: 40 }, () => 'no'));
    expect(h.asked).toEqual(['README.md/a0']);
    // During the quiet time nothing is asked, whatever the path.
    h.advance(REFUSAL_QUIET_MS - 1);
    expect(await h.ask('src/app.ts')).toBe('no');
    expect(h.asked).toHaveLength(1);
    // Afterwards it starts with one request again, and never with the refused path.
    h.advance(2);
    expect(await h.ask('README.md/a0')).toBe('no');
    const later = [h.ask('src/app.ts'), h.ask('src/b.ts'), h.ask('src/c.ts')];
    expect(h.asked).toEqual(['README.md/a0', 'src/app.ts']);
    await h.answer();
    expect(h.asked).toEqual(['README.md/a0', 'src/app.ts', 'src/b.ts', 'src/c.ts']);
    await h.answer();
    await h.answer('not_found');
    expect(await Promise.all(later)).toEqual(['src/app.ts', 'src/b.ts', 'no']);
  });

  it('refusals that were already on their way are counted once: the gate is one request wide again after any of them', async () => {
    const h = host();
    const first = h.ask('src/a.ts');
    await h.answer();
    expect(await first).toBe('src/a.ts');
    const burst = Array.from({ length: 10 }, (_, index) => h.ask(`node_modules/pkg/f${index}.js`));
    expect(h.inFlight()).toBe(MAX_LOOKUPS_IN_FLIGHT);
    await h.answer('path_denied');
    // The three that were out with it come back refused too; none of the six that waited is asked.
    while (h.inFlight() > 0) await h.answer('path_denied');
    expect(await Promise.all(burst)).toEqual(Array.from({ length: 10 }, () => 'no'));
    expect(h.asked).toHaveLength(1 + MAX_LOOKUPS_IN_FLIGHT);
    h.advance(REFUSAL_QUIET_MS + 1);
    void h.ask('src/x.ts');
    void h.ask('src/y.ts');
    expect(h.inFlight()).toBe(1);
  });

  it("never asks about a name the viewer's role cannot open, and keeps one gate per connection", async () => {
    const h = host();
    expect(await h.ask('.git/config')).toBe('no');
    expect(await h.ask('.smurg/state.json')).toBe('no');
    expect(h.asked).toEqual([]);
    void h.ask('.git/config', { isHost: true });
    expect(h.asked).toEqual(['.git/config']);
    const files = { stat: async (file: FileRef) => makeEntry(file.path) };
    expect(pathGateOf(files)).toBe(pathGateOf(files));
    expect(pathGateOf({ stat: files.stat })).not.toBe(pathGateOf(files));
  });

  it('"there is no such file" is an answer, not a refusal: what waited is asked next', async () => {
    const h = host();
    const first = h.ask('src/a.ts');
    const second = h.ask('src/b.ts');
    expect(h.asked).toEqual(['src/a.ts']);
    await h.answer('not_found');
    expect(await first).toBe('no');
    expect(h.asked).toEqual(['src/a.ts', 'src/b.ts']);
    await h.answer();
    expect(await second).toBe('src/b.ts');
  });
});
