// device-key-v2 records and the IndexedDB-backed stores, exercised in Node's WebCrypto against an in-memory store
// with IndexedDB's structured-clone semantics. What this does NOT cover (real IndexedDB, real WebKit/Chromium/Firefox)
// was verified in the research spike (noise.md V-C) and is listed in the delivery report.
import { describe, expect, it } from 'vitest';
import { randomBytes, utf8Encode } from '../bytes.ts';
import { x25519KeyPair } from '../noise/suite.ts';
import { clientConnect } from '../channel/handshake.ts';
import { createMemoryTransportPair } from '../channel/transport.ts';
import { FakeDaemon, WS } from '../channel/testing/harness.ts';
import {
  createDeviceKeyRecord,
  deviceKeyPairFromRecord,
  isUsableDeviceKeyRecord,
  selfTestDeviceKey,
  type DeviceKeyPair,
  type DeviceKeyRecord,
} from './device-key.ts';
import { KeyStoreError, createDaemonPinStore, createDeviceKeyStore } from './key-stores.ts';
import { DEVICE_KEY_STORE, createMemoryKeyValueStore, type KeyValueStore } from './kv.ts';

/** WebCrypto without X25519 (older engines): generateKey rejects with NotSupportedError. */
function subtleWithoutX25519(): SubtleCrypto {
  return new Proxy(crypto.subtle, {
    get(target, prop) {
      if (prop === 'generateKey') {
        return (alg: { name: string }, ...rest: unknown[]) =>
          alg.name === 'X25519'
            ? Promise.reject(new DOMException('X25519', 'NotSupportedError'))
            : (target.generateKey as (...a: unknown[]) => unknown).call(target, alg, ...rest);
      }
      const value = Reflect.get(target, prop) as unknown;
      return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(target) : value;
    },
  });
}

/** Simulates WebKit: X25519 CryptoKeys come back from storage as null (other values survive). */
function webKitLikeStore(): KeyValueStore {
  const inner = createMemoryKeyValueStore();
  const scrub = (value: unknown): unknown => {
    if (typeof CryptoKey !== 'undefined' && value instanceof CryptoKey) return value.algorithm.name === 'X25519' ? null : value;
    if (value instanceof Uint8Array || value === null || typeof value !== 'object') return value;
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, scrub(v)]));
  };
  return { ...inner, get: async (store, key) => scrub(await inner.get(store, key)) };
}

async function joinWith(deviceKey: DeviceKeyPair, daemon = new FakeDaemon()) {
  const pair = createMemoryTransportPair();
  const [client, d] = await Promise.all([
    clientConnect(pair.client, { workspaceId: WS, deviceKey, trust: daemon.addInvite().trust, hello: utf8Encode('browser') }),
    daemon.accept(pair.daemon),
  ]);
  return { client, d, daemon };
}

