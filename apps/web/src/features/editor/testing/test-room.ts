// TEST ONLY. An in-test Y.Doc server with the behaviour of the daemon's DocRoom that the web editor relies on
// (packages/daemon/src/docs/room.ts + doc-service.ts): sync step 1 and an awareness snapshot on join, fan-out of
// every update to the other subscribers, `user` of awareness states written by the server, content from members who
// may not write dropped with doc.rejected ('forbidden' / 'read-only'), apply-then-revert while an agent holds the
// lock (doc.rejected 'agent-locked'), and doc.reset (a new Y.Doc + epoch, then sync step 1).
//
// `bridgeDocs(conn, room)` answers doc.open on a FakeConnection and moves doc.* traffic both ways through `pump()`,
// in order, like the real channel: the client's notifications go to the room, the room's messages come back as
// daemon events.
import { DOC_TEXT_NAME, fileRefKey, type AwarenessUser, type FileRef, type LockInfo } from '@smurg/protocol';
import * as decoding from 'lib0/decoding';
import * as encoding from 'lib0/encoding';
import * as awarenessProtocol from 'y-protocols/awareness';
import * as syncProtocol from 'y-protocols/sync';
import * as Y from 'yjs';
import type { FakeConnection } from '../../../testing/fake-connection.ts';

type Outgoing =
  | { type: 'doc.sync' | 'doc.awareness'; payload: { docId: string; data: Uint8Array } }
  | { type: 'doc.reset'; payload: { docId: string; epoch: string } }
  | { type: 'doc.rejected'; payload: { docId: string; reason: 'agent-locked' | 'read-only' | 'forbidden'; lock?: LockInfo } };

export interface RoomMember {
  readonly id: string;
  readonly user: AwarenessUser;
  readonly canWrite: boolean;
  /** Why content is dropped when `canWrite` is false: the role ('forbidden') or the file ('read-only'). */
  readonly refusal: 'forbidden' | 'read-only';
  readonly send: (message: Outgoing) => void;
  readonly clientIds: Set<number>;
}

let roomCounter = 0;
const REVERT = Symbol('revert');

export class TestRoom {
  readonly id: string;
  readonly file: FileRef;
  epoch: string;
  doc: Y.Doc;
  awareness: awarenessProtocol.Awareness;
  agentLock: LockInfo | null = null;
  readonly members = new Map<string, RoomMember>();
  /** Every doc.sync content message a member sent that was dropped (viewer / read-only). */
  readonly dropped: string[] = [];

  constructor(file: FileRef, text: string) {
    roomCounter++;
    this.id = `doc_test_${roomCounter}`;
    this.file = file;
    this.epoch = `epoch_${roomCounter}_1`;
    this.doc = new Y.Doc();
    this.awareness = new awarenessProtocol.Awareness(this.doc);
    this.load(text);
  }

  get text(): string {
    return this.doc.getText(DOC_TEXT_NAME).toString();
  }

  private load(text: string): void {
    this.doc.getText(DOC_TEXT_NAME).insert(0, text);
    this.awareness.setLocalState(null); // the server itself is never a participant
    this.doc.on('update', (update: Uint8Array, origin: unknown) => {
      const encoder = encoding.createEncoder();
      syncProtocol.writeUpdate(encoder, update);
      const data = encoding.toUint8Array(encoder);
      for (const member of this.members.values()) {
        if (member !== origin) member.send({ type: 'doc.sync', payload: { docId: this.id, data } });
      }
    });
    this.awareness.on('update', ({ added, updated, removed }: { added: number[]; updated: number[]; removed: number[] }, origin: unknown) => {
      const changed = [...added, ...updated, ...removed];
      const data = awarenessProtocol.encodeAwarenessUpdate(this.awareness, changed);
      for (const member of this.members.values()) {
        if (member !== origin) member.send({ type: 'doc.awareness', payload: { docId: this.id, data } });
      }
    });
  }

  join(member: RoomMember): void {
    this.members.set(member.id, member);
    const encoder = encoding.createEncoder();
    syncProtocol.writeSyncStep1(encoder, this.doc);
    member.send({ type: 'doc.sync', payload: { docId: this.id, data: encoding.toUint8Array(encoder) } });
    const states = [...this.awareness.getStates().keys()];
    if (states.length > 0) member.send({ type: 'doc.awareness', payload: { docId: this.id, data: awarenessProtocol.encodeAwarenessUpdate(this.awareness, states) } });
  }

