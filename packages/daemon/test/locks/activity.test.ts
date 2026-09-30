// The activity feed (SPEC R8, R11; ARCHITECTURE §5.4, §7.3): activity.jsonl (private, bounded, paged newest first
// with an exact `before` cursor), the bus → activity + audit mapping of ActivityFeed (core/interfaces.ts), and
// activity.notify.
import { lstat, mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { MAIN_ROOT, activityEventSchema, type ActivityEvent, type FileRef, type SessionInfo } from '@smurg/protocol';
import { TypedEventBus } from '../../src/core/bus.ts';
import { ManualClock } from '../../src/core/lifecycle.ts';
import { silentLogger } from '../../src/core/logger.ts';
import { ActivityLogFile } from '../../src/locks/activity-log.ts';
import { ActivityFeedImpl, EXTERNAL_BURST_MAX, LOCK_DENIED_PER_SESSION_PER_MINUTE } from '../../src/locks/activity.ts';
import { locksModule } from '../../src/locks/module.ts';
import { createTempDir, createTestDaemon, removeTempDir, waitFor, type TestDaemon } from '../../src/testing/index.ts';
import { agentSession, preToolUse, recorder, watcherSaw } from './agent-sim.ts';
import { RecordingAudit } from './support.ts';

const main = (path: string): FileRef => ({ root: MAIN_ROOT, path });

let t: TestDaemon | null = null;
const dirs: string[] = [];

afterEach(async () => {
  await t?.cleanup();
  t = null;
  for (const dir of dirs.splice(0)) await removeTempDir(dir);
});

async function daemon(): Promise<TestDaemon> {
  t = await createTestDaemon({ modules: [locksModule], project: { files: { 'README.md': '# hi\n' } } });
  return t;
}

function thrown(fn: () => unknown): unknown {
  try {
    fn();
  } catch (err) {
    return err;
  }
  return null;
}

function event(at: number, path = 'a.txt'): ActivityEvent {
  return activityEventSchema.parse({ id: `act_${at}`, at, actor: { kind: 'system' }, kind: 'external.change', file: main(path), summary: `外部程式修改了 ${path}` });
}

describe('activity.jsonl', () => {
  it('is private, pages newest first with an exact `before`, and keeps paging across a rotation', async () => {
    const dir = await createTempDir('activity');
    dirs.push(dir);
    const path = join(dir, 'activity.jsonl');
    const file = new ActivityLogFile(path, { log: silentLogger, maxBytes: 4_096 });
    expect(await file.open()).toBe(0);
    for (let at = 1; at <= 60; at++) file.append(event(at, `f${at}.txt`));
    await file.flush();
    expect(((await lstat(path)).mode & 0o777).toString(8)).toBe('600');
    expect((await lstat(join(dir, 'activity.1.jsonl'))).isFile()).toBe(true); // rotated at 4 KiB

    const first = await file.query({ limit: 10 });
    expect(first.map((e) => e.at)).toEqual([60, 59, 58, 57, 56, 55, 54, 53, 52, 51]);
    const next = await file.query({ limit: 10, before: 51 });
    expect(next[0]?.at).toBe(50);
    // Everything that is still kept, in order, across both files (the oldest were dropped with the older rotation).
    const all = await file.query({ limit: 500 });
    const ats = all.map((e) => e.at);
    expect(ats).toEqual([...ats].sort((a, b) => b - a));
    expect(ats[0]).toBe(60);
    expect(ats.length).toBeGreaterThan(20);
    expect(ats.length).toBeLessThan(60);
    const filtered = await file.query({ limit: 5, accept: (e) => (e.file?.path ?? '').endsWith('0.txt') });
    expect(filtered.map((e) => e.at)).toEqual(ats.filter((at) => at % 10 === 0).slice(0, 5));
    await file.close();

    // A restart continues after the newest `at` on file.
    const reopened = new ActivityLogFile(path, { log: silentLogger, maxBytes: 4_096 });
    expect(await reopened.open()).toBe(60);
    await reopened.close();
  });

  it('refuses a symlinked or group-readable log (fail closed)', async () => {
    const dir = await createTempDir('activity');
    dirs.push(dir);
    await writeFile(join(dir, 'elsewhere.jsonl'), '', { mode: 0o600 });
    await symlink(join(dir, 'elsewhere.jsonl'), join(dir, 'activity.jsonl'));
    await expect(new ActivityLogFile(join(dir, 'activity.jsonl'), { log: silentLogger }).open()).rejects.toThrow(/cannot open/);
    await mkdir(join(dir, 'open'), { mode: 0o700 });
    await writeFile(join(dir, 'open', 'activity.jsonl'), '', { mode: 0o644 });
    await expect(new ActivityLogFile(join(dir, 'open', 'activity.jsonl'), { log: silentLogger }).open()).rejects.toThrow(/group\/other/);
  });

  it('`at` is strictly increasing, also across a restart with a clock that went back', async () => {
    const dir = await createTempDir('activity');
    dirs.push(dir);
    const path = join(dir, 'activity.jsonl');
    const clock = new ManualClock(5_000);
    const feed = (): ActivityFeedImpl =>
      new ActivityFeedImpl({
        clock,
        log: silentLogger,
        audit: new RecordingAudit(),
        hub: { broadcast: () => 0, sendToUser: () => 0 },
        members: { get: () => null, active: () => null },
        locks: () => ({ get: () => null }),
        file: new ActivityLogFile(path, { log: silentLogger }),
      });
    const first = feed();
    await first.start();
    const ats = [0, 1, 2].map(() => first.record({ actor: { kind: 'system' }, kind: 'external.change', file: main('x'), summary: 'x' }).at);
    expect(ats).toEqual([5_000, 5_001, 5_002]);
    await first.stop();
    clock.set(1_000);
    const second = feed();
    await second.start();
    expect(second.record({ actor: { kind: 'system' }, kind: 'external.change', summary: 'y' }).at).toBe(5_003);
    await second.stop();
    const lines = (await readFile(path, 'utf8')).trim().split('\n');
    expect(lines).toHaveLength(4);
  });
});

describe('bus → activity + audit', () => {
  it('human.edit: one entry per person and file per window on autosave, audited doc.edit', async () => {
    const d = await daemon();
    const host = await d.connectHost();
    await d.connect({ userId: 'dev:amy', displayName: 'Amy', role: 'editor' });
    const live = recorder(host.conn, 'activity.event');
    const file = main('README.md');
    for (let i = 0; i < 3; i++) {
      d.ctx.bus.emit('doc.human-edit', { file, docId: 'doc_1', userId: 'dev:amy', channelId: 'ch_x' });
      d.ctx.bus.emit('doc.saved', { file, docId: 'doc_1', hash: 'h'.repeat(64), at: Date.now() });
    }
    d.ctx.bus.emit('doc.saved', { file, docId: 'doc_1', hash: 'h'.repeat(64), at: Date.now() }); // a save nobody edited for
    d.ctx.bus.emit('doc.human-edit', { file, docId: 'doc_1', userId: 'dev:host', channelId: 'ch_y' });
    d.ctx.bus.emit('doc.saved', { file, docId: 'doc_1', hash: 'h'.repeat(64), at: Date.now() });
    // The autosave's own disk write, seen by the watcher without attribution, is not an external change.
    watcherSaw(d, file);
    await waitFor(() => live.length >= 2, { what: 'two human.edit entries' });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(live.map((l) => [l.event.kind, l.event.actor.kind === 'user' ? l.event.actor.displayName : '?'])).toEqual([
      ['human.edit', 'Amy'],
      ['human.edit', 'Host'],
    ]);
    expect(live[0]?.event.summary).toBe('Amy 編輯了 README.md');
    const audit = await host.conn.request('admin.audit.query', { limit: 50 });
    expect(audit.entries.filter((e) => e.action === 'doc.edit').map((e) => e.actor)).toEqual([
      expect.objectContaining({ userId: 'dev:host' }),
      expect.objectContaining({ userId: 'dev:amy' }),
    ]);
    expect(audit.entries.some((e) => e.action === 'external.change')).toBe(false);
  });

  it('changes someone already accounted for are not doubled; an external burst becomes one entry', async () => {
    const d = await daemon();
    const host = await d.connectHost();
    const live = recorder(host.conn, 'activity.event');
    const amyActor = { kind: 'user', userId: 'dev:amy', displayName: 'Amy' } as const;
    watcherSaw(d, main('uploaded.bin'), 'add', amyActor); // an upload commit: UploadService records it itself
    watcherSaw(d, main('.x.smurg-0123456789ab.tmp'), 'add'); // a temp file
    watcherSaw(d, main('log.txt'));
    watcherSaw(d, main('log.txt')); // the same file again within the window
    const burst = Array.from({ length: EXTERNAL_BURST_MAX + 5 }, (_, i) => ({ path: `gen/f${i}.ts`, change: 'add' as const }));
    d.ctx.bus.emit('file.changed', { root: MAIN_ROOT, changes: burst });
    const byAgent = { kind: 'agent', sessionId: 'ses_ian', ownerUserId: 'dev:ian', displayName: 'Claude（Ian）' } as const;
    watcherSaw(d, main('agent.ts'), 'change', byAgent);
    watcherSaw(d, main('agent.ts'), 'change', byAgent);
    await waitFor(() => live.length >= 3, { what: 'three entries' });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(live.map((l) => [l.event.kind, l.event.file?.path ?? null])).toEqual([
      ['external.change', 'log.txt'],
      ['external.change', null],
      ['agent.edit', 'agent.ts'],
    ]);
    expect(live[1]?.event.summary).toContain(`外部程式變更了 ${EXTERNAL_BURST_MAX + 5} 個檔案`);
    const audit = await host.conn.request('admin.audit.query', { limit: 50 });
    expect(audit.entries.filter((e) => e.action === 'external.change').map((e) => e.detail?.['count'] ?? 1)).toEqual([EXTERNAL_BURST_MAX + 5, 1]);
  });

  it('lock denials are bounded per session in the feed (forged PreToolUse floods)', async () => {
    const d = await daemon();
    const host = await d.connectHost();
    await d.connect({ userId: 'dev:ian', displayName: 'Ian', role: 'runner' });
    const live = recorder(host.conn, 'activity.event');
    d.ctx.services.locks.touchHuman(main('README.md'), { userId: 'dev:host', displayName: 'Host' });
    const ian = agentSession('ses_ian', 'dev:ian', 'Ian');
    for (let i = 0; i < LOCK_DENIED_PER_SESSION_PER_MINUTE + 10; i++) expect(preToolUse(d, ian, main('README.md')).granted).toBe(false);
    await waitFor(() => live.length >= LOCK_DENIED_PER_SESSION_PER_MINUTE, { what: 'the bounded lock.denied entries' });
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(live).toHaveLength(LOCK_DENIED_PER_SESSION_PER_MINUTE);
    expect(live[0]?.event.summary).toBe('Claude（Ian）想修改 README.md，但 Host 正在編輯，已被擋下');
  });

  it('an entry about a hidden path reaches the host only, live and in activity.list', async () => {
    const d = await daemon();
    const host = await d.connectHost();
    const amy = await d.connect({ userId: 'dev:amy', displayName: 'Amy', role: 'editor' });
    const hostLive = recorder(host.conn, 'activity.event');
    const amyLive = recorder(amy.conn, 'activity.event');
    const system = { kind: 'system' } as const;
    d.ctx.services.activity.record({ actor: system, kind: 'file.create', file: main('.smurg/worktrees/wt_1'), summary: 'hidden' });
    d.ctx.services.activity.record({ actor: system, kind: 'file.create', file: main('visible.txt'), summary: 'visible' });
    await waitFor(() => hostLive.length === 2 && amyLive.length === 1, { what: 'fan-out' });
    expect(amyLive[0]?.event.summary).toBe('visible');
    expect((await amy.conn.request('activity.list', { limit: 1 })).events.map((e) => e.summary)).toEqual(['visible']);
    expect((await host.conn.request('activity.list', {})).events.map((e) => e.summary)).toEqual(['visible', 'hidden']);
  });

  it('activity.list pages with an exact `before` cursor', async () => {
    const d = await daemon();
    const amy = await d.connect({ userId: 'dev:amy', displayName: 'Amy', role: 'viewer' });
    const recorded = Array.from({ length: 7 }, (_, i) => d.ctx.services.activity.record({ actor: { kind: 'system' }, kind: 'external.change', file: main(`f${i}`), summary: `s${i}` }));
    const page1 = await amy.conn.request('activity.list', { limit: 3 });
    const page2 = await amy.conn.request('activity.list', { limit: 3, before: page1.events.at(-1)?.at });
    const page3 = await amy.conn.request('activity.list', { limit: 3, before: page2.events.at(-1)?.at });
    expect([...page1.events, ...page2.events, ...page3.events].map((e) => e.id)).toEqual(recorded.map((e) => e.id).reverse());
  });
});

describe('activity.notify (the coordination MCP tool 「通知某位組員」)', () => {
  it('reaches only the notified member’s connections; unknown members and invalid text are refused', async () => {
    const d = await daemon();
    const host = await d.connectHost();
    const amy = await d.connect({ userId: 'dev:amy', displayName: 'Amy', role: 'editor' });
    const amyNotes = recorder(amy.conn, 'activity.notify');
    const hostNotes = recorder(host.conn, 'activity.notify');
    const from = { kind: 'agent', sessionId: 'ses_ian', ownerUserId: 'dev:ian', displayName: 'Claude（Ian）' } as const;
    d.ctx.services.activity.notify('dev:amy', { from, text: '我改完 src/app.ts 了，請看一下', file: main('README.md') });
    d.ctx.services.activity.notify('dev:amy', { from, text: 'hidden', file: main('.smurg/x') });
    await waitFor(() => amyNotes.length === 2, { what: 'the notifications' });
    expect(amyNotes[0]?.notification).toMatchObject({ from, text: '我改完 src/app.ts 了，請看一下', file: main('README.md') });
    expect(amyNotes[1]?.notification.file).toBeUndefined(); // a guest never learns a hidden path
    expect(hostNotes).toHaveLength(0);
    expect(thrown(() => d.ctx.services.activity.notify('dev:nobody', { from, text: 'x' }))).toMatchObject({ code: 'not_found' });
    expect(thrown(() => d.ctx.services.activity.notify('dev:amy', { from, text: 'x'.repeat(2_001) }))).toMatchObject({ code: 'bad_request' });
  });
});

describe('who changed a file nobody announced (review SPEC-01: Bash edits, FileChanged)', () => {
  const WT = { kind: 'worktree', worktreeId: 'wt_bob1' } as const;

  function sessionInfo(id: string, kind: 'agent' | 'terminal', root: SessionInfo['root']): SessionInfo {
    return { id, kind, ownerUserId: 'dev:bob', ownerName: 'Bob', title: id, sandboxed: true, root, status: 'running', cols: 80, rows: 24, createdAt: 1, login: 'unknown', attached: 0 };
  }

  async function feed(sessions: SessionInfo[]): Promise<{ readonly bus: TypedEventBus; readonly events: ActivityEvent[]; readonly audit: RecordingAudit }> {
    const dir = await createTempDir('activity');
    dirs.push(dir);
    const events: ActivityEvent[] = [];
    const audit = new RecordingAudit();
    const impl = new ActivityFeedImpl({
      clock: new ManualClock(10_000),
      log: silentLogger,
      audit,
      hub: {
        broadcast: ((_type: string, payload: { event: ActivityEvent }) => {
          events.push(payload.event);
          return 1;
        }) as never,
        sendToUser: () => 0,
      },
      members: { get: (userId) => (userId === 'dev:bob' ? ({ userId, displayName: 'Bob' } as never) : null), active: () => null },
      locks: () => ({ get: () => null }),
      sessions: () => ({ list: () => sessions }),
      file: new ActivityLogFile(join(dir, 'activity.jsonl'), { log: silentLogger }),
    });
    await impl.start();
    const bus = new TypedEventBus(silentLogger);
    impl.attach(bus);
    return { bus, events, audit };
  }

  it('in a worktree with one agent session running, a change nobody announced (its Bash `sed`) is that agent\'s edit', async () => {
    const { bus, events, audit } = await feed([sessionInfo('ses_bob_agent', 'agent', WT)]);
    bus.emit('file.changed', { root: WT, changes: [{ path: 'src/conflict.txt', change: 'change' }] });
    expect(events.map((e) => [e.kind, e.actor, e.file?.path])).toEqual([['agent.edit', { kind: 'agent', sessionId: 'ses_bob_agent', ownerUserId: 'dev:bob', displayName: 'Claude（Bob）' }, 'src/conflict.txt']]);
    expect(audit.entries.map((e) => [e.action, e.actor.kind])).toEqual([['agent.edit', 'agent']]);
  });

  it('in a worktree with a terminal (or several sessions), the change is attributed to the worktree\'s owner, not to 「外部程式」', async () => {
    const { bus, events } = await feed([sessionInfo('ses_bob_term', 'terminal', WT), sessionInfo('ses_main', 'agent', { kind: 'main' })]);
    bus.emit('file.changed', { root: WT, changes: [{ path: 'feature.txt', change: 'add' }] });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ kind: 'external.change', actor: { kind: 'user', userId: 'dev:bob', displayName: 'Bob' }, file: { root: WT, path: 'feature.txt' } });
    expect(events[0]?.summary).toBe('Bob 的 worktree 中的程式新增了 feature.txt');
    // Many files at once: one entry, still the owner's.
    const burst = Array.from({ length: EXTERNAL_BURST_MAX + 1 }, (_, i) => ({ path: `gen/f${i}.ts`, change: 'add' as const }));
    bus.emit('file.changed', { root: WT, changes: burst });
    expect(events).toHaveLength(2);
    expect(events[1]).toMatchObject({ kind: 'external.change', actor: { kind: 'user', userId: 'dev:bob' } });
  });

  it('in the main workspace, or a worktree where nothing of its owner runs, it stays 「外部程式」', async () => {
    const { bus, events } = await feed([sessionInfo('ses_bob_agent', 'agent', { kind: 'main' })]);
    bus.emit('file.changed', { root: MAIN_ROOT, changes: [{ path: 'a.txt', change: 'change' }] });
    bus.emit('file.changed', { root: WT, changes: [{ path: 'b.txt', change: 'change' }] });
    expect(events.map((e) => [e.kind, e.actor.kind])).toEqual([
      ['external.change', 'system'],
      ['external.change', 'system'],
    ]);
  });

  it('the FileChanged hook (agent.file-changed) records the agent\'s edit; the watcher\'s report of it is not doubled', async () => {
    const { bus, events } = await feed([]);
    bus.emit('agent.file-changed', { sessionId: 'ses_bob_agent', ownerUserId: 'dev:bob', file: main('README.md'), change: 'change' });
    bus.emit('file.changed', { root: MAIN_ROOT, changes: [{ path: 'README.md', change: 'change' }] });
    expect(events.map((e) => [e.kind, e.actor.kind, e.file?.path])).toEqual([['agent.edit', 'agent', 'README.md']]);
  });
});

