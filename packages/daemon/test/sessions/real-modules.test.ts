// The sessions module with the REAL hooks module (ARCHITECTURE §11 D-15): a session a Agent access member opens runs
// exactly like the host's own — the host's OS user, unsandboxed, the host's environment and HOME — and ends with
// everything it started when that member is removed. Everything lives in one temp dir with a FAKE host home
// (config.sessions.hostHome, holding a canary file); the developer's real home is never involved. The daemon runs
// without a relay; the SessionManager is driven directly (its handlers are covered by the other files).
import { randomBytes } from 'node:crypto';
import { execFile } from 'node:child_process';
import { chmod, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { userInfo } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FeatureModule } from '../../src/core/context.ts';
import type { AuditEntry } from '@smurg/protocol';
import type { ActivityFeed, ClientConnection, LockManager, PresenceService, Principal, WorktreeManager } from '../../src/core/interfaces.ts';
import { toDisposable } from '../../src/core/lifecycle.ts';
import { createLineLogger } from '../../src/core/logger.ts';
import { isStubService } from '../../src/core/stubs.ts';
import { createDaemon, type Daemon } from '../../src/daemon.ts';
import { hooksModule } from '../../src/hooks/module.ts';
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
  /** Where the stand-in claude and the terminal commands leave their evidence. */
  evidence: string;
  canary: string;
  base: string;
  runDir: string;
  warnings: string[];
  audit: AuditEntry[];
}

