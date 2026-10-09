// What the topic screens say about a topic, a plan and its work items, as pure functions of the wire's entities
// (tested without rendering). Every sentence is composed here from structured fields in the viewer's language
// (DESIGN §5.10: plan badges, the Start dialog's lines and the report's headings are web catalogue text; nothing
// parses a fallback). The daemon decides what may happen; this is display only.
import {
  MAIN_ROOT,
  can,
  topicPlanPath,
  topicSpecPath,
  type AgentSession,
  type FileRef,
  type HandEdit,
  type Member,
  type PlanInfo,
  type ReportSummary,
  type Role,
  type Topic,
  type UserRef,
  type WorkItem,
} from '@smurg/protocol';
import { msg, renderEnglish, reportOutcomeRef } from '@smurg/protocol/i18n';
import { intlTag } from '@smurg/protocol/locale';
import { itemLabel } from '../../lib/columns/describe.ts';
import { renderWireText } from '../../lib/errors.ts';
import { formatAge, formatAnd, formatDateTime, formatRole } from '../../lib/format.ts';
import { getLocale } from '../../lib/locale.ts';
import type { Tone } from '../../ui/index.ts';
import { t } from './strings.ts';

// ---------------------------------------------------------------------------------------------------------------
// Lists inside a sentence
// ---------------------------------------------------------------------------------------------------------------

/** The key suffix of a sentence that differs for one and for several where the number itself is not shown. */
export const oneOrMany = (count: number): 'one' | 'many' => (count === 1 ? 'one' : 'many');

const clocks = new Map<string, Intl.DateTimeFormat>();

/** "14:05" for a time of today; the date as well for an earlier day. */
export function formatClock(at: number, now: number = Date.now()): string {
  const sameDay = new Date(at).toDateString() === new Date(now).toDateString();
  if (!sameDay) return formatDateTime(at);
  const tag = intlTag(getLocale());
  let clock = clocks.get(tag);
  if (!clock) {
    clock = new Intl.DateTimeFormat(tag, { hour: '2-digit', minute: '2-digit', hour12: false });
    clocks.set(tag, clock);
  }
  return clock.format(at);
}

// ---------------------------------------------------------------------------------------------------------------
// Files
// ---------------------------------------------------------------------------------------------------------------

/** `specs/<slug>/SPEC.md` in the main workspace: a discussion exists only there. */
export function specFile(topic: Pick<Topic, 'slug'>): FileRef {
  return { root: MAIN_ROOT, path: topicSpecPath(topic.slug) };
}

export function planFile(topic: Pick<Topic, 'slug'>): FileRef {
  return { root: MAIN_ROOT, path: topicPlanPath(topic.slug) };
}

// ---------------------------------------------------------------------------------------------------------------
// People
// ---------------------------------------------------------------------------------------------------------------

type Person = Pick<Member, 'userId' | 'displayName' | 'role'>;

/** The host and the members with agent access, the host first: who allows commands and may start work. */
export function agentAccessPeople<P extends Person>(members: readonly P[]): P[] {
  return members.filter((member) => can(member.role, 'session.drive')).sort((a, b) => Number(b.role === 'host') - Number(a.role === 'host'));
}

/** Their names as one phrase: "Ian and Mei". Nobody known yet: "the host". */
export function agentAccessNames(members: readonly Person[]): string {
  const people = agentAccessPeople(members);
  return people.length === 0 ? t('people.host') : formatAnd(people.map((member) => member.displayName));
}

/** Who may be made responsible for an item: every member holding `discuss` (routing only, DESIGN §3.9). */
export function assignablePeople<P extends Person>(members: readonly P[]): P[] {
  const order: Record<Role, number> = { host: 0, agent: 1, editor: 2, viewer: 3 };
  return members.filter((member) => can(member.role, 'discuss')).sort((a, b) => order[a.role] - order[b.role]);
}

/** How many items of the plan each person is responsible for (items still in the plan). */
export function loads(plan: Pick<PlanInfo, 'items'>): Map<string, { user: UserRef; count: number }> {
  const out = new Map<string, { user: UserRef; count: number }>();
  for (const item of plan.items) {
    if (!item.inPlan || item.responsible === null) continue;
    const entry = out.get(item.responsible.userId);
    if (entry) entry.count += 1;
    else out.set(item.responsible.userId, { user: { userId: item.responsible.userId, displayName: item.responsible.displayName }, count: 1 });
  }
  return out;
}

