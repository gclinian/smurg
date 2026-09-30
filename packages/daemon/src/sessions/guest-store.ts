// Per-guest directories (ARCHITECTURE §7.1, §7.6, §11 D-9): `<stateDir>/guests/<wsKey>/<userKey>/` holding home/
// (HOME), cfg/ (CLAUDE_CONFIG_DIR) and tmp/ (TMPDIR). Keys are lowercase hex hashes: case-fold safe on APFS (ids are
// case-sensitive) and short, because tools in a guest session create Unix sockets under $TMPDIR (104-byte limit).
//
// THE GUEST CONTROLS EVERYTHING INSIDE ITS DIR. Its sandbox may write there, so any entry (even the dir itself, which a
// sandbox subpath rule lets it delete and re-create) can become a symlink to a host file at any moment, and the daemon
// is not sandboxed. The daemon therefore never writes into a guest dir by path while a guest process could race it:
//  - writes (the trust seed in cfg/.claude.json, imported config) happen only while the guest has NO running session,
//    and inside a QUARANTINE: the dir is first renamed to `<wsKey>/.work-<rand>`, a path no sandbox may touch (srt's
//    macOS rules are path based, so even an escaped process loses access; on Linux nothing of the guest survives its
//    sessions: PID namespace). There, with no concurrent writer, every component is lstat-checked (planted symlinks
//    and files are replaced, never followed), and the dir is renamed back afterwards;
//  - removal renames the dir out of reach first, then `rm -rf`s it (fs.rm never follows symlinks).
import { createHash, randomBytes } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { lstat, mkdir, open, readdir, realpath, rename, rm, unlink } from 'node:fs/promises';
import { join } from 'node:path';

export interface GuestPaths {
  readonly root: string;
  readonly home: string;
  readonly cfg: string;
  readonly tmp: string;
}

const KEY = /^[0-9a-f]{16}$/;

function hashKey(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex').slice(0, 16);
}

export function guestKeyOf(userId: string): string {
  return hashKey(`smurg-guest:${userId}`);
}

export function workspaceGuestKeyOf(workspaceId: string): string {
  return hashKey(`smurg-workspace:${workspaceId}`);
}

function pathsIn(root: string): GuestPaths {
  return { root, home: join(root, 'home'), cfg: join(root, 'cfg'), tmp: join(root, 'tmp') };
}

function isMissing(err: unknown): boolean {
  return (err as NodeJS.ErrnoException | undefined)?.code === 'ENOENT';
}

async function lstatOrNull(path: string): Promise<import('node:fs').Stats | null> {
  try {
    return await lstat(path);
  } catch (err) {
    if (isMissing(err)) return null;
    throw err;
  }
}

/**
 * Makes `<parent>/<name>` a real directory (0700) and returns its path. Anything else there (a symlink, a file) is
 * removed first, never followed. Only for trees no one else can write concurrently (a quarantine, or daemon-owned).
 */
export async function ensureRealDir(parent: string, name: string): Promise<string> {
  const path = join(parent, name);
  const info = await lstatOrNull(path);
  if (info?.isDirectory()) return path;
  if (info) await rm(path, { force: true }); // removes a symlink itself, never its target
  await mkdir(path, { mode: 0o700 });
  return path;
}

export class GuestStore {
  /** realpath of `<stateDir>/guests/<wsKey>` (0700). */
  readonly base: string;

  private constructor(base: string) {
    this.base = base;
  }

  static async open(stateDir: string, workspaceId: string): Promise<GuestStore> {
    const guests = await ensureRealDir(stateDir, 'guests');
    const base = await ensureRealDir(guests, workspaceGuestKeyOf(workspaceId));
    return new GuestStore(await realpath(base));
  }

  pathsFor(userId: string): GuestPaths {
    return pathsIn(join(this.base, guestKeyOf(userId)));
  }

  /** Whether the guest dir exists as a real directory (never follows a planted symlink). */
  async exists(userId: string): Promise<boolean> {
    const info = await lstatOrNull(this.pathsFor(userId).root);
    return info?.isDirectory() ?? false;
  }

