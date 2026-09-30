// SPEC R7.1: two people edit the same file at the same time through the real daemon (real invites, real Noise
// channels over the in-memory relay, the real client SDK), each with their own Y.Doc, like two browsers.
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { MAIN_ROOT } from '@smurg/protocol';
import * as Y from 'yjs';
import { createDocsModule } from '../../src/docs/module.ts';
import { createTestDaemon, waitFor, type TestDaemon } from '../../src/testing/index.ts';
import { DocClient, FakeLockManager, destroyDocClients, fakeLocksModule, safeIndex, sleep } from './helpers.ts';

let t: TestDaemon | null = null;

afterEach(async () => {
  try {
    destroyDocClients();
  } finally {
    await t?.cleanup();
    t = null;
  }
});

/** Deterministic PRNG (a failing run can be replayed). */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

const TOKENS = ['a', 'b', 'z', ' ', '中', '文', '字', '界', '編', '😀', '🎉', '👍🏽', '𠮷', '\n'];

function codePointCounts(text: string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const cp of text) counts.set(cp, (counts.get(cp) ?? 0) + 1);
  return counts;
}

function isSubsequence(needle: string, haystack: string): boolean {
  const n = [...needle];
  let i = 0;
  for (const cp of haystack) if (i < n.length && cp === n[i]) i++;
  return i === n.length;
}

describe('R7 編輯器與檔案', { timeout: 30_000 }, () => {
  it('兩個人同時編輯同一個檔案，雙方 1 秒內看到對方的修改，不遺失任何字元', async () => {
    const initial = '第一行 first line\n第二行 😀 second line\n第三行 third\n';
    t = await createTestDaemon({ project: { files: { 'notes/shared.md': initial } }, modules: [fakeLocksModule(new FakeLockManager()), createDocsModule()] });
    const amyConn = await t.connect({ userId: 'dev:amy', displayName: 'Amy', role: 'editor' });
    const bobConn = await t.connect({ userId: 'dev:bob', displayName: 'Bob', role: 'editor' });
    const file = { root: MAIN_ROOT, path: 'notes/shared.md' };
    const amy = await DocClient.open(amyConn.conn, file);
    const bob = await DocClient.open(bobConn.conn, file);
    expect(amy.docId).toBe(bob.docId);
    await waitFor(() => amy.synced && bob.synced, { what: 'initial sync' });
    expect(amy.text.toString()).toBe(initial);
    expect(bob.text.toString()).toBe(initial);

    // 1. Latency: each side sees the other's edit within 1 s (several samples, both directions).
    const latencies: number[] = [];
    for (let i = 0; i < 6; i++) {
      const [writer, reader] = i % 2 === 0 ? [amy, bob] : [bob, amy];
      const marker = `〔${i}號〕`;
      const start = performance.now();
      writer.text.insert(writer.text.length, marker);
      await waitFor(() => reader.text.toString().includes(marker), { timeoutMs: 1_000, what: `marker ${i} within 1 s` });
      latencies.push(performance.now() - start);
    }
    console.log(`R7.1 latency (ms): ${latencies.map((l) => l.toFixed(1)).join(', ')}`);
    expect(Math.max(...latencies)).toBeLessThan(1_000);

    // 2. Concurrent typing at random positions (CJK, emoji, surrogate pairs), both people at once.
    const beforeTyping = amy.text.toString();
    expect(bob.text.toString()).toBe(beforeTyping);
    const baseState = Y.encodeStateAsUpdate(amy.doc);
    const localUpdates: Uint8Array[] = [];
    for (const client of [amy, bob]) {
      client.doc.on('update', (update: Uint8Array, origin: unknown) => {
        if (origin !== client) localUpdates.push(update); // typed locally (remote ones carry the client as origin)
      });
    }
    const inserted: string[] = [];
    const type = async (client: DocClient, seed: number): Promise<void> => {
      const next = rng(seed);
      for (let i = 0; i < 80; i++) {
        const token = TOKENS[Math.floor(next() * TOKENS.length)] as string;
        const current = client.text.toString();
        const at = safeIndex(current, Math.floor(next() * (current.length + 1)));
        client.text.insert(at, token);
        inserted.push(token);
        if (next() < 0.4) await sleep(Math.floor(next() * 6));
      }
    };
    await Promise.all([type(amy, 1), type(bob, 2)]);
    await waitFor(() => amy.text.toString() === bob.text.toString() && amy.text.length === beforeTyping.length + inserted.join('').length, {
      timeoutMs: 5_000,
      what: 'both replicas to converge',
    });
    const final = amy.text.toString();
    // No character lost: exactly the original characters plus every inserted one, the original still in order.
    const expected = codePointCounts(beforeTyping + inserted.join(''));
    expect(codePointCounts(final)).toEqual(expected);
    expect(isSubsequence(beforeTyping, final)).toBe(true);
    expect(/[\ud800-\udbff](?![\udc00-\udfff])/.test(final)).toBe(false);
    // …and it IS the merge of all inserts: both people's updates merged independently of the daemon give the same text.
    const independent = new Y.Doc();
    Y.applyUpdate(independent, baseState);
    for (const update of localUpdates) Y.applyUpdate(independent, update);
    expect(independent.getText('content').toString()).toBe(final);

    // 3. A third person who joins now gets the same text, and the disk converges to it (autosave, D13).
    const carolConn = await t.connect({ userId: 'dev:carol', displayName: 'Carol', role: 'viewer' });
    const carol = await DocClient.open(carolConn.conn, file);
    await waitFor(() => carol.text.toString() === final, { what: 'late joiner sync' });
    await waitFor(async () => (await readFile(join(t!.root, 'notes/shared.md'), 'utf8')) === final, { timeoutMs: 5_000, what: 'autosave of the merged text' });
  });

  it('keys a document by the resolved file: another spelling or an in-share link opens the same room', async () => {
    t = await createTestDaemon({ project: { files: { 'README.md': 'hello\n' } }, modules: [createDocsModule()] });
    const { symlink } = await import('node:fs/promises');
    await symlink('README.md', join(t.root, 'link.md'));
    const amy = await t.connect({ userId: 'dev:amy', role: 'editor' });
    const direct = await DocClient.open(amy.conn, { root: MAIN_ROOT, path: 'README.md' });
    // Other spellings from another member (a raw open: the same channel would just re-join its subscription).
    const bob = await t.connect({ userId: 'dev:bob', role: 'editor' });
    const viaLink = await bob.conn.request('doc.open', { file: { root: MAIN_ROOT, path: 'link.md' } });
    expect(viaLink.docId).toBe(direct.docId);
    expect(viaLink.epoch).toBe(direct.opened.epoch);
    const caseInsensitive = await import('node:fs/promises').then((fs) => fs.stat(join(t!.root, 'readme.md')).then(() => true, () => false));
    if (caseInsensitive) {
      const otherCase = await bob.conn.request('doc.open', { file: { root: MAIN_ROOT, path: 'readme.md' } });
      expect(otherCase.docId).toBe(direct.docId);
    }
    // Saving through the room keeps the link a link (the write goes to the resolved file).
    await waitFor(() => direct.synced, { what: 'sync' });
    direct.text.insert(0, 'X');
    await waitFor(async () => (await readFile(join(t!.root, 'README.md'), 'utf8')) === 'Xhello\n', { what: 'autosave' });
    const { lstat } = await import('node:fs/promises');
    expect((await lstat(join(t.root, 'link.md'))).isSymbolicLink()).toBe(true);
  });
});
