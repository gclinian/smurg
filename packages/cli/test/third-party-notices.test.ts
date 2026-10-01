// Third-party notices (scripts/third-party-notices.ts; LICENSE: smurg is proprietary, the packages it bundles keep their
// own licenses). The committed files must be exactly what pnpm-lock.yaml and node_modules give now; generation is
// deterministic and does not depend on which platform's native packages are installed; a bundled package without a
// license file fails loudly; every license and NOTICE file of every bundled package is reproduced (srt's Apache-2.0
// text included); every package esbuild puts into the executable is listed; the Node.js section is filled in from the
// Node distribution's LICENSE. Fixtures are fake pnpm installs in a temp dir (no network).
import { mkdirSync, readFileSync, readdirSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, relative } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createTempDir, removeTempDir } from '@smurg/daemon/testing';
import { composeExecutableNotices, NODE_PENDING_SECTION, nodeDistributionLicense, normaliseText } from '../src/licenses/notices.ts';
import {
  bundledPackageOf,
  dependencyClosure,
  executableNotices,
  listedPackages,
  NOTICES_FILES,
  parseLockfile,
  RELEASE_TARGETS,
  renderNotices,
  ROOT,
  staleNotices,
  uncoveredPackages,
  type NoticesSpec,
} from '../../../scripts/third-party-notices.ts';

const temps: string[] = [];
afterEach(async () => {
  while (temps.length > 0) await removeTempDir(temps.pop() as string);
});

async function tempRoot(): Promise<string> {
  const dir = await createTempDir('notices');
  temps.push(dir);
  return dir;
}

// ---------------------------------------------------------------------------------------------------------------------
// A fake pnpm install: pnpm-lock.yaml (v9) and node_modules/.pnpm/<id>/node_modules/<name> with sibling links.

interface FakePackage {
  readonly name: string;
  readonly version: string;
  /** Root files of the package (LICENSE, NOTICE, …). */
  readonly files?: Readonly<Record<string, string>>;
  readonly license?: string;
  readonly deps?: Readonly<Record<string, string>>;
  readonly optional?: Readonly<Record<string, string>>;
  readonly platform?: { readonly os?: readonly string[]; readonly cpu?: readonly string[]; readonly libc?: readonly string[] };
  /** false: listed in the lockfile, not installed (another platform's package). */
  readonly installed?: boolean;
  /** The version its package.json says (default: `version`). */
  readonly installedVersion?: string;
}

const MIT = (who: string): string => `MIT License\n\nCopyright (c) 2026 ${who}\n\nPermission is hereby granted, free of charge…\n`;
const quote = (key: string): string => (key.startsWith('@') ? `'${key}'` : key);
const storeDir = (root: string, p: FakePackage): string => join(root, 'node_modules', '.pnpm', `${p.name.replace('/', '+')}@${p.version}`, 'node_modules', ...p.name.split('/'));

