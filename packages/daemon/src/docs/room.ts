// One open document: the authoritative Y.Doc and ONE Awareness, keyed by the resolved file (ARCHITECTURE §7.5). The
// room is the only fan-out point (every client connection is point to point): an update from one subscriber goes to
// every other subscriber; updates the daemon makes (disk changes, reverts) go to all of them. Awareness is per room,
// because a relative position at the end of a text is encoded by type name and would resolve in any other file.
//
// Disk state (what is on disk, lockBase, autosave bookkeeping) lives here too, but every decision about it is taken
// by DiskSync and DocServiceImpl, which serialise all disk work of a room through `enqueue`.
import { DOC_TEXT_NAME, type Actor, type AwarenessUser, type FileRef } from '@smurg/protocol';
import * as awarenessProtocol from 'y-protocols/awareness';
import * as Y from 'yjs';
import type { FileIdentity, Principal, UserId } from '../core/interfaces.ts';
import { newId } from '../core/lifecycle.ts';
import type { Logger } from '../core/logger.ts';
import { encodeStep1, encodeUpdateMessage } from './sync-messages.ts';
import type { DocMeta } from './text-codec.ts';

/** Client ids one subscription may speak for (a reloaded editor gets a new Y.Doc clientID). */
export const MAX_CLIENT_IDS_PER_SUBSCRIPTION = 4;

/** Why autosave (and disk reads) of a room are paused; nothing is written until it clears. */
export type PauseReason = 'deleted' | 'unsupported' | 'outside';

export type RoomSender = (channelId: string, type: 'doc.sync' | 'doc.awareness' | 'doc.reset', payload: { docId: string; data?: Uint8Array; epoch?: string }) => void;

/** A logical channel that opened this document. Survives a resume (keyed by channelId, not the socket). */
export class Subscription {
  readonly key: string;
  readonly channelId: string;
  readonly userId: UserId;
  readonly room: DocRoom;
  /** Path-level right to edit (not read-only, not host-only for a non-host); the role is checked per message. */
  canWrite: boolean;
  readonly clientIds = new Set<number>();

  constructor(room: DocRoom, channelId: string, userId: UserId, canWrite: boolean) {
    this.key = subscriptionKey(channelId, room.id);
    this.channelId = channelId;
    this.userId = userId;
    this.room = room;
    this.canWrite = canWrite;
  }
}

export function subscriptionKey(channelId: string, docId: string): string {
  return `${channelId}\u0000${docId}`;
}

/** Transaction origin of a human edit that did not come from a subscription (doc.conflict.resolve). */
export class HumanOrigin {
  readonly userId: UserId;
  constructor(userId: UserId) {
    this.userId = userId;
  }
}

/** Transaction origin of a change read from disk; `actor` is who made it (agent, user, or system = external). */
export class DiskOrigin {
  readonly actor: Actor;
  constructor(actor: Actor) {
    this.actor = actor;
  }
}

/** Transaction origin of an accept-then-revert (agent lock race). */
export const REVERT_ORIGIN = Symbol('smurg.doc.revert');
/** Transaction origin of the initial load (no subscriber exists yet). */
export const LOAD_ORIGIN = Symbol('smurg.doc.load');

/**
 * An agent's presence in one document: a real Awareness on a throwaway Y.Doc (only for a unique clientID) whose
 * updates are forwarded into the room, which broadcasts them and includes them in every late joiner's snapshot.
 * y-protocols renews it every 15 s, so clients (which drop states after 30 s) keep showing it.
 */
export class AgentPresence {
  readonly sessionId: string;
  private readonly dummy = new Y.Doc();
  private readonly awareness: awarenessProtocol.Awareness;
  private readonly room: DocRoom;

  constructor(room: DocRoom, sessionId: string, user: AwarenessUser) {
    this.room = room;
    this.sessionId = sessionId;
    this.awareness = new awarenessProtocol.Awareness(this.dummy);
    this.awareness.on('update', ({ added, updated, removed }: AwarenessChange) => {
      const update = awarenessProtocol.encodeAwarenessUpdate(this.awareness, [...added, ...updated, ...removed]);
      awarenessProtocol.applyAwarenessUpdate(this.room.awareness, update, AGENT_AWARENESS_ORIGIN);
    });
    this.awareness.setLocalState({ user, selection: null });
  }

  get clientId(): number {
    return this.dummy.clientID;
  }

  setUser(user: AwarenessUser): void {
    this.awareness.setLocalStateField('user', user);
  }

