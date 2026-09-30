// The worktree feature's workbench slots (SPEC R9, ARCHITECTURE §5.7): <WorktreeSwitcher /> at the top of the left
// sidebar (main workspace or any worktree, with owner and branch) and <MergeRequestsPanel /> as the 「合併請求」 tab of
// the bottom drawer (request a merge, review the complete diff, approve or reject). The host console shows the same
// MergeRequestsSection.
import { useMember } from '../../lib/workspace/context.tsx';
import { MergeRequestsSection } from './MergeRequests.tsx';
import { WorktreeSwitcherView } from './Switcher.tsx';
import { useMergeResultNotices } from './use-merge-notices.ts';
import './worktree.css';

export { MergeRequestsSection, type MergeRequestsSectionProps } from './MergeRequests.tsx';

export type WorktreeSwitcherProps = Record<never, never>;

export function WorktreeSwitcher(_props: WorktreeSwitcherProps) {
  return <WorktreeSwitcherView />;
}

export type MergeRequestsPanelProps = Record<never, never>;

export function MergeRequestsPanel(_props: MergeRequestsPanelProps) {
  // The panel stays mounted in the workbench's drawer: the requester hears the host's decision wherever they are.
  useMergeResultNotices(useMember()?.userId ?? null);
  return (
    <div className="worktree-panel">
      <MergeRequestsSection />
    </div>
  );
}
