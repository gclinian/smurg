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
//   - [!] `pnpm lint`: failed: 2 errors in cart.ts            (0.7.0: a check that failed)
//   ## What to watch out for
//   ## Follow-ups                (optional)
//
// As in plan-format.ts every finding exists twice: `text` for people (a catalog reference), `model` for the agent
// (one fixed English sentence per kind). Sections are Markdown people read: they pass `mask()` and the size limit.
//
// 0.7.0 (DESIGN 0.7.0 D5): a third check line, `- [!] <what>: failed: <what happened>`, still format v1 (every report
// of 0.6.0 parses to the same result as before). A report whose outcome is `complete` and that lists a failed check is
// refused at the outcome line (`outcome-failed`): "complete and verified" is a complete outcome, at least one check that
// passed and none that failed, and smurg merges by itself only what its report says is that. A ticked box whose words
// say the check failed or was not verified (`- [x] pnpm test: failed: …`) is refused at its line (`verified-ticked`).
// A check's words are read as the agent wrote them and masked only for what is stored (0.7.0 fix4): `mask()` hides the
// word after `password:` or `token:`, and "failed" is such a word.
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
  | 'verified-failed-why'
  | 'verified-too-many'
  | 'verified-ticked'
  | 'outcome-failed';

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
  /** A check that ran and did not pass (`- [!]`): never `passed`, always with its `note` (what happened). */
  readonly failed?: true;
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
  /** `failed` only when a check failed (absent: none, as every report of 0.6.0). */
  readonly checks: { readonly passed: number; readonly notVerified: number; readonly failed?: number };
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
  'verified-none': 'Under "How it was verified" list at least one check as "- [x] <what passed>", "- [ ] <what>: not verified: <why>" or "- [!] <what>: failed: <what happened>".',
  'verified-why': 'A check that did not pass is written "- [ ] <what>: not verified: <why>" and must say why.',
  'verified-failed-why': 'A check that failed is written "- [!] <what>: failed: <what happened>" and must say what happened.',
  'verified-too-many': `Under "How it was verified" list at most ${REPORT_CHECKS_MAX} checks.`,
  // (0.7.0 last check: the words of a check that passed can be taken for a failure; the agent rewords such a check, it
  // never writes a check that passed as failed or not run)
  'verified-ticked':
    'A ticked box "- [x]" is a check that passed, and these words read as a check that failed or did not run. If the check passed, keep it ticked and reword it so that its words do not read as a failure. If it failed, write it "- [!] <what>: failed: <what happened>"; if it did not run, "- [ ] <what>: not verified: <why>".',
  'outcome-failed': 'A report with a failed check is not complete: set the outcome line to partial, or make the check pass and mark it "- [x]".',
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
const CHECK_LINE = /^[-*][ \t]+\[([ xX!])\][ \t]+(.*)$/;
const NOT_VERIFIED = /^(.*?):[ \t]*not verified[ \t]*:[ \t]*(.*)$/i;
const FAILED = /^(.*?):[ \t]*failed[ \t]*:[ \t]*(.*)$/i;
/**
 * The characters `.` does not match. A line is cut at line feeds only, so one can hold the others; an expression
 * that ends in `(.*)$` then fails at such a character and tries the run of blanks in front of it again from every
 * blank (the square of the run). Such a line never matched the expressions above: it is not asked.
 */
const DOT_REFUSES = /[\n\r\u2028\u2029]/;
const lineMatch = (expression: RegExp, line: string): RegExpExecArray | null => (DOT_REFUSES.test(line) ? null : expression.exec(line));

