// The PURE parts of the agent runtime (DESIGN §2.3, §2.5, §2.10): one Claude Code line → runner events, a tool call →
// its view and result, a kind of session → its launch profile, the launch check, the file rule, the tool gate's table.
import { describe, expect, it } from 'vitest';
import { AGENT_EDIT_DENY_PATTERNS, AGENT_READ_DENY_PATTERNS, MAIN_ROOT, toolViewSchema, toolResultViewSchema, worktreeRoot, type FileRef } from '@smurg/protocol';
import { gateDenyReason } from '../../src/hooks/deny-text.ts';
import { ANY_MCP_TOOL as GATE_ANY_MCP, gateDecision, patternLeavesRoot } from '../../src/hooks/tool-gate.ts';
import { questionPartsOf, streamableLength } from '../../src/sessions/agent/agent-runner.ts';
import { hostRulesOf } from '../../src/sessions/agent/host-rules.ts';
import { Normaliser, outcomeOfResult } from '../../src/sessions/agent/normalise.ts';
import { ANY_MCP_TOOL, DISCUSSION_TOOLS, EXECUTION_TOOLS, RulePathError, STREAM_ARGS, buildProfile, checkLaunchArgs, claudeModeFor, daemonAllowsEdits, fileRule, gateToolsOf } from '../../src/sessions/agent/profiles.ts';
import { effectsOf, isFlaggedEnvName } from '../../src/sessions/agent/project-settings.ts';
import { conversationLostText, freeRolePrompt } from '../../src/sessions/agent/prompts.ts';
import { buildToolResult, buildToolView, diffFromPatch, editOf, headTail, safeId, suggestedRuleOf, toolPathOf } from '../../src/sessions/agent/tool-view.ts';

const file = (path: string): FileRef => ({ root: MAIN_ROOT, path });
const inRoot = (path: string) => ({ kind: 'in', file: file(path) }) as const;
const rel = (absolute: string): string | null => (absolute.startsWith('/p/') ? absolute.slice(3) : null);

