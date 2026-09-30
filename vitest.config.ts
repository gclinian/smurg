import { defineConfig } from 'vitest/config';

// Root runner: `pnpm test` runs every package's own vitest config as one project each.
// Inside a package, `pnpm test` (vitest run) uses only that package's vitest.config.ts.
// apps/web/e2e/smoke is a project of its own: the smoke test of the BUILT web app served by the real relay.
export default defineConfig({
  test: {
    projects: ['packages/*', 'apps/*', 'apps/web/e2e/smoke', 'tests/*'],
    // The run's registry of test temp dirs and processes: whatever a test could not clean up (its worker died) is
    // removed after the run (packages/daemon/src/testing/run-registry.ts). Every project lists it too, for runs of
    // one package; in one vitest process they share a single registry.
    globalSetup: ['packages/daemon/src/testing/run-registry-setup.ts'],
  },
});
