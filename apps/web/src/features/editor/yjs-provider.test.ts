import { DOC_TEXT_NAME, MAIN_ROOT } from '@smurg/protocol';
import * as awarenessProtocol from 'y-protocols/awareness';
import * as Y from 'yjs';
import { afterEach, describe, expect, it } from 'vitest';
import { TestRoom, testUser, type RoomMember } from './testing/test-room.ts';
import { EnvelopeYjsProvider, type DocTransport, type ProviderEvent } from './yjs-provider.ts';

/** Queued delivery, like a network: nothing arrives until flush(). */
class Net {
  private readonly queue: (() => void)[] = [];
  post(task: () => void): void {
    this.queue.push(task);
  }
  flush(): void {
    for (let guard = 0; this.queue.length > 0; guard++) {
      if (guard > 100_000) throw new Error('message storm');
      this.queue.shift()?.();
    }
  }
}

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

interface Client {
  readonly doc: Y.Doc;
  readonly awareness: awarenessProtocol.Awareness;
  readonly text: Y.Text;
  provider: EnvelopeYjsProvider;
  readonly sent: { kind: 'sync' | 'awareness'; data: Uint8Array }[];
  readonly events: ProviderEvent[];
  goOffline(): void;
  reconnect(): void;
}

/** A client of `room` over point-to-point queued channels (one member per client). */
function connect(net: Net, room: TestRoom, name: string, options: { canWrite?: boolean } = {}): Client {
  const id = `${name}-conn`;
  let online = true;
  const handlers = new Map<string, { sync(data: Uint8Array): void; awareness(data: Uint8Array): void }>();
  const member: RoomMember = {
    id,
    user: testUser(name),
    canWrite: options.canWrite !== false,
    refusal: 'forbidden',
    clientIds: new Set(),
    send: (message) =>
      net.post(() => {
        if (!online || message.type === 'doc.reset' || message.type === 'doc.rejected') return;
        const handler = handlers.get(message.payload.docId);
        if (message.type === 'doc.sync') handler?.sync(message.payload.data);
        else handler?.awareness(message.payload.data);
      }),
  };
  const sent: Client['sent'] = [];
  const transport: DocTransport = {
    onDocMessages(docId, handler) {
      handlers.set(docId, handler);
      return () => {
        if (handlers.get(docId) === handler) handlers.delete(docId);
      };
    },
    sendSync(_docId, data) {
      sent.push({ kind: 'sync', data });
      net.post(() => online && room.handleSync(id, data));
    },
    sendAwareness(_docId, data) {
      sent.push({ kind: 'awareness', data });
      net.post(() => online && room.handleAwareness(id, data));
    },
  };
  const doc = new Y.Doc();
  const awareness = new awarenessProtocol.Awareness(doc);
  const events: ProviderEvent[] = [];
  room.join(member);
  const client: Client = {
    doc,
    awareness,
    text: doc.getText(DOC_TEXT_NAME),
    provider: new EnvelopeYjsProvider(room.id, doc, awareness, transport),
    sent,
    events,
    goOffline() {
      online = false;
      room.leave(id);
      client.provider.disconnect();
    },
    reconnect() {
      online = true;
      // A new channel: a new provider on the SAME Y.Doc and Awareness (what DocSession does).
      client.provider.destroy();
      client.provider = new EnvelopeYjsProvider(room.id, doc, awareness, transport);
      client.provider.on((event) => events.push(event));
      room.join(member);
      client.provider.connect();
    },
  };
  client.provider.on((event) => events.push(event));
  client.provider.connect();
  cleanups.push(() => {
    client.provider.destroy();
    awareness.destroy();
    doc.destroy();
  });
  return client;
}

function newRoom(text: string): TestRoom {
  const room = new TestRoom({ root: MAIN_ROOT, path: 'src/app.ts' }, text);
  cleanups.push(() => room.destroy());
  return room;
}

const FILE = 'const greeting = "你好";\nconsole.log(greeting) // 🙂\n';

