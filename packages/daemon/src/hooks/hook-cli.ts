// `smurg hook`: the command hooks Claude Code runs inside every session (ARCHITECTURE §7.6, §7.7). Two behaviours,
// two separate code paths, chosen by the argument the daemon wrote after `hook` in the session settings:
//
// 1. `smurg hook` — THE TOOL GATE's command (runLockHook; for the edit tools the daemon also takes the agent lock).
//    Registered for PreToolUse of EVERY tool, it reads the hook JSON from stdin, asks the daemon over
//    $SMURG_HOOK_SOCKET with $SMURG_SESSION_TOKEN, prints the daemon's answer (or nothing) and exits 0.
//    FAIL CLOSED BY ITSELF. Claude Code lets the tool run when a hook times out, crashes, exits 1, prints unparseable
//    JSON or cannot start (claude-hooks.md §1.2, E1–E5). So on ANY failure during PreToolUse — no socket, refused,
//    deadline, malformed reply, unreadable input — it prints an explicit JSON deny that names the unreachable daemon
//    and returns 0, WHATEVER THE TOOL (row G1 of the gate): a command of an orphaned agent, or of an agent whose
//    daemon hangs, does not run, even when a remembered rule, a host rule or `acceptEdits` would have let it. Its own deadline (HOOK_CLI_DEADLINE_MS, 5 s) is shorter than the configured hook timeout (10 s).
//    Other events fail quietly: nothing on stdout (UserPromptSubmit / SessionStart stdout would become model context).
//
// 2. `smurg hook bash-activity` — THE BASH ACTIVITY HOOK (runBashActivityHook, §11 D-13). It only tells the daemon
//    "this session started / finished a Bash command" so a disk change inside that window can be attributed to the
//    agent. It never takes a lock and NEVER prints anything for a Bash event: a decision (or a deny) would block the
//    command. FAIL OPEN: daemon unreachable, slow (BASH_HOOK_DEADLINE_MS, 1 s) or answering nonsense ⇒ exit 0, no
//    output, nothing attributed. The one thing it refuses is to let an EDIT tool's PreToolUse pass through it: an edit
//    routed here by a misconfiguration would otherwise run without its lock, so that gets the lock hook's deny.
//
// Any argument other than `bash-activity` selects the lock hook: a typo can only make a hook stricter.
//
// Claude Code starts it once per hook event, so it must start FAST: it never imports the daemon (src/daemon.ts,
// src/index.ts, `@smurg/daemon`), zod or anything heavy; node:net and JSON are all it needs. The CLI loads it through
// the package export `@smurg/daemon/hook-cli` (test/composition.test.ts checks the import graph).
import { randomBytes } from 'node:crypto';
import { daemonUnreachableReason } from './deny-text.ts';
import { HookSocketError, requestDaemon } from './socket-client.ts';
import {
  BASH_HOOK_DEADLINE_MS,
  BASH_TOOL_NAME,
  EDIT_TOOL_NAMES,
  HOOK_CLI_BASH_ACTIVITY_ARG,
  HOOK_CLI_DEADLINE_MS,
  HOOK_ENV,
  HOOK_REQUEST_MAX_BYTES,
  HOOK_STDIN_MAX_BYTES,
  HOOK_VIA_BASH_ACTIVITY,
  isJsonObject,
  preToolUseDeny,
  projectHookInput,
  sniffHookEventName,
  type JsonObject,
} from './wire.ts';

/** What the hook talks to; injectable for tests, the process's own streams and environment by default. */
export interface HookCliIo {
  /** The hook input Claude Code writes: one JSON document, then EOF. */
  readonly stdin: AsyncIterable<string | Uint8Array>;
  /** Where the hook output (JSON) goes; Claude Code parses it. */
  readonly stdout: { write(chunk: string | Uint8Array): unknown };
  readonly stderr: { write(chunk: string | Uint8Array): unknown };
  /** SMURG_HOOK_SOCKET, SMURG_SESSION_TOKEN, SMURG_SESSION_ID are set by the daemon on the session. */
  readonly env: Readonly<Record<string, string | undefined>>;
  /** The command-line arguments after `hook` (the daemon's session settings put them there). */
  readonly args?: readonly string[];
}

