// A `smurg` command and a daemon of ANOTHER smurg version on one machine (0.5.1, DESIGN B1 and B2).
//
// Where it comes from (W/FOUND-U6, proofs p1, p2 and p8, run with the real code of v0.4.0 against v0.5.0): the control
// socket has no version of its own and its answers were read strictly, so a command took a daemon whose answer it
// could not read for "nothing is running": `smurg status` said "No workspace is being shared." (exit 3), `smurg stop`
// said "No smurg host is running" while the host kept sharing, `smurg update` passed its "are you sharing?" check, and
// a local `smurg attach` waited 30 s for an answer it had dropped.
//
// Every "daemon" here is a stand-in: a Unix socket in SMURG_HOME's run dir that answers with bytes this test wrote (as
// 0.4.0's daemon answers, as a later one might, never, or with something that is no answer at all). Nothing is
// started and nothing is signalled. The strict side (what the daemon sends) is untouched: its own tests are
// packages/daemon/test/local/**.
import { chmod, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { createServer, type Server, type Socket } from 'node:net';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  CTL_FRAME_KIND,
  CtlFrameDecoder,
  CtlProtocolError,
  commandCtlResponseSchema,
  commandDaemonStatusSchema,
  ctlResponseSchema,
  daemonStatusSchema,
  encodeCtlControl,
  encodeCtlFrame,
  readCtlResponse,
  runPathsFor,
  type CtlStatus,
} from '@smurg/daemon';
import { decodeEnvelope, welcomeSchema } from '@smurg/protocol';
import { probeDaemon, probeDaemons } from '../src/channel/discover.ts';
import { ctlAsk } from '../src/channel/local-channel.ts';
import { formatFailure } from '../src/cli/errors.ts';
import { runCli } from '../src/cli/run.ts';
import { runAttach } from '../src/commands/attach.ts';
import { commandContext } from '../src/commands/context.ts';
import { runStop } from '../src/commands/stop.ts';
import { runUninstall } from '../src/commands/uninstall.ts';
import { runUpdate } from '../src/commands/update.ts';
import { statePaths } from '../src/state/paths.ts';
import { rememberSharedFolder } from '../src/state/workspaces.ts';
import { CLI_VERSION } from '../src/version.ts';
import { makeDirs, testIo, type Dirs } from './helpers.ts';

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  while (cleanups.length > 0) await Promise.resolve((cleanups.pop() as () => Promise<void> | void)()).catch(() => {});
});

async function setup(): Promise<{ dirs: Dirs; env: Record<string, string> }> {
  const dirs = await makeDirs();
  cleanups.push(() => dirs.cleanup());
  return { dirs, env: { HOME: dirs.home, SMURG_HOME: dirs.stateDir } };
}

// ── What the daemons of the published versions answer ───────────────────────────────────────────────────────────────

/** `daemon.status()` of 0.4.0, key for key (W/U6/p8-ctl-real-socket.mjs ran 0.4.0's real ControlServer with it). */
const STATUS_040 = (workspaceId: string): Record<string, unknown> => ({
  workspaceId,
  started: true,
  stopped: false,
  relay: { interactive: 'online', transfer: 'online' },
  connections: 0,
  onlineMembers: 0,
  power: { active: true, mechanism: 'caffeinate', pid: 4242, reason: null },
  handshakes: { handshakes: 0, accepted: 0, failed: 0, refusedByRateLimit: 0, kickedForFailures: 0, kickedIdle: 0 },
  fingerprint: 'AAAA BBBB CCCC DDDD',
  relayUrl: 'https://app.smurg.ai',
  switches: { attributeBashEdits: true },
  isGitRepo: true,
});

/** What `smurg host` of 0.5.0 answers: every agent module is composed, and the answer names the web app. */
const STATUS_050 = (workspaceId: string): Record<string, unknown> => ({
  ...STATUS_040(workspaceId),
  claude: { version: '2.1.288', verdict: 'verified', login: 'logged-in' },
  agents: { running: 1, waiting: 0, stalled: 0, idle: 2 },
  topics: { total: 3, paused: 1 },
  projectSettings: 'none',
  hostRules: { count: 0 },
});

/** A later smurg that only ADDED keys: in the answer, in the status and in every object inside it. */
const STATUS_LATER = (workspaceId: string): Record<string, unknown> => {
  const base = STATUS_050(workspaceId) as Record<string, Record<string, unknown>>;
  return {
    ...base,
    smurg: '0.7.0',
    protocol: 5,
    queue: { depth: 0 },
    relay: { ...base['relay'], latencyMs: 12 },
    power: { ...base['power'], since: 1 },
    handshakes: { ...base['handshakes'], refusedByVersion: 2 },
    switches: { ...base['switches'], somethingNew: true },
    claude: { ...base['claude'], path: '/usr/local/bin/claude' },
    agents: { ...base['agents'], paused: 0 },
    topics: { ...base['topics'], archived: 4 },
    hostRules: { ...base['hostRules'], rules: ['Bash(ls:*)'] },
  };
};

const json = (value: unknown): Uint8Array => new TextEncoder().encode(JSON.stringify(value));
const control = (value: unknown): Uint8Array => encodeCtlFrame(CTL_FRAME_KIND.control, json(value));

