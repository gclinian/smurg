// The tree of ui/Tree: one tab stop, the keys of the WAI-ARIA tree pattern, activation and the context menu.
import { act, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { Tree, type TreeNode, type TreeProps } from './Tree.tsx';

const NODES: TreeNode[] = [
  {
    id: 'checkout',
    label: 'Checkout redesign, Executing',
    content: <span>Checkout redesign</span>,
    children: [
      { id: 'discussion', label: 'Discussion, Idle', content: <span>Discussion</span> },
      { id: 'spec', label: 'Spec', content: <span>Spec</span>, data: { 'data-unread': '' } },
      { id: 'cart', label: '1 · Cart API, Waiting for an answer', content: <span>1 · Cart API</span>, selected: true },
    ],
  },
  { id: 'search', label: 'Search filters, Spec', content: <span>Search filters</span>, children: [{ id: 'search-discussion', label: 'Discussion', content: <span>Discussion</span> }] },
  { id: 'free', label: 'No topic', content: <span>No topic</span>, children: [] },
];

function Harness({ initial = ['checkout'], nodes = NODES, ...rest }: Partial<TreeProps> & { initial?: string[] }) {
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set(initial));
  return (
    <Tree
      label="Sessions by topic"
      nodes={nodes}
      expanded={expanded}
      onToggle={(id, open) =>
        setExpanded((previous) => {
          const next = new Set(previous);
          if (open) next.add(id);
          else next.delete(id);
          return next;
        })
      }
      onActivate={() => {}}
      {...rest}
    />
  );
}

const item = (name: string | RegExp): HTMLElement => screen.getByRole('treeitem', { name });
const focused = (): string | null => document.activeElement?.getAttribute('data-tree-id') ?? null;

