// The one line `smurg host` adds under its two links when a newer version is published (owner decision 2026-10-02):
//
//   有新版本 0.3.0（目前 0.2.0）：停止分享後執行 smurg update
//
// It is looked up in the background after the links are printed and never delays or breaks the start: one request for
// <downloads>/latest/VERSION with a short timeout, and NOTHING is said when it fails, when this is the newest version,
// or when the check does not run at all: SMURG_NO_UPDATE_CHECK is set, an automated run (CI, or no terminal: the rule
// of cli/io.ts browserBlock), or smurg runs from source (there `smurg update` could not do what the line says).
import { flagOn, type CliIo } from '../cli/io.ts';
import { seaExecutable } from '../sea/native.ts';
import { CLI_VERSION } from '../version.ts';
import { downloadsBase, latestVersion, withTimeout, type FetchLike } from './downloads.ts';
import { compareVersions, parseVersion } from './versions.ts';

/** How long `smurg host` waits for latest/VERSION before it gives up silently. */
export const UPDATE_NOTICE_TIMEOUT_MS = 2_000;

/** Test seams (the real ones: this executable, its version, the runtime's fetch). */
export interface UpdateNoticeDeps {
  /** The single executable this process is; null: running from source. Default: seaExecutable(). */
  readonly executable?: string | null;
  /** This executable's version. Default: CLI_VERSION. */
  readonly version?: string;
  readonly fetch?: FetchLike;
  readonly timeoutMs?: number;
}

/** Why `smurg host` does not look for a newer version here; null when it does. */
export function updateCheckBlock(io: CliIo, deps: UpdateNoticeDeps = {}): 'disabled' | 'ci' | 'not-a-terminal' | 'from-source' | null {
  if (flagOn(io.env['SMURG_NO_UPDATE_CHECK'])) return 'disabled';
  if (flagOn(io.env['CI'])) return 'ci';
  if (!io.terminal.isTTY) return 'not-a-terminal';
  if ((deps.executable === undefined ? seaExecutable() : deps.executable) === null) return 'from-source';
  return null;
}

export function updateNoticeText(latest: string, current: string): string {
  return `有新版本 ${latest}（目前 ${current}）：停止分享後執行 smurg update`;
}

/**
 * The notice line, or null (nothing to say, for any reason). Never rejects; ends within the timeout, or as soon as
 * `signal` aborts (the host is stopping).
 */
export async function updateNotice(io: CliIo, signal: AbortSignal, deps: UpdateNoticeDeps = {}): Promise<string | null> {
  try {
    if (updateCheckBlock(io, deps) !== null) return null;
    const current = deps.version ?? CLI_VERSION;
    const have = parseVersion(current);
    if (have === null) return null;
    const latest = await latestVersion(downloadsBase(io.env), {
      signal: withTimeout(signal, deps.timeoutMs ?? UPDATE_NOTICE_TIMEOUT_MS),
      ...(deps.fetch ? { fetch: deps.fetch } : {}),
    });
    const published = parseVersion(latest);
    return published !== null && compareVersions(published, have) > 0 ? updateNoticeText(latest, current) : null;
  } catch {
    return null;
  }
}
