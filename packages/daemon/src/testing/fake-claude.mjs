#!/usr/bin/env node
// TEST ONLY: a stand-in for the `claude` executable (DESIGN §9.3 P1). It speaks the same bidirectional stream-json
// control protocol the agent runtime speaks with Claude Code, with no model and no network: what the "agent" does is a
// SCRIPT (a scenario file), so every package can test against a session that asks, edits, waits and stops on cue.
//
//   fake-claude.mjs --version                      → "<version> (Claude Code)"
//   fake-claude.mjs auth status --json             → {"loggedIn":true,…} exit 0 | {"loggedIn":false} exit 1
//   fake-claude.mjs -p --output-format stream-json --input-format stream-json … (--session-id <uuid> | --resume <uuid>)
//                   --settings <file> --mcp-config <file> --tools <list> --permission-mode <mode> …
//
// The scenario (JSON; its path is in $FAKE_CLAUDE_SCENARIO, absent: every message is answered "ok"):
//   { "version": "2.1.288", "loggedIn": true,
//     "account": { "tokenSource": "none", "apiKeySource": "ANTHROPIC_API_KEY", "apiProvider": "firstParty" },
//     "rules": [ { "behavior": "allow", "source": "userSettings", "rule": "Bash(ls *)" } ],
//     "extraTools": ["TaskStop"],
//     "turns": [ { "match": "<regex on the message text>", "once": true, "steps": [ … ] } ] }
// `account` is the WHOLE `initialize.account` object, as Claude Code 2.1.288 answers it (recorded with the real binary
// against the fake API; fake-claude.ts CLAUDE_ACCOUNTS holds the three shapes): the default is an API key in the
// environment; `{ "tokenSource": "none", "apiProvider": "firstParty" }` is no credential at all (`init.apiKeySource` is
// then "none" and every turn answers "Not logged in"); `{ "subscriptionType": "Claude Max", "apiProvider":
// "firstParty" }` is a claude.ai login (`init.apiKeySource` is "none" there too).
// Like the real one, the stand-in also reads the HOST'S OWN settings files: `$HOME/.claude/settings.json` (source
// userSettings; the sessions' HOME is a test's fake home), `<cwd>/.claude/settings.json` (projectSettings) and
// `<cwd>/.claude/settings.local.json` (localSettings), the last two not with `--setting-sources user`. Their
// `permissions` are rules of the session (and are listed by `list_permission_rules` with their source), their hooks run
// after the ones of `--settings`; a PreToolUse hook's `updatedInput` replaces the input the permission request and the
// call carry (the assistant's tool_use line keeps the input the "model" wrote).
// A user message WITHOUT `client_composed: true` is treated as typed by a person: an `@path` in it that names a file
// is expanded like the real CLI does (the file is read with no tool call); the stand-in records it as an echo entry
// of kind `mention`.
// A user message starts the first turn whose `match` fits (no `match`: any); a turn marked `once` is used one time per
// conversation (remembered across --resume). Steps:
//   { "text": "…", "deltas": ["…","…"], "parent": "<tool use id>" }   an assistant text block (streamed first)
//   { "thinking": true }                                                thinking deltas (nothing is stored)
//   { "tool": "Write", "input": { "file_path": "…", "content": "…" }, "ask": true|false, "suggest": { "toolName": "Bash", "ruleContent": "pnpm test *" },
//     "result": "…", "structured": { … }, "error": "…", "run": true, "id": "toolu_x", "parent": "…", "reason": "…" }
//       a tool call: the PreToolUse hooks of the settings file run first (a deny ends the call); then a permission
//       request when the rules of the session say so (or `ask` says so) and the stand-in waits for the answer; then
//       the call is performed (Write / Edit change real files, Read reads one, Bash runs for real only with `run`,
//       mcp__smurg__* goes to the real MCP command, AskUserQuestion always asks); then the PostToolUse hooks.
//   { "sleep": 50 }   { "wait": "interrupt" }   { "exit": 3, "stderr": "boom" }   { "raw": { …any stdout line… } }
//   { "retry": { "error": "overloaded", "attempt": 1, "max": 10 } }   { "rateLimit": { "status": "rejected", "resetsAt": 1900000000 } }
//   { "compact": true }   { "result": { "subtype": "error_during_execution", "is_error": true } }  (how the turn ends)
// `$FAKE_CLAUDE_ECHO` (a file): everything this process received (argv, the role prompt, the settings, every stdin
// line) is appended to it, for the tests that check what an agent was told.
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';

const argv = process.argv.slice(2);
const env = process.env;

function loadScenario() {
  const path = env.FAKE_CLAUDE_SCENARIO;
  if (!path) return {};
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return {};
  }
}

