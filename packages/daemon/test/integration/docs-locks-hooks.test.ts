// SPEC R8 with the REAL docs, locks, hooks and files modules together (DEFAULT_FEATURE_MODULES): people type through
// real Yjs clients, the agent is the real `smurg hook` entry (node + packages/cli/src/main.ts, exactly what Claude
// Code runs) talking to the real hook socket, and the agent's edit is a real write on disk that the real watcher and
// the docs module pick up. Nothing between two modules is faked.
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { MAIN_ROOT, type FileRef } from '@smurg/protocol';
import { createTestDaemon, waitFor, type TestDaemon } from '../../src/testing/index.ts';
import { DocClient, destroyDocClients } from '../docs/helpers.ts';
import { denyReason, hookInput, recorder, runHook, sleep } from './support.ts';

const APP: FileRef = { root: MAIN_ROOT, path: 'src/app.ts' };
const ORIGINAL = 'export const a = 1;\n';

let t: TestDaemon | null = null;

afterEach(async () => {
  destroyDocClients();
  await t?.cleanup();
  t = null;
});

describe('docs + locks + hooks (real modules, real hook entry)', { timeout: 120_000 }, () => {
  it('a person types → the agent\'s Edit is refused naming them; they go idle → the agent gets the lock, every editor is read-only; PostToolUse → editable again, and the agent\'s disk write reaches every editor and the activity feed as 「Claude（Ian）」', async () => {
    t = await createTestDaemon({ project: { files: { 'src/app.ts': ORIGINAL } }, settings: { humanLockIdleMs: 3_000 } });
    const d = t;
    const host = await d.connectHost();
    const amy = await d.connect({ userId: 'dev:amy', displayName: 'Amy', role: 'editor' });
    const cara = await d.connect({ userId: 'dev:cara', displayName: 'Cara', role: 'editor' });
    const vera = await d.connect({ userId: 'dev:vera', displayName: 'Vera', role: 'viewer' });
    await d.connect({ userId: 'dev:ian', displayName: 'Ian', role: 'runner' });
    const lockStates = [host, amy, cara, vera].map((client) => recorder(client.conn, 'lock.state'));
    const activity = recorder(host.conn, 'activity.event');
    const absApp = join(d.root, 'src', 'app.ts');

    const amyDoc = await DocClient.open(amy.conn, APP);
    const hostDoc = await DocClient.open(host.conn, APP);
    await waitFor(() => amyDoc.synced && hostDoc.synced && amyDoc.text.toString() === ORIGINAL, { what: 'both editors synced' });

    // The agent session of Ian (a runner): registered with the real hook server, as the sessions module does.
    const agent = d.ctx.services.hooks.registerSession({ sessionId: 'ses_integration_ian', ownerUserId: 'dev:ian', agentName: 'Claude（Ian）', root: MAIN_ROOT, sandboxed: true });

    // 1. Amy types her first character: the human lock is hers.
    amyDoc.text.insert(0, '// amy\n');
    await waitFor(() => d.ctx.services.locks.get(APP)?.kind === 'human', { what: 'Amy\'s human lock' });
    // …the agent's Edit through the real hook entry is refused, and the reason names her.
    const refused = await runHook(agent.env, hookInput('PreToolUse', absApp, d.root), d.root);
    expect(refused.code).toBe(0);
    expect(denyReason(refused)).toBe('此檔案正由 Amy 編輯中，請先處理其他檔案或稍後再試');
    await waitFor(() => activity.some((a) => a.event.kind === 'lock.denied'), { what: 'the lock.denied activity entry' });
    // The typed text reaches the disk by autosave; the agent's refused edit changed nothing.
    await waitFor(async () => (await readFile(absApp, 'utf8')) === `// amy\n${ORIGINAL}`, { what: 'the autosave of Amy\'s text' });

    // 2. Amy goes idle (humanLockIdleMs 3 s): the lock manager releases her lock by itself; everyone is told.
    await waitFor(() => d.ctx.services.locks.get(APP) === null, { timeoutMs: 15_000, what: 'the idle release' });
    await waitFor(() => lockStates.every((states) => states.some((s) => s.lock === null)), { what: 'lock.state null at every client' });

    // 3. Now the agent's Edit is granted: the hook prints nothing (never "allow": the owner's own prompt still applies).
    const granted = await runHook(agent.env, hookInput('PreToolUse', absApp, d.root), d.root);
    expect(granted.code).toBe(0);
    expect(denyReason(granted)).toBeNull();
    expect(d.ctx.services.locks.get(APP)).toMatchObject({ kind: 'agent', sessionId: 'ses_integration_ian', agentName: 'Claude（Ian）' });
    // Every client (host, both editors, the viewer) is told the file is the agent's: their editors are read-only.
    await waitFor(
      () => lockStates.every((states) => states.at(-1)?.lock?.kind === 'agent'),
      { what: 'lock.state (agent) at every client' },
    );
    for (const states of lockStates) expect(states.at(-1)).toMatchObject({ file: APP, lock: { kind: 'agent', agentName: 'Claude（Ian）', ownerUserId: 'dev:ian' } });
    const caraDoc = await DocClient.open(cara.conn, APP);
    expect(caraDoc.opened.canEdit).toBe(false);
    expect(caraDoc.opened.lock).toMatchObject({ kind: 'agent', agentName: 'Claude（Ian）' });
    // A person's update that still arrives is refused and reverted everywhere.
    amyDoc.text.insert(amyDoc.text.length, '// typed while locked\n');
    await waitFor(() => amyDoc.rejected.length > 0, { what: 'doc.rejected for Amy' });
    expect(amyDoc.rejected[0]).toMatchObject({ reason: 'agent-locked', lock: { kind: 'agent' } });
    await waitFor(() => !amyDoc.text.toString().includes('typed while locked') && !hostDoc.text.toString().includes('typed while locked'), { what: 'the revert' });

    // 4. The agent's Edit tool writes the file (what Claude Code does after PreToolUse allowed it).
    const agentText = `// amy\nexport const a = 2;\n`;
    await writeFile(absApp, agentText);
    const post = await runHook(agent.env, hookInput('PostToolUse', absApp, d.root), d.root);
    expect(post.code).toBe(0);
    expect(post.stdout.trim()).toBe('');
    // PostToolUse released the lock: editable again, everyone told.
    await waitFor(() => d.ctx.services.locks.get(APP) === null, { what: 'the agent lock released by PostToolUse' });
    await waitFor(() => lockStates.every((states) => states.at(-1)?.lock === null), { what: 'lock.state null at every client after PostToolUse' });
    // The agent's write is in every editor (disk → Yjs, one update with the agent as origin)…
    await waitFor(() => amyDoc.text.toString() === agentText && hostDoc.text.toString() === agentText && caraDoc.text.toString() === agentText, {
      timeoutMs: 15_000,
      what: 'the agent\'s change in every editor',
    });
    // …and in the activity feed, attributed to the agent and its owner.
    await waitFor(() => activity.some((a) => a.event.kind === 'agent.edit'), { timeoutMs: 15_000, what: 'the agent.edit activity entry' });
    const edit = activity.find((a) => a.event.kind === 'agent.edit')?.event;
    expect(edit).toMatchObject({ file: APP, actor: { kind: 'agent', sessionId: 'ses_integration_ian', ownerUserId: 'dev:ian', displayName: 'Claude（Ian）' } });
    const listed = await vera.conn.request('activity.list', { limit: 50 });
    expect(listed.events.some((e) => e.kind === 'agent.edit' && e.actor.kind === 'agent' && e.actor.displayName === 'Claude（Ian）')).toBe(true);
    const audit = await host.conn.request('admin.audit.query', { limit: 200 });
    expect(audit.entries.some((e) => e.action === 'lock.denied' && e.actor.kind === 'agent' && e.actor.ownerUserId === 'dev:ian')).toBe(true);
    expect(audit.entries.some((e) => e.action === 'agent.edit' && e.actor.kind === 'agent' && e.target === 'main:src/app.ts')).toBe(true);

    // 5. Editable again: Amy's next keystroke is accepted and saved.
    const rejectedBefore = amyDoc.rejected.length;
    amyDoc.text.insert(amyDoc.text.length, '// back to amy\n');
    await waitFor(async () => (await readFile(absApp, 'utf8')) === `${agentText}// back to amy\n`, { timeoutMs: 15_000, what: 'Amy\'s edit saved after the release' });
    await sleep(200);
    expect(amyDoc.rejected.length).toBe(rejectedBefore);
    expect(d.ctx.services.locks.get(APP)).toMatchObject({ kind: 'human', holders: [{ userId: 'dev:amy' }] });
    d.ctx.services.hooks.unregisterSession('ses_integration_ian');
  });
});
