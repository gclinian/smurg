// Every path the CLI uses derives from ONE state dir (ARCHITECTURE §7.1): `~/.smurg` by default, `$SMURG_HOME` when
// set (every test sets it to a temp dir, together with a fake HOME). Nothing here creates anything.
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { usageError } from '../cli/errors.ts';

export interface StatePaths {
  /** `~/.smurg` (0700). */
  readonly stateDir: string;
  /** Unix sockets of running daemons: `<stateDir>/run` (the daemon's default config.runDir). */
  readonly runDir: string;
  /** Relay session tokens of the CLI (0600). */
  readonly credentials: string;
  /** Shared folders → workspace ids, and workspaces joined through the relay. */
  readonly workspaces: string;
  /** Daemon logs of `smurg host` (never secrets). */
  readonly logsDir: string;
  /**
   * The empty directory `smurg host` runs its daemon from (0700): srt resolves the guest sandbox's mandatory write
   * denies against the process's working directory (ARCHITECTURE §7.6, review linux-binary F1).
   */
  readonly daemonCwd: string;
}

/** The person's home directory as the CLI sees it ($HOME first, so tests can fake it). */
export function homeDirOf(env: Readonly<Record<string, string | undefined>>): string {
  const home = env['HOME'];
  return home !== undefined && isAbsolute(home) ? home : homedir();
}

export function statePaths(env: Readonly<Record<string, string | undefined>>): StatePaths {
  const override = env['SMURG_HOME'];
  let stateDir: string;
  if (override !== undefined && override !== '') {
    // Fail closed: a relative SMURG_HOME would put keys wherever the command happens to run.
    if (!isAbsolute(override)) throw usageError('SMURG_HOME 必須是絕對路徑');
    stateDir = resolve(override);
  } else {
    stateDir = join(homeDirOf(env), '.smurg');
  }
  return {
    stateDir,
    runDir: join(stateDir, 'run'),
    credentials: join(stateDir, 'credentials.json'),
    workspaces: join(stateDir, 'workspaces.json'),
    logsDir: join(stateDir, 'logs'),
    daemonCwd: join(stateDir, 'cwd'),
  };
}

/** The daemon log of `smurg host` for one workspace: `<stateDir>/logs/<workspaceId>.log` (shown by `smurg status`). */
export function hostLogPath(paths: StatePaths, workspaceId: string): string {
  return join(paths.logsDir, `${workspaceId}.log`);
}