/** "Host · 2 items": the hint of a person in the "responsible" menu. */
export function assignHint(member: Person, count: number): string {
  return t('assign.hint', { role: formatRole(member.role), items: t('assign.items', { count }) });
}

// ---------------------------------------------------------------------------------------------------------------
// Work items
// ---------------------------------------------------------------------------------------------------------------

const byId = (plan: Pick<PlanInfo, 'items'>): Map<string, WorkItem> => new Map(plan.items.map((item) => [item.id, item]));

/** "1 and 2": the numbers of the items with these ids, in plan order (an id the plan no longer has is left out). */
export function itemNumbers(plan: Pick<PlanInfo, 'items'>, ids: readonly string[]): string {
  const items = byId(plan);
  const numbers = ids
    .map((id) => items.get(id)?.number)
    .filter((n): n is number => n !== undefined && n > 0)
    .sort((a, b) => a - b);
  return formatAnd(numbers.map(String));
}

/** "1 · Cart API" of the items with these ids, as one phrase. */
export function itemNames(plan: Pick<PlanInfo, 'items'>, ids: readonly string[]): string {
  const items = byId(plan);
  return formatAnd(ids.map((id) => items.get(id)).filter((item): item is WorkItem => item !== undefined).map((item) => itemLabel(item)));
}

export const isMerged = (item: Pick<WorkItem, 'merge'>): boolean => item.merge?.status === 'merged';
/**
 * The item's review stands: it was reviewed and its report still is. A report that changed after its review, or can no
 * longer be read, asks for the review again while the item keeps the state `reviewed`: the host's smurg counts
 * "N of M reviewed" and decides the topic's phase by the report, and so does everything here.
 */
export const reviewStands = (item: Pick<WorkItem, 'state' | 'report'>): boolean => item.state === 'reviewed' && (item.report === undefined || item.report.state === 'reviewed');
/** The item has run at least once (it has a session, a report or an attempt). */
export const wasStarted = (item: Pick<WorkItem, 'state' | 'attempt' | 'armed'>): boolean => item.state !== 'not-started' || item.attempt > 0;

/** The ids an item still waits for: what it depends on and is not merged yet. */
export function unmergedDependencies(plan: Pick<PlanInfo, 'items'>, item: Pick<WorkItem, 'dependsOn' | 'waitsFor'>): string[] {
  if (item.waitsFor !== undefined) return [...item.waitsFor];
  const items = byId(plan);
  return item.dependsOn.filter((id) => {
    const dependency = items.get(id);
    return dependency !== undefined && !isMerged(dependency);
  });
}

export interface ItemBadge {
  readonly text: string;
  readonly tone: Tone;
  /** What the progress bar shows for the item. */
  readonly bar: 'reviewed' | 'report' | 'running' | 'wait' | 'failed' | 'none';
  /** A person must act before this item goes on. */
  readonly waitsForPerson: boolean;
}

/**
 * The follow-up that still asks for something: a message sent from the report after its newest version
 * (`WorkItem.changesAsked`, kept by the host's smurg until the agent writes a new version). Once the report was
 * reviewed AFTER that message, the reviewer has taken the version as it is (the follow-up was a question, and its
 * answer is in the report): the item is reviewed, and nothing says "changes asked" any more.
 */
export function openChangesAsked(item: Pick<WorkItem, 'changesAsked' | 'report'>): WorkItem['changesAsked'] {
  const asked = item.changesAsked;
  if (asked === undefined) return undefined;
  const report = item.report;
  return report !== undefined && report.state === 'reviewed' && report.review !== undefined && report.review.at >= asked.at ? undefined : asked;
}

function reportBadge(item: WorkItem, report: ReportSummary): ItemBadge {
  const asked = openChangesAsked(item);
  if (asked !== undefined) return { text: t('badge.changesAsked', { name: asked.by.displayName }), tone: 'info', bar: 'running', waitsForPerson: false };
  if (report.state === 'invalid') return { text: t('badge.reportInvalid'), tone: 'danger', bar: 'failed', waitsForPerson: true };
  if (report.state === 'changed-after-review') return { text: t('badge.changedAfterReview'), tone: 'warning', bar: 'report', waitsForPerson: false };
  if (report.outcome === 'complete') return { text: t('badge.report'), tone: 'success', bar: 'report', waitsForPerson: false };
  return { text: t('badge.reportUnfinished', { outcome: outcomeLabel(report.outcome).toLocaleLowerCase() }), tone: 'warning', bar: 'report', waitsForPerson: false };
}

