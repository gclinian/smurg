// PURE (ARCHITECTURE §7.6 "Normalised events"; DESIGN §2.3): what a tool call of Claude Code looks like on smurg's own
// wire. A tool name + its input → ToolView (the tool card, and the SAME view on its permission card); the tool's result
// → ToolResultView. Nothing of Claude Code's own shapes leaves this file and normalise.ts.
//
// Rules for every body, whatever the tool (§7 S7, S8):
//  - `mask()` runs over every text that came from an agent or a tool before it is stored or sent;
//  - a `file` and a body exist only for a path inside a root that is not host-private; a path outside every root is
//    `outside: true` with no target and no body;
//  - a Read never has a body (file contents are never stored or sent); a search lists file names, never matched
//    lines, and never a host-private name.
// Path resolution (PathGuard.toFileRef) is the caller's: it passes what it found as `Located`.
import {
  COMMAND_MAX_BYTES,
  EVENT_TEXT_MAX_BYTES,
  OPAQUE_ID_PATTERN,
  SMURG_TOOL_PREFIX,
  TOOL_FETCH_BODY_BYTES,
  TOOL_NAME_MAX_CHARS,
  TOOL_OUTPUT_HEAD_BYTES,
  TOOL_OUTPUT_TAIL_BYTES,
  TOOL_SEARCH_FILES_MAX,
  isHostPrivatePath,
  mask,
  toolVerb,
  truncateToUtf8Bytes,
  type FileRef,
  type ToolResultView,
  type ToolView,
} from '@smurg/protocol';
import type { AgentRequest } from '../../core/interfaces.ts';

type Json = Record<string, unknown>;

function isObject(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

/** Where the path a tool names lies: inside one of the workspace's roots, outside all of them, or the tool names none. */
export type Located = { readonly kind: 'in'; readonly file: FileRef } | { readonly kind: 'outside' } | { readonly kind: 'none' };

/** An id of Claude Code's as an opaque id of ours (`[A-Za-z0-9_-]{1,64}`); anything else becomes a stable digest-free rewrite. */
export function safeId(raw: unknown, prefix: string): string {
  const text = typeof raw === 'string' ? raw : '';
  if (OPAQUE_ID_PATTERN.test(text)) return text;
  const cleaned = text.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 56);
  return cleaned.length > 0 ? `${prefix}_${cleaned}`.slice(0, 64) : `${prefix}_unknown`;
}

/** Text that passes `largeTextSchema`: no NUL, at most `maxBytes` of UTF-8. */
export function clip(text: string, maxBytes: number): { readonly text: string; readonly truncated: boolean } {
  const clean = text.includes('\u0000') ? text.replaceAll('\u0000', '') : text;
  const cut = truncateToUtf8Bytes(clean, maxBytes);
  return { text: cut, truncated: cut.length < clean.length };
}

/** The first `headBytes` and the last `tailBytes` of an output, with one line saying what was left out. */
export function headTail(text: string, headBytes: number, tailBytes: number): { readonly text: string; readonly truncated: boolean } {
  const clean = text.includes('\u0000') ? text.replaceAll('\u0000', '') : text;
  if (Buffer.byteLength(clean, 'utf8') <= headBytes + tailBytes) return { text: clean, truncated: false };
  const head = truncateToUtf8Bytes(clean, headBytes);
  let tail = clean.slice(Math.max(head.length, clean.length - tailBytes));
  while (Buffer.byteLength(tail, 'utf8') > tailBytes) tail = tail.slice(Math.max(1, Math.ceil((Buffer.byteLength(tail, 'utf8') - tailBytes) / 4)));
  // A cut may have split a surrogate pair at the start of the tail.
  if (tail.length > 0 && tail.charCodeAt(0) >= 0xdc00 && tail.charCodeAt(0) <= 0xdfff) tail = tail.slice(1);
  return { text: `${head}\n[…]\n${tail}`, truncated: true };
}

// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;?<>=!]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-_]/g;

export function stripAnsi(text: string): string {
  return text.replace(ANSI, '');
}

/** A tool name as a single line of at most TOOL_NAME_MAX_CHARS characters. */
export function toolName(raw: unknown): string {
  // eslint-disable-next-line no-control-regex
  const name = (typeof raw === 'string' ? raw : '').replace(/[\u0000-\u001f\u007f-\u009f‪-‮⁦-⁩]/g, '').slice(0, TOOL_NAME_MAX_CHARS);
  return name.length > 0 ? name : 'unknown';
}

/** The path a tool names in its input (absolute, or relative to the session's cwd), when it names one. */
export function toolPathOf(name: string, input: unknown): string | undefined {
  if (!isObject(input)) return undefined;
  const verb = toolVerb(name);
  if (verb === 'read' || verb === 'edit') return str(input['file_path']) ?? str(input['notebook_path']);
  if (verb === 'search') return str(input['path']);
  return undefined;
}

function target(text: string | undefined): { target?: string } {
  if (text === undefined || text.length === 0) return {};
  return { target: clip(text, COMMAND_MAX_BYTES).text };
}

