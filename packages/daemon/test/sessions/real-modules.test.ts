// The sessions module with the REAL sandbox and hooks modules (srt on this machine), skipping loudly while either is
// still a stub. Layout like test/sandbox/helpers.ts: everything a broken sandbox could read lives in one temp dir with a
// FAKE host home (config.sessions.hostHome) holding canary files; the developer's real home is never involved. The
// daemon runs without a relay; the SessionManager is driven directly (its handlers are covered by the other files).
import { randomBytes } from 'node:crypto';
import { execFile } from 'node:child_process';
import { chmod, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FeatureModule } from '../../src/core/context.ts';
import type { ActivityFeed, ClientConnection, LockManager, PresenceService, Principal, WorktreeManager } from '../../src/core/interfaces.ts';
import { toDisposable } from '../../src/core/lifecycle.ts';
import { createLineLogger } from '../../src/core/logger.ts';
import { isStubService } from '../../src/core/stubs.ts';
import { createDaemon, type Daemon } from '../../src/daemon.ts';
import { hooksModule } from '../../src/hooks/module.ts';
import { sandboxModule } from '../../src/sandbox/module.ts';
import { createSessionsModule } from '../../src/sessions/module.ts';
import type { SessionManagerImpl } from '../../src/sessions/session-manager.ts';
import { createTempDir, createTempRunDir, removeTempDir, removeTempRunDir } from '../../src/testing/index.ts';
import { FakeActivity, FakeLocks, FakePresence, FakeWorktrees, waitFor } from './helpers.ts';
import { CLI_MAIN } from './real-stack.ts';

const execFileAsync = promisify(execFile);
const supported = process.platform === 'darwin' || process.platform === 'linux';

interface Fixture {
  daemon: Daemon;
  sessions: SessionManagerImpl;
  home: string;
  share: string;
  canary: string;
  base: string;
  runDir: string;
  warnings: string[];
  restoreTmp: () => void;
}

let fixture: Fixture | null = null;
let setupError: unknown = null;
const RUNNER = 'dev:carol';
const conn = { channelId: 'ch_real_modules', id: 'conn_real_modules' } as unknown as ClientConnection;

function fakeServices(): FeatureModule {
  const worktrees = new FakeWorktrees();
  return {
    name: 'session-test-fakes',
    create: (ctx) => {
      worktrees.ctx = ctx;
      return {
        locks: new FakeLocks() as unknown as LockManager,
        presence: new FakePresence() as unknown as PresenceService,
        activity: new FakeActivity() as unknown as ActivityFeed,
        worktrees: worktrees as unknown as WorktreeManager,
      };
    },
    register: () => toDisposable(() => {}),
  };
}

