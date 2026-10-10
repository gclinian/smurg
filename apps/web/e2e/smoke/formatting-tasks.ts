// How conversation.perf.smoke.test.ts judges a page that formats texts while it is idle (features/markdown/idle.ts):
// from the tasks Chrome reports (every task longer than 50 ms: when it began and how long it took) and from what the
// page's document showed at each of its changes. The rule is apart from the smoke so that it has a test of its own
// that needs no browser (apps/web/test/formatting-tasks.test.ts): it is judged on machines that are slow and busy,
// and it was wrong in both directions when it looked at the durations of ONE page only, and in a third way when it
// looked at all the pages together only.
//
//   - Too strict when few tasks ran. "Nine tasks in ten are under the bound" allows no task over it among ten or
//     fewer: of nine tasks the ninth in ten IS the longest, and the longest task of a page is what a busy machine
//     makes long with nothing wrong (a macOS runner on 2026-10-09: 617 ms among nine tasks of about 107 ms, in a run
//     whose other pages had single tasks of 476 to 787 ms and passed). So the tasks are counted over EVERY page so
//     far: one in ten may have been held by a pause of the machine, and one in any case (a single pause is never a
//     finding).
//   - Too lenient when every task is long. A bound that is a multiple of the usual task grows with the tasks: with
//     every task at 2 s none was over it, and one task of 22 s alone was its own usual task. So the usual task has a
//     bound of its own, the budget at this machine's speed, and the texts ONE task formatted are counted.
//   - Too lenient, counted over every page only, when the held tasks come on one small page: they are lost among the
//     hundreds of the others. A queue whose last three texts held the page for half a second each made 15 held tasks
//     of 362, three of them among the ten of the last page: nothing against "one in ten of all of them", and what
//     the rule for one page had been right to fail. So the newest page has an allowance of its own as well, and how
//     large it can be without failing a machine that is only busy is worked out at `heldOfOnePage`.

/** The page at one change of its document: its clock (ms), the texts that are mounted, the texts that wait to be formatted. */
export type DocumentChange = readonly [at: number, texts: number, waiting: number];

/** A task as Chrome reports it: when it began, by the page's clock, and how long it took (ms, cut to a whole one). */
export type LongTask = readonly [start: number, duration: number];

/** When one page of texts was being formatted, by the page's clock: from the frame that showed it until none waited. */
export type Stretch = readonly [from: number, until: number];

/**
 * How many texts one task may format. A slice ends after the first text that left it longer than SLICE_MS (idle.ts,
 * 30 ms), and the texts of the smoke take about 70 ms each on the machine the budgets were set on: one text a task,
 * on that machine and on every slower one. Two fit into a slice on a machine more than twice as fast, three on one
 * nearly five times as fast: there this number is too small, and the smoke would fail with nothing wrong.
 */
export const TEXTS_A_TASK = 2;

/**
 * How many times what makes it held a task of the newest page may take when it is not the only one that does. A
 * pause of the machine is seldom that long (in 164 pages of 33 runs, on the runner and on a machine made busy on
 * purpose, the longest task of a page took 2.3 times `atMost` at the most), and two such pauses on one page are not
 * pauses: a queue whose last two texts held the page 2.5 s each has two held tasks a page, which the count allows.
 */
export const FAR_OVER = 4;

/** How many of the tasks of EVERY page so far may be held (take `atMost` or longer): one in ten, and one in any case. */
export const heldOfAll = (tasks: number): number => Math.max(1, Math.floor(tasks / 10));

