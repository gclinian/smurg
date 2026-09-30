// TEST ONLY: a daemon with the real sessions module (test seams: fake claude, controlled host environment, /bin/sh)
// and fakes of the services it calls (helpers.ts). Every client is a real SDK Connection through the in-memory relay.
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { createSessionsModule } from '../../src/sessions/module.ts';
import type { SessionManagerImpl, SessionsModuleOptions } from '../../src/sessions/session-manager.ts';
import { createTestDaemon, registerTestDir, type TestDaemon } from '../../src/testing/index.ts';
import type { FeatureModule } from '../../src/core/context.ts';
import type { SessionLaunchConfig } from '../../src/core/config.ts';
import { createFakes, fakeServicesModule, writeFakeClaude, type Fakes } from './helpers.ts';

export interface SessionStack {
  readonly t: TestDaemon;
  readonly fakes: Fakes;
  readonly sessions: SessionManagerImpl;
  readonly fakeClaude: { path: string; logDir: string };
  /** A fake home for host sessions (never the developer's). */
  readonly hostHome: string;
  readonly keychainCalls: { services: readonly string[]; account: string }[];
  cleanup(): Promise<void>;
}

export interface SessionStackOptions {
  readonly claudeVersion?: string;
  readonly module?: Partial<SessionsModuleOptions>;
  /** Host environment of host sessions; default: a small controlled one (never process.env with real secrets). */
  readonly hostEnv?: (home: string) => Readonly<Record<string, string | undefined>>;
  readonly project?: Record<string, string>;
  readonly extraModules?: readonly FeatureModule[];
  readonly fakes?: boolean;
  /** More of the daemon's config.sessions (e.g. guestSubscriptionLogin). */
  readonly daemonSessions?: Partial<SessionLaunchConfig>;
  /** A stand-in `claude` script to use instead of writeFakeClaude's (written by the test). */
  readonly claudePath?: string;
}

export async function startSessionStack(options: SessionStackOptions = {}): Promise<SessionStack> {
  const fakes = createFakes();
  const scratch = await mkdtemp(join(process.env['TMPDIR'] ?? '/tmp', 'smurg-sessions-'));
  registerTestDir(scratch);
  const hostHome = join(scratch, 'host-home');
  await mkdir(hostHome, { recursive: true });
  const fakeClaude = await writeFakeClaude(scratch, options.claudeVersion ?? '2.1.283');
  const keychainCalls: { services: readonly string[]; account: string }[] = [];
  const hostEnv =
    options.hostEnv?.(hostHome) ??
    Object.freeze({
      PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
      HOME: hostHome,
      USER: process.env['USER'] ?? 'host',
      LANG: 'en_US.UTF-8',
      SHELL: '/bin/sh',
      BASH_SILENCE_DEPRECATION_WARNING: '1',
    });
  const sessionsModule = createSessionsModule({
    hostEnv: () => hostEnv,
    hostShell: '/bin/sh',
    guestShell: '/bin/sh',
    launch: { claudePath: options.claudePath ?? fakeClaude.path, selfCommand: { file: '/usr/bin/true', args: [] } },
    keychain: async (services, account) => {
      keychainCalls.push({ services, account });
    },
    ...options.module,
  });
  const t = await createTestDaemon({
    modules: [...(options.fakes === false ? [] : [fakeServicesModule(fakes)]), ...(options.extraModules ?? []), sessionsModule],
    // The hooks writer (HookServer.writeSessionFiles) reads the self command from the daemon's configuration.
    sessions: { selfCommand: { file: '/usr/bin/true', args: [] }, ...options.daemonSessions },
    ...(options.project ? { project: { files: options.project } } : {}),
  });
  const sessions = t.ctx.services.sessions as SessionManagerImpl;
  return {
    t,
    fakes,
    sessions,
    fakeClaude,
    hostHome,
    keychainCalls,
    cleanup: async () => {
      await t.cleanup();
      await rm(scratch, { recursive: true, force: true });
    },
  };
}
