// One agent session's PROCESS SIDE (ARCHITECTURE §7.6 "Runner"; DESIGN §2.2, §2.3): the `claude` child, the message
// queue, the requests it has open, the turn that runs, the blocks that stream. It turns RunnerEvents (normalise.ts)
// into conversation events, bus events and answers on the pipe. What is shared between sessions (the log, watchers,
// records, limits, the account state, launch files) belongs to the service (agent-sessions.ts), reached through
// RunnerHost.
//
//              launch                          turn starts                      result
//   (record) ─────────▶ starting ──ready──▶ idle ───────────▶ running ─────────────────▶ idle
//                          │ fails            │ ▲               │  ▲                       │ park: idle, no open request
//                          ▼                  ▼ │ next message  ▼  │ answered / decided    ▼
//                       failed             parked           waiting-answer /            parked (no process; still `idle`)
//                                                           waiting-permission
//
// The runner records WHY it expects an exit (park, restart, end, stop); any other exit is a failure.
import { randomUUID } from 'node:crypto';
import { access } from 'node:fs/promises';
import { isAbsolute, resolve as resolvePath } from 'node:path';
import {
  DELTA_TEXT_MAX_BYTES,
  EVENT_TEXT_MAX_BYTES,
  STREAMING_BLOCKS_MAX,
  SmurgError,
  mask,
  noticeEvent,
  lineEvent,
  questionPartsSchema,
  rootRefEquals,
  shownAgentText,
  truncateToUtf8Bytes,
  type Actor,
  type AgentStatus,
  type ConversationEvent,
  type ConversationEventInput,
  type FileRef,
  type LoginState,
  type PayloadInputOf,
  type ProjectSettingsState,
  type Question,
  type StreamingBlock,
  type ToolView,
  type TurnOutcome,
  type UserRef,
} from '@smurg/protocol';
import { msg } from '@smurg/protocol/i18n';
import type { AgentsConfig } from '../../core/config.ts';
import type { DaemonContext } from '../../core/context.ts';
import type { AgentRequest, TurnMessage } from '../../core/interfaces.ts';
import { newId } from '../../core/lifecycle.ts';
import { ClaudeProcess, ControlError, type ClaudeExit } from './claude-process.ts';
import { hostRulesOf, type HostRule } from './host-rules.ts';
import { Normaliser, type RunnerEvent } from './normalise.ts';
import { STREAM_ARGS, claudeModeFor } from './profiles.ts';
import { conversationLostText, QUESTION_REFUSED_TEXT, REQUEST_WITHDRAWN_TEXT } from './prompts.ts';
import { PENDING_MESSAGES_MAX, type AgentRecord } from './store.ts';
import { buildToolResult, buildToolView, clip, editOf, safeId, suggestedRuleOf, toolName, toolPathOf, type Located } from './tool-view.ts';

/** Everything one spawn needs; built by the service (hook registration, profile, launch files, the launch check). */
export interface LaunchPlan {
  readonly file: string;
  /** The profile flags (HookServer.writeSessionFiles), checked by the launch check. */
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  /** The profile's tool list (a tool outside it that `init.tools` shows is logged once). */
  readonly tools: readonly string[];
  readonly trust: ProjectSettingsState;
}

/** A message for the agent: what is written on the pipe, and what the turn that takes it reports. */
export interface Outgoing {
  readonly uuid: string;
  readonly messageId: string;
  /** Header + text (frameMessage). */
  readonly text: string;
  readonly turn: TurnMessage;
  /** The member who wrote it (a person's message), for cancelQueued. */
  readonly fromUserId: string | null;
}

export interface RunnerHost {
  readonly ctx: DaemonContext;
  readonly config: AgentsConfig;
  append(runner: AgentRunner, input: ConversationEventInput, sync?: boolean): ConversationEvent;
  /** The session's wire state changed (`noteworthy`: a turn end, a card, a failure). */
  publish(runner: AgentRunner, options?: { readonly noteworthy?: boolean }): void;
  save(runner: AgentRunner): void;
  processChanged(runner: AgentRunner, reason: 'started' | 'parked' | 'failed' | 'ended'): void;
  /** Throws SmurgError when the start is refused (no claude, too old, logged out, the limits, no hook command). */
  prepareLaunch(runner: AgentRunner): Promise<LaunchPlan>;
  /** The process is gone: its hook token and launch files go. */
  releaseLaunch(runner: AgentRunner): void;
  /** Ends the session's processes: its `claude` child (when it has one) and what its commands left running. */
  kill(runner: AgentRunner): Promise<void>;
  /** A `session.delta` to the live watchers; the number of channels reached, or -1 when nobody watches live. */
  delta(runner: AgentRunner, payload: Omit<PayloadInputOf<'session.delta'>, 'sessionId'>): number;
  account(runner: AgentRunner, signal: { readonly kind: 'ok' } | { readonly kind: 'logged-out' } | { readonly kind: 'usage-limit'; readonly resetsAt?: number }): void;
  /** The host's own allow rules this runner's process reported at its start (they depend on the root it runs in). */
  hostRules(runner: AgentRunner, rules: readonly HostRule[]): void;
  /** `initialize` reported a personal subscription login. */
  personalSubscription(): void;
  agentActor(runner: AgentRunner): Actor;
  /** The session's root is gone (its worktree was removed): it cannot continue. */
  rootGone(runner: AgentRunner): void;
  /** Resident memory of a pid in bytes, or null. */
  rss(pid: number): Promise<number | null>;
  /** An idle moment: the service may park the process (memory, a pending restart). */
  idle(runner: AgentRunner): void;
}

interface OpenRequest {
  readonly id: string;
  readonly claudeRequestId: string;
  readonly kind: 'question' | 'permission';
  readonly tool: string;
  readonly toolUseId: string;
  readonly input: unknown;
  readonly verb: ToolView['verb'] | null;
  readonly command?: string;
}

interface Block {
  readonly blockId: string;
  readonly turnId: string;
  text: string;
  /** UTF-16 units of the block's MASKED text the live watchers have. */
  sent: number;
  readonly parent?: string;
}

interface Turn {
  readonly id: string;
  readonly startedAt: number;
  readonly messages: TurnMessage[];
  readonly edited: { file: FileRef; seq: number }[];
  finalText?: string;
  blocks: number;
}

interface ToolCall {
  readonly view: ToolView;
  readonly turnId: string;
  readonly startedAt: number;
  readonly seq: number;
  /** A permission request of this call was allowed by a person or the daemon. */
  decidedBy?: string;
}

type Expected = 'park' | 'restart' | 'end' | 'stop';
const AUDITED_VERBS: ReadonlySet<string> = new Set(['run', 'fetch', 'other']);
const NOT_LOGGED_IN = /not logged in|\/login/i;
const NO_CONVERSATION = /No conversation found/i;
const ALREADY_IN_USE = /already in use/i;
const CONTROL_MS = 10_000;

