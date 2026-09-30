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
      expect(Object.keys(list[0] ?? {}).sort()).toEqual(['agentLockTimeoutMs', 'guestSubscriptionLogin', 'humanLockIdleMs', 'sharedDirs', 'uploadChunkSize']);
    }
    // An editor cannot change them (router capability check), and nothing is broadcast then.
    await expect(eddie.conn.request('admin.settings.set', { humanLockIdleMs: 1_000 })).rejects.toMatchObject({ code: 'forbidden' });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(seen.get('dev:eddie')).toHaveLength(1);
  });
});

describe('PublicSettings.guestSubscriptionLogin (ARCHITECTURE §11 D-12): the daemon publishes its own switch', () => {
  it('on by default: every member\'s Welcome and every channel.settingsUpdated say true', async () => {
    t = await createTestDaemon();
    const host = await t.connectHost();
    const rita = await t.connect({ userId: 'dev:rita', role: 'runner' });
    expect(host.welcome?.settings.guestSubscriptionLogin).toBe(true);
    expect(rita.welcome?.settings.guestSubscriptionLogin).toBe(true);
    const updates: PublicSettings[] = [];
    rita.conn.on('channel.settingsUpdated', (payload) => updates.push(payload.settings));
    await host.conn.request('admin.settings.set', { humanLockIdleMs: 40_000 });
    await waitFor(() => updates.length === 1, { what: 'channel.settingsUpdated' });
    expect(updates[0]?.guestSubscriptionLogin).toBe(true);
  });

  it('switched off (config.sessions.guestSubscriptionLogin false): the Welcome and channel.settingsUpdated say false, and the console cannot turn it on', async () => {
    t = await createTestDaemon({ sessions: { guestSubscriptionLogin: false } });
    const host = await t.connectHost();
    const rita = await t.connect({ userId: 'dev:rita', role: 'runner' });
    expect(rita.welcome?.settings.guestSubscriptionLogin).toBe(false);
    expect(host.welcome?.settings.guestSubscriptionLogin).toBe(false);
    const updates: PublicSettings[] = [];
    rita.conn.on('channel.settingsUpdated', (payload) => updates.push(payload.settings));
    // It is configuration, not a console setting: admin.settings.set refuses it (strict schema) …
    await expect(host.conn.request('admin.settings.set', { guestSubscriptionLogin: true } as never)).rejects.toMatchObject({ code: 'bad_request' });
    // … and a real change of another setting still publishes the daemon's value.
    await host.conn.request('admin.settings.set', { humanLockIdleMs: 40_000 });
    await waitFor(() => updates.length === 1, { what: 'channel.settingsUpdated' });
    expect(updates[0]?.guestSubscriptionLogin).toBe(false);
    expect(t.ctx.settings.public().guestSubscriptionLogin).toBe(false);
  });
});
