// The one place the daemon runs git (ARCHITECTURE §5.7, §0 rule 5). Every call:
//  - execFile with an argument array (never a shell string), asynchronous, bounded output, a deadline and the
//    daemon's stop signal (Node stops only the child it spawned itself when a bound is hit: §0 rule 1);
//  - an explicit --git-dir / --work-tree: git never DISCOVERS a repository. A worktree lives inside the share, so a
//    worktree whose .git went missing would otherwise be served by the MAIN repository;
//  - a fixed minimal environment: no global or system config (the host's ~/.gitconfig, credential helpers, aliases,
//    Xcode's system config), no terminal prompt, only the local `file` transport, C locale for parseable output;
//  - command-line overrides that no repository config can win against: hooks off (core.hooksPath=/dev/null, the
//    worktree's content is guest-controlled), no fsmonitor, no signing, no automatic gc that would leave a detached
//    process behind, no pager, literal pathspecs.
// Repository config itself (a worktree's .git/config) is verified by the caller before a worktree command runs
// (integrity.ts): -c overrides cannot neutralise filter/diff/merge drivers whose names only that file knows.
import { execFile } from 'node:child_process';
import { constants as fsConstants } from 'node:fs';
import { access, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, dirname, isAbsolute, join } from 'node:path';
import { SmurgError } from '@smurg/protocol';
import { msg, type GitStep, type MessageRef } from '@smurg/protocol/i18n';

/** Oldest git the worktree mode accepts: `merge-tree --write-tree` (2.38) and the `--attr-source` option (2.42). */
export const GIT_MIN_VERSION: readonly [number, number, number] = Object.freeze([2, 42, 0]);

/** Overrides of repository config for every daemon git command (command-line config beats every file). */
export const GIT_HARDENING: readonly string[] = Object.freeze([
  'core.hooksPath=/dev/null',
  'core.fsmonitor=false',
  'core.pager=cat',
  'core.quotePath=false',
  'core.attributesFile=/dev/null',
  'core.excludesFile=/dev/null',
  'credential.helper=',
  'commit.gpgSign=false',
  'tag.gpgSign=false',
  'gc.auto=0',
  'gc.autoDetach=false',
  'maintenance.auto=false',
  'fetch.writeCommitGraph=false',
  'fetch.recurseSubmodules=false',
  'submodule.recurse=false',
  'protocol.allow=never',
  'protocol.file.allow=always',
  'advice.detachedHead=false',
  'init.defaultBranch=main',
]);

export interface GitIdentity {
  readonly name: string;
  readonly email: string;
}

export interface GitRunOptions {
  /** Absolute path of the git directory (never discovered). */
  readonly gitDir: string;
  /** Absolute path of the working tree; omitted for commands that must not touch one. */
  readonly workTree?: string;
  readonly args: readonly string[];
  /** stdout beyond this is cut (`truncated`); default 4 MiB. */
  readonly maxStdoutBytes?: number;
  /** Default 60 s. */
  readonly timeoutMs?: number;
  /** Author and committer of commits this command writes. */
  readonly identity?: GitIdentity;
  /** Read .gitattributes from this tree-ish instead of the working tree (a trusted commit of the main workspace). */
  readonly attrSource?: string;
  /** Written to stdin (then closed). */
  readonly input?: string | Uint8Array;
  /** Read-only commands: do not take optional locks (index refresh) in a repository someone else uses. */
  readonly readOnly?: boolean;
  /**
   * Stop the command when the daemon stops (default true). Commands that write the MAIN repository (fetch into it,
   * merge) pass false: killed half-way they would leave lock files or a half-done merge in the host's repository;
   * they are bounded by their deadline instead.
   */
  readonly abortable?: boolean;
  /**
   * Write objects and the index somewhere else than the repository (GIT_OBJECT_DIRECTORY, GIT_INDEX_FILE), still
   * reading existing objects from `alternates` (GIT_ALTERNATE_OBJECT_DIRECTORIES): the merge-request commit is staged
   * in a daemon-private store and published only after it was verified (stage-commit.ts).
   */
  readonly store?: GitObjectStore;
}

