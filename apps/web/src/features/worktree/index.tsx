// The worktree feature (SPEC R9, ARCHITECTURE §5.7): <WorktreeSwitcher /> at the top of code mode's file sidebar (main
// workspace or any worktree, with owner and branch); <MergeRequestsSection /> for the host console (request a merge,
// review the complete diff, approve or reject); and the review pieces the sessions view mounts: a result report's
// changed files (<ChangedFiles />), the host's "Merge…" (<MergeReviewDialog />) and the body of a Changes column
// (<MergeReviewPanel />). In the sessions view a merge request is an inbox item, not a panel.
import { WorktreeSwitcherView } from './Switcher.tsx';
import './worktree.css';

export { ChangedFiles, type ChangedFilesProps } from './ChangedFiles.tsx';
export { UnifiedDiff } from './FileDiff.tsx';
export { MergeRequestsSection, type MergeRequestsSectionProps } from './MergeRequests.tsx';
export { MergeReviewDialog, MergeReviewPanel, type MergeReviewDialogProps, type MergeReviewPanelProps } from './MergeReview.tsx';
export { RequestMergeDialog, type RequestMergeDialogProps } from './RequestMergeDialog.tsx';
export { isDecidable, requestStatusLabel, requestStatusTone } from './labels.ts';

export type WorktreeSwitcherProps = Record<never, never>;

export function WorktreeSwitcher(_props: WorktreeSwitcherProps) {
  return <WorktreeSwitcherView />;
}
