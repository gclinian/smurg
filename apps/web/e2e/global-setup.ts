import { createProjectTmpRoot, removeProjectTmpRoot } from '../../relay/test/test-tmp.ts';

// The web project's TMPDIR (see vitest.config.ts): created before the forks start, removed after they all exited,
// with whatever the browser tests' local relays (miniflare) and stacks left in it.
export default function setup(): () => void {
  createProjectTmpRoot('web');
  return () => removeProjectTmpRoot('web');
}
