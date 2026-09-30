// The activity feature: the live activity feed and the conflict panel, both tabs of the workbench's bottom drawer.
// Slot components take no props; everything comes from the workspace hooks (activity and conflicts stores).
import { ActivityFeed } from './ActivityPanel.tsx';
import { ConflictList } from './ConflictsPanel.tsx';
import './activity.css';

export type ActivityPanelProps = Record<never, never>;

/** 活動動態 (SPEC R8.5, R11): who / which agent / which file / what, newest first; click a file to open it. */
export function ActivityPanel(_props: ActivityPanelProps) {
  return <ActivityFeed />;
}

export type ConflictsPanelProps = Record<never, never>;

/** 衝突面板 (SPEC R8): the human text and the other version side by side; keep the human text or apply the other one. */
export function ConflictsPanel(_props: ConflictsPanelProps) {
  return <ConflictList />;
}