  /**
   * Runs `work` on the guest's dir in quarantine (see the file header) and puts it back. PRECONDITION (the caller's,
   * under its per-guest lock): the guest has no running session. Creates the dir when it does not exist yet.
   */
  async withQuarantine<T>(userId: string, work: (paths: GuestPaths) => Promise<T>): Promise<T> {
    const final = this.pathsFor(userId).root;
    const quarantine = join(this.base, `.work-${randomBytes(8).toString('hex')}`);
    const existing = await lstatOrNull(final);
    if (existing) await rename(final, quarantine); // a symlink or file moves as itself: nothing is followed
    const moved = await lstatOrNull(quarantine);
    if (moved && !moved.isDirectory()) await rm(quarantine, { force: true });
    if (!moved || !moved.isDirectory()) await mkdir(quarantine, { mode: 0o700 });
    try {
      const paths = pathsIn(quarantine);
      for (const name of ['home', 'cfg', 'tmp']) await ensureRealDir(quarantine, name);
      const result = await work(paths);
      await this.publish(quarantine, final);
      return result;
    } catch (err) {
      // Put whatever we have back only when nothing took its place; otherwise it goes to the trash.
      await this.publish(quarantine, final).catch(async () => rm(quarantine, { recursive: true, force: true }));
      throw err;
    }
  }

  private async publish(quarantine: string, final: string): Promise<void> {
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        await rename(quarantine, final);
        return;
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code !== 'EEXIST' && code !== 'ENOTEMPTY' && code !== 'ENOTDIR' && code !== 'EISDIR') throw err;
        // Something re-created the dir's name meanwhile: move it out of the way (it is not ours to trust).
        await this.discard(final);
      }
    }
    throw new Error('guest dir could not be put back');
  }

  /** Moves `path` out of every sandbox's reach, then deletes it. */
  private async discard(path: string): Promise<boolean> {
    const trash = join(this.base, `.trash-${randomBytes(8).toString('hex')}`);
    try {
      await rename(path, trash);
    } catch (err) {
      if (isMissing(err)) return false;
      throw err;
    }
    await rm(trash, { recursive: true, force: true });
    return true;
  }

  /** `rm -rf` of the guest dir (this is what removes a guest's Claude credential). Returns whether one existed. */
  async remove(userId: string): Promise<boolean> {
    return this.discard(this.pathsFor(userId).root);
  }

  /** Dir names (user keys) present on disk. */
  async keys(): Promise<string[]> {
    const names = await readdir(this.base).catch(() => [] as string[]);
    return names.filter((name) => KEY.test(name));
  }

  async removeKey(key: string): Promise<boolean> {
    if (!KEY.test(key)) return false;
    return this.discard(join(this.base, key));
  }

  /** Leftovers of an interrupted quarantine or removal (daemon crash). Only at start, before any session runs. */
  async sweepLeftovers(): Promise<number> {
    let removed = 0;
    for (const name of await readdir(this.base).catch(() => [] as string[])) {
      if (!/^\.(work|trash)-[0-9a-f]{16}$/.test(name)) continue;
      await rm(join(this.base, name), { recursive: true, force: true });
      removed++;
    }
    return removed;
  }
}

/**
 * Reads a small regular file inside a quarantined guest tree without following a symlink at the final component.
 * Returns null when it is missing, a symlink, not a regular file, or larger than `maxBytes`.
 */
export async function readGuestFile(path: string, maxBytes: number): Promise<Buffer | null> {
  let handle;
  try {
    handle = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK);
  } catch {
    return null;
  }
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > maxBytes) return null;
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}

/**
 * Writes `<dir>/<name>` atomically (0600): a fresh temp file (O_EXCL | O_NOFOLLOW), fsync, rename over the name
 * (rename replaces a planted symlink as an entry; it never writes through it). Only inside a quarantine.
 */
export async function writeGuestFileAtomic(dir: string, name: string, data: Uint8Array): Promise<void> {
  const tmp = join(dir, `.${name}.smurg-${randomBytes(6).toString('hex')}.tmp`);
  const handle = await open(tmp, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW, 0o600);
  try {
    await handle.writeFile(data);
    await handle.sync();
  } catch (err) {
    await handle.close().catch(() => {});
    await unlink(tmp).catch(() => {});
    throw err;
  }
  await handle.close();
  const target = join(dir, name);
  const existing = await lstatOrNull(target);
  if (existing?.isDirectory()) await rm(target, { recursive: true, force: true });
  await rename(tmp, target);
}
