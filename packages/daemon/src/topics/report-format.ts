// PURE. `specs/<slug>/reports/<item id>.md` → the sections of a result report, or what is wrong and where
// (ARCHITECTURE §5.10; design Appendix B.2). Fixed English headings in a fixed order; the web shows them under
// translated headings:
//
//   # Result report: Cart API
//
//   <!-- smurg:report v1 item=cart-api -->
//   - outcome: complete
//
//   ## What was done
//   ## Why it was done this way
//   ## How it was verified
//   - [x] `pnpm test cart`: 14 tests passed
//   - [ ] Manual check in the browser: not verified: no browser in this session
//   ## What to watch out for
//   ## Follow-ups                (optional)
//
// As in plan-format.ts every finding exists twice: `text` for people (a catalog reference), `model` for the agent
// (one fixed English sentence per kind). Sections are Markdown people read: they pass `mask()` and the size limit.
import { ITEM_ID_PATTERN, REPORT_CHECKS_MAX, REPORT_CHECK_TEXT_MAX_CHARS, REPORT_SECTION_MAX_BYTES, mask, type ReportOutcome } from '@smurg/protocol';
import { msg, type MessageRef } from '@smurg/protocol/i18n';
import { utf8Bytes, wireLarge, wireMultiline } from './text.ts';

export const REPORT_TITLE_PREFIX = '# Result report:';
export const REPORT_SECTIONS = ['What was done', 'Why it was done this way', 'How it was verified', 'What to watch out for'] as const;
export const REPORT_OPTIONAL_SECTION = 'Follow-ups';

export function reportMarker(itemId: string): string {
  return `<!-- smurg:report v1 item=${itemId} -->`;
}

export type ReportErrorKind =
  | 'title'
  | 'marker'
  | 'outcome'
  | 'heading'
  | 'section-missing'
  | 'section-order'
  | 'section-empty'
  | 'section-too-long'
  | 'verified-none'
  | 'verified-why'
  | 'verified-too-many';

export interface ReportError {
  readonly kind: ReportErrorKind;
  readonly line: number;
  /** For people. */
  readonly text: MessageRef;
  /** For the model: one fixed English sentence per kind. */
  readonly model: string;
}

export interface ReportCheck {
  readonly text: string;
  readonly passed: boolean;
  readonly note?: string;
}

export interface ParsedReport {
  readonly outcome: ReportOutcome;
  readonly sections: {
    readonly done: string;
    readonly why: string;
    readonly verified: readonly ReportCheck[];
    readonly watchOut: string;
    readonly followUps?: string;
  };
  readonly checks: { readonly passed: number; readonly notVerified: number };
}

export type ReportParse = { readonly ok: true; readonly report: ParsedReport } | { readonly ok: false; readonly errors: readonly ReportError[] };

/** The sentence the model reads for each kind of error. Fixed: nothing from the file is ever put into it. */
export const REPORT_ERROR_SENTENCES: Readonly<Record<ReportErrorKind, string>> = Object.freeze({
  title: `The first line must be the title line "${REPORT_TITLE_PREFIX} <the item's title>".`,
  marker: 'After the title the report needs its marker line "<!-- smurg:report v1 item=<the id of your work item> -->" with exactly the id of your own work item.',
  outcome: 'Directly after the marker line the report needs the line "- outcome: complete", "- outcome: partial" or "- outcome: blocked".',
  heading: `The only "##" headings of a report are "${REPORT_SECTIONS.join('", "')}" and the optional "${REPORT_OPTIONAL_SECTION}".`,
  'section-missing': `A section is missing. The report needs "## ${REPORT_SECTIONS.join('", "## ')}", in this order.`,
  'section-order': `The sections are in the wrong order or one appears twice. The order is "${REPORT_SECTIONS.join('", "')}", then the optional "${REPORT_OPTIONAL_SECTION}".`,
  'section-empty': 'This section is empty. Every section needs at least one sentence.',
  'section-too-long': 'This section is longer than 64 KiB. Shorten it.',
  'verified-none': 'Under "How it was verified" list at least one check as "- [x] <what passed>" or "- [ ] <what>: not verified: <why>".',
  'verified-why': 'A check that did not pass is written "- [ ] <what>: not verified: <why>" and must say why.',
  'verified-too-many': `Under "How it was verified" list at most ${REPORT_CHECKS_MAX} checks.`,
});

const LINE_SEPARATOR = /[\u2028\u2029]/;
const isBlank = (char: string | undefined): boolean => char === ' ' || char === '\t';

