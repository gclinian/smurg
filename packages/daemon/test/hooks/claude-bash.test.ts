// ARCHITECTURE §11 D-13 with the REAL `claude` (mock Anthropic API, dummy key, isolated HOME / CLAUDE_CONFIG_DIR:
// ARCHITECTURE §0 rule 2): a scripted Bash tool call that modifies a file shows up in the activity feed as the agent.
// The daemon composes the real hook server (session settings from the real settings writer: the Bash ACTIVITY hook
// is registered), the real locks module (activity feed) and the real files module (@parcel/watcher); only the session
// list is a stand-in naming the registered session. `smurg hook` runs from this package's sources (node + the CLI).
// Skipped LOUDLY when no verified `claude` is available (SMURG_TEST_CLAUDE_BIN selects another binary).
import { buildAgentSession, buildHookRegistration, buildLaunchProfile } from '../../src/core/fakes/build.ts';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MAIN_ROOT, type ActivityEvent, type SessionInfo } from '@smurg/protocol';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FeatureModule } from '../../src/core/context.ts';
import type { SessionManager } from '../../src/core/interfaces.ts';
import { toDisposable } from '../../src/core/lifecycle.ts';
import { SYSTEM_PRINCIPAL } from '../../src/core/permissions.ts';
import { filesModule } from '../../src/files/module.ts';
import { HookServerImpl } from '../../src/hooks/hook-server.ts';
import { hooksModule } from '../../src/hooks/module.ts';
import { locksModule } from '../../src/locks/module.ts';
import { createTestDaemon, waitFor, type TestDaemon } from '../../src/testing/index.ts';
import { findClaude, isolatedEnv, runClaude, seedClaudeTrust } from './claude-harness.ts';
import { startMockAnthropic } from './mock-anthropic.ts';

const found = await findClaude();
const claude = found.binary;
if (claude === null) console.warn(`\n[claude-bash] SKIPPED — ${found.reason}\n`);
const V = claude === null ? 'no claude' : `Claude Code ${claude.version}`;
const CLI_MAIN = fileURLToPath(new URL('../../../cli/src/main.ts', import.meta.url));

describe.skipIf(claude === null)(`D-13: an agent's Bash edit in the main workspace, real claude (${V}, mock API)`, () => {
  let t: TestDaemon;
  const sessions: SessionInfo[] = [];

  beforeAll(async () => {
    const fakeSessions: FeatureModule = {
      name: 'fake-session-list',
      create: () => ({ sessions: { list: () => sessions, get: (id: string) => sessions.find((s) => s.id === id) ?? null } as unknown as SessionManager }),
      register: () => toDisposable(() => {}),
    };
    t = await createTestDaemon({
      modules: [locksModule, hooksModule, filesModule, fakeSessions],
      project: { files: { 'free.txt': 'free text\n', 'notes/todo.md': '- one\n' } },
      sessions: { selfCommand: { file: process.execPath, args: [CLI_MAIN] } },
    });
    await t.connect({ userId: 'dev:ian', displayName: 'Ian', role: 'agent' });
  }, 60_000);

  afterAll(async () => {
    await t?.cleanup();
  }, 60_000);

  it('a scripted Bash `sed` / `printf >` shows up in the activity feed as `Claude (Ian)`, via bash; the Bash hook reported the window', async () => {
    const hooks = t.ctx.services.hooks as HookServerImpl;
    const sessionId = 'ses_claude_bash_1';
    const creds = hooks.registerSession(buildHookRegistration({ sessionId, ownerUserId: 'dev:ian', agentName: 'Claude (Ian)', root: MAIN_ROOT }));
    sessions.push(buildAgentSession({ id: sessionId, openedBy: { userId: 'dev:ian', displayName: 'Ian' }, title: 'Claude (Ian)', status: 'running', createdAt: Date.now() }));
    const files = await hooks.writeSessionFiles(sessionId, buildLaunchProfile());
    const settings = JSON.parse(await readFile(files.settingsPath, 'utf8')) as { hooks: Record<string, { matcher?: string }[]> };
    expect(settings.hooks['PreToolUse']?.map((group) => group.matcher)).toEqual(['Edit|Write|MultiEdit|NotebookEdit', 'Bash']);
    const isolated = join(t.root, '..', `claude-run-${Date.now()}`);
    for (const sub of ['home', 'cfg', 'tmp']) await mkdir(join(isolated, sub), { recursive: true, mode: 0o700 });
    await seedClaudeTrust({ cfgDir: join(isolated, 'cfg'), cwd: t.root });
    const windows: string[] = [];
    t.ctx.bus.on('agent.tool.pre', (e) => e.tool === 'Bash' && e.file === null && windows.push(`start:${e.sessionId}`));
    t.ctx.bus.on('agent.tool.post', (e) => e.tool === 'Bash' && e.file === null && windows.push(`end:${e.sessionId}`));
    const mock = await startMockAnthropic([
      { tools: [{ name: 'Bash', input: { command: "printf 'changed by the agent shell\\n' > free.txt && /usr/bin/sed -i '' 's/one/ONE/' notes/todo.md", description: 'edit two files with the shell' } }] },
      { text: 'DONE' },
    ]);
    try {
      const run = await runClaude(claude as NonNullable<typeof claude>, {
        cwd: t.root,
        env: isolatedEnv(isolated, mock.url, { ...creds.env }),
        args: ['-p', 'run the scripted shell command', '--output-format', 'json', '--no-session-persistence', '--allowedTools', 'Bash', ...files.claudeArgs],
        timeoutMs: 120_000,
      });
      expect(run.timedOut).toBe(false);
      expect(mock.toolResults()[0]?.isError, JSON.stringify(mock.toolResults())).toBe(false);
    } finally {
      await mock.close();
    }
    expect(await readFile(join(t.root, 'free.txt'), 'utf8')).toBe('changed by the agent shell\n');
    expect(windows).toEqual([`start:${sessionId}`, `end:${sessionId}`]);
    let events: ActivityEvent[] = [];
    await waitFor(async () => {
      events = (await t.ctx.services.activity.list({ limit: 50 }, SYSTEM_PRINCIPAL)).events;
      return ['free.txt', 'notes/todo.md'].every((path) => events.some((e) => e.file?.path === path));
    }, { timeoutMs: 15_000, what: 'the activity entries of both files' });
    for (const path of ['free.txt', 'notes/todo.md']) {
      const entry = events.find((e) => e.file?.path === path);
      expect(entry, path).toMatchObject({ kind: 'agent.edit', actor: { kind: 'agent', sessionId, ownerUserId: 'dev:ian', displayName: 'Claude (Ian)' } });
      expect(entry?.text).toMatchObject({ id: 'activity.agentBashChange', params: { agent: 'Claude (Ian)' } });
      expect(entry?.via).toBe('bash');
    }
    expect(events.some((e) => e.kind === 'external.change')).toBe(false);
    hooks.unregisterSession(sessionId);
  }, 180_000);
});
