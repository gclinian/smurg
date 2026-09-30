// The zh-TW texts of the locks module stay valid for their schemas whatever names and paths they are built from.
import { describe, expect, it } from 'vitest';
import { activityEventSchema, displayNameSchema } from '@smurg/protocol';
import { RELAY_DISPLAY_NAME_MAX_CHARS } from '@smurg/protocol/relay';
import { agentHeldReason, agentNameFor, humanHeldReason, lockDeniedSummary, nameThen, safeDisplayName, safeToolName, summary } from '../../src/locks/text.ts';

describe('locks texts', () => {
  it('「Claude（owner）」 is a valid display name even for the longest owner name', () => {
    expect(agentNameFor('Ian')).toBe('Claude（Ian）');
    const longest = '名'.repeat(RELAY_DISPLAY_NAME_MAX_CHARS);
    const name = agentNameFor(longest);
    expect(displayNameSchema.safeParse(name).success).toBe(true);
    expect(name.startsWith('Claude（')).toBe(true);
    expect(name.endsWith('）')).toBe(true);
    expect(safeDisplayName('Amy‮', 'fallback')).toBe('Amy');
  });

  it('deny reasons name the holders and read well after Claude Code’s "PreToolUse:Edit hook error: " prefix', () => {
    expect(humanHeldReason(['Amy'])).toBe('此檔案正由 Amy 編輯中，請先處理其他檔案或稍後再試');
    expect(humanHeldReason(['A', 'B', 'C', 'D', 'E', 'F', 'G'])).toBe('此檔案正由 A、B、C、D、E 等 7 人 編輯中，請先處理其他檔案或稍後再試');
    expect(agentHeldReason('Claude（Ian）')).toBe('Claude（Ian）正在修改此檔案，請先處理其他檔案或稍後再試');
    expect(nameThen('Amy', '編輯了 x')).toBe('Amy 編輯了 x');
  });

  it('summaries are single-line and at most 500 characters, whatever the path', () => {
    const text = lockDeniedSummary('Claude（Ian）', `${'very-long-directory/'.repeat(200)}file.ts`, ['Amy'], false);
    expect(text.length).toBeLessThanOrEqual(500);
    const event = { id: 'act_1', at: 1, actor: { kind: 'system' }, kind: 'external.change', summary: summary(`a\nb\u0000c${'x'.repeat(600)}`) };
    expect(activityEventSchema.safeParse(event).success).toBe(true);
    expect(safeToolName('Edit')).toBe('Edit');
    expect(safeToolName('Edit; rm -rf /')).toBeNull();
  });
});
