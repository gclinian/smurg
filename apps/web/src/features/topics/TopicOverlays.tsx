// The dialogs of the topics feature, mounted once by the workspace shell in both modes (slots.tsx → overlays). Which
// one is open is dialogs.ts; the command `newTopic` (the "New" control, the rail, the empty state) opens the first:
// its handler is in slots.tsx, registered before this file has loaded.
import { useCallback } from 'react';
import { useStore } from '../../lib/store.ts';
import { useStores } from '../../lib/workspace/context.tsx';
import { MergeReviewDialog } from '../worktree/index.tsx';
import { topicDialogs } from './dialogs.ts';
import { NewTopicDialog } from './NewTopicDialog.tsx';
import { PlanChangesDialog } from './PlanChanges.tsx';
import { StartDialog } from './StartDialog.tsx';
import { ArchiveTopicDialog, DeleteTopicDialog, RenameTopicDialog, RestartDiscussionDialog, RestoreTopic } from './TopicDialogs.tsx';
import './topics.css';

export default function TopicOverlays() {
  const stores = useStores();
  const dialogs = topicDialogs(stores);
  const dialog = useStore(dialogs);
  const close = useCallback(() => dialogs.close(), [dialogs]);

  if (dialog === null) return null;
  switch (dialog.kind) {
    case 'new':
      return <NewTopicDialog onClose={close} />;
    case 'start':
      // A different topic or selection is a different dialog: nothing carries over.
      return <StartDialog key={`${dialog.topicId}:${dialog.itemIds?.join(',') ?? ''}`} topicId={dialog.topicId} itemIds={dialog.itemIds} onClose={close} />;
    case 'changes':
      return <PlanChangesDialog key={dialog.topicId} topicId={dialog.topicId} onClose={close} />;
    case 'rename':
      return <RenameTopicDialog key={dialog.topicId} topicId={dialog.topicId} onClose={close} />;
    case 'archive':
      return <ArchiveTopicDialog key={dialog.topicId} topicId={dialog.topicId} onClose={close} />;
    case 'restore':
      return <RestoreTopic key={dialog.topicId} topicId={dialog.topicId} onClose={close} />;
    case 'delete':
      return <DeleteTopicDialog key={dialog.topicId} topicId={dialog.topicId} onClose={close} />;
    case 'restart':
      return <RestartDiscussionDialog key={dialog.topicId} topicId={dialog.topicId} onClose={close} />;
    case 'merge':
      return <MergeReviewDialog requestId={dialog.requestId} onClose={close} />;
  }
}
