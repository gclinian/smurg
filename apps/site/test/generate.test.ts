// The site build (scripts/site.ts, scripts/build.ts) on small fixture repositories: what it generates, what it refuses,
// and how it writes dist/.
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, describe, expect, it } from 'vitest';
import { NOTICES_PLACEHOLDER, SiteError, generateSite, writeSite, type SiteOptions } from '../scripts/site.ts';
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
  'docs/QUICKSTART.md': '# Quick start\n\nThen read how to [share](HOSTING.md#2-share) and the [roles](JOINING.md#2-roles).\n\n## Share\n\nText.\n',
  'docs/zh-TW/QUICKSTART.md': '# 快速上手\n\n接著讀怎麼[分享](HOSTING.md#2-分享)和[角色](JOINING.md#2-角色)。\n\n## 分享\n\n文字。\n',
  'docs/HOSTING.md': '# Host guide\n\nTeammates read [`JOINING.md`](JOINING.md#2-roles); the license is [LICENSE](../LICENSE); in [Chinese](zh-TW/HOSTING.md).\n\n## 1. Install\n\nFor developers: [ARCHITECTURE](ARCHITECTURE.md#rules) and the [relay](../apps/relay).\n\n## 2. Share\n\nBack to [install](#1-install).\n',
  'docs/JOINING.md': '# Guide for teammates\n\nHosts read [HOSTING.md](./HOSTING.md).\n\n## 1. Join\n\nText.\n\n## 2. Roles\n\nText.\n',
  'CHANGELOG.md': '# Changelog\n\nThe format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).\n\n## [0.1.0] - 2026-10-01\n\nSee [`docs/HOSTING.md`](docs/HOSTING.md#2-share) and the [spec](SPEC.md).\n',
  'docs/zh-TW/HOSTING.md': '# 主人指南\n\n組員請看 [`JOINING.md`](JOINING.md#2-角色)，授權見 [LICENSE](../../LICENSE)。\n\n## 1. 安裝\n\n開發者：[ARCHITECTURE](../ARCHITECTURE.md)。\n\n## 2. 分享\n\n回到 [安裝](#1-安裝)。\n',
  'docs/zh-TW/JOINING.md': '# 組員指南\n\n主人請看 [HOSTING.md](./HOSTING.md)。\n\n## 1. 加入\n\n文字。\n\n## 2. 角色\n\n文字。\n',
  'docs/zh-TW/CHANGELOG.md': '# 變更紀錄\n\n格式參考 [Keep a Changelog](https://keepachangelog.com/zh-TW/1.1.0/)。\n\n## [0.1.0] - 2026-10-01\n\n見 [`HOSTING.md`](HOSTING.md#2-分享) 與 [English](../../CHANGELOG.md)。\n',
  LICENSE: 'MIT License\n\nCopyright (c) 2026 Example Holder\n',
  // Files of the repository that are not pages of the site: a link to one goes to GitHub.
  'docs/ARCHITECTURE.md': '# Architecture\n',
  'SPEC.md': '# SPEC\n',
  'apps/relay/README.md': '# relay\n',
} as const;