function fakeInstall(root: string, importers: Readonly<Record<string, Readonly<Record<string, string>>>>, packages: readonly FakePackage[]): void {
  const lines = ["lockfileVersion: '9.0'", '', 'settings:', '  autoInstallPeers: true', '', 'importers:', ''];
  for (const [path, deps] of Object.entries(importers)) {
    lines.push(`  ${path}:`, '    dependencies:');
    for (const [name, version] of Object.entries(deps)) lines.push(`      ${quote(name)}:`, `        specifier: ${version.startsWith('link:') ? 'workspace:*' : version}`, `        version: ${version}`);
    lines.push('');
  }
  lines.push('packages:', '');
  for (const p of packages) {
    lines.push(`  ${quote(`${p.name}@${p.version}`)}:`, '    resolution: {integrity: sha512-AAAA}');
    for (const key of ['cpu', 'os', 'libc'] as const) if (p.platform?.[key]) lines.push(`    ${key}: [${(p.platform[key] as readonly string[]).join(', ')}]`);
    lines.push('');
  }
  lines.push('snapshots:', '');
  for (const p of packages) {
    if (!p.deps && !p.optional) {
      lines.push(`  ${quote(`${p.name}@${p.version}`)}:${p.platform ? '\n    optional: true' : ' {}'}`, '');
      continue;
    }
    lines.push(`  ${quote(`${p.name}@${p.version}`)}:`);
    for (const [kind, deps] of [['dependencies', p.deps], ['optionalDependencies', p.optional]] as const) {
      if (!deps) continue;
      lines.push(`    ${kind}:`);
      for (const [name, version] of Object.entries(deps)) lines.push(`      ${quote(name)}: ${version}`);
    }
    lines.push('    transitivePeerDependencies:', "      - '@noble/hashes'", '');
  }
  writeFileSync(join(root, 'pnpm-lock.yaml'), `${lines.join('\n')}\n`);
  const byKey = new Map(packages.map((p) => [`${p.name}@${p.version}`, p]));
  const link = (from: string, to: string): void => {
    mkdirSync(dirname(from), { recursive: true });
    symlinkSync(to, from);
  };
  for (const p of packages) {
    if (p.installed === false) continue;
    const dir = storeDir(root, p);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: p.name, version: p.installedVersion ?? p.version, license: p.license ?? 'MIT', repository: `https://github.com/example/${p.name.replace(/^@/, '').replace('/', '-')}` }));
    for (const [file, text] of Object.entries(p.files ?? {})) writeFileSync(join(dir, file), text);
    const depsRoot = p.name.startsWith('@') ? dirname(dirname(dir)) : dirname(dir);
    for (const [name, version] of Object.entries({ ...p.deps, ...p.optional })) {
      const dep = byKey.get(`${name}@${version}`);
      if (dep && dep.installed !== false) link(join(depsRoot, ...name.split('/')), storeDir(root, dep));
    }
  }
  for (const [path, deps] of Object.entries(importers)) {
    for (const [name, version] of Object.entries(deps)) {
      const dep = byKey.get(`${name}@${version}`);
      if (dep && dep.installed !== false) link(join(root, path, 'node_modules', ...name.split('/')), storeDir(root, dep));
    }
  }
}

const SPEC: NoticesSpec = { title: 'Fixture notices', intro: 'For tests.', importer: 'app', targets: RELEASE_TARGETS, buildTools: [] };

/** A package with native parts for many platforms, of which `installed` is the one this "machine" has. */
function watcherFamily(installed: string, parentLicense = MIT('Watcher authors'), variantLicense = parentLicense): FakePackage[] {
  const variants: [string, FakePackage['platform']][] = [
    ['darwin-arm64', { os: ['darwin'], cpu: ['arm64'] }],
    ['darwin-x64', { os: ['darwin'], cpu: ['x64'] }],
    ['linux-x64-glibc', { os: ['linux'], cpu: ['x64'], libc: ['glibc'] }],
    ['linux-arm64-glibc', { os: ['linux'], cpu: ['arm64'], libc: ['glibc'] }],
    ['linux-x64-musl', { os: ['linux'], cpu: ['x64'], libc: ['musl'] }],
    ['win32-x64', { os: ['win32'], cpu: ['x64'] }],
    ['android-arm64', { os: ['android'], cpu: ['arm64'] }],
  ];
  return [
    { name: '@fake/watcher', version: '2.0.0', files: { LICENSE: parentLicense }, deps: { 'is-glob': '4.0.3' }, optional: Object.fromEntries(variants.map(([v]) => [`@fake/watcher-${v}`, '2.0.0'])) },
    { name: 'is-glob', version: '4.0.3', files: { 'LICENSE.md': MIT('Jon Schlinkert') } },
    ...variants.map(([v, platform]): FakePackage => ({ name: `@fake/watcher-${v}`, version: '2.0.0', platform, files: { LICENSE: variantLicense }, installed: v === installed })),
  ];
}

