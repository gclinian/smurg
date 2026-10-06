// Tells the person who asked for a merge what the host decided (SPEC R9; review WEB-11: the requester saw nothing until
// they opened "Merge requests"). Like the suggestion notices: only a request this client saw PENDING and now sees merged,
// rejected or in conflict is announced — never what the first load already found decided.
import { useEffect } from 'react';
import type { MergeRequest } from '@smurg/protocol';
import { useStores } from '../../lib/workspace/context.tsx';
import { useToast } from '../../ui/index.ts';
import { formatList } from '../../lib/format.ts';
import { t } from './strings.ts';

const FILES_SHOWN = 5;

export function useMergeResultNotices(userId: string | null): void {
  const stores = useStores();
  const toast = useToast();
  useEffect(() => {
    if (userId === null) return;
    const lastSeen = new Map<string, MergeRequest['status']>();
    const scan = (announce: boolean): void => {
      for (const request of stores.worktrees.getState().mergeRequests.values()) {
        const previous = lastSeen.get(request.id);
        lastSeen.set(request.id, request.status);
        if (!announce || previous !== 'pending' || request.requestedBy?.userId !== userId || request.status === 'pending') continue;
        switch (request.status) {
          case 'merged':
            toast.show({ tone: 'success', title: t('notice.merged'), ...(request.message ? { description: request.message } : {}) });
            break;
          case 'rejected':
            toast.show({ tone: 'warning', title: t('notice.rejected'), ...(request.rejectReason ? { description: t('notice.reason', { reason: request.rejectReason }) } : {}) });
            break;
          case 'conflict': {
            const files = request.conflictFiles ?? [];
            const shown = formatList(files.length > FILES_SHOWN ? [...files.slice(0, FILES_SHOWN), '…'] : files);
            toast.show({ tone: 'warning', title: t('notice.conflict'), ...(shown ? { description: t('notice.conflictFiles', { files: shown }) } : {}) });
            break;
          }
        }
      }
    };
    scan(false);
    return stores.worktrees.subscribe(() => scan(true));
  }, [stores, toast, userId]);
}
