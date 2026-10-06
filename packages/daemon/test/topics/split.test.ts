// Who is responsible for which work item (design §4.4): the agent's proposal checked against the people it was told
// about, and smurg's even split for the rest. Pure.
import { describe, expect, it } from 'vitest';
import { checkProposal, evenSplit, type SplitItem, type SplitPerson } from '../../src/topics/split.ts';

const IAN: SplitPerson = { userId: 'dev:ian', name: 'Ian', joinedAt: 1 };
const MEI: SplitPerson = { userId: 'dev:mei', name: 'Mei', joinedAt: 2 };
const KEN: SplitPerson = { userId: 'dev:ken', name: 'Ken', joinedAt: 3 };

function item(id: string, number: number, size: SplitItem['size'] = 'm', dependsOn: string[] = []): SplitItem {
  return { id, number, size, dependsOn };
}

function loadOf(assigned: ReadonlyMap<string, string>, items: readonly SplitItem[]): Record<string, number> {
  const weight = { s: 1, m: 2, l: 3 } as const;
  const out: Record<string, number> = {};
  for (const [id, userId] of assigned) out[userId] = (out[userId] ?? 0) + weight[(items.find((entry) => entry.id === id) as SplitItem).size];
  return out;
}

describe('T3.2 the suggested split', () => {
  it("the agent's pair is kept when its item may be proposed for and its person matches exactly one of the people (any case)", () => {
    const checked = checkProposal(new Set(['a', 'b', 'c']), [IAN, MEI], [
      { id: 'a', person: 'ian' },
      { id: 'b', person: ' MEI ' },
      { id: 'c', person: 'Amy' }, // an Editor the agent was never told about
      { id: 'zzz', person: 'Ian' }, // not an item
      { id: 'a', person: 'Mei' }, // the first pair of an item wins
    ]);
    expect([...checked.kept]).toEqual([
      ['a', 'dev:ian'],
      ['b', 'dev:mei'],
    ]);
    expect(checked.unknownPeople).toBe(1);
    expect(checked.unknownItems).toBe(2);
  });

  it('a name two people share matches nobody', () => {
    const twin: SplitPerson = { userId: 'dev:ian2', name: 'Ian', joinedAt: 9 };
    expect(checkProposal(new Set(['a']), [IAN, twin], [{ id: 'a', person: 'Ian' }])).toMatchObject({ unknownPeople: 1 });
  });

  it('independent items are spread so that the weights (s 1, m 2, l 3) come out even', () => {
    const items = [item('a', 1, 'l'), item('b', 2, 'l'), item('c', 3, 'm'), item('d', 4, 'm'), item('e', 5, 's'), item('f', 6, 's')];
    const assigned = evenSplit(items, [IAN, MEI, KEN]);
    expect(assigned.size).toBe(6);
    expect(loadOf(assigned, items)).toEqual({ 'dev:ian': 4, 'dev:mei': 4, 'dev:ken': 4 });
  });

  it('items that depend on each other stay with one person; groups go heaviest first, ties to who joined earlier', () => {
    const items = [item('a', 1, 's'), item('b', 2, 'm', ['a']), item('c', 3, 's'), item('d', 4, 's'), item('e', 5, 's')];
    const assigned = evenSplit(items, [MEI, IAN]);
    // {a, b} weighs 3 of 6: not more than 1.5 x the average (4.5), so it stays together and goes first, to Ian (joined earlier).
    expect(assigned.get('a')).toBe('dev:ian');
    expect(assigned.get('b')).toBe('dev:ian');
    expect(['c', 'd', 'e'].map((id) => assigned.get(id))).toEqual(['dev:mei', 'dev:mei', 'dev:mei']);
  });

  it('a group heavier than 1.5 x the average load is split item by item', () => {
    const items = [item('a', 1, 'l'), item('b', 2, 'l', ['a']), item('c', 3, 'l', ['b']), item('d', 4, 's')];
    const assigned = evenSplit(items, [IAN, MEI]);
    // The chain weighs 9 of 10; the average is 5: it is split.
    expect(new Set(['a', 'b', 'c'].map((id) => assigned.get(id))).size).toBe(2);
    const loads = loadOf(assigned, items);
    expect(Math.abs((loads['dev:ian'] ?? 0) - (loads['dev:mei'] ?? 0))).toBeLessThanOrEqual(3);
  });

  it('what people already carry counts: the rest goes to the lighter ones', () => {
    const items = [item('c', 3, 'm'), item('d', 4, 'm')];
    const assigned = evenSplit(items, [IAN, MEI], new Map([['dev:ian', { weight: 6, items: 2 }]]));
    expect([...assigned.values()]).toEqual(['dev:mei', 'dev:mei']);
  });

  it('with nobody present nothing is assigned; one person gets everything', () => {
    const items = [item('a', 1), item('b', 2)];
    expect(evenSplit(items, []).size).toBe(0);
    expect([...evenSplit(items, [MEI]).values()]).toEqual(['dev:mei', 'dev:mei']);
  });
});
