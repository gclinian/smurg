// The production configuration bundles (`wrangler deploy --dry-run`, no account, nothing deployed), and the key
// helper scripts produce what the relay accepts.
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { parseSigningKeys } from '../src/auth/keys.ts';
import { ensureDevVars } from '../scripts/ensure-dev-vars.ts';
import { STAND_IN_MARKER, webDistProblem } from '../scripts/ensure-web-dist.ts';

const run = promisify(execFile);
const RELAY_DIR = fileURLToPath(new URL('..', import.meta.url));
const WRANGLER = join(RELAY_DIR, 'node_modules', 'wrangler', 'bin', 'wrangler.js');

describe('production bundle', () => {
  it('builds with `wrangler deploy --dry-run` using the top-level (production) values', async () => {
    const outdir = mkdtempSync(join(tmpdir(), 'smurg-relay-dry-run-'));
    try {
      // execFile's timeout only ever signals the child it started itself.
      const { stdout } = await run(process.execPath, [WRANGLER, 'deploy', '--dry-run', '--outdir', outdir, '--env=', '--config', 'wrangler.jsonc'], {
        cwd: RELAY_DIR,
        timeout: 120_000,
        env: { ...process.env, WRANGLER_SEND_METRICS: 'false', WRANGLER_SEND_ERROR_REPORTS: 'false' },
      });
      expect(stdout).toContain('--dry-run: exiting now.');
      expect(stdout).toContain('env.DEV_LOGIN ("0")');
      expect(stdout).toContain('env.RELAY_TAP_URL ("")');
      // Empty until scripts/deploy-relay.sh writes the workers.dev URL of the first deploy (README「部署到 Cloudflare」).
      // wrangler shortens long values in this table ("https://smurg-relay.<sub>.workers..."), so only the start is checked.
      expect(stdout).toMatch(/env\.RELAY_ISSUER \("(?:https:\/\/smurg-relay\.[^"]+)?"\)/);
      const bundle = join(outdir, 'index.js');
      expect(existsSync(bundle)).toBe(true);
      expect(statSync(bundle).size).toBeGreaterThan(10_000);
      expect(readFileSync(bundle, 'utf8')).toContain('smurg-identity+jwt');
    } finally {
      rmSync(outdir, { recursive: true, force: true });
    }
  }, 120_000);
});

describe('the SPA the bundle would ship (build-quality review F3)', () => {
  it('refuses the stand-in page that the tests and `dev:relay` create, and a missing build; accepts a real one', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'smurg-relay-web-dist-'));
    try {
      expect(webDistProblem(join(dir, 'missing'))).toBe('missing');
      mkdirSync(join(dir, 'stand-in'));
      writeFileSync(join(dir, 'stand-in', STAND_IN_MARKER), '');
      writeFileSync(join(dir, 'stand-in', 'index.html'), '<p>stand-in</p>');
      expect(webDistProblem(join(dir, 'stand-in'))).toBe('stand-in');
      mkdirSync(join(dir, 'real'));
      expect(webDistProblem(join(dir, 'real'))).toBe('no-index');
      writeFileSync(join(dir, 'real', 'index.html'), '<!doctype html>');
      // SEC-E-04: no security headers for the SPA, or a served build manifest, is not deployable either.
      expect(webDistProblem(join(dir, 'real'))).toBe('no-headers');
      writeFileSync(join(dir, 'real', '_headers'), "/*\n  X-Frame-Options: DENY\n");
      expect(webDistProblem(join(dir, 'real'))).toBe('no-headers');
      writeFileSync(join(dir, 'real', '_headers'), "/*\n  Content-Security-Policy: default-src 'self'; frame-ancestors 'none'\n  X-Frame-Options: DENY\n");
      expect(webDistProblem(join(dir, 'real'))).toBeNull();
      mkdirSync(join(dir, 'real', '.vite'));
      expect(webDistProblem(join(dir, 'real'))).toBe('manifest-served');
      writeFileSync(join(dir, 'real', '.assetsignore'), '# build metadata\n.vite\n');
      expect(webDistProblem(join(dir, 'real'))).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    // The web app ships both files (the relay's local workerd applies them: apps/web/e2e/smoke checks the headers).
    const webPublic = join(RELAY_DIR, '..', 'web', 'public');
    expect(readFileSync(join(webPublic, '_headers'), 'utf8')).toMatch(/Content-Security-Policy:[^\n]*frame-ancestors 'none'/);
    expect(readFileSync(join(webPublic, '.assetsignore'), 'utf8').split('\n')).toContain('.vite');
    // The build script runs the check before wrangler, and the check exits non-zero on a problem.
    const pkg = JSON.parse(readFileSync(join(RELAY_DIR, 'package.json'), 'utf8')) as { scripts: Record<string, string> };
    expect(pkg.scripts['build']).toMatch(/node scripts\/check-web-dist\.ts && wrangler deploy/);
  });
});

describe('key scripts', () => {
  it('signing-key.ts prints a private Ed25519 JWK that the relay accepts', async () => {
    const { stdout } = await run(process.execPath, [join(RELAY_DIR, 'scripts', 'signing-key.ts')], { timeout: 30_000 });
    const keys = await parseSigningKeys(stdout);
    expect(keys.jwks.keys).toHaveLength(1);
    expect(keys.kid).toBe((JSON.parse(stdout) as { kid: string }).kid);
  });

  it('ensure-dev-vars.ts creates a 0600 file once and never overwrites it', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'smurg-relay-dev-vars-'));
    try {
      const path = join(dir, '.dev.vars');
      expect(await ensureDevVars(path)).toBe(true);
      expect(statSync(path).mode & 0o777).toBe(0o600);
      const first = readFileSync(path, 'utf8');
      const line = first.split('\n').find((l) => l.startsWith('RELAY_SIGNING_KEY='));
      await parseSigningKeys(line?.slice('RELAY_SIGNING_KEY='.length) ?? '');
      expect(await ensureDevVars(path)).toBe(false);
      expect(readFileSync(path, 'utf8')).toBe(first);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
