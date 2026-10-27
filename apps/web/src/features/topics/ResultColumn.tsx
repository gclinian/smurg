// A topic's Result (DESIGN 0.7.0 D13, D19): what the team looks at when every item is settled, built from what the
// page can already ask: the plan, each item's report (`report.get`) and each merged request's diff
// (`worktree.merge.diff` / `.fileDiff`, which work for merged requests). Top to bottom:
//
//   the summary line          "2 of 3 merged · 4 passed · 0 failed · 1 not verified · 1 left out"
//   the checks                what failed and what was not verified first, item by item; then what passed
//   What the items changed    each merged item's diff as smurg (or the host) merged it, with the note on replaced lines
//   What to watch out for     item by item, in the agents' own words
//   Work items                each with its badge, its report, its review mark and the host's "Undo…"
//   Left out and undone
//   the foot                  "I've checked the result" (anyone who may discuss), what changes it, the host's
//                             "Undo the whole topic…"
//
// Items that ran directly in the shared folder have no history: the diff part says so (`result.direct`).
import type { ReportInfo, Topic, WorkItem } from '@smurg/protocol';
import { useEffect, useMemo, type ReactNode } from 'react';
import { itemLabel } from '../../lib/columns/describe.ts';
import { joinSentences } from '../../lib/format.ts';
import { shallowEqual, useStore } from '../../lib/store.ts';
import { selectWork } from '../../lib/stores/host.ts';
import { selectPlan, selectReport } from '../../lib/stores/topics.ts';
import { useCan, useStores } from '../../lib/workspace/context.tsx';
import { Badge, Button, Spinner } from '../../ui/index.ts';
import { IconAlertTriangle, IconCheck, IconCheckCircle, IconGitBranch, IconHistory, IconShield, IconXCircle } from '../../ui/icons.tsx';
import { Markdown } from '../markdown/index.ts';
import { ChangedFiles } from '../worktree/index.tsx';
import { topicDialogs } from './dialogs.ts';
import { isMerged, itemActions, itemBadge } from './model.ts';
import { Foot, LinkButton, Note, Scroll, formatClock, useAction, useOpenSide, useTopic } from './shared.tsx';
import { t } from './strings.ts';
import './topics.css';

export default function ResultColumn({ topicId }: { topicId: string }) {
  const stores = useStores();
  const topic = useTopic(topicId);
  const plan = useStore(stores.topics, (state) => selectPlan(state, topicId));
  useEffect(() => stores.topics.ensurePlan(topicId), [stores, topicId]);
  if (topic === undefined || plan === undefined) {
    return (
      <Note>
        <Spinner size={16} decorative /> {t('loading')}
      </Note>
    );
  }
  if (plan === null) return <Note>{t('plan.empty.title')}</Note>;
  return <Result key={topic.id} topic={topic} items={plan.items.filter((item) => item.inPlan)} />;
}

function Section({ icon, title, children, className }: { icon: ReactNode; title: string; children: ReactNode; className?: string }) {
  return (
    <section className={className === undefined ? 'report-sec' : `report-sec ${className}`} aria-label={title}>
      <h3 className="report-sec__h">
        {icon}
        {title}
      </h3>
      {children}
    </section>
  );
}

/** The counts of the summary line, from the plan's report summaries (the whole reports are not needed for them). */
export function resultCounts(items: readonly WorkItem[]): { merged: number; total: number; passed: number; failed: number; notVerified: number; leftOut: number; undone: number } {
  let merged = 0;
  let passed = 0;
  let failed = 0;
  let notVerified = 0;
  let leftOut = 0;
  let undone = 0;
  for (const item of items) {
    if (item.leftOut !== undefined) leftOut += 1;
    if (item.undone !== undefined) undone += 1;
    if (!isMerged(item)) continue;
    merged += 1;
    const checks = item.report?.checks;
    if (checks === undefined) continue;
    passed += checks.passed;
    failed += checks.failed ?? 0;
    notVerified += checks.notVerified;
  }
  return { merged, total: items.length, passed, failed, notVerified, leftOut, undone };
}

/** "2 of 3 merged · 4 passed · 0 failed · 1 not verified · 1 left out" (what is 0 of left out and undone is left out). */
export function resultSummaryLine(items: readonly WorkItem[]): string {
  const counts = resultCounts(items);
  const parts = [t('result.summary', counts)];
  if (counts.leftOut > 0) parts.push(t('result.summary.leftOut', { count: counts.leftOut }));
  if (counts.undone > 0) parts.push(t('result.summary.undone', { count: counts.undone }));
  return parts.join(t('sep'));
}

