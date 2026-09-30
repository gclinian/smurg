// Awareness validation (ARCHITECTURE §7.5, yjs-monaco.md V5) and sync-message parsing, below the wire. The wire-level
// "malformed awareness never reaches peers" test is in doc-security.test.ts.
import { describe, expect, it } from 'vitest';
import * as encoding from 'lib0/encoding';
import * as awarenessProtocol from 'y-protocols/awareness';
import * as Y from 'yjs';
import { encodeAwarenessEntries, filterAwarenessUpdate } from '../../src/docs/awareness-filter.ts';
import { encodeStep1, isEmptyUpdate, parseSyncMessage } from '../../src/docs/sync-messages.ts';

const USER = { name: 'Amy', color: '#112233', kind: 'human' as const, userId: 'dev:amy' };

function rawUpdate(entries: readonly { clientId: number; clock: number; json: string }[]): Uint8Array {
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, entries.length);
  for (const entry of entries) {
    encoding.writeVarUint(encoder, entry.clientId);
    encoding.writeVarUint(encoder, entry.clock);
    encoding.writeVarString(encoder, entry.json);
  }
  return encoding.toUint8Array(encoder);
}

describe('filterAwarenessUpdate', () => {
  it('drops every selection that would make Yjs throw on a peer (V5 payloads), keeps valid ones normalised', () => {
    const doc = new Y.Doc();
    doc.getText('content').insert(0, 'hello');
    const valid = Y.relativePositionToJSON(Y.createRelativePositionFromTypeIndex(doc.getText('content'), 2));
    const bad = [
      { item: { client: 1, clock: -5 } },
      { item: {} },
      { item: null, tname: null },
      { item: { client: 1, clock: '3' } },
      { type: { client: 1, clock: 0 }, item: { client: 1, clock: 0 } },
      { tname: 'other-text' },
      'not an object',
      { item: { client: 1, clock: 0 }, extra: true },
    ];
    for (const position of bad) {
      const data = rawUpdate([{ clientId: 7, clock: 1, json: JSON.stringify({ selection: { anchor: position, head: position } }) }]);
      const result = filterAwarenessUpdate(data, USER, () => true);
      expect(result.entries).toHaveLength(0);
      expect(result.dropped[0]?.reason).toBe('selection');
    }
    const ok = filterAwarenessUpdate(rawUpdate([{ clientId: 7, clock: 1, json: JSON.stringify({ selection: { anchor: valid, head: valid } }) }]), USER, () => true);
    expect(ok.entries).toHaveLength(1);
    const state = ok.entries[0]?.state;
    expect(state?.user).toEqual(USER);
    // Normalised through Yjs: every field present, and it resolves on a real doc.
    const anchor = Y.createRelativePositionFromJSON(state?.selection?.anchor);
    expect(Y.createAbsolutePositionFromRelativePosition(anchor, doc)?.index).toBe(2);
  });

  it('overwrites the claimed user, drops unknown client ids and malformed JSON, keeps removals (null state)', () => {
    const data = rawUpdate([
      { clientId: 1, clock: 3, json: JSON.stringify({ user: { name: 'Host', color: '#000000', kind: 'agent' }, selection: null }) },
      { clientId: 2, clock: 1, json: '{not json' },
      { clientId: 3, clock: 1, json: JSON.stringify({ selection: null }) },
      { clientId: 1, clock: 4, json: 'null' },
      { clientId: 4, clock: 1, json: '[1,2]' },
    ]);
    const result = filterAwarenessUpdate(data, USER, (id) => id !== 3);
    expect(result.entries.map((e) => [e.clientId, e.clock, e.state?.user.name ?? null])).toEqual([
      [1, 3, 'Amy'],
      [1, 4, null],
    ]);
    expect(result.dropped.map((d) => [d.clientId, d.reason])).toEqual([
      [2, 'malformed-state'],
      [3, 'client-id'],
      [4, 'malformed-state'],
    ]);
  });

  it('re-encodes in the y-protocols format and throws on garbage', () => {
    const result = filterAwarenessUpdate(rawUpdate([{ clientId: 9, clock: 2, json: '{}' }]), USER, () => true);
    const doc = new Y.Doc();
    const awareness = new awarenessProtocol.Awareness(doc);
    awarenessProtocol.applyAwarenessUpdate(awareness, encodeAwarenessEntries(result.entries), 'test');
    expect(awareness.getStates().get(9)).toEqual({ user: USER, selection: null });
    awareness.destroy();
    expect(() => filterAwarenessUpdate(Uint8Array.of(5, 1), USER, () => true)).toThrow();
    expect(() => filterAwarenessUpdate(rawUpdate(Array.from({ length: 17 }, (_, i) => ({ clientId: i, clock: 1, json: '{}' }))), USER, () => true)).toThrow();
  });
});

describe('sync messages', () => {
  it('parses the three y-protocols message types and recognises an empty update', () => {
    const doc = new Y.Doc();
    expect(parseSyncMessage(encodeStep1(doc)).kind).toBe('step1');
    const update = Y.encodeStateAsUpdate(doc);
    expect(isEmptyUpdate(update)).toBe(true);
    doc.getText('content').insert(0, 'x');
    expect(isEmptyUpdate(Y.encodeStateAsUpdate(doc))).toBe(false);
    // A delete-only update carries no structs but a delete set: not empty.
    const before = Y.encodeStateVector(doc);
    const peer = new Y.Doc();
    Y.applyUpdate(peer, Y.encodeStateAsUpdate(doc));
    peer.getText('content').delete(0, 1);
    expect(isEmptyUpdate(Y.encodeStateAsUpdate(peer, before))).toBe(false);
    expect(() => parseSyncMessage(Uint8Array.of(7, 0))).toThrow();
    expect(() => parseSyncMessage(Uint8Array.of(0, 5, 1))).toThrow();
  });
});
