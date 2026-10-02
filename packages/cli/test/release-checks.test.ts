// scripts/release-assets.sh --publish-checks: what must hold in the repository before a version's tag is built.
// Nothing here reaches the network: the script runs against a stand-in repository in a temporary directory.
import { spawn } from 'node:child_process';
import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { makeDirs, type Dirs } from './helpers.ts';

const RELEASE_ASSETS = fileURLToPath(new URL('../../../scripts/release-assets.sh', import.meta.url));
const SYSTEM_PATH = '/usr/bin:/bin:/usr/sbin:/sbin';
const INSTALL_LINE = 'curl -fsSL https://smurg.ai/install.sh | sh';

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  while (cleanups.length > 0) await Promise.resolve((cleanups.pop() as () => Promise<void> | void)()).catch(() => {});
});

interface Run {
  readonly code: number;
  readonly out: string;
}

/** Runs `shell <args>` with exactly this environment. */
function runShell(shell: string, args: readonly string[], env: Record<string, string>): Promise<Run> {
  return new Promise((resolve, reject) => {
    const child = spawn(shell, args, { env, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (chunk: Buffer) => (out += chunk.toString('utf8')));
    child.stderr.on('data', (chunk: Buffer) => (out += chunk.toString('utf8')));
    const timer = setTimeout(() => child.kill('SIGKILL'), 60_000);
    child.once('error', reject);
    child.once('close', (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? 1, out });
    });
    child.stdin.end('');
  });
}

async function setup(): Promise<Dirs> {
  const dirs = await makeDirs();
  cleanups.push(() => dirs.cleanup());
  return dirs;
}

async function writeExecutable(path: string, text: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, text);
  await chmod(path, 0o755);
}

const USER_DOCS = ['README.md', 'README.zh-TW.md', 'docs/HOSTING.md', 'docs/JOINING.md', 'docs/zh-TW/HOSTING.md', 'docs/zh-TW/JOINING.md'] as const;
const MIT_LICENSE = 'MIT License\n\nCopyright (c) 2026 Guan-Chen, Lin\n\nPermission is hereby granted, free of charge, to any person obtaining a copy\n';