  /** The caret at a UTF-16 index of the room's text (clamped), or no caret. */
  setCaret(index: number | null): void {
    if (index === null) {
      this.awareness.setLocalStateField('selection', null);
      return;
    }
    const clamped = Math.max(0, Math.min(index, this.room.text.length));
    const position = Y.createRelativePositionFromTypeIndex(this.room.text, clamped);
    const json = Y.relativePositionToJSON(position);
    this.awareness.setLocalStateField('selection', { anchor: json, head: json });
  }

  /** The caret at a relative position (JSON) computed elsewhere, e.g. by the compute worker on a fork of the doc. */
  setCaretRelative(position: Record<string, unknown> | null): void {
    this.awareness.setLocalStateField('selection', position === null ? null : { anchor: position, head: position });
  }

  destroy(): void {
    this.awareness.destroy(); // publishes the removal into the room first
    this.dummy.destroy();
  }
}

export const AGENT_AWARENESS_ORIGIN = Symbol('smurg.doc.agent-awareness');

interface AwarenessChange {
  readonly added: number[];
  readonly updated: number[];
  readonly removed: number[];
}

export interface DocRoomInit {
  /** Canonical reference (from the native realpath) and the realpath itself: the room's key. */
  readonly ref: FileRef;
  readonly realPath: string;
  readonly text: string;
  readonly meta: DocMeta;
  readonly hash: string;
  readonly identity: FileIdentity;
  readonly send: RoomSender;
  readonly log: Logger;
  /** Principal that loaded the file (fallback for background reads/writes). */
  readonly principal: Principal;
}

export class DocRoom {
  readonly id = newId('doc');
  readonly ref: FileRef;
  readonly realPath: string;
  epoch = newId('epoch');
  doc!: Y.Doc;
  text!: Y.Text;
  awareness!: awarenessProtocol.Awareness;
  readonly subs = new Map<string, Subscription>();
  readonly agents = new Map<string, AgentPresence>();

  // ---- disk state (see DocServiceImpl) ----
  /** The last text known to be on disk (normalised): the two-way base. */
  diskText: string;
  /** SHA-256 of the bytes last read from or written to disk: own echoes are recognised by this alone. */
  lastHash: string;
  meta: DocMeta;
  /** Identity of what was last read / written (writeFileAtomic `expect`). */
  identity: FileIdentity;
  /** The disk text when the current human edit lock was taken (null: no human lock). */
  lockBase: string | null = null;
  paused: PauseReason | null = null;
  /**
   * The pause outlasted its confirmation delay (not a `git checkout` that deletes and re-creates the file): unsaved
   * text went to the conflict panel, subscribers were told (doc.rejected), and human updates are refused until the file
   * is back.
   */
  pauseSettled = false;
  pauseTimer: NodeJS.Timeout | null = null;
  /** The text last kept as a recoverable version (conflict panel) when a pause settled. */
  recoveredText: string | null = null;
  /** Delay of the next retry after a failed read / write (grows while the file stays unreadable or unwritable). */
  retryDelayMs = 0;
  /** Unsaved human changes; `dirtySeq` counts edits so a save that raced a newer edit leaves the room dirty. */
  dirty = false;
  dirtySeq = 0;
  firstDirtyAt: number | null = null;
  saveTimer: NodeJS.Timeout | null = null;
  graceTimer: NodeJS.Timeout | null = null;
  retryTimer: NodeJS.Timeout | null = null;
  recheckQueued = false;
  /** Strongest attribution hint seen since the queued re-check was scheduled. */
  recheckHint: Actor | undefined = undefined;
  /** doc.open calls in flight for this room: the grace period must not destroy it under them. */
  holds = 0;
  /** File references this room was opened under (other spellings, links): isOpen / lockBase lookups. */
  readonly aliases = new Set<string>();
  /** Members whose edits are not on disk yet (writes use the least privileged of them). */
  readonly editors = new Map<UserId, Principal>();
  lastWritePrincipal: Principal;
  destroyed = false;
  /** Every applied Y.Doc update (delete-only ones do not move the state vector, so count them instead). */
  updates = 0;
  private queue: Promise<void> = Promise.resolve();
  private readonly send: RoomSender;
  private readonly log: Logger;

  constructor(init: DocRoomInit) {
    this.ref = init.ref;
    this.realPath = init.realPath;
    this.diskText = init.text;
    this.lastHash = init.hash;
    this.meta = init.meta;
    this.identity = init.identity;
    this.send = init.send;
    this.log = init.log;
    this.lastWritePrincipal = init.principal;
    this.createDoc(init.text);
  }

