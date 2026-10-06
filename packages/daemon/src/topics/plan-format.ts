// PURE. `specs/<slug>/PLAN.md` → the work items the daemon reads, or what is wrong and where (ARCHITECTURE §5.10;
// design Appendix B.1). The file is free Markdown with ONE block between two marker lines; inside it every `###`
// heading is a work item:
//
//   <!-- smurg:plan v1 -->
//   ### 1. Cart API
//   - id: cart-api
//   - depends on: none
//   - size: m
//   - touches: src/cart/**, test/cart/**
//
//   Add the cart endpoints. Done when the cart tests pass.
//   <!-- smurg:plan end -->
//
// Every finding exists twice, on purpose: `text` is a wire catalog reference for PEOPLE (the plan column, the Start
// dialog), `model` is one FIXED English sentence per kind of finding for the agent (`check_plan`, `fix-plan`). Neither
// ever holds a token copied from the file, except an item id that passed ITEM_ID_PATTERN.
import { ITEM_GLOB_MAX_CHARS, ITEM_ID_PATTERN, ITEM_SUMMARY_MAX_CHARS, ITEM_TITLE_MAX_CHARS, ITEM_TOUCHES_MAX, PLAN_ITEMS_MAX, PLAN_WARNINGS_MAX } from '@smurg/protocol';
import { msg, type MessageRef } from '@smurg/protocol/i18n';
import { wireLine, wireMultiline } from './text.ts';

export const PLAN_MARKER_START = '<!-- smurg:plan v1 -->';
export const PLAN_MARKER_END = '<!-- smurg:plan end -->';

export type ItemSize = 's' | 'm' | 'l';

/** One work item as the file defines it. `number` is its 1-based position in the block; `line` its heading's line. */
export interface ParsedItem {
  readonly id: string;
  readonly number: number;
  readonly title: string;
  readonly summary: string;
  readonly dependsOn: readonly string[];
  readonly size: ItemSize;
  readonly touches: readonly string[];
  readonly line: number;
}

export type PlanErrorKind =
  | 'no-block'
  | 'unclosed'
  | 'markers'
  | 'heading'
  | 'field'
  | 'missing-id'
  | 'bad-id'
  | 'duplicate-id'
  | 'unknown-dependency'
  | 'self-dependency'
  | 'cycle'
  | 'size'
  | 'too-many'
  | 'empty';

export interface PlanFinding {
  /** 1-based line of the file, when the finding has one. */
  readonly line?: number;
  /** For people. */
  readonly text: MessageRef;
  /** For the model: one fixed English sentence per kind. */
  readonly model: string;
}

export interface PlanError extends PlanFinding {
  readonly kind: PlanErrorKind;
}

export type PlanParse =
  | { readonly ok: true; readonly items: readonly ParsedItem[]; readonly warnings: readonly PlanFinding[] }
  | { readonly ok: false; readonly errors: readonly PlanError[] };

/** The sentence the model reads for each kind of error. Fixed: nothing from the file is ever put into it. */
export const PLAN_ERROR_SENTENCES: Readonly<Record<PlanErrorKind, string>> = Object.freeze({
  'no-block': `The file has no work item block. Put the work items between the two marker lines "${PLAN_MARKER_START}" and "${PLAN_MARKER_END}".`,
  unclosed: `The work item block is not closed. End it with the marker line "${PLAN_MARKER_END}".`,
  markers: 'A marker line appears more than once. Keep exactly one start marker line and one end marker line, in this order.',
  heading: 'Inside the block a work item starts with a heading of the form "### <number>. <title>" with a title of 1 to 120 characters, and no other heading level is allowed there.',
  field: 'This is not a field of a work item. The fields are "- id: <id>", "- depends on: <ids separated by commas, or none>", "- size: s | m | l" and "- touches: <up to 16 globs separated by commas>", each at most once.',
  'missing-id': 'This work item has no "- id: <id>" line directly after its heading.',
  'bad-id': 'An id is 1 to 40 characters of lower-case letters, digits and hyphens and starts with a letter or a digit.',
  'duplicate-id': 'This id is already used by an earlier work item. Every work item needs its own id.',
  'unknown-dependency': '"depends on" names an id that is not a work item of this plan.',
  'self-dependency': 'A work item cannot depend on itself.',
  cycle: 'Work items depend on each other in a circle. Remove one of these dependencies.',
  size: 'size is s, m or l.',
  'too-many': `A plan has at most ${PLAN_ITEMS_MAX} work items. Merge small items.`,
  empty: 'The block has no work items. Add at least one "### <number>. <title>" heading with an id.',
});

