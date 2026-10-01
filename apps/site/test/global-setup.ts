import { createProjectTmpRoot, removeProjectTmpRoot } from '../../relay/test/test-tmp.ts';

// The project's temp root (the forks' TMPDIR, see apps/relay/test/test-tmp.ts) is created here and removed by the
// teardown, after every fork exited, with whatever miniflare and the dry-run build left in it.
export default function setup(): () => void {
  createProjectTmpRoot('site');
  return () => removeProjectTmpRoot('site');
}
