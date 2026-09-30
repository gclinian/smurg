// Temporary folders for one acceptance test: the shared project, a sibling "outside" folder (targets of escape
// attempts), and the daemon's state dir. Everything lives under one `smurg-e2e-*` directory and is removed by
// stop(). The base is SMURG_E2E_TMPDIR when set (keeps runs inside a sandbox's scratch area), else the OS temp dir;
// never ~/.smurg (ARCHITECTURE §0 rule 4).
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, sep } from 'node:path';
import { registerTestDir } from '@smurg/daemon/testing';

const PREFIX = 'smurg-e2e-';

async function tempBase(): Promise<string> {
  const configured = process.env['SMURG_E2E_TMPDIR'];
  const base = configured && configured.length > 0 ? configured : tmpdir();
  await mkdir(base, { recursive: true });
  // realpath: macOS /var → /private/var, so paths compare equal to what the daemon resolves.
  return realpath(base);
}

/** A fresh private (0700, mkdtemp) directory. */
export async function createTempDir(label: string): Promise<string> {
  const base = await tempBase();
  const dir = await realpath(await mkdtemp(join(base, `${PREFIX}${label.replace(/[^a-z0-9-]/gi, '')}-`)));
  registerTestDir(dir); // removed after the run if this test never gets to stop() (its worker died)
  return dir;
}

/** Removes a directory made by createTempDir, and refuses anything else. */
export async function removeTempDir(dir: string): Promise<void> {
  const base = await tempBase();
  const name = dir.slice(base.length + 1);
  if (!dir.startsWith(base + sep) || !name.startsWith(PREFIX) || name.includes(sep)) throw new Error(`refusing to remove ${dir}`);
  await rm(dir, { recursive: true, force: true });
}

export type ProjectEntry = string | Uint8Array | { readonly symlink: string };

/** Writes `files` (relative path → content, or `{ symlink: target }`) under `dir`. */
export async function writeTree(dir: string, files: Readonly<Record<string, ProjectEntry>>): Promise<void> {
  for (const [rel, entry] of Object.entries(files)) {
    const path = join(dir, rel);
    await mkdir(dirname(path), { recursive: true });
    if (typeof entry === 'object' && !(entry instanceof Uint8Array)) await symlink(entry.symlink, path);
    else await writeFile(path, entry);
  }
}
