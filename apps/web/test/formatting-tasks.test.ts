// @vitest-environment node
// The rule conversation.perf.smoke.test.ts judges a page's tasks by (e2e/smoke/formatting-tasks.ts), on numbers a
// browser once reported and on what the smoke is there to catch. The smoke itself takes minutes and a browser, and
// whether its rule is right shows on a slow, busy machine: here it is a matter of milliseconds on any machine.
import { describe, expect, it } from 'vitest';
import { FAR_OVER, TEXTS_A_TASK, heldOfAll, heldOfOnePage, judgeFormatting, type DocumentChange, type LongTask, type Stretch } from '../e2e/smoke/formatting-tasks.ts';

/** The budget of the smoke on the machine it was set on (LONG_TASK_BUDGET_MS). */
const BUDGET = 200;

/**
 * A page as the smoke printed it before this rule: `count` tasks, "the usual one" (the one in the middle), "nine in
 * ten under" (the one at nine tenths) and the longest. Every task above the nine tenths is taken to be as long as the
 * longest, and every one below it as the usual one: the most held tasks those four numbers allow where the task at
 * nine tenths was not held itself (where it was, the tasks between the middle and it may have been as well).
 */
function printed(count: number, usual: number, nineInTen: number, longest: number): number[] {
  const at = Math.floor(count * 0.9);
  return Array.from({ length: count }, (_, index) => (index < at ? usual : index === at ? nineInTen : longest));
}

/** What the page keeps of a run, and when each page of texts was being formatted: what the smoke hands to the rule. */
interface Kept {
  readonly reported: LongTask[];
  readonly changes: DocumentChange[];
  readonly pages: Stretch[];
}

/** One task: how long it took; or that, the texts it formatted, and in how many changes of the document (one unless said). */
type Task = number | readonly [took: number, texts: number, changes?: number];

/**
 * One more page of texts the way a browser shows it: a mount (the texts that wait and three the mount formatted
 * itself), the frame, then the tasks one after the other. A task changes the document at its end, or `changes` times
 * with the last at its end; it really took 0.6 ms more than the whole milliseconds Chrome reports, and Chrome reports
 * it when that is over 50; the next task begins at the very clock of that last change. So every change here lies on
 * both borders the rule has to get right: after start + duration of its own task, and at the start of the next.
 */
function page(kept: Kept, tasks: readonly Task[]): Kept {
  const [before, mountedBefore] = kept.changes.at(-1) ?? [0, 0];
  let waiting = tasks.reduce<number>((sum, task) => sum + (typeof task === 'number' ? 1 : task[1]), 0);
  const mounted = mountedBefore + waiting + 3;
  let now = before + 300;
  kept.changes.push([now, mounted, waiting]);
  const from = (now += 16);
  for (const task of tasks) {
    const [took, texts, changes = 1] = typeof task === 'number' ? [task, 1] : task;
    const end = now + took + 0.6;
    for (let change = 1; change <= changes; change += 1) kept.changes.push([change === changes ? end : now + (took * change) / changes, mounted, (waiting -= texts / changes)]);
    if (took > 50) kept.reported.push([now, took]);
    now = end;
  }
  kept.pages.push([from, now + 6]);
  return kept;
}

/** Judges page after page, as the smoke does: each when it is the newest, with everything the page has kept so far. */
function judgePages(pages: readonly (readonly Task[])[], budget: number) {
  const kept: Kept = { reported: [], changes: [], pages: [] };
  return pages.map((tasks) => judgeFormatting({ ...page(kept, tasks), budget }));
}

const each = (count: number, task: Task): Task[] => Array.from({ length: count }, () => task);

