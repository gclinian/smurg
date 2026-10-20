// Permission modes with the REAL `claude` (Claude Code 2.1.288; DESIGN 0.6.0 D8, D8a, D9, D10, D11, D22 and its rows
// R2–R6 and R8), against the repository's fake Anthropic API on 127.0.0.1 with a dummy key and its scripted classifier
// for auto mode, in an environment built from nothing (isolated HOME, CLAUDE_CONFIG_DIR = that home's `.claude`,
// TMPDIR, from claude-harness.ts): never anyone's account, nothing billed, nothing leaves the machine (ARCHITECTURE §0
// rule 2). The daemon is the real one with the real hook server (`smurg hook` is this package's own entry point, run
// through a stand-in of smurg's executable), the real lock manager and the sessions module.
//
//  R2  A work item in auto: the places beyond its folder (D8a: the main folder's `.git`, `.claude`, smurg's history,
//      the host's `~/.claude`, smurg's state folder and executable) are refused, spelled absolute or with `~`; its own
//      edits and commands run; `echo > f` takes the fast path (no classifier), `python3 -c …` runs after the
//      classifier allows, one it refuses is a line and an audit entry, the third refusal in a row asks a person.
//  R3  A teammate's session in auto (G11, G12): a shell write of CLAUDE.md asks the host, one of a file someone is typing
//      in is refused, a work item's write outside its folder asks the host.
//  R4  Commands smurg cannot read (a variable, a substitution) in the main workspace in auto: Claude Code's classifier
//      is asked about them (its fast path does not take them), which is why GATE_ASKS_WHEN_UNSURE is false.
//  R5  "Asks for nothing": the session starts in bypassPermissions with smurg's settings file, the places of D8a are
//      still refused; with the host's own `disableBypassPermissionsMode` Claude Code runs it in auto and smurg says so.
//  R6  Auto mode on Haiku (no auto mode): smurg's own fallback, said and shown; once the list is known, the start asks
//      before commands from the first turn.
//  R8  The process keeps the rules it started with after its `--settings` file was overwritten (an agent can reach
//      its own launch file without naming it): the gate's refusal and a deny rule still hold, seconds later.
//
// Skipped LOUDLY without a verified `claude`; SMURG_TEST_CLAUDE_BIN selects the binary.
import { existsSync } from 'node:fs';
import { chmod, mkdir, readFile, readdir, realpath, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { MAIN_ROOT, type AgentSession, type ConversationEvent } from '@smurg/protocol';
import type { FeatureModule } from '../../src/core/context.ts';
import type { AgentRequest, DaemonEvents, Principal, WorktreeManager } from '../../src/core/interfaces.ts';
import { toDisposable } from '../../src/core/lifecycle.ts';
import { BASH_ASK_REASONS } from '../../src/hooks/deny-text.ts';
import { hooksModule } from '../../src/hooks/module.ts';
import { sessionFilesDir } from '../../src/hooks/settings-writer.ts';
import { GATE_ASKS_WHEN_UNSURE } from '../../src/hooks/tool-gate.ts';
import { locksModule } from '../../src/locks/module.ts';
import type { AgentSessionsImpl } from '../../src/sessions/agent/agent-sessions.ts';
import { createSessionsModule } from '../../src/sessions/module.ts';
import { TEST_HOST_USER, createTempDir, createTestDaemon, removeTempDir, waitFor, type TestDaemon } from '../../src/testing/index.ts';
import { MOCK_API_KEY, findClaude, isolatedEnv, seedClaudeTrust } from '../hooks/claude-harness.ts';
import { startMockAnthropic, type ClassifierAnswer, type ClassifierRequest, type MockAnthropic, type MockOptions, type MockStep } from '../hooks/mock-anthropic.ts';
import { FakeWorktrees } from './helpers.ts';

const found = await findClaude();
const claude = found.binary;
if (claude === null) console.warn(`\n[modes-claude-real] SKIPPED: ${found.reason}\n`);
else console.log(`[modes-claude-real] running against Claude Code ${claude.version} (${claude.path})`);
const V = claude ? `Claude Code ${claude.version}` : 'no claude';

const HOOK_CLI = fileURLToPath(new URL('../../src/hooks/hook-cli.ts', import.meta.url));
const COORD_SERVER = fileURLToPath(new URL('../../src/mcp/coord-server.ts', import.meta.url));
const CAROL = { userId: 'dev:carol', displayName: 'Carol' };
const TOPIC = { id: 'tp_checkout', slug: 'checkout', name: 'Checkout' };

interface Launch {
  readonly pid: number;
  readonly args: readonly string[];
}

interface Stack {
  readonly t: TestDaemon;
  readonly mock: MockAnthropic;
  readonly agents: AgentSessionsImpl;
  readonly worktrees: FakeWorktrees;
  readonly base: string;
  /** The isolated home; its `.claude` is the CLAUDE_CONFIG_DIR. */
  readonly home: string;
  readonly cfg: string;
  /** The stand-in of smurg's executable (the gate's hooks run it). */
  readonly smurg: string;
  readonly requests: { sessionId: string; request: AgentRequest }[];
  readonly gate: DaemonEvents['agent.tool.gate'][];
  readonly turns: DaemonEvents['agent.turn.finished'][];
  host(): Principal;
  carol(): Promise<Principal>;
  path(rel: string): string;
  events(sessionId: string): Promise<ConversationEvent[]>;
  say(sessionId: string, text: string, from?: Principal): Promise<void>;
  turnsDone(count: number): Promise<void>;
  launches(): Promise<Launch[]>;
  audited(action: string): Promise<{ outcome: string; detail: Record<string, unknown> }[]>;
  /** A worktree the fake worktree manager made, trusted for Claude Code like the shared folder. */
  worktree(owner: Principal): Promise<{ readonly id: string; readonly dir: string }>;
}

let stack: Stack | null = null;
afterEach(async () => {
  const current = stack;
  stack = null;
  if (current) {
    await current.t.cleanup().catch(() => {});
    await current.mock.close().catch(() => {});
    await removeTempDir(current.base);
  }
});

interface Paths {
  readonly root: string;
  readonly home: string;
  readonly stateDir: string;
  readonly smurg: string;
}

async function start(
  steps: (paths: Paths) => readonly MockStep[],
  options: {
    readonly classifier?: (request: ClassifierRequest) => ClassifierAnswer;
    /** A conversation of its own script (MockOptions.route). */
    readonly route?: (paths: Paths) => NonNullable<MockOptions['route']>;
    readonly settings?: Record<string, unknown>;
    readonly hostSettings?: Record<string, unknown>;
  } = {},
): Promise<Stack> {
  const binary = claude as NonNullable<typeof claude>;
  const base = await createTempDir('modes-real');
  const [home, tmp, launches, bin] = ['home', 'tmp', 'launches', 'bin'].map((sub) => join(base, sub)) as [string, string, string, string];
  const cfg = join(home, '.claude');
  for (const dir of [home, cfg, tmp, launches, bin]) await mkdir(dir, { recursive: true, mode: 0o700 });
  // The host's own Claude Code files that an agent must not change (D8a).
  await writeFile(join(cfg, 'settings.json'), JSON.stringify(options.hostSettings ?? {}));
  await writeFile(join(cfg, 'CLAUDE.md'), '# my own rules\n');
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
  const quote = (text: string): string => `'${text.replaceAll("'", "'\\''")}'`;
  // smurg's executable as the sessions run it: a file of this test (a write to it must be refused, D8a).
  const smurg = join(bin, 'smurg');
  await writeFile(smurg, ['#!/bin/sh', `exec ${quote(process.execPath)} ${quote(entry)} "$@"`, ''].join('\n'));
  await chmod(smurg, 0o755);
  // The claude wrapper: one file per launch (its pid, then its argv), then the real binary in its place.
  const wrapper = join(base, 'claude');
  await writeFile(wrapper, ['#!/bin/sh', `printf '%s\\n' "$$" "$@" > ${quote(launches)}/"launch-$$"`, `exec ${quote(binary.path)} "$@"`, ''].join('\n'));
  await chmod(wrapper, 0o755);
  const selfCommand = { file: smurg, args: [] };
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
  const t = await createTestDaemon({
    project: { files: { 'README.md': '# shop\n', 'CLAUDE.md': '# rules\n', 'notes.md': 'notes\n', 'list.txt': 'listed.txt\n', 'listed.txt': 'x\n', 'gone.md': 'x\n', '.claude/settings.json': '{}\n' }, git: true },
    modules: [locksModule, hooksModule, worktreesModule, createSessionsModule({ hostEnv: () => isolatedEnv(base, mockUrl, { CLAUDE_CONFIG_DIR: cfg }), launch: { claudePath: wrapper, selfCommand } })],
    sessions: { selfCommand, hostHome: home },
    ...(options.settings ? { settings: options.settings } : {}),
  });
  await mkdir(join(t.root, '.git', 'hooks'), { recursive: true });
  await mkdir(join(t.root, '.smurg', 'git', 'refs', 'heads'), { recursive: true });
  await writeFile(join(t.root, '.smurg', 'git', 'refs', 'heads', 'main'), '1111111111111111111111111111111111111111\n');
  const stateDir = await realpath(t.ctx.config.stateDir);
  const paths: Paths = { root: await realpath(t.root), home: await realpath(home), stateDir, smurg: await realpath(smurg) };
  const mock = await startMockAnthropic(steps(paths), { ...(options.classifier ? { classifier: options.classifier } : {}), ...(options.route ? { route: options.route(paths) } : {}) });
  mockUrl = mock.url;
  await seedClaudeTrust({ cfgDir: cfg, cwd: t.root, apiKey: MOCK_API_KEY });
  await t.connectHost();
  const agents = t.ctx.services.agents as AgentSessionsImpl;
  const requests: Stack['requests'] = [];
  const gate: DaemonEvents['agent.tool.gate'][] = [];
  const turns: DaemonEvents['agent.turn.finished'][] = [];
  t.ctx.bus.on('agent.request', (event) => requests.push(event));
  t.ctx.bus.on('agent.tool.gate', (event) => gate.push(event));
  t.ctx.bus.on('agent.turn.finished', (event) => turns.push(event));
  const host = (): Principal => t.ctx.members.principalOf(TEST_HOST_USER) as Principal;
  let carolConnected = false;
  const made: Stack = {
    t,
    mock,
    agents,
    worktrees,
    base,
    home,
    cfg,
    smurg,
    requests,
    gate,
    turns,
    host,
    carol: async () => {
      if (!carolConnected) {
        await t.connect({ ...CAROL, role: 'agent' });
        carolConnected = true;
      }
      return t.ctx.members.principalOf(CAROL.userId) as Principal;
    },
    path: (rel) => join(t.root, rel),
    events: async (sessionId) => (await agents.history({ sessionId, afterSeq: 0, limit: 500 })).events,
    say: async (sessionId, text, from) => {
      await agents.send(sessionId, { kind: 'person', from: from ?? host(), text, cleaned: false, origin: 'composer' });
    },
    turnsDone: (count) => waitFor(() => turns.length >= count, { timeoutMs: 90_000, what: `turn ${count} to end` }),
    launches: async () => {
      const out: (Launch & { at: number })[] = [];
      for (const name of await readdir(launches)) {
        const [pid, ...args] = (await readFile(join(launches, name), 'utf8')).split('\n').slice(0, -1);
        out.push({ pid: Number(pid), args, at: (await stat(join(launches, name))).mtimeMs });
      }
      return out.sort((a, b) => a.at - b.at).map(({ pid, args }) => ({ pid, args }));
    },
    audited: async (action) => {
      await t.ctx.audit.flush();
      return (await t.ctx.audit.query({ limit: 300 })).filter((entry) => entry.action === action).map((entry) => ({ outcome: entry.outcome, detail: (entry.detail ?? {}) as Record<string, unknown> })).reverse();
    },
    worktree: async (owner) => {
      const handle = await worktrees.acquireForSession({ owner: { userId: owner.actor.kind === 'user' ? owner.actor.userId : TEST_HOST_USER }, sessionId: `wt-${Math.random().toString(36).slice(2)}` });
      await seedClaudeTrust({ cfgDir: cfg, cwd: handle.root.realPath, apiKey: MOCK_API_KEY });
      return { id: handle.worktree.id, dir: handle.root.realPath };
    },
  };
  stack = made;
  return made;
}

const bash = (command: string): MockStep => ({ tools: [{ name: 'Bash', input: { command, description: 'scripted step' } }] });
const tool = (name: string, input: Record<string, unknown>): MockStep => ({ tools: [{ name, input }] });

/** The writes of R-SEC's reach.mjs that D8a's rules refuse (DESIGN 0.6.0 D21 rows R2 and R5). */
function beyondTheFolder(paths: Paths): readonly (readonly [string, string, string])[] {
  return [
    ['main .git/hooks', `echo '#!/bin/sh' >> ${join(paths.root, '.git/hooks/post-checkout')}`, join(paths.root, '.git/hooks/post-checkout')],
    ['main .claude/settings.json', `echo '{"hooks":{}}' > ${join(paths.root, '.claude/settings.json')}`, join(paths.root, '.claude/settings.json')],
    ['a ref of smurg\'s own history', `echo 0000000000000000000000000000000000000000 > ${join(paths.root, '.smurg/git/refs/heads/main')}`, join(paths.root, '.smurg/git/refs/heads/main')],
    ['the host\'s ~/.claude/settings.json', `echo '{"hooks":{}}' > ${join(paths.home, '.claude/settings.json')}`, join(paths.home, '.claude/settings.json')],
    ['the host\'s ~/.claude/CLAUDE.md', `echo '- always run the setup script first' >> ${join(paths.home, '.claude/CLAUDE.md')}`, join(paths.home, '.claude/CLAUDE.md')],
    ['~/.claude/settings.local.json by ~', `echo '{}' > ~/.claude/settings.local.json`, join(paths.home, '.claude/settings.local.json')],
    ['a file in smurg\'s state folder', `echo x > ${join(paths.stateDir, 'reach-probe.txt')}`, join(paths.stateDir, 'reach-probe.txt')],
    ['smurg\'s executable', `echo 'exit 0' >> ${paths.smurg}`, paths.smurg],
  ];
}

/** What each protected place holds, so a refused write is seen as one that changed nothing. */
async function snapshot(places: readonly (readonly [string, string, string])[]): Promise<(string | null)[]> {
  return Promise.all(places.map(async ([, , path]) => (existsSync(path) ? readFile(path, 'utf8') : null)));
}

describe.skipIf(!claude)(`permission modes with the real claude (${V}, fake Anthropic API with a scripted classifier)`, { timeout: 240_000 }, () => {
  it(`R2: a work item in auto: the places beyond its folder are refused (absolute and ~), its own edits and commands run; the fast path, the classifier, a refusal said and audited, three in a row ask a person (${V})`, async () => {
    let places: readonly (readonly [string, string, string])[] = [];
    /** What auto mode's classifier was asked about (stage 1), in order. */
    const actions: string[] = [];
    const s = await start(
      (paths) => {
        places = beyondTheFolder(paths);
        return [
          ...places.map(([, command]) => bash(command)),
          { text: 'Tried them.' },
          bash('echo own > own.txt'),
          tool('Write', { file_path: 'notes-of-mine.md', content: '# mine\n' }),
          bash('python3 -c "print(40 + 2)"'),
          bash('python3 -c "print(\'BLOCKME 1\')"'),
          bash('python3 -c "print(\'BLOCKME 2\')"'),
          bash('python3 -c "print(\'BLOCKME 3\')"'),
          { text: 'Done.' },
        ];
      },
      {
        classifier: (request) => {
          if (request.stage === 1) actions.push(request.action);
          return request.action.includes('BLOCKME') ? { severity: 90, category: 'Test Block' } : { severity: 5 };
        },
      },
    );
    const before = await snapshot(places);
    const wt = await s.worktree(s.host());
    const session = await s.agents.start({
      purpose: 'item',
      topic: TOPIC,
      item: { id: 'cart-api', number: 1, title: 'Cart API', attempt: 1 },
      openedBy: s.host(),
      responsible: null,
      workspace: { mode: 'worktree', worktreeId: wt.id },
      modeChoice: null,
      model: null,
      rolePrompt: () => 'You are the agent of one work item.',
      firstMessage: { kind: 'person', from: s.host(), text: 'try the places', cleaned: false, origin: 'composer' },
    });
    await s.turnsDone(1);
    expect(s.agents.get(session.id)).toMatchObject({ permissionMode: 'auto', modeInUse: 'auto' });
    expect((await s.launches()).at(-1)?.args).toEqual(expect.arrayContaining(['--permission-mode', 'auto']));
    const results = s.mock.toolResults();
    console.log(`[modes-claude-real ${claude?.version}] R2 beyond: ${JSON.stringify(results.slice(0, places.length).map((r) => `${r.isError ? 'ERROR ' : ''}${r.text.slice(0, 80)}`))}`);
    for (let i = 0; i < places.length; i++) expect(results[i], (places[i] as readonly string[])[0]).toMatchObject({ isError: true });
    expect(await snapshot(places)).toEqual(before);

    // Its own folder: an edit tool and a simple file command run; `echo > f` takes the fast path (no classifier).
    const asked = actions.length;
    await s.say(session.id, 'now your own work');
    await waitFor(() => s.requests.some((entry) => entry.sessionId === session.id && entry.request.kind === 'permission'), { timeoutMs: 90_000, what: 'the third refusal in a row to ask a person' });
    expect(await readFile(join(wt.dir, 'own.txt'), 'utf8')).toBe('own\n');
    expect(await readFile(join(wt.dir, 'notes-of-mine.md'), 'utf8')).toBe('# mine\n');
    const classified = actions.slice(asked);
    console.log(`[modes-claude-real ${claude?.version}] R2 classifier actions: ${JSON.stringify(classified)}`);
    expect(classified.some((action) => action.includes('echo own'))).toBe(false);
    expect(classified.some((action) => action.includes('40 + 2'))).toBe(true);
    const card = s.requests.find((entry) => entry.sessionId === session.id && entry.request.kind === 'permission')?.request;
    expect(card).toMatchObject({ kind: 'permission', tool: 'Bash', reasonType: 'classifier', view: { target: 'python3 -c "print(\'BLOCKME 3\')"' } });
    s.agents.decidePermission(session.id, card?.id as string, { allow: false, message: 'not this one' });
    await s.turnsDone(2);
    // Two refusals of the check: lines and audit entries, and no command that ran; the allowed ones ran, audited.
    const lines = (await s.events(session.id)).flatMap((event) => (event.kind === 'line' && event.text.id === 'conversation.autoMode.blocked' ? [event.text] : []));
    expect(lines).toHaveLength(2);
    expect(await s.audited('agent.command.blocked')).toMatchObject([
      { outcome: 'denied', detail: { sessionId: session.id, tool: 'Bash', command: 'python3 -c "print(\'BLOCKME 1\')"' } },
      { outcome: 'denied', detail: { sessionId: session.id, tool: 'Bash', command: 'python3 -c "print(\'BLOCKME 2\')"' } },
    ]);
    const ran = (await s.audited('agent.command')).map((entry) => [entry.outcome, entry.detail['command'], entry.detail['mode']]);
    expect(ran).toEqual(expect.arrayContaining([['ok', 'echo own > own.txt', 'auto'], ['ok', 'python3 -c "print(40 + 2)"', 'auto']]));
    expect(ran.some(([, command]) => String(command).includes('BLOCKME'))).toBe(false);
  });

  it(`R3: a teammate's session in auto: a shell write of CLAUDE.md asks the host (G11a), one of a file someone is typing in is refused (G11b); her work item's write outside its folder asks the host (G12) (${V})`, async () => {
    const s = await start(() => [bash('echo x >> CLAUDE.md'), bash('rm notes.md'), bash('G=CLAUDE.md && echo x >> "$G"'), { text: 'Main done.' }], {
      // The work item's conversation has its own script (the fake API answers each conversation by its turns).
      route: ({ home }) => (request) => (request.firstUser.includes('write a note home') ? [bash(`echo x >> ${join(home, 'notes.txt')}`), { text: 'Item done.' }][request.assistantTurns] : undefined),
    });
    const carol = await s.carol();
    s.t.ctx.services.locks.touchHuman({ root: MAIN_ROOT, path: 'notes.md' }, { userId: 'dev:amy', displayName: 'Amy' });
    const main = await s.agents.start({ purpose: 'free', openedBy: carol, responsible: null, workspace: { mode: 'main' }, modeChoice: null, model: null, rolePrompt: () => '', firstMessage: { kind: 'person', from: carol, text: 'change the rules', cleaned: false, origin: 'composer' } });
    await waitFor(() => s.requests.some((entry) => entry.sessionId === main.id), { timeoutMs: 90_000, what: 'the card of G11a' });
    const asked = s.requests.find((entry) => entry.sessionId === main.id)?.request;
    expect(asked).toMatchObject({ kind: 'permission', tool: 'Bash', reasonType: 'hook', reason: BASH_ASK_REASONS.writesHostOnly, view: { target: 'echo x >> CLAUDE.md' } });
    s.agents.decidePermission(main.id, asked?.id as string, { allow: false, message: 'the host keeps CLAUDE.md' });
    // A target smurg cannot read (GATE_ASKS_WHEN_UNSURE, R4): asked too, though Claude Code would run it unchecked.
    await waitFor(() => s.requests.filter((entry) => entry.sessionId === main.id).length === 2, { timeoutMs: 90_000, what: 'the card of a variable target' });
    const unsure = s.requests.filter((entry) => entry.sessionId === main.id)[1]?.request;
    expect(unsure).toMatchObject({ kind: 'permission', reasonType: 'hook', reason: BASH_ASK_REASONS.unsureAuto, view: { target: 'G=CLAUDE.md && echo x >> "$G"' } });
    s.agents.decidePermission(main.id, unsure?.id as string, { allow: false, message: 'no' });
    await s.turnsDone(1);
    expect(await readFile(s.path('CLAUDE.md'), 'utf8')).toBe('# rules\n');
    expect(await readFile(s.path('notes.md'), 'utf8')).toBe('notes\n');
    const typing = s.mock.toolResults()[1];
    expect(typing).toMatchObject({ isError: true });
    expect(typing?.text).toContain('Amy is typing in notes.md');
    expect(s.gate.filter((event) => event.sessionId === main.id).map((event) => event.row)).toEqual(['G11']);

    const wt = await s.worktree(carol);
    const item = await s.agents.start({
      purpose: 'item',
      topic: TOPIC,
      item: { id: 'cart-api', number: 1, title: 'Cart API', attempt: 1 },
      openedBy: carol,
      responsible: null,
      workspace: { mode: 'worktree', worktreeId: wt.id },
      modeChoice: null,
      model: null,
      rolePrompt: () => '',
      firstMessage: { kind: 'person', from: carol, text: 'write a note home', cleaned: false, origin: 'composer' },
    });
    await waitFor(() => s.requests.some((entry) => entry.sessionId === item.id), { timeoutMs: 90_000, what: 'the card of G12' });
    const outside = s.requests.find((entry) => entry.sessionId === item.id)?.request;
    expect(outside).toMatchObject({ kind: 'permission', reasonType: 'hook', reason: BASH_ASK_REASONS.writesOutside });
    s.agents.decidePermission(item.id, outside?.id as string, { allow: false, message: 'no' });
    await s.turnsDone(2);
    expect(existsSync(join(s.home, 'notes.txt'))).toBe(false);
  });

  it(`R4: what smurg cannot read in the host's main session in auto: a variable's target is on Claude Code's fast path (no check), a substitution, \`sh -c\` and xargs go to its classifier; hence GATE_ASKS_WHEN_UNSURE = ${String(GATE_ASKS_WHEN_UNSURE)} (${V})`, async () => {
    const actions: string[] = [];
    const s = await start(() => [bash('F=gone.md; rm "$F"'), bash('rm $(cat list.txt)'), bash('rm README.md'), bash('G=CLAUDE.md && echo x >> "$G"'), bash("sh -c 'echo y >> notes.md'"), bash('xargs rm < list.txt'), { text: 'Removed.' }], {
      classifier: (request) => {
        if (request.stage === 1) actions.push(request.action);
        return { severity: 5 };
      },
    });
    const session = await s.agents.start({ purpose: 'free', openedBy: s.host(), responsible: null, workspace: { mode: 'main' }, modeChoice: null, model: null, rolePrompt: () => '', firstMessage: { kind: 'person', from: s.host(), text: 'remove them', cleaned: false, origin: 'composer' } });
    await s.turnsDone(1);
    expect(s.agents.get(session.id)).toMatchObject({ modeInUse: 'auto' });
    const askedAbout = (needle: string): boolean => actions.some((action) => action.includes(needle));
    console.log(`[modes-claude-real ${claude?.version}] R4 classifier asked: variable ${askedAbout('F=gone.md')}, substitution ${askedAbout('$(cat list.txt)')}, plain rm ${askedAbout('rm README.md')}, variable && ${askedAbout('G=CLAUDE.md')}, sh -c ${askedAbout('sh -c')}, xargs ${askedAbout('xargs rm')}; actions ${JSON.stringify(actions)}; results ${JSON.stringify(s.mock.toolResults().map((r) => `${r.isError ? 'ERROR ' : ''}${r.text.slice(0, 60)}`))}`);
    // The evidence GATE_ASKS_WHEN_UNSURE rests on (measured: W/build/S4): Claude Code's fast path takes a command
    // whose target is a VARIABLE, with no check at all (the file went), while it sends a substitution, a line for
    // another shell and xargs to its classifier. So what smurg cannot read may run unchecked: the gate asks.
    expect(askedAbout('F=gone.md')).toBe(false);
    expect(existsSync(s.path('gone.md'))).toBe(false);
    expect(askedAbout('G=CLAUDE.md')).toBe(false);
    expect(await readFile(s.path('CLAUDE.md'), 'utf8')).toBe('# rules\nx\n');
    expect(askedAbout('$(cat list.txt)')).toBe(true);
    expect(askedAbout('sh -c')).toBe(true);
    expect(askedAbout('xargs rm')).toBe(true);
    // And a simple file command in the folder is the fast path: no check at all (DESIGN D10's first bullet).
    expect(askedAbout('rm README.md')).toBe(false);
    expect(existsSync(s.path('README.md'))).toBe(false);
    expect(GATE_ASKS_WHEN_UNSURE).toBe(true);
  });

  it(`R5: "Asks for nothing" starts in bypassPermissions with smurg's settings file and the places of D8a still refused; with the host's own disableBypassPermissionsMode Claude Code runs it in auto, and smurg says so (${V})`, async () => {
    let places: readonly (readonly [string, string, string])[] = [];
    const s = await start(
      (paths) => {
        places = beyondTheFolder(paths);
        return [...places.map(([, command]) => bash(command)), bash('echo own > own.txt'), { text: 'Tried them.' }];
      },
      { settings: { permissionMode: 'ask-nothing' } },
    );
    const before = await snapshot(places);
    const session = await s.agents.start({ purpose: 'free', openedBy: s.host(), responsible: null, workspace: { mode: 'main' }, modeChoice: null, model: null, rolePrompt: () => '', firstMessage: { kind: 'person', from: s.host(), text: 'try the places', cleaned: false, origin: 'composer' } });
    await s.turnsDone(1);
    expect(s.agents.get(session.id)).toMatchObject({ permissionMode: 'ask-nothing', modeInUse: 'ask-nothing' });
    expect((await s.launches()).at(-1)?.args).toEqual(expect.arrayContaining(['--permission-mode', 'bypassPermissions']));
    expect((await s.launches()).at(-1)?.args.join(' ')).not.toMatch(/dangerously/);
    const settings = JSON.parse(await readFile(join(sessionFilesDir(s.t.ctx.config.stateDir, s.t.ctx.config.workspaceId, session.id), 'settings.json'), 'utf8')) as { permissions: Record<string, unknown> };
    expect(settings.permissions).not.toHaveProperty('disableBypassPermissionsMode');
    expect(settings.permissions['defaultMode']).toBe('auto');
    const results = s.mock.toolResults();
    console.log(`[modes-claude-real ${claude?.version}] R5 beyond: ${JSON.stringify(results.slice(0, places.length).map((r) => `${r.isError ? 'ERROR ' : ''}${r.text.slice(0, 80)}`))}`);
    for (let i = 0; i < places.length; i++) expect(results[i], (places[i] as readonly string[])[0]).toMatchObject({ isError: true });
    expect(await snapshot(places)).toEqual(before);
    expect(await readFile(s.path('own.txt'), 'utf8')).toBe('own\n');
    // Nothing asked anybody.
    expect(s.requests).toEqual([]);
    await s.agents.end(session.id, { by: { kind: 'system' }, reason: 'ended', keepWorktree: true });

    // The host's own Claude Code settings refuse running without asking: Claude Code runs the file's fallback.
    await writeFile(join(s.cfg, 'settings.json'), JSON.stringify({ permissions: { disableBypassPermissionsMode: 'disable' } }));
    const refused = await s.agents.start({ purpose: 'free', openedBy: s.host(), responsible: null, workspace: { mode: 'main' }, modeChoice: null, model: null, rolePrompt: () => '', firstMessage: { kind: 'person', from: s.host(), text: 'hello', cleaned: false, origin: 'composer' } });
    const now = await waitFor(() => s.agents.get(refused.id)?.modeInUse !== undefined, { timeoutMs: 60_000, what: 'the reported mode' }).then(() => s.agents.get(refused.id) as AgentSession);
    expect(now).toMatchObject({ permissionMode: 'ask-nothing', modeInUse: 'auto', modeFallback: 'ask-nothing-off' });
    const notices = (await s.events(refused.id)).flatMap((event) => (event.kind === 'notice' ? [event.text.id] : []));
    expect(notices).toContain('notice.asksNothingRefused');
    expect(s.agents.hostAgentState().asksNothing).toBe('off');
  });

  it(`R6: auto on Haiku, which has no auto mode: smurg's own fallback, said and shown; once the list is known the next start asks before commands from its first turn (${V})`, async () => {
    const s = await start(() => [{ text: 'one' }, { text: 'two' }]);
    const first = await s.agents.start({ purpose: 'free', openedBy: s.host(), responsible: null, workspace: { mode: 'main' }, modeChoice: null, model: 'haiku', rolePrompt: () => '', firstMessage: { kind: 'person', from: s.host(), text: 'hello', cleaned: false, origin: 'composer' } });
    await s.turnsDone(1);
    expect(s.agents.get(first.id)).toMatchObject({ permissionMode: 'auto', modeInUse: 'ask-commands', modeFallback: 'model-no-auto', modelInUse: 'claude-haiku-4-5-20251001' });
    expect((await s.events(first.id)).flatMap((event) => (event.kind === 'notice' ? [event.text] : []))).toContainEqual({ id: 'notice.autoUnavailable.model', params: { model: 'Haiku' } });
    expect((await s.launches()).at(-1)?.args).toEqual(expect.arrayContaining(['--permission-mode', 'auto', '--model', 'haiku']));
    // The list is known now (the first process's initialize): the next session starts as "Asks before commands".
    expect(s.agents.modelEntry('haiku')).toMatchObject({ auto: false });
    const second = await s.agents.start({ purpose: 'free', openedBy: s.host(), responsible: null, workspace: { mode: 'main' }, modeChoice: null, model: 'haiku', rolePrompt: () => '', firstMessage: { kind: 'person', from: s.host(), text: 'hello', cleaned: false, origin: 'composer' } });
    await s.turnsDone(2);
    expect((await s.launches()).at(-1)?.args).toEqual(expect.arrayContaining(['--permission-mode', 'default', '--model', 'haiku']));
    expect(s.agents.get(second.id)).toMatchObject({ modeInUse: 'ask-commands', modeFallback: 'model-no-auto' });
    expect(s.agents.hostAgentState().autoMode).toBe('ok');
  });

  it(`R8: the process keeps the rules it started with after its --settings file was overwritten: seconds later the gate's refusal and a deny rule still hold (${V})`, async () => {
    const s = await start(() => [{ text: 'ready' }, bash('rm notes.md'), bash('mkdir -p .claude/agents && echo x > .claude/agents/planted.md'), { text: 'done' }]);
    const session = await s.agents.start({ purpose: 'free', openedBy: s.host(), responsible: null, workspace: { mode: 'main' }, modeChoice: null, model: null, rolePrompt: () => '', firstMessage: { kind: 'person', from: s.host(), text: 'first', cleaned: false, origin: 'composer' } });
    await s.turnsDone(1);
    // What an agent could do without naming the file (a script, a `cd` first): its launch file, rewritten to allow all.
    const file = join(sessionFilesDir(s.t.ctx.config.stateDir, s.t.ctx.config.workspaceId, session.id), 'settings.json');
    await writeFile(file, JSON.stringify({ disableAllHooks: true, permissions: { defaultMode: 'bypassPermissions', allow: ['Bash'], deny: [] } }));
    await new Promise((resolve) => setTimeout(resolve, 4_000));
    s.t.ctx.services.locks.touchHuman({ root: MAIN_ROOT, path: 'notes.md' }, { userId: 'dev:amy', displayName: 'Amy' });
    await s.say(session.id, 'second');
    await s.turnsDone(2);
    const results = s.mock.toolResults();
    console.log(`[modes-claude-real ${claude?.version}] R8 results: ${JSON.stringify(results.map((r) => `${r.isError ? 'ERROR ' : ''}${r.text.slice(0, 80)}`))}`);
    expect(results[0]).toMatchObject({ isError: true });
    expect(results[0]?.text).toContain('typing in notes.md');
    expect(results[1]).toMatchObject({ isError: true });
    expect(await readFile(s.path('notes.md'), 'utf8')).toBe('notes\n');
    expect(existsSync(s.path('.claude/agents/planted.md'))).toBe(false);
    expect(s.gate.map((event) => event.row)).toEqual(['G11']);
  });
});
