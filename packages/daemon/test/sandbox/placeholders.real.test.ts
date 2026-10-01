// Linux, real srt 0.0.77 + bubblewrap (r5 family): what bubblewrap's mount points do to the HOST's project while guest
// processes come and go, and where the daemon runs from.
//
//  * review RCR-1: srt decides the form of the mount point for an absent write-denied name on each wrap, from whether it
//    exists at that moment, and removes its mount points when its count of running wraps reaches zero. A guest process
//    that ended while another guest's wrap() was in flight turned `.claude` / `.git` / `.vscode` / `.idea` into empty
//    0444 FILES in the host's project for the whole next session (host: `mkdir -p .claude/x` "Not a directory", git
//    "invalid gitfile format"), and a start in one root while a guest ran in another aborted in bubblewrap ("Can't
//    create file at …/.claude/.smurg-no-such-entry: Read-only file system"). The service now makes those names exist
//    as empty directories of its own for as long as anything of it runs or is being wrapped (holdPlaceholderDirs).
//  * review linux-binary F1: srt resolves its mandatory write denies against the daemon's working directory. From
//    inside the share, bubblewrap added eight empty 0444 dotfiles (`.bashrc`, `.gitconfig`, …) to the host's project,
//    and a project with its own `.claude/` refused every guest session after the first ("Can't create file at
//    <share>/.claude/commands"). `smurg host` runs from `<stateDir>/cwd`; a daemon inside a write root is refused.
//  * reviews RV-1 / RV-2 (diff-review E1–E7): bubblewrap's protection of a host-only or host-private entry is a mount
//    on the entry as it was when the guest process started. The HOST replacing, removing or renaming it while the
//    guest runs (an atomic save, `git switch`, `git clean`) detaches the mount: the guest read the new `.envrc` /
//    `.claude/settings.local.json` and planted `.claude/settings.json` / rewrote `.mcp.json`; a read-denied file the
//    host created after the start was readable at once. The service now notices such a change (file watcher, a poll for
//    `.git`, the next wrap) and revokes every process of that root (SandboxService.onRevoked; the sessions module ends
//    them), and RV-3: the host's own directory made in place of a service placeholder is no longer taken for it.
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { appendFile, lstat, mkdir, readFile, readdir, realpath, rename, rm, rmdir, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { SmurgError } from '@smurg/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import type { DaemonEvents, SandboxRevocation, SandboxSpec, WrappedCommand } from '../../src/core/interfaces.ts';
import { filesInstanceOf, filesModule } from '../../src/files/module.ts';
import { createSandboxModule } from '../../src/sandbox/module.ts';
import { buildSandboxSpec } from '../../src/sessions/sandbox-spec.ts';
import { waitFor } from '../../src/testing/index.ts';
import { createSandboxFixture, guestEnv, isLinux, printWarningsOnFailure, startWrapped, type GuestDirs, type RunningProcess, type SandboxFixture } from './helpers.ts';

const TIMEOUT = 240_000;
const DIR_NAMES = ['.claude', '.git', '.vscode', '.idea'];
/** What srt denies relative to the daemon's working directory (sandbox-utils.js DANGEROUS_FILES, minus `.mcp.json`). */
const CWD_DOTFILES = ['.bash_profile', '.bashrc', '.gitconfig', '.gitmodules', '.profile', '.ripgreprc', '.zprofile', '.zshrc'];

let f: SandboxFixture | undefined;
const startDir = process.cwd();
afterEach(async (context) => {
  process.chdir(startDir);
  printWarningsOnFailure(f, context);
  await f?.cleanup();
  f = undefined;
});

/** `name=dir|file444|absent|…` for each name, as the HOST sees its project. */
async function forms(root: string, names: readonly string[] = DIR_NAMES): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const name of names) {
    const st = await lstat(join(root, name)).catch(() => null);
    out[name] = st === null ? 'absent' : st.isDirectory() ? 'dir' : st.isFile() ? `file${(st.mode & 0o777).toString(8)}` : 'other';
  }
  return out;
}

async function up(p: RunningProcess, marker: RegExp): Promise<string> {
  const ok = await p.waitForOutput(marker, 30_000).then(
    () => true,
    () => false,
  );
  return ok ? 'UP' : `NOT UP: ${p.output().replace(/\s+/g, ' ').slice(0, 200)}`;
}

function terminal(fx: SandboxFixture, guest: GuestDirs, id: string, marker: string, root?: string): Promise<SandboxSpec> {
  return fx.settingsDir(id, '{}\n').then((settingsDir) => fx.spec({ sessionId: id, command: `echo ${marker}; exec sleep 120`, guest, settingsDir, ...(root === undefined ? {} : { rootPath: root }) }));
}

