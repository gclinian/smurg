// ARCHITECTURE §11 D-12, the sessions side of a guest's Claude subscription login (session kind 'login'), with the
// services around the sessions module faked (FakeSandbox runs the command unconfined and records every spec; the
// real sandbox is test/sessions/login.real.test.ts and test/sandbox/login-policy.real.test.ts). Who may start one,
// what it runs (nothing from the request), who sees it, how it ends, what is audited, and what happens to the guest's
// agent sessions when it succeeded.
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { chmod, readFile, realpath, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SmurgError, sessionCreatePayloadSchema, type SessionInfo } from '@smurg/protocol';
import type { Principal } from '../../src/core/interfaces.ts';
import { LOGIN_MAX_MS, LOGIN_MESSAGES, loginClaudeArgs, loginCommand } from '../../src/sessions/login.ts';
import { DEFAULT_SESSION_LIMITS } from '../../src/sessions/session-manager.ts';
import { createTempDir, removeTempDir } from '../../src/testing/index.ts';
import { TestViewer, waitFor } from './helpers.ts';
import { startSessionStack, type SessionStack } from './setup.ts';

const stacks: SessionStack[] = [];
const viewers: TestViewer[] = [];
const scratch: string[] = [];

afterEach(async () => {
  for (const viewer of viewers.splice(0)) viewer.dispose();
  for (const stack of stacks.splice(0)) await stack.cleanup();
  for (const dir of scratch.splice(0)) await removeTempDir(dir);
});

/** A directory for a stand-in claude, removed after the test (registered with the test run as well). */
async function standinDir(): Promise<string> {
  const dir = await createTempDir('login-standin');
  scratch.push(dir);
  return dir;
}

async function stack(options: Parameters<typeof startSessionStack>[0] = {}): Promise<SessionStack> {
  const s = await startSessionStack(options);
  stacks.push(s);
  return s;
}

const login = { kind: 'login', workspace: { mode: 'main' }, cols: 100, rows: 30 } as const;

/** Whether a pid is still in the process table (ps, never a signal). */
function alive(pid: number): Promise<boolean> {
  return new Promise((resolve) => execFile('/bin/ps', ['-o', 'pid=', '-p', String(pid)], (err, stdout) => resolve(err === null && stdout.trim() === String(pid))));
}
const agent = { kind: 'agent', workspace: { mode: 'main' }, cols: 80, rows: 24 } as const;

/**
 * A stand-in `claude` for the login flow: `auth status` says logged in iff the guest's credential file exists; the
 * login (`… auth login --claudeai`) writes that file and exits 0 — unless LOGIN_WAIT is in its own directory, then it
 * waits (cat). Everything else (an agent) waits.
 */
async function loginClaude(dir: string, waitForever = false): Promise<string> {
  const path = join(dir, 'claude-login-standin');
  await writeFile(
    path,
    [
      '#!/bin/sh',
      'case "$1" in --version) echo "2.1.283 (Claude Code)"; exit 0 ;; esac',
      'if [ "$1" = auth ] && [ "$2" = status ]; then',
      '  if [ -f "$CLAUDE_CONFIG_DIR/.credentials.json" ]; then echo \'{"loggedIn":true,"authMethod":"claude.ai"}\'; exit 0; fi',
      '  echo \'{"loggedIn":false,"authMethod":"none"}\'; exit 1',
      'fi',
      'for a in "$@"; do if [ "$a" = login ]; then',
      waitForever ? '  echo LOGIN-WAITING; exec cat' : '  echo \'{"claudeAiOauth":{"accessToken":"sk-ant-oat01-fake"}}\' > "$CLAUDE_CONFIG_DIR/.credentials.json"; echo LOGIN-DONE; exit 0',
      'fi; done',
      'echo AGENT-READY; exec cat',
      '',
    ].join('\n'),
  );
  await chmod(path, 0o755);
  return path;
}

async function refusedWith(promise: Promise<unknown>): Promise<SmurgError> {
  const err = await promise.then(() => null, (e: unknown) => e);
  expect(err).toBeInstanceOf(SmurgError);
  return err as SmurgError;
}