// ── The stand-in control socket ─────────────────────────────────────────────────────────────────────────────────────

interface StandIn {
  readonly path: string;
  /** Every CONTROL request received, parsed. */
  readonly requests: unknown[];
  readonly server: Server;
  readonly listening: () => boolean;
  /** Stops listening and removes the socket (what a daemon does last when it stops). */
  close(): Promise<void>;
}

type Answer = (socket: Socket, request: { op?: unknown }, standIn: StandIn) => void;

/** A Unix socket at the control-socket path of `workspaceId` that hands every CONTROL request to `answer`. */
async function standIn(env: Record<string, string>, workspaceId: string, answer: Answer, onEnvelope?: (socket: Socket, body: Uint8Array) => void): Promise<StandIn> {
  const path = runPathsFor(statePaths(env).runDir, workspaceId).ctl;
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const sockets = new Set<Socket>();
  const requests: unknown[] = [];
  let listening = true;
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => undefined);
    const decoder = new CtlFrameDecoder();
    socket.on('data', (chunk: Buffer) => {
      for (const frame of decoder.push(new Uint8Array(chunk))) {
        if (frame.kind === CTL_FRAME_KIND.control) {
          const request = JSON.parse(new TextDecoder().decode(frame.body)) as { op?: unknown };
          requests.push(request);
          answer(socket, request, self);
        } else onEnvelope?.(socket, frame.body);
      }
    });
  });
  const self: StandIn = {
    path,
    requests,
    server,
    listening: () => listening,
    close: () =>
      new Promise<void>((resolve) => {
        if (!listening) return resolve();
        listening = false;
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
      }),
  };
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(path, resolve);
  });
  cleanups.push(() => self.close());
  return self;
}

/** Answers `status` with `status()` as a raw CONTROL frame, and `stop` as every published version does (then stops). */
const answering =
  (status: (workspaceId: string) => unknown, extra: Record<string, unknown> = {}, workspaceId = ''): Answer =>
  (socket, request, self) => {
    if (request.op === 'status') socket.end(control({ ok: true, op: 'status', status: status(workspaceId), ...extra }));
    else if (request.op === 'stop') {
      socket.end(control({ ok: true, op: 'stop' }));
      void self.close();
    } else socket.destroy();
  };

/** The ways a daemon of another version (or no smurg at all) fails to give this command a status it can read. */
const UNREADABLE: Readonly<Record<string, { readonly answer: (workspaceId: string) => Answer; readonly why: string }>> = {
  'a later smurg whose status changed a value this smurg knows (a new keep-awake mechanism)': {
    answer: (workspaceId) => (socket, request, self) => {
      if (request.op === 'status') {
        const status = STATUS_050(workspaceId) as Record<string, Record<string, unknown>>;
        socket.end(control({ ok: true, op: 'status', status: { ...status, power: { ...status['power'], mechanism: 'pmset' } } }));
      } else answering(STATUS_050, {}, workspaceId)(socket, request, self);
    },
    why: 'its answer is not one this smurg can read',
  },
  'an answer that never comes': {
    answer: (workspaceId) => (socket, request, self) => {
      if (request.op === 'stop') answering(STATUS_050, {}, workspaceId)(socket, request, self);
      // status: the connection stays open and nothing is ever written.
    },
    why: 'it did not answer',
  },
  'garbage instead of a frame': {
    answer: (workspaceId) => (socket, request, self) => {
      if (request.op === 'stop') answering(STATUS_050, {}, workspaceId)(socket, request, self);
      else socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
    },
    why: 'its answer is not one this smurg can read',
  },
  'a control frame that is not JSON': {
    answer: (workspaceId) => (socket, request, self) => {
      if (request.op === 'stop') answering(STATUS_050, {}, workspaceId)(socket, request, self);
      else socket.end(encodeCtlFrame(CTL_FRAME_KIND.control, new Uint8Array([0xff, 0xfe, 0x00, 0x7b])));
    },
    why: 'its answer is not one this smurg can read',
  },
  'a connection closed without an answer': {
    answer: (workspaceId) => (socket, request, self) => {
      if (request.op === 'stop') answering(STATUS_050, {}, workspaceId)(socket, request, self);
      else socket.destroy();
    },
    why: 'it closed the connection without an answer',
  },
};

// ── The two sides of the schema ─────────────────────────────────────────────────────────────────────────────────────

interface Shaped {
  readonly shape?: Record<string, Shaped>;
  readonly def?: { readonly type?: string; readonly catchall?: { readonly def?: { readonly type?: string } }; readonly innerType?: Shaped; readonly options?: readonly Shaped[] };
}

/** Every object of a schema as `path -> { keys, strict }` (through optional / nullable wrappers). */
function objectsOf(schema: Shaped, path = '$', out = new Map<string, { keys: string[]; strict: boolean }>()): Map<string, { keys: string[]; strict: boolean }> {
  let inner = schema;
  while (inner.def?.innerType !== undefined) inner = inner.def.innerType;
  if (inner.shape !== undefined) {
    out.set(path, { keys: Object.keys(inner.shape).sort(), strict: inner.def?.catchall?.def?.type === 'never' });
    for (const [key, value] of Object.entries(inner.shape)) objectsOf(value, `${path}.${key}`, out);
  }
  return out;
}

