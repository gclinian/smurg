// The files a merge request changes, as a list a reader unfolds file by file: the "Changes" section of a result
// report (DESIGN §5.4: "Changes from worktree.merge.diff / fileDiff of report.changes.requestId with 'Open in editor'
// and 'edited by hand: Amy' per file"). Reading only: deciding the merge is MergeReview.tsx.
import { useId, useState } from 'react';
import { formatList } from '../../lib/format.ts';
import { Badge, Banner, Button, Spinner } from '../../ui/index.ts';
import { IconChevronDown, IconChevronRight, IconCode } from '../../ui/icons.tsx';
import type { ReviewFile } from './diff-model.ts';
import { FileDiffView } from './FileDiff.tsx';
import { fileStatusLabel } from './labels.ts';
import { t } from './strings.ts';
import { useRequestDiff } from './use-request-diff.ts';

export interface ChangedFilesProps {
  readonly requestId: string;
  /** Files a person also edited in the worktree: each says "edited by hand: Amy". */
  readonly byHand?: readonly { readonly path: string; readonly by: readonly { readonly displayName: string }[] }[];
  /** "Open in editor" of a file; absent when there is nowhere to open it (the worktree is gone). */
  readonly onOpenFile?: ((path: string) => void) | undefined;
}

export function ChangedFiles({ requestId, byHand = [], onOpenFile }: ChangedFilesProps) {
  const { load, model, fileDiffs, open, fetchFile, reload } = useRequestDiff(requestId);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const id = useId();

  if (load.status === 'loading') {
    return (
      <p className="worktree-review__loading">
        <Spinner size={14} decorative /> {t('review.loading')}
      </p>
    );
  }
  if (load.status === 'error' || model === null) {
    return (
      <Banner tone="danger" live="alert" actions={<Button size="sm" onClick={reload}>{t('review.reload')}</Button>}>
        {t('review.loadFailed', { message: load.status === 'error' ? load.message : '' })}
      </Banner>
    );
  }
  if (model.files.length === 0) return <p className="worktree-review__empty">{t('review.noFiles')}</p>;

  const toggle = (entry: ReviewFile): void => {
    const path = entry.file.path;
    setExpanded((previous) => {
      const next = new Set(previous);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
    if (!expanded.has(path) && entry.file.hidden !== true) open(entry);
  };

  return (
    <ul className="worktree-files" aria-label={t('review.files')}>
      {model.files.map((entry, index) => {
        const { file } = entry;
        const isOpen = expanded.has(file.path);
        const hands = byHand.find((edited) => edited.path === file.path)?.by ?? [];
        const panelId = `${id}-${index}`;
        return (
          <li key={file.path} className="worktree-files__item" data-status={file.status}>
            <div className="worktree-files__row">
              <button type="button" className="worktree-files__toggle" aria-expanded={isOpen} aria-controls={panelId} onClick={() => toggle(entry)}>
                {isOpen ? <IconChevronDown size={12} /> : <IconChevronRight size={12} />}
                <span className="ui-visually-hidden">{fileStatusLabel(file.status)}: </span>
                <span className="worktree-files__path" title={file.path}>
                  {file.path}
                </span>
              </button>
              {hands.length > 0 ? <span className="worktree-files__byhand">{t('files.byHand', { names: formatList(hands.map((person) => person.displayName)) })}</span> : null}
              {file.hidden === true ? (
                <Badge>{t('files.hostOnly')}</Badge>
              ) : file.binary ? (
                <Badge>{t('review.binaryBadge')}</Badge>
              ) : (
                <span className="worktree-files__counts">
                  <span className="worktree-review__adds" aria-hidden="true">{`+${file.additions}`}</span>
                  <span className="worktree-review__dels" aria-hidden="true">{`−${file.deletions}`}</span>
                  <span className="ui-visually-hidden">{t('review.counts.file', { additions: t('review.linesAdded', { count: file.additions }), deletions: t('review.linesDeleted', { count: file.deletions }) })}</span>
                </span>
              )}
            </div>
            <div id={panelId} className="worktree-files__panel" hidden={!isOpen}>
              {isOpen ? (
                <>
                  {file.oldPath !== undefined ? <p className="worktree-diff__note">{t('review.renamedFrom', { path: file.oldPath })}</p> : null}
                  <FileDiffView entry={entry} fetched={fileDiffs.get(file.path)} onRetry={() => fetchFile(file.path)} />
                  {onOpenFile && file.status !== 'deleted' && file.hidden !== true ? (
                    <div className="worktree-files__actions">
                      <Button size="sm" variant="ghost" icon={<IconCode />} onClick={() => onOpenFile(file.path)}>
                        {t('files.openInEditor')}
                      </Button>
                    </div>
                  ) : null}
                </>
              ) : null}
            </div>
          </li>
        );
      })}
      {load.value.truncated ? <li className="worktree-files__note">{t('files.truncated')}</li> : null}
    </ul>
  );
}
