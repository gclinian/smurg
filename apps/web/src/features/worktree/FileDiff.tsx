// One file's diff as lines, with what a reviewer must not miss: a cut diff, a binary file, a file whose changes only
// the host may see, and invisible characters shown as ⟨U+…⟩ (diff-model.ts).
import { useMemo, useState } from 'react';
import { tApp } from '../../strings/app.ts';
import { Banner, Button, Spinner } from '../../ui/index.ts';
import { hasInvisible, parseDiffLines, revealInvisible, type MergeFileDiff, type ReviewFile } from './diff-model.ts';
import { t } from './strings.ts';
import type { Load } from './use-request-diff.ts';

/** Lines of one file's diff rendered at first; "Show more" adds this many again (a 1 MiB diff is ~30,000 lines). */
export const DIFF_LINES_STEP = 2_000;

export interface FileDiffViewProps {
  readonly entry: ReviewFile;
  /** The file's own diff, when it had to be fetched. */
  readonly fetched: Load<MergeFileDiff> | undefined;
  onRetry(): void;
}

export function FileDiffView({ entry, fetched, onRetry }: FileDiffViewProps) {
  const path = entry.file.path;
  const [limit, setLimit] = useState(DIFF_LINES_STEP);
  const withheld = entry.file.hidden === true || (fetched?.status === 'ready' && fetched.value.hidden === true);
  const source: { text: string; truncated: boolean; binary: boolean } | null =
    entry.section !== null
      ? { text: entry.section, truncated: false, binary: entry.file.binary === true }
      : fetched?.status === 'ready'
        ? { text: fetched.value.diff, truncated: fetched.value.truncated, binary: fetched.value.binary || entry.file.binary === true }
        : null;
  const lines = useMemo(() => (source ? parseDiffLines(source.text) : []), [source?.text]);
  const hidden = useMemo(() => lines.some((line) => hasInvisible(line.text)), [lines]);

  if (withheld) return <p className="worktree-diff__note">{t('review.withheld')}</p>;
  if (!source) {
    if (fetched?.status === 'error') {
      return (
        <Banner tone="danger" live="alert" actions={<Button size="sm" onClick={onRetry}>{tApp('common.retry')}</Button>}>
          {t('review.fileFailed', { path, message: fetched.message })}
        </Banner>
      );
    }
    return (
      <p className="worktree-review__loading">
        <Spinner size={14} decorative /> {t('review.fileLoading', { path })}
      </p>
    );
  }
  const hasHunks = lines.some((line) => line.kind === 'hunk');
  const shown = lines.slice(0, limit);
  return (
    <section className="worktree-diff" aria-label={t('review.diffLabel', { path })}>
      {source.truncated ? (
        <Banner tone="warning" live="none">
          {t('review.fileTruncated')}
        </Banner>
      ) : null}
      {hidden ? (
        <Banner tone="warning" live="none">
          {t('review.hiddenChars')}
        </Banner>
      ) : null}
      {source.binary ? <p className="worktree-diff__note">{t('review.binary')}</p> : !hasHunks ? <p className="worktree-diff__note">{t('review.noTextChange')}</p> : null}
      <pre className="worktree-diff__code">
        {shown.map((line, index) => (
          <span key={index} className={`worktree-diff__line worktree-diff__line--${line.kind}`}>
            <span className="worktree-diff__num" aria-hidden="true">
              {line.oldLine ?? ''}
            </span>
            <span className="worktree-diff__num" aria-hidden="true">
              {line.newLine ?? ''}
            </span>
            <span className="worktree-diff__text">
              {revealInvisible(line.text).map((piece, at) =>
                piece.codePoint !== undefined ? (
                  <span key={at} className="worktree-diff__hidden" title={t('review.hiddenChar', { code: piece.codePoint })}>
                    {`⟨${piece.codePoint}⟩`}
                  </span>
                ) : (
                  piece.text
                ),
              )}
            </span>
            {'\n'}
          </span>
        ))}
      </pre>
      {lines.length > limit ? (
        <Button size="sm" onClick={() => setLimit((n) => n + DIFF_LINES_STEP)}>
          {t('review.showMore', { count: lines.length - limit })}
        </Button>
      ) : null}
    </section>
  );
}