describe('the control socket has two schemas: what the daemon sends (strict) and what a command reads (unknown keys ignored)', () => {
  it('both name the same keys at every level of the status; the strict one is strict at every level, the command one at none', () => {
    const sent = objectsOf(daemonStatusSchema as unknown as Shaped);
    const read = objectsOf(commandDaemonStatusSchema as unknown as Shaped);
    expect([...read.keys()].sort()).toEqual([...sent.keys()].sort());
    // Nine objects: the status, relay, power, handshakes, switches, claude, agents, topics, hostRules.
    expect(sent.size).toBe(9);
    for (const [path, object] of sent) {
      expect(read.get(path)?.keys, path).toEqual(object.keys);
      expect(object.strict, `the daemon's ${path} must be strict`).toBe(true);
      expect(read.get(path)?.strict, `the command's ${path} must ignore unknown keys`).toBe(false);
    }
  });

  it('the answers have the same four forms on both sides, strict on one and not on the other', () => {
    const forms = (schema: unknown): { keys: string[]; strict: boolean }[] =>
      ((schema as Shaped).def?.options ?? []).map((option) => objectsOf(option).get('$') as { keys: string[]; strict: boolean });
    const sent = forms(ctlResponseSchema);
    const read = forms(commandCtlResponseSchema);
    expect(sent.map((f) => f.keys)).toEqual([['ok', 'op', 'status', 'webOrigin'], ['ok', 'op'], ['ok', 'op', 'welcome'], ['error', 'ok']]);
    expect(read.map((f) => f.keys)).toEqual(sent.map((f) => f.keys));
    expect(sent.map((f) => f.strict)).toEqual([true, true, true, true]);
    expect(read.map((f) => f.strict)).toEqual([false, false, false, false]);
  });

  it("a command reads 0.4.0's answer, 0.5.0's, and a later one that only added keys (at every level); the daemon's encoder still refuses to send such keys", () => {
    const id = 'ws_AAAAAAAAAAAAAAAAAAAAAA';
    const from040 = readCtlResponse(json({ ok: true, op: 'status', status: STATUS_040(id) }));
    expect(from040).toMatchObject({ ok: true, op: 'status', status: { workspaceId: id, fingerprint: 'AAAA BBBB CCCC DDDD' } });
    expect(from040.ok && from040.op === 'status' ? [from040.status.agents, from040.status.claude, 'webOrigin' in from040] : null).toEqual([undefined, undefined, false]);

    const from050 = readCtlResponse(json({ ok: true, op: 'status', status: STATUS_050(id), webOrigin: 'https://app.smurg.ai' }));
    expect(from050).toMatchObject({ ok: true, op: 'status', webOrigin: 'https://app.smurg.ai', status: { agents: { running: 1, idle: 2 }, topics: { total: 3, paused: 1 } } });

    const later = { ok: true, op: 'status', status: STATUS_LATER(id), webOrigin: 'https://app.smurg.ai', daemon: { smurg: '0.7.0' } };
    const fromLater = readCtlResponse(json(later));
    // What this command knows is read; what it does not know is not carried along.
    expect(fromLater).toEqual({ ok: true, op: 'status', status: STATUS_050(id), webOrigin: 'https://app.smurg.ai' });
    // The strict side: the same answer is refused when read strictly, and can never be SENT.
    expect(ctlResponseSchema.safeParse(later).success).toBe(false);
    expect(() => encodeCtlControl(later as never)).toThrow(CtlProtocolError);
    expect(readCtlResponse(json({ ok: true, op: 'stop', stoppedAt: 5 }))).toEqual({ ok: true, op: 'stop' });
  });

  it('a key this command knows keeps its rule: a changed value, a missing required key or a wrong type is not read (the daemon is then "another version")', () => {
    const id = 'ws_AAAAAAAAAAAAAAAAAAAAAA';
    const ok = STATUS_050(id) as Record<string, Record<string, unknown>>;
    expect(commandDaemonStatusSchema.safeParse(ok).success).toBe(true);
    const { workspaceId: _gone, ...withoutId } = ok;
    for (const bad of [
      { ...ok, power: { ...ok['power'], mechanism: 'pmset' } },
      { ...ok, claude: { ...ok['claude'], verdict: 'fine' } },
      { ...ok, claude: { ...ok['claude'], login: 'maybe' } },
      { ...ok, agents: { running: 1 } },
      { ...ok, agents: { ...ok['agents'], running: -1 } },
      { ...ok, topics: { total: 1.5, paused: 0 } },
      { ...ok, projectSettings: 'trusted' },
      { ...ok, connections: '3' },
      { ...ok, relay: 'online' },
      withoutId,
    ]) {
      expect(commandDaemonStatusSchema.safeParse(bad).success, JSON.stringify(bad).slice(-90)).toBe(false);
      expect(() => readCtlResponse(json({ ok: true, op: 'status', status: bad })), JSON.stringify(bad).slice(-90)).toThrow(CtlProtocolError);
    }
    for (const notAnAnswer of [{}, [], 'ok', null, { ok: true }, { ok: true, op: 'restart' }, { ok: 'yes', op: 'stop' }, { ok: false }, { ok: false, error: 'no' }, { ok: true, op: 'status', status: ok, webOrigin: '' }]) {
      expect(() => readCtlResponse(json(notAnAnswer)), JSON.stringify(notAnAnswer)).toThrow(CtlProtocolError);
    }
    expect(() => readCtlResponse(new Uint8Array([0x7b, 0xff]))).toThrow(CtlProtocolError);
  });

  it('a refusal is read for what a command shows of it: also one with a code or keys of a later smurg', () => {
    expect(readCtlResponse(json({ ok: false, error: { code: 'forbidden', message: 'no', text: { id: 'error.forbidden' } } }))).toEqual({ ok: false, error: { code: 'forbidden', message: 'no', text: { id: 'error.forbidden' } } });
    expect(readCtlResponse(json({ ok: false, error: { code: 'code_of_a_later_smurg', message: 'not now', detail: { a: 1 }, retryAfterMs: 5 }, at: 9 }))).toEqual({ ok: false, error: { code: 'code_of_a_later_smurg', message: 'not now' } });
  });
});

