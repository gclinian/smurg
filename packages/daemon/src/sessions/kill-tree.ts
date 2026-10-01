// Ending a session's processes (R2 kick, R11 terminate, session.end, smurg stop): ARCHITECTURE §0 rule 1 and §7.6.
//
// A process is signalled ONLY when it is positively tied to the session:
//   (a) the PTY child itself, while it is still ours: node-pty has not reported its exit, it is still the daemon's own
//       child (ppid = the daemon), and it is not another session's PTY child or one of the daemon's helpers,
//   (b) members of the PTY child's process group (the pgid passes the §0 assertion: integer > 1, not the daemon's pid,
//       not the daemon's own process group),
//   (c) same-uid processes whose ENVIRONMENT carries this session's exact `SMURG_SESSION_ID=<id>`,
//   and every descendant (by ppid) of those. Descendants found by an EARLIER ppid walk (KillTreeTarget.known: a job
//   orphaned by a natural `exit` has lost its ppid link) count while they are provably the same process (same start
//   time, uid and full command line) and still orphans.
// Every candidate is re-validated right before it is signalled: an integer pid > 1, same uid, not the daemon, not one
// of the daemon's ancestors, not in the daemon's process group, not a zombie. There is NO system-wide "looks like a session"
// sweep (§11 D-3: two research spikes killed unrelated processes of the host user that way). A set larger than
// `maxPids` is implausible for one session: the kill is aborted and logged loudly instead of signalling it.
//
// PID REUSE. macOS hands a freed pid out again within milliseconds (observed on this machine), and there is no pidfd:
// a target that exits between the scan and the signal could be replaced by a stranger. So a process is identified by
// (pid, start time, full command line), not by its pid, and only SIGSTOP is sent on the strength of one scan: a second
// scan must show the SAME identity (the process is frozen: it can no longer exit or exec) before the SIGKILL; a pid
// whose identity changed meanwhile gets an immediate SIGCONT (our stop is undone) and nothing else.
//
// Method (pty-packaging.md §6.3, measured 163–811 ms): scan, SIGSTOP, re-scan and verify, SIGKILL, wait until gone;
// repeat in rounds. The process table is read with an asynchronous execFile of `ps` (never spawnSync: ARCHITECTURE §0
// rule 5).
//
// Known limit (D-3): a process that setsid()s AND scrubs its environment is found by none of (a)–(c), on macOS and on
// Linux alike (sessions are not sandboxed: no PID namespace takes it down, §11 D-15).
import { execFile } from 'node:child_process';
import { readFile, readdir } from 'node:fs/promises';
import type { Logger } from '../core/logger.ts';

export interface ProcessRow {
  readonly pid: number;
  readonly ppid: number;
  readonly pgid: number;
  readonly uid: number;
  readonly zombie: boolean;
  /** `ps -o lstart`: with the command line, what tells two processes that had the same pid apart. */
  readonly start?: string;
  readonly command?: string;
}

/** Reads the process table. Injectable so the safety guards are unit-testable without touching real processes. */
export interface ProcessInspector {
  /** Every process on the machine. */
  table(): Promise<ProcessRow[]>;
  /**
   * `uid`'s processes whose ENVIRONMENT contains exactly `entry` (`KEY=value`), as pid → identity (start + command, see
   * identityOf), so a pid reused between this scan and the table is not taken for the marked process. Never returns
   * environment contents.
   */
  withEnvEntry(entry: string, uid: number): Promise<Map<number, string>>;
}

export type KillSignal = 'SIGSTOP' | 'SIGCONT' | 'SIGKILL';

/** A remembered descendant: what it was when it was seen as a descendant of the PTY child. */
export interface KnownProcess {
  readonly start: string;
  readonly command: string;
}

export interface KillTreeTarget {
  /** The PTY child's pid while node-pty has not reported its exit; null afterwards. */
  readonly rootPid: () => number | null;
  /** `SMURG_SESSION_ID=<sessionId>`. */
  readonly envEntry: string;
  /** Descendants found earlier by walking ppid from the PTY child while it ran (see the file header). */
  readonly known?: ReadonlyMap<number, KnownProcess>;
  /**
   * Pids that belong to someone else and are never signalled: other sessions' PTY children and the daemon's own
   * helper processes (all children of the daemon, like the PTY child).
   */
  readonly protect?: () => ReadonlySet<number>;
}

