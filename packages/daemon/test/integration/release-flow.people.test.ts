// The release composition when a member loses a role or leaves, and what `@name` reaches (OWNER-BRIEF decision 8;
// DESIGN §3.8 "mentions", §3.9, §7 S17): the real conversation, suggestion, inbox, worktree and agent-runtime modules
// on a real git repository with the stand-in `claude` (release-flow.support.ts). Ian is the host, Mei has agent
// access, Amy is an Editor, Leo a Viewer. Every step is asserted from what they RECEIVE, the files and the audit log.
//
// release-flow.members.test.ts covers a KICK (rules, an armed item, a loosened mode, a vote, a topic session that
// passes to the host). This file covers what that story does not reach: a demotion and a leave, the worktrees a
// member's ended sessions kept, and a mention in a suggestion and in a message.
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { AgentSession, InboxItem } from '@smurg/protocol';
import { AMY, IAN, LEO, MEI, audited, eventOf, inboxItem, inboxWithout, refusal, startFlow, statusIs, told, turnsFinished, waitFor, type Person } from './release-flow.support.ts';

const sessionOf = async (member: Person, sessionId: string): Promise<AgentSession> => (await member.conn.request('session.list', {})).sessions.find((session) => session.id === sessionId) as AgentSession;
const worktreesOf = async (member: Person): Promise<{ id: string; ownerUserId: string; kept: boolean }[]> => (await member.conn.request('worktree.list', {})).worktrees.map((worktree) => ({ id: worktree.id, ownerUserId: worktree.ownerUserId, kept: worktree.kept }));
const mentionsOf = (items: readonly InboxItem[]): InboxItem[] => items.filter((item) => item.kind === 'mention');

