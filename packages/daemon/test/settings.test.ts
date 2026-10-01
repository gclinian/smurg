// Host settings (admin.settings.*): every member works with the PublicSettings (lock timeouts, upload chunk size,
// shared dirs), so a change reaches connected clients at once as channel.settingsUpdated (contract review C16), and
// the host-only fields never do.
import { afterEach, describe, expect, it } from 'vitest';
import type { PublicSettings } from '@smurg/protocol';
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
    expect(Object.keys(settings).sort()).toEqual(['agentLockTimeoutMs', 'diskReserveBytes', 'diskReservePercent', 'humanLockIdleMs', 'sharedDirs', 'uploadChunkSize']);
  });
});
