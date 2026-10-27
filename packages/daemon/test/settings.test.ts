// Host settings (admin.settings.*): every member works with the PublicSettings (lock timeouts, upload chunk size,
// shared dirs), so a change reaches connected clients at once as channel.settingsUpdated (contract review C16), and
// the host-only fields never do.
import { afterEach, describe, expect, it } from 'vitest';
import { readFile, writeFile } from 'node:fs/promises';
import { totalmem } from 'node:os';
import { join } from 'node:path';
import { ESCALATE_AFTER_MS_DEFAULT, ESCALATE_AFTER_MS_RANGE, MAX_LIVE_AGENTS_RANGE, type HostNotice, type PermissionMode, type PublicSettings } from '@smurg/protocol';
import { SettingsServiceImpl } from '../src/admin/settings.ts';
import { TypedEventBus } from '../src/core/bus.ts';
import { defaultHostSettings, defaultMaxLiveAgents } from '../src/core/config.ts';
import type { AuditInput, AuditLog, PersistentDocument, Principal } from '../src/core/interfaces.ts';
import { silentLogger } from '../src/core/logger.ts';
import { SYSTEM_PRINCIPAL } from '../src/core/permissions.ts';
import { STAMP_FILE, keptCopyPath, serializeDocument } from '../src/core/state-store.ts';
import { initialWorkspaceState, workspaceStateSchema, type WorkspaceState } from '../src/core/workspace-state.ts';
import { createTempDir, createTempProject, createTempRunDir, createTestDaemon, removeTempDir, removeTempRunDir, waitFor, type TestDaemon } from '../src/testing/index.ts';

let t: TestDaemon | null = null;

afterEach(async () => {
  await t?.cleanup();
  t = null;
});

describe('admin.settings.set', () => {
  it('pushes the new PublicSettings to every connected member, without the host-only fields', async () => {
    t = await createTestDaemon();
    const host = await t.connectHost();
    const eddie = await t.connect({ userId: 'dev:eddie', role: 'editor' });
    const vera = await t.connect({ userId: 'dev:vera', role: 'viewer' });
    const seen = new Map<string, PublicSettings[]>();
    for (const client of [host, eddie, vera]) {
      seen.set(client.userId, []);
      client.conn.on('channel.settingsUpdated', (payload) => seen.get(client.userId)?.push(payload.settings));
    }
    await host.conn.request('admin.settings.set', { humanLockIdleMs: 45_000, diskReservePercent: 7 });
    await waitFor(() => [...seen.values()].every((list) => list.length === 1), { what: 'channel.settingsUpdated everywhere' });
    for (const list of seen.values()) {
      expect(list[0]?.humanLockIdleMs).toBe(45_000);
      // ARCHITECTURE §11 D-15: no guest switches any more. Protocol 5: every member knows the workspace's mode.
      // Protocol 6: and how work items merge.
      expect(Object.keys(list[0] ?? {}).sort()).toEqual(['agentLockTimeoutMs', 'humanLockIdleMs', 'merging', 'permissionMode', 'sharedDirs', 'uploadChunkSize']);
    }
    // An editor cannot change them (router capability check), and nothing is broadcast then.
    await expect(eddie.conn.request('admin.settings.set', { humanLockIdleMs: 1_000 })).rejects.toMatchObject({ code: 'forbidden' });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(seen.get('dev:eddie')).toHaveLength(1);
  });
});

describe('no guest switches (ARCHITECTURE §11 D-15)', () => {
  it('the console cannot set the removed guest switches or the sandbox network allow-list', async () => {
    t = await createTestDaemon();
    const host = await t.connectHost();
    for (const removed of [{ guestSubscriptionLogin: true }, { guestMainWorkspace: true }, { allowedDomains: ['pypi.org'] }]) {
      await expect(host.conn.request('admin.settings.set', removed as never)).rejects.toMatchObject({ code: 'bad_request' });
    }
    const { settings } = await host.conn.request('admin.settings.get', {});
    expect(Object.keys(settings).sort()).toEqual(['agentLockTimeoutMs', 'agentMcp', 'diskReserveBytes', 'diskReservePercent', 'escalateAfterMs', 'humanLockIdleMs', 'maxLiveAgents', 'merging', 'permissionMode', 'sharedDirs', 'uploadChunkSize']);
  });
});

