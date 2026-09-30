// A malicious relay for the R3 key-substitution test. It sits where the relay sits (clients talk to its origin), is
// fully functional as a relay (logins and identity tokens are forwarded to the real relay, control frames flow both
// ways), and attacks exactly where a compromised relay would: it never forwards the client's HELLO to the daemon but
// terminates the handshake itself, answering with ITS OWN static key.
//
//  - 'blind': the attacker knows what any relay knows (workspace id, connection ids), not the invite secret. It
//    re-authenticates the client's msg1 under a prologue of its own choosing (the msg1 tag's key does not depend on
//    the prologue, only its associated data does) and answers from its own transcript. This is what a real attacker
//    can do.
//  - 'leaked-invite': the worst case, the attacker somehow holds the invite secret `s`. It runs the product's own
//    responder (daemonAccept) with its own key, so the transcript is valid and only the client's check of `k`
//    (the daemon key fingerprint from the invite fragment) can stop it.
// Device-mode reconnects (a pinned daemon key) are always answered with daemonAccept and the attacker's key.
import { createServer, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  CHANNEL_FRAME,
  HandshakeState,
  buildNoisePrologue,
  concatBytes,
  daemonAccept,
  deriveInviteKeys,
  nobleSuite,
  randomBytes,
  resolveHandshakePattern,
  x25519KeyPair,
  type RawNoiseKeyPair,
  type Transport,
  type TransportCloseEvent,
} from '@smurg/protocol';
import WebSocket, { WebSocketServer } from 'ws';

export type KeySubstitution = { readonly kind: 'blind' } | { readonly kind: 'leaked-invite'; readonly secret: Uint8Array };

export interface MitmAttempt {
  mode: 'invite' | 'device' | null;
  /** Binary frames the client sent on this connection, in order. */
  readonly clientFrames: Buffer[];
  /** Binary frames the attacker sent to the client. */
  readonly attackerFrames: Buffer[];
  /** The attacker answered the HELLO with a msg2 carrying its own static key. */
  replied: boolean;
}

export interface MaliciousRelay {
  readonly origin: string;
  readonly attackerKey: RawNoiseKeyPair;
  readonly attempts: MitmAttempt[];
  close(): Promise<void>;
}

/** A Transport fed by push(): the attacker's side of one client connection. */
function pushTransport(send: (frame: Uint8Array) => void, closeSocket: () => void): Transport & { push(frame: Uint8Array): void; end(): void } {
  const handlers = new Set<(frame: Uint8Array) => void>();
  const closeHandlers = new Set<(event: TransportCloseEvent) => void>();
  const pending: Uint8Array[] = [];
  let closed = false;
  const finish = (): void => {
    if (closed) return;
    closed = true;
    for (const handler of [...closeHandlers]) handler({ code: 1000, reason: 'closed' });
  };
  return {
    push(frame) {
      if (closed) return;
      if (handlers.size === 0) pending.push(frame);
      else for (const handler of [...handlers]) handler(frame);
    },
    end: finish,
    send(frame) {
      if (!closed) send(frame);
    },
    onMessage(handler) {
      handlers.add(handler);
      for (const frame of pending.splice(0)) handler(frame);
      return () => {
        handlers.delete(handler);
      };
    },
    onClose(handler) {
      if (closed) {
        queueMicrotask(() => handler({ code: 1000, reason: 'closed' }));
        return () => {};
      }
      closeHandlers.add(handler);
      return () => {
        closeHandlers.delete(handler);
      };
    },
    close() {
      finish();
      closeSocket();
    },
  };
}

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

