// @vitest-environment node
// One naming and one picture for what a session, a work item, a topic and an inbox item are.
import { AGENT_STATUSES, INBOX_KINDS, TOPIC_PHASES } from '@smurg/protocol';
import { buildAgentSession, buildTerminalSession, buildWorkItem } from '@smurg/protocol/testing';
import { describe, expect, it } from 'vitest';
import { applyLocale } from './locale.ts';
import { itemGlyph, kindLabel, mostUrgent, phaseLabel, phaseTone, sessionGlyph, statusLabel, waitsForPerson } from './session-status.ts';
import { GLYPH_STATUSES } from '../ui/StatusGlyph.tsx';
import { ITEM_KINDS } from '../ui/KindIcon.tsx';

describe('session status', () => {
  it('every agent status has a glyph; a terminal has none', () => {
    const glyphs = Object.fromEntries(AGENT_STATUSES.map((status) => [status, sessionGlyph(buildAgentSession({ status }))]));
    expect(glyphs).toEqual({
      starting: 'running',
      running: 'running',
      'waiting-answer': 'question',
      'waiting-permission': 'permission',
      idle: 'idle',
      stalled: 'stalled',
      done: 'done',
      failed: 'failed',
      ended: 'ended',
    });
    expect(sessionGlyph(buildTerminalSession())).toBeNull();
  });

  it('a work item without a session shows its own state', () => {
    expect(itemGlyph(buildWorkItem())).toBe('todo');
    expect(itemGlyph(buildWorkItem({ state: 'waiting' }))).toBe('blocked');
    expect(itemGlyph(buildWorkItem({ state: 'queued' }))).toBe('blocked');
    expect(itemGlyph(buildWorkItem({ state: 'reviewed' }))).toBe('done');
    expect(itemGlyph(buildWorkItem({ state: 'stopped' }))).toBe('ended');
  });

  it('every glyph, phase and kind has a name in both languages', () => {
    for (const locale of ['en', 'zh-TW'] as const) {
      applyLocale(locale);
      for (const status of GLYPH_STATUSES) expect(statusLabel(status), status).not.toContain('status.');
      for (const phase of TOPIC_PHASES) expect(phaseLabel(phase), phase).not.toContain('phase.');
      for (const kind of INBOX_KINDS) expect(kindLabel(kind), kind).not.toContain('kind.');
    }
    applyLocale('en');
    expect(statusLabel('stalled')).toBe('Stopped without a report');
    expect(statusLabel('question')).toBe('Waiting for an answer');
    expect(phaseLabel('executing')).toBe('Executing');
    expect(kindLabel('vote')).toBe('Open vote');
    // The inbox kinds are the kinds ui/KindIcon draws.
    expect([...ITEM_KINDS].sort()).toEqual([...INBOX_KINDS].sort());
  });

  it('the most urgent status leads a collapsed topic: failed, permission, answer, stalled, running, idle', () => {
    expect(mostUrgent(['idle', 'running', 'question', 'permission'])).toBe('permission');
    expect(mostUrgent(['done', 'failed', 'permission'])).toBe('failed');
    expect(mostUrgent(['idle', 'stalled', 'running'])).toBe('stalled');
    expect(mostUrgent(['ended', 'idle'])).toBe('idle');
    expect(mostUrgent([])).toBeNull();
  });

  it('amber and red mean a person must act', () => {
    expect(GLYPH_STATUSES.filter(waitsForPerson)).toEqual(['question', 'permission', 'stalled', 'failed']);
    expect(waitsForPerson(null)).toBe(false);
  });

  it('a complete topic is green; a topic being worked on is not', () => {
    expect(phaseTone('complete')).toBe('success');
    expect(phaseTone('discussing')).toBe('neutral');
    expect(phaseTone('executing')).toBe('info');
  });
});
