// TEST ONLY. The vitest globalSetup of every project (and of the root config): opens the test run's registry of temp
// dirs and processes and removes what the run's tests left behind once every test file finished (run-registry.ts).
import { startRunRegistry, type RegistryProject } from './run-registry.ts';

export default function setup(project: RegistryProject): () => Promise<void> {
  return startRunRegistry(project);
}
