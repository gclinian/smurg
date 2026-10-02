// Suggestion text rules and the direct paste into one's own session (SPEC R6).
import { describe, expect, it } from 'vitest';
import { MAIN_ROOT, SUGGESTION_TEXT_MAX_CHARS } from '@smurg/protocol';
import { applyLocale } from '../../lib/locale.ts';
import { bracketedPaste, cleanSuggestionText, lineRange, quoteSelection, resolutionReason, sourceLabel, sourceOf, suggestionTextProblem } from './text.ts';


const decode = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);

describe('suggestion text', () => {
  it('normalises line ends and removes control characters except tab and newline (above all ESC)', () => {
    expect(cleanSuggestionText('a\r\nb\rc\td\x1b[201~e\x07\x00f\u009bg')).toBe('a\nb\nc\td[201~efg');
  });

  it('refuses blank, too long and invalid text (the daemon applies the same rule)', () => {
    expect(suggestionTextProblem('  \n\t ')).toBe('blank');
    expect(suggestionTextProblem('x'.repeat(SUGGESTION_TEXT_MAX_CHARS + 1))).toBe('too-long');
    expect(suggestionTextProblem('請補上測試 / add the tests')).toBeNull();
    expect(suggestionTextProblem('bidi ‮ override')).toBe('invalid');
  });
});

describe("direct paste into one's own session: bracketed paste, no Enter", () => {
  it('wraps the text in bracketed-paste markers, newlines as CR inside, and sends no Enter after it', () => {
    const text = decode(bracketedPaste('line 1\nline 2\n'));
    expect(text).toBe('\x1b[200~line 1\rline 2\r\x1b[201~');
    expect(text.endsWith('\x1b[201~')).toBe(true);
  });

  it('an ESC in the selection cannot end the paste early and turn the rest into keystrokes', () => {
    const text = decode(bracketedPaste('safe\x1b[201~\rrm -rf ~\r'));
    expect(text.match(/\x1b\[201~/g)).toHaveLength(1);
    expect(text.endsWith('\x1b[201~')).toBe(true);
  });
});

describe('a suggestion made from an editor selection', () => {
  const selection = { file: { root: MAIN_ROOT, path: 'src/app.ts' }, startLine: 3, endLine: 5, text: 'const a = 1;\n```\nx\n' };

  it('quotes where it is from and the code in a fence the code cannot close', () => {
    const quoted = quoteSelection(selection);
    // The header is the same in every language (an agent reads it, and it is stored): `path:start-end`.
    expect(quoted.startsWith('src/app.ts:3-5\n````\n')).toBe(true);
    expect(quoteSelection({ ...selection, endLine: 3 }).startsWith('src/app.ts:3\n````\n')).toBe(true);
    applyLocale('zh-TW');
    expect(quoteSelection(selection).startsWith('src/app.ts:3-5\n````\n')).toBe(true);
    applyLocale('en');
    expect(quoted).toContain('const a = 1;\n```\nx\n````');
    expect(lineRange(7, 7)).toBe('7');
  });

  it('names the attached code as a range, or as one line', () => {
    expect(sourceLabel('src/app.ts', 3, 5)).toBe('Attached code: src/app.ts, lines 3–5');
    expect(sourceLabel('src/app.ts', 3, 3)).toBe('Attached code: src/app.ts, line 3');
  });

  it("the reason an author reads: the rejecter's own words, or why smurg closed the suggestion itself", () => {
    expect(resolutionReason({ rejectReason: 'Already done' })).toBe('Already done');
    expect(resolutionReason({})).toBeNull();
    expect(resolutionReason({ closedReason: 'session-ended' })).toBe('The session ended.');
    expect(resolutionReason({ closedReason: 'author-kicked' })).toBe('Its author was removed from the workspace.');
    expect(resolutionReason({ closedReason: 'author-demoted' })).toBe('Its author can no longer make suggestions.');
  });

  it('keeps the source reference only for a real file range', () => {
    expect(sourceOf(selection)).toEqual({ file: selection.file, startLine: 3, endLine: 5 });
    expect(sourceOf({ ...selection, file: { root: MAIN_ROOT, path: '' } })).toBeNull();
    expect(sourceOf({ ...selection, startLine: 6 })).toBeNull();
  });
});