/** "Complete", "Partial", "Blocked" (the wire catalogue's wording, shared with the CLI). */
export function outcomeLabel(outcome: ReportSummary['outcome']): string {
  return renderWireText(reportOutcomeRef(outcome), outcome);
}

/**
 * The one badge of a work item (DESIGN §5.12 item 20). `session`: the item's session when the list knows it (a
 * running item says which kind of waiting).
 */
export function itemBadge(item: WorkItem, plan: Pick<PlanInfo, 'items' | 'slots'>, session?: Pick<AgentSession, 'status'>): ItemBadge {
  const waits = unmergedDependencies(plan, item);
  switch (item.state) {
    case 'not-started': {
      if (item.disarmed === 'plan-changed') return { text: t('badge.planChanged'), tone: 'warning', bar: 'wait', waitsForPerson: true };
      if (item.disarmed === 'starter-removed') return { text: t('badge.starterRemoved'), tone: 'warning', bar: 'wait', waitsForPerson: true };
      if (item.disarmed === 'start-failed') return { text: t('badge.startFailed'), tone: 'danger', bar: 'failed', waitsForPerson: true };
      if (waits.length > 0) return { text: t('badge.waits', { items: itemNumbers(plan, waits) }), tone: 'neutral', bar: 'none', waitsForPerson: false };
      return { text: t('badge.ready'), tone: 'neutral', bar: 'none', waitsForPerson: false };
    }
    case 'waiting': {
      const items = byId(plan);
      // Everything it waits for was reviewed: only the host's merge is missing.
      const onlyMerge = waits.length > 0 && waits.every((id) => {
        const dependency = items.get(id);
        return dependency !== undefined && reviewStands(dependency);
      });
      return { text: t(onlyMerge ? 'badge.waitsMerge' : 'badge.waits', { items: itemNumbers(plan, waits) }), tone: 'neutral', bar: 'none', waitsForPerson: false };
    }
    case 'queued':
      return {
        text: t('badge.queued', { inUse: plan.slots.inUse, max: plan.slots.max, people: t('badge.queued.people', { count: plan.slots.waitingForPeople }) }),
        tone: 'neutral',
        bar: 'none',
        waitsForPerson: false,
      };
    case 'running':
      if (session?.status === 'waiting-answer') return { text: t('badge.question'), tone: 'warning', bar: 'wait', waitsForPerson: true };
      if (session?.status === 'waiting-permission') return { text: t('badge.permission'), tone: 'warning', bar: 'wait', waitsForPerson: true };
      return { text: t('badge.running'), tone: 'info', bar: 'running', waitsForPerson: false };
    case 'stalled':
      return { text: t(`badge.stalled.${item.stalledBy ?? 'agent'}`), tone: 'warning', bar: 'wait', waitsForPerson: true };
    case 'done':
      return item.report === undefined ? { text: t('badge.done'), tone: 'success', bar: 'report', waitsForPerson: false } : reportBadge(item, item.report);
    case 'reviewed': {
      if (!reviewStands(item) || openChangesAsked(item) !== undefined) return reportBadge(item, item.report as ReportSummary);
      const reviewed = 'reviewed' as const;
      if (item.merge?.status === 'merged') return { text: t('badge.merged'), tone: 'success', bar: reviewed, waitsForPerson: false };
      if (item.merge?.status === 'conflict') return { text: t('badge.conflict'), tone: 'danger', bar: reviewed, waitsForPerson: true };
      if (item.merge?.status === 'rejected') return { text: t('badge.mergeRejected'), tone: 'warning', bar: reviewed, waitsForPerson: false };
      if (item.merge !== undefined) return { text: t('badge.reviewedWaitsMerge'), tone: 'success', bar: reviewed, waitsForPerson: false };
      return { text: t('badge.reviewed'), tone: 'success', bar: reviewed, waitsForPerson: false };
    }
    case 'failed':
      return { text: t('badge.failed'), tone: 'danger', bar: 'failed', waitsForPerson: true };
    case 'stopped':
      return { text: t('badge.stopped'), tone: 'neutral', bar: 'wait', waitsForPerson: true };
  }
}