describe('the agent settings of protocol 4 (host-only)', () => {
  it('defaults: live agents from the host\'s memory (2 to 8), escalation after five minutes, MCP servers of the host off', async () => {
    t = await createTestDaemon();
    const host = await t.connectHost();
    const { settings } = await host.conn.request('admin.settings.get', {});
    expect(settings.maxLiveAgents).toBe(defaultMaxLiveAgents(totalmem()));
    expect(settings.maxLiveAgents).toBeGreaterThanOrEqual(MAX_LIVE_AGENTS_RANGE.min);
    expect(settings.maxLiveAgents).toBeLessThanOrEqual(MAX_LIVE_AGENTS_RANGE.max);
    expect(settings.escalateAfterMs).toBe(ESCALATE_AFTER_MS_DEFAULT);
    expect(settings.agentMcp).toBe(false);
    // One live agent per 3 GiB of memory, never fewer than 2; the DEFAULT stops at 8 (the host may raise it to 32).
    expect([1, 8, 16, 24, 64, 512].map((gib) => defaultMaxLiveAgents(gib * 1024 ** 3))).toEqual([2, 2, 5, 8, 8, 8]);
    expect(defaultMaxLiveAgents(Number.NaN)).toBe(2);
  });

  it('the host changes them within their ranges; nobody else does, and no member is sent them', async () => {
    t = await createTestDaemon();
    const host = await t.connectHost();
    const rita = await t.connect({ userId: 'dev:rita', role: 'agent' });
    const pushed: PublicSettings[] = [];
    rita.conn.on('channel.settingsUpdated', (payload) => pushed.push(payload.settings));
    const { settings } = await host.conn.request('admin.settings.set', { maxLiveAgents: 4, escalateAfterMs: 120_000, agentMcp: true });
    expect(settings).toMatchObject({ maxLiveAgents: 4, escalateAfterMs: 120_000, agentMcp: true });
    expect(t.ctx.settings.get()).toMatchObject({ maxLiveAgents: 4, escalateAfterMs: 120_000, agentMcp: true });
    for (const bad of [
      { maxLiveAgents: MAX_LIVE_AGENTS_RANGE.min - 1 },
      { maxLiveAgents: MAX_LIVE_AGENTS_RANGE.max + 1 },
      { maxLiveAgents: 2.5 },
      { escalateAfterMs: ESCALATE_AFTER_MS_RANGE.min - 1 },
      { escalateAfterMs: ESCALATE_AFTER_MS_RANGE.max + 1 },
      { agentMcp: 'yes' },
    ]) {
      await expect(host.conn.request('admin.settings.set', bad as never)).rejects.toMatchObject({ code: 'bad_request' });
    }
    await expect(rita.conn.request('admin.settings.set', { maxLiveAgents: 8 })).rejects.toMatchObject({ code: 'forbidden' });
    await expect(rita.conn.request('admin.settings.get', {})).rejects.toMatchObject({ code: 'forbidden' });
    expect(t.ctx.settings.get().maxLiveAgents).toBe(4);
    // The change is audited; what members get (PublicSettings) carries none of the three.
    await waitFor(() => pushed.length >= 1, { what: 'channel.settingsUpdated' });
    for (const settingsSeen of pushed) expect(Object.keys(settingsSeen).sort()).toEqual(['agentLockTimeoutMs', 'humanLockIdleMs', 'merging', 'permissionMode', 'sharedDirs', 'uploadChunkSize']);
    await t.ctx.audit.flush();
    const changes = (await t.ctx.audit.query({ limit: 50 })).filter((entry) => entry.action === 'settings.change');
    expect(changes.length).toBeGreaterThanOrEqual(1);
  });
});

// ── protocol 5 (smurg 0.6.0): the workspace's permission mode, and the update's notice (DESIGN 0.6.0 D3, D8, D13) ──────

const HOST: Principal = { kind: 'user', actor: { kind: 'user', userId: 'dev:host', displayName: 'Host' }, userId: 'dev:host', role: 'host' };
const EDDIE: Principal = { kind: 'user', actor: { kind: 'user', userId: 'dev:eddie', displayName: 'Eddie' }, userId: 'dev:eddie', role: 'editor' };

