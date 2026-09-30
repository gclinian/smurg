// How an ended session is described (review WEB-12): a session the host terminated must not read like a normal exit.
import { describe, expect, it } from 'vitest';
import { statusLabel } from './session-info.ts';

describe('statusLabel of an ended session (review WEB-12)', () => {
  it('names the host who terminated it, and the other reasons a session ends without its owner', () => {
    expect(statusLabel({ status: 'exited', exitCode: 0, endReason: 'terminated', endedBy: { userId: 'github:1', displayName: 'Ian 老師' } })).toBe('已被主人（Ian 老師）終止');
    expect(statusLabel({ status: 'exited', exitCode: 0, endReason: 'terminated' })).toBe('已被主人終止');
    expect(statusLabel({ status: 'exited', endReason: 'kicked' })).toBe('已結束（擁有者已被移出工作區）');
    expect(statusLabel({ status: 'exited', endReason: 'left' })).toBe('已結束（擁有者已離開工作區）');
    expect(statusLabel({ status: 'exited', endReason: 'role-changed' })).toBe('已結束（擁有者的角色已變更）');
    expect(statusLabel({ status: 'exited', endReason: 'stopped' })).toBe('已結束（主人已停止分享）');
  });

  it('a normal exit (or an older daemon that sends no reason) keeps the exit code', () => {
    expect(statusLabel({ status: 'exited', exitCode: 3, endReason: 'exit' })).toBe('已結束（結束代碼 3）');
    expect(statusLabel({ status: 'exited', exitCode: 0, endReason: 'ended', endedBy: { userId: 'dev:amy', displayName: 'Amy' } })).toBe('已結束（結束代碼 0）');
    expect(statusLabel({ status: 'exited', exitCode: 3 })).toBe('已結束（結束代碼 3）');
    expect(statusLabel({ status: 'running' })).toBe('執行中');
  });
});