const scenario0 = loadScenario();
const VERSION = scenario0.version ?? env.FAKE_CLAUDE_VERSION ?? '2.1.288';

if (argv[0] === '--version' || argv[0] === '-v') {
  process.stdout.write(`${VERSION} (Claude Code)\n`);
  process.exit(0);
}
if (argv[0] === 'auth' && argv[1] === 'status') {
  const loggedIn = scenario0.loggedIn !== false && env.FAKE_CLAUDE_LOGGED_OUT !== '1';
  process.stdout.write(`${JSON.stringify(loggedIn ? { loggedIn: true, authMethod: 'api_key', apiProvider: 'firstParty' } : { loggedIn: false, authMethod: 'none' })}\n`);
  process.exit(loggedIn ? 0 : 1);
}

function flag(name) {
  const at = argv.indexOf(name);
  return at === -1 ? undefined : argv[at + 1];
}
const has = (name) => argv.includes(name);

function echo(kind, value) {
  if (!env.FAKE_CLAUDE_ECHO) return;
  try {
    appendFileSync(env.FAKE_CLAUDE_ECHO, `${JSON.stringify({ kind, session: env.SMURG_SESSION_ID ?? null, value })}\n`);
  } catch {
    // the echo is for tests only
  }
}

const cwd = process.cwd();
const sessionIdNew = flag('--session-id');
const sessionIdResume = flag('--resume');
const claudeSessionId = sessionIdResume ?? sessionIdNew ?? randomUUID();
const storeDir = join(env.CLAUDE_CONFIG_DIR ?? join(env.HOME ?? cwd, '.claude'), 'fake-claude');
const storePath = join(storeDir, `${claudeSessionId}.json`);
mkdirSync(storeDir, { recursive: true });
let conversation = { turns: 0, used: [], messages: [] };
if (sessionIdResume !== undefined) {
  if (!existsSync(storePath)) {
    process.stderr.write(`No conversation found with session ID: ${sessionIdResume}\n`);
    process.exit(1);
  }
  conversation = JSON.parse(readFileSync(storePath, 'utf8'));
} else if (existsSync(storePath)) {
  process.stderr.write(`Error: Session ID ${claudeSessionId} is already in use.\n`);
  process.exit(1);
}
const saveConversation = () => writeFileSync(storePath, JSON.stringify(conversation));

const readJson = (path) => {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return {};
  }
};
const settings = flag('--settings') ? readJson(flag('--settings')) : {};
const mcpConfig = flag('--mcp-config') ? readJson(flag('--mcp-config')) : {};
// The host's own settings files, in the order Claude Code names their sources. The user's file is read from the
// session's HOME only (every harness gives the sessions a fake home), never from $CLAUDE_CONFIG_DIR: a developer who
// has that variable set must not have their real settings read, or their real hooks run, by a test.
const ownSettings = [
  ['userSettings', env.HOME ? readJson(join(env.HOME, '.claude', 'settings.json')) : {}],
  ...(flag('--setting-sources') === 'user' ? [] : [['projectSettings', readJson(join(cwd, '.claude', 'settings.json'))], ['localSettings', readJson(join(cwd, '.claude', 'settings.local.json'))]]),
];
/** Every rule that does not come from `--settings`: the files above, then the scenario's. */
const hostRules = [];
for (const [source, file] of ownSettings) {
  for (const behavior of ['allow', 'ask', 'deny']) {
    const list = file?.permissions?.[behavior];
    for (const rule of Array.isArray(list) ? list : []) if (typeof rule === 'string') hostRules.push({ behavior, source, rule });
  }
}
for (const rule of Array.isArray(scenario0.rules) ? scenario0.rules : []) hostRules.push(rule);
const hostRulesOf = (behavior) => hostRules.filter((entry) => entry.behavior === behavior).map((entry) => entry.rule);
// `initialize.account` (see the header): the whole object.
const account = scenario0.account ?? { tokenSource: 'none', apiKeySource: 'ANTHROPIC_API_KEY', apiProvider: 'firstParty' };
const hasKey = typeof account.apiKeySource === 'string' && account.apiKeySource !== 'none';
const notLoggedIn = !hasKey && account.subscriptionType === undefined;
const toolList = (flag('--tools') ?? 'Read,Glob,Grep,Edit,Write,Bash,AskUserQuestion').split(',').filter(Boolean);
let permissionMode = flag('--permission-mode') ?? 'default';
const sessionRules = [];
echo('argv', argv);
echo('settings', settings);
if (flag('--append-system-prompt-file')) echo('role-prompt', (() => { try { return readFileSync(flag('--append-system-prompt-file'), 'utf8'); } catch { return null; } })());

