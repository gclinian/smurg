// Builds the web app ONCE per run, exactly as `pnpm --filter @smurg/web build` does (vite build + the chunk guard),
// but into this project's temp root instead of apps/web/dist: the relay tests serve apps/web/dist concurrently, and a
// build that empties it underneath them would race. The smoke test then serves this build from the real relay.
import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { createProjectTmpRoot, projectTmpRoot, removeProjectTmpRoot } from '../../../relay/test/test-tmp.ts';
import { systemChrome } from '../chrome.ts';

const run = promisify(execFile);
const WEB_ROOT = fileURLToPath(new URL('../..', import.meta.url));

export default async function setup(): Promise<() => void> {
  createProjectTmpRoot('web-smoke');
  const root = projectTmpRoot('web-smoke');
  // Without system Chrome the test skips itself (loudly): no build needed then.
  if (systemChrome() !== null) {
    const outDir = join(root, 'web-dist');
    // A child process: vite build sets NODE_ENV=production for its own process, which must not leak into vitest's.
    const env = { ...process.env, TMPDIR: root, NODE_ENV: 'production' };
    await run(process.execPath, [join(WEB_ROOT, 'node_modules', 'vite', 'bin', 'vite.js'), 'build', '--outDir', outDir, '--emptyOutDir', '--logLevel', 'warn'], {
      cwd: WEB_ROOT,
      env,
      maxBuffer: 64 * 1024 * 1024,
    });
    // The same guard `pnpm build` runs: Monaco and xterm stay out of the initial load.
    await run(process.execPath, [join(WEB_ROOT, 'scripts', 'check-chunks.ts'), outDir], { cwd: WEB_ROOT, env, maxBuffer: 16 * 1024 * 1024 });
  }
  return () => removeProjectTmpRoot('web-smoke');
}
