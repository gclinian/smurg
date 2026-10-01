// Host settings (admin.settings.*): every member works with the PublicSettings (lock timeouts, upload chunk size,
// shared dirs), so a change reaches connected clients at once as channel.settingsUpdated (contract review C16), and
// the host-only fields never do.
import { afterEach, describe, expect, it } from 'vitest';
import type { PublicSettings } from '@smurg/protocol';
import { defaultGuestMainWorkspace } from '../src/core/config.ts';
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
      expect(Object.keys(list[0] ?? {}).sort()).toEqual(['agentLockTimeoutMs', 'guestMainWorkspace', 'guestSubscriptionLogin', 'humanLockIdleMs', 'sharedDirs', 'uploadChunkSize']);
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

describe('PublicSettings.guestMainWorkspace (ARCHITECTURE §11 D-14): the daemon publishes whether guests may use the main workspace', () => {
  it('by default it is the platform\'s default (off on a Linux host, on on macOS), in the Welcome and in channel.settingsUpdated', async () => {
    t = await createTestDaemon();
    const expected = defaultGuestMainWorkspace(process.platform);
    expect(expected).toBe(process.platform !== 'linux');
    expect(t.daemon.config.sessions.guestMainWorkspace).toBe(expected);
    const host = await t.connectHost();
    const rita = await t.connect({ userId: 'dev:rita', role: 'runner' });
    expect(host.welcome?.settings.guestMainWorkspace).toBe(expected);
    expect(rita.welcome?.settings.guestMainWorkspace).toBe(expected);
    const updates: PublicSettings[] = [];
    rita.conn.on('channel.settingsUpdated', (payload) => updates.push(payload.settings));
    await host.conn.request('admin.settings.set', { humanLockIdleMs: 40_000 });
    await waitFor(() => updates.length === 1, { what: 'channel.settingsUpdated' });
    expect(updates[0]?.guestMainWorkspace).toBe(expected);
  });

  for (const value of [false, true]) {
    it(`set explicitly (config.sessions.guestMainWorkspace ${value}): every member is told ${value}, and the console cannot change it`, async () => {
      t = await createTestDaemon({ sessions: { guestMainWorkspace: value } });
      const host = await t.connectHost();
      const eddie = await t.connect({ userId: 'dev:eddie', role: 'editor' });
      const rita = await t.connect({ userId: 'dev:rita', role: 'runner' });
      for (const client of [host, eddie, rita]) expect(client.welcome?.settings.guestMainWorkspace).toBe(value);
      const updates: PublicSettings[] = [];
      rita.conn.on('channel.settingsUpdated', (payload) => updates.push(payload.settings));
      // Configuration, not a console setting: admin.settings.set refuses it (strict schema) …
      await expect(host.conn.request('admin.settings.set', { guestMainWorkspace: !value } as never)).rejects.toMatchObject({ code: 'bad_request' });
      // … and the host-only settings never carry it.
      const { settings } = await host.conn.request('admin.settings.get', {});
      expect(Object.keys(settings)).not.toContain('guestMainWorkspace');
      await host.conn.request('admin.settings.set', { humanLockIdleMs: 40_000 });
      await waitFor(() => updates.length === 1, { what: 'channel.settingsUpdated' });
      expect(updates[0]?.guestMainWorkspace).toBe(value);
      expect(t.ctx.settings.public().guestMainWorkspace).toBe(value);
    });
  }
});