const out = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- hooks of the settings file ---------------------------------------------------------------------------------------
function matcherFits(matcher, tool) {
  if (matcher === undefined || matcher === '' || matcher === '*') return true;
  try {
    return new RegExp(`^(?:${matcher})$`).test(tool);
  } catch {
    return false;
  }
}

function runCommand(command, args, stdin, timeoutMs = 15_000) {
  return new Promise((done) => {
    let stdout = '';
    let child;
    try {
      child = spawn(command, args ?? [], { cwd, env, stdio: ['pipe', 'pipe', 'ignore'] });
    } catch {
      done({ code: null, stdout });
      return;
    }
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.stdout.on('data', (chunk) => (stdout += chunk.toString('utf8')));
    child.on('error', () => {
      clearTimeout(timer);
      done({ code: null, stdout });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      done({ code, stdout });
    });
    child.stdin.on('error', () => {});
    child.stdin.end(stdin);
  });
}

/**
 * Runs the hooks of one event: the ones of `--settings` first, then the host's own. Returns the deny reason of a
 * PreToolUse hook (or null) and, when a PreToolUse hook answered `updatedInput`, the input the call goes on with.
 */
async function runHooks(event, tool, extra = {}) {
  const groups = [...(settings.hooks?.[event] ?? []), ...ownSettings.flatMap(([, file]) => (Array.isArray(file?.hooks?.[event]) ? file.hooks[event] : []))];
  let denied = null;
  let updatedInput;
  for (const group of groups) {
    if (tool !== undefined && !matcherFits(group.matcher, tool)) continue;
    for (const hook of group.hooks ?? []) {
      if (hook.type !== 'command' || typeof hook.command !== 'string') continue;
      const input = JSON.stringify({ hook_event_name: event, session_id: claudeSessionId, cwd, permission_mode: permissionMode, ...(tool === undefined ? {} : { tool_name: tool }), ...extra });
      // Exec form (command + args), or a command line for the shell.
      const result = Array.isArray(hook.args) ? await runCommand(hook.command, hook.args, input, (hook.timeout ?? 10) * 1000) : await runCommand('/bin/sh', ['-c', hook.command], input, (hook.timeout ?? 10) * 1000);
      if (event !== 'PreToolUse' || denied !== null) continue;
      try {
        const parsed = JSON.parse(result.stdout);
        const specific = parsed?.hookSpecificOutput;
        if (specific?.permissionDecision === 'deny') denied = String(specific.permissionDecisionReason ?? 'denied');
        else if (typeof specific?.updatedInput === 'object' && specific.updatedInput !== null) updatedInput = specific.updatedInput;
      } catch {
        // no output: no decision
      }
    }
  }
  return { denied, updatedInput };
}

// ---- permissions (a small model of Claude Code's rules: enough for the scripted calls) --------------------------------
function ruleFits(rule, tool, input) {
  const match = /^([A-Za-z0-9_]+)(?:\((.*)\))?$/s.exec(rule);
  if (!match) return false;
  const [, name, pattern] = match;
  if (name === 'Edit' ? !['Edit', 'Write', 'MultiEdit', 'NotebookEdit'].includes(tool) : name !== tool && !(name.startsWith('mcp__') && tool.startsWith(`${name}__`))) return false;
  if (pattern === undefined) return true;
  if (tool === 'Bash') {
    const command = String(input.command ?? '');
    return pattern.endsWith(' *') ? command === pattern.slice(0, -2) || command.startsWith(pattern.slice(0, -1)) : command === pattern;
  }
  if (tool === 'WebFetch') {
    try {
      return pattern === `domain:${new URL(String(input.url)).hostname}`;
    } catch {
      return false;
    }
  }
  const target = String(input.file_path ?? input.notebook_path ?? input.path ?? '');
  const absolute = pattern.startsWith('//') ? pattern.slice(1) : isAbsolute(pattern) ? join(cwd, pattern) : join(cwd, pattern);
  let regex;
  try {
    regex = new RegExp(`^${pathPatternSource(absolute)}$`);
  } catch {
    return false;
  }
  return regex.test(isAbsolute(target) ? target : join(cwd, target));
}

/**
 * A rule's path pattern as Claude Code 2.1.288 reads it (each line seen with the real binary): `**` and `*` are
 * wildcards, a character after a backslash is itself, an unescaped `[…]` is a CHARACTER CLASS (so a folder named
 * `a[b]c` is matched only by `a\[b\]c`), `(`, `)`, `{`, `}`, `!` and `?` are themselves.
 */
