// Rows G11 and G12 of the tool gate ON THE HOOK SOCKET (DESIGN 0.6.0 D10), and G10 while a process runs without
// asking: the real hook server, asked as `smurg hook` asks it, with a real folder on disk and the real PathGuard. What
// auto mode would run without asking anyone: in the main workspace a shell write of a file only the host may change
// asks the host when a teammate's session runs it (G11a), a shell write of a file someone is typing in is refused
// (G11b); a teammate's session that writes outside its own folder asks the host (G12). Only while Claude Code RUNS the
// process in auto mode (the registration's `claudeMode`, kept current by the runner): in the ask modes Claude Code
// asks before every shell write itself, in "Asks for nothing" the host chose no check.
import { mkdir, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { MAIN_ROOT, rootRefKey, type RootRef } from '@smurg/protocol';
import { buildHookRegistration } from '../../src/core/fakes/build.ts';
import type { FeatureModule } from '../../src/core/context.ts';
import type { ClaudeMode, DaemonEvents, ProjectTrust } from '../../src/core/interfaces.ts';
import { toDisposable } from '../../src/core/lifecycle.ts';
import { BASH_ASK_REASONS, bashWhileTypingReason } from '../../src/hooks/deny-text.ts';
import { HookServerImpl } from '../../src/hooks/hook-server.ts';
import { hooksModule } from '../../src/hooks/module.ts';
import { GATE_ASKS_WHEN_UNSURE } from '../../src/hooks/tool-gate.ts';
import { TEST_HOST_USER, createTempDir, createTestDaemon, removeTempDir, type TestDaemon } from '../../src/testing/index.ts';
import { fakeServices, type FakeServices } from './fakes.ts';
import { hookRequest } from './helpers.ts';

let t: TestDaemon | null = null;
const dirs: string[] = [];
afterEach(async () => {
  await t?.cleanup();
  t = null;
  for (const dir of dirs.splice(0)) await removeTempDir(dir);
});

const IAN = { userId: 'dev:ian', displayName: 'Ian' };
const AMY = { userId: 'dev:amy', displayName: 'Amy' };

interface Rig {
  readonly t: TestDaemon;
  readonly hooks: HookServerImpl;
  readonly fakes: FakeServices;
  readonly root: string;
  readonly home: string;
  readonly worktree: string;
  readonly other: string;
  readonly recorded: Map<string, Set<string>>;
  readonly gate: DaemonEvents['agent.tool.gate'][];
  /** A session registered as the sessions module registers one, its process in `claudeMode`. */
  session(options: { readonly owner?: typeof IAN; readonly root?: RootRef; readonly claudeMode?: ClaudeMode; readonly purpose?: 'free' | 'item' }): { readonly sessionId: string; readonly token: string };
  /** The gate's answer to a Bash PreToolUse: null (no output), `ask: <which>`, `deny: <reason>`. */
  bash(token: string, command: string, cwd?: string): Promise<string | null>;
}

async function rig(): Promise<Rig> {
  const base = await createTempDir('auto-gate');
  dirs.push(base);
  const home = await realpath(await mkdir(join(base, 'home'), { recursive: true }).then(() => join(base, 'home')));
  const recorded = new Map<string, Set<string>>();
  const trust = { protectedPaths: (root: RootRef) => recorded.get(rootRefKey(root)) ?? new Set<string>() } as unknown as ProjectTrust;
  const trustModule: FeatureModule = { name: 'fake-trust', create: () => ({ projectTrust: trust }), register: () => toDisposable(() => {}) };
  const fakes = fakeServices();
  t = await createTestDaemon({
    modules: [fakes.module, trustModule, hooksModule],
    sessions: { hostHome: home },
    project: { files: { 'README.md': '#\n', 'CLAUDE.md': '# rules\n', 'notes.md': 'notes\n', 'docs/CLAUDE.md': '# docs rules\n', 'docs/guide.md': 'guide\n', 'src/app.ts': 'export {};\n', 'scripts/lint.sh': '#!/bin/sh\n', 's3/lint.sh': '#!/bin/sh\n' } },
  });
  await t.connectHost();
  await t.connect({ ...IAN, role: 'agent' });
  const hooks = t.ctx.services.hooks;
  if (!(hooks instanceof HookServerImpl)) throw new Error('the hooks slot is not the HookServerImpl');
  const root = t.root;
  const worktree = join(root, '.smurg', 'worktrees', 'wt_one');
  const other = join(root, '.smurg', 'worktrees', 'wt_two');
  for (const dir of [worktree, other]) {
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'a.txt'), 'a\n');
    await writeFile(join(dir, 'CLAUDE.md'), '# rules\n');
  }
  await t.ctx.roots.registerWorktree({ worktreeId: 'wt_one', dir: worktree, ownerUserId: IAN.userId, sharedLinks: [] });
  await t.ctx.roots.registerWorktree({ worktreeId: 'wt_two', dir: other, ownerUserId: IAN.userId, sharedLinks: [] });
  const gate: DaemonEvents['agent.tool.gate'][] = [];
  t.ctx.bus.on('agent.tool.gate', (event) => gate.push(event));
  let seq = 0;
  const daemon = t;
  return {
    t: daemon,
    hooks,
    fakes,
    root,
    home,
    worktree,
    other,
    recorded,
    gate,
    session: (options) => {
      const owner = options.owner ?? IAN;
      const sessionId = `ses_auto_${++seq}`;
      const root = options.root ?? MAIN_ROOT;
      const credentials = hooks.registerSession(
        buildHookRegistration({
          sessionId,
          ownerUserId: owner.userId,
          agentName: `Claude (${owner.displayName})`,
          root,
          purpose: options.purpose ?? 'free',
          ...(options.purpose === 'item' ? { topic: { id: 'tp_1', slug: 'checkout' }, itemId: 'cart-api' } : {}),
          pathRights: owner.userId === TEST_HOST_USER ? 'host' : 'member',
          claudeMode: options.claudeMode ?? 'auto',
        }),
      );
      return { sessionId, token: credentials.token };
    },
    bash: async (token, command, cwd) => {
      const reply = await hookRequest(hooks.socketPath, token, { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_use_id: `toolu_auto_${++seq}`, cwd: cwd ?? root, tool_input: { command, description: 'run' } });
      const output = reply['hookOutput'] as { hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string } } | null;
      if (output === null) return null;
      const decision = output.hookSpecificOutput?.permissionDecision;
      const reason = output.hookSpecificOutput?.permissionDecisionReason ?? '';
      if (decision === 'deny') return `deny: ${reason}`;
      const name = Object.entries(BASH_ASK_REASONS).find(([, text]) => text === reason)?.[0];
      return `${decision ?? '?'}: ${name ?? reason}`;
    },
  };
}