export interface KillTreeOptions {
  readonly inspector: ProcessInspector;
  readonly log: Logger;
  /** Sends one signal to one validated pid (default process.kill). */
  readonly signal?: (pid: number, signal: KillSignal) => void;
  /** Overall budget (R2: 3 s end to end). */
  readonly deadlineMs?: number;
  /** More candidates than this is implausible for one session: abort, signal nothing. */
  readonly maxPids?: number;
  readonly selfPid?: number;
  readonly uid?: number;
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
}

export interface KillTreeResult {
  /** done: nothing tied to the session is left; timeout: survivors at the deadline; aborted: nothing was signalled. */
  readonly outcome: 'done' | 'timeout' | 'aborted';
  readonly reason?: 'pid-cap' | 'self-not-in-table' | 'scan-failed';
  readonly killed: readonly number[];
  readonly survivors: readonly number[];
  /** Pids stopped on the strength of a scan whose identity then changed (a reused pid): continued again. */
  readonly continued: readonly number[];
  readonly rounds: number;
  readonly ms: number;
}

export const DEFAULT_KILL_DEADLINE_MS = 2_500;
export const DEFAULT_MAX_PIDS_PER_SESSION = 512;
const MAX_ROUNDS = 6;
const POLL_MS = 25;

/**
 * Processes a killTree() has SIGSTOPped and not yet killed or continued, with the function that signals them
 * (review CLI-06). If the daemon's process exits in that window (a second Ctrl-C on `smurg host` calls
 * process.exit()), they would stay frozen forever as orphans: the 'exit' hook finishes the job synchronously. A frozen
 * process (confirmed by the second scan: stopped, so it can neither exit nor exec and its pid cannot be reused) is
 * killed; one stopped but not yet confirmed is only continued, as killTree itself would do.
 */
const inFlight = new Map<number, { state: 'stopped' | 'frozen'; send: (pid: number, signal: KillSignal) => void }>();
let exitHookInstalled = false;

/** The 'exit' hook (exported for tests): kill what is frozen, continue what is only stopped. Synchronous. */
export function releaseStoppedProcesses(): void {
  for (const [pid, entry] of inFlight) {
    try {
      entry.send(pid, entry.state === 'frozen' ? 'SIGKILL' : 'SIGCONT');
    } catch {
      // gone
    }
  }
  inFlight.clear();
}

/** Pids currently stopped by a killTree() in this process (tests). */
export function stoppedProcesses(): ReadonlyMap<number, 'stopped' | 'frozen'> {
  return new Map([...inFlight].map(([pid, entry]) => [pid, entry.state]));
}

function trackStopped(pid: number, state: 'stopped' | 'frozen', send: (pid: number, signal: KillSignal) => void): void {
  inFlight.set(pid, { state, send });
  if (!exitHookInstalled) {
    exitHookInstalled = true;
    process.on('exit', releaseStoppedProcesses);
  }
}

/** §0 rule 1: the only process groups we may treat as ours. */
export function isSafePgid(pgid: number, selfPid: number, ownPgid: number): boolean {
  return Number.isInteger(pgid) && pgid > 1 && pgid !== selfPid && pgid !== ownPgid;
}

function isPlausiblePid(pid: number): boolean {
  return Number.isInteger(pid) && pid > 1;
}

/** What makes a process this process: its start time and full command line (null when the scan lacks them). */
export function identityOf(row: Pick<ProcessRow, 'start' | 'command'>): string | null {
  return row.start === undefined || row.command === undefined ? null : `${row.start}\u0000${row.command}`;
}

export interface Selection {
  /** pid → identity at this scan. */
  readonly targets: Map<number, string | null>;
  /** Pids that must never be signalled in this round (the daemon, its ancestors, its process group, protect()). */
  readonly protectedPids: Set<number>;
  readonly abort?: 'self-not-in-table';
  /** The PTY child's pgid was refused by the §0 assertion. */
  readonly refusedPgid?: number;
}

export interface SelectInput {
  readonly rows: readonly ProcessRow[];
  /** pid → identity from the env-marker scan. */
  readonly markers: ReadonlyMap<number, string | null>;
  readonly rootPid: number | null;
  readonly selfPid: number;
  readonly uid: number;
  readonly known?: ReadonlyMap<number, KnownProcess>;
  readonly protect?: ReadonlySet<number>;
}

