import { ensureWebDist } from '../scripts/ensure-web-dist.ts';
import { createProjectTmpRoot, removeProjectTmpRoot } from './test-tmp.ts';

// createTestHarness validates assets.directory before starting workerd. The project's temp root (the forks' TMPDIR,
// see test-tmp.ts) is created here and removed by the teardown, after every fork exited, with whatever miniflare left.
export default function setup(): () => void {
  ensureWebDist();
  createProjectTmpRoot('relay');
  return () => removeProjectTmpRoot('relay');
}
