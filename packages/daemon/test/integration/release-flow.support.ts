// Shared by the release-flow tests (DESIGN §9.3 P12): the RELEASE composition (createTestDaemon without `modules`
// composes DEFAULT_FEATURE_MODULES, what `smurg host` runs) on a real git repository, the real `smurg hook` /
// `smurg mcp` commands, real clients over real Noise channels. Two things stand in: the `claude` executable (the
// scripted stand-in, src/testing/fake-claude.mjs) and, where a waiting time must pass, the clock (`advance`).
//
// The people of every flow test: Ian (Host), Mei (Agent access), Amy (Editor), Leo (Viewer). Everything a test asserts
// it reads from what these four RECEIVE (events, cards, inbox items, the audit log), not from the daemon's internals.
import { execFile } from 'node:child_process';
import { lstat, mkdir, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach } from 'vitest';
import type { AuditEntry, ConversationEvent, HostSettings, InboxItem, PayloadOf, PermissionRequest, Question, Role, SmurgError } from '@smurg/protocol';
import type { Connection, InteractiveEventType } from '@smurg/protocol/client';
import type { AgentsConfig } from '../../src/core/config.ts';
import {
  TEST_HOST_USER,
  createTempDir,
  createTempProject,
  createTempRunDir,
  createTestDaemon,
  installFakeClaude,
  isolatedGitEnv,
  removeTempDir,
  removeTempRunDir,
  waitFor,
  type FakeClaude,
  type TestClient,
  type TestDaemon,
} from '../../src/testing/index.ts';
import { CLI_MAIN } from './support.ts';

const execFileAsync = promisify(execFile);

export const IAN = TEST_HOST_USER;
export const MEI = 'dev:mei';
export const AMY = 'dev:amy';
export const LEO = 'dev:leo';

/** The d→c types a member's recorder keeps (everything the story sends to a client). */
const RECORDED = [
  'session.events',
  'session.state',
  'question.updated',
  'question.changed',
  'permission.updated',
  'suggest.updated',
  'topic.updated',
  'topic.removed',
  'plan.updated',
  'report.updated',
  'inbox.changed',
  'worktree.updated',
  'worktree.removed',
  'worktree.merge.updated',
] as const satisfies readonly InteractiveEventType[];
type Recorded = (typeof RECORDED)[number];

/** One member with a connection, and everything that connection received. */
export interface Person {
  readonly userId: string;
  readonly name: string;
  readonly role: Role;
  readonly client: TestClient;
  readonly conn: Connection;
  /** Every payload of one type this connection received, in arrival order (live: the array grows). */
  got<T extends Recorded>(type: T): PayloadOf<T>[];
  /**
   * The conversation of one session as this member has it: the page its `session.watch` answered and every event
   * that arrived since, in order (an event that came twice under one `seq` is the later copy, as a client keeps it).
   */
  events(sessionId: string): ConversationEvent[];
  /**
   * Every state of a permission card this member was given, in arrival order: with the page of a `session.watch`
   * (the cards its events point to and every open one) and with every `permission.updated` since.
   */
  permissions(): PermissionRequest[];
  /** The same for question cards (`question.updated`; votes and comments travel as `question.changed`). */
  questions(): Question[];
  /** The member's inbox as the daemon lists it now. */
  inbox(): Promise<InboxItem[]>;
  /** `session.watch`: the page it answers is kept, and from now on the session's events arrive. */
  watch(sessionId: string): Promise<void>;
}

