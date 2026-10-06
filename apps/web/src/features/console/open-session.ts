// From the console to a session's column in the sessions view: the console is a page of its own, so the column is
// opened in the member's columns store and the route changes to the workspace (the columns store is what the
// `openColumn` command of the shell writes too; the shell is not mounted on this page).
import { useCallback } from 'react';
import { useAppServices } from '../../app/services.tsx';
import { routePath } from '../../lib/router.ts';
import { useStores, useWorkspaceSession } from '../../lib/workspace/context.tsx';

/** `open(sessionId, cardId?)`: shows the session (scrolled to that card) and leaves the console. */
export function useOpenSession(): (sessionId: string, cardId?: string) => void {
  const stores = useStores();
  const { router } = useAppServices();
  const { workspaceId } = useWorkspaceSession();
  return useCallback(
    (sessionId, cardId) => {
      stores.columns.open({ kind: 'session', sessionId }, { from: 'inbox', ...(cardId === undefined ? {} : { anchor: { cardId } }) });
      router.navigate(routePath({ name: 'workspace', workspaceId }));
    },
    [stores, router, workspaceId],
  );
}
