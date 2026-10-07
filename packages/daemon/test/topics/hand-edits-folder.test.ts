// Who edited a topic's SPEC.md and PLAN.md by hand, when the write is a FOLDER (review R1-03, R2-03; DESIGN §7 S3
// "who edited them by hand (every write path, and changed outside smurg)"). Renaming, replacing or removing
// `specs/<slug>` or `specs` is a write of both files, by whoever did it; the activity feed and the watcher then name
// only the folder, so the topic must take a folder for the files it holds, and read the files again.
// The REAL topics module (and, in the second half, the real files and locks modules).
import { createHash } from 'node:crypto';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { MAIN_ROOT, topicPlanPath, topicSpecPath, type FileRef } from '@smurg/protocol';
import { fakesModule, fakesOf, recordActivity } from '../../src/core/fakes/index.ts';
import type { FileServiceImpl } from '../../src/files/file-service.ts';
import { filesModule } from '../../src/files/module.ts';
import { locksModule } from '../../src/locks/module.ts';
import { createTestDaemon, waitFor, type TestDaemon } from '../../src/testing/index.ts';
import { createTopicsModule } from '../../src/topics/module.ts';
import { SPEC_TEXT, createTopic, planText, settle, setupTopics, type TopicsTest } from './support.ts';

let test: TopicsTest | null = null;
let daemon: TestDaemon | null = null;
afterEach(async () => {
  await test?.cleanup();
  test = null;
  await daemon?.cleanup();
  daemon = null;
});

const main = (path: string): FileRef => ({ root: MAIN_ROOT, path });
const encode = (text: string): Uint8Array => new TextEncoder().encode(text);
const AMY = { kind: 'user' as const, userId: 'dev:amy', displayName: 'Amy' };
const MEI = { kind: 'user' as const, userId: 'dev:mei', displayName: 'Mei' };

describe('S3 handEdits per write path: a folder that holds the two files', () => {
  it('a member\'s rename of the topic\'s folder into place or away, and a rename or a delete of `specs`, name the member under BOTH files; a new empty folder and a folder beside the topic do not', async () => {
    test = await setupTopics();
    const { topic } = await createTopic(test);
    const edits = () => (test as TopicsTest).topic(topic.id).handEdits;
    // NOT hand edits: a folder beside the topic's, a folder inside it, a new (empty) folder above it, another root.
    recordActivity(test.t.ctx, { actor: AMY, kind: 'file.rename', file: main('specs/other'), renamedFrom: 'specs/other-old', at: 90 });
    recordActivity(test.t.ctx, { actor: AMY, kind: 'file.delete', file: main('specs/checkout/reports'), at: 91 });
    recordActivity(test.t.ctx, { actor: AMY, kind: 'file.create', file: main('specs'), at: 92 });
    recordActivity(test.t.ctx, { actor: AMY, kind: 'file.rename', file: { root: { kind: 'worktree', worktreeId: 'wt_1' }, path: 'specs' }, renamedFrom: 'stage', at: 93 });
    expect(edits()).toEqual({ spec: [], plan: [] });
    // The topic's folder moved INTO place (a staging folder renamed onto it): both files are whoever moved it.
    recordActivity(test.t.ctx, { actor: AMY, kind: 'file.rename', file: main('specs/checkout'), renamedFrom: 'stage', at: 100 });
    expect(edits()).toEqual({ spec: [{ by: { userId: 'dev:amy', displayName: 'Amy' }, at: 100 }], plan: [{ by: { userId: 'dev:amy', displayName: 'Amy' }, at: 100 }] });
    // …and AWAY from it; under another spelling of the folder; the folder above it; a delete.
    recordActivity(test.t.ctx, { actor: MEI, kind: 'file.rename', file: main('specs/checkout-old'), renamedFrom: 'Specs/Checkout', at: 110 });
    recordActivity(test.t.ctx, { actor: { kind: 'user', userId: 'dev:host', displayName: 'Host' }, kind: 'file.rename', file: main('specs.bak'), renamedFrom: 'specs', at: 120 });
    recordActivity(test.t.ctx, { actor: AMY, kind: 'file.delete', file: main('specs'), at: 130 });
    const members = [
      { by: { userId: 'dev:mei', displayName: 'Mei' }, at: 110 },
      { by: { userId: 'dev:host', displayName: 'Host' }, at: 120 },
      { by: { userId: 'dev:amy', displayName: 'Amy' }, at: 130 },
    ];
    expect(edits()).toEqual({ spec: members, plan: members });
  });

  it('what the WATCHER says about a folder names nobody (it reports a folder that was just made, and the agent\'s own writes below it): the files are read again, no hand edit is invented', async () => {
    test = await setupTopics();
    const { topic, session } = await createTopic(test);
    const edits = () => (test as TopicsTest).topic(topic.id).handEdits;
    const folder = main(`specs/${topic.slug}`);
    const discussion = test.fakes.agents.agentActor(session.id);
    // The topic's folder was just made; then the discussion agent writes the spec while the watcher reports the folder.
    recordActivity(test.t.ctx, { actor: { kind: 'system' }, kind: 'external.change', file: main('specs'), at: 100 });
    recordActivity(test.t.ctx, { actor: { kind: 'system' }, kind: 'external.change', file: folder, at: 101 });
    await writeFile(join(test.t.root, 'specs', topic.slug, 'SPEC.md'), SPEC_TEXT);
    recordActivity(test.t.ctx, { actor: { kind: 'system' }, kind: 'external.change', file: folder, at: 102 });
    recordActivity(test.t.ctx, { actor: { kind: 'agent', sessionId: 'sess_other', ownerUserId: 'dev:mei', displayName: 'Claude (Other)' }, kind: 'agent.edit', file: folder, via: 'bash', at: 103 });
    test.t.ctx.bus.emit('file.changed', { root: MAIN_ROOT, changes: [{ path: `specs/${topic.slug}`, change: 'change' }] });
    await waitFor(() => (test as TopicsTest).topic(topic.id).spec.exists, { what: 'the spec to be read' });
    recordActivity(test.t.ctx, { actor: discussion, kind: 'agent.edit', file: main(topicSpecPath(topic.slug)), at: 104 });
    await settle(test);
    expect(edits()).toEqual({ spec: [], plan: [] });
  });

  it('the watcher names only the folder of a rename: the topic reads its two files again', async () => {
    test = await setupTopics();
    const { topic } = await createTopic(test);
    const spec = (): boolean => (test as TopicsTest).topic(topic.id).spec.exists;
    await test.write(topicSpecPath(topic.slug), SPEC_TEXT);
    await waitFor(spec, { what: 'the spec to be read' });
    // A program on the host swaps the folder for one without a spec; the watcher reports the folders and no file.
    await mkdir(join(test.t.root, 'stage'));
    await rename(join(test.t.root, 'specs', topic.slug), join(test.t.root, 'specs', 'checkout-old'));
    await rename(join(test.t.root, 'stage'), join(test.t.root, 'specs', topic.slug));
    test.t.ctx.bus.emit('file.changed', { root: MAIN_ROOT, changes: [{ path: 'specs/checkout-old', change: 'addDir' }, { path: `specs/${topic.slug}`, change: 'addDir' }, { path: 'stage', change: 'unlinkDir' }] });
    await waitFor(() => !spec(), { what: 'the replaced folder to be read without anyone opening the Start dialog' });
    // The folder above it, under another spelling: read again as well.
    await writeFile(join(test.t.root, 'specs', topic.slug, 'SPEC.md'), SPEC_TEXT);
    test.t.ctx.bus.emit('file.changed', { root: MAIN_ROOT, changes: [{ path: 'Specs', change: 'addDir' }] });
    await waitFor(spec, { what: 'the spec to be read after a change of `specs`' });
    // A folder that holds neither file asks for nothing (the topic's files are as they were read).
    test.t.ctx.bus.emit('file.changed', { root: MAIN_ROOT, changes: [{ path: 'src', change: 'addDir' }, { path: `specs/${topic.slug}/reports`, change: 'addDir' }] });
    await settle(test);
    expect(spec()).toBe(true);
  });
});

