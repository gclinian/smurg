// TEST ONLY. How the tests of test/upgrade/ get at what the PUBLISHED versions of smurg wrote
// (test/fixtures/published/<version>/, its README says how each was made): the copy step, a check of the stored
// bytes against files.json, a picture of a folder (names, modes, bytes) and the fixture's ledger.
//
// This file, daemon-on.ts and the tests that start a daemon (opens, refusals, owner, put-back, other-version) import
// from src/ only what the code of tag v0.5.0 already had (the testing harness, createDaemon, admitConnection) and
// name everything 0.5.1 added to the disk by its literal name ('written-by.json',
// 'state.json.before-upgrade-from-0.4.0'): the names are a promise to every later version, and the same files can be
// run in a tree of the tag, where each test must fail for the reason 0.5.1 exists (the owner's refusal, word for
// word). The pin and the coverage test (pin.test.ts, fixtures.test.ts, persisted.ts) are about THIS tree's schemas.
import { createHash } from 'node:crypto';
import { chmodSync, closeSync, ftruncateSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, writeFileSync, writeSync } from 'node:fs';
import { lstat, mkdtemp, readFile, readdir, readlink, realpath } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTempRunDir, registerTestDir, removeTempRunDir } from '../../src/testing/index.ts';

/** `packages/daemon/test/fixtures/published` */
export const PUBLISHED_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'published');
/** Every published version that has a fixture, oldest first. The last one wrote the shapes this smurg writes. */
export const PUBLISHED_VERSIONS = ['0.4.0', '0.5.0'] as const;
export type PublishedVersion = (typeof PUBLISHED_VERSIONS)[number];
export type FixtureVariantName = 'stopped' | 'running';

/** The stamp of a workspace folder (DESIGN A5). A literal on purpose: every later smurg looks for this name. */
export const STAMP_NAME = 'written-by.json';
/** The kept copy of `<document>.json` as the step from `<from>` found it (DESIGN A9). A literal on purpose. */
export const keptCopyName = (document: string, from: string): string => `${document}.json.before-upgrade-from-${from}`;

// =====================================================================================================================
// The copy step: VERBATIM from test/fixtures/published/README.md ("The copy step"). Change it there first.
// =====================================================================================================================

export interface FixtureFile { path: string; mode: string; size: number; sha256: string; placeholder?: true; prefixOf?: string; pieces?: { offset: number; length: number; file: string }[] }
export interface FixtureVariant { at: number; overlayOf?: string; absent?: string[]; dirs: { path: string; mode: string }[]; files: FixtureFile[] }
export interface FixtureManifest { version: string; placeholder: string; variants: Record<string, FixtureVariant> }

/** Copies one variant of `<…>/fixtures/published/<version>` into the empty folder `to`. */
export function copyPublishedFixture(fixtureDir: string, variantName: 'stopped' | 'running', to: string) {
  const manifest = JSON.parse(readFileSync(join(fixtureDir, 'files.json'), 'utf8')) as FixtureManifest;
  const variant = manifest.variants[variantName];
  if (variant === undefined) throw new Error(`the fixture has no variant ${variantName}`);
  mkdirSync(to, { recursive: true, mode: 0o700 });
  chmodSync(to, 0o700);
  const root = realpathSync(to);
  // The files of the variant: its own, and (an overlay) those of the variant below that it neither replaces nor leaves out.
  const files = new Map<string, FixtureFile & { layer: string }>();
  if (variant.overlayOf !== undefined) {
    const gone = new Set(variant.absent ?? []);
    for (const file of manifest.variants[variant.overlayOf]!.files) if (!gone.has(file.path)) files.set(file.path, { ...file, layer: variant.overlayOf });
  }
  for (const file of variant.files) files.set(file.path, { ...file, layer: variantName });

  // Every folder, the empty ones too, 0700; `project` is where the state says the shared folder is (empty here).
  for (const dir of [...variant.dirs, { path: 'project', mode: '0700' }]) {
    mkdirSync(join(root, dir.path), { recursive: true });
    chmodSync(join(root, dir.path), Number.parseInt(dir.mode, 8));
  }
  for (const file of files.values()) {
    const target = join(root, file.path);
    mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
    const mode = Number.parseInt(file.mode, 8);
    if (file.pieces !== undefined) {
      // An upload's part: its size, zeros, and the bytes that arrived at their offsets.
      const fd = openSync(target, 'wx', mode);
      try {
        ftruncateSync(fd, file.size);
        for (const piece of file.pieces) writeSync(fd, readFileSync(join(fixtureDir, file.layer, piece.file)), 0, piece.length, piece.offset);
      } finally {
        closeSync(fd);
      }
    } else {
      // `prefixOf`: this file is the first `size` bytes of the same file of that variant (an append-only log, earlier).
      let bytes = file.prefixOf !== undefined ? readFileSync(join(fixtureDir, file.prefixOf, file.path)).subarray(0, file.size) : readFileSync(join(fixtureDir, file.layer, file.path));
      // latin1 keeps every byte as it is; the placeholder and a temporary folder's path are plain ASCII.
      if (file.placeholder === true) bytes = Buffer.from(bytes.toString('latin1').split(manifest.placeholder).join(root), 'latin1');
      writeFileSync(target, bytes, { mode, flag: 'wx' });
    }
    chmodSync(target, mode); // the mode given to open() is cut by the process's umask
  }
  const hostHome = join(root, 'host');
  const workspaceId = (JSON.parse(readFileSync(join(hostHome, 'workspaces.json'), 'utf8')) as { shared: { workspaceId: string }[] }).shared[0]!.workspaceId;
  return { root, at: variant.at, hostHome, workspaceId, workspaceDir: join(hostHome, 'workspaces', workspaceId), project: join(root, 'project'), cliMemberHome: join(root, 'cli-member'), devices: join(root, 'devices') };
}

