// `smurg host` and a guest's `smurg attach` through the relay, in-process with injected io: the host logs in (against a
// fake relay HTTP API), claims the workspace, runs the daemon (echo sessions + the real control socket; tunnelled
// traffic through the in-memory relay with real Noise channels) and prints its short summary (the workspace's name and
// the two links; everything else is in docs/HOSTING.md and `smurg status`); a guest joins with the printed invite using
// the CLI device key and pin files; an editor is read-only on the host's session and sees what a second viewer sees
// (R4.1), a member with agent access types into it (§11 D-15); a guest later reconnects with the pinned key only.
// `smurg stop` and Ctrl-C end the host.
import { generateKeyPairSync } from 'node:crypto';
import { lstat, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { createConnection } from 'node:net';
import { basename, dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  CTL_FRAME_KIND,
  CtlFrameDecoder,
  DEFAULT_FEATURE_MODULES,
  encodeCtlFrame,
  parseCtlResponse,
  systemClock,
  type CtlResponse,
  type Daemon,
  type FeatureModule,
  type PowerService,
  type PowerStatus,
} from '@smurg/daemon';
import { buildAgentSession, fakesModule, fakesOf } from '@smurg/daemon/fakes';
import { MemoryRelay, TestIdentityIssuer, waitFor } from '@smurg/daemon/testing';
import { toHex, utf8Encode } from '@smurg/protocol';
import xtermHeadless from '@xterm/headless';
import { runCli } from '../src/cli/run.ts';
import { formatFailure } from '../src/cli/errors.ts';
import { runAttach } from '../src/commands/attach.ts';
import { commandContext } from '../src/commands/context.ts';
import { renderText } from '../src/i18n/index.ts';
import { hostUsage, inviteHeading, runHost } from '../src/commands/host.ts';
import { LocalWorkspaceChannel } from '../src/channel/local-channel.ts';
import { statePaths } from '../src/state/paths.ts';
import { loadCredentials, saveSession } from '../src/state/credentials.ts';
import { loadWorkspaces, rememberSharedFolder } from '../src/state/workspaces.ts';
import type { UpdateNoticeDeps } from '../src/update/notice.ts';
import { startDownloads } from './downloads-server.ts';
import { browserOpening, startFakeRelay, type FakeRelay } from './fake-relay.ts';
import { echoSessions, type EchoSessions } from './fixtures/echo-sessions.ts';
import { fakeTerminal, makeDirs, testIo, type Dirs, type TestIo } from './helpers.ts';
import { SecondViewer, drained, viewportOf } from './viewer.ts';

const { Terminal } = xtermHeadless;
const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  while (cleanups.length > 0) await Promise.resolve((cleanups.pop() as () => Promise<void> | void)()).catch(() => {});
});

interface HostRun {
  readonly dirs: Dirs;
  readonly relay: FakeRelay;
  readonly memory: MemoryRelay;
  readonly issuer: TestIdentityIssuer;
  readonly echo: EchoSessions;
  readonly io: TestIo;
  readonly env: Record<string, string>;
  readonly workspaceId: string;
  readonly daemon: Daemon;
  readonly done: Promise<number>;
  readonly links: { readonly host: string; readonly invite: string };
}

async function startHost(
  extraArgs: readonly string[] = [],
  extraModules: readonly FeatureModule[] = [],
  power?: PowerService,
  more: {
    readonly now?: () => number;
    readonly credentialsWatchMs?: number;
    readonly loggedIn?: boolean;
    readonly onIo?: (io: TestIo) => void;
    /** More environment (SMURG_INSTALL_BASE_URL of a local downloads server) and the update notice's seams. */
    readonly env?: Record<string, string>;
    readonly update?: UpdateNoticeDeps;
  } = {},
): Promise<HostRun> {
  const dirs = await makeDirs();
  cleanups.push(() => dirs.cleanup());
  const relay = await startFakeRelay();
  cleanups.push(() => relay.close());
  const env = { HOME: dirs.home, SMURG_HOME: dirs.stateDir, ...more.env };
  // The in-memory relay serves one workspace id: pre-seed the folder's id as an earlier `smurg host` would have.
  const workspaceId = `ws_host_${Math.random().toString(36).slice(2, 14)}`;
  await rememberSharedFolder(statePaths(env), { folder: await realpath(dirs.project), relay: relay.origin, workspaceId, createdAt: 1 });
  if (more.loggedIn) {
    // A login from an earlier `smurg login`: `smurg host` uses it and prints nothing about it.
    const token = 'stored.host-token-for-test';
    relay.tokens.set(token, relay.loginAs);
    await saveSession(statePaths(env), relay.origin, { token, tokenType: 'Bearer', expiresIn: 7 * 24 * 3600, user: relay.loginAs }, Date.now());
  }
  const memory = new MemoryRelay(workspaceId);
  const issuer = new TestIdentityIssuer(relay.origin, generateKeyPairSync('ed25519'), systemClock);
  const echo = echoSessions();
  const io = testIo({ env, openUrl: browserOpening, ...(more.now ? { now: more.now } : {}) });
  more.onIo?.(io);
  let ready: (daemon: Daemon) => void = () => {};
  const readyPromise = new Promise<Daemon>((resolve) => {
    ready = resolve;
  });
  const done = runHost([dirs.project, '--relay', relay.origin, '--no-keep-awake', ...extraArgs], commandContext(io), {
    daemon: {
      socketFactory: memory.hostSocketFactory(),
      identityKeys: { get: (kid) => (kid === issuer.kid ? issuer.publicKey : null), refresh: async () => {} },
      modules: [echo.module, ...extraModules, ...DEFAULT_FEATURE_MODULES.filter((m) => m.name === 'local')],
      ...(power ? { power } : {}),
    },
    onReady: (daemon) => ready(daemon),
    ...(more.credentialsWatchMs !== undefined ? { credentialsWatchMs: more.credentialsWatchMs } : {}),
    ...(more.update ? { update: more.update } : {}),
  });
  cleanups.push(async () => {
    io.signal('SIGTERM');
    await done.catch(() => {});
  });
  const daemon = await Promise.race([readyPromise, done.then((code) => Promise.reject(new Error(`host ended early (${code}): ${io.err()}`)))]);
  await waitFor(() => memory.hostOnline('ws'), { what: 'the daemon at the relay' });
  const urls = io.out().match(/https?:\/\/\S+\/join\/\S+/g) ?? [];
  expect(urls).toHaveLength(2);
  return { dirs, relay, memory, issuer, echo, io, env, workspaceId, daemon, done, links: { host: urls[0] as string, invite: urls[1] as string } };
}

/** The whole start summary (owner decision 2026-10-01): the workspace's name, the two links, how to stop. */
function summaryOf(name: string, links: HostRun['links'], inviteLine: string): string {
  return ['', `smurg is sharing "${name}"`, '', 'Your link (for you only):', `  ${links.host}`, '', inviteLine, `  ${links.invite}`, '', 'Press Ctrl-C to stop sharing.', ''].join('\n');
}

