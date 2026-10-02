import { defineStrings } from './catalog.ts';
import { zhTW } from './stores.zh-TW.ts';

// Text produced by the shared stores (src/lib/stores) rather than by a feature.
export const tStores = defineStrings(
  'stores',
  {
    'docs.bufferOverflow': 'Too much sync data piled up for this file. Close it and open it again.',
    'area.files': 'Files',
    'area.locks': 'File locks',
    'area.docs': 'Open files',
    'area.sessions': 'Agent sessions',
    'area.suggestions': 'Suggestions',
    'area.activity': 'Activity',
    'area.conflicts': 'Conflicts',
    'area.worktrees': 'Worktrees',
    'area.admin': 'Host console data',
    'area.presence': 'Online members',
    'area.workspace': 'Workspace',
    'area.transfers': 'Transfers',
    // A session nobody gave a title, where the sentence already names who opened it. (The full default title,
    // "Terminal (Ian)", is the wire catalogue's `session.title.*`: one wording for the web app and the CLI.)
    'session.kind.agent': 'Claude',
    'session.kind.terminal': 'Terminal',
    'worktree.mine': 'My worktree',
    'worktree.of': "{owner}'s worktree",
    'worktree.named': '{who} ({name})',
    'worktree.since': '{who} (created {time})',
  },
  zhTW,
);
