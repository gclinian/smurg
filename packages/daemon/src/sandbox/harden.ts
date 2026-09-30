// Post-processing of the command string srt generates (ARCHITECTURE §7.6 "macOS profile hardening"). srt 0.0.77 has
// no switch for what is changed here, so the generated TEXT is rewritten, and every rewrite is pinned: if the
// expected text is not found exactly, the result is a HardeningError and no guest process starts (fail closed).
// srt is pinned to SRT_PINNED_VERSION; test/sandbox/harden.test.ts runs these functions against srt's real output.
//
// macOS (docs/research/sandbox.md §3, pty-packaging.md V9):
//  1. strip the `com.apple.securityd.xpc` / `com.apple.SecurityServer` mach-lookups: with them a guest can enumerate
//     the host's login keychain (71 items → 0 after the strip);
//  2. replace srt's pty rule, which opens EVERY /dev/ttys* of the host user for reading and writing (a guest read what
//     the host typed in another terminal), by one that allows only the session's own tty, passed to sandbox-exec as
//     the parameter SMURG_TTY by the outer shell (`$(/usr/bin/tty)`; without a pty: /dev/null, i.e. no tty at all);
//  3. check that srt grants writes only to the policy's write roots and its own stdio / /tmp/claude paths. srt adds
//     `~/.npm/_logs` and `~/.claude/debug` of the DAEMON's os.homedir() unless a read deny covers them;
//  4. make the unsandboxed outer shell PATH-independent: srt starts with a bare `env`, which the outer shell would look
//     up on the spawn environment's PATH, and a guest-writable directory on that PATH would run code unsandboxed;
//  5. check the network section: only srt's proxy port and the hook socket. srt's `allowLocalBinding` would add bind
//     and accept on EVERY interface and connect to EVERY localhost port, workspace-wide, so it is never used; a profile
//     that carries anything else is refused. Of the proxy port's three rules only the OUTBOUND one is kept: srt also
//     writes bind + inbound on "localhost:<proxy port>", which a sandboxed process never needs (the proxy lives in the
//     daemon) and which, because Seatbelt's "localhost" matches every local address while the proxy listens on
//     127.0.0.1 only, let a guest listen on <LAN address>:<proxy port> (or 0.0.0.0 with SO_REUSEADDR) and accept
//     connections from the network (measured, finish-gate 2026-09-29; test/sandbox/network-listen.real.test.ts);
//  6. the Claude login process ONLY (ARCHITECTURE §11 D-12): add bind + accept of TCP on "localhost" (its OAuth
//     callback server; no UDP), and nothing outbound: it cannot connect to the host's localhost services. Measured on
//     macOS 26.5: Seatbelt's "localhost" host token matches EVERY local address (0.0.0.0, the LAN address), and a
//     listen cannot be narrowed to the loopback interface with any filter Seatbelt accepts. So the login process also
//     gets an exec allow-list (7): only the programs the login needs can run in it, and none of them serves anything
//     but Claude Code's own callback (which listens on loopback);
//  7. the Claude login process ONLY: `(deny process-exec)` plus `(allow process-exec <the listed programs>)` at the end
//     of the profile (the last matching rule wins over srt's `(allow process-exec)`); an interpreter is checked too.
// Linux (see the Linux section below): every bwrap argument is checked against srt's known options; bwrap must be
// exec'd by its absolute path with its own user / pid / network namespaces, no capabilities, a fresh /proc and /dev and
// a read-only root; `--new-session` is decided at run time (a fresh pty keeps its signals); `--disable-userns`, and
// every directory on a read-deny tmpfs is made unlistable and the tmpfs read-only.

/** The only srt version these rewrites are verified against (packages/daemon/package.json pins it exactly). */
export const SRT_PINNED_VERSION = '0.0.77';

export const DARWIN_SANDBOX_EXEC = '/usr/bin/sandbox-exec';
const DARWIN_ENV = '/usr/bin/env';
const DARWIN_TTY = '/usr/bin/tty';

export class HardeningError extends Error {
  constructor(message: string) {
    super(`sandbox hardening failed: ${message}`);
    this.name = 'HardeningError';
  }
}

/** The two lines of srt's base macOS profile that let a guest talk to the Security daemons (keychain). */
export const DARWIN_SECURITYD_LINES: readonly string[] = Object.freeze([
  '  (global-name "com.apple.securityd.xpc")',
  '(allow mach-lookup (global-name "com.apple.SecurityServer"))',
]);

/** srt 0.0.77's pty section (allowPty: true), verbatim; it is the last thing in the profile. */
export const SRT_DARWIN_PTY_SECTION = [
  '; Pseudo-terminal (pty) support',
  '(allow pseudo-tty)',
  '(allow file-ioctl',
  '  (literal "/dev/ptmx")',
  '  (regex #"^/dev/ttys")',
  ')',
  '(allow file-read* file-write*',
  '  (literal "/dev/ptmx")',
  '  (regex #"^/dev/ttys")',
  ')',
].join('\n');

export const SMURG_TTY_PARAM = 'SMURG_TTY';

