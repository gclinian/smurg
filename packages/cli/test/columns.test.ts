// src/cli/columns.ts: the lists of `smurg attach` are padded and clipped by display width (a Chinese character takes
// two terminal cells), so a column of Chinese labels, topic names or titles stays under its header.
import { describe, expect, it } from 'vitest';
import { clipColumn, displayWidth, padColumn } from '../src/cli/columns.ts';

describe('columns (display width)', () => {
  it('counts one cell per ASCII character, two per CJK or fullwidth character, none for combining marks and joiners', () => {
    expect(displayWidth('')).toBe(0);
    expect(displayWidth('running')).toBe(7);
    expect(displayWidth('執行中')).toBe(6);
    expect(displayWidth('Checkout 結帳')).toBe(13);
    expect(displayWidth('（你）')).toBe(6);
    expect(displayWidth('한글')).toBe(4);
    expect(displayWidth('カタカナ')).toBe(8);
    expect(displayWidth('é')).toBe(1); // e + a combining acute accent
    expect(displayWidth('a​b')).toBe(2); // a zero-width space
    expect(displayWidth('\u{20000}')).toBe(2); // a supplementary-plane ideograph is one character of two cells
    expect(displayWidth('2 · Payment form')).toBe(16); // the middle dot of an item's default title is narrow
  });

  it('pads to a width in cells and never cuts', () => {
    expect(padColumn('idle', 8)).toBe('idle    ');
    expect(padColumn('待命', 8)).toBe('待命    ');
    expect(displayWidth(padColumn('等待回答', 24))).toBe(24);
    expect(padColumn('longer than the column', 4)).toBe('longer than the column');
    expect(padColumn('', 3)).toBe('   ');
  });

  it('clips to a width in cells, ending a cut text with three ASCII dots; never splits a character', () => {
    expect(clipColumn('Checkout', 24)).toBe('Checkout');
    expect(clipColumn('exactly-twenty-four-cells', 25)).toBe('exactly-twenty-four-cells');
    const long = clipColumn('A very long topic name that goes on and on', 24);
    expect(long).toBe('A very long topic nam...');
    expect(displayWidth(long)).toBe(24);
    const chinese = clipColumn('重新設計結帳流程與購物車的所有頁面', 24);
    expect(chinese).toBe('重新設計結帳流程與購...');
    expect(displayWidth(chinese)).toBeLessThanOrEqual(24);
    // An odd number of cells left: the wide character that would straddle the edge is left out.
    expect(clipColumn('a重新設計結帳流程與購物車', 12)).toBe('a重新設計...');
    expect(displayWidth(clipColumn('\u{1f600}\u{1f600}\u{1f600}\u{1f600}\u{1f600}', 7))).toBeLessThanOrEqual(7);
  });
});
