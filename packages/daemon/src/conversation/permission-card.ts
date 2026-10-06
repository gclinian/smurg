// The pure parts of a permission card (ARCHITECTURE §5.9; DESIGN §3.6): the strings a card may carry, what counts as
// reaching beyond the shared project, and the copy members other than the host get. No Claude Code input shape is
// read here: what the tool wants is `AgentRequest.view` (the ToolView of the same call), `absPath` and `edit`; the
// raw input is only ever shown whole.
//
// What a person is asked to ALLOW is never altered: the command, the diff and the input are shown as they are, not
// shortened and not masked (DESIGN §7 S6: a hidden part of a command is a part nobody approved; `mask()` is for what
// agents and tools PRINT). Only a NUL, which no wire string can hold, becomes a visible sign.
import { isAbsolute, join, relative } from 'node:path';
import {
  PERMISSION_REASON_MAX_CHARS,
  TOOL_NAME_MAX_CHARS,
  agentText,
  isClaudeConfigPath,
  isHostOnlyPath,
  isHostPrivatePath,
  type FileRef,
  type PermissionRequest,
} from '@smurg/protocol';

/** The directories of the host that a request is host-only for wherever the shared folder is: smurg's own state, Claude Code's, ssh's. */
export const HOST_HOME_DIRS: readonly string[] = Object.freeze(['.smurg', '.claude', '.ssh']);

/** What stands in for NUL in a text people read (a string on the wire never holds NUL). */
const VISIBLE_NUL = '␀';

export function utf8Bytes(text: string): number {
  return Buffer.byteLength(text, 'utf8');
}

/** A command or a diff as a card carries it: whole, a NUL made visible. Never shortened, never masked. */
export function shownText(text: string): string {
  return text.includes('\u0000') ? text.replaceAll('\u0000', VISIBLE_NUL) : text;
}

/** The tool's name as one line of at most TOOL_NAME_MAX_CHARS. */
export function shownToolName(tool: string): string {
  const line = agentText(tool).text.replace(/\s+/gu, ' ').trim();
  let out = '';
  for (const char of line) {
    if (out.length + char.length > TOOL_NAME_MAX_CHARS) break;
    out += char;
  }
  return out === '' ? 'tool' : out;
}

/** Claude Code's own English reason: cleaned, at most PERMISSION_REASON_MAX_CHARS; undefined when nothing is left. */
export function shownReason(reason: string | undefined): string | undefined {
  if (reason === undefined) return undefined;
  const text = agentText(reason).text.trim();
  if (text === '') return undefined;
  if (text.length <= PERMISSION_REASON_MAX_CHARS) return text;
  let out = '';
  for (const char of text) {
    if (out.length + char.length > PERMISSION_REASON_MAX_CHARS - 1) break;
    out += char;
  }
  return `${out}…`;
}

/** The WHOLE input of a tool, pretty-printed. Null when it cannot be shown as text. */
export function shownInput(input: unknown): string | null {
  try {
    const text = JSON.stringify(input, null, 2);
    return typeof text === 'string' ? text : null;
  } catch {
    return null;
  }
}

/** A URL a card may carry in `url`: http(s), one line, no control or bidi characters. */
export function shownUrl(target: string | undefined, maxChars: number): string | undefined {
  if (target === undefined || target.length > maxChars || !/^https?:\/\/\S+$/u.test(target)) return undefined;
  return agentText(target).text === target ? target : undefined;
}

/** Whether an absolute path lies in `dir` (or is it). Lexical: both are absolute host paths. */
export function isWithin(path: string, dir: string): boolean {
  const rel = relative(dir, path);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/** Under the host's `~/.smurg`, `~/.claude` or `~/.ssh`, or under the daemon's own state directory. */
export function isHostHomePath(absPath: string, home: string | null, stateDir: string): boolean {
  if (!isAbsolute(absPath)) return false;
  if (isWithin(absPath, stateDir)) return true;
  return home !== null && HOST_HOME_DIRS.some((name) => isWithin(absPath, join(home, name)));
}

/** A path inside a root that only the host may write, or that is the host's private data. */
export function isHostPathInRoot(ref: FileRef): boolean {
  return isHostOnlyPath(ref.path) || isHostPrivatePath(ref.path);
}

/**
 * A shell command that names Claude Code's configuration: `.claude/`, `.git/` or `.mcp.json` as a path segment. Used
 * ONLY together with Claude Code's own safety check when that check named no path: the daemon never decides from a
 * command's text alone what the command does.
 */
export function namesClaudeConfig(command: string): boolean {
  if (/(^|[\s"'`=:(<>|;&/])\.mcp\.json($|[\s"'`);|&<>])/u.test(command)) return true;
  return /(^|[\s"'`=:(<>|;&/])\.(claude|git)(\/|$|[\s"'`);|&<>])/u.test(command);
}

export { isClaudeConfigPath };

/**
 * The copy every member but the host gets: never the absolute `path`; for a request that reaches outside every root
 * also not the raw `input` (it names the path), and not a `reason` that names a path.
 */
export function memberCopy(request: PermissionRequest): PermissionRequest {
  const { path: _path, ...rest } = request;
  if (request.outside !== true) return rest;
  const { input: _input, ...copy } = rest;
  if (copy.reason !== undefined && /[/\\]/.test(copy.reason)) {
    const { reason: _reason, ...withoutReason } = copy;
    return withoutReason;
  }
  return copy;
}
