// The plan column (DESIGN §5.4, §5.12 item 20): a topic's work items with their state, who is responsible, what is
// always allowed in the topic and what the plan waits for; and the file itself (`specs/<slug>/PLAN.md`) in the
// collaborative editor.
//
// What the Items view says comes from `PlanInfo` (the daemon's reading of the file plus its own state per item) and
// from the topic (`plan.generating`, `valid`, `stale`, `paused`): the sentences are composed in model.ts. "Start"
// opens the Start dialog (`plan.preflight` → `plan.start`), never starts anything by itself.
import { MAIN_ROOT, type AgentSession, type PlanInfo, type PresenceMember, type Topic, type WorkItem } from '@smurg/protocol';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { ColumnMenuItems } from '../../lib/columns/context.tsx';
import { itemLabel } from '../../lib/columns/describe.ts';
import { renderWireText } from '../../lib/errors.ts';
import { formatList, joinSentences } from '../../lib/format.ts';
import { shallowEqual, useStore } from '../../lib/store.ts';
import { selectSession, selectTopicSessions } from '../../lib/stores/sessions.ts';
import { selectPlan } from '../../lib/stores/topics.ts';
import { useNow } from '../../lib/use-now.ts';
import { useCan, useCommand, useStores } from '../../lib/workspace/context.tsx';
import { Avatar, Banner, Button, EmptyState, Segmented, Spinner, type MenuItem } from '../../ui/index.ts';
import { IconCode, IconFileText, IconGitMerge, IconOpenSide, IconPlan, IconPlay, IconUser, IconUsers, IconWand } from '../../ui/icons.tsx';
import { StandaloneDocument, useHeldDocument } from '../editor/standalone.tsx';
import { ReviseBox } from './Discussion.tsx';
import { topicDialogs } from './dialogs.ts';
import { agentAccessNames, itemBadge, itemNames, loads, planFile, planSummary, progressLine, startsByItselfLines, waitingForLine, type PlanSummary } from './model.ts';
import { PlanItems } from './PlanItems.tsx';
import { Foot, LinkButton, Note, Scroll, Toolbar, ToolbarPath, useAction, useMembers, useOpenSide, useTopic } from './shared.tsx';
import { t } from './strings.ts';
import { TopicRules } from './TopicRules.tsx';
import './topics.css';

type View = 'items' | 'file';

/** How many running sessions "Watch running sessions side by side" opens beside the plan (the strip holds four). */
const WATCH_MAX = 3;

export default function PlanColumn({ topicId }: { topicId: string }) {
  const stores = useStores();
  const topic = useTopic(topicId);
  useEffect(() => stores.topics.ensurePlan(topicId), [stores, topicId]);
  if (topic === undefined) {
    return (
      <Note>
        <Spinner size={16} decorative /> {t('loading')}
      </Note>
    );
  }
  return <Plan key={topic.id} topic={topic} />;
}