function Result({ topic, items }: { topic: Topic; items: WorkItem[] }) {
  const stores = useStores();
  const openSide = useOpenSide();
  const isHost = useCan('worktree.merge.decide');
  // Items that ran directly in the shared folder (no git program, DESIGN 0.6.0 D15): smurg keeps no history of them.
  const direct = useStore(stores.host, (state) => selectWork(state)?.history === 'direct');
  const merged = useMemo(() => items.filter(isMerged), [items]);
  const out = items.filter((item) => item.leftOut !== undefined || item.undone !== undefined);
  const kept = items.filter((item) => item.leftOut === undefined && item.undone === undefined);
  const reportIds = merged.filter((item) => item.report !== undefined).map((item) => item.id);
  const idsKey = reportIds.join(',');
  useEffect(() => {
    for (const itemId of idsKey === '' ? [] : idsKey.split(',')) stores.topics.loadReport(topic.id, itemId).catch(() => {});
  }, [stores, topic.id, idsKey]);
  const reports = useStore(stores.topics, (state) => merged.map((item) => selectReport(state, topic.id, item.id)), shallowEqual);
  const withReports = merged.map((item, index) => ({ item, report: reports[index] })).filter((entry): entry is { item: WorkItem; report: ReportInfo } => entry.report !== undefined);
  const noHistory = direct || (merged.length > 0 && merged.every((item) => item.merging === undefined));
  const undoable = merged.some((item) => itemActions(item, { items }).undo);

  const checksOf = (kind: 'failed' | 'notVerified' | 'passed') =>
    withReports.flatMap(({ item, report }) =>
      report.sections.verified
        .filter((check) => (kind === 'failed' ? check.failed === true : kind === 'passed' ? check.passed : !check.passed && check.failed !== true))
        .map((check, index) => ({ key: `${item.id}:${kind}:${index}`, item, check })),
    );
  const failed = checksOf('failed');
  const notVerified = checksOf('notVerified');
  const passed = checksOf('passed');
  const checkList = (entries: ReturnType<typeof checksOf>, kind: 'failed' | 'notVerified' | 'passed') => (
    <ul className="report-checks">
      {entries.map(({ key, item, check }) => (
        <li key={key} data-passed={check.passed} {...(kind === 'failed' ? { 'data-failed': true } : {})}>
          {kind === 'passed' ? <IconCheck size={14} /> : kind === 'failed' ? <IconXCircle size={14} /> : <IconAlertTriangle size={14} />}
          <div>
            <span className="result__item">{itemLabel(item)}</span>
            <Markdown text={check.text} headingBase={4} />
            {check.note !== undefined ? <Markdown className="report-checks__note" text={check.note} headingBase={4} /> : null}
          </div>
        </li>
      ))}
    </ul>
  );

  return (
    <>
      <Scroll>
        <div className="report result col-measure" aria-label={t('result.title', { topic: topic.name })} role="region">
          <p className="result__summary">{resultSummaryLine(items)}</p>

          {failed.length > 0 ? (
            <Section icon={<IconXCircle size={14} />} title={t('report.check.failed')}>
              {checkList(failed, 'failed')}
            </Section>
          ) : null}
          {notVerified.length > 0 ? (
            <Section icon={<IconAlertTriangle size={14} />} title={t('result.notVerified')}>
              {checkList(notVerified, 'notVerified')}
            </Section>
          ) : null}
          {passed.length > 0 ? (
            <Section icon={<IconShield size={14} />} title={t('result.passed')}>
              {checkList(passed, 'passed')}
            </Section>
          ) : null}

          <Section icon={<IconGitBranch size={14} />} title={t('result.changes')}>
            {noHistory ? (
              <p className="report__none">{t('result.direct')}</p>
            ) : merged.length === 0 ? (
              // (everything was left out or undone: no heading over nothing, 0.7.0 review)
              <p className="report__none">{t('result.noneMerged')}</p>
            ) : (
              <>
                <p className="report__none">{t('result.changes.note')}</p>
                {withReports.map(({ item, report }) =>
                  report.changes === undefined ? null : (
                    <div key={item.id} className="result__changes">
                      <h4 className="result__item">{itemLabel(item)}</h4>
                      <ChangedFiles key={report.changes.requestId} requestId={report.changes.requestId} byHand={report.changes.byHand} />
                    </div>
                  ),
                )}
              </>
            )}
          </Section>

          {withReports.some(({ report }) => report.sections.watchOut.trim() !== '') ? (
            <Section icon={<IconAlertTriangle size={14} />} title={t('report.section.watchOut')} className="report-watch">
              {withReports
                .filter(({ report }) => report.sections.watchOut.trim() !== '')
                .map(({ item, report }) => (
                  <div key={item.id}>
                    <h4 className="result__item">{itemLabel(item)}</h4>
                    <Markdown text={report.sections.watchOut} headingBase={5} />
                  </div>
                ))}
            </Section>
          ) : null}

          {kept.length > 0 ? (
            <Section icon={<IconCheckCircle size={14} />} title={t('result.items')}>
              <ul className="result-items">
                {kept.map((item) => (
                  <ResultItem key={item.id} topic={topic} item={item} items={items} direct={direct} onReport={() => openSide({ kind: 'report', topicId: topic.id, itemId: item.id })} />
                ))}
              </ul>
              {!isHost && undoable ? <p className="report__none">{t('undo.askHost')}</p> : null}
            </Section>
          ) : null}

          {out.length > 0 ? (
            <Section icon={<IconHistory size={14} />} title={t('result.leftOutUndone')}>
              <ul className="result-items">
                {out.map((item) => (
                  <ResultItem key={item.id} topic={topic} item={item} items={items} direct={direct} onReport={() => openSide({ kind: 'report', topicId: topic.id, itemId: item.id })} />
                ))}
              </ul>
            </Section>
          ) : null}
        </div>
      </Scroll>
      <ResultFoot topic={topic} undoable={undoable} />
    </>
  );
}

