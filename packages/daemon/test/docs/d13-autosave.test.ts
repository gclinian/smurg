// SPEC D13 (網頁編輯器自動存檔) and R8 「以 agent 的名義套用成 Yjs 更新，所有人的游標位置不變」, through the real daemon.
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { AUTOSAVE_DEBOUNCE_MS, AUTOSAVE_MAX_WAIT_MS, MAIN_ROOT, type AuditEntry } from '@smurg/protocol';
import * as Y from 'yjs';
import { createDocsModule } from '../../src/docs/module.ts';
import { createTestDaemon, waitFor, type TestDaemon } from '../../src/testing/index.ts';
import { DocClient, FakeLockManager, destroyDocClients, fakeLocksModule, sleep } from './helpers.ts';

let t: TestDaemon | null = null;

afterEach(async () => {
  try {
    destroyDocClients();
  } finally {
    await t?.cleanup();
    t = null;
  }
});

const FILE = { root: MAIN_ROOT, path: 'doc.md' };

describe('D13 網頁編輯器自動存檔', { timeout: 30_000 }, () => {
  it('自動存檔：人的修改不需要按儲存就寫入磁碟（debounce 300 ms、最長 2 秒），並通知 doc.saved', async () => {
    t = await createTestDaemon({ project: { files: { 'doc.md': 'start\n' } }, modules: [fakeLocksModule(new FakeLockManager()), createDocsModule()] });
    const saves: { hash: string }[] = [];
    t.ctx.bus.on('doc.saved', (e) => saves.push(e));
    const amyConn = await t.connect({ userId: 'dev:amy', role: 'editor' });
    const amy = await DocClient.open(amyConn.conn, FILE);
    await waitFor(() => amy.synced, { what: 'sync' });
    const path = join(t.root, 'doc.md');

    // One edit: on disk after the debounce, without any save request.
    const typedAt = performance.now();
    amy.text.insert(amy.text.length, 'typed by Amy\n');
    await waitFor(async () => (await readFile(path, 'utf8')) === 'start\ntyped by Amy\n', { timeoutMs: 5_000, what: 'autosave' });
    const firstSaveMs = performance.now() - typedAt;
    expect(firstSaveMs).toBeGreaterThanOrEqual(AUTOSAVE_DEBOUNCE_MS - 20);
    await waitFor(() => amy.saved.length === 1, { what: 'doc.saved' });
    expect(amy.saved[0]).toMatchObject({ docId: amy.docId, file: FILE });
    expect(saves).toHaveLength(1);

    // Continuous typing (one key every 100 ms, which never lets the 300 ms debounce expire) is still saved at the
    // latest 2 s after the first unsaved key.
    const started = performance.now();
    let savedWhileTyping: number | null = null;
    const before = amy.saved.length;
    while (performance.now() - started < AUTOSAVE_MAX_WAIT_MS + 3_000) {
      amy.text.insert(amy.text.length, 'k');
      await sleep(100);
      if (savedWhileTyping === null && amy.saved.length > before) savedWhileTyping = performance.now() - started;
    }
    console.log(`D13: first save ${firstSaveMs.toFixed(0)} ms after the key; first save while typing continuously after ${savedWhileTyping?.toFixed(0)} ms`);
    expect(savedWhileTyping).not.toBeNull();
    // 2 s by design; the margin is for a loaded machine, not precision.
    expect(savedWhileTyping as number).toBeLessThan(AUTOSAVE_MAX_WAIT_MS + 2_500);
    // Everything ends up on disk once typing stops.
    await waitFor(async () => (await readFile(path, 'utf8')) === amy.text.toString(), { timeoutMs: 5_000, what: 'final autosave' });
  });

  it('自動存檔保留檔案的權限、BOM 與換行（atomic write, never a torn file）', async () => {
    t = await createTestDaemon({ project: { files: { 'run.sh': '﻿#!/bin/sh\r\necho hi\r\n' } }, modules: [createDocsModule()] });
    const { chmod, stat } = await import('node:fs/promises');
    const path = join(t.root, 'run.sh');
    await chmod(path, 0o755);
    const amyConn = await t.connect({ userId: 'dev:amy', role: 'editor' });
    const amy = await DocClient.open(amyConn.conn, { root: MAIN_ROOT, path: 'run.sh' });
    await waitFor(() => amy.synced, { what: 'sync' });
    expect(amy.opened.meta).toEqual({ eol: 'CRLF', bom: true, mixedEol: false });
    expect(amy.text.toString()).toBe('#!/bin/sh\necho hi\n');
    amy.text.insert(amy.text.length, 'echo 你好\n');
    await waitFor(async () => (await readFile(path, 'utf8')) === '﻿#!/bin/sh\r\necho hi\r\necho 你好\r\n', { what: 'autosave' });
    expect((await stat(path)).mode & 0o777).toBe(0o755);
  });

  it('agent 的修改套用成 Yjs 更新時，所有人的游標位置不變（relative positions）', async () => {
    const lines = ['# 標題', '', '世界 hello', '第二段落', 'tail line', ''];
    const initial = lines.join('\n');
    const locks = new FakeLockManager();
    t = await createTestDaemon({ project: { files: { 'doc.md': initial } }, modules: [fakeLocksModule(locks), createDocsModule()] });
    const audit: AuditEntry[] = [];
    t.ctx.audit.subscribe((e) => audit.push(e));
    const amyConn = await t.connect({ userId: 'dev:amy', displayName: 'Amy', role: 'editor' });
    const bobConn = await t.connect({ userId: 'dev:bob', displayName: 'Bob', role: 'editor' });
    const amy = await DocClient.open(amyConn.conn, FILE);
    const bob = await DocClient.open(bobConn.conn, FILE);
    await waitFor(() => amy.synced && bob.synced, { what: 'sync' });

    // Bob's caret sits on 「界」; Amy's editor renders it from Bob's awareness state.
    const at = initial.indexOf('界');
    bob.setCursor(at);
    const bobCursor = (): { anchor: unknown } | undefined => {
      for (const state of amy.remoteStates().values()) {
        const user = state['user'] as { userId?: string } | undefined;
        if (user?.userId === 'dev:bob') return state['selection'] as { anchor: unknown } | undefined;
      }
      return undefined;
    };
    await waitFor(() => bobCursor() !== undefined && bobCursor() !== null, { what: "Bob's cursor at Amy" });
    const resolveBob = (): string => {
      const selection = bobCursor() as { anchor: Record<string, unknown> };
      const absolute = Y.createAbsolutePositionFromRelativePosition(Y.createRelativePositionFromJSON(selection.anchor), amy.doc);
      return absolute ? amy.text.toString().slice(absolute.index, absolute.index + 1) : '?';
    };
    expect(resolveBob()).toBe('界');

    // The agent (holding the lock) inserts lines above and edits the line after, then releases (PostToolUse).
    const session = { file: FILE, sessionId: 'sess_amy', ownerUserId: 'dev:amy', agentName: 'Claude（Amy）', sessionRoot: MAIN_ROOT };
    expect(locks.requestAgent(session).granted).toBe(true);
    const agentVersion = ['# 標題', 'import x from "y";', 'import z from "w";', '', '世界 hello', '第二段落 (edited by agent)', 'tail line', ''].join('\n');
    await writeFile(join(t.root, 'doc.md'), agentVersion);
    t.ctx.bus.emit('file.changed', { root: MAIN_ROOT, changes: [{ path: 'doc.md', change: 'change' }] });
    await waitFor(() => amy.text.toString() === agentVersion && bob.text.toString() === agentVersion, { what: 'agent edit applied everywhere' });
    locks.releaseAgent('sess_amy');

    // Bob's caret, as Amy sees it, is still on 「界」 (the characters around it kept their Yjs identity).
    expect(resolveBob()).toBe('界');
    const bobLocal = Y.createAbsolutePositionFromRelativePosition(
      Y.createRelativePositionFromJSON((bob.awareness.getLocalState()?.['selection'] as { anchor: Record<string, unknown> }).anchor),
      bob.doc,
    );
    expect(bob.text.toString().charAt(bobLocal?.index ?? -1)).toBe('界');
    // The agent appears in presence as 「Claude（Amy）」 with its caret at the end of its last change.
    await waitFor(
      () => [...bob.remoteStates().values()].some((st) => (st['user'] as { name?: string; kind?: string })?.name === 'Claude（Amy）'),
      { what: 'agent presence' },
    );
    const agentState = [...bob.remoteStates().values()].find((st) => (st['user'] as { kind?: string })?.kind === 'agent') as Record<string, unknown>;
    const caret = Y.createAbsolutePositionFromRelativePosition(Y.createRelativePositionFromJSON((agentState['selection'] as { head: Record<string, unknown> }).head), bob.doc);
    expect(bob.text.toString().slice(0, caret?.index)).toMatch(/\(edited by agent\)$/);
    // The daemon did not treat its own application as a human edit: nothing to save, no human lock taken.
    await sleep(AUTOSAVE_DEBOUNCE_MS + 200);
    expect(amy.saved).toHaveLength(0);
    expect(locks.touches).toHaveLength(0);
  });
});
