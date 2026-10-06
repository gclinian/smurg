// Ending a session. The owner is asked whether to keep the session's worktree (SPEC R9.4 "when a session ends, ask whether to keep the
// worktree"): session.end {keepWorktree} — `false` is the ONLY path that deletes the worktree with the session
// (daemon contract C17), so the choice is always sent explicitly. The host may also terminate anyone's session
// (admin.session.terminate), which keeps any worktree.
import { useEffect, useId, useState } from 'react';
import type { SessionInfo } from '@smurg/protocol';
import { useStore } from '../../lib/store.ts';
import { useStores } from '../../lib/workspace/context.tsx';
import { tApp } from '../../strings/app.ts';
import { Banner, Button, Dialog, useToast } from '../../ui/index.ts';
import { describeSessionError, whereLabel } from './session-info.ts';
import { t } from './strings.ts';
import { plainSessionTitle, sessionTitle } from '../../lib/stores/sessions.ts';

export interface EndSessionDialogProps {
  readonly session: SessionInfo | null;
  /** 'end': the owner's own session; 'terminate': the host ends someone else's. */
  readonly mode: 'end' | 'terminate';
  onClose(): void;
}

export function EndSessionDialog({ session, mode, onClose }: EndSessionDialogProps) {
  const stores = useStores();
  const toast = useToast();
  const name = useId();
  const worktrees = useStore(stores.worktrees, (state) => state.worktrees);
  const [keep, setKeep] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const open = session !== null;

  useEffect(() => {
    if (open) return;
    setKeep(true);
    setBusy(false);
    setError(null);
  }, [open]);

  if (!session) return null;
  const inWorktree = session.root.kind === 'worktree';

  const confirm = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      if (mode === 'terminate') await stores.sessions.terminate(session.id);
      else await stores.sessions.end(session.id, inWorktree ? { keepWorktree: keep } : {});
      toast.show({ tone: 'success', title: t('end.done', { title: sessionTitle(session) }) });
      onClose();
    } catch (failure) {
      const view = describeSessionError(failure);
      setError(view.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      role="alertdialog"
      title={mode === 'terminate' ? t('terminate.title') : t('end.title')}
      description={mode === 'terminate' ? t('terminate.body', { owner: session.openedBy.displayName, title: plainSessionTitle(session) }) : t('end.body', { title: sessionTitle(session) })}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {tApp('common.cancel')}
          </Button>
          <Button variant="danger" loading={busy} onClick={() => void confirm()}>
            {mode === 'terminate' ? t('terminate.confirm') : t('end.confirm')}
          </Button>
        </>
      }
    >
      {mode === 'end' && inWorktree ? (
        <fieldset className="agents-fieldset">
          <legend>{t('end.worktreeQuestion')}</legend>
          <p className="agents-fieldset__note">{whereLabel(session, worktrees)}</p>
          <label className="agents-choice">
            <input type="radio" name={name} checked={keep} onChange={() => setKeep(true)} />
            <span className="agents-choice__text">
              <span className="agents-choice__label">{t('end.keep')}</span>
              <span className="agents-choice__hint">{t('end.keepHint')}</span>
            </span>
          </label>
          <label className="agents-choice">
            <input type="radio" name={name} checked={!keep} onChange={() => setKeep(false)} />
            <span className="agents-choice__text">
              <span className="agents-choice__label">{t('end.remove')}</span>
              <span className="agents-choice__hint">{t('end.removeHint')}</span>
            </span>
          </label>
        </fieldset>
      ) : null}
      {error ? (
        <Banner tone="danger" live="alert">
          {error}
        </Banner>
      ) : null}
    </Dialog>
  );
}
