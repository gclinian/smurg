// Small pieces the topic columns and dialogs share: reading a topic and the people from the stores, a time of day,
// the toast after a text was sent to an agent, and the frame parts of a column body (toolbar, scrolling body, foot).
import type { ColumnTarget, PresenceMember, ResultOf, Topic } from '@smurg/protocol';
import { useCallback, type ReactNode } from 'react';
import type { ColumnAnchor } from '../../lib/columns/target.ts';
import { describeError } from '../../lib/errors.ts';
import { shallowEqual, useStore } from '../../lib/store.ts';
import { selectTopic } from '../../lib/stores/topics.ts';
import { useCommand, useStores } from '../../lib/workspace/context.tsx';
import { cx, useToast } from '../../ui/index.ts';
import { agentAccessNames } from './model.ts';

export { formatClock } from './model.ts';
import { t } from './strings.ts';

/** The topic, archived or not; undefined while the list loads or when the topic is gone (the frame says so). */
export function useTopic(topicId: string): Topic | undefined {
  return useStore(useStores().topics, (state) => selectTopic(state, topicId));
}

/** Every member of the workspace as presence knows them (role, online). */
export function useMembers(): readonly PresenceMember[] {
  return useStore(useStores().presence, (state) => state.members, shallowEqual);
}

/**
 * What became of a text for an agent (`topic.revise`, `report.followUp`): a member with agent access sent a message,
 * anyone else made a suggestion. Says so in a toast; the text itself shows in the conversation.
 */
export function useSentNotice(where: 'discussion' | 'item'): (result: ResultOf<'topic.revise'>) => void {
  const toast = useToast();
  const members = useMembers();
  return useCallback(
    (result) => {
      if ('suggestion' in result) toast.show({ tone: 'success', title: t('sent.suggestion', { names: agentAccessNames(members) }) });
      else toast.show({ tone: 'success', title: where === 'discussion' ? t('sent.discussion') : t('sent.item') });
    },
    [toast, members, where],
  );
}

/** Runs an action of a button and says why in a toast when the daemon refuses it. */
export function useAction(): (run: () => Promise<unknown>, failed: (reason: string) => string) => Promise<boolean> {
  const toast = useToast();
  return useCallback(
    async (run, failed) => {
      try {
        await run();
        return true;
      } catch (error) {
        toast.show({ tone: 'danger', title: failed(describeError(error)) });
        return false;
      }
    },
    [toast],
  );
}

/** Opens a thing in a column beside the one that is being read (UX §2: links inside a column open to the side). */
export function useOpenSide(): (target: ColumnTarget, anchor?: ColumnAnchor) => void {
  const open = useCommand('openColumn');
  return useCallback(
    (target, anchor) => {
      open({ target, side: true, ...(anchor === undefined ? {} : { anchor }) }).catch(() => {});
    },
    [open],
  );
}

/** A button that reads as a link inside a sentence or a row ("Open the discussion", "Session", "Show the changes"). */
export function LinkButton({ children, onClick, disabled, className, title }: { children: ReactNode; onClick(): void; disabled?: boolean; className?: string; title?: string }) {
  return (
    <button type="button" className={cx('topics-link', className)} onClick={onClick} disabled={disabled} title={title}>
      {children}
    </button>
  );
}

/** The bar under a column's header: view switch, the file's path, the column's actions. */
export function Toolbar({ children }: { children: ReactNode }) {
  return <div className="col-toolbar">{children}</div>;
}

/** The part of a toolbar that takes the room that is left (the file's path). */
export function ToolbarPath({ path }: { path: string }) {
  return (
    <div className="col-toolbar__grow">
      <span className="col-toolbar__path" title={path}>
        {path}
      </span>
    </div>
  );
}

/** The scrolling part of a column (position: relative, so nothing inside makes the page taller than the window). */
export function Scroll({ children, className, hidden }: { children: ReactNode; className?: string; hidden?: boolean }) {
  return (
    <div className={cx('col-scroll', className)} hidden={hidden}>
      {children}
    </div>
  );
}

/** The foot of a column: a sentence and at most one main button. */
export function Foot({ text, children, className, flash }: { text?: ReactNode; children?: ReactNode; className?: string; flash?: boolean }) {
  return (
    <div className={cx('col-foot', className)} data-flash={flash || undefined}>
      {text !== undefined ? <span className="col-foot__text">{text}</span> : null}
      {children}
    </div>
  );
}

/** A centred note in place of a column's content (loading, nothing yet). */
export function Note({ children }: { children: ReactNode }) {
  return <div className="col-note">{children}</div>;
}
