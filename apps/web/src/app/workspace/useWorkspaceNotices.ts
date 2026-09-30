// Turns workspace events into toasts: a role change (「你的角色已變更」), a full resync after a reconnect, background
// store failures, and notifications agents send to this member (coordination MCP 「通知某位組員」).
import { useEffect, useRef } from 'react';
import { formatActor, formatRole } from '../../lib/format.ts';
import { useStore } from '../../lib/store.ts';
import { useStores } from '../../lib/workspace/context.tsx';
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
      toast.show({ tone: 'info', title: tWorkbench('notify.title', { name: formatActor(notification.from) }), description: notification.text, duration: 0 });
    }
  }, [notifications, toast]);
}