// ARCHITECTURE §11 D-13: changes a session's shell command made (Bash windows reported by the Bash activity hook).
describe('Bash windows (D-13): a change nobody claimed, inside the Bash window of exactly one agent session', () => {
  const WT = { kind: 'worktree', worktreeId: 'wt_amy1' } as const;
  const OWNERS: Record<string, string> = { 'dev:amy': 'Amy', 'dev:bob': 'Bob', 'dev:host': 'Host' };

  function info(id: string, owner: string, root: SessionInfo['root'], extra: Partial<SessionInfo> = {}): SessionInfo {
    return { id, kind: 'agent', ownerUserId: owner, ownerName: OWNERS[owner] ?? owner, title: id, sandboxed: owner !== 'dev:host', root, status: 'running', cols: 80, rows: 24, createdAt: 1, login: 'unknown', attached: 0, ...extra };
  }

  async function feed(sessions: SessionInfo[], options: { readonly attributeBashEdits?: boolean; readonly lockOf?: (file: FileRef) => unknown } = {}) {
    const dir = await createTempDir('activity-bash');
    dirs.push(dir);
    const clock = new ManualClock(100_000);
    const events: ActivityEvent[] = [];
    const audit = new RecordingAudit();
    const impl = new ActivityFeedImpl({
      clock,
      log: silentLogger,
      audit,
      hub: {
        broadcast: ((_type: string, payload: { event: ActivityEvent }) => {
          events.push(payload.event);
          return 1;
        }) as never,
        sendToUser: () => 0,
      },
      members: { get: (userId) => (OWNERS[userId] ? ({ userId, displayName: OWNERS[userId] } as never) : null), active: () => null },
      locks: () => ({ get: (file: FileRef) => (options.lockOf?.(file) ?? null) as never }),
      sessions: () => ({ list: () => sessions }),
      file: new ActivityLogFile(join(dir, 'activity.jsonl'), { log: silentLogger }),
      ...(options.attributeBashEdits === undefined ? {} : { attributeBashEdits: options.attributeBashEdits }),
    });
    await impl.start();
    const bus = new TypedEventBus(silentLogger);
    impl.attach(bus);
    const announced: { sessionId: string; file: string | null; tool: string }[] = [];
    bus.on('agent.tool.post', (e) => announced.push({ sessionId: e.sessionId, file: e.file?.path ?? null, tool: e.tool }));
    const bashStart = (sessionId: string, owner: string): void => bus.emit('agent.tool.pre', { sessionId, ownerUserId: owner, tool: 'Bash', file: null, outcome: 'granted' });
    const bashEnd = (sessionId: string, owner: string): void => bus.emit('agent.tool.post', { sessionId, ownerUserId: owner, tool: 'Bash', file: null, ok: true });
    const changed = (root: SessionInfo['root'], ...paths: string[]): void => bus.emit('file.changed', { root, changes: paths.map((path) => ({ path, change: 'change' as const })) });
    return { bus, clock, events, audit, announced, bashStart, bashEnd, changed };
  }

  const kinds = (events: ActivityEvent[]): [string, string, string | undefined][] => events.map((e) => [e.kind, e.actor.kind === 'agent' || e.actor.kind === 'user' ? e.actor.displayName : 'system', e.file?.path]);

  it('one agent\'s Bash edit is attributed to it: agent.edit 「…透過 shell 指令修改了…」, audited via bash, announced for the badge and the conflict source', async () => {
    const f = await feed([info('ses_amy', 'dev:amy', MAIN_ROOT)]);
    f.bashStart('ses_amy', 'dev:amy');
    f.changed(MAIN_ROOT, 'src/app.ts');
    expect(kinds(f.events)).toEqual([['agent.edit', 'Claude（Amy）', 'src/app.ts']]);
    expect(f.events[0]?.summary).toBe('Claude（Amy）透過 shell 指令修改了 src/app.ts');
    // The structured mark clients use (never the summary's wording).
    expect(f.events[0]?.via).toBe('bash');
    expect(f.audit.entries.map((e) => [e.action, e.actor.kind, e.detail?.['via']])).toEqual([['agent.edit', 'agent', 'bash']]);
    expect(f.announced).toContainEqual({ sessionId: 'ses_amy', file: 'src/app.ts', tool: 'Bash' });
    // The watcher's second report of the same write is not a second entry.
    f.changed(MAIN_ROOT, 'src/app.ts');
    expect(f.events).toHaveLength(1);
  });

  it('two overlapping windows: 「外部程式」 (never guess); a change outside every window: 「外部程式」', async () => {
    const f = await feed([info('ses_amy', 'dev:amy', MAIN_ROOT), info('ses_bob', 'dev:bob', MAIN_ROOT)]);
    f.changed(MAIN_ROOT, 'before.txt');
    f.bashStart('ses_amy', 'dev:amy');
    f.bashStart('ses_bob', 'dev:bob');
    f.changed(MAIN_ROOT, 'both.txt');
    expect(kinds(f.events)).toEqual([
      ['external.change', 'system', 'before.txt'],
      ['external.change', 'system', 'both.txt'],
    ]);
  });

  it('the grace period: a change up to 3 s after the command ended is still its own (watcher latency); later it is 「外部程式」', async () => {
    const f = await feed([info('ses_amy', 'dev:amy', MAIN_ROOT)]);
    f.bashStart('ses_amy', 'dev:amy');
    f.bashEnd('ses_amy', 'dev:amy');
    f.clock.advance(2_900);
    f.changed(MAIN_ROOT, 'late-but-in-grace.txt');
    f.clock.advance(200);
    f.changed(MAIN_ROOT, 'after-grace.txt');
    expect(kinds(f.events)).toEqual([
      ['agent.edit', 'Claude（Amy）', 'late-but-in-grace.txt'],
      ['external.change', 'system', 'after-grace.txt'],
    ]);
    expect(f.events.map((e) => e.via)).toEqual(['bash', undefined]);
  });

  it('a change in another root is not attributed: a guest\'s main-workspace window never claims a worktree change (and its other owner\'s window there)', async () => {
    const f = await feed([info('ses_amy', 'dev:amy', MAIN_ROOT)]);
    f.bashStart('ses_amy', 'dev:amy');
    f.changed(WT, 'wt-file.txt');
    expect(kinds(f.events)).toEqual([['external.change', 'system', 'wt-file.txt']]);
  });

  it('the host\'s unsandboxed session could write anywhere: its open window makes a guest\'s change ambiguous, and it never claims another root', async () => {
    const f = await feed([info('ses_amy', 'dev:amy', MAIN_ROOT), info('ses_host', 'dev:host', MAIN_ROOT), info('ses_bob_wt', 'dev:bob', { kind: 'worktree', worktreeId: 'wt_bob' })]);
    f.bashStart('ses_host', 'dev:host');
    f.changed({ kind: 'worktree', worktreeId: 'wt_bob' }, 'x.txt'); // the host's session is main-rooted: not its change to claim
    f.bashStart('ses_amy', 'dev:amy');
    f.changed(MAIN_ROOT, 'y.txt'); // amy or the host: ambiguous
    f.bashEnd('ses_amy', 'dev:amy');
    f.bashStart('ses_bob_wt', 'dev:bob');
    f.changed({ kind: 'worktree', worktreeId: 'wt_bob' }, 'z.txt'); // bob (sandboxed to wt_bob) or the host: ambiguous
    // Not even the SPEC-01 worktree rule may name bob's agent while the host's shell command could have written it.
    expect(kinds(f.events)).toEqual([
      ['external.change', 'system', 'x.txt'],
      ['external.change', 'system', 'y.txt'],
      ['external.change', 'system', 'z.txt'],
    ]);
    // Once the host's command is over (and its grace), bob's own window names bob's agent.
    f.bashEnd('ses_host', 'dev:host');
    f.clock.advance(3_100);
    f.changed({ kind: 'worktree', worktreeId: 'wt_bob' }, 'later.txt');
    expect(kinds(f.events).at(-1)).toEqual(['agent.edit', 'Claude（Bob）', 'later.txt']);
  });

  it('forged Bash windows only ever attribute changes in the session\'s own root, and only to that session', async () => {
    const f = await feed([info('ses_mallory', 'dev:bob', MAIN_ROOT), info('ses_amy_wt', 'dev:amy', WT)]);
    // A prompt-injected agent opens windows as fast as it may: it can claim unannounced changes of its own root…
    for (let i = 0; i < 5; i++) f.bashStart('ses_mallory', 'dev:bob');
    f.changed(MAIN_ROOT, 'm.txt');
    // …but never one of another root, never for someone else: amy's worktree change stays amy's (her only session there).
    f.changed(WT, 'amy.txt');
    expect(kinds(f.events)).toEqual([
      ['agent.edit', 'Claude（Bob）', 'm.txt'],
      ['agent.edit', 'Claude（Amy）', 'amy.txt'],
    ]);
    // Only the shell-window attribution is marked via 'bash'; amy's is the worktree rule's (no mark).
    expect(f.events.map((e) => e.via)).toEqual(['bash', undefined]);
    expect(f.announced.filter((a) => a.file !== null).map((a) => a.sessionId)).toEqual(['ses_mallory']);
  });

  it('a change another source claimed keeps its author: an agent lock held by another session, a person\'s save', async () => {
    const lockOf = (file: FileRef) => (file.path === 'locked.ts' ? { kind: 'agent', file, sessionId: 'ses_bob', ownerUserId: 'dev:bob', agentName: 'Claude（Bob）', acquiredAt: 1, expiresAt: 2 } : null);
    const f = await feed([info('ses_amy', 'dev:amy', MAIN_ROOT), info('ses_bob', 'dev:bob', MAIN_ROOT)], { lockOf });
    f.bashStart('ses_amy', 'dev:amy');
    f.changed(MAIN_ROOT, 'locked.ts');
    f.bus.emit('file.changed', { root: MAIN_ROOT, changes: [{ path: 'saved.ts', change: 'change', by: { kind: 'user', userId: 'dev:bob', displayName: 'Bob' } }] });
    expect(kinds(f.events)).toEqual([['agent.edit', 'Claude（Bob）', 'locked.ts']]);
  });

  it('many files at once (a git checkout): one agent.edit entry; a deleted file is recorded but not announced as written', async () => {
    const f = await feed([info('ses_amy', 'dev:amy', MAIN_ROOT)]);
    f.bashStart('ses_amy', 'dev:amy');
    f.changed(MAIN_ROOT, ...Array.from({ length: EXTERNAL_BURST_MAX + 5 }, (_, i) => `gen/f${i}.ts`));
    expect(f.events).toHaveLength(1);
    expect(f.events[0]).toMatchObject({ kind: 'agent.edit', actor: { kind: 'agent', sessionId: 'ses_amy' } });
    expect(f.events[0]?.summary).toMatch(/^Claude（Amy）透過 shell 指令變更了 25 個檔案（例如 gen\/f0\.ts/);
    expect(f.events[0]?.via).toBe('bash');
    expect(f.audit.entries.at(-1)).toMatchObject({ action: 'agent.edit', detail: { via: 'bash', count: 25 } });
    f.bus.emit('file.changed', { root: MAIN_ROOT, changes: [{ path: 'gone.txt', change: 'unlink' }] });
    expect(f.events.at(-1)?.summary).toBe('Claude（Amy）透過 shell 指令刪除了 gone.txt');
    expect(f.announced.some((a) => a.file === 'gone.txt')).toBe(false);
  });

  it('a window without its end counts for at most 10 minutes (+ grace)', async () => {
    const f = await feed([info('ses_amy', 'dev:amy', MAIN_ROOT)]);
    f.bashStart('ses_amy', 'dev:amy');
    f.clock.advance(10 * 60_000 + 1_000);
    f.changed(MAIN_ROOT, 'long.txt');
    f.clock.advance(3_000);
    f.changed(MAIN_ROOT, 'stale.txt');
    expect(kinds(f.events)).toEqual([
      ['agent.edit', 'Claude（Amy）', 'long.txt'],
      ['external.change', 'system', 'stale.txt'],
    ]);
  });

  it('config.activity.attributeBashEdits false: Bash windows are ignored', async () => {
    const f = await feed([info('ses_amy', 'dev:amy', MAIN_ROOT)], { attributeBashEdits: false });
    f.bashStart('ses_amy', 'dev:amy');
    f.changed(MAIN_ROOT, 'a.txt');
    expect(kinds(f.events)).toEqual([['external.change', 'system', 'a.txt']]);
  });
});