const HOST = { userId: TEST_HOST_USER, displayName: 'Host' };

describe('the tool gate in auto mode (DESIGN 0.6.0 D10, rows G11 and G12), on the hook socket', { timeout: 60_000 }, () => {
  it('G11a: a teammate\'s session in the main workspace asks the HOST before a shell write of a file only the host may change, or of a folder that holds one; the host\'s own session does not', async () => {
    const r = await rig();
    const ians = r.session({});
    for (const command of ['echo x >> CLAUDE.md', 'rm -rf docs', 'printf x > .claude/settings.json', 'mv README.md .smurg/x', 'cp README.md docs/CLAUDE.md', 'touch .git/hooks/post-checkout', 'rm -rf .']) {
      expect(await r.bash(ians.token, command), command).toBe('ask: writesHostOnly');
    }
    // Writes of ordinary files, and commands that only read, are auto mode's own to decide.
    for (const command of ['echo x >> notes.md', 'rm src/app.ts', 'mkdir build', 'cat CLAUDE.md', 'grep -r rules .', 'npm test']) expect(await r.bash(ians.token, command), command).toBeNull();
    // From another directory, under another spelling: as the file system has it.
    expect(await r.bash(ians.token, 'echo x >> ../CLAUDE.md', join(r.root, 'docs'))).toBe('ask: writesHostOnly');
    expect(await r.bash(ians.token, 'echo x >> ./docs/../claude.md')).toBe('ask: writesHostOnly');
    const hosts = r.session({ owner: HOST });
    for (const command of ['echo x >> CLAUDE.md', 'rm -rf docs']) expect(await r.bash(hosts.token, command), command).toBeNull();
    // Asking is no refusal: nothing for the audit's gate rows.
    expect(r.gate).toEqual([]);
  });

  it('G11b: a shell write of a file someone is typing in (or of a folder that holds one) is REFUSED for every session, naming who types; the bus has row G11 with the call\'s id', async () => {
    const r = await rig();
    r.fakes.locks.touchHuman({ root: MAIN_ROOT, path: 'notes.md' }, AMY);
    r.fakes.locks.touchHuman({ root: MAIN_ROOT, path: 'docs/guide.md' }, IAN);
    r.fakes.locks.touchHuman({ root: MAIN_ROOT, path: 'docs/guide.md' }, AMY);
    const hosts = r.session({ owner: HOST });
    const ians = r.session({});
    for (const session of [hosts, ians]) {
      expect(await r.bash(session.token, 'rm notes.md')).toBe(`deny: ${bashWhileTypingReason(['Amy'], 'notes.md')}`);
      expect(await r.bash(session.token, 'echo x >> NOTES.md')).toBe(`deny: ${bashWhileTypingReason(['Amy'], 'notes.md')}`);
      expect(await r.bash(session.token, 'rm -rf docs')).toBe(`deny: ${bashWhileTypingReason(['Ian', 'Amy'], 'docs/guide.md')}`);
      expect(await r.bash(session.token, 'cat notes.md')).toBeNull();
    }
    expect(bashWhileTypingReason(['Amy'], 'notes.md')).toBe('Refused by smurg: Amy is typing in notes.md. Wait for the lock with mcp__smurg__wait_for_lock, then try again, or leave that file alone.');
    expect(bashWhileTypingReason(['Ian', 'Amy'], 'docs/guide.md')).toBe('Refused by smurg: Ian, Amy are typing in docs/guide.md. Wait for the lock with mcp__smurg__wait_for_lock, then try again, or leave that file alone.');
    expect(r.gate).toHaveLength(6);
    expect(r.gate[0]).toEqual({ sessionId: hosts.sessionId, tool: 'Bash', row: 'G11', path: 'notes.md', toolUseId: expect.stringMatching(/^toolu_auto_/) });
    // Nobody types any more: auto mode decides again.
    r.fakes.locks.leaveHuman({ root: MAIN_ROOT, path: 'notes.md' }, AMY.userId);
    expect(await r.bash(hosts.token, 'rm notes.md')).toBeNull();
  });

  it('G12: a teammate\'s session asks the HOST before a shell write outside its own folder (the host\'s home, the main folder, another checkout), not in the temporary folders; the host\'s own sessions do not ask', async () => {
    const r = await rig();
    const item = r.session({ root: { kind: 'worktree', worktreeId: 'wt_one' }, purpose: 'item' });
    for (const command of ['echo x >> ~/notes.txt', `echo x >> ${join(r.home, '.zshrc')}`, `echo x >> ${join(r.root, 'README.md')}`, 'echo tampered >> ../wt_two/a.txt', `cp a.txt ${r.root}/src/`]) {
      expect(await r.bash(item.token, command, r.worktree), command).toBe('ask: writesOutside');
    }
    // Its own checkout (CLAUDE.md included: the merge review covers it, G11 does not run in a worktree), and scratch files.
    const scratch = join(await realpath(tmpdir()), 'smurg-auto-gate-scratch.txt');
    for (const command of ['echo x >> a.txt', 'echo x >> CLAUDE.md', 'rm -rf build', 'echo x > /tmp/x.txt', `echo x > ${scratch}`, 'echo x > /private/tmp/y.txt', 'npm test 2>/dev/null', 'ls > /dev/stderr', 'echo done > /dev/fd/2']) {
      expect(await r.bash(item.token, command, r.worktree), command).toBeNull();
    }
    // A target smurg cannot read (`$TMPDIR` is a variable here) is the next test's case.
    expect(await r.bash(item.token, 'echo x > "$TMPDIR/x.txt"', r.worktree)).toBe(GATE_ASKS_WHEN_UNSURE ? 'ask: unsureAuto' : null);
    // A teammate's free session in the main workspace: outside the shared folder asks; inside it is G11's.
    const ians = r.session({});
    expect(await r.bash(ians.token, 'echo x >> ~/notes.txt')).toBe('ask: writesOutside');
    expect(await r.bash(ians.token, 'echo x >> notes.md')).toBeNull();
    // The host's own sessions, in a worktree and in the main workspace: their reach is the host's to set.
    const hostsItem = r.session({ owner: HOST, root: { kind: 'worktree', worktreeId: 'wt_two' }, purpose: 'item' });
    const hosts = r.session({ owner: HOST });
    expect(await r.bash(hostsItem.token, 'echo x >> ~/notes.txt', r.other)).toBeNull();
    expect(await r.bash(hostsItem.token, `echo x >> ${join(r.root, 'README.md')}`, r.other)).toBeNull();
    expect(await r.bash(hosts.token, 'echo x >> ~/notes.txt')).toBeNull();
  });

  it(`a command whose writes smurg cannot follow asks the host for a teammate's session while GATE_ASKS_WHEN_UNSURE is ${String(GATE_ASKS_WHEN_UNSURE)} (DESIGN R4: Claude Code 2.1.288 runs a variable's target with no check); the host's own session is not asked`, async () => {
    const r = await rig();
    const ians = r.session({});
    const item = r.session({ root: { kind: 'worktree', worktreeId: 'wt_one' }, purpose: 'item' });
    const hosts = r.session({ owner: HOST });
    const expected = GATE_ASKS_WHEN_UNSURE ? 'ask: unsureAuto' : null;
    expect(GATE_ASKS_WHEN_UNSURE).toBe(true);
    for (const command of ['F=CLAUDE.md; rm "$F"', 'G=CLAUDE.md && echo x >> "$G"', 'rm $(cat list.txt)', 'sh -c "$X"', 'xargs rm < list.txt']) {
      expect(await r.bash(ians.token, command), command).toBe(expected);
      expect(await r.bash(item.token, command, r.worktree), command).toBe(expected);
      expect(await r.bash(hosts.token, command), command).toBeNull();
    }
    // What smurg CAN read is not asked about because of the rule.
    expect(await r.bash(ians.token, 'npm test && echo done > out.txt')).toBeNull();
  });

  it('only while the process RUNS in auto mode: not in the ask modes (Claude Code asks), not in "Asks for nothing" (the host chose no check); the registration follows what the process reports', async () => {
    const r = await rig();
    r.fakes.locks.touchHuman({ root: MAIN_ROOT, path: 'notes.md' }, AMY);
    for (const claudeMode of ['default', 'acceptEdits', 'bypassPermissions'] as const) {
      const main = r.session({ claudeMode });
      const item = r.session({ claudeMode, root: { kind: 'worktree', worktreeId: 'wt_one' }, purpose: 'item' });
      for (const command of ['echo x >> CLAUDE.md', 'rm notes.md', 'echo x >> ~/notes.txt']) expect(await r.bash(main.token, command), `${claudeMode} ${command}`).toBeNull();
      expect(await r.bash(item.token, 'echo x >> ~/notes.txt', r.worktree), claudeMode).toBeNull();
    }
    // The runner tells the hook server what Claude Code reported: from the next call on, the rows apply.
    const ians = r.session({ claudeMode: 'default' });
    expect(await r.bash(ians.token, 'echo x >> CLAUDE.md')).toBeNull();
    r.hooks.updateSession(ians.sessionId, { claudeMode: 'auto' });
    expect(await r.bash(ians.token, 'echo x >> CLAUDE.md')).toBe('ask: writesHostOnly');
    r.hooks.updateSession(ians.sessionId, { claudeMode: 'acceptEdits' });
    expect(await r.bash(ians.token, 'echo x >> CLAUDE.md')).toBeNull();
    // A mode no registration may name is not taken.
    r.hooks.updateSession(ians.sessionId, { claudeMode: 'plan' as ClaudeMode });
    expect(await r.bash(ians.token, 'echo x >> CLAUDE.md')).toBeNull();
    expect(() => r.hooks.registerSession(buildHookRegistration({ sessionId: 'ses_bad_mode', ownerUserId: IAN.userId, agentName: 'Claude (Ian)', root: MAIN_ROOT, claudeMode: 'dontAsk' as ClaudeMode }))).toThrow();
  });

  it('G10 is not asked while the process runs without asking ("Asks for nothing": every command already runs as the host); in every other mode it asks as before', async () => {
    const r = await rig();
    r.recorded.set(rootRefKey(MAIN_ROOT), new Set(['scripts/lint.sh']));
    for (const claudeMode of ['default', 'acceptEdits', 'auto'] as const) {
      const hosts = r.session({ owner: HOST, claudeMode });
      expect(await r.bash(hosts.token, 'cp s3/lint.sh scripts/'), claudeMode).toBe('ask: writes');
    }
    const bypass = r.session({ owner: HOST, claudeMode: 'bypassPermissions' });
    expect(await r.bash(bypass.token, 'cp s3/lint.sh scripts/')).toBeNull();
  });
});
