// What the model and permission mode pickers offer and say (DESIGN 0.6.0 D18), as pure functions: the list of the
// host's Claude Code, the host's default by its resolved id, a chosen model the list no longer holds, the notes while
// the list is not known, and the three mode choices after "follow" (never "Asks for nothing").
import { describe, expect, it } from 'vitest';
import type { AgentHostState } from '@smurg/protocol';
import { HOST_MODELS } from '../../testing/fixtures.ts';
import {
  AGENT_WORDS_CLASS,
  FOLLOW_VALUE,
  HOST_DEFAULT_VALUE,
  baseModelId,
  billsUsageCredits,
  entryOfRunning,
  followedMode,
  hostDefaultLabel,
  modeOptions,
  modelEntry,
  modelName,
  modelOptions,
  modelsNote,
  resultingMode,
} from './agent-choice.ts';

const KNOWN: AgentHostState = { models: HOST_MODELS, modelsKnown: true, hostDefault: 'claude-opus-5-5[1m]', autoMode: 'ok', asksNothing: 'ok' };
const UNKNOWN: AgentHostState = { models: [], modelsKnown: false, hostDefault: null, autoMode: 'ok', asksNothing: 'ok' };

describe('the model picker', () => {
  it("names the host's default by the entry it runs as (with or without [1m]); without one, plainly", () => {
    expect(baseModelId('claude-opus-5-5[1m]')).toBe('claude-opus-5-5');
    expect(modelEntry(KNOWN, null)?.value).toBe('opus');
    expect(hostDefaultLabel(KNOWN)).toBe("The host's default (Opus)");
    expect(hostDefaultLabel(UNKNOWN)).toBe("The host's default");
    expect(hostDefaultLabel(null)).toBe("The host's default");
    expect(hostDefaultLabel({ ...KNOWN, hostDefault: 'claude-something-else' })).toBe("The host's default");
  });

  it('offers the default first, then the list while it is known; a chosen model the list no longer holds stays itself', () => {
    expect(modelOptions(KNOWN, null).map((option) => option.value)).toEqual([HOST_DEFAULT_VALUE, 'opus', 'fable', 'sonnet', 'haiku']);
    expect(modelOptions(KNOWN, null)[2]?.label).toBe('Fable · Fable 5.1 · Billed to usage credits on some plans');
    expect(modelOptions({ ...KNOWN, models: [{ value: 'x', name: 'X', description: '  ', auto: true }] }, null)[1]?.label).toBe('X');
    expect(modelOptions(UNKNOWN, null)).toEqual([{ value: HOST_DEFAULT_VALUE, label: "The host's default" }]);
    expect(modelOptions(KNOWN, 'claude-gone-1')).toContainEqual({ value: 'claude-gone-1', label: 'claude-gone-1', className: AGENT_WORDS_CLASS });
    // The agent's own words (names and lines of its list) are marked: they are not the interface's, in any language.
    expect(modelOptions(KNOWN, null).map((option) => option.className)).toEqual([undefined, AGENT_WORDS_CLASS, AGENT_WORDS_CLASS, AGENT_WORDS_CLASS, AGENT_WORDS_CLASS]);
    expect(modelName(KNOWN, 'sonnet')).toBe('Sonnet');
    expect(modelName(KNOWN, 'claude-gone-1')).toBe('claude-gone-1');
  });

  it('a model whose entry may bill usage credits says so (by the list, never by a guess)', () => {
    expect(billsUsageCredits(KNOWN, 'fable')).toBe(true);
    expect(billsUsageCredits(KNOWN, 'sonnet')).toBe(false);
    expect(billsUsageCredits(KNOWN, null)).toBe(false);
    expect(billsUsageCredits(UNKNOWN, 'fable')).toBe(false);
  });

  it('finds the entry a running model is reported as', () => {
    expect(entryOfRunning(KNOWN, 'claude-sonnet-5-5')?.name).toBe('Sonnet');
    expect(entryOfRunning(KNOWN, 'claude-sonnet-5-5[1m]')?.name).toBe('Sonnet');
    expect(entryOfRunning(KNOWN, 'haiku')?.name).toBe('Haiku');
    expect(entryOfRunning(KNOWN, 'claude-fake')).toBeUndefined();
  });

  it("says that the host's agent is being asked, and after a while that it could not be", () => {
    expect(modelsNote(KNOWN, false)).toBeNull();
    expect(modelsNote(UNKNOWN, false)).toBe("Asking the host's Claude Code which models it offers…");
    expect(modelsNote(null, false)).toBe("Asking the host's Claude Code which models it offers…");
    expect(modelsNote(UNKNOWN, true)).toBe("The host's Claude Code could not be asked which models it offers. Sessions use the host's default.");
  });
});

describe('the permission mode picker', () => {
  it('"follow" first, naming what it follows, then the three choices: never "Asks for nothing"', () => {
    expect(modeOptions('workspace', 'auto').map((option) => option.label)).toEqual([
      'Workspace default (Auto: runs what a check allows)',
      'Auto: runs what a check allows',
      'Asks before commands',
      'Asks before edits and commands',
    ]);
    expect(modeOptions('topic', 'ask-commands')[0]).toEqual({ value: FOLLOW_VALUE, label: "This topic's setting (Asks before commands)" });
    expect(modeOptions('workspace', 'ask-nothing')[0]?.label).toBe('Workspace default (Asks for nothing)');
    expect(modeOptions('workspace', 'ask-nothing').map((option) => option.value)).not.toContain('ask-nothing');
  });

  it('what a choice results in, and what a work item follows', () => {
    expect(resultingMode(null, 'auto')).toBe('auto');
    expect(resultingMode('ask-all', 'auto')).toBe('ask-all');
    expect(followedMode({ purpose: 'item', topic: 'ask-commands', workspace: 'auto' })).toBe('ask-commands');
    expect(followedMode({ purpose: 'item', topic: null, workspace: 'ask-nothing' })).toBe('ask-nothing');
    expect(followedMode({ purpose: 'free', topic: 'ask-commands', workspace: 'auto' })).toBe('auto');
  });
});
