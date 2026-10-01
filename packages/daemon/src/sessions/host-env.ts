// The environment of every session (ARCHITECTURE §7.6, §11 D-15; claude-hooks.md §1.5): the host's own environment
// minus what a parent Claude Code session injects (by prefix) and minus the hook kill switches; the host's own provider
// settings stay (their choice). Every session runs like the host's own, whoever opened it.

/** Variables a parent Claude Code session injects (claude-hooks.md §1.5): scrubbed from host sessions by prefix. */
function isParentSessionVar(name: string): boolean {
  if (name === 'CLAUDECODE' || name === 'AI_AGENT' || name === 'CLAUDE_PID' || name === 'CLAUDE_EFFORT') return true;
  if (name.startsWith('CLAUDE_AGENT_SDK_') || name.startsWith('CLAUDE_PREVIEW_')) return true;
  if (name.startsWith('CLAUDE_CODE_')) return !isHostProviderVar(name);
  return false;
}

/** The host's own provider / login choices, kept for host sessions (ARCHITECTURE §7.6). */
function isHostProviderVar(name: string): boolean {
  if (name === 'CLAUDE_CODE_SAFE_MODE' || name === 'CLAUDE_CODE_SIMPLE') return false; // hook kill switches: always dropped
  return (
    name.startsWith('CLAUDE_CODE_USE_') ||
    /^CLAUDE_CODE_SKIP_[A-Z_]+_AUTH$/.test(name) ||
    name.startsWith('CLAUDE_CODE_CLIENT_') ||
    name === 'CLAUDE_CODE_OAUTH_TOKEN'
  );
}

export interface HostEnvInput {
  readonly hostEnv: Readonly<Record<string, string | undefined>>;
  /** config.sessions.hostHome: tests pass a fake home, so a host session never reads the developer's rc files. */
  readonly home: string | null;
  readonly sessionId: string;
  readonly hookEnv?: Readonly<Record<string, string>>;
}

/** The host's own environment for an unsandboxed host session. */
export function buildHostEnv(input: HostEnvInput): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(input.hostEnv)) {
    if (value === undefined || value.includes('\u0000')) continue;
    if (isParentSessionVar(name)) continue;
    // A daemon started from inside another smurg session must not pass that session's identity on.
    if (name.startsWith('SMURG_')) continue;
    env[name] = value;
  }
  if (input.home) env['HOME'] = input.home;
  env['TERM'] = 'xterm-256color';
  env['COLORTERM'] = 'truecolor';
  env['SMURG_SESSION_ID'] = input.sessionId;
  for (const [name, value] of Object.entries(input.hookEnv ?? {})) {
    if (name === 'SMURG_HOOK_SOCKET' || name === 'SMURG_SESSION_TOKEN') env[name] = value;
  }
  return env;
}
