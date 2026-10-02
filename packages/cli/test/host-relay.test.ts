// `smurg host` and a guest's `smurg attach` through the relay, in-process with injected io: the host logs in (against a
// fake relay HTTP API), claims the workspace, runs the daemon (echo sessions + the real control socket; tunnelled
// traffic through the in-memory relay with real Noise channels) and prints its short summary (the workspace's name and
// the two links; everything else is in docs/HOSTING.md and `smurg status`); a guest joins with the printed invite using
// the CLI device key and pin files; an editor is read-only on the host's session and sees what a second viewer sees
// (R4.1), an 「可使用 agent」 member types into it (§11 D-15); a guest later reconnects with the pinned key only.
// `smurg stop` and Ctrl-C end the host.
import { generateKeyPairSync } from 'node:crypto';
import { lstat, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { createConnection } from 'node:net';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
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
import { MemoryRelay, TestIdentityIssuer, waitFor } from '@smurg/daemon/testing';
import { toHex, utf8Encode } from '@smurg/protocol';
import xtermHeadless from '@xterm/headless';
import { runCli } from '../src/cli/run.ts';
import { runAttach } from '../src/commands/attach.ts';
import { commandContext } from '../src/commands/context.ts';
import { hostUsage, inviteHeading, runHost } from '../src/commands/host.ts';
import { LocalWorkspaceChannel } from '../src/channel/local-channel.ts';
import { statePaths } from '../src/state/paths.ts';
import { loadCredentials, saveSession } from '../src/state/credentials.ts';
import { rememberSharedFolder } from '../src/state/workspaces.ts';
import type { UpdateNoticeDeps } from '../src/update/notice.ts';
import { startDownloads } from './downloads-server.ts';
import { browserOpening, startFakeRelay, type FakeRelay } from './fake-relay.ts';
import { echoSessions, type EchoSessions } from './fixtures/echo-sessions.ts';
import { fakeTerminal, makeDirs, testIo, type Dirs, type TestIo } from './helpers.ts';
import { SecondViewer, drained, viewportOf } from './viewer.ts';

const { Terminal } = xtermHeadless;
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
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
  return ['', `smurg 正在分享「${name}」`, '', '你的連結（只給你自己用）：', `  ${links.host}`, '', inviteLine, `  ${links.invite}`, '', '按 Ctrl-C 停止分享。', ''].join('\n');
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
    expect(await run(join(dirs.home, 'nope'))).toMatchObject({ code: 2, err: expect.stringContaining('找不到資料夾') });
    await writeFile(join(dirs.home, 'file.txt'), 'x');
    expect(await run(join(dirs.home, 'file.txt'))).toMatchObject({ code: 2, err: expect.stringContaining('不是資料夾') });
    expect(await run(dirs.home)).toMatchObject({ code: 2, err: expect.stringContaining('不能分享整個家目錄') });
    // CLI-04: a folder that CONTAINS the home directory would show ~/.ssh and the rest to every member.
    expect(await run(dirname(dirs.home))).toMatchObject({ code: 2, err: expect.stringContaining('不能分享包含家目錄的資料夾') });
    // SMURG_HOME inside the folder: the keys would be visible to guests.
    const nested = testIo({ env: { HOME: dirs.home, SMURG_HOME: join(dirs.project, '.smurg-state') } });
    expect(await runCli(['host', dirs.project], nested)).toBe(2);
    expect(nested.err()).toContain('狀態目錄');
    const bad = testIo({ env });
    expect(await runCli(['host', dirs.project, '--role', 'host'], bad)).toBe(2);
    expect(bad.err()).toContain('不能是主人角色');
    const badExpiry = testIo({ env });
    expect(await runCli(['host', dirs.project, '--expires', '400d'], badExpiry)).toBe(2);
    // The invite links carry their secret: they may only point at https, or at http on this machine.
    const badWeb = testIo({ env });
    expect(await runCli(['host', dirs.project, '--web-origin', 'http://web.example.com'], badWeb)).toBe(2);
    expect(badWeb.err()).toContain('--web-origin 的網址不正確');
  });

  it('--web-origin: the links point at the web app people open (local development: the Vite dev server)', async () => {
    const h = await startHost(['--web-origin', 'http://localhost:5173']);
    expect(h.links.host.startsWith(`http://localhost:5173/join/${h.workspaceId}#k=`)).toBe(true);
    expect(h.links.invite.startsWith(`http://localhost:5173/join/${h.workspaceId}#k=`)).toBe(true);
    // The links say where they point; no separate line for it.
    expect(h.io.out()).not.toContain('網頁：');
  });

  it('with a stored login the whole output is the workspace\'s name, the two links (each once) and how to stop (owner decision 2026-10-01)', async () => {
    const h = await startHost([], [], undefined, { loggedIn: true });
    expect(h.io.opened).toEqual([]);
    expect(h.daemon.ctx.workspace.info.name).toBe(basename(await realpath(h.dirs.project)));
    expect(h.io.out()).toBe(summaryOf(h.daemon.ctx.workspace.info.name, h.links, '給組員的連結（用私訊傳給他們，7 天內有效）：'));
    expect(h.io.err()).toBe('');
    // Nothing follows on its own (keep-awake switched off by the host): still the same.
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(h.io.out()).toBe(summaryOf(h.daemon.ctx.workspace.info.name, h.links, '給組員的連結（用私訊傳給他們，7 天內有效）：'));
    expect(h.links.host).toContain(`/join/${h.workspaceId}#k=`);
    expect(h.links.host).not.toBe(h.links.invite);
  });

  it('the teammates\' line names the expiry, and the use limit and the role only when the host chose them', () => {
    expect(inviteHeading('editor', 7 * 86_400, undefined)).toBe('給組員的連結（用私訊傳給他們，7 天內有效）：');
    expect(inviteHeading('editor', 2 * 3600, 3)).toBe('給組員的連結（用私訊傳給他們，2 小時內有效，可以使用 3 次）：');
    expect(inviteHeading('agent', 30 * 60, undefined)).toBe('給組員的連結（用私訊傳給他們，30 分鐘內有效，角色：可使用 agent）：');
    expect(inviteHeading('viewer', 14 * 86_400, 1)).toBe('給組員的連結（用私訊傳給他們，14 天內有效，可以使用 1 次，角色：旁觀）：');
    expect(inviteHeading('editor', 365 * 86_400, undefined)).toBe('給組員的連結（用私訊傳給他們，365 天內有效）：');
  });

  it('--role agent: the printed link is an 「可使用 agent」 invite and its line says so; nothing else is printed (§11 D-15)', async () => {
    const h = await startHost(['--role', 'agent'], [], undefined, { loggedIn: true });
    expect(h.io.out()).toBe(summaryOf(h.daemon.ctx.workspace.info.name, h.links, '給組員的連結（用私訊傳給他們，7 天內有效，角色：可使用 agent）：'));
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
    expect(runner.err()).toContain('不認得的角色「runner」');
    expect(runner.err()).toContain('可用的角色：agent（可使用 agent）、editor（可編輯）、viewer（旁觀）。');
    expect(runner.opened).toEqual([]); // no login started
    const host = testIo({ env, openUrl: browserOpening });
    expect(await runCli(['host', dirs.project, '--relay', 'http://127.0.0.1:9', '--no-keep-awake', '--role', 'host'], host)).toBe(2);
    expect(host.err()).toContain('可用的角色：agent、editor、viewer。');
    expect(host.opened).toEqual([]);
  });

  it('logs in when needed, shares, prints only the short summary with the invite\'s terms; the links only on the terminal, never in the log; smurg stop ends it', async () => {
    const h = await startHost(['--role', 'editor', '--max-uses', '3', '--expires', '2h', '--name', '課堂專案']);
    const out = h.io.out();
    // Logged in (there was no session), claimed the workspace at the relay.
    expect(h.relay.workspaces.get(h.workspaceId)).toBe('github:4242');
    // After the login's own messages: exactly the summary (an explicit default role is not mentioned).
    const start = out.indexOf('\nsmurg 正在分享');
    expect(start).toBeGreaterThanOrEqual(0);
    expect(out.slice(start)).toBe(summaryOf('課堂專案', h.links, '給組員的連結（用私訊傳給他們，2 小時內有效，可以使用 3 次）：'));
    // Each link exactly once; the invite really has the terms the line names.
    for (const url of [h.links.host, h.links.invite]) expect(out.split(url)).toHaveLength(2);
    const invite = h.daemon.ctx.invites.list().find((i) => i.role === 'editor');
    expect(invite?.maxUses).toBe(3);
    expect((invite?.expiresAt ?? 0) - (invite?.createdAt ?? 0)).toBe(2 * 3600_000);
    // None of what moved to docs/HOSTING.md and `smurg status` (owner decision 2026-10-01).
    for (const moved of ['資料夾：', '工作區：', h.daemon.fingerprint, '金鑰指紋', '分享前請先了解', 'prompt injection', '沙盒', '訂閱', 'shell 指令', '主工作區', '防止睡眠', '紀錄檔', '可使用 agent', '內建的公用 relay']) {
      expect(out, moved).not.toContain(moved);
    }
    expect(h.io.err()).not.toContain('/join/');

    const stopper = testIo({ env: h.env });
    expect(await runCli(['stop'], stopper)).toBe(0);
    // `smurg stop` returns once the daemon stopped completely: its control socket goes last.
    expect(h.daemon.status().stopped).toBe(true);
    await expect(lstat(h.daemon.config.runPaths.ctl)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(stopper.out()).toContain('已停止分享');
    expect(await h.done).toBe(0);
    expect(h.io.out()).toContain('已停止分享');
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

  it('Ctrl-C stops gracefully (exit 0); a second Ctrl-C right away is ignored, a later one while stopping leaves at once (130; CLI-06)', async () => {
    const h = await startHost();
    h.io.signal('SIGINT');
    expect(await h.done).toBe(0);
    expect(h.io.out()).toContain('收到 SIGINT，正在停止分享');
    expect(h.daemon.status().stopped).toBe(true);
    expect(h.io.exits).toEqual([]);
    h.io.signal('SIGINT');
    // After the command returned nothing listens any more. During a stop: a double press within 2 s is one impatient
    // key press (leaving then could leave session processes stopped, CLI-06); a later press is the forced exit.
    let now = Date.now();
    const g = await startHost([], [], undefined, { now: () => now });
    g.io.signal('SIGINT');
    g.io.signal('SIGINT');
    expect(g.io.exits).toEqual([]);
    expect(g.io.out()).toContain('請稍候');
    now += 2_500;
    g.io.signal('SIGINT');
    expect(g.io.exits).toEqual([130]);
    expect(await g.done).toBe(0);
  });

  // Verification F-2 (2026-10-02): any process of the host's OS account reaches the control socket (every session of
  // a 「可使用 agent」 member). It used to choose the daemon's stop reason, and this command took 'start-failed' /
  // 'summary-failed' for its own stops: the daemon stopped while the host's terminal still said 「按 Ctrl-C 停止分享」.
  it('a stop request names no reason (one that does is refused and stops nothing); a daemon stop this command did not make is told and ends it, whatever its reason (verification F-2)', async () => {
    const h = await startHost();
    for (const reason of ['start-failed', 'summary-failed']) {
      expect(await rawCtlRequest(h.daemon.config.runPaths.ctl, { v: 1, op: 'stop', reason })).toMatchObject({ ok: false, error: { code: 'bad_request' } });
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(h.daemon.status().stopped).toBe(false);
    expect(h.io.out()).not.toContain('收到停止要求');
    // Stopped with those reasons from anywhere else: the host is told, and the command ends as for `smurg stop`.
    for (const reason of ['start-failed', 'summary-failed']) {
      const g = reason === 'start-failed' ? h : await startHost();
      await g.daemon.stop(reason);
      expect(await Promise.race([g.done, new Promise((resolve) => setTimeout(() => resolve('still running'), 10_000))])).toBe(0);
      expect(g.io.out()).toContain('收到停止要求（smurg stop），正在停止分享');
      expect(g.io.out()).toContain('已停止分享');
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
    expect(out).not.toContain('收到停止要求');
    expect(out).not.toContain('已停止分享');
    expect(out).not.toContain('按 Ctrl-C 停止分享');
  });

  it('the relay refusing the host login is told on the terminal; a renewed `smurg login` is picked up without a restart (REL-08, CLI-03, CLI-10)', async () => {
    const h = await startHost([], [], undefined, { credentialsWatchMs: 200 });
    // The relay stops accepting the daemon's token (the 7-day session expired, or was revoked): the next reconnect is 401.
    const renewed = 'renewed.token-for-test';
    h.memory.hostTokenValid = (token) => token === renewed;
    h.memory.dropHost('ws');
    await waitFor(() => h.io.out().includes('relay 拒絕了這台電腦的登入'), { timeoutMs: 15_000, what: 'the auth-rejected notice' });
    expect(h.io.out()).toContain(`smurg login --relay ${h.relay.origin}`);
    expect(h.daemon.status().relay.interactive).toBe('auth-rejected');
    expect(h.memory.hostOnline('ws')).toBe(false);
    // `smurg login` in another terminal writes credentials.json: the running host uses it at once.
    const user = { userId: 'github:4242', displayName: 'Ian', provider: 'github' as const };
    await saveSession(statePaths(h.env), h.relay.origin, { token: renewed, tokenType: 'Bearer', expiresIn: 7 * 24 * 3600, user }, Date.now());
    await waitFor(() => h.memory.hostOnline('ws'), { timeoutMs: 15_000, what: 'the daemon back at the relay with the renewed login' });
    await waitFor(() => h.io.out().includes('已重新連上 relay'), { what: 'the reconnected notice' });
    expect(h.io.out()).toContain('已改用新的 relay 登入');
    expect(h.memory.hostTokens.at(-1)).toBe(renewed);
    // A login of ANOTHER account is not used (the workspace belongs to the account that claimed it).
    await saveSession(statePaths(h.env), h.relay.origin, { token: 'other.account-token', tokenType: 'Bearer', expiresIn: 7 * 24 * 3600, user: { userId: 'github:1', displayName: 'Eve', provider: 'github' } }, Date.now());
    await waitFor(() => h.io.out().includes('是另一個帳號（Eve）'), { what: 'the other-account notice' });
    // A login that is about to expire is told while sharing, before members are locked out.
    await saveSession(statePaths(h.env), h.relay.origin, { token: 'short.lived-token', tokenType: 'Bearer', expiresIn: 3600, user }, Date.now());
    await waitFor(() => h.io.out().includes('relay 的登入將在'), { what: 'the expiry reminder' });
    // Secrets never reach the terminal.
    for (const token of [renewed, 'other.account-token', 'short.lived-token']) expect(h.io.out()).not.toContain(token);
  });

  it('a state file the disk refuses is told on the terminal, and so is its recovery (REL-14)', async () => {
    const h = await startHost();
    h.daemon.ctx.bus.emit('state.write', { document: 'members', ok: false });
    h.daemon.ctx.bus.emit('state.write', { document: 'invites', ok: false });
    expect(h.io.out().match(/無法寫入 smurg 的狀態檔/g)).toHaveLength(1);
    h.daemon.ctx.bus.emit('state.write', { document: 'members', ok: true });
    expect(h.io.out()).not.toContain('狀態檔已重新寫入成功');
    h.daemon.ctx.bus.emit('state.write', { document: 'invites', ok: true });
    expect(h.io.out()).toContain('狀態檔已重新寫入成功');
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
    const { session } = await ensureSession({ io: again, paths: statePaths(env) }, relay.origin, { interactive: true, minValidityMs: HOST_SESSION_MIN_VALIDITY_MS });
    expect(again.out()).toContain('relay 的登入快要到期');
    expect(again.opened).toHaveLength(1);
    expect(session.token).not.toBe(stored?.token);
    expect(session.expiresAt - Date.now()).toBeGreaterThan(HOST_SESSION_MIN_VALIDITY_MS);
    // Without the minimum (every other command), the one-hour login is still used as is.
    const plain = testIo({ env, openUrl: browserOpening });
    await ensureSession({ io: plain, paths: statePaths(env) }, relay.origin, { interactive: true });
    expect(plain.opened).toEqual([]);
  });

  it('refuses a folder that overlaps one a running host shares, whatever the relay (CLI-05)', async () => {
    const h = await startHost();
    // The same folder for another relay origin: refused before any login.
    const other = testIo({ env: h.env, openUrl: browserOpening });
    expect(await runCli(['host', h.dirs.project, '--relay', 'http://127.0.0.1:9', '--no-keep-awake'], other)).toBe(1);
    expect(other.err()).toContain('已經在分享中');
    expect(other.opened).toEqual([]);
    // A folder inside the shared one.
    await mkdir(join(h.dirs.project, 'sub'), { recursive: true });
    const inner = testIo({ env: h.env, openUrl: browserOpening });
    expect(await runCli(['host', join(h.dirs.project, 'sub'), '--relay', h.relay.origin, '--no-keep-awake'], inner)).toBe(1);
    expect(inner.err()).toContain('上層資料夾');
    expect(inner.opened).toEqual([]);
  });

  it('keep-awake lost after the start (the inhibitor exited) is told on the host terminal (CLI-13)', async () => {
    let status: PowerStatus = { active: true, mechanism: 'systemd-inhibit', pid: 4242, reason: null };
    const power: PowerService = { start: async () => status, stop: async () => {}, status: () => status };
    const h = await startHost([], [], power);
    // Working keep-awake is not news at the start; `smurg status` shows it.
    expect(h.io.out()).not.toContain('防止睡眠');
    expect(await statusOf(h)).toContain('防止睡眠：已啟用（systemd-inhibit）');
    status = { active: false, mechanism: 'none', pid: null, reason: 'the inhibitor exited' };
    await waitFor(() => h.io.out().includes('防止睡眠已失效'), { timeoutMs: 10_000, what: 'the keep-awake warning' });
    expect(h.io.out()).toContain('⚠ 防止睡眠已失效：未啟用（防睡眠程式已經結束）');
  });

  it('keep-awake the system refuses (Linux over SSH: polkit) is told in one line after the links, with the reason and what to do (linux-binary F5); switched off by the host, nothing is said', async () => {
    const status: PowerStatus = { active: false, mechanism: 'none', pid: null, reason: 'the inhibitor was refused' };
    const power: PowerService = { start: async () => status, stop: async () => {}, status: () => status };
    const h = await startHost([], [], power, { loggedIn: true });
    expect(h.io.out()).toBe(
      summaryOf(h.daemon.ctx.workspace.info.name, h.links, '給組員的連結（用私訊傳給他們，7 天內有效）：') +
        '\n⚠ 防止睡眠：未啟用（系統（polkit）不允許防止睡眠（例如透過 SSH 登入時，Ubuntu 預設如此）；請在這台電腦的桌面登入後執行 smurg host，或請系統管理員允許）。電腦睡眠時組員會看到「主人已離線」。\n',
    );
    // --no-keep-awake (every other test here): the host's own choice, not a notice; `smurg status` still says it.
    const off = await startHost([], [], undefined, { loggedIn: true });
    expect(off.io.out()).not.toContain('防止睡眠');
    expect(await statusOf(off)).toContain('防止睡眠：未啟用（已用 --no-keep-awake 關閉）');
  });

  it('passes the D-13 switch on to the daemon (on by default); the start says nothing about it, `smurg status` shows it (§11 D-13)', async () => {
    const h = await startHost([], [], undefined, { loggedIn: true });
    expect(h.daemon.config.activity.attributeBashEdits).toBe(true);
    expect(h.io.out()).toBe(summaryOf(h.daemon.ctx.workspace.info.name, h.links, '給組員的連結（用私訊傳給他們，7 天內有效）：'));
    const status = await statusOf(h);
    expect(status).toContain('  agent 的 shell 指令通知：開啟\n');
  });

  it('--no-bash-attribution switches the daemon off; the start says nothing, `smurg status` shows it', async () => {
    const h = await startHost(['--no-bash-attribution'], [], undefined, { loggedIn: true });
    expect(h.daemon.config.activity.attributeBashEdits).toBe(false);
    expect(h.io.out()).toBe(summaryOf(h.daemon.ctx.workspace.info.name, h.links, '給組員的連結（用私訊傳給他們，7 天內有效）：'));
    const status = await statusOf(h);
    expect(status).toContain('  agent 的 shell 指令通知：已關閉（--no-bash-attribution）\n');
  });

  it('`smurg status` shows what the start no longer prints: folder, relay, fingerprint, keep-awake, the switch, the log file; never a link', async () => {
    const h = await startHost(['--no-bash-attribution'], [], undefined, { loggedIn: true });
    const status = await statusOf(h);
    const lines = [
      `工作區 ${h.workspaceId}\n`,
      `  資料夾：${await realpath(h.dirs.project)}\n`,
      `  relay：${h.relay.origin}，互動連線 已連線，檔案傳輸 `,
      `  daemon 金鑰指紋：${h.daemon.fingerprint}\n`,
      '  防止睡眠：未啟用（已用 --no-keep-awake 關閉）\n',
      '  agent 的 shell 指令通知：已關閉（--no-bash-attribution）\n',
      `  紀錄檔：${join(h.dirs.stateDir, 'logs', `${h.workspaceId}.log`)}\n`,
    ];
    for (const line of lines) expect(status, line).toContain(line);
    // In this order.
    const at = lines.map((line) => status.indexOf(line));
    expect([...at].sort((x, y) => x - y)).toEqual(at);
    // No guest sandbox, guest login or main-workspace line any more (§11 D-15: there is no guest sandbox).
    for (const gone of ['客人沙盒', '訂閱登入', '主工作區', 'runner']) expect(status, gone).not.toContain(gone);
    // Not the relay's built-in mark (the test relay is not the built-in one), and never a link or its secret.
    expect(status).not.toContain('內建的公用 relay');
    expect(status).not.toContain('/join/');
    for (const url of [h.links.host, h.links.invite]) expect(status).not.toContain(new URLSearchParams(new URL(url).hash.slice(1)).get('s') as string);
  });

  it('what the start no longer prints is in the host guide (docs/HOSTING.md), and --help points to it', async () => {
    const help = testIo({ env: {} });
    expect(await runCli(['host', '--help'], help)).toBe(0);
    expect(help.out()).toBe(hostUsage());
    expect(help.out()).toContain('分享前必讀：https://smurg.ai/docs/hosting/#4-分享前必讀\n');
    expect(help.out()).toContain('https://smurg.ai/docs/hosting/#5-可使用-agent角色與-agent-的-shell-指令\n');
    expect(help.out()).toContain('smurg status');
    // The role 「可使用 agent」 and what it hands over are named right where it is chosen.
    expect(help.out()).toContain('agent（可使用 agent）、editor（可編輯，預設）、viewer（旁觀）');
    expect(help.out()).toContain('以你的身分在這台電腦上執行、用你的 Claude 登入');
    const guide = await readFile(join(ROOT, 'docs', 'HOSTING.md'), 'utf8');
    expect(guide).toContain('\n## 4. 分享前必讀\n');
    expect(guide).toContain('\n## 5. 「可使用 agent」角色與 agent 的 shell 指令\n');
    const section = (n: number): string => guide.slice(guide.indexOf(`\n## ${n}. `), guide.indexOf(`\n## ${n + 1}. `));
    // SPEC §11's warnings, before sharing.
    for (const text of ['**所有 agent session 都不在沙盒裡**', 'prompt injection', '**只把「可使用 agent」給你完全信任的人**', '組員只能在 `smurg host` 執行']) {
      expect(section(4), text).toContain(text);
    }
    // The role 「可使用 agent」 (what it lets happen on this machine, how to give and take it back) and the switch.
    for (const text of [
      '`smurg host <資料夾> --role agent`',
      '**以你的身分在你的電腦上執行**',
      '**沒有沙盒**',
      '**用量和費用都算在你身上**',
      '他開的 session 會立刻結束',
      '--no-bash-attribution',
      '**不含指令內容和輸出**',
    ]) {
      expect(section(5), text).toContain(text);
    }
    // The fingerprint, keep-awake, where the log is, and `smurg status`.
    for (const text of ['金鑰指紋', '闔上筆電螢幕仍然會睡眠', '`~/.smurg/logs/<工作區代碼>.log`', '`smurg status`']) expect(guide, text).toContain(text);
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
    await refused(['--no-bash-attribution=yes'], '不接受值');
    await refused(['--no-bash-attribution', '--bash-attribution'], '選項 --bash-attribution 和 --no-bash-attribution 不能同時指定');
    await refused(['--no-bash'], '不認得的選項 --no-bash');
    // §11 D-15 (owner decision 2026-10-01): no guest sandbox, so the guest-login and main-workspace switches are gone.
    for (const flag of ['--no-guest-subscription-login', '--guest-subscription-login', '--allow-main-workspace-guests', '--no-main-workspace-guests', '--main-workspace-guests']) {
      await refused([flag], `不認得的選項 ${flag}`);
    }
    const help = testIo({ env });
    expect(await runCli(['host', '--help'], help)).toBe(0);
    expect(help.out()).toContain('--no-bash-attribution');
    for (const gone of ['--no-guest-subscription-login', '--allow-main-workspace-guests', '--no-main-workspace-guests', 'runner', '客人沙盒']) expect(help.out(), gone).not.toContain(gone);
  });

  it('refuses a second host of the same folder while the first runs (exit 1)', async () => {
    const h = await startHost();
    const again = testIo({ env: h.env, openUrl: browserOpening });
    expect(await runCli(['host', h.dirs.project, '--relay', h.relay.origin, '--no-keep-awake'], again)).toBe(1);
    expect(again.err()).toContain('已經在分享中');
    // Refused before any login (CLI-07): without a relay session, no browser login starts for it.
    expect(await runCli(['logout', '--all'], testIo({ env: h.env }))).toBe(0);
    const loggedOut = testIo({ env: h.env, openUrl: browserOpening });
    expect(await runCli(['host', h.dirs.project, '--relay', h.relay.origin, '--no-keep-awake'], loggedOut)).toBe(1);
    expect(loggedOut.err()).toContain('已經在分享中');
    expect(loggedOut.opened).toEqual([]);
    expect(loggedOut.out()).not.toContain('登入');
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
    expect(list.out()).toContain('目前沒有 session');
    const device = join(guestDirs.stateDir, 'device.key');
    const pin = join(guestDirs.stateDir, 'pins', `${toHex(utf8Encode(h.workspaceId))}.pub`);
    expect((await lstat(device)).mode & 0o777).toBe(0o600);
    expect((await lstat(pin)).mode & 0o777).toBe(0o600);
    expect(Buffer.from(await readFile(pin)).equals(Buffer.from(h.daemon.daemonPublicKey))).toBe(true);

    // 2. The host starts a session (in the web app; here on the daemon side: the control socket cannot open sessions,
    // review F1) and prints something. The host's own terminal is attached through the control socket.
    const session = h.echo.open({ ownerUserId: h.relay.loginAs.userId, ownerName: h.relay.loginAs.displayName, kind: 'agent', title: 'Claude（Ian）' });
    const host = await LocalWorkspaceChannel.open(h.daemon.config.runPaths.ctl, { deviceName: 'host test' });
    cleanups.push(() => host.close());
    h.echo.print(session.id, '\x1b[1mhello from the host\x1b[0m\r\n');

    // 3. The guest attaches (the pinned key now; the invite was used once): an editor may not type (no session.drive).
    const terminal = fakeTerminal({ cols: 80, rows: 24 });
    const guest = testIo({ env: guestEnv, terminal });
    const attached = runAttach([session.id.slice(0, 12), '--workspace', h.workspaceId], commandContext(guest), { relayFor });
    await waitFor(() => terminal.text().includes('hello from the host'), { what: 'the snapshot on the guest terminal', timeoutMs: 15_000 });
    expect(terminal.rawMode).toBe(true);
    expect(guest.out()).toContain('（Ian 開的）');
    expect(guest.out()).toContain('唯讀模式：這個 session 是 Ian 開的，你的角色不能在 session 裡輸入');
    expect(terminal.text()).toContain('唯讀'); // the window title says it too
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

  it('an 「可使用 agent」 member types into a session the host opened (session.drive, §11 D-15): no read-only notice, the keys arrive; only the owner drives its size', async () => {
    const h = await startHost(['--role', 'agent']);
    const guestDirs = await makeDirs();
    cleanups.push(() => guestDirs.cleanup());
    const guestEnv = { HOME: guestDirs.home, SMURG_HOME: guestDirs.stateDir };
    const relayFor = async (): Promise<ReturnType<MemoryRelay['apiFor']>> => h.memory.apiFor({ userId: 'dev:ada', displayName: 'Ada' }, h.issuer);
    expect(await runAttach(['--invite', h.links.invite], commandContext(testIo({ env: guestEnv })), { relayFor })).toBe(0);
    expect(h.daemon.ctx.members.get('dev:ada')?.role).toBe('agent');
    // The host opens a terminal session (in the web app; here on the daemon side, review F1): Ada does not own it.
    const session = h.echo.open({ ownerUserId: h.relay.loginAs.userId, ownerName: h.relay.loginAs.displayName, kind: 'terminal', title: '終端機（Ian）' });
    h.echo.print(session.id, 'host$ ');
    // A bigger terminal than the session: as a non-owner, Ada's size is not applied (resize policy `owner`).
    const terminal = fakeTerminal({ cols: 100, rows: 30 });
    const io = testIo({ env: guestEnv, terminal });
    const attached = runAttach([session.id, '--workspace', h.workspaceId], commandContext(io), { relayFor });
    await waitFor(() => terminal.text().includes('host$ '), { what: 'the snapshot on Ada\'s terminal', timeoutMs: 15_000 });
    expect(io.out()).toContain('接上 session「終端機（Ian）」（Ian 開的）');
    expect(io.out()).not.toContain('唯讀');
    expect(terminal.text()).not.toContain('唯讀');
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
    expect(terminal.text()).toContain('結束代碼 5');

    const { session: second } = await own.request('session.create', { kind: 'terminal', workspace: { mode: 'main' }, cols: 80, rows: 24 });
    const t2 = fakeTerminal();
    const io2 = testIo({ env: guestEnv, terminal: t2 });
    const attached2 = runAttach([second.id], commandContext(io2), { relayFor });
    await waitFor(() => t2.rawMode && (h.echo.sessions.get(second.id)?.viewers.size ?? 0) > 0, { what: 'the second attach' });
    expect(await runCli(['stop'], testIo({ env: h.env }))).toBe(0);
    expect(await attached2).toBe(1);
    expect(t2.rawMode).toBe(false);
    expect(t2.text()).toContain('主人已停止分享');

    // The host is gone now: joining again says so after a few seconds, not after the whole 30 s timeout (CLI-14).
    await waitFor(() => !h.memory.hostOnline('ws'), { what: 'the host to leave the relay' });
    const offline = testIo({ env: guestEnv });
    const started = Date.now();
    expect(await runAttach(['--workspace', h.workspaceId], commandContext(offline), { relayFor }).catch((err: Error) => err.message)).toContain('主人目前離線');
    expect(Date.now() - started).toBeLessThan(15_000);
  });
});

describe('smurg host: the update notice (owner decision 2026-10-02)', () => {
  const INVITE_LINE = '給組員的連結（用私訊傳給他們，7 天內有效）：';
  /** What `smurg host` printed from its summary on. */
  const fromSummary = (h: HostRun): string => h.io.out().slice(h.io.out().indexOf('\nsmurg 正在分享'));
  /** The seams of a release build: a single executable of version 0.2.0 (the tests themselves run from source). */
  const released: UpdateNoticeDeps = { executable: '/nonexistent/bin/smurg', version: '0.2.0' };

  it('adds ONE line under the two links when a newer version is published; the rest of the start is exactly as before', async () => {
    const downloads = await startDownloads({ 'latest/VERSION': '0.3.0\n' });
    cleanups.push(() => downloads.close());
    const h = await startHost([], [], undefined, { loggedIn: true, env: { SMURG_INSTALL_BASE_URL: downloads.base }, update: released });
    await waitFor(() => h.io.out().includes('有新版本'), { what: 'the update notice' });
    expect(fromSummary(h)).toBe(`${summaryOf('project', h.links, INVITE_LINE)}\n有新版本 0.3.0（目前 0.2.0）：停止分享後執行 smurg update\n`);
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
    expect(slow.io.out()).not.toContain('有新版本');
  });
});
