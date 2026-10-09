// The production configuration builds (`wrangler deploy --dry-run`: no account, nothing deployed) as a maintainer's
// `wrangler deploy` would: wrangler runs the custom build (scripts/build.ts, which writes dist/), bundles the Worker
// and reads dist/ as the static assets. Also: the package scripts, and the notices a deploy publishes by default.
import { execFile, execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { INSTALL_SCRIPT, REPOSITORY } from '../src/routes.ts';
import { DOC_PAGES, LANGS, NOTICES_PLACEHOLDER, generateSite } from '../scripts/site.ts';
import { DIST, REPO_ROOT, SITE_ROOT, publicFiles, testSite } from './html.ts';

const run = promisify(execFile);
const WRANGLER = join(SITE_ROOT, 'node_modules', 'wrangler', 'bin', 'wrangler.js');

describe('production bundle', () => {
  it('builds with `wrangler deploy --dry-run`: the custom build writes dist/, then the Worker and its assets', async () => {
    const outdir = mkdtempSync(join(tmpdir(), 'smurg-site-dry-run-'));
    try {
      // execFile's timeout only ever signals the child it started itself.
      const { stdout, stderr } = await run(process.execPath, [WRANGLER, 'deploy', '--dry-run', '--outdir', outdir, '--config', 'wrangler.jsonc'], {
        cwd: SITE_ROOT,
        timeout: 120_000,
        // No banner: with it wrangler asks the npm registry for a newer version (its cache is in TMPDIR, which is new
        // for every run), and the process stays until that request ends: seconds, or longer than this test's time.
        env: { ...process.env, WRANGLER_SEND_METRICS: 'false', WRANGLER_SEND_ERROR_REPORTS: 'false', WRANGLER_HIDE_BANNER: 'true' },
      });
      expect(stdout).toContain('[custom build] Running: node "${SMURG_ROOT:?run source scripts/env.sh first}/apps/site/scripts/build.ts"');
      expect(stdout).toMatch(new RegExp(`smurg\\.ai: ${testSite().files.size} files in apps/site/dist \\(\\d+ written, \\d+ removed\\)`));
      // wrangler reads the assets from dist/ (it counts every index.html twice: as itself and as its directory).
      const served = [...testSite().files.keys()].filter((path) => path !== '_headers');
      const count = served.length + served.filter((path) => path === 'index.html' || path.endsWith('/index.html')).length;
      expect(stdout).toContain(`Read ${count} files from the assets directory ${DIST}`);
      expect(stdout).toContain('--dry-run: exiting now.');
      expect(`${stdout}\n${stderr}`).not.toMatch(/\[ERROR\]/);
      // The only binding is the static assets.
      expect(stdout).toMatch(/env\.ASSETS\s+Assets/);
      const bundle = readFileSync(join(outdir, 'index.js'), 'utf8');
      expect(bundle).toContain('https://downloads.smurg.ai');
      expect(bundle).toContain(INSTALL_SCRIPT.slice('https://downloads.smurg.ai'.length));
      // The Worker's other redirect: /github and /source go to the repository.
      expect(bundle).toContain(REPOSITORY);
      expect(existsSync(join(outdir, 'index.js.map'))).toBe(true);
      // What wrangler uploads is dist/: the site the tests check, generated pages included.
      const files = publicFiles(DIST).sort();
      expect(files).toEqual([...testSite().files.keys()].sort());
      for (const path of ['docs/index.html', 'docs/hosting/index.html', 'zh-TW/docs/index.html', 'zh-TW/docs/joining/index.html', 'docs/changelog/index.html', 'license/index.html', 'zh-TW/license/index.html', 'sitemap.xml', 'third-party-notices.txt']) {
        expect(readFileSync(join(DIST, path)).equals(testSite().files.get(path) as Buffer), path).toBe(true);
      }
    } finally {
      rmSync(outdir, { recursive: true, force: true });
    }
  }, 120_000);

  it('stops before bundling or uploading anything when the build refuses (here: a guide links a file that does not exist)', async () => {
    const sources = mkdtempSync(join(tmpdir(), 'smurg-site-refused-'));
    const outdir = join(sources, 'out');
    try {
      // A source tree with the docs and LICENSE but nothing else: the host guide's link to the relay's README (which
      // the site sends to GitHub) points at a file that is not there.
      for (const path of [...DOC_PAGES.flatMap((doc) => LANGS.map((lang) => doc[lang].source)), 'LICENSE']) {
        mkdirSync(join(sources, path, '..'), { recursive: true });
        writeFileSync(join(sources, path), readFileSync(join(REPO_ROOT, path)));
      }
      const env: NodeJS.ProcessEnv = { ...process.env, WRANGLER_SEND_METRICS: 'false', WRANGLER_SEND_ERROR_REPORTS: 'false', SMURG_SITE_SOURCE_ROOT: sources };
      const failure = await run(process.execPath, [WRANGLER, 'deploy', '--dry-run', '--outdir', outdir, '--config', 'wrangler.jsonc'], { cwd: SITE_ROOT, timeout: 120_000, env }).then(
        () => null,
        (error: { code: number; stdout: string; stderr: string }) => error,
      );
      expect(failure?.code).not.toBe(0);
      expect(`${failure?.stdout}\n${failure?.stderr}`).toContain('points at apps/relay/README.md, which does not exist in the repository');
      expect(`${failure?.stdout}\n${failure?.stderr}`).not.toContain('--dry-run: exiting now.');
      expect(existsSync(join(outdir, 'index.js'))).toBe(false);
    } finally {
      rmSync(sources, { recursive: true, force: true });
    }
  }, 120_000);

  it('the package scripts build the same way and never deploy', () => {
    const pkg = JSON.parse(readFileSync(join(SITE_ROOT, 'package.json'), 'utf8')) as { scripts: Record<string, string>; license: string; private: boolean };
    expect(pkg.scripts['build']).toMatch(/&& node scripts\/build\.ts$/);
    expect(pkg.scripts['dry-run']).toMatch(/wrangler deploy --dry-run --outdir \.wrangler\/dry-run$/);
    // Local previews build without the release's notices; a deploy never does (wrangler.jsonc's build runs without it).
    expect(pkg.scripts['dev']).toContain('SMURG_SITE_ALLOW_PLACEHOLDER=1 wrangler dev --ip 127.0.0.1');
    for (const [name, script] of Object.entries(pkg.scripts)) {
      expect(script.replace('wrangler deploy --dry-run', ''), name).not.toMatch(/wrangler deploy|wrangler publish|versions upload/);
    }
    // MIT like every package of the repository; never published to npm.
    expect(pkg.license).toBe('MIT');
    expect(pkg.private).toBe(true);
  });
});

describe('the notices a preview publishes when none is named (a deploy must name the release’s: test/generate.test.ts)', () => {
  it('are the executable’s complete notices from the license task’s generator: its Node.js section filled in', () => {
    // No SMURG_SITE_THIRD_PARTY_NOTICES (allowed for previews only): the build runs
    // `node scripts/third-party-notices.ts --executable`.
    const site = generateSite({ ...(process.env['SMURG_SITE_SOURCE_ROOT'] ? { repoRoot: process.env['SMURG_SITE_SOURCE_ROOT'] } : {}), allowPlaceholder: true });
    const notices = site.files.get('third-party-notices.txt')?.toString('utf8') ?? '';
    const expected = execFileSync(process.execPath, [join(REPO_ROOT, 'scripts', 'third-party-notices.ts'), '--executable'], { cwd: REPO_ROOT }).toString('utf8');
    expect(notices).toBe(expected);
    expect(notices).not.toContain(NOTICES_PLACEHOLDER);
    for (const name of ['node-pty', '@parcel/watcher', `node@${process.versions.node} (the Node.js runtime)`]) {
      expect(notices, name).toContain(name);
    }
    // Nothing of the guest sandbox (there is none: ARCHITECTURE §11 D-15).
    expect(notices).not.toMatch(/sandbox-runtime|apply-seccomp/);
    // The notices list the third-party components; about smurg itself they say that it is MIT-licensed.
    expect(notices).toContain('smurg itself is MIT-licensed');
    expect(notices).not.toMatch(/smurg is proprietary/i);
  });
});
