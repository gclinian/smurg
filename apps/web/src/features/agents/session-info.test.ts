// How a session is described: an ended one (review WEB-12: a session the host terminated must not read like a normal
// exit), who opened it (every session runs as the host, protocol v2), and a refused request.
import { describe, expect, it } from 'vitest';
import { SmurgError } from '@smurg/protocol';
import { describeSessionError, effectiveLogin, kindLabel, openedByLabel, statusLabel, tabLabel } from './session-info.ts';

describe('statusLabel of an ended session (review WEB-12)', () => {
  it('names the host who terminated it, and the other reasons a session ends without the person who opened it', () => {
    expect(statusLabel({ status: 'exited', exitCode: 0, endReason: 'terminated', endedBy: { userId: 'github:1', displayName: 'Ian 老師' } })).toBe('已被主人（Ian 老師）終止');
    expect(statusLabel({ status: 'exited', exitCode: 0, endReason: 'terminated' })).toBe('已被主人終止');
    expect(statusLabel({ status: 'exited', endReason: 'kicked' })).toBe('已結束（開啟它的人已被移出工作區）');
    expect(statusLabel({ status: 'exited', endReason: 'left' })).toBe('已結束（開啟它的人已離開工作區）');
    expect(statusLabel({ status: 'exited', endReason: 'role-changed' })).toBe('已結束（開啟它的人已不能使用 agent）');
    expect(statusLabel({ status: 'exited', endReason: 'stopped' })).toBe('已結束（主人已停止分享）');
  });

  it('a normal exit (or an older daemon that sends no reason) keeps the exit code', () => {
    expect(statusLabel({ status: 'exited', exitCode: 3, endReason: 'exit' })).toBe('已結束（結束代碼 3）');
    expect(statusLabel({ status: 'exited', exitCode: 0, endReason: 'ended', endedBy: { userId: 'dev:amy', displayName: 'Amy' } })).toBe('已結束（結束代碼 0）');
    expect(statusLabel({ status: 'exited', exitCode: 3 })).toBe('已結束（結束代碼 3）');
    expect(statusLabel({ status: 'running' })).toBe('執行中');
  });
});

describe('who opened a session', () => {
  it('the tab reads 「Claude（Amy 開的）」, whether the daemon titled it 「Claude」, 「Claude（Amy）」 or 「Claude（Amy 開的）」', () => {
    for (const title of ['Claude', 'Claude（Amy）', 'Claude（Amy 開的）']) expect(tabLabel({ title, ownerName: 'Amy' }), title).toBe('Claude（Amy 開的）');
    expect(tabLabel({ title: '修登入頁', ownerName: 'Ian' })).toBe('修登入頁（Ian 開的）');
  });

  it('the summary says 「Amy 開的」, or 「你開的」 for one\'s own', () => {
    expect(openedByLabel({ ownerName: 'Amy', ownerUserId: 'dev:amy' }, 'dev:ian')).toBe('Amy 開的');
    expect(openedByLabel({ ownerName: 'Amy', ownerUserId: 'dev:amy' }, 'dev:amy')).toBe('你開的');
  });

  it('there are two kinds: an agent and a terminal (no login process)', () => {
    expect(kindLabel({ kind: 'agent' })).toBe('agent（Claude Code）');
    expect(kindLabel({ kind: 'terminal' })).toBe('終端機');
  });

  it('a re-check of the login counts only until the daemon reports something newer', () => {
    expect(effectiveLogin({ login: 'unknown' }, { login: 'logged-in', against: 'unknown' })).toBe('logged-in');
    expect(effectiveLogin({ login: 'logged-out' }, { login: 'logged-in', against: 'unknown' })).toBe('logged-out');
    expect(effectiveLogin({ login: 'logged-out' }, null)).toBe('logged-out');
  });
});

describe('a refused session request in zh-TW', () => {
  it('a refusal by role says so; a known reason gets a hint; anything else keeps the daemon\'s message', () => {
    expect(describeSessionError(new SmurgError('forbidden', 'no'))).toMatchObject({ title: '無法開啟 session', message: '你的角色不能執行這個動作。' });
    expect(describeSessionError(new SmurgError('conflict', '太多 session 了', { reason: 'session-limit' })).hint).toBe('請先結束不再使用的 session，再試一次。');
    expect(describeSessionError(new SmurgError('internal', '出錯了')).hint).toBeUndefined();
  });
});
