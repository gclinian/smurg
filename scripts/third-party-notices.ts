// Third-party notices for what smurg distributes. smurg itself is proprietary (LICENSE); the packages bundled into the
// executable and into the web app keep their own licenses, which require their license and notice texts to travel
// with every copy. This generates those texts from the real dependency graph (pnpm-lock.yaml) and the installed
// packages' own files (node_modules), never by hand:
//
//   node scripts/third-party-notices.ts            (re)write both files below
//   node scripts/third-party-notices.ts --check    exit 1 when a file is not what pnpm-lock.yaml and node_modules give
//                                                  now (packages/cli/test/third-party-notices.test.ts runs the same)
//   node scripts/third-party-notices.ts --executable [--node PATH] [--out FILE]
//                                                  the executable's COMPLETE notices: packages/cli/THIRD-PARTY-NOTICES.txt
//                                                  with its Node.js section filled in from the LICENSE of the Node.js
//                                                  distribution of PATH (default: the running node). scripts/build-sea.ts
//                                                  embeds exactly this (`smurg licenses`).
//
// Files (committed; deterministic: the same bytes on every machine and platform that installed the same lockfile):
//   packages/cli/THIRD-PARTY-NOTICES.txt     the executable: the production dependency closure of @smurg/cli (with
//                                            @smurg/daemon and @smurg/protocol) for the four release targets
//                                            (darwin-arm64, darwin-x64, linux-x64, linux-arm64; glibc), plus esbuild,
//                                            whose runtime helpers are part of the bundle; then the Node.js
//                                            placeholder section.
//   apps/web/public/third-party-notices.txt  the web app (Vite copies it to dist: https://app.smurg.ai/third-party-notices.txt):
//                                            the production closure of @smurg/web, plus vite and rolldown (helpers).
//
// For every package: the root files whose names start with LICENSE/LICENCE, COPYING, NOTICE or ThirdPartyNotices /
// THIRD-PARTY-LICENSE (any case), verbatim except line endings and trailing spaces. A package without one FAILS the
// generation (there is no silent fallback). Platform-specific native packages (optional dependencies with os/cpu, such
// as @parcel/watcher-linux-x64-glibc) are installed only for the machine's own platform, so their text is the parent
// package's: the generator checks that every installed one carries exactly the parent's license files and license
// field, and fails when none of them is installed. The bundles are checked against these lists when they are built:
// scripts/build-sea.ts (esbuild's metafile and the native assets) and apps/web/vite.config.ts (Rollup's module ids)
// refuse a bundled package the notices do not list (bundledPackageOf, uncoveredPackages).
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, posix, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { composeExecutableNotices, NODE_PENDING_SECTION, nodeDistributionLicense, normaliseText, SECTION_RULE } from '../packages/cli/src/licenses/notices.ts';

export const ROOT = fileURLToPath(new URL('..', import.meta.url));

export type NoticesKind = 'executable' | 'web';

/** Where each committed file lives (relative to the repository root). */
export const NOTICES_FILES: Readonly<Record<NoticesKind, string>> = {
  executable: 'packages/cli/THIRD-PARTY-NOTICES.txt',
  web: 'apps/web/public/third-party-notices.txt',
};

/** The release targets (scripts/build-sea.ts TARGETS, scripts/install.sh). */
export const RELEASE_TARGETS: readonly Target[] = [
  { os: 'darwin', cpu: 'arm64' },
  { os: 'darwin', cpu: 'x64' },
  { os: 'linux', cpu: 'x64', libc: 'glibc' },
  { os: 'linux', cpu: 'arm64', libc: 'glibc' },
];

export interface Target {
  readonly os: string;
  readonly cpu: string;
  readonly libc?: string;
}

/** Build tools whose own code ends up in a bundle (runtime helpers), with where their version comes from. */
export interface BuildTool {
  readonly name: string;
  /** Importer whose devDependencies name it, or the package whose snapshot dependencies do. */
  readonly from: { readonly importer: string } | { readonly package: string };
  readonly why: string;
}

export interface NoticesSpec {
  readonly title: string;
  readonly intro: string;
  /** Workspace package (lockfile importer) whose production closure is bundled. */
  readonly importer: string;
  /** null: every optional package (a browser bundle has no platform packages). */
  readonly targets: readonly Target[] | null;
  readonly buildTools: readonly BuildTool[];
  /** Sections after the packages' (each starting with SECTION_RULE), from the closure. */
  readonly trailer?: (entries: readonly PackageEntry[]) => readonly string[];
}