describe('normalise: Claude Code lines → runner events', () => {
  it('everything DESIGN §2.3 lists, and nothing else: unknown types and thinking blocks are ignored', () => {
    const n = new Normaliser();
    const one = (line: unknown) => n.normalise(line as Record<string, unknown>);
    expect(one({ type: 'system', subtype: 'init', session_id: 'c1', tools: ['Read', 7], claude_code_version: '2.1.288', permissionMode: 'default', apiKeySource: 'none' })).toEqual([{ kind: 'init', claudeSessionId: 'c1', version: '2.1.288', tools: ['Read'], permissionMode: 'default', apiKeySource: 'none' }]);
    expect(one({ type: 'stream_event', event: { type: 'message_start', message: { id: 'msg_1' } }, parent_tool_use_id: null })).toEqual([]);
    expect(one({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hel' } } })).toEqual([{ kind: 'delta', blockKey: 'msg_1:0', text: 'Hel' }]);
    expect(one({ type: 'stream_event', event: { type: 'content_block_delta', index: 1, delta: { type: 'thinking_delta', thinking: 'secret thoughts' } } })).toEqual([{ kind: 'thinking', blockKey: 'msg_1:1' }]);
    expect(one({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{' } } })).toEqual([]);
    // One finished block per assistant line; the n-th block of a message has the key its deltas had.
    expect(one({ type: 'assistant', message: { id: 'msg_1', model: 'claude', content: [{ type: 'text', text: 'Hello' }] } })).toEqual([{ kind: 'text', blockKey: 'msg_1:0', text: 'Hello', aborted: false, synthetic: false }]);
    expect(one({ type: 'assistant', message: { id: 'msg_1', content: [{ type: 'thinking', thinking: 'x' }] } })).toEqual([]);
    expect(one({ type: 'assistant', message: { id: 'msg_1', content: [{ type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'ls' } }] }, parent_tool_use_id: 'toolu_0' })).toEqual([{ kind: 'tool.use', toolUseId: 'toolu_1', name: 'Bash', input: { command: 'ls' }, parentToolUseId: 'toolu_0' }]);
    expect(one({ type: 'assistant', message: { id: 'm2', model: '<synthetic>', content: [{ type: 'text', text: 'Not logged in · Please run /login' }] }, aborted: true })).toEqual([{ kind: 'text', blockKey: 'm2:0', text: 'Not logged in · Please run /login', aborted: true, synthetic: true }]);
    expect(one({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: [{ type: 'text', text: 'a' }, { type: 'image' }], is_error: true }] }, tool_use_result: { stdout: 'a' } })).toEqual([{ kind: 'tool.result', toolUseId: 'toolu_1', ok: false, text: 'a[image]', structured: { stdout: 'a' } }]);
    expect(one({ type: 'user', uuid: 'u1', isReplay: true, message: { content: [{ type: 'text', text: 'hi' }] } })).toEqual([{ kind: 'replay', uuid: 'u1' }]);
    expect(one({ type: 'command_lifecycle', command_uuid: 'u1', state: 'started' })).toEqual([{ kind: 'lifecycle', uuid: 'u1', state: 'started' }]);
    expect(one({ type: 'command_lifecycle', command_uuid: 'u1', state: 'exploded' })).toEqual([]);
    expect(one({ type: 'control_request', request_id: 'r1', request: { subtype: 'can_use_tool', tool_name: 'Bash', tool_use_id: 'toolu_1', input: { command: 'ls' }, permission_suggestions: [1], decision_reason: 'why', decision_reason_type: 'safetyCheck', blocked_path: '/x' } })).toEqual([
      { kind: 'request', requestId: 'r1', toolName: 'Bash', toolUseId: 'toolu_1', input: { command: 'ls' }, reason: 'why', reasonType: 'safetyCheck', blockedPath: '/x', suggestions: [1] },
    ]);
    expect(one({ type: 'control_request', request_id: 'r2', request: { subtype: 'hook_callback' } })).toEqual([{ kind: 'request.unsupported', requestId: 'r2', subtype: 'hook_callback' }]);
    expect(one({ type: 'control_cancel_request', request_id: 'r1' })).toEqual([{ kind: 'request.cancelled', requestId: 'r1' }]);
    expect(one({ type: 'control_response', response: { subtype: 'success', request_id: 's1', response: { a: 1 } } })).toEqual([{ kind: 'control.response', requestId: 's1', ok: true, response: { a: 1 } }]);
    expect(one({ type: 'control_response', response: { subtype: 'error', request_id: 's2', error: 'no' } })).toEqual([{ kind: 'control.response', requestId: 's2', ok: false, response: {}, error: 'no' }]);
    expect(one({ type: 'system', subtype: 'api_retry', error: 'authentication_failed', attempt: 2, max_retries: 10 })).toEqual([{ kind: 'api.retry', error: 'authentication_failed', attempt: 2, max: 10, auth: true }]);
    expect(one({ type: 'rate_limit_event', rate_limit_info: { status: 'rejected', resetsAt: 1_900_000_000 } })).toEqual([{ kind: 'rate.limit', allowed: false, resetsAt: 1_900_000_000_000 }]);
    expect(one({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed_warning' } })).toEqual([{ kind: 'rate.limit', allowed: true }]);
    expect(one({ type: 'system', subtype: 'status', status: 'compacting' })).toEqual([{ kind: 'status', compacting: true }]);
    expect(one({ type: 'system', subtype: 'status', status: null, permissionMode: 'acceptEdits' })).toEqual([{ kind: 'status', permissionMode: 'acceptEdits' }]);
    expect(one({ type: 'system', subtype: 'status', status: 'requesting' })).toEqual([]);
    expect(one({ type: 'system', subtype: 'compact_boundary' })).toEqual([{ kind: 'compact.boundary' }]);
    expect(one({ type: 'result', subtype: 'success', is_error: false, terminal_reason: 'completed', duration_ms: 12.4, user_message_uuids: ['u1', 3] })).toEqual([{ kind: 'result', outcome: 'completed', durationMs: 12, uuids: ['u1'], apiError: false }]);
    for (const ignored of [{ type: 'keep_alive' }, { type: 'system', subtype: 'hook_started' }, { type: 'brand_new_type', x: 1 }, { type: 'system', subtype: 'informational', content: 'x' }]) expect(one(ignored)).toEqual([]);
    expect(Normaliser.parse('not json')).toBeNull();
    expect(Normaliser.parse('[1]')).toBeNull();
  });

  it('a subagent streams in its own lane: its deltas and blocks carry the parent tool use and never take the main message id', () => {
    const n = new Normaliser();
    n.normalise({ type: 'stream_event', event: { type: 'message_start', message: { id: 'main' } } });
    n.normalise({ type: 'stream_event', event: { type: 'message_start', message: { id: 'sub' } }, parent_tool_use_id: 'toolu_task' });
    expect(n.normalise({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'a' } }, parent_tool_use_id: 'toolu_task' })).toEqual([{ kind: 'delta', blockKey: 'sub:0', text: 'a', parentToolUseId: 'toolu_task' }]);
    expect(n.normalise({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'b' } } })).toEqual([{ kind: 'delta', blockKey: 'main:0', text: 'b' }]);
  });

  it('the outcome of a turn from subtype and terminal_reason', () => {
    expect(outcomeOfResult({ subtype: 'success', is_error: false, terminal_reason: 'completed' })).toBe('completed');
    expect(outcomeOfResult({ subtype: 'success', is_error: true, terminal_reason: 'api_error' })).toBe('error');
    expect(outcomeOfResult({ subtype: 'error_during_execution', terminal_reason: 'aborted_streaming' })).toBe('interrupted');
    expect(outcomeOfResult({ subtype: 'error_during_execution', terminal_reason: 'aborted_tools' })).toBe('interrupted');
    expect(outcomeOfResult({ subtype: 'error_max_turns' })).toBe('max-turns');
    expect(outcomeOfResult({ subtype: 'error_max_budget_usd' })).toBe('budget');
    expect(outcomeOfResult({ subtype: 'error_during_execution' })).toBe('error');
  });
});

describe('tool views and results', () => {
  it('ToolView per tool: verb and target; a path outside every root has no target; a host-private path has no file', () => {
    expect(buildToolView('Read', { file_path: '/p/src/a.ts' }, inRoot('src/a.ts'))).toEqual({ name: 'Read', verb: 'read', target: 'src/a.ts', file: file('src/a.ts') });
    expect(buildToolView('Edit', { file_path: '/p/src/a.ts' }, inRoot('src/a.ts'))).toMatchObject({ verb: 'edit', target: 'src/a.ts' });
    expect(buildToolView('Write', { file_path: '/p/new.ts' }, inRoot('new.ts'), { created: true })).toMatchObject({ verb: 'create' });
    expect(buildToolView('Write', { file_path: '/p/old.ts' }, inRoot('old.ts'))).toMatchObject({ verb: 'edit' });
    expect(buildToolView('Read', { file_path: '/etc/passwd' }, { kind: 'outside' })).toEqual({ name: 'Read', verb: 'read', outside: true });
    expect(buildToolView('Read', { file_path: '/p/.envrc' }, inRoot('.envrc'))).toEqual({ name: 'Read', verb: 'read', target: '.envrc' });
    expect(buildToolView('Bash', { command: 'pnpm test', description: 'run' }, { kind: 'none' })).toEqual({ name: 'Bash', verb: 'run', target: 'pnpm test' });
    expect(buildToolView('Grep', { pattern: 'TODO', path: '/p/src' }, inRoot('src'))).toEqual({ name: 'Grep', verb: 'search', target: 'TODO' });
    expect(buildToolView('Glob', { pattern: '**/*.ts', path: '/etc' }, { kind: 'outside' })).toEqual({ name: 'Glob', verb: 'search', outside: true });
    expect(buildToolView('WebFetch', { url: 'https://example.com/a', prompt: 'x' }, { kind: 'none' })).toEqual({ name: 'WebFetch', verb: 'fetch', target: 'https://example.com/a' });
    expect(buildToolView('WebSearch', { query: 'smurg' }, { kind: 'none' })).toMatchObject({ verb: 'fetch', target: 'smurg' });
    expect(buildToolView('Task', { description: 'Explore', prompt: 'long' }, { kind: 'none' })).toEqual({ name: 'Task', verb: 'task', target: 'Explore' });
    expect(buildToolView('mcp__smurg__check_plan', {}, { kind: 'none' })).toEqual({ name: 'mcp__smurg__check_plan', verb: 'smurg', target: 'check_plan' });
    expect(buildToolView('mcp__mail__send', { to: 'x' }, { kind: 'none' })).toEqual({ name: 'mcp__mail__send', verb: 'other', target: 'mcp__mail__send' });
    expect(buildToolView('Bad\u0000Name\n', null, { kind: 'none' }).name).toBe('BadName');
    for (const view of [buildToolView('x'.repeat(200), {}, { kind: 'none' }), buildToolView('Bash', { command: 'a'.repeat(100_000) }, { kind: 'none' })]) expect(toolViewSchema.safeParse(view).success).toBe(true);
    expect(toolPathOf('Edit', { file_path: 'a' })).toBe('a');
    expect(toolPathOf('NotebookEdit', { notebook_path: 'n.ipynb' })).toBe('n.ipynb');
    expect(toolPathOf('Grep', { pattern: 'x', path: 'src' })).toBe('src');
    expect(toolPathOf('Bash', { command: 'cat a' })).toBeUndefined();
    expect(safeId('toolu_01AbC-x', 'tu')).toBe('toolu_01AbC-x');
    expect(safeId('msg:0 /x', 'b')).toBe('b_msg_0__x');
    expect(safeId(undefined, 'tu')).toBe('tu_unknown');
  });

  it('results: a diff with counts for an edit, the created text as additions, head and tail of a command output with its exit code, file NAMES of a search, never the content of a read; everything masked and bounded', () => {
    const edit = buildToolView('Edit', { file_path: '/p/a.ts' }, inRoot('a.ts'));
    const patch = [{ oldStart: 1, oldLines: 2, newStart: 1, newLines: 2, lines: [' keep', '-old', '+new'] }];
    expect(buildToolResult({ view: edit, ok: true, text: 'updated', structured: { structuredPatch: patch }, durationMs: 12, relativePath: rel })).toEqual({ durationMs: 12, additions: 1, deletions: 1, body: { kind: 'diff', text: '@@ -1,2 +1,2 @@\n keep\n-old\n+new\n', truncated: false } });
    expect(diffFromPatch([])).toBeNull();
    const created = buildToolView('Write', { file_path: '/p/n.ts' }, inRoot('n.ts'), { created: true });
    expect(buildToolResult({ view: created, ok: true, text: 'created', structured: { type: 'create', content: 'a\nb\n', structuredPatch: [] }, relativePath: rel })).toEqual({ additions: 2, deletions: 0, body: { kind: 'diff', text: '+a\n+b\n', truncated: false } });
    // A read never has a body, whatever Claude Code sent.
    expect(buildToolResult({ view: buildToolView('Read', {}, inRoot('a.ts')), ok: true, text: '1\tSECRET', structured: { file: { content: 'SECRET' } }, relativePath: rel })).toEqual({});
    // A path outside the workspace, and a host-private one: no body either.
    expect(buildToolResult({ view: { name: 'Edit', verb: 'edit', outside: true }, ok: true, text: 'x', structured: { structuredPatch: patch }, relativePath: rel })).toEqual({});
    expect(buildToolResult({ view: buildToolView('Edit', {}, inRoot('.envrc')), ok: true, text: 'x', structured: { structuredPatch: patch }, relativePath: rel })).toEqual({});
    const bash = buildToolView('Bash', { command: 'pnpm test' }, { kind: 'none' });
    expect(buildToolResult({ view: bash, ok: true, text: 'out', structured: { stdout: '\u001b[32mok\u001b[0m', stderr: 'warn' }, relativePath: rel })).toEqual({ exitCode: 0, body: { kind: 'output', text: 'ok\nwarn', truncated: false } });
    expect(buildToolResult({ view: bash, ok: false, text: 'Exit code 2\nboom', structured: { stdout: '', stderr: 'boom' }, relativePath: rel })).toMatchObject({ exitCode: 2, body: { kind: 'output', text: 'boom' } });
    const long = buildToolResult({ view: bash, ok: true, text: '', structured: { stdout: 'a'.repeat(200_000), stderr: '' }, relativePath: rel });
    expect(long.body?.truncated).toBe(true);
    expect(Buffer.byteLength(long.body?.text ?? '')).toBeLessThanOrEqual(64 * 1024 + 16 * 1024 + 8);
    expect(headTail('abc', 10, 10)).toEqual({ text: 'abc', truncated: false });
    // Secrets in what a tool printed are masked before anything is stored or sent.
    const leaked = buildToolResult({ view: bash, ok: true, text: '', structured: { stdout: 'token ghp_abcdefghijklmnopqrstuvwxyz0123456789 end', stderr: '' }, relativePath: rel });
    expect(leaked.body?.text).not.toContain('ghp_abcdefghijklmnopqrstuvwxyz0123456789');
    // A search: names relative to the root, never a host-private one, never one outside, never matched lines.
    const grep = buildToolView('Grep', { pattern: 'SECRET' }, { kind: 'none' });
    expect(buildToolResult({ view: grep, ok: true, text: 'a.ts:1:SECRET=1', structured: { mode: 'content', filenames: ['/p/src/a.ts', '/p/.envrc', '/p/.git/config', '/elsewhere/b.ts'], numFiles: 4, content: 'SECRET=1' }, relativePath: rel })).toEqual({ matches: 4, body: { kind: 'list', text: 'src/a.ts\n', truncated: true } });
    expect(buildToolResult({ view: buildToolView('TodoWrite', {}, { kind: 'none' }), ok: true, text: 'ok', structured: { newTodos: [{ content: 'one', status: 'completed' }, { content: 'two', status: 'pending' }] }, relativePath: rel })).toEqual({ body: { kind: 'list', text: '[x] one\n[ ] two\n', truncated: false } });
    const fetched = buildToolResult({ view: buildToolView('WebFetch', { url: 'https://x.example' }, { kind: 'none' }), ok: true, text: 'b'.repeat(40_000), structured: {}, relativePath: rel });
    expect(fetched.body).toMatchObject({ kind: 'text', truncated: true });
    expect(fetched.body?.text.length).toBe(16 * 1024);
    for (const result of [long, fetched, leaked]) expect(toolResultViewSchema.safeParse(result).success).toBe(true);
  });

  it('the normalised edit of a permission request, and the rule Claude Code suggests (never its destination)', () => {
    expect(editOf('Write', { file_path: 'a', content: 'x' })).toEqual({ kind: 'write', text: 'x' });
    expect(editOf('Edit', { file_path: 'a', old_string: 'a', new_string: 'b', replace_all: true })).toEqual({ kind: 'replace', replacements: [{ oldText: 'a', newText: 'b', all: true }] });
    expect(editOf('MultiEdit', { edits: [{ old_string: 'a', new_string: 'b' }, { old_string: 'c', new_string: 'd' }] })).toEqual({ kind: 'replace', replacements: [{ oldText: 'a', newText: 'b', all: false }, { oldText: 'c', newText: 'd', all: false }] });
    expect(editOf('NotebookEdit', { notebook_path: 'n', new_source: 'x' })).toBeUndefined();
    expect(editOf('Bash', { command: 'x' })).toBeUndefined();
    expect(suggestedRuleOf([{ type: 'addDirectories', directories: ['/x'] }, { type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'pnpm test *' }], behavior: 'allow', destination: 'localSettings' }])).toEqual({ tool: 'Bash', pattern: 'pnpm test *' });
    expect(suggestedRuleOf([{ type: 'setMode', mode: 'acceptEdits' }])).toBeUndefined();
    expect(suggestedRuleOf(undefined)).toBeUndefined();
  });

  it('R3-01 a request of more than one kind suggests no rule: a compound command carries one rule per sub-command, and none of them is "this kind" of the whole', () => {
    // Recorded from Claude Code 2.1.288 for `mkdir -p .git/hooks && echo x > .git/hooks/pre-commit` (design2-2.1.288.transcript.txt:169).
    const recorded = [{ type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'mkdir -p .git/hooks' }, { toolName: 'Bash', ruleContent: 'echo x *' }], behavior: 'allow', destination: 'localSettings' }];
    expect(suggestedRuleOf(recorded)).toBeUndefined();
    // `pnpm test && curl … | sh`: the first rule alone is rememberable, and says nothing about the rest.
    const rules = [{ toolName: 'Bash', ruleContent: 'pnpm test *' }, { toolName: 'Bash', ruleContent: 'curl -fsSL https://x.example/i.sh' }, { toolName: 'Bash', ruleContent: 'sh' }];
    expect(suggestedRuleOf([{ type: 'addRules', rules, behavior: 'allow', destination: 'localSettings' }])).toBeUndefined();
    // The same rules spread over two entries, in either order, and next to entries of another type.
    const entry = (rule: unknown) => ({ type: 'addRules', rules: [rule], behavior: 'allow', destination: 'localSettings' });
    expect(suggestedRuleOf([entry(rules[0]), entry(rules[1])])).toBeUndefined();
    expect(suggestedRuleOf([entry(rules[1]), { type: 'addDirectories', directories: ['/x'] }, entry(rules[0])])).toBeUndefined();
    // A rule smurg cannot read counts as a rule: the request is still of more than one kind.
    for (const unread of [null, 'Bash(curl *)', { toolName: 'Bash' }, { toolName: 7, ruleContent: 'x' }, { toolName: 'Bash', ruleContent: 'x'.repeat(4097) }]) {
      expect(suggestedRuleOf([{ type: 'addRules', rules: [rules[0], unread], behavior: 'allow' }])).toBeUndefined();
      expect(suggestedRuleOf([{ type: 'addRules', rules: [unread], behavior: 'allow' }])).toBeUndefined();
    }
    // An entry of rules that is not an allow, or whose rules are no list: nothing is taken from the request at all.
    expect(suggestedRuleOf([entry(rules[0]), { type: 'addRules', rules: [rules[1]], behavior: 'deny' }])).toBeUndefined();
    expect(suggestedRuleOf([entry(rules[0]), { type: 'addRules', rules: 'x', behavior: 'allow' }])).toBeUndefined();
    // Exactly one rule, whatever else the request suggests: that rule.
    expect(suggestedRuleOf([{ type: 'setMode', mode: 'acceptEdits', destination: 'session' }, entry(rules[0]), { type: 'addDirectories', directories: ['/x'] }])).toEqual({ tool: 'Bash', pattern: 'pnpm test *' });
  });

  it('AskUserQuestion input → question parts, or null when the wire cannot carry it (nothing is clipped)', () => {
    const option = (label: string) => ({ label, description: `${label}!` });
    const q = (question: string, options = [option('a'), option('b')]) => ({ question, header: 'H', multiSelect: false, options });
    expect(questionPartsOf({ questions: [q('One?'), { ...q('Two?'), multiSelect: true }] })).toEqual([
      { header: 'H', text: 'One?', multi: false, options: [{ label: 'a', description: 'a!' }, { label: 'b', description: 'b!' }] },
      { header: 'H', text: 'Two?', multi: true, options: [{ label: 'a', description: 'a!' }, { label: 'b', description: 'b!' }] },
    ]);
    expect(questionPartsOf({ questions: [q('Same?'), q('Same?')] })).toBeNull();
    expect(questionPartsOf({ questions: [q('Many?', ['a', 'b', 'c', 'd', 'e'].map(option))] })).toBeNull();
    expect(questionPartsOf({ questions: [1, 2, 3, 4, 5].map((i) => q(`Q${i}?`)) })).toBeNull();
    expect(questionPartsOf({ questions: [q('x'.repeat(5_000))] })).toBeNull();
    expect(questionPartsOf({ questions: [] })).toBeNull();
    expect(questionPartsOf('nonsense')).toBeNull();
  });

  it('a streaming block shows everything but its last unfinished word, so a token is masked whole before any of it is sent', () => {
    expect(streamableLength('The key is ghp_abc')).toBe('The key is '.length);
    expect(streamableLength('Done. ')).toBe(6);
    expect(streamableLength('好的，我來看')).toBe(6);
    expect(streamableLength('x'.repeat(300))).toBe(300);
  });
});

