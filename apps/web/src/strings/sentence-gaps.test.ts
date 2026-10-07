// Two sentences in one line, or a sentence and the link that follows it, are never glued with a literal space in the
// source: a Chinese sentence ends in a full-width full stop that carries its own gap, and "。 負責人…" reads as a hole
// (review R6-12 item 11). `joinSentences([...])` and `gapAfter(sentence)` of lib/format.ts put the gap where the
// language wants one. This test reads the source for the ways such a space was written.
import { describe, expect, it } from 'vitest';
import { gapAfter, joinSentences } from '../lib/format.ts';

const SOURCES = import.meta.glob(['../**/*.ts', '../**/*.tsx', '!../**/*.test.ts', '!../**/*.test.tsx', '!../testing/**', '!../**/strings*.ts', '!../**/dev/**'], { query: '?raw', import: 'default', eager: true }) as Record<string, string>;

/** A call of a catalogue's translator. */
const T = String.raw`\b(?:t|tApp|tConn|tJoin|tStores|tUi|tWorkbench)\(`;
const WAYS: readonly { readonly what: string; readonly pattern: RegExp }[] = [
  { what: "a translated text followed by {' '}", pattern: new RegExp(String.raw`${T}[^\n]*\)\}\{' '\}`) },
  { what: 'two expressions with a space between them, one of them a translated text', pattern: new RegExp(String.raw`\{[^{}\n]*${T}[^\n]*\)\} \{(?!'·'\})|\} \{[^{}\n]*${T}`) },
  { what: 'a template that begins with a space and a translated text', pattern: new RegExp(String.raw`\` \$\{${T}`) },
  { what: 'a template that puts a space between two texts it was handed', pattern: /\$\{(?:by|insteadOf|text|sentence|line\.text|problem|others|lead)\} \$\{/ },
  { what: "sentences joined with join(' ')", pattern: /\b(?:text|parts|sentences|lines)\.join\(' '\)/ },
  { what: "a text someone wrote, a closing tag and {' '}", pattern: /\{(?:line\.text|part\.text)\}\s*<\/span>\{' '\}/ },
  { what: 'a sentence in a variable and a space before what follows it', pattern: /\{(?:problem|accountText|failure)\} \{/ },
];

describe('sentences in one line', () => {
  it('no source file glues translated sentences, or a sentence and its link, with a literal space', () => {
    const found: string[] = [];
    for (const [path, source] of Object.entries(SOURCES)) {
      for (const way of WAYS) {
        const match = new RegExp(way.pattern.source, 'g').exec(source);
        if (match !== null) found.push(`${path.replace('../', '')}:${source.slice(0, match.index).split('\n').length}: ${way.what}`);
      }
    }
    expect(found).toEqual([]);
  });

  it('the gap after a sentence: a space, or nothing after Chinese and full-width punctuation', () => {
    expect(gapAfter('Claude is idle.')).toBe(' ');
    expect(gapAfter('Claude 待命中。')).toBe('');
    expect(gapAfter('無法開始：')).toBe('');
    expect(gapAfter('（代替 Amy）')).toBe('');
    expect(gapAfter('Claude 工作中')).toBe(' ');
    expect(gapAfter('')).toBe('');
    expect(gapAfter(null)).toBe('');
    expect(joinSentences(['Mei 在 05:12 看過了。', '（代替 Amy）', '已合併到主工作區。'])).toBe('Mei 在 05:12 看過了。（代替 Amy）已合併到主工作區。');
    expect(joinSentences(['Reviewed by Mei at 05:12.', '(instead of Amy)', 'Merged into the main workspace.'])).toBe('Reviewed by Mei at 05:12. (instead of Amy) Merged into the main workspace.');
  });
});
