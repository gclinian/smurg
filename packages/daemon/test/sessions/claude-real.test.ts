// Where Claude Code itself is the subject: an agent session a 「可使用 agent」 member opens runs the REAL `claude` exactly
// like the host's own (ARCHITECTURE §11 D-15: the host's environment, no sandbox).
// Safety (ARCHITECTURE §0 rule 2): the binary comes from SMURG_TEST_CLAUDE_BIN (else `claude` on PATH) and must be a
// verified version; the "host" environment the sessions module gets is the test's own: a fake HOME, an isolated
// CLAUDE_CONFIG_DIR (never the developer's config or keychain items), a dummy key and ANTHROPIC_BASE_URL on a closed
// 127.0.0.1 port. No prompt is sent; nothing leaves the machine. The hook command is the real `smurg hook` (node + the
// CLI's sources). Skips loudly when no verified binary is available or the hooks module is still a stub.
import { randomBytes } from 'node:crypto';
import { mkdir, realpath, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import xtermHeadless from '@xterm/headless';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CLAUDE_VERIFIED_VERSIONS, claudeVersionVerdict } from '../../src/core/config.ts';
import type { FeatureModule } from '../../src/core/context.ts';
import type { ActivityFeed, ClientConnection, LockManager, PresenceService, Principal } from '../../src/core/interfaces.ts';
import { toDisposable } from '../../src/core/lifecycle.ts';
import { createLineLogger } from '../../src/core/logger.ts';
import { isStubService } from '../../src/core/stubs.ts';
import { createDaemon, type Daemon } from '../../src/daemon.ts';
import { hooksModule } from '../../src/hooks/module.ts';
import { ClaudeVersionProbe, resolveClaude } from '../../src/sessions/claude.ts';
import { createSessionsModule } from '../../src/sessions/module.ts';
import { runProcess } from '../../src/sessions/process-run.ts';
import type { SessionManagerImpl } from '../../src/sessions/session-manager.ts';
import { createTempDir, createTempRunDir, removeTempDir, removeTempRunDir } from '../../src/testing/index.ts';
import { seedClaudeTrust } from '../hooks/claude-harness.ts';
import { FakeActivity, FakeLocks, FakePresence, sleep, waitFor } from './helpers.ts';
import { CLI_MAIN } from './real-stack.ts';

const { Terminal } = xtermHeadless;
const DUMMY_KEY = 'sk-ant-api03-smurg-test-dummy-key-000000000000000000000000';
const conn = { channelId: 'ch_claude_real', id: 'conn_claude_real' } as unknown as ClientConnection;

interface Fixture {
  daemon: Daemon;
  sessions: SessionManagerImpl;
  base: string;
  runDir: string;
  share: string;
  warnings: string[];
}

let fixture: Fixture | null = null;
let skipReason: string | null = null;

async function findVerifiedClaude(scratch: string): Promise<string | null> {
  const configured = process.env['SMURG_TEST_CLAUDE_BIN'];
  const binary = await resolveClaude(configured ? configured : null, configured ? undefined : process.env['PATH']);
  if (!binary) return null;
  // `--version` with an isolated environment (ClaudeVersionProbe: never the developer's config).
  const probe = new ClaudeVersionProbe({ scratchParent: scratch, run: runProcess });
  const verdict = claudeVersionVerdict(await probe.output(binary), { claudeMinVersion: CLAUDE_VERIFIED_VERSIONS[0] as string, claudeVerifiedVersions: CLAUDE_VERIFIED_VERSIONS });
  return verdict.ok && verdict.warning === null ? binary.realPath : null;
}

