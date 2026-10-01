// The site build (scripts/site.ts, scripts/build.ts) on small fixture repositories: what it generates, what it refuses,
// and how it writes dist/.
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, describe, expect, it } from 'vitest';
import { NOTICES_PLACEHOLDER, PLACEHOLDER, SiteError, generateSite, writeSite, type SiteOptions } from '../scripts/site.ts';
import { FIXTURE_NOTICES, PUBLIC, REPO_ROOT, SITE_ROOT, parsePage, publicFiles } from './html.ts';

const run = promisify(execFile);
const BUILD = join(SITE_ROOT, 'scripts', 'build.ts');
const temps: string[] = [];

afterAll(() => {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true });
});

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  temps.push(dir);
  return dir;
}

const DOCS = {
  'docs/HOSTING.md': '# 主人指南\n\n組員請看 [`JOINING.md`](JOINING.md#2-角色)，授權見 [LICENSE](../LICENSE)。\n\n## 1. 安裝\n\n內部文件：[ARCHITECTURE](ARCHITECTURE.md)。\n\n## 2. 分享\n\n回到 [安裝](#1-安裝)。\n',
  'docs/JOINING.md': '# 組員指南\n\n主人請看 [HOSTING.md](./HOSTING.md)。\n\n## 1. 加入\n\n文字。\n\n## 2. 角色\n\n文字。\n',
  'CHANGELOG.md': '# 變更紀錄\n\n格式參考 [Keep a Changelog](https://keepachangelog.com/zh-TW/1.1.0/)。\n\n## [0.1.0] - 2026-10-01\n\n見 [`docs/HOSTING.md`](docs/HOSTING.md#2-分享) 與 [spec](SPEC.md)。\n',
  LICENSE: 'smurg\n\nCopyright (c) 2026 Example Holder. All rights reserved.\n',
} as const;

/** A repository with the three docs and LICENSE, some of them replaced. */
function fixtureRepo(overrides: Partial<Record<keyof typeof DOCS, string>> = {}): string {
  const root = tempDir('site-fixture-');
  for (const [path, text] of Object.entries({ ...DOCS, ...overrides })) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
}

function problemsOf(options: SiteOptions): readonly string[] {
  try {
    generateSite(options);
  } catch (error) {
    if (error instanceof SiteError) return error.problems;
    throw error;
  }
  return [];
}