describe('device key records', () => {
  it('where X25519 CryptoKeys clone (Node, Chromium, Firefox): a non-extractable webcrypto record that survives cloning', async () => {
    const record = await createDeviceKeyRecord();
    expect(record.kind).toBe('webcrypto');
    const cloned = structuredClone(record);
    expect(isUsableDeviceKeyRecord(cloned)).toBe(true);
    const key = await deviceKeyPairFromRecord(cloned);
    expect(key.privateExtractable).toBe(false);
    if (record.kind === 'webcrypto') await expect(crypto.subtle.exportKey('pkcs8', record.pair.privateKey)).rejects.toThrow();
    const { d } = await joinWith(key);
    expect(d.clientStaticKey).toEqual(key.publicKey);
  });

  it('the WebKit path: a wrapped record, non-extractable after unwrap, survives cloning, handshakes', async () => {
    const record = await createDeviceKeyRecord(crypto.subtle, { forceWrapped: true });
    expect(record.kind).toBe('wrapped');
    const cloned = structuredClone(record);
    expect(isUsableDeviceKeyRecord(cloned)).toBe(true);
    const key = await deviceKeyPairFromRecord(cloned);
    expect(key.privateExtractable).toBe(false);
    await selfTestDeviceKey(key);
    const { d } = await joinWith(key);
    expect(d.clientStaticKey).toEqual(key.publicKey);
  });

  it('without WebCrypto X25519: a raw record that still handshakes', async () => {
    const record = await createDeviceKeyRecord(subtleWithoutX25519());
    expect(record.kind).toBe('raw');
    const key = await deviceKeyPairFromRecord(record);
    await joinWith(key);
  });

  it('re-validation rejects every record that is not exactly usable', async () => {
    const webcrypto = await createDeviceKeyRecord();
    const wrapped = (await createDeviceKeyRecord(crypto.subtle, { forceWrapped: true })) as Extract<DeviceKeyRecord, { kind: 'wrapped' }>;
    const extractable = (await crypto.subtle.generateKey({ name: 'X25519' }, true, ['deriveBits'])) as CryptoKeyPair;
    const ecdh = (await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits'])) as CryptoKeyPair;
    const aes = (await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['wrapKey', 'unwrapKey'])) as CryptoKey;
    expect(isUsableDeviceKeyRecord(webcrypto)).toBe(true);
    expect(isUsableDeviceKeyRecord(wrapped)).toBe(true);
    const bad: unknown[] = [
      null,
      undefined,
      'raw',
      { kind: 'raw', secretKey: new Uint8Array(31) },
      { kind: 'raw', secretKey: Array.from(randomBytes(32)) },
      { kind: 'webcrypto', pair: null },
      { kind: 'webcrypto', pair: { privateKey: null, publicKey: null } }, // what WebKit hands back
      { kind: 'webcrypto', pair: extractable },
      { kind: 'webcrypto', pair: ecdh },
      { ...wrapped, kek: null },
      { ...wrapped, kek: aes }, // extractable kek
      { ...wrapped, iv: new Uint8Array(8) },
      { ...wrapped, wrapped: new Uint8Array(0) },
      { ...wrapped, publicKey: new Uint8Array(33) },
      { kind: 'other' },
    ];
    for (const record of bad) expect(isUsableDeviceKeyRecord(record)).toBe(false);
  });

  it('a wrapped record whose public key was swapped fails the self-test', async () => {
    const wrapped = (await createDeviceKeyRecord(crypto.subtle, { forceWrapped: true })) as Extract<DeviceKeyRecord, { kind: 'wrapped' }>;
    const tampered = { ...wrapped, publicKey: x25519KeyPair().publicKey };
    await expect(selfTestDeviceKey(await deviceKeyPairFromRecord(tampered))).rejects.toThrow(/self-test/);
  });
});

