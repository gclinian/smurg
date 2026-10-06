// The trust gate for a root's project-level Claude Code settings (ARCHITECTURE §7.6 "Trust gate"; DESIGN §2.9, AD-13).
// Structured mode never shows Claude Code's trust dialog: a project's `.claude/settings.json` hooks and `.mcp.json`
// servers would run as the host as soon as a session starts in the folder. So a session loads them only when the host
// has confirmed exactly that content, after seeing everything it does.
//
//  - WHAT IS TRUSTED: a file content, per file (`.claude/settings.json`, `.claude/settings.local.json`, `.mcp.json`),
//    each with its own SHA-256, plus the scripts its commands point at (each recorded with its own hash). A decision
//    is keyed by path + content hash, not by root: a work item's worktree is a clone, its committed files hash like
//    the main workspace's and need no confirmation of their own.
//  - A ROOT is `used` when every one of the three files that exists in it has a trusted content (and every recorded
//    script still has its recorded content); `none` when none exists; otherwise `ignored` (the session then starts with
//    `--setting-sources user`).
//  - WHILE SESSIONS RUN the files and the recorded scripts are watched (bus `file.changed`): a change to a content
//    that is not trusted parks the sessions of that root.
//  - While a content is trusted its scripts are host-only for writes through smurg (`protectedPaths`).
import { createHash } from 'node:crypto';
import { lstat, readFile, realpath } from 'node:fs/promises';
import { isAbsolute, join, normalize, relative, sep } from 'node:path';
import { z } from 'zod';
import {
  CLAUDE_CONFIG_ENTRY_MAX_CHARS,
  CLAUDE_CONFIG_LIST_MAX,
  CLAUDE_CONFIG_SCRIPTS_MAX,
  CLAUDE_CONFIG_TEXT_MAX_BYTES,
  MAIN_ROOT,
  PROJECT_SETTINGS_FILES,
  SHORT_TEXT_MAX_CHARS,
  SmurgError,
  isValidRelPath,
  rootRefKey,
  takeListPage,
  truncateToUtf8Bytes,
  type ProjectSettingsState,
  type RootRef,
} from '@smurg/protocol';
import { msg } from '@smurg/protocol/i18n';
import type { DaemonContext } from '../../core/context.ts';
import type { AttentionFact, PersistentDocument, Principal, ProjectTrust, Req, Res } from '../../core/interfaces.ts';
import { DisposableStack, type Disposable } from '../../core/lifecycle.ts';

type ClaudeConfigFile = Res<'admin.claudeConfig.get'>['roots'][number]['files'][number];
type Ack = ClaudeConfigFile['needsAck'][number];

const sha256 = (data: string | Uint8Array): string => createHash('sha256').update(data).digest('hex');
const HEX = /^[0-9a-f]{64}$/;

const decisionSchema = z.strictObject({
  path: z.string().min(1).max(256),
  hash: z.string().regex(HEX),
  decision: z.enum(['trust', 'ignore']),
  /** The scripts the content's commands pointed at when it was decided: part of the trusted content. */
  scripts: z.array(z.strictObject({ path: z.string().min(1).max(4096), hash: z.string().regex(HEX) })).max(CLAUDE_CONFIG_SCRIPTS_MAX),
  at: z.int().min(0),
});
const documentSchema = z.strictObject({ decisions: z.array(decisionSchema).max(2_000) });
type TrustDocument = z.infer<typeof documentSchema>;
type Decision = z.infer<typeof decisionSchema>;

/** A project settings file larger than this is never trusted (it cannot be shown whole). */
const SETTINGS_FILE_MAX_BYTES = CLAUDE_CONFIG_TEXT_MAX_BYTES;
const SCRIPT_MAX_BYTES = 8 * 1024 * 1024;

type Json = Record<string, unknown>;
const isObject = (value: unknown): value is Json => typeof value === 'object' && value !== null && !Array.isArray(value);

// eslint-disable-next-line no-control-regex
const NOT_TEXT = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f‪-‮⁦-⁩]/g;
const entry = (text: string): string => text.replace(NOT_TEXT, ' ').slice(0, CLAUDE_CONFIG_ENTRY_MAX_CHARS);
const short = (text: string): string => text.replace(NOT_TEXT, ' ').replace(/[\t\n]/g, ' ').slice(0, SHORT_TEXT_MAX_CHARS) || '?';