function person(client: TestClient, name: string, role: Role): Person {
  const seen = new Map<Recorded, unknown[]>();
  for (const type of RECORDED) {
    const list: unknown[] = [];
    seen.set(type, list);
    client.conn.on(type, (payload: unknown) => list.push(payload));
  }
  const got = <T extends Recorded>(type: T): PayloadOf<T>[] => seen.get(type) as PayloadOf<T>[];
  const pages = new Map<string, ConversationEvent[]>();
  const permissions: PermissionRequest[] = [];
  const questions: Question[] = [];
  client.conn.on('permission.updated', (payload) => permissions.push(payload.request));
  client.conn.on('question.updated', (payload) => questions.push(payload.question));
  return {
    userId: client.userId,
    name,
    role,
    client,
    conn: client.conn,
    got,
    events: (sessionId) => {
      const bySeq = new Map<number, ConversationEvent>();
      for (const event of pages.get(sessionId) ?? []) bySeq.set(event.seq, event);
      for (const batch of got('session.events')) if (batch.sessionId === sessionId) for (const event of batch.events) bySeq.set(event.seq, event);
      return [...bySeq.values()].sort((a, b) => a.seq - b.seq);
    },
    permissions: () => permissions,
    questions: () => questions,
    inbox: async () => (await client.conn.request('inbox.list', {})).items,
    watch: async (sessionId) => {
      const page = await client.conn.request('session.watch', { sessionId });
      pages.set(sessionId, [...(pages.get(sessionId) ?? []), ...page.events]);
      permissions.push(...page.permissions);
      questions.push(...page.questions);
    },
  };
}

export interface FlowOptions {
  /** Files of the shared folder (a git repository with one commit). */
  readonly files?: Readonly<Record<string, string>>;
  /** `false`: a plain folder (topics work, execution does not). */
  readonly git?: boolean;
  /** The agent runtime's timers; `escalationSweepMs` is small by default so a moved clock is noticed at once. */
  readonly agents?: Partial<AgentsConfig>;
  readonly settings?: Partial<HostSettings>;
}

export interface Flow {
  readonly claude: FakeClaude;
  /** The shared folder (the main workspace). */
  readonly root: string;
  readonly stateDir: string;
  /** The daemon that runs now (a new one after `restart`). */
  readonly d: TestDaemon;
  readonly ian: Person;
  readonly mei: Person;
  readonly amy: Person;
  readonly leo: Person;
  /** Stops the daemon and starts it again on the same folder, state and home; everyone connects again. */
  restart(): Promise<void>;
  /** Stops the daemon (the folders stay until the test ends). */
  stop(): Promise<void>;
  /** Connects one more member (or the same member again after a removal). */
  join(userId: string, name: string, role: Role): Promise<Person>;
  /** Moves the daemon's clock forward. */
  advance(ms: number): void;
  /** git in the shared folder (or `cwd`), with an isolated configuration. */
  git(args: readonly string[], cwd?: string): Promise<string>;
  /** The command lines of the processes started with a file of this daemon's state directory (the agent sessions). */
  processes(): Promise<string[]>;
  /**
   * Kills the agent process of one session (SIGKILL), as a crash would: only a process whose command line names this
   * flow's own state directory AND that session's launch files. Returns how many were signalled.
   */
  killProcessOf(sessionId: string): Promise<number>;
  /**
   * The host's own `smurg` command (the real CLI, as the host would run it in a terminal on that computer) against
   * this daemon: `SMURG_HOME` is the daemon's state directory, so it finds the control socket where production puts it.
   */
  smurg(args: readonly string[]): Promise<{ readonly code: number; readonly stdout: string; readonly stderr: string }>;
}

const flows: { stop(): Promise<void>; temp: string; run: string }[] = [];

/** Every flow a test started is stopped and its folders are removed after it. */
afterEach(async () => {
  for (const flow of flows.splice(0)) {
    try {
      await flow.stop();
    } finally {
      await removeTempDir(flow.temp).catch(() => {});
      await removeTempRunDir(flow.run).catch(() => {});
    }
  }
}, 120_000);