function pathPatternSource(pattern) {
  const literal = (char) => char.replace(/[.+^${}()|[\]\\*?/-]/g, '\\$&');
  let source = '';
  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i];
    if (char === '\\' && i + 1 < pattern.length) source += literal(pattern[++i]);
    else if (pattern.startsWith('**/', i)) {
      source += '(?:.*/)?';
      i += 2;
    } else if (pattern.startsWith('**', i)) {
      source += '.*';
      i += 1;
    } else if (char === '*') source += '[^/]*';
    else if (char === '[') {
      const end = pattern.indexOf(']', i + 2);
      if (end === -1) source += '\\[';
      else {
        source += `[${pattern.slice(i + 1, end).replace(/\\/g, '\\\\')}]`;
        i = end;
      }
    } else source += literal(char);
  }
  return source;
}
const anyRule = (rules, tool, input) => (rules ?? []).some((rule) => ruleFits(rule, tool, input));
const READ_ONLY = /^(ls|cat|pwd|echo|git (status|diff|log)|printf)\b/;

function needsPermission(tool, input) {
  if (tool === 'AskUserQuestion') return true;
  if (tool.startsWith('mcp__smurg')) return false;
  const all = settings.permissions ?? {};
  if (anyRule([...(all.ask ?? []), ...hostRulesOf('ask')], tool, input)) return true;
  if (anyRule([...(all.allow ?? []), ...sessionRules, ...hostRulesOf('allow')], tool, input)) return false;
  if (['Read', 'Glob', 'Grep', 'TodoWrite', 'Task'].includes(tool)) return false;
  if (['Edit', 'Write', 'MultiEdit', 'NotebookEdit'].includes(tool)) return permissionMode !== 'acceptEdits';
  if (tool === 'Bash') return !READ_ONLY.test(String(input.command ?? ''));
  return true;
}

// ---- the MCP server of the mcp-config (smurg's own) -------------------------------------------------------------------
function callMcp(tool, args) {
  const [, server, ...rest] = tool.split('__');
  const name = rest.join('__');
  const config = mcpConfig.mcpServers?.[server];
  if (!config?.command) return Promise.resolve({ ok: false, text: `MCP server ${server} is not configured` });
  return new Promise((done) => {
    const child = spawn(config.command, config.args ?? [], { cwd, env: { ...env, ...(config.env ?? {}) }, stdio: ['pipe', 'pipe', 'ignore'] });
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      done({ ok: false, text: 'the MCP server did not answer' });
    }, 20_000);
    const finish = (value) => {
      clearTimeout(timer);
      child.kill('SIGKILL');
      done(value);
    };
    child.on('error', () => finish({ ok: false, text: 'the MCP server could not start' }));
    child.stdin.on('error', () => {});
    const send = (message) => child.stdin.write(`${JSON.stringify(message)}\n`);
    createInterface({ input: child.stdout }).on('line', (line) => {
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        return;
      }
      if (message.id === 1) {
        send({ jsonrpc: '2.0', method: 'notifications/initialized' });
        send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name, arguments: args ?? {} } });
      } else if (message.id === 2) {
        const text = (message.result?.content ?? []).map((part) => part.text ?? '').join('') || JSON.stringify(message.error ?? message.result ?? {});
        finish({ ok: message.error === undefined && message.result?.isError !== true, text });
      }
    });
    send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'fake-claude', version: VERSION } } });
  });
}

// ---- the session ------------------------------------------------------------------------------------------------------
let messageSeq = 0;
let toolSeq = 0;
const pendingRequests = new Map(); // our can_use_tool requests: request id → resolve
const inbox = []; // user messages that wait for a turn
let turnRunning = false;
let interrupted = false;
let interruptWaiter = null;
let inputEnded = false;

function initLine() {
  const smurgTools = Object.keys(mcpConfig.mcpServers ?? {}).includes('smurg') ? ['mcp__smurg__who_is_editing', 'mcp__smurg__lock_status', 'mcp__smurg__wait_for_lock', 'mcp__smurg__list_sessions', 'mcp__smurg__notify_member', 'mcp__smurg__check_plan', 'mcp__smurg__propose_split', 'mcp__smurg__check_report'] : [];
  return {
    type: 'system',
    subtype: 'init',
    cwd,
    session_id: claudeSessionId,
    tools: [...toolList, ...(scenario0.extraTools ?? []), ...smurgTools],
    mcp_servers: Object.keys(mcpConfig.mcpServers ?? {}).map((name) => ({ name, status: 'connected' })),
    model: 'claude-fake',
    permissionMode,
    apiKeySource: hasKey ? account.apiKeySource : 'none',
    claude_code_version: VERSION,
    uuid: randomUUID(),
  };
}