describe('who may start a login, and with what (D-12)', { timeout: 60_000 }, () => {
  it('the switch off (config.sessions.guestSubscriptionLogin false): refused with a zh-TW message pointing to API keys, audited, nothing started', async () => {
    const s = await stack({ daemonSessions: { guestSubscriptionLogin: false } });
    const rita = await s.t.connect({ userId: 'dev:rita', role: 'runner' });
    const err = await rita.conn.request('session.create', login).then(() => null, (e: { code: string; message: string; detail?: unknown }) => e);
    expect(err).toMatchObject({ code: 'forbidden', message: LOGIN_MESSAGES.switchedOff, detail: { reason: 'guest-subscription-login-off' } });
    expect(LOGIN_MESSAGES.switchedOff).toMatch(/API key/);
    expect(s.fakes.sandbox.wraps).toEqual([]);
    const audit = await s.t.ctx.audit.query({ limit: 20 });
    expect(audit.find((e) => e.action === 'session.create')).toMatchObject({ outcome: 'denied', target: 'login', detail: { kind: 'login', reason: 'guest-subscription-login-off' } });
    // agent sessions with an API key are unaffected
    await expect(rita.conn.request('session.create', { ...agent, apiKey: 'sk-ant-api03-test-key-0000000000' })).resolves.toMatchObject({ session: { kind: 'agent' } });
  });

  it('only a guest who may own sandboxed sessions: the host (unsandboxed) and editors / viewers are refused', async () => {
    const s = await stack();
    const host = await s.t.connectHost();
    const amy = await s.t.connect({ userId: 'dev:amy', role: 'editor' });
    await expect(host.conn.request('session.create', login)).rejects.toMatchObject({ code: 'forbidden', message: LOGIN_MESSAGES.guestsOnly, detail: { reason: 'login-guests-only' } });
    await expect(amy.conn.request('session.create', login)).rejects.toMatchObject({ code: 'forbidden' });
    expect(s.fakes.sandbox.wraps).toEqual([]);
  });

  it('refuses a worktree and an API key: nothing about the process comes from the request', async () => {
    const s = await stack();
    const rita = await s.t.connect({ userId: 'dev:rita', role: 'runner' });
    await expect(rita.conn.request('session.create', { ...login, workspace: { mode: 'worktree' } })).rejects.toMatchObject({ code: 'bad_request', detail: { reason: 'login-main-only' } });
    await expect(rita.conn.request('session.create', { ...login, apiKey: 'sk-ant-api03-test-key-0000000000' })).rejects.toMatchObject({ code: 'bad_request', detail: { reason: 'login-no-api-key' } });
    expect(s.fakes.sandbox.wraps).toEqual([]);
  });

  it('runs exactly `<claude> <fixed login args>` from a daemon-owned directory, whatever the request says (title, size)', async () => {
    const s = await stack();
    const rita = await s.t.connect({ userId: 'dev:rita', role: 'runner' });
    const hostile = { ...login, cols: 77, rows: 21, title: `$(touch /tmp/smurg-login-title-${process.pid}); --console` };
    const { session } = await rita.conn.request('session.create', hostile);
    expect(session).toMatchObject({ kind: 'login', title: 'Claude 訂閱登入（rita）', sandboxed: true, cols: 77, rows: 21 });
    const spec = s.fakes.sandbox.wraps.at(-1) as unknown as Record<string, unknown> & { command: string; env: Record<string, string>; rootPath: string; guestDir: string; settingsDir: string };
    const guest = s.sessions.guestPaths('dev:rita');
    expect(spec['loginProcess']).toBe(true);
    const claude = await realpath(s.fakeClaude.path);
    expect(spec.command).toBe(loginCommand({ tmpDir: guest.tmp, cwd: spec.settingsDir, claude, browser: '/usr/bin/true' }));
    expect(spec.command).not.toContain('touch');
    expect(spec.command).not.toContain('--console');
    expect(spec.rootPath).toBe(guest.home);
    expect(spec.guestDir).toBe(guest.root);
    expect(spec['loginPrograms']).toEqual(expect.arrayContaining([claude, '/usr/bin/true']));
    expect(Object.keys(spec.env).filter((name) => /TOKEN|HOOK|API_KEY/.test(name))).toEqual([]);
    expect(spec.env['BROWSER']).toBe('/usr/bin/true');
    expect(loginClaudeArgs('/usr/bin/true')).toEqual(['--setting-sources', 'project', '--settings', '{"disableAllHooks":true,"env":{"BROWSER":"/usr/bin/true"}}', 'auth', 'login', '--claudeai']);
    await rita.conn.request('session.end', { sessionId: session.id });
  });

  it('one at a time per guest', async () => {
    const s = await stack({ claudePath: await loginClaude(await standinDir(), true) });
    const rita = await s.t.connect({ userId: 'dev:rita', role: 'runner' });
    const tries = await Promise.allSettled([rita.conn.request('session.create', login), rita.conn.request('session.create', login)]);
    expect(tries.filter((t) => t.status === 'fulfilled')).toHaveLength(1);
    expect(tries.find((t) => t.status === 'rejected')).toMatchObject({ reason: { code: 'conflict', detail: { reason: 'login-running' } } });
    // Another guest may log in at the same time.
    const otto = await s.t.connect({ userId: 'dev:otto', role: 'runner' });
    await expect(otto.conn.request('session.create', login)).resolves.toMatchObject({ session: { kind: 'login', ownerUserId: 'dev:otto' } });
    await s.sessions.killAllForUser('dev:rita', 'left');
    await s.sessions.killAllForUser('dev:otto', 'left');
  });
});

