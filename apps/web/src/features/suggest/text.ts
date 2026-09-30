// Suggestion text and the direct paste into one's own session (SPEC R6).
//
// A suggestion ends up typed into a PTY, so it may carry no control characters but tab and newline (the protocol's
// suggestion text rule) — above all no ESC, which could end a bracketed paste early and turn the rest into keystrokes.
// The daemon cleans an accepted suggestion the same way before its paste (+ Enter); the direct paste of a selection
// into one's OWN session happens here, in the browser: bracketed paste and NO Enter (the owner reviews and submits).
import { SUGGESTION_TEXT_MAX_CHARS, suggestionTextSchema, type FileRef } from '@smurg/protocol';
import { t } from './strings.ts';

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g;

/** CRLF / CR → LF, then every control character except tab and LF removed. */
export function cleanSuggestionText(text: string): string {
  return text.replace(/\r\n?/g, '\n').replace(CONTROL, '');
}

export type TextProblem = 'blank' | 'too-long' | 'invalid';

/** Why `text` cannot be sent as a suggestion (the same rule the daemon applies), or null. */
export function suggestionTextProblem(text: string): TextProblem | null {
  if (!/\S/u.test(text)) return 'blank';
  if (text.length > SUGGESTION_TEXT_MAX_CHARS) return 'too-long';
  return suggestionTextSchema.safeParse(text).success ? null : 'invalid';
}

export function textProblemMessage(problem: TextProblem): string {
  switch (problem) {
    case 'blank':
      return t('text.blank');
    case 'too-long':
      return t('text.tooLong', { max: SUGGESTION_TEXT_MAX_CHARS });
    case 'invalid':
      return t('text.invalid');
  }
}

const encoder = new TextEncoder();

/**
 * The bytes of a bracketed paste of `text` (what a terminal sends for a paste while the program enabled bracketed
 * paste mode, as Claude Code and modern shells do): newlines as CR inside the brackets, no trailing Enter.
 */
export function bracketedPaste(text: string): Uint8Array {
  const clean = cleanSuggestionText(text).replace(/\n/g, '\r');
  return encoder.encode(`\x1b[200~${clean}\x1b[201~`);
}

export interface SelectionPayload {
  readonly file: FileRef;
  readonly startLine: number;
  readonly endLine: number;
  readonly text: string;
}

export function lineRange(startLine: number, endLine: number): string {
  return startLine === endLine ? String(startLine) : `${startLine}–${endLine}`;
}

/** The start of a suggestion made from an editor selection: where it is from, then the code in a fence. */
export function quoteSelection(selection: SelectionPayload): string {
  const code = cleanSuggestionText(selection.text).replace(/\n+$/u, '');
  let fence = '```';
  while (code.includes(fence)) fence += '`';
  const header = t('quote.header', { path: selection.file.path, range: lineRange(selection.startLine, selection.endLine) });
  return `${header}\n${fence}\n${code}\n${fence}\n\n`;
}

/** A suggestion source, when the selection has a file path (the protocol refuses the root itself). */
export function sourceOf(selection: SelectionPayload): { file: FileRef; startLine: number; endLine: number } | null {
  if (selection.file.path === '' || selection.startLine < 1 || selection.endLine < selection.startLine) return null;
  return { file: selection.file, startLine: selection.startLine, endLine: selection.endLine };
}
