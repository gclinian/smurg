// Where a client keeps what must survive a reconnect: its device key, the daemon keys it verified (pins) and,
// optionally, the resume position of its logical channel. Interfaces plus in-memory implementations; the IndexedDB
// versions live in ../browser (createDeviceKeyStore / createDaemonPinStore) and the file versions in ../node
// (loadOrCreateCliDeviceKey / readPinnedDaemonKey / pinDaemonKey).
import { equalBytes } from '../bytes.ts';
import { x25519KeyPair, type NoiseKeyPair } from '../noise/suite.ts';
import { isWorkspaceId } from '../relay/routes.ts';
import { OPAQUE_ID_PATTERN } from '../schema/primitives.ts';

// ---------------------------------------------------------------------------------------------------------------
// Device keys
// ---------------------------------------------------------------------------------------------------------------

/** The device's static Noise key for a workspace. The key pair's `dh` may be async (WebCrypto). */
export interface DeviceKeyProvider {
  getKeyPair(workspaceId: string): Promise<NoiseKeyPair>;
}

/** One key for every workspace (the CLI's `~/.smurg/device.key`). */
export function staticDeviceKeyProvider(keyPair: NoiseKeyPair): DeviceKeyProvider {
  if (!(keyPair?.publicKey instanceof Uint8Array) || keyPair.publicKey.length !== 32 || typeof keyPair.dh !== 'function') {
    throw new TypeError('not a Noise key pair');
  }
  return { getKeyPair: () => Promise.resolve(keyPair) };
}

/**
 * Adapts a store with `loadOrCreate(id) → { keyPair }` (the browser's createDeviceKeyStore) using the workspace id as
 * the key id, one key per workspace.
 */
export function deviceKeyProviderFromStore(store: {
  loadOrCreate(id: string): Promise<{ readonly keyPair: NoiseKeyPair }>;
}): DeviceKeyProvider {
  return {
    async getKeyPair(workspaceId) {
      return (await store.loadOrCreate(workspaceId)).keyPair;
    },
  };
}

/** In memory: a fresh raw X25519 key per workspace, kept for the lifetime of the provider (tests, previews). */
export function createMemoryDeviceKeyProvider(): DeviceKeyProvider & { readonly keys: ReadonlyMap<string, NoiseKeyPair> } {
  const keys = new Map<string, NoiseKeyPair>();
  return {
    keys,
    getKeyPair(workspaceId) {
      if (!isWorkspaceId(workspaceId)) return Promise.reject(new TypeError('invalid workspace id'));
      let keyPair = keys.get(workspaceId);
      if (!keyPair) {
        keyPair = x25519KeyPair();
        keys.set(workspaceId, keyPair);
      }
      return Promise.resolve(keyPair);
    },
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Pins of verified daemon keys
// ---------------------------------------------------------------------------------------------------------------

/**
 * workspaceId → the daemon static key this client verified (against an invite's `k`) and trusts from then on.
 * The browser's DaemonPinStore has exactly this shape. For the CLI:
 * `{ get: (ws) => readPinnedDaemonKey(dir, ws), pin: (ws, k, o) => pinDaemonKey(dir, ws, k, o) }`.
 */
export interface PinStore {
  get(workspaceId: string): Promise<Uint8Array | null>;
  /**
   * Stores a VERIFIED key. Re-pinning the same key is a no-op; a different key must be refused unless `replace` is
   * set, which the connection only does in invite mode (the invite's fingerprint is the trust anchor).
   */
  pin(workspaceId: string, daemonStaticKey: Uint8Array, options?: { replace?: boolean }): Promise<void>;
}

export class PinStoreError extends Error {
  readonly code: 'pin-mismatch' | 'bad-argument';

  constructor(code: 'pin-mismatch' | 'bad-argument', message: string) {
    super(message);
    this.name = 'PinStoreError';
    this.code = code;
  }
}

export function createMemoryPinStore(initial: Iterable<readonly [string, Uint8Array]> = []): PinStore & {
  readonly pins: ReadonlyMap<string, Uint8Array>;
  delete(workspaceId: string): void;
} {
  const pins = new Map<string, Uint8Array>();
  const check = (workspaceId: string): void => {
    if (!isWorkspaceId(workspaceId)) throw new PinStoreError('bad-argument', 'invalid workspace id');
  };
  for (const [ws, key] of initial) {
    check(ws);
    pins.set(ws, key.slice());
  }
  return {
    pins,
    get(workspaceId) {
      try {
        check(workspaceId);
      } catch (err) {
        return Promise.reject(err);
      }
      return Promise.resolve(pins.get(workspaceId)?.slice() ?? null);
    },
    pin(workspaceId, daemonStaticKey, options = {}) {
      try {
        check(workspaceId);
        if (!(daemonStaticKey instanceof Uint8Array) || daemonStaticKey.length !== 32) {
          throw new PinStoreError('bad-argument', 'daemon key must be 32 bytes');
        }
        const existing = pins.get(workspaceId);
        if (existing && !equalBytes(existing, daemonStaticKey) && !options.replace) {
          throw new PinStoreError('pin-mismatch', 'a different daemon key is pinned for this workspace');
        }
      } catch (err) {
        return Promise.reject(err);
      }
      pins.set(workspaceId, daemonStaticKey.slice());
      return Promise.resolve();
    },
    delete(workspaceId) {
      pins.delete(workspaceId);
    },
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Resume position
// ---------------------------------------------------------------------------------------------------------------

/**
 * The logical channel to continue (ARCHITECTURE §4 "Resume"): `channelId` from the Welcome, `lastSeq` = the last daemon
 * seq this client processed, `nextSeq` = the next seq this client would assign (so a restored client never reuses a
 * seq the daemon may already have processed and would drop as a duplicate).
 */
export interface ResumeState {
  readonly channelId: string;
  readonly lastSeq: number;
  readonly nextSeq: number;
}

/**
 * Only use a persistent store if the application state it describes survives as long: resuming tells the daemon
 * "I already have everything up to lastSeq", so a client that lost its state must start fresh instead.
 */
export interface ResumeStore {
  load(workspaceId: string): Promise<ResumeState | null>;
  save(workspaceId: string, state: ResumeState): Promise<void>;
  clear(workspaceId: string): Promise<void>;
}

export function isResumeState(value: unknown): value is ResumeState {
  if (value === null || typeof value !== 'object') return false;
  const v = value as Partial<ResumeState>;
  return (
    typeof v.channelId === 'string' &&
    OPAQUE_ID_PATTERN.test(v.channelId) &&
    Number.isSafeInteger(v.lastSeq) &&
    (v.lastSeq as number) >= 0 &&
    Number.isSafeInteger(v.nextSeq) &&
    (v.nextSeq as number) >= 1
  );
}

export function createMemoryResumeStore(): ResumeStore & { readonly states: ReadonlyMap<string, ResumeState> } {
  const states = new Map<string, ResumeState>();
  return {
    states,
    load: (workspaceId) => Promise.resolve(states.get(workspaceId) ?? null),
    save(workspaceId, state) {
      states.set(workspaceId, { channelId: state.channelId, lastSeq: state.lastSeq, nextSeq: state.nextSeq });
      return Promise.resolve();
    },
    clear(workspaceId) {
      states.delete(workspaceId);
      return Promise.resolve();
    },
  };
}
