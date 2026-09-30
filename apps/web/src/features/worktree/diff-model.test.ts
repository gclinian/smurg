import { describe, expect, it } from 'vitest';
import {
  buildReviewModel,
  hasInvisible,
  headerCandidates,
  parseDiffLines,
  revealInvisible,
  splitDiffSections,
  unopenedPaths,
  type MergeDiff,
  type MergeDiffFile,
} from './diff-model.ts';

const file = (path: string, overrides: Partial<MergeDiffFile> = {}): MergeDiffFile => ({ path, status: 'modified', additions: 1, deletions: 1, ...overrides });

const section = (from: string, to: string, body = '@@ -1 +1 @@\n-old\n+new\n'): string =>
  `diff --git a/${from} b/${to}\nindex 1111111..2222222 100644\n--- a/${from}\n+++ b/${to}\n${body}`;

describe('splitDiffSections', () => {
  it('splits at every diff --git line and keeps the header of each', () => {
    const diff = section('a.txt', 'a.txt') + section('dir/b c.txt', 'dir/b c.txt');
    const sections = splitDiffSections(diff);
    expect(sections.map((s) => s.header)).toEqual(['diff --git a/a.txt b/a.txt', 'diff --git a/dir/b c.txt b/dir/b c.txt']);
    expect(sections.map((s) => s.text).join('')).toBe(diff);
  });

  it('does not split inside content that mentions diff --git (content lines carry a prefix)', () => {
    const body = '@@ -1,2 +1,2 @@\n diff --git a/x b/x\n-diff --git a/y b/y\n+diff --git a/z b/z\n';
    expect(splitDiffSections(section('doc.md', 'doc.md', body))).toHaveLength(1);
  });

  it('returns nothing for an empty diff', () => {
    expect(splitDiffSections('')).toEqual([]);
  });
});

describe('buildReviewModel: which files the host must open one by one', () => {
  it('a complete diff: every file has its section, nothing blocks approval', () => {
    const diff: MergeDiff = {
      diff: section('a.txt', 'a.txt') + section('old name.txt', 'new name.txt'),
      truncated: false,
      files: [file('a.txt'), file('new name.txt', { status: 'renamed', oldPath: 'old name.txt', additions: 3, deletions: 0 })],
    };
    const model = buildReviewModel(diff);
    expect(model.mustOpen).toEqual([]);
    expect(model.files.map((f) => f.section !== null)).toEqual([true, true]);
    expect(model.totalAdditions).toBe(4);
    expect(model.totalDeletions).toBe(1);
  });

  it('a truncated diff: files without a section AND the last (possibly cut) section must be opened', () => {
    const diff: MergeDiff = {
      diff: section('a.txt', 'a.txt') + section('b.txt', 'b.txt'),
      truncated: true,
      files: [file('a.txt'), file('b.txt'), file('c.txt'), file('d.txt')],
    };
    const model = buildReviewModel(diff);
    expect(model.mustOpen).toEqual(['b.txt', 'c.txt', 'd.txt']);
    expect(model.files[0]?.section).not.toBeNull();
    expect(unopenedPaths(model, new Set(['c.txt']))).toEqual(['b.txt', 'd.txt']);
    expect(unopenedPaths(model, new Set(['b.txt', 'c.txt', 'd.txt']))).toEqual([]);
  });

  it('fails closed on headers it cannot match (quoted paths, unknown prefixes)', () => {
    const diff: MergeDiff = {
      diff: 'diff --git "a/q\\"uote.txt" "b/q\\"uote.txt"\n@@ -1 +1 @@\n-a\n+b\n' + 'diff --git x/odd.txt y/odd.txt\n@@ -1 +1 @@\n-a\n+b\n',
      truncated: false,
      files: [file('q"uote.txt'), file('odd.txt')],
    };
    expect(buildReviewModel(diff).mustOpen).toEqual(['q"uote.txt', 'odd.txt']);
  });

  it('accepts the no-prefix form (diff.noprefix in the repository config)', () => {
    const diff: MergeDiff = { diff: 'diff --git src/a.ts src/a.ts\n@@ -1 +1 @@\n-a\n+b\n', truncated: false, files: [file('src/a.ts')] };
    expect(buildReviewModel(diff).mustOpen).toEqual([]);
    expect(headerCandidates(file('n.ts', { oldPath: 'o.ts' }))).toEqual(['diff --git a/o.ts b/n.ts', 'diff --git o.ts n.ts']);
  });

  it('shows every section of a header (a type change is a deletion plus an addition)', () => {
    const removed = 'diff --git a/link b/link\ndeleted file mode 100644\n--- a/link\n+++ /dev/null\n@@ -1 +0,0 @@\n-text\n';
    const added = 'diff --git a/link b/link\nnew file mode 120000\n--- /dev/null\n+++ b/link\n@@ -0,0 +1 @@\n+../../etc\n';
    const model = buildReviewModel({ diff: removed + added, truncated: false, files: [file('link', { status: 'type-changed' })] });
    expect(model.mustOpen).toEqual([]);
    expect(model.files[0]?.section).toBe(removed + added);
  });

  it('never gives one file the section of another: an ambiguous header makes both files open on their own', () => {
    // "x b/y" (modified) and the rename "x" → "y b/x b/y" both spell `diff --git a/x b/y b/x b/y`.
    const shared = 'diff --git a/x b/y b/x b/y\n@@ -1 +1 @@\n-a\n+b\n';
    const model = buildReviewModel({
      diff: shared,
      truncated: false,
      files: [file('x b/y'), file('y b/x b/y', { status: 'renamed', oldPath: 'x' })],
    });
    expect(model.mustOpen).toEqual(['x b/y', 'y b/x b/y']);
  });

  it('a file listed but missing from an untruncated diff must still be opened (never approve unseen changes)', () => {
    const diff: MergeDiff = { diff: section('a.txt', 'a.txt'), truncated: false, files: [file('a.txt'), file('b.bin', { binary: true })] };
    expect(buildReviewModel(diff).mustOpen).toEqual(['b.bin']);
  });
});

