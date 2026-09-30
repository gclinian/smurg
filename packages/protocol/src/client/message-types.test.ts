import { describe, expect, expectTypeOf, it } from 'vitest';
import { MAIN_ROOT } from '../schema/paths.ts';
import { MESSAGE_REGISTRY, MESSAGE_TYPES, type PayloadOf, type ResultOf } from '../schema/registry.ts';
import type { Connection } from './connection.ts';
import { isTransferTypeName, type InteractiveRequestFn, type TransferRequestFn } from './message-types.ts';
import type { TransferConnection } from './transfer.ts';
import type { ClientWebSocket, ClientWebSocketConstructor } from './websocket.ts';

describe('socket split of the message registry', () => {
  it('the name-based split used by the compile-time types matches every registry entry', () => {
    for (const type of MESSAGE_TYPES) {
      const channel = MESSAGE_REGISTRY[type].channel;
      if (channel === 'both') expect(['error', 'channel.closed']).toContain(type);
      else expect(isTransferTypeName(type), type).toBe(channel === 'transfer');
    }
  });
});

// Compile-time contract. These functions are never called: `tsc` (pnpm typecheck) is the test.
function interactiveTypes(conn: Connection): void {
  expectTypeOf(conn.request('file.tree', { root: MAIN_ROOT, path: '' })).resolves.toEqualTypeOf<ResultOf<'file.tree'>>();
  expectTypeOf(conn.request('admin.invite.create', { role: 'editor' })).resolves.toEqualTypeOf<ResultOf<'admin.invite.create'>>();
  // @ts-expect-error — transfer-channel requests are not on the interactive connection
  void conn.request('file.upload.begin', { root: MAIN_ROOT, path: 'a', size: 1, chunkSize: 1 << 22, lastModified: 0 });
  // @ts-expect-error — one-way messages are not requests
  void conn.request('exec.input', { sessionId: 's', data: new Uint8Array(1) });
  // @ts-expect-error — wrong payload shape
  void conn.request('file.tree', { root: MAIN_ROOT });
  conn.notify('exec.input', { sessionId: 's', data: new Uint8Array(1) });
  conn.notify('doc.sync', { docId: 'd', data: new Uint8Array(1) });
  // @ts-expect-error — requests are not notifications
  conn.notify('file.tree', { root: MAIN_ROOT, path: '' });
  // @ts-expect-error — channel.ack is the SDK's own business
  conn.notify('channel.ack', { upTo: 1 });
  conn.on('file.changed', (payload, meta) => {
    expectTypeOf(payload).toEqualTypeOf<PayloadOf<'file.changed'>>();
    expectTypeOf(meta.seq).toBeNumber();
  });
  conn.on('doc.sync', (payload) => expectTypeOf(payload.data).toEqualTypeOf<Uint8Array>());
  conn.on('error', (payload) => expectTypeOf(payload).toEqualTypeOf<PayloadOf<'error'>>());
  // @ts-expect-error — requests are not events
  conn.on('file.tree', () => {});
  // @ts-expect-error — transfer events are not on the interactive connection
  conn.on('file.download.chunk', () => {});
  const request: InteractiveRequestFn = (type, payload, options) => conn.request(type, payload, options);
  void request;
}

function transferTypes(xfer: TransferConnection): void {
  expectTypeOf(xfer.request('file.upload.begin', { root: MAIN_ROOT, path: 'a', size: 1, chunkSize: 1 << 22, lastModified: 0 })).resolves.toEqualTypeOf<
    ResultOf<'file.upload.begin'>
  >();
  // @ts-expect-error — interactive requests are not on the transfer connection
  void xfer.request('file.tree', { root: MAIN_ROOT, path: '' });
  xfer.notify('file.download.ack', { downloadId: 'd', index: 0 });
  // @ts-expect-error — not a transfer notification
  xfer.notify('doc.sync', { docId: 'd', data: new Uint8Array(1) });
  xfer.on('file.download.chunk', (p) => expectTypeOf(p.data).toEqualTypeOf<Uint8Array>());
  xfer.on('channel.closed', (p) => expectTypeOf(p.reason).toBeString());
  // @ts-expect-error — interactive events are not on the transfer connection
  xfer.on('file.changed', () => {});
  const request: TransferRequestFn = (type, payload, options) => xfer.request(type, payload, options);
  void request;
}

function platformSockets(browser: WebSocket): ClientWebSocket {
  // The DOM WebSocket (instance and constructor) satisfies the SDK's socket interface as is. Node's global WebSocket
  // (undici) was checked the same way under a Node-only tsconfig like the CLI's.
  const ctor: ClientWebSocketConstructor = WebSocket;
  void ctor;
  return browser;
}

describe('typed API', () => {
  it('compiles (checked by tsc, see the functions above)', () => {
    expect([interactiveTypes, transferTypes, platformSockets].every((f) => typeof f === 'function')).toBe(true);
  });
});
