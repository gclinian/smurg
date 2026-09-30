// Key files are only ever created in per-test temporary directories (never under the real ~/.smurg) and removed
// afterwards.
import { chmod, lstat, mkdir, mkdtemp, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { randomBytes, toHex } from '../bytes.ts';
import {
  CLI_DEVICE_KEY_FILE,
  DAEMON_IDENTITY_KEY_FILE,
  loadDaemonIdentity,
  loadOrCreateCliDeviceKey,
  loadOrCreateDaemonIdentity,
  pinDaemonKey,
  readPinnedDaemonKey,
} from './identity.ts';
import { KeyFileError, ensurePrivateDirectory, readKeyFile, writeKeyFile } from './key-file.ts';

let root: string;
const mode = async (p: string) => (await stat(p)).mode & 0o777;
const WS = 'ws_test_0123456789';

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'smurg-protocol-keys-'));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('key files', () => {
  it('creates private directories (0700) and 0600 files, whatever the umask', async () => {
    const previous = process.umask(0o000);
    try {
      const dir = join(root, 'a', 'b');
      await ensurePrivateDirectory(dir);
      expect(await mode(dir)).toBe(0o700);
      expect(await mode(join(root, 'a'))).toBe(0o700);
      const key = randomBytes(32);
      await writeKeyFile(join(dir, 'k.key'), key);
      expect(await mode(join(dir, 'k.key'))).toBe(0o600);
      expect(await readKeyFile(join(dir, 'k.key'))).toEqual(key);
      expect((await readdir(dir)).filter((f) => f.endsWith('.tmp'))).toEqual([]);
    } finally {
      process.umask(previous);
    }
  });

  it('create-only writes never replace an existing key; overwrite replaces an insecure file with a 0600 one', async () => {
    const dir = join(root, 's');
    await ensurePrivateDirectory(dir);
    const path = join(dir, 'k.key');
    const first = randomBytes(32);
    await writeKeyFile(path, first);
    await expect(writeKeyFile(path, randomBytes(32))).rejects.toMatchObject({ code: 'exists' });
    expect(await readKeyFile(path)).toEqual(first);
    await chmod(path, 0o644);
    const second = randomBytes(32);
    await writeKeyFile(path, second, { overwrite: true });
    expect(await mode(path)).toBe(0o600);
    expect(await readKeyFile(path)).toEqual(second);
    expect((await readdir(dir)).sort()).toEqual(['k.key']);
  });

  it('refuses group/other permission bits, symlinks, wrong sizes and insecure directories', async () => {
    const dir = join(root, 's');
    await ensurePrivateDirectory(dir);
    const path = join(dir, 'k.key');
    await writeKeyFile(path, randomBytes(32));
    for (const m of [0o640, 0o604, 0o644, 0o660]) {
      await chmod(path, m);
      await expect(readKeyFile(path)).rejects.toMatchObject({ code: 'insecure-permissions' });
    }
    await chmod(path, 0o600);
    const link = join(dir, 'link.key');
    await symlink(path, link);
    await expect(readKeyFile(link)).rejects.toMatchObject({ code: 'not-regular-file' });
    const short = join(dir, 'short.key');
    await writeFile(short, randomBytes(31), { mode: 0o600 });
    await expect(readKeyFile(short)).rejects.toMatchObject({ code: 'wrong-size' });
    const directory = join(dir, 'dir.key');
    await mkdir(directory, { mode: 0o700 });
    await expect(readKeyFile(directory)).rejects.toMatchObject({ code: 'not-regular-file' });
    await expect(readKeyFile(join(dir, 'missing.key'))).rejects.toMatchObject({ code: 'missing' });
    await chmod(dir, 0o750);
    await expect(readKeyFile(path)).rejects.toMatchObject({ code: 'insecure-directory' });
    await expect(ensurePrivateDirectory(dir)).rejects.toMatchObject({ code: 'insecure-directory' });
    await expect(writeKeyFile(join(dir, 'new.key'), randomBytes(32))).rejects.toMatchObject({ code: 'insecure-directory' });
    expect(await mode(dir)).toBe(0o750); // refused, never "repaired"
  });

  it('refuses a directory that is a symlink', async () => {
    const real = join(root, 'real');
    await ensurePrivateDirectory(real);
    const alias = join(root, 'alias');
    await symlink(real, alias);
    await expect(ensurePrivateDirectory(alias)).rejects.toBeInstanceOf(KeyFileError);
  });
});

