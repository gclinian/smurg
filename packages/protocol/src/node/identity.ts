// Static keys of the daemon (per workspace) and of the CLI device, plus the CLI's pins of verified daemon keys.
// Every helper takes its directory as a parameter: callers pass ~/.smurg/... in production and a temp dir in tests;
// nothing here defaults to the real home directory.
import { dirname, join } from 'node:path';
import { toHex, utf8Encode } from '../bytes.ts';
import { x25519KeyPair, type RawNoiseKeyPair } from '../noise/suite.ts';
import { isWorkspaceId } from '../relay/routes.ts';
import { KeyFileError, ensurePrivateDirectory, readKeyFile, writeKeyFile } from './key-file.ts';

/** `~/.smurg/workspaces/<workspaceId>/identity.key` (ARCHITECTURE §7.1). */
export const DAEMON_IDENTITY_KEY_FILE = 'identity.key';
/** `~/.smurg/device.key`. */
export const CLI_DEVICE_KEY_FILE = 'device.key';
/** `~/.smurg/pins/<hex(utf8(workspaceId))>.pub` (hex: case-insensitive file systems must not merge two ids). */
export const DAEMON_PIN_DIR = 'pins';

export interface LoadedStaticKey {
  readonly keyPair: RawNoiseKeyPair;
  /** True when this call generated and stored a new key. */
  readonly created: boolean;
}

/** Loads the X25519 secret in `<dir>/<fileName>`; throws KeyFileError('missing') if there is none. */
export async function loadStaticKey(dir: string, fileName: string): Promise<RawNoiseKeyPair> {
  return x25519KeyPair(await readKeyFile(join(dir, fileName), 32));
}

/**
 * Loads `<dir>/<fileName>`, or creates it if (and only if) it does not exist. An existing file that fails any check
 * (permissions, owner, size, symlink) is an error and is NEVER replaced: a silently rotated daemon key would make
 * every client refuse the daemon (daemon-key-mismatch), and a replaced device key would lose the device's identity.
 */
export async function loadOrCreateStaticKey(dir: string, fileName: string): Promise<LoadedStaticKey> {
  await ensurePrivateDirectory(dir);
  try {
    return { keyPair: await loadStaticKey(dir, fileName), created: false };
  } catch (err) {
    if (!(err instanceof KeyFileError) || err.code !== 'missing' || err.path !== join(dir, fileName)) throw err;
  }
  const keyPair = x25519KeyPair();
  try {
    await writeKeyFile(join(dir, fileName), keyPair.secretKey);
    return { keyPair, created: true };
  } catch (err) {
    // Someone else created it between our read and our write: theirs wins.
    if (err instanceof KeyFileError && err.code === 'exists') return { keyPair: await loadStaticKey(dir, fileName), created: false };
    throw err;
  }
}

/** The daemon's static key for one workspace; `workspaceStateDir` is `~/.smurg/workspaces/<workspaceId>`. */
export function loadOrCreateDaemonIdentity(workspaceStateDir: string): Promise<LoadedStaticKey> {
  return loadOrCreateStaticKey(workspaceStateDir, DAEMON_IDENTITY_KEY_FILE);
}

/** The daemon's static key; never creates one (use when the workspace must already exist). */
export function loadDaemonIdentity(workspaceStateDir: string): Promise<RawNoiseKeyPair> {
  return loadStaticKey(workspaceStateDir, DAEMON_IDENTITY_KEY_FILE);
}

/** The CLI's device key; `stateDir` is `~/.smurg`. */
export function loadOrCreateCliDeviceKey(stateDir: string): Promise<LoadedStaticKey> {
  return loadOrCreateStaticKey(stateDir, CLI_DEVICE_KEY_FILE);
}

function pinPath(stateDir: string, workspaceId: string): string {
  if (!isWorkspaceId(workspaceId)) throw new TypeError('invalid workspace id');
  // Workspace ids are case-sensitive, file systems often are not (APFS): `Ws_…` and `ws_…` are different workspaces
  // that anyone can claim at the relay, so the raw id as a file name would let one invite overwrite another
  // workspace's pin (security review F3). Lowercase hex of the UTF-8 id is injective under any case folding.
  return join(stateDir, DAEMON_PIN_DIR, `${toHex(utf8Encode(workspaceId))}.pub`);
}

/** The daemon key the CLI pinned for `workspaceId`, or null if none. Other errors (permissions, size) throw. */
export async function readPinnedDaemonKey(stateDir: string, workspaceId: string): Promise<Uint8Array | null> {
  const path = pinPath(stateDir, workspaceId);
  try {
    return await readKeyFile(path, 32);
  } catch (err) {
    // No pin file, or no pin directory yet: nothing pinned. Every other failure (permissions, size) is an error.
    if (err instanceof KeyFileError && err.code === 'missing' && (err.path === path || err.path === dirname(path))) return null;
    throw err;
  }
}

export interface PinDaemonKeyOptions {
  /**
   * Replace a different existing pin. Only legitimate when the new key was verified against a fresh invite's `k`
   * (the invite is the trust anchor); never on a plain reconnect.
   */
  replace?: boolean;
}

/**
 * Pins a verified daemon key (call it from clientConnect's onDaemonVerified). Pinning the same key again is a no-op;
 * a different key throws KeyFileError('exists') unless `replace` is set.
 */
export async function pinDaemonKey(
  stateDir: string,
  workspaceId: string,
  daemonStaticKey: Uint8Array,
  options: PinDaemonKeyOptions = {},
): Promise<void> {
  if (!(daemonStaticKey instanceof Uint8Array) || daemonStaticKey.length !== 32) throw new RangeError('daemon key must be 32 bytes');
  const path = pinPath(stateDir, workspaceId);
  await ensurePrivateDirectory(stateDir);
  await ensurePrivateDirectory(join(stateDir, DAEMON_PIN_DIR));
  const existing = await readPinnedDaemonKey(stateDir, workspaceId);
  if (existing && existing.every((b, i) => b === daemonStaticKey[i])) return;
  if (existing && !options.replace) throw new KeyFileError('exists', path, 'a different daemon key is already pinned');
  await writeKeyFile(path, daemonStaticKey, { overwrite: existing !== null });
}