describe('launch profiles (DESIGN §2.5)', () => {
  const base = { root: MAIN_ROOT, rootRealPath: '/Users/ian/shop', rules: [], trust: 'used', agentMcp: false, rolePrompt: 'P' } as const;

  it('a file rule is written with the absolute form `//<realpath>/<pattern>`; a root or pattern that could end the rule is refused', () => {
    expect(fileRule('Edit', '/Users/ian/shop', 'specs/checkout/SPEC.md')).toBe('Edit(//Users/ian/shop/specs/checkout/SPEC.md)');
    expect(fileRule('Read', '/Users/ian/shop/', '**/.envrc')).toBe('Read(//Users/ian/shop/**/.envrc)');
    for (const [root, pattern] of [['/a', 'x)'], ['/a', 'x(y'], ['/a', 'x\ny'], ['/a', 'x\\y'], ['relative', 'x'], ['/a', '/abs'], ['/a', '']] as const) expect(() => fileRule('Edit', root, pattern)).toThrow();
  });

  it('R3-05 a shared folder with ( ) [ ] { } * ? ! or a space in its path: rules that Claude Code reads as that folder (brackets escaped, the rest as it is; verified with 2.1.288); a backslash or a control character is refused as a folder name, not as a failed start', () => {
    // Parentheses need nothing: "Dropbox (Acme)", "shop (copy)".
    expect(fileRule('Read', '/Users/ian/Dropbox (Acme)/shop (copy)', '.envrc')).toBe('Read(//Users/ian/Dropbox (Acme)/shop (copy)/.envrc)');
    expect(fileRule('Read', '/a)b(c', '**/.envrc')).toBe('Read(//a)b(c/**/.envrc)');
    // A bracket would open a character class (the rule then matches nothing): escaped it is itself.
    expect(fileRule('Read', '/Users/ian/code/[wip]/shop', '.envrc')).toBe('Read(//Users/ian/code/\\[wip\\]/shop/.envrc)');
    expect(fileRule('Edit', '/w/a[b]c/', 'specs/checkout/SPEC.md')).toBe('Edit(//w/a\\[b\\]c/specs/checkout/SPEC.md)');
    // `*`, `?`, `{`, `}`, `!` match themselves unescaped; an escaped `?` would match nothing.
    expect(fileRule('Read', '/w/st*r/q?m/br{a,b}/bang!x', '.envrc')).toBe('Read(//w/st*r/q?m/br{a,b}/bang!x/.envrc)');
    const profile = buildProfile({ ...base, purpose: 'discussion', mode: 'ask-all', rootRealPath: '/Users/ian/Dropbox (Acme)/[wip] shop', topicSlug: 'checkout' });
    expect(profile.allow).toEqual(['Edit(//Users/ian/Dropbox (Acme)/\\[wip\\] shop/specs/checkout/SPEC.md)', 'Edit(//Users/ian/Dropbox (Acme)/\\[wip\\] shop/specs/checkout/PLAN.md)']);
    expect(profile.deny).toContain('Read(//Users/ian/Dropbox (Acme)/\\[wip\\] shop/.envrc)');
    for (const root of ['/Users/ian/back\\slash', '/Users/ian/line\nbreak', '/Users/ian/bell\u0007']) {
      expect(() => fileRule('Read', root, '.envrc'), root).toThrow(RulePathError);
      expect(() => buildProfile({ ...base, purpose: 'free', mode: 'ask-all', rootRealPath: root }), root).toThrow(RulePathError);
    }
  });

  it('a discussion: the default mode, six tools, only its two files allowed, only smurg\'s MCP server, whatever the host set', () => {
    const profile = buildProfile({ ...base, purpose: 'discussion', mode: 'ask-all', topicSlug: 'checkout', agentMcp: true, rules: [{ tool: 'Bash', pattern: 'pnpm test *' }] });
    expect(profile.mode).toBe('default');
    expect(profile.tools).toEqual(['Read', 'Glob', 'Grep', 'Edit', 'Write', 'AskUserQuestion']);
    expect(profile.tools).toBe(DISCUSSION_TOOLS);
    expect(profile.allow).toEqual(['Edit(//Users/ian/shop/specs/checkout/SPEC.md)', 'Edit(//Users/ian/shop/specs/checkout/PLAN.md)']);
    expect(profile.strictMcp).toBe(true);
    expect(profile.ask).toEqual([]);
    expect(gateToolsOf(profile)).toEqual(DISCUSSION_TOOLS);
  });

  it('a work item: acceptEdits in its worktree, the execution tools, its topic\'s spec and plan denied, the remembered rules allowed (only rememberable forms); ask-all is the default mode', () => {
    const root = worktreeRoot('wt_1');
    const rules = [{ tool: 'Bash', pattern: 'pnpm test *' }, { tool: 'Bash', pattern: 'pnpm test *' }, { tool: 'Bash', pattern: 'curl *' }, { tool: 'WebFetch', pattern: 'domain:example.com' }, { tool: 'Bash', pattern: 'sh -c *' }];
    const profile = buildProfile({ ...base, purpose: 'item', mode: 'ask-commands', root, rootRealPath: '/w/wt_1', topicSlug: 'checkout', rules });
    expect(profile.mode).toBe('acceptEdits');
    expect(profile.tools).toBe(EXECUTION_TOOLS);
    expect(profile.allow).toEqual(['Bash(pnpm test *)', 'WebFetch(domain:example.com)']);
    expect(profile.deny).toContain('Edit(//w/wt_1/specs/checkout/SPEC.md)');
    expect(profile.deny).toContain('Edit(//w/wt_1/specs/checkout/PLAN.md)');
    expect(buildProfile({ ...base, purpose: 'item', mode: 'ask-all', root, rootRealPath: '/w/wt_1', topicSlug: 'checkout' }).mode).toBe('default');
  });

  it('the common deny rules are generated from the protocol\'s lists; a session rooted in the main workspace never runs in acceptEdits', () => {
    const profile = buildProfile({ ...base, purpose: 'free', mode: 'ask-commands' });
    expect(profile.deny).toEqual([...AGENT_READ_DENY_PATTERNS.map((p) => `Read(//Users/ian/shop/${p})`), ...AGENT_EDIT_DENY_PATTERNS.map((p) => `Edit(//Users/ian/shop/${p})`)]);
    expect(profile.deny).toContain('Read(//Users/ian/shop/.git/**)');
    expect(profile.deny).toContain('Edit(//Users/ian/shop/**/.claude/**)');
    expect(profile.mode).toBe('default');
    expect(claudeModeFor('free', 'ask-commands', MAIN_ROOT)).toBe('default');
    expect(claudeModeFor('free', 'ask-commands', worktreeRoot('wt'))).toBe('acceptEdits');
    expect(claudeModeFor('free', 'ask-all', worktreeRoot('wt'))).toBe('default');
    expect(daemonAllowsEdits('free', 'ask-commands', MAIN_ROOT)).toBe(true);
    expect(daemonAllowsEdits('free', 'ask-all', MAIN_ROOT)).toBe(false);
    expect(daemonAllowsEdits('item', 'ask-commands', worktreeRoot('wt'))).toBe(false);
    expect(daemonAllowsEdits('discussion', 'ask-commands', MAIN_ROOT)).toBe(false);
  });

  it('untrusted project settings: --setting-sources user; the host\'s own MCP servers only with the host setting (then any MCP tool passes the gate\'s list)', () => {
    expect(buildProfile({ ...base, purpose: 'free', mode: 'ask-all', trust: 'ignored' }).settingSources).toBe('user');
    expect(buildProfile({ ...base, purpose: 'free', mode: 'ask-all', trust: 'none' }).settingSources).toBe('all');
    const open = buildProfile({ ...base, purpose: 'free', mode: 'ask-all', agentMcp: true });
    expect(open.strictMcp).toBe(false);
    expect(gateToolsOf(open)).toEqual([...EXECUTION_TOOLS, ANY_MCP_TOOL]);
    expect(ANY_MCP_TOOL).toBe(GATE_ANY_MCP);
    // DX-10: no subagent tool (a subagent runs with what its definition says, not with what smurg set for the session).
    expect(EXECUTION_TOOLS).toEqual(['Read', 'Glob', 'Grep', 'Edit', 'Write', 'NotebookEdit', 'Bash', 'TaskStop', 'WebFetch', 'WebSearch', 'AskUserQuestion']);
  });

  it('THE launch check fails closed: the required flags, the two modes, nothing else', () => {
    const ok = ['--permission-mode', 'default', '--settings', '/s/settings.json', '--mcp-config', '/s/mcp.json', '--tools', 'Read,Bash', '--append-system-prompt-file', '/s/role.md', '--strict-mcp-config', '--setting-sources', 'user'];
    expect(checkLaunchArgs(ok)).toBeNull();
    expect(checkLaunchArgs(ok.slice(0, 8))).toBeNull();
    const without = (flag: string): string[] => {
      const at = ok.indexOf(flag);
      return [...ok.slice(0, at), ...ok.slice(at + 2)];
    };
    for (const flag of ['--permission-mode', '--settings', '--mcp-config', '--tools']) expect(checkLaunchArgs(without(flag)), flag).toMatch(/missing/);
    for (const mode of ['bypassPermissions', 'plan', 'auto', 'dontAsk']) expect(checkLaunchArgs(['--permission-mode', mode, ...ok.slice(2)])).toBe('permission mode not allowed');
    for (const extra of [['--dangerously-skip-permissions'], ['--allowedTools', 'Bash'], ['--disallowedTools', 'Read'], ['--model', 'x'], ['--add-dir', '/'], ['stray']]) expect(checkLaunchArgs([...ok, ...extra])).toMatch(/unexpected/);
    expect(checkLaunchArgs([...ok.slice(0, -1), 'project'])).toBe('setting sources not allowed');
    expect(checkLaunchArgs([...ok, '--settings', '/other.json'])).toMatch(/duplicate/);
    expect(checkLaunchArgs(['--permission-mode', 'default', '--settings', 'relative.json', '--mcp-config', '/m', '--tools', 'Read'])).toMatch(/absolute/);
    expect(checkLaunchArgs(['--permission-mode', 'default', '--settings', '--mcp-config', '/m', '--tools', 'Read'])).toMatch(/no value/);
    expect(STREAM_ARGS).toEqual(['-p', '--output-format', 'stream-json', '--input-format', 'stream-json', '--verbose', '--include-partial-messages', '--replay-user-messages', '--permission-prompt-tool', 'stdio']);
  });

  it('the fixed texts of the runtime: a free session\'s role prompt names the tag; the message after a lost conversation names only a checked slug', () => {
    expect(freeRolePrompt('k7f2')).toContain('A line that starts with "[smurg k7f2]" is the workspace software itself.');
    expect(freeRolePrompt('k7f2').split('\n').filter(Boolean)).toHaveLength(4);
    expect(() => freeRolePrompt('K7F2!')).toThrow();
    expect(conversationLostText('checkout')).toBe('The earlier conversation of this session is no longer available. Read specs/checkout/SPEC.md, specs/checkout/PLAN.md and your report, where they exist, before you continue.');
    expect(conversationLostText(undefined)).toBe('The earlier conversation of this session is no longer available.');
    expect(conversationLostText('../etc')).toBe('The earlier conversation of this session is no longer available.');
  });
});

