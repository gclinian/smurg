import { describe, expect, it } from 'vitest';
import { MemoryStorage } from '../testing/services.tsx';
import { createRecentWorkspaces, createThemeController } from './preferences.ts';
import { cssString, presenceCss, safeColor } from './presence-css.ts';
import { formatBytes, formatRelativeTime } from './format.ts';
import { describeDevice } from './connection/browser-deps.ts';
import { describeError } from './errors.ts';
import { ClientRequestError, RelayApiError } from '@smurg/protocol/client';
import { SmurgError } from '@smurg/protocol';

const WS = 'ws_misc_test_workspace_1';

describe('preferences', () => {
  it('remembers recent workspaces newest first, capped, and survives corrupt storage', () => {
    const storage = new MemoryStorage();
    const recent = createRecentWorkspaces(storage);
    recent.remember({ id: WS, name: 'proj', hostName: 'Ian' }, 1);
    recent.remember({ id: 'ws_second_workspace_01' }, 2);
    recent.remember({ id: WS }, 3);
    expect(recent.getState().map((r) => [r.id, r.name])).toEqual([
      [WS, 'proj'],
      ['ws_second_workspace_01', null],
    ]);
    for (let i = 0; i < 20; i++) recent.remember({ id: `ws_cap_test_workspace_${String(i).padStart(2, '0')}` }, 10 + i);
    expect(recent.getState()).toHaveLength(10);
    recent.forget(recent.getState()[0]!.id);
    expect(recent.getState()).toHaveLength(9);
    expect(createRecentWorkspaces(storage).getState()).toHaveLength(9);
    storage.setItem('smurg.recentWorkspaces', '{not json');
    expect(createRecentWorkspaces(storage).getState()).toEqual([]);
    storage.setItem('smurg.recentWorkspaces', JSON.stringify([{ id: 'bad id', lastOpenedAt: 1 }, { id: WS, lastOpenedAt: 'x' }]));
    expect(createRecentWorkspaces(storage).getState()).toEqual([]);
  });

  it('theme: dark by default, follows the OS in "system", explicit choices set data-theme', () => {
    const root = document.createElement('html');
    const theme = createThemeController({ storage: new MemoryStorage(), root, media: null });
    expect(theme.getState()).toEqual({ preference: 'system', resolved: 'dark' });
    expect(root.dataset['theme']).toBeUndefined();
    theme.setPreference('light');
    expect(root.dataset['theme']).toBe('light');
    expect(theme.getState().resolved).toBe('light');
    theme.setPreference('system');
    expect(root.dataset['theme']).toBeUndefined();
  });
});

describe('presence CSS for y-monaco cursors', () => {
  it('escapes names so they cannot break out of the CSS string', () => {
    expect(cssString('Amy')).toBe('"Amy"');
    expect(cssString('a"b\\c')).toBe('"a\\"b\\\\c"');
    expect(cssString('x</style><script>')).not.toContain('<');
    expect(cssString('a\nb')).toBe('"ab"');
    expect(safeColor('red')).toBe('#888888');
    expect(safeColor('#12abEF')).toBe('#12abEF');
  });

  it('renders one rule set per remote client, skipping itself', () => {
    const css = presenceCss(
      new Map([
        [1, { user: { name: 'Claude（Ian）', color: '#22c55e' } }],
        [2, { user: { name: 'Me', color: '#000000' } }],
        [3, null],
      ]),
      2,
    );
    expect(css).toContain('.yRemoteSelectionHead-1::after{content:"Claude（Ian）"');
    expect(css).not.toContain('Selection-2');
    expect(css).not.toContain('Selection-3');
  });
});

describe('formatting and errors', () => {
  it('formats sizes and relative times in zh-TW', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(5 * 1024 ** 3)).toBe('5 GB');
    expect(formatRelativeTime(1_000, 1_000)).toBe('剛剛');
    expect(formatRelativeTime(0, 3 * 60_000)).toBe('3 分鐘前');
  });

  it('names the device for the host list', () => {
    expect(describeDevice('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0 Safari/537.36')).toBe('Chrome（macOS）');
    expect(describeDevice('Mozilla/5.0 (X11; Linux x86_64; rv:155.0) Gecko/20100101 Firefox/155.0')).toBe('Firefox（Linux）');
    expect(describeDevice('')).toBe('瀏覽器');
  });

  it('describes errors in zh-TW and never shows non-zh daemon internals', () => {
    expect(describeError(new SmurgError('locked', '這個檔案目前被鎖定'))).toBe('這個檔案目前被鎖定');
    expect(describeError(new SmurgError('internal', 'not implemented: files'))).toBe('主人端發生內部錯誤');
    expect(describeError(new ClientRequestError('timeout'))).toContain('逾時');
    expect(describeError(new RelayApiError(401, 'unauthorized', 'x'))).toContain('重新登入');
    expect(describeError(new RelayApiError(0, 'network', 'x'))).toContain('無法連上');
    expect(describeError(new Error('secret /Users/host/path'))).not.toContain('/Users');
  });
});
