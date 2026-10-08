// TEST ONLY: what a PUBLISHED smurg left on a host's computer, copied to a place where `smurg host` can open it.
// The fixtures are under packages/daemon/test/fixtures/published/<version>/ (written by the real code of that version;
// their README says how, and this is its copy step: git keeps no modes, no empty folders and no holes in files, and
// the stored files hold a placeholder for the folder they are copied to).
import { chmodSync, closeSync, ftruncateSync, mkdirSync, openSync, readFileSync, realpathSync, writeFileSync, writeSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const PUBLISHED_FIXTURES = fileURLToPath(new URL('../../daemon/test/fixtures/published', import.meta.url));

interface FixtureFile {
  path: string;
  mode: string;
  size: number;
  sha256: string;
  placeholder?: true;
  prefixOf?: string;
  pieces?: { offset: number; length: number; file: string }[];
}
interface FixtureVariant {
  at: number;
  overlayOf?: string;
  absent?: string[];
  dirs: { path: string; mode: string }[];
  files: FixtureFile[];
}
interface FixtureManifest {
  version: string;
  placeholder: string;
  variants: Record<string, FixtureVariant>;
}

export interface FixtureCopy {
  readonly root: string;
  /** The instant the variant was taken (epoch ms). */
  readonly at: number;
  /** The host's `~/.smurg` (SMURG_HOME). */
  readonly hostHome: string;
  readonly workspaceId: string;
  /** `<hostHome>/workspaces/<workspace id>`. */
  readonly workspaceDir: string;
  /** Where the state says the shared folder is (empty: a fixture holds no shared folder). */
  readonly project: string;
}

/**
 * Copies one variant of the fixture of `version` into the EMPTY folder `to` (a short path without `"` or `\`: the
 * daemon's sockets live under `<to>/host/run`): files 0600, folders 0700, the placeholder replaced by `to`.
 */
export function copyPublishedFixture(version: '0.4.0' | '0.5.0', variantName: 'stopped' | 'running', to: string): FixtureCopy {
  const fixtureDir = join(PUBLISHED_FIXTURES, version);
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
    for (const file of (manifest.variants[variant.overlayOf] as FixtureVariant).files) if (!gone.has(file.path)) files.set(file.path, { ...file, layer: variant.overlayOf });
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
  const workspaceId = ((JSON.parse(readFileSync(join(hostHome, 'workspaces.json'), 'utf8')) as { shared: { workspaceId: string }[] }).shared[0] as { workspaceId: string }).workspaceId;
  return { root, at: variant.at, hostHome, workspaceId, workspaceDir: join(hostHome, 'workspaces', workspaceId), project: join(root, 'project') };
}