/** The settings service on a state.json held in memory, as the daemon composes it (the root check's uid injected). */
function settingsOn(options: { readonly notices?: readonly HostNotice[]; readonly uid?: number }) {
  let value: WorkspaceState = { ...initialWorkspaceState('ws_test_0123456789abcdef', defaultHostSettings(16 * 1024 ** 3)), hostNotices: [...(options.notices ?? [])] };
  const state: PersistentDocument<WorkspaceState> = {
    name: 'state',
    get: () => value,
    update: (mutator) => {
      const draft = structuredClone(value);
      value = workspaceStateSchema.parse(mutator(draft) ?? draft);
      return value;
    },
    flush: async () => {},
  };
  const audited: AuditInput[] = [];
  const audit = { record: (input: AuditInput) => void audited.push(input) } as unknown as AuditLog;
  const bus = new TypedEventBus(silentLogger);
  const attention: string[] = [];
  bus.on('attention.changed', (event) => attention.push(event.source));
  const service = new SettingsServiceImpl({ state, audit, bus, mainRealPath: '/nowhere', hostUserId: () => 'dev:host', uid: () => options.uid ?? 501, now: () => 1_000 });
  return { service, state, audited, attention };
}

describe('the workspace\'s permission mode (protocol 5, DESIGN 0.6.0 D3)', () => {
  it('is `auto` in a new workspace; every member learns it (Welcome, channel.settingsUpdated); only the host changes it', async () => {
    t = await createTestDaemon();
    const host = await t.connectHost();
    const eddie = await t.connect({ userId: 'dev:eddie', role: 'editor' });
    expect(eddie.welcome?.settings.permissionMode).toBe('auto');
    expect((await host.conn.request('admin.settings.get', {})).settings.permissionMode).toBe('auto');
    const pushed: PublicSettings[] = [];
    eddie.conn.on('channel.settingsUpdated', (payload) => pushed.push(payload.settings));
    const modes: PermissionMode[] = process.getuid?.() === 0 ? ['ask-commands', 'ask-all', 'auto'] : ['ask-commands', 'ask-all', 'ask-nothing', 'auto'];
    for (const permissionMode of modes) {
      expect((await host.conn.request('admin.settings.set', { permissionMode })).settings.permissionMode).toBe(permissionMode);
      await waitFor(() => pushed.at(-1)?.permissionMode === permissionMode, { what: `channel.settingsUpdated with ${permissionMode}` });
    }
    await expect(eddie.conn.request('admin.settings.set', { permissionMode: 'ask-all' })).rejects.toMatchObject({ code: 'forbidden' });
    await expect(host.conn.request('admin.settings.set', { permissionMode: 'yolo' } as never)).rejects.toMatchObject({ code: 'bad_request' });
    expect(t.ctx.settings.get().permissionMode).toBe('auto');
  });

  it('`ask-nothing` is refused while the daemon runs as root (Claude Code does not run so there); nothing changes', async () => {
    const root = settingsOn({ uid: 0 });
    await expect(root.service.update({ permissionMode: 'ask-nothing' }, HOST)).rejects.toMatchObject({ code: 'forbidden', detail: { reason: 'root' }, text: { id: 'settings.asksNothing.root' } });
    expect(root.state.get().settings.permissionMode).toBe('auto');
    expect(root.audited).toEqual([]);
    await root.service.update({ permissionMode: 'ask-all' }, HOST);
    expect(root.state.get().settings.permissionMode).toBe('ask-all');
    const user = settingsOn({ uid: 501 });
    await user.service.update({ permissionMode: 'ask-nothing' }, HOST);
    expect(user.state.get().settings.permissionMode).toBe('ask-nothing');
  });
});