describe('device key store', () => {
  it('creates once per id and returns the same key afterwards', async () => {
    const kv = createMemoryKeyValueStore();
    const store = createDeviceKeyStore(kv);
    expect(await store.load(WS)).toBeNull();
    const first = await store.loadOrCreate(WS);
    expect(first).toMatchObject({ created: true, replacedUnusable: false });
    expect(first.keyPair.kind).toBe('webcrypto');
    const again = await store.loadOrCreate(WS);
    expect(again.created).toBe(false);
    expect(again.keyPair.publicKey).toEqual(first.keyPair.publicKey);
    expect((await store.load(WS))!.keyPair.publicKey).toEqual(first.keyPair.publicKey);
    const other = await store.loadOrCreate('ws_other_0123456789');
    expect(other.keyPair.publicKey).not.toEqual(first.keyPair.publicKey);
    await store.delete(WS);
    expect(await store.load(WS)).toBeNull();
  });

  it('two tabs racing to create end up with one stored key', async () => {
    const kv = createMemoryKeyValueStore();
    const results = await Promise.all([createDeviceKeyStore(kv).loadOrCreate(WS), createDeviceKeyStore(kv).loadOrCreate(WS)]);
    expect(results[0].keyPair.publicKey).toEqual(results[1].keyPair.publicKey);
    expect(results.filter((r) => r.created)).toHaveLength(1);
  });

  it('WebKit-like storage: the wrapped kind survives; an X25519 CryptoKey record is detected at creation, not at the next load', async () => {
    const wrappedStore = createDeviceKeyStore(webKitLikeStore(), { forceWrapped: true });
    const created = await wrappedStore.loadOrCreate(WS);
    expect(created.keyPair.kind).toBe('wrapped');
    expect((await wrappedStore.loadOrCreate(WS)).created).toBe(false);

    const lossy = webKitLikeStore();
    await expect(createDeviceKeyStore(lossy).loadOrCreate(WS)).rejects.toMatchObject({ code: 'corrupt-record' });
    // A record that was stored earlier and no longer loads is replaced, and the caller is told.
    const recovered = await createDeviceKeyStore(lossy, { forceWrapped: true }).loadOrCreate(WS);
    expect(recovered).toMatchObject({ created: true, replacedUnusable: true });
  });

  it('never hands out a corrupt stored record', async () => {
    const kv = createMemoryKeyValueStore();
    const store = createDeviceKeyStore(kv);
    await store.loadOrCreate(WS);
    for (const junk of [{ v: 1 }, { v: 1, createdAt: 1, record: { kind: 'raw', secretKey: new Uint8Array(3) } }, 'x', 42]) {
      await kv.put(DEVICE_KEY_STORE, WS, junk);
      expect(await store.load(WS)).toBeNull();
    }
    const replaced = await store.loadOrCreate(WS);
    expect(replaced.replacedUnusable).toBe(true);
    await expect(store.load('')).rejects.toBeInstanceOf(KeyStoreError);
  });

  // A later page may write another shape under another `v`. This page, still open in another tab, reconnects at every
  // deploy: it must not take what it cannot read for "no key" and put a new key in its place (the host does not know
  // the new key, and the key the newer page made is gone).
  it('a record of another version is never replaced: loading stops with newer-record and the record stays as it was', async () => {
    const kv = createMemoryKeyValueStore();
    const store = createDeviceKeyStore(kv);
    const mine = await store.loadOrCreate(WS);
    for (const later of [
      { v: 2, createdAt: 5, record: { kind: 'raw-v2', secretKey: new Uint8Array(32).fill(7), extra: 'x' } },
      { v: 2 },
      { v: 3, key: new Uint8Array(32).fill(9) },
      { v: 0, createdAt: 1 },
      { v: '2', createdAt: 1 },
    ]) {
      await kv.put(DEVICE_KEY_STORE, WS, later);
      await expect(store.load(WS)).rejects.toMatchObject({ name: 'KeyStoreError', code: 'newer-record' });
      await expect(store.loadOrCreate(WS)).rejects.toMatchObject({ name: 'KeyStoreError', code: 'newer-record' });
      // Nothing was written: what the other page stored is still there, value for value.
      expect(await kv.get(DEVICE_KEY_STORE, WS)).toEqual(later);
    }
    // Another workspace's key is not touched by it, and this workspace's own record of this version still loads.
    expect((await store.loadOrCreate('ws_other_0123456789')).created).toBe(true);
    await kv.delete(DEVICE_KEY_STORE, WS);
    expect((await store.loadOrCreate(WS)).keyPair.publicKey).not.toEqual(mine.keyPair.publicKey);
  });

  it('a record of this version that no longer loads is still replaced, and the caller is told (the WebKit path stays)', async () => {
    const kv = createMemoryKeyValueStore();
    const store = createDeviceKeyStore(kv);
    await kv.put(DEVICE_KEY_STORE, WS, { v: 1, createdAt: 1, record: { kind: 'webcrypto', keyPair: { privateKey: null, publicKey: null }, publicKey: new Uint8Array(32) } });
    expect(await store.load(WS)).toBeNull();
    expect(await store.loadOrCreate(WS)).toMatchObject({ created: true, replacedUnusable: true });
  });

  it('two tabs racing: the one that lost finds a record of another version and stops, it does not overwrite it', async () => {
    const inner = createMemoryKeyValueStore();
    const later = { v: 2, createdAt: 9, record: { kind: 'later' } };
    let first = true;
    // The first read finds nothing; before this tab's add lands, a newer page in another tab stored its record.
    const kv: KeyValueStore = {
      ...inner,
      get: async (store, key) => {
        if (first) {
          first = false;
          await inner.put(store, key, later);
          return undefined;
        }
        return inner.get(store, key);
      },
    };
    await expect(createDeviceKeyStore(kv).loadOrCreate(WS)).rejects.toMatchObject({ code: 'newer-record' });
    expect(await inner.get(DEVICE_KEY_STORE, WS)).toEqual(later);
  });
});

