// The host's review of a merge request (SPEC R9 「主人看到完整 diff」, ARCHITECTURE §5.7), as pure functions.
//
// worktree.merge.diff returns the COMPLETE file list but a unified diff capped at 1 MiB (`truncated`; the daemon cuts
// at a file boundary, except when one file alone is bigger). The review therefore splits the diff into one section per
// file, keeps a section only when it is known to be complete, and lists every other file as one the host must open on
// its own (worktree.merge.fileDiff). 「合併」 is offered only when that list is exhausted.
//
// Everything that cannot be matched with certainty is treated as incomplete (fail closed): a file whose header git
// had to quote, a prefix configuration we do not recognise, the last section of a cut diff. That costs the host one
// more click, never an unseen change.
import type { ResultOf } from '@smurg/protocol';

export type MergeDiff = ResultOf<'worktree.merge.diff'>;
export type MergeDiffFile = MergeDiff['files'][number];
export type MergeFileDiff = ResultOf<'worktree.merge.fileDiff'>;

/** One file of the request as the review shows it. */
export interface ReviewFile {
  readonly file: MergeDiffFile;
  /** The file's complete section of the whole diff, or null when it has to be fetched with worktree.merge.fileDiff. */
  readonly section: string | null;
}

export interface ReviewModel {
  readonly files: readonly ReviewFile[];
  /** Paths (in list order) the host must open one by one before approving. */
  readonly mustOpen: readonly string[];
  readonly totalAdditions: number;
  readonly totalDeletions: number;
}

const HEADER = 'diff --git ';

/** Start offsets of every section: a line that begins with `diff --git ` (content lines never do: they carry a prefix). */
function sectionStarts(diff: string): number[] {
  const starts: number[] = [];
  if (diff.startsWith(HEADER)) starts.push(0);
  let at = diff.indexOf(`\n${HEADER}`);
  while (at !== -1) {
    starts.push(at + 1);
    at = diff.indexOf(`\n${HEADER}`, at + 1);
  }
  return starts;
}

export interface DiffSection {
  /** The `diff --git …` line. */
  readonly header: string;
  /** The whole section, header included. */
  readonly text: string;
}

/** Splits a unified diff into its per-file sections (anything before the first header is dropped). */
export function splitDiffSections(diff: string): DiffSection[] {
  const starts = sectionStarts(diff);
  return starts.map((start, index) => {
    const end = starts[index + 1] ?? diff.length;
    const text = diff.slice(start, end);
    const newline = text.indexOf('\n');
    return { header: newline === -1 ? text : text.slice(0, newline), text };
  });
}

/**
 * The header lines git writes for `file`: `diff --git a/<old> b/<new>` (the daemon runs git with quotePath off and an
 * isolated global config), or without prefixes when the repository sets diff.noprefix. A path git must quote (quotes,
 * backslashes, control characters) matches neither: that file is then fetched on its own.
 */
export function headerCandidates(file: MergeDiffFile): string[] {
  const from = file.oldPath ?? file.path;
  return [`${HEADER}a/${from} b/${file.path}`, `${HEADER}${from} ${file.path}`];
}

export function buildReviewModel(diff: MergeDiff): ReviewModel {
  const sections = splitDiffSections(diff.diff);
  // A cut diff may end inside its last section (a single file larger than the cap, or text that grew when invalid bytes
  // became U+FFFD): never trust the last one then.
  const trusted = diff.truncated ? sections.slice(0, -1) : sections;
  // One header can own several sections: git shows a type change (file ⇄ symlink) as a deletion plus an addition.
  const byHeader = new Map<string, string[]>();
  for (const section of trusted) byHeader.set(section.header, [...(byHeader.get(section.header) ?? []), section.text]);
  const claimed = diff.files.map((file) => headerCandidates(file).find((header) => byHeader.has(header)) ?? null);
  // File names may contain " b/": two files can spell the same header. Showing either file the other's section would
  // hide a change, so an ambiguous header is nobody's: both files are fetched on their own.
  const claims = new Map<string, number>();
  for (const header of claimed) if (header !== null) claims.set(header, (claims.get(header) ?? 0) + 1);
  let totalAdditions = 0;
  let totalDeletions = 0;
  const files = diff.files.map((file, index): ReviewFile => {
    totalAdditions += file.additions;
    totalDeletions += file.deletions;
    const header = claimed[index] ?? null;
    const section = header !== null && claims.get(header) === 1 ? (byHeader.get(header) ?? []).join('') : null;
    return { file, section };
  });
  return {
    files,
    mustOpen: files.filter((entry) => entry.section === null).map((entry) => entry.file.path),
    totalAdditions,
    totalDeletions,
  };
}

