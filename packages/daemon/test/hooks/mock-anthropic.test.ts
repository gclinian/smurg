// The fake Anthropic API (mock-anthropic.ts) that the REAL `claude` talks to in the opt-in tests (ARCHITECTURE §0 rule
// 2: a dummy key, 127.0.0.1, never anyone's account). DESIGN 0.6.0 D17: it answers auto mode's classifier in both of
// its stages, refuses a model with the API's 404, and records the model of every request.
//
// The first block talks HTTP to the fake API alone. The second runs the real Claude Code 2.1.288 against it when one is
// at hand (SMURG_TEST_CLAUDE_BIN, else a verified `claude` on PATH; isolated HOME, CLAUDE_CONFIG_DIR and TMPDIR from
// claude-harness.ts) and says SKIPPED otherwise: that 2.1.288 reads these answers as the design says (allowed, blocked,
// a refused model), and that the stand-in `claude` (src/testing/fake-claude.mjs) answers the control requests of
// models and modes as 2.1.288 does (the error codes the daemon branches on, the modes a start really runs in).
import { execFile, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { STREAM_ARGS } from '../../src/sessions/agent/profiles.ts';
import { createTempDir, installFakeClaude, removeTempDir, type FakeClaudeScenario } from '../../src/testing/index.ts';
import { MOCK_API_KEY, findClaude, isolatedEnv, killSpawnedGroup, ownProcessGroup, runClaude, seedClaudeTrust } from './claude-harness.ts';
import { CLASSIFIER_SYSTEM_START, startMockAnthropic, type ClassifierRequest, type MockAnthropic, type MockOptions, type MockStep } from './mock-anthropic.ts';

type Json = Record<string, unknown>;
const execFileAsync = promisify(execFile);

let mock: MockAnthropic | null = null;
let scratch: string | null = null;
afterEach(async () => {
  await mock?.close();
  mock = null;
  if (scratch !== null) await removeTempDir(scratch);
  scratch = null;
});

async function start(steps: readonly MockStep[] = [{ text: 'done' }], options: MockOptions = {}): Promise<MockAnthropic> {
  mock = await startMockAnthropic(steps, options);
  return mock;
}

async function post(body: Json): Promise<{ status: number; json: Json | null; text: string }> {
  const response = await fetch(`${mock?.url ?? ''}/v1/messages?beta=true`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': MOCK_API_KEY }, body: JSON.stringify(body) });
  const text = await response.text();
  let json: Json | null = null;
  try {
    json = JSON.parse(text) as Json;
  } catch {
    json = null;
  }
  return { status: response.status, json, text };
}

/** A classifier request laid out as 2.1.288 sends it (U2 exp: a billing block, then the monitor's system; the transcript in blocks). */
function classifierBody(stage: 1 | 2, action: string, stream = false): Json {
  return {
    model: 'claude-sonnet-5',
    max_tokens: stage === 1 ? 64 : 8192,
    ...(stage === 1 ? { stop_sequences: ['</severity>'] } : {}),
    thinking: { type: 'disabled' },
    ...(stream ? { stream: true } : {}),
    system: [{ type: 'text', text: 'x-anthropic-billing-header: cc_version=2.1.288; cc_entrypoint=sdk-cli;' }, { type: 'text', text: `${CLASSIFIER_SYSTEM_START}\n\n## Context\n…`, cache_control: { type: 'ephemeral' } }],
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: '<transcript>\n' },
          { type: 'text', text: '{"user":"Run the steps."}\n{"Bash":"ls -a"}\n' },
          { type: 'text', text: `${action}\n` },
          { type: 'text', text: '</transcript>\n' },
          { type: 'text', text: stage === 1 ? '\nRespond with <severity>N</severity> ONLY.' : '\nReview the classification process and follow it.' },
        ],
      },
    ],
  };
}

const textOf = (json: Json | null): string => ((json?.['content'] as Json[] | undefined) ?? []).map((block) => String(block['text'] ?? '')).join('');

