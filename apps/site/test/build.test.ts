// The production configuration bundles (`wrangler deploy --dry-run`: no account, nothing deployed), as the lead's
// `wrangler deploy` would build it.
import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { INSTALL_SCRIPT } from '../src/routes.ts';
import { SITE_ROOT } from './html.ts';

const run = promisify(execFile);
const WRANGLER = join(SITE_ROOT, 'node_modules', 'wrangler', 'bin', 'wrangler.js');

describe('production bundle', () => {
  it('builds with `wrangler deploy --dry-run`, with the static assets and the redirects', async () => {
    const outdir = mkdtempSync(join(tmpdir(), 'smurg-site-dry-run-'));
    try {
      // execFile's timeout only ever signals the child it started itself.
      const { stdout, stderr } = await run(process.execPath, [WRANGLER, 'deploy', '--dry-run', '--outdir', outdir, '--config', 'wrangler.jsonc'], {
        cwd: SITE_ROOT,
        timeout: 120_000,
        env: { ...process.env, WRANGLER_SEND_METRICS: 'false', WRANGLER_SEND_ERROR_REPORTS: 'false' },
      });
      expect(stdout).toContain('--dry-run: exiting now.');
      expect(`${stdout}\n${stderr}`).not.toMatch(/\[ERROR\]/);
      // The only binding is the static assets.
      expect(stdout).toMatch(/env\.ASSETS\s+Assets/);
      const bundle = readFileSync(join(outdir, 'index.js'), 'utf8');
      // The bundle keeps the template literals of src/routes.ts: look for the parts.
      expect(bundle).toContain(INSTALL_SCRIPT.slice('https://github.com/gclinian/smurg'.length));
      expect(bundle).toContain('https://github.com/gclinian/smurg');
      expect(existsSync(join(outdir, 'index.js.map'))).toBe(true);
    } finally {
      rmSync(outdir, { recursive: true, force: true });
    }
  }, 120_000);

  it('the package scripts build the same way and never deploy', () => {
    const pkg = JSON.parse(readFileSync(join(SITE_ROOT, 'package.json'), 'utf8')) as { scripts: Record<string, string> };
    expect(pkg.scripts['build']).toMatch(/wrangler deploy --dry-run --outdir dist$/);
    for (const [name, script] of Object.entries(pkg.scripts)) {
      expect(script.replace('wrangler deploy --dry-run', ''), name).not.toMatch(/wrangler deploy|wrangler publish|versions upload/);
    }
  });
});