/**
 * The name of a `## ` heading: what stands after `##` and its blanks, without the blanks, closing hashes and blanks at
 * the end of the line (`## What was done ##`); null for a line that is no such heading. Read from both ends in one
 * pass: an expression with a name of any length in front of three runs that may all be empty tried every split of a
 * run of blanks (the cube of its length: 1.3 s for a heading and 2,000 blanks before a letter).
 */
function sectionHeading(line: string): string | null {
  if (!line.startsWith('##') || LINE_SEPARATOR.test(line)) return null;
  let from = 2;
  while (isBlank(line[from])) from += 1;
  if (from === 2) return null;
  // Nothing but blanks after the hashes: the last of two or more is the name (and no section has it).
  if (from === line.length) return from >= 4 ? (line[from - 1] as string) : null;
  let end = line.length;
  while (isBlank(line[end - 1])) end -= 1;
  while (end > from && line[end - 1] === '#') end -= 1;
  while (end > from && isBlank(line[end - 1])) end -= 1;
  // A name is at least one character: of `## ##` it is the first hash.
  return line.slice(from, Math.max(end, from + 1));
}
const OTHER_TOP_HEADING = /^#(?:[ \t]|$)/;
const FENCE = /^ {0,3}(`{3,}|~{3,})/;
const OUTCOME_LINE = /^-[ \t]+outcome[ \t]*:[ \t]*(.*)$/i;
const CHECK_LINE = /^[-*][ \t]+\[([ xX])\][ \t]+(.*)$/;
const NOT_VERIFIED = /^(.*?):[ \t]*not verified[ \t]*:[ \t]*(.*)$/i;
/**
 * The characters `.` does not match. A line is cut at line feeds only, so one can hold the others; an expression
 * that ends in `(.*)$` then fails at such a character and tries the run of blanks in front of it again from every
 * blank (the square of the run). Such a line never matched the three expressions above: it is not asked.
 */
const DOT_REFUSES = /[\n\r\u2028\u2029]/;
const lineMatch = (expression: RegExp, line: string): RegExpExecArray | null => (DOT_REFUSES.test(line) ? null : expression.exec(line));

function error(kind: ReportErrorKind, line: number): ReportError {
  return { kind, line, text: kind === 'outcome' ? msg('report.error.outcome', { line }) : msg('report.error.format', { line }), model: REPORT_ERROR_SENTENCES[kind] };
}

function sectionText(lines: readonly string[]): string {
  return mask(lines.join('\n').trim());
}

/** Parses the report of the work item `itemId`. A report of another item (a copied file) is not this item's report. */
export function parseReport(source: string, itemId: string): ReportParse {
  const lines = source.replace(/\r\n?/g, '\n').split('\n');
  const errors: ReportError[] = [];
  let index = 0;
  const skipBlank = (): void => {
    while (index < lines.length && (lines[index] as string).trim().length === 0) index += 1;
  };

  skipBlank();
  const titleLine = lines[index] ?? '';
  if (!titleLine.startsWith(REPORT_TITLE_PREFIX) || titleLine.slice(REPORT_TITLE_PREFIX.length).trim().length === 0) errors.push(error('title', Math.min(index + 1, Math.max(lines.length, 1))));
  else index += 1;

  skipBlank();
  const expectedMarker = ITEM_ID_PATTERN.test(itemId) ? reportMarker(itemId) : null;
  const markerLine = (lines[index] ?? '').trim();
  if (expectedMarker === null || markerLine !== expectedMarker) {
    errors.push(error('marker', Math.min(index + 1, Math.max(lines.length, 1))));
    // A marker line of another item (or a misspelt one) is still the marker line: the outcome is looked for after it.
    if (markerLine.startsWith('<!--')) index += 1;
  } else index += 1;

  skipBlank();
  let outcome: ReportOutcome | null = null;
  const outcomeMatch = lineMatch(OUTCOME_LINE, lines[index] ?? '');
  const outcomeValue = outcomeMatch === null ? '' : (outcomeMatch[1] as string).trim().toLowerCase();
  if (outcomeValue === 'complete' || outcomeValue === 'partial' || outcomeValue === 'blocked') {
    outcome = outcomeValue;
    index += 1;
  } else errors.push(error('outcome', Math.min(index + 1, Math.max(lines.length, 1))));

  // The sections: every `## ` heading outside a code fence starts one.
  const found: { name: string; line: number; body: string[] }[] = [];
  let fence: string | null = null;
  for (; index < lines.length; index += 1) {
    const raw = lines[index] as string;
    const fenceMatch = FENCE.exec(raw);
    if (fence !== null) {
      if (fenceMatch !== null && (fenceMatch[1] as string).startsWith(fence[0] as string) && (fenceMatch[1] as string).length >= fence.length) fence = null;
      found.at(-1)?.body.push(raw);
      continue;
    }
    if (fenceMatch !== null) {
      fence = fenceMatch[1] as string;
      found.at(-1)?.body.push(raw);
      continue;
    }
    const heading = sectionHeading(raw);
    if (heading !== null) {
      found.push({ name: heading, line: index + 1, body: [] });
      continue;
    }
    if (OTHER_TOP_HEADING.test(raw)) {
      errors.push(error('heading', index + 1));
      continue;
    }
    found.at(-1)?.body.push(raw);
  }

  const order: readonly string[] = [...REPORT_SECTIONS, REPORT_OPTIONAL_SECTION];
  const byName = new Map<string, { line: number; body: string[] }>();
  let lastPosition = -1;
  for (const section of found) {
    const position = order.indexOf(section.name);
    if (position === -1) {
      errors.push(error('heading', section.line));
      continue;
    }
    if (position <= lastPosition) {
      errors.push(error('section-order', section.line));
      continue;
    }
    lastPosition = position;
    byName.set(section.name, { line: section.line, body: section.body });
  }
  const lastLine = Math.max(lines.length, 1);
  const text = (name: string, required: boolean): string | undefined => {
    const section = byName.get(name);
    if (section === undefined) {
      if (required && !found.some((entry) => entry.name === name)) errors.push(error('section-missing', lastLine));
      return undefined;
    }
    const body = sectionText(section.body);
    if (body.length === 0) {
      if (required) errors.push(error('section-empty', section.line));
      return required ? '' : undefined;
    }
    if (utf8Bytes(body) > REPORT_SECTION_MAX_BYTES) errors.push(error('section-too-long', section.line));
    return wireLarge(body, REPORT_SECTION_MAX_BYTES).text;
  };

  const done = text(REPORT_SECTIONS[0], true);
  const why = text(REPORT_SECTIONS[1], true);
  const verifiedSection = byName.get(REPORT_SECTIONS[2]);
  if (verifiedSection === undefined && !found.some((entry) => entry.name === REPORT_SECTIONS[2])) errors.push(error('section-missing', lastLine));
  const watchOut = text(REPORT_SECTIONS[3], true);
  const followUps = text(REPORT_OPTIONAL_SECTION, false);

  const verified: ReportCheck[] = [];
  if (verifiedSection !== undefined) {
    let inFence: string | null = null;
    verifiedSection.body.forEach((raw, offset) => {
      const lineNo = verifiedSection.line + 1 + offset;
      const fenceMatch = FENCE.exec(raw);
      if (inFence !== null) {
        if (fenceMatch !== null && (fenceMatch[1] as string).startsWith(inFence[0] as string) && (fenceMatch[1] as string).length >= inFence.length) inFence = null;
        return;
      }
      if (fenceMatch !== null) {
        inFence = fenceMatch[1] as string;
        return;
      }
      const check = lineMatch(CHECK_LINE, raw);
      if (check === null) return; // prose between the checks is allowed and not part of a check
      const body = mask((check[2] as string).trim());
      if (check[1] !== ' ') {
        verified.push({ text: wireMultiline(body, REPORT_CHECK_TEXT_MAX_CHARS), passed: true });
        return;
      }
      const not = lineMatch(NOT_VERIFIED, body);
      const what = not === null ? '' : (not[1] as string).trim();
      const whyNot = not === null ? '' : (not[2] as string).trim();
      if (what.length === 0 || whyNot.length === 0) {
        errors.push(error('verified-why', lineNo));
        return;
      }
      verified.push({ text: wireMultiline(what, REPORT_CHECK_TEXT_MAX_CHARS), passed: false, note: wireMultiline(whyNot, REPORT_CHECK_TEXT_MAX_CHARS) });
    });
    if (verified.length === 0 && !errors.some((entry) => entry.kind === 'verified-why')) errors.push(error('verified-none', verifiedSection.line));
    if (verified.length > REPORT_CHECKS_MAX) errors.push(error('verified-too-many', verifiedSection.line));
  }

  if (errors.length > 0 || outcome === null || done === undefined || why === undefined || watchOut === undefined) {
    return { ok: false, errors: errors.sort((a, b) => a.line - b.line) };
  }
  const passed = verified.filter((check) => check.passed).length;
  return {
    ok: true,
    report: {
      outcome,
      sections: { done, why, verified, watchOut, ...(followUps === undefined ? {} : { followUps }) },
      checks: { passed, notVerified: verified.length - passed },
    },
  };
}