describe('attacks on the login process (finish-gate security check, D-12)', { timeout: 60_000 }, () => {
  it('nothing of a request names whose guest dir, which command, which arguments or which environment: the schema refuses every such field, and a request forced past it still runs the fixed command in the CALLER\'s own guest dir', async () => {
    // At the wire: session.create is a strict schema; the router validates every inbound envelope against it.
    for (const extra of [{ ownerUserId: 'dev:otto' }, { userId: 'dev:otto' }, { guestDir: '/tmp/x' }, { env: { BROWSER: '/bin/sh' } }, { command: 'sh' }, { args: ['--x'] }, { cwd: '/' }, { claudePath: '/bin/sh' }, { settings: '{}' }]) {
      expect(sessionCreatePayloadSchema.safeParse({ ...login, ...extra }).success, JSON.stringify(extra)).toBe(false);
    }
    // Behind the router (defence in depth): the fields are ignored; the login is rita's, in rita's dir.
    const claudePath = await loginClaude(await standinDir(), true);
    const s = await stack({ claudePath });
    await s.t.connect({ userId: 'dev:rita', role: 'runner' });
    await s.t.connect({ userId: 'dev:otto', role: 'runner' });
    const rita = s.t.ctx.members.principalOf('dev:rita') as Principal;
    const forced = { ...login, ownerUserId: 'dev:otto', userId: 'dev:otto', guestDir: s.sessions.guestPaths('dev:otto').root, env: { BROWSER: '/bin/sh', SMURG_SESSION_TOKEN: 'x' }, command: 'touch /tmp/pwned', args: ['--debug'], cwd: '/' } as unknown as Parameters<typeof s.sessions.create>[0];
    const session = await s.sessions.create(forced, { channelId: 'ch_forced', id: 'conn_forced' } as never, rita);
    expect(session).toMatchObject({ kind: 'login', ownerUserId: 'dev:rita', title: 'Claude 訂閱登入（rita）' });
    const spec = s.fakes.sandbox.wraps.at(-1) as unknown as { command: string; env: Record<string, string>; guestDir: string; rootPath: string; settingsDir: string };
    const ritaDirs = s.sessions.guestPaths('dev:rita');
    expect(spec.guestDir).toBe(ritaDirs.root);
    expect(spec.rootPath).toBe(ritaDirs.home);
    expect(spec.command).toBe(loginCommand({ tmpDir: ritaDirs.tmp, cwd: spec.settingsDir, claude: await realpath(claudePath), browser: '/usr/bin/true' }));
    expect(spec.env['BROWSER']).toBe('/usr/bin/true');
    expect(Object.keys(spec.env).filter((name) => /TOKEN|HOOK/.test(name))).toEqual([]);
    expect(spec.command).not.toContain('pwned');
    expect(spec.command).not.toContain('--debug');
    expect(existsSync(join(s.sessions.guestPaths('dev:otto').cfg, '.credentials.json'))).toBe(false);
    await s.sessions.killAllForUser('dev:rita', 'left');
  });

  it('nobody but its owner types into it or resizes it (the owner can: positive control)', async () => {
    const s = await stack({ claudePath: await loginClaude(await standinDir(), true) });
    const rita = await s.t.connect({ userId: 'dev:rita', role: 'runner' });
    const otto = await s.t.connect({ userId: 'dev:otto', role: 'runner' });
    const host = await s.t.connectHost();
    const { session } = await rita.conn.request('session.create', login);
    const viewer = new TestViewer(rita.conn, session.id);
    viewers.push(viewer);
    await viewer.attach({ cols: 100, rows: 30 });
    await waitFor(() => viewer.received.includes('LOGIN-WAITING'), 'the login screen for its owner');
    const principals = { otto: s.t.ctx.members.principalOf('dev:otto') as Principal, host: s.t.ctx.members.principalOf('dev:host') as Principal };
    for (const [name, principal] of Object.entries(principals)) {
      expect(() => s.sessions.input({ sessionId: session.id, data: new TextEncoder().encode(`TYPED-BY-${name}\r`) }, { channelId: `ch_${name}`, id: `conn_${name}` } as never, principal), name).toThrow();
      expect(() => s.sessions.resize({ sessionId: session.id, cols: 20, rows: 5 }, { channelId: `ch_${name}`, id: `conn_${name}` } as never, principal), name).toThrow();
    }
    // Over the wire as well (exec.input is one-way: the daemon answers a refused one with an error).
    otto.conn.notify('exec.input', { sessionId: session.id, data: new TextEncoder().encode('TYPED-BY-otto-wire\r') });
    otto.conn.notify('exec.resize', { sessionId: session.id, cols: 20, rows: 5 });
    host.conn.notify('exec.input', { sessionId: session.id, data: new TextEncoder().encode('TYPED-BY-host-wire\r') });
    await new Promise((resolve) => setTimeout(resolve, 200));
    rita.conn.notify('exec.input', { sessionId: session.id, data: new TextEncoder().encode('TYPED-BY-rita\r') });
    await waitFor(() => viewer.received.includes('TYPED-BY-rita'), 'the owner\'s input echoed by the login process');
    expect(viewer.received).not.toContain('TYPED-BY-otto');
    expect(viewer.received).not.toContain('TYPED-BY-host');
    expect(s.sessions.listFor('dev:rita').find((x) => x.id === session.id)).toMatchObject({ cols: 100, rows: 30 });
    await rita.conn.request('session.end', { sessionId: session.id });
  });

  it('it cannot outlive its limit: 10 minutes in production; at the limit the process tree is gone, not only the status', async () => {
    expect(LOGIN_MAX_MS).toBe(10 * 60_000);
    expect(DEFAULT_SESSION_LIMITS.loginMaxMs).toBe(LOGIN_MAX_MS);
    const s = await stack({ claudePath: await loginClaude(await standinDir(), true), module: { limits: { loginMaxMs: 600 } } });
    const rita = await s.t.connect({ userId: 'dev:rita', role: 'runner' });
    const { session } = await rita.conn.request('session.create', login);
    const pid = s.sessions.ptyPid(session.id);
    expect(pid).not.toBeNull();
    expect(await alive(pid as number)).toBe(true);
    await waitFor(() => s.sessions.listFor('dev:rita').find((x) => x.id === session.id)?.status === 'exited', 'the time limit');
    expect(s.sessions.listFor('dev:rita').find((x) => x.id === session.id)).toMatchObject({ endReason: 'terminated' });
    await waitFor(async () => !(await alive(pid as number)), 'the login process to be gone');
    // A new one may start after the old one ended (the limit is per process, not a lock-out).
    await expect(rita.conn.request('session.create', login)).resolves.toMatchObject({ session: { kind: 'login' } });
    await s.sessions.killAllForUser('dev:rita', 'left');
  });
});

