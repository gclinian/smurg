// TEST ONLY: how a test uses the stand-in `claude` (fake-claude.mjs: the same control protocol on the pipes, a
// SCRIPT instead of a model, no network). Every package that needs an agent session to ask, edit, wait or stop on cue
// installs it into a scratch directory and points the daemon at it:
//
//   const claude = await installFakeClaude(scratch);
//   await claude.setScenario({ turns: [{ steps: [{ tool: 'Bash', input: { command: 'pnpm test' } }, { text: 'done' }] }] });
//   const t = await createTestDaemon({ modules: […, createSessionsModule({ hostEnv: () => ({ PATH: '/usr/bin:/bin', ...claude.env }), launch: { claudePath: claude.path, selfCommand } })], sessions: { selfCommand } });
//
// The scenario file is read again at every turn, so a test can change what the agent does next.
import { chmod, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** The stand-in itself (it has a shebang and the exec bit; `installFakeClaude` gives a wrapper that needs no `node` on PATH). */
export const FAKE_CLAUDE_SCRIPT = fileURLToPath(new URL('./fake-claude.mjs', import.meta.url));

export type FakeClaudeStep =
  | { readonly text: string; readonly deltas?: readonly string[]; readonly deltaMs?: number; readonly parent?: string; readonly synthetic?: boolean }
  | { readonly thinking: true; readonly ms?: number }
  | {
      readonly tool: string;
      readonly input?: Readonly<Record<string, unknown>>;
      /** Force a permission request (true) or none (false); default: the session's rules decide. */
      readonly ask?: boolean;
      /** The rule Claude Code would suggest with the request. */
      readonly suggest?: { readonly toolName: string; readonly ruleContent?: string };
      readonly result?: string;
      readonly structured?: Readonly<Record<string, unknown>>;
      readonly error?: string;
      /** Bash: run the command for real. */
      readonly run?: boolean;
      readonly id?: string;
      readonly parent?: string;
      readonly reason?: string;
      readonly reasonType?: string;
      readonly blockedPath?: string;
    }
  | { readonly sleep: number }
  | { readonly wait: 'interrupt' }
  | { readonly exit: number; readonly stderr?: string }
  | { readonly raw: Readonly<Record<string, unknown>> }
  | { readonly retry: { readonly error?: string; readonly status?: number; readonly attempt?: number; readonly max?: number } }
  | { readonly rateLimit: { readonly status: string; readonly resetsAt?: number } }
  | { readonly compact: true; readonly ms?: number }
  | { readonly result: Readonly<Record<string, unknown>> };

export interface FakeClaudeScenario {
  /** What `--version` prints and `init` reports (default 2.1.288). */
  readonly version?: string;
  /** `auth status --json` (default true). */
  readonly loggedIn?: boolean;
  /** `initialize.account` (`apiKeySource: 'none'`: every turn answers "Not logged in"). */
  readonly account?: { readonly apiKeySource?: string; readonly tokenSource?: string; readonly subscriptionType?: string };
  /** What `list_permission_rules` answers besides the rules of the session's own settings file. */
  readonly rules?: readonly { readonly behavior: 'allow' | 'deny' | 'ask'; readonly source: string; readonly rule: string }[];
  /** `list_permission_rules` is not a request this "version" knows. */
  readonly noRuleList?: boolean;
  /** Tools `init.tools` lists although `--tools` did not name them. */
  readonly extraTools?: readonly string[];
  /** The first turn whose `match` (a regex on the message text; none: any) fits answers a message; `once`: one time per conversation. */
  readonly turns?: readonly { readonly match?: string; readonly once?: boolean; readonly steps: readonly FakeClaudeStep[] }[];
}

export interface FakeClaude {
  /** The executable to give the daemon as `claudePath`. */
  readonly path: string;
  readonly scenarioPath: string;
  readonly echoPath: string;
  /** What the sessions' environment needs (`FAKE_CLAUDE_SCENARIO`, `FAKE_CLAUDE_ECHO`). */
  readonly env: Readonly<Record<string, string>>;
  setScenario(scenario: FakeClaudeScenario): Promise<void>;
  /** Everything the stand-in processes received so far (argv, role prompts, settings, every stdin line). */
  echoed(): Promise<{ readonly kind: 'argv' | 'settings' | 'role-prompt' | 'stdin'; readonly session: string | null; readonly value: unknown }[]>;
}

/** Writes a `claude` wrapper (this Node, the stand-in script) and an empty scenario into `dir`. */
export async function installFakeClaude(dir: string, scenario: FakeClaudeScenario = {}): Promise<FakeClaude> {
  const path = join(dir, 'claude');
  const scenarioPath = join(dir, 'fake-claude-scenario.json');
  const echoPath = join(dir, 'fake-claude-echo.jsonl');
  const quote = (text: string): string => `'${text.replaceAll("'", "'\\''")}'`;
  // The wrapper names the scenario itself, so `--version` and `auth status` answer from it in any environment (the
  // daemon probes the version with an environment built from nothing).
  await writeFile(
    path,
    [
      '#!/bin/sh',
      `: "\${FAKE_CLAUDE_SCENARIO:=${scenarioPath}}"`,
      `: "\${FAKE_CLAUDE_ECHO:=${echoPath}}"`,
      'export FAKE_CLAUDE_SCENARIO FAKE_CLAUDE_ECHO',
      `exec ${quote(process.execPath)} ${quote(FAKE_CLAUDE_SCRIPT)} "$@"`,
      '',
    ].join('\n'),
  );
  await chmod(path, 0o755);
  const setScenario = (next: FakeClaudeScenario): Promise<void> => writeFile(scenarioPath, JSON.stringify(next));
  await setScenario(scenario);
  await writeFile(echoPath, '');
  return {
    path,
    scenarioPath,
    echoPath,
    env: Object.freeze({ FAKE_CLAUDE_SCENARIO: scenarioPath, FAKE_CLAUDE_ECHO: echoPath }),
    setScenario,
    echoed: async () =>
      (await readFile(echoPath, 'utf8'))
        .split('\n')
        .filter((line) => line.length > 0)
        .map((line) => JSON.parse(line) as { kind: 'argv' | 'settings' | 'role-prompt' | 'stdin'; session: string | null; value: unknown }),
  };
}