/** A repository with the docs of both languages and LICENSE, some of them replaced. */
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
  it('renders the docs of both languages at their URLs, keeps links between them inside the language, and sends other repository files to GitHub', () => {
    const site = generateSite({ repoRoot: fixtureRepo(), notices: FIXTURE_NOTICES });
    const text = (path: string): string => site.files.get(path)?.toString('utf8') ?? '';
    const hosting = text('docs/hosting/index.html');
    expect(hosting).toContain('<html lang="en">');
    expect(hosting).toContain('<a href="/docs/joining/#2-roles"><code>JOINING.md</code></a>');
    expect(hosting).toContain('<a href="/license/">LICENSE</a>');
    expect(hosting).toContain('<a href="/zh-TW/docs/hosting/">Chinese</a>');
    expect(hosting).toContain('<a href="https://github.com/gclinian/smurg/blob/main/docs/ARCHITECTURE.md#rules">ARCHITECTURE</a>');
    expect(hosting).toContain('<a href="https://github.com/gclinian/smurg/tree/main/apps/relay">relay</a>');
    expect(hosting).toContain('<a href="#1-install">install</a>');
    const changelog = text('docs/changelog/index.html');
    expect(changelog).toContain('<a href="https://keepachangelog.com/en/1.1.0/">Keep a Changelog</a>');
    expect(changelog).toContain('<a href="/docs/hosting/#2-share"><code>docs/HOSTING.md</code></a>');
    const zhHosting = text('zh-TW/docs/hosting/index.html');
    expect(zhHosting).toContain('<html lang="zh-Hant-TW">');
    expect(zhHosting).toContain('<a href="/zh-TW/docs/joining/#2-角色"><code>JOINING.md</code></a>');
    expect(zhHosting).toContain('<a href="/zh-TW/license/">LICENSE</a>');
    expect(zhHosting).toContain('<a href="#1-安裝">安裝</a>');
    expect(text('zh-TW/docs/changelog/index.html')).toContain('<a href="/docs/changelog/">English</a>');
    // The quick start is a page of the docs like the guides: its links to them stay in its language.
    const quick = text('docs/quick-start/index.html');
    expect(quick).toContain('<html lang="en">');
    expect(quick).toContain('<a href="/docs/hosting/#2-share">share</a>');
    expect(text('zh-TW/docs/quick-start/index.html')).toContain('<a href="/zh-TW/docs/joining/#2-角色">角色</a>');
    expect(site.rewritten).toEqual([
      'docs/QUICKSTART.md:3 [share](HOSTING.md#2-share) -> /docs/hosting/#2-share',
      'docs/QUICKSTART.md:3 [roles](JOINING.md#2-roles) -> /docs/joining/#2-roles',
      'docs/HOSTING.md:3 [JOINING.md](JOINING.md#2-roles) -> /docs/joining/#2-roles',
      'docs/HOSTING.md:3 [LICENSE](../LICENSE) -> /license/',
      'docs/HOSTING.md:3 [Chinese](zh-TW/HOSTING.md) -> /zh-TW/docs/hosting/',
      'docs/HOSTING.md:7 [ARCHITECTURE](ARCHITECTURE.md#rules) -> https://github.com/gclinian/smurg/blob/main/docs/ARCHITECTURE.md#rules',
      'docs/HOSTING.md:7 [relay](../apps/relay) -> https://github.com/gclinian/smurg/tree/main/apps/relay',
      'docs/JOINING.md:3 [HOSTING.md](./HOSTING.md) -> /docs/hosting/',
      'CHANGELOG.md:7 [docs/HOSTING.md](docs/HOSTING.md#2-share) -> /docs/hosting/#2-share',
      'CHANGELOG.md:7 [spec](SPEC.md) -> https://github.com/gclinian/smurg/blob/main/SPEC.md',
      'docs/zh-TW/QUICKSTART.md:3 [分享](HOSTING.md#2-分享) -> /zh-TW/docs/hosting/#2-分享',
      'docs/zh-TW/QUICKSTART.md:3 [角色](JOINING.md#2-角色) -> /zh-TW/docs/joining/#2-角色',
      'docs/zh-TW/HOSTING.md:3 [JOINING.md](JOINING.md#2-角色) -> /zh-TW/docs/joining/#2-角色',
      'docs/zh-TW/HOSTING.md:3 [LICENSE](../../LICENSE) -> /zh-TW/license/',
      'docs/zh-TW/HOSTING.md:7 [ARCHITECTURE](../ARCHITECTURE.md) -> https://github.com/gclinian/smurg/blob/main/docs/ARCHITECTURE.md',
      'docs/zh-TW/JOINING.md:3 [HOSTING.md](./HOSTING.md) -> /zh-TW/docs/hosting/',
      'docs/zh-TW/CHANGELOG.md:7 [HOSTING.md](HOSTING.md#2-分享) -> /zh-TW/docs/hosting/#2-分享',
      'docs/zh-TW/CHANGELOG.md:7 [English](../../CHANGELOG.md) -> /docs/changelog/',
    ]);
    expect(site.plain).toEqual([]);
    const pages = ['docs/index.html', 'docs/quick-start/index.html', 'docs/hosting/index.html', 'docs/joining/index.html', 'docs/changelog/index.html', 'license/index.html'];
    for (const path of [...pages, ...pages.map((page) => `zh-TW/${page}`)]) {
      expect(parsePage(text(path)).errors, path).toEqual([]);
      // Each page names its counterpart: the alternates and the language link.
      const en = `/${path.replace(/^zh-TW\//, '').replace(/index\.html$/, '')}`;
      expect(text(path), path).toContain(`<link rel="alternate" hreflang="en" href="https://smurg.ai${en}">\n<link rel="alternate" hreflang="zh-Hant-TW" href="https://smurg.ai/zh-TW${en}">\n<link rel="alternate" hreflang="x-default" href="https://smurg.ai${en}">`);
      expect(text(path), path).toContain(path.startsWith('zh-TW/') ? `<li class="lang"><a href="${en}" hreflang="en" lang="en">English</a></li>` : `<li class="lang"><a href="/zh-TW${en}" hreflang="zh-Hant-TW" lang="zh-Hant-TW">繁體中文</a></li>`);
    }
    for (const path of ['license/index.html', 'zh-TW/license/index.html']) expect(text(path)).toContain('Copyright (c) 2026 Example Holder');
    // No 404 page is generated under /docs/ any more.
    expect(site.files.has('docs/404.html')).toBe(false);
    expect(text('sitemap.xml')).toContain('<loc>https://smurg.ai/zh-TW/docs/joining/</loc>');
    // The sitemap lists the docs in the order of the docs index: the quick start before the guides.
    expect(text('sitemap.xml').indexOf('<loc>https://smurg.ai/docs/quick-start/</loc>')).toBeGreaterThan(text('sitemap.xml').indexOf('<loc>https://smurg.ai/zh-TW/docs/</loc>'));
    expect(text('sitemap.xml').indexOf('<loc>https://smurg.ai/zh-TW/docs/quick-start/</loc>')).toBeLessThan(text('sitemap.xml').indexOf('<loc>https://smurg.ai/docs/hosting/</loc>'));
  });

  it('turns every link that is not https into text, and keeps https links to any host, GitHub included', () => {
    const repo = fixtureRepo({
      'docs/JOINING.md': '# Guide for teammates\n\n[a](http://example.com/) [b](//example.com/x) [c](mailto:a@example.com) [d](javascript:alert(1)) [e](https://example.com/ok) [f](https://github.com/x/y)\n\n## 2. Roles\n',
    });
    const site = generateSite({ repoRoot: repo, notices: FIXTURE_NOTICES });
    const joining = site.files.get('docs/joining/index.html')?.toString('utf8') ?? '';
    expect(joining).toContain('<p>a b c d <a href="https://example.com/ok">e</a> <a href="https://github.com/x/y">f</a></p>');
    expect(site.plain.filter((line) => line.startsWith('docs/JOINING.md'))).toEqual([
      'docs/JOINING.md:3 [a](http://example.com/) -> plain text (a http: link (only https links are kept))',
      'docs/JOINING.md:3 [b](//example.com/x) -> plain text (a protocol-relative link)',
      'docs/JOINING.md:3 [c](mailto:a@example.com) -> plain text (a mailto: link (only https links are kept))',
      'docs/JOINING.md:3 [d](javascript:alert(1)) -> plain text (a javascript: link (only https links are kept))',
    ]);
  });

  it('refuses a link to a repository file that does not exist, or to a path outside the repository', () => {
    const repo = fixtureRepo({ 'docs/JOINING.md': '# Guide for teammates\n\n[a](NOPE.md) [b](../apps/nope/README.md#x) [c](../../outside.md)\n\n## 2. Roles\n' });
    expect(problemsOf({ repoRoot: repo, notices: FIXTURE_NOTICES })).toEqual([
      'docs/JOINING.md: the link (NOPE.md) points at docs/NOPE.md, which does not exist in the repository',
      'docs/JOINING.md: the link (../apps/nope/README.md#x) points at apps/nope/README.md, which does not exist in the repository',
    ]);
    // (A path outside the repository is not a link the site can make: it becomes its text, and the build says so.)
    const outside = fixtureRepo({ 'docs/JOINING.md': '# Guide for teammates\n\n[c](../../outside.md)\n\n## 2. Roles\n' });
    expect(generateSite({ repoRoot: outside, notices: FIXTURE_NOTICES }).plain).toEqual(['docs/JOINING.md:3 [c](../../outside.md) -> plain text (a path outside the repository)']);
  });

  it('refuses a #link to a heading that does not exist, in the page or in another doc', () => {
    const repo = fixtureRepo({ 'docs/JOINING.md': '# Guide for teammates\n\n[a](#nope) [b](HOSTING.md#nope) [c](HOSTING.md#2-share) [d](zh-TW/HOSTING.md#2-share)\n\n## 2. Roles\n' });
    expect(problemsOf({ repoRoot: repo, notices: FIXTURE_NOTICES })).toEqual([
      'docs/joining/index.html: <a href="#nope">: no element has this id',
      'docs/joining/index.html: <a href="/docs/hosting/#nope">: docs/hosting/index.html has no element with this id',
      // The other language's page has its own headings.
      'docs/joining/index.html: <a href="/zh-TW/docs/hosting/#2-share">: zh-TW/docs/hosting/index.html has no element with this id',
    ]);
  });

  it('refuses a doc without exactly one h1 first, or with a skipped heading level, or with an image', () => {
    const repo = fixtureRepo({ 'docs/zh-TW/JOINING.md': '## 先\n\n# 一\n\n# 二\n\n#### 跳\n\n![x](x.png)\n\n## 2. 角色\n' });
    expect(problemsOf({ repoRoot: repo, notices: FIXTURE_NOTICES })).toEqual([
      'docs/zh-TW/JOINING.md: line 9: an image (x.png); the site has no images from the docs',
      'docs/zh-TW/JOINING.md: needs exactly one level-1 heading (#), before any other heading',
      'docs/zh-TW/JOINING.md: "跳" skips a heading level',
    ]);
  });

  it('refuses unfilled notices unless told to build anyway (previews and tests)', () => {
    const repo = fixtureRepo();
    const notices = join(tempDir('site-notices-'), 'notices.txt');
    writeFileSync(notices, `x@1.0.0\n\nNode.js runtime\n\n${NOTICES_PLACEHOLDER} into the executable …\n`);
    const problems = problemsOf({ repoRoot: repo, notices });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/the Node\.js section is still the committed placeholder/);
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
    rmSync(join(repo, 'docs', 'zh-TW', 'CHANGELOG.md'));
    const problems = problemsOf({ repoRoot: repo, publicDir, notices: FIXTURE_NOTICES });
    expect(problems.filter((p) => !p.includes('/docs/changelog/'))).toEqual([
      `docs/zh-TW/CHANGELOG.md: ${join(repo, 'docs', 'zh-TW', 'CHANGELOG.md')} does not exist`,
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
    const repo = fixtureRepo({ 'docs/JOINING.md': '# Guide\n\n[x](#nope) [y](NOPE.md)\n\n## 2. Roles\n' });
    const error = await run(process.execPath, [BUILD], {
      cwd: SITE_ROOT,
      env: env({ SMURG_SITE_SOURCE_ROOT: repo, SMURG_SITE_THIRD_PARTY_NOTICES: FIXTURE_NOTICES }),
    }).then(
      () => null,
      (e: { code: number; stderr: string }) => e,
    );
    expect(error?.code).toBe(1);
    expect(error?.stderr).toContain('the smurg.ai build failed:');
    expect(error?.stderr).toContain('docs/JOINING.md: the link (NOPE.md) points at docs/NOPE.md, which does not exist in the repository');
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
