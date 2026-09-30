import { fileURLToPath } from 'node:url';
import { defineProject } from 'vitest/config';
import { projectTmpRoot } from '../../../relay/test/test-tmp.ts';

// The smoke test of the BUILT web app (its own project: it builds the app once in globalSetup and runs in Node, not
// jsdom). The forks' TMPDIR holds the build, the local relay's miniflare state and the stack's temp dirs; globalSetup
// creates it and removes it after every fork exited (the pattern of apps/relay and tests/e2e).
const tmpRoot = projectTmpRoot('web-smoke');

export default defineProject({
  test: {
    name: '@smurg/web-smoke',
    environment: 'node',
    include: ['**/*.smoke.test.ts'],
    // The test run's registry first (its teardown runs last): src/testing/run-registry.ts in @smurg/daemon.
    globalSetup: ['../../../../packages/daemon/src/testing/run-registry-setup.ts', './global-setup.ts'],
    // Each file starts a real relay (workerd), a daemon with every module and a Chrome: at most two at once, so the
    // full gate (every project in parallel on an 8-core laptop) stays responsive.
    maxWorkers: 2,
    // vitest runs projects with their own maxWorkers only in a group of their own (it refuses to start the root run
    // otherwise): in the full gate this project runs after every other project finished, on an otherwise idle
    // machine. A run of this project alone (--project @smurg/web-smoke) is unaffected.
    sequence: { groupOrder: 1 },
    // A shared, busy machine: a production build of Monaco plus a real browser session.
    testTimeout: 180_000,
    hookTimeout: 180_000,
    env: {
      XDG_CONFIG_HOME: process.env['XDG_CONFIG_HOME'] ?? fileURLToPath(new URL('../../../../.xdg', import.meta.url)),
      WRANGLER_SEND_METRICS: 'false',
      TMPDIR: tmpRoot,
    },
  },
});
