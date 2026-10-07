// SPEC R8.4 (and the daemon side of R8.2): a file someone is editing changes on disk behind the editor's back (an
// agent's Bash `sed`, a formatter, `git checkout`), simulated by writing the file and reporting it the way the file
// watcher does (a `file.changed` bus event). The lock manager is a fake that implements the LockManager contract.
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { MAIN_ROOT, isSmurgError, type Actor, type AgentSession, type AuditEntry, type ConflictRecord } from '@smurg/protocol';
import type { FeatureModule } from '../../src/core/context.ts';
import { buildAgentSession } from '../../src/core/fakes/build.ts';
import type { SessionManager } from '../../src/core/interfaces.ts';
import { toDisposable } from '../../src/core/lifecycle.ts';
import { createDocsModule } from '../../src/docs/module.ts';
import { TEST_HOST_USER, createTestDaemon, waitFor, type TestClient, type TestDaemon } from '../../src/testing/index.ts';
import { DocClient, FakeActivity, FakeLockManager, destroyDocClients, fakeLocksModule } from './helpers.ts';

let t: TestDaemon | null = null;

afterEach(async () => {
  try {
    destroyDocClients();
  } finally {
    await t?.cleanup();
    t = null;
  }
});

const PATH = 'src/app.ts';
const FILE = { root: MAIN_ROOT, path: PATH };
const ORIGINAL = ['import { run } from "./run";', '', 'const a = 1;', 'const b = 2;', 'const c = 3;', 'const d = 4;', 'const e = 5;', 'run(a, b, c, d, e);', ''].join('\n');

interface Setup {
  readonly t: TestDaemon;
  readonly locks: FakeLockManager;
  readonly activity: FakeActivity;
  readonly host: TestClient;
  readonly amy: DocClient;
  readonly audit: AuditEntry[];
  readonly conflictsSeen: { amy: ConflictRecord[]; host: ConflictRecord[] };
  readonly agent: Extract<Actor, { kind: 'agent' }>;
}

async function setup(extra: readonly FeatureModule[] = []): Promise<Setup> {
  const locks = new FakeLockManager();
  const activity = new FakeActivity();
  t = await createTestDaemon({ project: { files: { [PATH]: ORIGINAL } }, modules: [fakeLocksModule(locks, activity), ...extra, createDocsModule()] });
  const audit: AuditEntry[] = [];
  t.ctx.audit.subscribe((entry) => audit.push(entry));
  const host = await t.connectHost();
  const amyClient = await t.connect({ userId: 'dev:amy', displayName: 'Amy', role: 'editor' });
  const conflictsSeen = { amy: [] as ConflictRecord[], host: [] as ConflictRecord[] };
  amyClient.conn.on('doc.conflict', (p) => conflictsSeen.amy.push(p.conflict));
  host.conn.on('doc.conflict', (p) => conflictsSeen.host.push(p.conflict));
  const amy = await DocClient.open(amyClient.conn, FILE);
  await waitFor(() => amy.synced, { what: 'sync' });
  const agent = { kind: 'agent' as const, sessionId: 'sess_host1', ownerUserId: t.hostUserId, displayName: 'Claude (Host)' };
  return { t, locks, activity, host, amy, audit, conflictsSeen, agent };
}

/** What an agent's Bash write looks like to the daemon: bytes on disk, then the watcher's event. */
async function bashWrites(s: Setup, content: string, by?: Actor): Promise<void> {
  await writeFile(join(s.t.root, PATH), content);
  s.t.ctx.bus.emit('file.changed', { root: MAIN_ROOT, changes: [{ path: PATH, change: 'change', ...(by ? { by } : {}) }] });
}

const disk = (s: Setup): Promise<string> => readFile(join(s.t.root, PATH), 'utf8');

/** Replaces one whole line (0-based) in the client's text, as typing would. */
function typeLine(client: DocClient, line: number, content: string): void {
  const text = client.text.toString();
  const start = text.split('\n').slice(0, line).join('\n').length + (line > 0 ? 1 : 0);
  const end = text.indexOf('\n', start);
  client.doc.transact(() => {
    client.text.delete(start, end - start);
    client.text.insert(start, content);
  });
}