export interface GitObjectStore {
  /** Absolute path of the object directory new objects are written to. */
  readonly objectDir: string;
  /** Absolute paths of object directories to read from as well (their own alternates are followed). */
  readonly alternates: readonly string[];
  /** Absolute path of the index file. */
  readonly indexFile: string;
}

/** A path list entry of GIT_ALTERNATE_OBJECT_DIRECTORIES, C-quoted (a path may contain the ':' separator). */
function quoteAlternate(path: string): string {
  if (!isAbsolute(path) || /[\u0000-\u001f\u007f]/.test(path)) throw new TypeError('alternate object directories must be plain absolute paths');
  return `"${path.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

export interface GitResult {
  /** Exit code; -1 when the output bound was hit (the process was stopped). */
  readonly code: number;
  readonly stdout: Buffer;
  readonly stderr: string;
  readonly truncated: boolean;
}

export class GitUnavailableError extends SmurgError {
  constructor(reason: 'git-not-found' | 'git-too-old' | 'git-unusable', message: MessageRef) {
    super('conflict', message, { reason });
    this.name = 'GitUnavailableError';
  }
}

const STDERR_KEEP = 16 * 1024;
const DEFAULT_MAX_STDOUT = 4 * 1024 * 1024;

/** Finds an executable `git` in `PATH` (asynchronously: no execSync in the daemon). */
export async function findGit(pathValue: string | undefined): Promise<string | null> {
  for (const dir of (pathValue ?? '').split(delimiter)) {
    if (!dir || !isAbsolute(dir)) continue;
    const candidate = join(dir, 'git');
    try {
      await access(candidate, fsConstants.X_OK);
      if ((await stat(candidate)).isFile()) return candidate;
    } catch {
      // not here
    }
  }
  return null;
}

/** `git version 2.49.0` / `git version 2.50.1 (Apple Git-155)` → [2, 49, 0]; null when unreadable. */
export function parseGitVersion(output: string): [number, number, number] | null {
  const match = /^git version (\d{1,4})\.(\d{1,4})(?:\.(\d{1,6}))?/.exec(output.trim());
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3] ?? '0')];
}

export function gitVersionAtLeast(version: readonly [number, number, number], minimum: readonly [number, number, number]): boolean {
  for (let i = 0; i < 3; i++) {
    const a = version[i] as number;
    const b = minimum[i] as number;
    if (a !== b) return a > b;
  }
  return true;
}

export interface GitRunnerOptions {
  readonly gitPath: string;
  /** Private, empty HOME for git (nothing of the host's home is ever read). */
  readonly home: string;
  /** Aborted when the daemon stops: running git commands are stopped. */
  readonly signal?: AbortSignal;
}

/** Runs git for the worktree module. Stateless apart from its fixed environment. */
export class GitRunner {
  readonly gitPath: string;
  private readonly baseEnv: Readonly<Record<string, string>>;
  private readonly signal: AbortSignal | undefined;

  constructor(options: GitRunnerOptions) {
    if (!isAbsolute(options.gitPath)) throw new TypeError('gitPath must be absolute');
    this.gitPath = options.gitPath;
    this.signal = options.signal;
    this.baseEnv = Object.freeze({
      PATH: [dirname(options.gitPath), '/usr/bin', '/bin'].join(':'),
      HOME: options.home,
      TMPDIR: tmpdir(),
      LANG: 'C',
      LC_ALL: 'C',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_TERMINAL_PROMPT: '0',
      GIT_ASKPASS: '',
      SSH_ASKPASS: '',
      GIT_ALLOW_PROTOCOL: 'file',
      GIT_PROTOCOL_FROM_USER: '0',
      GIT_ATTR_NOSYSTEM: '1',
      GIT_NO_REPLACE_OBJECTS: '1',
      GIT_LITERAL_PATHSPECS: '1',
      GIT_PAGER: 'cat',
      PAGER: 'cat',
      GIT_EDITOR: 'false',
      GIT_MERGE_AUTOEDIT: 'no',
      GIT_AUTHOR_NAME: 'smurg',
      GIT_AUTHOR_EMAIL: 'daemon@smurg.invalid',
      GIT_COMMITTER_NAME: 'smurg',
      GIT_COMMITTER_EMAIL: 'daemon@smurg.invalid',
    });
  }

  /** `git version` output (no repository involved). */
  async version(): Promise<[number, number, number] | null> {
    const result = await this.exec(['version'], { cwd: this.baseEnv['HOME'] as string, env: this.baseEnv, maxStdoutBytes: 4096, timeoutMs: 15_000 });
    return result.code === 0 ? parseGitVersion(result.stdout.toString('utf8')) : null;
  }

  /**
   * `git clone --shared --no-checkout` (ARCHITECTURE §5.7, §11 D-2): the only command that runs without --git-dir,
   * because it creates the repository. `template` is an empty daemon-owned directory: no sample hooks, no template
   * config. The clone's objects stay in the source through alternates (read-only for guests).
   */
  clone(options: { readonly source: string; readonly dest: string; readonly cwd: string; readonly template: string; readonly timeoutMs?: number }): Promise<GitResult> {
    for (const path of [options.source, options.dest, options.cwd, options.template]) if (!isAbsolute(path)) throw new TypeError('clone paths must be absolute');
    const args: string[] = [];
    for (const setting of GIT_HARDENING) args.push('-c', setting);
    args.push('--no-pager', 'clone', '--quiet', '--shared', '--no-checkout', `--template=${options.template}`, '--', options.source, options.dest);
    return this.exec(args, { cwd: options.cwd, env: this.baseEnv, maxStdoutBytes: 64 * 1024, timeoutMs: options.timeoutMs ?? 120_000 });
  }

  /** Runs one git command; never throws for a non-zero exit (see `code`), throws for spawn failures and deadlines. */
  run(options: GitRunOptions): Promise<GitResult> {
    const args: string[] = [];
    for (const setting of GIT_HARDENING) args.push('-c', setting);
    if (options.attrSource !== undefined) {
      if (!/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(options.attrSource)) throw new TypeError('attrSource must be an object id');
      args.push(`--attr-source=${options.attrSource}`);
    }
    args.push('--no-pager', `--git-dir=${options.gitDir}`);
    if (options.workTree !== undefined) args.push(`--work-tree=${options.workTree}`);
    args.push(...options.args);
    const env: Record<string, string> = { ...this.baseEnv };
    if (options.readOnly) env['GIT_OPTIONAL_LOCKS'] = '0';
    if (options.store) {
      for (const path of [options.store.objectDir, options.store.indexFile]) if (!isAbsolute(path)) throw new TypeError('object store paths must be absolute');
      env['GIT_OBJECT_DIRECTORY'] = options.store.objectDir;
      env['GIT_INDEX_FILE'] = options.store.indexFile;
      if (options.store.alternates.length > 0) env['GIT_ALTERNATE_OBJECT_DIRECTORIES'] = options.store.alternates.map(quoteAlternate).join(':');
    }
    if (options.identity) {
      env['GIT_AUTHOR_NAME'] = options.identity.name;
      env['GIT_AUTHOR_EMAIL'] = options.identity.email;
      env['GIT_COMMITTER_NAME'] = options.identity.name;
      env['GIT_COMMITTER_EMAIL'] = options.identity.email;
    }
    return this.exec(args, {
      cwd: options.workTree ?? options.gitDir,
      env,
      maxStdoutBytes: options.maxStdoutBytes ?? DEFAULT_MAX_STDOUT,
      timeoutMs: options.timeoutMs ?? 60_000,
      abortable: options.abortable ?? true,
      ...(options.input !== undefined ? { input: options.input } : {}),
    });
  }

  private exec(
    args: readonly string[],
    options: {
      readonly cwd: string;
      readonly env: Readonly<Record<string, string>>;
      readonly maxStdoutBytes: number;
      readonly timeoutMs: number;
      readonly abortable?: boolean;
      readonly input?: string | Uint8Array;
    },
  ): Promise<GitResult> {
    const signal = options.abortable === false ? undefined : this.signal;
    return new Promise((resolve, reject) => {
      if (signal?.aborted) {
        reject(new SmurgError('conflict', msg('daemon.stopping'), { reason: 'stopping' }));
        return;
      }
      const child = execFile(
        this.gitPath,
        [...args],
        {
          cwd: options.cwd,
          env: options.env,
          encoding: 'buffer',
          // One bound for both streams: stdout is the payload, stderr is kept short below.
          maxBuffer: Math.max(options.maxStdoutBytes, STDERR_KEEP),
          timeout: options.timeoutMs,
          killSignal: 'SIGKILL',
          windowsHide: true,
          ...(signal ? { signal } : {}),
        },
        (error, stdout, stderr) => {
          const out = Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout ?? '');
          const errText = (Buffer.isBuffer(stderr) ? stderr : Buffer.from(stderr ?? '')).subarray(0, STDERR_KEEP).toString('utf8');
          if (!error) {
            resolve({ code: 0, stdout: out, stderr: errText, truncated: false });
            return;
          }
          const code = (error as NodeJS.ErrnoException & { code?: unknown }).code;
          if (code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
            // Node stopped its own child: the output is complete up to the bound, the exit status is unknown.
            resolve({ code: -1, stdout: out.subarray(0, options.maxStdoutBytes), stderr: errText, truncated: true });
            return;
          }
          if (typeof code === 'number') {
            resolve({ code, stdout: out, stderr: errText, truncated: false });
            return;
          }
          if (code === 'ENOENT') {
            // The executable went, or the folder the command runs in did (a `.git` removed while sharing): only the
            // first is "git was not found" (whose words tell the host to install git and share again).
            void access(this.gitPath, fsConstants.X_OK).then(
              () => reject(new SmurgError('internal', msg('git.failed'), { reason: 'git-failed' }, { cause: error })),
              () => reject(new GitUnavailableError('git-not-found', msg('worktree.unavailable.gitNotFound', { minVersion: GIT_MIN_VERSION.join('.') }))),
            );
            return;
          }
          if (code === 'ABORT_ERR' || signal?.aborted) {
            reject(new SmurgError('conflict', msg('daemon.stopping'), { reason: 'stopping' }));
            return;
          }
          if ((error as { killed?: boolean }).killed) {
            reject(new SmurgError('internal', msg('git.timeout'), { reason: 'git-timeout' }));
            return;
          }
          reject(new SmurgError('internal', msg('git.failed'), { reason: 'git-failed' }, { cause: error }));
        },
      );
      if (options.input !== undefined) child.stdin?.end(options.input);
      else child.stdin?.end();
    });
  }
}

/** Throws unless the command succeeded with complete output. */
export function requireOk(result: GitResult, step: GitStep): GitResult {
  if (result.truncated) throw new SmurgError('too_large', msg('git.outputTooLarge', { step }), { reason: 'git-output-too-large', step });
  if (result.code !== 0) throw new SmurgError('internal', msg('git.stepFailed', { step }), { reason: 'git-failed', step });
  return result;
}

/** Paths as a message list parameter: at most 10, each at most 200 characters (the full sample is in `detail.paths`). */
export function listedPaths(paths: readonly string[]): string[] {
  return paths.slice(0, 10).map((path) => (path.length > 200 ? `${path.slice(0, 199)}\u2026` : path));
}

/** The first line of stdout (object ids, ref names). */
export function firstLine(result: GitResult): string {
  return result.stdout.toString('utf8').split('\n', 1)[0]?.trim() ?? '';
}