// ── B1: the three answers ───────────────────────────────────────────────────────────────────────────────────────────

describe('what is behind a control socket has three answers (probeDaemon)', () => {
  it('nothing there (no socket, or a socket nobody listens on); readable; alive but unreadable', async () => {
    const { env } = await setup();
    const paths = statePaths(env);
    const missing = runPathsFor(paths.runDir, 'ws_probe_nothing_0001').ctl;
    expect(await probeDaemon(missing)).toEqual({ kind: 'none' });
    expect(await ctlAsk(missing, { v: 1, op: 'status' })).toEqual({ kind: 'nothing' });

    // A file in the run dir that nobody listens on (what is left of a daemon that died hard): the connect fails.
    await mkdir(paths.runDir, { recursive: true, mode: 0o700 });
    const stale = join(paths.runDir, 'aaaaaaaaaaaa.ctl');
    await writeFile(stale, '');
    expect(await ctlAsk(stale, { v: 1, op: 'status' })).toEqual({ kind: 'nothing' });
    expect(await probeDaemon(stale)).toEqual({ kind: 'none' });

    const old = 'ws_probe_readable_01';
    await standIn(env, old, answering(STATUS_040, {}, old));
    const readable = await probeDaemon(runPathsFor(paths.runDir, old).ctl);
    expect(readable).toMatchObject({ kind: 'running', daemon: { status: { workspaceId: old }, webOrigin: null } });

    const mute = 'ws_probe_mute_00001';
    const silent = await standIn(env, mute, () => undefined);
    const started = Date.now();
    expect(await probeDaemon(silent.path, 300)).toEqual({ kind: 'unreadable', daemon: { ctlPath: silent.path, why: 'no-answer', workspaceId: null, folder: null } });
    expect(Date.now() - started).toBeLessThan(2_500);

    // Every socket of the run dir, each in its place; the file nobody listens on is not there at all.
    const all = await probeDaemons(paths);
    expect(all.running.map((d) => d.status.workspaceId)).toEqual([old]);
    expect(all.unreadable.map((d) => d.ctlPath)).toEqual([silent.path]);
  });

  it('a refusal of `status`, or the answer to another request, is not a status: alive but unreadable', async () => {
    const { env } = await setup();
    const refusing = await standIn(env, 'ws_probe_refuses_001', (socket) => socket.end(control({ ok: false, error: { code: 'forbidden', message: 'no' } })));
    expect(await probeDaemon(refusing.path)).toMatchObject({ kind: 'unreadable', daemon: { why: 'not-understood' } });
    const other = await standIn(env, 'ws_probe_other_0001', (socket) => socket.end(control({ ok: true, op: 'stop' })));
    expect(await probeDaemon(other.path)).toMatchObject({ kind: 'unreadable', daemon: { why: 'not-understood' } });
  });
});

