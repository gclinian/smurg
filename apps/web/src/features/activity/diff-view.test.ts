import { describe, expect, it } from 'vitest';
import { DIFF_MAX_CELLS, sideBySide, splitLines } from './diff-view.ts';


const pairs = (rows: ReturnType<typeof sideBySide>) => rows.map((row) => [row.human?.text ?? null, row.agent?.text ?? null, (row.human?.changed ?? row.agent?.changed) === true]);

describe('side-by-side diff of a conflict hunk', () => {
  it('splits lines without inventing an empty last line; keeps a CR visible', () => {
    expect(splitLines('')).toEqual([]);
    expect(splitLines('a\nb\n')).toEqual(['a', 'b']);
    expect(splitLines('a\nb')).toEqual(['a', 'b']);
    expect(splitLines('\n')).toEqual(['']);
    expect(splitLines('a\r\nb')).toEqual(['a\r', 'b']);
  });

  it('aligns unchanged lines, pairs a changed line with its replacement, numbers the human side from startLine', () => {
    const human = 'function greet() {\n  return "你好，艾咪 👋";\n}\n';
    const agent = 'function greet() {\n  return "Hello";\n  // 由 agent 加上 ✅\n}\n';
    const rows = sideBySide(human, agent, 40);
    expect(pairs(rows)).toEqual([
      ['function greet() {', 'function greet() {', false],
      ['  return "你好，艾咪 👋";', '  return "Hello";', true],
      [null, '  // 由 agent 加上 ✅', true],
      ['}', '}', false],
    ]);
    expect(rows.map((row) => row.human?.line ?? null)).toEqual([40, 41, null, 42]);
    expect(rows.every((row) => row.agent === null || row.agent.line === null)).toBe(true);
  });

  it('one side empty: every line of the other is marked', () => {
    expect(pairs(sideBySide('只有人寫的\n第二行\n', '', 3))).toEqual([
      ['只有人寫的', null, true],
      ['第二行', null, true],
    ]);
    expect(pairs(sideBySide('', 'agent 刪掉又重寫\n', 3))).toEqual([[null, 'agent 刪掉又重寫', true]]);
    expect(sideBySide('', '', 1)).toEqual([]);
  });

  it('interleaved changes keep their order on each side', () => {
    const rows = sideBySide('a\nX\nb\nY\nc', 'a\nb\nZ\nc', 1);
    expect(pairs(rows)).toEqual([
      ['a', 'a', false],
      ['X', null, true],
      ['b', 'b', false],
      ['Y', 'Z', true],
      ['c', 'c', false],
    ]);
  });

  it('stays bounded on huge hunks: beyond DIFF_MAX_CELLS lines are paired by position, text still exact', () => {
    const size = Math.ceil(Math.sqrt(DIFF_MAX_CELLS)) + 10;
    const human = Array.from({ length: size }, (_, i) => `human ${i} 中文`).join('\n');
    const agent = Array.from({ length: size }, (_, i) => `agent ${i} 🙂`).join('\n');
    const started = performance.now();
    const rows = sideBySide(human, agent, 1);
    expect(performance.now() - started).toBeLessThan(2_000);
    expect(rows).toHaveLength(size);
    expect(rows[5]).toEqual({ human: { line: 6, text: 'human 5 中文', changed: true }, agent: { line: null, text: 'agent 5 🙂', changed: true } });
  });
});