/** Pure selection over one snapshot of the process table (exported for the unit tests of the guards). */
export function selectTargets(input: SelectInput): Selection {
  const { rows, selfPid, uid } = input;
  const byPid = new Map<number, ProcessRow>();
  const children = new Map<number, number[]>();
  for (const row of rows) {
    if (!isPlausiblePid(row.pid) && row.pid !== 0 && row.pid !== 1) continue;
    byPid.set(row.pid, row);
    const list = children.get(row.ppid);
    if (list) list.push(row.pid);
    else children.set(row.ppid, [row.pid]);
  }
  const protectedPids = new Set<number>([0, 1, selfPid, ...(input.protect ?? [])]);
  const self = byPid.get(selfPid);
  if (!self) return { targets: new Map(), protectedPids, abort: 'self-not-in-table' };
  const ownPgid = self.pgid;
  // The daemon's ancestors (the shell, terminal, launchd…) are never ours to signal, whatever their environment says.
  for (let row: ProcessRow | undefined = self, hops = 0; row && hops < 4096; hops++) {
    protectedPids.add(row.pid);
    if (row.ppid <= 1 || protectedPids.has(row.ppid)) break;
    row = byPid.get(row.ppid);
  }
  for (const row of rows) if (row.pgid === ownPgid) protectedPids.add(row.pid);

  const roots = new Set<number>();
  let refusedPgid: number | undefined;
  const root = input.rootPid !== null ? byPid.get(input.rootPid) : undefined;
  // Still OUR child: a pid reused after node-pty reaped the child (before its exit callback ran) belongs to a stranger
  // (another parent) or to one of our other children (protected).
  if (root && root.uid === uid && root.ppid === selfPid && !(input.protect?.has(root.pid) ?? false)) {
    if (!isSafePgid(root.pgid, selfPid, ownPgid)) {
      // §0: a child in the daemon's own group (or a nonsensical pgid) is never treated as the session's group.
      refusedPgid = root.pgid;
    } else {
      if (!root.zombie) roots.add(root.pid);
      for (const row of rows) if (row.pgid === root.pgid && row.uid === uid) roots.add(row.pid);
    }
  }
  for (const [pid, identity] of input.markers) {
    const row = byPid.get(pid);
    if (row && row.uid === uid && identity !== null && identityOf(row) === identity) roots.add(pid);
  }
  for (const [pid, was] of input.known ?? []) {
    const row = byPid.get(pid);
    // The same process (start time + command line), and still an orphan of the session (or a child of one).
    if (!row || row.uid !== uid || row.start !== was.start || row.command !== was.command) continue;
    if (row.ppid === 1 || input.known?.has(row.ppid)) roots.add(pid);
  }
  const reach = new Set<number>();
  const stack = [...roots];
  while (stack.length > 0) {
    const pid = stack.pop() as number;
    if (reach.has(pid)) continue;
    reach.add(pid);
    for (const child of children.get(pid) ?? []) stack.push(child);
  }
  const targets = new Map<number, string | null>();
  for (const pid of reach) {
    const row = byPid.get(pid);
    if (!row || row.zombie || row.uid !== uid || !isPlausiblePid(pid) || protectedPids.has(pid)) continue;
    targets.set(pid, identityOf(row));
  }
  return refusedPgid === undefined ? { targets, protectedPids } : { targets, protectedPids, refusedPgid };
}

