// The session list of the left column (UX §3.2, §11): a real tree. Topics are groups with their fixed rows; a row
// opens what it stands for in the focused column (Enter, a click), to the side with Shift; the context menu (right
// click, Shift+F10, the menu key) has the same two and whatever the features add (rename, change responsible, end).
// A tree item holds no buttons: the marks that appear on hover are shortcuts for the mouse, and everything they do is
// in the context menu.
import type { UserRef } from '@smurg/protocol';
import { useEffect, useMemo, useRef, useState, type MouseEvent, type ReactNode } from 'react';
import { describeError } from '../../lib/errors.ts';
import { phaseLabel, phaseTone, statusLabel } from '../../lib/session-status.ts';
import { useStore } from '../../lib/store.ts';
import { MAX_COLUMNS } from '../../lib/stores/columns.ts';
import { selectUserId } from '../../lib/stores/workspace.ts';
import type { ColumnRef } from '../../lib/columns/target.ts';
import { useCommand, useStores } from '../../lib/workspace/context.tsx';
import { useSlotEnv, useSlots } from '../../lib/workspace/slots.tsx';
import { Avatar, Badge, ContextMenu, StatusGlyph, Tree, cx, useToast, type MenuItem, type TreeNode } from '../../ui/index.ts';
import { IconChevronDown, IconFileText, IconMore, IconOpenSide, IconPlan, IconReport, IconTerminal, IconUsers } from '../../ui/icons.tsx';
import { t } from './strings.ts';
import { FREE_GROUP, buildArchivedGroups, buildSessionTree, runningTargets, type TreeGroup, type TreeRow } from './tree-model.ts';

/** The tree item of a node (ids hold characters a selector would need escaped). */
function findItem(root: HTMLElement | null, id: string): HTMLElement | null {
  for (const element of root?.querySelectorAll<HTMLElement>('[data-tree-id]') ?? []) if (element.getAttribute('data-tree-id') === id) return element;
  return null;
}

function rowLabel(row: TreeRow): string {
  const parts = [row.title];
  if (row.meta !== undefined) parts.push(row.meta);
  if (row.glyph !== null) parts.push(statusLabel(row.glyph));
  if (row.responsible !== undefined) parts.push(row.responsible === null ? t('row.everyone') : t('row.responsible', { name: row.responsible.displayName }));
  if (row.report !== undefined) parts.push(row.report.waiting ? t('row.report.review') : t('row.report.reviewed'));
  if (row.unread) parts.push(t('row.unread'));
  if (row.open) parts.push(t('row.open.in'));
  return parts.join(', ');
}

function groupLabel(group: TreeGroup, archived: boolean): string {
  if (archived) return t('group.archived', { name: group.name });
  if (group.topic === undefined) return group.name;
  const phase = phaseLabel(group.topic.phase);
  return !group.open && group.waiting > 0 ? t('group.label.waiting', { name: group.name, phase, count: group.waiting }) : t('group.label', { name: group.name, phase });
}

export interface SessionTreeProps {
  /** The archived topics are listed too (after "Show archived topics"). */
  showArchived: boolean;
}

