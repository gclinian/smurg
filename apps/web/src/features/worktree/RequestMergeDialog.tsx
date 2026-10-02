// The worktree owner asks the host to merge (SPEC R9: the worktree owner requests the merge). The daemon commits the worktree's
// working tree as the owner and records exactly that commit: later edits need a new request (ARCHITECTURE §5.7).
import { useState } from 'react';
import type { WorktreeInfo } from '@smurg/protocol';
import { describeError } from '../../lib/errors.ts';
import { useStore } from '../../lib/store.ts';
import { useStores } from '../../lib/workspace/context.tsx';
import { tApp } from '../../strings/app.ts';
import { Banner, Button, Dialog, TextArea, useToast } from '../../ui/index.ts';
import { t } from './strings.ts';
import { mergeMessageProblem } from './text-check.ts';

export interface RequestMergeDialogProps {
  /** The worktree to merge; null renders nothing. */
  readonly worktree: WorktreeInfo | null;
  onClose(): void;
}

export function RequestMergeDialog({ worktree, onClose }: RequestMergeDialogProps) {
  if (!worktree) return null;
  return <RequestMergeForm key={worktree.id} worktree={worktree} onClose={onClose} />;
}

function RequestMergeForm({ worktree, onClose }: { worktree: WorktreeInfo; onClose(): void }) {
  const stores = useStores();
  const toast = useToast();
  const hasPending = useStore(stores.worktrees, (state) => [...state.mergeRequests.values()].some((r) => r.worktreeId === worktree.id && r.status === 'pending'));
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const problem = message === '' ? null : mergeMessageProblem(message);

  const submit = async (): Promise<void> => {
    if (problem) return;
    setBusy(true);
    setError(null);
    try {
      const trimmed = message.trim();
      await stores.worktrees.requestMerge(worktree.id, trimmed === '' ? undefined : trimmed);
      toast.show({ tone: 'success', title: t('request.sent') });
      onClose();
    } catch (failure) {
      setError(t('request.failed', { message: describeError(failure) }));
      setBusy(false);
    }
  };

  return (
    <Dialog
      open
      onClose={onClose}
      title={t('request.title', { branch: worktree.branch })}
      description={t('request.lead')}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            {tApp('common.cancel')}
          </Button>
          <Button variant="primary" loading={busy} disabled={problem !== null} onClick={() => void submit()}>
            {t('request.submit')}
          </Button>
        </>
      }
    >
      <div className="worktree-form">
        {hasPending ? (
          <Banner tone="info" live="none">
            {t('request.pendingNote')}
          </Banner>
        ) : null}
        <TextArea
          label={t('request.message')}
          placeholder={t('request.placeholder')}
          rows={4}
          value={message}
          onChange={(event) => setMessage(event.currentTarget.value)}
          error={problem ?? undefined}
        />
        {error ? (
          <Banner tone="danger" live="alert">
            {error}
          </Banner>
        ) : null}
      </div>
    </Dialog>
  );
}