describe('the tool gate (DESIGN §2.10)', () => {
  const none = new Set<string>();
  const inside = (path: string) => ({ kind: 'in', path }) as const;
  const discussion = { purpose: 'discussion', topic: { id: 't1', slug: 'checkout' }, pathRights: 'host', tools: DISCUSSION_TOOLS } as const;
  const item = { purpose: 'item', topic: { id: 't1', slug: 'checkout' }, pathRights: 'member', tools: EXECUTION_TOOLS } as const;
  const free = { purpose: 'free', pathRights: 'member', tools: EXECUTION_TOOLS } as const;
  const hostFree = { ...free, pathRights: 'host' } as const;

  it('G2: a tool outside the session\'s list is refused; smurg\'s own tools never are; other MCP tools only with the host setting', () => {
    expect(gateDecision(discussion, none, 'Bash', { kind: 'none' })).toEqual({ kind: 'deny', row: 'G2' });
    expect(gateDecision(discussion, none, 'WebFetch', { kind: 'none' })).toEqual({ kind: 'deny', row: 'G2' });
    expect(gateDecision(free, none, 'BrandNewTool', { kind: 'none' })).toEqual({ kind: 'deny', row: 'G2' });
    expect(gateDecision(discussion, none, 'mcp__smurg__check_plan', { kind: 'none' })).toEqual({ kind: 'pass' });
    expect(gateDecision(free, none, 'mcp__mail__send', { kind: 'none' })).toEqual({ kind: 'deny', row: 'G2' });
    expect(gateDecision({ ...free, tools: [...EXECUTION_TOOLS, GATE_ANY_MCP] }, none, 'mcp__mail__send', { kind: 'none' })).toEqual({ kind: 'pass' });
    expect(gateDecision({ ...free, tools: [...EXECUTION_TOOLS, GATE_ANY_MCP] }, none, 'Brand', { kind: 'none' })).toEqual({ kind: 'deny', row: 'G2' });
  });

  it('G3: Claude Code\'s configuration and the recorded scripts are written by no session, the host\'s own included', () => {
    for (const path of ['.claude/settings.json', 'pkg/.claude/hooks/x.sh', '.mcp.json', 'sub/.mcp.json', '.git/hooks/pre-commit']) {
      for (const session of [free, hostFree, item, discussion]) expect(gateDecision(session, none, 'Write', inside(path)), path).toEqual({ kind: 'deny', row: 'G3', path });
    }
    expect(gateDecision(hostFree, new Set(['scripts/lint.sh']), 'Edit', inside('scripts/lint.sh'))).toEqual({ kind: 'deny', row: 'G3', path: 'scripts/lint.sh' });
    expect(gateDecision(hostFree, new Set(['scripts/lint.sh']), 'Edit', inside('scripts/other.sh'))).toEqual({ kind: 'lock' });
  });

  it('G4: another host-only path needs the session\'s own host rights (never raised by a handover)', () => {
    for (const path of ['CLAUDE.md', 'docs/CLAUDE.local.md', '.vscode/settings.json', '.envrc']) {
      expect(gateDecision(free, none, 'Edit', inside(path)), path).toEqual({ kind: 'deny', row: 'G4', path });
      expect(gateDecision(hostFree, none, 'Edit', inside(path)), path).toEqual({ kind: 'lock' });
    }
  });

  it('G5 and G6: a discussion reads only inside its root and never a host-private file, and writes only its topic\'s SPEC.md and PLAN.md', () => {
    expect(gateDecision(discussion, none, 'Read', inside('src/cart.ts'))).toEqual({ kind: 'pass' });
    expect(gateDecision(discussion, none, 'Read', { kind: 'outside' })).toEqual({ kind: 'deny', row: 'G5' });
    expect(gateDecision(discussion, none, 'Glob', { kind: 'outside' })).toEqual({ kind: 'deny', row: 'G5' });
    for (const path of ['.envrc', 'pkg/.envrc', '.git/config', '.claude/settings.local.json', 'CLAUDE.local.md']) expect(gateDecision(discussion, none, 'Read', inside(path)), path).toEqual({ kind: 'deny', row: 'G5', path });
    expect(gateDecision(discussion, none, 'Grep', { kind: 'none' })).toEqual({ kind: 'pass' });
    for (const pattern of ['/etc/**', '~/.ssh/*', '../other/**', 'a/../../b']) expect(gateDecision(discussion, none, 'Glob', { kind: 'none' }, pattern), pattern).toEqual({ kind: 'deny', row: 'G5' });
    expect(gateDecision(discussion, none, 'Glob', { kind: 'none' }, 'src/**/*.ts')).toEqual({ kind: 'pass' });
    expect(patternLeavesRoot('a..b/c')).toBe(false);
    expect(gateDecision(discussion, none, 'Write', inside('specs/checkout/SPEC.md'))).toEqual({ kind: 'lock' });
    expect(gateDecision(discussion, none, 'Edit', inside('specs/checkout/PLAN.md'))).toEqual({ kind: 'lock' });
    for (const path of ['src/cart.ts', 'specs/other/SPEC.md', 'specs/checkout/CLAUDE.md', 'specs/checkout/reports/a.md', 'specs/checkout/spec.md']) expect(gateDecision(discussion, none, 'Write', inside(path)), path).toMatchObject({ kind: 'deny' });
    expect(gateDecision(discussion, none, 'Write', inside('src/cart.ts'))).toEqual({ kind: 'deny', row: 'G6', path: 'src/cart.ts' });
    expect(gateDecision(discussion, none, 'Write', { kind: 'outside' })).toEqual({ kind: 'deny', row: 'G6' });
    expect(gateDecision(discussion, none, 'Write', { kind: 'none' })).toEqual({ kind: 'deny', row: 'G6' });
    // An execution or free session reads wherever Claude Code's own rules let it.
    expect(gateDecision(free, none, 'Read', { kind: 'outside' })).toEqual({ kind: 'pass' });
  });

  it('G7, G8, G9: a work item never edits its topic\'s spec or plan; any other edit takes the lock; everything else gets no decision', () => {
    expect(gateDecision(item, none, 'Edit', inside('specs/checkout/SPEC.md'))).toEqual({ kind: 'deny', row: 'G7', path: 'specs/checkout/SPEC.md' });
    expect(gateDecision(item, none, 'Write', inside('specs/checkout/PLAN.md'))).toEqual({ kind: 'deny', row: 'G7', path: 'specs/checkout/PLAN.md' });
    expect(gateDecision(item, none, 'Write', inside('specs/checkout/reports/cart-api.md'))).toEqual({ kind: 'lock' });
    expect(gateDecision(item, none, 'Edit', inside('src/cart.ts'))).toEqual({ kind: 'lock' });
    expect(gateDecision(free, none, 'Edit', inside('specs/checkout/SPEC.md'))).toEqual({ kind: 'lock' });
    expect(gateDecision(item, none, 'NotebookEdit', { kind: 'outside' })).toEqual({ kind: 'lock' });
    for (const tool of ['Bash', 'WebFetch', 'AskUserQuestion', 'Read', 'Grep', 'mcp__smurg__notify_member']) expect(gateDecision(item, none, tool, { kind: 'none' }), tool).toEqual({ kind: 'pass' });
    // DX-10: the subagent tool is in no session's list, under the name Claude Code offers it (`Task`) and under the
    // name its hooks report (`Agent`): the gate refuses both, for every kind of session.
    for (const session of [item, free, discussion]) for (const tool of ['Task', 'Agent']) expect(gateDecision(session, none, tool, { kind: 'none' }), tool).toEqual({ kind: 'deny', row: 'G2' });
  });

  it('one fixed English sentence per row, saying what the session may do instead; a slug or tool name that is not plain is never quoted', () => {
    expect(gateDenyReason('G2', { tool: 'Bash' })).toBe('This session does not have the tool Bash. Use the tools you were given.');
    expect(gateDenyReason('G2', { tool: 'Evil"\nTool' })).toBe('This session does not have this tool. Use the tools you were given.');
    expect(gateDenyReason('G6', { slug: 'checkout' })).toBe('A discussion session writes only SPEC.md and PLAN.md in specs/checkout/. Put what you want to record into one of them.');
    expect(gateDenyReason('G6', { slug: '../x' })).toContain("in its topic's folder");
    for (const row of ['G2', 'G3', 'G4', 'G5', 'G6', 'G7'] as const) expect(gateDenyReason(row)).toMatch(/^[A-Z][^\n]{20,300}\.$/);
  });
});