describe('smurg status and a daemon of another version', () => {
  it("reads a daemon that answers as 0.4.0's does, and a later one that only added keys: the workspace is shown, exit 0", async () => {
    const { dirs, env } = await setup();
    const old = 'ws_other_040_000001';
    const later = 'ws_other_later_0001';
    await standIn(env, old, answering(STATUS_040, {}, old));
    await standIn(env, later, answering(STATUS_LATER, { webOrigin: 'https://app.smurg.ai', daemon: { smurg: '0.7.0' } }, later));
    await rememberSharedFolder(statePaths(env), { folder: dirs.project, relay: 'https://app.smurg.ai', workspaceId: old, createdAt: 1 });
    const io = testIo({ env });
    expect(await runCli(['status'], io)).toBe(0);
    expect(io.out()).toContain(`Workspace ${old}\n  Folder: ${dirs.project}\n`);
    expect(io.out()).toContain('  Daemon key fingerprint: AAAA BBBB CCCC DDDD\n');
    expect(io.out()).toContain(`Workspace ${later}\n`);
    expect(io.out()).toContain('  Claude Code: 2.1.288 (verified with this smurg), logged in\n');
    expect(io.out()).toContain('  Topics: 3 (1 paused)\n');
    expect(io.out()).not.toContain('another version');
    expect(io.err()).toBe('');
  });

  for (const [name, { answer, why }] of Object.entries(UNREADABLE)) {
    it(`${name}: says a smurg host of another version is sharing (exit 5), never "No workspace is being shared"`, async () => {
      const { dirs, env } = await setup();
      const id = 'ws_other_unread_001';
      const host = await standIn(env, id, answer(id));
      // Unknown to workspaces.json: only the socket can be named.
      const anonymous = testIo({ env });
      expect(await runCli(['status'], anonymous)).toBe(5);
      expect(anonymous.out()).toBe(
        [
          `A workspace (control socket ${host.path})`,
          `  A smurg host of another version is sharing it (this smurg is ${CLI_VERSION}): ${why}.`,
          '  To stop it: smurg stop, or Ctrl-C in the terminal that runs smurg host. To use this smurg, start it again with smurg host.',
          '',
        ].join('\n'),
      );
      expect(anonymous.out()).not.toContain('No workspace is being shared');
      // Remembered: named by workspace and folder, and `--workspace` finds it too.
      await rememberSharedFolder(statePaths(env), { folder: dirs.project, relay: 'https://app.smurg.ai', workspaceId: id, createdAt: 1 });
      for (const args of [['status'], ['status', '--workspace', id]]) {
        const io = testIo({ env });
        expect(await runCli(args, io), args.join(' ')).toBe(5);
        expect(io.out()).toBe(
          [
            `Workspace ${id}`,
            `  Folder: ${dirs.project}`,
            `  A smurg host of another version is sharing it (this smurg is ${CLI_VERSION}): ${why}.`,
            `  To stop it: smurg stop --workspace ${id}, or Ctrl-C in the terminal that runs smurg host. To use this smurg, start it again with smurg host.`,
            '',
          ].join('\n'),
        );
      }
      // Nothing was asked of it but its status.
      expect(host.requests.every((request) => JSON.stringify(request) === '{"v":1,"op":"status"}')).toBe(true);
    }, 30_000);
  }

  it('beside a daemon it can read: both are shown, and the exit code says that one could not be read', async () => {
    const { env } = await setup();
    const readable = 'ws_other_mixed_ok_01';
    const other = 'ws_other_mixed_no_01';
    await standIn(env, readable, answering(STATUS_050, {}, readable));
    await standIn(env, other, (UNREADABLE['garbage instead of a frame'] as (typeof UNREADABLE)[string]).answer(other));
    const io = testIo({ env });
    expect(await runCli(['status'], io)).toBe(5);
    expect(io.out()).toContain(`Workspace ${readable}\n`);
    expect(io.out()).toContain('A smurg host of another version is sharing it');
    const zh = testIo({ env: { ...env, SMURG_LANG: 'zh-TW' } });
    expect(await runCli(['status', '--workspace', other], zh)).toBe(5);
    expect(zh.out()).toContain(`工作區 ${other}\n  正由另一個版本的 smurg host 分享（這個 smurg 是 ${CLI_VERSION}）：它的回應這個 smurg 讀不懂。\n`);
  });
});

