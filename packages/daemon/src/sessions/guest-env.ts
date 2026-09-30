// Session environments (ARCHITECTURE §7.6; claude-hooks.md §1.4, §1.5, §4).
//
// Guest (sandboxed) sessions: built from an ALLOW-LIST, never inherited, then asserted against the deny patterns
// (credentials, provider switches, endpoints, proxies, loader hooks, agent sockets). The only exceptions are the
// variables smurg itself sets and, when the guest supplied one, their own ANTHROPIC_API_KEY.
// Host sessions: the host's own environment minus what a parent Claude Code session injects (by prefix) and minus the
// hook kill switches; the host's own provider settings stay (their choice).
import { dirname } from 'node:path';

/** Guest environment variables smurg sets that a deny pattern would otherwise catch. */
export const SMURG_OWNED_GUEST_VARS: ReadonlySet<string> = new Set([
  'CLAUDE_CONFIG_DIR',
  'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC',
  'CLAUDE_CODE_DISABLE_OFFICIAL_MARKETPLACE_AUTOINSTALL',
  'SMURG_SESSION_TOKEN',
]);

/**
 * Names that must never reach a guest (claude-hooks.md §4). Anything matching is refused even if a future edit of the
 * allow-list lets it through: the assertion is the second, independent layer.
 */
export const GUEST_DENY_PATTERNS: readonly RegExp[] = Object.freeze([
  /^ANTHROPIC_/,
  /^CLAUDE/,
  /^AI_AGENT$/,
  /^AWS_/,
  /^AZURE_/,
  /^GOOGLE_/,
  /^GCLOUD_/,
  /^CLOUDSDK_/,
  /^CLOUD_ML_/,
  /^VERTEX_/,
  /^MCP_/,
  /^OTEL_/,
  /^(ENABLE_BETA_TRACING_DETAILED|BETA_TRACING_ENDPOINT)$/,
  /^(HTTP|HTTPS|ALL|NO|FTP)_PROXY$/i,
  /^NODE_(OPTIONS|EXTRA_CA_CERTS|TLS_REJECT_UNAUTHORIZED|PATH)$/,
  /^SSL_CERT_(FILE|DIR)$/,
  /^REQUESTS_CA_BUNDLE$/,
  /^BUN_/,
  /^DYLD_/,
  /^LD_(PRELOAD|LIBRARY_PATH|AUDIT)$/,
  /^SSH_AUTH_SOCK$/,
  /^SSH_AGENT_PID$/,
  /^GPG_AGENT_INFO$/,
  /^GIT_(ASKPASS|SSH|SSH_COMMAND|CONFIG.*|EXEC_PATH)$/,
  /(^|_)(TOKEN|SECRET|SECRETS|PASSWORD|PASSWD|API_KEY|APIKEY|ACCESS_KEY|PRIVATE_KEY|CREDENTIALS?)(_|$)/,
  /^XDG_/,
  /^(ZDOTDIR|BASH_ENV|ENV|PROMPT_COMMAND|PERL5OPT|PYTHONSTARTUP|PYTHONPATH|RUBYOPT)$/,
  /^KUBECONFIG$/,
  /^DOCKER_(HOST|CONFIG|CERT_PATH|TLS_VERIFY)$/,
  /^SMURG_(?!SESSION_ID$|SESSION_TOKEN$|HOOK_SOCKET$)/,
]);

/** Exact names that switch Claude Code's login, provider or endpoint (all covered by the patterns; listed for tests). */
export const LOGIN_OVERRIDE_VARS: readonly string[] = Object.freeze([
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_CUSTOM_HEADERS',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'CLAUDE_CODE_OAUTH_REFRESH_TOKEN',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CODE_USE_FOUNDRY',
  'CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR',
  'CLAUDE_SECURESTORAGE_CONFIG_DIR',
  'AWS_BEARER_TOKEN_BEDROCK',
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
  'GOOGLE_APPLICATION_CREDENTIALS',
]);

export function isDeniedGuestVar(name: string): boolean {
  return GUEST_DENY_PATTERNS.some((pattern) => pattern.test(name));
}