/**
 * Words at the start of what follows `<what>` that say the check failed or did not run (0.7.0 last check): the outcome
 * words "failed", "not verified" and "not run", whatever follows them but a letter (`FAILED (2 of 3)`, `failed because
 * ...`, `not run (no browser)`); "fail", "fails", "failing", "failure" and the zh-TW word for failing (also with its
 * particle of a done action) only where the words stop after them or punctuation or a parenthesis follows (`FAIL (2 of
 * 3)`, `fails.`), for they also name a failure that a passed check looks at (`failing writes are retried`, `fails with a
 * wrong password, as it should`, the zh-TW word followed by its adjective mark). A hyphen is punctuation there only with
 * a blank after it (`FAIL - 2 of 3`, not `fail-safe`). The zh-TW word for "not verified" is also the usual word for
 * "unauthenticated" (`API: <unauthenticated> requests get a 401`): it reads as an outcome only where the words stop
 * after it, punctuation or a parenthesis follows, or a reason does, also after a blank ("because", "due to", "is
 * because"; 0.7.0 fix4, fix5), or its mark of experience ("not verified yet"), or a blank and another word (`<not
 * verified> <no browser>`: the adjective is written without a blank; 0.7.0 fix5).
 */
const FAILURE_WORD =
  /^(?:(?:failed|not[ \t]+(?:verified|run))(?![a-z])|(?:fail(?:s|ing|ure)?|\u5931\u6557\u4e86?|\u672a\u9a57\u8b49)(?=[ \t]*(?:$|[(\uff08:\uff1a,\uff0c;\uff1b.\u3002!\uff01\u3001\u2014\u2013]|-(?:[ \t]|$)))|\u672a\u9a57\u8b49(?=[ \t]*(?:\u56e0|\u7531\u65bc|\u662f\u56e0)|\u904e|[ \t]+[\u4e00-\u9fff]))/i;
/**
 * A blank and an outcome word at the end of what stands before the first colon (`pnpm test failed: ...`), or before a
 * parenthesis (it may hold code spans) after which the words stop, punctuation follows, or a word that places the
 * failure or says what comes of it (`... failed (2 of 3)`, `... failed (2 of 14) on CI`, `... not run (no browser), will
 * run in CI`, `... failed (see `total()`)`; the zh-TW words too; 0.7.0 fix5). Not "fails" or "failing" there: `The API
 * answers 503 when the database fails: ...` names what a passed check looks at; nor an outcome word followed by other
 * words after a parenthesis (`Requests that failed (HTTP 503) are retried: ...`, 0.7.0 fix4). The blanks before the
 * parenthesis are read with it, and each place after it starts with its own run of blanks once: two runs of blanks
 * are never tried against each other.
 */
const FAILURE_WORD_AFTER =
  /[ \t](?:failed|not[ \t]+(?:verified|run)|\u5931\u6557\u4e86?|\u672a\u9a57\u8b49)(?:[ \t]*[(\uff08](?:[^()\uff08\uff09`]|`[^`]*`)*[)\uff09](?:[ \t]*(?:$|[,\uff0c;\uff1b.\u3002\u3001])|[ \t]+(?:on|in|at|after|since|and|see|will|until|again)(?![a-z]))|[ \t]*$)/i;
/**
 * The test runner's own verdict after the colon or dash (0.7.0 fix4): an upper-case FAIL before a file or a package
 * (`FAIL src/cart.test.ts`, `FAIL github.com/acme/cart 0.41s`), also as the start of a code span (0.7.0 fix5).
 * Case-sensitive: `FAIL 0, PASS 42` is a count, and a "fail" in lower case before more words is the behaviour
 * FAILURE_WORD leaves alone.
 */
const RUNNER_FAIL = /^FAIL[ \t]+[^\s\d]/;
/**
 * The runners' verdicts where they stand in their output, anywhere outside a code span (0.7.0 fix5): go test's `---
 * FAIL: TestTotal`, cargo's `test result: FAILED` at the end, pytest's `FAILED tests/test_cart.py::test_total`, jest's
 * `FAIL src/cart.test.js` after an arrow, `FAIL (`src/cart.test.ts`)`: an upper-case FAIL or FAILED after the start, a
 * blank, `>`, `|` or an arrow, and before a colon, the end, or a blank and anything but a digit. Case-sensitive, as
 * RUNNER_FAIL: `FAIL 0, PASS 42` and the zh-TW "FAIL before the fix, PASS after it" (FAIL before a full-width comma)
 * are no verdict; `FAIL -> PASS after the fix` reads as one, which costs a rewording. Each start reads one run of
 * blanks.
 */
const RUNNER_FAIL_ANYWHERE = /(?:^|[ \t>\u2192\u276f|])(?:---[ \t]+)?FAIL(?:ED)?(?::|[ \t]+[^\s\d]|$)/;
/**
 * A line with neither colon nor dash is all `<what>` (0.7.0 fix4): a behaviour word that ends it says the check failed
 * (`pnpm test fails`, `pnpm test FAIL (2 of 14)`, `pnpm test is failing (2 of 14)`), as it does after a colon. A
 * parenthesis that holds a command does not count: `Shows a toast when saving fails (`pnpm test toast`, 2 passed)`
 * names what a passed check looks at.
 */
const BEHAVIOUR_AT_END = /[ \t](?:fail(?:s|ing|ure)?|\u5931\u6557\u4e86?)(?:[ \t]*[(\uff08][^`()\uff08\uff09]*[)\uff09])?[ \t]*$/i;
/** A dash between blanks: what separates a check from what became of it (`pnpm test — failed: …`). */
const DASH_SEPARATOR = /[ \t][—–-]+(?=[ \t])/;

/** A code span: a command's own words (`pnpm vitest -t "2 tests fail"`) are no count of what became of the check. */
const CODE_SPAN = /`[^`\n]*`/g;

/** The parts of FAILURE_COUNT. A count that is not the end of a number or of a word (`v2`, `S3`, `1.5`), and not zero. */
const COUNT = String.raw`(?<![\p{L}\p{N}.])[1-9]\d*`;
/** What a runner counts, in front of its verb (`2 tests fail`, `2 unit tests failed`). */
const COUNTED = String.raw`(?:[ \t]+(?:unit|e2e|integration|type|lint|snapshot)(?![\p{L}\p{N}]))?[ \t]+(?:tests?|checks?|specs?|cases?|suites?|files?|assertions?|examples?|scenarios?|jobs?|steps?|packages?|runs?)(?![\p{L}\p{N}])`;
/** What follows a count's failure word: the words stop, punctuation, or a place or a reason (`2 tests fail in cart.test.ts`). */
const COUNT_END = String.raw`(?=[ \t]*(?:$|[^\p{L}\p{N}\s])|[ \t]+(?:in|on|at|with|because|since|and|remain|remaining|left|during)(?![\p{L}\p{N}]))`;
/** A word that may stand between a count and its noun (`3 type errors`, `2 test failures`). */
const KIND = String.raw`(?:[ \t]+(?:type|lint|test|unit|build|compile|compiler|runtime|syntax|tsc|eslint|e2e|previous)(?![\p{L}\p{N}]))?`;
/** The zh-TW words between a count's measure word and the word for failing or for errors: at most two, no number, no punctuation. */
const ZH_COUNTED = String.raw`(?:[ \t]*[^\s\d,\uff0c\u3002.;\uff1b:\uff1a()\uff08\uff09\u3001!\uff01?\uff1f\u0060]{1,12}?){0,2}?[ \t]*`;
/** What follows the zh-TW word for failing or for errors after a count: the words stop, punctuation, or "in" (and "-ed" after failing). */
const ZH_COUNT_END = String.raw`(?=\u5728|[ \t]*(?:$|[^\p{L}\p{N}\s]))`;
/**
 * A count of failures or errors that is not zero in a ticked check's words, read without the command (0.7.0 fix4, the
 * lead's addition to the last check's T1): `12 passed, 2 failed`, `2 of 14 failed`, `2/14 failed`, `2 tests fail in
 * cart.test.ts`, `2 tests are failing`, `2 tests still fail`, `2 failing`, `failed with 3 errors`, `1 error`, `1 error
 * during collection`, `due to 2 previous errors`, `2 failures in legacy.test.ts`, `pass 12, fail 2`, the runner's own
 * line quoted after the colon (`` `Tests  2 failed | 12 passed (14)` ``, or in quotes: `"2 failed, 21 passed"`, 0.7.0
 * fix6), and in zh-TW a count with its measure word before the word for failing or for errors, or after either word,
 * or a count of a total before the word for failing (0.7.0 fix5). A count of anything else is no failure (`fails with
 * exit code 1`, `retried up to 3 times`, `5 failed attempts lock the account`, `a 500 error page`), nor is one inside
 * quotes elsewhere (`shows "2 of 10 failed"`) or right after
 * "after" (`locks after 5 failures`), and neither is a zero (`0 failed`, `0 errors`, `no failures`). Numbers written as
 * words (`two tests fail`) are not read. Each alternative starts at a count or at a fixed word and reads a bounded
 * stretch after it, and no two of its runs of blanks stand side by side (`fail` + blanks + `x` is read once).
 */
const FAILURE_COUNT = new RegExp(
  [
    // a count and the runner's verb: `2 failed`, `2 of 14 failed`, `2/14 failed`, `2 tests fail in ...`, `2 failing`
    String.raw`${COUNT}(?:[ \t]+(?:of|out[ \t]+of)[ \t]+\d+|[ \t]*\/[ \t]*\d+)?(?:${COUNTED})?[ \t]+(?:(?:are|is|still|also)[ \t]+)?(?:failed|fail(?:s|ing)?)${COUNT_END}`,
    // a count and its noun, one or many as the noun says: `1 error`, `3 errors`, `2 lint errors`, `2 failures`
    String.raw`(?<![\p{L}\p{N}.])1${KIND}[ \t]+(?:failure|error)${COUNT_END}`,
    String.raw`${COUNT}${KIND}[ \t]+(?:failures|errors)${COUNT_END}`,
    // the runner's word, then its count: `fail 2` (node --test), `failures: 2`, `errors = 3`
    String.raw`(?<![\p{L}\p{N}])(?:fail(?:ed|ures|ing)?|errors)(?:[ \t]*[:=])?[ \t]*[1-9]\d*(?![\p{N}.])(?=[ \t]*(?:$|[,;)|\uff09\uff0c\uff1b]))`,
    // zh-TW: a count, its measure word, then the word for failing (also "-ed") or for errors; the word for failing or for
    // errors, then a count with its measure word; a count of a total, then the word for failing (`2/14 <failed>`)
    String.raw`${COUNT}[ \t]*[\u500b\u9805]${ZH_COUNTED}(?:\u5931\u6557(?:\u4e86|${ZH_COUNT_END})|\u932f\u8aa4${ZH_COUNT_END})`,
    String.raw`(?:\u5931\u6557\u4e86?|\u932f\u8aa4)[ \t]*[1-9]\d*[ \t]*[\u500b\u9805]`,
    String.raw`${COUNT}[ \t]*\/[ \t]*\d+[ \t]*\u5931\u6557`,
  ].join('|'),
  'iu',
);

/** The first code span of a line: the command of a check with neither colon nor dash, for the count only. */
const FIRST_CODE_SPAN = /`[^`\n]*`/;
/**
 * A quoted text, for the count only (`shows "2 of 10 failed" when two rows are bad`): words a check looks at. The
 * quote that opens the words after the colon or dash is also read kept (0.7.0 fix6, fix7): that is the runner's own
 * line there, quoted as a code span quotes it (`` `pnpm test`: "Tests  2 failed | 12 passed (14)" ``).
 */
const QUOTED = /"[^"\n]*"|\u201c[^\u201c\u201d\n]*\u201d|\u300c[^\u300c\u300d\n]*\u300d/g;
/** "after" before a number, for the count only (`locks after 5 failures`): when something happens, no count of what failed. */
const AFTER_NUMBER = /(?<![\p{L}\p{N}])after[ \t]+(?=\d)/giu;

/**
 * Whether the words of a ticked check say that it failed or did not run (0.7.0 verify; narrowed in the 0.7.0 last
 * check; 0.7.0 fix4, fix5, fix6, fix7): the words after `<what>` and its first colon (`:`, or the full-width one) or
 * dash outside its code spans (`pnpm test:unit`: failed) begin with a failure word as FAILURE_WORD reads it, or with
 * the runner's FAIL before a file; `<what>` itself ends with an outcome word (`pnpm test failed: …`); a line with
 * neither colon nor dash ends with a failure word (`pnpm test fails`); a runner's verdict stands where it prints it
 * (`--- FAIL: TestTotal`); or the words count failures or errors that are not zero (`12 passed, 2 failed`), read
 * without the command's code spans (those of `<what>`, or the first one of a line with neither colon nor dash: `pnpm
 * vitest -t "2 tests fail"`), with those after the colon or dash (the runner's own line, quoted), and without quoted
 * texts, then once more with the quote that opens the words after the colon or dash kept (the runner's line too, 0.7.0
 * fix6; past the blanks, the ideographic one too, 0.7.0 fix7). "14 passed, 0 failed" after a colon is a check that
 * passed, and so is one whose words name a failure it looks at. This is a net for the common ways a ticked line
 * contradicts itself, not a reading of every wording: the team's check at the end and the undo catch the rest. Each
 * expression reads at most 2,000 characters in one pass (the count at most twice): no expression here can try a run of
 * blanks again from each of its blanks, and a quote's body stops at its own opening mark, so that a run of opening
 * marks is not read again from each.
 */
function tickedSaysFailed(words: string): boolean {
  const text = words.slice(0, 2000);
  // (the line's colon and dash stand outside the code spans: `pnpm test:unit`: failed, `pnpm test -- --run`: failed;
  // 0.7.0 fix7. Each span is blanked to as many characters, so that a place in `plain` is the same place in `text`)
  const plain = text.replace(CODE_SPAN, (span: string) => '_'.repeat(span.length));
  const colon = plain.search(/[:\uff1a]/);
  const head = colon === -1 ? text : text.slice(0, colon);
  const dash = DASH_SEPARATOR.exec(colon === -1 ? plain : plain.slice(0, colon));
  if (dash !== null || colon > 0) {
    const rest = (dash !== null ? text.slice(dash.index + dash[0].length) : text.slice(colon + 1)).replace(/^[ \t]+/, '');
    if (FAILURE_WORD.test(rest) || RUNNER_FAIL.test(rest.startsWith('`') ? rest.slice(1) : rest)) return true;
  }
  if (FAILURE_WORD_AFTER.test(dash !== null ? head.slice(0, dash.index) : head)) return true;
  if (colon === -1 && dash === null && BEHAVIOUR_AT_END.test(text)) return true;
  if (RUNNER_FAIL_ANYWHERE.test(text.replace(CODE_SPAN, ' '))) return true;
  const cut = dash !== null ? dash.index : colon;
  const counted = cut === -1 ? text.replace(FIRST_CODE_SPAN, ' ') : text.slice(0, cut).replace(CODE_SPAN, ' ') + text.slice(cut);
  // (the count with every quoted text blanked: a blank in a quote's place also joins the words around it, `Lint errors:
  // "src/cart.ts" 2`, a zh-TW count, a dash, a quoted name and the word for failing; 0.7.0 fix7)
  if (FAILURE_COUNT.test(counted.replace(QUOTED, ' ').replace(AFTER_NUMBER, 'after x'))) return true;
  // (then, only when a quote opens the words after the colon or dash, past their blanks, the ideographic one too: read
  // again with that quote kept, the runner's own line; 0.7.0 fix6, fix7)
  let keep = cut === -1 ? -1 : counted.length - text.length + cut + (dash !== null ? dash[0].length : 1);
  while (keep !== -1 && (counted[keep] === ' ' || counted[keep] === '\t' || counted[keep] === '\u3000')) keep += 1;
  const opens = keep === -1 ? undefined : counted[keep];
  if (opens !== '"' && opens !== '\u201c' && opens !== '\u300c') return false;
  return FAILURE_COUNT.test(counted.replace(QUOTED, (quote: string, at: number) => (at === keep ? quote : ' ')).replace(AFTER_NUMBER, 'after x'));
}

function error(kind: ReportErrorKind, line: number): ReportError {
  // People read both outcome errors as "the outcome line" (`report.error.outcome`); the model reads which one.
  const outcomeLine = kind === 'outcome' || kind === 'outcome-failed';
  return { kind, line, text: outcomeLine ? msg('report.error.outcome', { line }) : msg('report.error.format', { line }), model: REPORT_ERROR_SENTENCES[kind] };
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
  const outcomeLine = Math.min(index + 1, Math.max(lines.length, 1));
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
      // The words as the agent wrote them are read; only their masked form is kept (0.7.0 fix4: masked first, `Refresh
      // token: failed (…)` lost its "failed" and merged as a passed check, and `- [!] Refresh token: failed: …` could
      // not be written at all). Nothing unmasked leaves this function: the errors are fixed sentences.
      const words = (check[2] as string).trim();
      // (a key block is masked whole before such a line is cut in two: its BEGIN and END lines could fall in different
      // parts, and neither part would then hold a whole block to mask; 0.7.0 fix5. A key holds no word read here)
      const parts = words.includes('PRIVATE KEY-----') ? mask(words) : words;
      if (check[1] === '!') {
        const failed = lineMatch(FAILED, parts);
        const what = failed === null ? '' : mask((failed[1] as string).trim());
        const happened = failed === null ? '' : mask((failed[2] as string).trim());
        if (what.length === 0 || happened.length === 0) {
          errors.push(error('verified-failed-why', lineNo));
          return;
        }
        verified.push({ text: wireMultiline(what, REPORT_CHECK_TEXT_MAX_CHARS), passed: false, failed: true, note: wireMultiline(happened, REPORT_CHECK_TEXT_MAX_CHARS) });
        return;
      }
      if (check[1] !== ' ') {
        // A ticked box whose own words say the check failed or did not run (`- [x] pnpm test: failed: …`) is no check
        // that passed: the agent writes the line it means (0.7.0 review; smurg merges by itself on a passed check).
        if (lineMatch(FAILED, words) !== null || lineMatch(NOT_VERIFIED, words) !== null || tickedSaysFailed(words)) {
          errors.push(error('verified-ticked', lineNo));
          return;
        }
        verified.push({ text: wireMultiline(mask(words), REPORT_CHECK_TEXT_MAX_CHARS), passed: true });
        return;
      }
      const not = lineMatch(NOT_VERIFIED, parts);
      const what = not === null ? '' : mask((not[1] as string).trim());
      const whyNot = not === null ? '' : mask((not[2] as string).trim());
      if (what.length === 0 || whyNot.length === 0) {
        errors.push(error('verified-why', lineNo));
        return;
      }
      verified.push({ text: wireMultiline(what, REPORT_CHECK_TEXT_MAX_CHARS), passed: false, note: wireMultiline(whyNot, REPORT_CHECK_TEXT_MAX_CHARS) });
    });
    if (verified.length === 0 && !errors.some((entry) => entry.kind === 'verified-why' || entry.kind === 'verified-failed-why' || entry.kind === 'verified-ticked')) errors.push(error('verified-none', verifiedSection.line));
    if (verified.length > REPORT_CHECKS_MAX) errors.push(error('verified-too-many', verifiedSection.line));
  }
  // A failed check and a complete outcome cannot both stand: the outcome line is what the agent fixes.
  const failed = verified.filter((check) => check.failed === true).length;
  if (outcome === 'complete' && failed > 0) errors.push(error('outcome-failed', outcomeLine));

  if (errors.length > 0 || outcome === null || done === undefined || why === undefined || watchOut === undefined) {
    return { ok: false, errors: errors.sort((a, b) => a.line - b.line) };
  }
  const passed = verified.filter((check) => check.passed).length;
  return {
    ok: true,
    report: {
      outcome,
      sections: { done, why, verified, watchOut, ...(followUps === undefined ? {} : { followUps }) },
      checks: { passed, notVerified: verified.length - passed - failed, ...(failed > 0 ? { failed } : {}) },
    },
  };
}
