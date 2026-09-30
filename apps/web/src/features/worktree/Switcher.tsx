// The root switcher above the file tree (SPEC R9 「檔案樹可以切換檢視主工作區或任一 worktree」): the main workspace or any
// worktree, each labelled with its owner and branch. Under it, for a worktree: owner, branch, whether a session uses
// it, its read-only shared folders (D12), and — for its owner — 「請主人合併」; the owner or the host may remove it.
import { useState } from 'react';
import { MAIN_ROOT, rootRefKey, worktreeRoot, type WorktreeInfo } from '@smurg/protocol';
import { describeError } from '../../lib/errors.ts';
import { shallowEqual, useStore } from '../../lib/store.ts';
import { selectActiveRoot } from '../../lib/stores/files.ts';
import { selectUserId } from '../../lib/stores/workspace.ts';
import { selectWorktreeList, worktreeLabel } from '../../lib/stores/worktrees.ts';
import { useCan, useStores } from '../../lib/workspace/context.tsx';
import { tApp } from '../../strings/app.ts';
import { Banner, Button, Dialog, Select, useToast, type SelectOption } from '../../ui/index.ts';
import { IconGitMerge, IconTrash } from '../../ui/icons.tsx';
import { RequestMergeDialog } from './RequestMergeDialog.tsx';
import { t } from './strings.ts';

export function WorktreeSwitcherView() {
  const stores = useStores();
  const worktrees = useStore(stores.worktrees, selectWorktreeList, shallowEqual);
  const active = useStore(stores.files, selectActiveRoot);
  const userId = useStore(stores.workspace, selectUserId);
  const sessions = useStore(stores.sessions, (state) => state.sessions);
  const isHost = useCan('admin');
  const canRequest = useCan('worktree.merge.request');
  const [requesting, setRequesting] = useState<WorktreeInfo | null>(null);
  const [removing, setRemoving] = useState<WorktreeInfo | null>(null);

  // Nothing to switch between: keep the sidebar for the tree.
  if (worktrees.length === 0 && active.kind === 'main') return null;

  const activeKey = rootRefKey(active);
  const options: SelectOption<string>[] = [
    { value: rootRefKey(MAIN_ROOT), label: t('main') },
    ...worktrees.map((worktree) => ({
      value: rootRefKey(worktreeRoot(worktree.id)),
      // Whose and for what (review WEB-18); the branch is in the details below.
      label: worktreeLabel(worktree, { selfUserId: userId, sessions }),
    })),
  ];
  // The shown root disappeared (removed while it was open): keep the select truthful until the tree switches back.
  if (!options.some((option) => option.value === activeKey)) options.push({ value: activeKey, label: t('option.gone'), disabled: true });

  const choose = (key: string): void => {
    if (key === activeKey) return;
    const target = worktrees.find((worktree) => rootRefKey(worktreeRoot(worktree.id)) === key);
    stores.files.setActiveRoot(target ? worktreeRoot(target.id) : MAIN_ROOT);
  };

  const current = active.kind === 'worktree' ? (worktrees.find((worktree) => worktree.id === active.worktreeId) ?? null) : null;
  const owns = current !== null && current.ownerUserId === userId;

  return (
    <div className="worktree-switcher">
      <Select label={t('switcherLabel')} options={options} value={activeKey} onChange={choose} />
      {current ? (
        <div className="worktree-switcher__details" aria-label={t('active.label')} role="group">
          <p>{t('active.owner', { owner: current.ownerName })}</p>
          <p className="worktree-switcher__branch" title={current.branch}>
            {t('active.branch', { branch: current.branch })}
          </p>
          {current.sessionId !== undefined ? <p>{t('active.session')}</p> : current.kept ? <p>{t('active.kept')}</p> : null}
          {current.sharedDirs.length > 0 ? <p>{t('active.shared', { dirs: current.sharedDirs.join(t('list.separator')) })}</p> : null}
          {owns || isHost ? (
            <div className="worktree-switcher__actions">
              {owns && canRequest ? (
                <Button size="sm" icon={<IconGitMerge />} onClick={() => setRequesting(current)}>
                  {t('active.requestMerge')}
                </Button>
              ) : null}
              {owns || isHost ? (
                <Button size="sm" variant="ghost" icon={<IconTrash />} onClick={() => setRemoving(current)}>
                  {t('active.remove')}
                </Button>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}
      <RequestMergeDialog worktree={requesting} onClose={() => setRequesting(null)} />
      <RemoveWorktreeDialog worktree={removing} onClose={() => setRemoving(null)} />
    </div>
  );
}

function RemoveWorktreeDialog({ worktree, onClose }: { worktree: WorktreeInfo | null; onClose(): void }) {
  if (!worktree) return null;
  return <RemoveWorktreeConfirm key={worktree.id} worktree={worktree} onClose={onClose} />;
}

function RemoveWorktreeConfirm({ worktree, onClose }: { worktree: WorktreeInfo; onClose(): void }) {
  const stores = useStores();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const remove = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await stores.worktrees.remove(worktree.id);
      toast.show({ tone: 'success', title: t('remove.done') });
      setBusy(false);
      onClose();
    } catch (failure) {
      setError(t('remove.failed', { message: describeError(failure) }));
      setBusy(false);
    }
  };

  return (
    <Dialog
      open
      role="alertdialog"
      onClose={onClose}
      title={t('remove.title', { owner: worktree.ownerName })}
      description={t('remove.body', { branch: worktree.branch })}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            {tApp('common.cancel')}
          </Button>
          <Button variant="danger" loading={busy} onClick={() => void remove()}>
            {t('remove.confirm')}
          </Button>
        </>
      }
    >
      {error ? (
        <Banner tone="danger" live="alert">
          {error}
        </Banner>
      ) : null}
    </Dialog>
  );
}
