// The text an accepted suggestion may carry into a bracketed paste (SPEC R6; ARCHITECTURE §7.6 accepted suggestions).
import { describe, expect, it } from 'vitest';
import { suggestionStoredTextSchema, suggestionTextSchema } from '@smurg/protocol';
import { PASTE_END, sanitizeSuggestionForPaste } from '../../src/suggest/sanitize.ts';

describe('sanitizeSuggestionForPaste', () => {
  it('escape-sequence injection in a suggestion cannot break out of the paste: ESC [ 201 ~ and every control sequence are stripped', () => {
    const attacks = [
      `請修正\u001b[201~\rrm -rf ~\r`, // end the paste, then "type" a command and Enter
      `x\u009b201~y`, // 8-bit CSI (U+009B) variant of the same
      `a\u001b]52;c;cm0gLXJmIH4=\u0007b`, // OSC 52 clipboard write
      `a\u001b[2J\u001b[Hb`, // clear screen / move cursor
      `stop\u0003now\u0004\u001a`, // Ctrl-C, Ctrl-D, Ctrl-Z
      `bell\u0007del\u007fnul\u0000`,
      `\u001bP+q\u001b\\`, // DCS query
    ];
    for (const attack of attacks) {
      const clean = sanitizeSuggestionForPaste(attack);
      expect(clean).not.toContain('\u001b');
      expect(clean).not.toContain(PASTE_END);
      expect(clean).not.toMatch(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/);
    }
    expect(sanitizeSuggestionForPaste(`請修正\u001b[201~\rrm -rf ~\r`)).toBe('請修正[201~\nrm -rf ~\n');
  });

  it('keeps tabs and newlines, turns CRLF and lone CR into LF, and removes bidi controls and lone surrogates', () => {
    expect(sanitizeSuggestionForPaste('a\tb\nc')).toBe('a\tb\nc');
    expect(sanitizeSuggestionForPaste('a\r\nb\rc')).toBe('a\nb\nc');
    expect(sanitizeSuggestionForPaste('safe ‮evil‬ text')).toBe('safe evil text');
    expect(sanitizeSuggestionForPaste('x\ud800y')).toBe('xy');
    expect(sanitizeSuggestionForPaste('中文 🙂 ok')).toBe('中文 🙂 ok');
  });

  it('is idempotent and leaves every text the protocol accepts unchanged', () => {
    const samples = ['修正第 42 行的錯誤', 'line 1\n\tindented\nline 3', 'function f() {\n  return 1;\n}\n', '[201~ looks like a marker but has no ESC', ' '.repeat(3) + 'x'];
    for (const sample of samples) {
      expect(suggestionTextSchema.safeParse(sample).success).toBe(true);
      expect(sanitizeSuggestionForPaste(sample)).toBe(sample);
      expect(sanitizeSuggestionForPaste(sanitizeSuggestionForPaste(sample))).toBe(sample);
    }
    // Protocol 4 takes a person's text as it arrives (the daemon cleans it: one function, agentText); what is STORED
    // and sent holds none of these.
    for (const bad of ['a\u001b[201~b', 'a\u009bb', 'a\rb', 'a\u0003b']) {
      expect(suggestionTextSchema.safeParse(bad).success).toBe(true);
      expect(suggestionStoredTextSchema.safeParse(bad).success).toBe(false);
      expect(suggestionStoredTextSchema.safeParse(sanitizeSuggestionForPaste(bad)).success).toBe(true);
    }
  });
});
