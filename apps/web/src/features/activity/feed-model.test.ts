// The activity feed's labels as pure data.
import { describe, expect, it } from 'vitest';
import { actorLabel, kindLabel, kindTone, matchesFilter, viaShellCommand } from './feed-model.ts';

describe('merge entries in the activity feed (review WEB-11)', () => {
  it('have a label, a neutral tone, and show under 「全部」 and the people filter', () => {
    expect(kindLabel('merge')).toBe('合併');
    expect(kindTone('merge')).toBe('neutral');
    const event = { id: 'ac_1', at: 1, kind: 'merge' as const, actor: { kind: 'user' as const, userId: 'dev:amy', displayName: 'Amy' }, summary: '請求把自己的 worktree 合併到主工作區' };
    expect(matchesFilter(event, 'all')).toBe(true);
    expect(matchesFilter(event, 'people')).toBe(true);
    expect(matchesFilter(event, 'problems')).toBe(false);
  });
});

describe("an agent's change by a shell command (ARCHITECTURE §11 D-13)", () => {
  const agent = { kind: 'agent' as const, sessionId: 'sess_1', ownerUserId: 'dev:ian', displayName: 'Claude（Ian）' };
  it("is the agent's, marked 「透過指令」 only when the daemon attributed it to the agent (agent.edit, agent actor, via 'bash')", () => {
    const bash = { id: 'ac_b', at: 1, kind: 'agent.edit' as const, actor: agent, summary: 'Claude（Ian）透過 shell 指令修改了 src/app.ts', via: 'bash' as const };
    expect(viaShellCommand(bash)).toBe(true);
    expect(actorLabel(bash.actor)).toBe('Claude（Ian）');
    expect(matchesFilter(bash, 'agents')).toBe(true);
    expect(viaShellCommand({ ...bash, summary: 'Claude（Ian）透過 shell 指令變更了 3 個檔案（例如 a.ts、b.ts）' })).toBe(true);
    // The field decides, not the wording: another wording keeps the marker, the wording without the field gets none.
    expect(viaShellCommand({ ...bash, summary: 'Claude（Ian）用 shell 改了 src/app.ts' })).toBe(true);
    const { via: _via, ...withoutVia } = bash;
    expect(viaShellCommand(withoutVia)).toBe(false);
    // An Edit tool change: the agent's, no marker.
    expect(viaShellCommand({ ...withoutVia, summary: 'Claude（Ian） 修改了 src/app.ts（Edit）' })).toBe(false);
    // Nobody claimed it: 「外部程式」, as the daemon says, never a marker (even if a summary looked alike).
    const external = { id: 'ac_x', at: 1, kind: 'external.change' as const, actor: { kind: 'system' as const }, summary: '外部程式修改了 src/app.ts' };
    expect(actorLabel(external.actor)).toBe('外部程式');
    expect(viaShellCommand(external)).toBe(false);
    expect(viaShellCommand({ ...external, summary: '外部程式透過 shell 指令修改了 x' })).toBe(false);
    expect(viaShellCommand({ ...bash, kind: 'human.edit', actor: { kind: 'user', userId: 'dev:bob', displayName: 'Bob' } })).toBe(false);
  });
});