/** What a person can do with an item from its row (the role decides which of them show). */
export interface ItemActions {
  /** "Session": the item has one. */
  readonly session: string | null;
  /** "Report": the item has a report. */
  readonly report: boolean;
  /** "Try again": a failed or stopped item (`plan.item.retry`). */
  readonly retry: boolean;
  /** "Continue": a session that stopped without a report (`plan.item.continue`). */
  readonly continue: boolean;
  /** "Start this one": not started, nothing to wait for. */
  readonly start: boolean;
  /** "Start again": armed once, then disarmed (the plan changed, the starter went, the start failed). */
  readonly startAgain: boolean;
  /** "Ask the agent to resolve": the merge stopped on a conflict (`plan.item.resolve`). */
  readonly resolve: boolean;
}

export function itemActions(item: WorkItem, plan: Pick<PlanInfo, 'items'>): ItemActions {
  const notStarted = item.state === 'not-started' && item.inPlan;
  return {
    session: item.sessionId ?? null,
    report: item.report !== undefined,
    retry: item.state === 'failed' || item.state === 'stopped',
    continue: item.state === 'stalled',
    start: notStarted && item.disarmed === undefined && !item.armed && unmergedDependencies(plan, item).length === 0,
    startAgain: notStarted && item.disarmed !== undefined,
    resolve: item.merge?.status === 'conflict',
  };
}

// ---------------------------------------------------------------------------------------------------------------
// The plan as a whole
// ---------------------------------------------------------------------------------------------------------------

export interface PlanSummary {
  /** Items the plan file lists. */
  readonly total: number;
  /** Something was started (the plan shows progress instead of "what can start"). */
  readonly started: boolean;
  /** Not started, nothing to wait for. */
  readonly canStart: number;
  /** Not started, waits for another item. */
  readonly waitsOthers: number;
  /** Ids of the items a Start without ids would arm: in the plan, not started, not armed. */
  readonly startable: readonly string[];
  readonly reviewed: number;
  readonly merged: number;
  readonly toReview: number;
  readonly waitPerson: number;
  readonly running: number;
  readonly notStarted: number;
  /** Items whose review stands and whose change the host has not merged. */
  readonly reviewedNotMerged: readonly WorkItem[];
}

export function planSummary(plan: Pick<PlanInfo, 'items' | 'slots'>, sessionOf: (item: WorkItem) => Pick<AgentSession, 'status'> | undefined): PlanSummary {
  const items = plan.items.filter((item) => item.inPlan);
  let canStart = 0;
  let waitsOthers = 0;
  let reviewed = 0;
  let merged = 0;
  let toReview = 0;
  let waitPerson = 0;
  let running = 0;
  let notStarted = 0;
  const startable: string[] = [];
  const reviewedNotMerged: WorkItem[] = [];
  for (const item of items) {
    const badge = itemBadge(item, plan, sessionOf(item));
    if (item.state === 'not-started' && !item.armed) {
      startable.push(item.id);
      if (unmergedDependencies(plan, item).length === 0) canStart += 1;
      else waitsOthers += 1;
    }
    if (item.state === 'not-started' || item.state === 'waiting' || item.state === 'queued') notStarted += 1;
    if (reviewStands(item)) {
      reviewed += 1;
      if (isMerged(item)) merged += 1;
      else if (item.merge !== undefined) reviewedNotMerged.push(item);
    }
    if (item.state === 'done' || (item.state === 'reviewed' && item.report?.state === 'changed-after-review')) toReview += 1;
    if (badge.waitsForPerson && item.state !== 'not-started') waitPerson += 1;
    else if (item.state === 'running') running += 1;
  }
  return { total: items.length, started: items.some(wasStarted), canStart, waitsOthers, startable, reviewed, merged, toReview, waitPerson, running, notStarted, reviewedNotMerged };
}

/** "1 report to review · 3 wait for a person · 1 running · 1 not started": what is going on, zero parts left out. */
export function progressLine(summary: PlanSummary): string {
  const parts: string[] = [];
  if (summary.toReview > 0) parts.push(t('summary.toReview', { count: summary.toReview }));
  if (summary.waitPerson > 0) parts.push(t('summary.waitPerson', { count: summary.waitPerson }));
  if (summary.running > 0) parts.push(t('summary.running', { count: summary.running }));
  if (summary.notStarted > 0) parts.push(t('summary.notStarted', { count: summary.notStarted }));
  if (summary.merged > 0) parts.push(t('summary.merged', { count: summary.merged }));
  return parts.join(t('sep'));
}

/**
 * "Ian 1 question (6 min) · Mei 1 permission request (40 sec)" from `PlanInfo.waitingFor`; '' when nobody is waited
 * for. The time is the age every other place prints for the same wait (the card, the status bar, the inbox row).
 */