describe('who the next read of a topic file names as its writer (review R1-03)', () => {
  it('a note is about one write: a write that changed nothing does not name its writer for a later change nobody announced', async () => {
    test = await setupTopics();
    const { topic, session } = await createTopic(test);
    const discussion = test.fakes.agents.agentActor(session.id);
    const specPath = topicSpecPath(topic.slug);
    const now = () => (test as TopicsTest).topic(topic.id);
    await test.write(specPath, SPEC_TEXT);
    recordActivity(test.t.ctx, { actor: discussion, kind: 'agent.edit', file: main(specPath), at: 100 });
    await waitFor(() => now().spec.exists, { what: 'the spec to be read' });
    await settle(test);
    // The same write is reported once more (the watcher's report of it comes late): the content is as it was read.
    recordActivity(test.t.ctx, { actor: discussion, kind: 'agent.edit', file: main(specPath), at: 101 });
    // The files are read (here: because someone opens the Start dialog; there is no plan yet, so it is refused after
    // the read): nothing changed, and the note has had its read.
    await test.mei.conn.request('plan.preflight', { topicId: topic.id }).catch(() => undefined);
    await settle(test);
    expect(now().spec.changedBy).toMatchObject({ kind: 'agent', sessionId: session.id });
    // A program on the host changes the file: nobody announced it, and the agent's used-up note is not its writer.
    await test.write(specPath, `${SPEC_TEXT}\nChanged from outside.\n`);
    await waitFor(() => now().spec.changedBy?.kind !== 'agent', { what: 'the outside change to be read as nobody\'s' });
    expect(now().spec.changedBy).toEqual({ kind: 'system' });
    // And a member's write after it names the member, whatever was noted before.
    await test.write(specPath, `${SPEC_TEXT}\nAs Amy wants it.\n`);
    recordActivity(test.t.ctx, { actor: AMY, kind: 'human.edit', file: main(specPath), at: 200 });
    await waitFor(() => now().spec.changedBy?.kind === 'user', { what: 'the member\'s write to be read' });
    expect(now().spec.changedBy).toMatchObject({ kind: 'user', userId: 'dev:amy' });
  });
});

