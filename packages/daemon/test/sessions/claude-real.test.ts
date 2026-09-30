// Where Claude Code itself is the subject: a guest agent session running the REAL `claude` inside the REAL sandbox.
// Safety (ARCHITECTURE §0 rule 2): the binary comes from SMURG_TEST_CLAUDE_BIN (else `claude` on PATH) and must be a
// verified version; it only ever runs with the guest environment the sessions module builds (temporary HOME /
// CLAUDE_CONFIG_DIR / TMPDIR under a fake host home), a dummy key and ANTHROPIC_BASE_URL on a closed 127.0.0.1 port
// (config.sessions.testGuestEnv: accepted only without a relay). No prompt is sent; nothing leaves the machine.
// The hook command is the real `smurg hook` (node + the CLI's sources): a guest agent session starts only after it
// answered from inside the sandbox (the in-sandbox hook self-test).
// Skips loudly when no verified binary is available or the sandbox / hooks modules are still stubs.
// The guest's subscription login itself (ARCHITECTURE §11 D-12) runs as its own process: test/sessions/login.real.test.ts.
import { randomBytes } from 'node:crypto';
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import xtermHeadless from '@xterm/headless';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CLAUDE_VERIFIED_VERSIONS, claudeVersionVerdict, type SessionLaunchConfig } from '../../src/core/config.ts';
import type { FeatureModule } from '../../src/core/context.ts';
import type { ActivityFeed, ClientConnection, LockManager, PresenceService, Principal } from '../../src/core/interfaces.ts';
import { toDisposable } from '../../src/core/lifecycle.ts';
import { createLineLogger } from '../../src/core/logger.ts';
import { isStubService } from '../../src/core/stubs.ts';
import { createDaemon, type Daemon } from '../../src/daemon.ts';
import { hooksModule } from '../../src/hooks/module.ts';
import { sandboxModule } from '../../src/sandbox/module.ts';
import { ClaudeVersionProbe, resolveClaude } from '../../src/sessions/claude.ts';
import { createSessionsModule } from '../../src/sessions/module.ts';
import { runProcess } from '../../src/sessions/process-run.ts';
import type { SessionManagerImpl } from '../../src/sessions/session-manager.ts';
import { createTempDir, createTempRunDir, removeTempDir, removeTempRunDir } from '../../src/testing/index.ts';
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
  restoreTmp: () => void;
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
    skipReason = 'real srt runs on macOS and Linux only';
    return;
  }
  const runDir = await createTempRunDir();
  const previousTmp = process.env['TMPDIR'];
  if (tmpdir().length > 40) process.env['TMPDIR'] = runDir; // srt's proxy socket must fit the socket path limit
  const restoreTmp = (): void => {
    if (previousTmp === undefined) delete process.env['TMPDIR'];
    else process.env['TMPDIR'] = previousTmp;
  };
  const base = await createTempDir('sessions-claude');
  const claude = await findVerifiedClaude(base);
  if (claude === null) {
    skipReason = 'no verified Claude Code binary (set SMURG_TEST_CLAUDE_BIN to a 2.1.220 / 2.1.283 claude)';
    await removeTempDir(base);
    restoreTmp();
    await removeTempRunDir(runDir);
    return;
  }
  const home = join(base, 'home');
  const share = join(home, 'projects', 'app');
  await mkdir(share, { recursive: true });
  await writeFile(join(share, 'README.md'), 'readme\n');
  // Canary: the host's own CLAUDE.md must never reach a guest (R5.5 is the sandbox's, this is a smoke check).
  await mkdir(join(home, '.claude'), { recursive: true });
  await writeFile(join(home, '.claude', 'CLAUDE.md'), `SMURG-HOST-CLAUDE-MD-${randomBytes(4).toString('hex')}\n`);
  const warnings: string[] = [];
  const sessions: Partial<SessionLaunchConfig> = {
    hostHome: home,
    claudePath: claude,
    selfCommand: { file: process.execPath, args: [CLI_MAIN] },
    testGuestEnv: { ANTHROPIC_BASE_URL: 'http://127.0.0.1:9' },
  };
  const fakes: FeatureModule = {
    name: 'session-test-fakes',
    create: () => ({
      locks: new FakeLocks() as unknown as LockManager,
      presence: new FakePresence() as unknown as PresenceService,
      activity: new FakeActivity() as unknown as ActivityFeed,
    }),
    register: () => toDisposable(() => {}),
  };
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
      defaultSettings: { allowedDomains: [] },
      sessions,
    },
    modules: [fakes, sandboxModule, hooksModule, createSessionsModule({ hostEnv: () => ({ PATH: '/usr/bin:/bin', HOME: home, USER: 'host', LANG: 'en_US.UTF-8' }), keychain: async () => {} })],
    homeDir: home,
    log: createLineLogger({ level: 'warn', write: (line) => warnings.push(line) }),
  });
  await daemon.start();
  if (isStubService(daemon.ctx.services.sandbox) || isStubService(daemon.ctx.services.hooks)) skipReason = 'the sandbox or hooks module is still a stub';
  daemon.ctx.members.admitMember({ userId: 'dev:carol', displayName: 'carol', role: 'runner', at: Date.now() });
  fixture = { daemon, sessions: daemon.ctx.services.sessions as SessionManagerImpl, base, runDir, share: await realpath(share), warnings, restoreTmp };
}, 120_000);