describe('the fake Anthropic API: auto mode\'s classifier, a refused model, the model of every request (DESIGN 0.6.0 D17)', () => {
  it('a classifier request is answered in its stage: stage 1 "<severity>N" stopped at "</severity>", by default 5 (allowed); it is recorded as a classifier request and never as the main conversation', async () => {
    await start();
    const answer = await post(classifierBody(1, '{"Bash":"python3 -c \\"print(1)\\""}'));
    expect(answer.status).toBe(200);
    expect(answer.json).toMatchObject({ type: 'message', role: 'assistant', model: 'claude-sonnet-5', content: [{ type: 'text', text: '<severity>5' }], stop_reason: 'stop_sequence', stop_sequence: '</severity>' });
    expect(mock?.requests).toMatchObject([{ kind: 'messages', model: 'claude-sonnet-5', classifier: 1, isMain: false }]);
    expect(mock?.classifierRequests()).toHaveLength(1);
  });

  it('the `classifier` option sees the stage, the model and the action under review; a block is "<severity>N" in stage 1 and the thinking, severity and category in stage 2, streamed or not', async () => {
    const seen: ClassifierRequest[] = [];
    await start([], { classifier: (request) => (seen.push(request), request.action.includes('rm -rf') ? { severity: 90, category: 'Irreversible Local Destruction' } : { severity: 10 }) });
    expect(textOf((await post(classifierBody(1, '{"Bash":"rm -rf build"}'))).json)).toBe('<severity>90');
    const stage2 = await post(classifierBody(2, '{"Bash":"rm -rf build"}'));
    expect(stage2.json).toMatchObject({ stop_reason: 'end_turn', stop_sequence: null });
    expect(textOf(stage2.json)).toBe("<thinking>the fake API's classifier</thinking><severity>90</severity><category>Irreversible Local Destruction</category>");
    expect(textOf((await post(classifierBody(2, '{"Bash":"ls"}'))).json)).toBe("<thinking>the fake API's classifier</thinking><severity>10</severity>");
    expect(seen.map((request) => [request.stage, request.model, request.action])).toEqual([
      [1, 'claude-sonnet-5', '{"Bash":"rm -rf build"}'],
      [2, 'claude-sonnet-5', '{"Bash":"rm -rf build"}'],
      [2, 'claude-sonnet-5', '{"Bash":"ls"}'],
    ]);
    expect(seen[0]?.text).toContain('<transcript>');
    expect(seen[0]?.text).toContain('Respond with <severity>N</severity> ONLY.');
    // Streamed: the same text, and the stop sequence in the message delta.
    const streamed = await post(classifierBody(1, '{"Bash":"rm -rf build"}', true));
    expect(streamed.text).toContain('"text":"<severity>90"');
    expect(streamed.text).toContain('"stop_reason":"stop_sequence","stop_sequence":"</severity>"');
    expect(mock?.classifierRequests().map((request) => request.classifier)).toEqual([1, 2, 2, 1]);
  });

  it('"garbage" is text no stage can read; a side request that is not the classifier keeps its old answer', async () => {
    await start([], { classifier: () => 'garbage' });
    expect(textOf((await post(classifierBody(1, '{"Bash":"x"}'))).json)).toBe('mock side response');
    expect(textOf((await post(classifierBody(2, '{"Bash":"x"}'))).json)).toBe('mock side response');
    const title = await post({ model: 'claude-haiku-4-5-20251001', max_tokens: 100, system: [{ type: 'text', text: 'Write a short title.' }], messages: [{ role: 'user', content: 'hello' }] });
    expect(textOf(title.json)).toBe('mock side response');
    expect(mock?.requests.at(-1)).toMatchObject({ model: 'claude-haiku-4-5-20251001', classifier: null, isMain: false });
  });

  it('`refuseModels`: a main request for such a model gets the API\'s 404 `not_found_error`; another model is answered by the script; every request records its model', async () => {
    await start([{ text: 'hello from the script' }], { refuseModels: ['claude-fable-5-1'] });
    const main = (model: string): Json => ({ model, max_tokens: 1000, tools: [{ name: 'Bash', input_schema: {} }], messages: [{ role: 'user', content: 'hi' }] });
    const refused = await post(main('claude-fable-5-1'));
    expect(refused).toMatchObject({ status: 404, json: { type: 'error', error: { type: 'not_found_error', message: 'model: claude-fable-5-1' } } });
    const fine = await post(main('claude-sonnet-5-5'));
    expect(fine.status).toBe(200);
    expect(textOf(fine.json)).toBe('hello from the script');
    // A side request for the refused model is not the main conversation: the API's refusal is for the main one only.
    expect((await post({ ...main('claude-fable-5-1'), tools: [] })).status).toBe(200);
    expect(mock?.requests.map((request) => [request.model, request.isMain])).toEqual([
      ['claude-fable-5-1', true],
      ['claude-sonnet-5-5', true],
      ['claude-fable-5-1', false],
    ]);
  });
});