describe('smurg stop and a daemon of another version', () => {
  for (const [name, { answer }] of Object.entries(UNREADABLE)) {
    it(`${name}: still sends { v: 1, op: 'stop' }, waits for the socket to go and says what happened`, async () => {
      const { env } = await setup();
      const id = 'ws_other_stop_00001';
      const host = await standIn(env, id, answer(id));
      const io = testIo({ env });
      expect(await runCli(['stop'], io)).toBe(0);
      expect(io.out()).toBe(`A smurg host of another version is sharing here (this smurg is ${CLI_VERSION}); asking it to stop...\nStopped sharing.\n`);
      expect(host.requests.map((request) => JSON.stringify(request))).toContain('{"v":1,"op":"stop"}');
      expect(host.requests.filter((request) => (request as { op?: unknown }).op === 'stop')).toHaveLength(1);
      expect(host.listening()).toBe(false);
      // Now nothing is there: the usual answer.
      const after = testIo({ env });
      expect(await runCli(['stop'], after)).toBe(3);
      expect(after.err()).toContain('smurg: No smurg host is running');
    }, 30_000);
  }

  it('one that does not confirm in a form this smurg reads and stops all the same is reported as stopped; one that goes on sharing is not', async () => {
    const { env } = await setup();
    const id = 'ws_other_stop_odd_01';
    // `stop` is answered with garbage, then the daemon goes away.
    const odd = await standIn(env, id, (socket, request, self) => {
      if (request.op === 'stop') {
        socket.end('??');
        void self.close();
      } else socket.end('??');
    });
    const io = testIo({ env });
    expect(await runCli(['stop', '--workspace', id], io)).toBe(0);
    expect(io.out()).toBe(`A smurg host of another version is sharing workspace ${id} (this smurg is ${CLI_VERSION}); asking it to stop...\nStopped sharing.\n`);
    expect(odd.listening()).toBe(false);

    // One that takes the request and keeps sharing: said after the wait, with the one thing left to do.
    const stubborn = await standIn(env, id, (socket) => socket.end('??'));
    const stuck = testIo({ env });
    const failure = await runStop(['--workspace', id], commandContext(stuck), { stopWaitMs: 1_000 }).then(
      () => null,
      (err: unknown) => formatFailure(err, 'en'),
    );
    expect(failure).toEqual({ text: 'smurg: The smurg host of another version did not stop within 1 second\n  Press Ctrl-C in the terminal that runs smurg host.\n', exitCode: 1 });
    expect(stubborn.listening()).toBe(true);
    expect(stubborn.requests.some((request) => JSON.stringify(request) === '{"v":1,"op":"stop"}')).toBe(true);
  });

  it("stops a daemon that answers as 0.4.0's does, and names several shares (readable or not) to choose from", async () => {
    const { env } = await setup();
    const old = 'ws_other_stop_040_1';
    const host = await standIn(env, old, answering(STATUS_040, {}, old));
    const io = testIo({ env });
    expect(await runCli(['stop'], io)).toBe(0);
    expect(io.out()).toBe(`Stopping the share of workspace ${old}...\nStopped sharing.\n`);
    expect(host.listening()).toBe(false);

    const a = 'ws_other_stop_two_a';
    const b = 'ws_other_stop_two_b';
    await standIn(env, a, answering(STATUS_050, {}, a));
    const unreadable = await standIn(env, b, (UNREADABLE['a connection closed without an answer'] as (typeof UNREADABLE)[string]).answer(b));
    const several = testIo({ env });
    expect(await runCli(['stop'], several)).toBe(2);
    expect(several.err()).toContain('Several workspaces are being shared; choose one with --workspace');
    expect(several.err()).toContain(a);
    expect(several.err()).toContain(unreadable.path.slice(unreadable.path.lastIndexOf('/') + 1));
    // Chosen by its id, the unreadable one is asked to stop.
    const chosen = testIo({ env });
    expect(await runCli(['stop', '--workspace', b], chosen)).toBe(0);
    expect(unreadable.listening()).toBe(false);
  });
});

describe('smurg host, update and uninstall treat a folder shared by another version as shared, and say why they stop', () => {
  it('smurg host: the same folder, a folder inside it and a folder above it are refused before any login', async () => {
    const { dirs, env } = await setup();
    const id = 'ws_other_host_00001';
    const relay = 'http://127.0.0.1:9';
    const host = await standIn(env, id, (UNREADABLE['an answer that never comes'] as (typeof UNREADABLE)[string]).answer(id));
    const { realpath } = await import('node:fs/promises');
    const project = await realpath(dirs.project);
    const inside = join(project, 'docs');
    await mkdir(inside);
    await rememberSharedFolder(statePaths(env), { folder: project, relay, workspaceId: id, createdAt: 1 });

    const same = testIo({ env });
    expect(await runCli(['host', project, '--relay', relay], same)).toBe(1);
    expect(same.err()).toBe(
      `smurg: This folder is already being shared, by a smurg host of another version (this smurg is ${CLI_VERSION}): it did not answer\n` +
        '  Stop it (smurg stop, or Ctrl-C in the terminal that runs smurg host), then start it again with smurg host.\n',
    );
    const sub = testIo({ env });
    expect(await runCli(['host', inside, '--relay', relay], sub)).toBe(1);
    expect(sub.err()).toBe(
      `smurg: A folder above this one (${project}) is already being shared\n` +
        `  It is workspace ${id}, shared by a smurg host of another version (this smurg is ${CLI_VERSION}).\n` +
        `  Stop it first: smurg stop --workspace ${id}, or Ctrl-C in the terminal that runs smurg host.\n`,
    );
    // Nothing was written, nobody was asked to log in, and the other host was only asked for its status.
    expect(same.opened.concat(sub.opened)).toEqual([]);
    expect(await readdir(dirs.stateDir)).toEqual(expect.not.arrayContaining(['credentials.json', 'workspaces']));
    expect(host.requests.every((request) => (request as { op?: unknown }).op === 'status')).toBe(true);
  }, 60_000);

  it('smurg update: nothing is downloaded or replaced under it', async () => {
    const { dirs, env } = await setup();
    const id = 'ws_other_update_001';
    await standIn(env, id, (UNREADABLE['garbage instead of a frame'] as (typeof UNREADABLE)[string]).answer(id));
    const executable = join(dirs.home, 'smurg');
    await writeFile(executable, 'the installed executable\n', { mode: 0o755 });
    const asked: string[] = [];
    const fetch = (async (url: string | URL | Request) => {
      asked.push(String(url));
      return String(url).endsWith('/latest/VERSION') ? new Response('9.9.9\n', { status: 200 }) : new Response('no', { status: 404 });
    }) as typeof globalThis.fetch;
    const io = testIo({ env: { ...env, SMURG_INSTALL_BASE_URL: 'http://127.0.0.1:9' } });
    const failure = await runUpdate([], commandContext(io), { executable, version: '0.5.0', platform: 'linux', arch: 'x64', fetch }).then(
      () => null,
      (err: unknown) => formatFailure(err, 'en'),
    );
    const label = runPathsFor(statePaths(env).runDir, id).ctl.split('/').pop() as string;
    expect(failure).toEqual({
      text:
        `smurg: A smurg host of another version is sharing on this computer (${label}; this smurg is 0.5.0); nothing was updated\n` +
        '  Stop it first (smurg stop, or Ctrl-C in the terminal that runs smurg host), then run smurg update again.\n' +
        '  An update while it shares would mix the daemon that is still running with the new smurg commands.\n',
      exitCode: 1,
    });
    expect(asked).toEqual(['http://127.0.0.1:9/latest/VERSION']);
    expect(await readFile(executable, 'utf8')).toBe('the installed executable\n');
    expect(await readdir(dirs.home)).toEqual(expect.not.arrayContaining([expect.stringMatching(/^\.smurg-update-/)]));
  });

  it('smurg uninstall --yes: refuses before the plan, nothing is removed and the other host is not asked to stop', async () => {
    const { dirs, env } = await setup();
    const id = 'ws_other_uninst_001';
    const host = await standIn(env, id, (UNREADABLE['a connection closed without an answer'] as (typeof UNREADABLE)[string]).answer(id));
    await rememberSharedFolder(statePaths(env), { folder: dirs.project, relay: 'https://app.smurg.ai', workspaceId: id, createdAt: 1 });
    const executable = join(dirs.home, '.local', 'bin', 'smurg');
    await mkdir(dirname(executable), { recursive: true });
    await writeFile(executable, 'the installed executable\n');
    await chmod(executable, 0o755);
    const io = testIo({ env });
    const failure = await runUninstall(['--yes'], commandContext(io), { executable, platform: 'linux' }).then(
      () => null,
      (err: unknown) => formatFailure(err, 'en'),
    );
    expect(failure).toEqual({
      text:
        `smurg: A smurg host of another version is sharing on this computer (${id}); nothing was removed\n` +
        '  Stop it first (smurg stop, or Ctrl-C in the terminal that runs smurg host), then run smurg uninstall again.\n',
      exitCode: 1,
    });
    expect(io.out()).not.toContain('will remove');
    expect((await stat(executable)).isFile()).toBe(true);
    expect((await stat(join(dirs.stateDir, 'workspaces.json'))).isFile()).toBe(true);
    expect(host.requests.every((request) => (request as { op?: unknown }).op === 'status')).toBe(true);
    expect(host.listening()).toBe(true);
  });
});

