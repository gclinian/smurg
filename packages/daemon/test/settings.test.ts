// Host settings (admin.settings.*): every member works with the PublicSettings (lock timeouts, upload chunk size,
// shared dirs), so a change reaches connected clients at once as channel.settingsUpdated (contract review C16), and
// the host-only fields never do.
import { afterEach, describe, expect, it } from 'vitest';
import { totalmem } from 'node:os';
import { ESCALATE_AFTER_MS_DEFAULT, ESCALATE_AFTER_MS_RANGE, MAX_LIVE_AGENTS_RANGE, type PublicSettings } from '@smurg/protocol';
import { defaultMaxLiveAgents } from '../src/core/config.ts';
import { createTestDaemon, waitFor, type TestDaemon } from '../src/testing/index.ts';

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
      // ARCHITECTURE §11 D-15: no guest switches any more.
      expect(Object.keys(list[0] ?? {}).sort()).toEqual(['agentLockTimeoutMs', 'humanLockIdleMs', 'sharedDirs', 'uploadChunkSize']);
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
    expect(Object.keys(settings).sort()).toEqual(['agentLockTimeoutMs', 'agentMcp', 'diskReserveBytes', 'diskReservePercent', 'escalateAfterMs', 'humanLockIdleMs', 'maxLiveAgents', 'sharedDirs', 'uploadChunkSize']);
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
    for (const settingsSeen of pushed) expect(Object.keys(settingsSeen).sort()).toEqual(['agentLockTimeoutMs', 'humanLockIdleMs', 'sharedDirs', 'uploadChunkSize']);
    await t.ctx.audit.flush();
    const changes = (await t.ctx.audit.query({ limit: 50 })).filter((entry) => entry.action === 'settings.change');
    expect(changes.length).toBeGreaterThanOrEqual(1);
  });
});
