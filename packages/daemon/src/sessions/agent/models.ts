// The models the host's agent offers (DESIGN 0.6.0 D4, D7): the list every member may choose from, the host's own
// default, and the probe that asks Claude Code for both before any session has started.
//
//  - The list is Claude Code's `initialize` answer (`models[]`), mapped to the wire's `agentModelSchema`: the entry
//    `default` is left out (smurg's null IS "the host's default"), a Fable model is marked as one that may bill usage
//    credits, an entry the wire cannot carry is dropped. Every agent process hands its own answer over: the newest
//    answer wins. A change of the list or of the host's default is said once (`changed`: everyone gets `session.host`).
//  - The probe runs when a page asks for the host state and the list is not known (at most one at a time, not again
//    for a minute after a failure). It starts the binary the sessions use with EXACTLY the flags U1 E7 measured (the
//    runner's stream flags, a fresh `--session-id`, the ordinary profile flags, checked by the ordinary launch check),
//    in a private empty folder, with a settings file that switches every hook off (the host's own included: DESIGN R7,
//    test/sessions/models-claude-real.test.ts) and denies every tool that could change anything, no MCP server, the
//    host's user settings only. It asks `initialize` and `get_settings` (`applied.model`: the model a session that
//    names none runs on), closes stdin and ends what is left of its own process (its process group while it runs and
//    whatever carries its own `SMURG_SESSION_ID`, nothing else: ARCHITECTURE §0 rule 1). It sends no model request
//    (measured: only `HEAD /api/hello`), writes no transcript, never passes `--model`. The daemon's stop awaits it.
import { randomBytes, randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { AGENT_MODELS_MAX, MODEL_DESCRIPTION_MAX_CHARS, agentModelSchema, isWellFormedText, modelIdSchema, type AgentModel } from '@smurg/protocol';
import { ensurePrivateDirectory } from '@smurg/protocol/node';
import type { Logger } from '../../core/logger.ts';
import { writePrivateJson } from '../../hooks/settings-writer.ts';
import { ClaudeProcess, ControlError } from './claude-process.ts';
import { Normaliser } from './normalise.ts';
import { STREAM_ARGS, checkLaunchArgs } from './profiles.ts';

/** After a probe failed, the next one waits this long (DESIGN 0.6.0 D7). */
export const PROBE_RETRY_MS = 60_000;
/** After stdin is closed: how long the probe waits for Claude Code to exit by itself. */
export const PROBE_EXIT_MS = 5_000;
const PROBE_CONTROL_MS = 10_000;

/** The probe's folder under the workspace's session files: `<sessionFilesRoot>/<hex of "probe">` (no session id is that). */
export const PROBE_DIR_NAME = Buffer.from('probe', 'utf8').toString('hex');

/**
 * The probe's settings file: every hook off (the host's own user hooks included), nothing allowed, every tool that can
 * change something denied, bypass impossible, Claude Code's own default mode.
 */
export const PROBE_SETTINGS = Object.freeze({
  disableAllHooks: true,
  permissions: { allow: [], ask: [], deny: ['Bash', 'Edit', 'Write', 'WebFetch'], disableBypassPermissionsMode: 'disable', defaultMode: 'default' },
});

/** The probe's profile flags (after the stream flags and `--session-id`), as U1 E7 measured them. They pass checkLaunchArgs. */
export function probeFlags(files: { readonly settingsPath: string; readonly mcpConfigPath: string }): string[] {
  return ['--permission-mode', 'default', '--settings', files.settingsPath, '--mcp-config', files.mcpConfigPath, '--tools', 'Read', '--strict-mcp-config', '--setting-sources', 'user'];
}

const ONE_M = '[1m]';

/** A model id without the 1M-context suffix Claude Code keeps on it (`claude-sonnet-5-5[1m]`). */
export function withoutOneM(id: string): string {
  return id.toLowerCase().endsWith(ONE_M) ? id.slice(0, -ONE_M.length) : id;
}

/**
 * Whether an entry may be a Fable model by ANY of its names (R-SEC: a host-configured full id or a cloud ARN has no
 * `claude-fable` prefix). Claude Code bills Fable to usage credits on some plans without asking in an agent session
 * (U4); a false "may bill" only adds a line under the picker, a missed one hides a cost.
 */
export function mayBillUsageCredits(names: readonly (string | undefined)[]): boolean {
  return names.some((name) => name !== undefined && /fable/i.test(name));
}

// Control characters, bidi controls and lone surrogates are left out of a description (the wire refuses them).
// eslint-disable-next-line no-control-regex
const UNSHOWABLE = /[\u0000-\u001f\u007f-\u009f‪-‮⁦-⁩]/g;

function descriptionOf(value: unknown): string {
  if (typeof value !== 'string') return '';
  let text = value.replace(UNSHOWABLE, '');
  if (!isWellFormedText(text)) text = [...text].filter((char) => isWellFormedText(char)).join('');
  if (text.length <= MODEL_DESCRIPTION_MAX_CHARS) return text;
  let cut = text.slice(0, MODEL_DESCRIPTION_MAX_CHARS);
  // Never half of a surrogate pair at the end.
  if (!isWellFormedText(cut)) cut = cut.slice(0, -1);
  return cut;
}

/**
 * Claude Code's `initialize.models` → the wire's list (DESIGN 0.6.0 D7): `default` left out; `name` ← `displayName`;
 * `description` ← `description` (cut, unshowable characters out); `resolved` ← `resolvedModel` when it is a model id;
 * `auto` ← `supportsAutoMode === true`; `billing` for every spelling of Fable; an entry the wire cannot carry is
 * dropped (counted); at most AGENT_MODELS_MAX. Null when `raw` is no list (no answer to take).
 */
export function agentModelsOf(raw: unknown): { readonly models: AgentModel[]; readonly dropped: number } | null {
  if (!Array.isArray(raw)) return null;
  const models: AgentModel[] = [];
  let dropped = 0;
  const seen = new Set<string>();
  for (const item of raw) {
    const entry = typeof item === 'object' && item !== null ? (item as Record<string, unknown>) : {};
    const value = entry['value'];
    if (value === 'default') continue;
    const resolvedRaw = entry['resolvedModel'];
    const resolved = typeof resolvedRaw === 'string' && modelIdSchema.safeParse(resolvedRaw).success ? resolvedRaw : undefined;
    const name = entry['displayName'];
    const candidate = {
      value,
      name,
      description: descriptionOf(entry['description']),
      ...(resolved === undefined ? {} : { resolved }),
      auto: entry['supportsAutoMode'] === true,
      ...(mayBillUsageCredits([typeof value === 'string' ? value : undefined, typeof resolvedRaw === 'string' ? resolvedRaw : undefined, typeof name === 'string' ? name : undefined]) ? { billing: 'usage-credits' as const } : {}),
    };
    const parsed = agentModelSchema.safeParse(candidate);
    if (!parsed.success || seen.has(parsed.data.value) || models.length >= AGENT_MODELS_MAX) {
      dropped += 1;
      continue;
    }
    seen.add(parsed.data.value);
    models.push(parsed.data);
  }
  return { models, dropped };
}

/** What the probe needs of the sessions module (agent-sessions.ts fills it). */
export interface ModelProbeDeps {
  /** `<stateDir>/sessions` and `<stateDir>/sessions/<workspace key>` (sessionFilesRoot), each made private if missing. */
  readonly sessionsDir: string;
  readonly filesRoot: string;
  /** The binary the sessions use, checked as a session start checks it (found, not older than the floor); null: none can be used now. */
  binary(): Promise<string | null>;
  /** The probe's environment: the host's own, as a session's but without hook variables; `SMURG_SESSION_ID` is `marker`. */
  env(marker: string): Readonly<Record<string, string>>;
  /** Ends what is left of the probe: its own process group while its leader runs (`pid`), and whatever carries `marker`. */
  kill(target: { readonly pid: () => number | null; readonly marker: string }): Promise<void>;
  /** How long `initialize` may take (the sessions' own bound). */
  readonly initTimeoutMs: number;
}

export interface AgentModelsDeps {
  readonly log: Logger;
  readonly now: () => number;
  /** The list or the host's default changed (everyone is told: `session.host`). */
  readonly changed: () => void;
  /** The probe; null: none runs (the list comes only from the sessions' own `initialize`). */
  readonly probe: ModelProbeDeps | null;
}

/** The host agent's models (DESIGN 0.6.0 D7): the list, the host's default, the probe. */
export class AgentModels {
  private readonly deps: AgentModelsDeps;
  private models: AgentModel[] = [];
  private known = false;
  private hostDefault: string | null = null;
  private droppedLogged = false;
  private running: Promise<void> | null = null;
  /** The probe's process while it runs, with the marker its environment carries. */
  private current: { readonly proc: ClaudeProcess; readonly marker: string } | null = null;
  private failedAt: number | null = null;
  private stopping = false;

  constructor(deps: AgentModelsDeps) {
    this.deps = deps;
  }

  /** The list (copies), whether it is known, the host's default. */
  state(): { readonly models: AgentModel[]; readonly modelsKnown: boolean; readonly hostDefault: string | null } {
    return { models: this.models.map((entry) => ({ ...entry })), modelsKnown: this.known, hostDefault: this.hostDefault };
  }

  /**
   * The list entry of a model: the one whose `value` it is; for null (the host's default) the one whose `resolved` is
   * the host's default (both without `[1m]`). Undefined when the list does not hold it (or is not known).
   */
  entryFor(value: string | null): AgentModel | undefined {
    if (value !== null) return this.models.find((entry) => entry.value === value);
    const host = this.hostDefault;
    if (host === null) return undefined;
    return this.models.find((entry) => entry.resolved !== undefined && withoutOneM(entry.resolved) === withoutOneM(host));
  }

  /** An `initialize` answer's `models` (a session's or the probe's): the newest answer wins. */
  fromInitialize(raw: unknown): void {
    this.update(() => this.takeList(raw));
  }

  /** Applies `change`; says it once when what a member sees changed. */
  private update(change: () => void): void {
    const before = JSON.stringify([this.known, this.models, this.hostDefault]);
    change();
    if (JSON.stringify([this.known, this.models, this.hostDefault]) !== before) this.deps.changed();
  }

  private takeList(raw: unknown): void {
    const mapped = agentModelsOf(raw);
    if (mapped === null) return;
    if (mapped.dropped > 0 && !this.droppedLogged) {
      this.droppedLogged = true;
      this.deps.log.warn('the agent offers models smurg cannot show; they are left out', { dropped: mapped.dropped });
    }
    this.models = mapped.models;
    this.known = true;
  }

  /** A probe is running. */
  get probing(): boolean {
    return this.running !== null;
  }

  /** Resolves once no probe runs (never rejects). */
  settled(): Promise<void> {
    return this.running ?? Promise.resolve();
  }

  /** Starts the probe when the list is not known (one at a time; not for a minute after a failure). Never throws. */
  want(): void {
    if (this.known || this.running !== null || this.stopping || this.deps.probe === null) return;
    if (this.failedAt !== null && this.deps.now() - this.failedAt < PROBE_RETRY_MS) return;
    const probe = this.deps.probe;
    this.running = this.run(probe)
      .catch((err: unknown) => {
        this.failedAt = this.deps.now();
        if (!this.stopping) this.deps.log.warn('the host agent could not be asked which models it offers', { error: err instanceof Error ? `${err.name}: ${err.message.slice(0, 200)}` : 'unknown' });
      })
      .finally(() => {
        this.running = null;
      });
  }

  private async run(probe: ModelProbeDeps): Promise<void> {
    const file = await probe.binary();
    if (file === null) throw new Error('no usable claude');
    if (this.stopping) return;
    const dir = join(probe.filesRoot, PROBE_DIR_NAME);
    const cwd = join(dir, 'cwd');
    const marker = `smurg-probe-${randomBytes(8).toString('hex')}`;
    let proc: ClaudeProcess | null = null;
    try {
      // What an earlier probe left (the daemon died during it) goes first: the folder is empty when the probe starts.
      await rm(dir, { recursive: true, force: true });
      for (const level of [probe.sessionsDir, probe.filesRoot, dir, cwd]) await ensurePrivateDirectory(level);
      const settingsPath = join(dir, 'settings.json');
      const mcpConfigPath = join(dir, 'mcp.json');
      await writePrivateJson(dir, 'settings.json', PROBE_SETTINGS);
      await writePrivateJson(dir, 'mcp.json', { mcpServers: {} });
      const flags = probeFlags({ settingsPath, mcpConfigPath });
      const problem = checkLaunchArgs(flags);
      if (problem !== null) throw new Error(`the probe's flags were refused: ${problem}`);
      if (this.stopping) return;
      const normaliser = new Normaliser();
      const started: ClaudeProcess = new ClaudeProcess({
        file,
        args: [...STREAM_ARGS, '--session-id', randomUUID(), ...flags],
        cwd,
        env: probe.env(marker),
        stderrTailBytes: 4096,
        onLine: (line) => {
          const message = Normaliser.parse(line);
          if (message === null) return;
          for (const event of normaliser.normalise(message)) {
            if (event.kind === 'control.response') started.settleControl(event.requestId, event.ok, event.response, event.error, event.code);
            else if (event.kind === 'request.unsupported') started.respondError(event.requestId, `unsupported control request: ${event.subtype}`);
            else if (event.kind === 'request') started.respond(event.requestId, { behavior: 'deny', message: 'smurg only asks which models there are.' });
          }
        },
      });
      proc = started;
      this.current = { proc: started, marker };
      const init = await started.control({ subtype: 'initialize' }, probe.initTimeoutMs);
      let applied: unknown;
      try {
        const settings = await started.control({ subtype: 'get_settings' }, PROBE_CONTROL_MS);
        const appliedPart = typeof settings === 'object' && settings !== null ? (settings as Record<string, unknown>)['applied'] : undefined;
        applied = typeof appliedPart === 'object' && appliedPart !== null ? (appliedPart as Record<string, unknown>)['model'] : undefined;
      } catch (err) {
        // A version without `get_settings`: the list is still the list; the host's default stays unknown.
        if (!(err instanceof ControlError) || err.why === 'exit') throw err;
      }
      started.endInput();
      await started.waitExit(PROBE_EXIT_MS);
      if (this.stopping) return;
      const models = typeof init === 'object' && init !== null ? (init as Record<string, unknown>)['models'] : undefined;
      if (agentModelsOf(models) === null) throw new Error('the answer to initialize has no model list');
      this.failedAt = null;
      // The list and the host's default (`applied.model`: what a process that names no model runs on), said once.
      this.update(() => {
        this.hostDefault = typeof applied === 'string' && modelIdSchema.safeParse(applied).success ? applied : null;
        this.takeList(models);
      });
    } finally {
      if (proc !== null) {
        const ended = proc;
        await probe.kill({ pid: () => (ended.running ? (ended.pid ?? null) : null), marker }).catch((err: unknown) => this.deps.log.error('the probe of the host agent could not be ended', { error: err instanceof Error ? err.name : 'unknown' }));
        await ended.waitExit(2_000);
      }
      this.current = null;
      await rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  }

  /**
   * The daemon stops: a running probe is ended at once (its own process group and what carries its marker, nothing
   * else; an `initialize` that never comes is cut short by the exit) and awaited, its folder removed.
   */
  async stop(): Promise<void> {
    this.stopping = true;
    const current = this.current;
    if (current !== null && current.proc.running && this.deps.probe !== null) {
      const { proc, marker } = current;
      await this.deps.probe.kill({ pid: () => (proc.running ? (proc.pid ?? null) : null), marker }).catch((err: unknown) => this.deps.log.error('the probe of the host agent could not be ended', { error: err instanceof Error ? err.name : 'unknown' }));
    }
    await this.running;
  }
}