describe('daemon pin store', () => {
  it('pins a verified key, is idempotent, refuses a silent change, allows an explicit replacement', async () => {
    const pins = createDaemonPinStore(createMemoryKeyValueStore());
    expect(await pins.get(WS)).toBeNull();
    const k1 = randomBytes(32);
    await pins.pin(WS, k1);
    expect(await pins.get(WS)).toEqual(k1);
    await pins.pin(WS, k1);
    const k2 = randomBytes(32);
    await expect(pins.pin(WS, k2)).rejects.toMatchObject({ code: 'pin-mismatch' });
    expect(await pins.get(WS)).toEqual(k1);
    await pins.pin(WS, k2, { replace: true });
    expect(await pins.get(WS)).toEqual(k2);
    await pins.delete(WS);
    expect(await pins.get(WS)).toBeNull();
  });

  it('a corrupt pin record throws instead of reading as "no pin", and only an explicit replacement overwrites it', async () => {
    const kv = createMemoryKeyValueStore();
    const pins = createDaemonPinStore(kv);
    await kv.put('daemon-pins', WS, { v: 1, key: new Uint8Array(5), pinnedAt: 0 });
    await expect(pins.get(WS)).rejects.toMatchObject({ code: 'corrupt-record' });
    await expect(pins.pin(WS, randomBytes(32))).rejects.toMatchObject({ code: 'corrupt-record' });
    const k = randomBytes(32);
    await pins.pin(WS, k, { replace: true });
    expect(await pins.get(WS)).toEqual(k);
    await expect(pins.get('../x')).rejects.toMatchObject({ code: 'bad-argument' });
    await expect(pins.pin(WS, new Uint8Array(31))).rejects.toMatchObject({ code: 'bad-argument' });
  });

  it('a pin of another version is never overwritten, not even by an explicit replacement (a new invite): reading and pinning stop with newer-record', async () => {
    const kv = createMemoryKeyValueStore();
    const pins = createDaemonPinStore(kv);
    for (const later of [{ v: 2, key: randomBytes(32), pinnedAt: 3, by: 'invite' }, { v: 2, keys: [randomBytes(32)] }, { v: 0, key: randomBytes(32), pinnedAt: 0 }]) {
      await kv.put('daemon-pins', WS, later);
      await expect(pins.get(WS)).rejects.toMatchObject({ name: 'KeyStoreError', code: 'newer-record' });
      await expect(pins.pin(WS, randomBytes(32))).rejects.toMatchObject({ code: 'newer-record' });
      await expect(pins.pin(WS, randomBytes(32), { replace: true })).rejects.toMatchObject({ code: 'newer-record' });
      expect(await kv.get('daemon-pins', WS)).toEqual(later);
    }
  });

  it('end to end: join by invite, pin at msg2, reload from storage, reconnect in device mode', async () => {
    const kv = createMemoryKeyValueStore();
    const daemon = new FakeDaemon();
    const keys = createDeviceKeyStore(kv);
    const pins = createDaemonPinStore(kv);
    const { keyPair } = await keys.loadOrCreate(WS);
    const pair = createMemoryTransportPair();
    await Promise.all([
      clientConnect(pair.client, {
        workspaceId: WS,
        deviceKey: keyPair,
        trust: daemon.addInvite().trust,
        hello: utf8Encode('web'),
        onDaemonVerified: (key, mode) => pins.pin(WS, key, { replace: mode === 'invite' }),
      }),
      daemon.accept(pair.daemon),
    ]);
    // "Reload": fresh store objects over the same storage.
    const reloaded = await createDeviceKeyStore(kv).load(WS);
    const pin = await createDaemonPinStore(kv).get(WS);
    expect(pin).toEqual(daemon.staticKey.publicKey);
    const again = createMemoryTransportPair();
    const [client] = await Promise.all([
      clientConnect(again.client, { workspaceId: WS, deviceKey: reloaded!.keyPair, trust: { kind: 'pinned', daemonStaticKey: pin! }, hello: utf8Encode('web') }),
      daemon.accept(again.daemon),
    ]);
    expect(client.mode).toBe('device');
  });
});