describe('the update\'s notice `agents-auto` (DESIGN 0.6.0 D13)', () => {
  it('is an attention fact for the host alone while it is there, opening the console\'s settings', () => {
    const { service } = settingsOn({ notices: ['agents-auto'] });
    expect(service.notices()).toEqual(['agents-auto']);
    expect(service.attention()).toEqual([{ subject: 'agents-auto', id: 'workspace', at: 1_000, recipients: ['dev:host'], target: { kind: 'console', section: 'settings' }, excerpt: '' }]);
    expect(settingsOn({}).service.attention()).toEqual([]);
  });

  it('goes when the host has seen it (admin.notice.seen), and only the host can say so', async () => {
    const { service, state, attention } = settingsOn({ notices: ['agents-auto'] });
    await expect(service.seeNotice('agents-auto', EDDIE)).rejects.toMatchObject({ code: 'forbidden' });
    expect(state.get().hostNotices).toEqual(['agents-auto']);
    await service.seeNotice('agents-auto', HOST);
    expect(state.get().hostNotices).toEqual([]);
    expect(service.attention()).toEqual([]);
    expect(attention).toEqual(['settings']);
    await service.seeNotice('agents-auto', HOST); // seen twice: nothing more happens
    expect(attention).toEqual(['settings']);
  });

  it('goes when the host decides the workspace\'s mode, even to the mode it already has; another setting leaves it', async () => {
    const { service, state, attention } = settingsOn({ notices: ['agents-auto'] });
    await service.update({ humanLockIdleMs: 45_000 }, HOST);
    expect(state.get().hostNotices).toEqual(['agents-auto']);
    await service.update({ permissionMode: 'auto' }, SYSTEM_PRINCIPAL);
    expect(state.get().hostNotices).toEqual([]);
    expect(attention).toEqual(['settings']);
  });

  it('a workspace that 0.5.x left: the start upgrades it to `auto`, the host\'s inbox holds the notice, and it goes when he has seen it', async () => {
    const WS = 'ws_test_settings_notice_01';
    const stateDir = await createTempRunDir();
    const base = await createTempDir('notice');
    try {
      const root = await createTempProject(base, 'project', { files: { 'README.md': 'hello\n' } });
      const dir = join(stateDir, 'workspaces', WS);
      t = await createTestDaemon({ stateDir, root, workspaceId: WS });
      (await t.connect({ userId: 'dev:eddie', role: 'editor' })).close();
      await t.cleanup();
      t = null;
      // What 0.5.2 left: state.json version 1 with nine settings, and its stamp (shapes 1).
      const today = JSON.parse(await readFile(join(dir, 'state.json'), 'utf8')) as WorkspaceState;
      const { hostNotices: _notices, ...rest } = today;
      const { permissionMode: _mode, merging: _merging, ...nine } = today.settings;
      await writeFile(join(dir, 'state.json'), serializeDocument({ ...rest, version: 1, settings: nine }), { mode: 0o600 });
      await writeFile(join(dir, STAMP_FILE), serializeDocument({ smurg: '0.5.2', shapes: 1, at: 1 }), { mode: 0o600 });

      t = await createTestDaemon({ stateDir, root, workspaceId: WS });
      expect(t.daemon.upgraded).toEqual([{ document: 'state', from: '0.5.0', copy: keptCopyPath(dir, 'state', '0.5.0'), writer: '0.5.2' }]);
      expect(t.ctx.settings.get().permissionMode).toBe('auto');
      // Since 0.7.0 the step from 0.6.0 runs after it: automatic merging, with its own notice (DESIGN 0.7.0 D4).
      expect(t.ctx.settings.get().merging).toBe('auto');
      expect(t.ctx.settings.notices()).toEqual(['agents-auto', 'auto-merge']);
      const host = await t.connectHost();
      const eddie = await t.connect({ userId: 'dev:eddie', role: 'editor' });
      const KEY = 'attention:agents-auto:workspace';
      await waitFor(async () => (await host.conn.request('inbox.list', {})).items.some((item) => item.key === KEY), { what: 'the notice in the host\'s inbox' });
      expect((await host.conn.request('inbox.list', {})).items.find((item) => item.key === KEY)).toMatchObject({ kind: 'attention', subject: 'agents-auto', waiting: false, target: { kind: 'console', section: 'settings' } });
      expect((await eddie.conn.request('inbox.list', {})).items.some((item) => item.key === KEY)).toBe(false);
      await expect(eddie.conn.request('admin.notice.seen', { notice: 'agents-auto' })).rejects.toMatchObject({ code: 'forbidden' });
      await host.conn.request('admin.notice.seen', { notice: 'agents-auto' });
      await waitFor(async () => !(await host.conn.request('inbox.list', {})).items.some((item) => item.key === KEY), { what: 'the notice gone' });
      await t.cleanup();
      t = null;
      // 0.7.0's notice is another one: seeing `agents-auto` leaves it (it is the host's inbox item from 0.7.0 S6 on).
      expect((JSON.parse(await readFile(join(dir, 'state.json'), 'utf8')) as WorkspaceState).hostNotices).toEqual(['auto-merge']);
    } finally {
      await t?.cleanup();
      t = null;
      await removeTempRunDir(stateDir);
      await removeTempDir(base);
    }
  }, 60_000);
});

// ── protocol 6 (smurg 0.7.0): the update's notice `auto-merge` and the record of the step (DESIGN 0.7.0 D4, D18) ────────