export async function startFlow(options: FlowOptions = {}): Promise<Flow> {
  const base = await createTempDir('release-flow');
  const stateDir = await createTempRunDir();
  const root = await createTempProject(base, 'project', { files: options.files ?? { 'README.md': '# Bookshop\n' }, git: options.git ?? true });
  // The host's home: where the stand-in (like Claude Code) keeps its conversations. The same across a restart.
  const hostHome = join(base, 'home');
  await mkdir(hostHome, { recursive: true });
  const claude = await installFakeClaude(base);
  const workspaceId = `ws_test_flow_${Math.random().toString(36).slice(2, 10)}`;
  const gitEnv = isolatedGitEnv(join(base, '.git-home'));

  let d: TestDaemon | null = null;
  let people: { ian: Person; mei: Person; amy: Person; leo: Person } | null = null;

  const stop = async (): Promise<void> => {
    const running = d;
    d = null;
    people = null;
    await running?.cleanup();
  };
  const boot = async (): Promise<void> => {
    d = await createTestDaemon({
      root,
      stateDir,
      workspaceId,
      // No `modules`: the default, i.e. the release composition.
      agents: { escalationSweepMs: 15, ...options.agents },
      // A test that moves the clock by minutes must not look like a relay that was silent for minutes: the pong
      // watchdog of the host's relay link (6 s by the daemon's clock) would cut the link, and every member would be
      // offline for a moment and resume, at an arbitrary point of the story.
      timing: { pongWatchdogMs: 365 * 24 * 3600_000 },
      // How many work items may hold an agent process at once defaults from the machine's memory (2 on a small one):
      // fixed here, so the same sessions are parked for a slot, or not, on every machine.
      settings: { maxLiveAgents: 8, ...options.settings },
      sessions: { claudePath: claude.path, hostHome, selfCommand: { file: process.execPath, args: [CLI_MAIN] } },
    });
    const daemon = d;
    people = {
      ian: person(await daemon.connect({ userId: IAN, displayName: 'Ian', role: 'host' }), 'Ian', 'host'),
      mei: person(await daemon.connect({ userId: MEI, displayName: 'Mei', role: 'agent' }), 'Mei', 'agent'),
      amy: person(await daemon.connect({ userId: AMY, displayName: 'Amy', role: 'editor' }), 'Amy', 'editor'),
      leo: person(await daemon.connect({ userId: LEO, displayName: 'Leo', role: 'viewer' }), 'Leo', 'viewer'),
    };
  };
  const running = (): TestDaemon => {
    if (d === null) throw new Error('the daemon of this flow is stopped');
    return d;
  };
  const who = (name: 'ian' | 'mei' | 'amy' | 'leo'): Person => {
    if (people === null) throw new Error('the daemon of this flow is stopped');
    return people[name];
  };

  flows.push({ stop, temp: base, run: stateDir });
  await boot();

  return {
    claude,
    root,
    stateDir,
    get d() {
      return running();
    },
    get ian() {
      return who('ian');
    },
    get mei() {
      return who('mei');
    },
    get amy() {
      return who('amy');
    },
    get leo() {
      return who('leo');
    },
    restart: async () => {
      await stop();
      await boot();
    },
    stop,
    join: async (userId, name, role) => person(await running().connect({ userId, displayName: name, role }), name, role),
    advance: (ms) => running().advanceClock(ms),
    git: async (args, cwd = root) => (await execFileAsync('git', [...args], { cwd, env: gitEnv, maxBuffer: 16 * 1024 * 1024 })).stdout.trim(),
    processes: async () => {
      const { stdout } = await execFileAsync('ps', ['-axo', 'command='], { maxBuffer: 16 * 1024 * 1024 });
      return stdout.split('\n').filter((line) => line.includes(stateDir));
    },
    smurg: async (args) => {
      const env = { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', HOME: hostHome, SMURG_HOME: stateDir, SHELL: '/bin/sh', TERM: 'xterm-256color', LANG: 'en_US.UTF-8', SMURG_LANG: 'en', SMURG_NO_BROWSER: '1', TMPDIR: process.env['TMPDIR'] ?? '/tmp' };
      try {
        const { stdout, stderr } = await execFileAsync(process.execPath, [CLI_MAIN, ...args], { env, cwd: hostHome, timeout: 60_000 });
        return { code: 0, stdout, stderr };
      } catch (err) {
        const failed = err as { code?: number; stdout?: string; stderr?: string };
        return { code: typeof failed.code === 'number' ? failed.code : -1, stdout: failed.stdout ?? '', stderr: failed.stderr ?? '' };
      }
    },
    killProcessOf: async (sessionId) => {
      // A session's launch files are in <stateDir>/sessions/<workspace>/<hex of the session id>/.
      const mark = `/${Buffer.from(sessionId, 'utf8').toString('hex')}/settings.json`;
      const { stdout } = await execFileAsync('ps', ['-axo', 'pid=,command='], { maxBuffer: 16 * 1024 * 1024 });
      let killed = 0;
      for (const line of stdout.split('\n')) {
        if (!line.includes(stateDir) || !line.includes(mark)) continue;
        const pid = Number.parseInt(line.trim().split(/\s+/)[0] ?? '', 10);
        if (!Number.isSafeInteger(pid) || pid <= 1) continue;
        process.kill(pid, 'SIGKILL'); // a child of this test's own daemon
        killed += 1;
      }
      return killed;
    },
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// What is on disk (to see that a stopped daemon writes nothing more)
// ---------------------------------------------------------------------------------------------------------------------

/** Every file and folder under `dir` with its size and the time it was last written, sorted: equal lists = nothing was written. */
export async function onDisk(dir: string): Promise<string[]> {
  const out: string[] = [];
  const walk = async (path: string): Promise<void> => {
    for (const name of (await readdir(path)).sort()) {
      const full = join(path, name);
      const stat = await lstat(full);
      out.push(`${full.slice(dir.length)} ${stat.isDirectory() ? 'dir' : stat.size} ${stat.mtimeMs}`);
      if (stat.isDirectory()) await walk(full);
    }
  };
  await walk(dir);
  return out;
}

// ---------------------------------------------------------------------------------------------------------------------
// What a request was refused with
// ---------------------------------------------------------------------------------------------------------------------

export interface Refusal {
  readonly code: string;
  readonly reason?: string;
  /** The catalog id of the sentence. */
  readonly id?: string;
  readonly message: string;
  readonly detail?: Readonly<Record<string, unknown>>;
}

/** The refusal a request got, or null when it succeeded. */
export async function refusal(promise: Promise<unknown>): Promise<Refusal | null> {
  try {
    await promise;
    return null;
  } catch (err) {
    const e = err as Partial<SmurgError>;
    const reason = e.detail?.['reason'];
    return {
      code: e.code ?? 'unknown',
      message: e.message ?? '',
      ...(typeof reason === 'string' ? { reason } : {}),
      ...(e.text?.id === undefined ? {} : { id: e.text.id }),
      ...(e.detail === undefined ? {} : { detail: e.detail }),
    };
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// The audit log, as the host reads it
// ---------------------------------------------------------------------------------------------------------------------

/** The audit entries of some actions (none named: all), oldest first, as the host's console reads them (page by page). */
export async function audited(flow: Flow, ...actions: string[]): Promise<AuditEntry[]> {
  const all: AuditEntry[] = [];
  let before: number | undefined;
  for (;;) {
    // `at` is strictly increasing within one log, so `before` is an exact cursor.
    const { entries } = await flow.ian.conn.request('admin.audit.query', { limit: 500, ...(before === undefined ? {} : { before }) });
    all.push(...entries);
    if (entries.length < 500) break;
    before = entries.at(-1)?.at;
  }
  return all.filter((entry) => actions.length === 0 || actions.includes(entry.action)).reverse();
}

// ---------------------------------------------------------------------------------------------------------------------
// What the agents were given (the stand-in's echo)
// ---------------------------------------------------------------------------------------------------------------------

type Echo = Awaited<ReturnType<FakeClaude['echoed']>>[number];

function textOfUserLine(value: unknown): string | null {
  const line = value as { type?: string; message?: { content?: unknown } };
  if (line.type !== 'user') return null;
  const content = line.message?.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((part: { text?: string }) => part.text ?? '').join('');
  return null;
}

/** Every message the agent of one session was sent (header line and body), in order. */
export async function told(flow: Flow, sessionId: string): Promise<string[]> {
  return (await flow.claude.echoed()).filter((entry) => entry.kind === 'stdin' && entry.session === sessionId).flatMap((entry) => {
    const text = textOfUserLine(entry.value);
    return text === null ? [] : [text];
  });
}

/** Everything any agent process received so far (arguments, settings, role prompts, every line on its stdin), as one text. */
export async function everythingAgentsReceived(flow: Flow, filter: (entry: Echo) => boolean = () => true): Promise<string> {
  return (await flow.claude.echoed()).filter(filter).map((entry) => JSON.stringify(entry.value)).join('\n');
}

/** How many agent processes were started so far (one `argv` entry each). */
export async function launches(flow: Flow, sessionId?: string): Promise<number> {
  return (await flow.claude.echoed()).filter((entry) => entry.kind === 'argv' && (sessionId === undefined || entry.session === sessionId)).length;
}

// ---------------------------------------------------------------------------------------------------------------------
// Waiting for what a member receives
// ---------------------------------------------------------------------------------------------------------------------

export const kinds = (events: readonly ConversationEvent[]): string[] => events.map((event) => (event.kind === 'card' ? `card:${event.card}` : event.kind));

/** Waits until the member's inbox holds an item that fits, and returns it. */
export async function inboxItem(member: Person, fits: (item: InboxItem) => boolean, what: string, timeoutMs = 20_000): Promise<InboxItem> {
  let found: InboxItem | undefined;
  await waitFor(
    async () => {
      found = (await member.inbox()).find(fits);
      return found !== undefined;
    },
    { timeoutMs, what: `${what} in ${member.name}'s inbox` },
  );
  return found as InboxItem;
}

/** Waits until the member's inbox holds no item that fits. */
export async function inboxWithout(member: Person, fits: (item: InboxItem) => boolean, what: string, timeoutMs = 20_000): Promise<void> {
  await waitFor(async () => !(await member.inbox()).some(fits), { timeoutMs, what: `${what} to leave ${member.name}'s inbox` });
}

/** Waits until the member received an event of the session that fits, and returns the first one. */
export async function eventOf<E extends ConversationEvent = ConversationEvent>(member: Person, sessionId: string, fits: (event: ConversationEvent) => boolean, what: string, timeoutMs = 30_000): Promise<E> {
  await waitFor(() => member.events(sessionId).some(fits), { timeoutMs, what: `${what} at ${member.name}` });
  return member.events(sessionId).find(fits) as E;
}

/** Waits until the member was given a permission card in a state that fits, and returns the newest such state. */
export async function permissionAt(member: Person, fits: (request: PermissionRequest) => boolean, what: string, timeoutMs = 30_000): Promise<PermissionRequest> {
  await waitFor(() => member.permissions().some(fits), { timeoutMs, what: `${what} at ${member.name}` });
  return member.permissions().findLast(fits) as PermissionRequest;
}

/** Waits until the member was given a question card in a state that fits, and returns the newest such state. */
export async function questionAt(member: Person, fits: (question: Question) => boolean, what: string, timeoutMs = 30_000): Promise<Question> {
  await waitFor(() => member.questions().some(fits), { timeoutMs, what: `${what} at ${member.name}` });
  return member.questions().findLast(fits) as Question;
}

/** Waits until `count` turns of the session have finished in what the member received. */
export async function turnsFinished(member: Person, sessionId: string, count: number, timeoutMs = 30_000): Promise<void> {
  await waitFor(() => member.events(sessionId).filter((event) => event.kind === 'turn.finished').length >= count, { timeoutMs, what: `turn ${count} of the session to finish at ${member.name}` });
}

/** The statuses of a session as the member was told them (`session.state`), in order. */
export function statuses(member: Person, sessionId: string): string[] {
  return member.got('session.state').filter((update) => update.session.id === sessionId).map((update) => update.session.status);
}

/**
 * Waits until a new session's first process is up: `starting`, then anything else. (The very first `session.state` of
 * a session says `idle`: it has no process yet; a message sent then is queued until the process is ready.)
 */
export async function sessionReady(member: Person, sessionId: string, timeoutMs = 30_000): Promise<void> {
  await waitFor(
    () => {
      const told = statuses(member, sessionId);
      const at = told.indexOf('starting');
      return at !== -1 && told.slice(at).some((status) => status !== 'starting');
    },
    { timeoutMs, what: `the first process of the session to be ready, as ${member.name} is told` },
  );
}

/** Waits until the last status the member was told is `status`. */
export async function statusIs(member: Person, sessionId: string, status: string, timeoutMs = 30_000): Promise<void> {
  await waitFor(() => statuses(member, sessionId).at(-1) === status, { timeoutMs, what: `the session to be ${status}, as ${member.name} is told` });
}

export { waitFor };
