// "Send to agent" (SPEC R6): an editor selection becomes text for an agent session — a direct paste for those who may type
// into sessions (the host and agent access, any session: `session.drive`), a suggestion for editors. The command carries the file and the line range with the code (the
// suggest feature puts them in front of it: the agent only sees text), and the code is cleaned for the terminal: it
// ends up in a PTY as a bracketed paste, where ESC or a C1 control could end the paste early and turn the rest into
// keystrokes (the protocol refuses them anyway), and bidi overrides could make it read differently than it runs.
import { SUGGESTION_TEXT_MAX_CHARS, type FileRef, type SessionInfo } from '@smurg/protocol';
import type { Capabilities } from '../../lib/capabilities.ts';
import type { CommandMap } from '../../lib/commands.ts';

/** A Monaco selection in 1-based lines and columns (what the view reports). */
export interface EditorSelection {
  readonly startLine: number;
  readonly startColumn: number;
  readonly endLine: number;
  readonly endColumn: number;
}

/** Control characters other than tab and LF, bidi embeddings/overrides/isolates ("Trojan Source"), lone surrogates. */
// With the `u` flag a surrogate range in a class matches only LONE surrogates (a pair is one code point).
const UNSAFE = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069\ud800-\udfff]/gu;

/** Replaces what must not reach a terminal with U+FFFD (visible, so nobody is surprised by a silent change). */
export function sanitizeForAgent(text: string): string {
  return text.replace(/\r\n?/g, '\n').replace(UNSAFE, '\ufffd');
}

/**
 * The inclusive 1-based line range of a selection. A selection that ends at column 1 of a line does not include that
 * line (selecting whole lines with the mouse or Shift+Down ends there).
 */
export function selectionLines(selection: EditorSelection): { startLine: number; endLine: number } {
  const forward =
    selection.startLine < selection.endLine || (selection.startLine === selection.endLine && selection.startColumn <= selection.endColumn);
  const [start, end] = forward
    ? [{ line: selection.startLine }, { line: selection.endLine, column: selection.endColumn }]
    : [{ line: selection.endLine }, { line: selection.startLine, column: selection.startColumn }];
  const endLine = end.line > start.line && end.column === 1 ? end.line - 1 : end.line;
  return { startLine: start.line, endLine };
}

export function isEmptySelection(selection: EditorSelection | null): boolean {
  return selection === null || (selection.startLine === selection.endLine && selection.startColumn === selection.endColumn);
}

/** A code fence longer than any backtick run inside the code. */
function fenceFor(code: string): string {
  let longest = 0;
  for (const match of code.matchAll(/`+/g)) longest = Math.max(longest, match[0].length);
  return '`'.repeat(Math.max(3, longest + 1));
}

/**
 * The line above the quoted code: `path:12-20` (one line: `path:12`), with ` (worktree <id>)` for a file of a
 * worktree. Fixed, in no language: an agent reads it in the terminal and the host's audit log stores it.
 */
export function selectionHeader(input: { file: FileRef; startLine: number; endLine: number }): string {
  const range = input.startLine === input.endLine ? `${input.startLine}` : `${input.startLine}-${input.endLine}`;
  const worktree = input.file.root.kind === 'worktree' ? ` (worktree ${input.file.root.worktreeId})` : '';
  return sanitizeForAgent(`${input.file.path}:${range}${worktree}`);
}

export function formatSelectionForAgent(input: { file: FileRef; startLine: number; endLine: number; code: string }): string {
  const code = sanitizeForAgent(input.code).replace(/\n+$/, '');
  const fence = fenceFor(code);
  return `${selectionHeader(input)}\n${fence}\n${code}\n${fence}`;
}

export type SelectionPayload =
  | { readonly ok: true; readonly payload: CommandMap['sendSelectionAsSuggestion'] }
  | { readonly ok: false; readonly problem: 'empty' | 'too-large' };

/**
 * The command payload for a selection; `sessionId` undefined lets the suggest feature ask which session.
 *
 * The file and the line range travel as their own fields and `text` is the selected code itself (cleaned for a
 * terminal): the suggest feature, which handles the command, quotes it under `<path>:<range>` in a fence for a
 * suggestion and pastes it into one's own session. Pre-quoting here would quote it twice. The size bound is taken on
 * the quoted form (formatSelectionForAgent), which is what a suggestion ends up carrying.
 */
export function buildSelectionPayload(file: FileRef, selection: EditorSelection | null, selectedText: string, sessionId?: string): SelectionPayload {
  if (selection === null || isEmptySelection(selection) || selectedText.trim() === '') return { ok: false, problem: 'empty' };
  const { startLine, endLine } = selectionLines(selection);
  const code = sanitizeForAgent(selectedText).replace(/\n+$/, '');
  if (formatSelectionForAgent({ file, startLine, endLine, code }).length > SUGGESTION_TEXT_MAX_CHARS) return { ok: false, problem: 'too-large' };
  return { ok: true, payload: { file, startLine, endLine, text: code, ...(sessionId === undefined ? {} : { sessionId }) } };
}

export interface SessionTargets {
  /** Running agent sessions the member types into (the host and agent access: every one): the selection goes straight in. */
  readonly own: readonly SessionInfo[];
  /** Running agent sessions the member may only suggest to (an editor: other people's): someone who may type decides. */
  readonly others: readonly SessionInfo[];
}

/**
 * Where a selection may go. Terminals are never offered: pasted code would run as shell commands. Typing needs
 * `session.drive`; suggestions need `suggest.create` and never target one's own session (the daemon's rule).
 */
export function sessionTargets(sessions: readonly SessionInfo[], userId: string | null, caps: Pick<Capabilities, 'can' | 'canDrive'>): SessionTargets {
  const running = sessions.filter((session) => session.kind === 'agent' && session.status !== 'exited');
  if (userId === null) return { own: [], others: [] };
  if (caps.canDrive) return { own: running, others: [] };
  return { own: [], others: caps.can('suggest.create') ? running.filter((session) => session.ownerUserId !== userId) : [] };
}

/** Whether the "Send to agent" action is offered at all for this role. */
export function canSendToAgent(caps: Pick<Capabilities, 'can' | 'canDrive'>): boolean {
  return caps.can('suggest.create') || caps.canDrive;
}