/**
 * How many of the tasks of ONE page may be held: two, or a fifth of them (rounded up) where that is more.
 *
 * It cannot be fewer. Say a busy machine holds each task with the same chance, whatever became of the others. The
 * smoke's five pages have about 119, 62, 49, 119 and 9 or 10 tasks; a machine made busy on purpose held 10 to 15 of
 * about 365 (3 to 4 %), the runner above between 4 and 26 of 370 (what it printed says no more). How many runs in
 * 1,000 then fail with nothing wrong (every page judged when it is the newest, the bound over every page included:
 * by itself that one fails 1.0 at 3.5 % and 17 at 5 %):
 *
 *     each task is held with a chance of           2 %          3.5 %        5 %
 *     one, or one in ten rounded down              16 to 19     72 to 80     217 to 229
 *     two, or one in five rounded up (this one)    0.6 to 0.9   4.1 to 5.3   25 to 28
 *     three, or one in five                        0.02 to 0.04 1.2 to 1.3   18
 *
 * (the two numbers: a last page of 9 and of 10 tasks. The rule this module replaced, no held task among ten or
 * fewer, failed 166 to 401 on that page alone.)
 *
 * And it cannot be more, which is why one run in about two hundred is the price on a machine that holds 3.5 % of its
 * tasks (one in more than a thousand where it holds 2 %). Three held tasks among the seven to ten of the last page
 * are what this bound is here for (the queue above), and a busy machine does hold three or more of ten tasks 4.3
 * times in 1,000 at 3.5 %: whatever counts the held tasks of that page and fails three of ten fails a busy machine
 * that often. "One in five" for the larger pages, rounded up: with it no size of page fails more often by itself
 * than the page of ten does (rounded down, a page of 14 would: 12 in 1,000; one in six, a page of 12: 7).
 *
 * What the runner itself does is less than the machine that was made busy: in its 19 runs of 2026-10-07 to 10-09
 * (what each printed: its tasks, the usual one, the one at nine tenths, the longest) 43 of the 95 pages had a held
 * task, which is what a chance of about 1 in 100 for each task makes of pages of these sizes, and four of the 19
 * last pages (8 to 14 tasks) had one. At 1 % a run in about ten thousand fails with nothing wrong; at 1.5 %, one in
 * three thousand.
 *
 * One thing those runs show that the chance of a single task does not: a runner is slow for a while. One last page
 * of 13 tasks had a usual task of 190 ms where the pages before it had 103 to 134, and its two longest took 507 and
 * 539 ms: by the usual task of ALL the pages (4 * 108 ms) both were held, and so was every other task of that page
 * of 432 ms or more, with nothing wrong but a slow moment. So a task of the newest page counts as held by the usual
 * task of its own page as well (`judgeFormatting`), as it did in the rule before this one.
 */
export const heldOfOnePage = (tasks: number): number => Math.max(2, Math.ceil(tasks / 5));

export interface Formatting {
  /** Every task Chrome has reported since the page began to keep them: all that took longer than 50 ms. */
  readonly reported: readonly LongTask[];
  /** Every change of the document since then. */
  readonly changes: readonly DocumentChange[];
  /** When each page of texts so far was being formatted, the newest last. */
  readonly pages: readonly Stretch[];
  /** What a task may take (ms): the budget of the machine it was set on, times how much slower this machine is. */
  readonly budget: number;
}

export interface Verdict {
  /**
   * The tasks that ran while the texts of the pages so far were being formatted: the reported ones that began then,
   * and one for every change of the document in that time that lies in no reported task (a task of 50 ms or less).
   */
  readonly tasks: number;
  /** The most texts one task formatted (the changes of the document, and for a reported task the clock: see below). */
  readonly atOnce: number;
  /** How long the middle one of `tasks` took: 0 when it is one that Chrome did not report. */
  readonly usual: number;
  /** What one task may take before it counts as held: the budget, or four usual tasks on a machine that is uneven. */
  readonly atMost: number;
  /** How many of `tasks` took that long or longer … */
  readonly over: number;
  /** … and how many may (`heldOfAll`). */
  readonly mayBeOver: number;
  /** The newest page alone: its tasks … */
  readonly newestTasks: number;
  /** … what one of them may take before it counts as held: `atMost`, or four usual tasks of this page where that is more … */
  readonly newestAtMost: number;
  /** … how many took that long or longer, and how many may (`heldOfOnePage`) … */
  readonly newestOver: number;
  readonly newestMayBeOver: number;
  /** … and how many took FAR_OVER times that or longer: one may. */
  readonly newestFarOver: number;
  /** The longest task of the newest page. */
  readonly longest: number;
  /** What is wrong, in words; empty when the page was never held. */
  readonly broken: readonly string[];
}

