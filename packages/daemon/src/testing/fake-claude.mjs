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
//       request when the rules of the session say so (or `ask` says so, or a PreToolUse hook answered "ask": then
//       whatever the rules say) and the stand-in waits for the answer; then
//       the call is performed (Write / Edit change real files, Read reads one, Bash runs for real only with `run`,
//       mcp__smurg__* goes to the real MCP command, AskUserQuestion always asks); then the PostToolUse hooks.
//   { "sleep": 50 }   { "wait": "interrupt" }   { "exit": 3, "stderr": "boom" }   { "raw": { …any stdout line… } }
//   { "retry": { "error": "overloaded", "attempt": 1, "max": 10 } }   { "rateLimit": { "status": "rejected", "resetsAt": 1900000000 } }
//   { "compact": true }   { "result": { "subtype": "error_during_execution", "is_error": true } }  (how the turn ends)
//   a text step may carry "apiError": "<code>": the assistant line then has Claude Code's top-level `error` (U1 E4).
// `$FAKE_CLAUDE_ECHO` (a file): everything this process received (argv, the role prompt, the settings, every stdin
// line) is appended to it, for the tests that check what an agent was told; and every answer of the stand-in's auto
// mode classifier (kind `classifier`).
//
// MODELS (DESIGN 0.6.0 D17; measured with the real 2.1.288 against the fake API: U1 E1–E8, U4 H, N):
//   "models": [ … ]          what `initialize.models` answers, entries in Claude Code's shape ({ value, resolvedModel,
//                            displayName, description, supportsAutoMode?, … }). Default: the five entries 2.1.288
//                            answered (fake-claude.ts CLAUDE_MODELS_2_1_288): default and opus → claude-opus-5-5, fable →
//                            claude-fable-5-1, sonnet → claude-sonnet-5-5, haiku → claude-haiku-4-5-20251001 (the one
//                            without `supportsAutoMode`).
//   "defaultModel": "…"      the model of a process started without `--model` (and after `set_model` without a model).
//                            Default "claude-fake", as every test before 0.6.0 expects.
//   `--model <v>` names the model: an entry's `value` (any case) or `resolvedModel` resolves to its `resolvedModel`, a
//   trailing "[1m]" is kept on the id, anything else is used as it is (with Claude Code's stderr line
//   `[claude-code:unrecognized_model] …`). `init.model` (one `init` line at the start of EVERY turn, as 2.1.288) and
//   the assistant lines say the resolved id. `set_model { model }` changes it (success has no `response`, as 2.1.288;
//   no line says so, the next turn's `init` shows it); `set_model {}` goes back to the default. `get_settings` answers
//   { effective: {}, sources: [], applied: { model: <the resolved id> } }.
//   "refuseSwitch": ["fable"] a model the organization restricts (U4 N): `set_model` to it answers error_code
//                            `restricted_by_org`; started with `--model` it is replaced by the default model, said by a
//                            `system/informational` line at the first turn (the model list is not changed: that is
//                            "models").
//   "refuseModels": ["…"]    the API refuses the model (U1 E4): a turn on it answers a synthetic assistant message
//                            (`model: "<synthetic>"`, `error: "model_not_found"`, "There's an issue with the selected
//                            model (…)…") and a `result` with `is_error`; the process stays (a `set_model` rescues it);
//                            when stdin ends right after such a turn, the exit code is 1.
// PERMISSION MODES (U2 §B, U4 B–L; the error codes and the order in which they are checked are 2.1.288's, as
// test/hooks/mock-anthropic.test.ts measures them against the real binary when one is at hand):
//   `--permission-mode auto` runs in `default` instead, silently, when the model's list entry has no `supportsAutoMode`
//   (a model the list does not hold, "claude-fake" included, counts as having it) or any settings file the process
//   reads says `permissions.disableAutoMode: "disable"`. In auto: the edit tools on a file inside the working folder,
//   read-only commands, and `mkdir|touch|rm|rmdir|mv|cp …` / `echo|printf|cat … > file` whose operands all lie inside
//   the working folder run with no request and no classifier (the fast path); an ask rule asks; an allow rule runs (a
//   bare `Bash` rule is suspended); every other call goes to the stand-in's CLASSIFIER:
//     "classifier": { "block": ["<regex on the command, or on the input's JSON>", …], "category": "…" }, or a tool
//     step's "auto": "block" | "allow" (and "category"). Default: it allows. A block prints `system/permission_denied`
//     ({ tool_name, tool_use_id, decision_reason_type: "classifier", decision_reason: "[<category>]", message }) and an
//     error tool_result (`tool_result_meta` automode-blocked), and the call is in the result's `permission_denials`;
//     the THIRD block in a row (and every one after it until a call runs) is a `can_use_tool` with
//     `decision_reason_type: "classifier"` and "<n> consecutive actions were blocked. …".
//   A call a person refuses (`can_use_tool` answered `deny`) gets the person's message as its error result (2.1.288
//   hands the model their words) and is in `permission_denials`, as a hook's or a deny rule's refusal is.
//   A PreToolUse hook's "ask", a step's "ask": true and AskUserQuestion make a `can_use_tool` in every mode (a step's
//   "ask": false runs the call with neither a request nor the classifier).
//   `--permission-mode bypassPermissions` (or `--dangerously-skip-permissions`): when a settings file says
//   `permissions.disableBypassPermissionsMode: "disable"`, it runs in the `--settings` file's `defaultMode` (else
//   `auto`, then the auto rule above), silently. In bypass nothing asks but AskUserQuestion, an ask rule and a hook's
//   "ask". `FAKE_CLAUDE_AS_ROOT=1` with a bypass flag: stderr "--dangerously-skip-permissions cannot be used with
//   root/sudo privileges for security reasons", exit 1.
//   `set_permission_mode`: an unknown mode → error_code `invalid_mode`; `bypassPermissions` → `bypass_disabled` when a
//   settings file disables it, else `bypass_not_launched` unless the process was launched in it (or with
//   `--allow-dangerously-skip-permissions`); `auto` → `auto_mode_settings` (disableAutoMode) or `auto_mode_model`;
//   otherwise success `{ mode }` and a `status` line. 2.1.288 keeps an auto session in auto after `set_model` to a
//   model without auto mode (fixed in 2.1.299); so does the stand-in.
//   "controlErrors": { "<subtype>": { "error": "…", "code": "…" } }   that control request is answered with this error
//                            (no "code": no `error_code`, like every error 2.1.288 sends but the refusals above).
// HOOKS: `disableAllHooks` of the settings file that wins (`--settings`, then local, project, user) switches every hook
// off, the host's own included (assumed for the real 2.1.288, whose test is DESIGN 0.6.0 R7). An initialize-only
// process (stdin closed after control requests) exits 0 without a turn.
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
const sessionRules = [];
echo('argv', argv);
echo('settings', settings);
if (flag('--append-system-prompt-file')) echo('role-prompt', (() => { try { return readFileSync(flag('--append-system-prompt-file'), 'utf8'); } catch { return null; } })());