/**
 * The ToolView of one call. `created`: a Write to a file that does not exist yet (the verb is then `create`).
 * A path outside every root: `outside: true` and nothing else. A host-private path inside a root: its name as the
 * target, no `file` (so no body is ever attached to it).
 */
export function buildToolView(rawName: unknown, input: unknown, located: Located, options: { readonly created?: boolean } = {}): ToolView {
  const name = toolName(rawName);
  const base = toolVerb(name);
  const verb = base === 'edit' && name === 'Write' && options.created === true ? 'create' : base;
  const data = isObject(input) ? input : {};
  if (verb === 'read' || verb === 'edit' || verb === 'create') {
    if (located.kind === 'outside') return { name, verb, outside: true };
    if (located.kind === 'in') {
      if (isHostPrivatePath(located.file.path)) return { name, verb, ...target(located.file.path) };
      return { name, verb, ...target(located.file.path), file: located.file };
    }
    return { name, verb };
  }
  if (verb === 'run') return { name, verb, ...target(str(data['command']) ?? str(data['bash_id']) ?? str(data['shell_id'])) };
  if (verb === 'search') {
    // The pattern is the target; a search path outside every root makes the whole call `outside`.
    if (located.kind === 'outside') return { name, verb, outside: true };
    return { name, verb, ...target(str(data['pattern'])) };
  }
  if (verb === 'fetch') return { name, verb, ...target(str(data['url']) ?? str(data['query'])) };
  if (verb === 'task') return { name, verb, ...target(str(data['description'])) };
  if (verb === 'smurg') return { name, verb, ...target(name.slice(SMURG_TOOL_PREFIX.length)) };
  if (verb === 'todo') return { name, verb };
  return { name, verb, ...target(name) };
}

/** What an edit tool would write, normalised (AgentRequest.edit); undefined for a tool that edits no file or cannot be normalised. */
export function editOf(name: string, input: unknown): Extract<AgentRequest, { kind: 'permission' }>['edit'] | undefined {
  if (!isObject(input)) return undefined;
  if (name === 'Write') {
    const text = str(input['content']);
    return text === undefined ? undefined : { kind: 'write', text };
  }
  const one = (edit: Json): { oldText: string; newText: string; all: boolean } | null => {
    const oldText = str(edit['old_string']);
    const newText = str(edit['new_string']);
    return oldText === undefined || newText === undefined ? null : { oldText, newText, all: edit['replace_all'] === true };
  };
  if (name === 'Edit') {
    const replacement = one(input);
    return replacement === null ? undefined : { kind: 'replace', replacements: [replacement] };
  }
  if (name === 'MultiEdit' && Array.isArray(input['edits'])) {
    const replacements = input['edits'].map((edit) => (isObject(edit) ? one(edit) : null));
    if (replacements.length === 0 || replacements.some((entry) => entry === null)) return undefined;
    return { kind: 'replace', replacements: replacements as { oldText: string; newText: string; all: boolean }[] };
  }
  return undefined;
}