  /**
   * Runs `fn` after every earlier disk operation of this room (per-file serialised queue). A failure is logged here
   * and does not stop the queue; the returned promise still rejects, so fire-and-forget callers add `.catch(noop)`.
   */
  enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn);
    this.queue = run.then(
      () => undefined,
      (err: unknown) => {
        this.log.error('document disk operation failed', { error: err instanceof Error ? err.name : 'unknown', detail: err instanceof Error ? err.message.slice(0, 160) : null });
      },
    );
    return run;
  }

  sendStep1(sub: Subscription): void {
    this.send(sub.channelId, 'doc.sync', { docId: this.id, data: encodeStep1(this.doc) });
  }

  sendAwarenessSnapshot(sub: Subscription): void {
    const clients = [...this.awareness.getStates().keys()];
    this.send(sub.channelId, 'doc.awareness', { docId: this.id, data: awarenessProtocol.encodeAwarenessUpdate(this.awareness, clients) });
  }

  sendTo(sub: Subscription, data: Uint8Array): void {
    this.send(sub.channelId, 'doc.sync', { docId: this.id, data });
  }

  /** Whether `clientId` may be used by `sub` (binding it if free). */
  mayUseClientId(sub: Subscription, clientId: number): boolean {
    if (sub.clientIds.has(clientId)) return true;
    if (sub.clientIds.size >= MAX_CLIENT_IDS_PER_SUBSCRIPTION) return false;
    if (clientId === this.doc.clientID) return false;
    for (const other of this.subs.values()) if (other !== sub && other.clientIds.has(clientId)) return false;
    for (const agent of this.agents.values()) if (agent.clientId === clientId) return false;
    sub.clientIds.add(clientId);
    return true;
  }

  /** Drops a subscription's awareness states (peers see them leave). */
  removeAwarenessOf(sub: Subscription): void {
    if (sub.clientIds.size === 0) return;
    awarenessProtocol.removeAwarenessStates(this.awareness, [...sub.clientIds], sub);
    sub.clientIds.clear();
  }

  agentPresence(sessionId: string, user: AwarenessUser): AgentPresence {
    let presence = this.agents.get(sessionId);
    if (!presence) {
      presence = new AgentPresence(this, sessionId, user);
      this.agents.set(sessionId, presence);
    } else presence.setUser(user);
    return presence;
  }

  removeAgentPresence(sessionId: string): void {
    const presence = this.agents.get(sessionId);
    if (!presence) return;
    this.agents.delete(sessionId);
    presence.destroy();
  }

  /**
   * Replaces the Y.Doc with a fresh one holding `text` and a new epoch (doc.reset): every client drops its replica
   * and syncs again. Only for states that cannot be repaired by an edit.
   */
  reset(text: string): void {
    // Agent presences point into the old Y.Doc; they come back with the agent's next applied change.
    this.destroyDoc();
    this.epoch = newId('epoch');
    this.createDoc(text);
    for (const sub of this.subs.values()) {
      sub.clientIds.clear();
      this.send(sub.channelId, 'doc.reset', { docId: this.id, epoch: this.epoch });
      this.sendStep1(sub);
    }
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    for (const timer of [this.saveTimer, this.graceTimer, this.retryTimer, this.pauseTimer]) if (timer) clearTimeout(timer);
    this.saveTimer = this.graceTimer = this.retryTimer = this.pauseTimer = null;
    this.destroyDoc();
    this.subs.clear();
  }

  private createDoc(text: string): void {
    const doc = new Y.Doc();
    const ytext = doc.getText(DOC_TEXT_NAME);
    if (text.length > 0) doc.transact(() => ytext.insert(0, text), LOAD_ORIGIN);
    const awareness = new awarenessProtocol.Awareness(doc);
    awareness.setLocalState(null); // the daemon itself is not a participant
    doc.on('update', (update: Uint8Array, origin: unknown) => {
      this.updates += 1;
      if (this.subs.size === 0) return;
      const data = encodeUpdateMessage(update);
      for (const sub of this.subs.values()) if (sub !== origin) this.sendTo(sub, data);
    });
    awareness.on('update', ({ added, updated, removed }: AwarenessChange, origin: unknown) => {
      if (this.subs.size === 0) return;
      const changed = [...added, ...updated, ...removed];
      if (changed.length === 0) return;
      const data = awarenessProtocol.encodeAwarenessUpdate(awareness, changed);
      for (const sub of this.subs.values()) if (sub !== origin) this.send(sub.channelId, 'doc.awareness', { docId: this.id, data });
    });
    this.doc = doc;
    this.text = ytext;
    this.awareness = awareness;
  }

  private destroyDoc(): void {
    for (const agent of this.agents.values()) agent.destroy();
    this.agents.clear();
    this.awareness.destroy();
    this.doc.destroy();
  }
}
