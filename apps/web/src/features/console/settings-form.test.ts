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
      expect(parsed.errors.sharedDirs, bad).toContain(`「${bad}」不是有效的資料夾路徑`);
      expect(parsed.patch.sharedDirs).toBeUndefined();
    }
    expect(parseSettingsDraft(draft({ sharedDirs: 'data\ndata/' }), SETTINGS).errors.sharedDirs).toBe('「data/」重複了。');
    expect(parseSettingsDraft(draft({ sharedDirs: Array.from({ length: 65 }, (_, i) => `d${i}`).join('\n') }), SETTINGS).errors.sharedDirs).toBe('最多 64 個。');
  });

  it('has no setting of a guest sandbox (protocol v2: there is none)', () => {
    expect(Object.keys(draftFromSettings(SETTINGS)).sort()).toEqual(['agentLockTimeoutSec', 'diskReserveGb', 'diskReservePercent', 'humanLockIdleSec', 'sharedDirs']);
  });

  it('checks the ranges of the lock timings and the disk reserve', () => {
    const errors = parseSettingsDraft(
      draft({ humanLockIdleSec: '0.5', agentLockTimeoutSec: '601', diskReserveGb: '-1', diskReservePercent: '101' }),
      SETTINGS,
    ).errors;
    expect(errors).toEqual({
      humanLockIdleSec: '請輸入 1 到 3600 之間的數字。',
      agentLockTimeoutSec: '請輸入 1 到 600 之間的數字。',
      // 「-1」 is a number: the message says what is accepted (WEB-13).
      diskReserveGb: '請輸入 0 以上的數字。',
      diskReservePercent: '請輸入 0 到 100 之間的數字。',
    });
    const parsed = parseSettingsDraft(draft({ humanLockIdleSec: '', agentLockTimeoutSec: '1e3' }), SETTINGS);
    expect(parsed.errors.humanLockIdleSec).toBe('請輸入數值。');
    expect(parsed.errors.agentLockTimeoutSec).toBe('請輸入數字。');
    expect(errorCount(parsed)).toBe(2);
  });

  it('accepts zero reserve and fractional values', () => {
    const parsed = parseSettingsDraft(draft({ diskReserveGb: '0', diskReservePercent: '2.5', agentLockTimeoutSec: '1.5' }), SETTINGS);
    expect(parsed.errors).toEqual({});
    expect(parsed.patch).toEqual({ diskReserveBytes: 0, diskReservePercent: 2.5, agentLockTimeoutMs: 1_500 });
  });
});
