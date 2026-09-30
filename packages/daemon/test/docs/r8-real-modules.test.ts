// R8.4 with the production composition (DEFAULT_FEATURE_MODULES): the real LockManager takes the human lock, the real
// file watcher (@parcel/watcher) notices a write made by another process, and the docs module merges it. Nothing is
// emitted by hand here, so this covers the wiring between the modules, not only the docs module's contract.
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { MAIN_ROOT, type ConflictRecord } from '@smurg/protocol';
import { createTestDaemon, waitFor, type TestDaemon } from '../../src/testing/index.ts';
import { DocClient, destroyDocClients } from './helpers.ts';

let t: TestDaemon | null = null;

afterEach(async () => {
  try {
    destroyDocClients();
  } finally {
    await t?.cleanup();
    t = null;
  }
});

const PATH = 'src/main.ts';
const FILE = { root: MAIN_ROOT, path: PATH };
const ORIGINAL = ['export function main() {', '  const greeting = "hello";', '  console.log(greeting);', '  return 0;', '}', ''].join('\n');

describe('R8 一致性與檔案鎖 (real modules)', { timeout: 30_000 }, () => {
  it('agent 透過 Bash 修改有人正在編輯的檔案時，人打的內容不會遺失；重疊部分出現在衝突面板 — real lock manager and file watcher', async () => {
    t = await createTestDaemon({ project: { files: { [PATH]: ORIGINAL } } });
    const amyConn = await t.connect({ userId: 'dev:amy', displayName: 'Amy', role: 'editor' });
    const conflicts: ConflictRecord[] = [];
    amyConn.conn.on('doc.conflict', (p) => conflicts.push(p.conflict));
    const amy = await DocClient.open(amyConn.conn, FILE);
    await waitFor(() => amy.synced, { what: 'sync' });
    amy.text.insert(amy.text.toString().indexOf('"hello"') + 1, 'HUMAN ');
    await waitFor(async () => (await amyConn.conn.request('lock.list', {})).locks.some((l) => l.kind === 'human'), { what: 'human lock from the real LockManager' });
    await waitFor(async () => (await readFile(join(t!.root, PATH), 'utf8')).includes('HUMAN hello'), { what: 'autosave' });

    // Another process (the agent's Bash) rewrites the file from a stale copy: the greeting line and the return line.
    const agentVersion = ORIGINAL.replace('"hello"', '"hi from the agent"').replace('return 0;', 'return 1;');
    await writeFile(join(t.root, PATH), agentVersion);

    await waitFor(() => amy.text.toString().includes('return 1;'), { timeoutMs: 10_000, what: 'the watcher-driven merge' });
    expect(amy.text.toString()).toContain('HUMAN hello');
    expect(amy.text.toString()).not.toContain('hi from the agent');
    await waitFor(() => conflicts.length === 1, { what: 'doc.conflict' });
    expect(conflicts[0]?.hunks[0]).toMatchObject({ humanText: '  const greeting = "HUMAN hello";', agentText: '  const greeting = "hi from the agent";' });
    await waitFor(async () => (await readFile(join(t!.root, PATH), 'utf8')) === amy.text.toString(), { timeoutMs: 10_000, what: 'merged text on disk' });
  });
});
