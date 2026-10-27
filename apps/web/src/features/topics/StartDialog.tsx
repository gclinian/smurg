// The Start dialog (DESIGN §4.5, §5.12 item 21): Start is the one click with large effects, so one dialog lists them
// (`plan.preflight`) before `plan.start` runs. Start pins what the dialog showed (the plan's revision and the two
// files' hashes): when a file changed meanwhile the daemon refuses, and the dialog loads the list again.
//
// Protocol 5 (DESIGN 0.6.0 D18): how the items run decides one block (`history`): the folder's own git (the commit
// lines), smurg's own history (its line, nested repositories, a cloud-synced folder), or directly in the shared folder
// when the host's computer cannot run git: a warning the host must tick before Start, and for anyone else the sentence
// that only the host can start them, with no Start button. The topic's model and the mode its items run with are
// chosen here too, and sent with the Start (`plan.start.agent`) when changed.
//
// Protocol 6 (DESIGN 0.7.0 D3, D19): how the items reach the main workspace. While the workspace merges by itself and
// HEAD is on a branch, the dialog offers "How its items are merged" (smurg merges what its report says is complete and
// verified, or the host merges each item); the lines say what runs by itself, what stops the run and that nobody has to
// stay. A Start that chose the host sends `merging: 'host'`.
import { isSmurgError, knownErrorReasonOf, type MergePolicy, type SessionModeChoice, type StartPreflight } from '@smurg/protocol';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { describeError, renderWireText } from '../../lib/errors.ts';
import { gapAfter } from '../../lib/format.ts';
import { useStore } from '../../lib/store.ts';
import { selectWork } from '../../lib/stores/host.ts';
import { selectPlan } from '../../lib/stores/topics.ts';
import { useCan, useCommand, useMember, useStores } from '../../lib/workspace/context.tsx';
import { tApp } from '../../strings/app.ts';
import { Banner, Button, Dialog, Select, Spinner, useToast } from '../../ui/index.ts';
import {
  IconAgent,
  IconAlertCircle,
  IconAlertTriangle,
  IconCheck,
  IconCloudOff,
  IconEdit,
  IconFolder,
  IconGitBranch,
  IconGitMerge,
  IconHistory,
  IconPlay,
  IconQuestion,
  IconShield,
  IconUser,
} from '../../ui/icons.tsx';
import { ModelPicker } from '../agents/ModelPicker.tsx';
import { ModePicker } from '../agents/ModePicker.tsx';
import { resultingMode } from '../agents/agent-choice.ts';
import { PlanChanges } from './PlanChanges.tsx';
import { LinkButton, useAction, useMembers, useTopic } from './shared.tsx';
import {
  directAllows,
  initialMerging,
  offersMergeChoice,
  startAgentPatch,
  startCount,
  startHeadCount,
  startLines,
  startMergingPatch,
  startedNotice,
  type StartLine,
  type StartLineId,
} from './start-model.ts';
import { t } from './strings.ts';
import { TopicRules, useWorkspaceMode } from './TopicRules.tsx';

type Load = { status: 'loading' } | { status: 'ready'; preflight: StartPreflight } | { status: 'error'; message: string };