describe('scripts/third-party-notices.ts with a fake install', () => {
  it('is deterministic and the same whichever platform package is installed; only the release targets are listed', async () => {
    const mac = await tempRoot();
    const linux = await tempRoot();
    fakeInstall(mac, { app: { '@fake/watcher': '2.0.0', alpha: '1.0.0' } }, [...watcherFamily('darwin-arm64'), { name: 'alpha', version: '1.0.0', files: { LICENSE: MIT('Alpha'), 'license.js': 'module.exports = 1' } }]);
    fakeInstall(linux, { app: { '@fake/watcher': '2.0.0', alpha: '1.0.0' } }, [...watcherFamily('linux-x64-glibc'), { name: 'alpha', version: '1.0.0', files: { LICENSE: MIT('Alpha'), 'license.js': 'module.exports = 1' } }]);
    const text = renderNotices(SPEC, mac);
    expect(renderNotices(SPEC, mac)).toBe(text);
    expect(renderNotices(SPEC, linux)).toBe(text);
    const listed = listedPackages(text);
    expect([...listed.keys()]).toEqual(['@fake/watcher', '@fake/watcher-darwin-arm64', '@fake/watcher-darwin-x64', '@fake/watcher-linux-arm64-glibc', '@fake/watcher-linux-x64-glibc', 'alpha', 'is-glob']);
    expect(text).toContain('  @fake/watcher-linux-x64-glibc@2.0.0  same license files as @fake/watcher@2.0.0\n');
    expect(text).not.toMatch(/musl|win32|android/);
    // The parent's section names its platform parts; the text appears once, verbatim; code files named license.* are not license files.
    expect(text.split('Copyright (c) 2026 Watcher authors').length).toBe(2);
    expect(text).toContain('@fake/watcher@2.0.0\nLicense: MIT\nSource: https://github.com/example/fake-watcher\nAlso covers its platform-specific native parts');
    expect(text).toContain('----- LICENSE.md -----\nMIT License\n\nCopyright (c) 2026 Jon Schlinkert');
    expect(text).not.toContain('module.exports');
    expect(text.endsWith('\n') && !text.endsWith('\n\n')).toBe(true);
  });

  it('reproduces NOTICE files (Apache-2.0) next to the license, with line endings and trailing spaces normalised', async () => {
    const root = await tempRoot();
    fakeInstall(root, { app: { 'apache-thing': '3.0.0' } }, [
      { name: 'apache-thing', version: '3.0.0', license: 'Apache-2.0', files: { LICENSE: 'Apache License\r\nVersion 2.0, January 2004   \r\n', NOTICE: 'Apache Thing\r\nCopyright 2026 Example Corp.\r\n\r\n' } },
    ]);
    const text = renderNotices(SPEC, root);
    expect(text).toContain('apache-thing@3.0.0\nLicense: Apache-2.0\n');
    expect(text).toContain('----- LICENSE -----\nApache License\nVersion 2.0, January 2004\n\n----- NOTICE -----\nApache Thing\nCopyright 2026 Example Corp.\n');
  });

  it('fails loudly for a bundled package without a license file, naming it', async () => {
    const root = await tempRoot();
    fakeInstall(root, { app: { alpha: '1.0.0' } }, [
      { name: 'alpha', version: '1.0.0', files: { LICENSE: MIT('Alpha') }, deps: { 'no-license': '0.1.0' } },
      { name: 'no-license', version: '0.1.0', files: { 'README.md': '# no license here' } },
    ]);
    expect(() => renderNotices(SPEC, root)).toThrow(/no-license@0\.1\.0 \(node_modules\/\.pnpm\/no-license@0\.1\.0\/node_modules\/no-license\) has no license file/);
  });

  it('fails when a platform package carries another license than its parent, or when none of them is installed', async () => {
    const differs = await tempRoot();
    fakeInstall(differs, { app: { '@fake/watcher': '2.0.0' } }, watcherFamily('darwin-arm64', MIT('Watcher authors'), MIT('Someone else')));
    expect(() => renderNotices(SPEC, differs)).toThrow(/@fake\/watcher-darwin-arm64@2\.0\.0 is a platform package of @fake\/watcher@2\.0\.0 but its license files or license field differ/);
    const none = await tempRoot();
    fakeInstall(none, { app: { '@fake/watcher': '2.0.0' } }, watcherFamily('win32-x64'));
    expect(() => renderNotices(SPEC, none)).toThrow(/none of @fake\/watcher-darwin-arm64@2\.0\.0, .* is installed on this machine/);
  });

  it('fails when node_modules does not match the lockfile, or a dependency is missing', async () => {
    const stale = await tempRoot();
    fakeInstall(stale, { app: { alpha: '1.0.0' } }, [{ name: 'alpha', version: '1.0.0', installedVersion: '0.9.0', files: { LICENSE: MIT('Alpha') } }]);
    expect(() => renderNotices(SPEC, stale)).toThrow(/is alpha@0\.9\.0, but pnpm-lock\.yaml says alpha@1\.0\.0: node_modules is out of date/);
    const missing = await tempRoot();
    fakeInstall(missing, { app: { alpha: '1.0.0' } }, [{ name: 'alpha', version: '1.0.0', installed: false }]);
    expect(() => renderNotices(SPEC, missing)).toThrow(/alpha@1\.0\.0 \(a dependency of app\) is not installed/);
  });

  it('follows workspace links (link:) into the other workspace packages', async () => {
    const root = await tempRoot();
    fakeInstall(root, { app: { lib: 'link:../lib', alpha: '1.0.0' }, lib: { beta: '2.0.0' } }, [
      { name: 'alpha', version: '1.0.0', files: { LICENSE: MIT('Alpha') } },
      { name: 'beta', version: '2.0.0', files: { COPYING: 'BSD 3-Clause, Beta authors\n' } },
    ]);
    expect([...listedPackages(renderNotices(SPEC, root)).keys()]).toEqual(['alpha', 'beta']);
  });
});