export function SessionTree({ showArchived }: SessionTreeProps) {
  const stores = useStores();
  const slots = useSlots();
  const env = useSlotEnv();
  const toast = useToast();
  const openColumn = useCommand('openColumn');
  const topics = useStore(stores.topics);
  const sessions = useStore(stores.sessions);
  const columns = useStore(stores.columns);
  const selfUserId = useStore(stores.workspace, selectUserId);
  const colors = useStore(stores.presence, (state) => state.members);
  const tree = useRef<HTMLDivElement>(null);
  const [menu, setMenu] = useState<{ id: string; at: { x: number; y: number } } | null>(null);

  const input = useMemo(() => ({ topics, sessions, columns, selfUserId }), [topics, sessions, columns, selfUserId]);
  const groups = useMemo(() => buildSessionTree(input), [input]);
  const archived = useMemo(() => (showArchived ? buildArchivedGroups(input) : []), [input, showArchived]);
  const archivedIds = useMemo(() => new Set(archived.map((group) => group.id)), [archived]);
  const everyGroup = useMemo(() => [...groups, ...archived], [groups, archived]);

  // An unfolded topic shows one row per work item: that needs its plan. An unfolded archived topic shows its
  // sessions, which the list does not hold: they are looked up once.
  const wantedPlans = groups.filter((group) => group.open && group.topic?.plan.exists === true).map((group) => (group.topic as NonNullable<TreeGroup['topic']>).id);
  const wantedKey = wantedPlans.join('\n');
  useEffect(() => {
    for (const topicId of wantedKey === '' ? [] : wantedKey.split('\n')) stores.topics.ensurePlan(topicId);
  }, [wantedKey, stores.topics]);
  const lookedUp = useRef(new Set<string>());
  const unfoldedArchived = archived.filter((group) => group.open && group.topic !== undefined).map((group) => (group.topic as NonNullable<TreeGroup['topic']>).id).join('\n');
  useEffect(() => {
    for (const topicId of unfoldedArchived === '' ? [] : unfoldedArchived.split('\n')) {
      if (lookedUp.current.has(topicId)) continue;
      lookedUp.current.add(topicId);
      stores.sessions.ofTopic(topicId).catch((error: unknown) => {
        lookedUp.current.delete(topicId);
        toast.show({ tone: 'warning', title: t('archived.failed', { reason: describeError(error) }) });
      });
    }
  }, [unfoldedArchived, stores.sessions, toast]);

  const rowsById = useMemo(() => {
    const map = new Map<string, TreeRow>();
    for (const group of everyGroup) for (const row of group.rows) map.set(row.id, row);
    return map;
  }, [everyGroup]);
  const groupsById = useMemo(() => new Map(everyGroup.map((group) => [group.id, group])), [everyGroup]);

  const open = (target: ColumnRef, side: boolean): void => {
    openColumn({ target, from: 'row', ...(side ? { side: true } : {}) }).catch((error: unknown) => toast.show({ tone: 'warning', title: describeError(error) }));
  };

  const colorOf = (user: UserRef): string | undefined => colors.find((member) => member.userId === user.userId)?.color;

  /** A mark that a mouse can click without activating the row. Hidden from assistive technology: the menu has it. */
  const mark = (className: string, title: string, icon: ReactNode, onClick: () => void): ReactNode => (
    <span
      className={className}
      title={title}
      aria-hidden="true"
      onClick={(event: MouseEvent<HTMLSpanElement>) => {
        event.stopPropagation();
        onClick();
      }}
    >
      {icon}
    </span>
  );

  const rowContent = (row: TreeRow): ReactNode => (
    <>
      {row.glyph !== null ? (
        <StatusGlyph status={row.glyph} label={statusLabel(row.glyph)} />
      ) : (
        <span className="srow__icon">{row.kind === 'spec' ? <IconFileText size={14} /> : row.kind === 'plan' ? <IconPlan size={14} /> : <IconTerminal size={14} />}</span>
      )}
      <span className="srow__title">{row.title}</span>
      {row.meta !== undefined ? <span className="srow__meta">{row.meta}</span> : null}
      {row.report !== undefined
        ? mark(cx('srow__report', row.report.waiting && 'srow__report--waiting'), t('row.report.open'), <IconReport size={14} />, () => open((row.report as NonNullable<TreeRow['report']>).target, true))
        : null}
      {row.responsible === undefined ? null : row.responsible === null ? (
        <span className="srow__who" title={t('row.everyone')}>
          <IconUsers size={14} />
        </span>
      ) : (
        <span className="srow__who" title={t('row.responsible', { name: row.responsible.displayName })}>
          <Avatar name={row.responsible.displayName} {...(colorOf(row.responsible) === undefined ? {} : { color: colorOf(row.responsible) as string })} size="xs" decorative />
        </span>
      )}
      {mark('srow__side', t('row.openSide.hint'), <IconOpenSide size={14} />, () => open(row.target, true))}
    </>
  );

  const groupContent = (group: TreeGroup, isArchived: boolean): ReactNode => (
    <>
      <IconChevronDown size={12} className="topic__twisty" />
      <span className="topic__name">{group.name}</span>
      {!group.open && group.waiting > 0 ? (
        <span className="topic__wait">
          {group.urgent !== null ? <StatusGlyph status={group.urgent} label={statusLabel(group.urgent)} size={12} /> : null}
          {t('group.waiting', { count: group.waiting })}
        </span>
      ) : null}
      {group.topic !== undefined && !isArchived ? (
        <span className="topic__phase">
          <Badge tone={phaseTone(group.topic.phase)}>{phaseLabel(group.topic.phase)}</Badge>
        </span>
      ) : null}
      {group.topic !== undefined
        ? mark('topic__more', t('group.more'), <IconMore size={14} />, () => {
            const box = findItem(tree.current, group.id)?.querySelector(':scope > .ui-tree__row')?.getBoundingClientRect();
            setMenu({ id: group.id, at: { x: (box?.right ?? 0) - 24, y: box?.bottom ?? 0 } });
          })
        : null}
    </>
  );

  const nodes: TreeNode[] = everyGroup.map((group) => {
    const isArchived = archivedIds.has(group.id);
    return {
      id: group.id,
      label: groupLabel(group, isArchived),
      content: groupContent(group, isArchived),
      className: cx('topic', (isArchived || group.topic?.phase === 'complete' || group.id === FREE_GROUP) && 'topic--muted'),
      data: { 'data-group': group.id },
      children: group.rows.map(
        (row): TreeNode => ({
          id: row.id,
          label: rowLabel(row),
          content: rowContent(row),
          selected: row.current,
          className: cx('srow', row.quiet && 'srow--quiet'),
          data: { 'data-open-in': row.open ? '' : undefined, 'data-unread': row.unread ? '' : undefined, 'data-row-kind': row.kind },
        }),
      ),
    };
  });

  const expanded = useMemo(() => new Set(everyGroup.filter((group) => group.open).map((group) => group.id)), [everyGroup]);

  const menuItems = (id: string): MenuItem[] => {
    const row = rowsById.get(id);
    if (row) {
      return [
        { id: 'open', label: t('row.open'), onSelect: () => open(row.target, false) },
        { id: 'open-side', label: t('row.openSide'), icon: <IconOpenSide size={14} />, onSelect: () => open(row.target, true) },
        ...(row.report ? [{ id: 'open-report', label: t('row.report.open'), icon: <IconReport size={14} />, onSelect: () => open((row.report as NonNullable<TreeRow['report']>).target, true) }] : []),
        ...(row.session ? slots.sessionMenu(row.session, env) : []),
      ];
    }
    const group = groupsById.get(id);
    if (!group?.topic) return [];
    const running = runningTargets(group, MAX_COLUMNS);
    return [
      {
        id: 'watch',
        label: t('group.watch'),
        disabled: running.length === 0,
        onSelect: () => {
          running.forEach((target, index) => open(target, index > 0));
        },
      },
      ...slots.topicMenu(group.topic, env),
    ];
  };

  const menuFor = menu === null ? null : (rowsById.get(menu.id)?.title ?? groupsById.get(menu.id)?.name ?? '');

  return (
    <>
      <Tree
        ref={tree}
        label={t('sessions.tree')}
        nodes={nodes}
        expanded={expanded}
        onToggle={(id, open_) => stores.columns.setGroupOpen(id, open_)}
        onActivate={(id, how) => {
          const row = rowsById.get(id);
          if (row) open(row.target, how.side);
        }}
        onMenu={(id, at) => setMenu({ id, at })}
      />
      <ContextMenu
        at={menu?.at ?? null}
        label={menu === null ? '' : rowsById.has(menu.id) ? t('row.menu', { title: menuFor ?? '' }) : t('group.menu', { name: menuFor ?? '' })}
        items={menu === null ? [] : menuItems(menu.id)}
        onClose={() => {
          const id = menu?.id;
          setMenu(null);
          if (id !== undefined) findItem(tree.current, id)?.focus();
        }}
      />
    </>
  );
}