/** process.argv is [node|exe, script|exe, 'hook', ...] for the CLI, the single executable and the test entries alike. */
function processArgs(): string[] {
  const at = process.argv.indexOf('hook', 2);
  return at === -1 ? [] : process.argv.slice(at + 1);
}

function processIo(): HookCliIo {
  return { stdin: process.stdin, stdout: process.stdout, stderr: process.stderr, env: process.env, args: processArgs() };
}

export type HookCliMode = 'lock' | 'bash-activity';

/** `bash-activity` only when that is exactly the first argument; everything else is the fail-closed lock hook. */
export function hookCliMode(args: readonly string[] | undefined): HookCliMode {
  return args !== undefined && args[0] === HOOK_CLI_BASH_ACTIVITY_ARG ? 'bash-activity' : 'lock';
}

/**
 * `SMURG_HOOK_DEADLINE_MS` may only LOWER the deadline (tests of the slow-daemon case). A lower deadline can only turn
 * more PreToolUse answers into denies, never let an edit through, so honouring it from the environment is safe.
 */
function deadlineFrom(env: HookCliIo['env']): number {
  const raw = Number(env['SMURG_HOOK_DEADLINE_MS']);
  return Number.isInteger(raw) && raw >= 100 && raw < HOOK_CLI_DEADLINE_MS ? raw : HOOK_CLI_DEADLINE_MS;
}

class HookCliError extends Error {}

/** Reads all of stdin (bounded) before `deadlineAt`; always releases the stream (the process must be able to exit). */
async function readInput(stdin: HookCliIo['stdin'], deadlineAt: number): Promise<string> {
  const iterator = stdin[Symbol.asyncIterator]();
  const decoder = new TextDecoder('utf-8', { fatal: false });
  let text = '';
  let bytes = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new HookCliError('hook input not received in time')), Math.max(1, deadlineAt - Date.now()));
  });
  try {
    for (;;) {
      const next = await Promise.race([iterator.next(), expired]);
      if (next.done) break;
      const chunk = next.value;
      if (typeof chunk === 'string') {
        bytes += Buffer.byteLength(chunk, 'utf8');
        text += chunk;
      } else {
        bytes += chunk.byteLength;
        text += decoder.decode(chunk, { stream: true });
      }
      if (bytes > HOOK_STDIN_MAX_BYTES) throw new HookCliError('hook input too large');
    }
    return text + decoder.decode();
  } finally {
    clearTimeout(timer);
    // Destroys process.stdin when we stop early; otherwise a stdin that never ends keeps the process alive past
    // Claude Code's timeout, which counts as a non-blocking error (the edit would run).
    try {
      void Promise.resolve(iterator.return?.()).catch(() => {});
    } catch {
      // an iterator that cannot be returned has nothing to release
    }
  }
}

/** Writes and waits until the chunk is handed to the OS (pipes are asynchronous on macOS; the CLI may exit next). */
function writeAll(stream: HookCliIo['stdout'], text: string): Promise<void> {
  return new Promise<void>((resolve) => {
    const write = stream.write as (chunk: string, callback?: (err?: Error | null) => void) => unknown;
    if (write.length < 2) {
      write.call(stream, text);
      resolve();
      return;
    }
    write.call(stream, text, () => resolve());
  });
}

function describeError(err: unknown): string {
  if (err instanceof HookSocketError) return `${err.kind}: ${err.message}`;
  if (err instanceof Error) return err.message;
  return 'unknown error';
}

/** Runs one hook invocation and resolves with the process exit code (the CLI sets process.exitCode). Always 0. */
export async function runHookCli(io: HookCliIo = processIo()): Promise<number> {
  return hookCliMode(io.args) === 'bash-activity' ? runBashActivityHook(io) : runLockHook(io);
}

