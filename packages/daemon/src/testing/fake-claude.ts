// TEST ONLY: how a test uses the stand-in `claude` (fake-claude.mjs: the same control protocol on the pipes, a
// SCRIPT instead of a model, no network). Every package that needs an agent session to ask, edit, wait or stop on cue
// installs it into a scratch directory and points the daemon at it:
//
//   const claude = await installFakeClaude(scratch);
//   await claude.setScenario({ turns: [{ steps: [{ tool: 'Bash', input: { command: 'pnpm test' } }, { text: 'done' }] }] });
//   const t = await createTestDaemon({ modules: […, createSessionsModule({ hostEnv: () => ({ PATH: '/usr/bin:/bin', ...claude.env }), launch: { claudePath: claude.path, selfCommand } })], sessions: { selfCommand } });
//
// The scenario file is read again at every turn, so a test can change what the agent does next. What the stand-in
// knows of models and permission modes (0.6.0: `--model`, `set_model`, auto mode with its fast path and a scripted
// classifier, bypass, the error codes of 2.1.288) is in the header of fake-claude.mjs, each key with its evidence.
import { chmod, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** The stand-in itself (it has a shebang and the exec bit; `installFakeClaude` gives a wrapper that needs no `node` on PATH). */
export const FAKE_CLAUDE_SCRIPT = fileURLToPath(new URL('./fake-claude.mjs', import.meta.url));

export type FakeClaudeStep =
  | {
      readonly text: string;
      readonly deltas?: readonly string[];
      readonly deltaMs?: number;
      readonly parent?: string;
      readonly synthetic?: boolean;
      /** Claude Code's top-level `error` of an assistant line that an API error made (`model_not_found`, `authentication_failed`, …; U1 E4). */
      readonly apiError?: string;
    }
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
      /** In auto mode, what the stand-in's classifier answers for this call (instead of the scenario's `classifier`). */
      readonly auto?: 'allow' | 'block';
      /** The rule a block names (`decision_reason` "[<category>]"). */
      readonly category?: string;
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
  /**
   * The WHOLE `initialize.account` object, as Claude Code answers it (CLAUDE_ACCOUNTS has the recorded shapes).
   * Default: an API key in the environment. Without a key source and without a subscription every turn answers
   * "Not logged in".
   */
  readonly account?: Readonly<Record<string, string>>;
  /**
   * What `list_permission_rules` answers besides the rules of the session's own settings file and of the host's own
   * settings files (which the stand-in reads like the real one: `<home>/.claude/settings.json`, and in the session's
   * folder `.claude/settings.json` and `.claude/settings.local.json`).
   */
  readonly rules?: readonly { readonly behavior: 'allow' | 'deny' | 'ask'; readonly source: string; readonly rule: string }[];
  /** `list_permission_rules` is not a request this "version" knows. */
  readonly noRuleList?: boolean;
  /** Tools `init.tools` lists although `--tools` did not name them. */
  readonly extraTools?: readonly string[];
  /** The first turn whose `match` (a regex on the message text; none: any) fits answers a message; `once`: one time per conversation. */
  readonly turns?: readonly { readonly match?: string; readonly once?: boolean; readonly steps: readonly FakeClaudeStep[] }[];
  /** What `initialize.models` answers (default CLAUDE_MODELS_2_1_288); `--model` and `set_model` resolve through it. */
  readonly models?: readonly ClaudeModelEntry[];
  /** The model of a process started without `--model` (default 'claude-fake', which the list does not hold). */
  readonly defaultModel?: string;
  /**
   * Models the organization restricts (U4 N), by name or id: `set_model` to one answers `restricted_by_org`; started
   * with `--model` one, the default model runs instead and a `system/informational` line says so at the first turn.
   */
  readonly refuseSwitch?: readonly string[];
  /** Models the API refuses (U1 E4), by name or id: a turn answers `model_not_found`; stdin's end after it exits 1. */
  readonly refuseModels?: readonly string[];
  /** Auto mode's classifier: a call whose command (Bash) or input's JSON fits one of `block` is refused, naming `category`. Default: it allows. */
  readonly classifier?: { readonly block?: readonly string[]; readonly category?: string };
  /** A control request answered with this error (`code`: its `error_code`; none: no code, like 2.1.288's other errors). */
  readonly controlErrors?: Readonly<Record<string, { readonly error: string; readonly code?: string }>>;
  /**
   * Milliseconds between a turn's `command_lifecycle` `started` and its `system/init` line (default 0). 2.1.288 writes
   * them together; a busy machine may read them apart, and in between the session reads `idle` with nothing waiting.
   */
  readonly initAfterStartedMs?: number;
}

/** One entry of Claude Code's `initialize.models` (the SDK's ModelInfo). */
export interface ClaudeModelEntry {
  readonly value: string;
  readonly resolvedModel?: string;
  readonly displayName?: string;
  readonly description?: string;
  readonly supportsEffort?: boolean;
  readonly supportedEffortLevels?: readonly string[];
  readonly supportsAdaptiveThinking?: boolean;
  readonly supportsFastMode?: boolean;
  readonly supportsAutoMode?: boolean;
}

const EFFORTS = Object.freeze(['low', 'medium', 'high', 'xhigh', 'max']);