describe('S3 with the real files module: an Editor swaps the topic\'s folder in the main workspace', { timeout: 60_000 }, () => {
  it('the Start dialog names her under both files, the files are read again at once, and the spec\'s "changed by" is her', async () => {
    daemon = await createTestDaemon({
      modules: [fakesModule({ except: ['topics', 'plans', 'reports', 'locks', 'files', 'uploads', 'downloads', 'activity', 'presence'], handlers: true }), locksModule, filesModule, createTopicsModule({ fileDebounceMs: 10 })],
      project: { files: { 'README.md': '# project\n' } },
    });
    const d = daemon;
    await d.connectHost();
    const mei = await d.connect({ userId: 'dev:mei', displayName: 'Mei', role: 'agent' });
    const amy = await d.connect({ userId: 'dev:amy', displayName: 'Amy', role: 'editor' });
    const { topic, session } = await mei.conn.request('topic.create', { name: 'Checkout' });
    const PLAN = planText([{ id: 'cart-api', title: 'Cart API' }]);
    // The discussion agent writes both files (its own writes are not hand edits): announced to the watcher as its
    // tool call announces them, so the change on disk is the agent's and not "an outside program's".
    const discussion = fakesOf(d.ctx).agents.agentActor(session.id);
    for (const [path, text] of [[topicSpecPath(topic.slug), SPEC_TEXT], [topicPlanPath(topic.slug), PLAN]] as const) {
      d.ctx.services.files.expectChange(main(path), discussion);
      await writeFile(join(d.root, path), text);
      recordActivity(d.ctx, { actor: discussion, kind: 'agent.edit', file: main(path) });
    }
    const topicNow = () => d.ctx.services.topics.get(topic.id);
    await waitFor(() => topicNow()?.plan.valid === true && topicNow()?.spec.exists === true, { timeoutMs: 15_000, what: 'the agent\'s spec and plan' });
    expect(topicNow()?.handEdits).toEqual({ spec: [], plan: [] });
    expect(topicNow()?.spec.changedBy).toMatchObject({ kind: 'agent' });
    const AMYS_SPEC = `${SPEC_TEXT}\nAs Amy wants it.\n`;

    // Amy's detour: a staging folder with her own two files, the topic's folder aside, hers in its place.
    await amy.conn.request('file.create', { file: main('stage'), kind: 'dir' });
    await amy.conn.request('file.write', { file: main('stage/SPEC.md'), content: encode(AMYS_SPEC) });
    await amy.conn.request('file.write', { file: main('stage/PLAN.md'), content: encode(PLAN) });
    await amy.conn.request('file.rename', { root: MAIN_ROOT, from: `specs/${topic.slug}`, to: `specs/${topic.slug}-old` });
    await amy.conn.request('file.rename', { root: MAIN_ROOT, from: 'stage', to: `specs/${topic.slug}` });

    // Whatever the watcher reports about the two files from now on is hers: her rename of the folder is the newest
    // announcement, although the agent's window for the files themselves is still open (the watcher's late report of
    // the agent's own write, taken for a second write by the agent, named the agent as the writer of HER content).
    const attribution = (d.ctx.services.files as FileServiceImpl).attribution;
    expect(attribution.attribute(MAIN_ROOT, topicSpecPath(topic.slug))).toMatchObject({ kind: 'user', userId: 'dev:amy' });
    expect(attribution.attribute(MAIN_ROOT, topicPlanPath(topic.slug))).toMatchObject({ kind: 'user', userId: 'dev:amy' });

    // Read again by itself (nobody opened the Start dialog), and the change is hers.
    await waitFor(() => topicNow()?.spec.changedBy?.kind === 'user', { timeoutMs: 15_000, what: 'the replaced spec to be read' });
    expect(topicNow()?.spec.changedBy).toMatchObject({ kind: 'user', userId: 'dev:amy' });
    expect(topicNow()?.handEdits.spec.map((edit) => edit.by)).toEqual([{ userId: 'dev:amy', displayName: 'Amy' }]);
    expect(topicNow()?.handEdits.plan.map((edit) => edit.by)).toEqual([{ userId: 'dev:amy', displayName: 'Amy' }]);
    // What Mei is shown before she confirms the Start: the pinned content is Amy's, and it says so.
    const { preflight } = await mei.conn.request('plan.preflight', { topicId: topic.id });
    expect(preflight.specHash).toBe(createHash('sha256').update(AMYS_SPEC).digest('hex'));
    expect(preflight.handEdits.spec.map((edit) => edit.by)).toEqual([{ userId: 'dev:amy', displayName: 'Amy' }]);
    expect(preflight.handEdits.plan.map((edit) => edit.by)).toEqual([{ userId: 'dev:amy', displayName: 'Amy' }]);
  });
});