describe('EnvelopeYjsProvider over the doc.* channel', () => {
  it('two providers against one in-test Y.Doc server converge, including CJK and emoji', () => {
    const net = new Net();
    const room = newRoom(FILE);
    const amy = connect(net, room, 'Amy');
    const bob = connect(net, room, 'Bob');
    net.flush();
    expect(amy.provider.synced).toBe(true);
    expect(bob.provider.synced).toBe(true);
    expect(amy.text.toString()).toBe(FILE);
    expect(bob.text.toString()).toBe(FILE);

    // Concurrent edits, before either side hears of the other: CJK, emoji, a ZWJ family and CJK Ext-B.
    amy.text.insert(0, '// 艾咪在這裡 👩‍👩‍👧\n');
    bob.text.insert(bob.text.length, '// 鮑伯 ✅ 𠮷野家\n');
    amy.text.insert(amy.text.toString().indexOf('你好') + 2, '，世界🌏');
    bob.text.delete(bob.text.toString().indexOf('console'), 'console.'.length);
    net.flush();

    const expected = room.text;
    expect(amy.text.toString()).toBe(expected);
    expect(bob.text.toString()).toBe(expected);
    expect(expected).toContain('// 艾咪在這裡 👩‍👩‍👧\n');
    expect(expected).toContain('"你好，世界🌏"');
    expect(expected).toContain('log(greeting) // 🙂');
    expect(expected).toContain('// 鮑伯 ✅ 𠮷野家\n');
    expect(expected).not.toContain('\ufffd');
    // Each keystroke-sized edit travels as one small update, not as the document.
    const updates = amy.sent.filter((m) => m.kind === 'sync').map((m) => m.data.byteLength);
    expect(Math.max(...updates)).toBeLessThan(200);
  });

  it('a late joiner receives the text exactly once (step 1 / step 2), never a second copy', () => {
    const net = new Net();
    const room = newRoom(FILE);
    const amy = connect(net, room, 'Amy');
    net.flush();
    amy.text.insert(0, '一');
    net.flush();
    const late = connect(net, room, 'Late');
    net.flush();
    expect(late.text.toString()).toBe(`一${FILE}`);
    expect(late.events.filter((e) => e.type === 'synced')).toHaveLength(1);
  });

  it('offline edits merge through step 1 / step 2 when a new provider reconnects the same Y.Doc', () => {
    const net = new Net();
    const room = newRoom(FILE);
    const amy = connect(net, room, 'Amy');
    const bob = connect(net, room, 'Bob');
    net.flush();
    amy.goOffline();
    net.flush();
    amy.text.insert(0, '/* 離線時寫的 */\n');
    bob.text.insert(bob.text.length, '// 線上 🟢\n');
    net.flush();
    expect(room.text).not.toContain('離線時寫的');
    amy.reconnect();
    net.flush();
    const expected = `/* 離線時寫的 */\n${FILE}// 線上 🟢\n`;
    expect(room.text).toBe(expected);
    expect(amy.text.toString()).toBe(expected);
    expect(bob.text.toString()).toBe(expected);
    // The reconnect announced 'synced' again: whoever binds must guard (DocSession binds once per replica).
    expect(amy.events.filter((e) => e.type === 'synced')).toHaveLength(2);
  });

  it('presence: remote states arrive with the server-written user; only our own client id is ever published', () => {
    const net = new Net();
    const room = newRoom(FILE);
    const amy = connect(net, room, 'Amy');
    const bob = connect(net, room, 'Bob');
    net.flush();
    amy.awareness.setLocalStateField('selection', {
      anchor: Y.createRelativePositionFromTypeIndex(amy.text, 3),
      head: Y.createRelativePositionFromTypeIndex(amy.text, 5),
    });
    // A stale remote state in Amy's awareness must never be re-published by Amy.
    net.flush();
    const seen = bob.awareness.getStates().get(amy.doc.clientID) as { user: { name: string }; selection: { head: unknown } };
    expect(seen.user.name).toBe('Amy');
    const head = Y.createAbsolutePositionFromRelativePosition(Y.createRelativePositionFromJSON(seen.selection.head), bob.doc);
    expect(head?.index).toBe(5);
    for (const message of amy.sent.filter((m) => m.kind === 'awareness')) {
      const decoded = new Y.Doc();
      const probe = new awarenessProtocol.Awareness(decoded);
      awarenessProtocol.applyAwarenessUpdate(probe, message.data, 'probe');
      expect([...probe.getStates().keys()].filter((id) => id !== decoded.clientID)).toEqual([amy.doc.clientID]);
      probe.destroy();
      decoded.destroy();
    }
  });

  it('disconnect() drops other people’s presence; connect() re-announces ours with a newer clock', () => {
    const net = new Net();
    const room = newRoom(FILE);
    const amy = connect(net, room, 'Amy');
    const bob = connect(net, room, 'Bob');
    net.flush();
    expect(amy.awareness.getStates().has(bob.doc.clientID)).toBe(true);
    const clockBefore = amy.awareness.meta.get(amy.doc.clientID)?.clock ?? 0;
    amy.goOffline();
    net.flush();
    expect(amy.awareness.getStates().has(bob.doc.clientID)).toBe(false);
    expect(bob.awareness.getStates().has(amy.doc.clientID)).toBe(false);
    amy.reconnect();
    net.flush();
    expect(amy.awareness.meta.get(amy.doc.clientID)?.clock ?? 0).toBeGreaterThan(clockBefore);
    expect(bob.awareness.getStates().has(amy.doc.clientID)).toBe(true);
    expect(amy.awareness.getStates().has(bob.doc.clientID)).toBe(true);
  });

  it('destroy() sends nothing (the daemon has forgotten the subscription) and leaves the Y.Doc usable', () => {
    const net = new Net();
    const room = newRoom(FILE);
    const amy = connect(net, room, 'Amy');
    net.flush();
    const before = amy.sent.length;
    amy.provider.destroy();
    amy.text.insert(0, 'x');
    amy.awareness.setLocalStateField('selection', null);
    net.flush();
    expect(amy.sent.length).toBe(before);
    expect(amy.text.toString()).toBe(`x${FILE}`);
    expect(room.text).toBe(FILE);
  });

  it('a sync message that cannot be read is reported (receive-failed) instead of throwing into the channel', () => {
    const doc = new Y.Doc();
    const awareness = new awarenessProtocol.Awareness(doc);
    let deliver: ((data: Uint8Array) => void) | null = null;
    const transport: DocTransport = {
      onDocMessages: (_docId, handler) => {
        deliver = handler.sync;
        return () => {};
      },
      sendSync: () => {},
      sendAwareness: () => {},
    };
    const provider = new EnvelopeYjsProvider('doc_x', doc, awareness, transport);
    const events: ProviderEvent[] = [];
    provider.on((event) => events.push(event));
    provider.connect();
    // An unknown sync message type (a corrupt update inside a known type is dropped by Yjs itself).
    expect(() => deliver?.(new Uint8Array([9, 1]))).not.toThrow();
    expect(events.map((e) => e.type)).toEqual(['receive-failed']);
    provider.destroy();
    awareness.destroy();
    doc.destroy();
  });

  it('a local change that cannot be sent is reported (send-failed): the daemon did not get it', () => {
    const doc = new Y.Doc();
    const awareness = new awarenessProtocol.Awareness(doc);
    let failSync = false;
    const transport: DocTransport = {
      onDocMessages: () => () => {},
      sendSync: () => {
        if (failSync) throw new Error('closed');
      },
      sendAwareness: () => {
        throw new Error('awareness is best effort');
      },
    };
    const provider = new EnvelopeYjsProvider('doc_y', doc, awareness, transport);
    const events: ProviderEvent[] = [];
    provider.on((event) => events.push(event));
    provider.connect();
    failSync = true;
    expect(() => doc.getText(DOC_TEXT_NAME).insert(0, '字')).not.toThrow();
    expect(events.map((e) => e.type)).toEqual(['send-failed']);
    provider.destroy();
    awareness.destroy();
    doc.destroy();
  });

  it('refuses an Awareness of another Y.Doc (cursors would resolve against the wrong text)', () => {
    const doc = new Y.Doc();
    const other = new Y.Doc();
    const awareness = new awarenessProtocol.Awareness(other);
    const transport: DocTransport = { onDocMessages: () => () => {}, sendSync: () => {}, sendAwareness: () => {} };
    expect(() => new EnvelopeYjsProvider('doc_z', doc, awareness, transport)).toThrow(/same Y.Doc/);
    awareness.destroy();
    doc.destroy();
    other.destroy();
  });
});