export function waitingForLine(plan: Pick<PlanInfo, 'waitingFor'>, now: number): string {
  return plan.waitingFor
    .map((entry) => {
      const what: string[] = [];
      if (entry.questions > 0) what.push(t('waiting.questions', { count: entry.questions }));
      if (entry.permissions > 0) what.push(t('waiting.permissions', { count: entry.permissions }));
      if (entry.reports > 0) what.push(t('waiting.reports', { count: entry.reports }));
      return t('waiting.person', { name: entry.user.displayName, what: formatAnd(what), time: formatAge(entry.since, now) });
    })
    .join(t('sep'));
}

/** "Item 6 starts by itself when 1 and 2 are merged." for the items that wait (at most three sentences). */
export function startsByItselfLines(plan: Pick<PlanInfo, 'items'>): string[] {
  const lines: string[] = [];
  for (const item of plan.items) {
    if (!item.inPlan || isMerged(item)) continue;
    const waits = unmergedDependencies(plan, item);
    const pending = item.state === 'waiting' || (item.state === 'not-started' && item.disarmed === undefined);
    if (pending && waits.length > 0) lines.push(t(`foot.startsByItself.${oneOrMany(waits.length)}`, { number: item.number, items: itemNumbers(plan, waits) }));
  }
  return lines.slice(0, 3);
}

const NOT_A_GIT_REPO = msg('worktree.unavailable.notAGitRepo');
const GIT_DIR_GONE = msg('worktree.unavailable.gitDirGone');

/**
 * The plan's foot while the shared folder is not a git repository (`Topic.versioned` false; it follows the folder
 * while it is shared): why no item can start, in the words of the Start dialog's blocker and of a worktree refusal
 * (one message per reason, saying what the host can do). `gone`: a worktree or an open merge request exists
 * (selectHasWorktreeRecords), so the folder's `.git` went: "put it back", never "run git init", as the Start dialog
 * says then. A repository that cannot hold worktrees for another reason (no commit yet, git missing or too old, a
 * `.git` that is no ordinary folder) is told by the Start dialog: only the host's preflight knows it.
 */
export function notVersionedLine(gone = false): string {
  const reason = gone ? GIT_DIR_GONE : NOT_A_GIT_REPO;
  return t('foot.noGit', { reason: renderWireText(reason, renderEnglish(reason)) });
}

/** "Ian 2 · Mei 2 · Ken 2": the split, by load. */
export function splitLine(plan: Pick<PlanInfo, 'items'>): string {
  return [...loads(plan).values()].map((entry) => t('split.load', { name: entry.user.displayName, count: entry.count })).join(t('sep'));
}

// ---------------------------------------------------------------------------------------------------------------
// The spec
// ---------------------------------------------------------------------------------------------------------------

export interface SpecSection {
  /** The heading's text; null for what stands before the first `##` heading (the title and the lead). */
  readonly heading: string | null;
  /** The section's Markdown, heading line included. */
  readonly text: string;
}

// Everything below looks at SPEC.md as it is on screen: text anyone with write access (or an agent) wrote, as long as
// a file may be, at every mount of the column and every change of the text. So each look at a line is one pass over
// its characters. An expression such as `^## +(.*?)(?: +#+)? *$` is tried again from every space of a long run and
// costs the square of the line's length: one line of 64,000 spaces held the column for three seconds (review R4-03).

