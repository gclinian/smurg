// The Start dialog (DESIGN §4.5, §5.12 item 21): Start is the one click with large effects, so one dialog lists them
// (`plan.preflight`) before `plan.start` runs. Start pins what the dialog showed (the plan's revision and the two
// files' hashes): when a file changed meanwhile the daemon refuses, and the dialog loads the list again.
import { isSmurgError, knownErrorReasonOf, type StartPreflight } from '@smurg/protocol';
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { describeError } from '../../lib/errors.ts';
import { useStore } from '../../lib/store.ts';
import { selectPlan } from '../../lib/stores/topics.ts';
import { useCan, useCommand, useMember, useStores } from '../../lib/workspace/context.tsx';
import { tApp } from '../../strings/app.ts';
import { Banner, Button, Dialog, Spinner, useToast } from '../../ui/index.ts';
import { IconAlertCircle, IconAlertTriangle, IconCheck, IconEdit, IconFolder, IconGitBranch, IconPlay, IconQuestion, IconShield, IconUser } from '../../ui/icons.tsx';
import { PlanChanges } from './PlanChanges.tsx';
import { LinkButton, useAction, useTopic } from './shared.tsx';
import { startCount, startHeadCount, startLines, startedNotice, type StartLine, type StartLineId } from './start-model.ts';
import { t } from './strings.ts';
import { TopicRules } from './TopicRules.tsx';

type Load = { status: 'loading' } | { status: 'ready'; preflight: StartPreflight } | { status: 'error'; message: string };

const ICON: Readonly<Record<StartLineId, ReactNode>> = {
  starts: <IconPlay size={14} />,
  waits: <IconPlay size={14} />,
  already: <IconCheck size={14} />,
  responsible: <IconUser size={14} />,
  offline: <IconUser size={14} />,
  youDecide: <IconQuestion size={14} />,
  commit: <IconGitBranch size={14} />,
  handEdits: <IconEdit size={14} />,
  invisible: <IconAlertTriangle size={14} />,
  stale: <IconAlertTriangle size={14} />,
  openQuestion: <IconQuestion size={14} />,
  editingNow: <IconEdit size={14} />,
  specOpenQuestions: <IconQuestion size={14} />,
  settings: <IconShield size={14} />,
  shared: <IconFolder size={14} />,
  blocker: <IconAlertCircle size={14} />,
};

