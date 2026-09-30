// SPEC R3 「斷線重連時重新握手；應用層用 seq 補送遺漏的訊息」 with the resume contract of ARCHITECTURE §4 (and
// @smurg/protocol/client outbox.ts): after a reconnect the daemon replays exactly what the client has not
// processed, the client re-sends what the daemon has not acknowledged, and duplicates are dropped by seq on both
// sides. When the gap is gone the Welcome says resumed = false and the client resyncs.
import { afterEach, describe, expect, it } from 'vitest';
import { newId } from '../src/core/lifecycle.ts';
import { SYSTEM_ACTOR } from '../src/core/permissions.ts';
import { createTestDaemon, waitFor, type TestClient, type TestDaemon } from '../src/testing/index.ts';
import { createProbe } from './fixtures/probe-module.ts';

let t: TestDaemon | null = null;

afterEach(async () => {
  await t?.cleanup();
  t = null;
});

const FAST_RECONNECT = { reconnectBaseMs: 20, reconnectMaxMs: 60 };

function notify(t: TestDaemon, userId: string, text: string): void {
  t.ctx.hub.sendToUser(userId, 'activity.notify', { notification: { id: newId('n'), at: t.clock.now(), from: SYSTEM_ACTOR, text } });
}

function collect(client: TestClient): { texts: string[]; welcomes: boolean[] } {
  const texts: string[] = [];
  const welcomes: boolean[] = [];
  client.conn.on('activity.notify', (payload) => texts.push(payload.notification.text));
  client.conn.onWelcome((_welcome, info) => welcomes.push(info.resumed));
  return { texts, welcomes };
}

