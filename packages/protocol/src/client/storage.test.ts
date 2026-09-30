import { describe, expect, it } from 'vitest';
import { createMemoryKeyValueStore, createDaemonPinStore, createDeviceKeyStore } from '../browser/index.ts';
import { x25519KeyPair } from '../noise/suite.ts';
import {
  PinStoreError,
  createMemoryDeviceKeyProvider,
  createMemoryPinStore,
  createMemoryResumeStore,
  deviceKeyProviderFromStore,
  isResumeState,
  staticDeviceKeyProvider,
  type PinStore,
} from './storage.ts';

const WS = 'ws_storage_test_01';
const KEY_A = new Uint8Array(32).fill(1);
const KEY_B = new Uint8Array(32).fill(2);

describe('device key providers', () => {
  it('memory: one stable key per workspace', async () => {
    const provider = createMemoryDeviceKeyProvider();
    const a = await provider.getKeyPair(WS);
    expect(await provider.getKeyPair(WS)).toBe(a);
    expect(await provider.getKeyPair('ws_storage_test_02')).not.toBe(a);
    await expect(provider.getKeyPair('bad id')).rejects.toThrow(TypeError);
  });

  it('static: the CLI device key for every workspace', async () => {
    const keyPair = x25519KeyPair();
    const provider = staticDeviceKeyProvider(keyPair);
    expect(await provider.getKeyPair(WS)).toBe(keyPair);
    expect(() => staticDeviceKeyProvider({ publicKey: new Uint8Array(3), dh: () => new Uint8Array(32) })).toThrow(TypeError);
  });

  it('adapts the browser DeviceKeyStore (one key per workspace, async WebCrypto dh)', async () => {
    const provider = deviceKeyProviderFromStore(createDeviceKeyStore(createMemoryKeyValueStore()));
    const a = await provider.getKeyPair(WS);
    const b = await provider.getKeyPair(WS);
    expect(a.publicKey).toEqual(b.publicKey);
    const peer = x25519KeyPair();
    expect(await a.dh(peer.publicKey)).toEqual(peer.dh(a.publicKey));
  });
});

describe.each<[string, () => PinStore]>([
  ['memory PinStore', () => createMemoryPinStore()],
  ['browser DaemonPinStore (same interface)', () => createDaemonPinStore(createMemoryKeyValueStore())],
])('%s', (_name, make) => {
  it('pins, re-pins the same key, refuses a different key unless replace', async () => {
    const pins = make();
    expect(await pins.get(WS)).toBeNull();
    await pins.pin(WS, KEY_A);
    await pins.pin(WS, KEY_A);
    await expect(pins.pin(WS, KEY_B)).rejects.toMatchObject({ code: 'pin-mismatch' });
    expect(await pins.get(WS)).toEqual(KEY_A);
    await pins.pin(WS, KEY_B, { replace: true });
    expect(await pins.get(WS)).toEqual(KEY_B);
  });

  it('refuses bad arguments', async () => {
    const pins = make();
    await expect(pins.pin(WS, new Uint8Array(31))).rejects.toMatchObject({ code: 'bad-argument' });
    await expect(pins.get('../etc')).rejects.toBeDefined();
  });
});

describe('memory PinStore extras', () => {
  it('returns copies and throws PinStoreError', async () => {
    const pins = createMemoryPinStore([[WS, KEY_A]]);
    const got = await pins.get(WS);
    got?.fill(9);
    expect(await pins.get(WS)).toEqual(KEY_A);
    await expect(pins.pin(WS, KEY_B)).rejects.toBeInstanceOf(PinStoreError);
    pins.delete(WS);
    expect(await pins.get(WS)).toBeNull();
  });
});

describe('ResumeStore', () => {
  it('memory: load / save / clear', async () => {
    const store = createMemoryResumeStore();
    expect(await store.load(WS)).toBeNull();
    await store.save(WS, { channelId: 'ch_1', lastSeq: 3, nextSeq: 5 });
    expect(await store.load(WS)).toEqual({ channelId: 'ch_1', lastSeq: 3, nextSeq: 5 });
    await store.clear(WS);
    expect(await store.load(WS)).toBeNull();
  });

  it('isResumeState validates what a persistent store returns', () => {
    expect(isResumeState({ channelId: 'ch_1', lastSeq: 0, nextSeq: 1 })).toBe(true);
    expect(isResumeState({ channelId: 'ch 1', lastSeq: 0, nextSeq: 1 })).toBe(false);
    expect(isResumeState({ channelId: 'ch_1', lastSeq: -1, nextSeq: 1 })).toBe(false);
    expect(isResumeState({ channelId: 'ch_1', lastSeq: 0, nextSeq: 0 })).toBe(false);
    expect(isResumeState({ channelId: 'ch_1', lastSeq: 1.5, nextSeq: 2 })).toBe(false);
    expect(isResumeState(null)).toBe(false);
  });
});