const ms = (value: number): string => `${Math.round(value).toLocaleString('en-US')} ms`;

/**
 * The reported task that made a change of the document at `at` (its place in `reported`), or -1: the last one that
 * began before the change, when the change is not after its end.
 *
 * Both borders are exact, and each matters. A change is made INSIDE its task (the page hears of it before the task
 * ends), and the next task often begins within the same tenth of a millisecond, which is as fine as Chrome tells the
 * page either time: in the runs that were looked at, up to 13 tasks in 100 began at exactly the clock of the change
 * before them, and none before it (both are readings of one clock, cut the same way). A task takes time before it
 * changes anything, so a change AT a task's start is the task before's: counted for the later one, a machine that
 * formats two texts a slice would show four. And Chrome cuts a duration to a whole millisecond, so the end is up to
 * 1 ms after start + duration (of 2,300 changes the latest came 0.9 ms after it): cut off there, the last text of
 * a task would be lost.
 */
function taskOf(reported: readonly LongTask[], at: number): number {
  let last = -1;
  for (let index = 0; index < reported.length; index += 1) {
    const [start] = reported[index] as LongTask;
    if (start < at && (last === -1 || start >= (reported[last] as LongTask)[0])) last = index;
  }
  if (last === -1) return -1;
  const [start, duration] = reported[last] as LongTask;
  return at < start + duration + 1 ? last : -1;
}

/**
 * Five bounds, each for one way of holding the page:
 *
 *   1. no task formats more than TEXTS_A_TASK texts, counted two ways. By the document: a slice ends with one
 *      change, so how far "waiting" fell from one change to the next is what one task formatted (a change that
 *      mounted texts is a mount, not a slice). By the clock: a task may also let the page see a change after every
 *      text (microtasks run between two texts), and then each change shows one text however many the task goes on
 *      to format; so the changes that lie inside one reported task are added up. Formatting that comes back in one
 *      piece, or in pieces of many texts, fails here whatever the machine's speed, on one condition: the document
 *      changed once for the whole piece, or the piece took more than 50 ms, so that Chrome reported it. A task that
 *      is shorter and changes the document text by text is not seen, and has not held the page for 50 ms;
 *   2. the usual task is under the budget. The median: a busy machine holds some tasks, not most of them. This is
 *      where "every task is long" fails when each task still formats one text. A task Chrome did not report took
 *      50 ms or less and counts as shorter than every reported one; there is one for every change in no reported
 *      task, and none for a change inside one (or four texts in one long task would count as three short tasks
 *      beside it, and the usual task of a page that is held all the time would be a short one);
 *   3. few tasks are held, over every page so far: at most one in ten took `atMost` or longer (one may always: a
 *      single task cannot be told from a pause of the machine, and what one task can do wrong is in the bounds 1
 *      and 5);
 *   4. and few of the newest page alone, where a page of ten tasks cannot hide among four hundred: `heldOfOnePage`.
 *      Held, for this count, by the usual task of the page's own tasks as well (four of them, where that is more
 *      than `atMost`): a machine that is slow for the length of a small page makes every task of that page long,
 *      and the usual task of four hundred others does not know of it. The lower of the two in the middle: of six
 *      tasks of which three are held, the usual one is not a held one. And only while that usual task is not a held
 *      one itself: a page of which half the tasks or more are held (the last six texts of a queue, among ten) has
 *      no usual task to go by, and is judged by `atMost`. What this lets through: on a page whose usual task is
 *      more than the others' and under `atMost`, tasks of up to four times it do not count as held for that page
 *      (they do for the bound 3);
 *   5. no task of the newest page is anywhere near what the smoke is here for (formatting in one piece took 22 s):
 *      none takes ten times `atMost`, and at most one takes FAR_OVER times what makes it held (the bound 4 allows
 *      two held tasks on any page, and says nothing of how long they held it).
 */