export class AgentRunner {
  readonly record: AgentRecord;
  /** The exact bytes of role.md. */
  rolePrompt: string;
  login: LoginState = 'unknown';
  /** The root's project settings state at the last process start. */
  projectSettings: ProjectSettingsState = 'none';
  doing: 'compacting' | undefined;
  waitingSince: number | undefined;
  /** When the session last became idle (parking after `parkAfterMs`). */
  idleSince: number;
  /** Park at the next idle moment (a rule went, a decision about the root, a host setting, a member asked). */
  restartPending = false;
  /** The account problem this session ran into (the workspace's account state counts them). */
  blockedBy: 'logged-out' | 'usage-limit' | null = null;

  private readonly host: RunnerHost;
  private proc: ClaudeProcess | null = null;
  private phase: 'none' | 'starting' | 'ready' = 'none';
  private launching: Promise<void> | null = null;
  private expected: Expected | null = null;
  private normaliser = new Normaliser();
  private lines: Promise<void> = Promise.resolve();
  private queue: Outgoing[] = [];
  /** Written to the process and not completed yet (uuid → message; `started`: a turn took it). */
  private readonly written = new Map<string, Outgoing & { started: boolean; state: string }>();
  /** The message ids of `record.pending` as it was saved last. */
  private pendingKey = '';
  private readonly open = new Map<string, OpenRequest>();
  private turn: Turn | null = null;
  /** Messages a turn took before its `init` arrived. */
  private nextTurnMessages: TurnMessage[] = [];
  private readonly blocks = new Map<string, Block>();
  private readonly tools = new Map<string, ToolCall>();
  private deltaTimer: ReturnType<typeof setTimeout> | undefined;
  private thinking: { blockId: string; parent?: string } | null = null;
  private stopBy: UserRef | null = null;
  private stopping = false;
  private sawInit = false;
  private resultsThisProcess = 0;
  private unparsedLogged = false;
  private rewrittenLogged = false;
  /** A process of this session ran in this run of the daemon (its commands may have left something running). */
  private hadProcess = false;
  private planTools: readonly string[] = [];
  private readonly unknownTools = new Set<string>();
  private rateNoticeSaid = false;
  private turnWaiters: (() => void)[] = [];
  private triedResume = false;

  constructor(host: RunnerHost, record: AgentRecord, rolePrompt: string) {
    this.host = host;
    this.record = record;
    this.rolePrompt = rolePrompt;
    this.idleSince = host.ctx.clock.now();
    // What waited when the daemon went away still waits: the next start of the process delivers it, in order.
    this.queue = (record.pending ?? []).map((entry) => ({ uuid: randomUUID(), messageId: entry.messageId, text: entry.text, turn: entry.turn, fromUserId: entry.fromUserId }));
    this.pendingKey = this.queue.map((entry) => entry.messageId).join(',');
  }

  get id(): string {
    return this.record.id;
  }

  get hasProcess(): boolean {
    return this.phase !== 'none';
  }

  get pid(): number | null {
    return this.proc !== null && this.proc.running ? (this.proc.pid ?? null) : null;
  }

  get runningSince(): number | undefined {
    return this.turn?.startedAt;
  }

  get turnOpen(): boolean {
    return this.turn !== null;
  }

  get openRequests(): number {
    return this.open.size;
  }

  /** Idle with a process and nothing open: it may be parked. */
  get parkable(): boolean {
    return this.phase === 'ready' && this.turn === null && this.open.size === 0 && this.written.size === 0 && this.queue.length === 0;
  }

  /** The wire's AgentStatus, derived (DESIGN §2.2). */
  status(): AgentStatus {
    const record = this.record;
    if (record.state === 'ended') return 'ended';
    if (record.state === 'failed') return 'failed';
    if (this.phase === 'starting') return 'starting';
    let question = false;
    for (const request of this.open.values()) {
      if (request.kind === 'permission') return 'waiting-permission';
      question = true;
    }
    if (question) return 'waiting-answer';
    if (this.turn !== null) return 'running';
    if (record.itemState?.stalled !== undefined) return 'stalled';
    if (record.itemState?.reportRegistered === true) return 'done';
    return 'idle';
  }

  streaming(): StreamingBlock[] {
    return [...this.blocks.values()].slice(-STREAMING_BLOCKS_MAX).map((block) => ({
      turnId: block.turnId,
      blockId: block.blockId,
      text: clip(shownText(block.text.slice(0, streamableLength(block.text))), EVENT_TEXT_MAX_BYTES).text,
      ...(block.parent === undefined ? {} : { parentToolUseId: block.parent }),
    }));
  }

  // ---- messages -----------------------------------------------------------------------------------------------------

  /** Writes the message to the process, or queues it and starts one. Returns true when it had to be queued. */
  send(message: Outgoing): boolean {
    if (this.phase === 'ready' && this.proc !== null && this.queue.length === 0) {
      this.write(message);
      this.rememberPending();
      return false;
    }
    this.queue.push(message);
    this.rememberPending();
    void this.launch();
    return true;
  }

  /**
   * Keeps what no turn has taken yet in the record (written to a process that has not started it, then what waits
   * for a process), so a stop or a death of the daemon loses none of it. Saved only when the list changed.
   */
  private rememberPending(): void {
    const waiting: Outgoing[] = [...[...this.written.values()].filter((sent) => !sent.started), ...this.queue].slice(0, PENDING_MESSAGES_MAX);
    const key = waiting.map((entry) => entry.messageId).join(',');
    if (key === this.pendingKey) return;
    this.pendingKey = key;
    if (waiting.length === 0) delete this.record.pending;
    else this.record.pending = waiting.map((entry) => ({ messageId: entry.messageId, text: entry.text, turn: { ...entry.turn }, fromUserId: entry.fromUserId }));
    this.host.save(this);
  }

