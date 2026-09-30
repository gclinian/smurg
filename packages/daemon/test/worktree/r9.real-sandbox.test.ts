// R9 end to end with the REAL modules: the worktree module creates the shared clone and its read-only link, the
// sessions module starts a guest terminal in it, and the sandbox module confines it with real srt on this machine.
// Layout like test/sessions/real-modules.test.ts: everything lives in one temp dir with a FAKE host home; the daemon
// runs without a relay and the services are driven directly (the handlers are covered by the other files).
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chmod, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ClientConnection, Principal } from '../../src/core/interfaces.ts';
import { createLineLogger } from '../../src/core/logger.ts';
import { isStubService } from '../../src/core/stubs.ts';
import { createDaemon, type Daemon } from '../../src/daemon.ts';
import { hooksModule } from '../../src/hooks/module.ts';
import { sandboxModule } from '../../src/sandbox/module.ts';
import { createSessionsModule } from '../../src/sessions/module.ts';
import type { SessionManagerImpl } from '../../src/sessions/session-manager.ts';
import { createTempDir, createTempRunDir, isolatedGitEnv, removeTempDir, removeTempRunDir } from '../../src/testing/index.ts';
import { createWorktreeModule } from '../../src/worktree/module.ts';
import type { WorktreeManagerImpl } from '../../src/worktree/worktree-manager.ts';

const execFileAsync = promisify(execFile);
const supported = process.platform === 'darwin' || process.platform === 'linux';
const RUNNER = 'dev:carol';
const HOST = 'dev:host';
const conn = { channelId: 'ch_r9_real', id: 'conn_r9_real' } as unknown as ClientConnection;

interface Fixture {
  daemon: Daemon;
  sessions: SessionManagerImpl;
  worktrees: WorktreeManagerImpl;
  share: string;
  base: string;
  runDir: string;
  gitEnv: NodeJS.ProcessEnv;
  restoreTmp: () => void;
}

let fixture: Fixture | null = null;
let setupError: unknown = null;