const FENCE = /^ {0,3}(`{3,}|~{3,})/;
const isBlank = (char: string | undefined): boolean => char === ' ' || char === '\t';

/**
 * The text of a `## ` heading line, or null when the line is not one: what follows `## ` without the spaces around
 * it and without a closing run of `#` that a space sets apart (`## Payments ##`).
 */
function sectionHeading(line: string): string | null {
  if (!line.startsWith('## ')) return null;
  let end = line.length;
  while (end > 2 && line[end - 1] === ' ') end -= 1;
  let hashes = end;
  while (hashes > 2 && line[hashes - 1] === '#') hashes -= 1;
  if (hashes < end && line[hashes - 1] === ' ') end = hashes;
  return line.slice(3, end).trim();
}

/**
 * The spec's text cut at its `##` headings, so each section can be asked about on its own ("Ask the agent to revise
 * this section"). A `##` inside a code fence is not a heading. Joining the sections' texts with a line break gives
 * the text back.
 */
export function specSections(text: string): SpecSection[] {
  const sections: { heading: string | null; lines: string[] }[] = [{ heading: null, lines: [] }];
  let fence: string | null = null;
  for (const line of text.split('\n')) {
    const mark = FENCE.exec(line)?.[1];
    if (mark !== undefined) {
      if (fence === null) fence = mark;
      else if (mark[0] === fence[0] && mark.length >= fence.length) fence = null;
    }
    const heading = fence === null ? sectionHeading(line) : null;
    if (heading !== null) sections.push({ heading, lines: [line] });
    else (sections[sections.length - 1] as { lines: string[] }).lines.push(line);
  }
  return sections.filter((section, index) => index > 0 || section.lines.some((line) => line.trim() !== '')).map((section) => ({ heading: section.heading, text: section.lines.join('\n') }));
}

/** How many `#` begin `line` when it is a heading line (one to six, then a space or a tab); 0 otherwise. */
function headingDepth(line: string): number {
  let depth = 0;
  while (depth < line.length && line[depth] === '#') depth += 1;
  return depth >= 1 && depth <= 6 && isBlank(line[depth]) ? depth : 0;
}

const OPEN_QUESTIONS = 'open questions';

/** `## Open questions`, in any case, with an optional closing run of `#`. */
function isOpenQuestionsHeading(line: string): boolean {
  let at = headingDepth(line);
  if (at === 0) return false;
  while (isBlank(line[at])) at += 1;
  if (line.slice(at, at + OPEN_QUESTIONS.length).toLowerCase() !== OPEN_QUESTIONS) return false;
  at += OPEN_QUESTIONS.length;
  while (isBlank(line[at])) at += 1;
  while (line[at] === '#') at += 1;
  while (isBlank(line[at])) at += 1;
  return at === line.length;
}

/** What follows the marker of a list entry (`- `, `* `, `+ `, `1. `, `2) `), or null when `entry` is not one. */
function afterListMarker(entry: string): string | null {
  let at = 0;
  if (entry[0] === '-' || entry[0] === '*' || entry[0] === '+') at = 1;
  else {
    while (at < entry.length && (entry[at] as string) >= '0' && (entry[at] as string) <= '9') at += 1;
    if (at === 0 || (entry[at] !== '.' && entry[at] !== ')')) return null;
    at += 1;
  }
  if (!isBlank(entry[at])) return null;
  while (isBlank(entry[at])) at += 1;
  return at < entry.length ? entry.slice(at) : null;
}

/** "None", "Nothing", "n/a", with or without a full stop: an entry that lists no question. */
const SAYS_NONE: ReadonlySet<string> = new Set(['none', 'nothing', 'n/a', 'none.', 'nothing.', 'n/a.']);
const saysNone = (words: string): boolean => words.length <= 8 && SAYS_NONE.has(words.toLowerCase());

/**
 * How many open questions the spec lists under its "Open questions" heading: the rule of the daemon's Start
 * preflight (`StartPreflight.specOpenQuestions`), applied to the text on screen for the hint before "Generate plan".
 * List entries count one each ("None" does not); prose without a list counts as one.
 */
export function specOpenQuestions(text: string): number {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const start = lines.findIndex(isOpenQuestionsHeading);
  if (start === -1) return 0;
  let bullets = 0;
  let prose = 0;
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index] as string;
    if (headingDepth(line) > 0) break;
    const entry = line.trim();
    if (entry.length === 0) continue;
    const listed = afterListMarker(entry);
    if (listed !== null) {
      if (!saysNone(listed)) bullets += 1;
    } else if (!saysNone(entry)) prose += 1;
  }
  return bullets > 0 ? bullets : prose > 0 ? 1 : 0;
}

// ---------------------------------------------------------------------------------------------------------------
// Hand edits
// ---------------------------------------------------------------------------------------------------------------

/** "Amy (SPEC.md, 14:12), Mei (SPEC.md, 14:03)": who edited the two files by hand, newest first. */
export function handEditsLine(edits: { readonly spec: readonly HandEdit[]; readonly plan: readonly HandEdit[] }, now: number = Date.now()): string {
  const all = [...edits.spec.map((edit) => ({ ...edit, file: 'SPEC.md' })), ...edits.plan.map((edit) => ({ ...edit, file: 'PLAN.md' }))].sort((a, b) => b.at - a.at);
  return formatAnd(all.map((edit) => t('handEdit.entry', { name: edit.by === 'outside' ? t('handEdit.outside') : edit.by.displayName, file: edit.file, time: formatClock(edit.at, now) })));
}