const SPECS: Readonly<Record<NoticesKind, NoticesSpec>> = {
  executable: {
    title: 'smurg: third-party notices of the smurg executable',
    intro: `smurg itself is proprietary software under its own license (\`smurg licenses\`, https://smurg.ai/license/). The smurg
executable contains the third-party software listed below, each provided under its own license. This file reproduces
the license and notice files each package publishes, unchanged except for line endings and trailing spaces. The
executable also contains the Node.js runtime (the last section).

The executable for each platform contains the packages below that are meant for it: packages listed as "same license
files as" another are the platform-specific native parts of that package, published by its authors under the same
license files. "build tool" marks a tool whose small runtime helper functions are part of the program.`,
    importer: 'packages/cli',
    targets: RELEASE_TARGETS,
    buildTools: [{ name: 'esbuild', from: { importer: 'packages/cli' }, why: 'its runtime helper functions are part of the program' }],
    trailer: () => [NODE_PENDING_SECTION],
  },
  web: {
    title: 'smurg: third-party notices of the smurg web app',
    intro: `smurg itself is proprietary software under its own license (https://smurg.ai/license/). The smurg web app contains the
third-party software listed below, each provided under its own license. This file reproduces the license and notice
files each package publishes, unchanged except for line endings and trailing spaces (and, for vite, only the license
of Vite's own code: see its section). "build tool" marks a tool whose small runtime helper functions are part of the
app's code.`,
    importer: 'apps/web',
    targets: null,
    buildTools: [
      { name: 'vite', from: { importer: '.' }, why: 'its module preload helper and polyfill are part of the app' },
      { name: 'rolldown', from: { package: 'vite' }, why: 'its runtime helper functions are part of the app' },
    ],
  },
};

/** Per-package exceptions to "every license file, verbatim". Each one says why. */
const FILE_RULES: Readonly<Record<string, { readonly file: string; readonly cutAt: string; readonly note: string }>> = {
  vite: {
    file: 'LICENSE.md',
    cutAt: '# Licenses of bundled dependencies',
    note: "Only the first part of vite's LICENSE.md (Vite's own code) is reproduced: the rest lists the licenses of the libraries inside Vite's build tooling, none of which is part of the app.",
  },
};

/**
 * Packages published WITHOUT a license file, whose license text is published in another package built from the same
 * repository (checked: the same `license` field, both packages' repository URLs inside `repository`). The source
 * package is read where a workspace package (`via`) depends on it.
 */
const BORROWED_LICENSE: Readonly<Record<string, { readonly from: string; readonly via: string; readonly repository: string }>> = {
  '@xterm/headless': { from: '@xterm/xterm', via: 'apps/web', repository: 'https://github.com/xtermjs/xterm.js' },
  '@xterm/addon-serialize': { from: '@xterm/xterm', via: 'apps/web', repository: 'https://github.com/xtermjs/xterm.js' },
};

// ---------------------------------------------------------------------------------------------------------------------
// pnpm-lock.yaml (lockfile v9): the subset of YAML pnpm writes. Mappings by indentation, `key: value` and `key:`, keys
// plain or single-/double-quoted, scalar values plain or quoted, flow sequences ([a, b]) parsed, other flow values ({…})
// kept as text ({} as an empty mapping), block sequences (- item) of scalars.

type YamlValue = string | YamlValue[] | YamlMap;
interface YamlMap {
  [key: string]: YamlValue;
}

function unquote(text: string): string {
  if (text.startsWith("'") && text.endsWith("'") && text.length >= 2) return text.slice(1, -1).replaceAll("''", "'");
  if (text.startsWith('"') && text.endsWith('"') && text.length >= 2) return JSON.parse(text) as string;
  return text;
}

function scalar(text: string): YamlValue {
  const value = text.trim();
  if (value === '{}') return {};
  if (value.startsWith('[') && value.endsWith(']')) {
    const inner = value.slice(1, -1).trim();
    return inner === '' ? [] : inner.split(',').map((item) => unquote(item.trim()));
  }
  return unquote(value);
}