/** Kills everything positively tied to one session (see the file header). Never throws. */
export async function killTree(target: KillTreeTarget, options: KillTreeOptions): Promise<KillTreeResult> {
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const selfPid = options.selfPid ?? process.pid;
  const uid = options.uid ?? (typeof process.getuid === 'function' ? process.getuid() : -1);
  const maxPids = options.maxPids ?? DEFAULT_MAX_PIDS_PER_SESSION;
  const started = now();
  const deadline = started + (options.deadlineMs ?? DEFAULT_KILL_DEADLINE_MS);
  const killed = new Set<number>();
  const continued = new Set<number>();
  const log = options.log;
  const send = options.signal ?? ((pid: number, signal: KillSignal) => process.kill(pid, signal));

  const scan = async (): Promise<{ selection: Selection; rows: Map<number, ProcessRow> } | null> => {
    try {
      const [rows, markers] = await Promise.all([options.inspector.table(), options.inspector.withEnvEntry(target.envEntry, uid)]);
      const selection = selectTargets({ rows, markers, rootPid: target.rootPid(), selfPid, uid, ...(target.known ? { known: target.known } : {}), protect: target.protect?.() ?? new Set() });
      if (selection.refusedPgid !== undefined) log.error('kill-tree refused a process group (ARCHITECTURE §0)', { pgid: selection.refusedPgid });
      return { selection, rows: new Map(rows.map((row) => [row.pid, row])) };
    } catch (err) {
      log.error('kill-tree could not read the process table', { error: err instanceof Error ? err.message.slice(0, 160) : 'unknown' });
      return null;
    }
  };
  const signal = (pid: number, sig: KillSignal, guard: Selection): boolean => {
    // Last line of defence, whatever the selection said.
    if (!isPlausiblePid(pid) || pid === selfPid || guard.protectedPids.has(pid)) return false;
    if (sig !== 'SIGSTOP') inFlight.delete(pid);
    try {
      send(pid, sig);
      if (sig === 'SIGSTOP') trackStopped(pid, 'stopped', send);
      return true;
    } catch {
      return false; // ESRCH (gone) / EPERM
    }
  };
  const result = (outcome: KillTreeResult['outcome'], rounds: number, survivors: number[], reason?: KillTreeResult['reason']): KillTreeResult => ({
    outcome,
    ...(reason ? { reason } : {}),
    killed: [...killed],
    survivors,
    continued: [...continued],
    rounds,
    ms: now() - started,
  });

  let rounds = 0;
  for (; rounds < MAX_ROUNDS && now() < deadline; rounds++) {
    const first = await scan();
    if (!first) return result('aborted', rounds, [], 'scan-failed');
    if (first.selection.abort) {
      log.error('kill-tree aborted: the daemon is not in the process table', {});
      return result('aborted', rounds, [], first.selection.abort);
    }
    const candidates = first.selection.targets;
    if (candidates.size === 0) return result('done', rounds, []);
    if (candidates.size > maxPids) {
      log.error('kill-tree aborted: implausible number of processes for one session, nothing signalled', { count: candidates.size, max: maxPids });
      return result('aborted', rounds, [...candidates.keys()], 'pid-cap');
    }
    // Freeze the whole tree before killing anything: a stopped process can no longer fork, exec or exit, so its
    // identity is stable until the SIGKILL, and no child is orphaned (reparented, out of reach) by a parent dying first.
    const frozen = new Set<number>();
    let toStop: ReadonlyMap<number, string | null> = candidates;
    let guard = first.selection;
    for (let pass = 0; pass < 4 && toStop.size > 0; pass++) {
      const stopped = new Map<number, string | null>();
      for (const [pid, identity] of toStop) if (signal(pid, 'SIGSTOP', guard)) stopped.set(pid, identity);
      const check = await scan();
      if (check === null) {
        // Cannot verify what was just stopped: undo those stops (never leave a process frozen); the verified ones die.
        for (const pid of stopped.keys()) {
          signal(pid, 'SIGCONT', guard);
          continued.add(pid);
        }
        break;
      }
      if (!check.selection.abort) guard = check.selection;
      for (const [pid, identity] of stopped) {
        const row = check?.rows.get(pid);
        if (!row) {
          inFlight.delete(pid); // gone
          continue;
        }
        if (identity !== null && identityOf(row) === identity && row.uid === uid && check !== null && !check.selection.protectedPids.has(pid)) {
          frozen.add(pid);
          if (inFlight.has(pid)) trackStopped(pid, 'frozen', send);
        } else {
          // Not the process we meant any more (or we cannot tell): undo our stop and leave it alone.
          signal(pid, 'SIGCONT', guard);
          continued.add(pid);
        }
      }
      const next = new Map<number, string | null>();
      if (check && !check.selection.abort) {
        for (const [pid, identity] of check.selection.targets) if (!frozen.has(pid) && !continued.has(pid)) next.set(pid, identity);
      }
      if (frozen.size + next.size > maxPids) {
        log.error('kill-tree aborted: implausible number of processes for one session', { count: frozen.size + next.size, max: maxPids });
        for (const pid of frozen) signal(pid, 'SIGCONT', guard);
        return result('aborted', rounds, [...frozen, ...next.keys()], 'pid-cap');
      }
      toStop = next;
    }
    if (continued.size > 0) log.warn('kill-tree: a pid changed identity between scans; its stop was undone', { count: continued.size });
    for (const pid of frozen) if (signal(pid, 'SIGKILL', guard)) killed.add(pid);
    const pending = new Set(frozen);
    while (pending.size > 0 && now() < deadline) {
      const alive = await stillAlive(options.inspector, pending);
      if (alive === null || alive.length === 0) break;
      await sleep(POLL_MS);
    }
  }
  const final = await scan();
  const survivors = final && !final.selection.abort ? [...final.selection.targets.keys()] : [];
  if (survivors.length > 0) log.error('kill-tree: processes of the session survived', { count: survivors.length });
  return result(survivors.length === 0 ? 'done' : 'timeout', rounds, survivors);
}

