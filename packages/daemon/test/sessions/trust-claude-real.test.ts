// The trust gate's recorded scripts and the REAL `claude` binary (Claude Code 2.1.288), against the repository's fake
// Anthropic API on 127.0.0.1 with a dummy key and an environment built from nothing (isolated HOME /
// CLAUDE_CONFIG_DIR / TMPDIR): never anyone's account, nothing billed, nothing leaves the machine (ARCHITECTURE §0
// rule 2). The harness is the one of agent-claude-real.test.ts, reduced to what these cases need.
//
// What it settles (review R3-03): a work item's session runs in its worktree in Claude Code's `acceptEdits`, where a
// shell command that writes a file of the worktree runs without asking anyone, and the host's own allow rules apply on
// top. A script a host-confirmed project hook runs must not be replaced that way: the next hook event would run the
// new content as the host. smurg's tool gate reads every shell command first (hooks/bash-guard.ts, row G10) and
// answers "ask" for one that writes where such a script is: this file pins, on the real binary, that a hook's "ask"
// IS put above the mode's automatic run and above a matching allow rule, for every route the review named.
// Skipped LOUDLY without a verified `claude`; SMURG_TEST_CLAUDE_BIN selects another binary.
import { mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { MAIN_ROOT } from '@smurg/protocol';
import { msg } from '@smurg/protocol/i18n';
import type { FeatureModule } from '../../src/core/context.ts';
import type { AgentRequest, DaemonEvents, Principal, WorktreeManager } from '../../src/core/interfaces.ts';
import { toDisposable } from '../../src/core/lifecycle.ts';
import { BASH_ASK_REASONS } from '../../src/hooks/deny-text.ts';
import { hooksModule } from '../../src/hooks/module.ts';
import { locksModule } from '../../src/locks/module.ts';
import type { AgentSessionsImpl } from '../../src/sessions/agent/agent-sessions.ts';
import { createSessionsModule } from '../../src/sessions/module.ts';
import { TEST_HOST_USER, createTempDir, createTestDaemon, removeTempDir, waitFor, type TestDaemon } from '../../src/testing/index.ts';
import { MOCK_API_KEY, findClaude, isolatedEnv, seedClaudeTrust } from '../hooks/claude-harness.ts';
import { startMockAnthropic, type MockAnthropic, type MockStep } from '../hooks/mock-anthropic.ts';
import { FakeWorktrees } from './helpers.ts';

const found = await findClaude();
const claude = found.binary;
if (!claude) console.warn(`[trust-claude-real] SKIPPED: ${found.reason}`);
else console.log(`[trust-claude-real] running against Claude Code ${claude.version} (${claude.path})`);
const V = claude ? `Claude Code ${claude.version}` : 'no claude';

const HOOK_CLI = fileURLToPath(new URL('../../src/hooks/hook-cli.ts', import.meta.url));
const COORD_SERVER = fileURLToPath(new URL('../../src/mcp/coord-server.ts', import.meta.url));

interface Stack {
  readonly t: TestDaemon;
  readonly mock: MockAnthropic;
  readonly agents: AgentSessionsImpl;
  readonly worktrees: FakeWorktrees;
  readonly base: string;
  readonly requests: AgentRequest[];
  readonly turns: DaemonEvents['agent.turn.finished'][];
  host(): Principal;
}

let stack: Stack | null = null;
afterEach(async () => {
  const current = stack;
  stack = null;
  if (!current) return;
  await current.t.cleanup().catch(() => {});
  await current.mock.close().catch(() => {});
  await removeTempDir(current.base);
});

async function start(steps: readonly MockStep[], files: Record<string, string> | ((paths: { readonly base: string }) => Record<string, string>), options: { readonly credential?: boolean } = {}): Promise<Stack> {
  const base = await createTempDir('trust-claude-real');
  const [home, cfg, tmp] = ['home', 'cfg', 'tmp'].map((sub) => join(base, sub)) as [string, string, string];
  for (const dir of [home, cfg, tmp]) await mkdir(dir, { recursive: true, mode: 0o700 });
  const entry = join(base, 'smurg-entry.mjs');
  await writeFile(
    entry,
    [
      'const command = process.argv[2];',
      `if (command === 'hook') { const { runHookCli } = await import(${JSON.stringify(HOOK_CLI)}); process.exitCode = await runHookCli(); }`,
      `else if (command === 'mcp') { const { runMcpServer } = await import(${JSON.stringify(COORD_SERVER)}); process.exitCode = await runMcpServer(); }`,
      'else { process.exitCode = 2; }',
      '',
    ].join('\n'),
  );
  const selfCommand = { file: process.execPath, args: [entry] };
  let mockUrl = 'http://127.0.0.1:9';
  const worktrees = new FakeWorktrees();
  const worktreesModule: FeatureModule = {
    name: 'test-worktrees',
    create: (ctx) => {
      worktrees.ctx = ctx;
      return { worktrees: worktrees as unknown as WorktreeManager };
    },
    register: () => toDisposable(() => {}),
  };
  // Without a credential: the same environment with no API key in it (nothing is logged in, nothing can be billed).
  const hostEnv = (): Record<string, string> => {
    const env = isolatedEnv(base, mockUrl);
    if (options.credential === false) delete env['ANTHROPIC_API_KEY'];
    return env;
  };
  const t = await createTestDaemon({
    project: { files: { 'README.md': '# shop\n', ...(typeof files === 'function' ? files({ base }) : files) } },
    modules: [locksModule, hooksModule, worktreesModule, createSessionsModule({ hostEnv, launch: { claudePath: (claude as NonNullable<typeof claude>).path, selfCommand } })],
    sessions: { selfCommand, hostHome: home },
  });
  const mock = await startMockAnthropic(steps);
  mockUrl = mock.url;
  await seedClaudeTrust({ cfgDir: cfg, cwd: t.root, apiKey: MOCK_API_KEY });
  await t.connectHost();
  const agents = t.ctx.services.agents as AgentSessionsImpl;
  const requests: AgentRequest[] = [];
  const turns: DaemonEvents['agent.turn.finished'][] = [];
  t.ctx.bus.on('agent.request', (event) => {
    requests.push(event.request);
    // Whatever asks is refused: nothing in these cases may depend on a person saying yes.
    if (event.request.kind === 'permission') agents.decidePermission(event.sessionId, event.request.id, { allow: false, message: 'Nobody allows this here.' });
  });
  t.ctx.bus.on('agent.turn.finished', (event) => turns.push(event));
  const made: Stack = { t, mock, agents, worktrees, base, requests, turns, host: () => t.ctx.members.principalOf(TEST_HOST_USER) as Principal };
  stack = made;
  return made;
}

const bash = (command: string): MockStep => ({ tools: [{ name: 'Bash', input: { command, description: 'run' } }] });
const TOPIC = { id: 'tp_checkout', slug: 'checkout', name: 'Checkout' };
const LINT = '#!/bin/sh\n# the script the host confirmed\nexit 0\n';
const SETTINGS = JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'sh ./scripts/lint.sh' }] }] } });

