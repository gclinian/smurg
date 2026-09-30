// TEST ONLY: the REAL sessions, sandbox (real srt) and hooks modules of one daemon (no relay), with fakes only for the
// services around them (locks, presence, activity: helpers.ts). Everything a sandboxed process could read lives under
// one temp directory with a FAKE host home (never the developer's); the hook command is the real `smurg hook` of the
// CLI (node + packages/cli/src/main.ts), so agent sessions pass the in-sandbox hook self-test for real.
import { randomBytes } from 'node:crypto';
import { mkdir, realpath, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import xtermHeadless from '@xterm/headless';
import type { ActivityConfig, SessionLaunchConfig } from '../../src/core/config.ts';
import type { FeatureModule } from '../../src/core/context.ts';
import type { ActivityFeed, ClientConnection, LockManager, PresenceService, Principal } from '../../src/core/interfaces.ts';
import { toDisposable } from '../../src/core/lifecycle.ts';
import { createLineLogger } from '../../src/core/logger.ts';
import { createDaemon, type Daemon } from '../../src/daemon.ts';
import { hooksModule } from '../../src/hooks/module.ts';
import { sandboxModule } from '../../src/sandbox/module.ts';
import { createSessionsModule } from '../../src/sessions/module.ts';
import type { SessionManagerImpl } from '../../src/sessions/session-manager.ts';
import { createTempDir, createTempRunDir, removeTempDir, removeTempRunDir } from '../../src/testing/index.ts';
import { FakeActivity, FakeLocks, FakePresence } from './helpers.ts';

const { Terminal } = xtermHeadless;

/** The `smurg` command as sessions run it in development: config.sessions.selfCommand = node + this file. */
export const CLI_MAIN = fileURLToPath(new URL('../../../cli/src/main.ts', import.meta.url));

export const TEST_CONN = { channelId: 'ch_real_stack', id: 'conn_real_stack' } as unknown as ClientConnection;

export interface RealStack {
  readonly daemon: Daemon;
  readonly sessions: SessionManagerImpl;
  readonly activity: FakeActivity;
  readonly base: string;
  /** The fake host home (config.sessions.hostHome). */
  readonly home: string;
  /** realpath of the share. */
  readonly share: string;
  readonly stateDir: string;
  readonly warnings: string[];
  /** Admits `userId` as a member with `role` and returns their principal. */
  member(userId: string, displayName: string, role: 'runner' | 'editor' | 'viewer'): Principal;
  host(): Principal;
  /** The current screen of a session (a fresh snapshot attach as `principal`), and the whole text without whitespace. */
  screen(sessionId: string, principal: Principal): Promise<string>;
  cleanup(): Promise<void>;
}

export interface RealStackOptions {
  readonly claudePath: string;
  readonly sessions?: Partial<SessionLaunchConfig>;
  readonly activity?: Partial<ActivityConfig>;
  readonly allowedDomains?: readonly string[];
  readonly files?: Readonly<Record<string, string>>;
  /** Default: the real `smurg hook` of the CLI. */
  readonly selfCommand?: { readonly file: string; readonly args: readonly string[] };
}

export async function startRealStack(options: RealStackOptions): Promise<RealStack> {
  const runDir = await createTempRunDir();
  const base = await createTempDir('sessions-real');
  let daemon: Daemon | null = null;
  try {
    const home = join(base, 'home');
    const share = join(home, 'projects', 'app');
    await mkdir(share, { recursive: true });
    for (const [rel, content] of Object.entries({ 'README.md': 'readme\n', ...options.files })) {
      await mkdir(join(share, rel, '..'), { recursive: true });
      await writeFile(join(share, rel), content);
    }
    await mkdir(join(home, '.ssh'), { recursive: true });
    await writeFile(join(home, '.ssh', 'id_ed25519'), `SMURG-FAKE-HOST-KEY-${randomBytes(4).toString('hex')}\n`);
    const warnings: string[] = [];
    const activity = new FakeActivity();
    const fakes: FeatureModule = {
      name: 'session-test-fakes',
      create: () => ({
        locks: new FakeLocks() as unknown as LockManager,
        presence: new FakePresence() as unknown as PresenceService,
        activity: activity as unknown as ActivityFeed,
      }),
      register: () => toDisposable(() => {}),
    };
    daemon = await createDaemon({
      config: {
        stateDir: join(home, '.smurg'),
        runDir,
        shareDir: share,
        workspaceId: `ws_test_${randomBytes(9).toString('base64url')}`,
        hostUserId: 'dev:host',
        hostName: 'Host',
        relayUrl: null,
        keepAwake: false,
        defaultSettings: { allowedDomains: [...(options.allowedDomains ?? [])] },
        sessions: {
          hostHome: home,
          claudePath: options.claudePath,
          selfCommand: options.selfCommand ?? { file: process.execPath, args: [CLI_MAIN] },
          ...options.sessions,
        },
        ...(options.activity ? { activity: options.activity } : {}),
      },
      modules: [fakes, sandboxModule, hooksModule, createSessionsModule({ hostEnv: () => ({ PATH: '/usr/bin:/bin', HOME: home, USER: 'host', LANG: 'en_US.UTF-8' }), keychain: async () => {} })],
      homeDir: home,
      log: createLineLogger({ level: 'warn', write: (line) => warnings.push(line) }),
    });
    await daemon.start();
    const d = daemon;
    const sessions = d.ctx.services.sessions as SessionManagerImpl;
    return {
      daemon: d,
      sessions,
      activity,
      base,
      home: await realpath(home),
      share: await realpath(share),
      stateDir: await realpath(join(home, '.smurg')),
      warnings,
      member(userId, displayName, role) {
        d.ctx.members.admitMember({ userId, displayName, role, at: Date.now() });
        return d.ctx.members.principalOf(userId) as Principal;
      },
      host: () => d.ctx.members.principalOf('dev:host') as Principal,
      async screen(sessionId, principal) {
        const start = await sessions.attach({ sessionId }, TEST_CONN, principal);
        sessions.detach(sessionId, TEST_CONN.channelId);
        const term = new Terminal({ cols: start.result.cols, rows: start.result.rows, scrollback: 2000, allowProposedApi: true });
        await new Promise<void>((resolve) => term.write(start.result.data as Uint8Array, () => resolve()));
        const lines: string[] = [];
        for (let i = 0; i < term.buffer.active.length; i++) lines.push(term.buffer.active.getLine(i)?.translateToString(true) ?? '');
        term.dispose();
        return lines.join('\n');
      },
      async cleanup() {
        await d.stop();
        await removeTempDir(base);
        await removeTempRunDir(runDir);
      },
    };
  } catch (err) {
    await daemon?.stop().catch(() => {});
    await removeTempDir(base).catch(() => {});
    await removeTempRunDir(runDir).catch(() => {});
    throw err;
  }
}

/** Waits until `predicate` holds (polling), or throws naming `what`. */
export async function until(predicate: () => boolean | Promise<boolean>, what: string, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}