/** Variables that can send the host's login to another server. */
export function isFlaggedEnvName(name: string): boolean {
  const upper = name.toUpperCase();
  return upper.startsWith('ANTHROPIC_') || upper.startsWith('CLAUDE_') || /^(HTTPS?|ALL|NO)_PROXY$/.test(upper) || upper === 'NODE_EXTRA_CA_CERTS' || upper === 'SSL_CERT_FILE' || upper.startsWith('AWS_') || upper.startsWith('GOOGLE_') || upper.startsWith('VERTEX_');
}

const TOOL_RULE = /^(Bash|Edit|Write|MultiEdit|NotebookEdit|mcp__)/;

export interface FileEffects {
  readonly runs: string[];
  readonly permissions: string[];
  readonly env: { name: string; flagged: boolean }[];
  readonly otherKeys: string[];
  /** Every command with its arguments, for the script lookup. */
  readonly commands: string[][];
  readonly needsAck: Ack[];
}

function commandLine(command: unknown, args: unknown): string[] | null {
  if (typeof command !== 'string' || command.length === 0) return null;
  const rest = Array.isArray(args) ? args.filter((arg): arg is string => typeof arg === 'string') : [];
  return [command, ...rest];
}

/** PURE: everything a project settings file (or `.mcp.json`) does, read from its text (DESIGN §2.9 table). */
export function effectsOf(path: string, text: string): FileEffects {
  const runs: string[] = [];
  const permissions: string[] = [];
  const env: { name: string; flagged: boolean }[] = [];
  const otherKeys: string[] = [];
  const commands: string[][] = [];
  let credentials = false;
  let allowsTools = false;
  const run = (label: string, line: string[] | null): void => {
    if (line === null) return;
    commands.push(line);
    if (runs.length < CLAUDE_CONFIG_LIST_MAX) runs.push(entry(`${label}: ${line.join(' ')}`));
  };
  const servers = (value: unknown): void => {
    if (!isObject(value)) return;
    for (const [name, server] of Object.entries(value)) {
      if (!isObject(server)) continue;
      const line = commandLine(server['command'], server['args']);
      if (line !== null) run(`MCP server ${name}`, line);
      else if (typeof server['url'] === 'string' && runs.length < CLAUDE_CONFIG_LIST_MAX) runs.push(entry(`MCP server ${name}: ${server['url']}`));
      if (isObject(server['env'])) for (const key of Object.keys(server['env'])) if (isFlaggedEnvName(key)) credentials = true;
    }
  };
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { runs, permissions, env, otherKeys: ['(not valid JSON: Claude Code may read it differently)'], commands, needsAck: ['credentials', 'allows-tools'] };
  }
  if (!isObject(parsed)) return { runs, permissions, env, otherKeys: ['(not a JSON object)'], commands, needsAck: [] };
  for (const [key, value] of Object.entries(parsed)) {
    if (key === 'mcpServers') servers(value);
    else if (path === '.mcp.json') otherKeys.push(short(key));
    else if (key === 'hooks' && isObject(value)) {
      for (const [event, groups] of Object.entries(value)) {
        for (const group of Array.isArray(groups) ? groups : []) {
          for (const hook of isObject(group) && Array.isArray(group['hooks']) ? group['hooks'] : []) {
            if (!isObject(hook)) continue;
            const line = commandLine(hook['command'], hook['args']);
            if (line !== null) run(`hook ${event}`, line);
            else if (typeof hook['url'] === 'string' && runs.length < CLAUDE_CONFIG_LIST_MAX) runs.push(entry(`hook ${event}: ${hook['url']}`));
            else if (runs.length < CLAUDE_CONFIG_LIST_MAX) runs.push(entry(`hook ${event}: ${JSON.stringify(hook)}`));
          }
        }
      }
    } else if (key === 'apiKeyHelper') {
      credentials = true;
      run('apiKeyHelper', typeof value === 'string' ? [value] : null);
    } else if (key === 'statusLine' || key === 'fileSuggestion' || key === 'awsAuthRefresh' || key === 'awsCredentialExport' || key === 'otelHeadersHelper') {
      if (key !== 'statusLine' && key !== 'fileSuggestion') credentials = true;
      run(key, typeof value === 'string' ? [value] : isObject(value) ? commandLine(value['command'], value['args']) : null);
    } else if (key === 'enabledPlugins' || key === 'extraKnownMarketplaces' || key === 'pluginConfigs') {
      if (runs.length < CLAUDE_CONFIG_LIST_MAX) runs.push(entry(`${key}: ${JSON.stringify(value)}`));
    } else if (key === 'permissions' && isObject(value)) {
      for (const [kind, list] of Object.entries(value)) {
        if (Array.isArray(list)) {
          for (const rule of list) {
            if (typeof rule !== 'string') continue;
            if (kind === 'allow' && TOOL_RULE.test(rule)) allowsTools = true;
            if (permissions.length < CLAUDE_CONFIG_LIST_MAX) permissions.push(entry(`${kind}: ${rule}`));
          }
        } else if (permissions.length < CLAUDE_CONFIG_LIST_MAX) {
          if (kind === 'defaultMode' && value[kind] !== 'default' && value[kind] !== 'plan') allowsTools = true;
          permissions.push(entry(`${kind}: ${typeof list === 'string' ? list : JSON.stringify(list)}`));
        }
      }
    } else if (key === 'env' && isObject(value)) {
      for (const name of Object.keys(value)) {
        const flagged = isFlaggedEnvName(name);
        if (flagged) credentials = true;
        if (env.length < CLAUDE_CONFIG_LIST_MAX) env.push({ name: short(name), flagged });
      }
    } else if (otherKeys.length < CLAUDE_CONFIG_LIST_MAX) otherKeys.push(short(key));
  }
  return { runs, permissions, env, otherKeys, commands, needsAck: [...(credentials ? (['credentials'] as const) : []), ...(allowsTools ? (['allows-tools'] as const) : [])] };
}

