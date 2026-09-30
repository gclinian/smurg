// The SandboxSpec of one guest process (core/interfaces.ts SandboxSpec; ARCHITECTURE §7.6 "Sandbox (guests)"). The
// sandbox module turns it into srt's policy (broad deny regions + carve-outs); this file decides the session-specific
// paths: what the session may read and write, and what it must never touch, in main-workspace and worktree mode.
import { join } from 'node:path';
import type { SandboxSpec, SharedLink } from '../core/interfaces.ts';

/** The host-only names of ARCHITECTURE §5.2 at the top of a root: the host's unsandboxed tools run what is in them. */
const HOST_ONLY_TOP_LEVEL = ['.claude', '.mcp.json', '.git', '.envrc', '.vscode', '.idea'] as const;

export interface SandboxSpecInput {
  readonly sessionId: string;
  readonly command: string;
  /** realpath of the session root (the main share, or the worktree). */
  readonly rootPath: string;
  /** realpath of the main share. */
  readonly shareRealPath: string;
  /** Worktree mode: the registry's worktrees dir and the worktree's shared read-only links. */
  readonly worktree: { readonly worktreesDir: string; readonly sharedLinks: readonly SharedLink[] } | null;
  readonly guestDir: string;
  readonly settingsDir: string;
  readonly claudeRealPath: string | null;
  /** config.runPaths.hook (the sandbox refuses any other socket). */
  readonly hookSocketPath: string;
  readonly env: Readonly<Record<string, string>>;
}

function unique(paths: readonly string[]): string[] {
  return [...new Set(paths)];
}

export function buildSandboxSpec(input: SandboxSpecInput): SandboxSpec {
  const share = input.shareRealPath;
  const root = input.rootPath;
  // The claude binary (guests exec it by its realpath). `smurg hook` / `smurg mcp` (config.sessions.selfCommand) are
  // the sandbox module's to carve out: it knows the dev layout (node + the workspace's packages) and the SEA one.
  const extraRead: string[] = [];
  if (input.claudeRealPath) extraRead.push(input.claudeRealPath);
  const hostOnlyInRoot = HOST_ONLY_TOP_LEVEL.map((name) => join(root, name));
  if (input.worktree === null) {
    const hidden = join(share, '.smurg'); // other sessions' worktrees, partial uploads
    return {
      sessionId: input.sessionId,
      command: input.command,
      rootPath: root,
      guestDir: input.guestDir,
      settingsDir: input.settingsDir,
      readOnlyPaths: [],
      extraReadPaths: unique(extraRead),
      // The host's personal project files (claude-hooks / sandbox.md: may hold env secrets or hook commands).
      denyReadPaths: unique([hidden, join(share, '.claude', 'settings.local.json'), join(share, 'CLAUDE.local.md')]),
      denyWritePaths: unique([hidden, ...hostOnlyInRoot]),
      hookSocketPath: input.hookSocketPath,
      env: input.env,
    };
  }
  // Worktree mode (R9.1): the main share and every sibling worktree are denied explicitly, wherever the share lives.
  // The shared clone's objects (<share>/.git/objects, read-only) are the sandbox module's structural carve-out: it
  // refuses any other read carve-out inside the share in this mode.
  const links = input.worktree.sharedLinks;
  return {
    sessionId: input.sessionId,
    command: input.command,
    rootPath: root,
    guestDir: input.guestDir,
    settingsDir: input.settingsDir,
    readOnlyPaths: unique(links.map((link) => link.targetRealPath)),
    extraReadPaths: unique(extraRead),
    denyReadPaths: unique([share, input.worktree.worktreesDir]),
    denyWritePaths: unique([share, input.worktree.worktreesDir, ...hostOnlyInRoot, ...links.map((link) => join(root, link.path))]),
    hookSocketPath: input.hookSocketPath,
    env: input.env,
  };
}

/** POSIX shell single-quoting. */
export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

/**
 * The command a guest process runs inside the sandbox. srt forces its own TMPDIR (/tmp/claude, shared by every guest):
 * the inner export puts the guest's own back (sandbox.md gotcha 5).
 */
export function guestCommand(tmpDir: string, file: string, args: readonly string[]): string {
  return `export TMPDIR=${shellQuote(tmpDir)}; exec ${[file, ...args].map(shellQuote).join(' ')}`;
}