afterAll(async () => {
  if (!fixture) return;
  await fixture.daemon.stop();
  await removeTempDir(fixture.base);
  fixture.restoreTmp();
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

describe('a guest agent session running the real claude in the real sandbox (mock-API isolation)', { timeout: 120_000 }, () => {
  it('starts with smurg\'s --settings accepted and the trust seeded; `claude auth status --json` (in the sandbox, with the guest\'s own key) decides the login state', async (ctx) => {
    if (skipReason !== null) {
      console.warn(`[sessions] SKIPPED real-claude test: ${skipReason}`);
      return ctx.skip(skipReason);
    }
    const f = fixture as Fixture;
    const carol = f.daemon.ctx.members.principalOf('dev:carol') as Principal;
    // (Without a key, Claude Code's onboarding checks that api.anthropic.com is reachable and quits when it is not; this
    // sandbox allows no domain at all, so only the key case keeps a TUI running here. The logged-out verdict is covered
    // with a fake claude in launch.test.ts and by parseAuthStatus's unit test.)
    const session = await f.sessions.create({ kind: 'agent', workspace: { mode: 'main' }, cols: 120, rows: 40, apiKey: DUMMY_KEY }, conn, carol);
    expect(await f.sessions.loginStatus(session.id, carol)).toBe('logged-in');
    // The TUI renders (something beyond an empty screen) and keeps running: the settings file did not stop it.
    let text = '';
    await waitFor(async () => {
      text = await screen(session.id, carol);
      return text.replace(/\s+/g, '').length > 20;
    }, 'the Claude Code TUI', 60_000);
    await sleep(2_000);
    text = await screen(session.id, carol);
    console.info(`[claude-real] first screen of the guest's Claude Code:\n${text.split('\n').filter((l) => l.trim()).slice(0, 12).join('\n')}`);
    expect(f.sessions.get(session.id)?.status).toBe('running');
    expect(text.replace(/\s+/g, '')).not.toMatch(/SettingsError|Invalidsettings/i);
    expect(text).not.toContain('SMURG-HOST-CLAUDE-MD');
    // The seeded trust entry is in the guest's own config (the dialog would otherwise withhold every hook).
    const seeded = JSON.parse(await readFile(join(f.sessions.guestPaths('dev:carol').cfg, '.claude.json'), 'utf8'));
    expect(seeded.projects[f.share]?.hasTrustDialogAccepted).toBe(true);
    await f.sessions.end({ sessionId: session.id }, carol);
    expect(f.sessions.get(session.id)?.status).toBe('exited');
  });

  it('SPEC §13 item 5 / D-12 — the guest AGENT session itself still cannot listen: choosing the subscription login inside it fails ("Failed to start OAuth callback server"); the login runs as its own process instead (login.real.test.ts)', async (ctx) => {
    if (skipReason !== null) {
      console.warn(`[sessions] SKIPPED real-claude login test: ${skipReason}`);
      return ctx.skip(skipReason);
    }
    // No account is involved: the method is chosen and the screen is read; no code is ever pasted, and the sandbox
    // allows no domain at all. BROWSER is the guest env's no-op (claude-hooks.md: otherwise the HOST's browser opens).
    const f = fixture as Fixture;
    const carol = f.daemon.ctx.members.principalOf('dev:carol') as Principal;
    const session = await f.sessions.create({ kind: 'agent', workspace: { mode: 'main' }, cols: 160, rows: 50, apiKey: DUMMY_KEY }, conn, carol);
    const type = (text: string): void => f.sessions.input({ sessionId: session.id, data: new TextEncoder().encode(text) }, conn, carol);
    const flat = async (): Promise<string> => (await screen(session.id, carol)).replace(/\s+/g, '');
    try {
      // Onboarding (theme, security notes) up to the prompt. Its footer differs: 2.1.220 「? for shortcuts」, 2.1.283
      // 「⏵⏵ auto mode on (shift+tab to cycle)」.
      const atPrompt = (text: string): boolean => text.includes('?forshortcuts') || text.includes('shift+tabtocycle');
      for (let i = 0; i < 6 && !atPrompt(await flat()); i++) {
        await sleep(1_500);
        if (!atPrompt(await flat())) type('\r');
      }
      await waitFor(async () => atPrompt(await flat()), 'the prompt', 30_000).catch(async (err: unknown) => {
        // Name what the screen showed instead (Claude Code versions differ in their first screens).
        throw new Error(`${err instanceof Error ? err.message : String(err)}; the screen:\n${(await screen(session.id, carol)).split('\n').filter((l) => l.trim()).slice(0, 30).join('\n')}`);
      });
      type('/login');
      await sleep(800);
      type('\r');
      await waitFor(async () => (await flat()).includes('Selectloginmethod:'), 'the login method screen', 20_000);
      type('\r'); // 1. Claude account with subscription
      let text = '';
      await waitFor(async () => {
        text = await flat();
        return text.includes('OAutherror') || text.includes('Pastecodehereifprompted');
      }, 'the outcome of the subscription login', 30_000);
      // The agent session's sandbox still forbids listening (only the dedicated login process may, D-12).
      expect(text).toContain('FailedtostartOAuthcallbackserver');
      expect(text).not.toContain('Pastecodehereifprompted');
      expect(text).not.toContain('oauth/authorize');
    } finally {
      await f.sessions.end({ sessionId: session.id }, carol);
    }
  });
});
