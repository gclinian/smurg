// The small dialogs of a topic: rename, archive (with the lists of DESIGN §5.12 item 23), delete (the host, an
// archived topic), and "Restart discussion"; since 0.7.0 "Leave it out" (D11: what goes with it is said before anything
// changes) and the host's "Undo" (D14: its preview, what goes with it, what stops it, then one press). Each is opened
// through dialogs.ts and rendered by TopicOverlays.tsx.
import {
  TOPIC_NAME_MAX_CHARS,
  errorReasonOf,
  isSmurgError,
  topicNameSchema,
  unmergedWorktreesOfError,
  type Topic,
  type UndoItemRef,
  type UndoPreview,
  type UnmergedWorktree,
} from '@smurg/protocol';
import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { itemLabel } from '../../lib/columns/describe.ts';
import { describeError, renderWireText } from '../../lib/errors.ts';
import { formatAnd, formatList } from '../../lib/format.ts';
import { useStore } from '../../lib/store.ts';
import { selectPlan } from '../../lib/stores/topics.ts';
import { useCommand, useStores } from '../../lib/workspace/context.tsx';
import { tApp } from '../../strings/app.ts';
import { Banner, Button, Dialog, Input, Spinner, useToast } from '../../ui/index.ts';
import { dependentsOf, isMerged, reviewStands } from './model.ts';
import { useTopic } from './shared.tsx';
import { t } from './strings.ts';

interface TopicDialogProps {
  readonly topicId: string;
  onClose(): void;
}

/** Closes a dialog whose topic went away under it (deleted by the host meanwhile). */
function useTopicOrClose(topicId: string, onClose: () => void): Topic | undefined {
  const stores = useStores();
  const topic = useTopic(topicId);
  const loaded = useStore(stores.topics, (state) => state.status === 'ready');
  useEffect(() => {
    if (topic === undefined && loaded) onClose();
  }, [topic, loaded, onClose]);
  return topic;
}

function Failure({ children }: { children: ReactNode }) {
  return (
    <Banner tone="danger" live="alert">
      {children}
    </Banner>
  );
}

export function RenameTopicDialog({ topicId, onClose }: TopicDialogProps) {
  const stores = useStores();
  const topic = useTopicOrClose(topicId, onClose);
  const [name, setName] = useState(topic?.name ?? '');
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  if (topic === undefined) return null;
  const trimmed = name.trim();
  const problem = trimmed === '' ? null : trimmed.length > TOPIC_NAME_MAX_CHARS ? t('new.name.tooLong', { max: TOPIC_NAME_MAX_CHARS }) : topicNameSchema.safeParse(trimmed).success ? null : t('new.name.invalid');
  const ready = trimmed !== '' && problem === null && trimmed !== topic.name;

  const submit = async (event?: FormEvent): Promise<void> => {
    event?.preventDefault();
    if (!ready || busy) return;
    setBusy(true);
    setFailure(null);
    try {
      await stores.topics.rename(topic.id, trimmed);
      onClose();
    } catch (error) {
      setFailure(t('rename.failed', { reason: describeError(error) }));
      setBusy(false);
    }
  };

  return (
    <Dialog
      open
      onClose={onClose}
      size="sm"
      title={t('rename.title')}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            {tApp('common.cancel')}
          </Button>
          <Button variant="primary" loading={busy} disabled={!ready} onClick={() => void submit()}>
            {t('rename.submit')}
          </Button>
        </>
      }
    >
      <form className="topics-form" onSubmit={(event) => void submit(event)}>
        <Input label={t('new.name')} value={name} hint={t('rename.hint', { folder: `specs/${topic.slug}/` })} error={problem ?? undefined} onChange={(event) => setName(event.currentTarget.value)} />
        {failure !== null ? <Failure>{failure}</Failure> : null}
        <button type="submit" hidden disabled={!ready} />
      </form>
    </Dialog>
  );
}