/** `key: value` / `key:` → [key, rest or null]; quoted keys may contain anything but their quote. */
function splitKey(content: string, lineNo: number): [string, string | null] {
  let key: string;
  let rest: string;
  if (content.startsWith("'") || content.startsWith('"')) {
    const quote = content[0] as string;
    let end = 1;
    for (;;) {
      end = content.indexOf(quote, end);
      if (end < 0) throw new Error(`pnpm-lock.yaml:${lineNo}: unterminated quoted key`);
      if (quote === "'" && content[end + 1] === "'") {
        end += 2;
        continue;
      }
      break;
    }
    key = unquote(content.slice(0, end + 1));
    rest = content.slice(end + 1);
  } else {
    const colon = content.search(/:(?: |$)/);
    if (colon < 0) throw new Error(`pnpm-lock.yaml:${lineNo}: expected "key:" in ${JSON.stringify(content)}`);
    key = content.slice(0, colon);
    rest = content.slice(colon);
  }
  if (!rest.startsWith(':')) throw new Error(`pnpm-lock.yaml:${lineNo}: expected ":" after key ${JSON.stringify(key)}`);
  const value = rest.slice(1).trim();
  return [key, value === '' ? null : value];
}

export function parseLockfile(text: string): YamlMap {
  const root: YamlMap = {};
  // Open containers by indentation. `pending` is a `key:` whose children decide whether it is a mapping or a sequence.
  const stack: { indent: number; container: YamlMap | YamlValue[] | null; parent: YamlMap; key: string }[] = [];
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] as string;
    if (line.trim() === '' || line.trimStart().startsWith('#')) continue;
    const indent = line.length - line.trimStart().length;
    const content = line.trim();
    while (stack.length > 0 && (stack[stack.length - 1] as { indent: number }).indent >= indent) stack.pop();
    const top = stack[stack.length - 1];
    let container: YamlMap | YamlValue[];
    if (top === undefined) container = root;
    else {
      if (top.container === null) {
        top.container = content.startsWith('- ') || content === '-' ? [] : {};
        top.parent[top.key] = top.container;
      }
      container = top.container;
    }
    if (content.startsWith('- ')) {
      if (!Array.isArray(container)) throw new Error(`pnpm-lock.yaml:${i + 1}: a sequence item outside a sequence`);
      container.push(scalar(content.slice(2)));
      continue;
    }
    if (Array.isArray(container)) throw new Error(`pnpm-lock.yaml:${i + 1}: a mapping entry inside a sequence`);
    const [key, value] = splitKey(content, i + 1);
    if (value === null) {
      container[key] = {};
      stack.push({ indent, container: null, parent: container, key });
    } else container[key] = scalar(value);
  }
  return root;
}