export function judgeFormatting({ reported, changes, pages, budget }: Formatting): Verdict {
  /** What each reported task formatted, by the clock; and when the document changed in no reported task. */
  const formatted = reported.map(() => 0);
  const unreported: number[] = [];
  let atOnce = 0;
  for (let index = 1; index < changes.length; index += 1) {
    const [, textsBefore, waitingBefore] = changes[index - 1] as DocumentChange;
    const [at, texts, waiting] = changes[index] as DocumentChange;
    if (texts !== textsBefore || waiting >= waitingBefore) continue;
    const task = taskOf(reported, at);
    if (task === -1) unreported.push(at);
    else formatted[task] = (formatted[task] as number) + waitingBefore - waiting;
    // The larger of the two counts: a reported task's sum is never less than the fall of one of its changes.
    atOnce = Math.max(atOnce, task === -1 ? waitingBefore - waiting : (formatted[task] as number));
  }

  /** The tasks of one page: how long the reported ones took, and how many Chrome did not report. */
  const during = ([from, until]: Stretch): { durations: number[]; short: number } => ({
    durations: reported.filter(([start]) => start >= from && start <= until).map(([, duration]) => duration),
    short: unreported.filter((at) => at >= from && at <= until).length,
  });
  const each = pages.map(during);
  const sorted = each.flatMap((page) => page.durations).sort((a, b) => a - b);
  const short = each.reduce((sum, page) => sum + page.short, 0);
  const tasks = sorted.length + short;
  const middle = Math.floor(tasks / 2) - short;
  const usual = middle < 0 ? 0 : (sorted[middle] ?? 0);
  const atMost = Math.max(budget, 4 * usual);
  const over = sorted.filter((duration) => duration >= atMost).length;
  const mayBeOver = heldOfAll(tasks);
  const newest = each.at(-1) ?? { durations: [], short: 0 };
  const newestTasks = newest.durations.length + newest.short;
  const own = [...newest.durations].sort((a, b) => a - b);
  const ownMiddle = Math.floor((newestTasks - 1) / 2) - newest.short;
  const ownUsual = ownMiddle < 0 ? 0 : (own[ownMiddle] ?? 0);
  const newestAtMost = ownUsual < atMost ? Math.max(atMost, 4 * ownUsual) : atMost;
  const newestOver = own.filter((duration) => duration >= newestAtMost).length;
  const newestMayBeOver = heldOfOnePage(newestTasks);
  const newestFarOver = own.filter((duration) => duration >= FAR_OVER * newestAtMost).length;
  const longest = own.at(-1) ?? 0;

  const broken: string[] = [];
  if (atOnce > TEXTS_A_TASK) broken.push(`one task formatted ${atOnce} texts: more than ${TEXTS_A_TASK}, so the page was held for as long as all of them took`);
  if (usual >= budget) broken.push(`the usual task took ${ms(usual)}: the budget at this machine's speed is ${ms(budget)}`);
  if (over > mayBeOver) broken.push(`${over} tasks took ${ms(atMost)} or longer: of the ${tasks} of every page so far, ${mayBeOver} may be held by a pause of the machine`);
  if (newestOver > newestMayBeOver) broken.push(`${newestOver} tasks of the newest page took ${ms(newestAtMost)} or longer: of its ${newestTasks}, ${newestMayBeOver} may be held by a pause of the machine`);
  if (longest >= 10 * atMost) broken.push(`one task took ${ms(longest)}: ten times what a task may take (${ms(atMost)})`);
  if (newestFarOver > 1) broken.push(`${newestFarOver} tasks of the newest page took ${ms(FAR_OVER * newestAtMost)} or longer: one may, held by a pause of the machine`);
  return { tasks, atOnce, usual, atMost, over, mayBeOver, newestTasks, newestAtMost, newestOver, newestMayBeOver, newestFarOver, longest, broken };
}