export function ArchiveTopicDialog({ topicId, onClose }: TopicDialogProps) {
  const stores = useStores();
  const toast = useToast();
  const topic = useTopicOrClose(topicId, onClose);
  const plan = useStore(stores.topics, (state) => selectPlan(state, topicId));
  const [busy, setBusy] = useState<'archive' | 'keep' | 'delete' | null>(null);
  /** The daemon's list of worktrees whose changes were never merged: the second question. */
  const [unmerged, setUnmerged] = useState<readonly UnmergedWorktree[] | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  useEffect(() => stores.topics.ensurePlan(topicId), [stores, topicId]);
  if (topic === undefined) return null;

  const notMerged = (plan?.items ?? []).filter((item) => item.inPlan && reviewStands(item) && item.merge !== undefined && !isMerged(item));
  const nameOf = (itemId: string): string => {
    const item = plan?.items.find((candidate) => candidate.id === itemId);
    return item === undefined ? itemId : itemLabel(item);
  };

  const archive = async (how: 'archive' | 'keep' | 'delete'): Promise<void> => {
    setBusy(how);
    setFailure(null);
    try {
      await stores.topics.archive(topic.id, true, how === 'archive' ? undefined : how === 'delete');
      toast.show({ tone: 'success', title: t('archive.done', { topic: topic.name }) });
      onClose();
    } catch (error) {
      const worktrees = isSmurgError(error) ? unmergedWorktreesOfError(error) : null;
      if (worktrees !== null) setUnmerged(worktrees);
      else setFailure(t('archive.failed', { reason: describeError(error) }));
      setBusy(null);
    }
  };

  return (
    <Dialog
      open
      onClose={onClose}
      role="alertdialog"
      title={t('archive.title', { topic: topic.name })}
      footer={
        unmerged === null ? (
          <>
            <Button variant="ghost" onClick={onClose} disabled={busy !== null}>
              {tApp('common.cancel')}
            </Button>
            <Button variant="primary" loading={busy === 'archive'} onClick={() => void archive('archive')}>
              {t('archive.action')}
            </Button>
          </>
        ) : (
          <>
            <Button variant="ghost" onClick={onClose} disabled={busy !== null}>
              {tApp('common.cancel')}
            </Button>
            <Button variant="danger" loading={busy === 'delete'} disabled={busy !== null && busy !== 'delete'} onClick={() => void archive('delete')}>
              {t('archive.unmerged.delete')}
            </Button>
            <Button variant="primary" loading={busy === 'keep'} disabled={busy !== null && busy !== 'keep'} onClick={() => void archive('keep')}>
              {t('archive.unmerged.keep')}
            </Button>
          </>
        )
      }
    >
      <div className="topics-form">
        <p className="topics-text">{t('archive.lead')}</p>
        {notMerged.length > 0 ? (
          <div>
            <p className="topics-text">{t('archive.notMerged')}</p>
            <ul className="topics-list">
              {notMerged.map((item) => (
                <li key={item.id}>{itemLabel(item)}</li>
              ))}
            </ul>
          </div>
        ) : null}
        {unmerged !== null ? (
          <Banner tone="warning" live="alert" title={t('archive.unmerged.title', { count: unmerged.length })}>
            <ul className="topics-list">
              {unmerged.map((worktree) => (
                <li key={worktree.worktreeId}>
                  {nameOf(worktree.itemId)} <code>{worktree.branch}</code>
                </li>
              ))}
            </ul>
            <p>{t('archive.unmerged.body')}</p>
          </Banner>
        ) : null}
        {failure !== null ? <Failure>{failure}</Failure> : null}
      </div>
    </Dialog>
  );
}

export function DeleteTopicDialog({ topicId, onClose }: TopicDialogProps) {
  const stores = useStores();
  const toast = useToast();
  const topic = useTopicOrClose(topicId, onClose);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  if (topic === undefined) return null;
  const remove = async (): Promise<void> => {
    setBusy(true);
    setFailure(null);
    try {
      await stores.topics.remove(topic.id);
      toast.show({ tone: 'success', title: t('delete.done', { topic: topic.name }) });
      onClose();
    } catch (error) {
      setFailure(t('delete.failed', { reason: describeError(error) }));
      setBusy(false);
    }
  };
  return (
    <Dialog
      open
      onClose={onClose}
      role="alertdialog"
      size="sm"
      title={t('delete.title', { topic: topic.name })}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            {tApp('common.cancel')}
          </Button>
          <Button variant="danger" loading={busy} onClick={() => void remove()}>
            {t('delete.action')}
          </Button>
        </>
      }
    >
      <div className="topics-form">
        <p className="topics-text">{t('delete.lead', { folder: `specs/${topic.slug}/` })}</p>
        {failure !== null ? <Failure>{failure}</Failure> : null}
      </div>
    </Dialog>
  );
}

export function RestartDiscussionDialog({ topicId, onClose }: TopicDialogProps) {
  const stores = useStores();
  const openColumn = useCommand('openColumn');
  const topic = useTopicOrClose(topicId, onClose);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  if (topic === undefined) return null;
  const restart = async (): Promise<void> => {
    setBusy(true);
    setFailure(null);
    try {
      const result = await stores.topics.restartDiscussion(topic.id);
      onClose();
      await openColumn({ target: { kind: 'session', sessionId: result.session.id } }).catch(() => {});
    } catch (error) {
      setFailure(t('restart.failed', { reason: describeError(error) }));
      setBusy(false);
    }
  };
  return (
    <Dialog
      open
      onClose={onClose}
      role="alertdialog"
      size="sm"
      title={t('restart.title')}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            {tApp('common.cancel')}
          </Button>
          <Button variant="primary" loading={busy} onClick={() => void restart()}>
            {t('discussion.restart')}
          </Button>
        </>
      }
    >
      <div className="topics-form">
        <p className="topics-text">{topic.discussion === 'lost' ? t('restart.lead.lost') : t('restart.lead')}</p>
        {failure !== null ? <Failure>{failure}</Failure> : null}
      </div>
    </Dialog>
  );
}