function stepsFor(text) {
  const scenario = loadScenario();
  const turns = scenario.turns ?? [];
  for (let i = 0; i < turns.length; i++) {
    const turn = turns[i];
    if (turn.once && conversation.used.includes(i)) continue;
    if (turn.match !== undefined && !new RegExp(turn.match, 's').test(text)) continue;
    if (turn.once) conversation.used.push(i);
    return [...(turn.steps ?? [])];
  }
  return [{ text: 'ok' }];
}

async function emitText(step) {
  const id = `msg_fake_${++messageSeq}`;
  const parent = step.parent ?? null;
  out({ type: 'stream_event', event: { type: 'message_start', message: { id } }, parent_tool_use_id: parent, session_id: claudeSessionId });
  for (const delta of step.deltas ?? [step.text]) {
    out({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: delta } }, parent_tool_use_id: parent, session_id: claudeSessionId });
    if (step.deltaMs) await sleep(step.deltaMs);
    if (interrupted) break;
  }
  const text = interrupted && step.deltas ? step.deltas.join('').slice(0, Math.max(1, Math.floor(step.text.length / 2))) : step.text;
  out({ type: 'assistant', message: { id, type: 'message', role: 'assistant', model: step.synthetic ? '<synthetic>' : 'claude-fake', content: [{ type: 'text', text }] }, parent_tool_use_id: parent, session_id: claudeSessionId, uuid: randomUUID(), ...(interrupted ? { aborted: true } : {}) });
}

function ask(tool, input, toolUseId, step) {
  const requestId = randomUUID();
  const suggestions = step.suggest ? [{ type: 'addRules', rules: [step.suggest], behavior: 'allow', destination: 'localSettings' }] : [];
  out({
    type: 'control_request',
    request_id: requestId,
    request: { subtype: 'can_use_tool', tool_name: tool, display_name: tool, input, tool_use_id: toolUseId, ...(tool === 'AskUserQuestion' ? { requires_user_interaction: true } : { permission_suggestions: suggestions, ...(step.reason ? { decision_reason: step.reason, decision_reason_type: step.reasonType ?? 'other' } : {}), ...(step.blockedPath ? { blocked_path: step.blockedPath } : {}) }) },
  });
  return new Promise((done) => pendingRequests.set(requestId, done));
}

function toolResultLine(toolUseId, text, isError, structured, parent) {
  out({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUseId, content: text, ...(isError ? { is_error: true } : {}) }] }, parent_tool_use_id: parent ?? null, session_id: claudeSessionId, uuid: randomUUID(), ...(structured === undefined ? {} : { tool_use_result: structured }) });
}

async function perform(tool, input, step) {
  if (step.error !== undefined) return { ok: false, text: step.error };
  const file = input.file_path === undefined ? undefined : isAbsolute(input.file_path) ? input.file_path : resolve(cwd, input.file_path);
  if (tool === 'Write') {
    const existed = existsSync(file);
    const before = existed ? readFileSync(file, 'utf8') : '';
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, String(input.content ?? ''));
    const lines = String(input.content ?? '').replace(/\n$/, '').split('\n');
    const structured = existed
      ? { type: 'update', filePath: file, content: input.content, structuredPatch: [{ oldStart: 1, oldLines: before.split('\n').length - 1, newStart: 1, newLines: lines.length, lines: [...before.replace(/\n$/, '').split('\n').map((l) => `-${l}`), ...lines.map((l) => `+${l}`)] }] }
      : { type: 'create', filePath: file, content: input.content, structuredPatch: [] };
    return { ok: true, text: existed ? `The file ${file} has been updated.` : `File created successfully at: ${file}`, structured };
  }
  if (tool === 'Edit') {
    if (!existsSync(file)) return { ok: false, text: `File does not exist: ${file}` };
    const before = readFileSync(file, 'utf8');
    const oldText = String(input.old_string ?? '');
    if (!before.includes(oldText)) return { ok: false, text: 'String to replace not found in file.' };
    const after = input.replace_all ? before.split(oldText).join(String(input.new_string ?? '')) : before.replace(oldText, String(input.new_string ?? ''));
    writeFileSync(file, after);
    return { ok: true, text: `The file ${file} has been updated.`, structured: { filePath: file, oldString: oldText, newString: input.new_string, structuredPatch: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: [...oldText.split('\n').map((l) => `-${l}`), ...String(input.new_string ?? '').split('\n').map((l) => `+${l}`)] }] } };
  }
  if (tool === 'Read') {
    if (!existsSync(file)) return { ok: false, text: `File does not exist: ${file}` };
    const content = readFileSync(file, 'utf8');
    return { ok: true, text: content.split('\n').map((line, i) => `${i + 1}\t${line}`).join('\n'), structured: { type: 'text', file: { filePath: file, content, numLines: content.split('\n').length, startLine: 1, totalLines: content.split('\n').length } } };
  }
  if (tool === 'Bash' && step.run === true) {
    const result = await new Promise((done) => {
      let stdout = '';
      let stderr = '';
      const child = spawn('/bin/sh', ['-c', String(input.command ?? '')], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
      child.stdout.on('data', (c) => (stdout += c.toString('utf8')));
      child.stderr.on('data', (c) => (stderr += c.toString('utf8')));
      child.on('close', (code) => done({ code, stdout, stderr }));
      child.on('error', () => done({ code: 127, stdout, stderr }));
    });
    const text = [result.stdout, result.stderr].filter(Boolean).join('\n').trimEnd();
    return result.code === 0 ? { ok: true, text: text || '(Bash completed with no output)', structured: { stdout: result.stdout.trimEnd(), stderr: result.stderr.trimEnd(), interrupted: false, isImage: false } } : { ok: false, text: `Exit code ${result.code}\n${text}`, structured: { stdout: result.stdout.trimEnd(), stderr: result.stderr.trimEnd(), interrupted: false } };
  }
  if (tool.startsWith('mcp__') && step.result === undefined) return callMcp(tool, input);
  if (tool === 'Bash') return { ok: true, text: step.result ?? '(Bash completed with no output)', structured: step.structured ?? { stdout: step.result ?? '', stderr: '', interrupted: false, isImage: false } };
  return { ok: true, text: step.result ?? '', structured: step.structured };
}

