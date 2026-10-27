// @vitest-environment node
// What the next-step card of a result report says about an item smurg merges by itself (protocol 6, DESIGN 0.7.0 D19):
// merged, or held for a decision and who decides it; 0.6.0's words for any other item.
import { buildWorkItem } from '@smurg/protocol/testing';
import { afterEach, describe, expect, it } from 'vitest';
import { applyLocale } from '../../lib/locale.ts';
import { reportNextText } from './NextStepCard.tsx';
import type { Person } from './people.ts';

const PEOPLE: Person[] = [
  { userId: 'dev:host', displayName: 'Ian', role: 'host', color: '', online: true },
  { userId: 'dev:mei', displayName: 'Mei', role: 'agent', color: '', online: true },
];
const held = (reason: 'partial' | 'policy') => ({ state: 'held' as const, reason, since: 1, tries: 0, hostOnly: reason === 'policy', escalated: false });

afterEach(() => applyLocale('en'));

describe('the next-step card of a report: an item smurg merges', () => {
  it('merged, held for the responsible person, held for the host; nothing for an item the host merges', () => {
    const responsible = { userId: 'dev:mei', displayName: 'Mei', source: 'chosen' as const };
    expect(reportNextText(buildWorkItem({ merging: 'auto', merged: { at: 1, by: 'smurg' } }), PEOPLE)).toBe('The result report is written. smurg merged the change into the main workspace.');
    expect(reportNextText(buildWorkItem({ merging: 'auto', autoMerge: held('partial'), responsible }), PEOPLE)).toBe('The result report is written. It was not merged: not complete (partial). Mei decides.');
    expect(reportNextText(buildWorkItem({ merging: 'auto', autoMerge: held('policy'), responsible }), PEOPLE)).toBe('The result report is written. It was not merged: it changes files only the host may merge. Ian decides.');
    expect(reportNextText(buildWorkItem({ merging: 'host', merged: { at: 1, by: { userId: 'dev:host', displayName: 'Ian' } } }), PEOPLE)).toBeNull();
    applyLocale('zh-TW');
    expect(reportNextText(buildWorkItem({ merging: 'auto', autoMerge: held('partial'), responsible }), PEOPLE)).toBe('結果報告寫好了。它沒有合併：沒有完成（部分完成）。由 Mei 決定。');
    expect(reportNextText(buildWorkItem({ merging: 'auto', merged: { at: 1, by: 'smurg' } }), PEOPLE)).toBe('結果報告寫好了。smurg 已把變更合併到主工作區。');
  });
});