const out = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** Whether the scenario's regular expression fits `text` (one that does not compile fits nothing). */
const fits = (pattern, text) => {
  try {
    return new RegExp(pattern, 's').test(text);
  } catch {
    return false;
  }
};

// ---- models (see the header) -------------------------------------------------------------------------------------------
/** `initialize.models` of Claude Code 2.1.288 on the Anthropic API with a key (U1 E3); fake-claude.ts has the same list. */
const MODELS_2_1_288 = [
  { value: 'default', resolvedModel: 'claude-opus-5-5', displayName: 'Default (recommended)', description: 'Use the default model (currently Opus 5.5) · $4/$20 per Mtok', supportsEffort: true, supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max'], supportsAdaptiveThinking: true, supportsFastMode: true, supportsAutoMode: true },
  { value: 'opus', resolvedModel: 'claude-opus-5-5', displayName: 'Opus', description: 'Opus 5.5 · Best for everyday, complex tasks · $4/$20 per Mtok', supportsEffort: true, supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max'], supportsAdaptiveThinking: true, supportsFastMode: true, supportsAutoMode: true },
  { value: 'fable', resolvedModel: 'claude-fable-5-1', displayName: 'Fable', description: 'Fable 5.1 · Most capable for your hardest and longest-running tasks · $10/$50 per Mtok', supportsEffort: true, supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max'], supportsAdaptiveThinking: true, supportsAutoMode: true },
  { value: 'sonnet', resolvedModel: 'claude-sonnet-5-5', displayName: 'Sonnet', description: 'Sonnet 5.5 · Efficient for routine tasks · $2/$10 per Mtok', supportsEffort: true, supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max'], supportsAdaptiveThinking: true, supportsAutoMode: true },
  { value: 'haiku', resolvedModel: 'claude-haiku-4-5-20251001', displayName: 'Haiku', description: 'Haiku 4.5 · Fastest for quick answers · $1/$5 per Mtok' },
];
const modelList = Array.isArray(scenario0.models) ? scenario0.models.filter((entry) => typeof entry?.value === 'string') : MODELS_2_1_288;
const DEFAULT_MODEL = typeof scenario0.defaultModel === 'string' ? scenario0.defaultModel : 'claude-fake';
const ONE_M = '[1m]';

/** The list entry a model name or id stands for (by `value`, any case, then by `resolvedModel`), or undefined. */
function entryOf(name) {
  const lower = name.toLowerCase();
  return modelList.find((entry) => entry.value.toLowerCase() === lower) ?? modelList.find((entry) => entry.resolvedModel === name);
}

/** What a process runs for `name` (null: no `--model`): the name, the id `init` says, and the list entry. */
function resolveModel(name) {
  const asked = name ?? DEFAULT_MODEL;
  const oneM = asked.toLowerCase().endsWith(ONE_M);
  const base = oneM ? asked.slice(0, -ONE_M.length) : asked;
  const entry = entryOf(base);
  if (name !== null && entry === undefined) process.stderr.write(`[claude-code:unrecognized_model] ${JSON.stringify({ model: name, query_source: 'sdk' })}\n`);
  return { name, resolved: `${typeof entry?.resolvedModel === 'string' ? entry.resolvedModel : base}${oneM ? ONE_M : ''}`, entry };
}

/** Whether a model is on one of the scenario's lists (by the name it was given or the id it resolves to). */
const listed = (list, model) => Array.isArray(list) && list.some((item) => typeof item === 'string' && (item === model.name || item === model.resolved || `${item}${ONE_M}` === model.resolved));

let model = resolveModel(flag('--model') ?? null);
/** A model the organization restricts was named at the start: the default runs instead, said at the first turn. */
let restrictedAtStart = null;
if (model.name !== null && listed(scenario0.refuseSwitch, model)) {
  restrictedAtStart = model.name;
  model = resolveModel(null);
}
const restrictedText = (name) => `Model "${name}" is restricted by your organization's settings. Using ${model.resolved} instead.`;
/** The last turn ended on an API error (a refused model): stdin's end then exits 1, as 2.1.288 does. */
let lastTurnApiError = false;

// ---- permission modes (see the header) ---------------------------------------------------------------------------------
const MODES = ['acceptEdits', 'auto', 'bypassPermissions', 'default', 'dontAsk', 'plan'];
const modeName = (value) => (value === 'manual' ? 'default' : value);
/** Every settings file this process reads: `--settings` first, then the host's own. */
const settingsFiles = [settings, ...ownSettings.map(([, file]) => file)];
const disabledBySettings = (key) => settingsFiles.some((file) => file?.permissions?.[key] === 'disable');
const autoDisabled = disabledBySettings('disableAutoMode');
const bypassDisabled = disabledBySettings('disableBypassPermissionsMode');
/** Why auto mode cannot run now: `settings`, `model` (the list entry of the model has no auto mode), or null. */
const autoUnavailable = () => (autoDisabled ? 'settings' : model.entry !== undefined && model.entry.supportsAutoMode !== true ? 'model' : null);
const askedMode = has('--dangerously-skip-permissions') ? 'bypassPermissions' : modeName(flag('--permission-mode') ?? 'default');
if (env.FAKE_CLAUDE_AS_ROOT === '1' && (askedMode === 'bypassPermissions' || has('--allow-dangerously-skip-permissions'))) {
  process.stderr.write('--dangerously-skip-permissions cannot be used with root/sudo privileges for security reasons\n');
  process.exit(1);
}
/** Whether `set_permission_mode bypassPermissions` may switch to it (launched in it, or allowed to). */
const bypassAvailable = !bypassDisabled && (askedMode === 'bypassPermissions' || has('--allow-dangerously-skip-permissions'));
let permissionMode = askedMode;
if (permissionMode === 'bypassPermissions' && bypassDisabled) {
  const fallback = modeName(settings.permissions?.defaultMode);
  permissionMode = MODES.includes(fallback) && fallback !== 'bypassPermissions' ? fallback : 'auto';
}
if (permissionMode === 'auto' && autoUnavailable() !== null) permissionMode = 'default';
/** Classifier blocks in a row (a call that runs ends the row). */
let blocksInARow = 0;
/** The calls a turn did not run (the result's `permission_denials`). */
let denials = [];

// ---- hooks are off when the settings file that wins says so ------------------------------------------------------------
const hooksOff = [settings, ...ownSettings.map(([, file]) => file).reverse()].find((file) => typeof file?.disableAllHooks === 'boolean')?.disableAllHooks === true;

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
 * PreToolUse hook (or null), the reason of a PreToolUse hook that answered "ask" (or null), and, when a PreToolUse
 * hook answered `updatedInput`, the input the call goes on with.
 */
async function runHooks(event, tool, extra = {}) {
  const groups = hooksOff ? [] : [...(settings.hooks?.[event] ?? []), ...ownSettings.flatMap(([, file]) => (Array.isArray(file?.hooks?.[event]) ? file.hooks[event] : []))];
  let denied = null;
  let asked = null;
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
        else if (specific?.permissionDecision === 'ask') asked ??= String(specific.permissionDecisionReason ?? '');
        else if (typeof specific?.updatedInput === 'object' && specific.updatedInput !== null) updatedInput = specific.updatedInput;
      } catch {
        // no output: no decision
      }
    }
  }
  return { denied, asked, updatedInput };
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

const EDIT_TOOLS = ['Edit', 'Write', 'MultiEdit', 'NotebookEdit'];
const READ_TOOLS = ['Read', 'Glob', 'Grep', 'TodoWrite', 'Task'];
const READ_COMMANDS = ['ls', 'cat', 'pwd', 'echo', 'printf', 'head', 'tail', 'wc'];
const FILE_COMMANDS = ['mkdir', 'touch', 'rm', 'rmdir', 'mv', 'cp'];
/** What makes a command more than one simple command (the fast path takes none of them). */
const NOT_SIMPLE = [';', '&', '|', '`', '$', '<', '(', ')', '\n', '\\'];

/** A command's words, quotes taken off; null when a quote is not closed. */
function wordsOf(command) {
  const words = [];
  let word = null;
  let quote = null;
  for (const char of command) {
    if (quote !== null) {
      if (char === quote) quote = null;
      else word += char;
    } else if (char === "'" || char === '"') {
      quote = char;
      word ??= '';
    } else if (char === ' ' || char === '\t') {
      if (word !== null) words.push(word);
      word = null;
    } else word = (word ?? '') + char;
  }
  if (quote !== null) return null;
  if (word !== null) words.push(word);
  return words;
}

/** Claude Code's protected paths (U4: they never take the fast path): their names, anywhere in a path. */
const PROTECTED_NAMES = ['.git', '.claude', '.vscode', '.husky', '.gitconfig', '.mcp.json', '.bashrc', '.bash_profile', '.zshrc', '.zprofile', '.profile'];

/** Whether a path a command or a tool names lies inside the working folder (the folder itself does not) and is not protected. */
function inside(path) {
  const home = env.HOME ?? cwd;
  const absolute = path === '~' || path.startsWith('~/') ? join(home, path.slice(1)) : resolve(cwd, path);
  return absolute.startsWith(`${cwd}/`) && !absolute.slice(cwd.length + 1).split('/').some((name) => PROTECTED_NAMES.includes(name));
}

/** Claude Code's fast path in auto (U2, U4 G): a read-only command, or a simple file command inside the folder. */
function fastPath(command) {
  if (NOT_SIMPLE.some((mark) => command.includes(mark))) return false;
  const words = wordsOf(command.trim());
  if (words === null || words.length === 0) return false;
  const [name, ...rest] = words;
  if (name === 'git') return ['status', 'diff', 'log'].includes(rest[0] ?? '');
  const operands = [];
  const targets = [];
  for (let i = 0; i < rest.length; i++) {
    const word = rest[i];
    if (word === '>' || word === '>>') targets.push(rest[++i] ?? '');
    else if (word.startsWith('>')) targets.push(word.slice(word.startsWith('>>') ? 2 : 1));
    else if (word.includes('>')) return false; // `a>b`, `2>err`: not a redirect the fast path reads
    else if (!word.startsWith('-')) operands.push(word);
  }
  if (!targets.every(inside)) return false;
  if (READ_COMMANDS.includes(name)) return true;
  return FILE_COMMANDS.includes(name) && operands.length > 0 && operands.every(inside);
}

/**
 * What a call needs before it runs, in the mode the process runs in: `ask` (a `can_use_tool`), `run`, or `classify`
 * (auto mode's classifier). A step's `ask` decides first; a hook's "ask" was handled before.
 */
function routeOf(tool, input, step) {
  if (step.ask === true) return 'ask';
  if (step.ask === false) return 'run';
  const all = settings.permissions ?? {};
  const askRule = () => anyRule([...(all.ask ?? []), ...hostRulesOf('ask')], tool, input);
  if (permissionMode === 'bypassPermissions') return tool === 'AskUserQuestion' || askRule() ? 'ask' : 'run';
  if (permissionMode !== 'auto') return needsPermission(tool, input) ? 'ask' : 'run';
  if (tool === 'AskUserQuestion' || askRule()) return 'ask';
  if (tool.startsWith('mcp__smurg') || READ_TOOLS.includes(tool)) return 'run';
  // A bare `Bash` allow rule is a broad one: auto mode suspends it and asks its classifier instead.
  if (anyRule([...(all.allow ?? []), ...sessionRules, ...hostRulesOf('allow')].filter((rule) => rule !== 'Bash'), tool, input)) return 'run';
  if (EDIT_TOOLS.includes(tool)) return inside(String(input.file_path ?? input.notebook_path ?? '')) ? 'run' : 'classify';
  if (tool === 'Bash') return fastPath(String(input.command ?? '')) ? 'run' : 'classify';
  return 'classify';
}

/** The stand-in's classifier: the step's `auto`, else the scenario's `classifier.block` (read again for every call). */
function classify(tool, input, step) {
  const config = loadScenario().classifier ?? {};
  const text = tool === 'Bash' ? String(input.command ?? '') : JSON.stringify(input);
  const verdict = step.auto === 'block' || step.auto === 'allow' ? step.auto : Array.isArray(config.block) && config.block.some((pattern) => typeof pattern === 'string' && fits(pattern, text)) ? 'block' : 'allow';
  const category = typeof step.category === 'string' ? step.category : typeof config.category === 'string' ? config.category : 'Stand-in Block';
  const reason = `[${category}]`;
  echo('classifier', { tool, input, verdict, ...(verdict === 'block' ? { reason } : {}) });
  return { verdict, reason };
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
    model: model.resolved,
    permissionMode,
    apiKeySource: hasKey ? account.apiKeySource : 'none',
    claude_code_version: VERSION,
    uuid: randomUUID(),
  };
}

/** A turn on a model the API refuses (U1 E4): Claude Code's synthetic message and an error result; nothing else runs. */
function refusedModelSteps() {
  const text = `There's an issue with the selected model (${model.resolved}). It may not exist or you may not have access to it. Run --model to pick a different model.`;
  return [{ text, synthetic: true, apiError: 'model_not_found' }, { result: { subtype: 'success', is_error: true, terminal_reason: 'api_error', result: text } }];
}

function stepsFor(text) {
  const scenario = loadScenario();
  const turns = scenario.turns ?? [];
  for (let i = 0; i < turns.length; i++) {
    const turn = turns[i];
    if (turn.once && conversation.used.includes(i)) continue;
    if (turn.match !== undefined && !fits(turn.match, text)) continue;
    if (turn.once) conversation.used.push(i);
    return [...(turn.steps ?? [])];
  }
  return [{ text: 'ok' }];
}

async function emitText(step) {
  const id = `msg_fake_${++messageSeq}`;
  const parent = step.parent ?? null;
  // An API error is no streamed message (U1 E4: the assistant line alone).
  if (typeof step.apiError !== 'string') out({ type: 'stream_event', event: { type: 'message_start', message: { id } }, parent_tool_use_id: parent, session_id: claudeSessionId });
  for (const delta of typeof step.apiError === 'string' ? [] : (step.deltas ?? [step.text])) {
    out({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: delta } }, parent_tool_use_id: parent, session_id: claudeSessionId });
    if (step.deltaMs) await sleep(step.deltaMs);
    if (interrupted) break;
  }
  const text = interrupted && step.deltas ? step.deltas.join('').slice(0, Math.max(1, Math.floor(step.text.length / 2))) : step.text;
  out({ type: 'assistant', message: { id, type: 'message', role: 'assistant', model: step.synthetic ? '<synthetic>' : model.resolved, content: [{ type: 'text', text }] }, parent_tool_use_id: parent, session_id: claudeSessionId, uuid: randomUUID(), ...(typeof step.apiError === 'string' ? { error: step.apiError } : {}), ...(interrupted ? { aborted: true } : {}) });
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