describe('scripts/release-assets.sh --publish-checks', () => {
  it('--publish-checks (before a tag is built): a dated section in both changelogs, no placeholders, the built-in relay and the install line in all six user docs, the MIT license, one version everywhere', async () => {
    const dirs = await setup();
    // The script works from the repository it lives in: a copy of it in a stand-in repository.
    const repo = join(dirs.home, 'repo');
    const script = join(repo, 'scripts', 'release-assets.sh');
    await writeExecutable(script, await readFile(RELEASE_ASSETS, 'utf8'));
    const put = async (path: string, text: string): Promise<void> => {
      await mkdir(dirname(join(repo, path)), { recursive: true });
      await writeFile(join(repo, path), text);
    };
    const pkg = (version: string, license = 'MIT', isPrivate = true): string =>
      `{\n  "name": "x",\n  "version": "${version}",\n${isPrivate ? '  "private": true,\n' : ''}  "license": "${license}"\n}\n`;
    const relay = (value: string): string => `// the built-in relay\nexport const DEFAULT_RELAY_URL: string | null = ${value};\n`;
    const changelogs = async (heading: string, body: string, zhHeading = heading): Promise<void> => {
      await put('CHANGELOG.md', `# Changelog\n\n${heading}\n\n${body}\n`);
      await put('docs/zh-TW/CHANGELOG.md', `# Changelog (zh-TW)\n\n${zhHeading}\n\n${body}\n`);
    };
    const check = (version: string, extra: readonly string[] = []): Promise<Run> =>
      runShell('/bin/bash', [script, '--version', version, '--publish-checks', ...extra], { PATH: SYSTEM_PATH, HOME: '/nonexistent' });
    const problems = (run: Run): string[] => run.out.split('\n').filter((line) => line.startsWith('  - ')).map((line) => line.slice(4));

    // Everything still to fill in, and the repository as the proprietary releases (0.1.0 to 0.3.0) left it.
    await changelogs('## [9.8.7] - Unreleased', '- The shared relay: <RELAY_URL>', '## [9.8.7] - 2026-10-02');
    await put('README.md', 'The shared relay <RELAY_URL>\n');
    await put('docs/HOSTING.md', 'https://smurg-relay.<account-subdomain>.workers.dev\n');
    await put('docs/JOINING.md', `nothing to fill in\n${INSTALL_LINE}\n`);
    await put('docs/zh-TW/HOSTING.md', `${INSTALL_LINE}\n`);
    await put('packages/cli/src/relay/default-relay.ts', relay('null'));
    for (const path of ['package.json', 'packages/cli/package.json']) await put(path, pkg('9.8.7'));
    await put('packages/daemon/package.json', pkg('0.0.0'));
    await put('apps/relay/package.json', pkg('9.8.7', 'UNLICENSED'));
    await put('tests/e2e/package.json', pkg('9.8.7', 'MIT', false));
    await put('LICENSE', 'smurg\n\nCopyright (c) 2026 Guan-Chen, Lin. All rights reserved.\n\nsmurg is proprietary software.\n');
    await put('NOTICE', 'smurg\nCopyright (c) 2026 Guan-Chen, Lin. All rights reserved. The terms are in LICENSE.\n');
    const before = await check('9.8.7');
    expect(before.code).toBe(1);
    expect(before.out).toContain("CHANGELOG.md: the heading '## [9.8.7] - Unreleased' has no release date");
    expect(before.out).toContain('CHANGELOG.md: the 9.8.7 section still has a placeholder');
    expect(before.out).toContain('README.md still has a placeholder');
    expect(before.out).toContain('docs/HOSTING.md still has a placeholder');
    expect(before.out).toContain('README.zh-TW.md is missing (a user doc)');
    expect(before.out).toContain('docs/zh-TW/JOINING.md is missing (a user doc)');
    expect(problems(before).filter((line) => line.startsWith('docs/JOINING.md'))).toEqual([]);
    expect(problems(before).filter((line) => line.startsWith('docs/zh-TW/HOSTING.md'))).toEqual([]);
    expect(before.out).toContain('DEFAULT_RELAY_URL is not the deployed relay');
    expect(before.out).toContain("packages/daemon/package.json: version '0.0.0', not 9.8.7");
    expect(before.out).not.toContain('packages/cli/package.json');
    expect(before.out).toContain(`README.md does not show the install line  ${INSTALL_LINE}`);
    expect(before.out).toContain(`docs/HOSTING.md does not show the install line  ${INSTALL_LINE}`);
    expect(before.out).toContain("LICENSE: line 1 is 'smurg', not 'MIT License'");
    expect(before.out).toContain("LICENSE does not name the copyright holder (a line 'Copyright (c) YYYY Guan-Chen, Lin')");
    expect(before.out).toContain('LICENSE still has wording of the proprietary releases (line 3 5)');
    expect(before.out).toContain('NOTICE still has wording of the proprietary releases (line 2)');
    expect(before.out).toContain('apps/relay/package.json: "license" is not "MIT"');
    expect(before.out).toContain('tests/e2e/package.json: not "private": true');
    // The same, whatever --base-url is given (it only concerns the assembly).
    expect((await check('9.8.7', ['--base-url', 'https://example.test/x'])).out).toBe(before.out);

    // Filled in, but README.md still names another relay than the binary's built-in one and has no install line, and
    // the zh-TW changelog's section is not the one of CHANGELOG.md.
    await changelogs('## [9.8.7] - 2026-10-02', '- The shared relay: https://app.example.org', '## [9.8.7] - 2026-10-01');
    const doc = `${INSTALL_LINE}\nThe shared relay https://app.example.org\n`;
    for (const path of USER_DOCS) await put(path, doc);
    await put('README.md', 'The shared relay https://smurg-relay.example.workers.dev\n');
    await put('packages/cli/src/relay/default-relay.ts', relay("'https://app.example.org'"));
    await put('packages/daemon/package.json', pkg('9.8.7'));
    await put('apps/relay/package.json', pkg('9.8.7'));
    await put('tests/e2e/package.json', pkg('9.8.7'));
    await put('LICENSE', MIT_LICENSE);
    await put('NOTICE', 'smurg\nCopyright (c) 2026 Guan-Chen, Lin\n\nsmurg is MIT-licensed (see LICENSE).\n');
    const stale = await check('9.8.7');
    expect(stale.code).toBe(1);
    expect(problems(stale)).toEqual([
      "docs/zh-TW/CHANGELOG.md: the heading '## [9.8.7] - 2026-10-01' is not '## [9.8.7] - 2026-10-02' (CHANGELOG.md)",
      'README.md does not name the built-in relay https://app.example.org (DEFAULT_RELAY_URL): the docs must say what the binary uses',
      `README.md does not show the install line  ${INSTALL_LINE}`,
      // The workers.dev address README.md still gives is not the built-in relay's: a stale address of the shared relay.
      'README.md names a workers.dev address that is not the built-in relay: https://smurg-relay.example.workers.dev (docs/RELEASING.md §3)',
    ]);

    // Filled in: ready (and a pre-release tag of the same X.Y.Z passes too, below).
    await changelogs('## [9.8.7] - 2026-10-02', '- The shared relay: https://app.example.org');
    await put('README.md', doc);
    const ready = await check('9.8.7');
    expect(ready.out).toContain('9.8.7 is ready to publish');
    expect(ready.code).toBe(0);

    // The zh-TW changelog without this version's section, or missing.
    await put('docs/zh-TW/CHANGELOG.md', '# Changelog (zh-TW)\n\n## [9.8.6] - 2026-10-01\n\n- older\n');
    expect(problems(await check('9.8.7'))).toEqual(["docs/zh-TW/CHANGELOG.md has no section for 9.8.7 (a heading like '## [9.8.7] - YYYY-MM-DD')"]);
    await rm(join(repo, 'docs/zh-TW/CHANGELOG.md'));
    expect(problems(await check('9.8.7'))).toEqual(['docs/zh-TW/CHANGELOG.md is missing']);
    await changelogs('## [9.8.7] - 2026-10-02', '- The shared relay: https://app.example.org');

    // smurg is open source: links to the GitHub repository are fine wherever users read them (the section, the user
    // docs, the product page, the web app), and so are "open source" and "self-host" in the installer.
    await changelogs('## [9.8.7] - 2026-10-02', '- The shared relay: https://app.example.org ([source](https://github.com/gclinian/smurg)). 0.1.0 to 0.3.0 were proprietary builds.');
    await put('README.md', `${doc}Source: https://github.com/gclinian/smurg (MIT)\n`);
    await put('apps/site/public/index.html', '<a href="https://github.com/gclinian/smurg">Open source (MIT)</a>\n');
    await put('apps/web/src/about.ts', "export const SOURCE = 'https://github.com/gclinian/smurg';\n");
    await put('scripts/install.sh', "#!/bin/sh\n# smurg is open source (MIT): https://smurg.ai/github\nsay '  smurg login   # a self-hosted relay: add --relay <url>'\n");
    const open = await check('9.8.7');
    expect(open.out).toContain('9.8.7 is ready to publish');
    expect(open.code).toBe(0);

    // What the proprietary releases said about themselves must be gone from the user docs and the installer (the
    // changelog may say it about the old versions, above).
    await put('docs/zh-TW/JOINING.md', `${doc}The source is in a private repository.\n`);
    await put('scripts/install.sh', "#!/bin/sh\n# smurg is Proprietary software\n");
    expect(problems(await check('9.8.7'))).toEqual([
      'docs/zh-TW/JOINING.md still has wording of the proprietary releases (line 3): smurg is MIT-licensed open source',
      'scripts/install.sh still has wording of the proprietary releases (line 2): smurg is MIT-licensed open source',
    ]);
    await put('docs/zh-TW/JOINING.md', doc);
    await rm(join(repo, 'scripts/install.sh'));
    expect((await check('9.8.7')).code).toBe(0);

    // LICENSE: missing, another license, or the MIT text of another holder.
    await put('LICENSE', '\n                                 Apache License\n                           Version 2.0, January 2004\n');
    expect(problems(await check('9.8.7'))).toEqual(["LICENSE: line 1 is '', not 'MIT License'", "LICENSE does not name the copyright holder (a line 'Copyright (c) YYYY Guan-Chen, Lin')"]);
    await put('LICENSE', 'MIT License\n\nCopyright (c) 2026 <COPYRIGHT HOLDER>\n');
    expect(problems(await check('9.8.7'))).toEqual(["LICENSE does not name the copyright holder (a line 'Copyright (c) YYYY Guan-Chen, Lin')"]);
    await rm(join(repo, 'LICENSE'));
    expect(problems(await check('9.8.7'))).toEqual(['LICENSE is missing']);
    await put('LICENSE', MIT_LICENSE.replace('2026', '2026-2027'));
    expect((await check('9.8.7')).code).toBe(0);
    await put('LICENSE', MIT_LICENSE);

    // A self-hosted relay's workers.dev address written with a placeholder is fine; a concrete one other than the
    // built-in relay is not, in the version's section either.
    await put('docs/HOSTING.md', `${doc}Your own relay: https://smurg-relay.<your-subdomain>.workers.dev\n`);
    await put('docs/zh-TW/HOSTING.md', `${doc}https://smurg-relay.<你的子網域>.workers.dev\n`);
    expect((await check('9.8.7')).code).toBe(0);
    await changelogs('## [9.8.7] - 2026-10-02', '- The shared relay: https://app.example.org (it was https://smurg-relay.old-sub.workers.dev)');
    await put('docs/zh-TW/JOINING.md', 'https://app.example.org/join/<id>#…\n');
    expect(problems(await check('9.8.7'))).toEqual([
      `docs/zh-TW/JOINING.md does not show the install line  ${INSTALL_LINE}`,
      'CHANGELOG.md: the 9.8.7 section names a workers.dev address that is not the built-in relay: https://smurg-relay.old-sub.workers.dev',
    ]);
    // The built-in relay itself on workers.dev (a self-hoster's fork): naming it is not stale.
    await put('packages/cli/src/relay/default-relay.ts', relay("'https://smurg-relay.mine.workers.dev'"));
    for (const path of USER_DOCS) await put(path, `${INSTALL_LINE}\nThe shared relay https://smurg-relay.mine.workers.dev\n`);
    await changelogs('## [9.8.7] - 2026-10-02', '- The shared relay: https://smurg-relay.mine.workers.dev');
    expect((await check('9.8.7')).code).toBe(0);

    await changelogs('## [9.8.7-rc.1] - 2026-10-02', '- A release candidate');
    expect((await check('9.8.7-rc.1')).code).toBe(0);
  });

  it('this repository: LICENSE is MIT with its holder, and every package.json says MIT and private', async () => {
    const root = fileURLToPath(new URL('../../../', import.meta.url));
    const license = await readFile(join(root, 'LICENSE'), 'utf8');
    expect(license.startsWith('MIT License\n\nCopyright (c) 2026 Guan-Chen, Lin\n')).toBe(true);
    const manifests = ['package.json', 'packages/cli/package.json', 'packages/daemon/package.json', 'packages/protocol/package.json', 'apps/relay/package.json', 'apps/site/package.json', 'apps/web/package.json', 'tests/e2e/package.json'];
    const versions = new Set<string>();
    for (const path of manifests) {
      const text = await readFile(join(root, path), 'utf8');
      const manifest = JSON.parse(text) as { version?: string; license?: string; private?: boolean };
      // The exact lines scripts/release-assets.sh --publish-checks looks for.
      expect(text, path).toMatch(/^ {2}"license": "MIT",?$/m);
      expect(text, path).toMatch(/^ {2}"private": true,?$/m);
      expect(manifest.license, path).toBe('MIT');
      expect(manifest.private, path).toBe(true);
      versions.add(String(manifest.version));
    }
    expect([...versions]).toHaveLength(1);
    const rootManifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')) as Record<string, unknown>;
    expect(rootManifest['repository']).toBe('github:gclinian/smurg');
    expect(rootManifest['homepage']).toBe('https://smurg.ai');
    expect(rootManifest['bugs']).toBe('https://github.com/gclinian/smurg/issues');
  });
});
