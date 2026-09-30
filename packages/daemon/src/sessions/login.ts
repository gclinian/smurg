// A guest's Claude subscription login (ARCHITECTURE §11 D-12; implemented 2026-09-29 as recommended by the project
// lead, switchable with config.sessions.guestSubscriptionLogin; the owner's confirmation of the default is pending).
//
// The guest sandbox forbids listening on any port, so Claude Code's subscription login ("Failed to start OAuth
// callback server") cannot run inside a guest's agent session. Instead the daemon itself starts ONE dedicated process
// per guest, a session of kind 'login':
//   * the fixed command `<claude> --setting-sources project --settings <inline> auth login --claudeai` (verified on
//     2.1.220 and 2.1.283): nothing about it comes from the client, not an argument, not a variable, not a directory;
//   * in the guest's own sandbox (same guest dir as HOME / CLAUDE_CONFIG_DIR, same environment allow-list, BROWSER a
//     no-op, the hardened profile, so the credential lands in <guest>/cfg/.credentials.json and never in the host's
//     keychain), in mode 'login': the guest dir only, nothing of the share; its ONE extra right is to listen on the
//     loopback interface (bind + accept, never connect: sandbox/harden.ts LOOPBACK_LISTEN_LINES);
//   * with the guest's own settings switched off (`--setting-sources project`, run from a daemon-owned empty directory):
//     `claude auth login` applies the user settings' `env` block and then RUNS $BROWSER (verified on both versions: a
//     planted `env.BROWSER` script ran), so a guest could otherwise run their own program with the login's extra
//     right. The inline `--settings` pins BROWSER to the no-op as well (flag settings win over every other source);
//   * on macOS with an exec allow-list: Seatbelt cannot narrow a listen to the loopback interface ("localhost" matches
//     every local address, measured), so nothing but claude, the no-op BROWSER and /usr/bin/security may be started
//     in it (sandbox/harden.ts execAllowLines). On Linux srt's own network namespace keeps the listener off the host.
import { shellQuote } from './sandbox-spec.ts';
import type { SandboxSpec } from '../core/interfaces.ts';

/** The login process ends when its command exits, or after this. */
export const LOGIN_MAX_MS = 10 * 60_000;
/** An ended login's final screen is kept this long for its owner (then the mirror, which showed the URL, goes). */
export const LOGIN_EXITED_RETENTION_MS = 60_000;

/** The inline `--settings` of the login process: no hooks, BROWSER pinned to the no-op. */
export function loginInlineSettings(browser: string): string {
  return JSON.stringify({ disableAllHooks: true, env: { BROWSER: browser } });
}

/** The arguments of `claude` for the login process: fixed, except the no-op browser the daemon picked. */
export function loginClaudeArgs(browser: string): string[] {
  return ['--setting-sources', 'project', '--settings', loginInlineSettings(browser), 'auth', 'login', '--claudeai'];
}

/**
 * The shell command of the login process inside the sandbox: the guest's TMPDIR, a daemon-owned directory as the
 * working directory (it holds no `.claude/`, and the guest cannot write it), then exec claude.
 */
export function loginCommand(input: { readonly tmpDir: string; readonly cwd: string; readonly claude: string; readonly browser: string }): string {
  const exec = [input.claude, ...loginClaudeArgs(input.browser)].map(shellQuote).join(' ');
  return `export TMPDIR=${shellQuote(input.tmpDir)}; cd ${shellQuote(input.cwd)} || exit 97; exec ${exec}`;
}

/**
 * What the sandbox gets for the login process: the guest's home as root (inside the guest dir), the daemon-owned
 * directory (read-only), the claude binary, and `loginProcess: true` (sandbox/service.ts LoginSandboxSpec: mode
 * 'login'). No hook token, no shared dirs, no deny list of the share: mode 'login' denies all of it.
 */
export interface LoginSpecInput {
  readonly sessionId: string;
  readonly command: string;
  readonly guestDir: string;
  readonly guestHome: string;
  readonly settingsDir: string;
  readonly claudeRealPath: string;
  readonly hookSocketPath: string;
  readonly env: Readonly<Record<string, string>>;
  /** The programs the login may start besides the sandbox's shell (macOS exec allow-list): claude, BROWSER, security. */
  readonly programs: readonly string[];
}

export function buildLoginSandboxSpec(input: LoginSpecInput): SandboxSpec & { readonly loginProcess: true; readonly loginPrograms: readonly string[] } {
  return {
    sessionId: input.sessionId,
    command: input.command,
    rootPath: input.guestHome,
    guestDir: input.guestDir,
    settingsDir: input.settingsDir,
    readOnlyPaths: [],
    extraReadPaths: [input.claudeRealPath],
    denyWritePaths: [],
    denyReadPaths: [],
    hookSocketPath: input.hookSocketPath,
    env: input.env,
    loginProcess: true,
    loginPrograms: input.programs,
  };
}

/** zh-TW texts of the login's refusals (sent to the client). */
export const LOGIN_MESSAGES = Object.freeze({
  switchedOff: '這個工作區的主人沒有開放 Claude 訂閱登入：客人請在建立 agent session 時使用自己的 API key 登入（建議設定花費上限）。',
  guestsOnly: '主人的 Claude 不在沙盒裡，不需要這個登入程序：請直接在自己的終端機執行 claude auth login。',
  mainOnly: '登入程序不屬於任何工作區或 worktree，請不要指定 worktree。',
  noApiKey: '登入程序不使用 API key；要用 API key 的話，請在建立 agent session 時提供。',
  running: '你已經有一個 Claude 登入程序在進行中，請先完成或結束它。',
});
