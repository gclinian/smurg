// The trust gate for a root's project-level Claude Code settings (ARCHITECTURE §7.6 "Trust gate"; DESIGN §2.9, AD-13).
// Structured mode never shows Claude Code's trust dialog: a project's `.claude/settings.json` hooks and `.mcp.json`
// servers would run as the host as soon as a session starts in the folder. So a session loads them only when the host
// has confirmed exactly that content, after seeing everything it does.
//
//  - WHAT IS TRUSTED: a file content, per file (`.claude/settings.json`, `.claude/settings.local.json`, `.mcp.json`),
//    each with its own SHA-256, plus the scripts its commands point at (each recorded with its own hash). A decision
//    is keyed by path + content hash, not by root: a work item's worktree is a clone, its committed files hash like
//    the main workspace's and need no confirmation of their own.
//  - EVERYTHING ELSE CLAUDE CODE LOADS from the folder's `.claude/` (agents, skills, commands, rules, …: they can
//    declare hooks and allow tools in their own headers) is one more entry of the gate (PROJECT_LOADED_ENTRY): every
//    file named for the host, confirmed with the settings files, and decided per file content too, so a worktree
//    that has some of them needs no confirmation of its own.
//  - A ROOT is `used` when every one of these that exists in it has a trusted content (and every recorded script still
//    has its recorded content); `none` when none exists; otherwise `ignored` (the session then starts with
//    `--setting-sources user`).
//  - WHAT THE HOST IS SHOWN is everything, or it says what is missing: an entry that was shortened or left out of a
//    list is counted (`cut`) and then "Use them" needs the tick `incomplete`; characters a person cannot see are
//    written out (`<U+202E>`).
//  - WHILE SESSIONS RUN the files, `.claude/` and the recorded scripts are watched (bus `file.changed`; a folder that
//    holds one of them counts, a renamed folder is reported as the folder alone). Whenever a look at the files finds
//    a content that is not trusted (the watcher, a session start, the host opening the review, a merge) the sessions
//    of that root that loaded the settings are parked.
//  - THE SCRIPTS are every file of the folder a command names, however it spells the folder (`$CLAUDE_PROJECT_DIR`,
//    `${CLAUDE_PROJECT_DIR:-.}`, `$PWD`, a `cd` before it, a substitution in front of the path), AND every path a
//    command names where no file is yet (`[ -x scripts/optional.sh ] && …`, a build output): such a path is recorded
//    as "named, not there yet" (SCRIPT_ABSENT_HASH), guarded and watched like a script, and the file appearing is a
//    change of the confirmed content. A command that reaches its files in a way smurg cannot follow (a variable
//    as the program or as the script of an interpreter, a wildcard there, `eval`) says so in the review and needs the
//    tick `incomplete`. A lookup that cannot be made (too many words, a path that cannot be looked at) makes the
//    content one nobody can confirm.
//  - While a content is trusted its scripts are host-only for writes through smurg (`protectedPaths`: at the path
//    and below it), no agent's edit tool writes them (tool gate G3), and an agent's shell command that may change
//    one, or a folder above one, asks a person first (tool gate G10, hooks/bash-guard.ts).
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, readFile, readdir, realpath, stat } from 'node:fs/promises';
import { isAbsolute, join, normalize, relative, sep } from 'node:path';
import { z } from 'zod';
import {
  CLAUDE_CONFIG_ENTRY_MAX_CHARS,
  CLAUDE_CONFIG_LIST_MAX,
  CLAUDE_CONFIG_SCRIPTS_MAX,
  CLAUDE_CONFIG_TEXT_MAX_BYTES,
  MAIN_ROOT,
  PROJECT_LOADED_ENTRY,
  PROJECT_SETTINGS_FILES,
  SHORT_TEXT_MAX_CHARS,
  SmurgError,
  checkRelPath,
  foldRelPath,
  folderHoldsPath,
  parentRelPath,
  relPathSegments,
  rootRefKey,
  takeListPage,
  truncateToUtf8Bytes,
  visibleText,
  type ProjectSettingsState,
  type RootRef,
} from '@smurg/protocol';
import { msg } from '@smurg/protocol/i18n';
import type { DaemonContext } from '../../core/context.ts';
import type { AttentionFact, FileChange, PersistentDocument, Principal, ProjectTrust, Req, Res } from '../../core/interfaces.ts';
import { DisposableStack, type Disposable } from '../../core/lifecycle.ts';
import { declareDocument } from '../../core/state-store.ts';
import { UNKNOWN_PART, programName, programWords, scanShell, type ShellWord } from '../../core/shell-scan.ts';

type ClaudeConfigFile = Res<'admin.claudeConfig.get'>['roots'][number]['files'][number];
type Ack = ClaudeConfigFile['needsAck'][number];

const sha256 = (data: string | Uint8Array): string => createHash('sha256').update(data).digest('hex');
const HEX = /^[0-9a-f]{64}$/;

/** Decisions about files below `.claude/` (the loaded entry) that are kept: the oldest go first. */
const LOADED_KEYS_MAX = 20_000;

const decisionSchema = z.strictObject({
  path: z.string().min(1).max(256),
  hash: z.string().regex(HEX),
  decision: z.enum(['trust', 'ignore']),
  /** The scripts the content's commands pointed at when it was decided: part of the trusted content. */
  scripts: z.array(z.strictObject({ path: z.string().min(1).max(4096), hash: z.string().regex(HEX) })).max(CLAUDE_CONFIG_SCRIPTS_MAX),
  at: z.int().min(0),
});
const documentSchema = z.strictObject({
  decisions: z.array(decisionSchema).max(2_000),
  /**
   * The loaded entry, decided per file: the key of a file is the hash of its path, its content hash and the scripts
   * its header's hooks run (with their hashes), so a changed script is a content nobody decided about.
   */
  loaded: z.strictObject({ trusted: z.array(z.string().regex(HEX)).max(LOADED_KEYS_MAX), ignored: z.array(z.string().regex(HEX)).max(LOADED_KEYS_MAX) }),
});
type TrustDocument = z.infer<typeof documentSchema>;
/** claude-trust.json (no `version` key; new in 0.5.0): the host's decisions about a project's Claude Code settings. Declared by the sessions module. */
export const claudeTrustDocument = declareDocument({ name: 'claude-trust', schema: documentSchema, init: (): TrustDocument => ({ decisions: [], loaded: { trusted: [], ignored: [] } }), canSetAside: true });
type Decision = z.infer<typeof decisionSchema>;

/** A project settings file larger than this is never trusted (it cannot be shown whole). */
const SETTINGS_FILE_MAX_BYTES = CLAUDE_CONFIG_TEXT_MAX_BYTES;
/** A script larger than this is not hashed: the content that names it is never trusted. */
const SCRIPT_MAX_BYTES = 64 * 1024 * 1024;
/** Words of a file's commands that are looked up as files of the root. A file with more is never trusted. */
export const SCRIPT_CANDIDATES_MAX = 2_000;
/** In place of a content hash: the path is named by a command and no file is there (yet). */
export const SCRIPT_ABSENT_HASH = sha256('smurg: a script that is named and not there yet');
/** The loaded entry: files below `.claude/`, and their bytes, that one look hashes. More is never trusted. */
const LOADED_FILES_MAX = 2_000;
const LOADED_BYTES_MAX = 64 * 1024 * 1024;
/** A file below `.claude/` whose header is read (larger ones are named and hashed only). */
const HEADER_FILE_MAX_BYTES = 256 * 1024;
/** Directly below `.claude/`, not part of the loaded entry: the two settings files, and Claude Code's own worktree checkouts. */
const NOT_LOADED: ReadonlySet<string> = new Set(['settings.json', 'settings.local.json', 'worktrees']);

type Json = Record<string, unknown>;
const isObject = (value: unknown): value is Json => typeof value === 'object' && value !== null && !Array.isArray(value);