let fixture: Fixture | null = null;
let setupError: unknown = null;
const CAROL = 'dev:carol';
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
  const base = await createTempDir('sessions-real');
  const home = join(base, 'home');
  const share = join(home, 'projects', 'app');
  const stateDir = join(home, '.smurg');
  const evidence = join(base, 'evidence');
  const canary = `SMURG-CANARY-${randomBytes(6).toString('hex')}`;
  await mkdir(join(home, '.ssh'), { recursive: true });
  await writeFile(join(home, '.ssh', 'id_ed25519'), `${canary}\n`);
  await mkdir(share, { recursive: true });
  await mkdir(evidence, { recursive: true });
  await writeFile(join(share, 'README.md'), 'shared readme\n');
  // A stand-in `claude` that leaves its evidence in $EVIDENCE (the host environment the session gets).
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
{ for a in "$@"; do printf '%s\\n' "$a"; done; } > "$EVIDENCE/claude-argv.tmp" && mv "$EVIDENCE/claude-argv.tmp" "$EVIDENCE/claude-argv"
cat "$2" > "$EVIDENCE/claude-settings.tmp" 2>/dev/null && mv "$EVIDENCE/claude-settings.tmp" "$EVIDENCE/claude-settings"
printf 'socket=%s home=%s cwd=%s\\n' "$SMURG_HOOK_SOCKET" "$HOME" "$(pwd -P)" > "$EVIDENCE/claude-env.tmp" && mv "$EVIDENCE/claude-env.tmp" "$EVIDENCE/claude-env"
exec cat
`,
  );
  await chmod(claude, 0o755);
  const warnings: string[] = [];
  const workspaceId = `ws_test_${randomBytes(9).toString('base64url')}`;
  const hostEnv = { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', HOME: home, USER: process.env['USER'] ?? 'host', LANG: 'en_US.UTF-8', SHELL: '/bin/sh', EVIDENCE: evidence };
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
      // The real `smurg hook` (node + the CLI's sources) is what the session settings name.
      sessions: { hostHome: home, claudePath: claude, selfCommand: { file: process.execPath, args: [CLI_MAIN] } },
    },
    modules: [fakeServices(), hooksModule, createSessionsModule({ hostEnv: () => hostEnv, hostShell: '/bin/sh' })],
    homeDir: home,
    log: createLineLogger({ level: 'warn', write: (line) => warnings.push(line) }),
  });
  await daemon.start();
  const audit: AuditEntry[] = [];
  daemon.ctx.audit.subscribe((entry) => audit.push(entry));
  daemon.ctx.members.admitMember({ userId: CAROL, displayName: 'carol', role: 'agent', at: Date.now() });
  return {
    daemon,
    sessions: daemon.ctx.services.sessions as SessionManagerImpl,
    home: await realpath(home),
    share: await realpath(share),
    evidence: await realpath(evidence),
    canary,
    base,
    runDir,
    warnings,
    audit,
  };
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
  await removeTempRunDir(fixture.runDir);
}, 60_000);

function carol(): Principal {
  return (fixture as Fixture).daemon.ctx.members.principalOf(CAROL) as Principal;
}

async function type(sessionId: string, text: string, as: Principal = carol()): Promise<void> {
  (fixture as Fixture).sessions.input({ sessionId, data: new TextEncoder().encode(text) }, conn, as);
}

async function readWhenPresent(path: string, timeoutMs = 20_000): Promise<string> {
  let text = '';
  await waitFor(async () => {
    text = await readFile(path, 'utf8').catch(() => '');
    return text.length > 0;
  }, path, timeoutMs);
  return text;
}

function fixtureOrSkip(ctx: { skip: (note: string) => void }): Fixture {
  if (setupError) throw setupError;
  const f = fixture as Fixture;
  if (isStubService(f.daemon.ctx.services.hooks)) ctx.skip('hooks module is a stub');
  return f;
}

describe('sessions of a Agent access member with the real hooks module (§11 D-15)', { timeout: 90_000 }, () => {
  it('a terminal it opens runs as the host (the host user, HOME, no sandbox); removing the member ends it and everything it started within 3 s, audited', async (ctx) => {
    if (!supported) return ctx.skip('PTY sessions run on macOS and Linux only');
    const f = fixtureOrSkip(ctx);
    const session = await f.sessions.create({ kind: 'terminal', workspace: { mode: 'main' }, cols: 120, rows: 40 }, conn, carol());
    expect(session).toMatchObject({ kind: 'terminal', ownerUserId: CAROL, ownerName: 'carol', root: { kind: 'main' } });
    // No default title on the wire: each client builds it from kind + ownerName in the viewer's language.
    expect(session.title).toBeUndefined();
    expect(Object.keys(session)).not.toContain('sandboxed');
    const token = `${randomBytes(3).readUIntBE(0, 3) + 70_000_000}`;
    const out = (name: string): string => join(f.evidence, name);
    await type(
      session.id,
      [
        `/usr/bin/id -un > '${out('r-user')}'`,
        `printf '%s\\n' "$HOME" > '${out('r-home')}'`,
        `pwd -P > '${out('r-cwd')}'`,
        // Nothing confines it: it reads the host's home like the host's own session would (the reason the role is
        // for people the host trusts completely).
        `cat '${join(f.home, '.ssh', 'id_ed25519')}' > '${out('r-ssh')}' 2>&1`,
        `sleep ${token} &`,
        `echo done > '${out('r-done')}'`,
      ].join('\r') + '\r',
    );
    await readWhenPresent(out('r-done'));
    expect((await readFile(out('r-user'), 'utf8')).trim()).toBe(userInfo().username);
    expect((await readFile(out('r-home'), 'utf8')).trim()).toBe(f.home);
    expect((await readFile(out('r-cwd'), 'utf8')).trim()).toBe(f.share);
    expect(await readFile(out('r-ssh'), 'utf8')).toBe(`${f.canary}\n`);

    // The host types into Carol's session too (session.drive).
    await type(session.id, `echo from-the-host > '${out('r-host')}'\r`, f.daemon.ctx.members.principalOf('dev:host') as Principal);
    expect(await readWhenPresent(out('r-host'))).toBe('from-the-host\n');

    const pidsOf = async (): Promise<number> => (await execFileAsync('/bin/ps', ['-A', '-ww', '-o', 'command='])).stdout.split('\n').filter((l) => l.includes(`sleep ${token}`)).length;
    await waitFor(async () => (await pidsOf()) === 1, 'the background job');
    const t0 = Date.now();
    await f.sessions.killAllForUser(CAROL, 'kicked');
    await waitFor(async () => (await pidsOf()) === 0, 'the session processes to be gone', 3_000);
    console.info(`[R2.2] the processes of a session the removed member opened were gone ${Date.now() - t0} ms after the kick`);
    expect(f.sessions.get(session.id)).toMatchObject({ status: 'exited', endReason: 'kicked' });
    expect(f.audit.filter((e) => e.action === 'session.terminate' && e.target === session.id)).toEqual([
      expect.objectContaining({ actor: { kind: 'system' }, outcome: 'ok', detail: expect.objectContaining({ ownerUserId: CAROL, kind: 'terminal', reason: 'kicked' }) }),
    ]);
  });

  it('a member\'s terminal keeps its own terminal: a resize from its owner reaches the program (SIGWINCH, the new size), Ctrl-C interrupts the foreground program and not the session', async (ctx) => {
    if (!supported) return ctx.skip('PTY sessions run on macOS and Linux only');
    const f = fixtureOrSkip(ctx);
    const session = await f.sessions.create({ kind: 'terminal', workspace: { mode: 'main' }, cols: 120, rows: 40 }, conn, carol());
    const out = (name: string): string => join(f.evidence, `${session.id}-${name}`);
    try {
      // The owner's viewer, like the web client's: its viewport drives the PTY size.
      await f.sessions.attach({ sessionId: session.id, cols: 120, rows: 40 }, conn, carol());
      // A foreground program that notes each SIGWINCH with the size its terminal then reports, and a SIGINT.
      const perl = [
        `$d="${f.evidence}/${session.id}";`,
        'sub note { my ($n,$t)=@_; open(my $h, ">>", "$d-$n") or die; print $h $t; close $h }',
        '$SIG{WINCH}=sub { note("t-winch", `/bin/stty size`) };',
        '$SIG{INT}=sub { note("t-int", "int\\n"); exit 0 };',
        'note("t-ready", "ready\\n");',
        'sleep 1 while 1;',
      ].join(' ');
      await type(session.id, `/usr/bin/perl -e '${perl}'\r`);
      await readWhenPresent(out('t-ready'));
      f.sessions.resize({ sessionId: session.id, cols: 100, rows: 30 }, conn, carol());
      await waitFor(() => f.sessions.get(session.id)?.cols === 100 && f.sessions.get(session.id)?.rows === 30, 'the PTY resize');
      await waitFor(async () => (await readFile(out('t-winch'), 'utf8').catch(() => '')).includes('30 100'), 'SIGWINCH and the new size', 20_000);
      await type(session.id, '\x03');
      expect(await readWhenPresent(out('t-int'))).toBe('int\n');

      // A program that does not catch SIGINT: Ctrl-C ends it, the shell and the session go on.
      const token = `${randomBytes(3).readUIntBE(0, 3) + 80_000_000}`;
      const sleeping = async (): Promise<number> => (await execFileAsync('/bin/ps', ['-A', '-ww', '-o', 'command='])).stdout.split('\n').filter((l) => l.includes(`sleep ${token}`)).length;
      await type(session.id, `/bin/sleep ${token}\r`);
      await waitFor(async () => (await sleeping()) > 0, 'the foreground sleep');
      await type(session.id, '\x03');
      await waitFor(async () => (await sleeping()) === 0, 'Ctrl-C to end the foreground sleep', 10_000);
      await type(session.id, `echo "alive rc=$?" > '${out('t-alive')}'\r`);
      expect(await readWhenPresent(out('t-alive'))).toBe('alive rc=130\n');
      expect(f.sessions.get(session.id)?.status).toBe('running');
    } finally {
      f.sessions.detach(session.id, conn.channelId);
      await f.sessions.end({ sessionId: session.id }, carol());
    }
  });

  it('worktree mode (R9, the session side): the session works in its worktree', async (ctx) => {
    if (!supported) return ctx.skip('PTY sessions run on macOS and Linux only');
    const f = fixtureOrSkip(ctx);
    const session = await f.sessions.create({ kind: 'terminal', workspace: { mode: 'worktree' }, cols: 120, rows: 40 }, conn, carol());
    expect(session.root.kind).toBe('worktree');
    const worktree = f.daemon.ctx.roots.get(session.root)?.realPath as string;
    const done = join(f.evidence, `${session.id}-w-done`);
    await type(session.id, [`echo in-worktree > wt-note`, `pwd -P > '${done}'`].join('\r') + '\r');
    expect((await readWhenPresent(done)).trim()).toBe(worktree);
    expect(await readFile(join(worktree, 'wt-note'), 'utf8')).toBe('in-worktree\n');
    await f.sessions.end({ sessionId: session.id }, carol());
  });

  it('an agent a member opens gets the hooks module\'s launch files, the daemon\'s hook socket and the host\'s HOME, like the host\'s own agent', async (ctx) => {
    if (!supported) return ctx.skip('PTY sessions run on macOS and Linux only');
    const f = fixtureOrSkip(ctx);
    const session = await f.sessions.create({ kind: 'agent', workspace: { mode: 'main' }, cols: 120, rows: 40 }, conn, carol());
    expect(session).toMatchObject({ kind: 'agent', ownerUserId: CAROL, ownerName: 'carol' });
    const argv = (await readWhenPresent(join(f.evidence, 'claude-argv'))).split('\n').filter(Boolean);
    // The host's flags: no --strict-mcp-config (the guest variant is gone), never a permission flag.
    expect(argv).toHaveLength(4);
    expect(argv[0]).toBe('--settings');
    expect(argv[2]).toBe('--mcp-config');
    expect(argv[1]?.startsWith(join(await realpath(join(f.home, '.smurg')), 'sessions'))).toBe(true);
    const settings = JSON.parse(await readWhenPresent(join(f.evidence, 'claude-settings')));
    expect(settings.hooks.PreToolUse[0].matcher).toContain('Edit');
    expect(settings.disableAllHooks).toBe(false);
    expect(settings.permissions.defaultMode).toBe('default');
    expect(settings).not.toHaveProperty('claudeMdExcludes');
    expect(await readWhenPresent(join(f.evidence, 'claude-env'))).toBe(`socket=${f.daemon.ctx.config.runPaths.hook} home=${f.home} cwd=${f.share}\n`);
    await f.sessions.end({ sessionId: session.id }, carol());
    expect(f.sessions.get(session.id)?.status).toBe('exited');
  });
});
