import { useEffect, useRef, useState, type KeyboardEvent, type MouseEvent, type ReactNode, type Ref } from 'react';
import { cx } from './cx.ts';

export interface TreeNode {
  readonly id: string;
  /** The row's accessible name (the visible text and what the glyphs say). */
  readonly label: string;
  /** The row as it is drawn. No buttons, links or inputs inside: a tree item has no nested controls. */
  readonly content: ReactNode;
  /** A group: its rows (may be empty). Present: the row expands and collapses; absent: the row is a leaf. */
  readonly children?: readonly TreeNode[];
  /** The thing this row stands for is what the person is looking at (the focused column). */
  readonly selected?: boolean;
  readonly className?: string;
  /** `data-*` attributes of the row (states the style sheet draws: open in a column, unread). */
  readonly data?: Readonly<Record<`data-${string}`, string | boolean | undefined>>;
}

export interface TreeActivation {
  /** Shift was held: "open to the side". */
  readonly side: boolean;
}

export interface TreeProps {
  /** Accessible name of the tree; or the id of the element that names it. */
  label?: string;
  labelledBy?: string;
  nodes: readonly TreeNode[];
  /** The ids of the expanded groups. */
  expanded: ReadonlySet<string>;
  onToggle(id: string, expanded: boolean): void;
  /** Enter, Space or a click on a leaf. (On a group they expand or collapse it.) */
  onActivate(id: string, how: TreeActivation): void;
  /** Shift+F10, the menu key or a right click on a row: where its context menu opens. */
  onMenu?(id: string, at: { readonly x: number; readonly y: number }): void;
  className?: string;
  ref?: Ref<HTMLDivElement>;
}

interface Flat {
  readonly node: TreeNode;
  readonly level: number;
  readonly parentId: string | null;
}

function flatten(nodes: readonly TreeNode[], expanded: ReadonlySet<string>, level = 1, parentId: string | null = null, out: Flat[] = []): Flat[] {
  for (const node of nodes) {
    out.push({ node, level, parentId });
    if (node.children !== undefined && expanded.has(node.id)) flatten(node.children, expanded, level + 1, node.id, out);
  }
  return out;
}

/**
 * A WAI-ARIA tree with one tab stop: Up / Down move through the visible rows, Right expands a group or enters it,
 * Left collapses it or goes to the parent, Home / End jump, Enter (and Space) activate a leaf or toggle a group,
 * Shift+Enter activates "to the side", Shift+F10 and the menu key ask for the row's context menu.
 */
export function Tree({ label, labelledBy, nodes, expanded, onToggle, onActivate, onMenu, className, ref }: TreeProps) {
  const rows = flatten(nodes, expanded);
  const [activeId, setActiveId] = useState<string | null>(null);
  const items = useRef(new Map<string, HTMLDivElement>());
  /** Focus the active row after the next render (a row that just appeared, or the parent of one that went). */
  const focusAfterRender = useRef(false);

  // One tab stop: the row last used, else the selected row, else the first row. A row that is gone hands over.
  const present = activeId !== null && rows.some((row) => row.node.id === activeId);
  const tabStop = present ? activeId : (rows.find((row) => row.node.selected)?.node.id ?? rows[0]?.node.id ?? null);

  useEffect(() => {
    if (!focusAfterRender.current) return;
    focusAfterRender.current = false;
    if (tabStop !== null) items.current.get(tabStop)?.focus();
  });

  const go = (id: string | undefined): void => {
    if (id === undefined) return;
    setActiveId(id);
    const element = items.current.get(id);
    if (element) element.focus();
    else focusAfterRender.current = true;
  };

  const activate = (row: Flat, side: boolean): void => {
    setActiveId(row.node.id);
    if (row.node.children !== undefined) onToggle(row.node.id, !expanded.has(row.node.id));
    else onActivate(row.node.id, { side });
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>, row: Flat, index: number): void => {
    // Rows nest: a key belongs to the row that has the focus, not to the groups around it.
    if (event.target !== event.currentTarget || event.altKey || event.ctrlKey || event.metaKey) return;
    const isGroup = row.node.children !== undefined;
    const open = isGroup && expanded.has(row.node.id);
    switch (event.key) {
      case 'ArrowDown':
        go(rows[index + 1]?.node.id);
        break;
      case 'ArrowUp':
        go(rows[index - 1]?.node.id);
        break;
      case 'Home':
        go(rows[0]?.node.id);
        break;
      case 'End':
        go(rows[rows.length - 1]?.node.id);
        break;
      case 'ArrowRight':
        if (!isGroup) return;
        if (!open) onToggle(row.node.id, true);
        else go(rows[index + 1]?.level === row.level + 1 ? rows[index + 1]?.node.id : undefined);
        break;
      case 'ArrowLeft':
        if (open) onToggle(row.node.id, false);
        else if (row.parentId !== null) go(row.parentId);
        else return;
        break;
      case 'Enter':
      case ' ':
        activate(row, event.shiftKey && event.key === 'Enter');
        break;
      case 'ContextMenu':
      case 'F10': {
        if (event.key === 'F10' && !event.shiftKey) return;
        if (!onMenu) return;
        const box = event.currentTarget.querySelector(':scope > .ui-tree__row')?.getBoundingClientRect();
        onMenu(row.node.id, { x: (box?.left ?? 0) + 24, y: box?.bottom ?? 0 });
        break;
      }
      default:
        return;
    }
    event.preventDefault();
  };

  const onRowClick = (event: MouseEvent<HTMLDivElement>, row: Flat): void => {
    if (event.button !== 0) return;
    activate(row, event.shiftKey);
  };

  const render = (list: readonly TreeNode[], level: number, parentId: string | null): ReactNode =>
    list.map((node) => {
      const index = rows.findIndex((row) => row.node.id === node.id);
      const row: Flat = { node, level, parentId };
      const isGroup = node.children !== undefined;
      const open = isGroup && expanded.has(node.id);
      return (
        <div
          key={node.id}
          ref={(element) => {
            if (element) items.current.set(node.id, element);
            else items.current.delete(node.id);
          }}
          role="treeitem"
          aria-label={node.label}
          aria-level={level}
          aria-expanded={isGroup ? open : undefined}
          aria-selected={node.selected === true}
          tabIndex={node.id === tabStop ? 0 : -1}
          className={cx('ui-tree__item', node.className)}
          data-tree-id={node.id}
          onKeyDown={(event) => onKeyDown(event, row, index)}
          onFocus={(event) => {
            if (event.target === event.currentTarget) setActiveId(node.id);
          }}
        >
          <div
            className="ui-tree__row"
            {...node.data}
            onClick={(event) => onRowClick(event, row)}
            onContextMenu={(event) => {
              if (!onMenu) return;
              event.preventDefault();
              setActiveId(node.id);
              onMenu(node.id, { x: event.clientX, y: event.clientY });
            }}
          >
            {node.content}
          </div>
          {isGroup && open ? (
            <div role="group" className="ui-tree__group">
              {render(node.children ?? [], level + 1, node.id)}
            </div>
          ) : null}
        </div>
      );
    });

  return (
    <div ref={ref} role="tree" aria-label={label} aria-labelledby={labelledBy} className={cx('ui-tree', className)}>
      {render(nodes, 1, null)}
    </div>
  );
}
