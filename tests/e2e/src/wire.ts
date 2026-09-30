// What every socket of the stack put on, and took off, the wire: the daemon's host sockets (through the host-link
// gate) and each client's relay WebSocket. The R3 completeness check compares this with the relay's byte tap: every
// frame sent must have been recorded by the relay, and the relay must have recorded nothing that nobody sent.
import { createHash } from 'node:crypto';
import type { ClientWebSocketConstructor } from '@smurg/protocol/client';

export type WireSide = 'host' | 'client';
export type WireDirection = 'sent' | 'received';

export interface WireFrame {
  readonly side: WireSide;
  /** 'ws' | 'xfer' for host sockets; the client's name for client sockets. */
  readonly label: string;
  /** Serial number of the socket (per WireLog). */
  readonly socket: number;
  readonly direction: WireDirection;
  readonly kind: 'binary' | 'text';
  readonly data: Buffer;
  readonly at: number;
}

export class WireLog {
  private readonly items: WireFrame[] = [];
  private serial = 0;

  nextSocket(): number {
    return ++this.serial;
  }

  record(frame: Omit<WireFrame, 'at'>): void {
    this.items.push({ ...frame, at: Date.now() });
  }

  /** Snapshot. */
  frames(filter: Partial<Pick<WireFrame, 'side' | 'direction' | 'kind' | 'label'>> = {}): WireFrame[] {
    return this.items.filter(
      (f) =>
        (filter.side === undefined || f.side === filter.side) &&
        (filter.direction === undefined || f.direction === filter.direction) &&
        (filter.kind === undefined || f.kind === filter.kind) &&
        (filter.label === undefined || f.label === filter.label),
    );
  }

  get size(): number {
    return this.items.length;
  }
}

/** Identity of a frame's bytes, for multiset comparisons. */
export function frameKey(data: Buffer): string {
  return `${data.length}:${createHash('sha256').update(data).digest('base64')}`;
}

export function countKeys(buffers: readonly Buffer[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const buffer of buffers) {
    const key = frameKey(buffer);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

/** Frames of `needles` (as a multiset) that `haystack` does not contain. */
export function missingFrom(haystack: readonly Buffer[], needles: readonly Buffer[]): Buffer[] {
  const available = countKeys(haystack);
  const missing: Buffer[] = [];
  for (const needle of needles) {
    const key = frameKey(needle);
    const left = available.get(key) ?? 0;
    if (left > 0) available.set(key, left - 1);
    else missing.push(needle);
  }
  return missing;
}

function toBuffer(data: unknown): Buffer | null {
  if (typeof data === 'string') return Buffer.from(data, 'utf8');
  if (data instanceof ArrayBuffer) return Buffer.from(new Uint8Array(data.slice(0)));
  if (ArrayBuffer.isView(data)) return Buffer.from(new Uint8Array(data.buffer, data.byteOffset, data.byteLength).slice());
  return null;
}

/**
 * Node's global WebSocket (undici, the one the client SDK uses in bearer mode), recording every frame it sends while
 * open and every frame it receives. Passed to RelayApi as `WebSocket`.
 */
export function recordingWebSocket(log: WireLog, label: string): ClientWebSocketConstructor {
  const Base = globalThis.WebSocket;
  class RecordingWebSocket extends Base {
    private readonly serial: number;

    constructor(url: string, init?: unknown) {
      // undici accepts `{ headers }` as its second argument; RelayApi passes it in bearer mode.
      super(url, init as ConstructorParameters<typeof WebSocket>[1]);
      this.serial = log.nextSocket();
      this.addEventListener('message', (event: MessageEvent) => {
        const data = toBuffer(event.data);
        if (!data) return;
        log.record({ side: 'client', label, socket: this.serial, direction: 'received', kind: typeof event.data === 'string' ? 'text' : 'binary', data });
      });
    }

    // The base class's own parameter type: with the DOM lib in the program (@xterm typings reference it) it is
    // narrower than Node's (ArrayBufferView<ArrayBuffer>), and an override must accept what the base accepts.
    override send(data: Parameters<InstanceType<typeof Base>['send']>[0]): void {
      if (this.readyState === Base.OPEN) {
        const bytes = toBuffer(data);
        if (bytes) log.record({ side: 'client', label, socket: this.serial, direction: 'sent', kind: typeof data === 'string' ? 'text' : 'binary', data: bytes });
      }
      super.send(data);
    }
  }
  return RecordingWebSocket as unknown as ClientWebSocketConstructor;
}
