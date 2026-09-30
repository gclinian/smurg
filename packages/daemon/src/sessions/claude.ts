// The `claude` executable a session launches (ARCHITECTURE §7.6 "Claude Code version", "Login guide"):
//  - resolved from config.sessions.claudePath or the host's PATH, then realpath'd (the guest sandbox may read exactly
//    that file, and guests exec it by that path);
//  - its `--version` is read asynchronously with an isolated, credential-free environment (never the host's or a
//    guest's configuration) and cached by file identity, then judged by claudeVersionVerdict();
//  - `claude auth status --json` decides the login state; TUI strings are hints only.
import { constants as fsConstants } from 'node:fs';
import { access, mkdtemp, realpath, rm, stat } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import type { LoginState } from '@smurg/protocol';
import type { ProcessRunner } from './process-run.ts';

export interface ClaudeBinary {
  /** realpath of the executable. */
  readonly realPath: string;
}

async function executableFile(path: string): Promise<string | null> {
  try {
    const real = await realpath(path);
    const info = await stat(real);
    if (!info.isFile()) return null;
    await access(real, fsConstants.X_OK);
    return real;
  } catch {
    return null;
  }
}

/** config.sessions.claudePath when set (it must work: no silent fallback), else the first `claude` on `pathEnv`. */
export async function resolveClaude(configured: string | null, pathEnv: string | undefined): Promise<ClaudeBinary | null> {
  if (configured !== null) {
    const real = await executableFile(configured);
    return real ? { realPath: real } : null;
  }
  for (const dir of (pathEnv ?? '').split(':')) {
    if (!isAbsolute(dir)) continue; // a relative PATH entry would resolve against the daemon's cwd
    const real = await executableFile(join(dir, 'claude'));
    if (real) return { realPath: real };
  }
  return null;
}

/** An environment that carries nothing of anyone: `--version` must not read the host's or a guest's settings. */
function isolatedEnv(dir: string): Record<string, string> {
  return {
    PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
    HOME: dir,
    CLAUDE_CONFIG_DIR: dir,
    TMPDIR: dir,
    DISABLE_AUTOUPDATER: '1',
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    LANG: 'en_US.UTF-8',
  };
}

/** `claude --version` output per executable identity (a Claude Code update replaces the file). */
export class ClaudeVersionProbe {
  private readonly cache = new Map<string, Promise<string>>();
  private readonly scratchParent: string;
  private readonly run: ProcessRunner;

  constructor(options: { readonly scratchParent: string; readonly run: ProcessRunner }) {
    this.scratchParent = options.scratchParent;
    this.run = options.run;
  }

  /** The raw stdout (claudeVersionVerdict parses it); '' when it could not run. */
  async output(binary: ClaudeBinary): Promise<string> {
    let key: string;
    try {
      const info = await stat(binary.realPath);
      key = `${binary.realPath}\u0000${info.dev}:${info.ino}:${info.size}:${info.mtimeMs}`;
    } catch {
      return '';
    }
    let pending = this.cache.get(key);
    if (!pending) {
      pending = this.probe(binary);
      this.cache.set(key, pending);
      // A failed probe is not cached: the next session tries again.
      void pending.then((out) => {
        if (out === '') this.cache.delete(key);
      });
    }
    return pending;
  }

  private async probe(binary: ClaudeBinary): Promise<string> {
    const dir = await mkdtemp(join(this.scratchParent, '.probe-'));
    try {
      const result = await this.run(binary.realPath, ['--version'], { env: isolatedEnv(dir), cwd: dir, timeoutMs: 20_000, maxStdoutBytes: 4096 });
      return result.code === 0 && !result.timedOut ? result.stdout : '';
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  }
}

/**
 * `claude auth status --json`: exit 0 with loggedIn true ⇒ a credential is present (not validated); exit 1 with
 * loggedIn false ⇒ logged out; anything else (timeout, unreadable output) ⇒ unknown (claude-hooks.md §1.6).
 */
export function parseAuthStatus(result: { readonly code: number | null; readonly stdout: string; readonly timedOut: boolean }): LoginState {
  if (result.timedOut) return 'unknown';
  const text = result.stdout.trim();
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return 'unknown';
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.slice(start, end + 1));
  } catch {
    return 'unknown';
  }
  const loggedIn = parsed !== null && typeof parsed === 'object' ? (parsed as Record<string, unknown>)['loggedIn'] : undefined;
  if (result.code === 0 && loggedIn === true) return 'logged-in';
  if (loggedIn === false) return 'logged-out';
  return 'unknown';
}

/**
 * Hints in the TUI output that the login state may have changed (claude-hooks.md §1.6, gotcha 12): matched with every
 * whitespace removed because Ink positions text with cursor moves. Version-specific; they only trigger a re-check with
 * `claude auth status --json`, they never decide the state.
 */
export const LOGIN_HINTS: readonly string[] = Object.freeze([
  'Loginsuccessful',
  'Selectloginmethod',
  'Notloggedin',
  'Pastecodehereifprompted',
  'OAutherror',
  'Loginexpired',
  'OAuthtokenrevoked',
  'Successfullyloggedout',
]);

/** Streaming detector: feeds output, reports once per hint burst. Bounded memory (keeps a short tail). */
export class LoginHintDetector {
  private tail = '';
  private readonly decoder = new TextDecoder('utf-8', { fatal: false });

  /** True when this chunk (with the tail of the previous ones) contains a hint. */
  push(chunk: Uint8Array): boolean {
    // Strip escape sequences and whitespace; keep printable text only.
    const text = this.decoder
      .decode(chunk, { stream: true })
      // eslint-disable-next-line no-control-regex
      .replace(/\x1b\[[0-9;?<>=!]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-_]/g, '')
      .replace(/\s+/g, '');
    const window = this.tail + text;
    const hit = LOGIN_HINTS.some((hint) => window.includes(hint));
    // A hint is reported once: it must not fire again for the next chunks while it is still in the tail.
    this.tail = hit ? '' : window.slice(-64);
    return hit;
  }
}
