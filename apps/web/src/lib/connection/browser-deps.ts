// What a browser Connection needs besides the workspace id: the relay API (cookie session, same origin), the device
// key store and the store of pinned daemon keys, both on IndexedDB through @smurg/protocol/browser (device-key-v2 of
// noise.md: a non-extractable X25519 CryptoKeyPair where the engine can store one, AES-wrapped PKCS#8 on WebKit).
//
// What "non-extractable" means (noise.md §1.6, gotcha 20): script cannot EXPORT the key; it is NOT encrypted at rest
// (Chromium and Firefox write the raw bytes into the profile). Never describe it as protected against disk theft.
//
// A record a NEWER page wrote (another `v`) is never replaced: the key store stops with 'newer-record' and leaves it
// (packages/protocol/src/browser/key-stores.ts). The connection engine only knows that the storage failed
// (`closed: storage-error`); `keyStorage.newerRecord` is how the page knows why and says "reload" instead of "check
// that site data is not blocked".
import {
  KeyStoreError,
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
  /** A key operation stopped at a record a newer page wrote. Nothing was changed; a reload gets the page that reads it. */
  readonly newerRecord: boolean;
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

export interface BrowserConnectionDepsOptions {
  origin?: string;
  userAgent?: string;
  /** Opens the browser's key-value store (default: IndexedDB `smurg-keys`). A rejection means "not available here". */
  openKeyValueStore?: () => Promise<KeyValueStore>;
}

export function createBrowserConnectionDeps(options: BrowserConnectionDepsOptions = {}): BrowserConnectionDeps {
  const origin = options.origin ?? window.location.origin;
  const relay = new RelayApi({ relayUrl: origin, auth: { kind: 'cookie' } });
  const keyStorage = createStore<KeyStorageStatus>({ persistent: null, newerRecord: false });
  const openKeyValueStore = options.openKeyValueStore ?? (() => openIndexedDbKeyValueStore());
  let opening: Promise<OpenedKeys> | null = null;
  const open = (): Promise<OpenedKeys> => {
    opening ??= (async () => {
      let kv: KeyValueStore;
      try {
        kv = await openKeyValueStore();
        keyStorage.setState((previous) => ({ ...previous, persistent: true }));
      } catch {
        // Private windows of some browsers refuse IndexedDB: keep working for this tab, and say so in the UI.
        kv = createMemoryKeyValueStore();
        keyStorage.setState((previous) => ({ ...previous, persistent: false }));
      }
      return { kv, devices: createDeviceKeyStore(kv), pins: createDaemonPinStore(kv) };
    })();
    return opening;
  };
  /** Runs one key operation; a stop at a newer page's record is remembered for the page's words, then passed on. */
  const use = async <T>(operation: (keys: OpenedKeys) => Promise<T>): Promise<T> => {
    const keys = await open();
    try {
      return await operation(keys);
    } catch (error) {
      if (error instanceof KeyStoreError && error.code === 'newer-record') keyStorage.setState((previous) => ({ ...previous, newerRecord: true }));
      throw error;
    }
  };
  return {
    relay,
    keyStorage,
    deviceName: describeDevice(options.userAgent ?? (typeof navigator === 'undefined' ? '' : navigator.userAgent)),
    deviceKeys: {
      // One key per workspace (the protocol's browser store is keyed by id): a revoked key is replaced for that
      // workspace alone.
      getKeyPair: (workspaceId) => use(async ({ devices }) => (await devices.loadOrCreate(workspaceId)).keyPair),
    },
    pins: {
      get: (workspaceId) => use(({ pins }) => pins.get(workspaceId)),
      pin: (workspaceId, key, pinOptions) => use(({ pins }) => pins.pin(workspaceId, key, pinOptions)),
      delete: (workspaceId) => use(({ pins }) => pins.delete(workspaceId)),
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