describe('generateSite', () => {
  it('renders the docs at their URLs, rewrites links between them and turns the internal ones into text', () => {
    const site = generateSite({ repoRoot: fixtureRepo(), notices: FIXTURE_NOTICES });
    const hosting = site.files.get('docs/hosting/index.html')?.toString('utf8') ?? '';
    expect(hosting).toContain('<a href="/docs/joining/#2-角色"><code>JOINING.md</code></a>');
    expect(hosting).toContain('<a href="/license/">LICENSE</a>');
    expect(hosting).toContain('內部文件：ARCHITECTURE。');
    expect(hosting).toContain('<a href="#1-安裝">安裝</a>');
    const changelog = site.files.get('docs/changelog/index.html')?.toString('utf8') ?? '';
    expect(changelog).toContain('<a href="https://keepachangelog.com/zh-TW/1.1.0/">Keep a Changelog</a>');
    expect(changelog).toContain('<a href="/docs/hosting/#2-分享"><code>docs/HOSTING.md</code></a>');
    expect(site.rewritten).toEqual([
      'docs/HOSTING.md:3 [JOINING.md](JOINING.md#2-角色) -> /docs/joining/#2-角色',
      'docs/HOSTING.md:3 [LICENSE](../LICENSE) -> /license/',
      'docs/JOINING.md:3 [HOSTING.md](./HOSTING.md) -> /docs/hosting/',
      'CHANGELOG.md:7 [docs/HOSTING.md](docs/HOSTING.md#2-分享) -> /docs/hosting/#2-分享',
    ]);
    expect(site.plain).toEqual([
      'docs/HOSTING.md:7 [ARCHITECTURE](ARCHITECTURE.md) -> plain text (docs/ARCHITECTURE.md is not published)',
      'CHANGELOG.md:7 [spec](SPEC.md) -> plain text (SPEC.md is not published)',
    ]);
    for (const path of ['docs/index.html', 'docs/hosting/index.html', 'docs/joining/index.html', 'docs/changelog/index.html', 'license/index.html']) {
      expect(parsePage(site.files.get(path)?.toString('utf8') ?? '').errors, path).toEqual([]);
    }
    expect(site.files.get('license/index.html')?.toString('utf8')).toContain('Copyright (c) 2026 Example Holder. All rights reserved.');
  });

  it('turns every link that is not https into text (GitHub links never get this far: see the next test)', () => {
    const repo = fixtureRepo({
      'docs/JOINING.md': '# 組員指南\n\n[a](http://example.com/) [b](//example.com/x) [c](mailto:a@example.com) [d](javascript:alert(1)) [e](https://example.com/ok)\n\n## 2. 角色\n',
    });
    const site = generateSite({ repoRoot: repo, notices: FIXTURE_NOTICES });
    const joining = site.files.get('docs/joining/index.html')?.toString('utf8') ?? '';
    expect(joining).toContain('<p>a b c d <a href="https://example.com/ok">e</a></p>');
    expect(site.plain.filter((line) => line.startsWith('docs/JOINING.md'))).toEqual([
      'docs/JOINING.md:3 [a](http://example.com/) -> plain text (a http: link (only https links are kept))',
      'docs/JOINING.md:3 [b](//example.com/x) -> plain text (a protocol-relative link)',
      'docs/JOINING.md:3 [c](mailto:a@example.com) -> plain text (a mailto: link (only https links are kept))',
      'docs/JOINING.md:3 [d](javascript:alert(1)) -> plain text (a javascript: link (only https links are kept))',
    ]);
  });

  it('refuses docs that mention github.com, naming the line (the source is private)', () => {
    const repo = fixtureRepo({ 'docs/HOSTING.md': '# 主人指南\n\n```sh\ncurl -fsSL https://github.com/gclinian/smurg/releases/latest/download/install.sh | sh\n```\n\n[repo](https://github.com/x/y)\n' });
    // (The fixture's other docs link to headings this HOSTING.md does not have: those problems are left out here.)
    const problems = problemsOf({ repoRoot: repo, notices: FIXTURE_NOTICES }).filter((p) => p.startsWith('docs/HOSTING.md'));
    expect(problems).toEqual([
      'docs/HOSTING.md:4 mentions github.com (the source is private): curl -fsSL https://github.com/gclinian/smurg/releases/latest/download/install.sh | sh',
      'docs/HOSTING.md:7 mentions github.com (the source is private): [repo](https://github.com/x/y)',
    ]);
  });

  it('refuses a #link to a heading that does not exist, in the page or in another doc', () => {
    const repo = fixtureRepo({ 'docs/JOINING.md': '# 組員指南\n\n[a](#nope) [b](HOSTING.md#nope) [c](HOSTING.md#2-分享)\n\n## 2. 角色\n' });
    expect(problemsOf({ repoRoot: repo, notices: FIXTURE_NOTICES })).toEqual([
      'docs/joining/index.html: <a href="#nope">: no element has this id',
      'docs/joining/index.html: <a href="/docs/hosting/#nope">: docs/hosting/index.html has no element with this id',
    ]);
  });

  it('refuses a doc without exactly one h1 first, or with a skipped heading level, or with an image', () => {
    const repo = fixtureRepo({ 'docs/JOINING.md': '## 先\n\n# 一\n\n# 二\n\n#### 跳\n\n![x](x.png)\n\n## 2. 角色\n' });
    expect(problemsOf({ repoRoot: repo, notices: FIXTURE_NOTICES })).toEqual([
      'docs/JOINING.md: line 9: an image (x.png); the site has no images from the docs',
      'docs/JOINING.md: needs exactly one level-1 heading (#), before any other heading',
      'docs/JOINING.md: "跳" skips a heading level',
    ]);
  });

  it('refuses the LICENSE placeholder and unfilled notices unless told to build anyway (previews and tests)', () => {
    const repo = fixtureRepo({ LICENSE: `smurg\n\nCopyright (c) 2026 ${PLACEHOLDER}. All rights reserved.\n` });
    const notices = join(tempDir('site-notices-'), 'notices.txt');
    writeFileSync(notices, `x@1.0.0\n\nNode.js runtime\n\n${NOTICES_PLACEHOLDER} into the executable …\n`);
    const problems = problemsOf({ repoRoot: repo, notices });
    expect(problems).toHaveLength(2);
    expect(problems[0]).toMatch(/^LICENSE still names the copyright holder "<COPYRIGHT HOLDER>"/);
    expect(problems[1]).toMatch(/the Node\.js section is still the committed placeholder/);
    expect(problemsOf({ repoRoot: repo, notices, allowPlaceholder: true })).toEqual([]);
  });

  it('a deploy names the release’s notices: no file named, or one without the Node.js section, is refused (previews may)', () => {
    const repo = fixtureRepo();
    // Without SMURG_SITE_THIRD_PARTY_NOTICES the notices would carry the LICENSE of the Node.js running the build, not
    // of the one the executables are copies of.
    const unnamed = problemsOf({ repoRoot: repo });
    expect(unnamed).toHaveLength(1);
    expect(unnamed[0]).toMatch(/^third-party notices: a deploy publishes the release's own THIRD-PARTY-NOTICES\.txt, so name it: SMURG_SITE_THIRD_PARTY_NOTICES=<file>/);
    expect(unnamed[0]).toContain('https://downloads.smurg.ai/v<X.Y.Z>/THIRD-PARTY-NOTICES.txt');
    expect(unnamed[0]).toContain('node scripts/third-party-notices.ts --executable --out');
    // A file that is not the executables' notices (no Node.js section), e.g. the web app's.
    const web = join(tempDir('site-notices-'), 'web.txt');
    writeFileSync(web, readFileSync(join(REPO_ROOT, 'apps', 'web', 'public', 'third-party-notices.txt')));
    expect(problemsOf({ repoRoot: repo, notices: web })).toEqual([`third-party notices (${web}): no Node.js section ("node@X.Y.Z (the Node.js runtime)" and the Node.js LICENSE): not the executables' notices (the release's THIRD-PARTY-NOTICES.txt has it)`]);
    expect(problemsOf({ repoRoot: repo, notices: web, allowPlaceholder: true })).toEqual([]);
    expect(problemsOf({ repoRoot: repo, notices: FIXTURE_NOTICES })).toEqual([]);
  });

  it('fails clearly without notices, or with notices that are empty or not UTF-8 (and checks the links only once it has them)', () => {
    const repo = fixtureRepo();
    const dir = tempDir('site-notices-');
    writeFileSync(join(dir, 'empty.txt'), '\n');
    writeFileSync(join(dir, 'latin1.txt'), Buffer.from([0x63, 0x61, 0x66, 0xe9]));
    expect(problemsOf({ repoRoot: repo, notices: join(dir, 'missing.txt') })).toEqual([`third-party notices (${join(dir, 'missing.txt')}): the file does not exist`]);
    expect(problemsOf({ repoRoot: repo, notices: join(dir, 'empty.txt') })).toEqual([`third-party notices (${join(dir, 'empty.txt')}): empty`]);
    expect(problemsOf({ repoRoot: repo, notices: join(dir, 'latin1.txt') })).toEqual([`third-party notices (${join(dir, 'latin1.txt')}): not UTF-8 text`]);
  });

  it('refuses a file of public/ that the build would generate as well, and a missing doc', () => {
    const publicDir = tempDir('site-public-');
    for (const path of publicFiles()) {
      mkdirSync(dirname(join(publicDir, path)), { recursive: true });
      writeFileSync(join(publicDir, path), readFileSync(join(PUBLIC, path)));
    }
    mkdirSync(join(publicDir, 'license'));
    writeFileSync(join(publicDir, 'license', 'index.html'), '<!doctype html>');
    const repo = fixtureRepo();
    rmSync(join(repo, 'CHANGELOG.md'));
    const problems = problemsOf({ repoRoot: repo, publicDir, notices: FIXTURE_NOTICES });
    expect(problems.filter((p) => !p.includes('/docs/changelog/'))).toEqual([
      `CHANGELOG.md: ${join(repo, 'CHANGELOG.md')} does not exist`,
      'license/index.html is both in public/ and generated by the build',
    ]);
  });

  it('is deterministic: the same sources give the same bytes', () => {
    const repo = fixtureRepo();
    const a = generateSite({ repoRoot: repo, notices: FIXTURE_NOTICES });
    const b = generateSite({ repoRoot: repo, notices: FIXTURE_NOTICES });
    expect([...a.files.keys()]).toEqual([...b.files.keys()]);
    for (const [path, data] of a.files) expect(data.equals(b.files.get(path) as Buffer), path).toBe(true);
    expect([...a.files.keys()]).toEqual([...a.files.keys()].sort());
  });
});

describe('writeSite', () => {
  it('writes only what changed, removes what is no longer part of the site, and leaves no temporary file', () => {
    const files = generateSite({ repoRoot: fixtureRepo(), notices: FIXTURE_NOTICES }).files;
    const out = join(tempDir('site-out-'), 'dist');
    expect(writeSite(out, files)).toEqual({ written: files.size, removed: 0 });
    expect(writeSite(out, files)).toEqual({ written: 0, removed: 0 });
    writeFileSync(join(out, 'stale.html'), 'old');
    mkdirSync(join(out, 'old', 'dir'), { recursive: true });
    writeFileSync(join(out, 'old', 'dir', 'x.txt'), 'old');
    writeFileSync(join(out, 'index.html'), 'changed by hand');
    expect(writeSite(out, files)).toEqual({ written: 1, removed: 2 });
    expect(existsSync(join(out, 'old'))).toBe(false);
    for (const [path, data] of files) expect(readFileSync(join(out, path)).equals(data), path).toBe(true);
    // The temporary files go through .wrangler/tmp next to the output (gitignored, never uploaded).
    expect(readdirSync(join(dirname(out), '.wrangler', 'tmp', 'site-build'))).toEqual([]);
  });

  it('refuses to write into the repository, the site, public/ or a directory that contains them', () => {
    const files = new Map([['x.txt', Buffer.from('x')]]);
    for (const dir of [REPO_ROOT, SITE_ROOT, PUBLIC, join(PUBLIC, 'sub'), dirname(REPO_ROOT)]) {
      expect(() => writeSite(dir, files), dir).toThrow(/refusing to write the site/);
    }
  });
});

describe('scripts/build.ts', () => {
  const env = (extra: Record<string, string>): NodeJS.ProcessEnv => {
    const base = { ...process.env };
    delete base['SMURG_SITE_THIRD_PARTY_NOTICES'];
    delete base['SMURG_SITE_ALLOW_PLACEHOLDER'];
    delete base['SMURG_SITE_SOURCE_ROOT'];
    return { ...base, ...extra };
  };

  it('exits 1 and lists the problems, writing nothing, when the site cannot be built', async () => {
    const repo = fixtureRepo({ LICENSE: `Copyright (c) 2026 ${PLACEHOLDER}.\n`, 'docs/JOINING.md': '# 組員\n\n[x](#nope)\n\n## 2. 角色\n' });
    const error = await run(process.execPath, [BUILD], {
      cwd: SITE_ROOT,
      env: env({ SMURG_SITE_SOURCE_ROOT: repo, SMURG_SITE_THIRD_PARTY_NOTICES: FIXTURE_NOTICES }),
    }).then(
      () => null,
      (e: { code: number; stderr: string }) => e,
    );
    expect(error?.code).toBe(1);
    expect(error?.stderr).toContain('the smurg.ai build failed:');
    expect(error?.stderr).toContain('LICENSE still names the copyright holder "<COPYRIGHT HOLDER>"');
    expect(error?.stderr).toContain('docs/joining/index.html: <a href="#nope">: no element has this id');
  });

  it('a deploy build without SMURG_SITE_THIRD_PARTY_NOTICES is refused before anything is written', async () => {
    const repo = fixtureRepo();
    const error = await run(process.execPath, [BUILD], { cwd: SITE_ROOT, env: env({ SMURG_SITE_SOURCE_ROOT: repo }) }).then(
      () => null,
      (e: { code: number; stderr: string; stdout: string }) => e,
    );
    expect(error?.code).toBe(1);
    expect(error?.stderr).toContain("a deploy publishes the release's own THIRD-PARTY-NOTICES.txt, so name it: SMURG_SITE_THIRD_PARTY_NOTICES=<file>");
    expect(error?.stdout).not.toContain('files in apps/site/dist');
  });

  it('refuses to build for a wrangler started outside this checkout', async () => {
    const elsewhere = tempDir('site-cwd-');
    const error = await run(process.execPath, [BUILD], { cwd: elsewhere, env: env({}) }).then(
      () => null,
      (e: { code: number; stderr: string }) => e,
    );
    expect(error?.code).toBe(1);
    expect(error?.stderr).toMatch(/run from inside .* this build writes .*dist/);
  });
});