/** THE LOCK HOOK (see the top of this file): fails closed. */
export async function runLockHook(io: HookCliIo): Promise<number> {
  const deadlineAt = Date.now() + deadlineFrom(io.env);
  let eventName: string | null = null;
  try {
    const raw = await readInput(io.stdin, deadlineAt);
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      eventName = sniffHookEventName(raw);
      throw new HookCliError('hook input is not JSON');
    }
    if (!isJsonObject(parsed)) throw new HookCliError('hook input is not a JSON object');
    const hookInput = projectHookInput(parsed, { command: true });
    eventName = typeof hookInput['hook_event_name'] === 'string' ? hookInput['hook_event_name'] : null;
    const id = randomBytes(12).toString('base64url');
    const request: JsonObject = { id, token: io.env[HOOK_ENV.token] ?? '', op: 'hook', hookInput };
    if (Buffer.byteLength(JSON.stringify(request), 'utf8') >= HOOK_REQUEST_MAX_BYTES) throw new HookCliError('hook input too large to forward');
    const reply = await requestDaemon(io.env[HOOK_ENV.socket] ?? '', request, { deadlineMs: deadlineAt - Date.now() });
    if (reply['id'] !== id || !('hookOutput' in reply)) throw new HookCliError('malformed daemon reply');
    const hookOutput = reply['hookOutput'];
    if (hookOutput === null) return 0;
    if (!isJsonObject(hookOutput)) throw new HookCliError('malformed daemon reply');
    await writeAll(io.stdout, JSON.stringify(hookOutput));
    return 0;
  } catch (err) {
    const detail = describeError(err);
    // Unknown event (unreadable input) counts as PreToolUse: denying something that was not a tool call is harmless,
    // letting one through is not.
    if (eventName === null || eventName === 'PreToolUse') {
      await writeAll(io.stdout, JSON.stringify(preToolUseDeny(daemonUnreachableReason(detail))));
      io.stderr.write(`smurg hook: ${detail}; the call was denied\n`);
    } else {
      io.stderr.write(`smurg hook: ${detail}\n`);
    }
    return 0;
  }
}

/**
 * THE BASH ACTIVITY HOOK (see the top of this file, ARCHITECTURE §11 D-13): reports a Bash PreToolUse /
 * PostToolUse / PostToolUseFailure to the daemon and prints NOTHING. Every failure is silent (fail open).
 */
export async function runBashActivityHook(io: HookCliIo): Promise<number> {
  const deadlineAt = Date.now() + Math.min(deadlineFrom(io.env), BASH_HOOK_DEADLINE_MS);
  let hookInput: JsonObject;
  try {
    const parsed: unknown = JSON.parse(await readInput(io.stdin, deadlineAt));
    if (!isJsonObject(parsed)) return 0;
    hookInput = projectHookInput(parsed);
  } catch {
    return 0; // unreadable, too big or too late: a shell command is never blocked by this hook
  }
  const event = hookInput['hook_event_name'];
  const tool = hookInput['tool_name'];
  if (tool !== BASH_TOOL_NAME) {
    // Registered for Bash only; anything else reached it through a misconfiguration. An edit tool's PreToolUse must
    // not pass here without its lock (the lock hook's rule): deny it. Any other tool: report nothing, decide nothing.
    if (event === 'PreToolUse' && typeof tool === 'string' && EDIT_TOOL_NAMES.includes(tool)) {
      await writeAll(io.stdout, JSON.stringify(preToolUseDeny(daemonUnreachableReason('the bash-activity hook received an edit tool'))));
    }
    return 0;
  }
  if (event !== 'PreToolUse' && event !== 'PostToolUse' && event !== 'PostToolUseFailure') return 0;
  try {
    const request: JsonObject = { id: randomBytes(12).toString('base64url'), token: io.env[HOOK_ENV.token] ?? '', op: 'hook', hookInput, via: HOOK_VIA_BASH_ACTIVITY };
    if (Buffer.byteLength(JSON.stringify(request), 'utf8') >= HOOK_REQUEST_MAX_BYTES) return 0;
    // The reply is not even looked at: nothing the daemon says can turn this into a decision.
    await requestDaemon(io.env[HOOK_ENV.socket] ?? '', request, { deadlineMs: Math.max(1, deadlineAt - Date.now()) });
  } catch {
    // fail open: the command runs, and its changes are not attributed
  }
  return 0;
}
