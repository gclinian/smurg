// The diff a permission card shows for an edit (ARCHITECTURE §5.9: "a person never allows what they cannot see").
// PURE: the caller reads the file. The runner hands over what the edit tool would write, normalised
// (AgentRequest.edit); this file turns it into a unified diff against the file as it is now.
//
// The line diff runs with a time budget (ARCHITECTURE §0 rule 5: no long synchronous diff on the daemon's event loop).
// When the file is not readable, too large to diff or the budget runs out, the card shows each replacement by itself
// (the old text, the new text): less context, never less of what would change.
import { structuredPatch } from 'diff';
import type { AgentRequest } from '../core/interfaces.ts';

export type EditSpec = NonNullable<Extract<AgentRequest, { kind: 'permission' }>['edit']>;

/** A file (or a result) beyond this many UTF-16 units is not line-diffed. */
export const DIFF_MAX_CHARS = 1_048_576;
export const DIFF_TIMEOUT_MS = 150;
const CONTEXT_LINES = 3;

/** The file after the edit, or null when a replacement's old text is not in it (the tool call would fail). */
export function applyEdit(current: string, edit: EditSpec): string | null {
  if (edit.kind === 'write') return edit.text;
  let text = current;
  for (const replacement of edit.replacements) {
    if (replacement.oldText === '') {
      // Claude Code's Edit with an empty old text writes the new text into an empty (or new) file.
      if (text !== '') return null;
      text = replacement.newText;
      continue;
    }
    if (!text.includes(replacement.oldText)) return null;
    text = replacement.all ? text.split(replacement.oldText).join(replacement.newText) : text.replace(replacement.oldText, () => replacement.newText);
  }
  return text;
}

function header(label: string, created: boolean): string {
  return `--- ${created ? '/dev/null' : `a/${label}`}\n+++ b/${label}\n`;
}

/** Every line of a fragment with its sign. (A fragment is a piece of a file: where it ends says nothing about the file's end.) */
function prefixed(prefix: '+' | '-', text: string): string {
  if (text === '') return '';
  const lines = text.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return `${lines.map((line) => `${prefix}${line}`).join('\n')}\n`;
}

/** Every replacement by itself: what goes and what comes, without the lines around it. */
export function replacementsDiff(label: string, edit: EditSpec, created: boolean): string {
  if (edit.kind === 'write') {
    const lines = edit.text === '' ? 0 : edit.text.replace(/\n$/, '').split('\n').length;
    return `${header(label, created)}@@ ${created ? `-0,0 +1,${lines}` : 'the whole file is replaced by'} @@\n${prefixed('+', edit.text)}`;
  }
  const total = edit.replacements.length;
  return (
    header(label, created) +
    edit.replacements.map((replacement, index) => `@@ replacement ${index + 1} of ${total}${replacement.all ? ' (every occurrence)' : ''} @@\n${prefixed('-', replacement.oldText)}${prefixed('+', replacement.newText)}`).join('')
  );
}

/**
 * The unified diff of `before` → `after` (`before` null: the file does not exist yet), or null when the texts are too
 * large or the time budget ran out.
 */
export function unifiedDiff(label: string, before: string | null, after: string, timeoutMs = DIFF_TIMEOUT_MS): string | null {
  const old = before ?? '';
  if (old.length > DIFF_MAX_CHARS || after.length > DIFF_MAX_CHARS) return null;
  const patch = structuredPatch('a', 'b', old, after, undefined, undefined, { context: CONTEXT_LINES, timeout: timeoutMs });
  if (patch === undefined) return null;
  let out = header(label, before === null);
  for (const hunk of patch.hunks) {
    // The unified format's quirk: a side of zero lines starts one line lower.
    out += `@@ -${hunk.oldLines === 0 ? hunk.oldStart - 1 : hunk.oldStart},${hunk.oldLines} +${hunk.newLines === 0 ? hunk.newStart - 1 : hunk.newStart},${hunk.newLines} @@\n`;
    for (const line of hunk.lines) out += `${line}\n`;
  }
  return out;
}

/**
 * The diff of one edit. `label`: the path a reader sees (relative to the root; a fixed word for a file outside every
 * root). `current`: the file's text now, null when it does not exist or could not be read as text.
 */
export function changeDiff(input: { readonly label: string; readonly current: string | null; readonly exists: boolean; readonly edit: EditSpec; readonly timeoutMs?: number }): string {
  const created = !input.exists;
  if (input.current === null && input.exists) return replacementsDiff(input.label, input.edit, false);
  const after = applyEdit(input.current ?? '', input.edit);
  if (after === null) return replacementsDiff(input.label, input.edit, created);
  return unifiedDiff(input.label, created ? null : input.current, after, input.timeoutMs) ?? replacementsDiff(input.label, input.edit, created);
}
