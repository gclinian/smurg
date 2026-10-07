// The result report column (DESIGN §5.4, §5.12 item 22): what the agent wrote when a work item was done, under
// headings from the web catalogue (the file's own headings are fixed English), the changes behind it, the follow-ups
// asked from here, and the review.
//
//   "Ask about this result, or tell Claude what to change"   `report.followUp` (a suggestion from an Editor)
//   "I've reviewed this"                                     `report.review` with the version ON SCREEN; unfinished
//                                                            work (partial, blocked) asks once
//   then for the host "Merge…" (the complete diff review), for a member with agent access "Request merge" while
//   nobody reviewed.
import {
  isSmurgError,
  knownErrorReasonOf,
  mayReview,
  type MergeRequest,
  type ReportInfo,
  type ReportOutcome,
  type Topic,
  type WorkItem,
  type WorktreeInfo,
} from '@smurg/protocol';
import { useEffect, useState, type ReactNode } from 'react';
import { formatAnd, joinSentences } from '../../lib/format.ts';
import { ColumnHeaderExtra } from '../../lib/columns/context.tsx';
import { describeError, renderWireText } from '../../lib/errors.ts';
import { useStore } from '../../lib/store.ts';
import { selectPlan, selectReport } from '../../lib/stores/topics.ts';
import { useCan, useCommand, useMember, useStores } from '../../lib/workspace/context.tsx';
import { tApp } from '../../strings/app.ts';
import { Avatar, Badge, Banner, Button, Spinner, useToast, type Tone } from '../../ui/index.ts';
import { IconAgent, IconAlertTriangle, IconCheck, IconCheckCircle, IconComment, IconGitBranch, IconGitMerge, IconLightbulb, IconShield } from '../../ui/icons.tsx';
import { Markdown } from '../markdown/index.ts';
import { ChangedFiles } from '../worktree/index.tsx';
import { AskBox } from './AskBox.tsx';
import { topicDialogs } from './dialogs.ts';
import { agentAccessNames, isMerged, openChangesAsked, outcomeLabel } from './model.ts';
import { Foot, LinkButton, Note, Scroll, formatClock, useAction, useMembers, useOpenSide, useSentNotice, useTopic } from './shared.tsx';
import { t } from './strings.ts';
import './topics.css';

const OUTCOME_TONE: Readonly<Record<ReportOutcome, Tone>> = { complete: 'success', partial: 'warning', blocked: 'warning' };

export default function ReportColumn({ topicId, itemId }: { topicId: string; itemId: string }) {
  const stores = useStores();
  const topic = useTopic(topicId);
  const report = useStore(stores.topics, (state) => selectReport(state, topicId, itemId));
  const item = useStore(stores.topics, (state) => selectPlan(state, topicId)?.items.find((candidate) => candidate.id === itemId));
  const [failure, setFailure] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  // A column restored with the page is mounted before the first admission: ask once the lists are there (after a
  // resync the store fetches every report that was asked for by itself).
  const ready = useStore(stores.topics, (state) => state.status === 'ready');

  useEffect(() => stores.topics.ensurePlan(topicId), [stores, topicId]);
  useEffect(() => {
    if (!ready) return;
    let current = true;
    setFailure(null);
    stores.topics.loadReport(topicId, itemId).catch((error: unknown) => {
      if (current) setFailure(describeError(error));
    });
    return () => {
      current = false;
    };
  }, [stores, topicId, itemId, attempt, ready]);

  if (topic === undefined || report === undefined) {
    return failure !== null ? (
      <Note>
        <span>{t('report.loadFailed', { reason: failure })}</span>
        <Button size="sm" onClick={() => setAttempt((n) => n + 1)}>
          {tApp('common.retry')}
        </Button>
      </Note>
    ) : (
      <Note>
        <Spinner size={16} decorative /> {t('loading')}
      </Note>
    );
  }
  return <Report topic={topic} report={report} item={item} />;
}

function Section({ icon, title, meta, className, children }: { icon: ReactNode; title: string; meta?: ReactNode; className?: string; children: ReactNode }) {
  return (
    <section className={className === undefined ? 'report-sec' : `report-sec ${className}`}>
      <h3 className="report-sec__h">
        {icon}
        {title}
        {meta !== undefined ? <span className="report-sec__meta">{meta}</span> : null}
      </h3>
      {children}
    </section>
  );
}

