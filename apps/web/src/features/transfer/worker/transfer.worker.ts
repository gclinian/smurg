// The transfer Worker (ARCHITECTURE §5.2 "The browser side runs in a Web Worker"; transfer.md §1.2, noise.md §1.6).
// Loaded by the page with `new Worker(new URL('./transfer.worker.ts', import.meta.url), { type: 'module' })`.
//
// It owns its own TransferConnection: its own socket to the TransferDO and its own Noise session (never the page's
// CipherState, noise.md gotcha 6). The device key is shared with the page through the browser key store, which the
// Worker opens ITSELF (WebKit cannot post X25519 CryptoKeys to a Worker: `messageerror`, noise.md F28):
//   - the key is only LOADED, never created: the page's interactive connection registered it with the daemon, and a
//     key the daemon does not know would just be refused;
//   - pins are read-only: the transfer socket never uses an invite, so it may only confirm the daemon key that the
//     page already pinned, never replace it (fail closed).
import { equalBytes } from '@smurg/protocol';
import { createDaemonPinStore, createDeviceKeyStore, openIndexedDbKeyValueStore } from '@smurg/protocol/browser';
import { PinStoreError, RelayApi, TransferConnection, type DeviceKeyProvider, type PinStore } from '@smurg/protocol/client';
import { openIndexedDbJournal } from '../engine/journal.ts';
import { TransferManager } from '../engine/manager.ts';
import { subtleSha256 } from '../engine/source.ts';
import { sweepOpfsDownloads, workerOpfsEnv } from '../engine/writers.ts';
import { dispatchToManager, type FromWorker, type ToWorker } from './protocol.ts';

interface WorkerScope {
  readonly location: { readonly origin: string };
  postMessage(message: FromWorker): void;
  addEventListener(type: 'message', listener: (event: MessageEvent<ToWorker>) => void): void;
  close(): void;
}

const scope = globalThis as unknown as WorkerScope;
const post = (message: FromWorker): void => scope.postMessage(message);

let manager: TransferManager | null = null;
let starting: Promise<void> | null = null;
/** Messages that arrived while the Worker was still opening its storage. */
const early: ToWorker[] = [];

async function start(workspaceId: string, deviceName: string): Promise<void> {
  let kv: Awaited<ReturnType<typeof openIndexedDbKeyValueStore>>;
  try {
    kv = await openIndexedDbKeyValueStore();
  } catch (error) {
    post({ t: 'fatal', reason: 'no-indexeddb', message: error instanceof Error ? error.message : String(error) });
    return;
  }
  const devices = createDeviceKeyStore(kv);
  const pins = createDaemonPinStore(kv);
  const deviceKeys: DeviceKeyProvider = {
    async getKeyPair(id) {
      const loaded = await devices.load(id);
      if (!loaded) throw new Error('this browser has no device key for the workspace yet');
      return loaded.keyPair;
    },
  };
  const readOnlyPins: PinStore = {
    get: (id) => pins.get(id),
    async pin(id, key) {
      const current = await pins.get(id);
      if (current === null || !equalBytes(current, key)) throw new PinStoreError('pin-mismatch', 'the transfer connection never pins a new daemon key');
    },
  };
  const relay = new RelayApi({ relayUrl: scope.location.origin, auth: { kind: 'cookie' } });
  const journal = await openIndexedDbJournal().catch(() => null);
  const opfs = workerOpfsEnv();
  if (opfs) void sweepOpfsDownloads(opfs, Date.now());
  manager = new TransferManager({
    workspaceId,
    createLink: () => new TransferConnection({ relay, workspaceId, deviceKeys, pins: readOnlyPins, clientKind: 'web', deviceName }),
    journal,
    hasher: subtleSha256,
    writers: { opfs },
    emit: post,
  });
  post({ t: 'ready' });
  for (const message of early.splice(0)) dispatchToManager(manager, message);
  await manager.restore();
}

scope.addEventListener('message', (event) => {
  const message = event.data;
  if (message.t === 'init') {
    starting ??= start(message.workspaceId, message.deviceName).catch((error: unknown) => {
      post({ t: 'fatal', reason: 'init-failed', message: error instanceof Error ? error.message : String(error) });
    });
    return;
  }
  if (message.t === 'dispose') {
    void (async () => {
      await starting;
      await manager?.dispose();
      post({ t: 'disposed' });
      scope.close();
    })();
    return;
  }
  if (manager) dispatchToManager(manager, message);
  else early.push(message);
});
