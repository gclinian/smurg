// What a browser Connection needs besides the workspace id: the relay API (cookie session, same origin), the device
// key store and the store of pinned daemon keys, both on IndexedDB through @smurg/protocol/browser (device-key-v2 of
// noise.md: a non-extractable X25519 CryptoKeyPair where the engine can store one, AES-wrapped PKCS#8 on WebKit).
//
// What "non-extractable" means (noise.md §1.6, gotcha 20): script cannot EXPORT the key; it is NOT encrypted at rest
// (Chromium and Firefox write the raw bytes into the profile). Never describe it as protected against disk theft.
import {
  createDaemonPinStore,
  createDeviceKeyStore,
  createMemoryKeyValueStore,
  openIndexedDbKeyValueStore,
  type DaemonPinStore,
  type DeviceKeyStore,
  type KeyValueStore,
} from '@smurg/protocol/browser';
import { Connection, RelayApi, type DeviceKeyProvider, type PinStore } from '@smurg/protocol/client';
import { createStore, type ReadableStore } from '../store.ts';
import type { ConnectFn, WorkspaceConnection } from './types.ts';

export interface KeyStorageStatus {
  /** null until the first key operation opened the storage. */
  readonly persistent: boolean | null;
}

export interface BrowserConnectionDeps {
  readonly relay: RelayApi;
  readonly deviceKeys: DeviceKeyProvider;
  readonly pins: PinStore & Pick<DaemonPinStore, 'delete'>;
  readonly deviceName: string;
  /** false when IndexedDB is unavailable and keys live in memory only (lost with the tab). */
  readonly keyStorage: ReadableStore<KeyStorageStatus>;
}

interface OpenedKeys {
  readonly kv: KeyValueStore;
  readonly devices: DeviceKeyStore;
  readonly pins: DaemonPinStore;
}

export function createBrowserConnectionDeps(options: { origin?: string; userAgent?: string } = {}): BrowserConnectionDeps {
  const origin = options.origin ?? window.location.origin;
  const relay = new RelayApi({ relayUrl: origin, auth: { kind: 'cookie' } });
  const keyStorage = createStore<KeyStorageStatus>({ persistent: null });
  let opening: Promise<OpenedKeys> | null = null;
  const open = (): Promise<OpenedKeys> => {
    opening ??= (async () => {
      let kv: KeyValueStore;
      try {
        kv = await openIndexedDbKeyValueStore();
        keyStorage.setState({ persistent: true });
      } catch {
        // Private windows of some browsers refuse IndexedDB: keep working for this tab, and say so in the UI.
        kv = createMemoryKeyValueStore();
        keyStorage.setState({ persistent: false });
      }
      return { kv, devices: createDeviceKeyStore(kv), pins: createDaemonPinStore(kv) };
    })();
    return opening;
  };
  return {
    relay,
    keyStorage,
    deviceName: describeDevice(options.userAgent ?? (typeof navigator === 'undefined' ? '' : navigator.userAgent)),
    deviceKeys: {
      // One key per workspace (the protocol's browser store is keyed by id): a revoked key is replaced for that
      // workspace alone.
      async getKeyPair(workspaceId) {
        return (await (await open()).devices.loadOrCreate(workspaceId)).keyPair;
      },
    },
    pins: {
      get: async (workspaceId) => (await open()).pins.get(workspaceId),
      pin: async (workspaceId, key, pinOptions) => (await open()).pins.pin(workspaceId, key, pinOptions),
      delete: async (workspaceId) => (await open()).pins.delete(workspaceId),
    },
  };
}

/** A ConnectFn building real SDK connections (not started). */
export function browserConnect(deps: BrowserConnectionDeps): ConnectFn {
  return (workspaceId, options): WorkspaceConnection =>
    new Connection({
      relay: deps.relay,
      workspaceId,
      deviceKeys: deps.deviceKeys,
      pins: deps.pins,
      invite: options.invite ?? null,
      preferInvite: options.preferInvite === true,
      clientKind: 'web',
      deviceName: deps.deviceName,
    });
}

/**
 * "Chrome (macOS)" for the host's device list; "Browser" when the user agent says nothing. Best effort; the host
 * only uses it to tell a member's devices apart. The name is stored on the host and shown to everyone there, so it
 * has ONE language-neutral spelling and is never translated.
 */
export function describeDevice(userAgent: string): string {
  const ua = userAgent;
  const browser = /Edg\//.test(ua)
    ? 'Edge'
    : /Firefox\//.test(ua)
      ? 'Firefox'
      : /Chrome\//.test(ua) || /Chromium\//.test(ua)
        ? 'Chrome'
        : /Safari\//.test(ua)
          ? 'Safari'
          : 'Browser';
  const os = /iPhone|iPad|iPod/.test(ua)
    ? 'iOS'
    : /Android/.test(ua)
      ? 'Android'
      : /Mac OS X|Macintosh/.test(ua)
        ? 'macOS'
        : /Windows/.test(ua)
          ? 'Windows'
          : /CrOS/.test(ua)
            ? 'ChromeOS'
            : /Linux/.test(ua)
              ? 'Linux'
              : null;
  return os === null ? browser : `${browser} (${os})`;
}