export interface GuestEnvInput {
  /** `<guest>/home`, `<guest>/cfg`, `<guest>/tmp`. */
  readonly home: string;
  readonly configDir: string;
  readonly tmpDir: string;
  /** The host's environment: ONLY USER, LOGNAME, LANG, LC_ALL, LC_CTYPE, TZ are read from it. */
  readonly hostEnv: Readonly<Record<string, string | undefined>>;
  /** Directory of the resolved claude binary (first on PATH), when known. */
  readonly claudeDir: string | null;
  /** The shell guests get (SHELL). */
  readonly shell: string;
  /** A no-op executable: Claude must never open the login URL in the host's browser (claude-hooks.md §1.6). */
  readonly browser: string;
  readonly sessionId: string;
  /** SMURG_HOOK_SOCKET / SMURG_SESSION_TOKEN / SMURG_SESSION_ID from the hooks module (agent sessions). */
  readonly hookEnv?: Readonly<Record<string, string>>;
}

const SYSTEM_PATH = ['/usr/bin', '/bin', '/usr/sbin', '/sbin'];
const LOCALE = /^[A-Za-z0-9_.@-]{1,64}$/;
const TZ_VALUE = /^[A-Za-z0-9_+\-:/]{1,64}$/;
const USER_NAME = /^[A-Za-z0-9._-]{1,64}$/;

export class GuestEnvError extends Error {
  readonly names: readonly string[];

  constructor(names: readonly string[]) {
    super(`guest environment contains forbidden variables: ${names.join(', ')}`);
    this.name = 'GuestEnvError';
    this.names = names;
  }
}

/** The guest's environment from the allow-list (ARCHITECTURE §7.6), asserted before it is returned. */
export function buildGuestEnv(input: GuestEnvInput): Record<string, string> {
  const user = input.hostEnv['USER'];
  const env: Record<string, string> = {
    PATH: [...(input.claudeDir ? [input.claudeDir] : []), ...SYSTEM_PATH].join(':'),
    HOME: input.home,
    CLAUDE_CONFIG_DIR: input.configDir,
    TMPDIR: input.tmpDir,
    SHELL: input.shell,
    TERM: 'xterm-256color',
    COLORTERM: 'truecolor',
    LANG: input.hostEnv['LANG'] && LOCALE.test(input.hostEnv['LANG']) ? input.hostEnv['LANG'] : 'en_US.UTF-8',
    BROWSER: input.browser,
    DISABLE_AUTOUPDATER: '1',
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    CLAUDE_CODE_DISABLE_OFFICIAL_MARKETPLACE_AUTOINSTALL: '1',
    SMURG_SESSION_ID: input.sessionId,
  };
  if (user && USER_NAME.test(user)) {
    env['USER'] = user;
    env['LOGNAME'] = user;
  }
  for (const name of ['LC_ALL', 'LC_CTYPE'] as const) {
    const value = input.hostEnv[name];
    if (value && LOCALE.test(value)) env[name] = value;
  }
  const tz = input.hostEnv['TZ'];
  if (tz && TZ_VALUE.test(tz)) env['TZ'] = tz;
  for (const [name, value] of Object.entries(input.hookEnv ?? {})) {
    if (name === 'SMURG_HOOK_SOCKET' || name === 'SMURG_SESSION_TOKEN') env[name] = value;
  }
  assertGuestEnv(env, { apiKeyAllowed: false });
  return env;
}

/**
 * Throws GuestEnvError when any variable matches a deny pattern, except the smurg-owned ones and (when the guest
 * supplied it in session.create) ANTHROPIC_API_KEY. Runs on every guest environment right before it is used.
 */
export function assertGuestEnv(env: Readonly<Record<string, string>>, options: { readonly apiKeyAllowed: boolean }): void {
  const bad = Object.keys(env).filter((name) => {
    if (SMURG_OWNED_GUEST_VARS.has(name)) return false;
    if (options.apiKeyAllowed && name === 'ANTHROPIC_API_KEY') return false;
    return isDeniedGuestVar(name) || LOGIN_OVERRIDE_VARS.includes(name);
  });
  if (bad.length > 0) throw new GuestEnvError(bad);
}

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

/** Test seam (config.sessions.testGuestEnv, local relays only): added after the assertion, never over smurg's names. */
export function withTestGuestEnv(env: Record<string, string>, extra: Readonly<Record<string, string>> | null): Record<string, string> {
  if (!extra) return env;
  for (const [name, value] of Object.entries(extra)) {
    if (name in env || name.startsWith('SMURG_')) continue;
    env[name] = value;
  }
  return env;
}

/** PATH entry for the claude binary: the directory of its realpath (the sandbox allows reading only that file). */
export function claudeDirOf(claudeRealPath: string | null): string | null {
  return claudeRealPath ? dirname(claudeRealPath) : null;
}
