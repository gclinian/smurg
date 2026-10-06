// The left column of the sessions view (DESIGN §5.2, UX §3): the inbox, the session list grouped by topic, the rail,
// and what they say elsewhere on the screen (the two counts, the banners above the columns, the notices of a new
// waiting item).
export { InboxList, InboxPreview, useInboxRows, useOpenInboxItem, type InboxRow } from './InboxList.tsx';
export { InboxNotices, ShellBanners, type InboxNoticesProps } from './Notices.tsx';
export { SessionTree, type SessionTreeProps } from './SessionTree.tsx';
export { InboxCounts, Sidebar, type SidebarProps, type SidebarSection } from './Sidebar.tsx';
import { t } from './strings.ts';

/** What the separator beside the left column resizes: "the inbox and the session list". */
export const sidebarResizeLabel = (): string => t('resize');
