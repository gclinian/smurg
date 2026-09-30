// ARCHITECTURE §11 D-13 with the production composition (DEFAULT_FEATURE_MODULES: the real lock manager, file watcher,
// docs and sessions modules): a Bash window of an agent session (the events the hooks module emits for the Bash
// activity hook) and a write made by another process. The activity feed names the agent, and the R8 fallback's
// conflict record takes the same author ("the conflict record's source uses the same rule"); without a window both
// stay 「外部程式」 / system. The hook → bus path itself: test/hooks/hook-server.test.ts; the real claude:
// test/hooks/claude-e2e.test.ts.
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { MAIN_ROOT, type ActivityEvent, type ConflictRecord } from '@smurg/protocol';
import { createTempDir, createTestDaemon, removeTempDir, waitFor, type TestDaemon } from '../../src/testing/index.ts';
import { DocClient, destroyDocClients } from '../docs/helpers.ts';

let t: TestDaemon | null = null;
let scratch: string | null = null;

afterEach(async () => {
  try {
    destroyDocClients();
  } finally {
    await t?.cleanup();
    t = null;
    if (scratch) await removeTempDir(scratch);
    scratch = null;
  }
});

const PATH = 'src/main.ts';
const FILE = { root: MAIN_ROOT, path: PATH };
const ORIGINAL = ['export function main() {', '  const greeting = "hello";', '  console.log(greeting);', '  return 0;', '}', ''].join('\n');

async function setup(): Promise<{ readonly t: TestDaemon; readonly sessionId: string; readonly hostUserId: string }> {
  scratch = await createTempDir('bash-attribution');
  await mkdir(join(scratch, 'bin'), { recursive: true });
  const claude = join(scratch, 'bin', 'claude');
  await writeFile(claude, '#!/bin/sh\ncase "$1" in --version) echo "2.1.283 (Claude Code)"; exit 0 ;; esac\nif [ "$1" = auth ]; then echo \'{"loggedIn":true,"authMethod":"api_key"}\'; exit 0; fi\nexec cat\n');
  await chmod(claude, 0o755);
  t = await createTestDaemon({ project: { files: { [PATH]: ORIGINAL } }, sessions: { claudePath: claude, selfCommand: { file: '/usr/bin/true', args: [] } } });
  const host = await t.connectHost();
  const { session } = await host.conn.request('session.create', { kind: 'agent', workspace: { mode: 'main' }, cols: 80, rows: 24 });
  return { t, sessionId: session.id, hostUserId: session.ownerUserId };
}

async function amyTypesAndAnotherProcessWrites(d: TestDaemon): Promise<{ readonly conflicts: ConflictRecord[]; readonly activity: ActivityEvent[] }> {
  const amyConn = await d.connect({ userId: 'dev:amy', displayName: 'Amy', role: 'editor' });
  const conflicts: ConflictRecord[] = [];
  const activity: ActivityEvent[] = [];
  amyConn.conn.on('doc.conflict', (p) => conflicts.push(p.conflict));
  amyConn.conn.on('activity.event', (p) => activity.push(p.event));
  const amy = await DocClient.open(amyConn.conn, FILE);
  await waitFor(() => amy.synced, { what: 'sync' });
  amy.text.insert(amy.text.toString().indexOf('"hello"') + 1, 'HUMAN ');
  await waitFor(async () => (await readFile(join(d.root, PATH), 'utf8')).includes('HUMAN hello'), { what: 'autosave' });
  // Known limit (files module, not D-13): for 5 s after an autosave the watcher attributes ANY change of the file to the
  // person who saved it (FileService.expectChange, EXPECT_CHANGE_TTL_MS), and the activity feed then leaves it to the
  // save. The shell command here writes after that window, as one that runs a moment after the last keystroke would.
  await new Promise((resolve) => setTimeout(resolve, 5_500));
  // Another process (a `sed -i` of the agent's shell command, or anything else) rewrites the file from a stale copy.
  await writeFile(join(d.root, PATH), ORIGINAL.replace('"hello"', '"hi from the shell"').replace('return 0;', 'return 1;'));
  await waitFor(() => conflicts.length === 1, { timeoutMs: 15_000, what: 'doc.conflict' });
  await waitFor(() => activity.some((e) => e.file?.path === PATH && (e.kind === 'agent.edit' || e.kind === 'external.change')), { timeoutMs: 15_000, what: 'the activity entry of the disk change' });
  return { conflicts, activity };
}

describe('D-13 Bash attribution with the real modules', { timeout: 60_000 }, () => {
  it('inside the Bash window of exactly one agent session: the activity feed and the conflict record name that agent', async () => {
    const { t: d, sessionId, hostUserId } = await setup();
    d.ctx.bus.emit('agent.tool.pre', { sessionId, ownerUserId: hostUserId, tool: 'Bash', file: null, outcome: 'granted' });
    const { conflicts, activity } = await amyTypesAndAnotherProcessWrites(d);
    const entry = activity.find((e) => e.file?.path === PATH && e.kind === 'agent.edit');
    expect(entry).toMatchObject({ kind: 'agent.edit', actor: { kind: 'agent', sessionId, ownerUserId: hostUserId } });
    expect(entry?.summary).toMatch(/透過 shell 指令修改了 src\/main\.ts/);
    expect(conflicts[0]?.source).toMatchObject({ kind: 'agent', sessionId, ownerUserId: hostUserId });
    expect((await d.ctx.audit.query({ limit: 100 })).find((e) => e.action === 'agent.edit' && e.target === 'main:src/main.ts')).toMatchObject({ actor: { kind: 'agent', sessionId }, detail: { via: 'bash' } });
  });

  it('control: without a Bash window the same write stays 「外部程式」 and the conflict record\'s source is the system', async () => {
    const { t: d } = await setup();
    const { conflicts, activity } = await amyTypesAndAnotherProcessWrites(d);
    expect(activity.find((e) => e.file?.path === PATH && e.kind !== 'human.edit' && e.kind !== 'conflict')).toMatchObject({ kind: 'external.change', actor: { kind: 'system' } });
    expect(conflicts[0]?.source).toEqual({ kind: 'system' });
  });
});
