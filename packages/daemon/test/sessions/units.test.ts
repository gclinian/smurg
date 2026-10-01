// Unit tests of the sessions module's pure parts: raw tail, terminal mirror, environments (R4.3's allow-list),
// launch files, sandbox spec, import validation, kill-tree selection guards (ARCHITECTURE §0 rule 1), login parsing.
import xtermHeadless from '@xterm/headless';
import { describe, expect, it } from 'vitest';
import { LoginHintDetector, parseAuthStatus } from '../../src/sessions/claude.ts';
import { GuestEnvError, LOGIN_OVERRIDE_VARS, assertGuestEnv, buildGuestEnv, buildHostEnv, withTestGuestEnv } from '../../src/sessions/guest-env.ts';
import { validateImport } from '../../src/sessions/import-config.ts';
import { envEntryPidsFromPs, identityOf, isSafePgid, killTree, parseProcessTable, releaseStoppedProcesses, rememberDescendants, selectTargets, stoppedProcesses, type ProcessInspector, type ProcessRow } from '../../src/sessions/kill-tree.ts';
import { apiKeyApprovalSuffix, mergeClaudeJson } from '../../src/sessions/launch-files.ts';
import { RawTail } from '../../src/sessions/raw-tail.ts';
import { runProcess } from '../../src/sessions/process-run.ts';
import { buildSandboxSpec, guestCommand, shellQuote } from '../../src/sessions/sandbox-spec.ts';
import { TermMirror } from '../../src/sessions/term-mirror.ts';
import { createMemoryLogger } from '../../src/core/logger.ts';

const { Terminal } = xtermHeadless;
const enc = (text: string): Buffer => Buffer.from(text, 'utf8');

