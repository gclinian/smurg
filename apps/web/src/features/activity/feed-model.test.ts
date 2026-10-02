// The activity feed's labels as pure data.
import { describe, expect, it } from 'vitest';
import { actorLabel, kindLabel, kindTone, matchesFilter, viaShellCommand, actorInText } from './feed-model.ts';


/** A reference no build can render: the model never reads the sentence. */
const text = { id: 'test.summaryOnly' };

describe('merge entries in the activity feed', () => {
  it('have a label, a neutral tone, and show under "All activity" and the people filter', () => {
    expect(kindLabel('merge')).toBe('Merge');
    expect(kindTone('merge')).toBe('neutral');
    const event = { id: 'ac_1', at: 1, kind: 'merge' as const, actor: { kind: 'user' as const, userId: 'dev:amy', displayName: 'Amy' }, summary: 'Asked to merge their worktree into the main workspace', text };
    expect(matchesFilter(event, 'all')).toBe(true);
    expect(matchesFilter(event, 'people')).toBe(true);
    expect(matchesFilter(event, 'problems')).toBe(false);
  });
});

describe("an agent's change by a shell command (ARCHITECTURE §11 D-13)", () => {
  const agent = { kind: 'agent' as const, sessionId: 'sess_1', ownerUserId: 'dev:ian', displayName: 'Claude (Ian)' };
  it("is the agent's, marked \"via a command\" only when the daemon attributed it to the agent (agent.edit, agent actor, via 'bash')", () => {
    const bash = { id: 'ac_b', at: 1, kind: 'agent.edit' as const, actor: agent, summary: 'Claude (Ian) changed src/app.ts with a shell command', text, via: 'bash' as const };
    expect(viaShellCommand(bash)).toBe(true);
    expect(actorLabel(bash.actor)).toBe('Claude (Ian)');
    expect(matchesFilter(bash, 'agents')).toBe(true);
    expect(viaShellCommand({ ...bash, summary: 'Claude (Ian) changed 3 files with a shell command (e.g. a.ts, b.ts)' })).toBe(true);
    // The field decides, not the wording: another wording keeps the marker, the wording without the field gets none.
    expect(viaShellCommand({ ...bash, summary: 'Claude (Ian) used a shell on src/app.ts' })).toBe(true);
    const { via: _via, ...withoutVia } = bash;
    expect(viaShellCommand(withoutVia)).toBe(false);
    // An Edit tool change: the agent's, no marker.
    expect(viaShellCommand({ ...withoutVia, summary: 'Claude (Ian) edited src/app.ts (Edit)' })).toBe(false);
    // Nobody claimed it: "Outside program", as the daemon says, never a marker (even if a summary looked alike).
    const external = { id: 'ac_x', at: 1, kind: 'external.change' as const, actor: { kind: 'system' as const }, summary: 'A program outside smurg changed src/app.ts', text };
    expect(actorLabel(external.actor)).toBe('Outside program');
    // Inside a sentence of the conflict panel it reads as part of the sentence.
    expect(actorInText(external.actor)).toBe('an outside program');
    expect(actorInText(bash.actor)).toBe(bash.actor.displayName);
    expect(viaShellCommand(external)).toBe(false);
    expect(viaShellCommand({ ...external, summary: 'A program outside smurg changed x with a shell command' })).toBe(false);
    expect(viaShellCommand({ ...bash, kind: 'human.edit', actor: { kind: 'user', userId: 'dev:bob', displayName: 'Bob' } })).toBe(false);
  });
});