/** "Restore topic" asks nothing: sends `topic.archive { archived: false }` and says how it went. Renders nothing. */
export function RestoreTopic({ topicId, onClose }: TopicDialogProps): null {
  const stores = useStores();
  const toast = useToast();
  useEffect(() => {
    stores.topics.archive(topicId, false).then(
      (topic) => toast.show({ tone: 'success', title: t('restore.done', { topic: topic.name }) }),
      (error: unknown) => toast.show({ tone: 'danger', title: t('restore.failed', { reason: describeError(error) }) }),
    );
    onClose();
    // Once per request: the overlay keys this component by the topic.
  }, []);
  return null;
}

/**
 * "Leave out {item}?" (DESIGN 0.7.0 D11): what goes with it is said before anything changes: the items of the plan that
 * depend on it and are not merged. The daemon decides again on what is true when it runs (a merge in flight finishes).
 */
export function LeaveOutDialog({ topicId, itemId, onClose }: TopicDialogProps & { readonly itemId: string }) {
  const stores = useStores();
  const topic = useTopicOrClose(topicId, onClose);
  const plan = useStore(stores.topics, (state) => selectPlan(state, topicId));
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  useEffect(() => stores.topics.ensurePlan(topicId), [stores, topicId]);
  const item = plan?.items.find((candidate) => candidate.id === itemId);
  if (topic === undefined || item === undefined || !plan) return null;
  const others = dependentsOf(plan, itemId).filter((dependent) => !isMerged(dependent) && dependent.leftOut === undefined && dependent.inPlan);

  const leaveOut = async (): Promise<void> => {
    setBusy(true);
    setFailure(null);
    try {
      await stores.topics.leaveOut(topicId, itemId);
      onClose();
    } catch (error) {
      setFailure(t('leaveOut.failed', { reason: describeError(error) }));
      setBusy(false);
    }
  };
  return (
    <Dialog
      open
      onClose={onClose}
      role="alertdialog"
      size="sm"
      title={t('leaveOut.title', { item: itemLabel(item) })}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            {tApp('common.cancel')}
          </Button>
          <Button variant="danger" loading={busy} onClick={() => void leaveOut()}>
            {t('leaveOut.go')}
          </Button>
        </>
      }
    >
      <div className="topics-form">
        <p className="topics-text">{others.length === 0 ? t('leaveOut.body.alone') : t('leaveOut.body', { items: formatAnd(others.map((other) => itemLabel(other))) })}</p>
        {failure !== null ? <Failure>{failure}</Failure> : null}
      </div>
    </Dialog>
  );
}

type UndoLoad = { readonly status: 'loading' } | { readonly status: 'ready'; readonly preview: UndoPreview } | { readonly status: 'error'; readonly message: string };

/** An item an undo names: "1 · Cart API", and with its topic when it is another topic's ("2 · Search of Search page"). */
export function undoItemName(ref: UndoItemRef, topicId: string): string {
  const label = ref.number > 0 ? itemLabel(ref) : ref.title;
  return ref.topicId === topicId ? label : t('undo.itemOfTopic', { item: label, topic: ref.topicName });
}

/** What stops an undo now, one sentence each (the preview's blockers). */
export function undoBlockers(preview: UndoPreview, topicId: string): string[] {
  const { blockers } = preview;
  const lines: string[] = [];
  if (blockers.unavailable !== null) lines.push(renderWireText(blockers.unavailable.text, blockers.unavailable.fallback));
  if (blockers.running.length > 0) lines.push(t('undo.blocked.running', { items: formatAnd(blockers.running.map((ref) => undoItemName(ref, topicId))) }));
  for (const change of blockers.changedSince) {
    lines.push(change.outside || change.by.length === 0 ? t('undo.blocked.outside', { path: change.path }) : t('undo.blocked.changedSince', { path: change.path, names: formatAnd(change.by.map((user) => user.displayName)) }));
  }
  for (const typing of blockers.typing) lines.push(t('undo.blocked.typing', { path: typing.path, names: formatAnd(typing.names.map((user) => user.displayName)) }));
  if (blockers.uncommitted.length > 0) lines.push(t('undo.blocked.uncommitted', { paths: formatList([...blockers.uncommitted]) }));
  if (blockers.staged) lines.push(t('undo.blocked.staged'));
  if (blockers.busy) lines.push(t('undo.blocked.busy'));
  if (blockers.branch !== null) lines.push(t('undo.blocked.branch', blockers.branch));
  return lines;
}

