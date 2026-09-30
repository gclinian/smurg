import { fileURLToPath } from 'node:url';
import { defineProject } from 'vitest/config';
import { projectTmpRoot } from './test/test-tmp.ts';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
// The forks' TMPDIR: every local relay's miniflare-* state lands here, and globalSetup's teardown removes it all.
const tmpRoot = projectTmpRoot('relay');

export default defineProject({
  test: {
    name: '@smurg/relay',
    environment: 'node',
    include: ['test/**/*.test.ts'],
    // The test run's registry first (its teardown runs last): src/testing/run-registry.ts in @smurg/daemon.
    globalSetup: ['../../packages/daemon/src/testing/run-registry-setup.ts', './test/global-setup.ts'],
    // Starting workerd through createTestHarness takes a few seconds on a cold cache.
    testTimeout: 60_000,
    hookTimeout: 60_000,
    // wrangler's library code writes metrics consent, logs and caches under XDG_CONFIG_HOME: keep them in the repo
    // even when the tests are started without scripts/env.sh (ARCHITECTURE §0 rule 4).
    env: {
      XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME ?? `${repoRoot}.xdg`,
      WRANGLER_SEND_METRICS: 'false',
      TMPDIR: tmpRoot,
    },
  },
});