/**
 * The outer shell's first step on macOS: the session's own tty when stdin is a pty slave (node-pty), otherwise
 * `/dev/null`, which leaves every tty denied (a status check spawned with stdin ignored still runs, with no tty at all).
 * Only ever the caller's own stdin: a wrapped command must never be spawned with the HOST's terminal as stdin.
 */
export const DARWIN_TTY_PRELUDE =
  `${SMURG_TTY_PARAM}=$(${DARWIN_TTY} 2>/dev/null) || ${SMURG_TTY_PARAM}=/dev/null; ` +
  `case "$${SMURG_TTY_PARAM}" in /dev/ttys[0-9]*) ;; *) ${SMURG_TTY_PARAM}=/dev/null ;; esac; `;

/** Replacement: raw mode on the session's own tty works (TUIs need it), every other tty of the host is denied. */
export const SMURG_OWN_TTY_SECTION = [
  '; Pseudo-terminal (pty) support, restricted by smurg to the session own tty',
  '(allow pseudo-tty)',
  '(deny file-read* file-write* file-ioctl (regex #"^/dev/ttys"))',
  `(allow file-read* file-write* file-ioctl (literal (param "${SMURG_TTY_PARAM}")) (literal "/dev/ptmx"))`,
].join('\n');

/** The header of srt 0.0.77's network section; its rules follow until the next empty or comment line. */
export const SRT_NETWORK_HEADER = '; Network';

/**
 * The login process's extra rules (ARCHITECTURE §11 D-12), inserted right after SRT_NETWORK_HEADER: TCP only (its
 * OAuth callback server), and deliberately no network-outbound rule. Meant as "the loopback interface", but Seatbelt's
 * "localhost" admits every local address (measured; see 6 above): the exec allow-list is what keeps other programs out.
 */
export const LOOPBACK_LISTEN_LINES: readonly string[] = Object.freeze([
  '; smurg: the Claude login process may listen for TCP on localhost (bind, accept); no UDP, no outbound connection',
  '(allow network-bind (local tcp "localhost:*"))',
  '(allow network-inbound (local tcp "localhost:*"))',
]);

/** srt 0.0.77's process rules (its base profile allows every exec and fork). */
export const SRT_PROCESS_EXEC_LINE = '(allow process-exec)';