async function setup(): Promise<Fixture> {
  const runDir = await createTempRunDir();
  // srt's proxy socket lives in os.tmpdir(): keep it short while the daemon lives (as the sessions and sandbox tests do).
  const previousTmp = process.env['TMPDIR'];
  if (tmpdir().length > 40) process.env['TMPDIR'] = runDir;
  const restoreTmp = (): void => {
    if (previousTmp === undefined) delete process.env['TMPDIR'];
    else process.env['TMPDIR'] = previousTmp;
  };
  const base = await createTempDir('r9-real');
  const home = join(base, 'home');
  const share = join(home, 'projects', 'app');
  await mkdir(join(share, 'src'), { recursive: true });
  await writeFile(join(share, 'README.md'), 'main readme\n');
  await writeFile(join(share, 'src', 'app.ts'), 'export const answer = 42;\n');
  await writeFile(join(share, '.gitignore'), '/data/\n');
  const gitEnv = isolatedGitEnv(join(base, 'git-home'));
  await mkdir(join(base, 'git-home'), { recursive: true });
  await execFileAsync('git', ['init', '-q', '-b', 'main'], { cwd: share, env: gitEnv });
  await execFileAsync('git', ['add', '-A'], { cwd: share, env: gitEnv });
  await execFileAsync('git', ['commit', '-q', '-m', 'initial'], { cwd: share, env: gitEnv });
  // D12: a dataset that is not in git, shared read-only into every worktree.
  await mkdir(join(share, 'data'));
  await writeFile(join(share, 'data', 'train.csv'), 'a,b\n1,2\n');
  const bin = join(base, 'bin');
  await mkdir(bin, { recursive: true });
  const claude = join(bin, 'claude');
  await writeFile(claude, '#!/bin/sh\necho "2.1.283 (Claude Code)"\n');
  await chmod(claude, 0o755);
  const hostEnv = { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', HOME: home, USER: process.env['USER'] ?? 'host', LANG: 'en_US.UTF-8', SHELL: '/bin/sh' };
  const daemon = await createDaemon({
    config: {
      stateDir: join(home, '.smurg'),
      runDir,
      shareDir: share,
      workspaceId: `ws_test_${randomBytes(9).toString('base64url')}`,
      hostUserId: HOST,
      hostName: 'Host',
      relayUrl: null,
      keepAwake: false,
      defaultSettings: { allowedDomains: [], sharedDirs: ['data'] },
      sessions: { hostHome: home, claudePath: claude, selfCommand: { file: '/usr/bin/true', args: [] } },
    },
    modules: [sandboxModule, hooksModule, createWorktreeModule(), createSessionsModule({ hostEnv: () => hostEnv, hostShell: '/bin/sh', guestShell: '/bin/sh', keychain: async () => {} })],
    homeDir: home,
    log: createLineLogger({ level: 'error', write: () => {} }),
  });
  await daemon.start();
  daemon.ctx.members.admitMember({ userId: RUNNER, displayName: 'carol', role: 'runner', at: Date.now() });
  return {
    daemon,
    sessions: daemon.ctx.services.sessions as SessionManagerImpl,
    worktrees: daemon.ctx.services.worktrees as WorktreeManagerImpl,
    share: await realpath(share),
    base,
    runDir,
    gitEnv,
    restoreTmp,
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
  fixture.restoreTmp();
  await removeTempRunDir(fixture.runDir);
}, 60_000);

const principal = (userId: string): Principal => (fixture as Fixture).daemon.ctx.members.principalOf(userId) as Principal;

/** Waits until the step's result file carries its exit status line. */
async function readWhenDone(path: string, timeoutMs = 30_000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const text = await readFile(path, 'utf8').catch(() => '');
    if (/rc=\d+\n$/.test(text)) return text;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${path}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

describe('R9 with the real worktree, sessions and sandbox modules (real srt)', { timeout: 120_000 }, () => {
  it('R9.1 worktree 裡的 agent 無法讀寫主工作區或其他 worktree; R9.2 可以讀取共享資料夾，但無法寫入 — and its work reaches the main workspace only through the host\'s merge', async (ctx) => {
    if (!supported) return ctx.skip('real srt runs on macOS and Linux only');
    if (setupError) throw setupError;
    const f = fixture as Fixture;
    if (isStubService(f.daemon.ctx.services.sandbox)) return ctx.skip('sandbox module is a stub');

    // A sibling worktree of the same member, kept from an earlier session.
    const sibling = await f.worktrees.acquireForSession({ owner: principal(RUNNER), sessionId: 'ses_earlier' });
    await f.worktrees.releaseFromSession(sibling.worktree.id, 'ses_earlier', { keep: true });
    const siblingDir = sibling.root.realPath;

    const session = await f.sessions.create({ kind: 'terminal', workspace: { mode: 'worktree' }, cols: 160, rows: 40 }, conn, principal(RUNNER));
    expect(session.sandboxed).toBe(true);
    expect(session.root.kind).toBe('worktree');
    const worktreeId = session.root.kind === 'worktree' ? session.root.worktreeId : '';
    const worktree = f.daemon.ctx.roots.get(session.root)?.realPath as string;
    expect(worktree).toBe(join(f.share, '.smurg', 'worktrees', worktreeId));
    expect(f.worktrees.get(worktreeId)?.sharedDirs).toEqual(['data']);
    const guest = f.sessions.guestPaths(RUNNER);
    // One command at a time: a terminal's line buffer is limited (MAX_CANON), and these lines carry long paths.
    const steps: [string, string][] = [
      ['own', `echo in-worktree > wt-note; echo "rc=$?" > "$TMPDIR/own"`],
      ['main-read', `cat '${join(f.share, 'README.md')}' > "$TMPDIR/main-read" 2>&1; echo "rc=$?" >> "$TMPDIR/main-read"`],
      ['main-write', `(echo defaced > '${join(f.share, 'README.md')}') 2>/dev/null; echo "rc=$?" > "$TMPDIR/main-write"`],
      ['main-create', `(echo planted > '${join(f.share, 'planted.txt')}') 2>/dev/null; echo "rc=$?" > "$TMPDIR/main-create"`],
      ['sib-read', `cat '${join(siblingDir, 'README.md')}' > "$TMPDIR/sib-read" 2>&1; echo "rc=$?" >> "$TMPDIR/sib-read"`],
      ['sib-write', `(echo pwned > '${join(siblingDir, 'pwned.txt')}') 2>/dev/null; echo "rc=$?" > "$TMPDIR/sib-write"`],
      ['data-read', `cat data/train.csv > "$TMPDIR/data-read" 2>&1; echo "rc=$?" >> "$TMPDIR/data-read"`],
      ['data-append', `(echo 3,4 >> data/train.csv) 2>/dev/null; echo "rc=$?" > "$TMPDIR/data-append"`],
      ['data-create', `(echo x > data/new.csv) 2>/dev/null; echo "rc=$?" > "$TMPDIR/data-create"`],
      ['data-unlink', `(rm -f data) 2>/dev/null; echo "rc=$?" > "$TMPDIR/data-unlink"`],
    ];
    for (const [name, line] of steps) {
      f.sessions.input({ sessionId: session.id, data: new TextEncoder().encode(`${line}\r`) }, conn, principal(RUNNER));
      await readWhenDone(join(guest.tmp, name));
    }
    const result = async (name: string): Promise<string> => readFile(join(guest.tmp, name), 'utf8');

    // Its own worktree: read + write.
    expect(await result('own')).toBe('rc=0\n');
    expect(await readFile(join(worktree, 'wt-note'), 'utf8')).toBe('in-worktree\n');
    // R9.1: the main workspace and the sibling worktree: neither readable nor writable.
    expect(await result('main-read')).not.toContain('main readme');
    expect(await result('main-read')).toMatch(/rc=[1-9]/);
    expect(await result('main-write')).toMatch(/rc=[1-9]/);
    expect(await result('main-create')).toMatch(/rc=[1-9]/);
    expect(await readFile(join(f.share, 'README.md'), 'utf8')).toBe('main readme\n');
    expect(await readFile(join(f.share, 'planted.txt'), 'utf8').catch(() => null)).toBeNull();
    expect(await result('sib-read')).not.toContain('main readme');
    expect(await result('sib-read')).toMatch(/rc=[1-9]/);
    expect(await result('sib-write')).toMatch(/rc=[1-9]/);
    expect(await readFile(join(siblingDir, 'pwned.txt'), 'utf8').catch(() => null)).toBeNull();
    // R9.2: the shared directory through its read-only link: readable, never writable, the link itself stays (macOS).
    // Linux: bubblewrap can only mount on what a symlink points at, never on the link, so the guest may remove the
    // link from its OWN worktree; what it points at stays read-only, and the daemon's path guard refuses a re-pointed
    // shared link (r5.sandbox.test.ts R9.2; ARCHITECTURE §12).
    expect(await result('data-read')).toBe('a,b\n1,2\nrc=0\n');
    expect(await result('data-append')).toMatch(/rc=[1-9]/);
    expect(await result('data-create')).toMatch(/rc=[1-9]/);
    expect(await result('data-unlink')).toMatch(process.platform === 'darwin' ? /rc=[1-9]/ : /rc=0/);
    expect(await readFile(join(f.share, 'data', 'train.csv'), 'utf8')).toBe('a,b\n1,2\n');
    expect(await readFile(join(f.share, 'data', 'new.csv'), 'utf8').catch(() => null)).toBeNull();

    // The work leaves the worktree only through the merge flow: the owner requests, the host approves.
    await f.sessions.end({ sessionId: session.id, keepWorktree: true }, principal(RUNNER));
    const request = await f.worktrees.requestMerge({ worktreeId, message: 'note from the sandbox' }, principal(RUNNER));
    const review = await f.worktrees.diff({ requestId: request.id }, principal(HOST));
    expect(review.files.map((file) => file.path)).toEqual(['wt-note']);
    const merged = await f.worktrees.approve({ requestId: request.id }, principal(HOST));
    expect(merged.status).toBe('merged');
    expect(await readFile(join(f.share, 'wt-note'), 'utf8')).toBe('in-worktree\n');
    const { stdout } = await execFileAsync('git', ['status', '--porcelain', '--untracked-files=all'], { cwd: f.share, env: f.gitEnv });
    expect(stdout.trim()).toBe('');
  });
});