describe('the release composition: a member with agent access becomes a Viewer', { timeout: 240_000 }, () => {
  it('her free sessions end and the worktrees they kept (now and before) pass to the host: she can no longer remove them; what she was mentioned in stays hers to read', async () => {
    const flow = await startFlow({ files: { 'README.md': '# Bookshop\n', 'src/app.ts': 'export const a = 1;\n' } });
    await flow.claude.setScenario({
      turns: [
        { match: 'try two', steps: [{ tool: 'Edit', input: { file_path: 'src/app.ts', old_string: '1', new_string: '2' } }, { text: 'It works with 2.' }] },
        { match: 'try three', steps: [{ tool: 'Edit', input: { file_path: 'src/app.ts', old_string: '1', new_string: '3' } }, { text: 'It works with 3.' }] },
        { steps: [{ text: 'ok' }] },
      ],
    });
    const { ian, mei, amy, leo } = flow;

    // ---- Mei's first free session in a worktree: she ends it and keeps the worktree
    const first = (await mei.conn.request('session.create', { kind: 'agent', workspace: { mode: 'worktree' }, title: 'Two', firstMessage: 'Please try two.' })).session as AgentSession;
    const keptId = first.root.kind === 'worktree' ? first.root.worktreeId : '';
    await leo.watch(first.id);
    await turnsFinished(leo, first.id, 1);
    await statusIs(leo, first.id, 'idle');
    await mei.conn.request('session.end', { sessionId: first.id });
    await waitFor(async () => (await worktreesOf(leo)).some((worktree) => worktree.id === keptId && worktree.kept), { timeoutMs: 30_000, what: 'the first worktree to be kept' });
    // ---- her second one is still open when the host changes her role
    const second = (await mei.conn.request('session.create', { kind: 'agent', workspace: { mode: 'worktree' }, title: 'Three', firstMessage: 'Please try three.' })).session as AgentSession;
    const openId = second.root.kind === 'worktree' ? second.root.worktreeId : '';
    for (const member of [ian, mei, amy, leo]) await member.watch(second.id);
    await turnsFinished(leo, second.id, 1);
    await statusIs(leo, second.id, 'idle');
    expect((await worktreesOf(leo)).sort((a, b) => a.id.localeCompare(b.id))).toEqual([{ id: keptId, ownerUserId: MEI, kept: true }, { id: openId, ownerUserId: MEI, kept: false }].sort((a, b) => a.id.localeCompare(b.id)));
    const roots = { kept: flow.d.ctx.roots.get({ kind: 'worktree', worktreeId: keptId })?.realPath as string, open: flow.d.ctx.roots.get({ kind: 'worktree', worktreeId: openId })?.realPath as string };
    expect(await readFile(join(roots.kept, 'src/app.ts'), 'utf8')).toBe('export const a = 2;\n');
    expect(await readFile(join(roots.open, 'src/app.ts'), 'utf8')).toBe('export const a = 3;\n');

    // ---- `@name` in a suggestion and in a message (owner decision 8): the named person's inbox, nobody else's
    const suggested = (await amy.conn.request('suggest.create', { sessionId: second.id, text: 'Use four instead, @Mei and @Leo. (@Ian was not named in the list)', mentions: [MEI, LEO, AMY, 'dev:nobody'] })).suggestion;
    // Kept: active members the text names with `@`, never the sender, never an unknown id; the host is in the text but not in the list.
    expect(suggested.mentions).toEqual([MEI, LEO]);
    const meiMention = await inboxItem(mei, (item) => item.kind === 'mention', 'the mention in the suggestion');
    expect(meiMention).toMatchObject({ kind: 'mention', unread: true, waiting: false, sessionId: second.id, from: { kind: 'user', userId: AMY }, target: { kind: 'session', sessionId: second.id }, anchor: { cardId: suggested.id }, excerpt: 'Use four instead, @Mei and @Leo. (@Ian was not named in the list)' });
    expect(mentionsOf(await leo.inbox())).toMatchObject([{ from: { kind: 'user', userId: AMY }, anchor: { cardId: suggested.id } }]);
    expect(mentionsOf(await ian.inbox())).toEqual([]);
    expect(mentionsOf(await amy.inbox())).toEqual([]);
    // The suggestion itself waits for who may decide it (nobody is responsible: the host and Mei); the mention is a second row.
    expect((await mei.inbox()).filter((item) => item.kind === 'suggestion')).toMatchObject([{ sessionId: second.id, from: { kind: 'user', userId: AMY } }]);
    // A message of the host's that names Amy: her inbox, with where the message is.
    const sent = await ian.conn.request('session.message.send', { sessionId: second.id, text: 'What do you think, @Amy?', mentions: [AMY] });
    const amyMention = await inboxItem(amy, (item) => item.kind === 'mention', 'the mention in the message');
    expect(amyMention).toMatchObject({ from: { kind: 'user', userId: IAN }, target: { kind: 'session', sessionId: second.id }, anchor: { seq: expect.any(Number) }, excerpt: 'What do you think, @Amy?' });
    // The anchor is the message itself in the conversation.
    expect(await eventOf(leo, second.id, (event) => event.seq === amyMention.anchor?.seq, 'the message the mention points to')).toMatchObject({ kind: 'message', messageId: sent.messageId, from: { userId: IAN } });
    expect(mentionsOf(await mei.inbox())).toHaveLength(1);
    await turnsFinished(leo, second.id, 2);
    await statusIs(leo, second.id, 'idle');

    // ================================================================================================================
    // The host makes Mei a Viewer
    // ================================================================================================================
    expect(await refusal(amy.conn.request('admin.member.setRole', { userId: MEI, role: 'viewer' }))).toMatchObject({ code: 'forbidden' });
    expect((await ian.conn.request('admin.member.setRole', { userId: MEI, role: 'viewer' })).member).toMatchObject({ userId: MEI, role: 'viewer' });
    // Her open free session ends; nothing of its conversation is lost.
    await statusIs(leo, second.id, 'ended');
    expect(await sessionOf(leo, second.id)).toMatchObject({ status: 'ended', endReason: 'role-changed', openedBy: { userId: MEI } });
    expect((await audited(flow, 'session.terminate')).map((entry) => entry.detail)).toMatchObject([{ sessionId: second.id, openedBy: MEI, kind: 'agent', purpose: 'free', reason: 'role-changed' }]);
    // Both worktrees are kept, and they are the host's now: the one of the session that just ended and the one she had kept before.
    await waitFor(async () => (await worktreesOf(leo)).every((worktree) => worktree.ownerUserId === IAN && worktree.kept), { timeoutMs: 30_000, what: 'both worktrees to pass to the host' });
    expect((await worktreesOf(leo)).map((worktree) => worktree.id).sort()).toEqual([keptId, openId].sort());
    // As a Viewer she can remove neither (before: the owner by user id could, whatever her role had become).
    for (const worktreeId of [keptId, openId]) expect(await refusal(mei.conn.request('worktree.remove', { worktreeId }))).toMatchObject({ code: 'forbidden', reason: 'not-owner:worktree' });
    expect(await readFile(join(roots.kept, 'src/app.ts'), 'utf8')).toBe('export const a = 2;\n');
    expect(await readFile(join(roots.open, 'src/app.ts'), 'utf8')).toBe('export const a = 3;\n');
    expect((await audited(flow, 'worktree.remove')).filter((entry) => entry.outcome === 'ok')).toEqual([]);
    // Amy's suggestion to the ended session is closed (nobody decided it: its card says so, no inbox row does).
    await inboxWithout(mei, (item) => item.kind === 'suggestion', 'the suggestion of the ended session');
    await inboxWithout(ian, (item) => item.kind === 'suggestion', 'the suggestion of the ended session');
    expect((await leo.conn.request('suggest.list', { sessionId: second.id })).suggestions.find((suggestion) => suggestion.id === suggested.id)?.status).not.toBe('pending');
    expect(await refusal(ian.conn.request('suggest.accept', { suggestionId: suggested.id }))).toMatchObject({ code: 'conflict' });
    // The mention is still Mei's to read (a Viewer receives mentions); opening it removes it.
    expect(mentionsOf(await mei.inbox())).toMatchObject([{ key: meiMention.key }]);
    mei.conn.notify('inbox.seen', { keys: [meiMention.key] });
    await inboxWithout(mei, (item) => item.key === meiMention.key, 'the opened mention');
    // A Viewer cannot open a session, and a kept worktree is not a way back to one.
    expect(await refusal(mei.conn.request('session.create', { kind: 'agent', workspace: { mode: 'worktree', worktreeId: keptId } }))).toMatchObject({ code: 'forbidden' });

    // ---- the host looks at what was kept and removes it
    await ian.conn.request('worktree.remove', { worktreeId: keptId });
    await waitFor(async () => (await worktreesOf(leo)).length === 1, { timeoutMs: 30_000, what: 'the removed worktree to go' });
    expect((await audited(flow, 'worktree.remove')).filter((entry) => entry.outcome === 'ok').map((entry) => `${entry.actor.kind === 'user' ? entry.actor.userId : ''} ${entry.target}`)).toEqual([`${IAN} ${keptId}`]);

    // ================================================================================================================
    // Amy (an Editor) leaves by herself
    // ================================================================================================================
    // What she holds: she is responsible for a session of the host's, and a suggestion of hers waits there.
    const notes = (await ian.conn.request('session.create', { kind: 'agent', workspace: { mode: 'main' }, title: 'Notes' })).session as AgentSession;
    for (const member of [ian, leo]) await member.watch(notes.id);
    expect((await ian.conn.request('session.responsible.set', { sessionId: notes.id, userId: AMY })).session).toMatchObject({ responsible: { userId: AMY } });
    const hers = (await amy.conn.request('suggest.create', { sessionId: notes.id, text: 'Write the notes down.' })).suggestion;
    // An Editor who is responsible cannot accept: the suggestion is for the host (Mei is a Viewer now).
    await inboxItem(ian, (item) => item.kind === 'suggestion' && item.sessionId === notes.id, "Amy's suggestion");
    // (the request answers when the teardown has run; her membership stays, she can come back)
    await amy.conn.request('channel.leave', {});
    expect((await audited(flow, 'member.leave')).map((entry) => entry.target)).toEqual([AMY]);
    // She is no longer the responsible person: the session says so, once, and the log says why.
    await eventOf(leo, notes.id, (event) => event.kind === 'line' && event.text.id === 'conversation.responsible.fallback', 'the line about who decides now');
    expect(await sessionOf(leo, notes.id)).toMatchObject({ responsible: null, openedBy: { userId: IAN } });
    expect((await sessionOf(leo, notes.id)).status).not.toBe('ended');
    expect((await audited(flow, 'responsible.fallback')).map((entry) => entry.detail)).toMatchObject([{ sessionId: notes.id, from: AMY, reason: 'left' }]);
    expect((await audited(flow, 'session.handover')).filter((entry) => entry.detail?.['from'] === AMY).map((entry) => entry.detail)).toMatchObject([{ from: AMY, to: IAN, reason: 'left', cleared: [notes.id] }]);
    // Her suggestion is still what it was: words that reach the agent only when a member with agent access accepts
    // them, under her name. (A kick or a demotion below Editor withdraws it; leaving does not end her membership.)
    expect((await ian.conn.request('suggest.list', { sessionId: notes.id })).suggestions.find((suggestion) => suggestion.id === hers.id)).toMatchObject({ status: 'pending', author: { userId: AMY } });
    expect((await ian.conn.request('suggest.accept', { suggestionId: hers.id })).suggestion).toMatchObject({ status: 'accepted' });
    await turnsFinished(leo, notes.id, 1);
    expect((await told(flow, notes.id)).at(-1)).toBe('[Amy · Editor, suggestion accepted by Ian]\nWrite the notes down.');
    // The mentions she sent stay with the people she named.
    expect(mentionsOf(await leo.inbox())).toMatchObject([{ from: { kind: 'user', userId: AMY } }]);
  });
});