  /**
   * Every message is written with `client_composed: true`: smurg composed it (a header line, then text that may be
   * another member's), so Claude Code must deliver it as written. Without the field the CLI treats the text as typed
   * at its own prompt and expands every `@path` in it: the file's content goes to the model with no tool call (no
   * PreToolUse hook, so the gate never sees it; no permission request, so no card and no host-only check), also for a
   * file outside the project (verified with 2.1.288: test/sessions/agent-claude-real.test.ts). It also keeps the CLI
   * from running a message as a slash command, whatever its first character.
   */
  private write(message: Outgoing): void {
    this.written.set(message.uuid, { ...message, started: false, state: 'written' });
    this.proc?.write({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: message.text }] }, parent_tool_use_id: null, uuid: message.uuid, client_composed: true });
  }

  /** Drops that member's messages that no process has yet; returns their ids. */
  cancelQueued(userId: string): string[] {
    const mine = this.queue.filter((entry) => entry.fromUserId === userId);
    if (mine.length === 0) return [];
    this.queue = this.queue.filter((entry) => !mine.includes(entry));
    for (const entry of mine) this.host.append(this, { kind: 'delivery', messageId: entry.messageId, state: 'cancelled' });
    this.rememberPending();
    return mine.map((entry) => entry.messageId);
  }

  /** The running turn holds a message of that member that Claude Code has not started yet. */
  holdsUndelivered(userId: string): boolean {
    for (const entry of this.written.values()) if (entry.fromUserId === userId && !entry.started) return true;
    return false;
  }

  // ---- the process --------------------------------------------------------------------------------------------------

  /** Starts a process when there is none (a start, the next message, "Try again"). Never rejects: a failure is the session's state. */
  launch(): Promise<void> {
    if (this.record.state === 'ended' || this.stopping) return Promise.resolve();
    if (this.launching !== null) return this.launching;
    if (this.proc !== null) return Promise.resolve();
    const wasFailed = this.record.state === 'failed';
    this.phase = 'starting';
    if (wasFailed) this.record.state = 'live';
    this.host.processChanged(this, 'started');
    this.host.publish(this);
    this.launching = this.spawn()
      .catch((err: unknown) => this.launchFailed(err))
      .finally(() => {
        this.launching = null;
      });
    return this.launching;
  }

  /** Starts a process once the launch that is still settling (its process just went away) is over. */
  private launchSoon(): void {
    void (this.launching ?? Promise.resolve()).then(() => this.launch());
  }

  private async spawn(): Promise<void> {
    const host = this.host;
    const plan = await host.prepareLaunch(this);
    if (this.record.state === 'ended' || this.stopping) {
      host.releaseLaunch(this);
      this.phase = 'none';
      return;
    }
    this.projectSettings = plan.trust;
    this.normaliser = new Normaliser();
    this.sawInit = false;
    this.resultsThisProcess = 0;
    this.expected = null;
    const resume = this.record.hasConversation;
    this.planTools = plan.tools;
    const args = [...STREAM_ARGS, resume ? '--resume' : '--session-id', this.record.claudeSessionId, ...plan.args];
    const proc = new ClaudeProcess({
      file: plan.file,
      args,
      cwd: plan.cwd,
      env: plan.env,
      stderrTailBytes: host.config.stderrTailBytes,
      onLine: (line) => this.onLine(proc, line),
      onOversizedLine: () => host.ctx.log.warn('a line of the agent was too long and was dropped', { session: this.id }),
    });
    this.proc = proc;
    this.hadProcess = true;
    void proc.exited.then((exit) => this.onExit(proc, exit, plan));
    let init: unknown;
    try {
      init = await proc.control({ subtype: 'initialize' }, host.config.initTimeoutMs);
    } catch (err) {
      if (err instanceof ControlError && err.why === 'exit') return; // onExit classifies it
      // No answer: the process is of no use. onExit sees an expected end and the failure is reported here.
      this.expected = 'end';
      await host.kill(this);
      await proc.waitExit(2_000);
      this.failed(null, 'init-timeout');
      return;
    }
    if (this.proc !== proc) return;
    const account = typeof init === 'object' && init !== null ? (init as Record<string, unknown>)['account'] : null;
    if (typeof account === 'object' && account !== null) {
      const login = loginOfAccount(account as Record<string, unknown>);
      this.setLogin(login.state);
      if (login.personalSubscription) host.personalSubscription();
    }
    // The host's own allow rules (they apply; the host is told once). A version without the request: nothing is reported.
    try {
      host.hostRules(this, hostRulesOf(await proc.control({ subtype: 'list_permission_rules' }, CONTROL_MS)));
    } catch {
      // not available on this version: fine
    }
    if (this.proc !== proc || !proc.running) return;
    this.phase = 'ready';
    this.idleSince = host.ctx.clock.now();
    if (this.projectSettings === 'ignored' && !this.record.untrustedSaid) {
      this.record.untrustedSaid = true;
      host.append(this, noticeEvent('warning', msg('session.projectSettings.untrusted'), 'restart-agent'));
    }
    if (this.projectSettings !== 'ignored') this.record.untrustedSaid = false;
    host.save(this);
    host.publish(this);
    const queued = this.queue;
    this.queue = [];
    for (const message of queued) this.write(message);
    if (queued.length === 0) host.idle(this);
  }

  private launchFailed(err: unknown): void {
    // A refusal before the spawn (no claude, too old, logged out, a limit, no hook command).
    const host = this.host;
    this.proc = null;
    this.phase = 'none';
    host.releaseLaunch(this);
    if (this.record.state === 'ended') return;
    const text = err instanceof SmurgError && err.text !== undefined ? err.text : msg('session.claude.initTimeout');
    if (!(err instanceof SmurgError)) host.ctx.log.error('agent launch failed', { session: this.id, error: err instanceof Error ? err.name : 'unknown' });
    this.record.state = 'failed';
    this.record.startFailures += 1;
    host.append(this, noticeEvent('error', text, 'retry'), true);
    host.save(this);
    host.processChanged(this, 'failed');
    host.publish(this, { noteworthy: true });
  }

  /**
   * The process is gone: what it had not started yet waits for the next one (queued again); what a turn took is part
   * of the conversation Claude Code keeps.
   */
  private requeueWritten(): void {
    const back: Outgoing[] = [];
    for (const sent of this.written.values()) {
      if (!sent.started) back.push({ uuid: randomUUID(), messageId: sent.messageId, text: sent.text, turn: sent.turn, fromUserId: sent.fromUserId });
    }
    this.written.clear();
    if (back.length === 0) return;
    this.queue.unshift(...back);
    for (const message of back) this.host.append(this, { kind: 'delivery', messageId: message.messageId, state: 'queued' });
  }

  /** The process is gone and nobody asked for it. */
  private failed(code: number | null, why: 'exit' | 'init-timeout'): void {
    const host = this.host;
    this.proc = null;
    this.phase = 'none';
    host.releaseLaunch(this);
    if (this.record.state === 'ended') return;
    this.withdrawAll('failed', undefined);
    this.closeTurn('error');
    this.requeueWritten();
    this.record.state = 'failed';
    if (this.resultsThisProcess === 0) this.record.startFailures += 1;
    host.append(this, why === 'init-timeout' ? noticeEvent('error', msg('session.claude.initTimeout'), 'retry') : noticeEvent('error', msg('notice.processExited', { code: code ?? -1 }), 'retry'), true);
    host.save(this);
    host.processChanged(this, 'failed');
    host.publish(this, { noteworthy: true });
  }

  private onExit(proc: ClaudeProcess, exit: ClaudeExit, _plan: LaunchPlan): void {
    if (this.proc !== proc) return;
    const host = this.host;
    const expected = this.expected;
    this.expected = null;
    this.clearStreaming();
    // The lines printed before the exit are handled first.
    void this.lines.then(() => {
      if (this.proc !== proc) return;
      if (expected === 'park' || expected === 'restart') {
        this.proc = null;
        this.phase = 'none';
        this.restartPending = false;
        host.releaseLaunch(this);
        this.withdrawAll('stopped', undefined);
        this.closeTurn('interrupted');
        this.requeueWritten();
        host.processChanged(this, 'parked');
        host.publish(this);
        // A message that arrived while the process went away starts the next one.
        if (this.queue.length > 0) this.launchSoon();
        return;
      }
      if (expected === 'end' || expected === 'stop') {
        this.proc = null;
        this.phase = 'none';
        host.releaseLaunch(this);
        return;
      }
      const stderr = proc.stderrTail();
      if (this.record.hasConversation && this.resultsThisProcess === 0 && NO_CONVERSATION.test(stderr)) {
        // Claude Code removed its transcript: a new conversation, told to read the files again.
        this.proc = null;
        this.phase = 'none';
        host.releaseLaunch(this);
        this.requeueWritten();
        this.record.claudeSessionId = randomUUID();
        this.record.hasConversation = false;
        host.append(this, lineEvent(msg('session.resume.lost')));
        host.save(this);
        host.processChanged(this, 'parked');
        this.sendLost();
        return;
      }
      if (!this.record.hasConversation && this.resultsThisProcess === 0 && ALREADY_IN_USE.test(stderr) && !this.triedResume) {
        // The daemon died (or the process did) during the first turn: Claude Code has the conversation although no
        // `result` was ever seen. The flag follows what Claude Code says; tried once.
        this.triedResume = true;
        this.proc = null;
        this.phase = 'none';
        host.releaseLaunch(this);
        this.requeueWritten();
        this.record.hasConversation = true;
        host.save(this);
        host.processChanged(this, 'parked');
        this.launchSoon();
        return;
      }
      host.ctx.log.warn('an agent process ended unexpectedly', { session: this.id, code: exit.code ?? -1, signal: exit.signal ?? 'none', stderr: mask(stderr).slice(-2_000) });
      this.failed(exit.code, 'exit');
    });
  }

  /** The fixed message after a lost conversation, in front of whatever waits. */
  private sendLost(): void {
    const { ctx } = this.host;
    const messageId = newId('m');
    const text = conversationLostText(this.record.topic?.slug);
    this.host.append(this, { kind: 'smurg', messageId, purpose: 'conversation-lost', text });
    ctx.audit.record({ actor: { kind: 'system' }, action: 'smurg.message', outcome: 'ok', target: this.id, detail: { sessionId: this.id, messageId, purpose: 'conversation-lost' } });
    this.queue.unshift({ uuid: randomUUID(), messageId, text: `[smurg ${this.record.smurgTag}]\n${text}`, turn: { messageId, kind: 'smurg', purpose: 'conversation-lost' }, fromUserId: null });
    this.rememberPending();
    this.host.append(this, { kind: 'delivery', messageId, state: 'queued' });
    this.launchSoon();
  }

  /** Parks the process when the session is idle with nothing open: closes stdin and expects exit 0. True when it went (or there was none). */
  async park(why: 'park' | 'restart' = 'park'): Promise<boolean> {
    const proc = this.proc;
    if (proc === null || this.phase === 'none') return true;
    if (!this.parkable) return false;
    this.expected = why;
    proc.endInput();
    if ((await proc.waitExit(this.host.config.endGraceMs)) === null) {
      await this.host.kill(this);
      await proc.waitExit(2_000);
    }
    await this.lines;
    return this.proc === null;
  }

  /** Park now when idle, else at the next idle moment. */
  async restart(): Promise<void> {
    if (this.phase === 'none') return;
    this.restartPending = true;
    if (this.parkable) await this.park('restart');
  }

  /** "Stop": ends the running turn; the open requests are withdrawn with `by`. Resolves when the turn is over (bounded). */
  async interrupt(by: UserRef | null): Promise<void> {
    const proc = this.proc;
    if (proc === null || this.phase !== 'ready' || (this.turn === null && this.open.size === 0)) {
      this.withdrawAll('stopped', by ?? undefined);
      return;
    }
    this.stopBy = by;
    try {
      await proc.control({ subtype: 'interrupt' }, CONTROL_MS);
    } catch {
      // the process went away, or does not answer: the exit path closes the turn
    }
    this.withdrawAll('stopped', by ?? undefined);
    if (this.turn !== null) await this.turnEnded(5_000);
    this.stopBy = null;
  }

  private turnEnded(ms: number): Promise<void> {
    if (this.turn === null) return Promise.resolve();
    return new Promise<void>((resolve) => {
      const timer = setTimeout(done, ms);
      timer.unref?.();
      const waiters = this.turnWaiters;
      function done(): void {
        clearTimeout(timer);
        const at = waiters.indexOf(done);
        if (at !== -1) waiters.splice(at, 1);
        resolve();
      }
      waiters.push(done);
    });
  }

  /** Control `set_permission_mode` for the running process (the record keeps the mode for the next start). */
  async setClaudeMode(mode: 'default' | 'acceptEdits'): Promise<void> {
    if (this.proc === null || this.phase !== 'ready') return;
    try {
      await this.proc.control({ subtype: 'set_permission_mode', mode }, CONTROL_MS);
    } catch (err) {
      this.host.ctx.log.warn('the agent did not take the permission mode; it applies at its next start', { session: this.id, error: err instanceof Error ? err.name : 'unknown' });
      this.restartPending = true;
    }
  }

  /**
   * Ends the process for good (`end`) or for a daemon stop (`stop`: the record stays as it is). Interrupt, close stdin,
   * wait for exit 0, then the kill (always: see below).
   */
  async shutdown(why: 'end' | 'stop', by: UserRef | undefined): Promise<void> {
    this.stopping = why === 'stop';
    const proc = this.proc;
    const launching = this.launching;
    const wasRunning = this.turn !== null;
    this.expected = why;
    if (why === 'end') this.withdrawAll('ended', by);
    else this.open.clear(); // a daemon stop withdraws nothing on the bus: the conversation module does it at its next start
    if (proc !== null && proc.running) {
      if (this.turn !== null && this.phase === 'ready') await proc.control({ subtype: 'interrupt' }, 2_000).catch(() => {});
      proc.endInput();
      await proc.waitExit(this.host.config.endGraceMs);
    }
    // ALWAYS the kill, also when Claude Code went by itself (it does, as soon as its input closes) and when the
    // session has no process any more (parked): what its commands left running (a dev server, a watcher) ends with
    // the session, as a terminal's does. A daemon stop does it for the sessions that had a process in this run.
    if (why === 'end' || this.hadProcess) {
      await this.host.kill(this);
      if (proc !== null && proc.running) await proc.waitExit(2_000);
    }
    await launching?.catch(() => {});
    await this.lines;
    if (this.turn !== null) {
      this.stopBy = why === 'end' ? (by ?? null) : null;
      this.closeTurn('interrupted');
      this.stopBy = null;
    }
    // smurg stopped while the agent worked: the conversation says why the turn ended.
    if (why === 'stop' && wasRunning) this.host.append(this, lineEvent(msg('conversation.interrupted.restart')), true);
    this.clearStreaming();
    const had = this.phase !== 'none' || this.proc !== null;
    this.proc = null;
    this.phase = 'none';
    this.host.releaseLaunch(this);
    if (had && why === 'end') this.host.processChanged(this, 'ended');
    if (why === 'end') {
      for (const entry of this.queue) this.host.append(this, { kind: 'delivery', messageId: entry.messageId, state: 'cancelled' });
      this.queue = [];
      this.written.clear();
    }
    // A daemon stop keeps what waits (the record has it); an end keeps nothing.
    this.rememberPending();
  }

  // ---- requests -----------------------------------------------------------------------------------------------------

  private take(requestId: string): OpenRequest {
    const request = this.open.get(requestId);
    if (request === undefined) throw new SmurgError('conflict', undefined, { reason: 'withdrawn' });
    this.open.delete(requestId);
    return request;
  }

  private settled(): void {
    if (this.open.size === 0) this.waitingSince = undefined;
    this.host.publish(this);
  }

  answerQuestion(requestId: string, answer: { readonly answers: Readonly<Record<string, string>>; readonly notes: Readonly<Record<string, string>> }): void {
    const known = this.open.get(requestId);
    if (known !== undefined && known.kind !== 'question') throw new SmurgError('bad_request', undefined, { reason: 'not-a-question' });
    const request = this.take(requestId);
    const input = typeof request.input === 'object' && request.input !== null ? (request.input as Record<string, unknown>) : {};
    const annotations: Record<string, { notes: string }> = {};
    for (const [question, note] of Object.entries(answer.notes)) if (note.length > 0) annotations[question] = { notes: note };
    this.proc?.respond(request.claudeRequestId, {
      behavior: 'allow',
      updatedInput: { questions: input['questions'], answers: { ...answer.answers }, ...(Object.keys(annotations).length > 0 ? { annotations } : {}) },
    });
    this.settled();
  }

  decide(requestId: string, decision: { readonly allow: true; readonly sessionRule?: { readonly tool: string; readonly pattern: string } } | { readonly allow: false; readonly message: string }): void {
    const known = this.open.get(requestId);
    if (known !== undefined && known.kind === 'question' && decision.allow) throw new SmurgError('bad_request', undefined, { reason: 'not-a-permission' });
    const request = this.take(requestId);
    if (!decision.allow) {
      this.proc?.respond(request.claudeRequestId, { behavior: 'deny', message: decision.message });
      this.settled();
      return;
    }
    const call = this.tools.get(request.toolUseId);
    if (call !== undefined) call.decidedBy = request.id;
    this.proc?.respond(request.claudeRequestId, {
      behavior: 'allow',
      updatedInput: request.input,
      // Claude Code's own suggestion targets `localSettings` (a file in the shared project): never echoed. Ours goes to the session.
      ...(decision.sessionRule === undefined ? {} : { updatedPermissions: [{ type: 'addRules', rules: [{ toolName: decision.sessionRule.tool, ruleContent: decision.sessionRule.pattern }], behavior: 'allow', destination: 'session' }] }),
    });
    if (request.verb !== null && AUDITED_VERBS.has(request.verb)) this.auditCommand(request.toolUseId, request.verb, `decision:${request.id}`, request.command);
    this.settled();
  }

  private withdrawAll(reason: 'stopped' | 'ended' | 'failed', by: UserRef | undefined): void {
    if (this.open.size === 0) return;
    const requests = [...this.open.values()];
    this.open.clear();
    this.waitingSince = undefined;
    for (const request of requests) {
      // The CLI may still wait for an answer (an end, a stop it has not withdrawn yet): it must not hang.
      if (reason !== 'failed') this.proc?.respond(request.claudeRequestId, { behavior: 'deny', message: REQUEST_WITHDRAWN_TEXT });
      this.host.ctx.bus.emit('agent.request.withdrawn', { sessionId: this.id, requestId: request.id, reason, ...(by === undefined ? {} : { by }) });
    }
    this.host.publish(this);
  }

  private auditCommand(toolUseId: string, verb: string, why: string, command: string | undefined): void {
    this.host.ctx.audit.record({
      actor: this.host.agentActor(this),
      action: 'agent.command',
      outcome: 'ok',
      target: this.id,
      detail: { sessionId: this.id, toolUseId: safeId(toolUseId, 'tu'), verb, why, ...(command === undefined ? {} : { command }) },
      fullText: ['command'],
    });
  }

  // ---- stdout -------------------------------------------------------------------------------------------------------

  private onLine(proc: ClaudeProcess, line: string): void {
    const message = Normaliser.parse(line);
    if (message === null) {
      if (!this.unparsedLogged) {
        this.unparsedLogged = true;
        this.host.ctx.log.warn('the agent printed a line smurg cannot read', { session: this.id, line: mask(line.slice(0, 200)) });
      }
      return;
    }
    const events = this.normaliser.normalise(message);
    for (const event of events) {
      // Answers to our own control requests must not wait behind the handling of other lines.
      if (event.kind === 'control.response') {
        proc.settleControl(event.requestId, event.ok, event.response, event.error);
        continue;
      }
      this.lines = this.lines
        .then(() => (this.proc === proc ? this.handle(proc, event) : undefined))
        .catch((err: unknown) => this.host.ctx.log.error('handling an agent event failed', { session: this.id, kind: event.kind, error: err instanceof Error ? `${err.name}: ${err.message.slice(0, 200)}` : 'unknown' }));
    }
  }

  private setLogin(login: LoginState): void {
    if (this.login === login) return;
    this.login = login;
    if (login === 'logged-out') {
      this.blockedBy = 'logged-out';
      this.host.account(this, { kind: 'logged-out' });
    } else if (login === 'logged-in' && this.blockedBy === 'logged-out') {
      this.blockedBy = null;
      this.host.account(this, { kind: 'ok' });
    }
    this.host.publish(this);
  }

  private async handle(proc: ClaudeProcess, event: RunnerEvent): Promise<void> {
    const host = this.host;
    switch (event.kind) {
      case 'control.response':
        return;
      case 'init': {
        if (!this.sawInit) {
          this.sawInit = true;
          const version = /^[0-9A-Za-z.+-]{1,32}$/.test(event.version) ? event.version : undefined;
          if (version !== undefined) this.record.claudeVersion = version;
          if (event.apiKeySource === 'none' && this.login !== 'logged-in') this.setLogin('logged-out');
          host.ctx.bus.emit('agent.ready', { sessionId: this.id, claudeVersion: version ?? '', login: this.login, tools: event.tools.slice(0, 500) });
          // A tool Claude Code offers although the profile does not list it: the gate refuses it; said once.
          for (const tool of event.tools) {
            if (this.planTools.includes(tool) || tool.startsWith('mcp__') || this.unknownTools.has(tool) || this.unknownTools.size >= 64) continue;
            this.unknownTools.add(tool);
            host.ctx.log.info('the agent has a tool that is not in its tool list; the gate refuses it', { session: this.id, tool: tool.slice(0, 64) });
          }
        }
        if (event.permissionMode !== undefined) this.checkMode(event.permissionMode);
        this.openTurn();
        return;
      }
      case 'lifecycle': {
        const sent = this.written.get(event.uuid);
        if (sent === undefined) return;
        if (event.state === 'queued') {
          // Claude Code holds it for the next tool boundary: only worth an event while a turn runs.
          if (this.turn !== null) this.delivery(sent, 'queued');
        } else if (event.state === 'started') this.taken(sent);
        else {
          this.delivery(sent, event.state);
          this.written.delete(event.uuid);
          this.rememberPending();
          if (this.parkable) host.idle(this);
        }
        return;
      }
      case 'replay': {
        const sent = this.written.get(event.uuid);
        if (sent !== undefined) this.taken(sent);
        return;
      }
      case 'delta':
        this.thinking = null;
        this.onDelta(event.blockKey, event.text, event.parentToolUseId);
        return;
      case 'thinking':
        if (this.turn !== null) {
          this.thinking = { blockId: this.blockIdFor(event.blockKey), ...(event.parentToolUseId === undefined ? {} : { parent: safeId(event.parentToolUseId, 'tu') }) };
          this.scheduleDeltas();
        }
        return;
      case 'text': {
        this.thinking = null;
        const turn = this.openTurn();
        const known = this.blocks.get(event.blockKey);
        this.blocks.delete(event.blockKey);
        const blockId = known?.blockId ?? this.newBlockId(turn);
        if (event.synthetic && NOT_LOGGED_IN.test(event.text)) {
          host.append(this, noticeEvent('error', msg('notice.notLoggedIn')));
          this.setLogin('logged-out');
          return;
        }
        if (event.text.length === 0) return;
        const cut = clip(shownText(event.text), EVENT_TEXT_MAX_BYTES);
        const parent = event.parentToolUseId === undefined ? undefined : safeId(event.parentToolUseId, 'tu');
        host.append(this, { kind: 'text', turnId: turn.id, blockId, text: cut.text, ...(event.aborted ? { aborted: true as const } : {}), ...(cut.truncated ? { truncated: true as const } : {}), ...(parent === undefined ? {} : { parentToolUseId: parent }) });
        if (parent === undefined) turn.finalText = cut.text;
        return;
      }
      case 'tool.use':
        this.thinking = null;
        await this.onToolUse(event);
        return;
      case 'tool.result':
        this.onToolResult(event);
        return;
      case 'request':
        await this.onRequest(proc, event);
        return;
      case 'request.unsupported':
        proc.respondError(event.requestId, `unsupported control request: ${event.subtype}`);
        return;
      case 'request.cancelled': {
        for (const request of this.open.values()) {
          if (request.claudeRequestId !== event.requestId) continue;
          this.open.delete(request.id);
          if (this.open.size === 0) this.waitingSince = undefined;
          host.ctx.bus.emit('agent.request.withdrawn', { sessionId: this.id, requestId: request.id, reason: 'stopped', ...(this.stopBy === null ? {} : { by: this.stopBy }) });
          host.publish(this);
          break;
        }
        return;
      }
      case 'api.retry':
        if (event.auth) {
          host.append(this, noticeEvent('error', msg('notice.authRejected')));
          this.setLogin('logged-out');
        } else if (event.attempt <= 1 || event.attempt === event.max) {
          host.append(this, noticeEvent('warning', msg('notice.apiRetry', { error: event.error, attempt: event.attempt, max: event.max })));
        }
        return;
      case 'rate.limit':
        if (event.allowed) {
          if (this.blockedBy === 'usage-limit') {
            this.blockedBy = null;
            this.rateNoticeSaid = false;
            host.account(this, { kind: 'ok' });
          }
        } else {
          this.blockedBy = 'usage-limit';
          host.account(this, { kind: 'usage-limit', ...(event.resetsAt === undefined ? {} : { resetsAt: event.resetsAt }) });
          if (!this.rateNoticeSaid) {
            this.rateNoticeSaid = true;
            host.append(this, noticeEvent('warning', msg('notice.rateLimit')));
          }
        }
        return;
      case 'status':
        if (event.compacting === true && this.doing !== 'compacting') {
          this.doing = 'compacting';
          host.publish(this);
        }
        if (event.permissionMode !== undefined) this.checkMode(event.permissionMode);
        return;
      case 'compact.boundary':
        this.doing = undefined;
        host.append(this, noticeEvent('info', msg('notice.compacted')));
        host.publish(this);
        return;
      case 'result':
        this.onResult(event);
        return;
    }
  }

  /**
   * Only smurg changes the mode. A mode Claude Code reports that is not the one this session has (and is looser than
   * `default`) does not stand: it is set back, and logged. (A change smurg itself asked for is reported as the
   * session's mode; `default` where the session may have `acceptEdits` only asks more.)
   */
  private checkMode(claudeMode: string): void {
    const expected = claudeModeFor(this.record.purpose, this.record.mode, this.record.root);
    if (claudeMode === expected || claudeMode === 'default') return;
    this.host.ctx.log.warn('an agent runs in a permission mode smurg did not set; it is set back', { session: this.id, mode: claudeMode.slice(0, 40), expected });
    void this.setClaudeMode(expected);
  }

  private delivery(sent: { messageId: string; state: string }, state: 'queued' | 'started' | 'completed' | 'cancelled'): void {
    if (sent.state === state) return;
    sent.state = state;
    this.host.append(this, { kind: 'delivery', messageId: sent.messageId, state });
  }

  /** A turn took one of our messages. */
  private taken(sent: Outgoing & { started: boolean; state: string }): void {
    if (sent.started) return;
    sent.started = true;
    this.rememberPending();
    this.delivery(sent, 'started');
    if (this.turn !== null) this.turn.messages.push(sent.turn);
    else this.nextTurnMessages.push(sent.turn);
  }

  private openTurn(): Turn {
    if (this.turn !== null) return this.turn;
    const host = this.host;
    this.record.turnCounter += 1;
    this.record.lastTurnOpen = true;
    const turn: Turn = { id: `t_${this.record.turnCounter}`, startedAt: host.ctx.clock.now(), messages: this.nextTurnMessages, edited: [], blocks: 0 };
    this.nextTurnMessages = [];
    this.turn = turn;
    host.save(this);
    host.append(this, { kind: 'turn.started', turnId: turn.id });
    host.ctx.bus.emit('agent.turn.started', { sessionId: this.id, turnId: turn.id });
    host.publish(this);
    return turn;
  }

  private newBlockId(turn: Turn): string {
    turn.blocks += 1;
    return `b_${this.record.turnCounter}_${turn.blocks}`;
  }

  private blockIdFor(blockKey: string): string {
    return this.blocks.get(blockKey)?.blockId ?? `b_${this.record.turnCounter}_think`;
  }

  private onDelta(blockKey: string, text: string, parentToolUseId: string | undefined): void {
    const turn = this.openTurn();
    let block = this.blocks.get(blockKey);
    if (block === undefined) {
      block = { blockId: this.newBlockId(turn), turnId: turn.id, text: '', sent: 0, ...(parentToolUseId === undefined ? {} : { parent: safeId(parentToolUseId, 'tu') }) };
      this.blocks.set(blockKey, block);
    }
    // The block's `text` event is the truth; what streams is bounded like it.
    if (block.text.length < EVENT_TEXT_MAX_BYTES) block.text += text;
    this.scheduleDeltas();
  }

  private scheduleDeltas(): void {
    if (this.deltaTimer !== undefined) return;
    this.deltaTimer = setTimeout(() => {
      this.deltaTimer = undefined;
      this.flushDeltas();
    }, this.host.config.deltaCoalesceMs);
    this.deltaTimer.unref?.();
  }

  /**
   * One coalesced delta per block, masked. A delta that reached no channel is sent again with the next one, from the
   * same offset. The last unfinished word of a block is held back until the block goes on, so a token is masked as a
   * whole before any of it is sent; the block's `text` event replaces whatever the deltas built.
   */
  private flushDeltas(): void {
    const turn = this.turn;
    if (turn === null) return;
    let more = false;
    if (this.thinking !== null) {
      this.host.delta(this, { turnId: turn.id, blockId: this.thinking.blockId, offset: 0, text: '', thinking: true, ...(this.thinking.parent === undefined ? {} : { parentToolUseId: this.thinking.parent }) });
      // Repeated once per period while the agent thinks, so a watcher that just arrived learns it.
      more = true;
    }
    for (const block of this.blocks.values()) {
      const shown = shownText(block.text.slice(0, streamableLength(block.text)));
      if (block.sent >= shown.length) continue;
      const piece = truncateToUtf8Bytes(shown.slice(block.sent), DELTA_TEXT_MAX_BYTES);
      if (piece.length === 0) continue;
      const reached = this.host.delta(this, { turnId: block.turnId, blockId: block.blockId, offset: block.sent, text: piece, ...(block.parent === undefined ? {} : { parentToolUseId: block.parent }) });
      if (reached !== 0) block.sent += piece.length;
      if (block.sent < shown.length) more = true;
    }
    if (more) this.scheduleDeltas();
  }

  private clearStreaming(): void {
    if (this.deltaTimer !== undefined) clearTimeout(this.deltaTimer);
    this.deltaTimer = undefined;
    this.blocks.clear();
    this.thinking = null;
  }

  private async locate(name: string, input: unknown): Promise<{ located: Located; absPath?: string; created: boolean }> {
    const raw = toolPathOf(name, input);
    if (raw === undefined || raw.length === 0 || raw.includes('\u0000')) return { located: { kind: 'none' }, created: false };
    const cwd = this.host.ctx.roots.get(this.record.root)?.realPath;
    const absPath = isAbsolute(raw) ? raw : cwd !== undefined ? resolvePath(cwd, raw) : null;
    if (absPath === null) return { located: { kind: 'outside' }, created: false };
    let file: FileRef | null = null;
    try {
      file = await this.host.ctx.paths.toFileRef(absPath);
    } catch {
      file = null;
    }
    const created = name === 'Write' ? !(await access(absPath).then(() => true, () => false)) : false;
    return { located: file === null ? { kind: 'outside' } : { kind: 'in', file }, absPath, created };
  }

  private async onToolUse(event: Extract<RunnerEvent, { kind: 'tool.use' }>): Promise<void> {
    const name = toolName(event.name);
    // AskUserQuestion is not a tool card: it is the question card.
    if (name === 'AskUserQuestion') return;
    const turn = this.openTurn();
    const { located, created } = await this.locate(name, event.input);
    const view = buildToolView(name, event.input, located, { created });
    const toolUseId = safeId(event.toolUseId, 'tu');
    const stamped = this.host.append(this, { kind: 'tool.started', turnId: turn.id, toolUseId, tool: view, ...(event.parentToolUseId === undefined ? {} : { parentToolUseId: safeId(event.parentToolUseId, 'tu') }) });
    this.tools.set(event.toolUseId, { view, turnId: turn.id, startedAt: this.host.ctx.clock.now(), seq: stamped.seq });
    if (this.tools.size > 512) this.tools.delete(this.tools.keys().next().value as string);
  }

  private onToolResult(event: Extract<RunnerEvent, { kind: 'tool.result' }>): void {
    const call = this.tools.get(event.toolUseId);
    if (call === undefined) return; // AskUserQuestion, or a call we never saw start
    this.tools.delete(event.toolUseId);
    const host = this.host;
    const root = host.ctx.roots.get(this.record.root)?.realPath ?? null;
    const result = buildToolResult({
      view: call.view,
      ok: event.ok,
      text: event.text,
      structured: event.structured,
      durationMs: host.ctx.clock.now() - call.startedAt,
      relativePath: (absolute) => {
        if (root === null) return null;
        const abs = isAbsolute(absolute) ? absolute : resolvePath(root, absolute);
        if (abs === root) return null;
        return abs.startsWith(`${root}/`) ? abs.slice(root.length + 1) : null;
      },
    });
    host.append(this, { kind: 'tool.finished', turnId: call.turnId, toolUseId: safeId(event.toolUseId, 'tu'), ok: event.ok, result });
    const turn = this.turn;
    if (event.ok && turn !== null && call.view.file !== undefined && (call.view.verb === 'edit' || call.view.verb === 'create') && rootRefEquals(call.view.file.root, this.record.root)) {
      turn.edited.push({ file: call.view.file, seq: call.seq });
    }
    // A command that ran without a card (a rule, the host's own rule, Claude Code's own exception) is audited here;
    // one a person or the daemon allowed was audited with that decision.
    if (event.ok && call.decidedBy === undefined && AUDITED_VERBS.has(call.view.verb)) this.auditCommand(event.toolUseId, call.view.verb, 'unasked', call.view.target);
  }

  private async onRequest(proc: ClaudeProcess, event: Extract<RunnerEvent, { kind: 'request' }>): Promise<void> {
    const host = this.host;
    const name = toolName(event.toolName);
    const id = newId('rq');
    const toolUseId = safeId(event.toolUseId, 'tu');
    if (name === 'AskUserQuestion') {
      const parts = questionPartsOf(event.input);
      if (parts === null) {
        // Refused towards the agent by the runner itself: no event, no card, nothing clipped.
        proc.respond(event.requestId, { behavior: 'deny', message: QUESTION_REFUSED_TEXT });
        return;
      }
      this.open.set(id, { id, claudeRequestId: event.requestId, kind: 'question', tool: name, toolUseId: event.toolUseId, input: event.input, verb: null });
      this.waitingSince ??= host.ctx.clock.now();
      host.publish(this, { noteworthy: true });
      host.ctx.bus.emit('agent.request', { sessionId: this.id, request: { id, kind: 'question', toolUseId, parts } });
      return;
    }
    const { located, absPath, created } = await this.locate(name, event.input);
    if (this.proc !== proc) return;
    // The view of THIS request's input: it is the input the answer allows (`updatedInput` in decide()), so it is what
    // the card shows and what the audit entry records. The tool card of the same call was built from the assistant's
    // tool_use block; the two differ when something between them rewrote the input (a PreToolUse hook of the host's
    // own or of the project's confirmed settings may).
    const view = buildToolView(name, event.input, located, { created });
    const shown = this.tools.get(event.toolUseId)?.view;
    if (shown !== undefined && (shown.target !== view.target || shown.verb !== view.verb || shown.outside !== view.outside) && !this.rewrittenLogged) {
      this.rewrittenLogged = true;
      host.ctx.log.warn('a permission request asks for another input than the tool call of the agent showed; the card shows the request', { session: this.id, tool: name.slice(0, 64) });
    }
    const edit = editOf(name, event.input);
    const suggestedRule = suggestedRuleOf(event.suggestions);
    const request: AgentRequest = {
      id,
      kind: 'permission',
      toolUseId,
      tool: name,
      view,
      ...(absPath === undefined ? {} : { absPath }),
      ...(edit === undefined ? {} : { edit }),
      input: event.input,
      ...(event.reason === undefined ? {} : { reason: event.reason.slice(0, 1_000) }),
      ...(event.reasonType === undefined ? {} : { reasonType: event.reasonType.slice(0, 64) }),
      ...(event.blockedPath === undefined ? {} : { blockedPath: event.blockedPath }),
      ...(suggestedRule === undefined ? {} : { suggestedRule }),
    };
    this.open.set(id, { id, claudeRequestId: event.requestId, kind: 'permission', tool: name, toolUseId: event.toolUseId, input: event.input, verb: view.verb, ...(view.target === undefined ? {} : { command: view.target }) });
    this.waitingSince ??= host.ctx.clock.now();
    host.publish(this, { noteworthy: true });
    host.ctx.bus.emit('agent.request', { sessionId: this.id, request });
  }

  /** Ends the open turn without a `result` (the process went away, the session ended). */
  private closeTurn(outcome: TurnOutcome): void {
    if (this.turn === null) return;
    this.finishTurn(outcome, this.host.ctx.clock.now() - this.turn.startedAt);
  }

  private onResult(event: Extract<RunnerEvent, { kind: 'result' }>): void {
    const host = this.host;
    // A `result` before any `init` of this process is Claude Code refusing to start (a conversation id it does not
    // have, or already has): it prints one, says why on stderr and exits. It is no turn; the exit is classified.
    if (this.turn === null && !this.sawInit) return;
    this.resultsThisProcess += 1;
    this.triedResume = false;
    this.record.hasConversation = true;
    this.record.startFailures = 0;
    const turn = this.openTurn();
    for (const uuid of event.uuids) {
      const sent = this.written.get(uuid);
      if (sent !== undefined) this.taken(sent);
    }
    const duration = Math.max(event.durationMs, 0) || host.ctx.clock.now() - turn.startedAt;
    if (event.outcome === 'completed' && this.blockedBy !== null) {
      // A turn went through: whatever stopped this session is over.
      this.blockedBy = null;
      this.rateNoticeSaid = false;
      host.account(this, { kind: 'ok' });
    }
    this.finishTurn(event.outcome, duration);
    // A turn that ended with an error says so; one the missing login ended has said that already.
    if (event.outcome === 'error' && !(event.apiError && this.login === 'logged-out')) host.append(this, noticeEvent('error', msg('notice.turnError')));
    // Versions without command_lifecycle: what this turn took is done.
    for (const [uuid, sent] of [...this.written]) {
      if (!sent.started || !event.uuids.includes(uuid)) continue;
      this.delivery(sent, 'completed');
      this.written.delete(uuid);
    }
    void this.afterTurn();
  }

  private finishTurn(outcome: TurnOutcome, durationMs: number): void {
    const turn = this.turn;
    if (turn === null) return;
    const host = this.host;
    const stoppedBy = outcome === 'interrupted' && this.stopBy !== null ? this.stopBy : undefined;
    this.turn = null;
    this.clearStreaming();
    this.tools.clear();
    this.normaliser.reset();
    this.doing = undefined;
    this.record.lastTurnOpen = false;
    host.append(this, { kind: 'turn.finished', turnId: turn.id, outcome, durationMs: Math.max(0, Math.round(durationMs)), ...(stoppedBy === undefined ? {} : { stoppedBy }) }, true);
    host.save(this);
    this.idleSince = host.ctx.clock.now();
    host.publish(this, { noteworthy: true });
    host.ctx.bus.emit('agent.turn.finished', {
      sessionId: this.id,
      turnId: turn.id,
      outcome,
      ...(turn.finalText === undefined ? {} : { finalText: turn.finalText }),
      ...(stoppedBy === undefined ? {} : { stoppedBy }),
      messages: turn.messages,
      edited: turn.edited,
    });
    for (const waiter of [...this.turnWaiters]) waiter();
  }

  /** After every turn: the memory mark, a pending restart. */
  private async afterTurn(): Promise<void> {
    const pid = this.pid;
    if (pid !== null && !this.restartPending) {
      const rss = await this.host.rss(pid).catch(() => null);
      if (rss !== null && rss > this.host.config.parkAboveRssBytes) this.restartPending = true;
    }
    if (this.parkable) this.host.idle(this);
  }
}

