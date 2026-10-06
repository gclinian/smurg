// One file's diff as lines, with what a reviewer must not miss: a cut diff, a binary file, a file whose changes only
// the host may see, and invisible characters shown as ⟨U+…⟩ (diff-model.ts).
//
// `UnifiedDiff` is the same lines for a diff that stands alone (the changes of SPEC.md and PLAN.md in the Start
// dialog of features/topics): one rendering of a unified diff for everything a person reviews before it counts.
import { useMemo, useState } from 'react';
import { tApp } from '../../strings/app.ts';
import { Banner, Button, Spinner } from '../../ui/index.ts';
import { hasInvisible, parseDiffLines, revealInvisible, type DiffLine, type MergeFileDiff, type ReviewFile } from './diff-model.ts';
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

/**
 * The lines of a unified diff: old and new line numbers, added and removed lines marked, every invisible character
 * shown as ⟨U+…⟩ with a warning above, and "Show more" in steps. With `label` the block names itself and takes the
 * keyboard focus (a diff that stands alone and scrolls); inside a file's section the section is the name.
 */
export function DiffLines({ lines, label }: { lines: readonly DiffLine[]; label?: string }) {
  const [limit, setLimit] = useState(DIFF_LINES_STEP);
  const hidden = useMemo(() => lines.some((line) => hasInvisible(line.text)), [lines]);
  const shown = lines.slice(0, limit);
  return (
    <>
      {hidden ? (
        <Banner tone="warning" live="none">
          {t('review.hiddenChars')}
        </Banner>
      ) : null}
      <pre className="worktree-diff__code" {...(label === undefined ? {} : { role: 'group', 'aria-label': label, tabIndex: 0 })}>
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
    </>
  );
}

/** A unified diff that stands alone, named `label` (the caller's words: "Changes of PLAN.md"). */
export function UnifiedDiff({ diff, label }: { diff: string; label: string }) {
  const lines = useMemo(() => parseDiffLines(diff), [diff]);
  return (
    <div className="worktree-diff">
      <DiffLines lines={lines} label={label} />
    </div>
  );
}

export function FileDiffView({ entry, fetched, onRetry }: FileDiffViewProps) {
  const path = entry.file.path;
  const withheld = entry.file.hidden === true || (fetched?.status === 'ready' && fetched.value.hidden === true);
  const source: { text: string; truncated: boolean; binary: boolean } | null =
    entry.section !== null
      ? { text: entry.section, truncated: false, binary: entry.file.binary === true }
      : fetched?.status === 'ready'
        ? { text: fetched.value.diff, truncated: fetched.value.truncated, binary: fetched.value.binary || entry.file.binary === true }
        : null;
  const lines = useMemo(() => (source ? parseDiffLines(source.text) : []), [source?.text]);

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
  return (
    <section className="worktree-diff" aria-label={t('review.diffLabel', { path })}>
      {source.truncated ? (
        <Banner tone="warning" live="none">
          {t('review.fileTruncated')}
        </Banner>
      ) : null}
      {source.binary ? <p className="worktree-diff__note">{t('review.binary')}</p> : !hasHunks ? <p className="worktree-diff__note">{t('review.noTextChange')}</p> : null}
      {/* Keyed by the file: another file starts at the first step of lines again. */}
      <DiffLines key={path} lines={lines} />
    </section>
  );
}