async function waitUntilTrue(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('timed out');
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

describe('helper processes (process-run.ts)', () => {
  it('a helper whose signal is aborted is killed at once, like at its deadline; an aborted signal starts nothing (a guest sandbox that no longer holds, SandboxService.onRevoked)', async () => {
    const abort = new AbortController();
    const started = Date.now();
    const running = runProcess('/bin/sh', ['-c', 'echo started; exec sleep 30'], { env: { PATH: '/usr/bin:/bin' }, cwd: '/', timeoutMs: 20_000, signal: abort.signal });
    setTimeout(() => abort.abort(), 200);
    const result = await running;
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(result).toMatchObject({ signal: 'SIGKILL', timedOut: false, spawnError: false });
    expect(await runProcess('/bin/sh', ['-c', 'echo never'], { env: { PATH: '/usr/bin:/bin' }, cwd: '/', timeoutMs: 20_000, signal: abort.signal })).toEqual({ code: null, signal: null, stdout: '', timedOut: false, spawnError: true });
  });
});

describe('RawTail', () => {
  it('returns exact deltas by absolute offset and refuses evicted or future offsets', () => {
    const tail = new RawTail(10);
    tail.append(enc('abcd'));
    tail.append(enc('efgh'));
    expect(tail.since(2)?.toString()).toBe('cdefgh');
    expect(tail.since(8)?.toString()).toBe('');
    tail.append(enc('ijkl')); // 12 bytes > 10: 'abcd' evicted
    expect(tail.firstOffset).toBe(4);
    expect(tail.since(3)).toBeNull();
    expect(tail.since(5)?.toString()).toBe('fghijkl');
    expect(tail.since(13)).toBeNull();
  });
});

describe('TermMirror', () => {
  it('answers a terminal query exactly once (the daemon mirror is the only responder)', async () => {
    const replies: string[] = [];
    const mirror = new TermMirror(80, 24, 100, (data) => replies.push(data));
    mirror.write(enc('\x1b[c'));
    await mirror.drained();
    expect(replies).toEqual(['\x1b[?1;2c']);
    mirror.dispose();
  });

  it('snapshots the full scrollback at an exact offset and restores what SerializeAddon misses', async () => {
    const mirror = new TermMirror(40, 10, 5000, () => {});
    let text = '';
    for (let i = 1; i <= 300; i++) text += `hist-${i}\r\n`;
    mirror.write(enc(text));
    mirror.write(enc('\x1b[?25l\x1b[3 q'));
    const snapshot = await mirror.snapshot(5000, 8 * 1024 * 1024);
    expect(snapshot.offset).toBe(mirror.offset);
    const viewer = new Terminal({ cols: snapshot.cols, rows: snapshot.rows, scrollback: 5000, allowProposedApi: true });
    await new Promise<void>((resolve) => viewer.write(snapshot.data, () => resolve()));
    const lines: string[] = [];
    for (let i = 0; i < viewer.buffer.active.length; i++) lines.push(viewer.buffer.active.getLine(i)?.translateToString(true) ?? '');
    expect(lines).toContain('hist-1');
    expect(lines).toContain('hist-300');
    const data = new TextDecoder().decode(snapshot.data);
    expect(data.endsWith('\x1b[?25l')).toBe(true);
    expect(data).toContain('\x1b[3 q');
    viewer.dispose();
    mirror.dispose();
  });

  it('shrinks the scrollback of a snapshot that would exceed the attach limit instead of failing', async () => {
    const mirror = new TermMirror(80, 10, 5000, () => {});
    let text = '';
    for (let i = 1; i <= 2000; i++) text += `\x1b[3${i % 7}m${'x'.repeat(60)}\x1b[0m\r\n`;
    mirror.write(enc(text));
    const full = await mirror.snapshot(5000, 64 * 1024 * 1024);
    const small = await mirror.snapshot(5000, Math.floor(full.data.byteLength / 3));
    expect(small.data.byteLength).toBeLessThanOrEqual(Math.floor(full.data.byteLength / 3));
    expect(small.scrollbackLines).toBeLessThan(5000);
    mirror.dispose();
  });

  it('REL-12: a snapshot over the limit costs a bounded number of serializations, and an unchanged mirror is not serialized again', async () => {
    const mirror = new TermMirror(300, 30, 5000, () => {});
    // A wide, colourful terminal: one SGR per cell (test runners, `ls --color`, TUIs).
    const colours = Array.from({ length: 300 }, (_, i) => `\x1b[3${i % 8};4${(i + 3) % 8}m${String.fromCharCode(97 + (i % 26))}`).join('');
    const line = `${colours}\x1b[0m\r\n`;
    mirror.write(enc(line.repeat(4_000)));
    await mirror.drained();
    const serializer = (mirror as unknown as { serializer: { serialize: (options: { scrollback: number }) => string } }).serializer;
    const original = serializer.serialize.bind(serializer);
    const calls: number[] = [];
    serializer.serialize = (options) => {
      calls.push(options.scrollback);
      return original(options);
    };
    const maxBytes = 2 * 1024 * 1024;
    const snapshot = await mirror.snapshot(5000, maxBytes);
    expect(snapshot.data.byteLength).toBeLessThanOrEqual(maxBytes);
    expect(snapshot.scrollbackLines).toBeGreaterThan(0);
    // Never the whole history (tens of MB) first, then halving: two small probes and one or two real passes.
    expect(calls.length).toBeLessThanOrEqual(4);
    expect(Math.max(...calls)).toBeLessThan(4_000);
    // The same state again (another viewer, a flapping connection): no serialization at all.
    const before = calls.length;
    const again = await mirror.snapshot(5000, maxBytes);
    expect(again.data).toBe(snapshot.data);
    expect(calls.length).toBe(before);
    // New output: a fresh snapshot, which includes it.
    mirror.write(enc('tail-marker\r\n'));
    const fresh = await mirror.snapshot(5000, maxBytes);
    expect(calls.length).toBeGreaterThan(before);
    expect(new TextDecoder().decode(fresh.data)).toContain('tail-marker');
    mirror.dispose();
  });

  it('re-emits the cursor relative to the top margin when origin mode is on (verifier V7)', async () => {
    const mirror = new TermMirror(40, 20, 100, () => {});
    // margins 5..15, origin mode on, cursor to row 3 of the region (= screen row 7)
    mirror.write(enc('\x1b[5;15r\x1b[?6h\x1b[3;4Hx'));
    const snapshot = await mirror.snapshot(100, 1 << 20);
    const viewer = new Terminal({ cols: 40, rows: 20, allowProposedApi: true });
    await new Promise<void>((resolve) => viewer.write(snapshot.data, () => resolve()));
    expect(viewer.buffer.active.cursorY).toBe(6); // 0-based screen row 7
    viewer.dispose();
    mirror.dispose();
  });
});

describe('guest environment (R4.3: the host environment never reaches a guest)', () => {
  const hostEnv = {
    USER: 'host',
    LANG: 'zh_TW.UTF-8',
    PATH: '/opt/secret/bin:/usr/bin',
    HOME: '/Users/host',
    ANTHROPIC_API_KEY: 'sk-ant-host-secret',
    ANTHROPIC_AUTH_TOKEN: 'tok',
    CLAUDE_CODE_OAUTH_TOKEN: 'oauth',
    CLAUDE_CODE_USE_BEDROCK: '1',
    CLAUDE_CODE_USE_VERTEX: '1',
    CLAUDE_SECURESTORAGE_CONFIG_DIR: '',
    AWS_SECRET_ACCESS_KEY: 'aws',
    GITHUB_TOKEN: 'gh',
    HTTPS_PROXY: 'http://proxy',
    NODE_OPTIONS: '--require=/x',
    SSH_AUTH_SOCK: '/tmp/agent',
    CLAUDECODE: '1',
  };
  const base = { home: '/g/home', configDir: '/g/cfg', tmpDir: '/g/tmp', hostEnv, claudeDir: '/opt/claude', shell: '/bin/bash', browser: '/usr/bin/true', sessionId: 'ses_1' };

  it('is built from the allow-list only', () => {
    const env = buildGuestEnv({ ...base, hookEnv: { SMURG_HOOK_SOCKET: '/run/x.hook', SMURG_SESSION_TOKEN: 't', SMURG_SESSION_ID: 'other', EVIL: '1' } });
    expect(Object.keys(env).sort()).toEqual(
      [
        'BROWSER',
        'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC',
        'CLAUDE_CODE_DISABLE_OFFICIAL_MARKETPLACE_AUTOINSTALL',
        'CLAUDE_CONFIG_DIR',
        'COLORTERM',
        'DISABLE_AUTOUPDATER',
        'HOME',
        'LANG',
        'LOGNAME',
        'PATH',
        'SHELL',
        'SMURG_HOOK_SOCKET',
        'SMURG_SESSION_ID',
        'SMURG_SESSION_TOKEN',
        'TERM',
        'TMPDIR',
        'USER',
      ].sort(),
    );
    expect(env['PATH']).toBe('/opt/claude:/usr/bin:/bin:/usr/sbin:/sbin');
    expect(env['HOME']).toBe('/g/home');
    expect(env['SMURG_SESSION_ID']).toBe('ses_1');
    for (const name of LOGIN_OVERRIDE_VARS) expect(env[name]).toBeUndefined();
    expect(JSON.stringify(env)).not.toContain('secret');
  });

  it('the deny-pattern assertion refuses every credential or override variable, except the guest\'s own key', () => {
    for (const name of [...LOGIN_OVERRIDE_VARS, 'HTTPS_PROXY', 'https_proxy', 'NODE_OPTIONS', 'SSH_AUTH_SOCK', 'GITHUB_TOKEN', 'MY_SECRET', 'DYLD_INSERT_LIBRARIES', 'XDG_CONFIG_HOME', 'CLAUDECODE', 'SMURG_OTHER']) {
      expect(() => assertGuestEnv({ PATH: '/usr/bin', [name]: 'x' }, { apiKeyAllowed: false }), name).toThrow(GuestEnvError);
    }
    expect(() => assertGuestEnv({ ANTHROPIC_API_KEY: 'k' }, { apiKeyAllowed: true })).not.toThrow();
    expect(() => assertGuestEnv({ ANTHROPIC_AUTH_TOKEN: 'k' }, { apiKeyAllowed: true })).toThrow(GuestEnvError);
  });

  it('test-only extras never replace a variable smurg set', () => {
    const env = withTestGuestEnv({ HOME: '/g/home' }, { HOME: '/evil', ANTHROPIC_BASE_URL: 'http://127.0.0.1:1', SMURG_SESSION_ID: 'x' });
    expect(env).toEqual({ HOME: '/g/home', ANTHROPIC_BASE_URL: 'http://127.0.0.1:1' });
  });

  it('host sessions keep the host environment minus what a parent Claude Code session injected', () => {
    const env = buildHostEnv({
      hostEnv: {
        ...hostEnv,
        CLAUDE_CODE_ENTRYPOINT: 'cli',
        CLAUDE_CODE_SESSION_ID: 's',
        CLAUDE_AGENT_SDK_VERSION: '1',
        CLAUDE_PREVIEW_X: '1',
        AI_AGENT: 'claude',
        CLAUDE_PID: '1',
        CLAUDE_EFFORT: 'high',
        CLAUDE_CODE_SAFE_MODE: '1',
        CLAUDE_CODE_SIMPLE: '1',
        CLAUDE_CODE_SKIP_BEDROCK_AUTH: '1',
        CLAUDE_CODE_CLIENT_CERT: '/c',
        SMURG_SESSION_ID: 'parent',
      },
      home: '/fake/home',
      sessionId: 'ses_2',
    });
    for (const name of ['CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_SESSION_ID', 'CLAUDE_AGENT_SDK_VERSION', 'CLAUDE_PREVIEW_X', 'AI_AGENT', 'CLAUDE_PID', 'CLAUDE_EFFORT', 'CLAUDE_CODE_SAFE_MODE', 'CLAUDE_CODE_SIMPLE']) {
      expect(env[name], name).toBeUndefined();
    }
    // the host's own provider choices stay
    expect(env['ANTHROPIC_API_KEY']).toBe('sk-ant-host-secret');
    expect(env['CLAUDE_CODE_USE_BEDROCK']).toBe('1');
    expect(env['CLAUDE_CODE_OAUTH_TOKEN']).toBe('oauth');
    expect(env['CLAUDE_CODE_SKIP_BEDROCK_AUTH']).toBe('1');
    expect(env['CLAUDE_CODE_CLIENT_CERT']).toBe('/c');
    expect(env['HOME']).toBe('/fake/home');
    expect(env['SMURG_SESSION_ID']).toBe('ses_2');
    expect(env['TERM']).toBe('xterm-256color');
  });
});

// The settings.json / mcp.json builders are the hooks module's (one writer: test/hooks/settings-writer.test.ts).
describe('launch files', () => {
  it('seeds trust and key approval into .claude.json without losing the guest\'s own state', () => {
    const merged = mergeClaudeJson({ theme: 'dark', projects: { '/p': { history: [1] } }, customApiKeyResponses: { rejected: ['12345678901234567890'] } }, { projectPath: '/p', apiKeySuffix: apiKeyApprovalSuffix('sk-ant-xx-12345678901234567890') });
    expect(merged).toEqual({ theme: 'dark', projects: { '/p': { history: [1], hasTrustDialogAccepted: true } }, customApiKeyResponses: { approved: ['12345678901234567890'], rejected: [] } });
    expect(mergeClaudeJson('garbage', { projectPath: '/q' })).toEqual({ projects: { '/q': { hasTrustDialogAccepted: true } } });
  });
});

describe('sandbox spec', () => {
  const common = {
    sessionId: 'ses_1',
    command: 'exec x',
    shareRealPath: '/srv/share',
    guestDir: '/state/guests/k/u',
    settingsDir: '/state/sessions/ses_1',
    claudeRealPath: '/opt/claude/2.1.283',
    hookSocketPath: '/run/x.hook',
    env: { HOME: '/state/guests/k/u/home' },
  };

  it('main workspace: <share>/.smurg hidden, host-only paths not writable', () => {
    const spec = buildSandboxSpec({ ...common, rootPath: '/srv/share', worktree: null });
    expect(spec.denyReadPaths).toContain('/srv/share/.smurg');
    expect(spec.denyWritePaths).toEqual(expect.arrayContaining(['/srv/share/.smurg', '/srv/share/.claude', '/srv/share/.mcp.json', '/srv/share/.git', '/srv/share/.envrc', '/srv/share/.vscode', '/srv/share/.idea']));
    expect(spec.extraReadPaths).toEqual(['/opt/claude/2.1.283']); // smurg hook / mcp: the sandbox module's carve-outs
    expect(spec.hookSocketPath).toBe('/run/x.hook');
  });

  it('worktree mode (R9.1): the main share and every sibling worktree are denied, wherever the share lives', () => {
    const spec = buildSandboxSpec({
      ...common,
      rootPath: '/srv/share/.smurg/worktrees/wt1',
      worktree: { worktreesDir: '/srv/share/.smurg/worktrees', sharedLinks: [{ path: 'data', mainPath: 'data', targetRealPath: '/srv/share/data' }] },
    });
    expect(spec.denyReadPaths).toEqual(expect.arrayContaining(['/srv/share', '/srv/share/.smurg/worktrees']));
    expect(spec.denyWritePaths).toEqual(expect.arrayContaining(['/srv/share', '/srv/share/.smurg/worktrees', '/srv/share/.smurg/worktrees/wt1/.git', '/srv/share/.smurg/worktrees/wt1/data']));
    expect(spec.readOnlyPaths).toEqual(['/srv/share/data']);
    expect(spec.extraReadPaths).toEqual(['/opt/claude/2.1.283']); // .git/objects: the sandbox module's own carve-out
  });

  it('quotes the guest command for the shell', () => {
    expect(shellQuote("a'b")).toBe(`'a'\\''b'`);
    expect(guestCommand('/g/tmp', '/opt/claude', ['--settings', '/s p/x.json'])).toBe(`export TMPDIR='/g/tmp'; exec '/opt/claude' '--settings' '/s p/x.json'`);
  });
});

describe('session.importConfig validation (path safety)', () => {
  const lexical = (path: unknown): string => {
    if (typeof path !== 'string' || path.includes('..') || path.startsWith('/')) throw new Error('lexical');
    return path.normalize('NFC');
  };
  const file = (relPath: string, size = 3) => ({ relPath, content: new Uint8Array(size) });

  it('accepts CLAUDE.md, commands/** and skills/** only', () => {
    expect(validateImport([file('CLAUDE.md'), file('commands/a.md'), file('skills/s/SKILL.md')], lexical).map((f) => f.relPath)).toEqual(['CLAUDE.md', 'commands/a.md', 'skills/s/SKILL.md']);
    for (const bad of ['settings.json', '.claude.json', 'commands', 'agents/x.md', '.credentials.json']) expect(() => validateImport([file(bad)], lexical), bad).toThrow();
    expect(() => validateImport([file('../CLAUDE.md')], lexical)).toThrow();
  });

  it('refuses names a case-insensitive file system folds together, file/dir clashes and oversized content', () => {
    expect(() => validateImport([file('commands/A.md'), file('commands/a.md')], lexical)).toThrow(/不分大小寫/);
    expect(() => validateImport([file('skills/ſkill.md'), file('skills/skill.md')], lexical)).toThrow();
    expect(() => validateImport([file('commands/a'), file('commands/a/b.md')], lexical)).toThrow();
    expect(() => validateImport([file('commands/x.md', 1024 * 1024 + 1)], lexical)).toThrow();
    expect(() => validateImport([file('commands/.x.smurg-aa.tmp')], lexical)).toThrow();
  });
});

describe('kill-tree selection guards (ARCHITECTURE §0 rule 1)', () => {
  const SELF = 1000;
  const UID = 501;
  const row = (pid: number, ppid: number, pgid: number, extra: Partial<ProcessRow> = {}): ProcessRow => ({ pid, ppid, pgid, uid: UID, zombie: false, start: 'Mon Sep 28 10:00:00 2026', command: `cmd-${pid}`, ...extra });
  const id = (r: ProcessRow): string => identityOf(r) as string;
  // launchd 1 → terminal 900 (pgid 900) → daemon 1000 (pgid 950: the terminal job)
  const base = [row(1, 0, 1, { uid: 0 }), row(900, 1, 900), row(1000, 900, 950), row(1001, 1000, 950)];
  const select = (rows: ProcessRow[], extra: Partial<Parameters<typeof selectTargets>[0]> = {}) =>
    selectTargets({ rows, markers: new Map(), rootPid: null, selfPid: SELF, uid: UID, ...extra });

  it('the PTY child, its process group and the descendants of both are targets', () => {
    const rows = [...base, row(2000, 1000, 2000), row(2001, 2000, 2001), row(2002, 2001, 2001), row(2003, 1, 2000) /* orphan in the child's group */];
    expect([...select(rows, { rootPid: 2000 }).targets.keys()].sort()).toEqual([2000, 2001, 2002, 2003]);
  });

  it('a root pid that is no longer our own child (reused by a stranger) or belongs to another session counts not', () => {
    const stranger = [...base, row(2000, 4242, 2000), row(2001, 2000, 2000)];
    expect([...select(stranger, { rootPid: 2000 }).targets.keys()]).toEqual([]);
    const otherSession = [...base, row(2000, 1000, 2000), row(2001, 2000, 2000)];
    expect([...select(otherSession, { rootPid: 2000, protect: new Set([2000]) }).targets.keys()]).toEqual([]);
  });

  it('the daemon, its ancestors and its own process group are never targets, whatever the marker says', () => {
    const rows = [...base, row(2000, 1000, 2000)];
    const markers = new Map([1, 900, 1000, 1001, 2000].map((pid) => [pid, id(rows.find((r) => r.pid === pid) as ProcessRow)]));
    const { targets, protectedPids } = select(rows, { markers, rootPid: 2000 });
    expect([...targets.keys()]).toEqual([2000]);
    for (const pid of [1, 900, 1000, 1001]) expect(protectedPids.has(pid)).toBe(true);
  });

  it('a marker match counts only for the same process the environment scan saw (identity), not a reused pid', () => {
    const rows = [...base, row(3000, 1, 3000), row(3001, 1, 3001, { command: 'someone else' })];
    const markers = new Map([
      [3000, id(row(3000, 1, 3000))],
      [3001, id(row(3001, 1, 3001))], // the marked process was cmd-3001; the table now shows another process
    ]);
    expect([...select(rows, { markers }).targets.keys()]).toEqual([3000]);
  });

  it('refuses the process group of a child that sits in the daemon\'s own group (pgid validation)', () => {
    const rows = [...base, row(2000, 1000, 950), row(2100, 1, 950)];
    const selection = select(rows, { rootPid: 2000 });
    expect(selection.refusedPgid).toBe(950);
    expect(selection.targets.has(2100)).toBe(false);
    expect(selection.targets.has(1001)).toBe(false);
    expect(isSafePgid(950, SELF, 950)).toBe(false);
    expect(isSafePgid(1, SELF, 950)).toBe(false);
    expect(isSafePgid(SELF, SELF, 950)).toBe(false);
    expect(isSafePgid(2.5, SELF, 950)).toBe(false);
    expect(isSafePgid(2000, SELF, 950)).toBe(true);
  });

  it('other users\' processes and zombies are never targets; a reaped child counts no more', () => {
    const rows = [...base, row(2000, 1000, 2000), row(2001, 2000, 2000, { uid: 0 }), row(2002, 2000, 2000, { zombie: true }), row(3000, 1, 3000)];
    const markers = new Map([[3000, id(row(3000, 1, 3000))]]);
    expect([...select(rows, { markers, rootPid: 2000 }).targets.keys()].sort()).toEqual([2000, 3000]);
    // rootPid null (node-pty reported the exit): only the env marker ties processes to the session
    expect([...select(rows, { markers }).targets.keys()]).toEqual([3000]);
  });

  it('a remembered descendant counts only while it is the same orphaned process (start time + command line)', () => {
    const rows = [...base, row(4000, 1, 4000), row(4001, 1, 4001, { start: 'Mon Sep 28 10:00:09 2026' }), row(4002, 1, 4002, { command: 'another program' }), row(4003, 777, 4003)];
    const known = new Map([
      [4000, { start: 'Mon Sep 28 10:00:00 2026', command: 'cmd-4000' }],
      [4001, { start: 'Mon Sep 28 10:00:00 2026', command: 'cmd-4001' }], // the old job died; a new process got its pid
      [4002, { start: 'Mon Sep 28 10:00:00 2026', command: 'cmd-4002' }], // same second, other program: not ours
      [4003, { start: 'Mon Sep 28 10:00:00 2026', command: 'cmd-4003' }], // not an orphan: someone else's child now
      [1000, { start: 'Mon Sep 28 10:00:00 2026', command: 'cmd-1000' }], // the daemon itself: never
    ]);
    expect([...select(rows, { known }).targets.keys()]).toEqual([4000]);
    const tree = [...base, row(2000, 1000, 2000), row(2001, 2000, 2001), row(2002, 2001, 2001), row(2003, 1, 2003)];
    expect([...rememberDescendants(tree, 2000, SELF, UID, 10).keys()].sort()).toEqual([2001, 2002]);
    expect(rememberDescendants(tree, 2000, SELF, UID, 1).size).toBe(1);
    expect(rememberDescendants(tree, 2000, 4242, UID, 10).size).toBe(0); // the root is not our child: nothing
  });

  it('aborts without signalling anything when the set is implausibly large (pid cap)', async () => {
    const rows = [...base, row(2000, 1000, 2000)];
    for (let i = 0; i < 40; i++) rows.push(row(3000 + i, 2000, 2000));
    const signalled: number[] = [];
    const log = createMemoryLogger();
    const inspector: ProcessInspector = { table: async () => rows, withEnvEntry: async () => new Map() };
    const result = await killTree({ rootPid: () => 2000, envEntry: 'SMURG_SESSION_ID=ses_x' }, { inspector, log, signal: (pid) => signalled.push(pid), maxPids: 10, selfPid: SELF, uid: UID });
    expect(result).toMatchObject({ outcome: 'aborted', reason: 'pid-cap' });
    expect(signalled).toEqual([]);
    expect(log.lines.some((line) => line.level === 'error' && line.message.includes('implausible'))).toBe(true);
  });

  it('aborts when the daemon is not in the process table (fail closed)', async () => {
    const signalled: number[] = [];
    const inspector: ProcessInspector = { table: async () => [row(2000, 1, 2000)], withEnvEntry: async () => new Map([[2000, id(row(2000, 1, 2000))]]) };
    const result = await killTree({ rootPid: () => 2000, envEntry: 'x' }, { inspector, log: createMemoryLogger(), signal: (pid) => signalled.push(pid), selfPid: SELF, uid: UID });
    expect(result).toMatchObject({ outcome: 'aborted', reason: 'self-not-in-table' });
    expect(signalled).toEqual([]);
  });

  it('CLI-06: a process exit in the middle of a kill never leaves processes stopped: frozen ones are killed, unverified ones continued', async () => {
    const rows = [...base, row(2000, 1000, 2000), row(2001, 2000, 2001)];
    const signals: string[] = [];
    let scans = 0;
    let releaseScan: () => void = () => {};
    const blocked = new Promise<void>((resolve) => {
      releaseScan = resolve;
    });
    const inspector: ProcessInspector = {
      table: async () => {
        scans++;
        if (scans === 2) await blocked; // the verification scan after the SIGSTOPs: the daemon exits meanwhile
        return rows;
      },
      withEnvEntry: async () => new Map(),
    };
    const running = killTree({ rootPid: () => 2000, envEntry: 'x' }, { inspector, log: createMemoryLogger(), selfPid: SELF, uid: UID, signal: (pid, signal) => signals.push(`${signal}:${pid}`) });
    await waitUntilTrue(() => signals.length === 2);
    expect(signals.sort()).toEqual(['SIGSTOP:2000', 'SIGSTOP:2001']);
    expect([...stoppedProcesses().entries()].sort()).toEqual([
      [2000, 'stopped'],
      [2001, 'stopped'],
    ]);
    // process.exit() runs the 'exit' hook: stopped but not yet verified → continued (as killTree would have).
    expect(process.listeners('exit')).toContain(releaseStoppedProcesses);
    releaseStoppedProcesses();
    expect(signals.slice(2).sort()).toEqual(['SIGCONT:2000', 'SIGCONT:2001']);
    expect(stoppedProcesses().size).toBe(0);
    releaseScan();
    await running;
  });

  it('CLI-06: a process confirmed frozen by the second scan is killed by the exit hook', async () => {
    let rows = [...base, row(2000, 1000, 2000)];
    const signals: string[] = [];
    let scans = 0;
    let releaseScan: () => void = () => {};
    const blocked = new Promise<void>((resolve) => {
      releaseScan = resolve;
    });
    const inspector: ProcessInspector = {
      table: async () => {
        scans++;
        // 2000 forked 2001 just before it was stopped: the second scan confirms 2000 and finds 2001 (stopped next).
        if (scans === 2) rows = [...rows, row(2001, 2000, 2000)];
        if (scans === 3) await blocked; // verifying 2001: the daemon exits meanwhile
        return rows;
      },
      withEnvEntry: async () => new Map(),
    };
    const running = killTree({ rootPid: () => 2000, envEntry: 'x' }, { inspector, log: createMemoryLogger(), selfPid: SELF, uid: UID, signal: (pid, signal) => signals.push(`${signal}:${pid}`) });
    await waitUntilTrue(() => signals.includes('SIGSTOP:2001'));
    expect([...stoppedProcesses().entries()].sort()).toEqual([
      [2000, 'frozen'],
      [2001, 'stopped'],
    ]);
    releaseStoppedProcesses();
    expect(signals.slice(2).sort()).toEqual(['SIGCONT:2001', 'SIGKILL:2000']);
    expect(stoppedProcesses().size).toBe(0);
    releaseScan();
    await running;
  });

  it('a verification scan that fails undoes the stops it cannot verify (never a frozen process left behind)', async () => {
    const rows = [...base, row(2000, 1000, 2000)];
    const signals: string[] = [];
    let scans = 0;
    const inspector: ProcessInspector = {
      table: async () => {
        scans++;
        if (scans === 2) throw new Error('ps failed');
        return rows;
      },
      withEnvEntry: async () => new Map(),
    };
    await killTree({ rootPid: () => 2000, envEntry: 'x' }, { inspector, log: createMemoryLogger(), selfPid: SELF, uid: UID, deadlineMs: 200, signal: (pid, signal) => signals.push(`${signal}:${pid}`) });
    expect(signals.slice(0, 2)).toEqual(['SIGSTOP:2000', 'SIGCONT:2000']);
    expect(stoppedProcesses().size).toBe(0);
  });

  it('freezes the tree (SIGSTOP), verifies identities in a second scan, then SIGKILLs; a pid reused in between is continued, never killed', async () => {
    let rows = [...base, row(2000, 1000, 2000), row(2001, 2000, 2001), row(2002, 2000, 2002)];
    const signals: string[] = [];
    let scans = 0;
    const inspector: ProcessInspector = {
      table: async () => {
        scans++;
        // Between the first scan and the stop, 2002 exited and a stranger got its pid.
        if (scans === 2) rows = rows.map((r) => (r.pid === 2002 ? row(2002, 1, 2002, { command: 'a stranger' }) : r));
        return rows;
      },
      withEnvEntry: async () => new Map(),
    };
    const result = await killTree(
      { rootPid: () => (rows.some((r) => r.pid === 2000) ? 2000 : null), envEntry: 'x' },
      {
        inspector,
        log: createMemoryLogger(),
        selfPid: SELF,
        uid: UID,
        signal: (pid, signal) => {
          signals.push(`${signal}:${pid}`);
          if (signal === 'SIGKILL') rows = rows.filter((r) => r.pid !== pid);
        },
      },
    );
    expect(result.outcome).toBe('done');
    expect(result.continued).toEqual([2002]);
    expect(signals).toEqual(expect.arrayContaining(['SIGSTOP:2000', 'SIGSTOP:2001', 'SIGKILL:2000', 'SIGKILL:2001', 'SIGSTOP:2002', 'SIGCONT:2002']));
    expect(signals).not.toContain('SIGKILL:2002');
    expect(signals.indexOf('SIGSTOP:2001')).toBeLessThan(signals.indexOf('SIGKILL:2000')); // the whole tree is frozen first
    expect(signals.some((s) => /:(1|900|1000|1001)$/.test(s))).toBe(false);
  });

  it('parses ps output and reads the env marker from the environment, never from the arguments', () => {
    expect(parseProcessTable('  1     0     1     0 Ss\n 2000  1000  2000   501 S+\n 2001  2000  2000   501 Z\ngarbage\n')).toEqual([
      { pid: 1, ppid: 0, pgid: 1, uid: 0, zombie: false },
      { pid: 2000, ppid: 1000, pgid: 2000, uid: 501, zombie: false },
      { pid: 2001, ppid: 2000, pgid: 2000, uid: 501, zombie: true },
    ]);
    expect(parseProcessTable(' 7 1 7 501 S    Mon Sep  8 13:50:05 2026    /bin/sleep  100\n')).toEqual([
      { pid: 7, ppid: 1, pgid: 7, uid: 501, zombie: false, start: 'Mon Sep  8 13:50:05 2026', command: '/bin/sleep  100' },
    ]);
    const entry = 'SMURG_SESSION_ID=ses_abc';
    const t = 'Mon Sep 28 10:00:00 2026';
    const plain = [` 10 501 ${t} node server.js`, ` 11 501 ${t} grep SMURG_SESSION_ID=ses_abc`, ` 12 0 ${t} node other.js`, ` 13 501 ${t} node x`, ` 14 501 ${t} node y`].join('\n');
    const withEnv = [
      ` 10 501 ${t} node server.js PATH=/bin ${entry} HOME=/h`,
      ` 11 501 ${t} grep SMURG_SESSION_ID=ses_abc PATH=/bin`,
      ` 12 0 ${t} node other.js ${entry}`,
      ` 13 501 ${t} node x SMURG_SESSION_ID=ses_abcd`,
      ` 14 501 Mon Sep 28 10:00:01 2026 node y ${entry}`, // not the process the plain scan saw
    ].join('\n');
    expect([...envEntryPidsFromPs(plain, withEnv, entry, 501).keys()]).toEqual([10]);
  });
});

describe('login state', () => {
  it('claude auth status --json decides; everything unclear is unknown', () => {
    expect(parseAuthStatus({ code: 0, stdout: '{"loggedIn":true,"authMethod":"claude.ai"}', timedOut: false })).toBe('logged-in');
    expect(parseAuthStatus({ code: 1, stdout: '{"loggedIn":false,"authMethod":"none"}\n', timedOut: false })).toBe('logged-out');
    expect(parseAuthStatus({ code: 0, stdout: 'garbage', timedOut: false })).toBe('unknown');
    expect(parseAuthStatus({ code: null, stdout: '', timedOut: true })).toBe('unknown');
    expect(parseAuthStatus({ code: 1, stdout: '{"loggedIn":true}', timedOut: false })).toBe('unknown');
  });

  it('TUI hints are matched without whitespace and escape sequences, once per occurrence', () => {
    const detector = new LoginHintDetector();
    expect(detector.push(enc('\x1b[1mLogin\x1b[0m \x1b[2Gsucc'))).toBe(false);
    expect(detector.push(enc('essful'))).toBe(true);
    expect(detector.push(enc('more output'))).toBe(false);
  });
});
