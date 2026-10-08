// How a feature plugs into the workspace shell without the shell importing the feature (and without two features
// importing each other). A feature folder that contributes something has ONE small file, by convention
//
//   src/features/<feature>/slots.tsx
//
// which exports `slots = defineSlots({ … })`. The shell finds every such file by itself (app/workspace/
// feature-slots.ts, import.meta.glob), so adding a column kind never means editing a shared file. Keep slots.tsx
// light: it is loaded with the workspace page. Components go in with lazyChunk (lib/chunks.ts: React.lazy behind the
// one helper that says why a chunk did not come), so Monaco, xterm and the conversation code load when a column of
// that kind is first shown.
//
//   // src/features/conversation/slots.tsx
//   import { lazyChunk } from '../../lib/chunks.ts';
//   import { defineSlots } from '../../lib/slots.ts';
//   export const slots = defineSlots({
//     feature: 'conversation',
//     columns: { conversation: lazyChunk(() => import('./ConversationColumn.tsx')) },  // default export: the component
//     overlays: [lazyChunk(() => import('./SessionDialogs.tsx'))],                     // mounted once, in both modes
//     menus: { session: (session, env) => [{ id: 'rename', label: t('row.rename'), onSelect: () => … }] },
//     inboxRows: { question: (item, base, env) => ({ ...base, where: `${base.where} · …` }) },
//   });
//
// What each slot is:
//   columns     the body of a column of that kind (lib/columns/target.ts: ColumnKind → its props). The frame, the
//               header and the title are the shell's; the body reads useColumn() (lib/columns/context.tsx).
//   overlays    components mounted once in the workspace shell, in the sessions view AND in code mode, for as long as
//               the workspace is open: dialogs, toasts, command handlers (useCommandHandler). They render nothing
//               until something opens them.
//   menus       extra items of a row's context menu in the session list: a session row, a topic's "More actions".
//               The shell's own items (Open, Open to the side) come first.
//   inboxRows   changes the row the shell composes for an inbox item of that kind (features/sidebar/inbox-rows.ts
//               composes every kind; a feature overrides only what it knows better, e.g. a livelier second line).
import type { ComponentType } from 'react';
import { INBOX_KINDS, type InboxItem, type InboxKind, type Member, type SessionInfo, type Topic } from '@smurg/protocol';
import type { MenuItem } from '../ui/Menu.tsx';
import type { Capabilities } from './capabilities.ts';
import { COLUMN_KINDS, type ColumnBodyProps, type ColumnKind } from './columns/target.ts';
import type { CommandBus } from './commands.ts';
import type { WorkspaceStores } from './stores/index.ts';

/** What a slot function may use: the workspace's stores and command bus, and who is looking. */
export interface SlotEnv {
  readonly stores: WorkspaceStores;
  readonly commands: CommandBus;
  readonly capabilities: Capabilities;
  /** The viewer's own member record; null before the first admission. */
  readonly member: Member | null;
}

export type ColumnComponents = { readonly [K in ColumnKind]: ComponentType<ColumnBodyProps[K]> };

/** The one extra thing a row may offer beside opening it ("Continue", "Try again", "Continue all"). */
export interface InboxRowAction {
  readonly id: string;
  readonly label: string;
  /** A rejection is shown as a toast by the row; the action never opens the item. */
  run(): void | Promise<void>;
}

/** An inbox row as it is shown: two lines and at most one action. */
export interface InboxRowView {
  /** The first line: the question, the command, "Amy: 3 suggestions", "Result report: 3 · Receipt email". */
  readonly title: string;
  /** The first line is a command, a path or an address: monospace. */
  readonly mono?: boolean;
  /** The second line: topic › session, and a fact ("3 of 4 voted", "you or Mei"). */
  readonly where: string;
  readonly action?: InboxRowAction;
}

export type InboxRowRenderer = (item: InboxItem, base: InboxRowView, env: SlotEnv) => InboxRowView;

export interface SlotMenus {
  /** A session row of the list (an agent session or a terminal). */
  session?(session: SessionInfo, env: SlotEnv): readonly MenuItem[];
  /** A topic's "More actions". */
  topic?(topic: Topic, env: SlotEnv): readonly MenuItem[];
}