/** One raw control request (any JSON, as a hostile client of the socket would send it) and its response. */
async function rawCtlRequest(path: string, request: unknown): Promise<CtlResponse> {
  const socket = createConnection({ path });
  cleanups.push(() => {
    socket.destroy();
  });
  const decoder = new CtlFrameDecoder();
  return new Promise<CtlResponse>((resolve, reject) => {
    socket.on('connect', () => socket.write(encodeCtlFrame(CTL_FRAME_KIND.control, utf8Encode(JSON.stringify(request)))));
    socket.on('data', (chunk: Buffer) => {
      for (const frame of decoder.push(new Uint8Array(chunk))) if (frame.kind === CTL_FRAME_KIND.control) resolve(parseCtlResponse(frame.body));
    });
    socket.on('error', reject);
    socket.on('close', () => reject(new Error('the control socket closed without an answer')));
  });
}

/** `smurg status` in the host's state dir. */
async function statusOf(h: HostRun): Promise<string> {
  const io = testIo({ env: h.env });
  expect(await runCli(['status'], io)).toBe(0);
  return io.out();
}

describe('smurg host', () => {
  it('refuses folders that may not be shared (exit 2): missing, a file, the home directory, a parent of the state dir', async () => {
    const dirs = await makeDirs();
    cleanups.push(() => dirs.cleanup());
    const env = { HOME: dirs.home, SMURG_HOME: dirs.stateDir };
    const run = async (folder: string): Promise<{ code: number; err: string }> => {
      const io = testIo({ env });
      const code = await runCli(['host', folder, '--no-keep-awake'], io);
      return { code, err: io.err() };
    };
    expect(await run(join(dirs.home, 'nope'))).toMatchObject({ code: 2, err: expect.stringContaining('Folder not found') });
    await writeFile(join(dirs.home, 'file.txt'), 'x');
    expect(await run(join(dirs.home, 'file.txt'))).toMatchObject({ code: 2, err: expect.stringContaining('is not a folder') });
    expect(await run(dirs.home)).toMatchObject({ code: 2, err: expect.stringContaining('Your whole home folder cannot be shared') });
    // A folder that CONTAINS the home directory would show ~/.ssh and the rest to every member.
    expect(await run(dirname(dirs.home))).toMatchObject({ code: 2, err: expect.stringContaining('A folder that contains a home folder cannot be shared') });
    // SMURG_HOME inside the folder: the keys would be visible to guests.
    const nested = testIo({ env: { HOME: dirs.home, SMURG_HOME: join(dirs.project, '.smurg-state') } });
    expect(await runCli(['host', dirs.project], nested)).toBe(2);
    expect(nested.err()).toContain("smurg's state folder");
    const bad = testIo({ env });
    expect(await runCli(['host', dirs.project, '--role', 'host'], bad)).toBe(2);
    expect(bad.err()).toContain('An invite link cannot have the Host role');
    const badExpiry = testIo({ env });
    expect(await runCli(['host', dirs.project, '--expires', '400d'], badExpiry)).toBe(2);
    // The invite links carry their secret: they may only point at https, or at http on this machine.
    const badWeb = testIo({ env });
    expect(await runCli(['host', dirs.project, '--web-origin', 'http://web.example.com'], badWeb)).toBe(2);
    expect(badWeb.err()).toContain('The --web-origin URL is not valid');
  });

  it('--web-origin: the links point at the web app people open (local development: the Vite dev server)', async () => {
    const h = await startHost(['--web-origin', 'http://localhost:5173']);
    expect(h.links.host.startsWith(`http://localhost:5173/join/${h.workspaceId}#k=`)).toBe(true);
    expect(h.links.invite.startsWith(`http://localhost:5173/join/${h.workspaceId}#k=`)).toBe(true);
    // The links say where they point; no separate line for it.
    expect(h.io.out()).not.toContain('Web:');
  });

  it('with a stored login the whole output is the workspace\'s name, the two links (each once) and how to stop (owner decision 2026-10-01)', async () => {
    const h = await startHost([], [], undefined, { loggedIn: true });
    expect(h.io.opened).toEqual([]);
    expect(h.daemon.ctx.workspace.info.name).toBe(basename(await realpath(h.dirs.project)));
    expect(h.io.out()).toBe(summaryOf(h.daemon.ctx.workspace.info.name, h.links, 'Link for your teammates (send it to them privately; valid for 7 days):'));
    expect(h.io.err()).toBe('');
    // Nothing follows on its own (keep-awake switched off by the host): still the same.
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(h.io.out()).toBe(summaryOf(h.daemon.ctx.workspace.info.name, h.links, 'Link for your teammates (send it to them privately; valid for 7 days):'));
    expect(h.links.host).toContain(`/join/${h.workspaceId}#k=`);
    expect(h.links.host).not.toBe(h.links.invite);
  });

  it('the teammates\' line names the expiry, and the use limit and the role only when the host chose them', () => {
    const heading = (...args: Parameters<typeof inviteHeading>): string => renderText('en', inviteHeading(...args));
    expect(heading('editor', 7 * 86_400, undefined)).toBe('Link for your teammates (send it to them privately; valid for 7 days):');
    expect(heading('editor', 2 * 3600, 3)).toBe('Link for your teammates (send it to them privately; valid for 2 hours; 3 uses):');
    expect(heading('agent', 30 * 60, undefined)).toBe('Link for your teammates (send it to them privately; valid for 30 minutes; role: Agent access):');
    expect(heading('viewer', 14 * 86_400, 1)).toBe('Link for your teammates (send it to them privately; valid for 14 days; 1 use; role: Viewer):');
    expect(heading('editor', 86_400, undefined)).toBe('Link for your teammates (send it to them privately; valid for 1 day):');
    expect(heading('editor', 365 * 86_400, undefined)).toBe('Link for your teammates (send it to them privately; valid for 365 days):');
  });

  it('in zh-TW (SMURG_LANG=zh-TW): the same summary in Chinese, the role by its Chinese label', async () => {
    const h = await startHost(['--role', 'viewer', '--max-uses', '3'], [], undefined, { loggedIn: true, env: { SMURG_LANG: 'zh-TW' } });
    const name = h.daemon.ctx.workspace.info.name;
    expect(h.io.out()).toBe(
      ['', `smurg 正在分享「${name}」`, '', '你的連結（只給你自己用）：', `  ${h.links.host}`, '', '給組員的連結（用私訊傳給他們，7 天內有效，可以使用 3 次，角色：旁觀）：', `  ${h.links.invite}`, '', '按 Ctrl-C 停止分享。', ''].join('\n'),
    );
    const status = testIo({ env: h.env });
    expect(await runCli(['status'], status)).toBe(0);
    expect(status.out()).toContain(`工作區 ${h.workspaceId}\n`);
    expect(status.out()).toContain('  防止睡眠：未啟用（已用 --no-keep-awake 關閉）\n');
    h.io.signal('SIGINT');
    expect(await h.done).toBe(0);
    expect(h.io.out()).toContain('\n收到 SIGINT，正在停止分享…\n已停止分享。\n');
  });

  it('--role agent: the printed link is an agent-access invite and its line says so; nothing else is printed (§11 D-15)', async () => {
    const h = await startHost(['--role', 'agent'], [], undefined, { loggedIn: true });
    expect(h.io.out()).toBe(summaryOf(h.daemon.ctx.workspace.info.name, h.links, 'Link for your teammates (send it to them privately; valid for 7 days; role: Agent access):'));
    expect(h.io.err()).toBe('');
    const invites = h.daemon.ctx.invites.list().filter((i) => i.role !== 'host');
    expect(invites.map((i) => i.role)).toEqual(['agent']);
    expect(invites[0]?.maxUses).toBeUndefined();
  });

  it('--role runner (the old name) and --role host are refused before anything else happens (exit 2), naming the roles there are', async () => {
    const dirs = await makeDirs();
    cleanups.push(() => dirs.cleanup());
    const env = { HOME: dirs.home, SMURG_HOME: dirs.stateDir };
    const runner = testIo({ env, openUrl: browserOpening });
    expect(await runCli(['host', dirs.project, '--relay', 'http://127.0.0.1:9', '--no-keep-awake', '--role', 'runner'], runner)).toBe(2);
    expect(runner.err()).toContain('Unknown role "runner"');
    expect(runner.err()).toContain('The roles are: agent (Agent access), editor (Editor), viewer (Viewer).');
    expect(runner.opened).toEqual([]); // no login started
    const host = testIo({ env, openUrl: browserOpening });
    expect(await runCli(['host', dirs.project, '--relay', 'http://127.0.0.1:9', '--no-keep-awake', '--role', 'host'], host)).toBe(2);
    expect(host.err()).toContain('The roles are: agent, editor, viewer.');
    expect(host.opened).toEqual([]);
  });

  it('logs in when needed, shares, prints only the short summary with the invite\'s terms; the links only on the terminal, never in the log; smurg stop ends it', async () => {
    const h = await startHost(['--role', 'editor', '--max-uses', '3', '--expires', '2h', '--name', 'Class project']);
    const out = h.io.out();
    // Logged in (there was no session), claimed the workspace at the relay.
    expect(h.relay.workspaces.get(h.workspaceId)).toBe('github:4242');
    // After the login's own messages: exactly the summary (an explicit default role is not mentioned).
    const start = out.indexOf('\nsmurg is sharing');
    expect(start).toBeGreaterThanOrEqual(0);
    expect(out.slice(start)).toBe(summaryOf('Class project', h.links, 'Link for your teammates (send it to them privately; valid for 2 hours; 3 uses):'));
    // Each link exactly once; the invite really has the terms the line names.
    for (const url of [h.links.host, h.links.invite]) expect(out.split(url)).toHaveLength(2);
    const invite = h.daemon.ctx.invites.list().find((i) => i.role === 'editor');
    expect(invite?.maxUses).toBe(3);
    expect((invite?.expiresAt ?? 0) - (invite?.createdAt ?? 0)).toBe(2 * 3600_000);
    // None of what moved to docs/HOSTING.md and `smurg status` (owner decision 2026-10-01).
    for (const moved of ['Folder:', 'Workspace ', h.daemon.fingerprint, 'fingerprint', 'Before you share', 'prompt injection', 'sandbox', 'subscription', 'shell command', 'main workspace', 'Keep-awake', 'Log:', 'Agent access', 'built-in public relay']) {
      expect(out, moved).not.toContain(moved);
    }
    expect(h.io.err()).not.toContain('/join/');

    const stopper = testIo({ env: h.env });
    expect(await runCli(['stop'], stopper)).toBe(0);
    // `smurg stop` returns once the daemon stopped completely: its control socket goes last.
    expect(h.daemon.status().stopped).toBe(true);
    await expect(lstat(h.daemon.config.runPaths.ctl)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(stopper.out()).toContain('Stopped sharing.');
    expect(await h.done).toBe(0);
    expect(h.io.out()).toContain('Stopped sharing.');
    // The log file is private and holds no link or secret.
    const logPath = join(h.dirs.stateDir, 'logs', `${h.workspaceId}.log`);
    expect((await lstat(logPath)).mode & 0o777).toBe(0o600);
    const log = await readFile(logPath, 'utf8');
    expect(log).toContain('daemon started');
    for (const url of [h.links.host, h.links.invite]) {
      expect(log).not.toContain(url);
      expect(log).not.toContain(new URL(url).hash.slice(1));
      const secret = new URLSearchParams(new URL(url).hash.slice(1)).get('s');
      expect(secret).toBeTruthy();
      expect(log).not.toContain(secret as string);
    }
  });

  it('Ctrl-C stops gracefully (exit 0); a second Ctrl-C right away is ignored, a later one while stopping leaves at once (130)', async () => {
    const h = await startHost();
    h.io.signal('SIGINT');
    expect(await h.done).toBe(0);
    expect(h.io.out()).toContain('Received SIGINT; stopping the share...');
    expect(h.daemon.status().stopped).toBe(true);
    expect(h.io.exits).toEqual([]);
    h.io.signal('SIGINT');
    // After the command returned nothing listens any more. During a stop: a double press within 2 s is one impatient
    // key press (leaving then could leave session processes stopped); a later press is the forced exit.
    let now = Date.now();
    const g = await startHost([], [], undefined, { now: () => now });
    g.io.signal('SIGINT');
    g.io.signal('SIGINT');
    expect(g.io.exits).toEqual([]);
    expect(g.io.out()).toContain('one moment...');
    now += 2_500;
    g.io.signal('SIGINT');
    expect(g.io.exits).toEqual([130]);
    expect(await g.done).toBe(0);
  });

  it('a stop says how many agent sessions are paused, after "Stopped sharing." (their conversations stay); nothing more when there are none (DESIGN v0.5.0 §6)', async () => {
    // Ctrl-C: the count is taken as the stop begins, before the agent module stops.
    const h = await startHost([], [fakesModule()], undefined, { loggedIn: true });
    const agents = fakesOf(h.daemon.ctx).agents;
    for (const [index, status] of (['running', 'waiting-permission', 'idle', 'ended'] as const).entries()) agents.adopt(buildAgentSession({ id: `ses_host_agent_${index}`, status, createdAt: index + 1 }));
    h.io.signal('SIGINT');
    expect(await h.done).toBe(0);
    expect(h.io.out().endsWith('\nReceived SIGINT; stopping the share...\nStopped sharing.\n3 agent sessions are paused. They continue when you share this folder again.\n')).toBe(true);
    // `smurg stop` from another terminal: both terminals say it.
    const g = await startHost([], [fakesModule()], undefined, { loggedIn: true, env: { SMURG_LANG: 'zh-TW' } });
    fakesOf(g.daemon.ctx).agents.adopt(buildAgentSession({ id: 'ses_host_agent_only', status: 'idle' }));
    const stopper = testIo({ env: { HOME: g.dirs.home, SMURG_HOME: g.dirs.stateDir } });
    expect(await runCli(['stop'], stopper)).toBe(0);
    expect(stopper.out().endsWith('Stopped sharing.\n1 agent session is paused. It continues when you share this folder again.\n')).toBe(true);
    expect(await g.done).toBe(0);
    expect(g.io.out().endsWith('\n收到停止要求（smurg stop），正在停止分享…\n已停止分享。\n1 個 agent session 已暫停，下次分享這個資料夾時會繼續。\n')).toBe(true);
    // No agent session (or none that has not ended): the stop ends as it always did.
    const none = await startHost([], [fakesModule()], undefined, { loggedIn: true });
    fakesOf(none.daemon.ctx).agents.adopt(buildAgentSession({ id: 'ses_host_agent_ended', status: 'ended' }));
    none.io.signal('SIGINT');
    expect(await none.done).toBe(0);
    expect(none.io.out().endsWith('\nReceived SIGINT; stopping the share...\nStopped sharing.\n')).toBe(true);
  });

  // Verification F-2 (2026-10-02): any process of the host's OS account reaches the control socket (every session of
  // a member with agent access). It used to choose the daemon's stop reason, and this command took 'start-failed' /
  // 'summary-failed' for its own stops: the daemon stopped while the host's terminal still said to press Ctrl-C.
  it('a stop request names no reason (one that does is refused and stops nothing); a daemon stop this command did not make is told and ends it, whatever its reason (verification F-2)', async () => {
    const h = await startHost();
    for (const reason of ['start-failed', 'summary-failed']) {
      expect(await rawCtlRequest(h.daemon.config.runPaths.ctl, { v: 1, op: 'stop', reason })).toMatchObject({ ok: false, error: { code: 'bad_request' } });
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(h.daemon.status().stopped).toBe(false);
    expect(h.io.out()).not.toContain('Asked to stop');
    // Stopped with those reasons from anywhere else: the host is told, and the command ends as for `smurg stop`.
    for (const reason of ['start-failed', 'summary-failed']) {
      const g = reason === 'start-failed' ? h : await startHost();
      await g.daemon.stop(reason);
      expect(await Promise.race([g.done, new Promise((resolve) => setTimeout(() => resolve('still running'), 10_000))])).toBe(0);
      expect(g.io.out()).toContain('Asked to stop (smurg stop); stopping the share...');
      expect(g.io.out()).toContain('Stopped sharing.');
    }
  });

  it('a start that fails is reported as the failure it is, not as a stop request, although the daemon stops itself to undo it (verification F-2)', async () => {
    const failing: FeatureModule = {
      name: 'failing-start',
      register: () => ({ dispose: () => {} }),
      start: async () => {
        throw new Error('module start failed on purpose');
      },
    };
    let io: TestIo | null = null;
    await expect(startHost([], [failing], undefined, { onIo: (i) => (io = i) })).rejects.toThrow();
    const out = (io as TestIo | null)?.out() ?? 'no io';
    expect(out).not.toContain('Asked to stop');
    expect(out).not.toContain('Stopped sharing.');
    expect(out).not.toContain('Press Ctrl-C to stop sharing');
  });

  it('the relay refusing the host login is told on the terminal; a renewed `smurg login` is picked up without a restart', async () => {
    const h = await startHost([], [], undefined, { credentialsWatchMs: 200 });
    // The relay stops accepting the daemon's token (the 7-day session expired, or was revoked): the next reconnect is 401.
    const renewed = 'renewed.token-for-test';
    h.memory.hostTokenValid = (token) => token === renewed;
    h.memory.dropHost('ws');
    await waitFor(() => h.io.out().includes("the relay refused this computer's login"), { timeoutMs: 15_000, what: 'the auth-rejected notice' });
    expect(h.io.out()).toContain(`smurg login --relay ${h.relay.origin}`);
    expect(h.daemon.status().relay.interactive).toBe('auth-rejected');
    expect(h.memory.hostOnline('ws')).toBe(false);
    // `smurg login` in another terminal writes credentials.json: the running host uses it at once.
    const user = { userId: 'github:4242', displayName: 'Ian', provider: 'github' as const };
    await saveSession(statePaths(h.env), h.relay.origin, { token: renewed, tokenType: 'Bearer', expiresIn: 7 * 24 * 3600, user }, Date.now());
    await waitFor(() => h.memory.hostOnline('ws'), { timeoutMs: 15_000, what: 'the daemon back at the relay with the renewed login' });
    await waitFor(() => h.io.out().includes('Reconnected to the relay'), { what: 'the reconnected notice' });
    expect(h.io.out()).toContain('Now using the new relay login.');
    expect(h.memory.hostTokens.at(-1)).toBe(renewed);
    // A login of ANOTHER account is not used (the workspace belongs to the account that claimed it).
    await saveSession(statePaths(h.env), h.relay.origin, { token: 'other.account-token', tokenType: 'Bearer', expiresIn: 7 * 24 * 3600, user: { userId: 'github:1', displayName: 'Eve', provider: 'github' } }, Date.now());
    await waitFor(() => h.io.out().includes('is another account (Eve)'), { what: 'the other-account notice' });
    // A login that is about to expire is told while sharing, before members are locked out.
    await saveSession(statePaths(h.env), h.relay.origin, { token: 'short.lived-token', tokenType: 'Bearer', expiresIn: 3600, user }, Date.now());
    await waitFor(() => h.io.out().includes('the relay login expires at'), { what: 'the expiry reminder' });
    // Secrets never reach the terminal.
    for (const token of [renewed, 'other.account-token', 'short.lived-token']) expect(h.io.out()).not.toContain(token);
  });

  it('a state file the disk refuses is told on the terminal, and so is its recovery', async () => {
    const h = await startHost();
    h.daemon.ctx.bus.emit('state.write', { document: 'members', ok: false });
    h.daemon.ctx.bus.emit('state.write', { document: 'invites', ok: false });
    expect(h.io.out().match(/smurg's state file could not be written/g)).toHaveLength(1);
    h.daemon.ctx.bus.emit('state.write', { document: 'members', ok: true });
    expect(h.io.out()).not.toContain("smurg's state file was written again.");
    h.daemon.ctx.bus.emit('state.write', { document: 'invites', ok: true });
    expect(h.io.out()).toContain("smurg's state file was written again.");
  });

  it('asks for a new login before sharing when the stored one expires within 24 h', async () => {
    const dirs = await makeDirs();
    cleanups.push(() => dirs.cleanup());
    const relay = await startFakeRelay();
    cleanups.push(() => relay.close());
    const env = { HOME: dirs.home, SMURG_HOME: dirs.stateDir };
    const io = testIo({ env, openUrl: browserOpening });
    expect(await runCli(['login', '--relay', relay.origin], io)).toBe(0);
    const stored = (await loadCredentials(statePaths(env))).relays[relay.origin];
    expect(stored).toBeDefined();
    // The same login with one hour left.
    const file = JSON.parse(await readFile(statePaths(env).credentials, 'utf8')) as { relays: Record<string, { expiresAt: number }> };
    (file.relays[relay.origin] as { expiresAt: number }).expiresAt = Date.now() + 3600_000;
    await writeFile(statePaths(env).credentials, JSON.stringify(file), { mode: 0o600 });
    const { ensureSession } = await import('../src/relay/login.ts');
    const { HOST_SESSION_MIN_VALIDITY_MS } = await import('../src/commands/host.ts');
    const again = testIo({ env, openUrl: browserOpening });
    const { session } = await ensureSession(commandContext(again), relay.origin, { interactive: true, minValidityMs: HOST_SESSION_MIN_VALIDITY_MS });
    expect(again.out()).toContain('The relay login expires soon');
    expect(again.opened).toHaveLength(1);
    expect(session.token).not.toBe(stored?.token);
    expect(session.expiresAt - Date.now()).toBeGreaterThan(HOST_SESSION_MIN_VALIDITY_MS);
    // Without the minimum (every other command), the one-hour login is still used as is.
    const plain = testIo({ env, openUrl: browserOpening });
    await ensureSession(commandContext(plain), relay.origin, { interactive: true });
    expect(plain.opened).toEqual([]);
  });

  it('refuses a folder that overlaps one a running host shares, whatever the relay', async () => {
    const h = await startHost();
    // The same folder for another relay origin: refused before any login.
    const other = testIo({ env: h.env, openUrl: browserOpening });
    expect(await runCli(['host', h.dirs.project, '--relay', 'http://127.0.0.1:9', '--no-keep-awake'], other)).toBe(1);
    expect(other.err()).toContain('is already being shared');
    expect(other.opened).toEqual([]);
    // A folder inside the shared one.
    await mkdir(join(h.dirs.project, 'sub'), { recursive: true });
    const inner = testIo({ env: h.env, openUrl: browserOpening });
    expect(await runCli(['host', join(h.dirs.project, 'sub'), '--relay', h.relay.origin, '--no-keep-awake'], inner)).toBe(1);
    expect(inner.err()).toContain('A folder above this one');
    expect(inner.opened).toEqual([]);
  });

  it('keep-awake lost after the start (the inhibitor exited) is told on the host terminal', async () => {
    let status: PowerStatus = { active: true, mechanism: 'systemd-inhibit', pid: 4242, reason: null };
    const power: PowerService = { start: async () => status, stop: async () => {}, status: () => status };
    const h = await startHost([], [], power);
    // Working keep-awake is not news at the start; `smurg status` shows it.
    expect(h.io.out()).not.toContain('keep-awake');
    expect(await statusOf(h)).toContain('  Keep-awake: on (systemd-inhibit)\n');
    status = { active: false, mechanism: 'none', pid: null, reason: 'exited' };
    await waitFor(() => h.io.out().includes('keep-awake was lost'), { timeoutMs: 10_000, what: 'the keep-awake warning' });
    expect(h.io.out()).toContain('\nWarning: keep-awake was lost: off (the keep-awake program has ended). While the computer sleeps, your teammates see "Host offline".\n');
  });

  it('keep-awake the system refuses (Linux over SSH: polkit) is told in one line after the links, with the reason and what to do (linux-binary F5); switched off by the host, nothing is said', async () => {
    const status: PowerStatus = { active: false, mechanism: 'none', pid: null, reason: 'refused' };
    const power: PowerService = { start: async () => status, stop: async () => {}, status: () => status };
    const h = await startHost([], [], power, { loggedIn: true });
    expect(h.io.out()).toBe(
      summaryOf(h.daemon.ctx.workspace.info.name, h.links, 'Link for your teammates (send it to them privately; valid for 7 days):') +
        '\nWarning: keep-awake: off (the system (polkit) does not allow blocking sleep, as Ubuntu does by default for an SSH login; log in at this computer\'s desktop and run smurg host there, or ask the administrator to allow it). While the computer sleeps, your teammates see "Host offline".\n',
    );
    // --no-keep-awake (every other test here): the host's own choice, not a notice; `smurg status` still says it.
    const off = await startHost([], [], undefined, { loggedIn: true });
    expect(off.io.out()).not.toContain('keep-awake');
    expect(await statusOf(off)).toContain('  Keep-awake: off (turned off with --no-keep-awake)\n');
  });

  it('passes the D-13 switch on to the daemon (on by default); the start says nothing about it, `smurg status` shows it (§11 D-13)', async () => {
    const h = await startHost([], [], undefined, { loggedIn: true });
    expect(h.daemon.config.activity.attributeBashEdits).toBe(true);
    expect(h.io.out()).toBe(summaryOf(h.daemon.ctx.workspace.info.name, h.links, 'Link for your teammates (send it to them privately; valid for 7 days):'));
    const status = await statusOf(h);
    expect(status).toContain("  Notices of agents' shell commands: on\n");
  });

  it('--no-bash-attribution switches the daemon off; the start says nothing, `smurg status` shows it', async () => {
    const h = await startHost(['--no-bash-attribution'], [], undefined, { loggedIn: true });
    expect(h.daemon.config.activity.attributeBashEdits).toBe(false);
    expect(h.io.out()).toBe(summaryOf(h.daemon.ctx.workspace.info.name, h.links, 'Link for your teammates (send it to them privately; valid for 7 days):'));
    const status = await statusOf(h);
    expect(status).toContain("  Notices of agents' shell commands: off (--no-bash-attribution)\n");
  });

  it('`smurg status` shows what the start no longer prints: folder, relay, fingerprint, keep-awake, the switch, the log file; never a link', async () => {
    const h = await startHost(['--no-bash-attribution'], [], undefined, { loggedIn: true });
    const status = await statusOf(h);
    const lines = [
      `Workspace ${h.workspaceId}\n`,
      `  Folder: ${await realpath(h.dirs.project)}\n`,
      `  Relay: ${h.relay.origin}, interactive connection connected, file transfer `,
      `  Daemon key fingerprint: ${h.daemon.fingerprint}\n`,
      '  Keep-awake: off (turned off with --no-keep-awake)\n',
      "  Notices of agents' shell commands: off (--no-bash-attribution)\n",
      `  Log: ${join(h.dirs.stateDir, 'logs', `${h.workspaceId}.log`)}\n`,
    ];
    for (const line of lines) expect(status, line).toContain(line);
    // In this order.
    const at = lines.map((line) => status.indexOf(line));
    expect([...at].sort((x, y) => x - y)).toEqual(at);
    // No guest sandbox, guest login or main-workspace line any more (§11 D-15: there is no guest sandbox).
    for (const gone of ['sandbox', 'subscription', 'main workspace', 'runner']) expect(status, gone).not.toContain(gone);
    // Not the relay's built-in mark (the test relay is not the built-in one), and never a link or its secret.
    expect(status).not.toContain('built-in public relay');
    expect(status).not.toContain('/join/');
    for (const url of [h.links.host, h.links.invite]) expect(status).not.toContain(new URLSearchParams(new URL(url).hash.slice(1)).get('s') as string);
  });

  it('what the start no longer prints is in the host guide, and --help points to it', async () => {
    const help = testIo({ env: {} });
    expect(await runCli(['host', '--help'], help)).toBe(0);
    expect(help.out()).toBe(renderText('en', hostUsage()));
    expect(help.out()).toContain('Read before you share: https://smurg.ai/docs/hosting/#4-before-you-share\n');
    expect(help.out()).toContain('https://smurg.ai/docs/hosting/#5-agent-access-and-agents-shell-commands\n');
    expect(help.out()).toContain('smurg status');
    // Agent access and what it hands over are named right where the role is chosen.
    expect(help.out()).toContain('agent (Agent access), editor (Editor, the default),');
    expect(help.out()).toContain('run as you on this computer, with your Claude\n');
  });

  it('validates the switch before anything else happens (exit 2), refuses the removed guest-sandbox flags as unknown options, and --help lists what is left', async () => {
    const dirs = await makeDirs();
    cleanups.push(() => dirs.cleanup());
    const env = { HOME: dirs.home, SMURG_HOME: dirs.stateDir };
    const refused = async (args: string[], text: string): Promise<void> => {
      const io = testIo({ env, openUrl: browserOpening });
      expect(await runCli(['host', dirs.project, '--relay', 'http://127.0.0.1:9', '--no-keep-awake', ...args], io)).toBe(2);
      expect(io.err()).toContain(text);
      expect(io.opened).toEqual([]); // no login started
    };
    await refused(['--no-bash-attribution=yes'], 'does not take a value');
    await refused(['--no-bash-attribution', '--bash-attribution'], 'Options --bash-attribution and --no-bash-attribution cannot be used together');
    await refused(['--no-bash'], 'Unknown option --no-bash');
    // §11 D-15 (owner decision 2026-10-01): no guest sandbox, so the guest-login and main-workspace switches are gone.
    for (const flag of ['--no-guest-subscription-login', '--guest-subscription-login', '--allow-main-workspace-guests', '--no-main-workspace-guests', '--main-workspace-guests']) {
      await refused([flag], `Unknown option ${flag}`);
    }
    const help = testIo({ env });
    expect(await runCli(['host', '--help'], help)).toBe(0);
    expect(help.out()).toContain('--no-bash-attribution');
    for (const gone of ['--no-guest-subscription-login', '--allow-main-workspace-guests', '--no-main-workspace-guests', 'runner', 'sandbox']) expect(help.out(), gone).not.toContain(gone);
  });

  it('refuses a second host of the same folder while the first runs (exit 1)', async () => {
    const h = await startHost();
    const again = testIo({ env: h.env, openUrl: browserOpening });
    expect(await runCli(['host', h.dirs.project, '--relay', h.relay.origin, '--no-keep-awake'], again)).toBe(1);
    expect(again.err()).toContain('is already being shared');
    // Refused before any login: without a relay session, no browser login starts for it.
    expect(await runCli(['logout', '--all'], testIo({ env: h.env }))).toBe(0);
    const loggedOut = testIo({ env: h.env, openUrl: browserOpening });
    expect(await runCli(['host', h.dirs.project, '--relay', h.relay.origin, '--no-keep-awake'], loggedOut)).toBe(1);
    expect(loggedOut.err()).toContain('is already being shared');
    expect(loggedOut.opened).toEqual([]);
    expect(loggedOut.out()).not.toContain('ogging in');
  });
});

describe('smurg attach through the relay (guest, CLI device key)', () => {
  it('joins with the invite (device key and pin 0600), an editor is read-only on the host session, renders what a second viewer renders (R4.1), reconnects later with the pinned key', async () => {
    const h = await startHost(['--role', 'editor']);
    const guestDirs = await makeDirs();
    cleanups.push(() => guestDirs.cleanup());
    const guestEnv = { HOME: guestDirs.home, SMURG_HOME: guestDirs.stateDir };
    const relayFor = async (): Promise<ReturnType<MemoryRelay['apiFor']>> => h.memory.apiFor({ userId: 'dev:amy', displayName: 'Amy' }, h.issuer);

    // 1. Join and list: no session yet.
    const list = testIo({ env: guestEnv });
    expect(await runAttach(['--invite', h.links.invite], commandContext(list), { relayFor })).toBe(0);
    expect(list.out()).toContain('This workspace has no sessions.');
    const device = join(guestDirs.stateDir, 'device.key');
    const pin = join(guestDirs.stateDir, 'pins', `${toHex(utf8Encode(h.workspaceId))}.pub`);
    expect((await lstat(device)).mode & 0o777).toBe(0o600);
    expect((await lstat(pin)).mode & 0o777).toBe(0o600);
    expect(Buffer.from(await readFile(pin)).equals(Buffer.from(h.daemon.daemonPublicKey))).toBe(true);

    // 2. The host starts a session (in the web app; here on the daemon side: the control socket cannot open sessions,
    // review F1) and prints something. The host's own terminal is attached through the control socket.
    const session = h.echo.open({ ownerUserId: h.relay.loginAs.userId, ownerName: h.relay.loginAs.displayName });
    const host = await LocalWorkspaceChannel.open(h.daemon.config.runPaths.ctl, { deviceName: 'host test' });
    cleanups.push(() => host.close());
    h.echo.print(session.id, '\x1b[1mhello from the host\x1b[0m\r\n');

    // 3. The guest attaches (the pinned key now; the invite was used once): an editor may not type (no session.drive).
    const terminal = fakeTerminal({ cols: 80, rows: 24 });
    const guest = testIo({ env: guestEnv, terminal });
    const attached = runAttach([session.id.slice(0, 12), '--workspace', h.workspaceId], commandContext(guest), { relayFor });
    await waitFor(() => terminal.text().includes('hello from the host'), { what: 'the snapshot on the guest terminal', timeoutMs: 15_000 });
    expect(terminal.rawMode).toBe(true);
    expect(guest.out()).toContain('Attaching to session "Terminal (Ian)" (opened by Ian). Press Ctrl-] to leave.');
    expect(guest.out()).toContain('Read-only: Ian opened this terminal session, and your role cannot type into terminal sessions. Press Ctrl-] to leave.');
    // Suggestions are for agent sessions (protocol 4): the notice of a terminal no longer points at them.
    expect(guest.out()).not.toContain('suggestion');
    expect(terminal.text()).toContain('smurg: Terminal (Ian) - read-only'); // the window title says it too
    terminal.type('rm -rf important\r');
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(h.echo.inputs.get(session.id) ?? '').not.toContain('rm -rf');
    expect(terminal.text()).toContain('\x07');
    // The owner types (through the host's channel): the guest sees it live.
    host.notify('exec.input', { sessionId: session.id, data: new TextEncoder().encode('echo owner-typed\r') });
    await waitFor(() => terminal.text().includes('owner-typed'), { what: 'live output on the guest terminal' });
    // R4.1: the guest's CLI screen equals a second viewer's (the host's, like the web client).
    const viewer = new SecondViewer(host, session);
    cleanups.push(() => viewer.dispose());
    await viewer.attach();
    const rendered = new Terminal({ cols: 80, rows: 24, scrollback: 1000, allowProposedApi: true });
    for (const chunk of terminal.written) rendered.write(chunk);
    await drained(rendered);
    await drained(viewer.term);
    expect(viewportOf(rendered)).toEqual(viewer.viewport());
    // Ctrl-] detaches: exit 0, terminal restored.
    terminal.type('\x1d');
    expect(await attached).toBe(0);
    expect(terminal.rawMode).toBe(false);
    expect(terminal.rawModeHistory).toEqual([true, false]);
    expect(terminal.released).toBe(true);

    // 4. Later: no invite, the pinned key only (device mode), found through the remembered workspace.
    const later = testIo({ env: guestEnv });
    expect(await runAttach([], commandContext(later), { relayFor })).toBe(0);
    expect(later.out()).toContain(session.id);
    expect(h.daemon.ctx.members.devicesOf('dev:amy')).toHaveLength(1);
  });

  it('agent sessions through the relay: listed with the workspace\'s address in the web app (the invite link\'s origin, remembered for later joins) and refused as the session to attach (exit 2)', async () => {
    // A development setup: the links point at the web app's own origin, the relay is elsewhere.
    const h = await startHost(['--role', 'editor', '--web-origin', 'http://localhost:5173']);
    h.echo.addAgent(buildAgentSession({ id: 'ses_relay_talk', purpose: 'discussion', topicId: 'tp_checkout', topicName: 'Checkout', status: 'waiting-answer', modeFixed: true }));
    const guestDirs = await makeDirs();
    cleanups.push(() => guestDirs.cleanup());
    const guestEnv = { HOME: guestDirs.home, SMURG_HOME: guestDirs.stateDir };
    const relayFor = async (): Promise<ReturnType<MemoryRelay['apiFor']>> => h.memory.apiFor({ userId: 'dev:amy', displayName: 'Amy' }, h.issuer);
    const address = `http://localhost:5173/w/${h.workspaceId}`;
    const sentence = `Agent conversations open in the browser: ${address}`;

    const first = testIo({ env: guestEnv });
    expect(await runAttach(['--invite', h.links.invite, '--relay', h.relay.origin], commandContext(first), { relayFor })).toBe(0);
    expect(first.out()).toContain('This workspace has no terminal sessions.\n');
    expect(first.out()).toMatch(/\nses_relay_talk\s+waiting for an answer\s+Checkout\s+Discussion\n/);
    expect(first.out().endsWith(`\n${sentence}\n`)).toBe(true);
    expect(first.out()).not.toContain('Attach with smurg attach');
    // The web app's origin is remembered with the join, because it is not the relay.
    expect((await loadWorkspaces(statePaths(guestEnv))).joined).toMatchObject([{ workspaceId: h.workspaceId, relay: h.relay.origin, web: 'http://localhost:5173' }]);

    // Later, without the invite (the pinned key): the same address; naming the conversation as the session is refused.
    const later = testIo({ env: guestEnv });
    expect(await runAttach([], commandContext(later), { relayFor })).toBe(0);
    expect(later.out().endsWith(`\n${sentence}\n`)).toBe(true);
    const terminal = fakeTerminal();
    const refused = await runAttach(['ses_relay', '--workspace', h.workspaceId], commandContext(testIo({ env: guestEnv, terminal })), { relayFor }).then(
      () => null,
      (err: unknown) => formatFailure(err, 'en'),
    );
    expect(refused).toEqual({ text: `smurg: Session "Discussion" is an agent conversation, not a terminal\n  ${sentence}\n`, exitCode: 2 });
    expect(terminal.rawModeHistory).toEqual([]);

    // The usual setup: the relay serves the web app, so the address is the relay's and nothing more is remembered.
    const g = await startHost(['--role', 'viewer']);
    g.echo.addAgent(buildAgentSession({ id: 'ses_relay_free', openedBy: { userId: g.relay.loginAs.userId, displayName: g.relay.loginAs.displayName }, status: 'idle' }));
    const otherDirs = await makeDirs();
    cleanups.push(() => otherDirs.cleanup());
    const otherEnv = { HOME: otherDirs.home, SMURG_HOME: otherDirs.stateDir };
    const viewer = testIo({ env: otherEnv });
    const viewerRelay = async (): Promise<ReturnType<MemoryRelay['apiFor']>> => g.memory.apiFor({ userId: 'dev:vic', displayName: 'Vic' }, g.issuer);
    expect(await runAttach(['--invite', g.links.invite], commandContext(viewer), { relayFor: viewerRelay })).toBe(0);
    expect(viewer.out()).toMatch(/\nses_relay_free\s+idle\s+No topic\s+Claude \(Ian\)\n/);
    expect(viewer.out().endsWith(`\nAgent conversations open in the browser: ${g.relay.origin}/w/${g.workspaceId}\n`)).toBe(true);
    const joined = (await loadWorkspaces(statePaths(otherEnv))).joined;
    expect(joined).toHaveLength(1);
    expect(joined[0]).not.toHaveProperty('web');
  });

  it('a member with agent access types into a session the host opened (session.drive, §11 D-15): no read-only notice, the keys arrive; only the owner drives its size', async () => {
    const h = await startHost(['--role', 'agent']);
    const guestDirs = await makeDirs();
    cleanups.push(() => guestDirs.cleanup());
    const guestEnv = { HOME: guestDirs.home, SMURG_HOME: guestDirs.stateDir };
    const relayFor = async (): Promise<ReturnType<MemoryRelay['apiFor']>> => h.memory.apiFor({ userId: 'dev:ada', displayName: 'Ada' }, h.issuer);
    expect(await runAttach(['--invite', h.links.invite], commandContext(testIo({ env: guestEnv })), { relayFor })).toBe(0);
    expect(h.daemon.ctx.members.get('dev:ada')?.role).toBe('agent');
    // The host opens a terminal session (in the web app; here on the daemon side, review F1): Ada does not own it.
    const session = h.echo.open({ ownerUserId: h.relay.loginAs.userId, ownerName: h.relay.loginAs.displayName });
    h.echo.print(session.id, 'host$ ');
    // A bigger terminal than the session: as a non-owner, Ada's size is not applied (resize policy `owner`).
    const terminal = fakeTerminal({ cols: 100, rows: 30 });
    const io = testIo({ env: guestEnv, terminal });
    const attached = runAttach([session.id, '--workspace', h.workspaceId], commandContext(io), { relayFor });
    await waitFor(() => terminal.text().includes('host$ '), { what: 'the snapshot on Ada\'s terminal', timeoutMs: 15_000 });
    expect(io.out()).toContain('Attaching to session "Terminal (Ian)" (opened by Ian)');
    expect(io.out()).not.toContain('Read-only');
    expect(terminal.text()).not.toContain('read-only');
    terminal.type('echo typed-by-ada\r');
    await waitFor(() => (h.echo.inputs.get(session.id) ?? '').includes('echo typed-by-ada\r'), { what: 'Ada\'s keys in the host\'s session' });
    await waitFor(() => terminal.text().includes('echo typed-by-ada\r\n'), { what: 'the echo on Ada\'s terminal' });
    terminal.resize(120, 40);
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(h.echo.sessions.get(session.id)?.info).toMatchObject({ cols: 80, rows: 24 });
    terminal.type('\x1d');
    expect(await attached).toBe(0);
    expect(terminal.rawModeHistory).toEqual([true, false]);
  });

  it('the session exit code becomes the exit code of a guest attach of their own session; the host stopping ends an attach with an error', async () => {
    const h = await startHost(['--role', 'agent']);
    const guestDirs = await makeDirs();
    cleanups.push(() => guestDirs.cleanup());
    const guestEnv = { HOME: guestDirs.home, SMURG_HOME: guestDirs.stateDir };
    const relayFor = async (): Promise<ReturnType<MemoryRelay['apiFor']>> => h.memory.apiFor({ userId: 'dev:ria', displayName: 'Ria' }, h.issuer);
    expect(await runAttach(['--invite', h.links.invite], commandContext(testIo({ env: guestEnv })), { relayFor })).toBe(0);
    // A session owned by the guest (created directly on the daemon side for the test).
    const s1 = [...h.echo.sessions.values()];
    expect(s1).toHaveLength(0);
    const { RelayWorkspaceChannel } = await import('../src/channel/relay-channel.ts');
    const own = await RelayWorkspaceChannel.open({ relay: await relayFor(), workspaceId: h.workspaceId, stateDir: guestDirs.stateDir, invite: null, deviceName: 'test' });
    cleanups.push(() => own.close());
    const { session } = await own.request('session.create', { kind: 'terminal', workspace: { mode: 'main' }, cols: 80, rows: 24 });
    const terminal = fakeTerminal({ cols: 90, rows: 25 });
    const io = testIo({ env: guestEnv, terminal });
    const attached = runAttach([session.id], commandContext(io), { relayFor });
    await waitFor(() => terminal.rawMode, { what: 'raw mode' });
    await waitFor(() => (h.echo.sessions.get(session.id)?.viewers.size ?? 0) > 0, { what: 'the attach' });
    // Owner: SIGWINCH resizes the session; typing reaches it.
    terminal.resize(100, 30);
    await waitFor(() => h.echo.sessions.get(session.id)?.info.cols === 100, { what: 'the resize' });
    terminal.type('exit 5\r');
    expect(await attached).toBe(5);
    expect(terminal.rawMode).toBe(false);
    expect(terminal.text()).toContain('exit code 5');

    const { session: second } = await own.request('session.create', { kind: 'terminal', workspace: { mode: 'main' }, cols: 80, rows: 24 });
    const t2 = fakeTerminal();
    const io2 = testIo({ env: guestEnv, terminal: t2 });
    const attached2 = runAttach([second.id], commandContext(io2), { relayFor });
    await waitFor(() => t2.rawMode && (h.echo.sessions.get(second.id)?.viewers.size ?? 0) > 0, { what: 'the second attach' });
    expect(await runCli(['stop'], testIo({ env: h.env }))).toBe(0);
    expect(await attached2).toBe(1);
    expect(t2.rawMode).toBe(false);
    expect(t2.text()).toContain('The host stopped sharing (smurg stop).');

    // The host is gone now: joining again says so after a few seconds, not after the whole 30 s timeout.
    await waitFor(() => !h.memory.hostOnline('ws'), { what: 'the host to leave the relay' });
    const offline = testIo({ env: guestEnv });
    const started = Date.now();
    expect(await runAttach(['--workspace', h.workspaceId], commandContext(offline), { relayFor }).catch((err: Error) => err.message)).toContain('The host is offline');
    expect(Date.now() - started).toBeLessThan(15_000);
  });
});

describe('smurg host: the update notice (owner decision 2026-10-02)', () => {
  const INVITE_LINE = 'Link for your teammates (send it to them privately; valid for 7 days):';
  /** What `smurg host` printed from its summary on. */
  const fromSummary = (h: HostRun): string => h.io.out().slice(h.io.out().indexOf('\nsmurg is sharing'));
  /** The seams of a release build: a single executable of version 0.2.0 (the tests themselves run from source). */
  const released: UpdateNoticeDeps = { executable: '/nonexistent/bin/smurg', version: '0.2.0' };

  it('adds ONE line under the two links when a newer version is published; the rest of the start is exactly as before', async () => {
    const downloads = await startDownloads({ 'latest/VERSION': '0.3.0\n' });
    cleanups.push(() => downloads.close());
    const h = await startHost([], [], undefined, { loggedIn: true, env: { SMURG_INSTALL_BASE_URL: downloads.base }, update: released });
    await waitFor(() => h.io.out().includes('is available'), { what: 'the update notice' });
    expect(fromSummary(h)).toBe(`${summaryOf('project', h.links, INVITE_LINE)}\nVersion 0.3.0 is available (this is 0.2.0): stop sharing, then run smurg update\n`);
    expect(downloads.requests).toEqual(['latest/VERSION']);
    expect(h.io.err()).toBe('');
  });

  it('says nothing when this is the newest version, when the site fails, and asks nothing at all from source or with SMURG_NO_UPDATE_CHECK=1', async () => {
    const downloads = await startDownloads({ 'latest/VERSION': '0.2.0\n' });
    cleanups.push(() => downloads.close());
    const same = await startHost([], [], undefined, { loggedIn: true, env: { SMURG_INSTALL_BASE_URL: downloads.base }, update: released });
    await waitFor(() => downloads.requests.length === 1, { what: 'the version request' });
    const failing = await startDownloads({ 'latest/VERSION': (_req, res) => void res.writeHead(500).end('boom') });
    cleanups.push(() => failing.close());
    const failed = await startHost([], [], undefined, { loggedIn: true, env: { SMURG_INSTALL_BASE_URL: failing.base }, update: released });
    await waitFor(() => failing.requests.length === 1, { what: 'the failing request' });
    // Running from source (every other test of this file), and switched off: no request is made.
    const silent = await startDownloads({ 'latest/VERSION': '9.9.9\n' });
    cleanups.push(() => silent.close());
    const fromSource = await startHost([], [], undefined, { loggedIn: true, env: { SMURG_INSTALL_BASE_URL: silent.base } });
    const off = await startHost([], [], undefined, { loggedIn: true, env: { SMURG_INSTALL_BASE_URL: silent.base, SMURG_NO_UPDATE_CHECK: '1' }, update: released });
    await new Promise((resolve) => setTimeout(resolve, 300));
    for (const h of [same, failed, fromSource, off]) {
      expect(fromSummary(h)).toBe(summaryOf('project', h.links, INVITE_LINE));
      expect(h.io.err()).toBe('');
    }
    expect(silent.requests).toEqual([]);
  });

  it('never delays the start or the stop: a site that does not answer is given up silently', async () => {
    const downloads = await startDownloads({ 'latest/VERSION': () => {} }); // accepts the request, never answers
    cleanups.push(() => downloads.close());
    // The links are printed (startHost returns with both) while the request is still open.
    const h = await startHost([], [], undefined, { loggedIn: true, env: { SMURG_INSTALL_BASE_URL: downloads.base }, update: { ...released, timeoutMs: 400 } });
    await waitFor(() => downloads.requests.length === 1, { what: 'the version request' });
    expect(fromSummary(h)).toBe(summaryOf('project', h.links, INVITE_LINE));
    await new Promise((resolve) => setTimeout(resolve, 700)); // past the timeout: still nothing
    expect(fromSummary(h)).toBe(summaryOf('project', h.links, INVITE_LINE));
    // With the default 2 s still running, a stop does not wait for it either.
    const slow = await startHost([], [], undefined, { loggedIn: true, env: { SMURG_INSTALL_BASE_URL: downloads.base }, update: { ...released, timeoutMs: 60_000 } });
    await waitFor(() => downloads.requests.length === 2, { what: 'the second version request' });
    const started = Date.now();
    slow.io.signal('SIGINT');
    expect(await slow.done).toBe(0);
    expect(Date.now() - started).toBeLessThan(15_000);
    expect(slow.io.out()).not.toContain('is available');
  });
});
