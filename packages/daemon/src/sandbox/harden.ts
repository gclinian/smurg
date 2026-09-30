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
// Linux: the command must start with the absolute bwrap path (base config `bwrapPath`) and keep `--die-with-parent`;
// the login process also needs `--unshare-net` (its loopback is then its own namespace's, not the host's).

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
// Linux (implemented from srt 0.0.77's source; not run on Linux by this project, see docs)
// ---------------------------------------------------------------------------------------------------------------------

/**
 * srt renders `<bwrap> --new-session --die-with-parent …` (bwrapPath from the base config), or, when the mounts do not
 * fit one argument, `/bin/sh -c 'exec 3<"$1" && shift && exec "$@"' srt-args <file> <bwrap> …`. Either way the
 * outer shell must exec an absolute path and bwrap must die with its parent.
 *
 * `loopbackListen` (the Claude login process, ARCHITECTURE §11 D-12): on Linux srt gives every sandboxed process its
 * own network namespace (`--unshare-net`, the proxy reached through a bridged socket), so the login process's callback
 * server listens on the namespace's OWN loopback, never on the host's, and the host's localhost services are not
 * reachable from it: nothing needs to be added. That is only true while `--unshare-net` is on the command line, so the
 * login process requires the direct form (whose arguments are visible) with it. Implemented from srt 0.0.77's source
 * (linux-sandbox-utils.js); not run on Linux by this project.
 */
export function hardenLinuxCommand(wrapped: string, bwrapPath: string, options: { readonly loopbackListen?: boolean } = {}): string {
  if (!bwrapPath.startsWith('/')) throw new HardeningError('bwrap path is not absolute');
  const direct = `${shellQuote(bwrapPath)} `;
  const viaArgsFile = `/bin/sh -c `;
  if (!wrapped.startsWith(direct) && !(wrapped.startsWith(viaArgsFile) && wrapped.includes(` ${shellQuote(bwrapPath)} `))) {
    throw new HardeningError('the command does not start with the absolute bwrap path');
  }
  if (!wrapped.includes(' --die-with-parent ')) throw new HardeningError('bwrap is not started with --die-with-parent');
  if (!wrapped.includes(' --new-session ')) throw new HardeningError('bwrap is not started with --new-session');
  if (options.loopbackListen === true) {
    if (!wrapped.startsWith(direct)) throw new HardeningError('the login process needs bwrap arguments that can be checked (no arguments file)');
    if (!linuxBwrapWords(wrapped).includes('--unshare-net')) throw new HardeningError('the login process needs its own network namespace (--unshare-net)');
  }
  return `exec ${wrapped}`;
}

/** The words of a direct bwrap command up to its `--` (shellQuote-style words, like srt writes them). */
function linuxBwrapWords(wrapped: string): string[] {
  const words: string[] = [];
  let i = 0;
  while (i < wrapped.length) {
    const word = readQuotedWord(wrapped, i);
    if (word.value === '--') return words;
    words.push(word.value);
    i = word.end;
    if (i < wrapped.length) {
      if (wrapped[i] !== ' ') throw new HardeningError('malformed bwrap command');
      i++;
    }
  }
  throw new HardeningError('the bwrap command has no -- before the sandboxed shell');
}