describe('R8 consistency and file locks', { timeout: 30_000 }, () => {
  it('an agent changes, through Bash, a file someone is editing: what the person typed is not lost and the overlap appears in the conflict panel', async () => {
    const s = await setup();
    typeLine(s.amy, 3, 'const b = 20; // Amy');
    await waitFor(() => s.locks.get(FILE)?.kind === 'human', { what: 'human lock' });
    // The agent's Bash rewrites the same line and, further down, another one.
    const agentVersion = ORIGINAL.replace('const b = 2;', 'const b = 200; // agent').replace('const e = 5;', 'const e = 50; // agent');
    await bashWrites(s, agentVersion, s.agent);

    await waitFor(() => s.amy.text.toString().includes('const e = 50; // agent'), { what: 'non-overlapping agent change applied' });
    const merged = s.amy.text.toString();
    expect(merged).toContain('const b = 20; // Amy');
    expect(merged).not.toContain('const b = 200; // agent');
    // The overlapping part reaches the conflict panel: both the humans and the agent's owner are told.
    await waitFor(() => s.conflictsSeen.amy.length === 1 && s.conflictsSeen.host.length === 1, { what: 'doc.conflict to Amy and to the agent owner' });
    const conflict = s.conflictsSeen.amy[0] as ConflictRecord;
    expect(conflict).toMatchObject({ file: FILE, source: s.agent, status: 'open', humans: [{ userId: 'dev:amy', displayName: 'Amy' }] });
    expect(conflict.hunks).toEqual([{ humanText: 'const b = 20; // Amy', agentText: 'const b = 200; // agent', baseText: 'const b = 2;', startLine: 4 }]);
    // The merged text is written back: the disk converges to it (the human text is on disk, not lost).
    await waitFor(async () => (await disk(s)) === merged, { what: 'merged text written back' });
    // Conflict panel requests.
    const amyConn = s.amy.conn;
    expect((await amyConn.request('doc.conflict.list', {})).conflicts.map((c) => c.id)).toEqual([conflict.id]);
    const got = await amyConn.request('doc.conflict.get', { conflictId: conflict.id });
    expect(new TextDecoder().decode(got.agentVersion)).toBe(agentVersion);
    expect(got.conflict.agentVersionBytes).toBe(Buffer.byteLength(agentVersion));
    expect(s.audit.filter((e) => e.action === 'doc.conflict')).toMatchObject([{ actor: s.agent, outcome: 'ok', target: `main:${PATH}` }]);
    expect(s.activity.records.filter((r) => r.kind === 'conflict')).toMatchObject([{ actor: s.agent, file: FILE }]);
  });

  it('... what the person typed is not lost — text that was ALREADY AUTOSAVED survives a write built from a stale copy (V4)', async () => {
    const s = await setup();
    typeLine(s.amy, 2, 'const a = 1; // HUMAN LINE');
    await waitFor(() => s.amy.saved.length > 0, { what: 'autosave' });
    expect(await disk(s)).toContain('HUMAN LINE');

    // (1) A generator / formatter holding the old buffer writes the old text with a change elsewhere.
    await bashWrites(s, ORIGINAL.replace('const e = 5;', 'const e = 5; // regenerated'));
    await waitFor(() => s.amy.text.toString().includes('// regenerated'), { what: 'stale write merged' });
    expect(s.amy.text.toString()).toContain('HUMAN LINE');
    await waitFor(async () => (await disk(s)).includes('HUMAN LINE') && (await disk(s)).includes('// regenerated'), { what: 'disk has both' });

    // (2) `git checkout -- src/app.ts`: exactly the text from before the human lock was taken. Relative to lockBase
    // that is "no change", so everything in the editor is kept (conservative: the earlier agent line stays too) and
    // written back.
    const beforeRevert = s.amy.text.toString();
    await bashWrites(s, ORIGINAL);
    await waitFor(async () => (await disk(s)) === beforeRevert, { what: 'human line written back after the revert' });
    expect(s.amy.text.toString()).toBe(beforeRevert);

    // (3) A stale copy that rewrites the human's own line: human text kept, the agent's line to the conflict panel.
    await bashWrites(s, ORIGINAL.replace('const a = 1;', 'const a = 1; // STALE AGENT'));
    await waitFor(() => s.conflictsSeen.amy.length === 1, { what: 'conflict for the overlapping stale write' });
    expect(s.amy.text.toString()).toContain('HUMAN LINE');
    expect(s.amy.text.toString()).not.toContain('STALE AGENT');
    expect(s.conflictsSeen.amy[0]?.source).toEqual({ kind: 'system' }); // nobody claimed the write: an external change
    await waitFor(async () => (await disk(s)).includes('HUMAN LINE'), { what: 'disk keeps the human line' });
    expect(s.t.ctx.services.docs.lockBase(FILE)).toBe(ORIGINAL);
  });

  it('without a human lock the disk change is applied as is, attributed to the agent that held the lock', async () => {
    const s = await setup();
    const granted = s.locks.requestAgent({ file: FILE, sessionId: s.agent.sessionId, ownerUserId: s.agent.ownerUserId, agentName: s.agent.displayName, sessionRoot: MAIN_ROOT });
    expect(granted.granted).toBe(true);
    const agentVersion = ORIGINAL.replace('run(a, b, c, d, e);', 'run(a, b, c, d, e); // done by agent');
    await writeFile(join(s.t.root, PATH), agentVersion);
    s.locks.releaseAgent(s.agent.sessionId); // PostToolUse: lock.changed → the daemon re-checks the file at once
    await waitFor(() => s.amy.text.toString() === agentVersion, { what: 'agent edit applied' });
    expect(s.conflictsSeen.amy).toHaveLength(0);
    // Nothing to write back (the disk already has it) and no human lock was taken by the daemon's own change.
    expect(s.locks.get(FILE)).toBeNull();
    // The agent shows up in the document's presence as `Claude (Host)`.
    await waitFor(() => [...s.amy.remoteStates().values()].some((st) => (st['user'] as { name?: string })?.name === 'Claude (Host)'), { what: 'agent presence' });
  });

  it("an agent's caret is the turn's: it goes when the session is no longer at work, and it carries the session's name as it is now, the name presence.state gives it (WX-7, review R6-14)", async () => {
    // The session manager knows the session under its current name (the topic was renamed since the process, and
    // with it the lock's name, started).
    const NOW = 'Claude (Checkout v2)';
    const sessions = { agentActor: (sessionId: string) => ({ kind: 'agent' as const, sessionId, ownerUserId: TEST_HOST_USER, displayName: NOW }) } as unknown as SessionManager;
    const s = await setup([{ name: 'fake-sessions', create: () => ({ sessions }), register: () => toDisposable(() => {}) }]);
    const agentStates = (): { name?: string }[] => [...s.amy.remoteStates().values()].map((st) => st['user'] as { name?: string; kind?: string }).filter((user) => user?.kind === 'agent');
    const write = async (text: string): Promise<void> => {
      expect(s.locks.requestAgent({ file: FILE, sessionId: s.agent.sessionId, ownerUserId: s.agent.ownerUserId, agentName: 'Claude (Checkout)', sessionRoot: MAIN_ROOT }).granted).toBe(true);
      await writeFile(join(s.t.root, PATH), text);
      s.locks.releaseAgent(s.agent.sessionId);
      await waitFor(() => s.amy.text.toString() === text, { what: 'the agent edit to be applied' });
    };
    const session = (status: AgentSession['status']): AgentSession => buildAgentSession({ id: s.agent.sessionId, openedBy: { userId: TEST_HOST_USER, displayName: 'Host' }, root: MAIN_ROOT, status, createdAt: 1 });
    await write(ORIGINAL.replace('run(a, b, c, d, e);', 'run(a, b, c, d, e); // one'));
    await waitFor(() => agentStates().length === 1, { what: 'the agent caret' });
    expect(agentStates()).toMatchObject([{ name: NOW }]);
    // Still at work (it waits for a permission inside the turn): the caret stays.
    s.t.ctx.bus.emit('session.updated', { session: session('waiting-permission') });
    s.t.ctx.bus.emit('session.updated', { session: session('running') });
    // Someone else's session ends its turn: not this agent's caret.
    s.t.ctx.bus.emit('session.updated', { session: { ...session('idle'), id: 'sess_other' } });
    await write(ORIGINAL.replace('run(a, b, c, d, e);', 'run(a, b, c, d, e); // two'));
    expect(agentStates()).toMatchObject([{ name: NOW }]);
    // The turn ends; the session lives on. Its caret and its name leave the document.
    s.t.ctx.bus.emit('session.updated', { session: session('idle') });
    await waitFor(() => agentStates().length === 0, { what: 'the caret to go with the turn' });
  });

  it('a file an agent is changing — a human update that still arrives is applied, then reverted everywhere, and the sender gets doc.rejected', async () => {
    const s = await setup();
    const bobClient = await s.t.connect({ userId: 'dev:bob', displayName: 'Bob', role: 'editor' });
    const bob = await DocClient.open(bobClient.conn, FILE);
    await waitFor(() => bob.synced, { what: 'sync' });
    s.locks.requestAgent({ file: FILE, sessionId: s.agent.sessionId, ownerUserId: s.agent.ownerUserId, agentName: s.agent.displayName, sessionRoot: MAIN_ROOT });
    // A new opener sees canEdit = false and the lock.
    const late = await (await s.t.connect({ userId: 'dev:carol', role: 'editor' })).conn.request('doc.open', { file: FILE });
    expect(late).toMatchObject({ canEdit: false, lock: { kind: 'agent', sessionId: s.agent.sessionId } });
    // Amy's client had not seen the lock yet: her insert and a delete-only edit both come back.
    s.amy.text.insert(0, '// typed during the agent lock\n');
    await waitFor(() => s.amy.rejected.length === 1, { what: 'doc.rejected' });
    s.amy.text.delete(0, 6);
    await waitFor(() => s.amy.rejected.length === 2, { what: 'second doc.rejected' });
    await waitFor(() => s.amy.text.toString() === ORIGINAL && bob.text.toString() === ORIGINAL, { what: 'every replica converged back' });
    expect(s.amy.rejected[0]).toMatchObject({ reason: 'agent-locked', lock: { kind: 'agent', agentName: 'Claude (Host)' } });
    expect(bob.rejected).toHaveLength(0);
    expect(await disk(s)).toBe(ORIGINAL);
    // After the agent is done, editing works again.
    s.locks.releaseAgent(s.agent.sessionId);
    s.amy.text.insert(0, '// after\n');
    await waitFor(async () => (await disk(s)).startsWith('// after\n'), { what: 'autosave after the lock' });
    expect(s.amy.rejected).toHaveLength(2);
  });

  it('doc.conflict.resolve: apply-agent-version writes the agent version (audited); a viewer may list but not resolve', async () => {
    const s = await setup();
    typeLine(s.amy, 3, 'const b = 21;');
    const agentVersion = ORIGINAL.replace('const b = 2;', 'const b = 22;');
    await bashWrites(s, agentVersion, s.agent);
    await waitFor(() => s.conflictsSeen.amy.length === 1, { what: 'conflict' });
    const conflictId = (s.conflictsSeen.amy[0] as ConflictRecord).id;

    const vera = await s.t.connect({ userId: 'dev:vera', role: 'viewer' });
    expect((await vera.conn.request('doc.conflict.list', {})).conflicts).toHaveLength(1);
    const refused = await vera.conn.request('doc.conflict.resolve', { conflictId, action: 'dismiss' }).catch((e: unknown) => e);
    expect(isSmurgError(refused) && refused.code).toBe('forbidden');

    const resolved = await s.amy.conn.request('doc.conflict.resolve', { conflictId, action: 'apply-agent-version' });
    expect(resolved.conflict.status).toBe('applied');
    await waitFor(() => s.amy.text.toString() === agentVersion, { what: 'agent version in the editor' });
    expect(await disk(s)).toBe(agentVersion);
    expect(s.audit.filter((e) => e.action === 'doc.conflict-resolve')).toMatchObject([{ actor: { kind: 'user', userId: 'dev:amy' }, outcome: 'ok', detail: { conflictId, action: 'apply-agent-version' } }]);
    // Everyone's panel is updated with the new status.
    await waitFor(() => s.conflictsSeen.host.some((c) => c.id === conflictId && c.status === 'applied'), { what: 'status update' });
  });
});