beforeAll(async () => {
  if (process.platform !== 'darwin' && process.platform !== 'linux') {
    skipReason = 'PTY sessions run on macOS and Linux only';
    return;
  }
  const runDir = await createTempRunDir();
  const base = await createTempDir('sessions-claude');
  const claude = await findVerifiedClaude(base);
  if (claude === null) {
    skipReason = 'no verified Claude Code binary (set SMURG_TEST_CLAUDE_BIN to a 2.1.220 / 2.1.283 claude)';
    await removeTempDir(base);
    await removeTempRunDir(runDir);
    return;
  }
  const home = join(base, 'home');
  const cfg = join(home, 'claude-config');
  const share = join(home, 'projects', 'app');
  await mkdir(share, { recursive: true });
  await mkdir(cfg, { recursive: true });
  await writeFile(join(share, 'README.md'), 'readme\n');
  // What the host's own Claude Code has once it trusted the folder and approved its key (the dialogs would otherwise
  // withhold every hook / ask about the key).
  await seedClaudeTrust({ cfgDir: cfg, cwd: share, apiKey: DUMMY_KEY });
  const warnings: string[] = [];
  const fakes: FeatureModule = {
    name: 'session-test-fakes',
    create: () => ({
      locks: new FakeLocks() as unknown as LockManager,
      presence: new FakePresence() as unknown as PresenceService,
      activity: new FakeActivity() as unknown as ActivityFeed,
    }),
    register: () => toDisposable(() => {}),
  };
  const hostEnv = { PATH: '/usr/bin:/bin', HOME: home, USER: 'host', LANG: 'en_US.UTF-8', CLAUDE_CONFIG_DIR: cfg, ANTHROPIC_API_KEY: DUMMY_KEY, ANTHROPIC_BASE_URL: 'http://127.0.0.1:9' };
  const daemon = await createDaemon({
    config: {
      stateDir: join(home, '.smurg'),
      runDir,
      shareDir: share,
      workspaceId: `ws_test_${randomBytes(9).toString('base64url')}`,
      hostUserId: 'dev:host',
      hostName: 'Host',
      relayUrl: null,
      keepAwake: false,
      sessions: { hostHome: home, claudePath: claude, selfCommand: { file: process.execPath, args: [CLI_MAIN] } },
    },
    modules: [fakes, hooksModule, createSessionsModule({ hostEnv: () => hostEnv })],
    homeDir: home,
    log: createLineLogger({ level: 'warn', write: (line) => warnings.push(line) }),
  });
  await daemon.start();
  if (isStubService(daemon.ctx.services.hooks)) skipReason = 'the hooks module is still a stub';
  daemon.ctx.members.admitMember({ userId: 'dev:carol', displayName: 'carol', role: 'agent', at: Date.now() });
  fixture = { daemon, sessions: daemon.ctx.services.sessions as SessionManagerImpl, base, runDir, share: await realpath(share), warnings };
}, 120_000);

afterAll(async () => {
  if (!fixture) return;
  await fixture.daemon.stop();
  await removeTempDir(fixture.base);
  await removeTempRunDir(fixture.runDir);
}, 60_000);

/** The mirror's current screen, read through a fresh snapshot attach. */
async function screen(sessionId: string, principal: Principal): Promise<string> {
  const f = fixture as Fixture;
  const start = await f.sessions.attach({ sessionId }, conn, principal);
  f.sessions.detach(sessionId, conn.channelId);
  const term = new Terminal({ cols: start.result.cols, rows: start.result.rows, scrollback: 1000, allowProposedApi: true });
  await new Promise<void>((resolve) => term.write(start.result.data as Uint8Array, () => resolve()));
  const lines: string[] = [];
  for (let i = 0; i < term.buffer.active.length; i++) lines.push(term.buffer.active.getLine(i)?.translateToString(true) ?? '');
  term.dispose();
  return lines.join('\n');
}

describe('a 可使用 agent member\'s agent session running the real claude like the host\'s own (mock-API isolation)', { timeout: 120_000 }, () => {
  it('starts with smurg\'s --settings accepted, in the host\'s environment; `claude auth status --json` (the host\'s login: here its key) decides the login state', async (ctx) => {
    if (skipReason !== null) {
      console.warn(`[sessions] SKIPPED real-claude test: ${skipReason}`);
      return ctx.skip(skipReason);
    }
    const f = fixture as Fixture;
    const carol = f.daemon.ctx.members.principalOf('dev:carol') as Principal;
    const session = await f.sessions.create({ kind: 'agent', workspace: { mode: 'main' }, cols: 120, rows: 40 }, conn, carol);
    expect(session).toMatchObject({ ownerUserId: 'dev:carol', title: 'Claude（carol）' });
    expect(await f.sessions.loginStatus(session.id, carol)).toBe('logged-in');
    // The TUI renders (something beyond an empty screen) and keeps running: the settings file did not stop it.
    let text = '';
    await waitFor(async () => {
      text = await screen(session.id, carol);
      return text.replace(/\s+/g, '').length > 20;
    }, 'the Claude Code TUI', 60_000);
    await sleep(2_000);
    text = await screen(session.id, carol);
    console.info(`[claude-real] first screen of the member's Claude Code:\n${text.split('\n').filter((l) => l.trim()).slice(0, 12).join('\n')}`);
    expect(f.sessions.get(session.id)?.status).toBe('running');
    expect(text.replace(/\s+/g, '')).not.toMatch(/SettingsError|Invalidsettings/i);
    await f.sessions.end({ sessionId: session.id }, carol);
    expect(f.sessions.get(session.id)?.status).toBe('exited');
  });
});
