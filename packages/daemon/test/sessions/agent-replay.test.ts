// DESIGN §7 S15 (AD-2): Claude Code changes, the wire is strict. The raw stdout lines recorded from Claude Code 2.1.288
// (runtime experiments, mock API; test/sessions/fixtures/claude-2.1.288.stdout.jsonl, paths scrubbed) are replayed
// through the normaliser and the real runner; every event that results passes the wire's schemas, nothing of Claude
// Code's own shapes is stored, and a line of a kind smurg does not know changes nothing.
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chmod, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { conversationEventSchema, questionPartsSchema, toolViewSchema, type AgentSession } from '@smurg/protocol';
import type { AgentRequest, Principal } from '../../src/core/interfaces.ts';
import type { AgentSessionsImpl } from '../../src/sessions/agent/agent-sessions.ts';
import { loginOfAccount } from '../../src/sessions/agent/agent-runner.ts';
import { hostRulesOf } from '../../src/sessions/agent/host-rules.ts';
import { Normaliser } from '../../src/sessions/agent/normalise.ts';
import { CLAUDE_ACCOUNTS, FAKE_CLAUDE_SCRIPT, TEST_HOST_USER, createTempDir, removeTempDir, waitFor } from '../../src/testing/index.ts';
import { startSessionStack, type SessionStack } from './setup.ts';

const FIXTURE = fileURLToPath(new URL('./fixtures/claude-2.1.288.stdout.jsonl', import.meta.url));

let current: SessionStack | null = null;
let scratch: string | null = null;
afterEach(async () => {
  await current?.cleanup();
  current = null;
  if (scratch) await removeTempDir(scratch);
  scratch = null;
});

