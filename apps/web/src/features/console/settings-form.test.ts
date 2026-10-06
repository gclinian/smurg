import type { HostSettings } from '@smurg/protocol';
import { describe, expect, it } from 'vitest';
import { GIB, draftFromSettings, errorCount, hasChanges, parseSettingsDraft, type SettingsDraft } from './settings-form.ts';


const SETTINGS: HostSettings = {
  humanLockIdleMs: 30_000,
  agentLockTimeoutMs: 60_000,
  uploadChunkSize: 4 * 1024 * 1024,
  sharedDirs: ['data'],
  diskReserveBytes: 5 * GIB,
  diskReservePercent: 5,
  maxLiveAgents: 8,
  escalateAfterMs: 600_000,
  agentMcp: false,
};

const draft = (overrides: Partial<SettingsDraft> = {}): SettingsDraft => ({ ...draftFromSettings(SETTINGS), ...overrides });

describe('settings validation', () => {
  it('shows the current settings in human units and sends nothing when nothing changed', () => {
    expect(draftFromSettings(SETTINGS)).toEqual({
      sharedDirs: 'data',
      humanLockIdleSec: '30',
      agentLockTimeoutSec: '60',
      diskReserveGb: '5',
      diskReservePercent: '5',
      maxLiveAgents: '8',
      escalateAfterMin: '10',
      agentMcp: false,
    });
    const parsed = parseSettingsDraft(draft(), SETTINGS);
    expect(parsed.errors).toEqual({});
    expect(hasChanges(parsed)).toBe(false);
  });

  it('sends only the changed fields, converted to the protocol units', () => {
    const parsed = parseSettingsDraft(
      draft({ sharedDirs: 'data\n  models/checkpoints/ \n\n', humanLockIdleSec: '45', diskReserveGb: '10.5' }),
      SETTINGS,
    );
    expect(parsed.errors).toEqual({});
    expect(parsed.patch).toEqual({
      sharedDirs: ['data', 'models/checkpoints'],
      humanLockIdleMs: 45_000,
      diskReserveBytes: Math.round(10.5 * GIB),
    });
  });

  it('refuses paths outside the share, dot segments and duplicates', () => {
    for (const bad of ['/etc', '../secret', 'a/../b', './data', 'a\\b']) {
      const parsed = parseSettingsDraft(draft({ sharedDirs: bad }), SETTINGS);
      expect(parsed.errors.sharedDirs, bad).toContain(`"${bad}" is not a valid folder path`);
      expect(parsed.patch.sharedDirs).toBeUndefined();
    }
    expect(parseSettingsDraft(draft({ sharedDirs: 'data\ndata/' }), SETTINGS).errors.sharedDirs).toBe('"data/" is listed twice.');
    expect(parseSettingsDraft(draft({ sharedDirs: Array.from({ length: 65 }, (_, i) => `d${i}`).join('\n') }), SETTINGS).errors.sharedDirs).toBe('At most 64.');
  });

  it('has no setting of a guest sandbox (protocol v2: there is none)', () => {
    expect(Object.keys(draftFromSettings(SETTINGS)).sort()).toEqual([
      'agentLockTimeoutSec',
      'agentMcp',
      'diskReserveGb',
      'diskReservePercent',
      'escalateAfterMin',
      'humanLockIdleSec',
      'maxLiveAgents',
      'sharedDirs',
    ]);
  });

  it('the three agent settings: a whole number of work items, the waiting time in minutes, and the MCP switch', () => {
    const parsed = parseSettingsDraft(draft({ maxLiveAgents: '12', escalateAfterMin: '2.5', agentMcp: true }), SETTINGS);
    expect(parsed.errors).toEqual({});
    expect(parsed.patch).toEqual({ maxLiveAgents: 12, escalateAfterMs: 150_000, agentMcp: true });
    // The bounds of the protocol: 2 to 32 work items, 1 to 60 minutes.
    for (const bad of ['1', '33', '2.5', 'many', '-4']) {
      expect(parseSettingsDraft(draft({ maxLiveAgents: bad }), SETTINGS).errors.maxLiveAgents, bad).toBe('Enter a whole number from 2 to 32.');
    }
    expect(parseSettingsDraft(draft({ maxLiveAgents: '' }), SETTINGS).errors.maxLiveAgents).toBe('Enter a value.');
    for (const ok of ['2', '32']) expect(parseSettingsDraft(draft({ maxLiveAgents: ok }), SETTINGS).patch).toEqual({ maxLiveAgents: Number(ok) });
    expect(parseSettingsDraft(draft({ escalateAfterMin: '0.5' }), SETTINGS).errors.escalateAfterMin).toBe('Enter a number from 1 to 60.');
    expect(parseSettingsDraft(draft({ escalateAfterMin: '61' }), SETTINGS).errors.escalateAfterMin).toBe('Enter a number from 1 to 60.');
    expect(parseSettingsDraft(draft({ escalateAfterMin: '1' }), SETTINGS).patch).toEqual({ escalateAfterMs: 60_000 });
    expect(parseSettingsDraft(draft({ escalateAfterMin: '60' }), SETTINGS).patch).toEqual({ escalateAfterMs: 3_600_000 });
    // Switching the MCP servers back off is a change too; leaving the switch alone is not.
    const on = { ...SETTINGS, agentMcp: true };
    expect(parseSettingsDraft({ ...draftFromSettings(on), agentMcp: false }, on).patch).toEqual({ agentMcp: false });
    expect(hasChanges(parseSettingsDraft(draftFromSettings(on), on))).toBe(false);
  });

  it('checks the ranges of the lock timings and the disk reserve', () => {
    const errors = parseSettingsDraft(
      draft({ humanLockIdleSec: '0.5', agentLockTimeoutSec: '601', diskReserveGb: '-1', diskReservePercent: '101' }),
      SETTINGS,
    ).errors;
    expect(errors).toEqual({
      humanLockIdleSec: 'Enter a number from 1 to 3600.',
      agentLockTimeoutSec: 'Enter a number from 1 to 600.',
      // "-1" is a number: the message says what is accepted.
      diskReserveGb: 'Enter a number of 0 or more.',
      diskReservePercent: 'Enter a number from 0 to 100.',
    });
    const parsed = parseSettingsDraft(draft({ humanLockIdleSec: '', agentLockTimeoutSec: '1e3' }), SETTINGS);
    expect(parsed.errors.humanLockIdleSec).toBe('Enter a value.');
    expect(parsed.errors.agentLockTimeoutSec).toBe('Enter a number.');
    expect(errorCount(parsed)).toBe(2);
  });

  it('accepts zero reserve and fractional values', () => {
    const parsed = parseSettingsDraft(draft({ diskReserveGb: '0', diskReservePercent: '2.5', agentLockTimeoutSec: '1.5' }), SETTINGS);
    expect(parsed.errors).toEqual({});
    expect(parsed.patch).toEqual({ diskReserveBytes: 0, diskReservePercent: 2.5, agentLockTimeoutMs: 1_500 });
  });
});