  leave(memberId: string): void {
    const member = this.members.get(memberId);
    if (!member) return;
    this.members.delete(memberId);
    awarenessProtocol.removeAwarenessStates(this.awareness, [...member.clientIds], member);
  }

  handleSync(memberId: string, data: Uint8Array): void {
    const member = this.members.get(memberId);
    if (!member) return;
    const decoder = decoding.createDecoder(data);
    const messageType = decoding.readVarUint(decoder);
    if (messageType === syncProtocol.messageYjsSyncStep1) {
      const encoder = encoding.createEncoder();
      syncProtocol.readSyncMessage(decoding.createDecoder(data), encoder, this.doc, member);
      member.send({ type: 'doc.sync', payload: { docId: this.id, data: encoding.toUint8Array(encoder) } });
      return;
    }
    const update = decoding.readVarUint8Array(decoder);
    if (isEmptyUpdate(update)) return;
    if (!member.canWrite) {
      this.dropped.push(memberId);
      member.send({ type: 'doc.rejected', payload: { docId: this.id, reason: member.refusal } });
      return;
    }
    const before = this.text;
    Y.applyUpdate(this.doc, update, member);
    if (this.agentLock !== null && this.text !== before) {
      replaceText(this.doc, before, REVERT);
      member.send({ type: 'doc.rejected', payload: { docId: this.id, reason: 'agent-locked', lock: this.agentLock } });
    }
  }

  handleAwareness(memberId: string, data: Uint8Array): void {
    const member = this.members.get(memberId);
    if (!member) return;
    // Like the daemon: keep only the selection, force `user`, bind client ids to the member.
    const decoder = decoding.createDecoder(data);
    const count = decoding.readVarUint(decoder);
    const encoder = encoding.createEncoder();
    const entries: [number, number, string][] = [];
    for (let i = 0; i < count; i++) {
      const clientId = decoding.readVarUint(decoder);
      const clock = decoding.readVarUint(decoder);
      const raw = JSON.parse(decoding.readVarString(decoder)) as Record<string, unknown> | null;
      member.clientIds.add(clientId);
      entries.push([clientId, clock, JSON.stringify(raw === null ? null : { user: member.user, selection: raw['selection'] ?? null })]);
    }
    encoding.writeVarUint(encoder, entries.length);
    for (const [clientId, clock, json] of entries) {
      encoding.writeVarUint(encoder, clientId);
      encoding.writeVarUint(encoder, clock);
      encoding.writeVarString(encoder, json);
    }
    awarenessProtocol.applyAwarenessUpdate(this.awareness, encoding.toUint8Array(encoder), member);
  }

  /** The daemon re-created the Y.Doc from `text` (new epoch): doc.reset, then sync step 1, to every member. */
  reset(text: string): void {
    this.awareness.destroy();
    this.doc.destroy();
    this.epoch = `${this.epoch}_r`;
    this.doc = new Y.Doc();
    this.awareness = new awarenessProtocol.Awareness(this.doc);
    this.load(text);
    for (const member of this.members.values()) {
      member.clientIds.clear();
      member.send({ type: 'doc.reset', payload: { docId: this.id, epoch: this.epoch } });
      const encoder = encoding.createEncoder();
      syncProtocol.writeSyncStep1(encoder, this.doc);
      member.send({ type: 'doc.sync', payload: { docId: this.id, data: encoding.toUint8Array(encoder) } });
    }
  }

  /** A change on disk applied by the daemon with an agent's origin (fans out to everyone). */
  applyExternal(text: string): void {
    replaceText(this.doc, this.text, 'agent', text);
  }

  destroy(): void {
    this.awareness.destroy();
    this.doc.destroy();
  }
}

function isEmptyUpdate(update: Uint8Array): boolean {
  // An update with no structs and an empty delete set encodes as [0, 0].
  return update.length === 2 && update[0] === 0 && update[1] === 0;
}

/** Replaces the text by a common prefix/suffix splice (enough for tests). */
function replaceText(doc: Y.Doc, current: string, origin: unknown, target?: string): void {
  const text = doc.getText(DOC_TEXT_NAME);
  const now = text.toString();
  const goal = target ?? current;
  if (now === goal) return;
  let start = 0;
  while (start < now.length && start < goal.length && now[start] === goal[start]) start++;
  let endNow = now.length;
  let endGoal = goal.length;
  while (endNow > start && endGoal > start && now[endNow - 1] === goal[endGoal - 1]) {
    endNow--;
    endGoal--;
  }
  doc.transact(() => {
    if (endNow > start) text.delete(start, endNow - start);
    if (endGoal > start) text.insert(start, goal.slice(start, endGoal));
  }, origin);
}

