import { defineProject, mergeConfig } from 'vitest/config';
import { projectTmpRoot } from '../relay/test/test-tmp.ts';
import viteConfig from './vite.config.ts';

// The forks' TMPDIR: the browser tests (e2e/) start local relays whose miniflare state and stack temp dirs land there;
// e2e/global-setup.ts creates it and removes it after every fork exited (the pattern of apps/relay and tests/e2e).
const tmpRoot = projectTmpRoot('web');

// Reuse the app's Vite config (React transform, aliases, dedupe) so tests see the same module graph as the build.
// Components are tested in jsdom with @testing-library/react; the browser acceptance tests (e2e/, node environment)
// drive system Chrome against the real relay and daemon and skip themselves where no Chrome is installed.
export default mergeConfig(
  viteConfig,
  defineProject({
    test: {
      name: '@smurg/web',
      environment: 'jsdom',
      setupFiles: ['./src/testing/setup.ts'],
      include: ['src/**/*.test.{ts,tsx}', 'test/**/*.test.{ts,tsx}', 'e2e/**/*.e2e.test.ts'],
      // The test run's registry first (its teardown runs last): src/testing/run-registry.ts in @smurg/daemon.
      globalSetup: ['../../packages/daemon/src/testing/run-registry-setup.ts', './e2e/global-setup.ts'],
      // A shared, busy machine: generous per-test time (nothing here waits on real network or real timers for long).
      testTimeout: 20_000,
      env: {
        XDG_CONFIG_HOME: process.env['XDG_CONFIG_HOME'] ?? new URL('../../.xdg', import.meta.url).pathname,
        WRANGLER_SEND_METRICS: 'false',
        TMPDIR: tmpRoot,
      },
    },
  }),
);