describe('the rule of the perf smoke for a page that formats texts while it is idle', () => {
  // GitHub's macOS runner on 2026-10-09: 1.88 times as slow as the reference machine and busy. Five pages; on the
  // last one (nine tasks) "nine in ten under 617 ms" was the longest task, and 617 was not under 4 * 107 = 428.
  const RUNNER = [printed(124, 151, 240, 476), printed(64, 127, 256, 736), printed(49, 111, 179, 726), printed(124, 119, 231, 787), printed(9, 107, 617, 617)];

  it('a slow, busy runner whose tasks are one text each is not held: single long tasks on every page, one of them among nine', () => {
    const verdicts = judgePages(RUNNER, BUDGET * 1.88);
    expect(verdicts.map((verdict) => verdict.broken)).toEqual([[], [], [], [], []]);
    // The whole of it: 370 tasks, one text each, the usual one far under the budget of 376 ms, and held 23 of them
    // where 37 may be (6, 4 and 12 on the pages before, of which 13, 10 and 25 may be), one of the last nine. What
    // that page printed (the middle one 107 ms, the last 617) says nothing of the three tasks between them: one to
    // four of the nine were held, 26 in all at the most, and the rule passes one or two.
    expect(verdicts.at(-1)).toMatchObject({ tasks: 370, atOnce: 1, usual: 127, atMost: 508, over: 23, mayBeOver: 37, newestTasks: 9, newestAtMost: 508, newestOver: 1, newestMayBeOver: 2, longest: 617 });
    expect(judgePages([...RUNNER.slice(0, 4), [...each(5, 107), 617, 617, 617, 617]], BUDGET * 1.88)[4]?.broken).toEqual(['4 tasks of the newest page took 508 ms or longer: of its 9, 2 may be held by a pause of the machine']);
    expect(verdicts.map((verdict) => [verdict.newestOver, verdict.newestMayBeOver])).toEqual([[0, 25], [6, 13], [4, 10], [12, 25], [1, 2]]);
  });

  it('few tasks: one held task among nine is no finding, nor is the only task Chrome reports; most of nine held is one', () => {
    expect(judgePages([printed(9, 107, 617, 617)], BUDGET * 1.88)[0]).toMatchObject({ over: 1, mayBeOver: 1, newestOver: 1, newestMayBeOver: 2, broken: [] });
    // A machine on which no text takes 50 ms: Chrome reports no task, or only the one that was held.
    expect(judgePages([each(9, 20)], BUDGET)[0]).toMatchObject({ tasks: 9, atOnce: 1, usual: 0, over: 0, broken: [] });
    expect(judgePages([[...each(4, 20), 617, ...each(4, 20)]], BUDGET)[0]).toMatchObject({ tasks: 9, usual: 0, atMost: 200, over: 1, mayBeOver: 1, broken: [] });
    // Five of nine held: the usual task is one of them.
    expect(judgePages([[107, 107, 107, 107, 617, 617, 617, 617, 617]], BUDGET * 1.88)[0]?.broken).toEqual([`the usual task took 617 ms: the budget at this machine's speed is 376 ms`]);
  });

  it('every task long fails, whatever makes it long: many texts a task, or one text that holds the page', () => {
    // Slices of five texts (350 ms each on the reference machine): nothing stands out among them.
    const five = judgePages([each(24, [350, 5])], BUDGET)[0];
    expect(five?.broken).toEqual([`one task formatted 5 texts: more than ${TEXTS_A_TASK}, so the page was held for as long as all of them took`, `the usual task took 350 ms: the budget at this machine's speed is 200 ms`]);
    // The count does not go by the machine: where the budget is three times as long and the same tasks are under it,
    // five texts in one task are still five.
    expect(judgePages([each(24, [350, 5])], BUDGET * 3)[0]?.broken).toEqual([`one task formatted 5 texts: more than ${TEXTS_A_TASK}, so the page was held for as long as all of them took`]);
    // One text a task, and each task 2 s.
    expect(judgePages([each(120, 2_000)], BUDGET)[0]?.broken).toEqual([`the usual task took 2,000 ms: the budget at this machine's speed is 200 ms`]);
    // A machine twice as fast as the reference may format two texts in a slice.
    expect(judgePages([each(60, [60, 2])], BUDGET)[0]).toMatchObject({ tasks: 60, atOnce: 2, broken: [] });
  });

  it('formatting that comes back in one piece fails: one task for every text that waited', () => {
    const verdict = judgePages([[[22_000, 120]]], BUDGET)[0];
    expect(verdict?.atOnce).toBe(120);
    expect(verdict?.broken).toEqual([`one task formatted 120 texts: more than ${TEXTS_A_TASK}, so the page was held for as long as all of them took`, `the usual task took 22,000 ms: the budget at this machine's speed is 200 ms`]);
  });

  it('a task of seconds fails among a hundred ordinary ones: by the texts it formatted, or by its length alone', () => {
    const ordinary = each(119, 70);
    // Forty texts in 2.7 s: just under ten times a task's bound (2.8 s here). The count needs no bound in time.
    expect(judgePages([ordinary, [[2_700, 40]]], BUDGET)[1]?.broken).toEqual([`one task formatted 40 texts: more than ${TEXTS_A_TASK}, so the page was held for as long as all of them took`]);
    // One text, 3 s.
    expect(judgePages([[...ordinary, 3_000]], BUDGET)[0]?.broken).toEqual(['one task took 3,000 ms: ten times what a task may take (280 ms)']);
    // A pause of the machine as the runner had them is neither.
    expect(judgePages([[...ordinary, 787]], BUDGET)[0]?.broken).toEqual([]);
  });

  it('held tasks that are no longer rare fail: more than one task in ten of every page so far', () => {
    expect(judgePages([[...each(100, 70), ...each(20, 500)]], BUDGET)[0]?.broken).toEqual(['20 tasks took 280 ms or longer: of the 120 of every page so far, 12 may be held by a pause of the machine']);
    expect(judgePages([[...each(108, 70), ...each(12, 500)]], BUDGET)[0]?.broken).toEqual([]);
    // What the pages together may have, at the sizes of the smoke's five as they add up.
    expect([119, 181, 230, 349, 358].map(heldOfAll)).toEqual([11, 18, 23, 34, 35]);
  });

  it('held tasks that come on one small page fail: three among its seven to ten, however few they are among all the pages', () => {
    // A queue whose last three texts hold the page for half a second each: 15 held tasks in about 360, three a page.
    const queue = (tasks: number): number[] => [...each(tasks - 3, 69), 570, 570, 570] as number[];
    for (const last of [6, 7, 8, 9, 10]) {
      const verdicts = judgePages([queue(119), queue(62), queue(49), queue(119), queue(last)], BUDGET);
      expect(verdicts.slice(0, 4).map((verdict) => verdict.broken)).toEqual([[], [], [], []]);
      expect(verdicts[4]).toMatchObject({ tasks: 349 + last, over: 15, mayBeOver: heldOfAll(349 + last), newestTasks: last, newestOver: 3, newestMayBeOver: 2 });
      expect(verdicts[4]?.broken).toEqual([`3 tasks of the newest page took 276 ms or longer: of its ${last}, 2 may be held by a pause of the machine`]);
    }
    // Two of them is what a machine that is only busy does to a page of ten now and then, and one is what the runner did.
    expect(judgePages([each(119, 69), each(62, 69), each(49, 69), each(119, 69), [...each(8, 69), 570, 570]], BUDGET)[4]).toMatchObject({ newestOver: 2, newestMayBeOver: 2, broken: [] });
    // On a large page the pages together are the tighter bound at first; later one page may not have a fifth of its own held.
    expect(judgePages([each(119, 69), each(62, 69), [...each(38, 69), ...each(11, 570)]], BUDGET)[2]).toMatchObject({ over: 11, mayBeOver: 23, newestOver: 11, newestMayBeOver: 10 });
    expect(judgePages([each(119, 69), each(62, 69), [...each(38, 69), ...each(11, 570)]], BUDGET)[2]?.broken).toEqual(['11 tasks of the newest page took 276 ms or longer: of its 49, 10 may be held by a pause of the machine']);
  });

  it('a page on which the machine was slow is not held: its tasks are judged by the usual one of their own page as well', () => {
    // The runner on 2026-10-08, 1.74 times as slow as the reference machine: four pages with a usual task of 103 to
    // 134 ms, then a last page of 13 tasks whose usual one took 190 ms, the one at nine tenths 507 and the longest
    // 539. What it printed says no more of the tasks between the middle and the nine tenths: here four of them took
    // 450 to 500 ms. By the usual task of all the pages (4 * 108 ms) six tasks of the thirteen were held where three
    // may be; by the usual task of their own page none was, and nothing was wrong. (Over every page the six do count:
    // 34 of 373 with the 28 that the pages before had at the most, where 37 may be.)
    const before = [printed(125, 106, 149, 480), printed(65, 108, 191, 292), printed(51, 103, 227, 457), printed(119, 134, 281, 886)];
    const slow = [150, 160, 170, 175, 180, 185, 190, 450, 460, 480, 500, 507, 539];
    const verdict = judgePages([...before, slow], BUDGET * 1.74)[4];
    expect(verdict).toMatchObject({ usual: 108, atMost: 432, newestTasks: 13, newestAtMost: 760, newestOver: 0, newestMayBeOver: 3, over: 34, mayBeOver: 37, broken: [] });
    expect(slow.filter((took) => took >= 432)).toHaveLength(6);
    // The lower of the two tasks in the middle is the usual one of a page: three held of six are still three held.
    expect(judgePages([each(119, 69), [69, 69, 69, 570, 570, 570]], BUDGET)[1]).toMatchObject({ newestAtMost: 276, newestOver: 3, newestMayBeOver: 2 });
    // A usual task that is long for its page and not held raises the bound for that page, and the short tasks Chrome
    // did not report count among its tasks: of seven, the middle one took 150 ms, and two of 700 are two held.
    expect(judgePages([each(119, 69), [20, 20, 150, 150, 150, 700, 700]], BUDGET)[1]).toMatchObject({ newestTasks: 7, newestAtMost: 600, newestOver: 2, newestMayBeOver: 2, broken: [] });
    // But a usual task that is a held one itself excuses nothing: a page whose every task is long, among four pages
    // that hide it from the bounds over every page (9 held of 358 where 35 may be), and a queue whose last SIX texts
    // hold the page, six of the last page's ten.
    const quiet = [each(119, 69), each(62, 69), each(49, 69), each(119, 69)];
    expect(judgePages([...quiet, each(9, 570)], BUDGET)[4]).toMatchObject({ newestAtMost: 276, newestOver: 9, over: 9, mayBeOver: 35 });
    expect(judgePages([...quiet, each(9, 570)], BUDGET)[4]?.broken).toEqual(['9 tasks of the newest page took 276 ms or longer: of its 9, 2 may be held by a pause of the machine']);
    const lastSix = (tasks: number): number[] => [...each(tasks - 6, 69), ...each(6, 570)] as number[];
    const six = judgePages([lastSix(119), lastSix(62), lastSix(49), lastSix(120), lastSix(10)], BUDGET);
    expect(six.slice(0, 4).map((verdict) => verdict.broken)).toEqual([[], [], [], []]);
    expect(six[4]).toMatchObject({ over: 30, mayBeOver: 36, newestAtMost: 276, newestOver: 6 });
    expect(six[4]?.broken).toEqual(['6 tasks of the newest page took 276 ms or longer: of its 10, 2 may be held by a pause of the machine']);
    // Where every task of every page is long, the usual task of all of them is what says so.
    expect(judgePages([each(119, 570)], BUDGET)[0]?.broken).toEqual([`the usual task took 570 ms: the budget at this machine's speed is 200 ms`]);
  });

  it('two held tasks of a page may not both be held for long: one pause of seconds is a pause, two on one page are not', () => {
    // A queue whose last two texts hold the page 2.5 s each: two held tasks a page, which the count allows on any page.
    const queue = (tasks: number): number[] => [...each(tasks - 2, 69), 2_500, 2_500] as number[];
    expect(FAR_OVER * 276).toBe(1_104);
    const verdicts = judgePages([queue(119), queue(62), queue(49), queue(119), queue(9)], BUDGET);
    expect(verdicts.map((verdict) => [verdict.newestOver, verdict.newestMayBeOver, verdict.newestFarOver])).toEqual([[2, 24, 2], [2, 13, 2], [2, 10, 2], [2, 24, 2], [2, 2, 2]]);
    for (const verdict of verdicts) expect(verdict.broken).toEqual(['2 tasks of the newest page took 1,104 ms or longer: one may, held by a pause of the machine']);
    // One such pause, and a second held task as a busy machine makes them (the runner's longest was 1,155 ms where a
    // task counted as held at 608): nothing.
    expect(judgePages([each(119, 69), [...each(7, 69), 2_500, 700]], BUDGET)[1]).toMatchObject({ newestOver: 2, newestFarOver: 1, broken: [] });
  });

  /** The chance of each number of held tasks among `tasks`, when each is held with the chance `rate` whatever became of the others. */
  function chances(tasks: number, rate: number): number[] {
    const list = [(1 - rate) ** tasks];
    for (let held = 1; held <= tasks; held += 1) list.push(((list[held - 1] as number) * (tasks - held + 1) * rate) / (held * (1 - rate)));
    return list;
  }
  /** Of 1,000 runs with nothing wrong, how many fail at some page: by the bound over every page, or by `ofOnePage` for the newest. */
  function failInAThousand(pages: readonly number[], rate: number, ofOnePage: (tasks: number) => number): number {
    let passed = new Map<number, number>([[0, 1]]);
    let tasks = 0;
    for (const size of pages) {
      tasks += size;
      const weights = chances(size, rate);
      const next = new Map<number, number>();
      for (const [before, chance] of passed)
        for (let held = 0; held <= Math.min(size, ofOnePage(size), heldOfAll(tasks) - before); held += 1) next.set(before + held, (next.get(before + held) ?? 0) + chance * (weights[held] as number));
      passed = next;
    }
    return 1_000 * (1 - [...passed.values()].reduce((sum, chance) => sum + chance, 0));
  }

  it('the allowance of one page is two, or one in five: what it costs a run with nothing wrong, and what one fewer or one more would', () => {
    // At the sizes of the smoke's pages: two of the last page, a fifth of the others.
    expect([119, 62, 49, 10, 9, 7].map(heldOfOnePage)).toEqual([24, 13, 10, 2, 2, 2]);
    // The numbers of the comment at `heldOfOnePage`: runs in 1,000 that fail with nothing wrong, when a busy machine
    // holds 2 %, 3.5 % or 5 % of all tasks; a last page of nine tasks, and of ten.
    const runs = (ofOnePage: (tasks: number) => number, last: number): string[] => [0.02, 0.035, 0.05].map((rate) => failInAThousand([119, 62, 49, 119, last], rate, ofOnePage).toFixed(2));
    expect([runs(heldOfOnePage, 9), runs(heldOfOnePage, 10)]).toEqual([['0.62', '4.07', '25.14'], ['0.87', '5.28', '28.23']]);
    // And at the chance the runner itself showed in 19 runs (about 1 %), and at half as much again: a run in about
    // ten thousand, and one in three thousand.
    const seldom = (last: number): string[] => [0.01, 0.015].map((rate) => failInAThousand([119, 62, 49, 119, last], rate, heldOfOnePage).toFixed(2));
    expect([seldom(9), seldom(10)]).toEqual([['0.08', '0.27'], ['0.11', '0.37']]);
    // The bound over every page so far, by itself: it is what is left when one page may have any number held.
    expect(runs(() => Number.POSITIVE_INFINITY, 10)).toEqual(['0.01', '1.00', '16.90']);
    // One fewer on a small page (one, or one in ten): a run in thirteen at 3.5 %. The rule before this one allowed
    // none among ten or fewer: every third or fourth run, on its last page alone.
    const oneInTen = (tasks: number): number => Math.max(1, Math.floor(tasks / 10));
    expect([runs(oneInTen, 9), runs(oneInTen, 10)]).toEqual([['16.26', '71.70', '216.62'], ['19.31', '79.69', '229.21']]);
    expect([9, 10].map((last) => (1_000 * (1 - (chances(last, 0.035)[0] as number))).toFixed(0))).toEqual(['274', '300']);
    // One more (three, or one in five) costs next to nothing beside the bound over every page, and passes the queue
    // that holds its last three texts: the three held tasks of a page of ten are what a busy machine does 4.3 times
    // in 1,000, and nothing that counts the tasks of that page can fail them less often than that.
    const three = (tasks: number): number => Math.max(3, Math.ceil(tasks / 5));
    expect([runs(three, 9), runs(three, 10)]).toEqual([['0.02', '1.17', '17.55'], ['0.04', '1.27', '17.93']]);
    const threeOrMore = (tasks: number, allowed: number): number => 1_000 * chances(tasks, 0.035).slice(allowed + 1).reduce((sum, chance) => sum + chance, 0);
    expect(threeOrMore(10, 2).toFixed(1)).toBe('4.3');
    // A fifth rounded UP: no size of page fails by itself more often than the page of ten does. Rounded down a page of
    // 14 may have two and fails 12 times in 1,000; with a sixth, a page of 12 fails 7 times.
    const worst = (ofOnePage: (tasks: number) => number): string => Math.max(...Array.from({ length: 130 }, (_, index) => threeOrMore(index + 1, ofOnePage(index + 1)))).toFixed(1);
    expect([worst(heldOfOnePage), worst((tasks) => Math.max(2, Math.floor(tasks / 5))), worst((tasks) => Math.max(2, Math.ceil(tasks / 6)))]).toEqual(['4.3', '11.7', '7.4']);
  });

  it('a mount is not a slice: texts that arrive, and the ones a mount formats itself, are not counted as one task', () => {
    // 123 texts are mounted and 120 wait; they are formatted one by one; 68 more arrive, 65 of them wait.
    expect(judgePages([each(120, 20), each(65, 20)], BUDGET)[1]).toMatchObject({ tasks: 185, atOnce: 1 });
    // Fewer texts wait after a change that also mounted some: whatever that change did, it was not one slice, though
    // the task that made it was long and is reported.
    expect(judgeFormatting({ reported: [[0.5, 255]], changes: [[0, 128, 30], [255.8, 200, 10]], pages: [[300, 400]], budget: BUDGET })).toMatchObject({ tasks: 0, atOnce: 0, broken: [] });
  });

  it('the texts of a task are counted by the clock as well: a task that lets the document change after every text is still one task', () => {
    // What Chrome and the page kept of slices that go on for 250 ms and let the page's microtasks run between two
    // texts: the document changes once for every text, 70 ms apart, and each task holds the page for four of them.
    const chained = {
      reported: [[2532.8, 280], [2824.4, 281], [3106.5, 283]] as LongTask[],
      changes: [[2511.4, 128, 125], [2603.1, 128, 124], [2673.2, 128, 123], [2742.9, 128, 122], [2812.8, 128, 121], [2894.3, 128, 120], [2965.2, 128, 119], [3035.1, 128, 118], [3105.3, 128, 117], [3179.6, 128, 116], [3249.5, 128, 115], [3319.6, 128, 114], [3389.6, 128, 113]] as DocumentChange[],
      pages: [[2520, 3400]] as Stretch[],
    };
    // Three tasks, not twelve: so the usual one is a task of 281 ms and not one of the nine "short" ones beside them.
    expect(judgeFormatting({ ...chained, budget: BUDGET })).toMatchObject({ tasks: 3, atOnce: 4, usual: 281, over: 0 });
    expect(judgeFormatting({ ...chained, budget: BUDGET }).broken).toEqual([`one task formatted 4 texts: more than ${TEXTS_A_TASK}, so the page was held for as long as all of them took`, `the usual task took 281 ms: the budget at this machine's speed is 200 ms`]);
    // The same slices on a machine so fast that none takes 50 ms: Chrome reports nothing, each change counts as a
    // task of its own, and nothing held the page for long.
    expect(judgePages([each(30, [40, 4, 4])], BUDGET)[0]).toMatchObject({ tasks: 120, atOnce: 1, usual: 0, broken: [] });
  });

  it('a change on the border between two tasks belongs to the one that made it: an ordinary run shows one text a task, two texts a slice show two', () => {
    // An ordinary run, as Chrome and the page kept it: five tasks of one text each. Three of the changes have the very
    // clock of the next task's start (5677.4, 5747.7) or lie after start + duration of their own (all of them).
    const ordinary = {
      reported: [[5607.3, 70], [5677.4, 70], [5747.7, 70], [5820.4, 70], [5890.7, 70]] as LongTask[],
      changes: [[5607.1, 128, 82], [5677.4, 128, 81], [5747.7, 128, 80], [5817.8, 128, 79], [5890.6, 128, 78], [5960.8, 128, 77]] as DocumentChange[],
      pages: [[5600, 5970]] as Stretch[],
    };
    expect(judgeFormatting({ ...ordinary, budget: BUDGET })).toMatchObject({ tasks: 5, atOnce: 1, usual: 70, broken: [] });
    // A machine fast enough for two texts a slice, task after task without a pause (every change at the clock of the
    // next task's start): two, not the four that the next task's two would make of them.
    expect(judgePages([each(60, [55, 2])], BUDGET)[0]).toMatchObject({ tasks: 60, atOnce: 2, broken: [] });
    // And the last change of a task is its own though it comes after start + duration (Chrome cuts the duration to a
    // whole millisecond): three texts by three changes are three.
    expect(judgePages([each(60, [60, 3, 3])], BUDGET)[0]).toMatchObject({ tasks: 60, atOnce: 3 });
    expect(judgePages([each(60, [60, 3, 3])], BUDGET)[0]?.broken).toEqual([`one task formatted 3 texts: more than ${TEXTS_A_TASK}, so the page was held for as long as all of them took`]);
    // But not a change a millisecond or more after it: that one a later task made, which Chrome did not report.
    const after: DocumentChange[] = [[990, 16, 9], [1060.9, 16, 7], [1061, 16, 5]];
    expect(judgeFormatting({ reported: [[1000, 60]], changes: after, pages: [[995, 1070]], budget: BUDGET })).toMatchObject({ tasks: 2, atOnce: 2, broken: [] });
  });
});
