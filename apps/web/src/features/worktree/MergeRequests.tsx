// Merge requests (SPEC R9 「合併：worktree 擁有者提出合併請求 → 主人看到完整 diff → 確認後合併」). Shown as the
// workbench's 「合併請求」 drawer tab and inside the host console:
//  - worktree owners (runner, host) see their worktrees with 「請求合併」;
//  - everyone sees the requests and their status; the requester reads the outcome (merged, rejected with the reason,
//    conflict with the files);
//  - the host opens 「審核」 (MergeReview.tsx), the requester may open the same diff read-only.
import { useState } from 'react';
import type { WorktreeInfo } from '@smurg/protocol';
import { useStore } from '../../lib/store.ts';
import { selectMergeRequestList, selectWorktreeList } from '../../lib/stores/worktrees.ts';
import { selectUserId } from '../../lib/stores/workspace.ts';
import { useCan, useStores } from '../../lib/workspace/context.tsx';
import { Banner, Button, EmptyState, Spinner } from '../../ui/index.ts';
import { IconGitMerge } from '../../ui/icons.tsx';
import { isDecidable } from './labels.ts';
import { MergeRequestItem } from './MergeRequestItem.tsx';
import { MergeReviewDialog } from './MergeReview.tsx';
import { RequestMergeDialog } from './RequestMergeDialog.tsx';
import { t } from './strings.ts';
import { useNow } from './use-now.ts';

export interface MergeRequestsSectionProps {
  /** Level of the section's sub-headings (the console nests them one level deeper). */
  readonly headingLevel?: 3 | 4;
}

export function MergeRequestsSection({ headingLevel = 3 }: MergeRequestsSectionProps) {
  const stores = useStores();
  const state = useStore(stores.worktrees);
  const userId = useStore(stores.workspace, selectUserId);
  const isHost = useCan('worktree.merge.decide');
  const canRequest = useCan('worktree.merge.request');
  const now = useNow();
  const [reviewing, setReviewing] = useState<string | null>(null);
  const [requesting, setRequesting] = useState<WorktreeInfo | null>(null);
  const Heading = headingLevel === 3 ? 'h3' : 'h4';

  const requests = selectMergeRequestList(state);
  // The queue reads oldest first; history newest first.
  const open = requests.filter((request) => isDecidable(request.status)).reverse();
  const decided = requests.filter((request) => !isDecidable(request.status));
  const mine = canRequest && userId !== null ? selectWorktreeList(state).filter((worktree) => worktree.ownerUserId === userId) : [];
  const pendingFor = (worktreeId: string): boolean => requests.some((request) => request.worktreeId === worktreeId && request.status === 'pending');

  const item = (request: (typeof requests)[number]) => (
    <MergeRequestItem
      key={request.id}
      request={request}
      worktree={state.worktrees.get(request.worktreeId) ?? null}
      userId={userId}
      isHost={isHost}
      now={now}
      onOpen={setReviewing}
    />
  );

  return (
    <div className="worktree-requests">
      {state.status === 'loading' && requests.length === 0 ? (
        <p className="worktree-requests__loading">
          <Spinner size={14} decorative /> {t('list.loading')}
        </p>
      ) : null}
      {state.status === 'error' && state.error ? (
        <Banner tone="danger" live="none">
          {t('list.failed', { message: state.error })}
        </Banner>
      ) : null}

      {mine.length > 0 ? (
        <section className="worktree-requests__group" aria-label={t('mine.title')}>
          <Heading className="worktree-requests__heading">{t('mine.title')}</Heading>
          <ul className="worktree-mine">
            {mine.map((worktree) => (
              <li key={worktree.id} className="worktree-mine__item">
                <span className="worktree-mine__branch">{worktree.branch}</span>
                {pendingFor(worktree.id) ? <span className="worktree-mine__note">{t('mine.pending')}</span> : null}
                <Button size="sm" icon={<IconGitMerge />} onClick={() => setRequesting(worktree)}>
                  {t('mine.request')}
                </Button>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {requests.length === 0 && state.status !== 'loading' ? (
        <EmptyState compact icon={<IconGitMerge size={20} />} title={t('mergeTitle')} description={t('list.empty')} />
      ) : null}

      {open.length > 0 ? (
        <section className="worktree-requests__group" aria-label={t('list.pendingTitle', { count: open.length })}>
          <Heading className="worktree-requests__heading">{t('list.pendingTitle', { count: open.length })}</Heading>
          <ul className="worktree-requests__list">{open.map(item)}</ul>
        </section>
      ) : null}
      {decided.length > 0 ? (
        <section className="worktree-requests__group" aria-label={t('list.decidedTitle')}>
          <Heading className="worktree-requests__heading">{t('list.decidedTitle')}</Heading>
          <ul className="worktree-requests__list">{decided.map(item)}</ul>
        </section>
      ) : null}

      <MergeReviewDialog requestId={reviewing} onClose={() => setReviewing(null)} />
      <RequestMergeDialog worktree={requesting} onClose={() => setRequesting(null)} />
    </div>
  );
}
