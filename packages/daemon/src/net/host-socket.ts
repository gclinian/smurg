// The daemon's WebSocket to the relay, as the relay link sees it. Production uses the `ws` package (bearer auth
// header; Node's global WebSocket would also work); tests use the in-memory relay in src/testing.
import WebSocket from 'ws';
import { MAX_RELAY_FRAME } from '@smurg/protocol';

export interface HostSocketHandlers {
  open(): void;
  /** Text frames arrive as strings, binary frames as FRESH Uint8Arrays (never reused by the socket). */
  message(data: string | Uint8Array): void;
  close(code: number, reason: string): void;
  error(error: Error): void;
  /**
   * The relay answered the upgrade with an HTTP status instead of 101 (401: the host's session token is expired or
   * invalid; 404: the workspace is not claimed). Called before close(); the socket never opened.
   */
  rejected?(status: number): void;
}

export interface HostSocket {
  readonly bufferedAmount: number;
  send(data: string | Uint8Array): void;
  /** Graceful close. */
  close(code?: number, reason?: string): void;
  /** Immediate teardown, no close handshake (after `bye`, or when the pong watchdog fired). */
  terminate(): void;
}

export type HostSocketFactory = (url: string, headers: Readonly<Record<string, string>>, handlers: HostSocketHandlers) => HostSocket;

/** `ws`-backed host sockets. perMessageDeflate is off (ciphertext does not compress). */
export function wsHostSocketFactory(): HostSocketFactory {
  return (url, headers, handlers) => {
    const ws = new WebSocket(url, { headers: { ...headers }, perMessageDeflate: false, maxPayload: MAX_RELAY_FRAME + 1024 });
    ws.on('open', () => handlers.open());
    ws.on('message', (data, isBinary) => {
      if (!isBinary) {
        handlers.message(Array.isArray(data) ? Buffer.concat(data).toString('utf8') : Buffer.from(data as ArrayBuffer).toString('utf8'));
        return;
      }
      const buffer = Array.isArray(data) ? Buffer.concat(data) : data instanceof ArrayBuffer ? Buffer.from(data) : data;
      handlers.message(new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength));
    });
    ws.on('close', (code, reason) => handlers.close(code, reason.toString('utf8')));
    ws.on('error', (err) => handlers.error(err));
    // Without this listener `ws` only reports "Unexpected server response: 401" as an error text; the link needs the
    // status to tell an expired login (stop hammering, tell the host) from a network problem.
    ws.on('unexpected-response', (_req, res) => {
      const status = res.statusCode ?? 0;
      res.resume(); // drain the body
      handlers.rejected?.(status);
      ws.terminate(); // still CONNECTING: aborts the request, then 'error' + 'close' follow
    });
    return {
      get bufferedAmount() {
        return ws.bufferedAmount;
      },
      send: (data) => {
        if (ws.readyState === WebSocket.OPEN) ws.send(data);
      },
      close: (code, reason) => {
        try {
          ws.close(code, reason);
        } catch {
          ws.terminate();
        }
      },
      terminate: () => ws.terminate(),
    };
  };
}