/**
 * The host's "Undo…" of an item (`itemIds`) or of the whole topic (null): the preview first (`topic.undo.preview`,
 * nothing changes), what goes with it and what stops it, then "Undo" with the preview's token. When what the undo
 * does changed meanwhile, the daemon refuses (`undo.changed`) and the dialog looks again.
 */
export function UndoDialog({ topicId, itemIds, onClose }: TopicDialogProps & { readonly itemIds: readonly string[] | null }) {
  const stores = useStores();
  const toast = useToast();
  const topic = useTopicOrClose(topicId, onClose);
  const plan = useStore(stores.topics, (state) => selectPlan(state, topicId));
  const [attempt, setAttempt] = useState(0);
  const [load, setLoad] = useState<UndoLoad>({ status: 'loading' });
  const [changed, setChanged] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const idsKey = itemIds === null ? '' : itemIds.join(',');
  useEffect(() => stores.topics.ensurePlan(topicId), [stores, topicId]);
  useEffect(() => {
    let current = true;
    setLoad({ status: 'loading' });
    stores.topics.undoPreview(topicId, idsKey === '' ? null : idsKey.split(',')).then(
      (preview) => {
        if (current) setLoad({ status: 'ready', preview });
      },
      (error: unknown) => {
        if (current) setLoad({ status: 'error', message: describeError(error) });
      },
    );
    return () => {
      current = false;
    };
  }, [stores, topicId, idsKey, attempt]);
  if (topic === undefined) return null;

  const asked = itemIds === null ? [] : itemIds.map((id) => plan?.items.find((item) => item.id === id)).filter((item) => item !== undefined);
  const title = itemIds === null ? t('undo.title.topic', { topic: topic.name }) : t('undo.title', { item: formatAnd(asked.map((item) => itemLabel(item))) });
  const preview = load.status === 'ready' ? load.preview : null;

  const undo = async (): Promise<void> => {
    if (preview === null || !preview.ok) return;
    setBusy(true);
    setFailure(null);
    setChanged(null);
    try {
      await stores.topics.undo(topicId, itemIds, preview.token);
      toast.show({ tone: 'success', title: t('badge.undone') });
      onClose();
    } catch (error) {
      if (isSmurgError(error) && (errorReasonOf(error) === 'changed' || errorReasonOf(error) === 'not-ok')) {
        // What the undo does is not what the dialog showed: look again; nothing was changed.
        setChanged(describeError(error));
        setAttempt((n) => n + 1);
      } else setFailure(t('undo.failed', { reason: describeError(error) }));
      setBusy(false);
    }
  };

  const others = (why: 'built-on' | 'same-lines'): string => formatAnd((preview?.undone ?? []).filter((ref) => ref.why === why).map((ref) => undoItemName(ref, topicId)));
  const blockers = preview === null ? [] : undoBlockers(preview, topicId);
  return (
    <Dialog
      open
      onClose={onClose}
      role="alertdialog"
      size="md"
      title={title}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            {tApp('common.cancel')}
          </Button>
          <Button variant="danger" loading={busy} disabled={preview === null || !preview.ok} onClick={() => void undo()}>
            {t('undo.go')}
          </Button>
        </>
      }
    >
      <div className="topics-form">
        {changed !== null ? (
          <Banner tone="warning" live="alert">
            {changed}
          </Banner>
        ) : null}
        {load.status === 'loading' ? (
          <p className="topics-changes__note">
            <Spinner size={14} decorative /> {t('undo.loading')}
          </p>
        ) : null}
        {load.status === 'error' ? (
          <Banner tone="danger" live="alert" actions={<Button size="sm" onClick={() => setAttempt((n) => n + 1)}>{tApp('common.retry')}</Button>}>
            {t('undo.loadFailed', { reason: load.message })}
          </Banner>
        ) : null}
        {preview !== null ? (
          <>
            <p className="topics-text">{preview.history === 'smurg' ? t('undo.body.smurg') : t('undo.body')}</p>
            {others('built-on') !== '' ? <p className="topics-text">{t('undo.builtOn', { items: others('built-on') })}</p> : null}
            {others('same-lines') !== '' ? <p className="topics-text">{t('undo.sameLines', { items: others('same-lines') })}</p> : null}
            {preview.leftOut.length > 0 ? <p className="topics-text">{t('undo.leftOut', { items: formatAnd(preview.leftOut.map((ref) => undoItemName(ref, topicId))) })}</p> : null}
            {blockers.length > 0 ? (
              <Banner tone="warning" live="none" title={t('undo.blocked.title')}>
                <ul className="topics-list">
                  {blockers.map((line, index) => (
                    <li key={index}>{line}</li>
                  ))}
                </ul>
              </Banner>
            ) : null}
          </>
        ) : null}
        {failure !== null ? <Failure>{failure}</Failure> : null}
      </div>
    </Dialog>
  );
}