function Plan({ topic }: { topic: Topic }) {
  const stores = useStores();
  const act = useAction();
  const openSide = useOpenSide();
  const openInCodeMode = useCommand('openInCodeMode');
  const canSuggest = useCan('suggest.create');
  const canDrive = useCan('session.drive');
  const canWrite = useCan('file.write');
  const members = useMembers();
  const plan = useStore(stores.topics, (state) => selectPlan(state, topic.id));
  const planStatus = useStore(stores.topics, (state) => state.planStatus.get(topic.id));
  const sessions = useStore(stores.sessions, (state) => selectTopicSessions(state, topic.id), shallowEqual);
  const file = useMemo(() => planFile(topic), [topic.slug]);
  const [view, setView] = useState<View>('items');
  const [opened, setOpened] = useState(false);
  const [revise, setRevise] = useState<{ initialText?: string } | null>(null);
  const held = useHeldDocument(opened && topic.plan.exists ? file : null);
  const live = !topic.archived;

  useEffect(() => {
    if (view === 'file') setOpened(true);
  }, [view]);
  useEffect(() => {
    if (!topic.plan.exists && view === 'file') setView('items');
  }, [topic.plan.exists, view]);

  const sessionOf = useCallback(
    (item: WorkItem): AgentSession | undefined => {
      if (item.sessionId === undefined) return undefined;
      const found = sessions.find((session) => session.id === item.sessionId) ?? selectSession(stores.sessions.getState(), item.sessionId);
      return found?.kind === 'agent' ? found : undefined;
    },
    [sessions, stores],
  );

  const generate = (): void => {
    void act(
      () => stores.topics.generatePlan(topic.id),
      (reason) => t('spec.generate.failed', { reason }),
    );
  };

  const menu = useMemo<MenuItem[]>(
    () => (topic.plan.exists ? [{ id: 'plan-code', label: t('menu.openInCode'), icon: <IconCode />, onSelect: () => void openInCodeMode({ root: MAIN_ROOT, file: file.path }).catch(() => {}) }] : []),
    [topic.plan.exists, file, openInCodeMode],
  );

  const toolbar = (
    <Toolbar>
      <Segmented<View>
        label={t('plan.view')}
        size="sm"
        value={view}
        onChange={setView}
        options={[
          { id: 'items', label: t('view.items'), icon: <IconPlan size={14} /> },
          { id: 'file', label: t('view.file'), icon: <IconFileText size={14} />, disabled: !topic.plan.exists },
        ]}
      />
      <ToolbarPath path={file.path} />
      {canSuggest && live && topic.plan.exists && topic.phase !== 'complete' ? (
        <Button size="sm" icon={<IconWand />} onClick={() => setRevise({})}>
          {t('revise.open')}
        </Button>
      ) : null}
    </Toolbar>
  );

  const summary = plan ? planSummary(plan, sessionOf) : null;

  return (
    <>
      <ColumnMenuItems items={menu} />
      {toolbar}
      <Scroll hidden={view !== 'items'}>
        <div className="plan col-measure">
          {topic.archived ? (
            <Banner tone="info" live="none">
              {t('archived.note')}
            </Banner>
          ) : null}
          {topic.plan.paused ? (
            <Banner
              tone="warning"
              title={t('plan.paused.title')}
              actions={
                canDrive && live ? (
                  <Button size="sm" variant="primary" onClick={() => void act(() => stores.topics.resume(topic.id), (reason) => t('plan.paused.failed', { reason }))}>
                    {t('plan.paused.continue')}
                  </Button>
                ) : null
              }
            >
              {canDrive ? t('plan.paused.body') : t('plan.paused.body.others', { names: agentAccessNames(members) })}
            </Banner>
          ) : null}
          {topic.plan.generating ? (
            <Banner tone="info" icon={<Spinner size={14} decorative />}>
              {topic.plan.exists ? t('plan.generating.update') : t('plan.generating')}
            </Banner>
          ) : null}
          {topic.plan.exists && !topic.plan.valid && !topic.plan.generating ? (
            <Banner
              tone="danger"
              live="none"
              title={topic.plan.error?.line === undefined ? t('plan.invalid.title') : t('plan.invalid.titleLine', { line: topic.plan.error.line })}
              actions={
                <>
                  <Button size="sm" onClick={() => setView('file')}>
                    {t('plan.invalid.openFile')}
                  </Button>
                  {canSuggest && live ? (
                    <Button size="sm" icon={<IconWand />} onClick={() => setRevise({ initialText: t('plan.invalid.fixText') })}>
                      {t('plan.invalid.fix')}
                    </Button>
                  ) : null}
                </>
              }
            >
              {joinSentences([topic.plan.error === undefined ? null : renderWireText(topic.plan.error.text, topic.plan.error.fallback), plan ? t('plan.invalid.last') : null])}
            </Banner>
          ) : null}
          {topic.plan.stale && topic.plan.exists && !topic.plan.generating ? (
            <Banner
              tone="warning"
              live="none"
              actions={
                canDrive && live ? (
                  <Button size="sm" onClick={generate}>
                    {t('plan.update')}
                  </Button>
                ) : null
              }
            >
              {t('plan.stale')}
            </Banner>
          ) : null}
          {plan && summary && topic.phase === 'complete' ? <Complete topic={topic} plan={plan} summary={summary} /> : null}

          {!topic.plan.exists && !topic.plan.generating ? (
            <EmptyState
              icon={<IconPlan size={24} />}
              title={t('plan.empty.title')}
              description={topic.spec.exists ? t('plan.empty.body') : t('plan.empty.noSpec')}
              action={
                <div className="topics-actions">
                  {canDrive && live && topic.spec.exists ? (
                    <Button variant="primary" icon={<IconPlan />} onClick={generate}>
                      {t('plan.generate')}
                    </Button>
                  ) : null}
                  <Button onClick={() => openSide({ kind: 'spec', topicId: topic.id })}>{t('plan.empty.openSpec')}</Button>
                </div>
              }
            />
          ) : plan === undefined ? (
            planStatus === 'error' ? (
              <Banner tone="danger" live="none" actions={<Button size="sm" onClick={() => void stores.topics.reloadPlan(topic.id).catch(() => {})}>{t('plan.reload')}</Button>}>
                {t('plan.loadFailed')}
              </Banner>
            ) : topic.plan.exists ? (
              <p className="plan__loading">
                <Spinner size={14} decorative /> {t('loading')}
              </p>
            ) : null
          ) : plan === null || summary === null ? null : (
            <PlanBody topic={topic} plan={plan} summary={summary} members={members} sessionOf={sessionOf} />
          )}
        </div>
      </Scroll>
      {held !== null && opened ? (
        <div className="topics-editor" hidden={view !== 'file'}>
          <StandaloneDocument held={held} active={view === 'file'} />
        </div>
      ) : null}
      {view === 'file' && !canWrite ? <Foot className="topics-foot--status" text={t('view.edit.viewer')} /> : null}
      {revise !== null && live ? (
        <ReviseBox topic={topic} target="plan" quote={null} onQuoteRemoved={() => {}} {...(revise.initialText === undefined ? {} : { initialText: revise.initialText })} onClose={() => setRevise(null)} />
      ) : plan && summary && view === 'items' ? (
        <PlanFoot topic={topic} plan={plan} summary={summary} sessionOf={sessionOf} />
      ) : null}
    </>
  );
}