describe('a login is private to its owner (D-12)', { timeout: 60_000 }, () => {
  it('not in anyone else\'s session.list, no session.state to anyone else, nobody else attaches; no other module sees it', async () => {
    const s = await stack({ claudePath: await loginClaude(await standinDir(), true) });
    const host = await s.t.connectHost();
    const rita = await s.t.connect({ userId: 'dev:rita', role: 'runner' });
    const otto = await s.t.connect({ userId: 'dev:otto', role: 'runner' });
    const states: Record<string, SessionInfo[]> = { host: [], rita: [], otto: [] };
    host.conn.on('session.state', (p) => states['host']?.push(p.session));
    rita.conn.on('session.state', (p) => states['rita']?.push(p.session));
    otto.conn.on('session.state', (p) => states['otto']?.push(p.session));
    const { session } = await rita.conn.request('session.create', login);
    const viewer = new TestViewer(rita.conn, session.id);
    viewers.push(viewer);
    await viewer.attach({ cols: 100, rows: 30 });
    await waitFor(() => viewer.received.includes('LOGIN-WAITING'), 'the login screen for its owner');
    expect((await rita.conn.request('session.list', {})).sessions.map((x) => x.id)).toContain(session.id);
    expect((await otto.conn.request('session.list', {})).sessions.map((x) => x.id)).not.toContain(session.id);
    expect((await host.conn.request('session.list', {})).sessions.map((x) => x.id)).not.toContain(session.id);
    await expect(otto.conn.request('session.attach', { sessionId: session.id })).rejects.toMatchObject({ code: 'not_found' });
    await expect(host.conn.request('session.attach', { sessionId: session.id })).rejects.toMatchObject({ code: 'not_found' });
    await expect(otto.conn.request('suggest.create', { sessionId: session.id, text: 'paste this code' })).rejects.toBeDefined();
    expect(s.sessions.list().map((x) => x.id)).not.toContain(session.id);
    expect(s.sessions.get(session.id)).toBeNull();
    expect(s.fakes.presence.agents.size).toBe(0);
    await rita.conn.request('session.end', { sessionId: session.id });
    await waitFor(() => (states['rita'] ?? []).some((x) => x.id === session.id && x.status === 'exited'), 'the owner learns it ended');
    expect(states['rita']?.some((x) => x.id === session.id && x.status === 'running')).toBe(true);
    expect(states['otto']?.some((x) => x.id === session.id)).toBe(false);
    expect(states['host']?.some((x) => x.id === session.id)).toBe(false);
    // Its output is never in the audit log or the daemon log.
    expect(JSON.stringify(await s.t.ctx.audit.query({ limit: 100 }))).not.toContain('LOGIN-WAITING');
  });
});

