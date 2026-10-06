import { defineStrings } from '../../strings/catalog.ts';
import { zhTW } from './strings.zh-TW.ts';

// The columns of the sessions view: the frame around what a column shows, and the strip they stand in (UX §2).
export const t = defineStrings(
  'columns',
  {
    'region': 'Open columns',
    'close': 'Close column: {title}',
    'more': 'More actions for {title}',
    'closeOthers': 'Close the other columns',
    'pin': 'Pin column: {title}',
    'unpin': 'Unpin column: {title}',
    'pin.item': 'Pin column',
    'unpin.item': 'Unpin',
    'title.hint': '{title} (press Delete to close this column)',
    'title.topic': '{title} · {topic}',
    'refused': 'Four columns are open. Close one first.',
    'gone.session': "This session ended a while ago, and the host's computer no longer keeps its content. You can close this column.",
    'gone.topic': 'This topic was deleted. You can close this column.',
    'gone.changes': 'This merge request no longer exists. You can close this column.',
    'gone.close': 'Close column',
    'waiting': 'Loading {title}',
    'placeholder.title': '{title} cannot be shown here',
    'placeholder.body': 'This build of smurg has nothing that shows this kind of column.',
    'side.region': 'Session beside the editor',
    'side.choose': 'Session shown beside the editor',
    'side.none': 'No session',
    'side.empty.title': 'No session beside the editor',
    'side.empty.body': 'Choose an agent session to keep its conversation next to the code.',
    'side.empty.none': 'There is no agent session yet. Start one in the sessions view.',
  },
  zhTW,
);