function toolResultLine(toolUseId, text, isError, structured, parent, extra = {}) {
  out({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUseId, content: text, ...(isError ? { is_error: true } : {}) }] }, parent_tool_use_id: parent ?? null, session_id: claudeSessionId, uuid: randomUUID(), ...(structured === undefined ? {} : { tool_use_result: structured }), ...extra });
}

/** What 2.1.288 adds to the tool_result line of a call a hook or a person refused. */
const refusedMeta = (toolUseId) => ({ tool_result_meta: [{ id: toolUseId, non_execution_kind: 'permission-rule' }] });

/** A call the turn did not run, for the result's `permission_denials` (2.1.288 lists deny rules, refusals, blocks). */
const notRun = (tool, toolUseId, input) => denials.push({ tool_name: tool, tool_use_id: toolUseId, tool_input: input });

/** Auto mode's classifier refused a call (U4 B3): the `permission_denied` line, then the error tool_result. */
async function autoBlocked(tool, hookTool, input, toolUseId, parent, reason) {
  const message = `Permission for this action was denied by the Claude Code auto mode classifier. Reason: ${reason}. If you have other tasks that don't depend on this action, continue working on those.`;
  out({ type: 'system', subtype: 'permission_denied', tool_name: tool, tool_use_id: toolUseId, decision_reason_type: 'classifier', decision_reason: reason, message, uuid: randomUUID(), session_id: claudeSessionId });
  await runHooks('PermissionDenied', hookTool, { tool_input: input, tool_use_id: toolUseId, reason });
  toolResultLine(toolUseId, message, true, `Error: ${message}`, parent, { tool_result_meta: [{ id: toolUseId, non_execution_kind: 'automode-blocked' }] });
  notRun(tool, toolUseId, input);
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
  out({ type: 'assistant', message: { id: `msg_fake_${++messageSeq}`, type: 'message', role: 'assistant', model: model.resolved, content: [{ type: 'tool_use', id: toolUseId, name: tool, input }] }, parent_tool_use_id: parent, session_id: claudeSessionId, uuid: randomUUID() });
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
  const { denied, asked, updatedInput } = await runHooks('PreToolUse', hookTool, { tool_input: input, tool_use_id: toolUseId });
  if (denied !== null) {
    const text = `PreToolUse:${hookTool} hook error: ${denied}`;
    toolResultLine(toolUseId, text, true, `Error: ${text}`, parent, refusedMeta(toolUseId));
    notRun(tool, toolUseId, input);
    return;
  }
  // A hook rewrote the input: the permission request and the call carry the new one (recorded from 2.1.288).
  if (updatedInput !== undefined) input = updatedInput;
  if (anyRule([...(settings.permissions?.deny ?? []), ...hostRulesOf('deny')], tool, input)) {
    toolResultLine(toolUseId, `Permission to use ${tool} has been denied.`, true, undefined, parent);
    notRun(tool, toolUseId, input);
    return;
  }
  let answers;
  // A PreToolUse hook that answered "ask": a permission request whatever the mode and the allow rules would have
  // done by themselves, with the hook's reason and no suggestion (recorded from 2.1.288: `acceptEdits` and a matching
  // `Bash(cp:*)` rule both give way, and in auto the classifier is not asked; a deny rule, above, still refuses first).
  let route = asked !== null ? 'ask' : routeOf(tool, input, step);
  let request = asked !== null ? { reason: asked, reasonType: 'hook' } : step;
  if (route === 'classify') {
    const { verdict, reason } = classify(tool, input, step);
    if (verdict === 'allow') {
      blocksInARow = 0;
      route = 'run';
    } else {
      blocksInARow += 1;
      if (blocksInARow < 3) {
        await autoBlocked(tool, hookTool, input, toolUseId, parent, reason);
        return;
      }
      // The third block in a row: a person decides (U4 L), with the rule Claude Code suggests for the call.
      route = 'ask';
      request = { reason: `${blocksInARow} consecutive actions were blocked. Please review the transcript before continuing.\n\nLatest blocked action: ${reason}`, reasonType: 'classifier', suggest: tool === 'Bash' ? { toolName: tool, ruleContent: String(input.command ?? '') } : { toolName: tool } };
    }
  }
  if (route === 'ask') {
    if (['Edit', 'Write', 'MultiEdit', 'NotebookEdit'].includes(tool)) await runHooks('PermissionRequest', tool, { tool_input: input, tool_use_id: toolUseId });
    const response = await ask(tool, input, toolUseId, request);
    if (response === null) return; // withdrawn (interrupt): no result
    if (response.behavior !== 'allow') {
      if (tool === 'AskUserQuestion') toolResultLine(toolUseId, String(response.message ?? 'The user declined to answer.'), true, undefined, parent);
      else {
        // 2.1.288 hands the model the person's own words (U4 L; test/hooks/mock-anthropic.test.ts), and lists the call.
        const text = typeof response.message === 'string' && response.message.length > 0 ? response.message : "The user doesn't want to proceed with this tool use.";
        toolResultLine(toolUseId, text, true, `Error: ${text}`, parent, refusedMeta(toolUseId));
        notRun(tool, toolUseId, input);
      }
      return;
    }
    if (request.reasonType === 'classifier') blocksInARow = 0;
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
  const hold = loadScenario().holdInitUntil;
  if (typeof hold === 'string') while (!existsSync(hold)) await sleep(10);
  denials = [];
  out(initLine());
  if (restrictedAtStart !== null) {
    out({ type: 'system', subtype: 'informational', content: restrictedText(restrictedAtStart), isMeta: false, level: 'warning', uuid: randomUUID(), session_id: claudeSessionId });
    restrictedAtStart = null;
  }
  await runHooks('UserPromptSubmit', undefined, {});
  out({ type: 'user', message: first.message, session_id: claudeSessionId, parent_tool_use_id: null, uuid: first.uuid, isReplay: true });
  // (Only a refused model's turn makes the exit 1: what 2.1.288 does after a turn that was not logged in was not measured.)
  const refused = !notLoggedIn && listed(loadScenario().refuseModels, model);
  const steps = notLoggedIn ? [{ text: 'Not logged in · Please run /login', synthetic: true }, { result: { subtype: 'success', is_error: true, terminal_reason: 'api_error' } }] : refused ? refusedModelSteps() : stepsFor(first.text);
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
  lastTurnApiError = refused && !interrupted;
  out({ type: 'result', ...result, duration_ms: Date.now() - started, num_turns: 1, result: typeof result.result === 'string' ? result.result : '', session_id: claudeSessionId, total_cost_usd: 0, usage: {}, permission_denials: denials, user_message_uuids: uuids, uuid: randomUUID() });
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
    process.exit(lastTurnApiError ? 1 : 0);
  }
}

