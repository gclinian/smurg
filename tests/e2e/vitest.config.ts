import { fileURLToPath } from 'node:url';
import { defineProject } from 'vitest/config';
import { projectTmpRoot } from '../../apps/relay/test/test-tmp.ts';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
// The forks' TMPDIR (miniflare state of the local relays, stack temp dirs); removed by globalSetup's teardown.
const tmpRoot = projectTmpRoot('e2e');

export default defineProject({
  test: {
    name: '@smurg/e2e',
    environment: 'node',
    include: ['test/**/*.test.ts'],
    testTimeout: 60_000,
    hookTimeout: 60_000,
    // Acceptance tests start relays, daemons and clients on fixed resources: run files one at a time.
    fileParallelism: false,
    // The test run's registry first (its teardown runs last): src/testing/run-registry.ts in @smurg/daemon.
    globalSetup: ['../../packages/daemon/src/testing/run-registry-setup.ts', './test/global-setup.ts'],
    env: {
      XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME ?? `${repoRoot}.xdg`,
      WRANGLER_SEND_METRICS: 'false',
      TMPDIR: tmpRoot,
      // No test may ever open the person's own browser: every CLI these tests spawn inherits this.
      SMURG_NO_BROWSER: '1',
    },
  },
});