/** One of the three files as it is in a root right now. */
interface FileScan {
  readonly path: string;
  readonly hash: string;
  readonly text: string;
  /** A symlink, a directory, an oversized or unreadable file: Claude Code may still load it, smurg cannot vouch for it. */
  readonly unverifiable: boolean;
  readonly effects: FileEffects;
  readonly scripts: { path: string; hash: string }[];
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
  /** A root's files changed to a content that is not trusted while sessions may run there. */
  filesChanged(root: RootRef): void;
  /** The host's decision changed a root's state. */
  decided(root: RootRef): void;
}

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
    this.doc = await this.ctx.state.document('claude-trust', documentSchema, () => ({ decisions: [] }));
    this.since = this.ctx.clock.now();
    await this.refresh(MAIN_ROOT).catch(() => null);
  }

  /** Bus listeners: the watch of the files and recorded scripts, roots that come and go. */
  register(): Disposable {
    const stack = new DisposableStack();
    stack.add(
      this.ctx.bus.on('file.changed', ({ root, changes }) => {
        const scan = this.scans.get(rootRefKey(root));
        const touches = changes.some((change) => PROJECT_SETTINGS_FILES.includes(change.path) || change.path === '.claude' || scan?.watched.has(change.path) === true);
        if (touches) void this.refresh(root, 'files').catch(() => null);
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

  private decisions(): readonly Decision[] {
    return this.doc?.get().decisions ?? [];
  }

  private decisionFor(path: string, hash: string): Decision | null {
    return this.decisions().find((decision) => decision.path === path && decision.hash === hash) ?? null;
  }

  /**
   * Reads the root's three files again and recomputes its state; `why: 'files'` is the watcher (a change to an
   * untrusted content parks the root's sessions). Emits `trust.changed` when the state changed. Null: no such root.
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
    if (before !== undefined && before.state === scan.state && before.undecided === scan.undecided) return;
    if (before === undefined && scan.state === 'none') return;
    this.ctx.bus.emit('trust.changed', { root: scan.root, state: scan.state });
    this.ctx.bus.emit('attention.changed', { source: 'trust' });
    if (before === undefined || before.state === scan.state) return;
    if (why === 'decided') this.reactions?.decided(scan.root);
    else if (why === 'files' && scan.state === 'ignored') this.reactions?.filesChanged(scan.root);
  }

  private async scan(root: RootRef): Promise<RootScan | null> {
    const info = this.ctx.roots.get(root);
    if (info === null) return null;
    const files: FileScan[] = [];
    for (const path of PROJECT_SETTINGS_FILES) {
      const file = await this.scanFile(info.realPath, path);
      if (file !== null) files.push(file);
    }
    return this.judge(root, files);
  }

  private judge(root: RootRef, files: FileScan[]): RootScan {
    const watched = new Set<string>();
    const protectedPaths = new Set<string>();
    let trusted = 0;
    let undecided = false;
    for (const file of files) {
      for (const script of file.scripts) watched.add(script.path);
      const decision = file.unverifiable ? null : this.decisionFor(file.path, file.hash);
      if (decision === null) undecided = true;
      if (decision?.decision !== 'trust') continue;
      // The scripts are part of the trusted content: every recorded one must still be what it was.
      const now = new Map(file.scripts.map((script) => [script.path, script.hash]));
      const intact = decision.scripts.every((script) => now.get(script.path) === script.hash) && decision.scripts.length === file.scripts.length;
      if (!intact) {
        undecided = true;
        continue;
      }
      trusted += 1;
      for (const script of decision.scripts) protectedPaths.add(script.path);
    }
    const state: ProjectSettingsState = files.length === 0 ? 'none' : trusted === files.length ? 'used' : 'ignored';
    return { root, files, state, watched, protectedPaths, undecided };
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
    const unverifiable = (what: string): FileScan => ({ path, hash: sha256(`unverifiable:${what}`), text: '', unverifiable: true, effects: { runs: [], permissions: [], env: [], otherKeys: [`(${what})`], commands: [], needsAck: [] }, scripts: [] });
    const real = await realpath(absolute).catch(() => null);
    if (info === undefined || !info.isFile() || real !== absolute) return unverifiable('not a regular file inside the folder: a link or a folder');
    if (info.size > SETTINGS_FILE_MAX_BYTES) return unverifiable('too large to show');
    let bytes: Buffer;
    try {
      bytes = await readFile(absolute);
    } catch {
      return unverifiable('unreadable');
    }
    const text = bytes.toString('utf8');
    if (text.includes('\u0000')) return unverifiable('not text');
    const effects = effectsOf(path, text);
    return { path, hash: sha256(bytes), text, unverifiable: false, effects, scripts: await this.scriptsOf(rootReal, effects.commands) };
  }

  /** Each argument of each command that resolves to an existing regular file inside the root, with its hash. */
  private async scriptsOf(rootReal: string, commands: readonly string[][]): Promise<{ path: string; hash: string }[]> {
    const out = new Map<string, string>();
    const candidates = new Set<string>();
    for (const line of commands) {
      for (const word of line.flatMap((part) => part.split(/\s+/))) {
        const cleaned = word.replace(/^["']|["']$/g, '').replace(/^\$CLAUDE_PROJECT_DIR\//, '').replace(/^\$\{CLAUDE_PROJECT_DIR\}\//, '');
        if (cleaned.length === 0 || cleaned.length > 1024 || cleaned.startsWith('-')) continue;
        candidates.add(cleaned);
      }
    }
    for (const candidate of candidates) {
      if (out.size >= CLAUDE_CONFIG_SCRIPTS_MAX) break;
      const absolute = normalize(isAbsolute(candidate) ? candidate : join(rootReal, candidate));
      const rel = relative(rootReal, absolute);
      if (rel.length === 0 || rel.startsWith('..') || isAbsolute(rel)) continue;
      const relPath = rel.split(sep).join('/');
      if (!isValidRelPath(relPath) || PROJECT_SETTINGS_FILES.includes(relPath)) continue;
      try {
        const info = await lstat(absolute);
        if (!info.isFile() || info.size > SCRIPT_MAX_BYTES) continue;
        if ((await realpath(absolute)) !== absolute) continue;
        out.set(relPath, sha256(await readFile(absolute)));
      } catch {
        // not a file of the root
      }
    }
    return [...out].map(([path, hash]) => ({ path, hash })).sort((a, b) => (a.path < b.path ? -1 : 1));
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
    for (const info of roots) {
      const scan = await this.refresh(info.ref).catch(() => null);
      if (scan === null || (scan.files.length === 0 && info.key !== 'main')) continue;
      described.push({
        root: scan.root,
        state: scan.state,
        files: scan.files.map((file) => {
          const decision = file.unverifiable ? null : this.decisionFor(file.path, file.hash);
          const known = this.decisions().some((entry) => entry.path === file.path);
          return {
            path: file.path,
            hash: file.hash,
            decision: decision?.decision ?? null,
            // Another content of this file was decided before: this one differs from it.
            changed: decision === null && known,
            text: truncateToUtf8Bytes(file.text, CLAUDE_CONFIG_TEXT_MAX_BYTES),
            runs: file.effects.runs,
            permissions: file.effects.permissions,
            env: file.effects.env,
            otherKeys: file.effects.otherKeys,
            scripts: file.scripts,
            needsAck: file.effects.needsAck,
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
      if (file.unverifiable && input.decision === 'trust') throw new SmurgError('conflict', msg('claudeConfig.changed'), { reason: 'unverifiable' });
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