function PlanBody({ topic, plan, summary, members, sessionOf }: { topic: Topic; plan: PlanInfo; summary: PlanSummary; members: readonly PresenceMember[]; sessionOf(item: WorkItem): AgentSession | undefined }) {
  const now = useNow(10_000);
  const inPlan = plan.items.filter((item) => item.inPlan);
  const removed = plan.items.filter((item) => !item.inPlan);
  const waiting = waitingForLine(plan, now);
  return (
    <>
      <div className="plan__summary">
        <div className="plan__counts">
          <strong>{summary.started ? t('summary.reviewed', { reviewed: summary.reviewed, total: summary.total }) : t('summary.items', { count: summary.total })}</strong>
          <span>
            {summary.started
              ? progressLine(summary)
              : [summary.canStart > 0 ? t('summary.canStart', { count: summary.canStart }) : null, summary.waitsOthers > 0 ? t('summary.waitsOthers', { count: summary.waitsOthers }) : null]
                  .filter((part): part is string => part !== null)
                  .join(t('sep'))}
          </span>
        </div>
        {waiting !== '' ? <p className="plan__waiting">{t('waiting.line', { who: waiting })}</p> : null}
        {summary.started ? (
          <div className="plan__bar" aria-hidden="true">
            {inPlan.map((item) => (
              <span key={item.id} data-s={barOf(item, plan, sessionOf)} />
            ))}
          </div>
        ) : null}
      </div>
      {topic.phase === 'complete' ? null : <Assign topic={topic} plan={plan} members={members} started={summary.started} />}
      {plan.warnings.length > 0 ? (
        <Banner tone="warning" live="none">
          <ul className="topics-list">
            {plan.warnings.map((warning, index) => (
              <li key={index}>{renderWireText(warning.text, warning.fallback)}</li>
            ))}
          </ul>
        </Banner>
      ) : null}
      <PlanItems topic={topic} plan={plan} items={inPlan} members={members} sessionOf={sessionOf} label={t('plan.items.label')} />
      {removed.length > 0 ? (
        <section className="plan__removed" aria-label={t('plan.removed.title')}>
          <h3 className="plan__heading">{t('plan.removed.title')}</h3>
          <p className="plan-assign__text">{t('plan.removed.body')}</p>
          <PlanItems topic={topic} plan={plan} items={removed} members={members} sessionOf={sessionOf} label={t('plan.removed.title')} />
        </section>
      ) : null}
    </>
  );
}

function barOf(item: WorkItem, plan: PlanInfo, sessionOf: (item: WorkItem) => AgentSession | undefined): string {
  const bar = itemBadge(item, plan, sessionOf(item)).bar;
  return bar === 'none' ? '' : bar;
}

/** "Who is responsible": the mode, what it means, the suggested split with its reason, and what the topic always allows. */
function Assign({ topic, plan, members, started }: { topic: Topic; plan: PlanInfo; members: readonly PresenceMember[]; started: boolean }) {
  const stores = useStores();
  const act = useAction();
  const canDrive = useCan('session.drive') && !topic.archived;
  const people = [...loads(plan).values()];
  const names = agentAccessNames(members);
  return (
    <div className="plan-assign">
      <div className="plan-assign__row">
        <span className="plan-assign__label">{t('assign.heading')}</span>
        {canDrive ? (
          <Segmented<PlanInfo['mode']>
            label={t('assign.heading')}
            size="sm"
            value={plan.mode}
            onChange={(mode) => {
              if (mode !== plan.mode) void act(() => stores.topics.setPlanMode(topic.id, mode), (reason) => t('assign.failed', { reason }));
            }}
            options={[
              { id: 'assigned', label: t('assign.mode.assigned'), icon: <IconUser size={14} /> },
              { id: 'everyone', label: t('assign.mode.everyone'), icon: <IconUsers size={14} /> },
            ]}
          />
        ) : (
          <span className="plan-assign__mode">{plan.mode === 'assigned' ? t('assign.mode.assigned') : t('assign.mode.everyone')}</span>
        )}
      </div>
      {plan.mode === 'everyone' ? (
        <p className="plan-assign__text">{t('assign.everyone.text', { names })}</p>
      ) : (
        <>
          {!started && plan.split !== undefined ? (
            <p className="plan-assign__text">
              {joinSentences([
                plan.split.source === 'agent' ? (plan.split.reason === undefined || plan.split.reason.trim() === '' ? t('assign.split.agent') : t('assign.split.agentReason', { reason: plan.split.reason })) : t('assign.split.smurg'),
                t('assign.assigned.text'),
              ])}
            </p>
          ) : !started ? (
            <p className="plan-assign__text">{t('assign.assigned.text')}</p>
          ) : null}
          <div className="plan-assign__people">
            {people.map((entry) => (
              <span key={entry.user.userId} className="plan-load">
                <Avatar name={entry.user.displayName} size="xs" decorative color={members.find((member) => member.userId === entry.user.userId)?.color ?? ''} />
                {t('split.load', { name: entry.user.displayName, count: entry.count })}
              </span>
            ))}
            {canDrive && !started ? (
              <LinkButton onClick={() => void act(() => stores.topics.suggestSplit(topic.id), (reason) => t('assign.failed', { reason }))}>{t('assign.suggestAgain')}</LinkButton>
            ) : null}
          </div>
        </>
      )}
      <TopicRules topic={topic} />
    </div>
  );
}

