// TEST ONLY: a second daemon on the same state dir, share, workspace id and relay as a stopped test daemon (the
// harness's own pattern, see test/files/helpers.ts restartDaemon), to check what survives a restart.
import { dirname, join } from 'node:path';
import { createDaemon, type Daemon } from '../../src/daemon.ts';
import type { FeatureModule } from '../../src/core/context.ts';
import { silentLogger } from '../../src/core/logger.ts';
import { MEMORY_RELAY_ORIGIN, TEST_HOST_NAME, TEST_HOST_USER, waitFor, type TestDaemon } from '../../src/testing/index.ts';
import { createWorktreeModule } from '../../src/worktree/module.ts';

export async function restartDaemonWith(t: TestDaemon, modules: readonly FeatureModule[] = [createWorktreeModule()]): Promise<Daemon> {
  const daemon = await createDaemon({
    config: {
      stateDir: t.stateDir,
      runDir: t.runDir,
      shareDir: t.root,
      workspaceId: t.workspaceId,
      hostUserId: TEST_HOST_USER,
      hostName: TEST_HOST_NAME,
      relayUrl: MEMORY_RELAY_ORIGIN,
      webOrigin: MEMORY_RELAY_ORIGIN,
      keepAwake: false,
    },
    relay: { token: 'test-host-token', socketFactory: t.relay.hostSocketFactory() },
    identityKeys: { get: (kid) => (kid === t.issuer.kid ? t.issuer.publicKey : null), refresh: async () => {} },
    modules,
    clock: t.clock,
    log: silentLogger,
    homeDir: join(dirname(t.stateDir), 'home'),
    random: () => 0.5,
  });
  await daemon.start();
  await waitFor(() => t.relay.hostOnline('ws') && t.relay.hostOnline('xfer'), { timeoutMs: 10_000, what: 'the restarted daemon to reach the relay' });
  return daemon;
}