describe('the committed notices of this repository', () => {
  it('are exactly what pnpm-lock.yaml and node_modules give now (else: node scripts/third-party-notices.ts)', () => {
    expect(staleNotices(), 'run  node scripts/third-party-notices.ts  and commit both files').toEqual([]);
  });

  it('reproduce every license and NOTICE file of every package of the executable and the web app', () => {
    for (const [kind, importer, targets] of [['executable', 'packages/cli', RELEASE_TARGETS], ['web', 'apps/web', null]] as const) {
      const text = readFileSync(join(ROOT, NOTICES_FILES[kind]), 'utf8');
      const closure = dependencyClosure(ROOT, importer, targets);
      expect(closure.size).toBeGreaterThan(10);
      for (const [key, entry] of closure) {
        expect(text, `${kind}: ${key}`).toContain(`\n  ${key}  `);
        if (entry.dir === null || entry.sameAs !== null) continue;
        const names = readdirSync(entry.dir).filter((name) => /^(licen[cs]e|copying|notice|third[-_]?party)/i.test(name) && !/\.(js|ts|json)$/.test(name) && statSync(join(entry.dir as string, name)).isFile());
        if (entry.name === '@xterm/headless' || entry.name === '@xterm/addon-serialize') expect(names).toEqual([]); // published without one: the xterm.js LICENSE stands in
        else expect(names.length, `${key} has license files`).toBeGreaterThan(0);
        for (const name of names) expect(text, `${kind}: ${key}/${name}`).toContain(`----- ${name} -----\n${entry.name === 'vite' ? '' : normaliseText(readFileSync(join(entry.dir, name), 'utf8'))}`);
      }
    }
  });

  it("carry @anthropic-ai/sandbox-runtime's Apache-2.0 LICENSE in full (and its NOTICE, whenever the package has one)", () => {
    const text = readFileSync(join(ROOT, NOTICES_FILES.executable), 'utf8');
    const srt = dependencyClosure(ROOT, 'packages/cli', RELEASE_TARGETS).get(`@anthropic-ai/sandbox-runtime@${(JSON.parse(readFileSync(join(ROOT, 'packages/daemon/package.json'), 'utf8')) as { dependencies: Record<string, string> }).dependencies['@anthropic-ai/sandbox-runtime']}`);
    expect(srt?.dir).toBeTruthy();
    const dir = srt?.dir as string;
    const license = normaliseText(readFileSync(join(dir, 'LICENSE'), 'utf8'));
    expect(license).toMatch(/^\s*Apache License\n\s*Version 2\.0, January 2004\n/);
    expect(text).toContain(`License: Apache-2.0\nSource: https://github.com/anthropics/sandbox-runtime\n\n----- LICENSE -----\n${license}`);
    for (const name of readdirSync(dir).filter((file) => /^notice/i.test(file))) expect(text).toContain(`----- ${name} -----\n${normaliseText(readFileSync(join(dir, name), 'utf8'))}`);
    // The Linux executables carry srt's statically linked apply-seccomp: the glibc note, then the Node.js placeholder.
    expect(text).toContain('statically\nlinked with the GNU C Library (glibc)');
    expect(text.endsWith(`\n${NODE_PENDING_SECTION}`)).toBe(true);
  });

  it('list every npm package esbuild bundles into the executable, and the native parts', async () => {
    // The same bundle as scripts/build-sea.ts (CLI entry and the docs compute worker; node-pty and @parcel/watcher are
    // its native stand-ins, their packages are added like build-sea adds them), without writing anything.
    const cliRequire = createRequire(join(ROOT, 'packages/cli/package.json'));
    const esbuild = cliRequire('esbuild') as { build(options: Record<string, unknown>): Promise<{ metafile: { inputs: Record<string, unknown> } }> };
    const stub = { name: 'native-stand-ins', setup(build: { onResolve: (o: { filter: RegExp }, f: (a: { path: string }) => unknown) => void; onLoad: (o: { filter: RegExp; namespace: string }, f: () => unknown) => void }) {
      build.onResolve({ filter: /^(node-pty|@parcel\/watcher)$/ }, (args) => ({ path: args.path, namespace: 'native' }));
      build.onLoad({ filter: /.*/, namespace: 'native' }, () => ({ contents: 'module.exports = {}', loader: 'js' }));
    } };
    const bundled = new Set<string>(['node-pty', '@parcel/watcher', `@parcel/watcher-${process.platform}-${process.arch}${process.platform === 'linux' ? '-glibc' : ''}`]);
    for (const entry of ['packages/cli/src/main.ts', 'packages/daemon/src/docs/compute-worker.ts']) {
      const result = await esbuild.build({ entryPoints: [join(ROOT, entry)], bundle: true, platform: 'node', format: 'cjs', write: false, metafile: true, outdir: join(ROOT, 'packages/cli/dist/never-written'), logLevel: 'silent', define: { 'import.meta.url': '__x', __SMURG_BUILD_VERSION__: '"0.0.0"' }, plugins: [stub] });
      for (const input of Object.keys(result.metafile.inputs)) {
        const name = bundledPackageOf(input);
        if (name !== null) bundled.add(name);
      }
    }
    for (const name of ['@anthropic-ai/sandbox-runtime', 'zod', 'yjs', 'ws', 'jose', '@xterm/headless']) expect(bundled).toContain(name);
    expect(uncoveredPackages('executable', bundled)).toEqual([]);
    expect(uncoveredPackages('executable', ['left-pad'])).toEqual(['left-pad']);
  });
});