// ---------------------------------------------------------------------------------------------------------------------
// What the host reads: nothing invisible, nothing cut without a count
// ---------------------------------------------------------------------------------------------------------------------

// What the host reads is written by the protocol's `visibleText`: every character nobody can see as `<U+XXXX>`.
export { visibleText };

/** The first `max` UTF-16 units of `text`, never ending inside a surrogate pair. */
function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  const last = text.charCodeAt(max - 1);
  return text.slice(0, last >= 0xd800 && last <= 0xdbff ? max - 1 : max);
}

/** Variables that can send the host's login to another server. */
export function isFlaggedEnvName(name: string): boolean {
  const upper = name.toUpperCase();
  return upper.startsWith('ANTHROPIC_') || upper.startsWith('CLAUDE_') || /^(HTTPS?|ALL|NO)_PROXY$/.test(upper) || upper === 'NODE_EXTRA_CA_CERTS' || upper === 'SSL_CERT_FILE' || upper.startsWith('AWS_') || upper.startsWith('GOOGLE_') || upper.startsWith('VERTEX_');
}

const PROGRAM_ENV_NAMES: ReadonlySet<string> = new Set([
  ...['PATH', 'ENV', 'BASH_ENV', 'SHELL', 'ZDOTDIR', 'IFS', 'CDPATH', 'PROMPT_COMMAND', 'PS4', 'HOME', 'TMPDIR', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME'],
  ...['EDITOR', 'VISUAL', 'PAGER', 'MANPAGER', 'BROWSER', 'SSH_ASKPASS', 'SUDO_ASKPASS'],
  ...['NODE_OPTIONS', 'NODE_PATH', 'PYTHONPATH', 'PYTHONSTARTUP', 'PYTHONHOME', 'PYTHONINSPECT', 'PERL5LIB', 'PERL5OPT', 'PERLLIB', 'RUBYOPT', 'RUBYLIB', 'GEM_PATH', 'GEM_HOME', 'BUNDLE_GEMFILE'],
  ...['JAVA_TOOL_OPTIONS', '_JAVA_OPTIONS', 'JDK_JAVA_OPTIONS', 'CLASSPATH', 'GOFLAGS', 'RUSTC_WRAPPER', 'RUSTFLAGS', 'CC', 'CXX', 'LD', 'MAKEFLAGS'],
]);
const PROGRAM_ENV_PREFIXES: readonly string[] = ['LD_', 'DYLD_', 'GIT_', 'SSH_', 'NPM_CONFIG_', 'YARN_', 'PNPM_', 'COREPACK_', 'BUN_', 'DENO_', 'PIP_', 'UV_', 'CARGO_', 'DOCKER_', 'BASH_FUNC_'];

/**
 * Variables that change which programs run, what they load, or how git and ssh reach a server (`PATH`, `NODE_OPTIONS`,
 * `BASH_ENV`, `GIT_SSH_COMMAND`, `LD_PRELOAD`, `DYLD_*`, …). Their value is shown among the commands, and a file of the
 * root it names is recorded like a script. The families smurg knows; no list of them is complete.
 */
export function isProgramEnvName(name: string): boolean {
  const upper = name.toUpperCase();
  return PROGRAM_ENV_NAMES.has(upper) || PROGRAM_ENV_PREFIXES.some((prefix) => upper.startsWith(prefix));
}

const TOOL_RULE = /^(Bash|Edit|Write|MultiEdit|NotebookEdit|mcp__)/;
const TOOL_NAMED = /(^|[\s,[("'])(Bash|Edit|Write|MultiEdit|NotebookEdit|mcp__)/;

export interface FileEffects {
  readonly runs: string[];
  readonly permissions: string[];
  readonly env: { name: string; flagged: boolean; programs?: boolean }[];
  readonly otherKeys: string[];
  /** Every command with its arguments, for the script lookup. */
  readonly commands: string[][];
  readonly needsAck: Ack[];
  /** What the lists leave out; absent when they are everything. */
  readonly cut?: { omitted: number; shortened: number };
  /** Commands whose files smurg cannot follow (each has UNFOLLOWED_NOTE below it); absent when there is none. */
  readonly unfollowed?: number;
}

/** The lists of one entry of the review, bounded as the wire bounds them, counting what does not fit. */
class Lists {
  readonly runs: string[] = [];
  readonly permissions: string[] = [];
  readonly env: { name: string; flagged: boolean; programs?: boolean }[] = [];
  readonly otherKeys: string[] = [];
  readonly commands: string[][] = [];
  omitted = 0;
  shortened = 0;
  /** Commands that reach their files in a way smurg cannot follow. */
  unfollowed = 0;
  credentials = false;
  allowsTools = false;

  private fit(text: string, max: number): string {
    if (text.length > max) this.shortened += 1;
    return clip(text, max);
  }

  private add<T>(list: T[], make: () => T): void {
    if (list.length >= CLAUDE_CONFIG_LIST_MAX) this.omitted += 1;
    else list.push(make());
  }

  line(list: string[], text: string): void {
    this.add(list, () => this.fit(visibleText(text), CLAUDE_CONFIG_ENTRY_MAX_CHARS));
  }

  key(text: string): void {
    this.add(this.otherKeys, () => this.name(text));
  }

  name(text: string): string {
    return this.fit(visibleText(text, true), SHORT_TEXT_MAX_CHARS) || '?';
  }

  variable(name: string): void {
    const flagged = isFlaggedEnvName(name);
    if (flagged) this.credentials = true;
    this.add(this.env, () => ({ name: this.name(name), flagged, ...(isProgramEnvName(name) ? { programs: true } : {}) }));
  }

  /** A command the content runs: listed whole, and its words are looked up as scripts. */
  run(label: string, line: string[] | null): void {
    if (line === null) return;
    this.commands.push(line);
    this.line(this.runs, `${label}: ${line.join(' ')}`);
    if (cannotFollow(line)) {
      // Said right below the command it is about; counted even when the list has no room for the sentence.
      this.unfollowed += 1;
      this.line(this.runs, UNFOLLOWED_NOTE);
    }
  }

  effects(extraAcks: readonly Ack[] = []): FileEffects {
    const cut = this.omitted > 0 || this.shortened > 0;
    const incomplete = cut || this.unfollowed > 0;
    const acks = new Set<Ack>([...(this.credentials ? (['credentials'] as const) : []), ...(this.allowsTools ? (['allows-tools'] as const) : []), ...extraAcks, ...(incomplete ? (['incomplete'] as const) : [])]);
    return {
      runs: this.runs,
      permissions: this.permissions,
      env: this.env,
      otherKeys: this.otherKeys,
      commands: this.commands,
      needsAck: (['credentials', 'allows-tools', 'incomplete'] as const).filter((ack) => acks.has(ack)),
      ...(cut ? { cut: { omitted: this.omitted, shortened: this.shortened } } : {}),
      ...(this.unfollowed > 0 ? { unfollowed: this.unfollowed } : {}),
    };
  }
}

function commandLine(command: unknown, args: unknown): string[] | null {
  if (typeof command !== 'string' || command.length === 0) return null;
  const rest = Array.isArray(args) ? args.filter((arg): arg is string => typeof arg === 'string') : [];
  return [command, ...rest];
}

/** PURE: everything a project settings file (or `.mcp.json`) does, read from its text (DESIGN §2.9 table). */
export function effectsOf(path: string, text: string): FileEffects {
  const lists = new Lists();
  const servers = (value: unknown): void => {
    if (!isObject(value)) {
      lists.line(lists.runs, `mcpServers: ${JSON.stringify(value)}`);
      return;
    }
    for (const [name, server] of Object.entries(value)) {
      if (!isObject(server)) continue;
      const line = commandLine(server['command'], server['args']);
      if (line !== null) lists.run(`MCP server ${name}`, line);
      else if (typeof server['url'] === 'string') lists.line(lists.runs, `MCP server ${name}: ${server['url']}`);
      if (isObject(server['env'])) {
        for (const [key, value] of Object.entries(server['env'])) {
          if (isFlaggedEnvName(key)) lists.credentials = true;
          if (isProgramEnvName(key)) lists.run(`MCP server ${name} env ${key}`, [typeof value === 'string' ? value : JSON.stringify(value)]);
        }
      }
    }
  };
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ...lists.effects(), otherKeys: ['(not valid JSON: Claude Code may read it differently)'], needsAck: ['credentials', 'allows-tools'] };
  }
  if (!isObject(parsed)) return { ...lists.effects(), otherKeys: ['(not a JSON object)'] };
  for (const [key, value] of Object.entries(parsed)) {
    if (key === 'mcpServers') servers(value);
    else if (path === '.mcp.json') lists.key(key);
    else if (key === 'hooks' && isObject(value)) {
      for (const [event, groups] of Object.entries(value)) {
        // A shape smurg does not know is shown as it is written: Claude Code may read it as a hook.
        if (!Array.isArray(groups)) {
          lists.line(lists.runs, `hook ${event}: ${JSON.stringify(groups)}`);
          continue;
        }
        for (const group of groups) {
          if (!isObject(group) || !Array.isArray(group['hooks'])) {
            lists.line(lists.runs, `hook ${event}: ${JSON.stringify(group)}`);
            continue;
          }
          for (const hook of group['hooks']) {
            const line = isObject(hook) ? commandLine(hook['command'], hook['args']) : null;
            if (line !== null) lists.run(`hook ${event}`, line);
            else if (isObject(hook) && typeof hook['url'] === 'string') lists.line(lists.runs, `hook ${event}: ${hook['url']}`);
            else lists.line(lists.runs, `hook ${event}: ${JSON.stringify(hook)}`);
          }
        }
      }
    } else if (key === 'apiKeyHelper') {
      lists.credentials = true;
      lists.run('apiKeyHelper', typeof value === 'string' ? [value] : null);
    } else if (key === 'statusLine' || key === 'fileSuggestion' || key === 'awsAuthRefresh' || key === 'awsCredentialExport' || key === 'otelHeadersHelper') {
      if (key !== 'statusLine' && key !== 'fileSuggestion') lists.credentials = true;
      lists.run(key, typeof value === 'string' ? [value] : isObject(value) ? commandLine(value['command'], value['args']) : null);
    } else if (key === 'enabledPlugins' || key === 'extraKnownMarketplaces' || key === 'pluginConfigs') {
      lists.line(lists.runs, `${key}: ${JSON.stringify(value)}`);
    } else if (key === 'permissions' && isObject(value)) {
      for (const [kind, list] of Object.entries(value)) {
        if (Array.isArray(list)) {
          for (const rule of list) {
            if (typeof rule !== 'string') continue;
            if (kind === 'allow' && TOOL_RULE.test(rule)) lists.allowsTools = true;
            lists.line(lists.permissions, `${kind}: ${rule}`);
          }
        } else {
          if (kind === 'defaultMode' && list !== 'default' && list !== 'plan') lists.allowsTools = true;
          lists.line(lists.permissions, `${kind}: ${typeof list === 'string' ? list : JSON.stringify(list)}`);
        }
      }
    } else if (key === 'env' && isObject(value)) {
      for (const [name, content] of Object.entries(value)) {
        lists.variable(name);
        // What such a variable is set to decides what runs: shown with the commands, looked up like one.
        if (isProgramEnvName(name)) lists.run(`env ${name}`, [typeof content === 'string' ? content : JSON.stringify(content)]);
      }
    } else lists.key(key);
  }
  return lists.effects();
}

/** Below a command in `runs`: smurg cannot tell which files it runs. */
export const UNFOLLOWED_NOTE = '^ smurg cannot follow which files the command above runs (a variable, a wildcard or a text it builds names them): only the scripts listed for this entry are guarded';

// Names whose value is known when a hook command runs: the folder itself, the directory the command starts in, and
// the host's home. (A settings file that sets one of them shows it among the variables that change which programs run.)
const KNOWN_NAMES: Readonly<Record<string, string>> = { CLAUDE_PROJECT_DIR: '/', PWD: '/', HOME: '/' };
const SHELLS: ReadonlySet<string> = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'fish']);
/** Programs whose first operand is a file they run. */
const SCRIPT_RUNNERS: ReadonlySet<string> = new Set([...SHELLS, 'source', '.', 'node', 'deno', 'bun', 'python', 'python2', 'python3', 'ruby', 'perl', 'php', 'lua', 'osascript', 'awk', 'gawk', 'make', 'tsx', 'ts-node']);
/** Programs that run the command that follows their own options. */
const WRAPPERS: ReadonlySet<string> = new Set(['env', 'sudo', 'doas', 'nice', 'nohup', 'timeout', 'command', 'builtin', 'exec', 'time', 'xargs']);
const FIND_RUNS: ReadonlySet<string> = new Set(['-exec', '-execdir', '-ok', '-okdir']);
const ASSIGNED = /^[A-Za-z_][A-Za-z0-9_]*=/;

const notKnown = (word: ShellWord): boolean => word.dynamic || word.glob || word.text.includes(UNKNOWN_PART);
const literalWord = (text: string): ShellWord => ({ text, dynamic: /[$`]/.test(text), glob: false, prefix: text, quoted: true });

/**
 * How much reading one command is worth. Every look at a list of words takes the list's length out of it (and one
 * more for each 64 characters of a word), every text handed to the reader the text's length; a command that uses it up is not followed. So what following costs is in
 * proportion to the command, whatever the command is: a wrapper in front of a wrapper is looked at twice (as the
 * command, and as the value of an option of the one before it), so thirty of them in a row doubled the work thirty
 * times, and an `eval` reads everything behind it again. Sixteen wrappers in a row are followed; no command has more.
 */
interface FollowBudget {
  left: number;
}
const FOLLOW_STEPS_MIN = 20_000;
const FOLLOW_STEPS_PER_CHAR = 8;

/** Whether the words of ONE command name what it runs in a way nobody can follow. */
function wordsNotFollowed(words: readonly ShellWord[], depth: number, budget: FollowBudget): boolean {
  // A look reads every character of every word: a long word costs its length (one step for each 64 characters), or
  // thirty wrappers in front of one word of 64,000 letters would read it thousands of times.
  budget.left -= words.reduce((steps, word) => steps + 1 + (word.text.length >> 6), 1);
  if (budget.left < 0) return true;
  const first = words[0];
  if (first === undefined) return false;
  // The program itself is a variable, a substitution or a wildcard.
  if (notKnown(first)) return true;
  const program = programName(first);
  const rest = words.slice(1);
  if (program === 'cd' || program === 'pushd') return rest.some(notKnown) || rest.some((word) => word.text === '-');
  if (program === 'popd') return true;
  if (program === 'eval') return rest.some(notKnown) || textNotFollowed(rest.map((word) => word.text).join(' '), depth + 1, budget);
  if (WRAPPERS.has(program)) {
    let at = 0;
    while (at < rest.length && !notKnown(rest[at] as ShellWord) && (/^-/.test((rest[at] as ShellWord).text) || ASSIGNED.test((rest[at] as ShellWord).text) || /^[0-9.]+[smhd]?$/.test((rest[at] as ShellWord).text))) at += 1;
    const inner = rest.slice(at);
    // `xargs sh`, `xargs node`: the script comes from the input.
    if (program === 'xargs' && inner[0] !== undefined && !notKnown(inner[0]) && SCRIPT_RUNNERS.has(programName(inner[0]))) return true;
    if (wordsNotFollowed(inner, depth, budget)) return true;
    // An option of the wrapper that takes a value (`sudo -u x python3 …`): the command starts later.
    const later = inner.findIndex((word, index) => index > 0 && !notKnown(word) && (SCRIPT_RUNNERS.has(programName(word)) || WRAPPERS.has(programName(word)) || programName(word) === 'eval'));
    return later !== -1 && wordsNotFollowed(inner.slice(later), depth, budget);
  }
  if (program === 'find') {
    const at = rest.findIndex((word) => !notKnown(word) && FIND_RUNS.has(word.text));
    return at !== -1 && wordsNotFollowed(rest.slice(at + 1).filter((word) => word.text !== ';' && word.text !== '+'), depth, budget);
  }
  if (!SCRIPT_RUNNERS.has(program)) return false;
  const operands = rest.filter((word) => notKnown(word) || !word.text.startsWith('-'));
  const script = operands[0];
  // No operand: it reads its program from its input, which no settings file holds.
  if (script === undefined) return false;
  // `sh -c "<a command line>"`: read like the command itself.
  if (SHELLS.has(program) && rest.some((word) => !notKnown(word) && /^-[A-Za-z]*c$/.test(word.text))) return script.text === UNKNOWN_PART || textNotFollowed(script.text, depth + 1, budget);
  return notKnown(script);
}

function textNotFollowed(text: string, depth: number, budget: FollowBudget): boolean {
  if (depth > 3) return true;
  budget.left -= text.length;
  if (budget.left < 0) return true;
  const scan = scanShell(text, { variables: KNOWN_NAMES, home: '/' });
  return scan.unparsed || scan.commands.some((command) => wordsNotFollowed(programWords(command), depth, budget));
}

/**
 * PURE: whether a command the content runs reaches its files in a way smurg cannot follow: the program, or the
 * script an interpreter is given, is a variable, a substitution or a wildcard; a `cd` to such a place; `eval` of
 * such a text; a line the reader cannot take apart, or one that takes more reading than its length is worth
 * (FollowBudget). `line`: the command, and its `args` when it has a list of them (each one word, run without a shell).
 */
export function cannotFollow(line: readonly string[]): boolean {
  const [command, ...args] = line;
  if (command === undefined) return false;
  const budget: FollowBudget = { left: FOLLOW_STEPS_MIN + FOLLOW_STEPS_PER_CHAR * line.reduce((sum, part) => sum + part.length, 0) };
  if (args.length === 0) return textNotFollowed(command, 0, budget);
  const scan = scanShell(command, { variables: KNOWN_NAMES, home: '/' });
  const head = scan.commands[0];
  if (scan.unparsed || scan.commands.length !== 1 || head === undefined) return true;
  return wordsNotFollowed([...programWords(head), ...args.map(literalWord)], 0, budget);
}

const LOOSE_SPLIT = /[\s;&|()<>=,`]+/;
const PLAIN_NAME = /^[\p{L}\p{N}._@+-]+$/u;
const SCRIPT_EXTENSION = /\.(sh|bash|zsh|ksh|fish|js|mjs|cjs|ts|mts|cts|tsx|jsx|py|rb|pl|php|lua|ps1|awk|jar)$/i;

/** A word of a command that may be a file of the root. `named`: written as a path of its own (not a piece of a word). */
interface Candidate {
  readonly text: string;
  readonly named: boolean;
}

/**
 * PURE: the words of the commands that are looked up as files, and the directories a command changes to (`cd x`):
 * every word is looked up from each of them. `variables`: the real values of the known names. `overflow`: more
 * words than SCRIPT_CANDIDATES_MAX (then nothing can be said about the content).
 */
export function scriptCandidates(commands: readonly (readonly string[])[], variables: Readonly<Record<string, string>>, home: string | undefined): { candidates: Candidate[]; dirs: string[]; overflow: boolean } {
  const found = new Map<string, boolean>();
  const dirs = new Set<string>();
  let overflow = false;
  const add = (text: string, named: boolean): void => {
    if (text.length === 0 || text.length > 1024 || text.startsWith('-') || text.includes('\u0000') || text.includes(UNKNOWN_PART)) return;
    const known = found.get(text);
    if (known === undefined && found.size >= SCRIPT_CANDIDATES_MAX) overflow = true;
    else found.set(text, known === true || named);
  };
  const word = (entry: ShellWord): void => {
    // `NAME=value`, `--config=./x.js`: the value is a word of its own.
    const texts = [entry.text, ...(entry.text.includes('=') ? [entry.text.slice(entry.text.indexOf('=') + 1)] : [])];
    for (const text of texts) {
      if (!entry.dynamic && !entry.glob) add(text, true);
      // A substitution or a variable in front of a path (`$(git rev-parse --show-toplevel)/scripts/x.sh`): whatever
      // it stands for, the rest may be a path of this folder.
      else if (text.startsWith(`${UNKNOWN_PART}/`) && !text.slice(2).includes(UNKNOWN_PART) && !entry.glob) add(text.slice(2), true);
      // The written pieces around it; the one right after an expansion is looked up without its leading slash.
      text.split(UNKNOWN_PART).forEach((part, index) => part.split(LOOSE_SPLIT).forEach((piece, at) => add(index > 0 && at === 0 ? piece.replace(/^\/+/, '') : piece, false)));
    }
  };
  for (const line of commands) {
    // An `args` list is given to a shell when the command is one (`sh`, `-c`, `<a command line>`).
    const shellArgs = SHELLS.has(programName(scanShell(line[0] ?? '').commands[0]?.words[0]));
    line.forEach((part, index) => {
      // Each part whole (an argument of an `args` list is one word whatever it holds), as a shell would split it, and
      // with every quote simply dropped: a word too many is looked up and not found, a word too few is a script
      // nobody guards.
      add(part, index > 0);
      const scan = index > 0 && !shellArgs ? { commands: [] } : scanShell(part, home === undefined ? { variables } : { variables, home });
      for (const command of scan.commands) {
        for (const entry of [...command.words, ...command.assignments, ...command.writes, ...command.reads]) word(entry);
        const words = programWords(command);
        const program = programName(words[0]);
        if (program === 'cd' || program === 'pushd') for (const target of words.slice(1)) if (!notKnown(target) && !target.text.startsWith('-')) dirs.add(target.text);
      }
      for (const piece of part.replace(/["']/g, '').split(LOOSE_SPLIT)) add(piece.replace(/^\$\{?CLAUDE_PROJECT_DIR[^}/]*\}?\//, ''), false);
    });
  }
  return { candidates: [...found].map(([text, named]) => ({ text, named })), dirs: [...dirs], overflow };
}

/**
 * PURE: whether a word that names NO existing file is still a path the command names (and so is recorded as "named,
 * not there yet"): written with an anchor (`./x`, `../x`, an absolute path), or a relative path of plain names, or a
 * bare file name with a script's extension. A word such as `s/a/b/`, `application/json` in a quoted header, a
 * regular expression or a URL is not.
 */
export function namesAPath(text: string): 'anchored' | 'plain' | null {
  if (text.endsWith('/')) return null;
  if (text.startsWith('/') || text.startsWith('./') || text.startsWith('../')) return 'anchored';
  const segments = text.split('/');
  if (!segments.every((segment) => PLAIN_NAME.test(segment))) return null;
  return segments.length > 1 || SCRIPT_EXTENSION.test(text) ? 'plain' : null;
}

const HEADER_KEY = /^([A-Za-z][A-Za-z0-9_-]*)\s*:\s*(.*)$/;
const HEADER_PERMISSION_KEYS: ReadonlySet<string> = new Set(['allowed-tools', 'allowedtools', 'tools', 'disallowed-tools', 'disallowedtools', 'permissionmode', 'permission-mode', 'mcpservers', 'mcp-servers']);
const unquoted = (value: string): string => value.trim().replace(/^(["'])(.*)\1$/, '$2');

/**
 * PURE: what the header (the block between the two `---` lines) of a file below `.claude/` declares that runs a
 * command or allows a tool: an agent, a skill or a command can carry hooks of its own and a list of allowed tools.
 * Read line by line, not as YAML: a line smurg cannot place is shown as it is written rather than interpreted.
 */
export function headerEffectsOf(path: string, text: string): FileEffects {
  const lists = new Lists();
  headerEffects(path, text, lists);
  return lists.effects();
}

function headerEffects(path: string, text: string, lists: Lists): void {
  if (!text.startsWith('---')) return;
  const end = text.indexOf('\n---', 3);
  if (end === -1) return;
  let section = '';
  let hookCommands = 0;
  let hooksDeclared = false;
  // Cut at every character that ends a line for some reader (a lone CR, U+2028, U+2029 too): each piece is looked at
  // as a line of its own, so a key cannot stand behind one unseen, and no expression below meets a character `.`
  // does not match (it would try the run of blanks in front of it again from every blank: the square of the run).
  for (const line of text.slice(3, end).split(/\r\n|[\n\r\u2028\u2029]/)) {
    if (line.trim() === '' || line.trim().startsWith('#')) continue;
    const top = /^\S/.test(line) ? HEADER_KEY.exec(line) : null;
    if (top !== null) {
      section = (top[1] as string).toLowerCase();
      const value = (top[2] as string).trim();
      if (section === 'hooks') {
        hooksDeclared = true;
        // Written on one line (`hooks: { … }`): shown as it stands.
        if (value !== '') {
          hookCommands += 1;
          lists.line(lists.runs, `${path}: ${line.trim()}`);
        }
      } else if (HEADER_PERMISSION_KEYS.has(section)) {
        if ((section === 'allowed-tools' || section === 'allowedtools') && TOOL_NAMED.test(value)) lists.allowsTools = true;
        if ((section === 'permissionmode' || section === 'permission-mode') && unquoted(value) !== 'default' && unquoted(value) !== 'plan') lists.allowsTools = true;
        lists.line(lists.permissions, `${path}: ${line.trim()}`);
      }
      continue;
    }
    if (section === 'hooks') {
      const command = /^\s*(?:-\s*)?(command|url)\s*:\s*(.+)$/.exec(line);
      if (command !== null) {
        hookCommands += 1;
        if (command[1] === 'command') lists.run(`hook in ${path}`, [unquoted(command[2] as string)]);
        else lists.line(lists.runs, `hook in ${path}: ${unquoted(command[2] as string)}`);
      }
    } else if (HEADER_PERMISSION_KEYS.has(section)) {
      if ((section === 'allowed-tools' || section === 'allowedtools') && TOOL_NAMED.test(line)) lists.allowsTools = true;
      lists.line(lists.permissions, `${path}: ${section}: ${line.trim()}`);
    }
  }
  if (hooksDeclared && hookCommands === 0) lists.line(lists.runs, `${path}: declares hooks (read the file)`);
}

/** SHA-256 of a file, streamed; null when it cannot be read whole. */
function hashFile(absolute: string): Promise<string | null> {
  return new Promise((resolve) => {
    const hash = createHash('sha256');
    const stream = createReadStream(absolute);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', () => resolve(null));
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

/** `hash`: the file's content, or SCRIPT_ABSENT_HASH for a path that is named and not there. */
type Script = { path: string; hash: string };

// eslint-disable-next-line no-control-regex
const NOT_GUARDABLE = /[\\\u0000-\u001f\u007f]/;

/**
 * Whether smurg guards a script of this name: any name a request can carry (no backslash, no control character).
 * Brackets, wildcards and blanks are fine: PathGuard compares names, and the tool gate reads a quoted name as that
 * name and an unquoted pattern as whatever it can match. A content that runs a file of another name is never trusted.
 */
export function isGuardable(path: string): boolean {
  return path.length > 0 && !path.startsWith('/') && !NOT_GUARDABLE.test(path);
}

// A word that is a pattern for a tool (`src/**` and the like), not the name of one file.
const PATTERN_LIKE = /[*?[\]{}]/;

/** One file below `.claude/` (the loaded entry). `key`: what a decision about it is stored under. */
interface LoadedFile {
  readonly path: string;
  readonly hash: string;
  readonly scripts: Script[];
  readonly key: string;
}

/** One entry of a root as it is right now: one of the three files, or the loaded entry. */
interface FileScan {
  readonly path: string;
  readonly hash: string;
  readonly text: string;
  /** A symlink, a directory, an oversized or unreadable file: Claude Code may still load it, smurg cannot vouch for it. */
  readonly unverifiable: boolean;
  readonly effects: FileEffects;
  readonly scripts: Script[];
  /** The loaded entry only: every file it stands for. */
  readonly loaded?: readonly LoadedFile[];
}

interface RootScan {
  readonly root: RootRef;
  readonly files: FileScan[];
  readonly state: ProjectSettingsState;
  /** Every script path of the root's files (watched), and those of trusted contents (host-only for writes). */
  readonly watched: ReadonlySet<string>;
  readonly protectedPaths: ReadonlySet<string>;
  /** A content nobody decided about (the host has something to confirm). */
  readonly undecided: boolean;
}

export interface TrustReactions {
  /** A look at a root's files found a content that is not trusted while sessions may run there with the old one. */
  filesChanged(root: RootRef): void;
  /** The root's sessions must start again to get what is trusted now (the host decided; the recorded scripts changed). */
  decided(root: RootRef): void;
}

const sameSet = (a: ReadonlySet<string>, b: ReadonlySet<string>): boolean => a.size === b.size && [...a].every((entry) => b.has(entry));

export class ProjectTrustImpl implements ProjectTrust {
  private readonly ctx: DaemonContext;
  private doc: PersistentDocument<TrustDocument> | null = null;
  private readonly scans = new Map<string, RootScan>();
  private readonly refreshing = new Map<string, Promise<RootScan | null>>();
  private reactions: TrustReactions | null = null;
  private since = 0;

  constructor(ctx: DaemonContext) {
    this.ctx = ctx;
  }

  setReactions(reactions: TrustReactions): void {
    this.reactions = reactions;
  }

  async start(): Promise<void> {
    this.doc = await this.ctx.state.document(claudeTrustDocument.name, claudeTrustDocument.schema, claudeTrustDocument.init);
    this.since = this.ctx.clock.now();
    await this.refresh(MAIN_ROOT).catch(() => null);
  }

  /** Bus listeners: the watch of the files and recorded scripts, a merge into the main workspace, roots that come and go. */
  register(): Disposable {
    const stack = new DisposableStack();
    stack.add(
      this.ctx.bus.on('file.changed', ({ root, changes }) => {
        const scan = this.scans.get(rootRefKey(root));
        if (changes.some((change) => this.concerns(scan, change.path) || this.swappedBeside(scan, change))) void this.refresh(root, 'files').catch(() => null);
      }),
    );
    stack.add(
      // A merge writes many files of the main workspace at once (and the watcher may not report every one): what the
      // merged change did to the settings, to `.claude/` or to a recorded script is looked at right away.
      this.ctx.bus.on('merge.changed', ({ request }) => {
        if (request.status === 'merged') void this.refresh(MAIN_ROOT, 'files').catch(() => null);
      }),
    );
    stack.add(
      this.ctx.roots.onChange((change) => {
        if (change.kind === 'removed') this.scans.delete(change.root.key);
        else void this.refresh(change.root.ref).catch(() => null);
      }),
    );
    return stack;
  }

  /**
   * Whether a changed path is something the gate looks at: a settings file, anything of `.claude/`, a recorded
   * script, or a FOLDER that holds one of them (a folder that was renamed, replaced or removed is reported as the
   * folder alone, never as the files below it). Names compare as a case-insensitive file system compares them.
   */
  private concerns(scan: RootScan | undefined, path: string): boolean {
    if (folderHoldsPath(PROJECT_LOADED_ENTRY, path)) {
      // Not what lies below Claude Code's own worktree checkouts (`.claude/worktrees/<name>/…`): the gate does not
      // look there (NOT_LOADED), and a host who works in one would make it look at every file they save.
      const segments = relPathSegments(foldRelPath(path));
      return !(segments[1] === 'worktrees' && segments.length > 2);
    }
    for (const file of PROJECT_SETTINGS_FILES) if (folderHoldsPath(path, file)) return true;
    for (const script of scan?.watched ?? []) if (folderHoldsPath(path, script)) return true;
    return false;
  }

  /**
   * A folder that appeared or went away IN a folder on the way to something the gate looks at. A folder renamed away
   * with a new one put in its place in the same moment is sometimes reported only as the old one under its new name
   * (Linux: the two events of the replaced name cancel each other; seen once on a continuous-integration runner,
   * where the swap of `scripts/hooks` arrived as `scripts/hooks.away` alone). The name that is reported is then a
   * neighbour of the folder that was replaced, never a folder above the script: so a neighbour makes the gate look too.
   */
  private swappedBeside(scan: RootScan | undefined, change: FileChange): boolean {
    if (change.change !== 'addDir' && change.change !== 'unlinkDir') return false;
    const parent = parentRelPath(change.path);
    return parent !== null && this.concerns(scan, parent);
  }

  private decisions(): readonly Decision[] {
    return this.doc?.get().decisions ?? [];
  }

  private decisionFor(path: string, hash: string): Decision | null {
    return this.decisions().find((decision) => decision.path === path && decision.hash === hash) ?? null;
  }

  /** The loaded entry: `trust` when every file it stands for is trusted, `ignore` when every one is decided, else null. */
  private loadedDecision(files: readonly LoadedFile[]): 'trust' | 'ignore' | null {
    const stored = this.doc?.get().loaded;
    if (stored === undefined) return null;
    const trusted = new Set(stored.trusted);
    if (files.every((file) => trusted.has(file.key))) return 'trust';
    const ignored = new Set(stored.ignored);
    return files.every((file) => trusted.has(file.key) || ignored.has(file.key)) ? 'ignore' : null;
  }

  /**
   * What the host decided about an entry AS IT IS NOW: null when nobody did. The scripts are part of a trusted content
   * (every recorded one must still be what it was), so a file whose text is the confirmed one but whose script changed
   * is not decided any more. (The loaded entry: a file's scripts are part of its key.)
   */
  private decisionOf(file: FileScan): 'trust' | 'ignore' | null {
    if (file.unverifiable) return null;
    if (file.loaded !== undefined) return this.loadedDecision(file.loaded);
    const stored = this.decisionFor(file.path, file.hash);
    if (stored === null) return null;
    if (stored.decision !== 'trust') return stored.decision;
    const now = new Map(file.scripts.map((script) => [script.path, script.hash]));
    const intact = stored.scripts.every((script) => now.get(script.path) === script.hash) && stored.scripts.length === file.scripts.length;
    return intact ? 'trust' : null;
  }

  /**
   * Reads the root's files again and recomputes its state; `why: 'files'` is the watcher, `'check'` every other look
   * (a session start, the host opening the review). Emits `trust.changed` when the state changed; a content that is
   * no longer trusted parks the root's sessions whoever noticed it. Null: no such root.
   */
  refresh(root: RootRef, why: 'files' | 'check' = 'check'): Promise<RootScan | null> {
    const key = rootRefKey(root);
    const running = this.refreshing.get(key);
    if (running !== undefined) return running.then(() => this.refresh(root, why));
    const task = this.scan(root)
      .then((scan) => {
        if (scan === null) {
          this.scans.delete(key);
          return null;
        }
        this.apply(scan, why);
        return scan;
      })
      .finally(() => {
        if (this.refreshing.get(key) === task) this.refreshing.delete(key);
      });
    this.refreshing.set(key, task);
    return task;
  }

  private apply(scan: RootScan, why: 'files' | 'check' | 'decided'): void {
    const key = rootRefKey(scan.root);
    const before = this.scans.get(key);
    this.scans.set(key, scan);
    if (before !== undefined && before.state === scan.state && before.undecided === scan.undecided) {
      // Still in use, but other scripts are recorded now (another confirmed content is back): a process that loaded
      // the earlier content would go on running scripts nobody guards any more. The sessions start again.
      if (scan.state === 'used' && !sameSet(before.protectedPaths, scan.protectedPaths)) this.reactions?.decided(scan.root);
      return;
    }
    if (before === undefined && scan.state === 'none') return;
    this.ctx.bus.emit('trust.changed', { root: scan.root, state: scan.state });
    this.ctx.bus.emit('attention.changed', { source: 'trust' });
    if (before === undefined || before.state === scan.state) return;
    if (why === 'decided') this.reactions?.decided(scan.root);
    // Not only when the watcher saw it: a watcher misses changes (a folder made in one burst on Linux), and a
    // session start or the host's look at the review finds the same thing later.
    else if (scan.state === 'ignored') this.reactions?.filesChanged(scan.root);
  }

  private async scan(root: RootRef): Promise<RootScan | null> {
    const info = this.ctx.roots.get(root);
    if (info === null) return null;
    const files: FileScan[] = [];
    for (const path of PROJECT_SETTINGS_FILES) {
      const file = await this.scanFile(info.realPath, path);
      if (file !== null) files.push(file);
    }
    const loaded = await this.scanLoaded(info.realPath);
    if (loaded !== null) files.push(loaded);
    return this.judge(root, files);
  }

  private judge(root: RootRef, files: FileScan[]): RootScan {
    const watched = new Set<string>();
    const protectedPaths = new Set<string>();
    let trusted = 0;
    let undecided = false;
    for (const file of files) {
      for (const script of file.scripts) watched.add(script.path);
      const decision = this.decisionOf(file);
      if (decision === null) undecided = true;
      if (decision !== 'trust') continue;
      trusted += 1;
      for (const script of file.scripts) protectedPaths.add(script.path);
    }
    const state: ProjectSettingsState = files.length === 0 ? 'none' : trusted === files.length ? 'used' : 'ignored';
    return { root, files, state, watched, protectedPaths, undecided };
  }

  /** An entry Claude Code may load but smurg cannot vouch for: never trusted; the review says why (and shows what it could read). */
  private unverifiable(path: string, what: string, shown: { text: string; effects: FileEffects } | null = null): FileScan {
    const effects: FileEffects = shown?.effects ?? { runs: [], permissions: [], env: [], otherKeys: [], commands: [], needsAck: [] };
    return { path, hash: sha256(`unverifiable:${what}`), text: shown?.text ?? '', unverifiable: true, effects: { ...effects, otherKeys: [`(${what})`, ...effects.otherKeys].slice(0, CLAUDE_CONFIG_LIST_MAX) }, scripts: [] };
  }

  private async scanFile(rootReal: string, path: string): Promise<FileScan | null> {
    const absolute = join(rootReal, path);
    let info;
    try {
      info = await lstat(absolute);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT' || code === 'ENOTDIR') {
        // `.claude` itself may be a link to somewhere that has the file: then realpath finds it.
        const real = await realpath(absolute).catch(() => null);
        if (real === null) return null;
      } else return null;
    }
    const real = await realpath(absolute).catch(() => null);
    if (info === undefined || !info.isFile() || real !== absolute) return this.unverifiable(path, 'not a regular file inside the folder: a link or a folder');
    if (info.size > SETTINGS_FILE_MAX_BYTES) return this.unverifiable(path, 'too large to show');
    let bytes: Buffer;
    try {
      bytes = await readFile(absolute);
    } catch {
      return this.unverifiable(path, 'unreadable');
    }
    const text = bytes.toString('utf8');
    if (text.includes('\u0000')) return this.unverifiable(path, 'not text');
    const effects = effectsOf(path, text);
    const found = await this.scriptsOf(rootReal, effects.commands);
    if (found.problem !== null) return this.unverifiable(path, found.problem, { text, effects });
    return { path, hash: sha256(bytes), text, unverifiable: false, effects, scripts: found.scripts };
  }

  /**
   * Everything else Claude Code loads from the root's `.claude/`: every file below it except the two settings files
   * (and Claude Code's own `worktrees/`). Null when there is none. Each file is hashed; the headers of the text files
   * are read for hooks and allowed tools; a link, a special file or more than smurg looks through is never trusted.
   */
  private async scanLoaded(rootReal: string): Promise<FileScan | null> {
    const path = PROJECT_LOADED_ENTRY;
    const top = join(rootReal, path);
    let info;
    try {
      info = await lstat(top);
    } catch {
      return null;
    }
    // A link in place of the folder: the settings files below it are refused one by one (scanFile).
    if (!info.isDirectory() || (await realpath(top).catch(() => null)) !== top) return info.isSymbolicLink() ? this.unverifiable(path, 'not a folder inside the folder: a link') : null;
    const lists = new Lists();
    const found: { path: string; hash: string; size: number; commands: string[][] }[] = [];
    let problem: string | null = null;
    let bytes = 0;
    const pending: string[] = [''];
    while (pending.length > 0 && problem === null) {
      const below = pending.shift() as string;
      let entries;
      try {
        entries = await readdir(join(top, below), { withFileTypes: true });
      } catch {
        problem = 'a folder in it cannot be read';
        break;
      }
      entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
      for (const entry of entries) {
        if (below === '' && NOT_LOADED.has(entry.name)) continue;
        const inside = below === '' ? entry.name : `${below}/${entry.name}`;
        if (entry.isDirectory()) {
          pending.push(inside);
          continue;
        }
        const rel = checkRelPath(`${path}/${inside}`);
        if (!entry.isFile() || !rel.ok) {
          problem = entry.isFile() ? 'a file in it has a name smurg cannot show' : 'it holds a link or a special file';
          break;
        }
        const absolute = join(top, inside);
        const size = (await stat(absolute).catch(() => null))?.size ?? 0;
        bytes += size;
        if (found.length >= LOADED_FILES_MAX || bytes > LOADED_BYTES_MAX) {
          problem = 'it holds more than smurg can look through';
          break;
        }
        let hash: string | null;
        const commands: string[][] = [];
        if (size <= HEADER_FILE_MAX_BYTES) {
          const content = await readFile(absolute).catch(() => null);
          hash = content === null ? null : sha256(content);
          if (content !== null && !content.includes(0)) {
            const before = lists.commands.length;
            headerEffects(rel.path, content.toString('utf8'), lists);
            commands.push(...lists.commands.slice(before));
          }
        } else hash = await hashFile(absolute);
        if (hash === null) {
          problem = 'a file in it cannot be read';
          break;
        }
        found.push({ path: rel.path, hash, size, commands });
      }
    }
    if (problem === null && found.length === 0) return null;
    found.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    const text = found.map((file) => `${file.hash}  ${file.path}`).join('\n');
    const loaded: LoadedFile[] = [];
    const scripts = new Map<string, string>();
    for (const file of found) {
      if (problem !== null) break;
      const own = await this.scriptsOf(rootReal, file.commands);
      if (own.problem !== null) problem = own.problem;
      for (const script of own.scripts) scripts.set(script.path, script.hash);
      loaded.push({ path: file.path, hash: file.hash, scripts: own.scripts, key: sha256(JSON.stringify([file.path, file.hash, own.scripts.map((script) => [script.path, script.hash])])) });
    }
    if (problem === null && scripts.size > CLAUDE_CONFIG_SCRIPTS_MAX) problem = `its files run more scripts of this folder than smurg keeps track of (${CLAUDE_CONFIG_SCRIPTS_MAX})`;
    if (problem === null && Buffer.byteLength(text, 'utf8') > CLAUDE_CONFIG_TEXT_MAX_BYTES) problem = 'it holds more than smurg can show';
    // Named, one by one (the list's own limit counts what it leaves out); `text` has every file with its hash.
    for (const file of found) lists.key(file.path);
    const effects = lists.effects();
    if (problem !== null) return this.unverifiable(path, problem, { text: truncateToUtf8Bytes(text, CLAUDE_CONFIG_TEXT_MAX_BYTES), effects });
    return {
      path,
      hash: sha256(loaded.map((file) => file.key).join('\n')),
      text,
      unverifiable: false,
      effects,
      scripts: [...scripts].map(([script, hash]) => ({ path: script, hash })).sort((a, b) => (a.path < b.path ? -1 : 1)),
      loaded,
    };
  }

  /**
   * The scripts the content runs: each word of each command that names an existing file inside the root, with the
   * file's hash, and each path a command names where nothing is yet (SCRIPT_ABSENT_HASH in place of a hash). A word
   * is looked up as scriptCandidates reads it, from the root and from every folder a command changes to. The path
   * recorded is the one the FILE SYSTEM gives the file (its stored case and normalisation; through a link, the
   * link's path and the file it leads to), so the watch, PathGuard and the tool gate all name the file that runs.
   * `problem`: something that cannot be recorded or looked up (then the content that names it is never trusted,
   * instead of being trusted with a script nobody guards).
   */
  private async scriptsOf(rootReal: string, commands: readonly string[][]): Promise<{ scripts: Script[]; problem: string | null }> {
    const out = new Map<string, string>();
    const fail = (problem: string): { scripts: Script[]; problem: string } => ({ scripts: [], problem });
    const home = this.ctx.config.sessions.hostHome ?? undefined;
    const read = scriptCandidates(commands, { CLAUDE_PROJECT_DIR: rootReal, PWD: '.', ...(home === undefined ? {} : { HOME: home }) }, home);
    if (read.overflow) return fail(`its commands have more words than smurg looks up (${SCRIPT_CANDIDATES_MAX})`);
    const inRoot = (absolute: string): string | null => {
      const rel = relative(rootReal, absolute);
      return rel.length === 0 || rel.startsWith('..') || isAbsolute(rel) ? null : rel.split(sep).join('/');
    };
    // Where a relative word may lead: the folder itself, and each folder inside it that a command changes to.
    const bases = [rootReal];
    for (const dir of read.dirs) {
      const absolute = normalize(isAbsolute(dir) ? dir : join(rootReal, dir));
      if (inRoot(absolute) !== null && !bases.includes(absolute) && bases.length < 16) bases.push(absolute);
    }
    const record = (path: string, hash: string): string | null => {
      const checked = checkRelPath(path);
      // A name no request, rule or list can carry: nobody could guard the file.
      if (!checked.ok || !isGuardable(checked.path)) return 'it runs a file of this folder whose name smurg cannot guard (a backslash or a control character)';
      out.set(checked.path, hash);
      return out.size > CLAUDE_CONFIG_SCRIPTS_MAX ? `it runs more scripts of this folder than smurg keeps track of (${CLAUDE_CONFIG_SCRIPTS_MAX})` : null;
    };
    for (const candidate of read.candidates) {
      for (const base of isAbsolute(candidate.text) ? [rootReal] : bases) {
        const absolute = normalize(isAbsolute(candidate.text) ? candidate.text : join(base, candidate.text));
        const named = inRoot(absolute);
        if (named === null) continue;
        let real: string;
        let size: number;
        try {
          real = await realpath(absolute);
          const info = await stat(real);
          if (!info.isFile()) continue;
          size = info.size;
        } catch (err) {
          const code = (err as NodeJS.ErrnoException).code;
          // A name too long to be a file is no file, now or later.
          if (code === 'ENAMETOOLONG') continue;
          if (code !== 'ENOENT' && code !== 'ENOTDIR') return fail('it names a path of this folder that smurg cannot look at');
          // Nothing there. A word that is written as a path is still what the command runs once a file appears.
          const kind = candidate.named ? namesAPath(candidate.text) : null;
          // (A pattern handed to a tool, such as `"$CLAUDE_PROJECT_DIR/src/*.ts"`, names no one file.)
          if (kind === null || PATTERN_LIKE.test(candidate.text)) continue;
          const checked = checkRelPath(named);
          if (!checked.ok || !isGuardable(checked.path)) {
            if (kind === 'anchored') return fail('it names a file of this folder that is not there, by a name smurg cannot guard (a backslash or a control character)');
            continue;
          }
          if (PROJECT_SETTINGS_FILES.includes(checked.path)) continue;
          const problem = record(checked.path, SCRIPT_ABSENT_HASH);
          if (problem !== null) return fail(problem);
          continue;
        }
        // As the file system spells it; a path that reaches the file through a link is recorded as well.
        const stored = inRoot(real);
        const paths = stored === null ? [named] : foldRelPath(stored) === foldRelPath(named) ? [stored] : [stored, named];
        if (paths.every((path) => PROJECT_SETTINGS_FILES.includes(path))) continue;
        if (size > SCRIPT_MAX_BYTES) return fail('it runs a file of this folder that is too large to check');
        const hash = await hashFile(real);
        if (hash === null) return fail('it runs a file of this folder that cannot be read');
        for (const path of paths) {
          const problem = record(path, hash);
          if (problem !== null) return fail(problem);
        }
      }
    }
    return { scripts: [...out].map(([path, hash]) => ({ path, hash })).sort((a, b) => (a.path < b.path ? -1 : 1)), problem: null };
  }

  // ---- ProjectTrust -------------------------------------------------------------------------------------------------

  state(root: RootRef): ProjectSettingsState {
    return this.scans.get(rootRefKey(root))?.state ?? 'none';
  }

  hashes(root: RootRef): { readonly path: string; readonly hash: string }[] {
    return (this.scans.get(rootRefKey(root))?.files ?? []).map((file) => ({ path: file.path, hash: file.hash }));
  }

  protectedPaths(root: RootRef): ReadonlySet<string> {
    return this.scans.get(rootRefKey(root))?.protectedPaths ?? new Set();
  }

  async describe(input: Req<'admin.claudeConfig.get'>): Promise<Res<'admin.claudeConfig.get'>> {
    const roots = this.ctx.roots.list().sort((a, b) => (a.key === 'main' ? -1 : b.key === 'main' ? 1 : a.key < b.key ? -1 : 1));
    const described: Res<'admin.claudeConfig.get'>['roots'] = [];
    const loadedKnown = (this.doc?.get().loaded.trusted.length ?? 0) + (this.doc?.get().loaded.ignored.length ?? 0) > 0;
    for (const info of roots) {
      const scan = await this.refresh(info.ref).catch(() => null);
      if (scan === null || (scan.files.length === 0 && info.key !== 'main')) continue;
      described.push({
        root: scan.root,
        state: scan.state,
        files: scan.files.map((file) => {
          const decision = this.decisionOf(file);
          const known = file.loaded !== undefined || file.path === PROJECT_LOADED_ENTRY ? loadedKnown : this.decisions().some((entry) => entry.path === file.path);
          return {
            path: file.path,
            hash: file.hash,
            decision,
            // Another content of this file was decided before: this one differs from it.
            changed: decision === null && known,
            text: truncateToUtf8Bytes(file.text, CLAUDE_CONFIG_TEXT_MAX_BYTES),
            runs: file.effects.runs,
            permissions: file.effects.permissions,
            env: file.effects.env,
            otherKeys: file.effects.otherKeys,
            scripts: file.scripts.map((script) => (script.hash === SCRIPT_ABSENT_HASH ? { ...script, absent: true as const } : script)),
            needsAck: file.effects.needsAck,
            ...(file.effects.cut === undefined ? {} : { cut: file.effects.cut }),
            ...(file.effects.unfollowed === undefined ? {} : { unfollowed: file.effects.unfollowed }),
          };
        }),
      });
    }
    const page = takeListPage(described, input.after, (entry) => rootRefKey(entry.root));
    return { roots: page.items, hasMore: page.hasMore };
  }

  async decide(input: Req<'admin.claudeConfig.decide'>, by: Principal): Promise<void> {
    if (this.doc === null) throw new SmurgError('internal', msg('session.notStarted'), { reason: 'not-started' });
    const scan = await this.refresh(input.root);
    if (scan === null) throw new SmurgError('not_found', undefined, { reason: 'unknown-root' });
    const chosen: FileScan[] = [];
    for (const wanted of input.files) {
      const file = scan.files.find((entry) => entry.path === wanted.path);
      if (file === undefined || file.hash !== wanted.hash) throw new SmurgError('conflict', msg('claudeConfig.changed'), { reason: 'changed' });
      if (file.unverifiable && input.decision === 'trust') throw new SmurgError('conflict', msg('claudeConfig.cannotConfirm'), { reason: 'unverifiable' });
      chosen.push(file);
    }
    if (input.decision === 'trust') {
      const needed = new Set(chosen.flatMap((file) => file.effects.needsAck));
      for (const ack of needed) {
        if (!input.acknowledged.includes(ack)) throw new SmurgError('bad_request', msg('claudeConfig.ackNeeded'), { reason: 'ack-needed', needs: [...needed] });
      }
    }
    const at = this.ctx.clock.now();
    this.doc.update((draft) => {
      for (const file of chosen) {
        if (file.loaded !== undefined) {
          const keys = new Set(file.loaded.map((entry) => entry.key));
          const [into, outOf] = input.decision === 'trust' ? (['trusted', 'ignored'] as const) : (['ignored', 'trusted'] as const);
          draft.loaded[outOf] = draft.loaded[outOf].filter((key) => !keys.has(key));
          // Bounded: the oldest decisions go first.
          draft.loaded[into] = [...draft.loaded[into].filter((key) => !keys.has(key)), ...keys].slice(-LOADED_KEYS_MAX);
          continue;
        }
        draft.decisions = draft.decisions.filter((entry) => !(entry.path === file.path && entry.hash === file.hash));
        draft.decisions.push({ path: file.path, hash: file.hash, decision: input.decision, scripts: file.scripts.slice(0, CLAUDE_CONFIG_SCRIPTS_MAX), at });
      }
      // Bounded: the oldest decisions about contents nobody has any more go first.
      if (draft.decisions.length > 1_500) draft.decisions = draft.decisions.sort((a, b) => a.at - b.at).slice(-1_500);
    });
    this.ctx.audit.record({
      actor: by.actor,
      action: 'claude-config.decide',
      outcome: 'ok',
      target: rootRefKey(input.root),
      detail: { root: rootRefKey(input.root), decision: input.decision, files: chosen.map((file) => ({ path: file.path, hash: file.hash })), acknowledged: [...input.acknowledged] },
    });
    // The decision is about a content: every root that has it changes with it.
    for (const [key, known] of [...this.scans]) {
      const next = this.judge(known.root, known.files);
      if (key === rootRefKey(input.root) || next.state !== known.state || next.undecided !== known.undecided) this.apply(next, 'decided');
    }
    this.ctx.bus.emit('attention.changed', { source: 'trust' });
  }

  attention(): AttentionFact[] {
    const host = this.ctx.members.hostUserId();
    const out: AttentionFact[] = [];
    for (const scan of this.scans.values()) {
      if (!scan.undecided) continue;
      out.push({ subject: 'project-settings', id: rootRefKey(scan.root).replace(/[^A-Za-z0-9_-]/g, '-'), at: this.since, recipients: [host], target: { kind: 'console', section: 'claude-config' }, excerpt: '' });
    }
    return out;
  }
}