/**
 * What `initialize.account` says about the host's login. Claude Code's own shapes (recorded from 2.1.288):
 *   an API key        { tokenSource: 'none', apiKeySource: 'ANTHROPIC_API_KEY', apiProvider: 'firstParty' }
 *   a claude.ai login { subscriptionType: 'Claude Max', apiProvider: 'firstParty' }
 *   no credential     { tokenSource: 'none', apiProvider: 'firstParty' }
 * Logged out is only the last one: Anthropic's own API, no token, no key, no subscription (a cloud provider has
 * neither a token nor a key and is logged in; a missing `tokenSource` alone says nothing: a subscription has none).
 * `subscriptionType` is a display name: `Claude Pro`, `Claude Max`, `Claude Team`, `Claude Enterprise`, `Claude API`,
 * or `Claude <the plan's own name>`. A personal subscription is one that names Pro or Max and neither Team nor
 * Enterprise (OWNER-DECISIONS Q6: the host is told once that it is for their own use).
 */
export function loginOfAccount(account: Readonly<Record<string, unknown>>): { readonly state: 'logged-in' | 'logged-out'; readonly personalSubscription: boolean } {
  const subscription = typeof account['subscriptionType'] === 'string' ? account['subscriptionType'] : undefined;
  const provider = account['apiProvider'];
  const keySource = account['apiKeySource'];
  const loggedOut = subscription === undefined && account['tokenSource'] === 'none' && (keySource === undefined || keySource === 'none') && (provider === undefined || provider === 'firstParty');
  const personal = subscription !== undefined && /\b(pro|max)\b/i.test(subscription) && !/\b(team|enterprise)\b/i.test(subscription);
  return { state: loggedOut ? 'logged-out' : 'logged-in', personalSubscription: !loggedOut && personal };
}

