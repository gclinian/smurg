// A topic's SPEC.md edited by people and by the discussion agent in turns (design §4.6): the REAL docs, locks and
// files modules with the REAL topics module. People type through real Yjs clients; the agent's edit is what the tool
// gate makes of an Edit call: the lock decision of the real LockManager, the bus events the hook server emits around
// it, and a real write on disk that the real watcher and the docs module pick up. (The agent runtime and the hook
// entry themselves are the sessions and hooks packages' own tests; here they are the fakes of the contract.)
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { MAIN_ROOT, topicPlanPath, topicSpecPath, type FileRef, type LockInfo } from '@smurg/protocol';
import { fakesModule, fakesOf } from '../../src/core/fakes/index.ts';
import { docsModule } from '../../src/docs/module.ts';
import { filesModule } from '../../src/files/module.ts';
import { locksModule } from '../../src/locks/module.ts';
import { createTestDaemon, waitFor, type TestDaemon } from '../../src/testing/index.ts';
import { createTopicsModule } from '../../src/topics/module.ts';
import { DocClient, destroyDocClients } from '../docs/helpers.ts';
import { SPEC_TEXT, planText } from '../topics/support.ts';

let t: TestDaemon | null = null;

afterEach(async () => {
  destroyDocClients();
  await t?.cleanup();
  t = null;
});