export interface FeatureSlots {
  /** The feature's folder name (`conversation`): names the feature in a conflict. */
  readonly feature: string;
  readonly columns?: Partial<ColumnComponents>;
  readonly overlays?: readonly ComponentType[];
  readonly menus?: SlotMenus;
  readonly inboxRows?: Partial<Record<InboxKind, InboxRowRenderer>>;
}

/** Identity, typed: `export const slots = defineSlots({ … })`. */
export function defineSlots(slots: FeatureSlots): FeatureSlots {
  return slots;
}

export class SlotConflictError extends Error {
  override readonly name = 'SlotConflictError';
}

export interface SlotRegistry {
  /** The features that contributed, in registration order. */
  readonly features: readonly string[];
  /** The component of a column kind; null when no feature registered one (the frame shows a placeholder). */
  column<K extends ColumnKind>(kind: K): ComponentType<ColumnBodyProps[K]> | null;
  readonly overlays: readonly { readonly feature: string; readonly index: number; readonly Component: ComponentType }[];
  /** The context-menu items every feature adds for a session row, in registration order. */
  sessionMenu(session: SessionInfo, env: SlotEnv): MenuItem[];
  topicMenu(topic: Topic, env: SlotEnv): MenuItem[];
  /** Applies the feature's renderer of the item's kind to the shell's row, when one is registered. */
  inboxRow(item: InboxItem, base: InboxRowView, env: SlotEnv): InboxRowView;
}

/**
 * One registry from every feature's slots. A column kind and an inbox kind belong to ONE feature: a second claim is
 * a programming error and throws. Menus and overlays add up.
 */
export function createSlotRegistry(features: readonly FeatureSlots[]): SlotRegistry {
  const columns = new Map<ColumnKind, { feature: string; Component: ComponentType<never> }>();
  const inboxRows = new Map<InboxKind, { feature: string; render: InboxRowRenderer }>();
  const overlays: { feature: string; index: number; Component: ComponentType }[] = [];
  const names: string[] = [];

  for (const slots of features) {
    if (names.includes(slots.feature)) throw new SlotConflictError(`feature registered twice: ${slots.feature}`);
    names.push(slots.feature);
    for (const kind of COLUMN_KINDS) {
      const Component = slots.columns?.[kind];
      if (Component === undefined) continue;
      const taken = columns.get(kind);
      if (taken) throw new SlotConflictError(`column kind "${kind}" is registered by ${taken.feature} and by ${slots.feature}`);
      columns.set(kind, { feature: slots.feature, Component: Component as ComponentType<never> });
    }
    for (const kind of INBOX_KINDS) {
      const render = slots.inboxRows?.[kind];
      if (render === undefined) continue;
      const taken = inboxRows.get(kind);
      if (taken) throw new SlotConflictError(`inbox rows of kind "${kind}" are rendered by ${taken.feature} and by ${slots.feature}`);
      inboxRows.set(kind, { feature: slots.feature, render });
    }
    (slots.overlays ?? []).forEach((Component, index) => overlays.push({ feature: slots.feature, index, Component }));
  }

  return {
    features: Object.freeze([...names]),
    column<K extends ColumnKind>(kind: K) {
      return (columns.get(kind)?.Component ?? null) as ComponentType<ColumnBodyProps[K]> | null;
    },
    overlays: Object.freeze(overlays),
    sessionMenu(session, env) {
      return features.flatMap((slots) => [...(slots.menus?.session?.(session, env) ?? [])]);
    },
    topicMenu(topic, env) {
      return features.flatMap((slots) => [...(slots.menus?.topic?.(topic, env) ?? [])]);
    },
    inboxRow(item, base, env) {
      return inboxRows.get(item.kind)?.render(item, base, env) ?? base;
    },
  };
}

/** A registry nothing registered in (the default of a test; every column shows the frame's placeholder). */
export const EMPTY_SLOT_REGISTRY: SlotRegistry = createSlotRegistry([]);
