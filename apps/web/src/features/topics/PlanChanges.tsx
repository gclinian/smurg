// "Show the changes": what changed in SPEC.md and PLAN.md since the last confirmed Start (`plan.changes`), inside the
// Start dialog and as a dialog of its own (an item that did not start because the plan changed).
import type { ResultOf } from '@smurg/protocol';
import { useEffect, useState } from 'react';
import { describeError } from '../../lib/errors.ts';
import { useStores } from '../../lib/workspace/context.tsx';
import { tApp } from '../../strings/app.ts';
import { Banner, Button, Dialog, Spinner } from '../../ui/index.ts';
import { DiffText } from './DiffText.tsx';
import { useTopic } from './shared.tsx';
import { t } from './strings.ts';

type Changes = ResultOf<'plan.changes'>;
type Load = { status: 'loading' } | { status: 'ready'; value: Changes } | { status: 'error'; message: string };

const FILE_NAME = { spec: 'SPEC.md', plan: 'PLAN.md' } as const;

/** The two files' diffs, loaded when shown. */
export function PlanChanges({ topicId }: { topicId: string }) {
  const stores = useStores();
  const [attempt, setAttempt] = useState(0);
  const [load, setLoad] = useState<Load>({ status: 'loading' });
  useEffect(() => {
    let current = true;
    setLoad({ status: 'loading' });
    stores.topics.changes(topicId).then(
      (value) => {
        if (current) setLoad({ status: 'ready', value });
      },
      (error: unknown) => {
        if (current) setLoad({ status: 'error', message: describeError(error) });
      },
    );
    return () => {
      current = false;
    };
  }, [stores, topicId, attempt]);

  if (load.status === 'loading') {
    return (
      <p className="topics-changes__note">
        <Spinner size={14} decorative /> {t('loading')}
      </p>
    );
  }
  if (load.status === 'error') {
    return (
      <Banner tone="danger" live="alert" actions={<Button size="sm" onClick={() => setAttempt((n) => n + 1)}>{tApp('common.retry')}</Button>}>
        {t('changes.failed', { reason: load.message })}
      </Banner>
    );
  }
  if (load.value.files.length === 0) return <p className="topics-changes__note">{t('changes.none')}</p>;
  return (
    <div className="topics-changes">
      {load.value.files.map((file) => (
        <section key={file.target} className="topics-changes__file" aria-label={FILE_NAME[file.target]}>
          <h3 className="topics-changes__name">{FILE_NAME[file.target]}</h3>
          {file.truncated ? (
            <Banner tone="warning" live="none">
              {t('changes.truncated')}
            </Banner>
          ) : null}
          <DiffText diff={file.diff} label={FILE_NAME[file.target]} />
        </section>
      ))}
    </div>
  );
}

export function PlanChangesDialog({ topicId, onClose }: { topicId: string; onClose(): void }) {
  const topic = useTopic(topicId);
  return (
    <Dialog
      open
      onClose={onClose}
      size="lg"
      title={topic === undefined ? t('changes.title') : t('changes.titleOf', { topic: topic.name })}
      description={t('changes.lead')}
      footer={
        <Button variant="ghost" onClick={onClose}>
          {tApp('common.close')}
        </Button>
      }
    >
      <PlanChanges topicId={topicId} />
    </Dialog>
  );
}