// =====================================================================================================================
// A copy a test works on
// =====================================================================================================================

export const fixtureDirOf = (version: PublishedVersion): string => join(PUBLISHED_DIR, version);

export function manifestOf(version: PublishedVersion): FixtureManifest {
  return JSON.parse(readFileSync(join(fixtureDirOf(version), 'files.json'), 'utf8')) as FixtureManifest;
}

/** The longest socket name a daemon makes in `<SMURG_HOME>/run` (the lock of the shared folder: `<12>.<hex4>.lk`). */
const LONGEST_SOCKET_NAME = 'abcdefghijkl.ffff.lk';
/** A Unix socket path holds 103 bytes on macOS (src/core/sockets.ts). */
const SOCKET_PATH_MAX_BYTES = 103;

/**
 * An empty private folder short enough for `<folder>/host/run/<socket>`: the fixture's SMURG_HOME is `host/` of the
 * copy, and a daemon started on it keeps its sockets below. createTempRunDir() measures `<folder>/<socket>` only.
 */
async function shortFolder(): Promise<string> {
  const fits = (dir: string): boolean => Buffer.byteLength(join(dir, 'host', 'run', LONGEST_SOCKET_NAME)) <= SOCKET_PATH_MAX_BYTES;
  const first = await createTempRunDir();
  if (fits(first)) return first;
  await removeTempRunDir(first);
  // The same kind of folder under /tmp (createTempRunDir's own second choice, and removeTempRunDir accepts it).
  const dir = await realpath(await mkdtemp(join(await realpath('/tmp'), 'smurg-run-')));
  registerTestDir(dir);
  if (!fits(dir)) throw new Error('no temp directory is short enough for the Unix sockets of a fixture copy');
  return dir;
}

export interface FixtureCopy {
  readonly version: PublishedVersion;
  readonly variant: FixtureVariantName;
  /** The folder the copy was made in (the placeholder of the stored files reads this path now). */
  readonly root: string;
  /** The instant the variant was taken (epoch ms): where a test sets its clock. */
  readonly at: number;
  /** The host's `~/.smurg` (SMURG_HOME). */
  readonly hostHome: string;
  readonly workspaceId: string;
  /** `<hostHome>/workspaces/<workspaceId>` */
  readonly workspaceDir: string;
  /** Where the state says the shared folder is. EMPTY: a fixture does not hold the shared folder. */
  readonly project: string;
  readonly cliMemberHome: string;
  /** `<devices>/<label>/device.key` + `pins/`: the devices of the people of the fixture's story. */
  readonly devices: string;
  /** Removes the copy (and nothing else). */
  remove(): Promise<void>;
}

/** A fresh copy of one variant of a published fixture, files 0600 and folders 0700, in a folder a daemon can start in. */
export async function copyOf(version: PublishedVersion, variant: FixtureVariantName = 'stopped'): Promise<FixtureCopy> {
  const to = await shortFolder();
  try {
    const copy = copyPublishedFixture(fixtureDirOf(version), variant, to);
    return { version, variant, ...copy, remove: () => removeTempRunDir(to) };
  } catch (err) {
    await removeTempRunDir(to).catch(() => {});
    throw err;
  }
}

/**
 * The stored files against files.json: every listed file is there with its size and SHA-256, and nothing is stored
 * that is not listed. A checkout that changed line ends, or a file a `.gitignore` rule left out, shows here.
 */
