// Suggestion text rules and the direct paste into one's own session (SPEC R6).
import { describe, expect, it } from 'vitest';
import { MAIN_ROOT, SUGGESTION_TEXT_MAX_CHARS } from '@smurg/protocol';
import { bracketedPaste, cleanSuggestionText, lineRange, quoteSelection, sourceOf, suggestionTextProblem } from './text.ts';

const decode = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);

describe('suggestion text', () => {
  it('normalises line ends and removes control characters except tab and newline (above all ESC)', () => {
    expect(cleanSuggestionText('a\r\nb\rc\td\x1b[201~e\x07\x00f\u009bg')).toBe('a\nb\nc\td[201~efg');
  });

  it('refuses blank, too long and invalid text (the daemon applies the same rule)', () => {
    expect(suggestionTextProblem('  \n\t ')).toBe('blank');
    expect(suggestionTextProblem('x'.repeat(SUGGESTION_TEXT_MAX_CHARS + 1))).toBe('too-long');
    expect(suggestionTextProblem('請補上測試')).toBeNull();
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
    expect(quoted.startsWith('src/app.ts 第 3–5 行：\n````\n')).toBe(true);
    expect(quoted).toContain('const a = 1;\n```\nx\n````');
    expect(lineRange(7, 7)).toBe('7');
  });

  it('keeps the source reference only for a real file range', () => {
    expect(sourceOf(selection)).toEqual({ file: selection.file, startLine: 3, endLine: 5 });
    expect(sourceOf({ ...selection, file: { root: MAIN_ROOT, path: '' } })).toBeNull();
    expect(sourceOf({ ...selection, startLine: 6 })).toBeNull();
  });
});
