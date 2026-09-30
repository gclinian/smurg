// TEST ONLY. Wires a FakeRelay, a FakeDaemon and client connections together.
import { Connection, type ConnectionOptions } from '../connection.ts';
import { TransferConnection, type TransferConnectionOptions } from '../transfer.ts';
import { createMemoryDeviceKeyProvider, createMemoryPinStore } from '../storage.ts';
import type { InviteTrust } from '../engine.ts';
import { FakeDaemon, type FakeDaemonOptions } from './fake-daemon.ts';
import { FakeRelay, type FakeRelayApi } from './fake-relay.ts';

export const AMY = 'dev:amy';

export interface World {
  readonly relay: FakeRelay;
  readonly daemon: FakeDaemon;
}

export function createWorld(options: FakeDaemonOptions & { attach?: boolean } = {}): World {
  const relay = new FakeRelay();
  const daemon = new FakeDaemon(options);
  if (options.attach !== false) {
    relay.attachHost('ws', daemon);
    relay.attachHost('xfer', daemon);
  }
  return { relay, daemon };
}

/** One person's device: its relay login, device key and pins survive across Connection instances. */
export interface Device {
  readonly api: FakeRelayApi;
  readonly deviceKeys: ReturnType<typeof createMemoryDeviceKeyProvider>;
  readonly pins: ReturnType<typeof createMemoryPinStore>;
}

export function createDevice(world: World, userId = AMY): Device {
  return { api: world.relay.apiFor(userId), deviceKeys: createMemoryDeviceKeyProvider(), pins: createMemoryPinStore() };
}

type Extra = Partial<Omit<ConnectionOptions, 'relay' | 'deviceKeys' | 'pins' | 'workspaceId'>>;

export function connect(world: World, device: Device, options: Extra & { invite?: InviteTrust | null } = {}): Connection {
  return new Connection({
    relay: device.api,
    workspaceId: world.daemon.workspaceId,
    deviceKeys: device.deviceKeys,
    pins: device.pins,
    clientKind: 'web',
    deviceName: 'Test browser',
    random: () => 0.5,
    ...options,
  });
}

export function connectTransfer(
  world: World,
  device: Device,
  options: Partial<Omit<TransferConnectionOptions, 'relay' | 'deviceKeys' | 'pins' | 'workspaceId'>> = {},
): TransferConnection {
  return new TransferConnection({
    relay: device.api,
    workspaceId: world.daemon.workspaceId,
    deviceKeys: device.deviceKeys,
    pins: device.pins,
    clientKind: 'cli',
    deviceName: 'Test CLI',
    random: () => 0.5,
    ...options,
  });
}

/**
 * Lets every queued microtask (and the microtasks they queue) run. The fake relay and daemon deliver everything
 * through microtasks, so a few macrotask turns bring the whole world to rest. Uses the real setImmediate, which the
 * client tests leave un-faked.
 */
export async function settle(turns = 5): Promise<void> {
  for (let i = 0; i < turns; i++) await new Promise<void>((resolve) => setImmediate(resolve));
}

/** vi.useFakeTimers() options for these tests: timers and Date are faked, setImmediate stays real for settle(). */
export const FAKE_TIMERS: { toFake: ('setTimeout' | 'clearTimeout' | 'setInterval' | 'clearInterval' | 'Date')[] } = {
  toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'],
};