// ---- with the real Claude Code ----------------------------------------------------------------------------------------

const found = await findClaude();
const claude = found.binary;
if (claude === null) console.warn(`\n[mock-anthropic] SKIPPED (the real Claude Code against the fake API): ${found.reason}\n`);
else console.log(`[mock-anthropic] running against Claude Code ${claude.version} (${claude.path})`);

/** An isolated folder for one real run: home, cfg, tmp and a trusted project (seedClaudeTrust, the dummy key approved). */
async function isolated(label: string): Promise<{ readonly dir: string; readonly project: string; readonly env: Record<string, string> }> {
  scratch ??= await createTempDir('mock-anthropic');
  const dir = join(scratch, `${label}-${randomUUID().slice(0, 8)}`);
  for (const sub of ['home', 'cfg', 'tmp', 'project']) await mkdir(join(dir, sub), { recursive: true, mode: 0o700 });
  const project = await realpath(join(dir, 'project'));
  await seedClaudeTrust({ cfgDir: join(dir, 'cfg'), cwd: project, apiKey: MOCK_API_KEY });
  return { dir, project, env: isolatedEnv(dir, mock?.url ?? 'http://127.0.0.1:9') };
}

/** The members of a process group (by `ps`), to clean up after a run: only the group this file spawned. */
async function groupMembers(pgid: number): Promise<number[]> {
  const { stdout } = await execFileAsync('/bin/ps', ['-A', '-o', 'pid=,pgid=']);
  return stdout
    .split('\n')
    .map((line) => line.trim().split(' ').filter(Boolean).map(Number))
    .filter((fields) => fields.length === 2 && fields[1] === pgid)
    .map((fields) => fields[0] as number);
}

interface ControlAnswer {
  readonly subtype: unknown;
  readonly error_code?: unknown;
  readonly response?: Json;
}

/**
 * One process (the real `claude` or the stand-in) with the runner's stream flags: the control requests one after the
 * other, each awaited, then stdin closed (no turn). Its process group is signalled only if it outlives the run.
 */