function ResultItem({ topic, item, items, direct, onReport }: { topic: Topic; item: WorkItem; items: WorkItem[]; direct: boolean; onReport(): void }) {
  const stores = useStores();
  const isHost = useCan('worktree.merge.decide');
  const badge = itemBadge(item, { items, slots: { inUse: 0, max: 0, waitingForPeople: 0 } }, undefined, { direct });
  const actions = itemActions(item, { items });
  const review = item.report?.state === 'reviewed' ? item.report.review : undefined;
  return (
    <li className="result-item" data-item={item.id}>
      <span className="result-item__title">{itemLabel(item)}</span>
      <Badge tone={badge.tone}>{badge.text}</Badge>
      {review !== undefined ? <span className="report__none">{t('report.state.reviewed', { name: review.by.displayName, time: formatClock(review.at) })}</span> : null}
      <span className="plan-item__spacer" />
      {item.report !== undefined ? <LinkButton onClick={onReport}>{t('item.report')}</LinkButton> : null}
      {actions.undo && isHost && !topic.archived ? <LinkButton onClick={() => topicDialogs(stores).open({ kind: 'undo', topicId: topic.id, itemIds: [item.id] })}>{t('undo.action')}</LinkButton> : null}
    </li>
  );
}

function ResultFoot({ topic, undoable }: { topic: Topic; undoable: boolean }) {
  const stores = useStores();
  const act = useAction();
  const canDiscuss = useCan('discuss');
  const isHost = useCan('worktree.merge.decide');
  if (topic.archived) return <Foot className="topics-foot--status" text={t('archived.note')} />;
  const undoTopic =
    isHost && undoable ? (
      <Button onClick={() => topicDialogs(stores).open({ kind: 'undo', topicId: topic.id, itemIds: null })}>{t('result.undoTopic')}</Button>
    ) : null;
  if (topic.checked !== undefined) {
    return (
      <Foot className="topics-foot--status" text={joinSentences([t('complete.checked', { name: topic.checked.by.displayName, time: formatClock(topic.checked.at) }), t('result.change')])}>
        {undoTopic}
      </Foot>
    );
  }
  const ready = topic.phase === 'ready';
  return (
    <Foot className="report-foot" text={joinSentences([ready && canDiscuss ? t('result.check.lead') : null, t('result.change')])}>
      {undoTopic}
      {ready && canDiscuss ? (
        <Button variant="primary" icon={<IconCheck />} onClick={() => void act(() => stores.topics.check(topic.id), (reason) => t('result.check.failed', { reason }))}>
          {t('result.check')}
        </Button>
      ) : null}
    </Foot>
  );
}
