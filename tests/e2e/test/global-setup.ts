import { createProjectTmpRoot, removeProjectTmpRoot } from '../../../apps/relay/test/test-tmp.ts';

// The e2e forks' TMPDIR (apps/relay/test/test-tmp.ts): created before the forks start, removed after they all exited,
// with whatever the local relays' miniflare and the stacks left in it.
export default function setup(): () => void {
  createProjectTmpRoot('e2e');
  return () => removeProjectTmpRoot('e2e');
}