describe('how a login ends (D-12)', { timeout: 60_000 }, () => {
  it('ends by itself after the limit (10 minutes in production): terminated, audited with its reason only', async () => {
    const s = await stack({ claudePath: await loginClaude(await standinDir(), true), module: { limits: { loginMaxMs: 400 } } });
    const rita = await s.t.connect({ userId: 'dev:rita', role: 'runner' });
    const { session } = await rita.conn.request('session.create', login);
    await waitFor(() => s.sessions.listFor('dev:rita').find((x) => x.id === session.id)?.status === 'exited', 'the timeout');
    expect(s.sessions.listFor('dev:rita').find((x) => x.id === session.id)).toMatchObject({ status: 'exited', endReason: 'terminated' });
    const ended = (await s.t.ctx.audit.query({ limit: 50 })).find((e) => e.action === 'session.end' && e.target === session.id);
    expect(ended?.detail).toMatchObject({ kind: 'login', reason: 'terminated' });
    expect(Object.keys(ended?.detail ?? {}).sort()).toEqual(expect.arrayContaining(['kind', 'reason', 'sessionId']));
  });

  it('a kick ends it with everything else of the guest', async () => {
    const s = await stack({ claudePath: await loginClaude(await standinDir(), true) });
    const rita = await s.t.connect({ userId: 'dev:rita', role: 'runner' });
    const { session } = await rita.conn.request('session.create', login);
    await s.sessions.killAllForUser('dev:rita', 'kicked');
    expect(s.sessions.listFor('dev:rita').find((x) => x.id === session.id)).toMatchObject({ status: 'exited', endReason: 'kicked' });
  });

  it('after a successful login the guest\'s running agent sessions report logged-in (the credential is in the guest dir); start and exit code audited', async () => {
    const s = await stack({ claudePath: await loginClaude(await standinDir()) });
    const rita = await s.t.connect({ userId: 'dev:rita', role: 'runner' });
    const principal = s.t.ctx.members.principalOf('dev:rita') as Principal;
    const { session: agentSession } = await rita.conn.request('session.create', agent);
    await waitFor(async () => (await s.sessions.loginStatus(agentSession.id, principal)) === 'logged-out', 'not logged in yet');
    const updates: SessionInfo[] = [];
    rita.conn.on('session.state', (p) => updates.push(p.session));
    const { session } = await rita.conn.request('session.create', login);
    await waitFor(() => s.sessions.listFor('dev:rita').find((x) => x.id === session.id)?.status === 'exited', 'the login to finish');
    await waitFor(() => updates.some((x) => x.id === agentSession.id && x.login === 'logged-in'), 'the agent session re-checked');
    expect(await s.sessions.loginStatus(agentSession.id, principal)).toBe('logged-in');
    expect(await readFile(join(s.sessions.guestPaths('dev:rita').cfg, '.credentials.json'), 'utf8')).toContain('claudeAiOauth');
    const audit = await s.t.ctx.audit.query({ limit: 50 });
    expect(audit.find((e) => e.action === 'session.create' && e.target === session.id)).toMatchObject({ outcome: 'ok', detail: { kind: 'login' } });
    expect(audit.find((e) => e.action === 'session.end' && e.target === session.id)?.detail).toEqual({ sessionId: session.id, kind: 'login', reason: 'exit', exitCode: 0 });
    await rita.conn.request('session.end', { sessionId: agentSession.id });
  });
});