describe('resume', () => {
  it('replays daemon messages lost with the socket, exactly once, and says resumed = true', async () => {
    t = await createTestDaemon({ timing: FAST_RECONNECT });
    const amy = await t.connect({ userId: 'dev:amy' });
    const seen = collect(amy);
    notify(t, 'dev:amy', 'n1');
    await waitFor(() => seen.texts.length === 1);
    const channelId = amy.conn.welcome?.channelId;

    t.relay.dropHost('ws');
    notify(t, 'dev:amy', 'n2'); // lost in transit: the host socket is already gone
    await waitFor(() => t?.ctx.hub.connections({ userId: 'dev:amy' }).length === 0, { what: 'hub detach' });
    notify(t, 'dev:amy', 'n3'); // queued while the client is away
    await waitFor(() => seen.welcomes.length === 1 && amy.conn.getState().kind === 'online', { what: 'resumed reconnect' });
    notify(t, 'dev:amy', 'n4');
    await waitFor(() => seen.texts.length >= 4);
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(seen.welcomes).toEqual([true]);
    expect(amy.conn.welcome?.channelId).toBe(channelId);
    expect(seen.texts).toEqual(['n1', 'n2', 'n3', 'n4']);
  });

  it('drops client messages the daemon already processed when the client re-sends them after a resume', async () => {
    const probe = createProbe();
    probe.overrides.set('lock.list', () => ({ locks: [] }));
    // The daemon never acknowledges during this test, so the client keeps (and re-sends) everything it sent.
    t = await createTestDaemon({ modules: [probe.module], timing: { ...FAST_RECONNECT, ackDelayMs: 600_000, ackEvery: 100_000 } });
    const amy = await t.connect({ userId: 'dev:amy' });
    const seen = collect(amy);
    await amy.conn.request('lock.list', {});
    await amy.conn.request('lock.list', {});
    expect(probe.count('lock.list')).toBe(2);

    t.relay.dropHost('ws');
    await waitFor(() => seen.welcomes.length === 1 && amy.conn.getState().kind === 'online', { what: 'resumed reconnect' });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(seen.welcomes).toEqual([true]);
    expect(probe.count('lock.list')).toBe(2); // the re-sent copies were recognised by seq and dropped
    await amy.conn.request('lock.list', {});
    expect(probe.count('lock.list')).toBe(3);
  });

  it('sends a request made while the host was away once the channel is back', async () => {
    const probe = createProbe();
    probe.overrides.set('lock.list', () => ({ locks: [] }));
    t = await createTestDaemon({ modules: [probe.module], timing: FAST_RECONNECT });
    const amy = await t.connect({ userId: 'dev:amy' });
    t.relay.dropHost('ws');
    await waitFor(() => amy.conn.getState().kind === 'host-offline', { what: 'host-offline' });
    const pending = amy.conn.request('lock.list', {});
    await expect(pending).resolves.toEqual({ locks: [] });
    expect(probe.count('lock.list')).toBe(1);
  });

  it('resumes on a new client socket (new relay connection id) too', async () => {
    t = await createTestDaemon({ timing: FAST_RECONNECT });
    const amy = await t.connect({ userId: 'dev:amy' });
    const seen = collect(amy);
    const [socket] = t.relay.clientsOf('dev:amy', 'ws');
    expect(socket).toBeDefined();
    t.relay.byeClient(socket as NonNullable<typeof socket>, 4000, 'test');
    notify(t, 'dev:amy', 'while-away');
    await waitFor(() => seen.welcomes.length === 1 && amy.conn.getState().kind === 'online', { what: 'reconnect' });
    await waitFor(() => seen.texts.length === 1);
    expect(seen.welcomes).toEqual([true]);
    expect(seen.texts).toEqual(['while-away']);
    expect(t.relay.clientsOf('dev:amy', 'ws')[0]?.conn).not.toBe(socket?.conn);
  });

  it('answers resumed = false when the outbox overflowed while the client was away', async () => {
    t = await createTestDaemon({ timing: FAST_RECONNECT, limits: { outboxMaxEntries: 5 } });
    const amy = await t.connect({ userId: 'dev:amy' });
    const seen = collect(amy);
    const oldChannel = amy.conn.welcome?.channelId;
    t.relay.dropHost('ws');
    await waitFor(() => t?.ctx.hub.connections({ userId: 'dev:amy' }).length === 0, { what: 'hub detach' });
    for (let i = 0; i < 12; i++) notify(t, 'dev:amy', `missed-${i}`);
    await waitFor(() => seen.welcomes.length === 1 && amy.conn.getState().kind === 'online', { what: 'reconnect' });
    expect(seen.welcomes).toEqual([false]);
    expect(amy.conn.welcome?.channelId).not.toBe(oldChannel);
    expect(t.ctx.hub.recipients({ userId: 'dev:amy' }).map((r) => r.channelId)).toEqual([amy.conn.welcome?.channelId]);
  });

  it('never lets another device continue a logical channel it does not own', async () => {
    t = await createTestDaemon();
    const amy = await t.connect({ userId: 'dev:amy' });
    const channelId = amy.conn.welcome?.channelId as string;
    const hub = t.daemon.internals.hub;
    const stranger = hub.prepareAdmission({ purpose: 'interactive', userId: 'dev:amy', deviceId: 'another-device', resume: { channelId, lastSeq: 0 } });
    expect(stranger.resumed).toBe(false);
    expect(stranger.channelId).not.toBe(channelId);
    const otherUser = hub.prepareAdmission({ purpose: 'interactive', userId: 'dev:bob', deviceId: amy.conn.welcome ? 'x' : 'y', resume: { channelId, lastSeq: 0 } });
    expect(otherUser.resumed).toBe(false);
  });
});

describe('presence.heartbeat', () => {
  it('reaches every interactive client on the configured interval', async () => {
    t = await createTestDaemon({ timing: { presenceHeartbeatMs: 40 } });
    const amy = await t.connect({ userId: 'dev:amy' });
    const beats: number[] = [];
    amy.conn.on('presence.heartbeat', (payload) => beats.push(payload.at));
    await waitFor(() => beats.length >= 3, { what: 'three heartbeats', timeoutMs: 2_000 });
    expect(beats[1]).toBeGreaterThan(beats[0] as number);
  });
});
