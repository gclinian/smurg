// A TCP proxy in front of the local relay, for the smoke tests that must lose a connection the way a network does
// (R7.3: an upload cut off midway). The browser loads the app from the proxy's origin; every connection is passed through byte
// for byte, and the proxy knows which ones carry the transfer socket (the HTTP request line of the WebSocket upgrade:
// `GET /xfer/…`). `dropTransferAfter(n)` destroys the first transfer connection once n bytes went up through it —
// both sides at once, mid-stream, like a network drop — and counts what every later transfer connection sends, so a
// test can tell a resumed upload from one that started over. Loopback only; nothing is modified.
import { createServer, connect, type Server, type Socket } from 'node:net';

export interface TransferConnectionStats {
  readonly serial: number;
  /** Bytes the browser sent up through it. */
  bytesUp: number;
  /** It was cut by dropTransferAfter. */
  dropped: boolean;
  /** Opened after the drop. */
  readonly afterDrop: boolean;
}

export interface DropProxy {
  /** http://127.0.0.1:<port> */
  readonly origin: string;
  readonly port: number;
  /** Where to forward to (the relay's port); connections before it is set are refused. */
  setUpstream(port: number): void;
  /** Cut the first transfer connection once `bytes` went up through it. */
  dropTransferAfter(bytes: number): void;
  readonly transfers: readonly TransferConnectionStats[];
  /** Whether the drop happened. */
  readonly dropped: boolean;
  close(): Promise<void>;
}

export async function startDropProxy(): Promise<DropProxy> {
  let upstreamPort: number | null = null;
  let dropAt: number | null = null;
  let dropped = false;
  const transfers: TransferConnectionStats[] = [];
  const sockets = new Set<Socket>();

  const pipe = (from: Socket, to: Socket, onChunk?: (chunk: Buffer) => void): void => {
    from.on('data', (chunk: Buffer) => {
      onChunk?.(chunk);
      if (to.destroyed) return;
      if (!to.write(chunk)) {
        from.pause();
        to.once('drain', () => from.resume());
      }
    });
  };

  const server: Server = createServer((client) => {
    sockets.add(client);
    client.on('close', () => sockets.delete(client));
    if (upstreamPort === null) {
      client.destroy();
      return;
    }
    const upstream = connect(upstreamPort, '127.0.0.1');
    sockets.add(upstream);
    upstream.on('close', () => sockets.delete(upstream));
    const cut = (): void => {
      client.destroy();
      upstream.destroy();
    };
    client.on('error', cut);
    upstream.on('error', cut);
    client.on('close', cut);
    upstream.on('close', cut);

    let head = '';
    let stats: TransferConnectionStats | null | undefined;
    pipe(client, upstream, (chunk) => {
      if (stats === undefined) {
        head += chunk.toString('latin1');
        const end = head.indexOf('\r\n');
        if (end >= 0) {
          stats = / \/xfer\//.test(head.slice(0, end)) ? { serial: transfers.length, bytesUp: 0, dropped: false, afterDrop: dropped } : null;
          if (stats) transfers.push(stats);
        }
      }
      if (!stats) return;
      stats.bytesUp += chunk.length;
      if (!dropped && dropAt !== null && stats.bytesUp >= dropAt) {
        dropped = true;
        stats.dropped = true;
        // Mid-stream, both ways at once: what the browser and the relay see when the network goes away.
        setImmediate(cut);
      }
    });
    pipe(upstream, client);
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const port = (server.address() as { port: number }).port;
  return {
    origin: `http://127.0.0.1:${port}`,
    port,
    setUpstream(value) {
      upstreamPort = value;
    },
    dropTransferAfter(bytes) {
      dropAt = bytes;
    },
    get transfers() {
      return transfers;
    },
    get dropped() {
      return dropped;
    },
    close() {
      for (const socket of sockets) socket.destroy();
      return new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