function asMap(value: YamlValue | undefined): YamlMap {
  return value !== undefined && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function asList(value: YamlValue | undefined): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

// ---------------------------------------------------------------------------------------------------------------------
// The dependency closure.

interface Lockfile {
  readonly importers: YamlMap;
  readonly packages: YamlMap;
  readonly snapshots: YamlMap;
}

const parsedLockfiles = new Map<string, Lockfile>();

function readLockfile(root: string): Lockfile {
  const text = readFileSync(join(root, 'pnpm-lock.yaml'), 'utf8');
  const cached = parsedLockfiles.get(text);
  if (cached !== undefined) return cached;
  const lock = parseLockfile(text);
  if (lock['lockfileVersion'] !== '9.0') throw new Error(`pnpm-lock.yaml: lockfileVersion ${JSON.stringify(lock['lockfileVersion'])} is not supported (9.0 expected): update scripts/third-party-notices.ts`);
  const parsed = { importers: asMap(lock['importers']), packages: asMap(lock['packages']), snapshots: asMap(lock['snapshots']) };
  parsedLockfiles.clear();
  parsedLockfiles.set(text, parsed);
  return parsed;
}

/** `1.2.3(peer@4)(x@5)` → `1.2.3`. */
const withoutPeers = (version: string): string => version.replace(/\(.*$/, '');

/** A dependency's lockfile reference → the real package name and its snapshot version (an `npm:` alias resolved). */
function resolveReference(name: string, reference: string): { name: string; version: string } {
  const base = withoutPeers(reference);
  const at = base.lastIndexOf('@');
  if (at > 0) return { name: base.slice(0, at), version: reference.slice(at + 1) };
  return { name, version: reference };
}

function matchesList(list: readonly string[], value: string | undefined): boolean {
  if (list.length === 0) return true;
  if (value === undefined) return false;
  const negated = list.filter((item) => item.startsWith('!')).map((item) => item.slice(1));
  const positive = list.filter((item) => !item.startsWith('!'));
  return !negated.includes(value) && (positive.length === 0 || positive.includes(value));
}

function forTargets(meta: YamlMap, targets: readonly Target[] | null): boolean {
  if (targets === null) return true;
  const os = asList(meta['os']);
  const cpu = asList(meta['cpu']);
  const libc = asList(meta['libc']);
  return targets.some((target) => matchesList(os, target.os) && matchesList(cpu, target.cpu) && matchesList(libc, target.libc));
}

const isPlatformPackage = (meta: YamlMap): boolean => asList(meta['os']).length > 0 || asList(meta['cpu']).length > 0 || asList(meta['libc']).length > 0;

export interface PackageEntry {
  readonly name: string;
  readonly version: string;
  /** The installed package directory, or null (a platform package of another platform). */
  readonly dir: string | null;
  /** A platform-specific native part: its license files are this package's (name@version). */
  readonly sameAs: string | null;
  /** Set for build tools (why their code is in the bundle). */
  readonly buildTool: string | null;
}

/** The node_modules directory that holds `dir`'s dependencies (pnpm: the one `dir` itself is linked in). */
function dependencyRoot(dir: string, name: string): string {
  return name.startsWith('@') ? dirname(dirname(dir)) : dirname(dir);
}

function installedDir(nodeModules: string, name: string, version: string): string | null {
  const link = join(nodeModules, ...name.split('/'));
  if (!existsSync(link)) return null;
  const dir = realpathSync(link);
  const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { name?: string; version?: string };
  if (manifest.name !== name || manifest.version !== withoutPeers(version)) {
    throw new Error(`${relative(ROOT, link)} is ${manifest.name}@${manifest.version}, but pnpm-lock.yaml says ${name}@${withoutPeers(version)}: node_modules is out of date (scripts/with-install-lock.sh pnpm install)`);
  }
  return dir;
}

/** The production dependency closure of a workspace package, keyed `name@version`. */
export function dependencyClosure(root: string, importer: string, targets: readonly Target[] | null): Map<string, PackageEntry> {
  const lock = readLockfile(root);
  const entries = new Map<string, PackageEntry>();
  const seenImporters = new Set<string>();
  const seenSnapshots = new Set<string>();

  const visitPackage = (name: string, reference: string, nodeModules: string, parent: { key: string; optional: boolean } | null): void => {
    const resolved = resolveReference(name, reference);
    const snapshotKey = `${resolved.name}@${resolved.version}`;
    const version = withoutPeers(resolved.version);
    const key = `${resolved.name}@${version}`;
    const meta = lock.packages[key];
    const snapshot = lock.snapshots[snapshotKey];
    if (meta === undefined || snapshot === undefined) throw new Error(`pnpm-lock.yaml has no package/snapshot ${snapshotKey}`);
    if (!forTargets(asMap(meta), targets)) return;
    const platform = isPlatformPackage(asMap(meta)) && parent !== null && parent.optional;
    const dir = installedDir(nodeModules, resolved.name, resolved.version);
    if (dir === null && !platform) throw new Error(`${key} (a dependency of ${parent?.key ?? importer}) is not installed: run scripts/with-install-lock.sh pnpm install`);
    if (!entries.has(key)) entries.set(key, { name: resolved.name, version, dir, sameAs: platform ? (parent as { key: string }).key : null, buildTool: null });
    if (seenSnapshots.has(snapshotKey)) return;
    seenSnapshots.add(snapshotKey);
    if (dir === null) {
      if (Object.keys(asMap(asMap(snapshot)['dependencies'])).length > 0) throw new Error(`${key} is not installed here and has dependencies of its own: its notices cannot be derived`);
      return;
    }
    const childModules = dependencyRoot(dir, resolved.name);
    for (const [kind, optional] of [['dependencies', false], ['optionalDependencies', true]] as const) {
      for (const [child, childReference] of Object.entries(asMap(asMap(snapshot)[kind]))) {
        if (typeof childReference !== 'string') continue;
        visitPackage(child, childReference, childModules, { key, optional });
      }
    }
  };

  const visitImporter = (path: string): void => {
    if (seenImporters.has(path)) return;
    seenImporters.add(path);
    const record = asMap(lock.importers[path]);
    if (lock.importers[path] === undefined) throw new Error(`pnpm-lock.yaml has no importer ${path}`);
    const nodeModules = join(root, path, 'node_modules');
    for (const kind of ['dependencies', 'optionalDependencies'] as const) {
      for (const [name, value] of Object.entries(asMap(record[kind]))) {
        const reference = asMap(value)['version'];
        if (typeof reference !== 'string') continue;
        if (reference.startsWith('link:')) visitImporter(posix.normalize(posix.join(path, reference.slice('link:'.length))));
        else visitPackage(name, reference, nodeModules, null);
      }
    }
  };

  visitImporter(importer);
  return entries;
}

/** The installed package `name` that a workspace package (`importer`) depends on directly, with its lockfile version. */
function importerPackage(root: string, lock: Lockfile, importer: string, name: string): { reference: string; dir: string } {
  const record = asMap(lock.importers[importer]);
  const reference = asMap(asMap(record['devDependencies'])[name] ?? asMap(record['dependencies'])[name])['version'];
  if (typeof reference !== 'string') throw new Error(`pnpm-lock.yaml: importer ${importer} does not depend on ${name}`);
  const dir = installedDir(join(root, importer, 'node_modules'), name, reference);
  if (dir === null) throw new Error(`${name} is not installed: run scripts/with-install-lock.sh pnpm install`);
  return { reference, dir };
}

/** A build tool's entry: its version from the lockfile, its installed directory. */
function buildToolEntry(root: string, tool: BuildTool): PackageEntry {
  const lock = readLockfile(root);
  const fromImporter = (importer: string, name: string): { reference: string; dir: string } => importerPackage(root, lock, importer, name);
  let reference: string;
  let dir: string;
  if ('importer' in tool.from) ({ reference, dir } = fromImporter(tool.from.importer, tool.name));
  else {
    // A dependency of another build tool (rolldown of vite): that tool's snapshot names its version.
    const owner = fromImporter('.', tool.from.package);
    const value = asMap(asMap(lock.snapshots[`${tool.from.package}@${owner.reference}`])['dependencies'])[tool.name];
    if (typeof value !== 'string') throw new Error(`pnpm-lock.yaml: ${tool.from.package}@${owner.reference} does not depend on ${tool.name}`);
    reference = value;
    const installed = installedDir(dependencyRoot(owner.dir, tool.from.package), tool.name, reference);
    if (installed === null) throw new Error(`${tool.name} is not installed: run scripts/with-install-lock.sh pnpm install`);
    dir = installed;
  }
  return { name: tool.name, version: withoutPeers(reference), dir, sameAs: null, buildTool: tool.why };
}

// ---------------------------------------------------------------------------------------------------------------------
// License files.

const LICENSE_FILE = /^(?:licen[cs]e|copying|notice|third[-_]?party[-_]?(?:notices?|licen[cs]es?))(?:[-._].*)?$/i;
const CODE_FILE = /\.(?:[cm]?js|[cm]?ts|json|map|html?|d\.ts)$/i;

interface LicenseFile {
  readonly name: string;
  readonly text: string;
}

/** Byte-order comparison: the same on every machine (localeCompare is not). */
const byCodeUnit = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

function licenseFiles(entry: PackageEntry): LicenseFile[] {
  const dir = entry.dir as string;
  const names = readdirSync(dir)
    .filter((name) => LICENSE_FILE.test(name) && !CODE_FILE.test(name) && statSync(join(dir, name)).isFile())
    .sort(byCodeUnit);
  const rule = FILE_RULES[entry.name];
  return names.map((name) => {
    let text = readFileSync(join(dir, name), 'utf8');
    if (rule !== undefined && rule.file === name) {
      const cut = text.indexOf(rule.cutAt);
      if (cut < 0) throw new Error(`${entry.name}@${entry.version}: ${name} no longer contains ${JSON.stringify(rule.cutAt)}: check FILE_RULES in scripts/third-party-notices.ts`);
      text = text.slice(0, cut);
    }
    return { name, text: normaliseText(text) };
  });
}

interface Manifest {
  readonly license?: unknown;
  readonly licenses?: unknown;
  readonly repository?: unknown;
  readonly homepage?: unknown;
}

function manifestOf(entry: PackageEntry): Manifest {
  return JSON.parse(readFileSync(join(entry.dir as string, 'package.json'), 'utf8')) as Manifest;
}

function licenseField(manifest: Manifest): string {
  const { license, licenses } = manifest;
  if (typeof license === 'string' && license.trim() !== '') return license.trim();
  if (license && typeof license === 'object' && typeof (license as { type?: unknown }).type === 'string') return (license as { type: string }).type;
  if (Array.isArray(licenses)) {
    const types = licenses.map((item: unknown) => (item && typeof item === 'object' ? (item as { type?: unknown }).type : item)).filter((type): type is string => typeof type === 'string');
    if (types.length > 0) return types.join(' OR ');
  }
  return '(not stated in package.json)';
}

function sourceOf(manifest: Manifest): string | null {
  const { repository, homepage } = manifest;
  let url: unknown = typeof repository === 'string' ? repository : repository && typeof repository === 'object' ? (repository as { url?: unknown }).url : undefined;
  if (typeof url !== 'string' && typeof homepage === 'string') url = homepage;
  if (typeof url !== 'string' || url.trim() === '') return null;
  let text = url.trim().replace(/^git\+/, '').replace(/\.git$/, '');
  if (/^github:/.test(text)) text = `https://github.com/${text.slice('github:'.length)}`;
  else if (/^[\w.-]+\/[\w.-]+$/.test(text)) text = `https://github.com/${text}`;
  text = text.replace(/^git:\/\//, 'https://').replace(/^ssh:\/\/git@/, 'https://').replace(/^git@github\.com:/, 'https://github.com/');
  return text;
}

// ---------------------------------------------------------------------------------------------------------------------
// Rendering.

/** Words joined into lines of at most `width` characters (a longer word stays on its own line). */
function wrap(text: string, width = 118): string {
  const lines: string[] = [];
  let line = '';
  for (const word of text.split(/\s+/)) {
    if (line !== '' && line.length + 1 + word.length > width) {
      lines.push(line);
      line = word;
    } else line = line === '' ? word : `${line} ${word}`;
  }
  if (line !== '') lines.push(line);
  return lines.join('\n');
}

/** The notices text of one kind, from the lockfile and node_modules under `root`. */
export function generateNotices(kind: NoticesKind, root = ROOT): string {
  return renderNotices(SPECS[kind], root);
}

/** The notices text of `spec` (the tests drive it with a fixture). */
export function renderNotices(spec: NoticesSpec, root = ROOT): string {
  const what = `the notices of ${spec.importer}`;
  const closure = dependencyClosure(root, spec.importer, spec.targets);
  for (const tool of spec.buildTools) {
    const entry = buildToolEntry(root, tool);
    const key = `${entry.name}@${entry.version}`;
    if (!closure.has(key)) closure.set(key, entry);
  }
  // By name, then version (a package before its platform-specific parts, whose names extend it).
  const entries = [...closure.entries()].sort(([, a], [, b]) => byCodeUnit(a.name, b.name) || byCodeUnit(a.version, b.version));
  const problems: string[] = [];
  const files = new Map<string, LicenseFile[]>();
  const manifests = new Map<string, Manifest>();
  const borrowedNotes = new Map<string, string>();
  for (const [key, entry] of entries) {
    if (entry.dir === null) continue;
    const manifest = manifestOf(entry);
    manifests.set(key, manifest);
    let own = licenseFiles(entry);
    const borrow = BORROWED_LICENSE[entry.name];
    if (borrow !== undefined) {
      if (own.length > 0) problems.push(`${key} has license files now: remove its BORROWED_LICENSE rule from scripts/third-party-notices.ts`);
      else {
        const source = importerPackage(root, readLockfile(root), borrow.via, borrow.from);
        const sourceEntry: PackageEntry = { name: borrow.from, version: withoutPeers(source.reference), dir: source.dir, sameAs: null, buildTool: null };
        const sourceManifest = manifestOf(sourceEntry);
        const inRepository = (url: string | null): boolean => url !== null && (url === borrow.repository || url.startsWith(`${borrow.repository}/`));
        if (licenseField(sourceManifest) !== licenseField(manifest) || !inRepository(sourceOf(manifest)) || !inRepository(sourceOf(sourceManifest))) {
          problems.push(`${key}: its BORROWED_LICENSE rule no longer holds (license field or repository differ from ${borrow.from}'s)`);
        }
        own = licenseFiles(sourceEntry);
        borrowedNotes.set(key, `The package is published without a license file. It is built from ${borrow.repository}, whose license file follows as published in ${borrow.from}@${sourceEntry.version}.`);
      }
    }
    files.set(key, own);
  }
  // Platform packages: the parent's files; every installed one must carry exactly those, and one must be installed.
  const families = new Map<string, { installed: number; members: string[] }>();
  for (const [key, entry] of entries) {
    if (entry.sameAs === null) {
      if ((files.get(key) ?? []).length === 0) problems.push(`${key} (${relative(realpathSync(root), entry.dir as string)}) has no license file (LICENSE, LICENCE, COPYING, NOTICE…): find its license text and add a rule to scripts/third-party-notices.ts, or do not bundle it`);
      continue;
    }
    const family = families.get(entry.sameAs) ?? { installed: 0, members: [] };
    family.members.push(key);
    families.set(entry.sameAs, family);
    if (entry.dir === null) continue;
    family.installed += 1;
    const parentFiles = files.get(entry.sameAs) ?? [];
    const own = files.get(key) ?? [];
    const sameText = own.length > 0 && own.map((file) => file.text).join('\0') === parentFiles.map((file) => file.text).join('\0');
    const sameField = licenseField(manifests.get(key) as Manifest) === licenseField(manifests.get(entry.sameAs) as Manifest);
    if (!sameText || !sameField) problems.push(`${key} is a platform package of ${entry.sameAs} but its license files or license field differ from the parent's: its notices cannot stand in for the other platforms' (list it on its own)`);
  }
  for (const [parent, family] of families) {
    if (family.installed === 0) problems.push(`none of ${family.members.join(', ')} (platform packages of ${parent}) is installed on this machine, so their license files cannot be checked against ${parent}'s: generate the notices on macOS or Linux`);
  }
  if (problems.length > 0) throw new Error(`${what}:\n  - ${problems.join('\n  - ')}`);

  const index: string[] = [];
  const sections: string[] = [];
  for (const [key, entry] of entries) {
    if (entry.sameAs !== null) {
      index.push(`  ${key}  same license files as ${entry.sameAs}`);
      continue;
    }
    const manifest = manifests.get(key) as Manifest;
    const license = licenseField(manifest);
    index.push(`  ${key}  ${license}${entry.buildTool !== null ? ' (build tool)' : ''}`);
    const head = [SECTION_RULE, key, `License: ${license}`];
    const source = sourceOf(manifest);
    if (source !== null) head.push(`Source: ${source}`);
    const covers = families.get(key);
    if (covers) head.push(`Also covers its platform-specific native parts (the same license files):\n${covers.members.map((member) => `  ${member}`).join('\n')}`);
    if (entry.buildTool !== null) head.push(wrap(`Build tool: ${entry.buildTool}.`));
    const rule = FILE_RULES[entry.name];
    if (rule !== undefined) head.push(wrap(rule.note));
    const borrowed = borrowedNotes.get(key);
    if (borrowed !== undefined) head.push(wrap(borrowed));
    const body = (files.get(key) as LicenseFile[]).map((file) => `----- ${file.name} -----\n${file.text}`);
    sections.push(`${head.join('\n')}\n\n${body.join('\n')}`);
  }

  const parts = [`${spec.title}\n${'='.repeat(spec.title.length)}\n\n${spec.intro}\n`, `Packages (${index.length}):\n${index.join('\n')}\n`, ...sections];
  if (spec.trailer) parts.push(...spec.trailer(entries.map(([, entry]) => entry)));
  // Sections are separated by one blank line; every text ends with exactly one newline.
  const text = parts.map((part) => (part.endsWith('\n') ? part : `${part}\n`)).join('\n');
  if (/\r/.test(text)) throw new Error('notices contain a carriage return');
  return text;
}

// ---------------------------------------------------------------------------------------------------------------------
// What a bundle contains, checked against a notices file.

/** The `name@version` entries a notices file lists in its "Packages" index. */
export function listedPackages(notices: string): Map<string, string[]> {
  const listed = new Map<string, string[]>();
  const start = notices.search(/^Packages \(\d+\):$/m);
  if (start < 0) throw new Error('not a notices file: no "Packages (N):" index');
  for (const line of notices.slice(start).split('\n').slice(1)) {
    if (line === '') break;
    const match = /^ {2}(@?[^@\s]+)@(\S+) {2}/.exec(line);
    if (!match) throw new Error(`notices index line not understood: ${JSON.stringify(line)}`);
    const [, name, version] = match as unknown as [string, string, string];
    listed.set(name, [...(listed.get(name) ?? []), version]);
  }
  return listed;
}

/**
 * The npm package a bundled module comes from (`…/node_modules/.pnpm/x@1/node_modules/@a/b/lib/c.js` → `@a/b`), or
 * null for a module of this repository. Separators of either kind; the last node_modules segment wins.
 */
export function bundledPackageOf(modulePath: string): string | null {
  const parts = modulePath.split(/[\\/]/);
  const at = parts.lastIndexOf('node_modules');
  if (at < 0) return null;
  const first = parts[at + 1];
  if (first === undefined || first === '' || first === '.pnpm') return null;
  if (first.startsWith('@')) {
    const second = parts[at + 2];
    return second ? `${first}/${second}` : null;
  }
  return first;
}

/** Package names of `bundled` that the committed notices of `kind` do not list. */
export function uncoveredPackages(kind: NoticesKind, bundled: Iterable<string>, root = ROOT): string[] {
  const listed = listedPackages(readFileSync(join(root, NOTICES_FILES[kind]), 'utf8'));
  return [...new Set(bundled)].filter((name) => !listed.has(name)).sort(byCodeUnit);
}

/** The executable's complete notices (the Node.js section filled in from `nodeBinary`'s distribution). */
export function executableNotices(nodeBinary: string, nodeVersion: string, root = ROOT): string {
  const committed = readFileSync(join(root, NOTICES_FILES.executable), 'utf8');
  const node = nodeDistributionLicense(nodeBinary, nodeVersion);
  if (node === null) throw new Error(`no Node.js LICENSE next to ${nodeBinary} (expected <prefix>/LICENSE of an official Node.js distribution beside <prefix>/bin/node): the executable must carry it`);
  return composeExecutableNotices(committed, node);
}

/** Kinds whose committed file differs from a fresh generation. */
export function staleNotices(root = ROOT): NoticesKind[] {
  return (['executable', 'web'] as const).filter((kind) => {
    const file = join(root, NOTICES_FILES[kind]);
    return !existsSync(file) || readFileSync(file, 'utf8') !== generateNotices(kind, root);
  });
}

function main(argv: readonly string[]): number {
  const options = new Set(argv.filter((arg) => arg === '--check' || arg === '--executable'));
  let node = process.execPath;
  let out: string | null = null;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string;
    if (arg === '--check' || arg === '--executable') continue;
    if (arg === '--node' || arg === '--out') {
      const value = argv[++i];
      if (value === undefined) throw new Error(`${arg} needs a value`);
      if (arg === '--node') node = value;
      else out = value;
    } else if (arg === '-h' || arg === '--help') {
      process.stdout.write('usage: node scripts/third-party-notices.ts [--check] | --executable [--node PATH] [--out FILE]\n');
      return 0;
    } else throw new Error(`unknown argument ${arg}`);
  }
  if (options.has('--executable')) {
    const version = node === process.execPath ? process.versions.node : (JSON.parse(execNodeVersion(node)) as string);
    const text = executableNotices(node, version);
    if (out === null) process.stdout.write(text);
    else writeFileSync(out, text);
    return 0;
  }
  if (options.has('--check')) {
    const stale = staleNotices();
    if (stale.length === 0) {
      process.stdout.write(`third-party notices up to date: ${Object.values(NOTICES_FILES).join(', ')}\n`);
      return 0;
    }
    process.stderr.write(`third-party notices out of date: ${stale.map((kind) => NOTICES_FILES[kind]).join(', ')}\nregenerate: node scripts/third-party-notices.ts\n`);
    return 1;
  }
  for (const kind of ['executable', 'web'] as const) {
    const text = generateNotices(kind);
    writeFileSync(join(ROOT, NOTICES_FILES[kind]), text);
    const count = [...listedPackages(text).values()].reduce((sum, versions) => sum + versions.length, 0);
    process.stdout.write(`${NOTICES_FILES[kind]}: ${count} packages, ${(Buffer.byteLength(text) / 1024).toFixed(0)} KiB\n`);
  }
  return 0;
}

function execNodeVersion(node: string): string {
  return execFileSync(node, ['-p', 'JSON.stringify(process.versions.node)']).toString();
}

/** True when this file is the script being run (Vite's config loader and the tests import it). */
function isMain(): boolean {
  const script = process.argv[1];
  if (script === undefined || !existsSync(script)) return false;
  try {
    return realpathSync(script) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isMain()) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(`third-party-notices: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 1;
  }
}