// ── B2: a local attach ──────────────────────────────────────────────────────────────────────────────────────────────

/** A welcome every published version accepts (the schema did not change between 0.4.0 and 0.5.0: W/U6/p2). */
const WELCOME = (workspaceId: string): Record<string, unknown> => ({
  channelId: 'ch_0123456789abcdef0123456789abcdef',
  resumed: false,
  member: { userId: 'google:1234567890', displayName: 'Host', role: 'host', color: '#3366cc', online: true, joinedAt: 1_759_000_000_000 },
  workspace: { id: workspaceId, name: 'tidepool', hostUserId: 'google:1234567890', hostName: 'Host', platform: 'darwin', isGitRepo: true },
  settings: { humanLockIdleMs: 60_000, agentLockTimeoutMs: 120_000, uploadChunkSize: 1_048_576, sharedDirs: [] },
  serverTime: 1_759_000_000_000,
});

/** msgpack by hand for `{ type, id, seq: 1, payload: { sessions: [] } }`: the `session.list.ok` 0.4.0's daemon sends (no `hasMore`). */
function sessionListOkOf040(id: string): Uint8Array {
  const str = (text: string): number[] => {
    const bytes = [...new TextEncoder().encode(text)];
    if (bytes.length > 31) throw new Error('fixstr only');
    return [0xa0 | bytes.length, ...bytes];
  };
  return new Uint8Array([0x84, ...str('type'), ...str('session.list.ok'), ...str('id'), ...str(id), ...str('seq'), 0x01, ...str('payload'), 0x81, ...str('sessions'), 0x90]);
}

