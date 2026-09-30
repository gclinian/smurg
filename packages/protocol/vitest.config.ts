import { defineProject } from 'vitest/config';

export default defineProject({
  test: {
    name: '@smurg/protocol',
    environment: 'node',
    include: ['src/**/*.test.ts', 'test/**/*.test.ts'],
    // Removes vitest's own module dump dir after a run of this package alone (src/testing/run-registry.ts in
    // @smurg/daemon; only node built-ins are loaded).
    globalSetup: ['../daemon/src/testing/run-registry-setup.ts'],
  },
});