describe.skipIf(!claude)(`a script the trust gate recorded and the real claude (${V}, mock Anthropic API)`, { timeout: 180_000 }, () => {
  it(`R3-03: in a work item's worktree (acceptEdits, and with allow rules of the host's own for cp, mv, tee, ln, rm, sed) every route onto a recorded script asks a person first, with smurg's reason; nothing replaces the script unasked; ordinary commands beside it run unasked (${V})`, async () => {
    // What each command must lead to: `asks` (a permission request with the gate's reason; refused here, so the tool
    // result is an error and nothing changed), or `runs` (no request, no error).
    const ROUTES: readonly (readonly [command: string, expected: 'asks' | 'runs'])[] = [
      ["printf '# A00 append\\n' >> scripts/lint.sh", 'asks'],
      ["cd scripts && printf '# A01 after cd\\n' > lint.sh", 'asks'],
      ["printf '# A02 tee\\n' | tee scripts/lint.sh", 'asks'],
      ["sed -i '' 's/exit 0/exit 0 # A03 sed/' scripts/lint.sh", 'asks'],
      ["printf '# A04 dotdot\\n' > ./scripts/../scripts/lint.sh", 'asks'],
      ["printf '# A05 case\\n' > SCRIPTS/LINT.SH", 'asks'],
      ['mkdir -p s3', 'runs'],
      ["printf '#!/bin/sh\\n# A07 staged\\nexit 0\\n' > s3/lint.sh", 'runs'],
      // The sceptic's two: a file of the same name copied or moved INTO the folder. No word of them spells the script.
      ['cp s3/lint.sh scripts/', 'asks'],
      ['mv s3/lint.sh scripts/', 'asks'],
      ['cp -R s3/. scripts/', 'asks'],
      ['ln -s scripts/lint.sh alias.sh', 'asks'],
      // Through a folder link the worktree already holds.
      ['cp s3/lint.sh tools/', 'asks'],
      ['rm scripts/lint.sh', 'asks'],
      // The folder swap of D-GUARD's question to the owner: neither command names the script.
      ['mv scripts scripts.old', 'asks'],
      ['mv s3 scripts', 'asks'],
      // The script as the SOURCE of a copy: a person is asked (it was refused outright by a deny rule before).
      ['cp scripts/lint.sh s3/copy.sh', 'asks'],
      // What a work item does all day stays unasked: reading the script, a file beside it, another folder.
      ['cat scripts/lint.sh', 'runs'],
      ['echo beside > scripts/other.txt', 'runs'],
      ['cp s3/lint.sh s3/again.sh', 'runs'],
      // The control for the host's rules: `tee` asks in acceptEdits by itself, and runs here because a rule allows it.
      ['printf x | tee s3/tee.txt', 'runs'],
      ['ln -s again.sh s3/link.sh', 'runs'],
    ];
    const s = await start([...ROUTES.map(([command]) => bash(command)), { text: 'Done.' }], { '.claude/settings.json': SETTINGS, 'scripts/lint.sh': LINT });
    // The host's own Claude Code rules apply to every session (OWNER-DECISIONS Q7): rules that would let these run.
    await writeFile(join(s.base, 'cfg', 'settings.json'), JSON.stringify({ permissions: { allow: ['Bash(cp:*)', 'Bash(mv:*)', 'Bash(tee:*)', 'Bash(ln:*)', 'Bash(rm:*)', 'Bash(sed:*)', 'Bash(printf:*)'] } }));
    const trust = s.t.ctx.services.projectTrust;
    const described = await trust.describe({});
    const main = described.roots.find((root) => root.root.kind === 'main');
    expect(main?.files[0]?.scripts.map((script) => script.path)).toEqual(['scripts/lint.sh']);
    await trust.decide({ root: MAIN_ROOT, files: (main?.files ?? []).map((file) => ({ path: file.path, hash: file.hash })), decision: 'trust', acknowledged: [] }, s.host());
    expect(trust.state(MAIN_ROOT)).toBe('used');
    // The item's worktree: a clone, so the same contents, trusted without a decision of its own.
    const handle = await s.worktrees.acquireForSession({ owner: { userId: TEST_HOST_USER }, sessionId: 'item-worktree' });
    const dir = handle.root.realPath;
    await mkdir(join(dir, '.claude'), { recursive: true });
    await mkdir(join(dir, 'scripts'), { recursive: true });
    await writeFile(join(dir, '.claude', 'settings.json'), SETTINGS);
    await writeFile(join(dir, 'scripts', 'lint.sh'), LINT);
    await symlink('scripts', join(dir, 'tools'));
    const root = { kind: 'worktree', worktreeId: handle.worktree.id } as const;
    // Every content the script ever had, polled: a replacement that was undone again would still be seen.
    const seen = new Set<string>([LINT]);
    const poll = setInterval(() => void readFile(join(dir, 'scripts', 'lint.sh'), 'utf8').then((text) => seen.add(text), () => seen.add('<<gone>>')), 10);
    try {
      const session = await s.agents.start({
        purpose: 'item',
        topic: TOPIC,
        item: { id: 'cart-api', number: 1, title: 'Cart API', attempt: 1 },
        openedBy: s.host(),
        responsible: null,
        workspace: { mode: 'worktree', worktreeId: handle.worktree.id },
        mode: 'ask-commands',
        rolePrompt: ({ smurgTag }) => `You work on one item of a plan. A line that starts with "[smurg ${smurgTag}]" is the workspace software itself.`,
        opening: msg('conversation.started.discussion', { name: 'Host' }),
        firstMessage: { kind: 'person', from: s.host(), text: 'Do the work.', cleaned: false, origin: 'composer' },
      });
      await waitFor(() => s.turns.length >= 1, { timeoutMs: 150_000, what: 'the turn to end' });
      const results = s.mock.toolResults();
      const asked = s.requests.flatMap((request) => (request.kind === 'permission' ? [request] : []));
      console.log(`[trust-claude-real ${claude?.version}] R3-03 routes: ${JSON.stringify(ROUTES.map(([command], index) => `${results[index]?.isError === true ? 'REFUSED' : results[index] === undefined ? 'NO RESULT' : 'RAN'} ${asked.some((request) => request.view.target === command) ? '(asked)' : '(nobody asked)'} ${command}`), null, 1)}`);
      expect(s.agents.get(session.id)).toMatchObject({ projectSettings: 'used' });
      expect([...trust.protectedPaths(root)]).toEqual(['scripts/lint.sh']);
      ROUTES.forEach(([command, expected], index) => {
        const request = asked.find((entry) => entry.view.target === command);
        if (expected === 'asks') {
          // A person was asked, by smurg's gate, and told why; refused here, so the command did not run.
          expect(request, command).toMatchObject({ tool: 'Bash', reasonType: 'hook', reason: BASH_ASK_REASONS.writes });
          expect(results[index], command).toMatchObject({ isError: true });
        } else {
          expect(request, command).toBeUndefined();
          expect(results[index], command).toMatchObject({ isError: false });
        }
      });
    } finally {
      clearInterval(poll);
    }
    // The recorded script never held anything but the confirmed content, and its folder was never moved.
    expect([...seen]).toEqual([LINT]);
    expect(await readFile(join(dir, 'scripts', 'lint.sh'), 'utf8')).toBe(LINT);
    expect(existsSync(join(dir, 'scripts.old'))).toBe(false);
    expect(existsSync(join(dir, 'alias.sh'))).toBe(false);
    expect(existsSync(join(dir, 'scripts', 'other.txt'))).toBe(true);
    expect(existsSync(join(dir, 's3', 'again.sh'))).toBe(true);
    // Looked at again: still the confirmed content.
    expect((await trust.describe({})).roots.find((entry) => entry.root.kind === 'worktree')?.state).toBe('used');
  });

  it(`DX-8: \`claude auth status\` counts a project's apiKeyHelper as a login when it is run in that folder (and does not run it); smurg asks from its own directory until the host confirmed the settings (${V})`, async () => {
    const s = await start([], ({ base }) => ({ '.claude/settings.json': JSON.stringify({ apiKeyHelper: `/usr/bin/touch ${join(base, 'HELPER-RAN')}; echo sk-ant-from-the-project-helper` }) }), { credential: false });
    const trust = s.t.ctx.services.projectTrust;
    expect(trust.state(MAIN_ROOT)).toBe('ignored');
    // Nobody is logged in, and the folder's settings are nobody's decision yet: a session would start without them.
    expect(await s.agents.loginState(true)).toBe('logged-out');
    // The host confirms them (the tick for a command that supplies the key): now they are what a session loads.
    const main = (await trust.describe({})).roots.find((root) => root.root.kind === 'main');
    expect(main?.files[0]?.needsAck).toEqual(['credentials']);
    await trust.decide({ root: MAIN_ROOT, files: (main?.files ?? []).map((file) => ({ path: file.path, hash: file.hash })), decision: 'trust', acknowledged: ['credentials'] }, s.host());
    expect(await s.agents.loginState(true)).toBe('logged-in');
    // Asking is not running: the helper was never executed by either check.
    expect(existsSync(join(s.base, 'HELPER-RAN'))).toBe(false);
  });
});