async function stillAlive(inspector: ProcessInspector, pids: ReadonlySet<number>): Promise<number[] | null> {
  try {
    const rows = await inspector.table();
    return rows.filter((row) => pids.has(row.pid) && !row.zombie).map((row) => row.pid);
  } catch {
    return null;
  }
}

/** Live descendants (by ppid) of the PTY child with their identities, for KillTreeTarget.known. Bounded by `max`. */
export function rememberDescendants(rows: readonly ProcessRow[], rootPid: number, selfPid: number, uid: number, max: number): Map<number, KnownProcess> {
  const out = new Map<number, KnownProcess>();
  const root = rows.find((row) => row.pid === rootPid);
  // Only while the root is still our own child (see (a) in the file header).
  if (!root || root.ppid !== selfPid) return out;
  const children = new Map<number, ProcessRow[]>();
  for (const row of rows) {
    const list = children.get(row.ppid);
    if (list) list.push(row);
    else children.set(row.ppid, [row]);
  }
  const stack = [...(children.get(rootPid) ?? [])];
  while (stack.length > 0 && out.size < max) {
    const row = stack.pop() as ProcessRow;
    if (out.has(row.pid) || row.uid !== uid || row.zombie || row.start === undefined || row.command === undefined || !isPlausiblePid(row.pid)) continue;
    out.set(row.pid, { start: row.start, command: row.command });
    stack.push(...(children.get(row.pid) ?? []));
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// The real process table (macOS and Linux)
// ---------------------------------------------------------------------------------------------------------------

const PS = '/bin/ps';
const PS_ENV = { PATH: '/usr/bin:/bin', LC_ALL: 'C' };

function run(file: string, args: readonly string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(file, [...args], { env: PS_ENV, maxBuffer: 256 * 1024 * 1024, timeout: 10_000, encoding: 'utf8' }, (err, stdout) => {
      if (err) reject(err);
      else resolve(stdout);
    });
  });
}

/** `lstart`: "Mon Sep 28 13:50:05 2026" (day of month space-padded). */
const LSTART = '[A-Z][a-z]{2} [A-Z][a-z]{2} [ \\d]\\d \\d{2}:\\d{2}:\\d{2} \\d{4}';
const TABLE_LINE = new RegExp(`^\\s*(\\d+)\\s+(\\d+)\\s+(\\d+)\\s+(\\d+)\\s+(\\S+)(?:\\s+(${LSTART})(?:\\s+(.*?))?)?\\s*$`);

/** `ps -o pid=,ppid=,pgid=,uid=,stat=[,lstart=,command=]` */
export function parseProcessTable(stdout: string): ProcessRow[] {
  const rows: ProcessRow[] = [];
  for (const line of stdout.split('\n')) {
    const match = TABLE_LINE.exec(line);
    if (!match) continue;
    const [pid, ppid, pgid, uid] = [match[1], match[2], match[3], match[4]].map(Number) as [number, number, number, number];
    if (![pid, ppid, pgid, uid].every((n) => Number.isSafeInteger(n))) continue;
    const start = match[6];
    const command = match[7];
    rows.push({ pid, ppid, pgid, uid, zombie: (match[5] as string).startsWith('Z'), ...(start !== undefined ? { start, command: command ?? '' } : {}) });
  }
  return rows;
}

const COMMAND_LINE = new RegExp(`^\\s*(\\d+)\\s+(\\d+)\\s+(${LSTART})\\s+(.*?)\\s*$`);

