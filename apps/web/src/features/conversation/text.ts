// Small pure helpers of the conversation column: what is shown of text people are asked to allow, how
// paths are put into a sentence, the quote a code selection becomes.
import type { FileRef } from '@smurg/protocol';
import { trimEndOf } from '../../lib/trim.ts';

// eslint-disable-next-line no-control-regex
const HIDDEN = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u061c\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff]/g;

/**
 * Text a person is asked to allow (a command, an input), with every character a reader cannot see made visible: C0
 * controls as their control pictures (ESC → ␛), everything else that hides or reorders text (bidirectional controls,
 * zero-width characters) as its code point (⟦U+202E⟧). Tab and line feed stay: they are layout.
 */
export function showControls(text: string): string {
  return text.replace(HIDDEN, (char) => {
    const code = char.charCodeAt(0);
    if (code < 0x20) return String.fromCharCode(0x2400 + code);
    if (code === 0x7f) return '\u2421';
    return `\u27e6U+${code.toString(16).toUpperCase().padStart(4, '0')}\u27e7`;
  });
}

/** The folder every path is in ("src/cart"), or null when they share none (or there is one path at the root). */
export function commonDir(paths: readonly string[]): string | null {
  if (paths.length === 0) return null;
  let shared = (paths[0] as string).split('/').slice(0, -1);
  for (const path of paths.slice(1)) {
    const parts = path.split('/').slice(0, -1);
    let length = 0;
    while (length < shared.length && length < parts.length && shared[length] === parts[length]) length++;
    shared = shared.slice(0, length);
    if (shared.length === 0) return null;
  }
  return shared.length === 0 ? null : shared.join('/');
}

/** The first `words` words of a command ("pnpm add" of "pnpm add left-pad"): what a sentence names it by. */
export function commandHead(command: string, words: number): string {
  return command.trim().split(/\s+/u).slice(0, words).join(' ');
}

/**
 * What a Bash rule's pattern says in words: `pnpm test *` allows "commands that start with pnpm test" (the star at the
 * end is the rule's own syntax). The pattern is made from a command an agent wrote: one pass, not `/\s*\*$/`.
 */
export function commandsOfRule(pattern: string): string {
  return pattern.endsWith('*') ? pattern.slice(0, -1).trimEnd() : pattern;
}

export function lineRange(startLine: number, endLine: number): string {
  return startLine === endLine ? String(startLine) : `${startLine}–${endLine}`;
}

/** The longest run of backticks in `text`, so a fence around it can be one longer. */
function longestBackticks(text: string): number {
  let longest = 0;
  for (const run of text.match(/`+/g) ?? []) longest = Math.max(longest, run.length);
  return longest;
}

/**
 * A code selection as text for a message or a suggestion: where it is from (the path, the lines, the worktree when it
 * is not the main workspace), then the lines in a fence that the code itself cannot close. The form is the one the
 * editor takes its size bound on (features/editor/selection.ts `formatSelectionForAgent`): nothing is added to it.
 */
export function quoteSelection(selection: { readonly file: FileRef; readonly startLine: number; readonly endLine: number; readonly text: string }): string {
  const body = trimEndOf(selection.text.replace(/\r\n?/g, '\n'), '\n');
  const fence = '`'.repeat(Math.max(3, longestBackticks(body) + 1));
  const range = selection.startLine === selection.endLine ? `${selection.startLine}` : `${selection.startLine}-${selection.endLine}`;
  const worktree = selection.file.root.kind === 'worktree' ? ` (worktree ${selection.file.root.worktreeId})` : '';
  return `${selection.file.path}:${range}${worktree}\n${fence}\n${body}\n${fence}`;
}

/** The DOM id of a card inside a column (two columns never show the same session, so the card id is enough). */
export function cardDomId(cardId: string): string {
  return `conv-card-${cardId.replace(/[^A-Za-z0-9_-]/g, '_')}`;
}
