// The changes of one merge request as a component reads them: the whole diff (worktree.merge.diff), its review model
// (diff-model.ts) and the files that had to be fetched on their own (worktree.merge.fileDiff). Shared by the host's
// review (MergeReview.tsx) and the "Changes" section of a result report (ChangedFiles.tsx).
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { describeError } from '../../lib/errors.ts';
import { useStores } from '../../lib/workspace/context.tsx';
import { tApp } from '../../strings/app.ts';
import { buildReviewModel, unopenedPaths, type MergeDiff, type MergeFileDiff, type ReviewFile, type ReviewModel } from './diff-model.ts';

export type Load<T> = { readonly status: 'loading' } | { readonly status: 'ready'; readonly value: T } | { readonly status: 'error'; readonly message: string };

export interface RequestDiff {
  readonly load: Load<MergeDiff>;
  /** Null until the diff is there. */
  readonly model: ReviewModel | null;
  /** By path: the files fetched on their own. */
  readonly fileDiffs: ReadonlyMap<string, Load<MergeFileDiff>>;
  /** Paths whose own diff arrived. */
  readonly opened: ReadonlySet<string>;
  /** Paths that still have to be opened before a merge may be approved (fail closed: diff-model.ts). */
  readonly remaining: readonly string[];
  /** Makes sure the file's diff is there: fetches it when the whole diff does not hold it completely. */
  open(entry: ReviewFile): void;
  /** Fetches one file's diff again (after a failure). */
  fetchFile(path: string): void;
  /** Loads the whole diff again. */
  reload(): void;
}

export function useRequestDiff(requestId: string): RequestDiff {
  const { worktrees } = useStores();
  const [attempt, setAttempt] = useState(0);
  const [load, setLoad] = useState<Load<MergeDiff>>({ status: 'loading' });
  const [fileDiffs, setFileDiffs] = useState<ReadonlyMap<string, Load<MergeFileDiff>>>(new Map());
  const alive = useRef(true);
  const requested = useRef(new Set<string>());

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  useEffect(() => {
    let current = true;
    setLoad({ status: 'loading' });
    setFileDiffs(new Map());
    requested.current = new Set();
    worktrees.diff(requestId).then(
      (value) => {
        if (current) setLoad({ status: 'ready', value });
      },
      (failure: unknown) => {
        if (current) setLoad({ status: 'error', message: describeError(failure) });
      },
    );
    return () => {
      current = false;
    };
  }, [worktrees, requestId, attempt]);

  const model = useMemo(() => (load.status === 'ready' ? buildReviewModel(load.value) : null), [load]);

  const fetchFile = useCallback(
    (path: string): void => {
      const asked = requested.current;
      asked.add(path);
      setFileDiffs((previous) => new Map(previous).set(path, { status: 'loading' }));
      const settle = (next: Load<MergeFileDiff>): void => {
        // A reload meanwhile started over: this answer belongs to the old list.
        if (alive.current && requested.current === asked) setFileDiffs((previous) => new Map(previous).set(path, next));
      };
      worktrees.fileDiff(requestId, path).then(
        (value) => {
          // Only the file that was asked for counts as opened (fail closed on a mismatched answer).
          if (value.path === path) {
            settle({ status: 'ready', value });
            return;
          }
          asked.delete(path);
          settle({ status: 'error', message: tApp('error.generic') });
        },
        (failure: unknown) => {
          asked.delete(path);
          settle({ status: 'error', message: describeError(failure) });
        },
      );
    },
    [worktrees, requestId],
  );

  const open = useCallback(
    (entry: ReviewFile): void => {
      if (entry.section === null && !requested.current.has(entry.file.path)) fetchFile(entry.file.path);
    },
    [fetchFile],
  );

  const opened = useMemo(() => {
    const set = new Set<string>();
    for (const [path, state] of fileDiffs) if (state.status === 'ready') set.add(path);
    return set;
  }, [fileDiffs]);
  const remaining = useMemo(() => (model ? unopenedPaths(model, opened) : []), [model, opened]);
  const reload = useCallback(() => setAttempt((n) => n + 1), []);

  return { load, model, fileDiffs, opened, remaining, open, fetchFile, reload };
}
