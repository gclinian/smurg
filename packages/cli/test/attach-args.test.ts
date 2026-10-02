// `smurg attach` through its module with an injected io, against an in-process daemon found through SMURG_HOME's run
// dir (as in production): the session list, picking a session by number / id prefix, and the zh-TW refusals with their
// exit codes (no terminal, unknown session, ended session, nothing to attach to, a malformed invite).
import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_FEATURE_MODULES, createDaemon, silentLogger, type Daemon } from '@smurg/daemon';
import { waitFor } from '@smurg/daemon/testing';
import { runCli } from '../src/cli/run.ts';
import { attachUsage, formatSessionList } from '../src/commands/attach.ts';
import { renderText } from '../src/i18n/index.ts';
import { LocalWorkspaceChannel } from '../src/channel/local-channel.ts';
import { echoSessions, type EchoSessions } from './fixtures/echo-sessions.ts';
import { fakeTerminal, makeDirs, testIo, type Dirs } from './helpers.ts';

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  while (cleanups.length > 0) await Promise.resolve((cleanups.pop() as () => Promise<void> | void)()).catch(() => {});
});

/** The host's sessions, opened on the daemon side (as from the web): the control socket cannot open any (review F1). */
const HOST = { ownerUserId: 'dev:host', ownerName: 'Host' } as const;

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
    expect(empty.out()).toContain('on this computer');
    expect(empty.out()).toContain('This workspace has no sessions.');
    l.echo.open({ ...HOST, kind: 'terminal', title: 'first one' });
    l.echo.open({ ...HOST, kind: 'agent' });
    const io = testIo({ env: l.env });
    expect(await runCli(['attach'], io)).toBe(0);
    expect(io.out()).toMatch(/1\s+ses_\S+\s+terminal\s+Host \(you\)\s+running\s+first one/);
    expect(io.out()).toMatch(/2\s+ses_\S+\s+agent\s+Host \(you\)\s+running\s+Claude \(Host\)/);
    expect(io.out()).toContain('smurg attach <number or session ID>');
  });

  it('the control socket carries only what smurg attach sends (review F1): anything else is refused as forbidden and audited via control-socket', async () => {
    const l = await local();
    const attempts = [
      ['session.create', { kind: 'terminal', workspace: { mode: 'main' }, cols: 80, rows: 24 }],
      ['admin.member.list', {}],
      ['admin.member.setRole', { userId: 'dev:carol', role: 'editor' }],
      ['admin.invite.create', { role: 'agent' }],
      ['worktree.merge.approve', { requestId: 'mr_nope' }],
      ['channel.leave', {}],
    ] as const;
    for (const [type, payload] of attempts) {
      const refused = await l.host.request(type as never, payload as never).then(
        () => 'accepted',
        (err: unknown) => err,
      );
      expect({ type, refused }).toMatchObject({ type, refused: { code: 'forbidden', detail: { reason: 'control-socket' } } });
    }
    expect(l.echo.sessions.size).toBe(0);
    // What the attach itself needs still works over the same channel.
    expect(await l.host.request('session.list', {})).toEqual({ sessions: [] });
    await l.daemon.ctx.audit.flush();
    const denied = (await l.daemon.ctx.audit.query({ limit: 100 })).filter((e) => e.action === 'authz.denied').reverse();
    expect(denied.map((e) => [e.target, e.actor.kind === 'user' ? e.actor.userId : e.actor.kind, e.detail?.['reason'], e.detail?.['via']])).toEqual(
      attempts.map(([type]) => [type, 'dev:host', 'control-socket', 'control-socket']),
    );
  });

  it('picks a session by its number and attaches; Ctrl-] detaches with exit 0 and restores the terminal', async () => {
    const l = await local();
    l.echo.open({ ...HOST, kind: 'terminal', title: 'one' });
    const session = l.echo.open({ ...HOST, kind: 'terminal', title: 'two' });
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
    expect(io.out()).toContain('Attaching to session "two"');
  });

  it('refuses in zh-TW with exit 2: no terminal, an unknown session, an ambiguous prefix; an ended session is exit 1', async () => {
    const l = await local();
    const session = l.echo.open({ ...HOST, kind: 'terminal', title: 'x' });
    const noTty = testIo({ env: l.env, terminal: fakeTerminal({ isTTY: false }) });
    expect(await runCli(['attach', session.id], noTty)).toBe(2);
    expect(noTty.err()).toContain('smurg attach must run in a terminal');
    const unknown = testIo({ env: l.env });
    expect(await runCli(['attach', 'ses_nope'], unknown)).toBe(2);
    expect(unknown.err()).toContain('No session "ses_nope"');
    l.echo.open({ ...HOST, kind: 'terminal', title: 'y' });
    const ambiguous = testIo({ env: l.env });
    expect(await runCli(['attach', 'ses_'], ambiguous)).toBe(2);
    expect(ambiguous.err()).toContain('matches more than one session');
    l.host.notify('exec.input', { sessionId: session.id, data: new TextEncoder().encode('exit 3\r') });
    await waitFor(() => l.echo.sessions.get(session.id)?.info.status === 'exited', { what: 'the session to end' });
    const ended = testIo({ env: l.env });
    expect(await runCli(['attach', session.id], ended)).toBe(1);
    expect(ended.err()).toContain('has already exited (exit code 3)');
  });

  it('lists every session under the member who opened it (they all run as the host, §11 D-15): agent or terminal, the own ones marked', () => {
    const base = { root: { kind: 'main' as const }, status: 'running' as const, cols: 80, rows: 24, createdAt: 1, login: 'unknown' as const, attached: 0 };
    const text = formatSessionList(
      [
        { ...base, id: 'ses_amy_agent', kind: 'agent', ownerUserId: 'dev:amy', ownerName: 'Amy' },
        { ...base, id: 'ses_host_term', kind: 'terminal', ownerUserId: 'dev:host', ownerName: 'Host', title: 'build' },
      ],
      'dev:amy',
      'en',
    );
    expect(text).toMatch(/1\s+ses_amy_agent\s+agent\s+Amy \(you\)\s+running\s+Claude \(Amy\)/);
    expect(text).toMatch(/2\s+ses_host_term\s+terminal\s+Host\s+running\s+build/);
    expect(text).not.toContain('Host (you)');
  });

  it('with nothing to attach to (no local host, never joined) or a malformed invite: exit 2 with what to do', async () => {
    const dirs = await makeDirs();
    cleanups.push(() => dirs.cleanup());
    const env = { HOME: dirs.home, SMURG_HOME: dirs.stateDir };
    const nothing = testIo({ env });
    expect(await runCli(['attach'], nothing)).toBe(2);
    expect(nothing.err()).toContain('Which workspace to attach to is not known');
    expect(nothing.err()).toContain('--invite');
    const bad = testIo({ env });
    expect(await runCli(['attach', '--invite', 'https://smurg.app/join/ws_x#k=nope'], bad)).toBe(2);
    expect(bad.err()).toContain('The invite link is not valid');
  });

  it('--help says who may type: the host and members with agent access into any session, every other role read-only (§11 D-15)', async () => {
    const usage = renderText('en', attachUsage());
    expect(usage).toContain('Once attached: press Ctrl-] to leave (the session keeps running). The host and members with agent access can type\n  into any session; other roles are read-only.');
    expect(usage).not.toContain('only the owner');
    const io = testIo({ env: {} });
    expect(await runCli(['attach', '--help'], io)).toBe(0);
    expect(io.out()).toContain('The host and members with agent access can type');
  });
});
