import { defineProject } from 'vitest/config';

export default defineProject({
  test: {
    name: '@smurg/daemon',
    environment: 'node',
    include: ['src/**/*.test.ts', 'test/**/*.test.ts'],
    // The test run's registry: temp dirs and processes a test could not clean up (a worker that died) are removed after
    // the run (src/testing/run-registry.ts in @smurg/daemon).
    globalSetup: ['./src/testing/run-registry-setup.ts'],
    // node-pty is a native addon: run test files in child processes (the vitest default), not worker threads.
    pool: 'forks',
    // No test may ever open the person's own browser: every CLI these tests spawn inherits this.
    env: { SMURG_NO_BROWSER: '1' },
  },
});