export async function startMaliciousRelay(options: { readonly upstream: string; readonly workspaceId: string; readonly substitution: KeySubstitution }): Promise<MaliciousRelay> {
  const attackerKey = x25519KeyPair();
  const attempts: MitmAttempt[] = [];
  const sockets = new Set<WebSocket>();
  const upstreamWs = options.upstream.replace(/^http/, 'ws');

  const server = createServer((req, res) => {
    // Plain HTTP (identity tokens, /api/me): a working relay, so the client proceeds to the handshake.
    void (async () => {
      try {
        const body = await readBody(req);
        const headers: Record<string, string> = {};
        for (const name of ['authorization', 'content-type', 'accept']) {
          const value = req.headers[name];
          if (typeof value === 'string') headers[name] = value;
        }
        const upstream = await fetch(`${options.upstream}${req.url ?? '/'}`, {
          method: req.method ?? 'GET',
          headers,
          // A Uint8Array over a plain ArrayBuffer: a valid BodyInit for both Node's and the DOM lib's fetch types.
          ...(body.length > 0 ? { body: new Uint8Array(body) } : {}),
          redirect: 'manual',
        });
        const payload = Buffer.from(await upstream.arrayBuffer());
        res.writeHead(upstream.status, { 'content-type': upstream.headers.get('content-type') ?? 'application/octet-stream' });
        res.end(payload);
      } catch {
        res.writeHead(502).end();
      }
    })();
  });

  const wss = new WebSocketServer({ noServer: true, perMessageDeflate: false });
  server.on('upgrade', (req, socket, head) => {
    wss.handleUpgrade(req, socket, head, (client) => onClient(client, req));
  });

  function onClient(client: WebSocket, req: IncomingMessage): void {
    sockets.add(client);
    const authorization = req.headers['authorization'];
    const upstream = new WebSocket(`${upstreamWs}${req.url ?? '/'}`, {
      headers: typeof authorization === 'string' ? { authorization } : {},
      perMessageDeflate: false,
    });
    sockets.add(upstream);
    const toUpstream: string[] = [];
    const attempt: MitmAttempt = { mode: null, clientFrames: [], attackerFrames: [], replied: false };
    attempts.push(attempt);
    let transport: ReturnType<typeof pushTransport> | null = null;

    const sendToClient = (frame: Uint8Array): void => {
      if (client.readyState !== WebSocket.OPEN) return;
      attempt.attackerFrames.push(Buffer.from(frame));
      if (frame[0] === CHANNEL_FRAME.REPLY) attempt.replied = true;
      client.send(frame);
    };

    upstream.on('open', () => {
      for (const text of toUpstream.splice(0)) upstream.send(text);
    });
    // Relay control (hello, host.online/offline, pong, bye) passes through; the real daemon's frames never arrive
    // because the client's HELLO never reaches it.
    upstream.on('message', (data: Buffer, isBinary: boolean) => {
      if (!isBinary && client.readyState === WebSocket.OPEN) client.send(data.toString('utf8'));
    });
    upstream.on('close', () => client.close());
    upstream.on('error', () => client.terminate());

    client.on('message', (data: Buffer, isBinary: boolean) => {
      if (!isBinary) {
        const text = data.toString('utf8');
        if (upstream.readyState === WebSocket.OPEN) upstream.send(text);
        else toUpstream.push(text);
        return;
      }
      const frame = new Uint8Array(data.byteLength);
      frame.set(data);
      attempt.clientFrames.push(Buffer.from(frame));
      if (transport) {
        transport.push(frame);
        return;
      }
      if (frame[0] !== CHANNEL_FRAME.HELLO) return;
      attempt.mode = frame[2] === 1 ? 'invite' : 'device';
      if (attempt.mode === 'invite' && options.substitution.kind === 'blind') {
        void answerBlind(frame, sendToClient);
        return;
      }
      transport = pushTransport(sendToClient, () => client.terminate());
      const leaked = options.substitution.kind === 'leaked-invite' ? [deriveInviteKeys(options.substitution.secret)] : [];
      daemonAccept(transport, {
        workspaceId: options.workspaceId,
        staticKey: attackerKey,
        suite: nobleSuite,
        invites: () => leaked,
        // Never reached: the client refuses at msg2. If it were, the attacker would learn nothing it could use.
        admit: () => ({ accept: false, payload: new Uint8Array(0) }),
      }).catch(() => undefined);
      transport.push(frame);
    });
    client.on('close', () => {
      transport?.end();
      upstream.terminate();
    });
    client.on('error', () => upstream.terminate());
  }

  /** XXpsk3 msg2 from the attacker's own transcript: msg1 re-tagged under a prologue with a guessed invite id. */
  async function answerBlind(hello: Uint8Array, send: (frame: Uint8Array) => void): Promise<void> {
    const pattern = resolveHandshakePattern('XXpsk3');
    const prologue = buildNoisePrologue(options.workspaceId, 'invite', randomBytes(16));
    const psk = randomBytes(32);
    const clientEphemeral = hello.subarray(3, 3 + 32);
    const forger = new HandshakeState({
      suite: nobleSuite,
      pattern,
      initiator: true,
      prologue,
      psks: [psk],
      e: {
        publicKey: clientEphemeral,
        dh: () => {
          throw new Error('the forger never computes a DH');
        },
      },
    });
    const forgedMsg1 = await forger.writeMessage(new Uint8Array(0));
    const responder = new HandshakeState({ suite: nobleSuite, pattern, initiator: false, prologue, psks: [psk], s: attackerKey });
    await responder.readMessage(forgedMsg1);
    const msg2 = await responder.writeMessage(new Uint8Array(0));
    send(concatBytes(new Uint8Array([CHANNEL_FRAME.REPLY]), msg2));
  }

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const { port } = server.address() as AddressInfo;

  return {
    origin: `http://127.0.0.1:${port}`,
    attackerKey,
    attempts,
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.terminate();
        wss.close();
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}