/** Lines of `ps -o pid=,uid=,lstart=,command=` keyed by pid. */
function parseCommands(stdout: string): Map<number, { uid: number; start: string; line: string }> {
  const out = new Map<number, { uid: number; start: string; line: string }>();
  for (const raw of stdout.split('\n')) {
    const match = COMMAND_LINE.exec(raw);
    if (!match) continue;
    out.set(Number(match[1]), { uid: Number(match[2]), start: match[3] as string, line: match[4] as string });
  }
  return out;
}

/**
 * macOS: `ps -E` appends the environment to the command column (same-uid processes only; Apple platform binaries hide
 * theirs, pty-packaging.md gotcha 9). The command itself is read separately so an ARGUMENT that merely contains the
 * marker text (someone grepping for it) is never mistaken for the environment entry, and both reads must agree on the
 * process (start time + command line).
 */
export function envEntryPidsFromPs(plain: string, withEnv: string, entry: string, uid: number): Map<number, string> {
  const commands = parseCommands(plain);
  const out = new Map<number, string>();
  for (const [pid, { uid: owner, start, line }] of parseCommands(withEnv)) {
    if (owner !== uid) continue;
    const command = commands.get(pid);
    if (!command || command.uid !== uid || command.start !== start || !line.startsWith(command.line)) continue;
    const environment = line.slice(command.line.length);
    if (environment.length > 0 && !environment.startsWith(' ')) continue;
    if (environment.split(' ').includes(entry)) out.set(pid, identityOf({ start, command: command.line }) as string);
  }
  return out;
}

let ownGroup: Promise<number | null> | null = null;

/** The daemon's own process group (read once from the process table), or null when it cannot be read. */
export function ownProcessGroup(): Promise<number | null> {
  ownGroup ??= run(PS, ['-o', 'pgid=', '-p', String(process.pid)])
    .then((stdout) => {
      const pgid = Number(stdout.trim());
      return Number.isInteger(pgid) && pgid > 0 ? pgid : null;
    })
    .catch(() => null);
  return ownGroup;
}

const TABLE_ARGS = ['-A', '-ww', '-o', 'pid=,ppid=,pgid=,uid=,stat=,lstart=,command='];

export function systemProcessInspector(platform: NodeJS.Platform = process.platform): ProcessInspector {
  return {
    async table() {
      return parseProcessTable(await run(PS, TABLE_ARGS));
    },
    async withEnvEntry(entry, uid) {
      if (platform === 'darwin') {
        const [plain, withEnv] = await Promise.all([run(PS, ['-A', '-ww', '-o', 'pid=,uid=,lstart=,command=']), run(PS, ['-E', '-A', '-ww', '-o', 'pid=,uid=,lstart=,command='])]);
        return envEntryPidsFromPs(plain, withEnv, entry, uid);
      }
      if (platform === 'linux') return linuxEnvEntryPids(entry, uid);
      return new Map();
    },
  };
}

/**
 * Linux: /proc/<pid>/environ of the same-uid processes (unreadable ones are skipped), identities from the table read
 * before and re-read after: a pid whose identity changed in between is dropped. Verified on Ubuntu 24.04
 * (test/sessions/kill.test.ts: the detached daemon is found by its environment entry).
 */
async function linuxEnvEntryPids(entry: string, uid: number): Promise<Map<number, string>> {
  const before = parseProcessTable(await run(PS, TABLE_ARGS)).filter((row) => row.uid === uid && !row.zombie);
  const found: number[] = [];
  const names = new Set((await readdir('/proc')).filter((name) => /^\d+$/.test(name)).map(Number));
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < before.length) {
      const row = before[next++] as ProcessRow;
      if (!names.has(row.pid)) continue;
      try {
        const env = await readFile(`/proc/${row.pid}/environ`, 'latin1');
        if (env.split('\0').includes(entry)) found.push(row.pid);
      } catch {
        // gone, or not readable (setuid / other uid)
      }
    }
  };
  await Promise.all(Array.from({ length: 16 }, () => worker()));
  const after = new Map(parseProcessTable(await run(PS, TABLE_ARGS)).map((row) => [row.pid, row]));
  const beforeById = new Map(before.map((row) => [row.pid, row]));
  const out = new Map<number, string>();
  for (const pid of found) {
    const a = beforeById.get(pid);
    const b = after.get(pid);
    const identity = a ? identityOf(a) : null;
    if (a && b && identity !== null && identity === identityOf(b)) out.set(pid, identity);
  }
  return out;
}
