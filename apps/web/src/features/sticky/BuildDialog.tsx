// "Build this" (DESIGN 0.8.0 D5.3): the exact text that becomes the topic's spec, as the daemon composed it from what
// this member reads (`sticky.spec`: the note and the notes it links to directly), shown as plain, visible text and
// never rendered, with the warning the Start dialog gives when it holds characters nobody sees. Confirming asks the
// daemon to make the topic from THAT text (`sticky.build` with its hash: a note that changed meanwhile is refused, and
// the new text is shown to be read again); then the topic's plan opens in the sessions view, where the member presses
// Start in the topic's own Start dialog. No work starts here (the topic's discussion starts, as every new topic's does,
// D5.5).
//
// One dialog makes at most one topic: once the host made the topic and a later step failed (D5.4), or once nobody can
// know whether it did (a reply that never came), the dialog offers no confirm again (the same text again would make a
// second topic, `<slug>-2`), only Close; "Build this" opened anew reads the text again and is a new build.
import { errorReasonOf, hasInvisibleCharacters, isSmurgError, type ResultOf } from '@smurg/protocol';
import { isClientRequestError } from '@smurg/protocol/client';
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

/**
 * What became of the last confirm: the words; a second line (where to look when nobody knows the outcome); the topic
 * the host made all the same (D5.4); `final`: a topic was made or may have been, so this dialog confirms nothing more.
 */
interface Problem {
  readonly text: string;
  readonly more: string | null;
  readonly topicId: string | null;
  readonly final: boolean;
}

/**
 * The page cannot know that the host made nothing: the request failed here after it may have reached the host (it was
 * sent and timed out, the connection dropped or closed under it). Only a request that never left the page (not
 * connected, too much queued, or `sent: false`) is known to have made nothing; a host's refusal says so itself.
 */
function outcomeUnknown(error: unknown): boolean {
  if (!isClientRequestError(error)) return false;
  if (error.failure === 'not-connected' || error.failure === 'overflow') return false;
  return error.detail?.['sent'] !== false;
}

function problemOf(error: unknown): Problem {
  const topicId = isSmurgError(error) && typeof error.detail?.['topicId'] === 'string' ? error.detail['topicId'] : null;
  if (topicId !== null) return { text: describeError(error), more: null, topicId, final: true };
  if (outcomeUnknown(error)) return { text: describeError(error), more: t('build.unknown'), topicId: null, final: true };
  return { text: t('build.failed', { reason: describeError(error) }), more: null, topicId: null, final: false };
}

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
  const [problem, setProblem] = useState<Problem | null>(null);
  // One press makes one topic: a second press while the first is on its way does nothing (and after it, `final`).
  const running = useRef(false);
  // The answer of a read that was asked for after this one wins (a reopen, a read after `note-changed`).
  const generation = useRef(0);
  const closeButton = useRef<HTMLButtonElement>(null);
  const final = problem?.final === true;

  // The confirm that held the focus is gone: the focus goes to Close, in the dialog, never to the page behind it.
  useEffect(() => {
    if (final) closeButton.current?.focus();
  }, [final]);

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
    if (running.current || shown.kind !== 'ready' || final) return;
    running.current = true;
    setBusy(true);
    setProblem(null);
    try {
      const { topicId } = await conn.request('sticky.build', { note, hash: shown.spec.hash });
      running.current = false;
      onClose();
      await openColumn({ target: { kind: 'plan', topicId } });
    } catch (error) {
      setProblem(problemOf(error));
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
        final ? (
          <Button ref={closeButton} variant="ghost" onClick={close}>
            {tApp('common.close')}
          </Button>
        ) : (
          <>
            <Button variant="ghost" onClick={close} disabled={busy}>
              {tApp('common.cancel')}
            </Button>
            <Button variant="primary" onClick={() => void confirm()} loading={busy} disabled={ready === null}>
              {t('build.confirm')}
            </Button>
          </>
        )
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
            {problem.more === null ? (
              problem.text
            ) : (
              <>
                <p>{problem.text}</p>
                <p>{problem.more}</p>
              </>
            )}
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