/**
 * An agent's own text as it is stored and sent to everyone: without the characters a reader cannot see (so a command it
 * quotes reads in the order it is), THEN masked (a credential cannot hide from the mask behind a zero-width character).
 */
export function shownText(text: string): string {
  return mask(shownAgentText(text));
}

const TOKEN_CHAR = /[A-Za-z0-9_\-+/=.:~%@]/;
/** How much of a streaming block may be shown: everything but its last unfinished word (at most 256 characters of it). */
export function streamableLength(text: string): number {
  let end = text.length;
  while (end > 0 && text.length - end < 256 && TOKEN_CHAR.test(text[end - 1] as string)) end -= 1;
  return text.length - end >= 256 ? text.length : end;
}

/** AskUserQuestion's input as the wire's question parts; null when the wire cannot carry it (nothing is ever clipped). */
export function questionPartsOf(input: unknown): Question['parts'] | null {
  const questions = typeof input === 'object' && input !== null ? (input as Record<string, unknown>)['questions'] : null;
  if (!Array.isArray(questions)) return null;
  const parts = questions.map((entry) => {
    const question = typeof entry === 'object' && entry !== null ? (entry as Record<string, unknown>) : {};
    const options = Array.isArray(question['options']) ? question['options'] : [];
    return {
      header: typeof question['header'] === 'string' ? question['header'] : '',
      text: question['question'],
      multi: question['multiSelect'] === true,
      options: options.map((option) => {
        const fields = typeof option === 'object' && option !== null ? (option as Record<string, unknown>) : {};
        return { label: fields['label'], description: typeof fields['description'] === 'string' ? fields['description'] : '' };
      }),
    };
  });
  const parsed = questionPartsSchema.safeParse(parts);
  return parsed.success ? parsed.data : null;
}
