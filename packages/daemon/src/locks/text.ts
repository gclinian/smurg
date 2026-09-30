// User-facing (zh-TW) texts of the locks module and the small helpers that keep them valid for the schemas: deny
// reasons reach the model after Claude Code's "PreToolUse:Edit hook error: " prefix (claude-hooks.md §3.4), activity
// summaries are single-line text of at most ACTIVITY_SUMMARY_MAX_CHARS.
import { ACTIVITY_SUMMARY_MAX_CHARS, displayNameSchema } from '@smurg/protocol';
import { RELAY_DISPLAY_NAME_MAX_CHARS } from '@smurg/protocol/relay';
import type { FileChangeKind } from '../core/interfaces.ts';
import { agentDisplayName } from '../core/permissions.ts';

/** How many holder names a deny reason lists before it says 「等 N 人」. */
const NAMES_LISTED = 5;
/** Longest path shown inside a summary (the whole summary is capped too). */
const PATH_SHOWN_MAX = 200;

/** Cuts `text` to `max` UTF-16 units without splitting a surrogate pair; appends 「…」 when cut. */
export function clipText(text: string, max: number): string {
  if (text.length <= max) return text;
  let end = max - 1;
  const code = text.charCodeAt(end - 1);
  if (code >= 0xd800 && code <= 0xdbff) end -= 1;
  return `${text.slice(0, end)}…`;
}

/** Control and bidi characters never go into a summary (lineText rule). */
function clean(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/[\u0000-\u001f\u007f-\u009f؜‎‏‪-‮⁦-⁩]/g, ' ');
}

export function summary(text: string): string {
  return clipText(clean(text), ACTIVITY_SUMMARY_MAX_CHARS);
}

export function shownPath(path: string): string {
  return clipText(path === '' ? '/' : path, PATH_SHOWN_MAX);
}

/** A name followed by a verb: no space after a full-width closing bracket (「Claude（Ian）修改了」), else one space. */
export function nameThen(name: string, rest: string): string {
  return /[）」』】]$/u.test(name) ? `${name}${rest}` : `${name} ${rest}`;
}

/**
 * 「Claude（<owner>）」, valid for displayNameSchema whatever the owner's name: a maximal owner name plus the wrapper
 * would exceed the limit and make every LockInfo / PresenceAgent carrying it fail validation.
 */
export function agentNameFor(ownerDisplayName: string): string {
  const room = RELAY_DISPLAY_NAME_MAX_CHARS - agentDisplayName('').length;
  const owner = ownerDisplayName.length > room ? clipText(ownerDisplayName, room) : ownerDisplayName;
  return agentDisplayName(owner);
}

/** A display name that passes displayNameSchema (clipped / replaced), for names that arrive from other modules. */
export function safeDisplayName(name: string, fallback: string): string {
  if (displayNameSchema.safeParse(name).success) return name;
  const cleaned = clipText(clean(name).trim(), RELAY_DISPLAY_NAME_MAX_CHARS);
  return displayNameSchema.safeParse(cleaned).success ? cleaned : fallback;
}

function listNames(names: readonly string[]): string {
  if (names.length <= NAMES_LISTED) return names.join('、');
  return `${names.slice(0, NAMES_LISTED).join('、')} 等 ${names.length} 人`;
}

// ---- deny reasons (the hook prints them as permissionDecisionReason) -------------------------------------------

export function humanHeldReason(names: readonly string[]): string {
  return `此檔案正由 ${listNames(names)} 編輯中，請先處理其他檔案或稍後再試`;
}

export function agentHeldReason(agentName: string): string {
  return nameThen(agentName, '正在修改此檔案，請先處理其他檔案或稍後再試');
}

export const OUTSIDE_ROOT_REASON = '此檔案不在這個 session 的工作區內，無法修改';
export const INVALID_TARGET_REASON = '無法對這個路徑申請檔案鎖';
export const LOCK_CAP_REASON = '這個 session 短時間內申請了太多檔案鎖，請稍後再試';

// ---- activity summaries -----------------------------------------------------------------------------------------

const CHANGE_VERBS: Readonly<Record<FileChangeKind, string>> = {
  add: '新增了',
  change: '修改了',
  unlink: '刪除了',
  addDir: '新增了資料夾',
  unlinkDir: '刪除了資料夾',
};

export function changeVerb(change: FileChangeKind): string {
  return CHANGE_VERBS[change];
}

export function agentEditSummary(agentName: string, path: string, tool: string | null): string {
  return summary(`${nameThen(agentName, `修改了 ${shownPath(path)}`)}${tool ? `（${tool}）` : ''}`);
}

export function agentChangeSummary(agentName: string, path: string, change: FileChangeKind): string {
  return summary(nameThen(agentName, `${changeVerb(change)} ${shownPath(path)}`));
}

/** An agent's change made by a shell command (Bash tool; ARCHITECTURE §11 D-13). */
export function bashChangeSummary(agentName: string, path: string, change: FileChangeKind): string {
  return summary(nameThen(agentName, `透過 shell 指令${changeVerb(change)} ${shownPath(path)}`));
}

export function bashBurstSummary(agentName: string, count: number, sample: readonly string[]): string {
  const shown = sample.slice(0, 3).map(shownPath).join('、');
  return summary(nameThen(agentName, `透過 shell 指令變更了 ${count} 個檔案${shown ? `（例如 ${shown}）` : ''}`));
}

export function externalChangeSummary(path: string, change: FileChangeKind): string {
  return summary(`外部程式${changeVerb(change)} ${shownPath(path)}`);
}

/** A change in `name`'s own worktree made by one of their sessions (a terminal, or an agent among several). */
export function worktreeChangeSummary(name: string, path: string, change: FileChangeKind): string {
  return summary(nameThen(name, `的 worktree 中的程式${changeVerb(change)} ${shownPath(path)}`));
}

export function worktreeBurstSummary(name: string, count: number, sample: readonly string[]): string {
  const shown = sample.slice(0, 3).map(shownPath).join('、');
  return summary(nameThen(name, `的 worktree 中變更了 ${count} 個檔案${shown ? `（例如 ${shown}）` : ''}`));
}

export function externalBurstSummary(count: number, sample: readonly string[]): string {
  const shown = sample.slice(0, 3).map(shownPath).join('、');
  return summary(`外部程式變更了 ${count} 個檔案${shown ? `（例如 ${shown}）` : ''}`);
}

export function humanEditSummary(name: string, path: string): string {
  return summary(nameThen(name, `編輯了 ${shownPath(path)}`));
}

export function lockDeniedSummary(agentName: string, path: string | null, holderNames: readonly string[] | null, holderIsAgent: boolean): string {
  const target = path === null ? '一個檔案' : shownPath(path);
  if (holderNames === null || holderNames.length === 0) return summary(nameThen(agentName, `修改 ${target} 的請求被拒絕`));
  const who = listNames(holderNames);
  return summary(nameThen(agentName, `想修改 ${target}，但 ${who} ${holderIsAgent ? '正在修改' : '正在編輯'}，已被擋下`));
}

/** Tool names come from the hook's stdin (a claim): only a plain identifier is shown. */
export function safeToolName(tool: string): string | null {
  return /^[A-Za-z][A-Za-z0-9_.:-]{0,63}$/.test(tool) ? tool : null;
}