async function toolStep(step) {
  const tool = step.tool;
  let input = step.input ?? {};
  const toolUseId = step.id ?? `toolu_fake_${String(++toolSeq).padStart(4, '0')}`;
  const parent = step.parent ?? null;
  out({ type: 'assistant', message: { id: `msg_fake_${++messageSeq}`, type: 'message', role: 'assistant', model: 'claude-fake', content: [{ type: 'tool_use', id: toolUseId, name: tool, input }] }, parent_tool_use_id: parent, session_id: claudeSessionId, uuid: randomUUID() });
  // Claude Code 2.1.288 offers the subagent tool as `Task` (`init.tools`, the assistant's tool_use) and names it
  // `Agent` towards its hooks (recorded: "PreToolUse:Agent hook error: …"). Without the name in `--tools` it has no
  // such tool. (For every OTHER tool the stand-in is deliberately more willing than the real CLI: a call of a tool
  // that `--tools` does not name still reaches the hooks, so a test can see smurg's own gate refuse it; the real
  // CLI answers "No such tool available" before any hook runs.)
  const hookTool = tool === 'Task' ? 'Agent' : tool;
  if (tool === 'Task' && ![...toolList, ...(scenario0.extraTools ?? [])].includes(tool)) {
    toolResultLine(toolUseId, `<tool_use_error>Error: No such tool available: ${tool}</tool_use_error>`, true, undefined, parent);
    return;
  }
  const { denied, updatedInput } = await runHooks('PreToolUse', hookTool, { tool_input: input, tool_use_id: toolUseId });
  if (denied !== null) {
    toolResultLine(toolUseId, `PreToolUse:${hookTool} hook error: ${denied}`, true, undefined, parent);
    return;
  }
  // A hook rewrote the input: the permission request and the call carry the new one (recorded from 2.1.288).
  if (updatedInput !== undefined) input = updatedInput;
  if (anyRule([...(settings.permissions?.deny ?? []), ...hostRulesOf('deny')], tool, input)) {
    toolResultLine(toolUseId, `Permission to use ${tool} has been denied.`, true, undefined, parent);
    return;
  }
  let answers;
  if (step.ask ?? needsPermission(tool, input)) {
    if (['Edit', 'Write', 'MultiEdit', 'NotebookEdit'].includes(tool)) await runHooks('PermissionRequest', tool, { tool_input: input, tool_use_id: toolUseId });
    const response = await ask(tool, input, toolUseId, step);
    if (response === null) return; // withdrawn (interrupt): no result
    if (response.behavior !== 'allow') {
      toolResultLine(toolUseId, tool === 'AskUserQuestion' ? String(response.message ?? 'The user declined to answer.') : `The user doesn't want to proceed with this tool use. ${response.message ?? ''}`.trim(), true, undefined, parent);
      return;
    }
    if (response.updatedInput !== undefined) input = response.updatedInput;
    for (const update of response.updatedPermissions ?? []) {
      if (update.type === 'addRules' && update.behavior === 'allow') for (const rule of update.rules ?? []) sessionRules.push(rule.ruleContent === undefined ? rule.toolName : `${rule.toolName}(${rule.ruleContent})`);
      if (update.type === 'setMode') permissionMode = update.mode;
    }
    answers = input.answers;
  }
  if (tool === 'AskUserQuestion') {
    const text = `Your questions have been answered: ${Object.entries(answers ?? {}).map(([q, a]) => `"${q}"="${a}"${input.annotations?.[q]?.notes ? ` notes: ${input.annotations[q].notes}` : ''}`).join(', ')}. You can now continue with these answers in mind.`;
    toolResultLine(toolUseId, text, false, { questions: input.questions, answers }, parent);
    return;
  }
  const result = await perform(tool, input, step);
  await runHooks(result.ok ? 'PostToolUse' : 'PostToolUseFailure', hookTool, { tool_input: input, tool_use_id: toolUseId });
  toolResultLine(toolUseId, result.text, !result.ok, result.structured, parent);
}