describe('the update\'s notice `auto-merge` (DESIGN 0.7.0 D18)', () => {
  it('is an attention fact for the host alone while it is there, beside `agents-auto`, opening the console\'s settings', () => {
    const { service } = settingsOn({ notices: ['agents-auto', 'auto-merge'] });
    expect(service.attention()).toEqual([
      { subject: 'agents-auto', id: 'workspace', at: 1_000, recipients: ['dev:host'], target: { kind: 'console', section: 'settings' }, excerpt: '' },
      { subject: 'auto-merge', id: 'workspace', at: 1_000, recipients: ['dev:host'], target: { kind: 'console', section: 'settings' }, excerpt: '' },
    ]);
  });

  it('goes when the host has seen it, or names how work items merge (even as they do now); deciding the mode settles only the other notice', async () => {
    const seen = settingsOn({ notices: ['auto-merge'] });
    await expect(seen.service.seeNotice('auto-merge', EDDIE)).rejects.toMatchObject({ code: 'forbidden' });
    await seen.service.seeNotice('auto-merge', HOST);
    expect(seen.state.get().hostNotices).toEqual([]);
    expect(seen.service.attention()).toEqual([]);

    const set = settingsOn({ notices: ['agents-auto', 'auto-merge'] });
    await set.service.update({ permissionMode: 'auto' }, HOST);
    expect(set.state.get().hostNotices).toEqual(['auto-merge']);
    await set.service.update({ humanLockIdleMs: 45_000 }, HOST);
    expect(set.state.get().hostNotices).toEqual(['auto-merge']);
    await set.service.update({ merging: 'auto' }, HOST);
    expect(set.state.get().hostNotices).toEqual([]);
    expect(set.attention).toEqual(['settings', 'settings']);
    // Both at once.
    const both = settingsOn({ notices: ['agents-auto', 'auto-merge'] });
    await both.service.update({ permissionMode: 'ask-commands', merging: 'host' }, HOST);
    expect(both.state.get().hostNotices).toEqual([]);
  });

  it('a workspace that 0.6.0 left: the start turns automatic merging on, writes ONE audit entry of the system that says so (none at the next start), and the host\'s inbox holds the notice', async () => {
    const WS = 'ws_test_settings_merging_1';
    const stateDir = await createTempRunDir();
    const base = await createTempDir('merging-notice');
    try {
      const root = await createTempProject(base, 'project', { files: { 'README.md': 'hello\n' } });
      const dir = join(stateDir, 'workspaces', WS);
      t = await createTestDaemon({ stateDir, root, workspaceId: WS });
      await t.cleanup();
      t = null;
      // What 0.6.0 left: state.json version 2, ten settings (no `merging`), its notice seen, its stamp (shapes 2).
      const today = JSON.parse(await readFile(join(dir, 'state.json'), 'utf8')) as WorkspaceState;
      const { merging: _merging, ...ten } = today.settings;
      await writeFile(join(dir, 'state.json'), serializeDocument({ ...today, version: 2, settings: ten, hostNotices: [] }), { mode: 0o600 });
      await writeFile(join(dir, STAMP_FILE), serializeDocument({ smurg: '0.6.0', shapes: 2, at: 1 }), { mode: 0o600 });

      t = await createTestDaemon({ stateDir, root, workspaceId: WS });
      expect(t.daemon.upgraded).toEqual([{ document: 'state', from: '0.6.0', copy: keptCopyPath(dir, 'state', '0.6.0'), writer: '0.6.0' }]);
      expect(t.ctx.settings.get().merging).toBe('auto');
      expect(t.ctx.settings.notices()).toEqual(['auto-merge']);
      await t.ctx.audit.flush();
      const step = (await t.ctx.audit.query({ limit: 50 })).filter((entry) => entry.action === 'settings.change');
      expect(step).toMatchObject([{ actor: { kind: 'system' }, outcome: 'ok', target: 'settings', detail: { changed: ['merging'], merging: 'auto', reason: 'update-0.7.0', from: '0.6.0' } }]);
      const host = await t.connectHost();
      const KEY = 'attention:auto-merge:workspace';
      await waitFor(async () => (await host.conn.request('inbox.list', {})).items.some((item) => item.key === KEY), { what: 'the notice in the host\'s inbox' });
      expect((await host.conn.request('inbox.list', {})).items.find((item) => item.key === KEY)).toMatchObject({ kind: 'attention', subject: 'auto-merge', waiting: false, target: { kind: 'console', section: 'settings' } });
      await t.cleanup();
      t = null;

      // The next start ran no step: no second entry.
      t = await createTestDaemon({ stateDir, root, workspaceId: WS });
      expect(t.daemon.upgraded).toEqual([]);
      await t.ctx.audit.flush();
      expect((await t.ctx.audit.query({ limit: 50 })).filter((entry) => entry.action === 'settings.change')).toHaveLength(1);
    } finally {
      await t?.cleanup();
      t = null;
      await removeTempRunDir(stateDir);
      await removeTempDir(base);
    }
  }, 60_000);
});
