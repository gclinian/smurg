// `smurg attach` through its module with an injected io, against an in-process daemon found through SMURG_HOME's run
// dir (as in production): the session list, picking a session by number / id prefix, and the zh-TW refusals with their
// exit codes (no terminal, unknown session, ended session, nothing to attach to, a malformed invite).
import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_FEATURE_MODULES, createDaemon, silentLogger, type Daemon } from '@smurg/daemon';
import { waitFor } from '@smurg/daemon/testing';
import { runCli } from '../src/cli/run.ts';
import { formatSessionList } from '../src/commands/attach.ts';
import { LocalWorkspaceChannel } from '../src/channel/local-channel.ts';
import { echoSessions, type EchoSessions } from './fixtures/echo-sessions.ts';
import { fakeTerminal, makeDirs, testIo, type Dirs } from './helpers.ts';

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  while (cleanups.length > 0) await Promise.resolve((cleanups.pop() as () => Promise<void> | void)()).catch(() => {});
});

interface Local {
  readonly dirs: Dirs;
  readonly env: Record<string, string>;
  readonly daemon: Daemon;
  readonly echo: EchoSessions;
  readonly host: LocalWorkspaceChannel;
}

async function local(): Promise<Local> {
  const dirs = await makeDirs();
  cleanups.push(() => dirs.cleanup());
  const echo = echoSessions();
  const daemon = await createDaemon({
    config: { stateDir: dirs.stateDir, shareDir: dirs.project, workspaceId: `ws_args_${Math.random().toString(36).slice(2, 12)}`, hostUserId: 'dev:host', hostName: 'Host', relayUrl: null, keepAwake: false },
    modules: [echo.module, ...DEFAULT_FEATURE_MODULES.filter((m) => m.name === 'local')],
    log: silentLogger,
    homeDir: dirs.home,
  });
  await daemon.start();
  cleanups.push(() => daemon.stop());
  const host = await LocalWorkspaceChannel.open(daemon.config.runPaths.ctl, { deviceName: 'test' });
  cleanups.push(() => host.close());
  return { dirs, env: { HOME: dirs.home, SMURG_HOME: dirs.stateDir }, daemon, echo, host };
}

describe('smurg attach (arguments, list, refusals)', () => {
  it('without a session: lists the sessions of the local workspace (as the host), numbered, marking the own ones', async () => {
    const l = await local();
    const empty = testIo({ env: l.env });
    expect(await runCli(['attach'], empty)).toBe(0);
    expect(empty.out()).toContain('本機');
    expect(empty.out()).toContain('目前沒有 session');
    await l.host.request('session.create', { kind: 'terminal', workspace: { mode: 'main' }, cols: 80, rows: 24, title: '第一個' });
    await l.host.request('session.create', { kind: 'agent', workspace: { mode: 'main' }, cols: 80, rows: 24, title: 'Claude（Host）' });
    const io = testIo({ env: l.env });
    expect(await runCli(['attach'], io)).toBe(0);
    expect(io.out()).toMatch(/1\s+ses_\S+\s+終端機\s+Host（你）\s+執行中\s+第一個/);
    expect(io.out()).toMatch(/2\s+ses_\S+\s+agent\s+Host（你）/);
    expect(io.out()).toContain('smurg attach <編號或 session ID>');
  });

  it('picks a session by its number and attaches; Ctrl-] detaches with exit 0 and restores the terminal', async () => {
    const l = await local();
    await l.host.request('session.create', { kind: 'terminal', workspace: { mode: 'main' }, cols: 80, rows: 24, title: 'one' });
    const { session } = await l.host.request('session.create', { kind: 'terminal', workspace: { mode: 'main' }, cols: 80, rows: 24, title: 'two' });
    l.echo.print(session.id, 'marker-two\r\n');
    const terminal = fakeTerminal({ cols: 90, rows: 20 });
    const io = testIo({ env: l.env, terminal });
    const done = runCli(['attach', '2'], io);
    await waitFor(() => terminal.text().includes('marker-two'), { what: 'the snapshot of session 2' });
    terminal.type('hi\r');
    await waitFor(() => (l.echo.inputs.get(session.id) ?? '').includes('hi\r'), { what: 'the keystrokes (the host owns it)' });
    terminal.type('\x1d');
    expect(await done).toBe(0);
    expect(terminal.rawModeHistory).toEqual([true, false]);
    expect(io.out()).toContain('接上 session「two」');
  });

  it('refuses in zh-TW with exit 2: no terminal, an unknown session, an ambiguous prefix; an ended session is exit 1', async () => {
    const l = await local();
    const { session } = await l.host.request('session.create', { kind: 'terminal', workspace: { mode: 'main' }, cols: 80, rows: 24, title: 'x' });
    const noTty = testIo({ env: l.env, terminal: fakeTerminal({ isTTY: false }) });
    expect(await runCli(['attach', session.id], noTty)).toBe(2);
    expect(noTty.err()).toContain('需要在終端機中執行');
    const unknown = testIo({ env: l.env });
    expect(await runCli(['attach', 'ses_nope'], unknown)).toBe(2);
    expect(unknown.err()).toContain('找不到 session「ses_nope」');
    await l.host.request('session.create', { kind: 'terminal', workspace: { mode: 'main' }, cols: 80, rows: 24, title: 'y' });
    const ambiguous = testIo({ env: l.env });
    expect(await runCli(['attach', 'ses_'], ambiguous)).toBe(2);
    expect(ambiguous.err()).toContain('符合多個 session');
    l.host.notify('exec.input', { sessionId: session.id, data: new TextEncoder().encode('exit 3\r') });
    await waitFor(() => l.echo.sessions.get(session.id)?.info.status === 'exited', { what: 'the session to end' });
    const ended = testIo({ env: l.env });
    expect(await runCli(['attach', session.id], ended)).toBe(1);
    expect(ended.err()).toContain('已經結束（結束代碼 3）');
  });

  it('lists a member\'s own Claude login process (session kind login, §11 D-12) as such, not as a terminal', () => {
    const base = { ownerUserId: 'dev:amy', ownerName: 'Amy', sandboxed: true, root: { kind: 'main' as const }, status: 'running' as const, cols: 80, rows: 24, createdAt: 1, login: 'unknown' as const, attached: 0 };
    const text = formatSessionList(
      [
        { ...base, id: 'ses_login', kind: 'login', title: 'Claude 登入' },
        { ...base, id: 'ses_term', kind: 'terminal', title: 'shell' },
      ],
      'dev:amy',
    );
    expect(text).toMatch(/1\s+ses_login\s+登入程序\s+Amy（你）/);
    expect(text).toMatch(/2\s+ses_term\s+終端機\s+Amy（你）/);
  });

  it('with nothing to attach to (no local host, never joined) or a malformed invite: exit 2 with what to do', async () => {
    const dirs = await makeDirs();
    cleanups.push(() => dirs.cleanup());
    const env = { HOME: dirs.home, SMURG_HOME: dirs.stateDir };
    const nothing = testIo({ env });
    expect(await runCli(['attach'], nothing)).toBe(2);
    expect(nothing.err()).toContain('不知道要接上哪個工作區');
    expect(nothing.err()).toContain('--invite');
    const bad = testIo({ env });
    expect(await runCli(['attach', '--invite', 'https://smurg.app/join/ws_x#k=nope'], bad)).toBe(2);
    expect(bad.err()).toContain('邀請連結不正確');
  });
});
