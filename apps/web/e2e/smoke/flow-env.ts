// The stack of the flow smoke (flow.smoke.test.ts, DESIGN §9.5 item 4): the same parts as startSmoke (the BUILT web
// app served by the real local relay, a real daemon on the release composition, system Chrome), composed here because
// the flow needs three things a `startStack` stack does not give:
//
//   - the daemon RESTARTS in the middle of the story, on the same folder, state directory and home, while the four
//     browsers stay open (`restartDaemon`);
//   - the people have the names of the story: the host's account is `Ian` (the join helpers log the others in as
//     `Mei`, `Amy`, `Leo`; a dev account's display name is its account name);
//   - the relay's test tap is on, so the run can say how many frames the whole flow sent through the relay
//     (`frames()`, DESIGN §9.5 item 6).
//
// The agents are the scripted stand-in `claude` (packages/daemon/src/testing/fake-claude.mjs): no Claude Code, no
// account, no network. Nothing here uses a moved clock: what waits in the story (a question nobody answers) waits in
// real time, for the shortest waiting time the host can set (one minute).
import { execFile } from 'node:child_process';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { Browser, Page } from 'playwright-core';
import { DEFAULT_FEATURE_MODULES, SYSTEM_PRINCIPAL, createDaemon, type Daemon } from '../../../../packages/daemon/src/index.ts';
import { createTempRunDir, installFakeClaude, isolatedGitEnv, removeTempRunDir, type FakeClaude, type FakeClaudeScenario } from '../../../../packages/daemon/src/testing/index.ts';
import type { HostSettings } from '@smurg/protocol';
import { bufferedLogger, waitUntil } from '../../../../tests/e2e/src/harness.ts';
import { createTempDir, removeTempDir, writeTree, type ProjectEntry } from '../../../../tests/e2e/src/temp.ts';
import { startLocalRelay, type LocalRelay } from '../../../relay/test-support/index.ts';
import { launchPages, type PageProblems, type SmokeLocale } from './helpers.ts';

const execFileAsync = promisify(execFile);

/** The host's dev account of a flow stack: the display name of a dev account is its account name. */
export const FLOW_HOST = 'Ian';

/** How many log lines and audit entries a failed test prints. */
const DIAGNOSTIC_LOG_LINES = 400;
const DIAGNOSTIC_AUDIT_ENTRIES = 200;

export interface FlowEnvOptions {
  /** Files of the shared folder (a git repository with one commit). */
  readonly projectFiles: Readonly<Record<string, ProjectEntry>>;
  /** What the stand-in `claude` does at first (`setScenario` changes it between steps). */
  readonly scenario: FakeClaudeScenario;
  /** The `smurg` command agent sessions run for their hooks and MCP tools. */
  readonly selfCommand: { readonly file: string; readonly args: readonly string[] };
  /** Host settings a fresh workspace starts with (on top of the daemon's defaults). */
  readonly settings?: Partial<HostSettings>;
}

/** What the relay's tap counted: WebSocket frames the relay received (`in`) and sent (`out`), since the stack started. */
export interface FrameCount {
  /** Frames the relay received: from the host's daemon and from the browsers. These are what a hosted relay is billed by. */
  readonly in: number;
  readonly inFromHost: number;
  readonly inFromClients: number;
  /** Frames the relay sent on (to the browsers and to the host). */
  readonly out: number;
  /** Bytes of the received frames. */
  readonly inBytes: number;
  /** HTTP requests the Worker answered (pages, assets, tokens, upgrades). */
  readonly requests: number;
}