describe('Tree', () => {
  it('is a tree of treeitems with levels, groups and the expanded state; a row holds no control', () => {
    render(<Harness />);
    const tree = screen.getByRole('tree', { name: 'Sessions by topic' });
    expect(item('Checkout redesign, Executing').getAttribute('aria-expanded')).toBe('true');
    expect(item('Checkout redesign, Executing').getAttribute('aria-level')).toBe('1');
    expect(item('Search filters, Spec').getAttribute('aria-expanded')).toBe('false');
    expect(item('Discussion, Idle').getAttribute('aria-level')).toBe('2');
    // A leaf has no expanded state; the selected row says so.
    expect(item('Spec').hasAttribute('aria-expanded')).toBe(false);
    expect(item(/Cart API/).getAttribute('aria-selected')).toBe('true');
    expect(item('Spec').getAttribute('aria-selected')).toBe('false');
    expect(item(/Cart API/).closest('[role="group"]')).toBeTruthy();
    expect(tree.querySelectorAll('button, a, input')).toHaveLength(0);
    // The rows of a collapsed group are not there.
    expect(screen.getAllByRole('treeitem')).toHaveLength(6);
    // A row's own state attributes reach its row.
    expect(item('Spec').querySelector('.ui-tree__row')?.hasAttribute('data-unread')).toBe(true);
  });

  it('has one tab stop: the selected row, then the row last used', async () => {
    render(<Harness />);
    const stops = (): string[] => screen.getAllByRole('treeitem').filter((element) => element.getAttribute('tabindex') === '0').map((element) => element.getAttribute('data-tree-id') as string);
    expect(stops()).toEqual(['cart']);
    await userEvent.tab();
    expect(focused()).toBe('cart');
    await userEvent.keyboard('{ArrowUp}');
    expect(focused()).toBe('spec');
    expect(stops()).toEqual(['spec']);
    await userEvent.tab();
    expect(focused()).toBeNull();
  });

  it('without a selected row the first row is the tab stop', () => {
    render(<Harness nodes={NODES.slice(1)} initial={[]} />);
    expect(item('Search filters, Spec').getAttribute('tabindex')).toBe('0');
    expect(item('No topic').getAttribute('tabindex')).toBe('-1');
  });

  it('Up, Down, Home and End move through the visible rows', async () => {
    render(<Harness />);
    item('Checkout redesign, Executing').focus();
    await userEvent.keyboard('{ArrowDown}');
    expect(focused()).toBe('discussion');
    await userEvent.keyboard('{ArrowDown}{ArrowDown}{ArrowDown}');
    // Past the last child: the next group (its children are folded away).
    expect(focused()).toBe('search');
    await userEvent.keyboard('{ArrowDown}');
    expect(focused()).toBe('free');
    await userEvent.keyboard('{ArrowDown}');
    expect(focused()).toBe('free');
    await userEvent.keyboard('{Home}');
    expect(focused()).toBe('checkout');
    await userEvent.keyboard('{ArrowUp}');
    expect(focused()).toBe('checkout');
    await userEvent.keyboard('{End}');
    expect(focused()).toBe('free');
  });

  it('Right expands a group, then enters it; Left goes to the parent, then collapses it', async () => {
    render(<Harness />);
    item('Search filters, Spec').focus();
    await userEvent.keyboard('{ArrowRight}');
    expect(item('Search filters, Spec').getAttribute('aria-expanded')).toBe('true');
    expect(focused()).toBe('search');
    await userEvent.keyboard('{ArrowRight}');
    expect(focused()).toBe('search-discussion');
    // Right on a leaf does nothing.
    await userEvent.keyboard('{ArrowRight}');
    expect(focused()).toBe('search-discussion');
    await userEvent.keyboard('{ArrowLeft}');
    expect(focused()).toBe('search');
    await userEvent.keyboard('{ArrowLeft}');
    expect(item('Search filters, Spec').getAttribute('aria-expanded')).toBe('false');
    // Left on a collapsed top-level group does nothing.
    await userEvent.keyboard('{ArrowLeft}');
    expect(focused()).toBe('search');
    // An expanded group without rows: Right stays.
    item('No topic').focus();
    await userEvent.keyboard('{ArrowRight}{ArrowRight}');
    expect(focused()).toBe('free');
  });

  it('Enter and a click activate a leaf; with Shift they ask for "to the side"; Space activates too', async () => {
    const onActivate = vi.fn();
    render(<Harness onActivate={onActivate} />);
    item('Spec').focus();
    await userEvent.keyboard('{Enter}');
    expect(onActivate).toHaveBeenLastCalledWith('spec', { side: false });
    await userEvent.keyboard('{Shift>}{Enter}{/Shift}');
    expect(onActivate).toHaveBeenLastCalledWith('spec', { side: true });
    await userEvent.keyboard(' ');
    expect(onActivate).toHaveBeenLastCalledWith('spec', { side: false });
    await userEvent.click(screen.getByText('1 · Cart API'));
    expect(onActivate).toHaveBeenLastCalledWith('cart', { side: false });
    expect(item(/Cart API/).getAttribute('tabindex')).toBe('0');
    fireEvent.click(screen.getByText('Discussion'), { shiftKey: true });
    expect(onActivate).toHaveBeenLastCalledWith('discussion', { side: true });
    expect(onActivate).toHaveBeenCalledTimes(5);
  });

  it('Enter and a click on a group fold and unfold it, and activate nothing', async () => {
    const onActivate = vi.fn();
    render(<Harness onActivate={onActivate} />);
    await userEvent.click(screen.getByText('Checkout redesign'));
    expect(item('Checkout redesign, Executing').getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByRole('treeitem', { name: 'Spec' })).toBeNull();
    item('Checkout redesign, Executing').focus();
    await userEvent.keyboard('{Enter}');
    expect(item('Checkout redesign, Executing').getAttribute('aria-expanded')).toBe('true');
    expect(onActivate).not.toHaveBeenCalled();
  });

  // DESIGN 0.8.0 D7.4: a sticky note that links to others is a group, and opening it is what a person wants.
  it('with activatesGroups, Enter, Space and a click open a group and unfold it; its twisty only folds and unfolds it', async () => {
    const onActivate = vi.fn();
    const withTwisty: TreeNode[] = NODES.map((node) =>
      node.children === undefined
        ? node
        : {
            ...node,
            content: (
              <>
                <span data-tree-twisty aria-hidden="true">
                  ▸
                </span>
                <span>{node.id}</span>
              </>
            ),
          },
    );
    render(<Harness nodes={withTwisty} initial={[]} activatesGroups onActivate={onActivate} />);
    const group = item('Checkout redesign, Executing');
    expect(group.getAttribute('aria-expanded')).toBe('false');
    // A click on the row opens the group's thing and unfolds it; a second click opens it again and folds nothing.
    await userEvent.click(screen.getByText('checkout'));
    expect(onActivate).toHaveBeenLastCalledWith('checkout', { side: false });
    expect(group.getAttribute('aria-expanded')).toBe('true');
    await userEvent.click(screen.getByText('checkout'));
    expect(onActivate).toHaveBeenCalledTimes(2);
    expect(group.getAttribute('aria-expanded')).toBe('true');
    // The twisty folds and unfolds, and opens nothing.
    const twisty = group.querySelector('[data-tree-twisty]') as HTMLElement;
    await userEvent.click(twisty);
    expect(group.getAttribute('aria-expanded')).toBe('false');
    await userEvent.click(twisty);
    expect(group.getAttribute('aria-expanded')).toBe('true');
    expect(onActivate).toHaveBeenCalledTimes(2);
    // Enter and Space open a folded group and unfold it; Left and Right still fold it, and open nothing.
    const search = item('Search filters, Spec');
    search.focus();
    await userEvent.keyboard('{Enter}');
    expect(onActivate).toHaveBeenLastCalledWith('search', { side: false });
    expect(search.getAttribute('aria-expanded')).toBe('true');
    await userEvent.keyboard('{ArrowLeft}');
    expect(search.getAttribute('aria-expanded')).toBe('false');
    await userEvent.keyboard(' ');
    expect(onActivate).toHaveBeenCalledTimes(4);
    expect(search.getAttribute('aria-expanded')).toBe('true');
    await userEvent.keyboard('{ArrowLeft}{ArrowRight}');
    expect(search.getAttribute('aria-expanded')).toBe('true');
    expect(onActivate).toHaveBeenCalledTimes(4);
    // A leaf is opened as before.
    await userEvent.click(screen.getByText('Spec'));
    expect(onActivate).toHaveBeenLastCalledWith('spec', { side: false });
  });

  it('a key belongs to the row that has the focus, not to the group around it', async () => {
    const onToggle = vi.fn();
    render(<Tree label="t" nodes={NODES} expanded={new Set(['checkout'])} onToggle={onToggle} onActivate={() => {}} />);
    item('Spec').focus();
    await userEvent.keyboard('{ArrowRight}');
    expect(onToggle).not.toHaveBeenCalled();
  });

  it('the context menu is asked for by a right click, Shift+F10 and the menu key, where the row is', async () => {
    const onMenu = vi.fn();
    render(<Harness onMenu={onMenu} />);
    fireEvent.contextMenu(screen.getByText('Spec'), { clientX: 40, clientY: 120 });
    expect(onMenu).toHaveBeenLastCalledWith('spec', { x: 40, y: 120 });
    item(/Cart API/).focus();
    await userEvent.keyboard('{Shift>}{F10}{/Shift}');
    expect(onMenu).toHaveBeenLastCalledWith('cart', expect.objectContaining({ x: expect.any(Number), y: expect.any(Number) }));
    fireEvent.keyDown(item(/Cart API/), { key: 'ContextMenu' });
    expect(onMenu).toHaveBeenCalledTimes(3);
    // F10 alone is the browser's.
    fireEvent.keyDown(item(/Cart API/), { key: 'F10' });
    expect(onMenu).toHaveBeenCalledTimes(3);
  });

  it('when the row with the tab stop goes away the tab stop moves on', () => {
    const view = render(<Tree label="t" nodes={NODES} expanded={new Set(['checkout'])} onToggle={() => {}} onActivate={() => {}} />);
    act(() => item('Spec').focus());
    expect(item('Spec').getAttribute('tabindex')).toBe('0');
    const without: TreeNode[] = [{ ...(NODES[0] as TreeNode), children: (NODES[0] as TreeNode).children?.filter((node) => node.id !== 'spec') ?? [] }, ...NODES.slice(1)];
    view.rerender(<Tree label="t" nodes={without} expanded={new Set(['checkout'])} onToggle={() => {}} onActivate={() => {}} />);
    // The selected row takes over.
    expect(item(/Cart API/).getAttribute('tabindex')).toBe('0');
  });
});
