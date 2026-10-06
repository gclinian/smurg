// The texts of the locks module stay valid for their schemas whatever names and paths they are built from: the agent
// name, what an agent reads (deny reasons, fixed English) and the activity sentences (message references).
import { describe, expect, it } from 'vitest';
import { activityEventSchema, agentDisplayName, displayNameSchema, messageRefSchema } from '@smurg/protocol';
import { render, renderEnglish } from '@smurg/protocol/i18n';
import { RELAY_DISPLAY_NAME_MAX_CHARS } from '@smurg/protocol/relay';
import {
  HOOK_DENY_REASONS,
  INVALID_TARGET_REASON,
  LOCK_CAP_REASON,
  OUTSIDE_ROOT_REASON,
  agentHeldReason,
  daemonUnreachableReason,
  humanHeldReason,
  pathCheckFailedReason,
  pathDeniedReason,
} from '../../src/hooks/deny-text.ts';
import { PATH_DENIED_REASONS } from '../../src/core/errors.ts';
import {
  agentEditText,
  bashBurstText,
  externalBurstText,
  lockDeniedText,
  safeDisplayName,
  safeToolName,
  shownPath,
  summary,
  worktreeBurstText,
} from '../../src/locks/text.ts';

const CJK = /[\u3000-\u303f\u3400-\u9fff\uff00-\uffef]/u;

describe('locks texts', () => {
  it('`Claude (owner)` is a valid display name even for the longest owner name', () => {
    expect(agentDisplayName('Ian')).toBe('Claude (Ian)');
    const longest = '名'.repeat(RELAY_DISPLAY_NAME_MAX_CHARS);
    const name = agentDisplayName(longest);
    expect(name.length).toBe(RELAY_DISPLAY_NAME_MAX_CHARS);
    expect(displayNameSchema.safeParse(name).success).toBe(true);
    expect(name.startsWith('Claude (')).toBe(true);
    expect(name.endsWith('…)')).toBe(true);
    // An owner name that just fits is not clipped; a surrogate pair is never cut in half.
    const fits = 'x'.repeat(RELAY_DISPLAY_NAME_MAX_CHARS - 'Claude ()'.length);
    expect(agentDisplayName(fits)).toBe(`Claude (${fits})`);
    const emoji = agentDisplayName('\u{1f600}'.repeat(RELAY_DISPLAY_NAME_MAX_CHARS));
    expect(displayNameSchema.safeParse(emoji).success).toBe(true);
    expect(/[\ud800-\udbff](?![\udc00-\udfff])/.test(emoji)).toBe(false);
    expect(safeDisplayName('Amy‮', 'fallback')).toBe('Amy');
  });

  it('deny reasons are English, name the holders and read well after Claude Code’s "PreToolUse:Edit hook error: " prefix', () => {
    expect(humanHeldReason(['Amy'])).toBe('This file is being edited by Amy. Work on other files first, or try again later.');
    expect(humanHeldReason(['A', 'B', 'C', 'D', 'E', 'F', 'G'])).toBe('This file is being edited by A, B, C, D, E and 2 more. Work on other files first, or try again later.');
    expect(agentHeldReason('Claude (Ian)')).toBe('Claude (Ian) is changing this file. Work on other files first, or try again later.');
    expect(daemonUnreachableReason('connect: ENOENT\u0007\n')).toBe(
      'smurg is not reachable on the host (connect: ENOENT  ). Nothing can run until it is back.',
    );
    const all = [
      ...Object.values(HOOK_DENY_REASONS),
      OUTSIDE_ROOT_REASON,
      INVALID_TARGET_REASON,
      LOCK_CAP_REASON,
      humanHeldReason(['Amy', 'Bob']),
      agentHeldReason('Claude (Ian)'),
      pathCheckFailedReason('internal'),
      pathDeniedReason('something-new'),
      ...PATH_DENIED_REASONS.map(pathDeniedReason),
    ];
    for (const text of all) {
      expect(text, text).not.toMatch(CJK);
      expect(text, text).toMatch(/^[A-Za-z].*\.$/);
      expect(text, text).not.toMatch(/undefined|\[object/);
    }
    // Every PathGuard reason has its own wording (no shared fallback).
    expect(new Set(PATH_DENIED_REASONS.map(pathDeniedReason)).size).toBe(PATH_DENIED_REASONS.length);
    expect(pathDeniedReason('host-only')).toBe('Only the host may change this path. The edit was blocked.');
  });

  it('activity sentences are references whose parameters are clipped: valid for the wire and at most 500 characters', () => {
    const longPath = `${'very-long-directory/'.repeat(200)}file.ts`;
    const refs = [
      lockDeniedText('Claude (Ian)', longPath, ['Amy'], false),
      lockDeniedText('Claude (Ian)', null, null, false),
      lockDeniedText('Claude (Ian)', longPath, Array.from({ length: 30 }, (_, i) => `member-${i}`), true),
      agentEditText('Claude (Ian)', longPath, 'Edit'),
      agentEditText('Claude (Ian)', longPath, null),
      bashBurstText('Claude (Ian)', 25, Array.from({ length: 25 }, (_, i) => `${longPath}${i}`)),
      worktreeBurstText('Amy', 40, [longPath, longPath, longPath, longPath]),
      externalBurstText(12, []),
    ];
    for (const ref of refs) {
      expect(messageRefSchema.safeParse(ref).success, JSON.stringify(ref).slice(0, 120)).toBe(true);
      const english = summary(renderEnglish(ref));
      expect(english.length).toBeLessThanOrEqual(500);
      expect(render('zh-TW', ref)).toMatch(CJK);
      const event = { id: 'act_1', at: 1, actor: { kind: 'system' }, kind: 'external.change', text: ref, summary: english };
      expect(activityEventSchema.safeParse(event).success).toBe(true);
    }
    expect(shownPath(longPath).length).toBe(200);
    expect(shownPath('')).toBe('/');
    expect(lockDeniedText('Claude (Ian)', 'a.ts', Array.from({ length: 30 }, (_, i) => `m${i}`), false)).toEqual({
      id: 'activity.lockDeniedHeld',
      params: { agent: 'Claude (Ian)', path: 'a.ts', holders: ['m0', 'm1', 'm2', 'm3', 'm4'], holderCount: 30, holderIsAgent: false },
    });
    expect(bashBurstText('Claude (Ian)', 25, ['a', 'b', 'c', 'd']).params).toEqual({ agent: 'Claude (Ian)', count: 25, sample: ['a', 'b', 'c'] });
    const event = { id: 'act_1', at: 1, actor: { kind: 'system' }, kind: 'external.change', text: externalBurstText(1, []), summary: summary(`a\nb\u0000c${'x'.repeat(600)}`) };
    expect(activityEventSchema.safeParse(event).success).toBe(true);
    expect(safeToolName('Edit')).toBe('Edit');
    expect(safeToolName('Edit; rm -rf /')).toBeNull();
  });
});
