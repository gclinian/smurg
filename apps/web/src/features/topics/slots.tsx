// What the topics feature contributes to the workspace shell (lib/slots.ts; P7/FOR-FEATURES.md):
//
//   columns.spec / plan / report / changes   the bodies of the topic columns, each loaded when first shown (the spec and
//                                            plan columns bring the editor, so Monaco never loads with the page);
//   overlays                                 the feature's dialogs and the handler of the command `newTopic`;
//   menus.topic                              "Rename", "Restart discussion", "Archive topic" / "Restore topic",
//                                            "Delete topic" in a topic's "More actions";
//   inboxRows.attention                      "Start again" on the row of an item that did not start (the shell's row
//                                            only opens the plan).
//
// Keep this file light: it loads with the workspace page. Everything it names is behind a dynamic import, except
// dialogs.ts (a few lines of state) and the strings.
import { lazy } from 'react';
import type { MenuItem } from '../../ui/Menu.tsx';
import { defineSlots } from '../../lib/slots.ts';
import { topicDialogs } from './dialogs.ts';
import { t } from './strings.ts';

export const slots = defineSlots({
  feature: 'topics',
  columns: {
    spec: lazy(() => import('./SpecColumn.tsx')),
    plan: lazy(() => import('./PlanColumn.tsx')),
    report: lazy(() => import('./ReportColumn.tsx')),
    changes: lazy(() => import('./ChangesColumn.tsx')),
  },
  overlays: [lazy(() => import('./TopicOverlays.tsx'))],
  menus: {
    topic(topic, env) {
      const dialogs = topicDialogs(env.stores);
      const { can } = env.capabilities;
      const items: MenuItem[] = [];
      if (!topic.archived) {
        if (can('session.drive')) items.push({ id: 'topic-rename', label: t('menu.rename'), onSelect: () => dialogs.open({ kind: 'rename', topicId: topic.id }) });
        if (can('session.create')) {
          items.push({ id: 'topic-restart', label: t('discussion.restart'), onSelect: () => dialogs.open({ kind: 'restart', topicId: topic.id }) });
          items.push({ id: 'topic-archive', label: t('archive.action'), onSelect: () => dialogs.open({ kind: 'archive', topicId: topic.id }) });
        }
        return items;
      }
      if (can('session.create')) {
        // Restoring asks nothing: the overlay sends it and says how it went.
        items.push({ id: 'topic-restore', label: t('menu.restore'), onSelect: () => dialogs.open({ kind: 'restore', topicId: topic.id }) });
      }
      if (can('admin')) items.push({ id: 'topic-delete', label: t('delete.action'), danger: true, onSelect: () => dialogs.open({ kind: 'delete', topicId: topic.id }) });
      return items;
    },
  },
  inboxRows: {
    // An item that was armed and then did not start (the plan changed, the starter left, the start failed): the Start
    // dialog shows what changed and starts it again.
    attention(item, base, env) {
      const { topicId, itemId } = item;
      if (item.subject !== 'item-not-started' || topicId === undefined || itemId === undefined || !env.capabilities.can('session.create')) return base;
      return { ...base, action: { id: 'start-again', label: t('item.startAgain'), run: () => topicDialogs(env.stores).open({ kind: 'start', topicId, itemIds: [itemId] }) } };
    },
  },
});