describe('what the host is told about Claude Code on their computer', () => {
  it('the host\'s own allow rules in the answer to list_permission_rules: only allow rules of the host\'s own sources, never smurg\'s settings file', () => {
    const response = { state: { rules: [
      { behavior: 'allow', source: 'userSettings', rule: 'Bash(ls *)' },
      { behavior: 'allow', source: 'userSettings', rule: 'Bash(ls *)' },
      { behavior: 'allow', source: 'projectSettings', rule: 'Edit' },
      { behavior: 'allow', source: 'localSettings', rule: 'WebFetch(domain:example.com)' },
      { behavior: 'allow', source: 'policySettings', rule: 'Read' },
      { behavior: 'allow', source: 'flagSettings', rule: 'mcp__smurg' },
      { behavior: 'allow', source: 'session', rule: 'Bash(pnpm test *)' },
      { behavior: 'deny', source: 'userSettings', rule: 'Bash(rm *)' },
      { behavior: 'allow', source: 'userSettings', rule: 'Bad\u0007Rule\n' },
    ] } };
    expect(hostRulesOf(response)).toEqual([
      { rule: 'WebFetch(domain:example.com)', source: 'local' },
      { rule: 'Read', source: 'managed' },
      { rule: 'Edit', source: 'project' },
      { rule: 'Bad Rule', source: 'user' },
      { rule: 'Bash(ls *)', source: 'user' },
    ]);
    for (const shape of [null, {}, { state: null }, { state: { rules: 'x' } }, 'text']) expect(hostRulesOf(shape)).toEqual([]);
  });

  it('what a project settings file does: every command line whole, every rule, every variable (flagged when it can redirect the login), the other keys; what needs its own tick', () => {
    const settings = JSON.stringify({
      hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: './scripts/lint.sh --fix' }] }], Stop: [{ hooks: [{ type: 'command', command: 'node', args: ['tools/notify.js'] }] }] },
      permissions: { allow: ['Bash(npm test *)', 'Read'], deny: ['WebFetch'], defaultMode: 'acceptEdits', additionalDirectories: ['../other'] },
      env: { ANTHROPIC_BASE_URL: 'https://evil.example', FOO: 'bar', https_proxy: 'x' },
      apiKeyHelper: '/bin/get-key',
      statusLine: { type: 'command', command: 'echo hi' },
      model: 'x',
      mcpServers: { db: { command: 'npx', args: ['-y', 'db-mcp'] } },
    });
    const effects = effectsOf('.claude/settings.json', settings);
    expect(effects.runs).toEqual(['hook PreToolUse: ./scripts/lint.sh --fix', 'hook Stop: node tools/notify.js', 'apiKeyHelper: /bin/get-key', 'statusLine: echo hi', 'MCP server db: npx -y db-mcp']);
    expect(effects.permissions).toEqual(['allow: Bash(npm test *)', 'allow: Read', 'deny: WebFetch', 'defaultMode: acceptEdits', 'additionalDirectories: ../other']);
    expect(effects.env).toEqual([{ name: 'ANTHROPIC_BASE_URL', flagged: true }, { name: 'FOO', flagged: false }, { name: 'https_proxy', flagged: true }]);
    expect(effects.otherKeys).toEqual(['model']);
    expect(effects.needsAck).toEqual(['credentials', 'allows-tools']);
    expect(effects.commands).toContainEqual(['./scripts/lint.sh --fix']);
    expect(effectsOf('.mcp.json', JSON.stringify({ mcpServers: { files: { command: 'node', args: ['tools/mcp.js'] }, web: { type: 'http', url: 'https://mcp.example' } } }))).toMatchObject({ runs: ['MCP server files: node tools/mcp.js', 'MCP server web: https://mcp.example'], needsAck: [] });
    expect(effectsOf('.claude/settings.json', '{}')).toMatchObject({ runs: [], permissions: [], env: [], otherKeys: [], needsAck: [] });
    // A file Claude Code may read differently than smurg does is never trusted lightly.
    expect(effectsOf('.claude/settings.json', '{ not json').needsAck).toEqual(['credentials', 'allows-tools']);
    for (const name of ['ANTHROPIC_API_KEY', 'CLAUDE_CODE_USE_BEDROCK', 'HTTP_PROXY', 'all_proxy', 'NODE_EXTRA_CA_CERTS']) expect(isFlaggedEnvName(name), name).toBe(true);
    for (const name of ['PATH', 'NODE_ENV', 'MY_TOKEN']) expect(isFlaggedEnvName(name), name).toBe(false);
  });
});