describe('smurg attach on the host and a daemon of another version', () => {
  it('the welcome sample is one today\'s protocol accepts, and the 0.4.0 session list is one it does not', () => {
    expect(welcomeSchema.safeParse(WELCOME('ws_AAAAAAAAAAAAAAAAAAAAAA')).success).toBe(true);
    const decoded = decodeEnvelope(sessionListOkOf040('l123456-1'), { from: 'daemon', channel: 'interactive' });
    expect(decoded.ok).toBe(false);
  });

  it("a daemon that answers as 0.4.0's does: the attach is accepted, the first answer cannot be decoded, and the command ends AT ONCE saying another version is sharing (it used to wait 30 s)", async () => {
    const { env } = await setup();
    const id = 'ws_other_attach_001';
    const host = await standIn(
      env,
      id,
      (socket, request, self) => {
        if (request.op === 'attach') socket.write(control({ ok: true, op: 'attach', welcome: WELCOME(id) }));
        else answering(STATUS_040, {}, id)(socket, request, self);
      },
      (socket, body) => {
        const asked = decodeEnvelope(body, { from: 'client', channel: 'interactive' });
        if (asked.ok && asked.envelope.type === 'session.list') socket.write(encodeCtlFrame(CTL_FRAME_KIND.envelope, sessionListOkOf040(asked.envelope.id)));
      },
    );
    for (const args of [[], ['--workspace', id]]) {
      const io = testIo({ env });
      const started = Date.now();
      const failure = await runAttach(args, commandContext(io)).then(
        () => null,
        (err: unknown) => formatFailure(err, 'en'),
      );
      expect(Date.now() - started, 'no 30 s wait').toBeLessThan(10_000);
      expect(failure).toEqual({
        text:
          `smurg: Another version of smurg is sharing here (this smurg is ${CLI_VERSION}): it sent a message this smurg cannot read\n` +
          '  Stop it (smurg stop, or Ctrl-C in the terminal that runs smurg host), then start it again with smurg host.\n',
        exitCode: 1,
      });
    }
    expect(host.requests.filter((request) => (request as { op?: unknown }).op === 'attach')).toHaveLength(2);
    // The same in the second language.
    const zh = testIo({ env: { ...env, SMURG_LANG: 'zh-TW' } });
    const failure = await runAttach([], commandContext(zh)).then(
      () => null,
      (err: unknown) => formatFailure(err, 'zh-TW'),
    );
    expect(failure?.text).toBe(`smurg：這裡正由另一個版本的 smurg 分享（這個 smurg 是 ${CLI_VERSION}）：它送來這個 smurg 讀不懂的訊息\n  請先停止它（smurg stop，或到執行 smurg host 的終端機按 Ctrl-C），再用 smurg host 重新啟動。\n`);
  }, 60_000);

  it('a frame that is no frame after the attach, and an attach answer this smurg cannot read, end it the same way', async () => {
    const { env } = await setup();
    const id = 'ws_other_attach_002';
    await standIn(
      env,
      id,
      (socket, request, self) => {
        if (request.op === 'attach') socket.write(control({ ok: true, op: 'attach', welcome: WELCOME(id) }));
        else answering(STATUS_050, {}, id)(socket, request, self);
      },
      (socket) => socket.write(new Uint8Array([0, 0, 0, 2, 0x09, 0x00])),
    );
    const garbage = await runAttach([], commandContext(testIo({ env }))).then(
      () => null,
      (err: unknown) => formatFailure(err, 'en'),
    );
    expect(garbage?.text).toContain(`smurg: Another version of smurg is sharing here (this smurg is ${CLI_VERSION}): it sent a message this smurg cannot read\n`);

    // A welcome with a key this smurg does not know: the welcome stays the protocol's strict schema.
    const other = 'ws_other_attach_003';
    const { env: env2 } = await setup();
    await standIn(env2, other, (socket, request, self) => {
      if (request.op === 'attach') socket.write(control({ ok: true, op: 'attach', welcome: { ...WELCOME(other), features: ['x'] } }));
      else answering(STATUS_050, {}, other)(socket, request, self);
    });
    const welcome = await runAttach([], commandContext(testIo({ env: env2 }))).then(
      () => null,
      (err: unknown) => formatFailure(err, 'en'),
    );
    expect(welcome).toEqual({
      text:
        `smurg: Another version of smurg is sharing here (this smurg is ${CLI_VERSION}): its answer is not one this smurg can read\n` +
        '  Stop it (smurg stop, or Ctrl-C in the terminal that runs smurg host), then start it again with smurg host.\n',
      exitCode: 1,
    });
  }, 60_000);

  for (const [name, { answer, why }] of Object.entries(UNREADABLE)) {
    it(`${name}: says so at once and does not go on to join this computer's own workspace through the relay`, async () => {
      const { dirs, env } = await setup();
      const id = 'ws_other_attach_004';
      const host = await standIn(env, id, answer(id));
      await rememberSharedFolder(statePaths(env), { folder: dirs.project, relay: 'http://127.0.0.1:9', workspaceId: id, createdAt: 1 });
      for (const [args, cwd] of [
        [[], dirs.home],
        [['--workspace', id], dirs.home],
        [[], dirs.project],
      ] as const) {
        const io = testIo({ env, cwd });
        const failure = await runAttach(args, commandContext(io)).then(
          () => null,
          (err: unknown) => formatFailure(err, 'en'),
        );
        expect(failure, args.join(' ')).toEqual({
          text: `smurg: Another version of smurg is sharing here (this smurg is ${CLI_VERSION}): ${why}\n  Stop it (smurg stop, or Ctrl-C in the terminal that runs smurg host), then start it again with smurg host.\n`,
          exitCode: 1,
        });
      }
      // No device key was made (the relay path was never taken) and the host was asked for nothing but its status.
      expect(await readdir(dirs.stateDir)).not.toContain('device.key');
      expect(host.requests.every((request) => (request as { op?: unknown }).op === 'status')).toBe(true);
    }, 60_000);
  }
});

// Unused: a typed status keeps the samples honest against today's strict schema where they claim to be 0.5.0's.
const _typed: CtlStatus = daemonStatusSchema.parse(STATUS_050('ws_AAAAAAAAAAAAAAAAAAAAAA'));
void _typed;
