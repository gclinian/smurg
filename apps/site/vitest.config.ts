import { fileURLToPath } from 'node:url';
import { defineProject } from 'vitest/config';
import { projectTmpRoot } from '../relay/test/test-tmp.ts';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
// The forks' TMPDIR: the local workerd's miniflare-* state and the dry-run output land here, and globalSetup's
// teardown removes it all (the pattern of apps/relay, apps/web/e2e/smoke and tests/e2e).
const tmpRoot = projectTmpRoot('site');

// The Worker's routing, wrangler.jsonc, the site served by a local workerd (wrangler's createTestHarness), the
// static checks of public/ and the dry-run build.
export default defineProject({
  test: {
    name: '@smurg/site',
    environment: 'node',
    include: ['test/**/*.test.ts'],
    // The test run's registry first (its teardown runs last): src/testing/run-registry.ts in @smurg/daemon.
    globalSetup: ['../../packages/daemon/src/testing/run-registry-setup.ts', './test/global-setup.ts'],
    // Starting workerd and bundling with wrangler take a few seconds on a cold cache.
    testTimeout: 60_000,
    hookTimeout: 60_000,
    // wrangler writes metrics consent, logs and caches under XDG_CONFIG_HOME: keep them in the repo even when the
    // tests are started without scripts/env.sh (ARCHITECTURE §0 rule 4).
    env: {
      XDG_CONFIG_HOME: process.env['XDG_CONFIG_HOME'] ?? `${repoRoot}.xdg`,
      WRANGLER_SEND_METRICS: 'false',
      WRANGLER_SEND_ERROR_REPORTS: 'false',
      TMPDIR: tmpRoot,
    },
  },
});
