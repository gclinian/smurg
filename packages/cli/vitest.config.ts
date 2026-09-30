import { defineProject } from 'vitest/config';

export default defineProject({
  test: {
    name: '@smurg/cli',
    environment: 'node',
    include: ['src/**/*.test.ts', 'test/**/*.test.ts'],
    // The test run's registry: temp dirs and processes a test could not clean up (a worker that died) are removed after
    // the run (src/testing/run-registry.ts in @smurg/daemon).
    globalSetup: ['../daemon/src/testing/run-registry-setup.ts'],
    // SMURG_NO_BROWSER=1 in every worker (and every process a test spawns with process.env): no test opens a browser.
    setupFiles: ['test/setup-no-browser.ts'],
    // node-pty (the attach tests' outer terminal) is a native addon: child processes, not worker threads.
    pool: 'forks',
    // The attach tests spawn daemons and PTYs on a machine shared with other builds: generous margins.
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
