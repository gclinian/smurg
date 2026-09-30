// 「強制釋放」 of a file lock (SPEC R8 「主人可以強制釋放任何鎖」, review WEB-04): host only, always confirmed, naming who
// holds the lock. Used by the editor's lock banner and the file tree's context menu. The daemon checks the capability
// (`lock.force-release`) and audits the release; this is the UI for it.
import { baseNameOfRelPath, type FileRef, type LockInfo } from '@smurg/protocol';
import { useRef, useState } from 'react';
import { describeError } from '../../lib/errors.ts';
import { useCan, useStores } from '../../lib/workspace/context.tsx';
import { Button, Dialog, useToast } from '../../ui/index.ts';
import { t } from './strings.ts';

/** Whether the local member may force-release locks (the host). */
export function useCanForceRelease(): boolean {
  return useCan('lock.force-release');
}

/** Who holds `lock`, for the dialog and the menu: 「Claude（Ian）」 or 「Amy、Bob」. */
export function lockHolderNames(lock: LockInfo): string {
  return lock.kind === 'agent' ? lock.agentName : lock.holders.map((holder) => holder.displayName).join(t('list.separator'));
}

export interface ForceReleaseDialogProps {
  readonly file: FileRef;
  readonly lock: LockInfo;
  onClose(): void;
}

export function ForceReleaseDialog({ file, lock, onClose }: ForceReleaseDialogProps) {
  const stores = useStores();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const cancel = useRef<HTMLButtonElement>(null);
  const name = baseNameOfRelPath(file.path);
  const holders = lockHolderNames(lock);
  const release = (): void => {
    setBusy(true);
    stores.locks.forceRelease(file).then(
      () => {
        toast.show({ tone: 'success', title: t('forceRelease.done', { name }) });
        onClose();
      },
      (error: unknown) => {
        toast.show({ tone: 'danger', title: t('forceRelease.failed', { message: describeError(error) }) });
        setBusy(false);
      },
    );
  };
  return (
    <Dialog
      open
      role="alertdialog"
      onClose={onClose}
      title={t('forceRelease.title', { name })}
      description={lock.kind === 'agent' ? t('forceRelease.agentText', { holders }) : t('forceRelease.humanText', { holders })}
      initialFocus={cancel}
      size="sm"
      footer={
        <>
          <Button ref={cancel} variant="ghost" onClick={onClose}>
            {t('dialog.cancel')}
          </Button>
          <Button variant="danger" loading={busy} onClick={release}>
            {t('forceRelease.confirm')}
          </Button>
        </>
      }
    />
  );
}
