// "These names already exist": the person decides for the whole upload (overwrite / keep both / cancel upload). There is no silent
// default (SPEC goal 3: no silent overwrite), so the dialog cannot be dismissed without a choice.
import { Button, Dialog } from '../../../ui/index.ts';
import type { JobSnapshot, UploadConflictPolicy } from '../engine/types.ts';
import { t } from '../strings.ts';

export function ConflictDialog({ job, onAnswer }: { job: JobSnapshot | null; onAnswer(id: string, policy: UploadConflictPolicy | null): void }) {
  const conflict = job?.conflict ?? null;
  return (
    <Dialog
      open={job !== null && conflict !== null}
      onClose={() => job && onAnswer(job.id, null)}
      title={t('conflict.title')}
      description={t('conflict.description')}
      role="alertdialog"
      dismissible={false}
      footer={
        job ? (
          <>
            <Button variant="ghost" onClick={() => onAnswer(job.id, null)}>
              {t('conflict.cancel')}
            </Button>
            <Button onClick={() => onAnswer(job.id, 'rename')}>{t('conflict.rename')}</Button>
            <Button variant="danger" onClick={() => onAnswer(job.id, 'overwrite')}>
              {t('conflict.overwrite')}
            </Button>
          </>
        ) : null
      }
    >
      {conflict ? (
        <>
          <ul className="transfer-conflict-list">
            {conflict.paths.map((path) => (
              <li key={path}>{path}</li>
            ))}
          </ul>
          {conflict.more > 0 ? <p className="transfer-message">{t('conflict.more', { count: conflict.more })}</p> : null}
        </>
      ) : null}
    </Dialog>
  );
}