/** The paths still blocking 「合併」: those of `mustOpen` that were not opened (successfully) yet. */
export function unopenedPaths(model: ReviewModel, opened: ReadonlySet<string>): string[] {
  return model.mustOpen.filter((path) => !opened.has(path));
}

// ---------------------------------------------------------------------------------------------------------------
// Lines of one section, for display
// ---------------------------------------------------------------------------------------------------------------

export type DiffLineKind = 'meta' | 'hunk' | 'add' | 'del' | 'context' | 'note';

export interface DiffLine {
  readonly kind: DiffLineKind;
  readonly text: string;
  /** 1-based line numbers inside hunks (old side for del/context, new side for add/context). */
  readonly oldLine?: number;
  readonly newLine?: number;
}

const HUNK = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

/**
 * Classifies the lines of one file's diff. Before the first hunk everything is git's header (`index`, `---`, `+++`,
 * `rename from`, `Binary files … differ`); inside a hunk the first character decides, so a removed line that reads
 * `-- x` is not mistaken for a `---` header.
 */
export function parseDiffLines(section: string): DiffLine[] {
  const raw = section.endsWith('\n') ? section.slice(0, -1) : section;
  if (raw === '') return [];
  const lines: DiffLine[] = [];
  let inHunk = false;
  let oldLine = 0;
  let newLine = 0;
  for (const text of raw.split('\n')) {
    const hunk = HUNK.exec(text);
    if (hunk) {
      inHunk = true;
      oldLine = Number(hunk[1]);
      newLine = Number(hunk[2]);
      lines.push({ kind: 'hunk', text });
      continue;
    }
    if (text.startsWith(HEADER)) {
      inHunk = false;
      lines.push({ kind: 'meta', text });
      continue;
    }
    if (!inHunk) {
      lines.push({ kind: 'meta', text });
      continue;
    }
    switch (text[0]) {
      case '+':
        lines.push({ kind: 'add', text, newLine: newLine++ });
        break;
      case '-':
        lines.push({ kind: 'del', text, oldLine: oldLine++ });
        break;
      case '\\':
        lines.push({ kind: 'note', text });
        break;
      default:
        // ' ' (or an empty line from a tool that strips trailing blanks): unchanged on both sides.
        lines.push({ kind: 'context', text, oldLine: oldLine++, newLine: newLine++ });
    }
  }
  return lines;
}

// ---------------------------------------------------------------------------------------------------------------
// Invisible characters
// ---------------------------------------------------------------------------------------------------------------

/**
 * Characters that change what code means or how it reads without being seen: bidirectional controls ("Trojan
 * Source": the host would review a different order of tokens than the compiler reads), zero-width characters and
 * control characters (tab and CR excepted: CRLF files end every line with one).
 */
const INVISIBLE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f؜​-‏‪-‮⁠-⁤⁦-⁩﻿]/u;
const INVISIBLE_ALL = new RegExp(INVISIBLE.source, 'gu');

export interface TextPiece {
  readonly text: string;
  /** Set for an invisible character: its code point as `U+202E`. */
  readonly codePoint?: string;
}

export function hasInvisible(text: string): boolean {
  return INVISIBLE.test(text);
}

/** Splits `text` so every invisible character can be shown as a visible marker. */
export function revealInvisible(text: string): TextPiece[] {
  if (!INVISIBLE.test(text)) return [{ text }];
  const pieces: TextPiece[] = [];
  let at = 0;
  for (const match of text.matchAll(INVISIBLE_ALL)) {
    const index = match.index;
    if (index > at) pieces.push({ text: text.slice(at, index) });
    const code = match[0].codePointAt(0) ?? 0;
    pieces.push({ text: match[0], codePoint: `U+${code.toString(16).toUpperCase().padStart(4, '0')}` });
    at = index + match[0].length;
  }
  if (at < text.length) pieces.push({ text: text.slice(at) });
  return pieces;
}

/** Abbreviated commit id for display (the full id stays available as a tooltip). */
export function shortCommit(commit: string): string {
  return commit.slice(0, 10);
}
