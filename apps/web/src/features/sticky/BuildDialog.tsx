// "Build this" (DESIGN 0.8.0 D5.3): the exact text that becomes the topic's spec, as the daemon composed it from what
// this member reads (`sticky.spec`: the note and the notes it links to directly), shown as plain, visible text and
// never rendered, with the warning the Start dialog gives when it holds characters nobody sees. Confirming asks the
// daemon to make the topic from THAT text (`sticky.build` with its hash: a note that changed meanwhile is refused, and
// the new text is shown to be read again); then the topic's plan opens in the sessions view, where the member presses
// Start in the topic's own Start dialog. Nothing starts here.
import { errorReasonOf, hasInvisibleCharacters, isSmurgError, type ResultOf } from '@smurg/protocol';
import { useCallback, useEffect, useRef, useState } from 'react';
import { describeError } from '../../lib/errors.ts';
import { formatAnd } from '../../lib/format.ts';
import { useCommand, useConnection } from '../../lib/workspace/context.tsx';
import { tApp } from '../../strings/app.ts';
import { Banner, Button, Dialog, Spinner } from '../../ui/index.ts';
import { PlainText } from '../markdown/index.ts';
import { t } from './strings.ts';
import './sticky.css';

type Spec = ResultOf<'sticky.spec'>;

type Shown = { readonly kind: 'loading' } | { readonly kind: 'failed'; readonly reason: string } | { readonly kind: 'ready'; readonly spec: Spec };

export interface BuildDialogProps {
  /** The note's name on disk. */
  readonly note: string;
  readonly open: boolean;
  onClose(): void;
}

export function BuildDialog({ note, open, onClose }: BuildDialogProps) {
  const conn = useConnection();
  const openColumn = useCommand('openColumn');
  const [shown, setShown] = useState<Shown>({ kind: 'loading' });
  const [busy, setBusy] = useState(false);
  /** What became of the last confirm: the host's words, and the topic when one was made all the same (D5.4). */
  const [problem, setProblem] = useState<{ readonly text: string; readonly topicId: string | null } | null>(null);
  // One press makes one topic: a second press while the first is on its way does nothing.
  const running = useRef(false);
  // The answer of a read that was asked for after this one wins (a reopen, a read after `note-changed`).
  const generation = useRef(0);

  const read = useCallback(async (): Promise<void> => {
    const mine = ++generation.current;
    setShown({ kind: 'loading' });
    try {
      const spec = await conn.request('sticky.spec', { note });
      if (mine === generation.current) setShown({ kind: 'ready', spec });
    } catch (error) {
      if (mine === generation.current) setShown({ kind: 'failed', reason: describeError(error) });
    }
  }, [conn, note]);

  useEffect(() => {
    if (!open) return;
    setProblem(null);
    void read();
    return () => {
      generation.current += 1;
    };
  }, [open, read]);

  const close = (): void => {
    if (running.current) return;
    onClose();
  };

  const confirm = async (): Promise<void> => {
    if (running.current || shown.kind !== 'ready') return;
    running.current = true;
    setBusy(true);
    setProblem(null);
    try {
      const { topicId } = await conn.request('sticky.build', { note, hash: shown.spec.hash });
      running.current = false;
      onClose();
      await openColumn({ target: { kind: 'plan', topicId } });
    } catch (error) {
      const topicId = isSmurgError(error) && typeof error.detail?.['topicId'] === 'string' ? error.detail['topicId'] : null;
      setProblem({ text: topicId === null ? t('build.failed', { reason: describeError(error) }) : describeError(error), topicId });
      // The note or a note it links to changed: the new text is read, to be read again before a new confirm.
      if (isSmurgError(error) && error.code === 'conflict' && errorReasonOf(error) === 'note-changed') void read();
    } finally {
      running.current = false;
      setBusy(false);
    }
  };

  const ready = shown.kind === 'ready' ? shown.spec : null;
  return (
    <Dialog
      open={open}
      onClose={close}
      size="lg"
      title={t('build.title')}
      description={t('build.body')}
      footer={
        <>
          <Button variant="ghost" onClick={close} disabled={busy}>
            {tApp('common.cancel')}
          </Button>
          <Button variant="primary" onClick={() => void confirm()} loading={busy} disabled={ready === null}>
            {t('build.confirm')}
          </Button>
        </>
      }
    >
      <div className="sticky-build">
        {problem !== null ? (
          <Banner
            tone="danger"
            live="alert"
            actions={
              problem.topicId === null ? null : (
                <Button
                  size="sm"
                  onClick={() => {
                    const topicId = problem.topicId as string;
                    onClose();
                    void openColumn({ target: { kind: 'plan', topicId } });
                  }}
                >
                  {t('build.openPlan')}
                </Button>
              )
            }
          >
            {problem.text}
          </Banner>
        ) : null}
        {shown.kind === 'loading' ? (
          <p className="sticky-card__quiet">
            <Spinner size={14} decorative />
            <span>{t('build.loading')}</span>
          </p>
        ) : null}
        {shown.kind === 'failed' ? (
          <div className="sticky-build__failed">
            <p className="sticky-card__problem" role="alert">
              {t('build.loadFailed', { reason: shown.reason })}
            </p>
            <Button size="sm" onClick={() => void read()}>
              {t('load.retry')}
            </Button>
          </div>
        ) : null}
        {ready !== null ? (
          <>
            <p className="sticky-build__notes">{t('build.notes', { count: ready.notes.length, names: formatAnd(ready.notes) })}</p>
            {hasInvisibleCharacters(ready.text) ? (
              <Banner tone="warning" live="none">
                {t('build.invisible')}
              </Banner>
            ) : null}
            <section className="sticky-build__text" aria-label={t('build.text')} tabIndex={0}>
              <PlainText text={ready.text} />
            </section>
          </>
        ) : null}
      </div>
    </Dialog>
  );
}
