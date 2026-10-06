// The small dialogs of a topic: rename, archive (with the lists of DESIGN §5.12 item 23), delete (the host, an
// archived topic), and "Restart discussion". Each is opened through dialogs.ts and rendered by TopicOverlays.tsx.
import { TOPIC_NAME_MAX_CHARS, isSmurgError, topicNameSchema, unmergedWorktreesOfError, type Topic, type UnmergedWorktree } from '@smurg/protocol';
import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { itemLabel } from '../../lib/columns/describe.ts';
import { describeError } from '../../lib/errors.ts';
import { useStore } from '../../lib/store.ts';
import { selectPlan } from '../../lib/stores/topics.ts';
import { useCommand, useStores } from '../../lib/workspace/context.tsx';
import { tApp } from '../../strings/app.ts';
import { Banner, Button, Dialog, Input, useToast } from '../../ui/index.ts';
import { isMerged, reviewStands } from './model.ts';
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