export interface DocsBridge {
  readonly rooms: Map<string, TestRoom>;
  /** Creates the file on the "host". */
  addFile(file: FileRef, text: string, options?: { canWrite?: boolean; meta?: { eol: 'LF' | 'CRLF' | 'CR'; bom: boolean; mixedEol: boolean } }): TestRoom;
  /** Moves every pending doc.* message both ways until nothing is left. Returns the number moved. */
  pump(): number;
  /** Forgets this connection's subscriptions (a new logical channel after a non-resumed Welcome). */
  dropChannel(): void;
  readonly member: { user: AwarenessUser };
}

/**
 * Serves doc.open / doc.close for `conn` from in-test rooms. Each FakeConnection is one member. Rooms may be shared
 * between bridges (two browsers on one file): pass the same `rooms` map.
 */
export function bridgeDocs(conn: FakeConnection, user: AwarenessUser, shared?: Map<string, TestRoom>, options: { canWrite?: boolean } = {}): DocsBridge {
  const rooms = shared ?? new Map<string, TestRoom>();
  const queue: Outgoing[] = [];
  let processed = conn.notifications.length;
  let channel = 1;
  const roomWritable = new WeakMap<TestRoom, boolean>();
  const roomMeta = new WeakMap<TestRoom, { eol: 'LF' | 'CRLF' | 'CR'; bom: boolean; mixedEol: boolean }>();
  const memberId = (): string => `${user.userId}#${channel}`;
  const memberFor = (room: TestRoom): RoomMember => ({
    id: memberId(),
    user,
    canWrite: options.canWrite !== false && (roomWritable.get(room) ?? true),
    refusal: options.canWrite === false ? 'forbidden' : 'read-only',
    send: (message) => queue.push(message),
    clientIds: new Set(),
  });
  const joinAfterReply: TestRoom[] = [];

  conn.handle('doc.open', ({ file }) => {
    const room = rooms.get(fileRefKey(file));
    if (!room) throw new Error(`no such test file ${file.path}`);
    joinAfterReply.push(room);
    const canEdit = options.canWrite !== false && (roomWritable.get(room) ?? true);
    return {
      docId: room.id,
      epoch: room.epoch,
      canEdit: canEdit && room.agentLock?.kind !== 'agent',
      ...(room.agentLock ? { lock: room.agentLock } : {}),
      meta: roomMeta.get(room) ?? { eol: 'LF', bom: false, mixedEol: false },
    };
  });

  const roomById = (docId: string): TestRoom | undefined => [...rooms.values()].find((room) => room.id === docId);

  return {
    rooms,
    member: { user },
    addFile(file, text, fileOptions = {}) {
      const room = new TestRoom(file, text);
      rooms.set(fileRefKey(file), room);
      roomWritable.set(room, fileOptions.canWrite ?? true);
      if (fileOptions.meta) roomMeta.set(room, fileOptions.meta);
      return room;
    },
    pump() {
      let moved = 0;
      for (let guard = 0; guard < 10_000; guard++) {
        const join = joinAfterReply.shift();
        if (join) {
          join.join(memberFor(join));
          moved++;
          continue;
        }
        const notification = conn.notifications[processed];
        if (notification) {
          processed++;
          moved++;
          const payload = notification.payload as { docId?: string; data?: Uint8Array };
          const room = payload.docId === undefined ? undefined : roomById(payload.docId);
          if (!room || !payload.data) {
            if (notification.type === 'doc.close' && room) room.leave(memberId());
            continue;
          }
          if (notification.type === 'doc.sync') room.handleSync(memberId(), payload.data);
          else if (notification.type === 'doc.awareness') room.handleAwareness(memberId(), payload.data);
          continue;
        }
        const out = queue.shift();
        if (out) {
          moved++;
          conn.emit(out.type, out.payload as never);
          continue;
        }
        return moved;
      }
      throw new Error('bridgeDocs.pump: message storm');
    },
    dropChannel() {
      for (const room of rooms.values()) room.leave(memberId());
      queue.length = 0;
      joinAfterReply.length = 0;
      processed = conn.notifications.length;
      channel++;
    },
  };
}

export function testUser(name: string, userId = `dev:${name.toLowerCase()}`, color = '#3b82f6'): AwarenessUser {
  return { name, color, kind: 'human', userId };
}
