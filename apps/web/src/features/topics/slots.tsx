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
// dialogs.ts (a few lines of state) and the strings. The handler of `newTopic` is registered here, at once (the "New"
// control is there from the first moment), and the dialogs behind it (TopicOverlays.tsx) load on their own.
import { Suspense } from 'react';
import { lazyChunk } from '../../lib/chunks.ts';
import type { MenuItem } from '../../ui/Menu.tsx';
import { defineSlots } from '../../lib/slots.ts';
import { useCommandHandler, useStores } from '../../lib/workspace/context.tsx';
import { topicDialogs } from './dialogs.ts';
import { t } from './strings.ts';

const Dialogs = lazyChunk(() => import('./TopicOverlays.tsx'));

/**
 * The feature's overlay. A click on "New" → "New topic" right after the page appeared must not find "nobody handles
 * this" because the dialogs' code is still on its way: the command only says which dialog is open (dialogs.ts), and
 * the dialog shows as soon as its code is there.
 */
function TopicsOverlay() {
  const stores = useStores();
  useCommandHandler('newTopic', () => {
    topicDialogs(stores).open({ kind: 'new' });
  });
  return (
    <Suspense fallback={null}>
      <Dialogs />
    </Suspense>
  );
}

export const slots = defineSlots({
  feature: 'topics',
  columns: {
    spec: lazyChunk(() => import('./SpecColumn.tsx')),
    plan: lazyChunk(() => import('./PlanColumn.tsx')),
    report: lazyChunk(() => import('./ReportColumn.tsx')),
    changes: lazyChunk(() => import('./ChangesColumn.tsx')),
  },
  overlays: [TopicsOverlay],
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