describe('replay of lines recorded from Claude Code 2.1.288', { timeout: 60_000 }, () => {
  it('the normaliser reads every recorded line; unknown kinds yield nothing', async () => {
    const lines = (await readFile(FIXTURE, 'utf8')).split('\n').filter((line) => line.length > 0);
    expect(lines.length).toBeGreaterThan(100);
    const normaliser = new Normaliser();
    const kinds = new Map<string, number>();
    for (const line of lines) {
      const message = Normaliser.parse(line);
      expect(message).not.toBeNull();
      for (const event of normaliser.normalise(message as Record<string, unknown>)) kinds.set(event.kind, (kinds.get(event.kind) ?? 0) + 1);
    }
    for (const kind of ['init', 'delta', 'text', 'tool.use', 'tool.result', 'replay', 'lifecycle', 'request', 'result', 'status', 'control.response']) expect(kinds.get(kind) ?? 0, kind).toBeGreaterThan(0);
    expect(kinds.get('result')).toBe(4);
    expect(kinds.get('request')).toBe(2);
    expect(normaliser.normalise({ type: 'a_type_of_next_year', payload: { anything: true } })).toEqual([]);
  });

  it('through the real runner: every stored event passes the wire schema; a question and a permission request are raised with wire-valid content; no file content of a read is stored', async () => {
    // A `claude` that answers the handshake and then prints the recorded lines when the first message arrives.
    scratch = await createTempDir('replay');
    const replayer = join(scratch, 'replay-claude.mjs');
    await writeFile(
      replayer,
      [
        "import { readFileSync } from 'node:fs';",
        "import { createInterface } from 'node:readline';",
        "if (process.argv[2] === '--version') { console.log('2.1.288 (Claude Code)'); process.exit(0); }",
        "if (process.argv[2] === 'auth') { console.log(JSON.stringify({ loggedIn: true })); process.exit(0); }",
        `const lines = readFileSync(${JSON.stringify(FIXTURE)}, 'utf8').split('\\n').filter(Boolean);`,
        'let played = false;',
        "createInterface({ input: process.stdin }).on('line', (line) => {",
        '  const message = JSON.parse(line);',
        "  if (message.type === 'control_request') { const ok = message.request.subtype === 'initialize'; process.stdout.write(JSON.stringify({ type: 'control_response', response: { subtype: ok ? 'success' : 'error', request_id: message.request_id, response: {}, error: 'unsupported' } }) + '\\n'); return; }",
        "  if (message.type === 'user' && !played) { played = true; for (const recorded of lines) { if (JSON.parse(recorded).type !== 'control_response') process.stdout.write(recorded + '\\n'); } process.stdout.write(JSON.stringify({ type: 'a_type_of_next_year', x: 1 }) + '\\nnot json at all\\n'); }",
        "}).on('close', () => process.exit(0));",
        '',
      ].join('\n'),
    );
    const wrapper = join(scratch, 'replay-claude');
    await writeFile(wrapper, `#!/bin/sh\nexec '${process.execPath}' '${replayer}' "$@"\n`);
    await chmod(wrapper, 0o755);
    const s = await startSessionStack({ claudePath: wrapper });
    current = s;
    const agents = s.t.ctx.services.agents as AgentSessionsImpl;
    const requests: AgentRequest[] = [];
    const turns: string[] = [];
    s.t.ctx.bus.on('agent.request', (event) => requests.push(event.request));
    s.t.ctx.bus.on('agent.turn.finished', (event) => turns.push(event.outcome));
    await s.t.connectHost();
    const session = await s.sessions.create({ kind: 'agent', workspace: { mode: 'main' }, firstMessage: 'replay' }, null as never, s.t.ctx.members.principalOf(TEST_HOST_USER) as Principal);
    await waitFor(() => turns.length === 4, { timeoutMs: 20_000, what: 'the four recorded turns' });
    expect(turns).toEqual(['completed', 'completed', 'completed', 'interrupted']);
    // What was raised: the question with wire-valid parts, the command with the same view its tool card shows.
    expect(requests.map((request) => request.kind)).toEqual(['question', 'permission']);
    const [question, permission] = requests as [Extract<AgentRequest, { kind: 'question' }>, Extract<AgentRequest, { kind: 'permission' }>];
    expect(questionPartsSchema.safeParse(question.parts).success).toBe(true);
    expect(question.parts.map((part) => [part.header, part.multi, part.options.length])).toEqual([['Database', false, 2], ['Platforms', true, 3]]);
    expect(toolViewSchema.safeParse(permission.view).success).toBe(true);
    expect(permission).toMatchObject({ tool: 'Bash', view: { verb: 'run' } });
    // Claude Code's own suggestion (a rule for its local settings file) is read as a rule, never echoed as it came.
    expect(permission.suggestedRule?.tool).toBe('Bash');
    expect((agents.get(session.id) as AgentSession).lastSeq).toBeGreaterThan(15);
    const events = (await agents.history({ sessionId: session.id, afterSeq: 0, limit: 500 })).events;
    for (const event of events) expect(conversationEventSchema.safeParse(event).success, JSON.stringify(event).slice(0, 200)).toBe(true);
    const kinds = new Set(events.map((event) => event.kind));
    for (const kind of ['message', 'delivery', 'turn.started', 'text', 'tool.started', 'tool.finished', 'turn.finished']) expect(kinds.has(kind as never), kind).toBe(true);
    expect(events.filter((event) => event.kind === 'text').map((event) => (event.kind === 'text' ? event.text : ''))).toContain('Before I write the spec I need two decisions from the group.');
    const tools = events.filter((event) => event.kind === 'tool.started').map((event) => (event.kind === 'tool.started' ? `${event.tool.name}:${event.tool.verb}` : ''));
    expect(tools).toEqual(expect.arrayContaining(['Bash:run', 'Read:read']));
    expect(tools).not.toContain('AskUserQuestion:other');
    // The log on disk: one valid event per line and nothing else; what a Read returned is not in it.
    await s.t.ctx.services.agents.storageDir(session.id).then(async (dir) => {
      const files = (await readdir(dir)).filter((name) => name.endsWith('.jsonl'));
      let stored = 0;
      for (const name of files) {
        for (const line of (await readFile(join(dir, name), 'utf8')).split('\n').filter(Boolean)) {
          const { v, ...event } = JSON.parse(line) as Record<string, unknown>;
          expect(v).toBe(1);
          expect(conversationEventSchema.safeParse(event).success).toBe(true);
          expect(line).not.toContain('tool_use_result');
          expect(line).not.toContain('3\\towner: Amy');
          stored += 1;
        }
      }
      expect(stored).toBeGreaterThanOrEqual(events.length);
    });
    const read = events.find((event) => event.kind === 'tool.finished' && events.some((started) => started.kind === 'tool.started' && started.toolUseId === event.toolUseId && started.tool.verb === 'read'));
    expect(read).toMatchObject({ ok: true });
    expect(read?.kind === 'tool.finished' ? read.result.body : 'x').toBeUndefined();
  });
});

