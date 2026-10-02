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
    'copy.done': 'Copied',
    'copy.failed': 'Could not copy. Select the text by hand.',
  },
  zhTW,
);
