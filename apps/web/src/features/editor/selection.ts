// "Send to agent" (SPEC R6): an editor selection becomes text for an agent session: a message from those who may
// message agents (the host and agent access, any session: `session.drive`), a suggestion from an editor. With
// protocol 4 that is `session.message.send` / `suggest.create` with `origin: 'selection'`; the conversation feature
// handles the command and sends it. The command carries the file and the line range with the code (the handler puts
// them in front of it: the agent only reads text). The code is cleaned first: control characters could end up in a
// shell command the agent copies, and bidi overrides could make it read differently than it runs.
import { SUGGESTION_TEXT_MAX_CHARS, isSessionOver, type FileRef, type SessionInfo } from '@smurg/protocol';
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
 * worktree. Fixed, in no language: an agent reads it and the host's audit log stores it.
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
 * The command payload for a selection; `sessionId` undefined lets the handler ask which session.
 *
 * The file and the line range travel as their own fields and `text` is the selected code itself (cleaned): the
 * conversation feature, which handles the command, quotes it under `<path>:<range>` in a fence. Pre-quoting here
 * would quote it twice. The size bound is taken on the quoted form (formatSelectionForAgent), which is what the
 * message or suggestion ends up carrying.
 */
export function buildSelectionPayload(file: FileRef, selection: EditorSelection | null, selectedText: string, sessionId?: string): SelectionPayload {
  if (selection === null || isEmptySelection(selection) || selectedText.trim() === '') return { ok: false, problem: 'empty' };
  const { startLine, endLine } = selectionLines(selection);
  const code = sanitizeForAgent(selectedText).replace(/\n+$/, '');
  if (formatSelectionForAgent({ file, startLine, endLine, code }).length > SUGGESTION_TEXT_MAX_CHARS) return { ok: false, problem: 'too-large' };
  return { ok: true, payload: { file, startLine, endLine, text: code, ...(sessionId === undefined ? {} : { sessionId }) } };
}

export interface SessionTargets {
  /** Running agent sessions the member messages directly (the host and agent access: every one). */
  readonly own: readonly SessionInfo[];
  /** Running agent sessions the member may only suggest to (an editor: every one); someone with agent access decides. */
  readonly others: readonly SessionInfo[];
}

/**
 * Where a selection may go. Terminals are never offered: pasted code would run as shell commands. A message needs
 * `session.drive`; a suggestion needs `suggest.create`. (Protocol 4 has no "never to one's own session" rule: an
 * editor opens no sessions.)
 */
export function sessionTargets(sessions: readonly SessionInfo[], caps: Pick<Capabilities, 'can' | 'canDrive'>): SessionTargets {
  const running = sessions.filter((session) => session.kind === 'agent' && !isSessionOver(session));
  if (caps.canDrive) return { own: running, others: [] };
  return { own: [], others: caps.can('suggest.create') ? running : [] };
}

/** Whether the "Send to agent" action is offered at all for this role. */
export function canSendToAgent(caps: Pick<Capabilities, 'can' | 'canDrive'>): boolean {
  return caps.can('suggest.create') || caps.canDrive;
}