describe.runIf(isLinux)('bubblewrap mount points in the host project (Linux, real sandbox)', () => {
  it('a guest process that ends while another guest’s wrap() is in flight leaves directories, never empty 0444 files, in the host’s project; nothing is left after both (review RCR-1)', async () => {
    f = await createSandboxFixture();
    const fx = f;
    const alice = await fx.guest('alice');
    const bob = await fx.guest('bob');
    // (1) forced: B is held right after its policy was chosen (at its canary self-test), then A's process ends.
    const a = startWrapped(await fx.sandbox.wrap(await terminal(fx, alice, 'ses_a', 'A-UP')));
    expect(await up(a, /A-UP/)).toBe('UP');
    expect(Object.values(await forms(fx.share))).toEqual(['dir', 'dir', 'dir', 'dir']);
    const service = fx.ctx.services.sandbox as unknown as Record<string, unknown>;
    const original = (service['selfTest'] as (...args: unknown[]) => Promise<void>).bind(service);
    let letGo: () => void = () => {};
    let reached: () => void = () => {};
    const atHold = new Promise<void>((resolve) => (reached = resolve));
    const hold = new Promise<void>((resolve) => (letGo = resolve));
    service['selfTest'] = async (...args: unknown[]) => {
      service['selfTest'] = original;
      reached();
      await hold;
      return original(...args);
    };
    const bWrap = fx.sandbox.wrap(await terminal(fx, bob, 'ses_b', 'B-UP'));
    await atHold;
    a.kill();
    await a.exited; // released: srt's count of running wraps is zero now
    expect(await forms(fx.share)).toEqual({ '.claude': 'dir', '.git': 'dir', '.vscode': 'dir', '.idea': 'dir' });
    letGo();
    const b = startWrapped(await bWrap);
    expect(await up(b, /B-UP/)).toBe('UP');
    expect(await forms(fx.share)).toEqual({ '.claude': 'dir', '.git': 'dir', '.vscode': 'dir', '.idea': 'dir' });
    await mkdir(join(fx.share, '.claude', 'commands')); // the host's own tools keep working meanwhile
    b.kill();
    await b.exited;
    expect(await readdir(join(fx.share, '.claude'))).toEqual(['commands']); // the host's content: kept
    expect(await forms(fx.share, ['.git', '.vscode', '.idea'])).toEqual({ '.git': 'absent', '.vscode': 'absent', '.idea': 'absent' });
    await rm(join(fx.share, '.claude'), { recursive: true });

    // (2) natural timing: A killed `delay` ms after B's wrap() started, nothing held.
    const rows: string[] = [];
    for (const delay of [0, 30, 80, 150]) {
      const a2 = startWrapped(await fx.sandbox.wrap(await terminal(fx, alice, `ses_a${delay}`, 'A-UP')));
      expect(await up(a2, /A-UP/)).toBe('UP');
      const timer = setTimeout(() => a2.kill(), delay);
      const b2 = startWrapped(await fx.sandbox.wrap(await terminal(fx, bob, `ses_b${delay}`, 'B-UP')));
      expect(await up(b2, /B-UP/)).toBe('UP');
      await a2.exited;
      clearTimeout(timer);
      const during = await forms(fx.share);
      rows.push(`delay=${delay} ${JSON.stringify(during)}`);
      b2.kill();
      await b2.exited;
      expect(Object.values(during), rows.at(-1)).toEqual(['dir', 'dir', 'dir', 'dir']);
      for (const name of DIR_NAMES) expect(existsSync(join(fx.share, name)), `${name} after both`).toBe(false);
    }
  }, TIMEOUT);

  it('a guest process starts in one root while another runs in a different root (worktree and main, both ways), and two started at the same moment in one root both come up', async () => {
    f = await createSandboxFixture({ git: true });
    const fx = f;
    const dir = join(fx.share, '.smurg', 'worktrees', 'wt_x');
    await mkdir(dir, { recursive: true });
    await fx.ctx.roots.registerWorktree({ worktreeId: 'wt_x', dir, ownerUserId: 'dev:alice', sharedLinks: [] });
    const wt = await realpath(dir);
    const alice = await fx.guest('alice');
    const bob = await fx.guest('bob');
    const spec = async (id: string, root: 'main' | 'wt', guest: GuestDirs, marker: string): Promise<SandboxSpec> =>
      buildSandboxSpec({
        sessionId: id,
        command: `echo ${marker}; exec sleep 120`,
        rootPath: root === 'main' ? fx.share : wt,
        shareRealPath: fx.share,
        worktree: root === 'main' ? null : { worktreesDir: fx.ctx.roots.worktreesDir, sharedLinks: [] },
        guestDir: guest.dir,
        settingsDir: await fx.settingsDir(id, '{}\n'),
        claudeRealPath: null,
        hookSocketPath: fx.ctx.config.runPaths.hook,
        env: guestEnv(guest),
      });
    for (const [xRoot, yRoot] of [
      ['wt', 'main'],
      ['main', 'wt'],
    ] as const) {
      const x = startWrapped(await fx.sandbox.wrap(await spec(`ses_x_${xRoot}`, xRoot, alice, 'X-UP')));
      expect(await up(x, /X-UP/), `X in ${xRoot}`).toBe('UP');
      const y = startWrapped(await fx.sandbox.wrap(await spec(`ses_y_${yRoot}`, yRoot, bob, 'Y-UP')));
      expect(await up(y, /Y-UP/), `Y in ${yRoot} while X runs in ${xRoot}`).toBe('UP');
      expect(Object.values(await forms(wt, ['.claude', '.vscode', '.idea']))).toEqual(['dir', 'dir', 'dir']);
      y.kill();
      x.kill();
      await Promise.all([x.exited, y.exited]);
    }
    const [p, q] = await Promise.all([fx.sandbox.wrap(await spec('ses_p', 'main', alice, 'P-UP')), fx.sandbox.wrap(await spec('ses_q', 'main', bob, 'Q-UP'))]);
    const [pp, qq] = [startWrapped(p), startWrapped(q)];
    expect([await up(pp, /P-UP/), await up(qq, /Q-UP/)]).toEqual(['UP', 'UP']);
    pp.kill();
    qq.kill();
    await Promise.all([pp.exited, qq.exited]);
    expect(await forms(fx.share, ['.claude', '.vscode', '.idea'])).toEqual({ '.claude': 'absent', '.vscode': 'absent', '.idea': 'absent' });
    expect(await forms(wt, ['.claude', '.vscode', '.idea', '.smurg'])).toEqual({ '.claude': 'absent', '.vscode': 'absent', '.idea': 'absent', '.smurg': 'absent' });
  }, TIMEOUT);

  it('a daemon running inside the share is refused (daemon-cwd) and leaves nothing; from an empty directory of its own, a project with its own .claude/ runs two guests at once and gets none of srt’s working-directory placeholders (review linux-binary F1)', async () => {
    f = await createSandboxFixture({ files: { '.claude/settings.json': '{"permissions":{}}\n', 'README.md': 'x\n' } });
    const fx = f;
    const alice = await fx.guest('alice');
    const bob = await fx.guest('bob');
    process.chdir(fx.share);
    expect(await fx.sandbox.preflight()).toMatchObject({ ok: false, reason: 'daemon-cwd' });
    const refused = await fx.sandbox.wrap(await terminal(fx, alice, 'ses_in', 'IN-UP')).then(
      () => null,
      (err: unknown) => err,
    );
    expect(refused).toBeInstanceOf(SmurgError);
    expect((refused as SmurgError).detail).toEqual({ reason: 'daemon-cwd' });
    expect((await readdir(fx.share)).sort()).toEqual(['.claude', '.smurg', 'README.md']);

    const own = join(fx.stateDir, 'cwd'); // what `smurg host` uses (packages/cli host.ts)
    await mkdir(own, { mode: 0o700 });
    process.chdir(own);
    expect(await fx.sandbox.preflight()).toEqual({ ok: true, platform: 'linux' });
    const first = startWrapped(await fx.sandbox.wrap(await terminal(fx, alice, 'ses_1', 'ONE-UP')));
    expect(await up(first, /ONE-UP/)).toBe('UP');
    const second = startWrapped(await fx.sandbox.wrap(await terminal(fx, bob, 'ses_2', 'TWO-UP')));
    expect(await up(second, /TWO-UP/)).toBe('UP');
    expect(Object.values(await forms(fx.share, CWD_DOTFILES)).filter((form) => form !== 'absent')).toEqual([]);
    expect(await readdir(join(fx.share, '.claude'))).toEqual(['settings.json']);
    expect(await readdir(own)).toEqual([]);
    first.kill();
    second.kill();
    await Promise.all([first.exited, second.exited]);
    expect((await readdir(fx.share)).sort()).toEqual(['.claude', '.smurg', 'README.md']);
    await writeFile(join(fx.share, 'README.md'), 'y\n'); // the host's share is still an ordinary folder
  }, TIMEOUT);
});