export interface FlowEnv {
  readonly relay: LocalRelay;
  readonly browser: Browser;
  readonly origin: string;
  readonly allProblems: string[];
  readonly claude: FakeClaude;
  /** When the relay of this stack started (Date.now()): `frames()` counts from then. */
  readonly startedAt: number;
  /** The part of a stack the smoke helpers read; `daemon` is the one that runs NOW (another after `restartDaemon`). */
  readonly stack: { readonly workspaceId: string; readonly root: string; readonly stateDir: string; readonly daemon: Daemon };
  newPage(options?: { readonly width?: number; readonly height?: number; readonly locale?: SmokeLocale }): Promise<Page>;
  problemsOf(page: Page): PageProblems;
  invite(role: 'agent' | 'editor' | 'viewer'): Promise<string>;
  hostLink(): string;
  diagnostics(): Promise<string>;
  /** Replaces the stand-in's scenario in one step (a turn that starts meanwhile reads the old one or the new one, never half of one). */
  setScenario(scenario: FakeClaudeScenario): Promise<void>;
  /** Stops the host's daemon and starts it again on the same folder, state and home: what `smurg host` after a reboot does. */
  restartDaemon(): Promise<void>;
  /**
   * Kills the `claude` process of one agent session as a crash would (SIGKILL). Only a process whose command line
   * names THIS stack's own state directory and that session's launch files is signalled. Returns how many were.
   */
  killAgentOf(sessionId: string): Promise<number>;
  /** git in the shared folder, with an isolated configuration. */
  git(args: readonly string[]): Promise<string>;
  frames(): FrameCount;
  stop(): Promise<void>;
}