describe('revealInvisible (Trojan Source and friends)', () => {
  it('marks bidi controls, zero-width and control characters, but not tab or CR', () => {
    const line = '+if (isAdmin) ‮ } ⁦// admin⁩ {​\tok\r';
    expect(hasInvisible(line)).toBe(true);
    expect(revealInvisible(line)).toEqual([
      { text: '+if (isAdmin) ' },
      { text: '‮', codePoint: 'U+202E' },
      { text: ' } ' },
      { text: '⁦', codePoint: 'U+2066' },
      { text: '// admin' },
      { text: '⁩', codePoint: 'U+2069' },
      { text: ' {' },
      { text: '​', codePoint: 'U+200B' },
      { text: '\tok\r' },
    ]);
    expect(revealInvisible('\u0007')).toEqual([{ text: '\u0007', codePoint: 'U+0007' }]);
  });

  it('leaves ordinary text (CJK included) alone', () => {
    expect(hasInvisible('+const 名稱 = "你好";\t// ok\r')).toBe(false);
    expect(revealInvisible('plain')).toEqual([{ text: 'plain' }]);
  });
});

describe('parseDiffLines', () => {
  it('classifies header, hunk, added, removed, context and notes with line numbers', () => {
    const text = section('a.txt', 'a.txt', '@@ -10,3 +10,3 @@ fn\n keep\n--- not a header\n+++ not a header either\n\\ No newline at end of file\n');
    const lines = parseDiffLines(text);
    expect(lines.map((l) => l.kind)).toEqual(['meta', 'meta', 'meta', 'meta', 'hunk', 'context', 'del', 'add', 'note']);
    expect(lines[5]).toMatchObject({ oldLine: 10, newLine: 10 });
    expect(lines[6]).toMatchObject({ kind: 'del', oldLine: 11 });
    expect(lines[7]).toMatchObject({ kind: 'add', newLine: 11 });
  });

  it('keeps binary notices as header lines', () => {
    const lines = parseDiffLines('diff --git a/i.png b/i.png\nindex 1..2 100644\nBinary files a/i.png and b/i.png differ\n');
    expect(lines.every((l) => l.kind === 'meta')).toBe(true);
    expect(lines).toHaveLength(3);
  });
});