/** A guest process whose revocation kills it (what the sessions module does), with when it was revoked. */
interface GuardedProcess {
  readonly p: RunningProcess;
  readonly wrapped: WrappedCommand;
  revoked: { readonly at: number; readonly revocation: SandboxRevocation } | null;
}

describe.runIf(isLinux)('protected entries the host changes while a guest runs (Linux, real sandbox; reviews RV-1, RV-2, RV-3)', () => {
  const POLL_MS = 300;
  let events: DaemonEvents['sandbox.protected-changed'][] = [];

  /** A daemon with the sandbox (a short guard poll) and the real file watcher, run from its own working directory. */
  async function fixture(files: Readonly<Record<string, string>>): Promise<SandboxFixture> {
    f = await createSandboxFixture({ files: { 'README.md': 'x\n', ...files }, module: createSandboxModule({ guardPollMs: POLL_MS }), extraModules: [filesModule] });
    const fx = f;
    const own = join(fx.stateDir, 'cwd');
    await mkdir(own, { mode: 0o700 });
    process.chdir(own);
    events = [];
    fx.ctx.bus.on('sandbox.protected-changed', (event) => events.push(event));
    await waitFor(() => filesInstanceOf(fx.ctx)?.watcher?.watchedRoots().includes('main') === true, { what: 'the file watcher on the share' });
    return fx;
  }

  async function start(fx: SandboxFixture, guest: GuestDirs, id: string, command: string): Promise<GuardedProcess> {
    const settingsDir = await fx.settingsDir(id, '{}\n');
    const wrapped = await fx.sandbox.wrap(fx.spec({ sessionId: id, command, guest, settingsDir }));
    const p = startWrapped(wrapped, { timeoutMs: 120_000 });
    const g: GuardedProcess = { p, wrapped, revoked: null };
    fx.sandbox.onRevoked?.(wrapped, (revocation) => {
      g.revoked = { at: Date.now(), revocation };
      p.kill();
    });
    return g;
  }

  /** Waits for `g` to be revoked (and its process gone); returns the milliseconds since `since`. */
  async function revokedWithin(g: GuardedProcess, since: number, timeoutMs = 10_000): Promise<number> {
    await waitFor(() => g.revoked !== null, { timeoutMs, what: 'the revocation of the guest process' });
    await g.p.exited;
    return (g.revoked?.at ?? 0) - since;
  }

  const atomicSave = async (path: string, content: string): Promise<void> => {
    await writeFile(`${path}.smurg-test-save`, content);
    await rename(`${path}.smurg-test-save`, path);
  };

  it('RV-1: the host saves a read-denied file atomically (.envrc, .claude/settings.local.json) or creates one (sub/.envrc, CLAUDE.local.md, settings.local.json) while a guest runs: that guest is revoked and the host told; an in-place edit revokes nothing; the next guest is denied the new content', async () => {
    const fx = await fixture({ '.envrc': 'export SECRET=old-secret\n', '.claude/settings.local.json': '{"env":{"TOKEN":"old-tok"}}\n', 'sub/a.txt': 'a\n' });
    const alice = await fx.guest('alice');
    const reads = 'echo "R-ENVRC[$(cat .envrc 2>&1)]"; echo "R-SLJ[$(cat .claude/settings.local.json 2>&1)]"; echo "R-SUB[$(cat sub/.envrc 2>&1)]"; echo "R-LOCAL[$(cat CLAUDE.local.md 2>&1)]"';
    const latencies: string[] = [];

    // An in-place edit keeps the inode (the mount holds): no revocation, the guest still reads nothing.
    const quiet = await start(fx, alice, 'ses_inplace', `echo UP; while [ ! -e README.go ]; do sleep 0.05; done; ${reads}; echo DONE; exec sleep 120`);
    await quiet.p.waitForOutput(/UP/, 30_000);
    await appendFile(join(fx.share, '.envrc'), 'export MORE=in-place\n');
    await new Promise((resolve) => setTimeout(resolve, POLL_MS * 4));
    await writeFile(join(fx.share, 'README.go'), '');
    await quiet.p.waitForOutput(/DONE/, 30_000);
    expect(quiet.revoked).toBeNull();
    expect(quiet.p.output()).toMatch(/R-ENVRC\[cat: \.envrc: Permission denied\]/);
    expect(quiet.p.output()).not.toContain('in-place');
    quiet.p.kill();
    await quiet.p.exited;
    await rm(join(fx.share, 'README.go'));
    expect(events).toEqual([]);

    const cases: { readonly label: string; readonly prepare?: () => Promise<void>; readonly change: () => Promise<void>; readonly rel: string }[] = [
      { label: 'E5 .envrc saved atomically', rel: '.envrc', change: () => atomicSave(join(fx.share, '.envrc'), 'export SECRET=new-secret\n') },
      { label: 'E5 settings.local.json saved atomically', rel: '.claude/settings.local.json', change: () => atomicSave(join(fx.share, '.claude', 'settings.local.json'), '{"env":{"TOKEN":"new-tok"}}\n') },
      { label: 'E7 sub/.envrc created', rel: 'sub/.envrc', change: () => writeFile(join(fx.share, 'sub', '.envrc'), 'export SECRET=late-secret\n') },
      { label: 'E7 CLAUDE.local.md created', rel: 'CLAUDE.local.md', change: () => writeFile(join(fx.share, 'CLAUDE.local.md'), 'late private notes\n') },
      {
        label: 'E7 settings.local.json created (the host Claude Code\'s "don\'t ask again")',
        rel: '.claude/settings.local.json',
        prepare: () => unlink(join(fx.share, '.claude', 'settings.local.json')),
        change: () => writeFile(join(fx.share, '.claude', 'settings.local.json'), '{"permissions":{"allow":["Bash(npm test)"]},"env":{"TOKEN":"late-tok"}}\n'),
      },
    ];
    for (const [i, c] of cases.entries()) {
      await c.prepare?.();
      events = [];
      const g = await start(fx, alice, `ses_rv1_${i}`, `echo UP; ${reads}; exec sleep 120`);
      await g.p.waitForOutput(/R-LOCAL/, 30_000);
      const before = Date.now();
      await c.change();
      latencies.push(`${c.label}: ${await revokedWithin(g, before)} ms`);
      expect(g.revoked?.revocation.paths, c.label).toContain(join(fx.share, c.rel));
      expect(events.map((e) => ({ root: e.root, revoked: e.revoked })), c.label).toEqual([{ root: { kind: 'main' }, revoked: 1 }]);
      expect(events[0]?.paths, c.label).toContain(c.rel);
      // A new guest process is started with the file as it is now: denied.
      const next = await start(fx, alice, `ses_rv1_next_${i}`, `${reads}; echo NEXT-DONE`);
      await next.p.waitForOutput(/NEXT-DONE/, 30_000);
      const out = next.p.output();
      for (const secret of ['new-secret', 'new-tok', 'late-secret', 'late private notes', 'late-tok']) expect(out, `${c.label}: ${secret}`).not.toContain(secret);
      await next.p.exited;
      expect(next.revoked).toBeNull();
    }
    process.stdout.write(`RV-1 revocation latency: ${latencies.join('; ')}\n`);
  }, TIMEOUT);

  it('RV-2: the host removes, renames or replaces a protected top-level entry while a guest runs (git clean of a placeholder, git switch, an atomic save of .mcp.json, srt\'s .mcp.json mount point removed, .git replaced): revoked; RV-3: the host\'s own empty .vscode made in place of the placeholder is kept', async () => {
    const fx = await fixture({ '.mcp.json': '{"mcpServers":{}}\n' });
    const alice = await fx.guest('alice');
    const latencies: string[] = [];
    const run = async (label: string, prepare: (() => Promise<void>) | null, change: () => Promise<void>, rel: string): Promise<void> => {
      if (prepare !== null) await prepare();
      events = [];
      const g = await start(fx, alice, `ses_rv2_${latencies.length}`, 'echo UP; exec sleep 120');
      await g.p.waitForOutput(/UP/, 30_000);
      const before = Date.now();
      await change();
      latencies.push(`${label}: ${await revokedWithin(g, before)} ms`);
      expect(g.revoked?.revocation.paths, label).toContain(join(fx.share, rel));
      expect(events[0]?.paths, label).toContain(rel);
    };
    await run('E1 the empty .claude placeholder removed (git clean -fd)', null, () => rmdir(join(fx.share, '.claude')), '.claude');
    await run(
      'E2 the host\'s own .claude renamed away (git switch)',
      async () => {
        await mkdir(join(fx.share, '.claude'), { recursive: true });
        await writeFile(join(fx.share, '.claude', 'settings.json'), '{"permissions":{}}\n');
      },
      () => rename(join(fx.share, '.claude'), join(fx.share, '.claude-other-branch')),
      '.claude',
    );
    await rm(join(fx.share, '.claude-other-branch'), { recursive: true });
    await run('E6 .mcp.json saved atomically', null, () => atomicSave(join(fx.share, '.mcp.json'), '{"mcpServers":{"mine":{"command":"node"}}}\n'), '.mcp.json');
    await run('.git (the watcher never reports it) replaced: found by the poll', null, async () => {
      await rmdir(join(fx.share, '.git'));
      await mkdir(join(fx.share, '.git'));
    }, '.git');
    await rmdir(join(fx.share, '.git'));
    await rm(join(fx.share, '.mcp.json'));
    await run('srt\'s 0444 .mcp.json mount point removed by the host (git clean)', null, () => unlink(join(fx.share, '.mcp.json')), '.mcp.json');
    // RV-3 (E3): rmdir + mkdir hands the freed inode number straight back on ext4; the placeholder's inode is held now.
    let kept = 0;
    for (let i = 0; i < 3; i++) {
      await run(`E3 .vscode replaced by the host's own (round ${i + 1})`, null, async () => {
        await rmdir(join(fx.share, '.vscode'));
        await mkdir(join(fx.share, '.vscode'));
      }, '.vscode');
      await waitFor(async () => (await lstat(join(fx.share, '.idea')).catch(() => null)) === null, { what: 'the service placeholders gone' });
      if (existsSync(join(fx.share, '.vscode'))) kept++;
      await rm(join(fx.share, '.vscode'), { recursive: true, force: true });
    }
    expect(kept).toBe(3);
    process.stdout.write(`RV-2 revocation latency: ${latencies.join('; ')}\n`);
  }, TIMEOUT);

  it("CI run 36810877157: a guest whose wrap() recorded its own canary's mount points (a loaded machine: the watcher and the poll saw them before srt removed them) is not revoked while its process is still starting", async () => {
    const fx = await fixture({});
    const alice = await fx.guest('alice');
    const service = fx.ctx.services.sandbox as unknown as Record<string, unknown>;
    const runner = service['runner'] as { run(input: unknown): Promise<unknown> };
    // The canary is done, srt's cleanup not yet: its bubblewrap mount points stay long enough for the watcher's batch
    // and a poll to record them (a busy CI runner; here, held).
    service['runner'] = {
      ...runner,
      run: async (input: unknown) => {
        const result = await runner.run(input);
        await new Promise((resolve) => setTimeout(resolve, POLL_MS * 2));
        return result;
      },
    };
    // On a busy runner the watcher's batches also come late: the one for srt's cleanup only after the hand-out.
    const fileEvents = (service['fileEvents'] as (root: string, events: unknown) => void).bind(service);
    service['fileEvents'] = (root: string, events: unknown) => {
      setTimeout(() => fileEvents(root, events), POLL_MS);
    };
    const settingsDir = await fx.settingsDir('ses_ci_r9', '{}\n');
    const wrapped = await fx.sandbox.wrap(fx.spec({ sessionId: 'ses_ci_r9', command: 'echo R9-UP; exec sleep 120', guest: alice, settingsDir }));
    service['runner'] = runner;
    let revoked: SandboxRevocation | null = null;
    fx.sandbox.onRevoked?.(wrapped, (revocation) => {
      revoked = revocation;
    });
    // Handed out: srt's mount points exist, as bubblewrap makes them, before the process starts...
    expect(await forms(fx.share, ['.mcp.json', '.envrc'])).toEqual({ '.mcp.json': 'file444', '.envrc': 'file444' });
    // ...and while it starts slowly, the watcher's batch for srt's cleanup and the polls change nothing.
    await new Promise((resolve) => setTimeout(resolve, POLL_MS * 4));
    delete service['fileEvents']; // the service's own method again
    expect(revoked).toBeNull();
    const p = startWrapped(wrapped, { timeoutMs: 120_000 });
    expect(await up(p, /R9-UP/)).toBe('UP');
    await new Promise((resolve) => setTimeout(resolve, POLL_MS * 4));
    expect(revoked).toBeNull();
    expect(events).toEqual([]);
    p.kill();
    await p.exited;
  }, TIMEOUT);

  it('a wrap() in flight while the host changes a protected entry is refused (protected-changed); guests starting and stopping beside a running one revoke nothing', async () => {
    const fx = await fixture({ '.envrc': 'export SECRET=x\n' });
    const alice = await fx.guest('alice');
    const bob = await fx.guest('bob');
    const a = await start(fx, alice, 'ses_keep', 'echo A-UP; exec sleep 120');
    await a.p.waitForOutput(/A-UP/, 30_000);
    // Churn: srt's mount points and the service's placeholders come and go with other guests' processes.
    for (let i = 0; i < 3; i++) {
      const b = await start(fx, bob, `ses_churn_${i}`, 'echo B-UP; sleep 0.3');
      await b.p.exited;
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_MS * 4));
    expect(a.revoked).toBeNull();
    expect(events).toEqual([]);
    // Held at its canary self-test, i.e. after its policy was chosen.
    const service = fx.ctx.services.sandbox as unknown as Record<string, unknown>;
    const original = (service['selfTest'] as (...args: unknown[]) => Promise<void>).bind(service);
    let letGo: () => void = () => {};
    let reached: () => void = () => {};
    const atHold = new Promise<void>((resolve) => (reached = resolve));
    const hold = new Promise<void>((resolve) => (letGo = resolve));
    service['selfTest'] = async (...args: unknown[]) => {
      service['selfTest'] = original;
      reached();
      await hold;
      return original(...args);
    };
    const settingsDir = await fx.settingsDir('ses_inflight', '{}\n');
    const inFlight = fx.sandbox.wrap(fx.spec({ sessionId: 'ses_inflight', command: 'echo C-UP; exec sleep 120', guest: bob, settingsDir })).then(
      () => null,
      (err: unknown) => err,
    );
    await atHold;
    await atomicSave(join(fx.share, '.envrc'), 'export SECRET=changed\n');
    await revokedWithin(a, Date.now());
    letGo();
    const refused = await inFlight;
    expect(refused).toBeInstanceOf(SmurgError);
    expect((refused as SmurgError).detail).toEqual({ reason: 'protected-changed' });
    // Nothing of either is left in the host's project once both are gone.
    await waitFor(async () => !existsSync(join(fx.share, '.claude')) && !existsSync(join(fx.share, '.vscode')), { what: 'the placeholders removed' });
    expect((await readdir(fx.share)).sort()).toEqual(['.envrc', '.smurg', 'README.md']);
  }, TIMEOUT);
});

