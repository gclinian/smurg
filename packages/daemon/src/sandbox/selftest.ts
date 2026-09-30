// The functional self-test (ARCHITECTURE §7.6 "Preflight"): before a guest process starts, a canary command runs
// through EXACTLY the same path as the session (the session's own policy, srt, the hardening, node-pty) and must
// prove from inside that the sandbox is really there:
//   20  SANDBOX_RUNTIME is not 1          (srt's env prefix did not run)
//   21  the canary file is readable       (it lives in the daemon state dir, which is denied)
//   22  the probe file could be written   (next to the canary)
//   23  the host home can be listed       (only checked when the home exists)
//   24  the own tty cannot be used        (macOS: allowPty + the own-tty rewrite; raw mode needs it)
//   25  the session root cannot be listed (the carve-outs do not work: the policy is wrong)
// and print a per-run nonce. Only then does the service hand out the real command. There is no fallback.
import { randomBytes } from 'node:crypto';
import { mkdir, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { shellQuote } from './harden.ts';

export interface PtyRunResult {
  readonly exitCode: number | null;
  readonly output: string;
  readonly timedOut: boolean;
}

export interface PtyRunInput {
  readonly file: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  readonly timeoutMs: number;
}

/** Runs a command on a fresh pty to completion (injectable: unit tests pass a fake). */
export interface PtyRunner {
  run(input: PtyRunInput): Promise<PtyRunResult>;
}

const MAX_OUTPUT_CHARS = 64 * 1024;

/**
 * node-pty, loaded lazily. On timeout only the child this runner spawned is killed (node-pty signals its own pid);
 * nothing else is ever signalled (ARCHITECTURE §0 rule 1).
 */
export function createNodePtyRunner(): PtyRunner {
  return {
    async run(input) {
      const pty = await import('node-pty');
      return new Promise<PtyRunResult>((resolve, reject) => {
        let child: ReturnType<typeof pty.spawn>;
        try {
          child = pty.spawn(input.file, [...input.args], { name: 'xterm-256color', cols: 80, rows: 24, cwd: input.cwd, env: { ...input.env } });
        } catch (err) {
          reject(err instanceof Error ? err : new Error(String(err)));
          return;
        }
        let output = '';
        let timedOut = false;
        const timer = setTimeout(() => {
          timedOut = true;
          child.kill('SIGKILL');
        }, input.timeoutMs);
        child.onData((data) => {
          if (output.length < MAX_OUTPUT_CHARS) output += data;
        });
        child.onExit(({ exitCode }) => {
          clearTimeout(timer);
          // onExit can fire before the last onData on macOS: give the reader a moment to drain.
          setTimeout(() => resolve({ exitCode: timedOut ? null : exitCode, output, timedOut }), 50);
        });
      });
    },
  };
}

export interface SelfTestPlan {
  /** The canary directory (inside the daemon state dir, denied by every guest policy). */
  readonly canaryDir: string;
  readonly secretPath: string;
  readonly probePath: string;
  readonly secret: string;
  readonly nonce: string;
}

/** Creates the canary files. The caller removes `canaryDir` afterwards (always). */
export async function prepareSelfTest(parentDir: string): Promise<SelfTestPlan> {
  const nonce = randomBytes(12).toString('hex');
  const canaryDir = join(parentDir, `selftest-${nonce}`);
  await mkdir(canaryDir, { recursive: true, mode: 0o700 });
  const secretPath = join(canaryDir, 'canary-secret');
  const probePath = join(canaryDir, 'canary-probe');
  const secret = `smurg-sandbox-canary-${randomBytes(12).toString('hex')}`;
  await writeFile(secretPath, `${secret}\n`, { mode: 0o600 });
  return { canaryDir, secretPath, probePath, secret, nonce };
}

export function selfTestScript(plan: SelfTestPlan, checks: { readonly hostHome: string | null; readonly root: string; readonly tty: boolean }): string {
  const q = shellQuote;
  return [
    'test "$SANDBOX_RUNTIME" = 1 || exit 20',
    `/bin/cat ${q(plan.secretPath)} >/dev/null 2>&1 && exit 21`,
    `(echo x > ${q(plan.probePath)}) 2>/dev/null && exit 22`,
    ...(checks.hostHome === null ? [] : [`/bin/ls ${q(checks.hostHome)} >/dev/null 2>&1 && exit 23`]),
    ...(checks.tty ? ['/bin/stty size >/dev/null 2>&1 || exit 24'] : []),
    `/bin/ls ${q(checks.root)} >/dev/null 2>&1 || exit 25`,
    `echo SMURG-SANDBOX-SELFTEST-OK-${plan.nonce}`,
  ].join('; ');
}

const FAILURES: Readonly<Record<number, string>> = {
  20: 'SANDBOX_RUNTIME was not set inside',
  21: 'the canary in the daemon state dir was readable',
  22: 'the probe next to the canary was writable',
  23: 'the host home could be listed',
  24: 'the session tty was not usable (pty rule)',
  25: 'the session root was not readable (carve-outs)',
  126: 'the launcher could not be executed',
  127: 'the launcher was not found',
};

/** Evaluates a run; returns null when it proves the sandbox, else an English reason for the host's log. */
export async function judgeSelfTest(plan: SelfTestPlan, result: PtyRunResult): Promise<string | null> {
  const probeLeaked = await stat(plan.probePath).then(
    () => true,
    () => false,
  );
  if (probeLeaked) {
    await rm(plan.probePath, { force: true });
    return 'the probe file was created from inside the sandbox';
  }
  if (result.output.includes(plan.secret)) return 'the canary content appeared in the output';
  if (result.timedOut) return 'the self-test did not finish in time';
  if (result.exitCode !== 0) return `exit ${result.exitCode}: ${FAILURES[result.exitCode ?? -1] ?? 'unexpected failure'}`;
  if (!result.output.includes(`SMURG-SANDBOX-SELFTEST-OK-${plan.nonce}`)) return 'the success marker is missing';
  return null;
}

/** Reads whether `path` exists as a directory (the host-home check is only meaningful for an existing home). */
export async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}