function Report({ topic, report, item }: { topic: Topic; report: ReportInfo; item: WorkItem | undefined }) {
  const stores = useStores();
  const openSide = useOpenSide();
  const openInCodeMode = useCommand('openInCodeMode');
  const member = useMember();
  const members = useMembers();
  const canSuggest = useCan('suggest.create');
  const canDrive = useCan('session.drive');
  const sent = useSentNotice('item');
  const worktree = useStore(stores.worktrees, (state) => (item?.worktreeId === undefined ? undefined : state.worktrees.get(item.worktreeId)));
  const request = useStore(stores.worktrees, (state) => (report.changes === undefined ? undefined : state.mergeRequests.get(report.changes.requestId)));
  const merged = item !== undefined ? isMerged(item) : request?.status === 'merged';
  // Merged and reviewed: the item is finished and its session has ended (`report.closed`).
  const closed = merged && report.state === 'reviewed';
  const live = !topic.archived;
  const changes = report.changes;
  // The report on screen is the newest word about its own state (the plan's copy of the summary follows a moment later).
  const asked = item === undefined ? undefined : openChangesAsked({ changesAsked: item.changesAsked, report });

  return (
    <>
      <ColumnHeaderExtra>
        <Badge tone={OUTCOME_TONE[report.outcome]}>{outcomeLabel(report.outcome)}</Badge>
      </ColumnHeaderExtra>
      <Scroll>
        <div className="report col-measure">
          <div className="report__facts">
            <StateBadge report={report} selfUserId={member?.userId ?? null} />
            <span className="report__checks">{t('report.checks', { passed: report.checks.passed, notVerified: report.checks.notVerified })}</span>
            <span>
              <IconAgent size={14} />
              {report.version > 1 ? t('report.writtenVersion', { time: formatClock(report.writtenAt), version: report.version }) : t('report.written', { time: formatClock(report.writtenAt) })}
            </span>
            {worktree !== undefined ? (
              <span>
                <IconGitBranch size={14} />
                <span className="report__branch">{worktree.branch}</span>
              </span>
            ) : null}
            {item?.sessionId !== undefined ? <LinkButton onClick={() => openSide({ kind: 'session', sessionId: item.sessionId as string })}>{t('report.openSession')}</LinkButton> : null}
          </div>
          {report.state === 'invalid' ? (
            <Banner tone="danger" live="none" title={report.error?.line === undefined ? t('report.invalid') : t('report.invalidLine', { line: report.error.line })}>
              {report.error === undefined ? null : renderWireText(report.error.text, report.error.fallback)}
            </Banner>
          ) : null}
          {asked !== undefined ? (
            <Banner tone="info" live="none">
              {t('report.changesAsked', { name: asked.by.displayName, time: formatClock(asked.at) })}
            </Banner>
          ) : null}
          <Section icon={<IconCheckCircle size={14} />} title={t('report.section.done')}>
            <Markdown text={report.sections.done} headingBase={4} />
          </Section>
          <Section icon={<IconLightbulb size={14} />} title={t('report.section.why')}>
            <Markdown text={report.sections.why} headingBase={4} />
          </Section>
          <Section icon={<IconShield size={14} />} title={t('report.section.verified')}>
            {report.sections.verified.length === 0 ? (
              <p className="report__none">{t('report.verified.none')}</p>
            ) : (
              <ul className="report-checks">
                {report.sections.verified.map((check, index) => (
                  <li key={index} data-passed={check.passed}>
                    {check.passed ? <IconCheck size={14} /> : <IconAlertTriangle size={14} />}
                    <div>
                      <span className="ui-visually-hidden">{check.passed ? t('report.check.passed') : t('report.check.notVerified')} </span>
                      <Markdown text={check.text} headingBase={4} />
                      {check.note !== undefined ? <Markdown className="report-checks__note" text={check.note} headingBase={4} /> : null}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </Section>
          <Section icon={<IconAlertTriangle size={14} />} title={t('report.section.watchOut')} className="report-watch">
            <Markdown text={report.sections.watchOut} headingBase={4} />
          </Section>
          <Section
            icon={<IconGitBranch size={14} />}
            title={t('report.section.changes')}
            {...(changes === undefined ? {} : { meta: t('report.changes.counts', { files: t('report.changes.files', { count: changes.files }), additions: changes.additions, deletions: changes.deletions }) })}
          >
            {changes === undefined ? (
              <p className="report__none">{report.noChanges === undefined ? t('report.changes.none') : t(`report.noChanges.${report.noChanges}`)}</p>
            ) : (
              <ChangedFiles
                // A new report version is a new request: the list starts over.
                key={changes.requestId}
                requestId={changes.requestId}
                byHand={changes.byHand}
                onOpenFile={worktree === undefined || merged ? undefined : (path) => void openInCodeMode({ root: { kind: 'worktree', worktreeId: worktree.id }, file: path, ...(item?.sessionId === undefined ? {} : { sessionId: item.sessionId }) }).catch(() => {})}
              />
            )}
          </Section>
          {report.sections.followUps !== undefined && report.sections.followUps.trim() !== '' ? (
            <Section icon={<IconLightbulb size={14} />} title={t('report.section.followUps')}>
              <Markdown text={report.sections.followUps} headingBase={4} />
            </Section>
          ) : null}
          {report.questions.length > 0 ? (
            <Section icon={<IconComment size={14} />} title={t('report.section.questions')}>
              <ol className="report-thread">
                {report.questions.map((question) => (
                  <li key={question.id} className="report-thread__entry">
                    <div className="report-thread__item">
                      <Avatar name={question.from.displayName} size="sm" decorative color={members.find((person) => person.userId === question.from.userId)?.color ?? ''} />
                      <div>
                        <b>{question.from.displayName}</b> <time dateTime={new Date(question.at).toISOString()}>{formatClock(question.at)}</time>
                        <Markdown text={question.text} headingBase={4} breaks />
                        {question.truncated ? <p className="report__none">{t('report.question.cut')}</p> : null}
                      </div>
                    </div>
                    {question.answer !== undefined ? (
                      <div className="report-thread__item">
                        <Avatar name={t('report.agent')} size="sm" status="agent" decorative />
                        <div>
                          <b>{t('report.agent')}</b> <time dateTime={new Date(question.answer.at).toISOString()}>{formatClock(question.answer.at)}</time>
                          <Markdown text={question.answer.text} headingBase={4} />
                          {question.answer.truncated ? <p className="report__none">{t('report.question.cut')}</p> : null}
                        </div>
                      </div>
                    ) : (
                      <p className="report__none">{t('report.question.waiting')}</p>
                    )}
                  </li>
                ))}
              </ol>
            </Section>
          ) : null}
        </div>
      </Scroll>
      {closed ? (
        <Foot className="topics-foot--status" text={t('report.closed')}>
          {topic.discussionSessionId !== undefined ? <LinkButton onClick={() => openSide({ kind: 'session', sessionId: topic.discussionSessionId as string })}>{t('discussion.open')}</LinkButton> : null}
        </Foot>
      ) : canSuggest && live ? (
        <AskBox
          draftKey={`follow-up:${topic.id}:${report.itemId}`}
          label={canDrive ? t('followUp.label') : t('followUp.label.suggestion')}
          placeholder={canDrive ? t('followUp.label') : t('followUp.label.suggestion')}
          hint={canDrive ? t('followUp.hint') : t('revise.hint.suggestion', { names: agentAccessNames(members) })}
          sendLabel={canDrive ? t('followUp.send') : t('revise.send.suggestion')}
          onSend={async (text) => {
            sent(await stores.topics.followUp({ topicId: topic.id, itemId: report.itemId, text }));
          }}
        />
      ) : null}
      {live ? <ReviewFoot topic={topic} report={report} item={item} request={request} worktree={worktree} merged={merged === true} /> : <Foot className="topics-foot--status" text={t('archived.note')} />}
    </>
  );
}

function StateBadge({ report, selfUserId }: { report: ReportInfo; selfUserId: string | null }) {
  if (report.state === 'reviewed' && report.review !== undefined) {
    return (
      <Badge tone="success">
        <IconCheck size={12} /> {t('report.state.reviewed', { name: report.review.by.displayName, time: formatClock(report.review.at) })}
      </Badge>
    );
  }
  if (report.state === 'invalid') return <Badge tone="danger">{t('badge.reportInvalid')}</Badge>;
  const mine = selfUserId !== null && report.reviewers.some((reviewer) => reviewer.userId === selfUserId);
  const waits = mine ? t('report.state.waitsYou') : report.reviewers.length === 1 ? t('report.state.waitsFor', { name: (report.reviewers[0] as { displayName: string }).displayName }) : t('report.state.waits');
  return <Badge tone="warning">{report.state === 'changed-after-review' ? t('report.state.changed', { waits }) : waits}</Badge>;
}

/** The last line of the column: who reviews, "I've reviewed this", and what happens to the change afterwards. */
function ReviewFoot({ topic, report, item, request, worktree, merged }: { topic: Topic; report: ReportInfo; item: WorkItem | undefined; request: MergeRequest | undefined; worktree: WorktreeInfo | undefined; merged: boolean }) {
  const stores = useStores();
  const toast = useToast();
  const act = useAction();
  const member = useMember();
  const isHost = useCan('worktree.merge.decide');
  const canRequest = useCan('worktree.merge.request');
  const canDrive = useCan('session.drive');
  const canAsk = useCan('suggest.create');
  const [busy, setBusy] = useState(false);
  const [confirmUnfinished, setConfirmUnfinished] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  const reviewerIds = report.reviewers.map((reviewer) => reviewer.userId);
  const escalated = report.escalatedAt !== undefined;
  const may = member !== null && mayReview(member, { reviewers: reviewerIds, escalated });
  const instead = may && !reviewerIds.includes(member.userId);
  const toReview = report.state === 'to-review' || report.state === 'changed-after-review';
  const unfinished = report.outcome !== 'complete';

  const review = async (acknowledge: boolean): Promise<void> => {
    setBusy(true);
    setFailure(null);
    try {
      await stores.topics.review({ topicId: topic.id, itemId: report.itemId, version: report.version, ...(acknowledge ? { acknowledgeUnfinished: true } : {}) });
      setConfirmUnfinished(false);
      toast.show({ tone: 'success', title: t('review.done') });
    } catch (error) {
      const reason = isSmurgError(error) ? knownErrorReasonOf(error) : null;
      if (reason === 'unfinished') setConfirmUnfinished(true);
      else if (reason === 'report-changed') {
        // The agent wrote a newer version meanwhile: show it; nothing was marked.
        setFailure(t('review.changed'));
        stores.topics.loadReport(topic.id, report.itemId).catch(() => {});
      } else setFailure(t('review.failed', { reason: describeError(error) }));
    } finally {
      setBusy(false);
    }
  };

  const problem =
    failure !== null ? (
      <p className="report-foot__problem" role="alert">
        {failure}
      </p>
    ) : null;

  // A merge that stopped on a conflict is said in EVERY state of the report, with the way through the agent: the host
  // may merge a change nobody reviewed yet, and the inbox row of the conflict leads here.
  const conflict = request?.status === 'conflict' && !merged;
  const conflictLine = conflict ? t('review.conflict') : null;
  const resolve =
    conflict && canDrive && item !== undefined ? (
      <Button onClick={() => void act(() => stores.topics.resolveItem(topic.id, report.itemId), (reason) => t('item.failed', { item: item.title, reason }))}>{t('item.resolve')}</Button>
    ) : null;

  if (toReview) {
    if (!may) {
      const names = formatAnd(report.reviewers.map((reviewer) => reviewer.displayName));
      // A viewer has no box to ask in: the sentence does not promise one.
      const others = report.reviewers.length === 1 ? t(canAsk ? 'review.others.one' : 'review.others.one.readOnly', { name: names }) : t(canAsk ? 'review.others.many' : 'review.others.many.readOnly');
      return (
        <Foot className="report-foot" text={joinSentences([conflictLine, others])}>
          {resolve}
          {canRequest && !isHost && worktree !== undefined && request?.status === 'draft' ? <RequestMerge worktree={worktree} /> : null}
          {isHost && request !== undefined && !merged ? <MergeButton requestId={request.id} /> : null}
        </Foot>
      );
    }
    if (confirmUnfinished) {
      return (
        <Foot className="report-foot" text={t('review.unfinished', { outcome: outcomeLabel(report.outcome).toLocaleLowerCase() })}>
          <Button variant="ghost" onClick={() => setConfirmUnfinished(false)} disabled={busy}>
            {tApp('common.cancel')}
          </Button>
          <Button variant="primary" loading={busy} onClick={() => void review(true)}>
            {t('review.unfinished.confirm')}
          </Button>
          {problem}
        </Foot>
      );
    }
    return (
      <Foot className="report-foot" text={joinSentences([conflictLine, report.state === 'changed-after-review' ? t('review.again') : t('review.lead')])}>
        {resolve}
        {isHost && request !== undefined && !merged ? <MergeButton requestId={request.id} secondary /> : null}
        {canRequest && !isHost && worktree !== undefined && request?.status === 'draft' ? <RequestMerge worktree={worktree} /> : null}
        <Button variant="primary" icon={<IconCheck />} loading={busy} onClick={() => (unfinished ? setConfirmUnfinished(true) : void review(false))}>
          {instead && report.reviewers.length === 1 ? t('review.instead', { name: (report.reviewers[0] as { displayName: string }).displayName }) : t('review.action')}
        </Button>
        {problem}
      </Foot>
    );
  }

  if (report.state === 'invalid') {
    // The report cannot be reviewed, but a request of it may still wait in the host's inbox (reviewed before the
    // report broke, or stopped on a conflict): the host decides it from here.
    return (
      <Foot className="report-foot" text={joinSentences([t('review.invalid'), conflictLine])}>
        {resolve}
        {isHost && request !== undefined && !merged && request.status !== 'rejected' ? <MergeButton requestId={request.id} /> : null}
      </Foot>
    );
  }

  // Reviewed: what became of the change.
  const by = report.review === undefined ? null : t('review.by', { name: report.review.by.displayName, time: formatClock(report.review.at) });
  const insteadOf = report.review?.insteadOf === undefined ? null : t('review.insteadOf', { name: report.review.insteadOf.displayName });
  /** Who reviewed it, then what became of the change. */
  const reviewed = (then: string): string => joinSentences([by, insteadOf, then]);
  if (merged) {
    const mergedBy = request?.decidedAt === undefined ? t('review.merged') : t('review.mergedAt', { time: formatClock(request.decidedAt) });
    return <Foot className="report-foot" text={reviewed(mergedBy)} />;
  }
  if (request === undefined || report.changes === undefined) return <Foot className="report-foot" text={reviewed(t('review.noChanges'))} />;
  if (request.status === 'conflict') {
    return (
      <Foot className="report-foot" text={reviewed(t('review.conflict'))}>
        {resolve}
        {isHost ? <MergeButton requestId={request.id} /> : null}
      </Foot>
    );
  }
  if (request.status === 'rejected') return <Foot className="report-foot" text={reviewed(request.rejectReason ? t('review.rejectedReason', { reason: request.rejectReason }) : t('review.rejected'))} />;
  return (
    <Foot className="report-foot" text={reviewed(isHost ? t('review.ready.host') : t('review.ready'))}>
      {isHost ? <MergeButton requestId={request.id} /> : null}
    </Foot>
  );
}

/** The host's "Merge…": the complete diff review (the dialog of the worktree feature). */
function MergeButton({ requestId, secondary = false }: { requestId: string; secondary?: boolean }) {
  const stores = useStores();
  return (
    <Button variant={secondary ? 'secondary' : 'primary'} icon={<IconGitMerge />} onClick={() => topicDialogs(stores).open({ kind: 'merge', requestId })}>
      {t('review.merge')}
    </Button>
  );
}

/** A member with agent access asks the host to merge work nobody reviewed yet (`worktree.merge.request`). */
function RequestMerge({ worktree }: { worktree: WorktreeInfo }) {
  const stores = useStores();
  const toast = useToast();
  const act = useAction();
  return (
    <Button
      icon={<IconGitMerge />}
      onClick={() =>
        void act(
          () => stores.worktrees.requestMerge(worktree.id),
          (reason) => t('review.requestFailed', { reason }),
        ).then((ok) => {
          if (ok) toast.show({ tone: 'success', title: t('review.requested') });
        })
      }
    >
      {t('review.request')}
    </Button>
  );
}