/**
 * `initialize.models` as Claude Code 2.1.288 answered it on the Anthropic API with an API key (recorded with the real
 * binary against the fake API, U1 E3, U4 A): the stand-in's default list (fake-claude.mjs holds the same five).
 * Haiku 4.5 is the one without auto mode.
 */
export const CLAUDE_MODELS_2_1_288: readonly ClaudeModelEntry[] = Object.freeze([
  Object.freeze({ value: 'default', resolvedModel: 'claude-opus-5-5', displayName: 'Default (recommended)', description: 'Use the default model (currently Opus 5.5) \u00b7 $4/$20 per Mtok', supportsEffort: true, supportedEffortLevels: EFFORTS, supportsAdaptiveThinking: true, supportsFastMode: true, supportsAutoMode: true }),
  Object.freeze({ value: 'opus', resolvedModel: 'claude-opus-5-5', displayName: 'Opus', description: 'Opus 5.5 \u00b7 Best for everyday, complex tasks \u00b7 $4/$20 per Mtok', supportsEffort: true, supportedEffortLevels: EFFORTS, supportsAdaptiveThinking: true, supportsFastMode: true, supportsAutoMode: true }),
  Object.freeze({ value: 'fable', resolvedModel: 'claude-fable-5-1', displayName: 'Fable', description: 'Fable 5.1 \u00b7 Most capable for your hardest and longest-running tasks \u00b7 $10/$50 per Mtok', supportsEffort: true, supportedEffortLevels: EFFORTS, supportsAdaptiveThinking: true, supportsAutoMode: true }),
  Object.freeze({ value: 'sonnet', resolvedModel: 'claude-sonnet-5-5', displayName: 'Sonnet', description: 'Sonnet 5.5 \u00b7 Efficient for routine tasks \u00b7 $2/$10 per Mtok', supportsEffort: true, supportedEffortLevels: EFFORTS, supportsAdaptiveThinking: true, supportsAutoMode: true }),
  Object.freeze({ value: 'haiku', resolvedModel: 'claude-haiku-4-5-20251001', displayName: 'Haiku', description: 'Haiku 4.5 \u00b7 Fastest for quick answers \u00b7 $1/$5 per Mtok' }),
]);

/** One answer of the stand-in's auto mode classifier (what `FakeClaude.classified` returns). */
export interface FakeClassifierEntry {
  readonly session: string | null;
  readonly tool: string;
  readonly input: unknown;
  readonly verdict: 'allow' | 'block';
  /** A block's `decision_reason` ("[<category>]"). */
  readonly reason?: string;
}

/**
 * `initialize.account` as Claude Code 2.1.288 answers it. `apiKey` and `loggedOut` were recorded with the real binary
 * against the fake API (dummy key, isolated home); `subscriptionMax` with a credential file that only looks like a
 * claude.ai login (the same set-up). The display names Claude Code has for `subscriptionType`: `Claude Pro`,
 * `Claude Max`, `Claude Team`, `Claude Enterprise`, `Claude API`.
 */
export const CLAUDE_ACCOUNTS = Object.freeze({
  apiKey: Object.freeze({ tokenSource: 'none', apiKeySource: 'ANTHROPIC_API_KEY', apiProvider: 'firstParty' }),
  loggedOut: Object.freeze({ tokenSource: 'none', apiProvider: 'firstParty' }),
  subscriptionMax: Object.freeze({ subscriptionType: 'Claude Max', apiProvider: 'firstParty' }),
});

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
  /**
   * Every file mention (`@path`) the stand-in processes EXPANDED, as the real CLI does for a user message that is not
   * marked `client_composed`: the file was read with no tool call. smurg marks every message, so this stays empty.
   */
  mentions(): Promise<{ readonly session: string | null; readonly path: string; readonly text: string }[]>;
  /** Every call the stand-in's auto mode classifier was asked about, in order (none: no call went to it). */
  classified(): Promise<FakeClassifierEntry[]>;
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
  type Entry = { kind: 'argv' | 'settings' | 'role-prompt' | 'stdin' | 'mention' | 'classifier'; session: string | null; value: unknown };
  const entries = async (): Promise<Entry[]> =>
    (await readFile(echoPath, 'utf8'))
      .split('\n')
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as Entry);
  await setScenario(scenario);
  await writeFile(echoPath, '');
  return {
    path,
    scenarioPath,
    echoPath,
    env: Object.freeze({ FAKE_CLAUDE_SCENARIO: scenarioPath, FAKE_CLAUDE_ECHO: echoPath }),
    setScenario,
    echoed: async () => (await entries()).filter((entry): entry is Entry & { kind: 'argv' | 'settings' | 'role-prompt' | 'stdin' } => entry.kind !== 'mention' && entry.kind !== 'classifier'),
    mentions: async () => (await entries()).filter((entry) => entry.kind === 'mention').map((entry) => ({ session: entry.session, ...(entry.value as { path: string; text: string }) })),
    classified: async () => (await entries()).filter((entry) => entry.kind === 'classifier').map((entry) => ({ session: entry.session, ...(entry.value as Omit<FakeClassifierEntry, 'session'>) })),
  };
}
