import { defineStrings } from './catalog.ts';
import { zhTW } from './ui.zh-TW.ts';

// Accessible names and small words of the shared components (src/ui).
export const tUi = defineStrings(
  'ui',
  {
    'dialog.close': 'Close dialog',
    'toast.region': 'Notifications',
    'toast.dismiss': 'Dismiss this notification',
    'split.resize': 'Drag or use the arrow keys to resize {name}',
    'language.label': 'Language',
    'spinner.loading': 'Loading',
    'drawer.expand': 'Expand {name}',
    'drawer.collapse': 'Collapse {name}',
    'avatar.online': '{name} (online)',
    'avatar.offline': '{name} (offline)',
    'avatar.agent': '{name} (agent)',
    'avatar.more': '{count} more',
    'table.empty': 'Nothing here',
    'boundary.error': '{name} cannot be shown',
    'boundary.errorBody': 'Something went wrong in this part of the page. The connection and the other parts are not affected.',
    'boundary.retry': 'Show again',
    // A part of the page whose file did not come (lib/chunks.ts): why, and the one thing that helps. Title and body
    // are read one after the other: "smurg was updated. Reload to get the new page; …".
    'chunk.gone.title': 'smurg was updated',
    'chunk.gone.body': 'Reload to get the new page; if the host has not updated yet, the page will say so.',
    'chunk.offline.title': 'This part of the page could not be loaded',
    'chunk.offline.body': 'The browser is offline or cannot reach the smurg server. When the connection is back, reload the page.',
    'chunk.failed.title': 'This part of the page could not be loaded',
    'chunk.failed.body': 'Reload the page to load it again.',
    'chunk.reload': 'Reload the page',
    // The whole page, when something other than a missing file stopped it (app/PageBoundary.tsx).
    'page.crashed.title': 'This page stopped working',
    'page.crashed.body': 'Something went wrong on this page. Reload the page to go on.',
    'columns.resize': 'Drag or use the arrow keys to resize {name}',
    'columns.more': '{count} more',
    'copy.done': 'Copied',
    'copy.failed': 'Could not copy. Select the text by hand.',
  },
  zhTW,
);
