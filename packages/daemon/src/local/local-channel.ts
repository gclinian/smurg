// The hub's channel for a host-local client of the control socket (ARCHITECTURE §7.1, §8). A relay client's channel
// is a Noise SecureChannel; here the bytes never leave the host's machine and the 0600 socket authenticates the host's
// OS account, so the channel is a plain pass-through with the same contract the hub relies on: in-order delivery of
// fresh buffers, close events exactly once, nothing sent before the owner is ready (the Welcome goes out first).
//
// What such a channel may SEND is the allow-list below (review F1, 2026-10-02), enforced by the router; what it may
// RECEIVE unasked is the second allow-list (review F-1 of the verification, 2026-10-02), enforced by the hub.
import { SmurgError, type ChannelCloseEvent, type ClientMessageType, type DaemonMessageType } from '@smurg/protocol';
import type { HubChannel } from '../core/hub.ts';

/** `detail.via` of every audit entry a local (control-socket) channel causes (core/audit.ts withAuditVia, hub, daemon). */
export const LOCAL_CHANNEL_VIA = 'control-socket';

/**
 * The ONLY client messages a local channel may send: exactly what `smurg attach` sends over the control socket
 * (`packages/cli/src/commands/attach.ts`: session.list; `attach/attach-session.ts`: session.attach, exec.input,
 * exec.resize, session.detach; `channel/local-channel.ts`: channel.ack, which the hub consumes itself). Everything else
 * — admin.* (invites, members and their roles, kicks, session terminations, settings, the audit log), merge decisions,
 * forced lock releases, session.create / session.end, suggestions, files, documents, channel.leave — is refused with
 * `forbidden` {reason: 'control-socket'} and audited (router, before the capability check).
 *
 * Why: the socket's 0600 mode authenticates the host's OS ACCOUNT, not the host. Every session runs as that account
 * (ARCHITECTURE §11 D-15), so a 「可使用 agent」 member reaches `~/.smurg/run/<short>.ctl` from any session she drives
 * and would be admitted as the host. Restricted to the attach (and to receiving what the attach consumes,
 * LOCAL_CHANNEL_RECEIVES), she gains nothing through smurg that her own role does not already give her (watch and type
 * into any session), except the PTY size of the host's own sessions (the owner's resize, which that OS account can set
 * on the pty device anyway); what the host decides stays with the host's own relay channels (the web console).
 * `smurg stop` / `smurg status` are control requests of ./protocol.ts, not channel messages: not affected.
 */
export const LOCAL_CHANNEL_TYPES: readonly ClientMessageType[] = Object.freeze([
  'channel.ack',
  'session.list',
  'session.attach',
  'session.detach',
  'exec.input',
  'exec.resize',
] as const satisfies readonly ClientMessageType[]);

const LOCAL_CHANNEL_ALLOWED: ReadonlySet<string> = new Set<string>(LOCAL_CHANNEL_TYPES);

/** Whether a local (control-socket) channel may send `type` (LOCAL_CHANNEL_TYPES). */
export function localChannelAllows(type: string): boolean {
  return LOCAL_CHANNEL_ALLOWED.has(type);
}

/**
 * The ONLY d→c messages a local channel receives besides the answers to its own requests (`X.ok` / `error` replies go
 * through the hub's reply(), unaffected): exactly what `smurg attach` consumes (`attach/attach-session.ts`:
 * exec.output, exec.resize, session.state; `channel/local-channel.ts`: channel.closed, channel.ack) plus the hub's own
 * keep-alive (presence.heartbeat) and an unsolicited `error`. The hub (core/hub.ts send / broadcast) drops every other
 * type for a local logical channel, connected or not, so nothing else is even queued for its resume: no
 * `admin.audit.entry` (the live audit log of every member), `activity.notify` / `activity.event`, `presence.state`,
 * `channel.memberUpdated`, suggestions, merges, documents or files reach whoever holds the host's OS account through
 * the socket. Same reasoning as LOCAL_CHANNEL_TYPES: fail closed in one place, not per module.
 */
export const LOCAL_CHANNEL_RECEIVES: readonly DaemonMessageType[] = Object.freeze([
  'exec.output',
  'exec.resize',
  'session.state',
  'channel.closed',
  'channel.ack',
  'presence.heartbeat',
  'error',
] as const satisfies readonly DaemonMessageType[]);

const LOCAL_CHANNEL_RECEIVED: ReadonlySet<string> = new Set<string>(LOCAL_CHANNEL_RECEIVES);

/** Whether the hub may send (or queue) `type` unasked to a local (control-socket) channel (LOCAL_CHANNEL_RECEIVES). */
export function localChannelReceives(type: string): boolean {
  return LOCAL_CHANNEL_RECEIVED.has(type);
}

/** The refusal of anything else, as the client sees it. */
export function localChannelRefusal(): SmurgError {
  return new SmurgError('forbidden', '透過這台電腦的控制 socket（smurg attach）只能列出、接上 session 和在 session 裡輸入；其他操作請在網頁上進行。', { reason: 'control-socket' });
}

export interface LocalChannelSink {
  send(bytes: Uint8Array): void;
  close(): void;
}

export class LocalChannel implements HubChannel {
  private readonly sink: LocalChannelSink;
  private messageHandler: ((message: Uint8Array) => void) | null = null;
  private readonly closeHandlers = new Set<(event: ChannelCloseEvent) => void>();
  private closeEvent: ChannelCloseEvent | null = null;
  /** Daemon messages held until open(); null once open. */
  private held: Uint8Array[] | null = [];

  constructor(sink: LocalChannelSink) {
    this.sink = sink;
  }

  get isClosed(): boolean {
    return this.closeEvent !== null;
  }

  send(message: Uint8Array): void {
    if (this.closeEvent) return;
    if (this.held) this.held.push(message);
    else this.sink.send(message);
  }

  onMessage(handler: (message: Uint8Array) => void): () => void {
    this.messageHandler = handler;
    return () => {
      if (this.messageHandler === handler) this.messageHandler = null;
    };
  }

  onClose(handler: (event: ChannelCloseEvent) => void): () => void {
    const event = this.closeEvent;
    if (event) {
      queueMicrotask(() => handler(event));
      return () => {};
    }
    this.closeHandlers.add(handler);
    return () => this.closeHandlers.delete(handler);
  }

  /** The daemon closes (stop, protocol error, the host's own kick is impossible): the socket goes too. */
  close(): void {
    if (!this.finish({ initiator: 'local' })) return;
    try {
      this.sink.close();
    } catch {
      // The socket is already gone.
    }
  }

  /** The Welcome went out: deliver what the hub queued (a resumed channel's replay) and everything after it. */
  open(): void {
    const held = this.held;
    this.held = null;
    if (!held || this.closeEvent) return;
    for (const message of held) this.sink.send(message);
  }

  /** One client Envelope from the socket. A copy: decoded byte fields alias their input buffer. */
  deliver(bytes: Uint8Array): void {
    if (this.closeEvent) return;
    this.messageHandler?.(bytes.slice());
  }

  /** The socket closed underneath. */
  remoteClosed(): void {
    this.finish({ initiator: 'remote' });
  }

  private finish(event: ChannelCloseEvent): boolean {
    if (this.closeEvent) return false;
    this.closeEvent = event;
    this.held = null;
    for (const handler of [...this.closeHandlers]) handler(event);
    this.closeHandlers.clear();
    return true;
  }
}