// DX-11: the stand-in `claude` is the oracle of every test that may not use an account, so what it ANSWERS must be
// what Claude Code answers. The answers to smurg's own control requests were recorded from 2.1.288 (fake API, dummy key,
// isolated home; fixtures/claude-2.1.288.control.jsonl, paths scrubbed): the runtime reads them as it must, and the
// stand-in answers in the same shapes.
describe('the recorded answers of Claude Code 2.1.288 to smurg\'s control requests', { timeout: 60_000 }, () => {
  const CONTROL = fileURLToPath(new URL('./fixtures/claude-2.1.288.control.jsonl', import.meta.url));
  type Rule = { behavior: string; source: string; rule: string; editability?: string };
  const recorded = async (): Promise<{ accounts: Record<string, string>[]; rules: Rule[] }> => {
    const lines = (await readFile(CONTROL, 'utf8')).split('\n').filter(Boolean).map((line) => JSON.parse(line) as { account?: Record<string, string>; response?: { state: { rules: Rule[] } } });
    return { accounts: lines.flatMap((line) => (line.account ? [line.account] : [])), rules: lines.flatMap((line) => line.response?.state.rules ?? []) };
  };

  it('the runtime reads them: an API key and a subscription are logged in, no credential is logged out, "Claude Max" is a personal subscription; only the host\'s own allow rules are the host\'s rules', async () => {
    const { accounts, rules } = await recorded();
    expect(accounts).toEqual([CLAUDE_ACCOUNTS.apiKey, CLAUDE_ACCOUNTS.loggedOut, CLAUDE_ACCOUNTS.subscriptionMax]);
    expect(accounts.map((account) => loginOfAccount(account))).toEqual([
      { state: 'logged-in', personalSubscription: false },
      { state: 'logged-out', personalSubscription: false },
      { state: 'logged-in', personalSubscription: true },
    ]);
    expect(new Set(rules.map((rule) => `${rule.behavior}/${rule.source}`))).toEqual(new Set(['allow/userSettings', 'allow/projectSettings', 'allow/localSettings', 'allow/flagSettings', 'ask/userSettings', 'deny/userSettings', 'deny/flagSettings']));
    // Not smurg's own settings file (flagSettings), not an ask or a deny rule.
    expect(hostRulesOf({ state: { rules } })).toEqual([
      { rule: 'Bash(pnpm lint *)', source: 'local' },
      { rule: 'Bash(pnpm test *)', source: 'project' },
      { rule: 'Bash(ls *)', source: 'user' },
    ]);
  });

  it('the stand-in answers in the same shapes: `initialize.account`, and `list_permission_rules` with each rule\'s source and order, from the same settings files', async () => {
    scratch = await createTempDir('standin-shapes');
    const home = join(scratch, 'home');
    const project = join(scratch, 'project');
    await mkdir(join(home, '.claude'), { recursive: true });
    await mkdir(join(project, '.claude'), { recursive: true });
    // The settings files of the recording.
    await writeFile(join(home, '.claude/settings.json'), JSON.stringify({ permissions: { allow: ['Bash(ls *)'], deny: ['Bash(rm -rf *)'], ask: ['Bash(git push *)'] } }));
    await writeFile(join(project, '.claude/settings.json'), JSON.stringify({ permissions: { allow: ['Bash(pnpm test *)'] } }));
    await writeFile(join(project, '.claude/settings.local.json'), JSON.stringify({ permissions: { allow: ['Bash(pnpm lint *)'] } }));
    const flag = join(scratch, 'smurg-settings.json');
    await writeFile(flag, JSON.stringify({ permissions: { allow: ['mcp__smurg', 'Bash(cargo test *)'], deny: ['ListAgents', 'Read(//host/project/.envrc)'] } }));
    const ask = async (extra: readonly string[], account?: Record<string, string>): Promise<{ account: unknown; rules: Rule[] }> => {
      const scenario = join(scratch as string, `scenario-${extra.length}-${account === undefined ? 'default' : Object.keys(account).join('-')}.json`);
      await writeFile(scenario, JSON.stringify(account === undefined ? {} : { account }));
      const child = spawn(process.execPath, [FAKE_CLAUDE_SCRIPT, '-p', '--output-format', 'stream-json', '--input-format', 'stream-json', '--session-id', randomUUID(), '--settings', flag, ...extra], { cwd: project, env: { PATH: '/usr/bin:/bin', HOME: home, FAKE_CLAUDE_SCENARIO: scenario }, stdio: ['pipe', 'pipe', 'ignore'] });
      const answers = new Map<string, unknown>();
      createInterface({ input: child.stdout }).on('line', (line) => {
        const message = JSON.parse(line) as { type?: string; response?: { request_id: string; response: unknown } };
        if (message.type === 'control_response' && message.response) answers.set(message.response.request_id, message.response.response);
      });
      child.stdin.write(`${JSON.stringify({ type: 'control_request', request_id: 'c1', request: { subtype: 'initialize' } })}\n${JSON.stringify({ type: 'control_request', request_id: 'c2', request: { subtype: 'list_permission_rules' } })}\n`);
      await waitFor(() => answers.size === 2, { timeoutMs: 15_000, what: 'both answers of the stand-in' });
      child.stdin.end();
      await new Promise((resolve) => child.on('close', resolve));
      return { account: (answers.get('c1') as { account: unknown }).account, rules: (answers.get('c2') as { state: { rules: Rule[] } }).state.rules };
    };
    const real = await recorded();
    const shape = (rules: readonly Rule[]): string[] => rules.map((rule) => `${rule.behavior}/${rule.source}/${rule.rule}/${rule.editability}`);
    const standIn = await ask([]);
    expect(standIn.account).toEqual(real.accounts[0]);
    expect(shape(standIn.rules)).toEqual(shape(real.rules));
    // The other two logins, as recorded; and without the project's settings (a folder nobody confirmed).
    expect((await ask([], CLAUDE_ACCOUNTS.loggedOut)).account).toEqual(real.accounts[1]);
    expect((await ask([], CLAUDE_ACCOUNTS.subscriptionMax)).account).toEqual(real.accounts[2]);
    expect(shape((await ask(['--setting-sources', 'user'])).rules)).toEqual(shape(real.rules.filter((rule) => rule.source !== 'projectSettings' && rule.source !== 'localSettings')));
  });
});