/** The refusal of a `set_permission_mode`, as 2.1.288 checks it (its own order and error codes), or null. */
function modeRefusal(mode) {
  if (!MODES.includes(mode)) return { error: `Cannot set permission mode: must be one of ${MODES.join(', ')}`, code: 'invalid_mode' };
  if (mode === 'bypassPermissions') {
    if (bypassDisabled) return { error: 'Cannot set permission mode to bypassPermissions because it is disabled by settings or configuration', code: 'bypass_disabled' };
    if (!bypassAvailable) return { error: 'Cannot set permission mode to bypassPermissions because the session was not launched with --dangerously-skip-permissions', code: 'bypass_not_launched' };
  }
  if (mode === 'auto') {
    const why = autoUnavailable();
    if (why === 'settings') return { error: 'Cannot set permission mode to auto: auto mode disabled by settings', code: 'auto_mode_settings' };
    if (why === 'model') return { error: 'Cannot set permission mode to auto: auto mode unavailable for this model', code: 'auto_mode_model' };
  }
  return null;
}

function onControl(message) {
  const request = message.request ?? {};
  const respond = (response) => out({ type: 'control_response', response: { subtype: 'success', request_id: message.request_id, ...(response === undefined ? {} : { response }) } });
  /** An error answer; `code` is Claude Code's `error_code`, which 2.1.288 sends only for the refusals a host can act on. */
  const refuse = (error, code) => out({ type: 'control_response', response: { subtype: 'error', request_id: message.request_id, error, ...(typeof code === 'string' ? { error_code: code } : {}) } });
  const scripted = loadScenario().controlErrors?.[request.subtype];
  if (typeof scripted?.error === 'string') {
    refuse(scripted.error, scripted.code);
    return;
  }
  switch (request.subtype) {
    case 'initialize':
      respond({ commands: [], agents: [], models: modelList, account, pid: process.pid, current_permission_mode: permissionMode });
      return;
    case 'list_permission_rules':
      if (scenario0.noRuleList) refuse('Unsupported control request subtype: list_permission_rules');
      else {
        // Claude Code's own order: every allow rule, then ask, then deny; each with where it comes from and whether the
        // session may change it (`--settings` rules are read-only).
        const flagRules = ['allow', 'ask', 'deny'].flatMap((behavior) => (settings.permissions?.[behavior] ?? []).map((rule) => ({ behavior, source: 'flagSettings', rule })));
        const inOrder = ['allow', 'ask', 'deny'].flatMap((behavior) => [...hostRules, ...flagRules].filter((entry) => entry.behavior === behavior));
        respond({ state: { rules: inOrder.map((entry) => ({ behavior: entry.behavior, source: entry.source, rule: entry.rule, editability: entry.source === 'flagSettings' ? 'readonly' : 'persistent' })), workspaceDirectories: [], originalCwd: cwd, managedOnly: false } });
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
    case 'set_permission_mode': {
      const mode = modeName(String(request.mode));
      const refusal = modeRefusal(mode);
      if (refusal !== null) {
        refuse(refusal.error, refusal.code);
        return;
      }
      permissionMode = mode;
      respond({ mode });
      out({ type: 'system', subtype: 'status', status: null, permissionMode, session_id: claudeSessionId, uuid: randomUUID() });
      return;
    }
    case 'set_model': {
      const name = typeof request.model === 'string' ? request.model : null;
      const next = resolveModel(name);
      if (name !== null && listed(loadScenario().refuseSwitch, next)) {
        refuse(restrictedText(name), 'restricted_by_org');
        return;
      }
      model = next;
      respond(); // 2.1.288's success has no `response`, and no line says so: the next turn's `init` shows the model.
      return;
    }
    case 'get_settings':
      respond({ effective: {}, sources: [], applied: { model: model.resolved } });
      return;
    default:
      refuse(`Unsupported control request subtype: ${request.subtype}`);
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