describe('spec co-editing (real docs, locks, files and topics modules)', { timeout: 60_000 }, () => {
  it('T2.2 people and the agent edit the spec in turns', async () => {
    t = await createTestDaemon({
      modules: [locksModule, filesModule, docsModule, fakesModule({ except: ['topics', 'plans', 'reports'], handlers: true }), createTopicsModule({ fileDebounceMs: 50 })],
      settings: { humanLockIdleMs: 1_000 },
    });
    const d = t;
    const fakes = fakesOf(d.ctx);
    const locks = d.ctx.services.locks;
    await d.connectHost();
    const mei = await d.connect({ userId: 'dev:mei', displayName: 'Mei', role: 'agent' });
    const amy = await d.connect({ userId: 'dev:amy', displayName: 'Amy', role: 'editor' });

    const { topic, session } = await mei.conn.request('topic.create', { name: 'Checkout', firstMessage: 'We need a checkout.' });
    const spec: FileRef = { root: MAIN_ROOT, path: topicSpecPath(topic.slug) };
    const absSpec = join(d.root, spec.path);
    const onDisk = (): Promise<string> => readFile(absSpec, 'utf8').catch(() => '');
    const current = (): ReturnType<typeof d.ctx.services.topics.get> => d.ctx.services.topics.get(topic.id);

    /** One Edit / Write call of the discussion agent, as the tool gate and the hooks around it handle it. */
    const agentEdits = async (change: (text: string) => string): Promise<{ granted: true } | { granted: false; holder: LockInfo | null }> => {
      const owner = { sessionId: session.id, ownerUserId: 'dev:mei' };
      const lock = locks.requestAgent({ file: spec, ...owner, agentName: fakes.agents.agentActor(session.id).displayName, sessionRoot: MAIN_ROOT });
      if (!lock.granted) {
        d.ctx.bus.emit('agent.tool.pre', { ...owner, tool: 'Edit', file: spec, outcome: 'denied', ...(lock.holder === null ? {} : { holder: lock.holder }) });
        return { granted: false, holder: lock.holder };
      }
      d.ctx.bus.emit('agent.tool.pre', { ...owner, tool: 'Edit', file: spec, outcome: 'granted' });
      await writeFile(absSpec, change(await onDisk()));
      fakes.agents.edit(session.id, spec);
      d.ctx.bus.emit('agent.tool.post', { ...owner, tool: 'Edit', file: spec, ok: true });
      locks.releaseAgent(session.id, spec);
      return { granted: true };
    };

    // ---- 1. The agent writes the first draft: nobody is typing, so the file is its own for the edit ----
    fakes.agents.startTurn(session.id);
    expect(await agentEdits(() => '# Spec: Checkout\n\n## Goal\nA checkout page.\n\n## Decisions\n\n## Open questions\n')).toEqual({ granted: true });
    fakes.agents.finishTurn(session.id, { finalText: 'The draft is ready.' });
    await waitFor(() => current()?.phase === 'spec', { what: 'the phase to become spec' });
    expect(current()?.spec.lastAgentChange).toMatchObject({ sessionId: session.id, askedBy: { userId: 'dev:mei' } });
    // The agent's own draft is nobody's hand edit.
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(current()?.handEdits).toEqual({ spec: [], plan: [] });

    // ---- 2. Two people edit it together: one shared human lock, both texts in everyone's editor and on disk ----
    const amyDoc = await DocClient.open(amy.conn, spec);
    const meiDoc = await DocClient.open(mei.conn, spec);
    await waitFor(() => amyDoc.synced && meiDoc.synced && meiDoc.text.toString().includes('## Goal'), { what: 'both editors synced' });
    amyDoc.text.insert(amyDoc.text.toString().indexOf('## Decisions'), 'Guests can check out too. (Amy)\n\n');
    await waitFor(() => meiDoc.text.toString().includes('(Amy)'), { what: "Amy's text at Mei's editor" });
    meiDoc.text.insert(meiDoc.text.length, '- Which payment provider? (Mei)\n');
    await waitFor(() => amyDoc.text.toString().includes('(Mei)'), { what: "Mei's text at Amy's editor" });
    await waitFor(() => locks.get(spec)?.kind === 'human', { what: 'the shared human lock' });
    expect(locks.whoIsEditing(spec).humans.map((human) => human.displayName).sort()).toEqual(['Amy', 'Mei']);
    await waitFor(async () => (await onDisk()).includes('(Amy)') && (await onDisk()).includes('(Mei)'), { what: 'the autosave of both texts' });
    // The Start dialog will say who edited the spec by hand.
    await waitFor(() => (current()?.handEdits.spec.length ?? 0) === 2, { what: 'both hand edits' });
    expect(current()?.handEdits.spec.map((edit) => (typeof edit.by === 'string' ? edit.by : edit.by.displayName)).sort()).toEqual(['Amy', 'Mei']);

    // ---- 3. Someone asks the agent for a change while they still type: the agent waits its turn ----
    await mei.conn.request('topic.revise', { topicId: topic.id, target: 'spec', text: 'Add the decision about guests.' });
    fakes.agents.startTurn(session.id);
    amyDoc.text.insert(amyDoc.text.length, '- Is there a guest limit? (Amy)\n');
    await waitFor(() => locks.get(spec)?.kind === 'human', { what: 'the human lock while Amy types' });
    const before = await onDisk();
    const refused = await agentEdits((text) => `${text}THE AGENT MUST NOT WRITE NOW\n`);
    expect(refused).toMatchObject({ granted: false, holder: { kind: 'human' } });
    expect(await onDisk()).toBe(before);
    // People see why the agent waits (and can let it go first).
    const notice = fakes.agents.eventsOf(session.id).find((event) => event.kind === 'notice');
    expect(notice).toMatchObject({ level: 'info', text: { id: 'conversation.locked.spec', params: { path: spec.path } } });
    expect(notice?.kind === 'notice' ? notice.text.params?.['holders'] : undefined).toContain('Amy');

    // ---- 4. They stop typing: the lock goes by itself, the agent takes its turn, and nobody's text is lost ----
    await waitFor(() => locks.get(spec) === null, { timeoutMs: 15_000, what: 'the idle release of the human lock' });
    await waitFor(async () => (await onDisk()).includes('guest limit'), { what: "the autosave of Amy's last line" });
    const granted = await agentEdits((text) => text.replace('## Decisions\n', '## Decisions\n- Guests may check out without an account. (Claude)\n'));
    expect(granted).toEqual({ granted: true });
    fakes.agents.finishTurn(session.id, { finalText: 'Added the decision.' });
    await waitFor(() => amyDoc.text.toString().includes('(Claude)') && meiDoc.text.toString().includes('(Claude)'), { timeoutMs: 15_000, what: "the agent's change in both editors" });
    const final = await onDisk();
    for (const kept of ['A checkout page.', 'Guests can check out too. (Amy)', '- Which payment provider? (Mei)', '- Is there a guest limit? (Amy)', '- Guests may check out without an account. (Claude)']) {
      expect(final).toContain(kept);
      expect(amyDoc.text.toString()).toContain(kept);
      expect(meiDoc.text.toString()).toContain(kept);
    }
    expect(final).not.toContain('THE AGENT MUST NOT WRITE NOW');
    // The spec column can say who changed it last and open the discussion at that edit.
    await waitFor(() => current()?.spec.changedBy?.kind === 'agent', { what: 'the last change to be the agent\'s' });
    expect(current()?.spec.lastAgentChange).toMatchObject({ sessionId: session.id, askedBy: { userId: 'dev:mei', displayName: 'Mei' } });
    // The people who edited by hand are still listed for the next Start; the agent is not among them.
    expect(current()?.handEdits.spec.map((edit) => (typeof edit.by === 'string' ? edit.by : edit.by.userId)).sort()).toEqual(['dev:amy', 'dev:mei']);
    expect(fakes.agents.eventsOf(session.id).filter((event) => event.kind === 'pointer')).toMatchObject([{ target: 'spec' }, { target: 'spec' }]);
  });

  // The activity feed has ONE "edited" entry per person and file per minute (autosave runs all the time). The topic
  // must still know a hand edit at EVERY save: a Start forgets the list, and whoever types after it, within that
  // minute, has to be named by the next Start and in its commit (design §4.5; found by the browser flow, P12E).
  it('typing in the editor is a hand edit at every save: after a Start, the same person typing again within the minute is named by the next Start', async () => {
    t = await createTestDaemon({
      modules: [locksModule, filesModule, docsModule, fakesModule({ except: ['topics', 'plans', 'reports'], handlers: true }), createTopicsModule({ fileDebounceMs: 50 })],
      settings: { humanLockIdleMs: 1_000 },
    });
    const d = t;
    const fakes = fakesOf(d.ctx);
    await d.connectHost();
    const mei = await d.connect({ userId: 'dev:mei', displayName: 'Mei', role: 'agent' });
    const amy = await d.connect({ userId: 'dev:amy', displayName: 'Amy', role: 'editor' });
    const { topic } = await mei.conn.request('topic.create', { name: 'Checkout' });
    const spec: FileRef = { root: MAIN_ROOT, path: topicSpecPath(topic.slug) };
    const current = (): NonNullable<ReturnType<typeof d.ctx.services.topics.get>> => {
      const now = d.ctx.services.topics.get(topic.id);
      if (now === null) throw new Error('the topic is gone');
      return now;
    };
    const item = (id: string) => d.ctx.services.plans.get(topic.id)?.items.find((candidate) => candidate.id === id);
    // The people among the spec's hand edits (the two files are written from outside smurg below: that is `outside`).
    const people = () => current().handEdits.spec.flatMap((edit) => (typeof edit.by === 'string' ? [] : [{ name: edit.by.displayName, at: edit.at }]));
    const start = async (itemIds?: string[]) => {
      const { preflight } = await mei.conn.request('plan.preflight', { topicId: topic.id, ...(itemIds === undefined ? {} : { itemIds }) });
      await mei.conn.request('plan.start', { topicId: topic.id, planRevision: preflight.planRevision, specHash: preflight.specHash, planHash: preflight.planHash, ...(itemIds === undefined ? {} : { itemIds }) });
      return preflight;
    };
    await writeFile(join(d.root, spec.path), SPEC_TEXT);
    await writeFile(join(d.root, topicPlanPath(topic.slug)), planText([{ id: 'first' }, { id: 'second', dependsOn: ['first'] }]));
    // Told by hand as well: on Linux the watcher has no watch yet inside a folder that was made a moment ago together
    // with its parent (the known limit of the inotify backend, src/files/watcher.ts), and these two come from outside.
    d.ctx.bus.emit('file.changed', { root: MAIN_ROOT, changes: [{ path: spec.path, change: 'add' }, { path: topicPlanPath(topic.slug), change: 'add' }] });
    await waitFor(() => d.ctx.services.plans.get(topic.id)?.items.length === 2 && current().spec.exists, { what: 'the spec and the plan to be read' });
    await waitFor(() => current().handEdits.spec.length === 1 && current().handEdits.plan.length === 1, { what: 'the two files noted as written from outside' });
    expect(current().handEdits).toMatchObject({ spec: [{ by: 'outside' }], plan: [{ by: 'outside' }] });

    // ---- Amy types; the first Start names her and forgets the list ----
    const amyDoc = await DocClient.open(amy.conn, spec);
    await waitFor(() => amyDoc.synced && amyDoc.text.toString().includes('## Goal'), { what: "Amy's editor synced" });
    amyDoc.text.insert(amyDoc.text.length, 'Guests can check out too.\n');
    await waitFor(() => people().length === 1, { what: "Amy's first hand edit" });
    expect(people()).toMatchObject([{ name: 'Amy' }]);
    await waitFor(() => current().spec.changedBy?.kind === 'user', { what: 'the spec to be changed by Amy' });
    const firstAt = people()[0]?.at ?? 0;
    expect((await start()).handEdits).toMatchObject({ spec: [{ by: 'outside' }, { by: { userId: 'dev:amy' } }], plan: [{ by: 'outside' }] });
    expect(current().handEdits).toEqual({ spec: [], plan: [] });
    expect(fakes.worktrees.log.of('commitMainPaths').map((call) => (call[0] as { trailers: string[] }).trailers)).toEqual([['Edited-by: Amy']]);
    expect(item('second')).toMatchObject({ state: 'waiting', armed: true });

    // ---- she types again, seconds later: the item that waited is disarmed AND she is a hand editor again ----
    amyDoc.text.insert(amyDoc.text.length, 'Gift cards are out of scope.\n');
    await waitFor(() => item('second')?.disarmed === 'plan-changed', { what: 'the waiting item to be disarmed' });
    await waitFor(() => people().length === 1, { what: "Amy's hand edit after the Start" });
    expect(current().handEdits).toMatchObject({ spec: [{ by: { userId: 'dev:amy', displayName: 'Amy' } }], plan: [] });
    expect(people()[0]?.at).toBeGreaterThan(firstAt);
    // The file's last change is hers too (not "nobody's" because the feed had no entry for it).
    await waitFor(() => current().spec.changedBy?.kind === 'user', { what: 'the last change of the spec to be Amy\'s' });
    expect(current().spec.changedBy).toMatchObject({ kind: 'user', userId: 'dev:amy' });
    // The feed itself still has its one entry per person and file per minute.
    const feed = (await mei.conn.request('activity.list', { limit: 100 })).events.filter((event) => event.kind === 'human.edit' && event.file?.path === spec.path);
    expect(feed).toHaveLength(1);

    // ---- "Start again": the dialog names her, and so does the commit ----
    expect((await start(['second'])).handEdits).toMatchObject({ spec: [{ by: { userId: 'dev:amy' } }], plan: [] });
    expect(fakes.worktrees.log.of('commitMainPaths').map((call) => (call[0] as { trailers: string[] }).trailers)).toEqual([['Edited-by: Amy'], ['Edited-by: Amy']]);
    expect(current().handEdits).toEqual({ spec: [], plan: [] });
  });
});
