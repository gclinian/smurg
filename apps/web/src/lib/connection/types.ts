// The part of the client SDK's Connection the web app uses. Everything in the app (stores, hooks, features) talks to
// this interface, never to the Connection class: the real Connection satisfies it, and so does the FakeConnection in
// src/testing/fake-connection.ts that tests drive by hand.
import type { Welcome } from '@smurg/protocol';
import type { Connection, ConnectionState, InviteTrust, RequestOptions, WaitOptions } from '@smurg/protocol/client';

export interface WorkspaceConnection {
  /** Starts connecting. Register listeners (stores) first. */
  start(): unknown;
  /** Closes for good (state `closed{local}`); pending requests fail with ClientRequestError('closed'). */
  close(): void;
  getState(): ConnectionState;
  subscribe(listener: (state: ConnectionState) => void): () => void;
  /** The Welcome of the current (or last) admission. */
  readonly welcome: Welcome | null;
  /** Every admission; `resumed = false` means: drop and reload everything. */
  onWelcome(listener: (welcome: Welcome, info: { readonly resumed: boolean }) => void): () => void;
  /** Typed request → `X.ok` payload (rejects with the daemon's SmurgError or a ClientRequestError). */
  request: Connection['request'];
  /** Typed one-way message (doc.sync, exec.input, presence.update, …). */
  notify: Connection['notify'];
  /** Typed daemon event subscription. */
  on: Connection['on'];
  whenOnline(options?: WaitOptions): Promise<Welcome>;
  /** "Leave": channel.leave, then close. */
  leave(options?: RequestOptions): Promise<void>;
}

export type { ConnectionState };

/** How a workspace connection is opened (ARCHITECTURE §4 "Client states"). */
export interface OpenOptions {
  /** From a pending invite (join flow). Without it, only a pinned daemon key can be used (device mode). */
  readonly invite?: InviteTrust | null;
  /**
   * Use the invite even though a DIFFERENT daemon key is pinned. Only after the person explicitly confirmed the new
   * link (the join page asks): the new key replaces the pin. Never set silently (noise.md gotcha 16).
   */
  readonly preferInvite?: boolean;
}

/** Builds (but does not start) the connection of one workspace. */
export type ConnectFn = (workspaceId: string, options: OpenOptions) => WorkspaceConnection;
