// The three dialogs of the host that a conversation leads to: the confirmation before an entry is removed, the review
// of a folder's Claude Code project settings, and the host's own Claude Code rules. They are the console feature's:
// it handles the commands `redactEvent`, `reviewProjectSettings` and `showHostRules` and mounts the dialogs once, in
// both modes (features/console/slots.tsx). A conversation only dispatches; for anyone but the host nothing opens.
import { useMemo } from 'react';
import type { RootRef } from '@smurg/protocol';
import { describeError } from '../../lib/errors.ts';
import { useCommands } from '../../lib/workspace/context.tsx';
import { useToast } from '../../ui/index.ts';

export interface HostDialogs {
  /** "Remove this entry": the confirmation before one event is replaced by "The host removed this entry." */
  redact(sessionId: string, seq: number): void;
  /** The Claude Code project settings of the folder a session works in (the trust gate). */
  projectSettings(root: RootRef): void;
  /** Which of the host's own Claude Code allow rules apply to agents here. */
  hostRules(): void;
}

export function useHostDialogs(): HostDialogs {
  const commands = useCommands();
  const toast = useToast();
  return useMemo(() => {
    // A build without the console feature has no handler: the button says so instead of doing nothing.
    const failed = (error: unknown): void => {
      toast.show({ tone: 'warning', title: describeError(error) });
    };
    return {
      redact: (sessionId, seq) => void commands.dispatch('redactEvent', { sessionId, seq }).catch(failed),
      projectSettings: (root) => void commands.dispatch('reviewProjectSettings', { root }).catch(failed),
      hostRules: () => void commands.dispatch('showHostRules', {}).catch(failed),
    };
  }, [commands, toast]);
}
