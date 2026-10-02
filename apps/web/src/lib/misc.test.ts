import { describe, expect, it } from 'vitest';
import { MemoryStorage } from '../testing/services.tsx';
import { createRecentWorkspaces, createThemeController } from './preferences.ts';
import { cssString, presenceCss, safeColor } from './presence-css.ts';
import { compareText, formatBytes, formatDateTime, formatDuration, formatExactTime, formatList, formatNumber, formatRelativeTime, formatRole, formatTime } from './format.ts';
import { describeDevice } from './connection/browser-deps.ts';
import { describeError, renderWireText } from './errors.ts';
import { ClientRequestError, RelayApiError } from '@smurg/protocol/client';
import { SmurgError } from '@smurg/protocol';
import { msg } from '@smurg/protocol/i18n';
import { applyLocale } from './locale.ts';

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
        [1, { user: { name: 'Claude (Ian)', color: '#22c55e' } }],
        [2, { user: { name: 'Me', color: '#000000' } }],
        [3, null],
      ]),
      2,
    );
    expect(css).toContain('.yRemoteSelectionHead-1::after{content:"Claude (Ian)"');
    expect(css).not.toContain('Selection-2');
    expect(css).not.toContain('Selection-3');
  });
});

describe('formatting and errors', () => {
  it('formats sizes, numbers, times, durations and lists in English', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(5 * 1024 ** 3)).toBe('5 GB');
    expect(formatBytes(1536)).toBe('1.5 KB');
    expect(formatBytes(Number.NaN)).toBe('Unknown');
    expect(formatNumber(1234567)).toBe('1,234,567');
    expect(formatRelativeTime(1_000, 1_000)).toBe('just now');
    expect(formatRelativeTime(0, 45_000)).toBe('45 seconds ago');
    expect(formatRelativeTime(0, 60_000)).toBe('1 minute ago');
    expect(formatRelativeTime(0, 3 * 60_000)).toBe('3 minutes ago');
    expect(formatRelativeTime(0, 5 * 3_600_000)).toBe('5 hours ago');
    expect(formatRelativeTime(0, 86_400_000)).toBe('1 day ago');
    expect(formatRelativeTime(0, 30 * 86_400_000)).toBe(formatDateTime(0));
    expect([formatDuration(1), formatDuration(45), formatDuration(60), formatDuration(61), formatDuration(7200), formatDuration(-3)]).toEqual([
      '1 second',
      '45 seconds',
      '1 minute',
      '2 minutes',
      '2 hours',
      '0 seconds',
    ]);
    expect(formatList(['a.ts', 'b.ts', 'c.ts'])).toBe('a.ts, b.ts, c.ts');
    expect(['file10', 'File2', 'file1'].sort(compareText)).toEqual(['file1', 'File2', 'file10']);
    expect(['host', 'agent', 'editor', 'viewer'].map((role) => formatRole(role as 'host'))).toEqual(['Host', 'Agent access', 'Editor', 'Viewer']);
  });

  it('formats dates with the month spelled out in English, and to the second for logs', () => {
    const at = new Date(2026, 4, 29, 4, 26, 40).getTime();
    expect(formatDateTime(at)).toBe('May 29, 2026, 04:26');
    expect(formatTime(at)).toBe('04:26:40');
    expect(formatExactTime(at)).toBe('05/29/2026, 04:26:40');
  });

  it('follows the language without a reload: the same calls in zh-TW', () => {
    applyLocale('zh-TW');
    const at = new Date(2026, 4, 29, 4, 26, 40).getTime();
    expect(formatRelativeTime(1_000, 1_000)).toBe('剛剛');
    expect(formatRelativeTime(0, 3 * 60_000)).toBe('3 分鐘前');
    expect(formatRelativeTime(0, 5 * 3_600_000)).toBe('5 小時前');
    expect(formatDateTime(at)).toMatch(/^2026\/5\/29\s04:26$/);
    expect(formatExactTime(at)).toMatch(/^2026\/05\/29\s04:26:40$/);
    expect([formatDuration(45), formatDuration(180)]).toEqual(['45 秒', '3 分鐘']);
    expect(formatList(['a.ts', 'b.ts'])).toBe('a.ts、b.ts');
    expect(formatRole('agent')).toBe('可使用 agent');
    expect(formatBytes(Number.NaN)).toBe('未知');
    applyLocale('en');
    expect(formatRelativeTime(0, 3 * 60_000)).toBe('3 minutes ago');
  });

  it('names the device for the host list: one language-neutral spelling', () => {
    expect(describeDevice('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0 Safari/537.36')).toBe('Chrome (macOS)');
    expect(describeDevice('Mozilla/5.0 (X11; Linux x86_64; rv:155.0) Gecko/20100101 Firefox/155.0')).toBe('Firefox (Linux)');
    expect(describeDevice('')).toBe('Browser');
    applyLocale('zh-TW');
    expect(describeDevice('')).toBe('Browser');
  });

  it('describes an error from its message reference in the viewer\'s language', () => {
    const locked = new SmurgError('locked');
    const specific = new SmurgError('forbidden', msg('error.default.hostOnly'), { reason: 'host-only' });
    const timeout = new ClientRequestError('timeout');
    // An id this build does not know (a newer host): the English sentence it came with.
    const newer = SmurgError.fromPayload({ code: 'conflict', message: 'The branch moved on.', text: { id: 'worktree.someLaterSentence', params: { n: 1 } } });
    // No reference at all (a plain string, not written for people): the default sentence of the code.
    const bare = new SmurgError('internal', 'not implemented: files');

    expect(describeError(locked)).toBe('This file is locked right now.');
    expect(describeError(specific)).toBe('Only the host can do this.');
    expect(describeError(timeout)).toBe('The request timed out. The host may be offline.');
    expect(describeError(newer)).toBe('The branch moved on.');
    expect(describeError(bare)).toBe('Something went wrong on the host.');
    expect(describeError(new SmurgError('internal', 'x', { reason: 'not-implemented' }))).toBe("smurg on the host's computer does not support this yet.");
    expect(describeError(new RelayApiError(401, 'unauthorized', 'x'))).toBe('Your login has expired. Log in again.');
    expect(describeError(new RelayApiError(0, 'network', 'x'))).toBe('Cannot reach the smurg server. Try again later.');
    expect(describeError(new RelayApiError(503, 'unavailable', 'x'))).toBe('The smurg server answered with an error (503).');
    expect(describeError(new Error('secret /Users/host/path'))).toBe('Something unexpected went wrong. Try again later.');

    applyLocale('zh-TW');
    expect(describeError(locked)).toBe('這個檔案目前被鎖定');
    expect(describeError(specific)).toBe('只有主人可以執行這個動作');
    expect(describeError(timeout)).toBe('請求逾時，主人可能已離線');
    expect(describeError(newer)).toBe('The branch moved on.');
    expect(describeError(bare)).toBe('主人端發生內部錯誤');
    expect(describeError(new RelayApiError(401, 'unauthorized', 'x'))).toBe('你的登入已過期，請重新登入。');
  });

  it('renderWireText: a reference with wrong parameters falls back, never throws and never prints "undefined"', () => {
    expect(renderWireText(msg('role.agent'), 'x')).toBe('Agent access');
    expect(renderWireText({ id: 'role.nobody' }, 'fallback')).toBe('fallback');
    expect(renderWireText(undefined, 'fallback')).toBe('fallback');
    expect(renderWireText({ id: 'error.default.locked', params: { extra: ['a'] } }, 'fallback')).toBe('This file is locked right now.');
  });
});