describe.runIf(isLinux)('the guard-review round of 2026-10-01 (Linux, real sandbox and watcher; GR-1, GR-3, GR-4)', () => {
  const run = promisify(execFile);
  let events: DaemonEvents['sandbox.protected-changed'][] = [];

  /** A daemon with the sandbox (short guard poll and walk) and the real file watcher, run from its own directory. */
  async function fixture(options: { readonly files?: Readonly<Record<string, string>>; readonly git?: boolean; readonly walkMs?: number } = {}): Promise<SandboxFixture> {
    f = await createSandboxFixture({
      files: { 'README.md': 'x\n', ...options.files },
      ...(options.git === true ? { git: true } : {}),
      module: createSandboxModule({ guardPollMs: 300, guardWalkMs: options.walkMs ?? 300 }),
      extraModules: [filesModule],
    });
    const fx = f;
    const own = join(fx.stateDir, 'cwd');
    await mkdir(own, { mode: 0o700 });
    process.chdir(own);
    events = [];
    fx.ctx.bus.on('sandbox.protected-changed', (event) => events.push(event));
    await waitFor(() => filesInstanceOf(fx.ctx)?.watcher?.watchedRoots().includes('main') === true, { what: 'the file watcher on the share' });
    return fx;
  }

  async function start(fx: SandboxFixture, guest: GuestDirs, id: string, command: string): Promise<GuardedProcess> {
    const settingsDir = await fx.settingsDir(id, '{}\n');
    const wrapped = await fx.sandbox.wrap(fx.spec({ sessionId: id, command, guest, settingsDir }));
    const p = startWrapped(wrapped, { timeoutMs: 120_000 });
    const g: GuardedProcess = { p, wrapped, revoked: null };
    fx.sandbox.onRevoked?.(wrapped, (revocation) => {
      g.revoked = { at: Date.now(), revocation };
      p.kill();
    });
    return g;
  }

  async function revokedWithin(g: GuardedProcess, since: number, timeoutMs = 10_000): Promise<number> {
    await waitFor(() => g.revoked !== null, { timeoutMs, what: 'the revocation of the guest process' });
    await g.p.exited;
    return (g.revoked?.at ?? 0) - since;
  }

  it('GR-1: a name in a directory the watcher never watched (made in one burst with its parent): a guest\'s two-step plant and the host\'s new secret there revoke the guest', async () => {
    const fx = await fixture();
    const alice = await fx.guest('alice');
    // (a) `mkdir -p deep/a/b`, a second later the name: inotify never watched deep/a/b, so no event at all.
    const a = await start(fx, alice, 'ses_gr1_plant', "mkdir -p deep/a/b && sleep 1 && mkdir deep/a/b/.claude && echo '{\"hooks\":{}}' > deep/a/b/.claude/settings.json && echo PLANTED; exec sleep 120");
    // On a slow runner the periodic walk may find deep/a/b/.claude and revoke the guest before its `echo PLANTED`
    // (CI run 36882410691): either is the plant being caught, so wait for whichever comes first.
    const plantedOutput = a.p.waitForOutput(/PLANTED/, 30_000);
    plantedOutput.catch(() => undefined);
    await Promise.race([plantedOutput, waitFor(() => a.revoked !== null, { timeoutMs: 30_000, what: 'PLANTED or the revocation' })]);
    const planted = Date.now();
    const ms = await revokedWithin(a, planted);
    expect(a.revoked?.revocation.paths).toContain(join(fx.share, 'deep', 'a', 'b', '.claude'));
    expect(events.map((event) => event.paths)).toContainEqual(expect.arrayContaining(['deep/a/b/.claude']));
    // (b) the host's `mkdir -p` (coreutils: every level in one go) before the guest starts, the secret file later.
    await run('mkdir', ['-p', join(fx.share, 'svc', 'api', 'config')]);
    await new Promise((resolve) => setTimeout(resolve, 500));
    const c = await start(fx, alice, 'ses_gr1_reader', 'echo UP; exec sleep 120');
    await c.p.waitForOutput(/UP/, 30_000);
    const written = Date.now();
    await writeFile(join(fx.share, 'svc', 'api', 'config', '.envrc'), 'export TOKEN=host-secret\n');
    const ms2 = await revokedWithin(c, written);
    expect(c.revoked?.revocation.paths).toContain(join(fx.share, 'svc', 'api', 'config', '.envrc'));
    process.stdout.write(`GR-1 revocation: two-step plant ${ms} ms, host secret in a mkdir -p directory ${ms2} ms\n`);
  }, TIMEOUT);

  it('GR-1: a guest that plants a name in such a directory and exits at once: the host is still told after the release (nothing left to revoke)', async () => {
    const fx = await fixture({ walkMs: 3_600_000 });
    const alice = await fx.guest('alice');
    const g = await start(fx, alice, 'ses_gr1_exit', 'mkdir -p late/x && sleep 0.3 && mkdir late/x/.vscode && echo DONE');
    await g.p.exited;
    await waitFor(() => events.some((event) => event.paths.includes('late/x/.vscode')), { timeoutMs: 10_000, what: 'the host told of late/x/.vscode' });
    expect(events.find((event) => event.paths.includes('late/x/.vscode'))?.revoked).toBe(0);
  }, TIMEOUT);

  it('GR-3: the host\'s new sub/.envrc right after a build wrote 20,000 files still revokes the guest at once (the sandbox hears of each watcher batch as it arrives, not behind the files module\'s own work)', async () => {
    const fx = await fixture({ files: { 'sub/a.txt': 'a\n' } });
    const alice = await fx.guest('alice');
    const g = await start(fx, alice, 'ses_gr3', 'echo UP; exec sleep 120');
    await g.p.waitForOutput(/UP/, 30_000);
    for (let d = 0; d < 20; d++) {
      await mkdir(join(fx.share, 'dist', `d${d}`), { recursive: true });
      await Promise.all(Array.from({ length: 1000 }, (_, i) => writeFile(join(fx.share, 'dist', `d${d}`, `f${i}.js`), 'x')));
    }
    await new Promise((resolve) => setTimeout(resolve, 400));
    const written = Date.now();
    await writeFile(join(fx.share, 'sub', '.envrc'), 'export SECRET=late\n');
    const ms = await revokedWithin(g, written, 30_000);
    process.stdout.write(`GR-3 revocation behind a 20,000-file build: ${ms} ms\n`);
    expect(ms).toBeLessThan(3_000);
  }, TIMEOUT);

  it('GR-4: a git share: while a guest runs, the host\'s `git add -A` and `git stash -u` leave the placeholders alone; a checkout that puts a tracked empty .envrc in place revokes the guest, and that file is still there, unchanged, once the guest is gone', async () => {
    const fx = await fixture({ git: true });
    const env = fx.gitEnv();
    const git = async (...args: string[]): Promise<string> => (await run('git', args, { cwd: fx.share, env })).stdout;
    await git('checkout', '-q', '-b', 'with-envrc');
    await writeFile(join(fx.share, '.envrc'), '');
    await git('add', '.envrc');
    await git('commit', '-q', '-m', 'an empty .envrc');
    await git('checkout', '-q', 'main');
    expect(existsSync(join(fx.share, '.envrc'))).toBe(false);
    const alice = await fx.guest('alice');
    const g = await start(fx, alice, 'ses_gr4', 'echo UP; exec sleep 120');
    await g.p.waitForOutput(/UP/, 30_000);
    for (const name of ['.mcp.json', '.envrc', '.claude', '.vscode', '.idea']) expect(existsSync(join(fx.share, name)), name).toBe(true);
    await writeFile(join(fx.share, 'notes.txt'), 'mine\n');
    await git('add', '-A');
    expect(await git('diff', '--cached', '--name-only')).toBe('notes.txt\n');
    await git('commit', '-q', '-m', 'work');
    await writeFile(join(fx.share, 'wip.txt'), 'wip\n');
    await git('stash', '-u', '-q');
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    expect(g.revoked).toBeNull();
    expect(events).toEqual([]);
    await git('stash', 'pop', '-q');
    await rm(join(fx.share, 'wip.txt'));
    // The checkout replaces the ignored placeholder with the tracked file: the guest's mount is gone, so it ends.
    const switched = Date.now();
    await git('checkout', '-q', 'with-envrc');
    const checkedOut = await lstat(join(fx.share, '.envrc'));
    expect(checkedOut.mode & 0o222).not.toBe(0); // git's file (umask), not srt's 0444 one
    await revokedWithin(g, switched);
    expect(g.revoked?.revocation.paths).toContain(join(fx.share, '.envrc'));
    await waitFor(() => !existsSync(join(fx.share, '.vscode')), { what: 'the placeholders gone' });
    const kept = await lstat(join(fx.share, '.envrc'));
    expect([kept.isFile(), kept.size, kept.ino, kept.mode]).toEqual([true, 0, checkedOut.ino, checkedOut.mode]);
    expect(existsSync(join(fx.share, '.mcp.json'))).toBe(false);
    expect(await git('status', '--porcelain', '--untracked-files=all')).toBe('');
    expect(await readFile(join(fx.share, '.git', 'info', 'exclude'), 'utf8')).not.toContain('placeholders');
  }, TIMEOUT);
});
