// The key storage as the page uses it: one device key per workspace and the pin of the host's key, on the browser's
// key-value store. Here the store is the protocol package's in-memory one (IndexedDB's copy semantics).
import { describe, expect, it } from 'vitest';
import { DAEMON_PIN_STORE, DEVICE_KEY_STORE, createMemoryKeyValueStore } from '@smurg/protocol/browser';
import { WORKSPACE_ID } from '../../testing/fixtures.ts';
import { createBrowserConnectionDeps } from './browser-deps.ts';

function depsOn(kv: ReturnType<typeof createMemoryKeyValueStore>) {
  return createBrowserConnectionDeps({ origin: 'https://app.smurg.test', userAgent: 'test', openKeyValueStore: () => Promise.resolve(kv) });
}

describe("the browser's keys", () => {
  it('a first visit makes a key, later visits get the same one, and nothing is said about a newer page', async () => {
    const kv = createMemoryKeyValueStore();
    const deps = depsOn(kv);
    expect(deps.keyStorage.getState()).toEqual({ persistent: null, newerRecord: false });
    const first = await deps.deviceKeys.getKeyPair(WORKSPACE_ID);
    expect(deps.keyStorage.getState()).toEqual({ persistent: true, newerRecord: false });
    expect((await depsOn(kv).deviceKeys.getKeyPair(WORKSPACE_ID)).publicKey).toEqual(first.publicKey);
    expect(await deps.pins.get(WORKSPACE_ID)).toBeNull();
  });

  it('a device key a newer page wrote: no key is handed out, the record stays, and the page knows why', async () => {
    const kv = createMemoryKeyValueStore();
    const later = { v: 2, createdAt: 5, record: { kind: 'later' } };
    await kv.put(DEVICE_KEY_STORE, WORKSPACE_ID, later);
    const deps = depsOn(kv);
    await expect(deps.deviceKeys.getKeyPair(WORKSPACE_ID)).rejects.toMatchObject({ code: 'newer-record' });
    expect(deps.keyStorage.getState()).toEqual({ persistent: true, newerRecord: true });
    expect(await kv.get(DEVICE_KEY_STORE, WORKSPACE_ID)).toEqual(later);
  });

  it("a pin of the host's key a newer page wrote: reading and pinning stop, the pin stays, and the page knows why", async () => {
    const kv = createMemoryKeyValueStore();
    const later = { v: 2, keys: ['a pin in a later shape'], pinnedAt: 7 };
    await kv.put(DAEMON_PIN_STORE, WORKSPACE_ID, later);
    const reading = depsOn(kv);
    await expect(reading.pins.get(WORKSPACE_ID)).rejects.toMatchObject({ code: 'newer-record' });
    expect(reading.keyStorage.getState().newerRecord).toBe(true);
    const pinning = depsOn(kv);
    await expect(pinning.pins.pin(WORKSPACE_ID, new Uint8Array(32).fill(9), { replace: true })).rejects.toMatchObject({ code: 'newer-record' });
    expect(pinning.keyStorage.getState().newerRecord).toBe(true);
    expect(await kv.get(DAEMON_PIN_STORE, WORKSPACE_ID)).toEqual(later);
  });

  it('any other storage failure is not blamed on a newer page', async () => {
    const kv = createMemoryKeyValueStore();
    await kv.put(DAEMON_PIN_STORE, WORKSPACE_ID, { v: 1, key: new Uint8Array(3), pinnedAt: 0 });
    const deps = depsOn(kv);
    await expect(deps.pins.get(WORKSPACE_ID)).rejects.toMatchObject({ code: 'corrupt-record' });
    expect(deps.keyStorage.getState().newerRecord).toBe(false);
  });
});