describe('the Node.js section and the helpers', () => {
  it('fills the placeholder with the LICENSE of the Node.js distribution, and refuses anything else', async () => {
    const prefix = await tempRoot();
    mkdirSync(join(prefix, 'bin'));
    writeFileSync(join(prefix, 'bin', 'node'), '');
    expect(nodeDistributionLicense(join(prefix, 'bin', 'node'), '22.0.0')).toBeNull();
    writeFileSync(join(prefix, 'LICENSE'), 'MIT License of something else\n');
    expect(nodeDistributionLicense(join(prefix, 'bin', 'node'), '22.0.0')).toBeNull();
    writeFileSync(join(prefix, 'LICENSE'), 'Node.js is licensed for use as follows:\r\n\r\n"""\r\nCopyright Node.js contributors.   \r\n"""\r\n');
    const full = executableNotices(join(prefix, 'bin', 'node'), '22.0.0');
    const committed = readFileSync(join(ROOT, NOTICES_FILES.executable), 'utf8');
    expect(full.startsWith(committed.slice(0, committed.length - NODE_PENDING_SECTION.length))).toBe(true);
    expect(full.endsWith('node@22.0.0 (the Node.js runtime)\nLicense: MIT; the libraries Node.js contains are listed with their licenses in this LICENSE file\nSource: https://nodejs.org/\n\n----- LICENSE -----\nNode.js is licensed for use as follows:\n\n"""\nCopyright Node.js contributors.\n"""\n')).toBe(true);
    expect(full).not.toContain(NODE_PENDING_SECTION);
    expect(() => composeExecutableNotices('no placeholder here\n', { version: '22.0.0', text: 'x' })).toThrow(/placeholder/);
    expect(() => composeExecutableNotices(committed, { version: 'v22', text: 'x' })).toThrow(/not a Node\.js version/);
    // The real distribution of the Node running this test (nvm, setup-node: <prefix>/LICENSE beside bin/node).
    const real = nodeDistributionLicense(process.execPath, process.versions.node);
    if (real === null) console.warn(`[notices] the Node running the tests (${process.execPath}) has no distribution LICENSE: build-sea would refuse it`);
    else expect(real.text).toMatch(/^Node\.js is licensed for use as follows:/);
  });

  it('maps bundled module paths to packages, reads the index, parses pnpm lockfile YAML', () => {
    expect(bundledPackageOf('../../node_modules/.pnpm/@noble+curves@2.4.0/node_modules/@noble/curves/esm/ed25519.js')).toBe('@noble/curves');
    expect(bundledPackageOf('node_modules/.pnpm/ws@8.22.0/node_modules/ws/lib/websocket.js')).toBe('ws');
    expect(bundledPackageOf('C:\\x\\node_modules\\zod\\index.js')).toBe('zod');
    expect(bundledPackageOf('packages/daemon/src/index.ts')).toBeNull();
    expect(bundledPackageOf('/r/node_modules/.pnpm/x@1/node_modules/')).toBeNull();
    const listed = listedPackages(readFileSync(join(ROOT, NOTICES_FILES.executable), 'utf8'));
    expect(listed.get('zod')?.length).toBeGreaterThanOrEqual(1);
    expect(listed.has('node-pty') && listed.has('@parcel/watcher') && listed.has('@anthropic-ai/sandbox-runtime')).toBe(true);
    const lock = parseLockfile("lockfileVersion: '9.0'\n\npackages:\n\n  '@a/b@1.0.0':\n    resolution: {integrity: sha512-x}\n    cpu: [x64, '!arm']\n\nsnapshots:\n\n  c@2.0.0(d@1.0.0):\n    dependencies:\n      d: 1.0.0\n    transitivePeerDependencies:\n      - '@e/f'\n  g@1.0.0: {}\n");
    expect(lock).toEqual({
      lockfileVersion: '9.0',
      packages: { '@a/b@1.0.0': { resolution: '{integrity: sha512-x}', cpu: ['x64', '!arm'] } },
      snapshots: { 'c@2.0.0(d@1.0.0)': { dependencies: { d: '1.0.0' }, transitivePeerDependencies: ['@e/f'] }, 'g@1.0.0': {} },
    });
    expect(relative(ROOT, join(ROOT, NOTICES_FILES.web))).toBe('apps/web/public/third-party-notices.txt');
  });
});
