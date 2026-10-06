// The Changes column (DESIGN §5.4): a merge request without a result report (a free session's worktree). The whole
// review of the worktree feature inside a column: every member reads the complete diff, the host merges or rejects.
import { useStore } from '../../lib/store.ts';
import { useStores } from '../../lib/workspace/context.tsx';
import { Spinner } from '../../ui/index.ts';
import { MergeReviewPanel } from '../worktree/index.tsx';
import { Note, Scroll } from './shared.tsx';
import { t } from './strings.ts';
import './topics.css';

export default function ChangesColumn({ requestId }: { requestId: string }) {
  const known = useStore(useStores().worktrees, (state) => state.mergeRequests.has(requestId));
  if (!known) {
    return (
      <Note>
        <Spinner size={16} decorative /> {t('loading')}
      </Note>
    );
  }
  return (
    <MergeReviewPanel
      requestId={requestId}
      frame={({ body, footer }) => (
        <>
          <Scroll>
            <div className="topics-changes-column">{body}</div>
          </Scroll>
          {footer !== null ? <div className="col-foot topics-changes-column__foot">{footer}</div> : null}
        </>
      )}
    />
  );
}