/** "Topic complete", with what is still open: reviewed items the host has not merged. */
function Complete({ topic, plan, summary }: { topic: Topic; plan: PlanInfo; summary: PlanSummary }) {
  const stores = useStores();
  const canArchive = useCan('session.create') && !topic.archived;
  const open = summary.reviewedNotMerged;
  return (
    <Banner
      tone="success"
      live="none"
      className="plan-done"
      title={t('complete.title')}
      actions={
        canArchive ? (
          <Button size="sm" onClick={() => topicDialogs(stores).open({ kind: 'archive', topicId: topic.id })}>
            {t('archive.action')}
          </Button>
        ) : null
      }
    >
      {open.length === 0
        ? t('complete.body')
        : t('complete.body.unmerged', {
            items: itemNames(
              plan,
              open.map((item) => item.id),
            ),
          })}
    </Banner>
  );
}

function PlanFoot({ topic, plan, summary, sessionOf }: { topic: Topic; plan: PlanInfo; summary: PlanSummary; sessionOf(item: WorkItem): AgentSession | undefined }) {
  const stores = useStores();
  const openSide = useOpenSide();
  const canStart = useCan('session.create');
  const isHost = useCan('worktree.merge.decide');
  const members = useMembers();
  if (topic.archived) return null;

  const nextToMerge = summary.reviewedNotMerged.find((item) => item.merge?.ready === true && item.merge.status !== 'conflict') ?? summary.reviewedNotMerged[0];
  const mergeButton =
    isHost && nextToMerge !== undefined ? (
      <Button icon={<IconGitMerge />} onClick={() => openSide({ kind: 'report', topicId: topic.id, itemId: nextToMerge.id })} title={itemLabel(nextToMerge)}>
        {t('foot.nextMerge')}
      </Button>
    ) : null;
  // A complete topic has nothing left to start: only the host's way to what is not merged yet.
  if (topic.phase === 'complete') return mergeButton === null ? null : <Foot>{mergeButton}</Foot>;

  const byItself = startsByItselfLines(plan);
  const running = plan.items.filter((item) => item.inPlan && item.state === 'running' && sessionOf(item) !== undefined);
  // The button counts what starts NOW; when everything left waits for another item, what a Start would arm.
  const startable = summary.canStart > 0 ? summary.canStart : summary.startable.length;
  const text: string[] = [];
  if (!topic.versioned) text.push(t('foot.noGit'));
  else if (startable > 0) text.push(canStart ? t('foot.start') : t('foot.start.others', { names: agentAccessNames(members) }));
  text.push(...byItself);

  return (
    <Foot text={text.length === 0 ? undefined : joinSentences(text)}>
      {mergeButton}
      {running.length > 1 ? (
        <Button
          icon={<IconOpenSide />}
          onClick={() => {
            for (const item of running.slice(0, WATCH_MAX)) openSide({ kind: 'session', sessionId: item.sessionId as string });
          }}
          title={formatList(running.slice(0, WATCH_MAX).map((item) => itemLabel(item)))}
        >
          {t('foot.watch')}
        </Button>
      ) : null}
      {canStart && startable > 0 && topic.plan.valid ? (
        <Button variant="primary" icon={<IconPlay />} disabled={topic.plan.generating} onClick={() => topicDialogs(stores).open({ kind: 'start', topicId: topic.id })}>
          {summary.started ? t('foot.startMore', { count: startable }) : t('foot.startAll', { count: startable })}
        </Button>
      ) : null}
    </Foot>
  );
}