async function runTurn(first) {
  turnRunning = true;
  interrupted = false;
  const uuids = [first.uuid];
  const started = Date.now();
  out({ type: 'command_lifecycle', command_uuid: first.uuid, state: 'queued', uuid: randomUUID(), session_id: claudeSessionId });
  out({ type: 'command_lifecycle', command_uuid: first.uuid, state: 'started', uuid: randomUUID(), session_id: claudeSessionId });
  out(initLine());
  await runHooks('UserPromptSubmit', undefined, {});
  out({ type: 'user', message: first.message, session_id: claudeSessionId, parent_tool_use_id: null, uuid: first.uuid, isReplay: true });
  const steps = notLoggedIn ? [{ text: 'Not logged in · Please run /login', synthetic: true }, { result: { subtype: 'success', is_error: true, terminal_reason: 'api_error' } }] : stepsFor(first.text);
  let final = null;
  while (steps.length > 0 && !interrupted) {
    const step = steps.shift();
    if (step.text !== undefined) await emitText(step);
    else if (step.thinking) {
      const id = `msg_fake_${++messageSeq}`;
      out({ type: 'stream_event', event: { type: 'message_start', message: { id } }, parent_tool_use_id: null });
      out({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'hm' } }, parent_tool_use_id: null });
      if (step.ms) await sleep(step.ms);
    } else if (step.tool !== undefined) await toolStep(step);
    else if (step.sleep !== undefined) {
      const until = Date.now() + step.sleep;
      while (Date.now() < until && !interrupted) await sleep(5);
    } else if (step.wait === 'interrupt') {
      if (!interrupted) await new Promise((done) => (interruptWaiter = done));
    } else if (step.exit !== undefined) {
      if (step.stderr) process.stderr.write(`${step.stderr}\n`);
      saveConversation();
      process.exit(step.exit);
    } else if (step.raw !== undefined) out(step.raw);
    else if (step.retry !== undefined) out({ type: 'system', subtype: 'api_retry', error: step.retry.error ?? 'overloaded', error_status: step.retry.status ?? 529, attempt: step.retry.attempt ?? 1, max_retries: step.retry.max ?? 10, retry_delay_ms: 1, session_id: claudeSessionId });
    else if (step.rateLimit !== undefined) out({ type: 'rate_limit_event', rate_limit_info: step.rateLimit, session_id: claudeSessionId });
    else if (step.compact) {
      out({ type: 'system', subtype: 'status', status: 'compacting', session_id: claudeSessionId });
      await sleep(step.ms ?? 5);
      out({ type: 'system', subtype: 'compact_boundary', session_id: claudeSessionId });
    } else if (step.result !== undefined) final = step.result;
    // A message that arrived meanwhile is folded into this turn at the step boundary.
    while (inbox.length > 0 && !interrupted) {
      const next = inbox.shift();
      uuids.push(next.uuid);
      out({ type: 'command_lifecycle', command_uuid: next.uuid, state: 'started', uuid: randomUUID(), session_id: claudeSessionId });
      out({ type: 'user', message: next.message, session_id: claudeSessionId, parent_tool_use_id: null, uuid: next.uuid, isReplay: true });
      steps.push(...stepsFor(next.text));
    }
  }
  await runHooks('Stop', undefined, {});
  conversation.turns += 1;
  saveConversation();
  const result = interrupted ? { subtype: 'error_during_execution', is_error: true, terminal_reason: 'aborted_streaming' } : (final ?? { subtype: 'success', is_error: false, terminal_reason: 'completed' });
  out({ type: 'result', ...result, duration_ms: Date.now() - started, num_turns: 1, result: '', session_id: claudeSessionId, total_cost_usd: 0, usage: {}, permission_denials: [], user_message_uuids: uuids, uuid: randomUUID() });
  for (const uuid of uuids) out({ type: 'command_lifecycle', command_uuid: uuid, state: 'completed', uuid: randomUUID(), session_id: claudeSessionId });
  turnRunning = false;
  interrupted = false;
  void pump();
}

