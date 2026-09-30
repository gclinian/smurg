// SPEC R2 / R4 / R5 / R9 with the REAL sessions, sandbox (srt on this machine), hooks and worktree modules composed
// as in production (DEFAULT_FEATURE_MODULES): a runner opens a sandboxed terminal in their own worktree through the
// real handlers; inside it the main workspace is unreadable and unwritable while the worktree works; the hook socket is
// the one socket reachable from inside (the host's control socket is not); a kick ends the session, its processes and
// the guest directory. Nothing is signalled by this test: it only reads the process table.
import { execFile } from 'node:child_process';
import { lstat, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { isStubService } from '../../src/core/stubs.ts';
import type { SessionManagerImpl } from '../../src/sessions/session-manager.ts';
import { createTestDaemon, waitFor, type TestDaemon } from '../../src/testing/index.ts';

const execFileAsync = promisify(execFile);
const supported = process.platform === 'darwin' || process.platform === 'linux';

let t: TestDaemon | null = null;
const savedShell = process.env['SHELL'];

beforeAll(() => {
  // The sessions module reads the host's environment at session start: a plain POSIX shell for the guest terminal,
  // so the commands below behave the same whatever the developer's login shell is.
  process.env['SHELL'] = '/bin/sh';
});

afterAll(() => {
  if (savedShell === undefined) delete process.env['SHELL'];
  else process.env['SHELL'] = savedShell;
});

afterEach(async () => {
  await t?.cleanup();
  t = null;
});

async function exists(path: string): Promise<boolean> {
  return (await lstat(path).catch(() => null)) !== null;
}

/** Processes whose command line contains `marker` (read-only `ps`; nothing is signalled). */
async function processesRunning(marker: string): Promise<number> {
  const { stdout } = await execFileAsync('/bin/ps', ['-A', '-ww', '-o', 'command=']);
  return stdout.split('\n').filter((line) => line.includes(marker)).length;
}

describe('sessions + sandbox + hooks + worktree (real modules, real srt)', { timeout: 180_000 }, () => {
  it('a runner\'s sandboxed terminal in their worktree cannot read or write the main workspace; a kick ends it, its processes and the guest dir', async (ctx) => {
    if (!supported) return ctx.skip('real srt runs on macOS and Linux only');
    t = await createTestDaemon({
      project: { git: true, files: { 'README.md': 'main readme\n', 'src/app.ts': 'export const a = 1;\n', 'secret.txt': 'MAIN-ONLY-SECRET\n' } },
      settings: { allowedDomains: [] },
    });
    const d = t;
    if (isStubService(d.ctx.services.sandbox) || isStubService(d.ctx.services.sessions) || isStubService(d.ctx.services.worktrees)) {
      throw new Error('DEFAULT_FEATURE_MODULES must provide sessions, sandbox and worktrees');
    }
    const host = await d.connectHost();
    const carol = await d.connect({ userId: 'dev:carol', displayName: 'Carol', role: 'runner' });
    const share = d.ctx.roots.main.realPath;

    // Through the real handler: the role decides the sandbox (a runner cannot ask for an unsandboxed one).
    const { session } = await carol.conn.request('session.create', { kind: 'terminal', workspace: { mode: 'worktree' }, cols: 100, rows: 30 });
    expect(session).toMatchObject({ kind: 'terminal', sandboxed: true, ownerUserId: 'dev:carol', root: { kind: 'worktree' }, status: 'running' });
    if (session.root.kind !== 'worktree') throw new Error('not a worktree session');
    const worktree = d.ctx.roots.get(session.root)?.realPath as string;
    expect(worktree.startsWith(join(share, '.smurg', 'worktrees'))).toBe(true);
    const { worktrees } = await host.conn.request('worktree.list', {});
    expect(worktrees.find((w) => w.id === (session.root as { worktreeId: string }).worktreeId)).toMatchObject({ ownerUserId: 'dev:carol', sessionId: session.id });

    // One command at a time (a PTY's line buffer is small); each writes its result into the worktree.
    let step = 0;
    const run = async (command: string): Promise<{ output: string; rc: number }> => {
      const file = join(worktree, `.step-${++step}.txt`);
      carol.conn.notify('exec.input', { sessionId: session.id, data: new TextEncoder().encode(`{ ${command} ; } > '${file}' 2>&1; echo "rc=$?" >> '${file}'\r`) });
      let text = '';
      await waitFor(async () => /rc=\d+\n$/.test((text = await readFile(file, 'utf8').catch(() => ''))), { timeoutMs: 30_000, what: `the result of: ${command}` });
      const rc = Number(/rc=(\d+)\n$/.exec(text)?.[1]);
      return { output: text.replace(/rc=\d+\n$/, ''), rc };
    };

    // Positive controls: the worktree is the session's root, readable and writable.
    expect(await run('cat README.md')).toEqual({ output: 'main readme\n', rc: 0 });
    expect((await run('echo from-the-worktree > notes.txt && cat notes.txt')).output).toBe('from-the-worktree\n');
    // R9.1: the main workspace is neither readable nor writable, however it is reached.
    const secret = await run(`cat '${join(share, 'secret.txt')}'`);
    expect(secret.rc).not.toBe(0);
    expect(secret.output).not.toContain('MAIN-ONLY-SECRET');
    // The OS refused it (Seatbelt: EPERM; bubblewrap: the path is not mounted), not a typo in the path.
    expect(secret.output).toMatch(/Operation not permitted|Permission denied|No such file/);
    expect((await run(`ls '${share}'`)).rc).not.toBe(0);
    expect((await run(`echo pwned > '${join(share, 'pwned.txt')}'`)).rc).not.toBe(0);
    expect(await exists(join(share, 'pwned.txt'))).toBe(false);
    const viaAlternates = await run(`cat '${join(share, '.git', 'config')}'`);
    expect(viaAlternates.rc).not.toBe(0);
    // The hook socket (hooks module) is the one Unix socket the sandbox lets through; the host's control socket is not.
    const hook = await run(`printf '{}\\n' | /usr/bin/nc -U '${d.ctx.config.runPaths.hook}'`);
    expect(hook.output).toContain('"error"');
    const control = await run(`printf 'x' | /usr/bin/nc -U '${d.ctx.config.runPaths.ctl}'; echo "nc=$?"`);
    expect(control.output).toMatch(/nc=[1-9]/);
    expect(control.output).not.toContain('"ok"');

    // A background job with a unique command line: it must go with the session (R2: 「session 程序被終止」).
    const marker = `sleep ${700_000 + Math.floor(Math.random() * 99_999)}`;
    carol.conn.notify('exec.input', { sessionId: session.id, data: new TextEncoder().encode(`${marker} &\r`) });
    await waitFor(async () => (await processesRunning(marker)) > 0, { timeoutMs: 15_000, what: 'the background job' });

    const sessions = d.ctx.services.sessions as SessionManagerImpl;
    const guest = sessions.guestPaths('dev:carol');
    expect(await exists(guest.root)).toBe(true);

    // The host kicks Carol from the console (one request): within 3 s her session, its processes and her guest dir
    // (her Claude login would be in it) are gone; the worktree is kept for the host to review (C17).
    const t0 = Date.now();
    await host.conn.request('admin.member.kick', { userId: 'dev:carol' });
    await waitFor(() => sessions.get(session.id)?.status === 'exited', { timeoutMs: 3_000, what: 'the session to exit' });
    await waitFor(async () => (await processesRunning(marker)) === 0, { timeoutMs: Math.max(100, 3_000 - (Date.now() - t0)), what: 'the background job to be gone' });
    await waitFor(async () => !(await exists(guest.root)), { timeoutMs: Math.max(100, 3_000 - (Date.now() - t0)), what: 'the guest dir to be removed' });
    console.info(`[integration] kick → session, processes and guest dir gone after ${Date.now() - t0} ms`);
    expect(await exists(worktree)).toBe(true);
    const audit = await host.conn.request('admin.audit.query', { limit: 200 });
    expect(audit.entries.some((e) => e.action === 'session.create' && e.target === session.id)).toBe(true);
    expect(audit.entries.some((e) => e.action === 'member.kick' && e.target === 'dev:carol')).toBe(true);
  });
});