const ITEM_HEADING = /^###[ \t]+(\d{1,4})\.[ \t]+(.*)$/;
const ANY_HEADING = /^ {0,3}#{1,6}(?:[ \t]|$)/;
/** `- <name>: <value>`: a name of letters, digits, spaces, `_` and `-`, a colon, then a space or the end of the line. */
const FIELD_LINE = /^-[ \t]+([A-Za-z][A-Za-z0-9 _\t-]*?)[ \t]*:(?:[ \t]+(.*))?$/;
const FENCE = /^ {0,3}(`{3,}|~{3,})/;
const FIELD_NAMES = ['id', 'depends on', 'size', 'touches'] as const;
type FieldName = (typeof FIELD_NAMES)[number];

function finding(kind: PlanErrorKind, text: MessageRef, line?: number): PlanError {
  return { kind, text, model: PLAN_ERROR_SENTENCES[kind], ...(line === undefined ? {} : { line }) };
}

function splitList(value: string): string[] {
  return value
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

/** The first paragraph of an item's description: what the plan column shows under its title. */
function firstParagraph(lines: readonly string[]): string {
  const out: string[] = [];
  for (const line of lines) {
    if (line.trim().length === 0) {
      if (out.length > 0) break;
      continue;
    }
    out.push(line.trimEnd());
  }
  return wireMultiline(out.join('\n'), ITEM_SUMMARY_MAX_CHARS).trim();
}

interface DraftItem {
  line: number;
  title: string;
  fields: Map<FieldName, { value: string; line: number }>;
  /** A field line of this item was refused: a missing id is then most likely that line's typo, not a second mistake. */
  badField: boolean;
  description: string[];
}

/** Two globs can name the same file: one is a prefix of the other up to its first wildcard. A conservative test. */
function globsOverlap(a: string, b: string): boolean {
  const literal = (glob: string): string => {
    const cut = glob.search(/[*?[{]/);
    return cut === -1 ? glob : glob.slice(0, cut);
  };
  const exact = (glob: string): boolean => !/[*?[{]/.test(glob);
  if (exact(a) && exact(b)) return a === b;
  const la = literal(a);
  const lb = literal(b);
  return la.startsWith(lb) || lb.startsWith(la);
}

/** Whether `from` reaches `to` over dependencies (in either direction the two are ordered). */
function reaches(from: string, to: string, deps: ReadonlyMap<string, readonly string[]>): boolean {
  const seen = new Set<string>();
  const stack = [from];
  while (stack.length > 0) {
    const id = stack.pop() as string;
    if (id === to) return true;
    if (seen.has(id)) continue;
    seen.add(id);
    for (const next of deps.get(id) ?? []) stack.push(next);
  }
  return false;
}

/** One cycle of the dependency graph as ids in order, or null. */
function findCycle(deps: ReadonlyMap<string, readonly string[]>): string[] | null {
  const state = new Map<string, 'open' | 'done'>();
  const path: string[] = [];
  const visit = (id: string): string[] | null => {
    if (state.get(id) === 'done') return null;
    if (state.get(id) === 'open') return path.slice(path.indexOf(id));
    state.set(id, 'open');
    path.push(id);
    for (const next of deps.get(id) ?? []) {
      const cycle = visit(next);
      if (cycle !== null) return cycle;
    }
    path.pop();
    state.set(id, 'done');
    return null;
  };
  for (const id of deps.keys()) {
    const cycle = visit(id);
    if (cycle !== null) return cycle;
  }
  return null;
}

/**
 * Parses PLAN.md. Every failure is one error with its line (a typo must not silently drop a dependency, so unknown
 * fields are errors); warnings leave the plan valid.
 */
export function parsePlan(source: string): PlanParse {
  const lines = source.replace(/\r\n?/g, '\n').split('\n');
  const starts: number[] = [];
  const ends: number[] = [];
  lines.forEach((line, index) => {
    const trimmed = line.trim();
    if (trimmed === PLAN_MARKER_START) starts.push(index);
    else if (trimmed === PLAN_MARKER_END) ends.push(index);
  });
  const start = starts[0];
  if (start === undefined) return { ok: false, errors: [finding('no-block', msg('plan.error.noBlock'))] };
  const end = ends.find((index) => index > start);
  const secondStart = starts[1];
  if (end === undefined || (secondStart !== undefined && secondStart < end)) return { ok: false, errors: [finding('unclosed', msg('plan.error.unclosed', { line: start + 1 }), start + 1)] };
  const extra = [...starts.slice(1), ...ends.filter((index) => index !== end)].sort((a, b) => a - b)[0];
  if (extra !== undefined) return { ok: false, errors: [finding('markers', msg('plan.error.unclosed', { line: extra + 1 }), extra + 1)] };

  const errors: PlanError[] = [];
  const drafts: DraftItem[] = [];
  let current: DraftItem | null = null;
  let inFields = false;
  let fence: string | null = null;
  for (let index = start + 1; index < end; index += 1) {
    const raw = lines[index] as string;
    const lineNo = index + 1;
    const fenceMatch = FENCE.exec(raw);
    if (fence !== null) {
      // Inside a fenced code block nothing is a heading or a field: it is description.
      if (fenceMatch !== null && (fenceMatch[1] as string).startsWith(fence[0] as string) && (fenceMatch[1] as string).length >= fence.length) fence = null;
      current?.description.push(raw);
      continue;
    }
    if (fenceMatch !== null) {
      fence = fenceMatch[1] as string;
      inFields = false;
      current?.description.push(raw);
      continue;
    }
    const heading = ITEM_HEADING.exec(raw);
    if (heading !== null) {
      const title = wireLine(heading[2] as string, Number.MAX_SAFE_INTEGER).trim();
      if (title.length === 0 || title.length > ITEM_TITLE_MAX_CHARS) errors.push(finding('heading', msg('plan.error.heading', { line: lineNo }), lineNo));
      current = { line: lineNo, title: title.slice(0, ITEM_TITLE_MAX_CHARS), fields: new Map(), badField: false, description: [] };
      drafts.push(current);
      inFields = true;
      continue;
    }
    if (ANY_HEADING.test(raw)) {
      errors.push(finding('heading', msg('plan.error.heading', { line: lineNo }), lineNo));
      inFields = false;
      continue;
    }
    if (current === null) continue; // text before the first item is allowed and ignored
    if (inFields) {
      if (raw.trim().length === 0) continue;
      const field = FIELD_LINE.exec(raw);
      if (field !== null) {
        const name = (field[1] as string).trim().toLowerCase().replace(/[ \t]+/g, ' ');
        if (!(FIELD_NAMES as readonly string[]).includes(name) || current.fields.has(name as FieldName)) {
          errors.push(finding('field', msg('plan.error.field', { line: lineNo }), lineNo));
          current.badField = true;
        } else current.fields.set(name as FieldName, { value: (field[2] ?? '').trim(), line: lineNo });
        continue;
      }
      inFields = false;
    }
    current.description.push(raw);
  }

  if (drafts.length === 0) errors.push(finding('empty', msg('plan.error.empty')));
  if (drafts.length > PLAN_ITEMS_MAX) errors.push(finding('too-many', msg('plan.error.tooMany', { max: PLAN_ITEMS_MAX })));

  // Ids first: dependencies are checked against the ids that are well-formed and unique.
  const lineOfId = new Map<string, number>();
  const ids: (string | null)[] = drafts.map((draft) => {
    const field = draft.fields.get('id');
    if (field === undefined) {
      if (!draft.badField) errors.push(finding('missing-id', msg('plan.error.missingId', { line: draft.line }), draft.line));
      return null;
    }
    if (!ITEM_ID_PATTERN.test(field.value)) {
      errors.push(finding('bad-id', msg('plan.error.badId', { line: field.line }), field.line));
      return null;
    }
    if (lineOfId.has(field.value)) {
      errors.push(finding('duplicate-id', msg('plan.error.duplicateId', { line: field.line, id: field.value }), field.line));
      return null;
    }
    lineOfId.set(field.value, field.line);
    return field.value;
  });

  const items: ParsedItem[] = [];
  const deps = new Map<string, string[]>();
  drafts.forEach((draft, index) => {
    const id = ids[index] ?? null;
    let size: ItemSize = 'm';
    const sizeField = draft.fields.get('size');
    if (sizeField !== undefined) {
      const value = sizeField.value.toLowerCase();
      if (value === 's' || value === 'm' || value === 'l') size = value;
      else errors.push(finding('size', msg('plan.error.size', { line: sizeField.line }), sizeField.line));
    }
    const dependsOn: string[] = [];
    const dependsField = draft.fields.get('depends on');
    if (dependsField !== undefined && dependsField.value.toLowerCase() !== 'none') {
      for (const dependency of splitList(dependsField.value)) {
        if (id !== null && dependency === id) errors.push(finding('self-dependency', msg('plan.error.cycle', { ids: [id] }), dependsField.line));
        else if (!lineOfId.has(dependency)) errors.push(finding('unknown-dependency', msg('plan.error.unknownDependency', { line: dependsField.line }), dependsField.line));
        else if (!dependsOn.includes(dependency)) dependsOn.push(dependency);
      }
    }
    const touches: string[] = [];
    const touchesField = draft.fields.get('touches');
    if (touchesField !== undefined) {
      const globs = splitList(touchesField.value).map((glob) => wireLine(glob, Number.MAX_SAFE_INTEGER));
      if (globs.length > ITEM_TOUCHES_MAX || globs.some((glob) => glob.length === 0 || glob.length > ITEM_GLOB_MAX_CHARS)) errors.push(finding('field', msg('plan.error.field', { line: touchesField.line }), touchesField.line));
      else for (const glob of globs) if (!touches.includes(glob)) touches.push(glob);
    }
    if (id === null) return;
    deps.set(id, dependsOn);
    items.push({ id, number: index + 1, title: draft.title, summary: firstParagraph(draft.description), dependsOn, size, touches, line: draft.line });
  });

  if (errors.length === 0) {
    const cycle = findCycle(deps);
    // (At most ten ids are named: the reference must fit the wire whatever the plan holds.)
    if (cycle !== null) errors.push(finding('cycle', msg('plan.error.cycle', { ids: cycle.slice(0, 10) })));
  }
  // In the order of the file; a finding about the whole block (no line) comes after the ones that name a line.
  if (errors.length > 0) return { ok: false, errors: errors.sort((a, b) => (a.line ?? Number.MAX_SAFE_INTEGER) - (b.line ?? Number.MAX_SAFE_INTEGER)) };

  const warnings: PlanFinding[] = [];
  for (const item of items) {
    if (item.summary.length === 0) warnings.push({ line: item.line, text: msg('plan.warning.noSummary', { number: item.number }), model: `Work item ${item.number} has no description. Say in one paragraph what is done when it is finished.` });
  }
  for (let a = 0; a < items.length; a += 1) {
    for (let b = a + 1; b < items.length; b += 1) {
      const first = items[a] as ParsedItem;
      const second = items[b] as ParsedItem;
      if (!first.touches.some((glob) => second.touches.some((other) => globsOverlap(glob, other)))) continue;
      if (reaches(first.id, second.id, deps) || reaches(second.id, first.id, deps)) continue;
      warnings.push({
        line: second.line,
        text: msg('plan.warning.overlap', { first: first.number, second: second.number }),
        model: `Work items ${first.number} and ${second.number} may change the same files and neither depends on the other. Make one depend on the other, or separate what they touch.`,
      });
    }
  }
  return { ok: true, items, warnings: warnings.slice(0, PLAN_WARNINGS_MAX) };
}

/** What makes two parses the same plan (a re-parse that differs bumps `PlanInfo.revision`). */
export function planFingerprint(items: readonly ParsedItem[]): string {
  return JSON.stringify(items.map((item) => [item.id, item.title, item.summary, item.dependsOn, item.size, item.touches]));
}