async function pump() {
  if (turnRunning) return;
  const next = inbox.shift();
  if (next !== undefined) {
    await runTurn(next);
    return;
  }
  if (inputEnded) {
    await runHooks('SessionEnd', undefined, { reason: 'other' });
    process.exit(0);
  }
}

function onControl(message) {
  const request = message.request ?? {};
  const respond = (response) => out({ type: 'control_response', response: { subtype: 'success', request_id: message.request_id, response } });
  switch (request.subtype) {
    case 'initialize':
      respond({ commands: [], agents: [], models: [], account, pid: process.pid, current_permission_mode: permissionMode });
      return;
    case 'list_permission_rules':
      if (scenario0.noRuleList) out({ type: 'control_response', response: { subtype: 'error', request_id: message.request_id, error: 'Unsupported control request subtype: list_permission_rules' } });
      else {
        // Claude Code's own order: every allow rule, then ask, then deny; each with where it comes from and whether the
        // session may change it (`--settings` rules are read-only).
        const flagRules = ['allow', 'ask', 'deny'].flatMap((behavior) => (settings.permissions?.[behavior] ?? []).map((rule) => ({ behavior, source: 'flagSettings', rule })));
        const listed = ['allow', 'ask', 'deny'].flatMap((behavior) => [...hostRules, ...flagRules].filter((entry) => entry.behavior === behavior));
        respond({ state: { rules: listed.map((entry) => ({ behavior: entry.behavior, source: entry.source, rule: entry.rule, editability: entry.source === 'flagSettings' ? 'readonly' : 'persistent' })), workspaceDirectories: [], originalCwd: cwd, managedOnly: false } });
      }
      return;
    case 'interrupt':
      interrupted = turnRunning;
      for (const [requestId, done] of pendingRequests) {
        out({ type: 'control_cancel_request', request_id: requestId });
        done(null);
      }
      pendingRequests.clear();
      interruptWaiter?.();
      interruptWaiter = null;
      respond({});
      return;
    case 'set_permission_mode':
      permissionMode = String(request.mode);
      respond({});
      out({ type: 'system', subtype: 'status', status: null, permissionMode, session_id: claudeSessionId, uuid: randomUUID() });
      return;
    default:
      out({ type: 'control_response', response: { subtype: 'error', request_id: message.request_id, error: `Unsupported control request subtype: ${request.subtype}` } });
  }
}

await runHooks('SessionStart', undefined, { source: sessionIdResume ? 'resume' : 'startup' });
const lines = createInterface({ input: process.stdin });
lines.on('line', (line) => {
  if (!line.trim()) return;
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
  echo('stdin', message);
  if (message.type === 'control_request') onControl(message);
  else if (message.type === 'control_response') {
    const id = message.response?.request_id;
    const done = pendingRequests.get(id);
    if (done) {
      pendingRequests.delete(id);
      done(message.response?.response ?? { behavior: 'deny', message: 'no response' });
    }
  } else if (message.type === 'user') {
    const content = message.message?.content;
    const text = typeof content === 'string' ? content : (content ?? []).map((part) => part.text ?? '').join('');
    // A message a person typed (no `client_composed`): `@path` mentions of files are expanded with no tool call.
    if (message.client_composed !== true) {
      for (const mention of text.matchAll(/(?:^|\s)@(?:"([^"]+)"|(\S+))/g)) {
        const named = mention[1] ?? mention[2];
        const path = isAbsolute(named) ? named : resolve(cwd, named);
        try {
          echo('mention', { path, text: readFileSync(path, 'utf8').slice(0, 4096) });
        } catch {
          // not a file: nothing is expanded
        }
      }
    }
    const entry = { uuid: message.uuid ?? randomUUID(), message: message.message, text };
    conversation.messages.push(text);
    inbox.push(entry);
    if (turnRunning) out({ type: 'command_lifecycle', command_uuid: entry.uuid, state: 'queued', uuid: randomUUID(), session_id: claudeSessionId });
    void pump();
  }
});
lines.on('close', () => {
  inputEnded = true;
  // A pending request fails when the stream closes; the turn that runs finishes first.
  for (const done of pendingRequests.values()) done({ behavior: 'deny', message: 'Tool permission stream closed' });
  pendingRequests.clear();
  void pump();
});
// Like Claude Code, a conversation exists on disk only once something was said in it: a --resume of a session that
// never had a turn is refused, and so is a --session-id of one that has.
