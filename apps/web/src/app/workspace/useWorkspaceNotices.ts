// Turns workspace events into toasts: a role change ("Your role is now ..."), a full resync after a reconnect,
// background store failures, notifications for this member: an agent's own words (the coordination MCP tool
// notify_member, never translated) or a notice the host wrote (a message reference, shown in the viewer's language),
// and what a change of a topic tells everyone (a topic was started, its spec draft or plan is ready, it is complete:
// DESIGN §5.12 item 17), with "Open".
import { useEffect, useRef } from 'react';
import type { ColumnTarget, MemberNotification } from '@smurg/protocol';
import { renderWireText } from '../../lib/errors.ts';
import { formatActor, formatRole } from '../../lib/format.ts';
import { useStore } from '../../lib/store.ts';
import { selectTopic, type TopicNotice } from '../../lib/stores/topics.ts';
import { selectUserId } from '../../lib/stores/workspace.ts';
import { useCommand, useStores } from '../../lib/workspace/context.tsx';
import { tConn } from '../../strings/connection.ts';
import { tStores } from '../../strings/stores.ts';
import { tWorkbench } from '../../strings/workbench.ts';
import { useToast } from '../../ui/index.ts';

export function useWorkspaceNotices(): void {
  const stores = useStores();
  const toast = useToast();
  const roleChange = useStore(stores.workspace, (state) => state.roleChange);
  const generation = useStore(stores.workspace, (state) => state.generation);
  const errors = useStore(stores.errors);
  const notifications = useStore(stores.activity, (state) => state.notifications);
  const topicNotices = useStore(stores.topics, (state) => state.notices);
  const openColumn = useCommand('openColumn');

  const seenRoleChange = useRef(roleChange);
  useEffect(() => {
    if (roleChange === null || roleChange === seenRoleChange.current) return;
    seenRoleChange.current = roleChange;
    toast.show({ tone: 'info', title: tConn('toast.roleChanged', { role: formatRole(roleChange.to) }) });
  }, [roleChange, toast]);

  const seenGeneration = useRef(generation);
  useEffect(() => {
    // generation 1 is the first admission; later ones are reconnects that could not resume.
    if (generation > 1 && generation !== seenGeneration.current) toast.show({ tone: 'info', title: tConn('toast.resynced') });
    seenGeneration.current = generation;
  }, [generation, toast]);

  const seenError = useRef(errors.at(-1)?.id ?? 0);
  useEffect(() => {
    for (const error of errors) {
      if (error.id <= seenError.current) continue;
      seenError.current = error.id;
      toast.show({ tone: 'danger', title: tWorkbench('error.area', { area: tStores(`area.${error.area}`), message: error.message }) });
    }
  }, [errors, toast]);

  const seenNotification = useRef(new Set(notifications.map((n) => n.id)));
  useEffect(() => {
    for (const notification of notifications) {
      if (seenNotification.current.has(notification.id)) continue;
      seenNotification.current.add(notification.id);
      toast.show({ tone: 'info', title: tWorkbench('notify.title', { name: formatActor(notification.from) }), description: notificationText(notification), duration: 0 });
    }
  }, [notifications, toast]);

  const seenTopicNotice = useRef(topicNotices.at(-1)?.id ?? 0);
  useEffect(() => {
    for (const notice of topicNotices) {
      if (notice.id <= seenTopicNotice.current) continue;
      seenTopicNotice.current = notice.id;
      const topic = selectTopic(stores.topics.getState(), notice.topicId);
      // The member who started a topic is looking at it already.
      if (notice.kind === 'started' && topic?.createdBy.userId === selectUserId(stores.workspace.getState())) continue;
      const target = topicNoticeTarget(notice, topic?.discussionSessionId);
      toast.show({
        tone: notice.kind === 'complete' ? 'success' : 'info',
        title: tWorkbench(`notice.${notice.kind}`, { name: notice.name }),
        action: { label: tWorkbench('notice.open'), onClick: () => void openColumn({ target, from: 'inbox' }).catch(() => {}) },
      });
    }
  }, [topicNotices, toast, stores, openColumn]);
}

/** What "Open" on a topic's notice shows: its discussion for a new topic, its spec for a draft, else its plan. */
export function topicNoticeTarget(notice: Pick<TopicNotice, 'kind' | 'topicId'>, discussionSessionId: string | undefined): ColumnTarget {
  if (notice.kind === 'started') return discussionSessionId === undefined ? { kind: 'spec', topicId: notice.topicId } : { kind: 'session', sessionId: discussionSessionId };
  if (notice.kind === 'spec-ready') return { kind: 'spec', topicId: notice.topicId };
  return { kind: 'plan', topicId: notice.topicId };
}

/** An agent's own words as they are; a notice the host wrote in the viewer's language (English as the fallback). */
export function notificationText(notification: MemberNotification): string {
  if (notification.text !== undefined) return notification.text;
  return renderWireText(notification.msg, notification.fallback ?? '');
}