const ICON: Readonly<Record<StartLineId, ReactNode>> = {
  starts: <IconPlay size={14} />,
  waits: <IconPlay size={14} />,
  already: <IconCheck size={14} />,
  responsible: <IconUser size={14} />,
  offline: <IconUser size={14} />,
  youDecide: <IconQuestion size={14} />,
  commit: <IconGitBranch size={14} />,
  smurgHistory: <IconHistory size={14} />,
  nestedRepos: <IconGitBranch size={14} />,
  cloudSynced: <IconCloudOff size={14} />,
  handEdits: <IconEdit size={14} />,
  invisible: <IconAlertTriangle size={14} />,
  stale: <IconAlertTriangle size={14} />,
  openQuestion: <IconQuestion size={14} />,
  editingNow: <IconEdit size={14} />,
  specOpenQuestions: <IconQuestion size={14} />,
  settings: <IconShield size={14} />,
  shared: <IconFolder size={14} />,
  merge: <IconGitMerge size={14} />,
  leave: <IconCheck size={14} />,
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
  // One object per question to the host. `quietly`: the list on screen stays while it is asked for again (the host
  // came back to the page).
  const [attempt, setAttempt] = useState({ quietly: false });
  const [load, setLoad] = useState<Load>({ status: 'loading' });
  /** The latest `plan.preflight` is not answered yet. */
  const asking = useRef(false);
  const [changed, setChanged] = useState(false);
  const [showChanges, setShowChanges] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  /** The host ticked "I understand that these changes land in the shared folder directly". */
  const [confirmed, setConfirmed] = useState(false);
  /** The topic's model and its items' mode as the dialog shows them; null: as the topic has them. */
  const [agentDraft, setAgentDraft] = useState<{ model: string | null; permissionMode: SessionModeChoice | null } | null>(null);
  const workspaceMode = useWorkspaceMode();
  /** "How its items are merged" as the dialog shows it; null: what the preflight proposes. */
  const [mergingDraft, setMergingDraft] = useState<MergePolicy | null>(null);
  const members = useMembers();
  const idsKey = itemIds?.join(',') ?? '';

  useEffect(() => stores.topics.ensurePlan(topicId), [stores, topicId]);
  useEffect(() => {
    let current = true;
    asking.current = true;
    if (!attempt.quietly) setLoad({ status: 'loading' });
    stores.topics.preflight(topicId, idsKey === '' ? undefined : idsKey.split(',')).then(
      (preflight) => {
        if (!current) return;
        asking.current = false;
        setLoad({ status: 'ready', preflight });
      },
      (error: unknown) => {
        if (!current) return;
        asking.current = false;
        // A list asked for again quietly keeps what it shows when the question fails: the next return asks again.
        if (!attempt.quietly) setLoad({ status: 'error', message: describeError(error) });
      },
    );
    return () => {
      current = false;
    };
  }, [stores, topicId, idsKey, attempt]);

  const reload = useCallback(() => setAttempt({ quietly: false }), []);
  // The shared folder became a git repository, or stopped being one, while the dialog is open (the host ran
  // `git init` in a terminal and came back): the topic says so (`versioned`), and what the dialog shows was asked
  // before. The list is asked for again; nothing else in a topic.updated does that.
  // The same when how work items run changes (protocol 5: git installed or gone, smurg's own history made).
  const versioned = topic?.versioned;
  const history = useStore(stores.host, (state) => selectWork(state)?.history);
  const folderKey = versioned === undefined ? undefined : `${String(versioned)}/${history ?? ''}`;
  const folderSeen = useRef(folderKey);
  useEffect(() => {
    if (folderKey === undefined) return;
    const before = folderSeen.current;
    folderSeen.current = folderKey;
    if (before !== undefined && before !== folderKey) reload();
  }, [folderKey, reload]);
  const preflight = load.status === 'ready' ? load.preflight : null;
  // The dialog shows a blocker, and the host went away to do something about it (a first commit in a terminal: no
  // event announces that one) and came back: the page is visible again, or the window has the focus again. The list
  // is asked for again, once for the two events of one return and never while an answer is still on its way or the
  // page is hidden. The list stays on screen meanwhile, so the click that brought the window back still lands on the
  // control it was aimed at, and nothing typed in the dialog is lost. Nothing is asked when no blocker is shown.
  const blocked = preflight !== null && preflight.blockers.length > 0;
  useEffect(() => {
    if (!blocked) return;
    const back = (): void => {
      if (document.visibilityState !== 'visible' || asking.current) return;
      asking.current = true;
      setAttempt({ quietly: true });
    };
    document.addEventListener('visibilitychange', back);
    window.addEventListener('focus', back);
    return () => {
      document.removeEventListener('visibilitychange', back);
      window.removeEventListener('focus', back);
    };
  }, [blocked]);
  const startable = preflight !== null && preflight.blockers.length === 0 && startCount(preflight) > 0 && directAllows(preflight, confirmed);
  const headCount = preflight === null ? 0 : startHeadCount(preflight);
  const topicAgent = topic?.agent ?? { model: null, permissionMode: null };
  const agent = agentDraft ?? topicAgent;
  const itemsMode = resultingMode(agent.permissionMode, workspaceMode);
  /** A member's dialog for items that run directly: only the host can start them, so there is no Start button. */
  const directHostOnly = preflight?.history === 'direct' && preflight.direct?.hostOnly === true;
  const merging: MergePolicy = mergingDraft ?? (preflight === null ? 'host' : initialMerging(preflight));
  const mergeChoice = preflight !== null && offersMergeChoice(preflight);

  const start = async (): Promise<void> => {
    if (preflight === null || !startable) return;
    setBusy(true);
    setFailure(null);
    try {
      const agentPatch = startAgentPatch(topicAgent, agent);
      const mergingPatch = startMergingPatch(preflight, merging);
      await stores.topics.start({
        topicId,
        ...(itemIds === undefined ? {} : { itemIds: [...itemIds] }),
        planRevision: preflight.planRevision,
        specHash: preflight.specHash,
        planHash: preflight.planHash,
        ...(agentPatch === undefined ? {} : { agent: agentPatch }),
        ...(mergingPatch ?? {}),
        ...(preflight.history === 'direct' ? { direct: true as const } : {}),
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

  const hostName = members.find((person) => person.role === 'host')?.displayName ?? null;
  const lines = preflight === null || !plan ? [] : startLines(preflight, plan, member?.userId ?? null, { merging, host: isHost ? null : hostName });
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
          {directHostOnly ? null : (
            <Button variant="primary" icon={<IconPlay />} loading={busy} disabled={!startable} onClick={() => void start()}>
              {t('start.go')}
            </Button>
          )}
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
        {preflight !== null && preflight.history === 'direct' && preflight.direct !== null ? (
          <Banner tone="warning" live="none" title={t('start.direct.title')} className="start-direct">
            <p>{t('start.direct.body', { reason: renderWireText(preflight.direct.reason.text, preflight.direct.reason.fallback) })}</p>
            {preflight.direct.hostOnly ? (
              <p>{t('start.direct.hostOnly')}</p>
            ) : (
              <label className="start-direct__confirm">
                <input type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.currentTarget.checked)} />
                <span>{t('start.direct.confirm')}</span>
              </label>
            )}
          </Banner>
        ) : null}
        {lines.length > 0 ? (
          <ul className="start-list">
            {lines.map((line, index) => (
              <li key={`${line.id}-${index}`} className="start-line" data-tone={line.tone} data-line={line.id}>
                {line.tone === 'warn' && line.id !== 'offline' ? <IconAlertTriangle size={14} /> : ICON[line.id]}
                <div>
                  <span>
                    {line.tone === 'danger' ? <span className="ui-visually-hidden">{`${t('start.blocker')}${gapAfter(t('start.blocker'))}`}</span> : null}
                    {line.text}
                  </span>
                  {gapAfter(line.text)}
                  {action(line)}
                  {line === changesAfter && showChanges ? <PlanChanges topicId={topicId} /> : null}
                </div>
              </li>
            ))}
            {topic !== undefined ? (
              <li className="start-line" data-tone="plain" data-line="agent">
                <IconAgent size={14} />
                <div className="topics-agent">
                  <div className="topics-agent__pickers">
                    {/* Only sent with Start: a member's dialog for items that run directly has none, so nothing to choose. */}
                    <ModelPicker label={t('start.agent.model')} value={agent.model} disabled={busy || directHostOnly} onChange={(model) => setAgentDraft({ ...agent, model })} />
                    <ModePicker
                      label={t('start.agent.mode')}
                      value={agent.permissionMode}
                      follows="workspace"
                      followed={workspaceMode}
                      disabled={busy || directHostOnly}
                      onChange={(permissionMode) => setAgentDraft({ ...agent, permissionMode })}
                    />
                    {mergeChoice ? (
                      <Select<MergePolicy>
                        label={t('start.agent.merge')}
                        value={merging}
                        disabled={busy}
                        options={[
                          { value: 'auto', label: t('start.merge.option.auto') },
                          { value: 'host', label: t('start.merge.option.host') },
                        ]}
                        onChange={setMergingDraft}
                      />
                    ) : null}
                  </div>
                  <span className="start-line__note">{t('start.agent.note')}</span>
                </div>
              </li>
            ) : null}
            {topic !== undefined ? (
              <li className="start-line" data-tone="plain" data-line="rules">
                <IconShield size={14} />
                <div>
                  <TopicRules topic={topic} mode={itemsMode} />
                  {itemsMode === 'ask-commands' || itemsMode === 'ask-all' ? (
                    <span className="start-line__note">{t('start.rules.note')}</span>
                  ) : itemsMode === 'auto' ? (
                    <span className="start-line__note">{t('start.rules.note.auto')}</span>
                  ) : null}
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