describe('daemon identity and CLI device key', () => {
  it('creates once, then loads the same key', async () => {
    const wsDir = join(root, 'workspaces', WS);
    const a = await loadOrCreateDaemonIdentity(wsDir);
    expect(a.created).toBe(true);
    expect(await mode(join(wsDir, DAEMON_IDENTITY_KEY_FILE))).toBe(0o600);
    const b = await loadOrCreateDaemonIdentity(wsDir);
    expect(b.created).toBe(false);
    expect(b.keyPair.publicKey).toEqual(a.keyPair.publicKey);
    expect((await loadDaemonIdentity(wsDir)).publicKey).toEqual(a.keyPair.publicKey);
    const cli = await loadOrCreateCliDeviceKey(root);
    expect(cli.created).toBe(true);
    expect((await lstat(join(root, CLI_DEVICE_KEY_FILE))).isFile()).toBe(true);
  });

  it('concurrent first starts agree on a single key', async () => {
    const wsDir = join(root, 'race');
    const results = await Promise.all(Array.from({ length: 8 }, () => loadOrCreateDaemonIdentity(wsDir)));
    expect(new Set(results.map((r) => toHex(r.keyPair.publicKey))).size).toBe(1);
    expect(results.filter((r) => r.created)).toHaveLength(1);
  });

  it('never silently rotates: an insecure or corrupt identity file is an error, not a reason to regenerate', async () => {
    const wsDir = join(root, 'ws');
    const original = await loadOrCreateDaemonIdentity(wsDir);
    const path = join(wsDir, DAEMON_IDENTITY_KEY_FILE);
    await chmod(path, 0o644);
    await expect(loadOrCreateDaemonIdentity(wsDir)).rejects.toMatchObject({ code: 'insecure-permissions' });
    await chmod(path, 0o600);
    await writeFile(path, randomBytes(16));
    await expect(loadOrCreateDaemonIdentity(wsDir)).rejects.toMatchObject({ code: 'wrong-size' });
    expect(original.created).toBe(true);
    await expect(loadDaemonIdentity(join(root, 'nowhere'))).rejects.toMatchObject({ code: 'missing' });
  });
});

describe('CLI daemon pins', () => {
  it('pins, re-pins the same key, refuses a different key unless replace is explicit', async () => {
    expect(await readPinnedDaemonKey(root, WS)).toBeNull();
    const k1 = randomBytes(32);
    await pinDaemonKey(root, WS, k1);
    expect(await readPinnedDaemonKey(root, WS)).toEqual(k1);
    await pinDaemonKey(root, WS, k1);
    const k2 = randomBytes(32);
    await expect(pinDaemonKey(root, WS, k2)).rejects.toMatchObject({ code: 'exists' });
    expect(await readPinnedDaemonKey(root, WS)).toEqual(k1);
    await pinDaemonKey(root, WS, k2, { replace: true });
    expect(await readPinnedDaemonKey(root, WS)).toEqual(k2);
  });

  // Security review F3: ids are case-sensitive (anyone can claim `victim_…` next to `Victim_…` at the relay), the
  // default macOS file system is not. Pinning one must never read or overwrite the other's pin.
  it('pins of workspace ids that differ only in case are independent', async () => {
    const real = 'Victim_Workspace_0123456789';
    const attacker = 'victim_workspace_0123456789';
    const realKey = new Uint8Array(32).fill(0xaa);
    await pinDaemonKey(root, real, realKey);
    expect(await readPinnedDaemonKey(root, attacker)).toBeNull();
    await pinDaemonKey(root, attacker, new Uint8Array(32).fill(0xbb), { replace: true });
    expect(await readPinnedDaemonKey(root, real)).toEqual(realKey);
  });

  it('workspace ids cannot escape the pin directory', async () => {
    for (const bad of ['../../../../etc/passwd', 'a/b', '..', 'short']) {
      await expect(pinDaemonKey(root, bad, randomBytes(32))).rejects.toThrow(TypeError);
      await expect(readPinnedDaemonKey(root, bad)).rejects.toThrow(TypeError);
    }
  });
});