export async function startFlowEnv(options: FlowEnvOptions): Promise<FlowEnv> {
  const webDist = join(process.env['TMPDIR'] as string, 'web-dist');
  const stops: (() => Promise<void>)[] = [];
  try {
    const base = await createTempDir('flow');
    stops.push(() => removeTempDir(base));
    const root = join(base, 'project');
    const stateDir = join(base, 'state');
    const homeDir = join(base, 'home');
    await mkdir(homeDir, { recursive: true, mode: 0o700 });
    const runDir = await createTempRunDir();
    stops.push(() => removeTempRunDir(runDir));
    await writeTree(root, options.projectFiles);
    const gitEnv = isolatedGitEnv(join(base, '.git-home'));
    await mkdir(join(base, '.git-home'), { recursive: true });
    const git = async (args: readonly string[]): Promise<string> => (await execFileAsync('git', [...args], { cwd: root, env: gitEnv, maxBuffer: 16 * 1024 * 1024 })).stdout.trim();
    await git(['init', '-q', '-b', 'main']);
    await git(['add', '-A']);
    await git(['commit', '-q', '-m', 'initial']);

    const claudeDir = join(base, 'claude');
    await mkdir(claudeDir, { recursive: true });
    const claude = await installFakeClaude(claudeDir, options.scenario);

    const relay = await startLocalRelay({ tap: true, webDist });
    stops.push(() => relay.stop());
    const startedAt = Date.now();
    const host = await relay.devLogin(FLOW_HOST, { displayName: FLOW_HOST });
    const workspaceId = await relay.createWorkspace(host.token);

    const daemonLog = bufferedLogger(4_000);
    let daemon: Daemon | null = null;
    const boot = async (): Promise<void> => {
      const next = await createDaemon({
        config: {
          stateDir,
          runDir,
          shareDir: root,
          workspaceId,
          hostUserId: host.userId,
          hostName: host.displayName,
          relayUrl: relay.origin,
          webOrigin: relay.origin,
          // caffeinate would keep the developer's machine awake.
          keepAwake: false,
          ...(options.settings ? { defaultSettings: options.settings } : {}),
          sessions: { claudePath: claude.path, selfCommand: { file: options.selfCommand.file, args: [...options.selfCommand.args] } },
        },
        relay: { token: host.token },
        homeDir,
        modules: DEFAULT_FEATURE_MODULES,
        log: daemonLog.log,
      });
      await next.start();
      daemon = next;
      await waitUntil(async () => {
        const [ws, xfer] = await Promise.all([relay.inspect('ws', workspaceId), relay.inspect('xfer', workspaceId)]);
        return ws.hostStatus === 'online' && xfer.hostStatus === 'online';
      }, 30_000, 'the daemon to be online at the relay (ws and xfer)');
    };
    const running = (): Daemon => {
      if (daemon === null) throw new Error('the daemon of this flow is stopped');
      return daemon;
    };
    stops.push(async () => {
      const last = daemon;
      daemon = null;
      await last?.stop('test-stopped');
    });
    await boot();

    const pages = await launchPages();
    stops.push(() => pages.close());

    const stack = {
      workspaceId,
      root: running().ctx.workspace.shareRealPath,
      stateDir,
      get daemon() {
        return running();
      },
    };

    return {
      relay,
      browser: pages.browser,
      origin: relay.origin,
      allProblems: pages.allProblems,
      claude,
      startedAt,
      stack,
      newPage: (size) => pages.newPage(size),
      problemsOf: (page) => pages.problemsOf(page),
      invite: async (role) => running().ctx.invites.create({ role, maxUses: 1 }, SYSTEM_PRINCIPAL).url,
      hostLink: () => running().internals.invites.createHostInvite().url,
      async diagnostics() {
        const lines = daemonLog.lines();
        if (daemon === null) return ['--- the daemon is stopped', ...lines.slice(-DIAGNOSTIC_LOG_LINES)].join('\n');
        const current = daemon;
        const sessions = current.ctx.services.sessions
          .list()
          .map((s) => `${s.id} ${s.kind} owner=${s.openedBy.userId} root=${s.root.kind} status=${s.status}${s.endReason === undefined ? '' : ` endReason=${s.endReason}`}`);
        await current.ctx.audit.flush().catch(() => {});
        const audit = await current.ctx.audit.query({ limit: DIAGNOSTIC_AUDIT_ENTRIES }).catch(() => []);
        return [
          `--- sessions (${sessions.length})`,
          ...sessions,
          `--- audit (last ${audit.length}, oldest first)`,
          ...[...audit].reverse().map((e) => `${new Date(e.at).toISOString()} ${e.action} ${e.outcome} ${e.target ?? ''} ${JSON.stringify(e.detail ?? {})}`),
          `--- daemon log (last ${Math.min(lines.length, DIAGNOSTIC_LOG_LINES)} of ${lines.length} lines kept)`,
          ...lines.slice(-DIAGNOSTIC_LOG_LINES),
        ].join('\n');
      },
      async setScenario(scenario) {
        const next = `${claude.scenarioPath}.next`;
        await writeFile(next, JSON.stringify(scenario));
        await rename(next, claude.scenarioPath);
      },
      async restartDaemon() {
        const last = running();
        daemon = null;
        await last.stop('test-restart');
        await boot();
      },
      async killAgentOf(sessionId) {
        // A session's launch files are in <stateDir>/sessions/<workspace>/<hex of the session id>/.
        const mark = `/${Buffer.from(sessionId, 'utf8').toString('hex')}/settings.json`;
        const { stdout } = await execFileAsync('ps', ['-axo', 'pid=,command='], { maxBuffer: 16 * 1024 * 1024 });
        let killed = 0;
        for (const line of stdout.split('\n')) {
          if (!line.includes(stateDir) || !line.includes(mark)) continue;
          const pid = Number.parseInt(line.trim().split(/\s+/)[0] ?? '', 10);
          if (!Number.isSafeInteger(pid) || pid <= 1) continue;
          process.kill(pid, 'SIGKILL'); // a child of this test's own daemon
          killed += 1;
        }
        return killed;
      },
      git,
      frames() {
        const count = { in: 0, inFromHost: 0, inFromClients: 0, out: 0, inBytes: 0, requests: 0 };
        for (const frame of relay.tap?.frames() ?? []) {
          if (frame.direction === 'request') count.requests += 1;
          else if (frame.direction === 'out') count.out += 1;
          else {
            count.in += 1;
            count.inBytes += frame.data.length;
            if (frame.role === 'host') count.inFromHost += 1;
            else count.inFromClients += 1;
          }
        }
        return count;
      },
      async stop() {
        for (const stop of stops.splice(0).reverse()) await stop().catch(() => {});
      },
    };
  } catch (error) {
    for (const stop of stops.splice(0).reverse()) await stop().catch(() => {});
    throw error;
  }
}
