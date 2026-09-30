// The WebSocket surface the client needs. The browser's WebSocket and Node >= 22's global WebSocket (undici) both
// satisfy it; tests use an in-memory fake.

export const WS_CONNECTING = 0;
export const WS_OPEN = 1;
export const WS_CLOSING = 2;
export const WS_CLOSED = 3;

export interface ClientWebSocketMessageEvent {
  readonly data: unknown;
}

export interface ClientWebSocketCloseEvent {
  readonly code: number;
  readonly reason: string;
}

export interface ClientWebSocket {
  binaryType: string;
  readonly readyState: number;
  /** Bytes queued by `send()` but not yet handed to the network (browser: a usable backpressure signal). */
  readonly bufferedAmount: number;
  /** `Uint8Array<ArrayBuffer>`: the DOM's send() takes BufferSource, which excludes SharedArrayBuffer-backed views. */
  send(data: string | Uint8Array<ArrayBuffer>): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: 'open' | 'error', listener: () => void): void;
  addEventListener(type: 'message', listener: (event: ClientWebSocketMessageEvent) => void): void;
  addEventListener(type: 'close', listener: (event: ClientWebSocketCloseEvent) => void): void;
  removeEventListener(type: 'open' | 'error', listener: () => void): void;
  removeEventListener(type: 'message', listener: (event: ClientWebSocketMessageEvent) => void): void;
  removeEventListener(type: 'close', listener: (event: ClientWebSocketCloseEvent) => void): void;
}

/**
 * A WebSocket constructor: the browser's, or Node's global one (undici). Typed with the URL only so both fit; bearer
 * auth additionally passes undici's `{ headers }` init (browsers cannot set headers on a WebSocket), see RelayApi.
 */
export type ClientWebSocketConstructor = new (url: string) => ClientWebSocket;

/** undici's extension of the WHATWG constructor. */
export type HeaderWebSocketConstructor = new (url: string, init: { headers: Record<string, string> }) => ClientWebSocket;

export type ClientWebSocketFactory = (url: string) => ClientWebSocket;

/** A view the DOM's send() accepts: the frame itself when it is ArrayBuffer-backed (always, for our frames), else a copy. */
export function sendableBytes(frame: Uint8Array): Uint8Array<ArrayBuffer> {
  return frame.buffer instanceof ArrayBuffer ? (frame as Uint8Array<ArrayBuffer>) : new Uint8Array(frame);
}

/** globalThis.WebSocket, or a clear error where there is none. */
export function globalWebSocketConstructor(): ClientWebSocketConstructor {
  const ctor = (globalThis as { WebSocket?: unknown }).WebSocket;
  if (typeof ctor !== 'function') throw new TypeError('no global WebSocket in this runtime; pass one explicitly');
  return ctor as ClientWebSocketConstructor;
}
