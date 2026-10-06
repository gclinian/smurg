// docs/ACCEPTANCE.md names, for every SPEC criterion, the tests that prove it: `file` › "title". A renamed test would
// leave the document pointing at nothing, so every reference is checked against the tree:
//
//   `path/to/x.test.ts` › "title"                    one title
//   `path/to/x.test.ts` › "describe" › "it"          nested titles: each is checked on its own
//   `path/to/x.test.ts` › "a …" and › "b"            several titles of one file
//   `path/to/x.test.ts`                              the file alone (must exist)
//
// A quoted title belongs to the nearest test file named before it in the same table cell (outside a table: the same
// paragraph or list item). "…" abbreviates: every piece between "…" must occur in the file, in that order. A table cell
// that starts with "— (was" records tests that were removed with their code and is not checked.
//
// While v0.5.0 is being built, the references of pending-v050.ts wait for the package that replaces the test they
// named; with SMURG_RELEASE_GATE=1 nothing waits.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PENDING_ACCEPTANCE_REFS, RELEASE_GATE, isPendingAcceptanceRef } from './pending-v050.ts';
import { read, REPO_ROOT } from './tree.ts';

const DOC = 'docs/ACCEPTANCE.md';
/** The path abbreviations the document uses. */
const PREFIXES: readonly (readonly [string, string])[] = [
  ['daemon/', 'packages/daemon/test/'],
  ['web/', 'apps/web/'],
  ['cli/', 'packages/cli/'],
];
const LITERAL = ['packages/', 'apps/', 'tests/', 'scripts/'];
/** A bare file name is a file of the cross-package acceptance tests. */
const BARE = 'tests/e2e/test/';
const COLUMN_HEADING = '(file › test)';

function resolve(ref: string): string | null {
  for (const [short, full] of PREFIXES) if (ref.startsWith(short)) return full + ref.slice(short.length);
  if (LITERAL.some((prefix) => ref.startsWith(prefix))) return ref;
  return ref.includes('/') ? null : BARE + ref;
}

const sources = new Map<string, string>();
function source(path: string): string {
  let text = sources.get(path);
  if (text === undefined) {
    text = read(path).replaceAll("\\'", "'").replaceAll('\\"', '"').replaceAll('\\`', '`');
    sources.set(path, text);
  }
  return text;
}

/** `[first line, text]` of every table cell, and of every paragraph or list item outside tables. */
function units(lines: readonly string[]): [number, string][] {
  const out: [number, string][] = [];
  let paragraph: string[] = [];
  let start = 0;
  let fence = false;
  const flush = (): void => {
    if (paragraph.length > 0) out.push([start, paragraph.join(' ')]);
    paragraph = [];
  };
  lines.forEach((line, index) => {
    const n = index + 1;
    if (line.startsWith('```')) {
      flush();
      fence = !fence;
      return;
    }
    if (fence) {
      out.push([n, line]);
      return;
    }
    if (line.startsWith('|')) {
      flush();
      for (const cell of line.split(/(?<!\\)\|/).slice(1, -1)) out.push([n, cell.replaceAll('\\|', '|').trim()]);
      return;
    }
    if (line.trim() === '' || /^\s*(?:- |\d+\. |#)/.test(line)) flush();
    if (line.trim() !== '') {
      if (paragraph.length === 0) start = n;
      paragraph.push(line.trim());
    }
  });
  flush();
  return out;
}

function check(): { problems: string[]; files: number; titles: number; pending: number } {
  const problems: string[] = [];
  let files = 0;
  let titles = 0;
  let pending = 0;
  for (const [n, raw] of units(read(DOC).split('\n'))) {
    if (raw.startsWith('— (was')) continue;
    const text = raw.replaceAll(COLUMN_HEADING, '');
    const marks: { at: number; kind: 'file' | 'title'; value: string }[] = [];
    for (const match of text.matchAll(/`([^`\s]+\.test\.tsx?)`/g)) marks.push({ at: match.index as number, kind: 'file', value: match[1] as string });
    const quoted = new Set<number>();
    for (const match of text.matchAll(/›\s*"([^"]*)"/g)) {
      marks.push({ at: match.index as number, kind: 'title', value: match[1] as string });
      quoted.add(match.index as number);
    }
    for (const match of text.matchAll(/›/g)) {
      if (!quoted.has(match.index as number)) problems.push(`${DOC}:${n}: a › that is not followed by a "quoted title": ${text.slice(Math.max(0, (match.index as number) - 60), (match.index as number) + 60)}`);
    }
    let current: { ref: string; path: string } | 'pending' | null = null;
    for (const mark of marks.sort((a, b) => a.at - b.at)) {
      if (mark.kind === 'file') {
        files += 1;
        const path = resolve(mark.value);
        if (path === null || !existsSync(join(REPO_ROOT, path))) {
          if (isPendingAcceptanceRef(mark.value)) {
            // The file went with the behaviour it tested; its titles wait with it.
            pending += 1;
            current = 'pending';
            continue;
          }
          problems.push(`${DOC}:${n}: \`${mark.value}\` -> ${path}: no such file`);
          current = null;
        } else current = { ref: mark.value, path };
        continue;
      }
      titles += 1;
      if (current === 'pending') continue;
      if (current === null) {
        problems.push(`${DOC}:${n}: "${mark.value}" has no (existing) test file before it`);
        continue;
      }
      const pieces = mark.value
        .split('…')
        .map((piece) => piece.trim())
        .filter((piece) => piece !== '');
      if (pieces.length === 0) {
        problems.push(`${DOC}:${n}: \`${current.ref}\` › "${mark.value}": nothing to check`);
        continue;
      }
      const text = source(current.path);
      let at = 0;
      for (const piece of pieces) {
        const found = text.indexOf(piece, at);
        if (found < 0) {
          if (isPendingAcceptanceRef(current.ref, piece)) {
            pending += 1;
            break;
          }
          problems.push(`${DOC}:${n}: \`${current.ref}\` › "${piece}": ${text.includes(piece) ? 'in the file, but not after the piece before it' : 'not in the file'} (${current.path})`);
          break;
        }
        at = found + piece.length;
      }
    }
  }
  return { problems, files, titles, pending };
}

describe('docs/ACCEPTANCE.md points at tests that exist', () => {
  const result = check();

  it('every `file` › "title" reference resolves to a file of the tree and a title in it', () => {
    expect(result.problems).toEqual([]);
  });

  it('reads the references (a change of the syntax must not turn the check into nothing)', () => {
    expect(result.files).toBeGreaterThan(150);
    expect(result.titles).toBeGreaterThan(100);
  });

  it('the pending list is well-formed: every entry names its package and why, no entry twice', () => {
    for (const entry of PENDING_ACCEPTANCE_REFS) {
      expect(entry.file).toMatch(/\.test\.tsx?$/);
      expect(entry.owner).toMatch(/^P(?:[1-9]|1[0-2])$/);
      expect(entry.why.length).toBeGreaterThan(20);
    }
    const keys = PENDING_ACCEPTANCE_REFS.map((entry) => `${entry.file} › ${entry.title ?? ''}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it.runIf(RELEASE_GATE)('the release gate: nothing is pending', () => {
    expect(PENDING_ACCEPTANCE_REFS).toEqual([]);
    expect(result.pending).toBe(0);
  });
});
