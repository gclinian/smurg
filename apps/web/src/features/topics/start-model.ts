// What the Start dialog says (DESIGN §4.5), as a pure function of `StartPreflight`: one line per fact, in the order a
// person needs them: what starts, who is responsible, what is committed, what changed since someone last looked, what
// agents may do, and what stops the start. The dialog (StartDialog.tsx) adds the icons and the two inline actions.
import type { PlanInfo, StartPreflight, UserRef } from '@smurg/protocol';
import { renderWireText } from '../../lib/errors.ts';
import { formatAnd, formatList, joinSentences } from '../../lib/format.ts';
import { handEditsLine, itemNames, oneOrMany } from './model.ts';
import { t } from './strings.ts';

export type StartLineId =
  | 'starts'
  | 'waits'
  | 'already'
  | 'responsible'
  | 'offline'
  | 'youDecide'
  | 'commit'
  | 'handEdits'
  | 'invisible'
  | 'stale'
  | 'openQuestion'
  | 'editingNow'
  | 'specOpenQuestions'
  | 'settings'
  | 'shared'
  | 'blocker';

export interface StartLine {
  readonly id: StartLineId;
  /** `warn`: look before you start. `danger`: Start is refused while this holds. */
  readonly tone: 'plain' | 'warn' | 'danger';
  readonly text: string;
}

/** Waiting items named one by one up to here; the rest are counted. */
export const START_WAITS_SHOWN = 6;

const FILE_NAME = { spec: 'SPEC.md', plan: 'PLAN.md' } as const;

/** How many items a Start arms: those that start now and those that wait. */
export function startCount(preflight: Pick<StartPreflight, 'startsNow' | 'waits'>): number {
  return preflight.startsNow.length + preflight.waits.length;
}

/**
 * The number the dialog's title says, which is the number on the plan's Start button that opened it: the items that
 * start now; when everything a Start arms waits for another item, how many it arms.
 */
export function startHeadCount(preflight: Pick<StartPreflight, 'startsNow' | 'waits'>): number {
  return preflight.startsNow.length > 0 ? preflight.startsNow.length : preflight.waits.length;
}

/** What the toast says after a Start: how many sessions started, and how many items start by themselves later. */
export function startedNotice(preflight: Pick<StartPreflight, 'startsNow' | 'waits'>): { title: string; description?: string } {
  const now = preflight.startsNow.length;
  const later = preflight.waits.length;
  if (now === 0) return { title: t('start.done.onlyLater', { count: later }) };
  return { title: t('start.done', { count: now }), ...(later > 0 ? { description: t('start.done.later', { count: later }) } : {}) };
}

export function startLines(preflight: StartPreflight, plan: Pick<PlanInfo, 'items'>, selfUserId: string | null): StartLine[] {
  const lines: StartLine[] = [];
  const push = (id: StartLineId, text: string, tone: StartLine['tone'] = 'plain'): void => {
    lines.push({ id, tone, text });
  };

  // What stops the start comes first, in the host's words: one message per reason, saying what the host can do
  // (git's reasons: `worktree.unavailable.*`). An id this build does not know shows the English it came with.
  for (const blocker of preflight.blockers) push('blocker', renderWireText(blocker.text, blocker.fallback), 'danger');

  if (preflight.startsNow.length > 0) push('starts', t('start.now', { count: preflight.startsNow.length, items: itemNames(plan, preflight.startsNow) }));
  else push('starts', t('start.now.none'));
  for (const wait of preflight.waits.slice(0, START_WAITS_SHOWN)) {
    push('waits', t(`start.waits.${oneOrMany(wait.for.length)}`, { item: itemNames(plan, [wait.itemId]), items: itemNames(plan, wait.for) }));
  }
  if (preflight.waits.length > START_WAITS_SHOWN) push('waits', t('start.waitsMore', { count: preflight.waits.length - START_WAITS_SHOWN }));
  if (preflight.alreadyStarted.length > 0) push('already', t('start.already', { items: itemNames(plan, preflight.alreadyStarted) }));

  // Who is responsible, by load; offline people are named (their items start and wait for them).
  const starting = new Set([...preflight.startsNow, ...preflight.waits.map((wait) => wait.itemId)]);
  const load = new Map<string, { user: UserRef; count: number; online: boolean }>();
  for (const entry of preflight.responsible) {
    if (entry.user === null || !starting.has(entry.itemId)) continue;
    const known = load.get(entry.user.userId);
    if (known) known.count += 1;
    else load.set(entry.user.userId, { user: entry.user, count: 1, online: entry.online });
  }
  if (load.size > 0) push('responsible', t('start.responsible', { who: [...load.values()].map((entry) => t('split.load', { name: entry.user.displayName, count: entry.count })).join(t('sep')) }));
  const offline = [...load.values()].filter((entry) => !entry.online).map((entry) => entry.user.displayName);
  if (offline.length > 0) push('offline', t(`start.offline.${oneOrMany(offline.length)}`, { names: formatAnd(offline) }), 'warn');
  if (preflight.youDecide > 0) push('youDecide', t('start.youDecide', { count: preflight.youDecide }));

  // What Start commits, and where. A host says nothing (null) while git stops the start; a host before 0.5.2 named no
  // branch ('') for a share it could not commit in (a gitfile `.git`): no line then, the blocker says why.
  const commit = preflight.commit;
  if (commit !== null && !(commit.branch === '' && preflight.blockers.length > 0)) {
    const parts = [
      !commit.needed
        ? t('start.commit.clean', { branch: commit.branch })
        : commit.as.userId === selfUserId
          ? t('start.commit.you', { branch: commit.branch })
          : t('start.commit', { branch: commit.branch, name: commit.as.displayName }),
    ];
    if (commit.alsoInFolder.length > 0) parts.push(t('start.commit.also', { files: formatList([...commit.alsoInFolder]) }));
    push('commit', joinSentences(parts));
  }

  if (preflight.handEdits.spec.length + preflight.handEdits.plan.length > 0) push('handEdits', t('start.handEdits', { who: handEditsLine(preflight.handEdits) }), 'warn');
  if (preflight.invisibleCharacters.length > 0) {
    push('invisible', t(`start.invisible.${oneOrMany(preflight.invisibleCharacters.length)}`, { files: formatAnd(preflight.invisibleCharacters.map((target) => FILE_NAME[target])) }), 'warn');
  }
  if (preflight.stale) push('stale', t('start.stale'), 'warn');
  if (preflight.openQuestion) push('openQuestion', t('start.openQuestion'), 'warn');
  if (preflight.editingNow.length > 0) {
    push('editingNow', t(`start.editingNow.${oneOrMany(preflight.editingNow.length)}`, { names: formatAnd(preflight.editingNow.map((user) => user.displayName)) }), 'warn');
  }
  if (preflight.specOpenQuestions > 0) push('specOpenQuestions', t('start.specOpenQuestions', { count: preflight.specOpenQuestions }), 'warn');

  if (preflight.projectSettings === 'used') push('settings', t('start.settings.used'));
  else if (preflight.projectSettings === 'ignored') push('settings', t('start.settings.ignored'), 'warn');
  push('shared', preflight.sharedDirs.length === 0 ? t('start.shared.none') : t('start.shared', { dirs: formatList([...preflight.sharedDirs]) }));
  return lines;
}
