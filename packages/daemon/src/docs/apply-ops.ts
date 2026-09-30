// Applying a diff to the room's Y.Text, and undoing a human update (the agent-lock race).
//
// A disk change is applied as insert/delete operations in ONE transaction whose origin names the actor: characters
// the diff leaves alone keep their Yjs item ids, so every remote cursor (a RelativePosition) stays on its character
// (R8 「所有人的游標位置不變」, yjs-monaco.md Q4, F4).
import type * as Y from 'yjs';
import type { CompactOp } from './diff.ts';

export interface ApplyResult {
  readonly changed: boolean;
  /** UTF-16 index just after the last changed region (the agent's caret), or null when nothing changed. */
  readonly lastChangeEnd: number | null;
}

export function applyCompactOps(text: Y.Text, ops: readonly CompactOp[], origin: unknown): ApplyResult {
  const doc = text.doc;
  if (!doc) throw new Error('the Y.Text is not part of a Y.Doc');
  if (ops.length === 0) return { changed: false, lastChangeEnd: null };
  let lastChangeEnd: number | null = null;
  doc.transact(() => {
    let index = 0;
    for (const op of ops) {
      if (typeof op === 'string') {
        if (op.length === 0) continue;
        text.insert(index, op);
        index += op.length;
        lastChangeEnd = index;
      } else if (op > 0) index += op;
      else if (op < 0) {
        text.delete(index, -op);
        lastChangeEnd = index;
      }
    }
  }, origin);
  return { changed: lastChangeEnd !== null, lastChangeEnd };
}

/** One element of a Y.Text delta (YTextEvent.delta). */
export interface TextDeltaItem {
  readonly insert?: unknown;
  readonly delete?: number;
  readonly retain?: number;
}

/**
 * The operations that turn the text AFTER a transaction back into `before`, from that transaction's delta. Exact and
 * O(size of the change): no diff is computed, so reverting even a large paste never blocks the event loop.
 */
export function inverseOfDelta(delta: readonly TextDeltaItem[], before: string): CompactOp[] {
  const ops: CompactOp[] = [];
  let beforeIndex = 0;
  for (const item of delta) {
    if (typeof item.retain === 'number') {
      ops.push(item.retain);
      beforeIndex += item.retain;
    } else if (item.insert !== undefined) {
      // Embeds count as one unit in a Y.Text.
      ops.push(-(typeof item.insert === 'string' ? item.insert.length : 1));
    } else if (typeof item.delete === 'number') {
      ops.push(before.slice(beforeIndex, beforeIndex + item.delete));
      beforeIndex += item.delete;
    }
  }
  return ops;
}