describe('the release composition: an agent session in a worktree whose start is refused', { timeout: 240_000 }, () => {
  it('leaves no empty worktree behind; a kept worktree the member wanted to continue in stays kept, with its work', async () => {
    // One agent session may be alive at a time: the second start is refused, whatever it asked for.
    const flow = await startFlow({ files: { 'README.md': '# Bookshop\n', 'src/app.ts': 'export const a = 1;\n' }, agents: { maxAgentSessions: 1 } });
    await flow.claude.setScenario({ turns: [{ match: 'try two', steps: [{ tool: 'Edit', input: { file_path: 'src/app.ts', old_string: '1', new_string: '2' } }, { text: 'It works with 2.' }] }, { steps: [{ text: 'ok' }] }] });
    const { mei, leo } = flow;
    // A session in a worktree of its own; Mei ends it and keeps the worktree.
    const first = (await mei.conn.request('session.create', { kind: 'agent', workspace: { mode: 'worktree' }, firstMessage: 'Please try two.' })).session as AgentSession;
    const keptId = first.root.kind === 'worktree' ? first.root.worktreeId : '';
    await leo.watch(first.id);
    await turnsFinished(leo, first.id, 1);
    await mei.conn.request('session.end', { sessionId: first.id });
    await waitFor(async () => (await worktreesOf(leo)).some((worktree) => worktree.id === keptId && worktree.kept), { timeoutMs: 30_000, what: 'the worktree to be kept' });
    const keptRoot = flow.d.ctx.roots.get({ kind: 'worktree', worktreeId: keptId })?.realPath as string;
    // The one session that may be alive.
    await mei.conn.request('session.create', { kind: 'agent', workspace: { mode: 'main' }, title: 'The only one' });

    // ---- a NEW worktree for a session that is refused: nothing stays
    expect(await refusal(mei.conn.request('session.create', { kind: 'agent', workspace: { mode: 'worktree' }, title: 'Too many' }))).toMatchObject({ code: 'conflict', reason: 'agent-limit', id: 'session.limit.agents' });
    await waitFor(async () => (await worktreesOf(leo)).length === 1, { timeoutMs: 30_000, what: 'the worktree of the refused start to go' });
    expect(await worktreesOf(leo)).toEqual([{ id: keptId, ownerUserId: MEI, kept: true }]);
    // ---- the KEPT worktree, for a session that is refused: it is still there, kept, with what the first session did
    expect(await refusal(mei.conn.request('session.create', { kind: 'agent', workspace: { mode: 'worktree', worktreeId: keptId }, title: 'Go on' }))).toMatchObject({ code: 'conflict', reason: 'agent-limit' });
    expect(await worktreesOf(leo)).toEqual([{ id: keptId, ownerUserId: MEI, kept: true }]);
    expect(await readFile(join(keptRoot, 'src/app.ts'), 'utf8')).toBe('export const a = 2;\n');
    expect((await leo.conn.request('session.list', {})).sessions.filter((session) => session.status !== 'ended').map((session) => session.title)).toEqual(['The only one']);
  });
});