export function storedFileProblems(version: PublishedVersion): string[] {
  const dir = fixtureDirOf(version);
  const manifest = manifestOf(version);
  const problems: string[] = [];
  const listed = new Set<string>();
  for (const [name, variant] of Object.entries(manifest.variants)) {
    for (const file of variant.files) {
      if (file.prefixOf !== undefined) continue; // not stored: the first bytes of another variant's file
      const stored = file.pieces !== undefined ? file.pieces.map((piece) => piece.file) : [file.path];
      for (const path of stored) listed.add(`${name}/${path}`);
      if (file.pieces !== undefined) continue; // the pieces are checked by their length when the copy is made
      let bytes: Buffer;
      try {
        bytes = readFileSync(join(dir, name, file.path));
      } catch {
        problems.push(`${name}/${file.path}: listed in files.json and not stored`);
        continue;
      }
      if (bytes.length !== file.size) problems.push(`${name}/${file.path}: ${bytes.length} bytes, files.json says ${file.size}`);
      else if (createHash('sha256').update(bytes).digest('hex') !== file.sha256) problems.push(`${name}/${file.path}: the SHA-256 differs from files.json`);
    }
  }
  const walk = (path: string, name: string): void => {
    for (const entry of readdirSync(path, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
      const full = join(path, entry.name);
      if (entry.isDirectory()) walk(full, `${name}/${entry.name}`);
      else if (!listed.has(`${name}/${entry.name}`)) problems.push(`${name}/${entry.name}: stored and not listed in files.json`);
    }
  };
  for (const name of Object.keys(manifest.variants)) walk(join(dir, name), name);
  return problems;
}

// =====================================================================================================================
// Byte for byte
// =====================================================================================================================

/**
 * Everything below `dir`: every name with its kind, its mode and (a file) its size and the SHA-256 of its bytes, (a
 * symlink) where it points. Two equal pictures: nothing was created, removed, renamed, chmod-ed or written with other
 * bytes. Modification times are not in it (a rewrite with the same bytes is told by `mtimesOf`).
 */
export async function snapshotOf(dir: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  const walk = async (path: string, name: string): Promise<void> => {
    let st;
    try {
      st = await lstat(path);
    } catch {
      return;
    }
    const mode = (st.mode & 0o7777).toString(8);
    if (st.isSymbolicLink()) out[name] = `link ${mode} -> ${await readlink(path)}`;
    else if (st.isDirectory()) {
      out[`${name}/`] = `dir ${mode}`;
      for (const entry of (await readdir(path)).sort()) await walk(join(path, entry), `${name}/${entry}`);
    } else if (st.isFile()) {
      const bytes = await readFile(path).catch(() => null);
      out[name] = `file ${mode} ${st.size} ${bytes === null ? 'unreadable' : createHash('sha256').update(bytes).digest('hex')}`;
    } else out[name] = `other ${mode}`;
  };
  await walk(dir, '.');
  return out;
}

/** The modification time of every file directly in `dir` (ms): a file that was written again has another one. */
export async function mtimesOf(dir: string): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const name of (await readdir(dir)).sort()) {
    const st = await lstat(join(dir, name));
    if (st.isFile()) out[name] = st.mtimeMs;
  }
  return out;
}

/**
 * What a refused start must leave byte for byte (DESIGN A2): the workspace folder (its `uploads/` with it), the
 * launch files under `~/.smurg/sessions`, the uploads kept in the shared folder; and `all`: the whole copy, which is
 * the host's `~/.smurg` with `run/` and `logs/`, the files of the member who uses the command, the device keys and
 * the shared folder. (A daemon of the tests has no log file; the lock of the shared folder is a socket in `run/`
 * and a file in `<shared folder>/.smurg/`, both made and removed. `<shared folder>/.smurg/` itself is made by a
 * start before it reads anything: a test that compares `all` makes it first.)
 */
export async function everythingOf(copy: Pick<FixtureCopy, 'root' | 'hostHome' | 'workspaceDir' | 'project'>): Promise<{
  readonly workspace: Record<string, string>;
  readonly sessions: Record<string, string>;
  readonly shareUploads: Record<string, string>;
  readonly all: Record<string, string>;
}> {
  return {
    workspace: await snapshotOf(copy.workspaceDir),
    sessions: await snapshotOf(join(copy.hostHome, 'sessions')),
    shareUploads: await snapshotOf(join(copy.project, '.smurg', 'uploads')),
    all: await snapshotOf(copy.root),
  };
}

// =====================================================================================================================
// What the fixture holds
// =====================================================================================================================

export const readJson = async <T = unknown>(path: string): Promise<T> => JSON.parse(await readFile(path, 'utf8')) as T;
export const sha256Of = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

/** `ledger.json`: what the people of the fixture's story held. An invite's `url` carries its secret. */
export interface FixtureLedger {
  readonly workspaceId: string;
  readonly links: Readonly<Record<string, string>>;
  readonly invites: Readonly<Record<string, { readonly url: string; readonly id: string; readonly role: string }>>;
}

export function ledgerOf(version: PublishedVersion): FixtureLedger {
  return JSON.parse(readFileSync(join(fixtureDirOf(version), 'ledger.json'), 'utf8')) as FixtureLedger;
}

/** The stored state.json of a workspace, as much of it as the tests name. */
export interface StoredState {
  readonly version: number;
  readonly workspaceId: string;
  readonly members: readonly { readonly userId: string; readonly displayName: string; readonly role: string; readonly status: string; readonly kickedAt?: number }[];
  readonly devices: readonly { readonly deviceId: string; readonly userId: string; readonly publicKeyHex: string; readonly name: string; readonly kind: string; readonly revoked: boolean }[];
  readonly invites: readonly { readonly id: string; readonly keyIdHex: string; readonly role: string; readonly createdAt: number; readonly expiresAt?: number; readonly maxUses?: number; readonly uses: number; readonly revoked: boolean; readonly host: boolean }[];
  readonly settings: Readonly<Record<string, unknown>>;
  readonly worktreeRoots: readonly unknown[];
}