export function StartDialog({ topicId, itemIds, onClose }: { topicId: string; itemIds?: readonly string[] | undefined; onClose(): void }) {
  const stores = useStores();
  const toast = useToast();
  const act = useAction();
  const member = useMember();
  const isHost = useCan('admin');
  const openColumn = useCommand('openColumn');
  const topic = useTopic(topicId);
  const plan = useStore(stores.topics, (state) => selectPlan(state, topicId));
  const [attempt, setAttempt] = useState(0);
  const [load, setLoad] = useState<Load>({ status: 'loading' });
  const [changed, setChanged] = useState(false);
  const [showChanges, setShowChanges] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const idsKey = itemIds?.join(',') ?? '';

  useEffect(() => stores.topics.ensurePlan(topicId), [stores, topicId]);
  useEffect(() => {
    let current = true;
    setLoad({ status: 'loading' });
    stores.topics.preflight(topicId, idsKey === '' ? undefined : idsKey.split(',')).then(
      (preflight) => {
        if (current) setLoad({ status: 'ready', preflight });
      },
      (error: unknown) => {
        if (current) setLoad({ status: 'error', message: describeError(error) });
      },
    );
    return () => {
      current = false;
    };
  }, [stores, topicId, idsKey, attempt]);

  const reload = useCallback(() => setAttempt((n) => n + 1), []);
  const preflight = load.status === 'ready' ? load.preflight : null;
  const startable = preflight !== null && preflight.blockers.length === 0 && startCount(preflight) > 0;
  const headCount = preflight === null ? 0 : startHeadCount(preflight);

  const start = async (): Promise<void> => {
    if (preflight === null || !startable) return;
    setBusy(true);
    setFailure(null);
    try {
      await stores.topics.start({
        topicId,
        ...(itemIds === undefined ? {} : { itemIds: [...itemIds] }),
        planRevision: preflight.planRevision,
        specHash: preflight.specHash,
        planHash: preflight.planHash,
      });
      toast.show({ tone: 'success', ...startedNotice(preflight) });
      onClose();
    } catch (error) {
      if (isSmurgError(error) && knownErrorReasonOf(error) === 'plan-changed') {
        // What was confirmed is no longer what the files say: show the list again, nothing was started.
        setChanged(true);
        setShowChanges(false);
        reload();
      } else {
        setFailure(t('start.failed', { reason: describeError(error) }));
      }
    } finally {
      setBusy(false);
    }
  };

  const updateFirst = (): void => {
    onClose();
    void act(
      () => stores.topics.generatePlan(topicId),
      (reason) => t('spec.generate.failed', { reason }),
    );
  };

  const action = (line: StartLine): ReactNode => {
    if (line.id === 'handEdits' || line.id === 'invisible') {
      return <LinkButton onClick={() => setShowChanges((shown) => !shown)}>{showChanges ? t('start.hideChanges') : t('start.showChanges')}</LinkButton>;
    }
    if (line.id === 'stale') return <LinkButton onClick={updateFirst}>{t('start.updateFirst')}</LinkButton>;
    if (line.id === 'shared' && isHost) {
      return (
        <LinkButton
          onClick={() => {
            onClose();
            void openColumn({ target: { kind: 'console', section: 'settings' } }).catch(() => {});
          }}
        >
          {t('start.sharedSetting')}
        </LinkButton>
      );
    }
    return null;
  };

  const lines = preflight === null || !plan ? [] : startLines(preflight, plan, member?.userId ?? null);
  // "Show the changes" stands once, under the first line that offers it.
  const changesAfter = lines.find((line) => line.id === 'handEdits' || line.id === 'invisible');

  return (
    <Dialog
      open
      onClose={onClose}
      size="lg"
      title={headCount === 0 ? t('start.title') : t('start.titleCount', { count: headCount })}
      description={t('start.lead')}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            {tApp('common.cancel')}
          </Button>
          <Button variant="primary" icon={<IconPlay />} loading={busy} disabled={!startable} onClick={() => void start()}>
            {t('start.go')}
          </Button>
        </>
      }
    >
      <div className="start">
        {changed ? (
          <Banner tone="warning" live="alert">
            {t('start.changed')}
          </Banner>
        ) : null}
        {load.status === 'loading' || (load.status === 'ready' && plan === undefined) ? (
          <p className="topics-changes__note">
            <Spinner size={14} decorative /> {t('start.loading')}
          </p>
        ) : null}
        {load.status === 'error' ? (
          <Banner tone="danger" live="alert" actions={<Button size="sm" onClick={reload}>{tApp('common.retry')}</Button>}>
            {t('start.loadFailed', { reason: load.message })}
          </Banner>
        ) : null}
        {lines.length > 0 ? (
          <ul className="start-list">
            {lines.map((line, index) => (
              <li key={`${line.id}-${index}`} className="start-line" data-tone={line.tone} data-line={line.id}>
                {line.tone === 'warn' && line.id !== 'offline' ? <IconAlertTriangle size={14} /> : ICON[line.id]}
                <div>
                  <span>
                    {line.tone === 'danger' ? <span className="ui-visually-hidden">{t('start.blocker')} </span> : null}
                    {line.text}
                  </span>{' '}
                  {action(line)}
                  {line === changesAfter && showChanges ? <PlanChanges topicId={topicId} /> : null}
                </div>
              </li>
            ))}
            {topic !== undefined ? (
              <li className="start-line" data-tone="plain" data-line="rules">
                <IconShield size={14} />
                <div>
                  <TopicRules topic={topic} />
                  <span className="start-line__note">{t('start.rules.note')}</span>
                </div>
              </li>
            ) : null}
          </ul>
        ) : null}
        {failure !== null ? (
          <Banner tone="danger" live="alert">
            {failure}
          </Banner>
        ) : null}
      </div>
    </Dialog>
  );
}
