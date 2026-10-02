import { defineProject } from 'vitest/config';

// The repository's enforcement lints (ARCHITECTURE §10): tests that read the tree, not a package's behaviour.
// No package.json here on purpose: this folder is a vitest project of the root runner, not a workspace package (it
// has no dependencies of its own and no version to keep in step with the eight packages).
export default defineProject({
  test: {
    name: '@smurg/lint',
    environment: 'node',
    include: ['*.test.ts'],
    testTimeout: 60_000,
  },
});
