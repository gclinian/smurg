// The pages that stand in for a sticky note (DESIGN 0.8.0 D7.6): while there is no Home, the first page; for a valid
// name the index does not list (a link to a note not written yet, a typed address), the page of that name. A member
// who may write files writes the note from there (sticky.create: an empty note, D2.5); everyone else is told who can.
// The one way to make a note: a link always leads to a page, never to a file being made by a stray click.
import { errorReasonOf, isSmurgError } from '@smurg/protocol';
import { useId, useState } from 'react';
import { describeError } from '../../lib/errors.ts';
import { selectNote } from '../../lib/stores/sticky.ts';
import { useCan, useStores } from '../../lib/workspace/context.tsx';
import { Button } from '../../ui/index.ts';
import { IconPlus } from '../../ui/icons.tsx';
import { t } from './strings.ts';
import './sticky.css';

export interface NoPageProps {
  /** `first`: there is no Home yet; `missing`: the note `name` is not written yet. */
  readonly kind: 'first' | 'missing';
  readonly name: string;
}

export function NoPage({ kind, name }: NoPageProps) {
  const stores = useStores();
  const canWrite = useCan('file.write');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const headingId = useId();

  const write = (): void => {
    setBusy(true);
    setProblem(null);
    stores.sticky
      .create(name)
      .catch(async (error: unknown) => {
        // Somebody wrote it a moment ago: the index lists it, and the page becomes the note. When it still does not
        // (its file is past the sticky notes the index lists), the host's words say why (review S3-R4).
        if (isSmurgError(error) && error.code === 'conflict' && errorReasonOf(error) === 'exists') {
          await stores.sticky.reload().catch(() => {});
          if (selectNote(stores.sticky.getState(), name) !== undefined) return;
        }
        setProblem(t('create.failed', { reason: describeError(error) }));
      })
      .finally(() => setBusy(false));
  };

  return (
    <div className="sticky-page">
      <section className="sticky-card sticky-card--blank" aria-labelledby={headingId}>
        <h2 id={headingId} className="sticky-card__name" tabIndex={-1} data-region-focus>
          {kind === 'first' ? t('first.title') : name}
        </h2>
        <div className="sticky-card__body">
          <p className="sticky-card__quiet">{kind === 'first' ? t('first.body') : t('missing.body')}</p>
          {canWrite ? (
            <div className="sticky-card__actions">
              <Button variant="primary" icon={<IconPlus />} loading={busy} onClick={write}>
                {kind === 'first' ? t('first.write') : t('missing.write')}
              </Button>
            </div>
          ) : (
            <p className="sticky-card__quiet">{kind === 'first' ? t('first.viewer') : t('missing.viewer')}</p>
          )}
          {problem === null ? null : (
            <p className="sticky-card__problem" role="alert">
              {problem}
            </p>
          )}
        </div>
      </section>
    </div>
  );
}