/** The login process's exec allow-list (appended last): only `programs` may be exec'd, interpreters included. */
export function execAllowLines(programs: readonly string[]): string[] {
  if (programs.length === 0) throw new HardeningError('an exec allow-list needs at least one program');
  for (const program of programs) {
    if (!program.startsWith('/') || /["\\\u0000-\u001f\u007f]/.test(program)) throw new HardeningError(`program path cannot be expressed: ${JSON.stringify(program)}`);
  }
  return [
    '; smurg: the Claude login process may start only these programs',
    '(deny process-exec)',
    `(allow process-exec ${[...new Set(programs)].map((program) => `(literal ${JSON.stringify(program)})`).join(' ')})`,
  ];
}

/** What srt 0.0.77 writes into the network section for smurg's base config (proxy port, the hook socket). */
const SRT_NETWORK_RULES: readonly RegExp[] = Object.freeze([
  /^\(allow system-socket \(socket-domain AF_UNIX\)\)$/,
  /^\(allow network-bind \(local unix-socket \(subpath "(?:[^"\\]|\\.)*"\)\)\)$/,
  /^\(allow network-outbound \(remote unix-socket \(subpath "(?:[^"\\]|\\.)*"\)\)\)$/,
  /^\(allow network-(?:bind|inbound) \(local ip "localhost:[0-9]{1,5}"\)\)$/,
  /^\(allow network-outbound \(remote ip "localhost:[0-9]{1,5}"\)\)$/,
]);

/** srt's bind / accept rules on its proxy port: removed (5 above). */
const SRT_PROXY_LISTEN_RULE = /^\(allow network-(?:bind|inbound) \(local ip "localhost:[0-9]{1,5}"\)\)$/;
const SRT_PROXY_OUTBOUND_RULE = /^\(allow network-outbound \(remote ip "localhost:[0-9]{1,5}"\)\)$/;

/**
 * Checks srt's network section line by line (only SRT_NETWORK_RULES), that no network rule appears anywhere else,
 * removes srt's bind / inbound rules on the proxy port (a sandboxed process only connects to it), and returns the
 * lines with the login process's LOOPBACK_LISTEN_LINES inserted when `loopbackListen`.
 */
export function checkDarwinNetwork(lines: readonly string[], loopbackListen: boolean): string[] {
  const headers = lines.reduce((n, line) => (line === SRT_NETWORK_HEADER ? n + 1 : n), 0);
  if (headers !== 1) throw new HardeningError(`expected one network section, found ${headers}`);
  const start = lines.indexOf(SRT_NETWORK_HEADER);
  let end = start + 1;
  while (end < lines.length && lines[end] !== '' && !(lines[end] as string).startsWith(';')) end++;
  const section = lines.slice(start + 1, end);
  for (const line of section) {
    if (!SRT_NETWORK_RULES.some((rule) => rule.test(line))) throw new HardeningError(`unexpected network rule: ${JSON.stringify(line)}`);
  }
  for (const [index, line] of lines.entries()) {
    if (index > start && index < end) continue;
    if (/\((?:allow|deny) network/.test(line)) throw new HardeningError(`network rule outside the network section: ${JSON.stringify(line)}`);
  }
  // The proxy stays reachable (its outbound rule), nothing may listen on its port.
  if (!section.some((line) => SRT_PROXY_OUTBOUND_RULE.test(line))) throw new HardeningError('the network section has no rule for the proxy');
  const kept = section.filter((line) => !SRT_PROXY_LISTEN_RULE.test(line));
  return [...lines.slice(0, start + 1), ...(loopbackListen ? LOOPBACK_LISTEN_LINES : []), ...kept, ...lines.slice(end)];
}

/** Lines of srt's base profile that allow some write and are not path policy (pinned). */
const KNOWN_WRITE_ALLOW_LINES: ReadonlySet<string> = new Set(['(allow file-ioctl file-read-data file-write-data']);
/** Rule headers whose filters are the write roots (read section re-allow and the write section). */
const WRITE_ROOT_RULE_HEADERS: ReadonlySet<string> = new Set(['(allow file-write*', '(allow file-write-unlink file-write-create']);

// ---------------------------------------------------------------------------------------------------------------------
// Shell quoting (the same scheme as srt's utils/shell-quote.js, so a parse → re-quote round trip is exact)
// ---------------------------------------------------------------------------------------------------------------------

const BARE_WORD = /^[A-Za-z0-9_./:@+,-][A-Za-z0-9_./:=@+,-]*$/;

/** One POSIX shell word: bare when nothing in it is special, else single-quoted with `'"'"'` for each quote. */
export function shellQuote(word: string): string {
  if (word === '') return "''";
  if (BARE_WORD.test(word)) return word;
  return `'${word.replace(/'/g, `'"'"'`)}'`;
}

/** Reads one word written by shellQuote starting at `start`; returns its value and the index after it. */
function readQuotedWord(text: string, start: number): { value: string; end: number } {
  if (text[start] !== "'") {
    let end = start;
    while (end < text.length && text[end] !== ' ') end++;
    const value = text.slice(start, end);
    if (!BARE_WORD.test(value)) throw new HardeningError('unexpected unquoted word in the sandbox command');
    return { value, end };
  }
  let value = '';
  let i = start + 1;
  for (;;) {
    const close = text.indexOf("'", i);
    if (close === -1) throw new HardeningError('unterminated quote in the sandbox command');
    value += text.slice(i, close);
    if (text.startsWith(`'"'"'`, close)) {
      value += "'";
      i = close + 5;
      continue;
    }
    return { value, end: close + 1 };
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// macOS
// ---------------------------------------------------------------------------------------------------------------------

export interface DarwinWrapped {
  /** Everything between the leading `env ` and ` /usr/bin/sandbox-exec` (srt's -u / VAR=value words, still quoted). */
  readonly envWords: string;
  /** The Seatbelt profile, unquoted. */
  readonly profile: string;
  readonly shell: string;
  /** The command passed to `<shell> -c`, unquoted. */
  readonly command: string;
}

/**
 * Splits srt's `env … /usr/bin/sandbox-exec -p '<profile>' <shell> -c '<command>'`. The profile is located by
 * parsing the quoted word right after the FIRST ` /usr/bin/sandbox-exec -p `, so nothing inside the command can be
 * mistaken for it, and the command word must end the string.
 */
export function parseDarwinWrapped(wrapped: string, shell: string): DarwinWrapped {
  if (!wrapped.startsWith('env ')) throw new HardeningError('the command does not start with env');
  const marker = ` ${DARWIN_SANDBOX_EXEC} -p `;
  const at = wrapped.indexOf(marker);
  if (at === -1) throw new HardeningError('sandbox-exec is not in the command');
  const envWords = wrapped.slice('env '.length, at);
  const profileWord = readQuotedWord(wrapped, at + marker.length);
  const middle = ` ${shellQuote(shell)} -c `;
  if (!wrapped.startsWith(middle, profileWord.end)) throw new HardeningError('the shell after the profile is not the expected one');
  const commandWord = readQuotedWord(wrapped, profileWord.end + middle.length);
  if (commandWord.end !== wrapped.length) throw new HardeningError('unexpected text after the sandboxed command');
  return { envWords, profile: profileWord.value, shell, command: commandWord.value };
}

/** Removes exactly one occurrence of the whole line `line`; throws unless there was exactly one. */
function removeLineOnce(lines: string[], line: string): void {
  const hits = lines.reduce((n, l) => (l === line ? n + 1 : n), 0);
  if (hits !== 1) throw new HardeningError(`expected profile line found ${hits} times: ${JSON.stringify(line)}`);
  lines.splice(lines.indexOf(line), 1);
}

/**
 * Checks that every write-allow rule of the profile names only `writeRoots` or srt's own write paths. Throws on any
 * other allowed path, on a glob filter, and on any write-allow rule it does not know.
 */
export function checkDarwinWriteAllows(profile: string, writeRoots: readonly string[], srtOwnWritePaths: readonly string[]): void {
  const allowed = new Set([...writeRoots, ...srtOwnWritePaths]);
  const lines = profile.split('\n');
  let rootRules = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] as string;
    if (!line.startsWith('(allow ') || !line.includes('file-write')) continue;
    if (KNOWN_WRITE_ALLOW_LINES.has(line)) continue;
    if (line === `(allow file-read* file-write* file-ioctl (literal (param "${SMURG_TTY_PARAM}")) (literal "/dev/ptmx"))`) continue;
    if (!WRITE_ROOT_RULE_HEADERS.has(line)) throw new HardeningError(`unexpected write-allow rule: ${JSON.stringify(line)}`);
    rootRules++;
    for (i++; i < lines.length; i++) {
      const filter = lines[i] as string;
      if (filter.startsWith('  (with message ')) break;
      const match = /^ {2}\(subpath ("(?:[^"\\]|\\.)*")\)$/.exec(filter);
      if (match === null) throw new HardeningError(`unexpected write-allow filter: ${JSON.stringify(filter)}`);
      const path = JSON.parse(match[1] as string) as string;
      if (!allowed.has(path)) throw new HardeningError(`srt allows writing a path outside the policy: ${JSON.stringify(path)}`);
    }
  }
  if (rootRules !== 2) throw new HardeningError(`expected 2 write-root rules, found ${rootRules}`);
}

/**
 * Hardens the profile text: strips the Security-daemon lookups, replaces the pty section with the own-tty section,
 * checks the write surface and the network section, and refuses a profile without network restriction. With
 * `loopbackListen` (the Claude login process only) the loopback listen rules are added.
 */
export function hardenDarwinProfile(
  profile: string,
  writeRoots: readonly string[],
  srtOwnWritePaths: readonly string[],
  loopbackListen = false,
  execAllow: readonly string[] | null = null,
): string {
  const original = profile.split('\n');
  if (original[0] !== '(version 1)' || !(original[1] ?? '').startsWith('(deny default')) throw new HardeningError('the profile does not start with (deny default)');
  if (original.includes('(allow network*)')) throw new HardeningError('the profile allows all network access (srt was not initialized)');
  const lines = checkDarwinNetwork(original, loopbackListen);
  for (const line of DARWIN_SECURITYD_LINES) removeLineOnce(lines, line);
  let text = lines.join('\n');
  if (/com\.apple\.securityd\.xpc|com\.apple\.SecurityServer/.test(text)) throw new HardeningError('Security daemon lookups are still in the profile');
  const hits = text.split(SRT_DARWIN_PTY_SECTION).length - 1;
  if (hits !== 1 || !text.endsWith(`\n${SRT_DARWIN_PTY_SECTION}`)) throw new HardeningError('the pty section is not the one this code was verified against');
  text = `${text.slice(0, text.length - SRT_DARWIN_PTY_SECTION.length)}${SMURG_OWN_TTY_SECTION}`;
  // Nothing else may mention ttys, ptmx or pseudo-tty: exactly the one occurrence each in the own-tty section.
  for (const needle of ['/dev/ttys', '/dev/ptmx', 'pseudo-tty', `(param "${SMURG_TTY_PARAM}")`]) {
    if (text.split(needle).length - 1 !== 1) throw new HardeningError(`unexpected pty rules in the profile (${needle})`);
  }
  checkDarwinWriteAllows(text, writeRoots, srtOwnWritePaths);
  if (execAllow !== null) {
    const execLines = text.split('\n').filter((line) => line.includes('process-exec'));
    if (execLines.length !== 1 || execLines[0] !== SRT_PROCESS_EXEC_LINE) throw new HardeningError('the process rules are not the ones this code was verified against');
    text = `${text}\n${execAllowLines(execAllow).join('\n')}`;
  }
  return text;
}

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * srt's words between `env` and sandbox-exec: `-u NAME` pairs, then `NAME=value` assignments. Anything else (an option,
 * a command, a shell operator) would run in the unsandboxed outer shell or change what env does, so it is refused.
 */
export function checkDarwinEnvWords(envWords: string): void {
  let i = 0;
  let expectName = false;
  while (i < envWords.length) {
    const word = readQuotedWord(envWords, i);
    if (expectName) {
      if (!ENV_NAME.test(word.value)) throw new HardeningError('env -u is not followed by a variable name');
      expectName = false;
    } else if (word.value === '-u') {
      expectName = true;
    } else {
      const eq = word.value.indexOf('=');
      if (eq <= 0 || !ENV_NAME.test(word.value.slice(0, eq))) throw new HardeningError('unexpected word in the env prefix');
    }
    i = word.end;
    if (i < envWords.length) {
      if (envWords[i] !== ' ') throw new HardeningError('malformed env prefix');
      i++;
    }
  }
  if (expectName) throw new HardeningError('env -u without a name');
}

export interface DarwinHardeningOptions {
  /** The inner shell given to srt's wrapWithSandbox. */
  readonly shell: string;
  readonly writeRoots: readonly string[];
  readonly srtOwnWritePaths: readonly string[];
  /** The Claude login process only (ARCHITECTURE §11 D-12): bind + accept on loopback. */
  readonly loopbackListen?: boolean;
  /** The Claude login process only: the programs it may exec (everything else is denied). */
  readonly execAllow?: readonly string[] | null;
}

/**
 * The command the outer (unsandboxed) shell runs:
 *   <DARWIN_TTY_PRELUDE> exec /usr/bin/env <srt env words> /usr/bin/sandbox-exec -D SMURG_TTY="$SMURG_TTY" \
 *     -p '<hardened profile>' <shell> -c '<command>'
 * Every program the outer shell starts is named by absolute path.
 */
export function hardenDarwinCommand(wrapped: string, options: DarwinHardeningOptions): string {
  const parsed = parseDarwinWrapped(wrapped, options.shell);
  checkDarwinEnvWords(parsed.envWords);
  const profile = hardenDarwinProfile(parsed.profile, options.writeRoots, options.srtOwnWritePaths, options.loopbackListen === true, options.execAllow ?? null);
  const tail = `-p ${shellQuote(profile)} ${shellQuote(parsed.shell)} -c ${shellQuote(parsed.command)}`;
  // Belt and braces: the rebuilt words parse back to exactly the same parts (the quoting is exact).
  const again = parseDarwinWrapped(`env ${parsed.envWords} ${DARWIN_SANDBOX_EXEC} ${tail}`, options.shell);
  if (again.envWords !== parsed.envWords || again.profile !== profile || again.command !== parsed.command) {
    throw new HardeningError('the hardened command does not round-trip');
  }
  return `${DARWIN_TTY_PRELUDE}exec ${DARWIN_ENV} ${parsed.envWords} ${DARWIN_SANDBOX_EXEC} -D ${SMURG_TTY_PARAM}="$${SMURG_TTY_PARAM}" ${tail}`;
}

// ---------------------------------------------------------------------------------------------------------------------
// Linux (verified with srt 0.0.77 on Ubuntu 24.04 arm64, kernel 6.8, bubblewrap 0.9.0, AppArmor userns restriction on
// with the smurg-bwrap profile; docs/research/sandbox.md "Linux, verified 2026-10-01")
// ---------------------------------------------------------------------------------------------------------------------
//
// srt builds the guest's file system from mounts: `--ro-bind / /`, the write roots bound writable, then a tmpfs over
// every read-denied directory (`/home`, `/tmp`, the host home, `<share>/.smurg`, …) with the allowRead / allowWrite
// carve-outs bound back on top. Measured, that leaves three holes the macOS profile does not have:
//  1. bubblewrap creates the directories leading to a carve-out on the tmpfs (the "skeleton"), so the host home, the
//     state dir, `<stateDir>/guests` and (worktree mode) the main share can be LISTED: they show the names on the way
//     to the carve-outs (the self-test's check 23 failed on this: "the host home could be listed");
//  2. every such tmpfs is WRITABLE: a guest could create files under /tmp, the host home, `<share>/.smurg` (private to
//     the sandbox, but "writes only to the roots" did not hold, and `.smurg` looked writable);
//  3. the sandboxed process runs under bwrap's AppArmor profile, which allows user namespaces: in a nested one it holds
//     CAP_DAC_READ_SEARCH over its own files and lists the skeleton anyway (`unshare -Ur ls`).
// So the hardening appends, before bwrap's `--`: `--disable-userns` (3), `--chmod 0111` on every directory that lives
// on a read-deny tmpfs (the tmpfs roots and the skeleton: lookups work, listing fails) and `--remount-ro` on every
// such tmpfs (1 and 2: nothing there can be created, and the modes cannot be changed back). It also decides
// `--new-session` at run time (LINUX_SESSION_PRELUDE) and requires the namespaces and mounts the policy relies on.

/** The bash array the outer shell passes to bwrap in place of srt's `--new-session` (empty on a fresh pty). */
export const LINUX_NEW_SESSION_VAR = 'SMURG_NEW_SESSION';
const LINUX_STAT_VAR = 'SMURG_STAT';

/**
 * The outer shell's first step on Linux. srt always starts bwrap with `--new-session` (setsid): that keeps a guest from
 * the terminal of whoever spawned it (TIOCSTI injection, CVE-2017-5226), but measured on a node-pty it also cuts the
 * session's own pty off as the controlling terminal: no SIGWINCH on resize (a TUI never redraws), no job control, and
 * Ctrl-C in a guest terminal kills bwrap (its process group is the foreground one) and with it the whole session.
 * `--new-session` is therefore dropped exactly when the outer shell leads its own session with a controlling terminal
 * and stdin is a terminal: that is node-pty (forkpty: setsid + TIOCSCTTY on a FRESH pty that no other session holds,
 * so TIOCSTI only reaches the guest's own input). Spawned any other way (child_process, stdin not a terminal, or a
 * setsid without a controlling terminal) the shell is not a session leader with a terminal and bwrap keeps
 * `--new-session`. Shell builtins only; a failure keeps `--new-session`.
 */
export const LINUX_SESSION_PRELUDE =
  `${LINUX_NEW_SESSION_VAR}=(--new-session); ` +
  `{ read -r ${LINUX_STAT_VAR} < /proc/$$/stat && ${LINUX_STAT_VAR}=\${${LINUX_STAT_VAR}##*) } && set -- $${LINUX_STAT_VAR} && ` +
  `[ "$4" = "$$" ] && [ "$5" != 0 ] && [ -t 0 ] && ${LINUX_NEW_SESSION_VAR}=(); } 2>/dev/null; `;

/** How srt 0.0.77's bwrap words are replaced: the array expands to `--new-session` or to nothing. */
const LINUX_NEW_SESSION_WORD = `"\${${LINUX_NEW_SESSION_VAR}[@]}"`;

/** The mode of every directory on a read-deny tmpfs: search only (a carve-out below stays reachable by its path). */
export const LINUX_HIDDEN_DIR_MODE = '0111';

/**
 * The bwrap options srt 0.0.77 writes into a wrapped command, with their argument counts. Anything else (for example
 * `--dev-bind`, `--cap-add`, a second `--proc`) is refused: the hardening has only been verified against these.
 */
const SRT_BWRAP_ARITY: ReadonlyMap<string, number> = new Map([
  ['--new-session', 0],
  ['--die-with-parent', 0],
  ['--unshare-net', 0],
  ['--unshare-pid', 0],
  ['--unshare-user', 0],
  ['--unsetenv', 1],
  ['--tmpfs', 1],
  ['--dev', 1],
  ['--proc', 1],
  ['--cap-drop', 1],
  ['--args', 1],
  ['--setenv', 2],
  ['--bind', 2],
  ['--ro-bind', 2],
]);

/** Options whose operand is a mount destination (the last argument). */
const MOUNT_OPTIONS: ReadonlySet<string> = new Set(['--bind', '--ro-bind', '--tmpfs', '--dev', '--proc']);

/** srt's arguments-file form: `/bin/sh -c 'exec 9<"$1" && shift && exec "$@"' srt-args /proc/<pid>/fd/<n> <bwrap> …`. */
const ARGS_FILE_SCRIPT = /^exec ([0-9])<"\$1" && shift && exec "\$@"$/;
const ARGS_FILE_PATH = /^\/proc\/[0-9]+\/fd\/[0-9]+$/;

interface Word {
  readonly value: string;
  readonly start: number;
  readonly end: number;
}

/** Every word of a command written with shellQuote-style quoting (srt's utils/shell-quote.js), with its position. */
function splitQuotedWords(text: string): Word[] {
  const words: Word[] = [];
  let i = 0;
  while (i < text.length) {
    const word = readQuotedWord(text, i);
    words.push({ value: word.value, start: i, end: word.end });
    i = word.end;
    if (i < text.length) {
      if (text[i] !== ' ') throw new HardeningError('malformed bwrap command');
      i++;
    }
  }
  return words;
}

/**
 * srt's arguments file (`/proc/<pid>/fd/<n>`, NUL-separated mount words), when the wrapped command uses one; null for
 * the direct form. The service reads it (it is this process's own descriptor) and passes the words back in.
 */
export function linuxArgsFilePath(wrapped: string): string | null {
  if (!wrapped.startsWith('/bin/sh -c ')) return null;
  const words = splitQuotedWords(wrapped);
  const path = words[4]?.value ?? '';
  return words[3]?.value === 'srt-args' && ARGS_FILE_PATH.test(path) ? path : null;
}

interface BwrapOp {
  readonly option: string;
  readonly args: readonly string[];
  /** The option's word on the command line; null for a word read from the arguments file. */
  readonly word: Word | null;
}

function takeOps(words: readonly string[], lineWords: readonly Word[] | null, from: number, stopAtSeparator: boolean): { ops: BwrapOp[]; end: number } {
  const ops: BwrapOp[] = [];
  let i = from;
  while (i < words.length) {
    const option = words[i] as string;
    if (stopAtSeparator && option === '--') return { ops, end: i };
    const arity = SRT_BWRAP_ARITY.get(option);
    if (arity === undefined) throw new HardeningError(`unexpected bwrap argument: ${JSON.stringify(option.slice(0, 80))}`);
    if (i + arity >= words.length) throw new HardeningError(`bwrap option ${option} is missing its arguments`);
    ops.push({ option, args: words.slice(i + 1, i + 1 + arity), word: lineWords === null ? null : (lineWords[i] as Word) });
    i += 1 + arity;
  }
  if (stopAtSeparator) throw new HardeningError('the bwrap command has no -- before the sandboxed shell');
  return { ops, end: i };
}

function isAtOrBelow(p: string, dir: string): boolean {
  return p === dir || p.startsWith(dir === '/' ? '/' : `${dir}/`);
}

function parentsOf(p: string): string[] {
  const out: string[] = [];
  for (let dir = p.slice(0, p.lastIndexOf('/')) || '/'; ; dir = dir.slice(0, dir.lastIndexOf('/')) || '/') {
    out.push(dir);
    if (dir === '/') return out;
  }
}

/**
 * From the mounts in order: the directories that end up on a read-deny tmpfs (the tmpfs roots that stay visible, and
 * the directories bubblewrap creates on them for a later mount) and those tmpfs roots. A directory is on the tmpfs of
 * mount k when k is the last mount at or above it, and it exists there when it is k's own root or a mount AFTER k lies
 * below it (bubblewrap created it for that mount).
 */
export function linuxHiddenDirs(mounts: readonly { readonly kind: 'bind' | 'tmpfs' | 'other'; readonly dest: string }[]): { readonly chmod: string[]; readonly readOnly: string[] } {
  for (const mount of mounts) {
    if (!mount.dest.startsWith('/') || /(?:^|\/)\.\.?(?:\/|$)|\/\/|[\u0000]/.test(mount.dest) || (mount.dest.length > 1 && mount.dest.endsWith('/'))) {
      throw new HardeningError(`mount destination is not a normalised absolute path: ${JSON.stringify(mount.dest.slice(0, 120))}`);
    }
  }
  const owner = (dir: string): number => {
    for (let k = mounts.length - 1; k >= 0; k--) if (isAtOrBelow(dir, (mounts[k] as { dest: string }).dest)) return k;
    return -1;
  };
  const chmod = new Set<string>();
  const readOnly = new Set<string>();
  mounts.forEach((mount, k) => {
    if (mount.kind === 'tmpfs' && owner(mount.dest) === k) {
      chmod.add(mount.dest);
      readOnly.add(mount.dest);
    }
  });
  mounts.forEach((mount, j) => {
    for (const dir of parentsOf(mount.dest)) {
      const k = owner(dir);
      if (k >= 0 && k < j && (mounts[k] as { kind: string }).kind === 'tmpfs') chmod.add(dir);
    }
  });
  const byDepth = (a: string, b: string): number => a.split('/').length - b.split('/').length || (a < b ? -1 : a > b ? 1 : 0);
  return { chmod: [...chmod].sort(byDepth), readOnly: [...readOnly].sort(byDepth) };
}

export interface LinuxHardeningOptions {
  /** The Claude login process (ARCHITECTURE §11 D-12). */
  readonly loopbackListen?: boolean;
  /** The words of srt's arguments file (linuxArgsFilePath), when the command uses one. */
  readonly argsFileWords?: readonly string[] | null;
  /**
   * The policy's write roots and srt's bridge sockets: the only destinations srt may bind WRITABLE. srt also binds its
   * own `/tmp/claude` writable whenever it exists on the host (sandbox-utils.js SANDBOX_OWN_WRITE_PATHS, not
   * configurable), a scratch dir every guest and the host's own sandboxed Claude Code would share: any such other
   * writable bind gets a tmpfs of its own on top (then hidden and read-only like every read-deny tmpfs). Without this
   * list every writable bind is accepted as is (unit tests of the parser only).
   */
  readonly writableBinds?: readonly string[];
}

/**
 * srt renders `<bwrap> --new-session --die-with-parent …` (bwrapPath from the base config), or, when the mounts do not
 * fit one argument, `/bin/sh -c 'exec 9<"$1" && shift && exec "$@"' srt-args /proc/<pid>/fd/<n> <bwrap> … --args 9 …`
 * with the mount words in that file. Every bwrap argument (the file's included) is parsed against srt's known options;
 * the command must exec bwrap by its absolute path with `--die-with-parent`, one `--new-session`, user, pid and network
 * namespaces (`--unshare-net`: srt's proxy is the ONLY way out, and the login process's callback server listens on
 * the namespace's own loopback, ARCHITECTURE §11 D-12), `--cap-drop ALL`, a fresh `/proc` and `/dev`, and
 * `--ro-bind / /` (nothing writable but the roots). The result is LINUX_SESSION_PRELUDE + `exec` + srt's command with
 * its `--new-session` word replaced by LINUX_NEW_SESSION_WORD and the hidden-directory arguments added before `--`.
 */
export function hardenLinuxCommand(wrapped: string, bwrapPath: string, options: LinuxHardeningOptions = {}): string {
  if (!bwrapPath.startsWith('/')) throw new HardeningError('bwrap path is not absolute');
  const words = splitQuotedWords(wrapped);
  const values = words.map((word) => word.value);
  let bwrapAt: number;
  let argsFd: string | null = null;
  if (values[0] === bwrapPath) {
    bwrapAt = 0;
  } else if (values[0] === '/bin/sh' && values[1] === '-c' && ARGS_FILE_SCRIPT.test(values[2] ?? '') && values[3] === 'srt-args' && ARGS_FILE_PATH.test(values[4] ?? '') && values[5] === bwrapPath) {
    bwrapAt = 5;
    argsFd = (ARGS_FILE_SCRIPT.exec(values[2] as string) as RegExpExecArray)[1] as string;
  } else {
    throw new HardeningError('the command does not start with the absolute bwrap path');
  }
  const line = takeOps(values, words, bwrapAt + 1, true);
  const tail = values.slice(line.end + 1);
  if (tail.length !== 3 || !(tail[0] as string).startsWith('/') || tail[1] !== '-c') throw new HardeningError('the sandboxed command is not `<absolute shell> -c <command>`');
  // The arguments file's ops take the place of its `--args`.
  const argsOps = line.ops.filter((op) => op.option === '--args');
  let ops: BwrapOp[] = line.ops;
  if (argsOps.length > 0) {
    if (argsFd === null || argsOps.length !== 1 || argsOps[0]?.args[0] !== argsFd) throw new HardeningError('unexpected bwrap --args');
    if (options.argsFileWords === undefined || options.argsFileWords === null) throw new HardeningError('the bwrap arguments file was not read');
    const fileOps = takeOps(options.argsFileWords, null, 0, false).ops;
    if (fileOps.some((op) => op.option === '--args' || op.option === '--new-session')) throw new HardeningError('unexpected option in the bwrap arguments file');
    const at = ops.indexOf(argsOps[0] as BwrapOp);
    ops = [...ops.slice(0, at), ...fileOps, ...ops.slice(at + 1)];
  } else if (argsFd !== null) {
    throw new HardeningError('the arguments-file form without --args');
  }
  const count = (option: string, args?: readonly string[]): number =>
    ops.filter((op) => op.option === option && (args === undefined || (op.args.length === args.length && op.args.every((a, i) => a === args[i])))).length;
  if (count('--die-with-parent') < 1) throw new HardeningError('bwrap is not started with --die-with-parent');
  const newSession = ops.filter((op) => op.option === '--new-session');
  if (newSession.length !== 1 || newSession[0]?.word === null) throw new HardeningError('bwrap is not started with exactly one --new-session');
  if (count('--unshare-user') < 1 || count('--unshare-pid') < 1) throw new HardeningError('bwrap does not create its own user and pid namespaces');
  if (count('--unshare-net') < 1) {
    throw new HardeningError(options.loopbackListen === true ? 'the login process needs its own network namespace (--unshare-net)' : 'bwrap does not create its own network namespace (--unshare-net)');
  }
  if (count('--cap-drop', ['ALL']) !== 1 || count('--cap-drop') !== 1) throw new HardeningError('bwrap does not drop every capability');
  if (count('--proc', ['/proc']) !== 1 || count('--proc') !== 1 || count('--dev', ['/dev']) !== 1 || count('--dev') !== 1) throw new HardeningError('bwrap does not mount a fresh /proc and /dev');
  if (count('--ro-bind', ['/', '/']) !== 1) throw new HardeningError('bwrap does not start from a read-only root');
  const mounts: { kind: 'bind' | 'tmpfs' | 'other'; dest: string }[] = ops
    .filter((op) => MOUNT_OPTIONS.has(op.option))
    .map((op) => ({ kind: op.option === '--tmpfs' ? ('tmpfs' as const) : op.option === '--bind' || op.option === '--ro-bind' ? ('bind' as const) : ('other' as const), dest: op.args[op.args.length - 1] as string }));
  // A writable bind that is neither a write root nor a bridge socket (srt's /tmp/claude): covered by a tmpfs of ours.
  const covers: string[] = [];
  if (options.writableBinds !== undefined) {
    const allowed = new Set(options.writableBinds);
    for (const op of ops) {
      if (op.option !== '--bind') continue;
      const dest = op.args[1] as string;
      if (allowed.has(dest) || covers.includes(dest)) continue;
      if (dest === '/' || mounts.some((m) => m.dest !== dest && isAtOrBelow(m.dest, dest))) throw new HardeningError(`srt binds a path writable that the policy does not name: ${JSON.stringify(dest.slice(0, 120))}`);
      covers.push(dest);
    }
  }
  mounts.push(...covers.map((dest) => ({ kind: 'tmpfs' as const, dest })));
  const hidden = linuxHiddenDirs(mounts);
  const extra = [
    '--disable-userns',
    ...covers.flatMap((dir) => ['--tmpfs', dir]),
    ...hidden.chmod.flatMap((dir) => ['--chmod', LINUX_HIDDEN_DIR_MODE, dir]),
    ...hidden.readOnly.flatMap((dir) => ['--remount-ro', dir]),
  ];
  const session = newSession[0]?.word as Word;
  const separator = words[line.end] as Word;
  const hardened =
    wrapped.slice(0, session.start) +
    LINUX_NEW_SESSION_WORD +
    wrapped.slice(session.end, separator.start) +
    `${extra.map(shellQuote).join(' ')} ` +
    wrapped.slice(separator.start);
  return `${LINUX_SESSION_PRELUDE}exec ${hardened}`;
}