/** The rule Claude Code suggests with a permission request (`addRules` … `allow`), as `{ tool, pattern }`. Never echoed back as it came. */
export function suggestedRuleOf(suggestions: unknown): { readonly tool: string; readonly pattern: string } | undefined {
  if (!Array.isArray(suggestions)) return undefined;
  for (const entry of suggestions) {
    if (!isObject(entry) || entry['type'] !== 'addRules' || entry['behavior'] !== 'allow' || !Array.isArray(entry['rules'])) continue;
    for (const rule of entry['rules']) {
      if (!isObject(rule)) continue;
      const tool = str(rule['toolName']);
      const pattern = str(rule['ruleContent']);
      if (tool !== undefined && pattern !== undefined && tool.length <= 64 && pattern.length <= 4096) return { tool, pattern };
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------------------------------------------------

/** A unified diff from Claude Code's `structuredPatch` (hunks with prefixed lines), with its line counts. */
export function diffFromPatch(patch: unknown): { readonly text: string; readonly additions: number; readonly deletions: number } | null {
  if (!Array.isArray(patch) || patch.length === 0) return null;
  const out: string[] = [];
  let additions = 0;
  let deletions = 0;
  for (const hunk of patch) {
    if (!isObject(hunk) || !Array.isArray(hunk['lines'])) continue;
    const n = (key: string): number => (typeof hunk[key] === 'number' && Number.isFinite(hunk[key]) ? Math.max(0, Math.trunc(hunk[key] as number)) : 0);
    out.push(`@@ -${n('oldStart')},${n('oldLines')} +${n('newStart')},${n('newLines')} @@`);
    for (const line of hunk['lines']) {
      if (typeof line !== 'string') continue;
      if (line.startsWith('+')) additions += 1;
      else if (line.startsWith('-')) deletions += 1;
      out.push(line);
    }
  }
  return out.length === 0 ? null : { text: `${out.join('\n')}\n`, additions, deletions };
}

function additionsOf(content: string): { readonly text: string; readonly additions: number } {
  if (content.length === 0) return { text: '', additions: 0 };
  const lines = content.endsWith('\n') ? content.slice(0, -1).split('\n') : content.split('\n');
  return { text: `${lines.map((line) => `+${line}`).join('\n')}\n`, additions: lines.length };
}

function body(kind: 'diff' | 'output' | 'list' | 'text', text: string, maxBytes: number, alreadyCut = false): NonNullable<ToolResultView['body']> {
  const cut = clip(mask(text), maxBytes);
  return { kind, text: cut.text, truncated: cut.truncated || alreadyCut };
}

const EXIT_CODE = /(?:^|\n)Exit code (\d{1,3})\b/;

export interface ToolResultInput {
  /** The ToolView of the call (its `tool.started`). */
  readonly view: ToolView;
  readonly ok: boolean;
  /** The text of the tool_result block (what the model reads). */
  readonly text: string;
  /** Claude Code's structured result (`tool_use_result`), when it sent one. */
  readonly structured: unknown;
  readonly durationMs?: number;
  /** Maps an absolute path of a search result to its path relative to the session's root; null: outside it. */
  relativePath(absolute: string): string | null;
}

/** The ToolResultView of a finished call (DESIGN §2.3 table). */
export function buildToolResult(input: ToolResultInput): ToolResultView {
  const { view, ok } = input;
  const structured = isObject(input.structured) ? input.structured : {};
  const duration = input.durationMs !== undefined && Number.isFinite(input.durationMs) ? { durationMs: Math.max(0, Math.round(input.durationMs)) } : {};
  // A path outside the workspace, and a host-private path: never a body.
  if (view.outside === true) return { ...duration };
  switch (view.verb) {
    case 'read':
      return { ...duration };
    case 'edit':
    case 'create': {
      if (view.file === undefined) return { ...duration };
      if (!ok) return { ...duration, body: body('text', input.text, TOOL_FETCH_BODY_BYTES) };
      const patch = diffFromPatch(structured['structuredPatch']);
      if (patch !== null) return { ...duration, additions: patch.additions, deletions: patch.deletions, body: body('diff', patch.text, EVENT_TEXT_MAX_BYTES) };
      const content = str(structured['content']);
      if (content !== undefined && (structured['type'] === 'create' || view.verb === 'create')) {
        const added = additionsOf(content);
        return { ...duration, additions: added.additions, deletions: 0, body: body('diff', added.text, EVENT_TEXT_MAX_BYTES) };
      }
      return { ...duration };
    }
    case 'run': {
      const stdout = str(structured['stdout']);
      const stderr = str(structured['stderr']);
      const combined = stdout !== undefined || stderr !== undefined ? [stdout ?? '', stderr ?? ''].filter((part) => part.length > 0).join('\n') : input.text;
      const output = headTail(stripAnsi(ok && combined.length === 0 ? '' : combined.length === 0 ? input.text : combined), TOOL_OUTPUT_HEAD_BYTES, TOOL_OUTPUT_TAIL_BYTES);
      const match = EXIT_CODE.exec(input.text);
      const exitCode = match !== null ? Number(match[1]) : ok ? 0 : 1;
      return { ...duration, exitCode, ...(output.text.length > 0 ? { body: body('output', output.text, EVENT_TEXT_MAX_BYTES, output.truncated) } : {}) };
    }
    case 'search': {
      if (!ok) return { ...duration, body: body('text', input.text, TOOL_FETCH_BODY_BYTES) };
      const names = Array.isArray(structured['filenames']) ? structured['filenames'].filter((name): name is string => typeof name === 'string') : [];
      const listed: string[] = [];
      for (const name of names) {
        const rel = input.relativePath(name);
        // Never a host-private name, never a name outside the session's root.
        if (rel === null || rel.length === 0 || isHostPrivatePath(rel)) continue;
        if (listed.length < TOOL_SEARCH_FILES_MAX) listed.push(rel);
      }
      const count = typeof structured['numFiles'] === 'number' && Number.isFinite(structured['numFiles']) ? Math.max(0, Math.trunc(structured['numFiles'])) : names.length;
      return { ...duration, matches: count, ...(listed.length > 0 ? { body: body('list', `${listed.join('\n')}\n`, EVENT_TEXT_MAX_BYTES, names.length > listed.length) } : {}) };
    }
    case 'todo': {
      const todos = Array.isArray(structured['newTodos']) ? structured['newTodos'] : [];
      const lines = todos.flatMap((todo) => {
        if (!isObject(todo) || typeof todo['content'] !== 'string') return [];
        const mark = todo['status'] === 'completed' ? '[x]' : todo['status'] === 'in_progress' ? '[~]' : '[ ]';
        return [`${mark} ${todo['content'].replace(/\s+/g, ' ')}`];
      });
      return { ...duration, ...(lines.length > 0 ? { body: body('list', `${lines.join('\n')}\n`, TOOL_FETCH_BODY_BYTES) } : {}) };
    }
    default:
      // fetch, task, smurg, other: the text answer, bounded.
      return { ...duration, ...(input.text.length > 0 ? { body: body('text', input.text, TOOL_FETCH_BODY_BYTES) } : {}) };
  }
}