async function controlRun(file: string, args: readonly string[], cwd: string, env: Readonly<Record<string, string>>, requests: readonly Json[], turn?: string): Promise<{ readonly answers: ControlAnswer[]; readonly code: number | null; readonly lines: Json[] }> {
  const own = await ownProcessGroup();
  const child = spawn(file, [...STREAM_ARGS, '--session-id', randomUUID(), ...args], { cwd, env: { ...env }, detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
  const pgid = child.pid;
  const waiting = new Map<string, (answer: ControlAnswer) => void>();
  const lines: Json[] = [];
  let resulted: (() => void) | null = null;
  child.stdin.on('error', () => {});
  child.stderr.resume();
  createInterface({ input: child.stdout }).on('line', (text) => {
    let line: Json;
    try {
      line = JSON.parse(text) as Json;
    } catch {
      return;
    }
    lines.push(line);
    const response = line['response'] as Json | undefined;
    if (line['type'] === 'control_response' && typeof response?.['request_id'] === 'string') waiting.get(response['request_id'])?.(response as unknown as ControlAnswer);
    // A permission request (the runner's `can_use_tool`): this test refuses it, as a person may.
    if (line['type'] === 'control_request' && (line['request'] as Json | undefined)?.['subtype'] === 'can_use_tool') child.stdin.write(`${JSON.stringify({ type: 'control_response', response: { subtype: 'success', request_id: line['request_id'], response: { behavior: 'deny', message: 'the test refuses' } } })}\n`);
    if (line['type'] === 'result') resulted?.();
  });
  const closed = new Promise<number | null>((resolve) => child.on('close', (code) => resolve(code)));
  const timer = setTimeout(() => killSpawnedGroup(pgid, own), 60_000);
  try {
    const answers: ControlAnswer[] = [];
    for (const [index, request] of requests.entries()) {
      const id = `smurg_test_${index}`;
      const answered = new Promise<ControlAnswer>((resolve) => waiting.set(id, resolve));
      child.stdin.write(`${JSON.stringify({ type: 'control_request', request_id: id, request })}\n`);
      answers.push(await Promise.race([answered, closed.then((code): ControlAnswer => ({ subtype: `exited ${String(code)}` }))]));
    }
    if (turn !== undefined) {
      const done = new Promise<void>((resolve) => (resulted = resolve));
      child.stdin.write(`${JSON.stringify({ type: 'user', message: { role: 'user', content: turn } })}\n`);
      await Promise.race([done, closed]);
    }
    child.stdin.end();
    const code = await closed;
    return { answers, code, lines };
  } finally {
    clearTimeout(timer);
    if (pgid !== undefined && (await groupMembers(pgid)).length > 0) killSpawnedGroup(pgid, own);
  }
}

/** What the daemon reads of an answer: success or not, Claude Code's `error_code`, the mode it confirms, whether it has a `response`. */
function summary(answer: ControlAnswer | undefined): Json {
  const response = answer?.response;
  return {
    ok: answer?.subtype === 'success',
    code: answer?.error_code ?? null,
    hasResponse: response !== undefined,
    ...(typeof response?.['mode'] === 'string' ? { mode: response['mode'] } : {}),
    ...(typeof response?.['current_permission_mode'] === 'string' ? { current: response['current_permission_mode'] } : {}),
    ...(Array.isArray(response?.['models']) ? { models: (response['models'] as Json[]).map((entry) => [entry['value'], entry['resolvedModel'], entry['supportsAutoMode'] === true]) } : {}),
    ...(typeof (response?.['applied'] as Json | undefined)?.['model'] === 'string' ? { applied: (response?.['applied'] as Json)['model'] } : {}),
  };
}

describe.skipIf(claude === null)(`the real Claude Code against the fake API (${claude?.version ?? 'no claude'}; opt-in)`, { timeout: 180_000 }, () => {
  const prompt = 'Run the step.';
  const write = "/bin/sh -c 'echo classified > classified.txt'";
  const run = (args: readonly string[], where: { readonly project: string; readonly env: Record<string, string> }) =>
    runClaude(claude as NonNullable<typeof claude>, { cwd: where.project, env: where.env, args: ['-p', prompt, '--output-format', 'json', ...args], timeoutMs: 120_000 });

  it('auto mode with the classifier\'s default answer (severity 5): the command runs after one stage-1 request, which goes to claude-sonnet-5; the main requests ask for the session\'s model', async () => {
    await start([{ tools: [{ name: 'Bash', input: { command: write, description: 'write through a shell' } }] }, { text: 'done' }]);
    const where = await isolated('allow');
    const result = await run(['--permission-mode', 'auto', '--model', 'sonnet'], where);
    console.log(`[mock-anthropic ${claude?.version}] auto, allowed: exit ${result.code} in ${result.ms} ms; classifier ${JSON.stringify(mock?.classifierRequests().map((request) => `${request.classifier}:${request.model}`))}`);
    expect(result.code).toBe(0);
    expect(existsSync(join(where.project, 'classified.txt'))).toBe(true);
    expect(mock?.classifierRequests().map((request) => [request.classifier, request.model])).toEqual([[1, 'claude-sonnet-5']]);
    expect([...new Set(mock?.requests.filter((request) => request.isMain).map((request) => request.model))]).toEqual(['claude-sonnet-5-5']);
  });

  it('a block (severity 90 and a category): stage 1, then stage 2; the command does not run; Claude Code tells the model the rule and lists the call in `permission_denials`', async () => {
    await start([{ tools: [{ name: 'Bash', input: { command: write, description: 'write through a shell' } }] }, { text: 'done' }], { classifier: () => ({ severity: 90, category: 'Irreversible Local Destruction' }) });
    const where = await isolated('block');
    const result = await run(['--permission-mode', 'auto', '--model', 'sonnet'], where);
    console.log(`[mock-anthropic ${claude?.version}] auto, blocked: exit ${result.code} in ${result.ms} ms; denials ${JSON.stringify(result.final?.['permission_denials'])}`);
    expect(result.code).toBe(0);
    expect(existsSync(join(where.project, 'classified.txt'))).toBe(false);
    expect(mock?.classifierRequests().map((request) => request.classifier)).toEqual([1, 2]);
    expect(mock?.toolResults()).toMatchObject([{ toolUseId: 'toolu_mock_1', isError: true, text: expect.stringContaining('denied by the Claude Code auto mode classifier. Reason: [Irreversible Local Destruction]') }]);
    expect(result.final?.['permission_denials']).toMatchObject([{ tool_name: 'Bash', tool_use_id: 'toolu_mock_1', tool_input: { command: write } }]);
  });

  it('a refused model: the API\'s 404 makes Claude Code\'s "There\'s an issue with the selected model" error result; every main request asked for that model', async () => {
    await start([{ text: 'never' }], { refuseModels: ['claude-fable-5-1'] });
    const where = await isolated('refused');
    const result = await run(['--permission-mode', 'default', '--model', 'fable'], where);
    console.log(`[mock-anthropic ${claude?.version}] refused model: exit ${result.code}; result ${JSON.stringify(result.final?.['result'])}`);
    expect(result.final).toMatchObject({ is_error: true, result: expect.stringContaining("There's an issue with the selected model (claude-fable-5-1).") });
    const mains = mock?.requests.filter((request) => request.isMain) ?? [];
    expect(mains.length).toBeGreaterThan(0);
    expect(new Set(mains.map((request) => request.model))).toEqual(new Set(['claude-fable-5-1']));
  });

  // The control requests of models and modes: each case runs the real binary and the stand-in with the same flags and
  // settings file (the stand-in's `refuseSwitch` stands for the real one's `availableModels`), and compares what the
  // daemon reads of every answer.
  const cases: readonly {
    readonly name: string;
    readonly args: readonly string[];
    readonly settings: Json;
    readonly requests: readonly Json[];
    readonly realSettings?: Json;
    readonly scenario?: FakeClaudeScenario;
    /** The model lists differ on purpose (the real one's `availableModels` shortens it; the stand-in's list is its scenario's). */
    readonly listDiffers?: boolean;
    /** The answers both must give (beyond being the same). */
    readonly expected: readonly Json[];
  }[] = [
    {
      name: 'auto on sonnet: the list, the model, a bypass it was not launched in, set_model, a model without auto mode, an unknown mode, an unknown request',
      args: ['--permission-mode', 'auto', '--model', 'sonnet'],
      settings: {},
      requests: [{ subtype: 'initialize' }, { subtype: 'get_settings' }, { subtype: 'set_permission_mode', mode: 'bypassPermissions' }, { subtype: 'set_model', model: 'haiku' }, { subtype: 'set_permission_mode', mode: 'default' }, { subtype: 'set_permission_mode', mode: 'auto' }, { subtype: 'set_permission_mode', mode: 'nonsense' }, { subtype: 'no_such_request_of_smurg' }],
      expected: [
        { ok: true, current: 'auto' },
        { ok: true, applied: 'claude-sonnet-5-5' },
        { ok: false, code: 'bypass_not_launched' },
        { ok: true, code: null, hasResponse: false },
        { ok: true, mode: 'default' },
        { ok: false, code: 'auto_mode_model' },
        { ok: false, code: 'invalid_mode' },
        { ok: false, code: null },
      ],
    },
    {
      // Every session smurg does not launch in bypass has this key (D8): its switch into bypass is refused with
      // `bypass_disabled`, which 2.1.288 checks BEFORE `bypass_not_launched` (measured here, 2026-10-20).
      name: 'auto with smurg\'s `disableBypassPermissionsMode`: a switch into bypass is `bypass_disabled`',
      args: ['--permission-mode', 'auto', '--model', 'sonnet'],
      settings: { permissions: { disableBypassPermissionsMode: 'disable' } },
      requests: [{ subtype: 'initialize' }, { subtype: 'set_permission_mode', mode: 'bypassPermissions' }],
      expected: [{ ok: true, current: 'auto' }, { ok: false, code: 'bypass_disabled' }],
    },
    {
      name: 'auto with `disableAutoMode`: it starts in default, and a switch into auto is refused',
      args: ['--permission-mode', 'auto', '--model', 'sonnet'],
      settings: { permissions: { disableAutoMode: 'disable' } },
      requests: [{ subtype: 'initialize' }, { subtype: 'set_permission_mode', mode: 'auto' }],
      expected: [{ ok: true, current: 'default' }, { ok: false, code: 'auto_mode_settings' }],
    },
    {
      name: 'auto on haiku: it starts in default',
      args: ['--permission-mode', 'auto', '--model', 'haiku'],
      settings: {},
      requests: [{ subtype: 'initialize' }],
      expected: [{ ok: true, current: 'default' }],
    },
    {
      name: 'bypass with the disable key and defaultMode auto: it starts in auto, and cannot switch into bypass',
      args: ['--permission-mode', 'bypassPermissions', '--model', 'sonnet'],
      settings: { permissions: { disableBypassPermissionsMode: 'disable', defaultMode: 'auto' } },
      requests: [{ subtype: 'initialize' }, { subtype: 'set_permission_mode', mode: 'bypassPermissions' }],
      expected: [{ ok: true, current: 'auto' }, { ok: false, code: 'bypass_disabled' }],
    },
    {
      name: 'bypass without the disable key: it starts in bypass, and may go back to it',
      args: ['--permission-mode', 'bypassPermissions', '--model', 'sonnet'],
      settings: { permissions: { defaultMode: 'auto' } },
      requests: [{ subtype: 'initialize' }, { subtype: 'set_permission_mode', mode: 'default' }, { subtype: 'set_permission_mode', mode: 'bypassPermissions' }],
      expected: [{ ok: true, current: 'bypassPermissions' }, { ok: true, mode: 'default' }, { ok: true, mode: 'bypassPermissions' }],
    },
    {
      name: 'a model the organization restricts: set_model is refused with restricted_by_org',
      args: ['--permission-mode', 'default', '--model', 'sonnet'],
      settings: {},
      realSettings: { availableModels: ['sonnet', 'opus'] },
      scenario: { refuseSwitch: ['fable'] },
      listDiffers: true,
      requests: [{ subtype: 'initialize' }, { subtype: 'set_model', model: 'fable' }, { subtype: 'set_model', model: 'opus' }],
      expected: [{ ok: true, current: 'default' }, { ok: false, code: 'restricted_by_org' }, { ok: true, hasResponse: false }],
    },
  ];

  it.for(cases)('the stand-in answers like $name', async (testCase) => {
    await start();
    const where = await isolated('control');
    const settingsFile = async (settings: Json, name: string): Promise<string> => {
      const path = join(where.dir, `${name}.json`);
      await writeFile(path, JSON.stringify(settings));
      return path;
    };
    const tail = ['--setting-sources', 'user'];
    const real = await controlRun((claude as NonNullable<typeof claude>).path, [...testCase.args, '--settings', await settingsFile(testCase.realSettings ?? testCase.settings, 'real'), ...tail], where.project, where.env, testCase.requests);
    const standInDir = join(where.dir, 'stand-in');
    await mkdir(standInDir, { recursive: true });
    const standIn = await installFakeClaude(standInDir, testCase.scenario ?? {});
    const fake = await controlRun(standIn.path, [...testCase.args, '--settings', await settingsFile(testCase.settings, 'fake'), ...tail], where.project, { ...where.env, ...standIn.env }, testCase.requests);
    const comparable = (answers: readonly ControlAnswer[]): Json[] => answers.map(summary).map(({ models, ...rest }) => (testCase.listDiffers === true ? rest : { ...rest, ...(models === undefined ? {} : { models }) }));
    const realSummary = comparable(real.answers);
    const fakeSummary = comparable(fake.answers);
    console.log(`[mock-anthropic ${claude?.version}] ${testCase.name}:\n  real  ${JSON.stringify(realSummary)} exit ${real.code}\n  stand ${JSON.stringify(fakeSummary)} exit ${fake.code}`);
    expect(fakeSummary).toEqual(realSummary);
    expect(realSummary).toMatchObject(testCase.expected);
    // Neither started a turn, and both ended by themselves when stdin closed.
    expect([real.code, fake.code]).toEqual([0, 0]);
    expect(await readFile(join(standInDir, 'fake-claude-echo.jsonl'), 'utf8')).toContain('"kind":"argv"');
  });
  it('a model the organization restricts, named at the start: the default model runs and an informational line says so; the stand-in (`refuseSwitch`) does the same', async () => {
    await start([{ text: 'hello' }]);
    const where = await isolated('restricted');
    const settings = join(where.dir, 'available.json');
    await writeFile(settings, JSON.stringify({ availableModels: ['sonnet', 'opus'] }));
    const empty = join(where.dir, 'empty.json');
    await writeFile(empty, '{}');
    const args = ['--permission-mode', 'default', '--model', 'fable', '--setting-sources', 'user'];
    const real = await controlRun((claude as NonNullable<typeof claude>).path, [...args, '--settings', settings], where.project, where.env, [{ subtype: 'initialize' }], 'hello');
    const standInDir = join(where.dir, 'stand-in');
    await mkdir(standInDir, { recursive: true });
    const standIn = await installFakeClaude(standInDir, { refuseSwitch: ['fable'], defaultModel: 'claude-opus-5-5' });
    const fake = await controlRun(standIn.path, [...args, '--settings', empty], where.project, { ...where.env, ...standIn.env }, [{ subtype: 'initialize' }], 'hello');
    const seen = (lines: readonly Json[]): Json => ({
      init: lines.filter((line) => line['type'] === 'system' && line['subtype'] === 'init').map((line) => line['model']),
      informational: [...new Set(lines.filter((line) => line['type'] === 'system' && line['subtype'] === 'informational').map((line) => String(line['content'])).filter((text) => text.includes('restricted')))],
    });
    console.log(`[mock-anthropic ${claude?.version}] restricted at the start: real ${JSON.stringify(seen(real.lines))}, stand-in ${JSON.stringify(seen(fake.lines))}`);
    expect(seen(fake.lines)).toEqual(seen(real.lines));
    expect(seen(real.lines)).toEqual({ init: ['claude-opus-5-5'], informational: ['Model "fable" is restricted by your organization\'s settings. Using claude-opus-5-5 instead.'] });
    expect([real.code, fake.code]).toEqual([0, 0]);
  });
  it('auto mode\'s lines: the fast path runs with no classifier, a block is a `permission_denied` line and an error result, the third block in a row asks a person; the stand-in prints the same', async () => {
    const commands = ['echo hi > made.txt', "/bin/sh -c 'echo 1 > a.txt'", "/bin/sh -c 'echo 2 > b.txt'", "/bin/sh -c 'echo 3 > c.txt'"];
    await start([...commands.map((command) => ({ tools: [{ name: 'Bash', input: { command } }] })), { text: 'done' }], { classifier: () => ({ severity: 90, category: 'Irreversible Local Destruction' }) });
    const where = await isolated('auto-lines');
    const args = ['--permission-mode', 'auto', '--model', 'sonnet', '--setting-sources', 'user'];
    const real = await controlRun((claude as NonNullable<typeof claude>).path, args, where.project, where.env, [{ subtype: 'initialize' }], 'Run the steps.');
    const realStage1 = mock?.classifierRequests().filter((request) => request.classifier === 1).length;
    const standInDir = join(where.dir, 'stand-in');
    const standInProject = join(where.dir, 'stand-in-project');
    await mkdir(standInDir, { recursive: true });
    await mkdir(standInProject, { recursive: true });
    const standIn = await installFakeClaude(standInDir, {
      classifier: { block: ['^/bin/sh'], category: 'Irreversible Local Destruction' },
      turns: [{ steps: [...commands.map((command, index) => ({ tool: 'Bash', id: `toolu_mock_${index + 1}`, input: { command }, run: true })), { text: 'done' }] }],
    });
    const fake = await controlRun(standIn.path, args, await realpath(standInProject), { ...where.env, ...standIn.env }, [{ subtype: 'initialize' }], 'Run the steps.');
    const seen = (lines: readonly Json[]): Json => {
      const denied = lines.filter((line) => line['type'] === 'system' && line['subtype'] === 'permission_denied');
      const results = lines.flatMap((line) => (line['type'] === 'user' && Array.isArray((line['message'] as Json)['content']) ? ((line['message'] as Json)['content'] as Json[]).filter((part) => part['type'] === 'tool_result').map((part) => ({ part, line })) : []));
      const asked = lines.filter((line) => line['type'] === 'control_request' && (line['request'] as Json)['subtype'] === 'can_use_tool').map((line) => line['request'] as Json);
      const result = lines.find((line) => line['type'] === 'result');
      return {
        denied: denied.map((line) => [line['tool_use_id'], line['tool_name'], line['decision_reason_type'], line['decision_reason'], String(line['message']).startsWith('Permission for this action was denied by the Claude Code auto mode classifier. Reason: [Irreversible Local Destruction].'), Object.keys(line).filter((key) => key !== 'timestamp').toSorted()]),
        results: results.map(({ part, line }) => [part['tool_use_id'], part['is_error'] === true, line['tool_result_meta'] ?? null, typeof line['tool_use_result'] === 'string' ? String(line['tool_use_result']).slice(0, 40) : null]),
        asked: asked.map((request) => [request['tool_use_id'], request['decision_reason_type'], request['decision_reason'], request['permission_suggestions']]),
        denials: ((result?.['permission_denials'] as Json[] | undefined) ?? []).map((entry) => [entry['tool_use_id'], entry['tool_name']]),
      };
    };
    console.log(`[mock-anthropic ${claude?.version}] auto lines:\n  real  ${JSON.stringify(seen(real.lines))} (stage-1 requests ${realStage1})\n  stand ${JSON.stringify(seen(fake.lines))} (classified ${(await standIn.classified()).length})`);
    expect(seen(fake.lines)).toEqual(seen(real.lines));
    expect(realStage1).toBe(3);
    expect((await standIn.classified()).map((entry) => entry.verdict)).toEqual(['block', 'block', 'block']);
    const what = seen(real.lines) as { denied: unknown[][]; asked: unknown[][]; denials: unknown[][] };
    expect(what.denied.map((line) => line.slice(0, 5))).toEqual([['toolu_mock_2', 'Bash', 'classifier', '[Irreversible Local Destruction]', true], ['toolu_mock_3', 'Bash', 'classifier', '[Irreversible Local Destruction]', true]]);
    expect(what.asked.map((request) => request.slice(0, 3))).toEqual([['toolu_mock_4', 'classifier', '3 consecutive actions were blocked. Please review the transcript before continuing.\n\nLatest blocked action: [Irreversible Local Destruction]']]);
    expect(what.denials).toEqual([['toolu_mock_2', 'Bash'], ['toolu_mock_3', 'Bash'], ['toolu_mock_4', 'Bash']]);
    expect([existsSync(join(where.project, 'made.txt')), existsSync(join(standInProject, 'made.txt'))]).toEqual([true, true]);
    expect([existsSync(join(where.project, 'a.txt')), existsSync(join(standInProject, 'a.txt'))]).toEqual([false, false]);
  });
});