async function setup(): Promise<Fixture> {
  const runDir = await createTempRunDir();
  // srt's proxy socket lives in os.tmpdir(): keep it short while the daemon lives (test/sandbox/helpers.ts does too).
  const previousTmp = process.env['TMPDIR'];
  if (tmpdir().length > 40) process.env['TMPDIR'] = runDir;
  const restoreTmp = (): void => {
    if (previousTmp === undefined) delete process.env['TMPDIR'];
    else process.env['TMPDIR'] = previousTmp;
  };
  const base = await createTempDir('sessions-real');
  const home = join(base, 'home');
  const share = join(home, 'projects', 'app');
  const stateDir = join(home, '.smurg');
  const canary = `SMURG-CANARY-${randomBytes(6).toString('hex')}`;
  await mkdir(join(home, '.ssh'), { recursive: true });
  await writeFile(join(home, '.ssh', 'id_ed25519'), `${canary}\n`);
  await mkdir(share, { recursive: true });
  await writeFile(join(share, 'README.md'), 'shared readme\n');
  // A fake `claude` that leaves its evidence in $TMPDIR (the guest's own tmp: writable inside the sandbox).
  const bin = join(base, 'bin');
  await mkdir(bin, { recursive: true });
  const claude = join(bin, 'claude');
  await writeFile(
    claude,
    `#!/bin/sh
case "$1" in
  --version) echo "2.1.283 (Claude Code)"; exit 0 ;;
  auth) echo '{"loggedIn":false,"authMethod":"none"}'; exit 1 ;;
esac
{ for a in "$@"; do printf '%s\\n' "$a"; done; } > "$TMPDIR/claude-argv"
cat "$2" > "$TMPDIR/claude-settings" 2>/dev/null; echo "read=$?" >> "$TMPDIR/claude-settings-rc"
(echo tamper >> "$2") 2>/dev/null; echo "write=$?" >> "$TMPDIR/claude-settings-rc"
echo "socket=$SMURG_HOOK_SOCKET" > "$TMPDIR/claude-env"
exec cat
`,
  );
  await chmod(claude, 0o755);
  const warnings: string[] = [];
  const workspaceId = `ws_test_${randomBytes(9).toString('base64url')}`;
  const hostEnv = { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', HOME: home, USER: process.env['USER'] ?? 'host', LANG: 'en_US.UTF-8', SHELL: '/bin/sh' };
  const daemon = await createDaemon({
    config: {
      stateDir,
      runDir,
      shareDir: share,
      workspaceId,
      hostUserId: 'dev:host',
      hostName: 'Host',
      relayUrl: null,
      keepAwake: false,
      defaultSettings: { allowedDomains: [] },
      // The real `smurg hook` (node + the CLI's sources): a guest agent session starts only after the hook answered
      // from inside its sandbox (the in-sandbox hook self-test, SEC-D-05 follow-up).
      sessions: { hostHome: home, claudePath: claude, selfCommand: { file: process.execPath, args: [CLI_MAIN] } },
    },
    modules: [fakeServices(), sandboxModule, hooksModule, createSessionsModule({ hostEnv: () => hostEnv, hostShell: '/bin/sh', guestShell: '/bin/sh', keychain: async () => {} })],
    homeDir: home,
    log: createLineLogger({ level: 'warn', write: (line) => warnings.push(line) }),
  });
  await daemon.start();
  daemon.ctx.members.admitMember({ userId: RUNNER, displayName: 'carol', role: 'runner', at: Date.now() });
  return { daemon, sessions: daemon.ctx.services.sessions as SessionManagerImpl, home: await realpath(home), share: await realpath(share), canary, base, runDir, warnings, restoreTmp };
}

beforeAll(async () => {
  if (!supported) return;
  try {
    fixture = await setup();
  } catch (err) {
    setupError = err;
  }
}, 60_000);

afterAll(async () => {
  if (!fixture) return;
  await fixture.daemon.stop();
  await removeTempDir(fixture.base);
  fixture.restoreTmp();
  await removeTempRunDir(fixture.runDir);
}, 60_000);

function runner(): Principal {
  return (fixture as Fixture).daemon.ctx.members.principalOf(RUNNER) as Principal;
}

async function type(sessionId: string, text: string): Promise<void> {
  (fixture as Fixture).sessions.input({ sessionId, data: new TextEncoder().encode(text) }, conn, runner());
}

async function readWhenPresent(path: string, timeoutMs = 20_000): Promise<string> {
  let text = '';
  await waitFor(async () => {
    text = await readFile(path, 'utf8').catch(() => '');
    return text.length > 0;
  }, path, timeoutMs);
  return text;
}

describe('sessions with the real sandbox and hooks modules', { timeout: 90_000 }, () => {
  it('a guest terminal runs inside the real sandbox: the host home is unreadable and unwritable, the project and the guest dir are not; the kick still ends it within 3 s', async (ctx) => {
    if (!supported) return ctx.skip('real srt runs on macOS and Linux only');
    if (setupError) throw setupError;
    const f = fixture as Fixture;
    if (isStubService(f.daemon.ctx.services.sandbox)) {
      console.warn('[sessions] SKIPPED: the sandbox module is still a stub');
      return ctx.skip('sandbox module is a stub');
    }
    const session = await f.sessions.create({ kind: 'terminal', workspace: { mode: 'main' }, cols: 120, rows: 40 }, conn, runner());
    expect(session.sandboxed).toBe(true);
    const guest = f.sessions.guestPaths(RUNNER);
    const token = `${randomBytes(3).readUIntBE(0, 3) + 70_000_000}`;
    // Linux: also a job that setsid()s AND scrubs its environment (ARCHITECTURE §11 D-3: on macOS such a process
    // survives the end of its session; on Linux it lives in the session's own pid namespace, which dies with bwrap).
    const escapee = `${randomBytes(3).readUIntBE(0, 3) + 60_000_000}`;
    const linux = process.platform === 'linux';
    await type(
      session.id,
      [
        `cat '${join(f.home, '.ssh', 'id_ed25519')}' > "$TMPDIR/r-ssh" 2>&1; echo "rc=$?" >> "$TMPDIR/r-ssh"`,
        `(echo pwned > '${join(f.home, 'pwned')}') 2>/dev/null; echo "rc=$?" > "$TMPDIR/r-write"`,
        `cat README.md > "$TMPDIR/r-read" 2>&1`,
        `echo guest-note > "$HOME/note"; echo "rc=$?" > "$TMPDIR/r-home"`,
        `sleep ${token} &`,
        ...(linux ? [`/usr/bin/setsid /usr/bin/env -i /bin/sleep ${escapee} < /dev/null > /dev/null 2>&1 &`] : []),
        `echo done > "$TMPDIR/r-done"`,
      ].join('\r') + '\r',
    );
    await readWhenPresent(join(guest.tmp, 'r-done'));
    const ssh = await readFile(join(guest.tmp, 'r-ssh'), 'utf8');
    expect(ssh).not.toContain(f.canary);
    expect(ssh).toMatch(/rc=[1-9]/);
    expect(await readFile(join(guest.tmp, 'r-write'), 'utf8')).toMatch(/rc=[1-9]/);
    await expect(readFile(join(f.home, 'pwned'), 'utf8')).rejects.toThrow();
    expect(await readFile(join(guest.tmp, 'r-read'), 'utf8')).toBe('shared readme\n');
    expect(await readFile(join(guest.tmp, 'r-home'), 'utf8')).toBe('rc=0\n');

    const pidsOf = async (): Promise<number> => (await execFileAsync('/bin/ps', ['-A', '-ww', '-o', 'command='])).stdout.split('\n').filter((l) => l.includes(`sleep ${token}`) || (linux && l.includes(`sleep ${escapee}`))).length;
    await waitFor(async () => (await pidsOf()) === (linux ? 2 : 1), 'the background jobs');
    const t0 = Date.now();
    await f.sessions.killAllForUser(RUNNER, 'kicked');
    await waitFor(async () => (await pidsOf()) === 0, 'the sandboxed jobs to be gone', 3_000);
    console.info(`[R2.2/real srt] sandboxed session processes gone ${Date.now() - t0} ms after the kick`);
    await f.sessions.removeGuestDir(RUNNER);
  });

  // Linux: srt starts bubblewrap with --new-session (setsid), which cut the guest's shell off from its own pty: no
  // SIGWINCH on a resize (a TUI never redraws), no job control, and Ctrl-C reached bubblewrap itself and ended the whole
  // session (measured before harden.ts LINUX_SESSION_PRELUDE). macOS (sandbox-exec) never had the problem.
  it('a guest terminal keeps its own terminal inside the sandbox: a resize reaches the program in it (SIGWINCH, the new size), Ctrl-C interrupts the foreground program and not the session', async (ctx) => {
    if (!supported) return ctx.skip('real srt runs on macOS and Linux only');
    if (setupError) throw setupError;
    const f = fixture as Fixture;
    if (isStubService(f.daemon.ctx.services.sandbox)) {
      console.warn('[sessions] SKIPPED: the sandbox module is still a stub');
      return ctx.skip('sandbox module is a stub');
    }
    const session = await f.sessions.create({ kind: 'terminal', workspace: { mode: 'main' }, cols: 120, rows: 40 }, conn, runner());
    expect(session.sandboxed).toBe(true);
    const guest = f.sessions.guestPaths(RUNNER);
    try {
      // The owner's viewer, like the web client's: its viewport drives the PTY size.
      await f.sessions.attach({ sessionId: session.id, cols: 120, rows: 40 }, conn, runner());
      // A foreground program that notes each SIGWINCH with the size its terminal then reports, and a SIGINT.
      const perl = [
        '$d=$ENV{TMPDIR};',
        'sub note { my ($n,$t)=@_; open(my $h, ">>", "$d/$n") or die; print $h $t; close $h }',
        '$SIG{WINCH}=sub { note("t-winch", `/bin/stty size`) };',
        '$SIG{INT}=sub { note("t-int", "int\\n"); exit 0 };',
        'note("t-ready", "ready\\n");',
        'sleep 1 while 1;',
      ].join(' ');
      await type(session.id, `/usr/bin/perl -e '${perl}'\r`);
      await readWhenPresent(join(guest.tmp, 't-ready'));
      f.sessions.resize({ sessionId: session.id, cols: 100, rows: 30 }, conn, runner());
      await waitFor(() => f.sessions.get(session.id)?.cols === 100 && f.sessions.get(session.id)?.rows === 30, 'the PTY resize');
      await waitFor(async () => (await readFile(join(guest.tmp, 't-winch'), 'utf8').catch(() => '')).includes('30 100'), 'SIGWINCH and the new size inside the sandbox', 20_000);
      await type(session.id, '\x03');
      expect(await readWhenPresent(join(guest.tmp, 't-int'))).toBe('int\n');

      // A program that does not catch SIGINT: Ctrl-C ends it, the guest's shell and the session go on.
      const token = `${randomBytes(3).readUIntBE(0, 3) + 80_000_000}`;
      const sleeping = async (): Promise<number> => (await execFileAsync('/bin/ps', ['-A', '-ww', '-o', 'command='])).stdout.split('\n').filter((l) => l.includes(`sleep ${token}`)).length;
      await type(session.id, `/bin/sleep ${token}\r`);
      await waitFor(async () => (await sleeping()) > 0, 'the foreground sleep');
      await type(session.id, '\x03');
      await waitFor(async () => (await sleeping()) === 0, 'Ctrl-C to end the foreground sleep', 10_000);
      await type(session.id, `echo "alive rc=$?" > "$TMPDIR/t-alive"\r`);
      expect(await readWhenPresent(join(guest.tmp, 't-alive'))).toBe('alive rc=130\n');
      expect(f.sessions.get(session.id)?.status).toBe('running');
    } finally {
      f.sessions.detach(session.id, conn.channelId);
      await f.sessions.end({ sessionId: session.id }, runner());
    }
  });

  it('worktree mode (R9.1, the session side): the guest writes its worktree, while the main share is neither readable nor writable', async (ctx) => {
    if (!supported) return ctx.skip('real srt runs on macOS and Linux only');
    if (setupError) throw setupError;
    const f = fixture as Fixture;
    if (isStubService(f.daemon.ctx.services.sandbox)) {
      console.warn('[sessions] SKIPPED: the sandbox module is still a stub');
      return ctx.skip('sandbox module is a stub');
    }
    const session = await f.sessions.create({ kind: 'terminal', workspace: { mode: 'worktree' }, cols: 120, rows: 40 }, conn, runner());
    expect(session.root.kind).toBe('worktree');
    const guest = f.sessions.guestPaths(RUNNER);
    const worktree = f.daemon.ctx.roots.get(session.root)?.realPath as string;
    await type(
      session.id,
      [
        `echo in-worktree > wt-note; echo "rc=$?" > "$TMPDIR/w-own"`,
        `cat '${join(f.share, 'README.md')}' > "$TMPDIR/w-read" 2>&1; echo "rc=$?" >> "$TMPDIR/w-read"`,
        `(echo defaced > '${join(f.share, 'README.md')}') 2>/dev/null; echo "rc=$?" > "$TMPDIR/w-write"`,
        `echo done > "$TMPDIR/w-done"`,
      ].join('\r') + '\r',
    );
    await readWhenPresent(join(guest.tmp, 'w-done'));
    expect(await readFile(join(guest.tmp, 'w-own'), 'utf8')).toBe('rc=0\n');
    expect(await readFile(join(worktree, 'wt-note'), 'utf8')).toBe('in-worktree\n');
    const read = await readFile(join(guest.tmp, 'w-read'), 'utf8');
    expect(read).not.toContain('shared readme');
    expect(read).toMatch(/rc=[1-9]/);
    expect(await readFile(join(guest.tmp, 'w-write'), 'utf8')).toMatch(/rc=[1-9]/);
    expect(await readFile(join(f.share, 'README.md'), 'utf8')).toBe('shared readme\n');
    await f.sessions.end({ sessionId: session.id }, runner());
  });

  it('a guest agent gets the hooks module\'s launch files: read-only inside the sandbox, the daemon\'s hook socket, --strict-mcp-config', async (ctx) => {
    if (!supported) return ctx.skip('real srt runs on macOS and Linux only');
    if (setupError) throw setupError;
    const f = fixture as Fixture;
    if (isStubService(f.daemon.ctx.services.sandbox) || isStubService(f.daemon.ctx.services.hooks)) {
      console.warn('[sessions] SKIPPED: the sandbox or hooks module is still a stub');
      return ctx.skip('sandbox or hooks module is a stub');
    }
    const session = await f.sessions.create({ kind: 'agent', workspace: { mode: 'main' }, cols: 120, rows: 40 }, conn, runner());
    const guest = f.sessions.guestPaths(RUNNER);
    // The stand-in writes its argv line by line: wait for the whole list, not just the first line.
    await waitFor(async () => (await readFile(join(guest.tmp, 'claude-argv'), 'utf8').catch(() => '')).includes('--strict-mcp-config'), 'the whole argv', 20_000);
    const argv = (await readFile(join(guest.tmp, 'claude-argv'), 'utf8')).split('\n').filter(Boolean);
    expect(argv[0]).toBe('--settings');
    expect(argv[2]).toBe('--mcp-config');
    expect(argv[4]).toBe('--strict-mcp-config');
    expect(argv[1]?.startsWith(join(await realpath(join(f.home, '.smurg')), 'sessions'))).toBe(true);
    await readWhenPresent(join(guest.tmp, 'claude-settings-rc'));
    await waitFor(async () => (await readFile(join(guest.tmp, 'claude-settings-rc'), 'utf8')).includes('write='), 'the write attempt');
    const rc = await readFile(join(guest.tmp, 'claude-settings-rc'), 'utf8');
    expect(rc).toContain('read=0');
    expect(rc).toMatch(/write=[1-9]/); // the daemon-owned settings are not writable from inside
    const settings = JSON.parse(await readFile(join(guest.tmp, 'claude-settings'), 'utf8'));
    expect(settings.hooks.PreToolUse[0].matcher).toContain('Edit');
    expect(settings.disableAllHooks).toBe(false);
    await waitFor(async () => (await readFile(join(guest.tmp, 'claude-env'), 'utf8').catch(() => '')).endsWith('\n'), 'the env line', 20_000);
    expect(await readFile(join(guest.tmp, 'claude-env'), 'utf8')).toBe(`socket=${f.daemon.ctx.config.runPaths.hook}\n`);
    const seeded = JSON.parse(await readFile(join(guest.cfg, '.claude.json'), 'utf8'));
    expect(seeded.projects[f.share].hasTrustDialogAccepted).toBe(true);
    await f.sessions.end({ sessionId: session.id }, runner());
    expect(f.sessions.get(session.id)?.status).toBe('exited');
  });
});
