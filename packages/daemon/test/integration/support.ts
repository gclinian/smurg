// Shared by the integration tests: the REAL feature modules composed together (createTestDaemon without `modules`
// composes DEFAULT_FEATURE_MODULES, exactly what production runs) and driven by real clients. No fake at a seam
// between two modules: where a test needs an agent, it runs the real hook entry (`smurg hook` of the CLI) against the
// real hook socket, and the agent's "edit" is a real write on disk picked up by the real file watcher.
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { EventType, PayloadOf } from '@smurg/protocol';
import type { Connection } from '@smurg/protocol/client';

/** The `smurg` command as sessions run it in development (config.sessions.selfCommand = node + this file). */
export const CLI_MAIN = fileURLToPath(new URL('../../../cli/src/main.ts', import.meta.url));

/** Every payload of one d→c type, in arrival order. */
export function recorder<T extends EventType>(conn: Connection, type: T): PayloadOf<T>[] {
  const seen: PayloadOf<T>[] = [];
  conn.on(type as never, (payload: unknown) => seen.push(payload as PayloadOf<T>));
  return seen;
}

/** What Claude Code writes to a hook's stdin (claude-hooks.md §1.3), for the edit tools and the lifecycle events. */
export function hookInput(event: 'PreToolUse' | 'PostToolUse' | 'PostToolUseFailure' | 'UserPromptSubmit' | 'Stop', filePath: string | null, cwd: string, tool = 'Edit'): string {
  return JSON.stringify({
    session_id: '2e92a5cd-0000-4000-8000-000000000000',
    transcript_path: '/tmp/cfg/projects/x/2e92a5cd.jsonl',
    cwd,
    permission_mode: 'default',
    hook_event_name: event,
    ...(filePath === null
      ? {}
      : {
          tool_name: tool,
          tool_input: { file_path: filePath, old_string: 'export const a = 1;', new_string: 'export const a = 2;', replace_all: false },
          tool_use_id: `toolu_${Math.random().toString(36).slice(2, 12)}`,
        }),
  });
}

export interface HookRun {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly ms: number;
}

/**
 * Runs `node <cli>/src/main.ts hook` (the real entry Claude Code runs) with the session's hook environment and
 * `input` on stdin. Only the child this function spawned is ever signalled (on a 20 s timeout).
 */
export function runHook(env: Readonly<Record<string, string>>, input: string, cwd: string): Promise<HookRun> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const child = spawn(process.execPath, [CLI_MAIN, 'hook'], { cwd, env: { PATH: '/usr/bin:/bin', SMURG_NO_BROWSER: '1', SMURG_LANG: 'en', ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString('utf8')));
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString('utf8')));
    const timer = setTimeout(() => {
      child.kill('SIGKILL'); // our own child only
      reject(new Error('`smurg hook` did not exit within 20 s'));
    }, 20_000);
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr, ms: Date.now() - started });
    });
    child.stdin.end(input);
  });
}

/** The PreToolUse decision in a hook's stdout: null when it printed nothing (granted), else the deny reason. */
export function denyReason(run: HookRun): string | null {
  if (run.stdout.trim() === '') return null;
  const output = JSON.parse(run.stdout) as { hookSpecificOutput?: { hookEventName?: string; permissionDecision?: string; permissionDecisionReason?: string } };
  if (output.hookSpecificOutput?.hookEventName !== 'PreToolUse' || output.hookSpecificOutput.permissionDecision !== 'deny') {
    throw new Error(`unexpected hook output: ${run.stdout}`);
  }
  return output.hookSpecificOutput.permissionDecisionReason ?? '';
}

export const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Collects the raw bytes of one session's exec.output as text (for "did X appear in the terminal"). */
export function terminalText(conn: Connection, sessionId: string): { readonly text: () => string } {
  const decoder = new TextDecoder();
  let text = '';
  conn.on('exec.output', (payload) => {
    if (payload.sessionId === sessionId) text += decoder.decode(payload.data, { stream: true });
  });
  return { text: () => text };
}
