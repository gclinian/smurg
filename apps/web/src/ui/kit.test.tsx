// The small pieces the sessions view added to the design system: Segmented, Collapsible, Card, StatusGlyph, KindIcon,
// Chip, AvatarStack, ContextMenu, the slot boundary and the focus helpers.
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { AvatarStack, Card, Chip, Collapsible, ContextMenu, GLYPH_STATUSES, ITEM_KINDS, KindIcon, Segmented, SlotBoundary, StatusGlyph, focusSoon, neighbourAfterRemoval } from './index.ts';

describe('Segmented', () => {
  it('radio: a radio group with one tab stop; arrows, Home and End move and choose', async () => {
    function Harness() {
      const [value, setValue] = useState<'all' | 'mine' | 'waiting'>('all');
      return <Segmented<'all' | 'mine' | 'waiting'> label="Show" value={value} onChange={setValue} options={[{ id: 'all', label: 'All' }, { id: 'mine', label: 'Mine' }, { id: 'waiting', label: 'Waiting' }]} />;
    }
    render(<Harness />);
    const group = screen.getByRole('radiogroup', { name: 'Show' });
    const radio = (name: string): HTMLElement => within(group).getByRole('radio', { name });
    expect(radio('All').getAttribute('aria-checked')).toBe('true');
    expect(radio('All').getAttribute('tabindex')).toBe('0');
    expect(radio('Mine').getAttribute('tabindex')).toBe('-1');
    await userEvent.click(radio('Mine'));
    expect(radio('Mine').getAttribute('aria-checked')).toBe('true');
    await userEvent.keyboard('{ArrowRight}');
    expect(radio('Waiting').getAttribute('aria-checked')).toBe('true');
    expect(document.activeElement).toBe(radio('Waiting'));
    await userEvent.keyboard('{ArrowRight}');
    expect(radio('All').getAttribute('aria-checked')).toBe('true');
    await userEvent.keyboard('{End}');
    expect(radio('Waiting').getAttribute('aria-checked')).toBe('true');
    await userEvent.keyboard('{Home}{ArrowLeft}');
    expect(radio('Waiting').getAttribute('aria-checked')).toBe('true');
  });

  it('links: each segment is a link; the current one is marked; a plain click calls onChange, a modified click is the browser\'s', async () => {
    const onChange = vi.fn();
    render(
      <Segmented
        label="Mode"
        variant="links"
        value="sessions"
        onChange={onChange}
        options={[
          { id: 'sessions', label: 'Sessions', href: '/w/x', badge: <span>2</span>, ariaLabel: 'Sessions: 2 waiting, 0 to look at' },
          { id: 'code', label: 'Code mode', href: '/w/x/code', title: 'Code mode: files, editor and terminal' },
        ]}
      />,
    );
    const group = screen.getByRole('group', { name: 'Mode' });
    const sessions = within(group).getByRole('link', { name: 'Sessions: 2 waiting, 0 to look at' });
    const code = within(group).getByRole('link', { name: 'Code mode' });
    expect(sessions.getAttribute('aria-current')).toBe('page');
    expect(code.hasAttribute('aria-current')).toBe(false);
    expect(code.getAttribute('href')).toBe('/w/x/code');
    expect(code.getAttribute('title')).toBe('Code mode: files, editor and terminal');
    await userEvent.click(code);
    expect(onChange).toHaveBeenCalledWith('code');
    // Ctrl / Cmd + click opens a tab: not ours.
    fireEvent.click(code, { ctrlKey: true });
    fireEvent.click(code, { metaKey: true });
    fireEvent.click(code, { button: 1 });
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it('links: with no current page neither segment is marked', () => {
    render(<Segmented label="Mode" variant="links" value={null} onChange={() => {}} options={[{ id: 'a', label: 'Sessions', href: '/a' }, { id: 'b', label: 'Code mode', href: '/b' }]} />);
    expect(screen.getAllByRole('link').filter((link) => link.hasAttribute('aria-current'))).toEqual([]);
  });

  it('radio: with nothing chosen the first segment is the tab stop; a disabled segment is skipped', async () => {
    const onChange = vi.fn();
    render(<Segmented label="View" value={null} onChange={onChange} options={[{ id: 'read', label: 'Read' }, { id: 'edit', label: 'Edit', disabled: true }, { id: 'file', label: 'File' }]} />);
    expect(screen.getByRole('radio', { name: 'Read' }).getAttribute('tabindex')).toBe('0');
    screen.getByRole('radio', { name: 'Read' }).focus();
    await userEvent.keyboard('{ArrowRight}');
    expect(onChange).toHaveBeenLastCalledWith('file');
  });
});

describe('Collapsible', () => {
  it('a section named by its heading with a disclosure button; the body stays mounted while folded', async () => {
    function Harness() {
      const [open, setOpen] = useState(true);
      return (
        <Collapsible title="Inbox" open={open} onToggle={setOpen} meta={<span>2 · 4</span>} actions={<button type="button">New</button>} sectionProps={{ 'data-region': '' }}>
          <p>items</p>
        </Collapsible>
      );
    }
    render(<Harness />);
    const section = screen.getByRole('region', { name: 'Inbox' });
    expect(section.hasAttribute('data-region')).toBe(true);
    expect(within(section).getByRole('heading', { level: 2 })).toBeTruthy();
    const toggle = within(section).getByRole('button', { name: /Inbox/ });
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    const body = document.getElementById(toggle.getAttribute('aria-controls') as string) as HTMLElement;
    expect(body.hidden).toBe(false);
    await userEvent.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(body.hidden).toBe(true);
    expect(body.textContent).toBe('items');
    // The counts and the header's own controls stay while folded.
    expect(toggle.textContent).toContain('2 · 4');
    expect(within(section).getByRole('button', { name: 'New' })).toBeTruthy();
    expect(section.className).toContain('ui-collapsible--collapsed');
  });

  it('level 3 for a section inside a column', () => {
    render(
      <Collapsible title="Earlier" open onToggle={() => {}} level={3}>
        <p>x</p>
      </Collapsible>,
    );
    expect(screen.getByRole('heading', { level: 3 })).toBeTruthy();
  });
});

describe('Card', () => {
  it('a section with an h3 that can take the focus by script, never by Tab', () => {
    let node: HTMLElement | null = null;
    render(
      <Card
        ref={(element) => {
          node = element;
        }}
        id="card-q1"
        title="Question from Claude"
        meta="4 of 4 voted"
        icon={<KindIcon kind="question" label="Question" />}
        tone="warning"
        footer={<button type="button">Submit answer</button>}
      >
        <p>Where should the cart total be computed?</p>
      </Card>,
    );
    const card = screen.getByRole('region', { name: 'Question from Claude' });
    expect(card.tagName).toBe('SECTION');
    expect(card.id).toBe('card-q1');
    expect(card.getAttribute('tabindex')).toBe('-1');
    expect(within(card).getByRole('heading', { level: 3, name: 'Question from Claude' })).toBeTruthy();
    expect(card.textContent).toContain('4 of 4 voted');
    expect(card.className).toContain('ui-card--warning');
    expect(card.querySelector('footer button')).toBeTruthy();
    expect(node).toBe(card);
    act(() => card.focus());
    expect(document.activeElement).toBe(card);
  });

  it('flash marks where an inbox item led; a settled card is drawn quieter; a card without a body has none', () => {
    const view = render(<Card title="Permission request" flash />);
    const card = screen.getByRole('region', { name: 'Permission request' });
    expect(card.hasAttribute('data-flash')).toBe(true);
    expect(card.querySelector('.ui-card__body')).toBeNull();
    view.rerender(<Card title="Permission request" settled />);
    expect(card.hasAttribute('data-flash')).toBe(false);
    expect(card.className).toContain('ui-card--settled');
  });
});

describe('StatusGlyph and KindIcon', () => {
  it('every status is a shape with a name (never colour alone)', () => {
    const shapes = new Set<string>();
    for (const status of GLYPH_STATUSES) {
      const view = render(<StatusGlyph status={status} label={`label of ${status}`} />);
      const image = screen.getByRole('img', { name: `label of ${status}` });
      expect(image.closest('.ui-status')?.getAttribute('data-status')).toBe(status);
      expect(image.closest('.ui-status')?.getAttribute('title')).toBe(`label of ${status}`);
      shapes.add(image.innerHTML.replace(/<title>.*<\/title>/, ''));
      view.unmount();
    }
    // Ten statuses, ten different drawings.
    expect(shapes.size).toBe(GLYPH_STATUSES.length);
  });

  it('every kind of thing that waits has an icon with a name', () => {
    for (const kind of ITEM_KINDS) {
      const view = render(<KindIcon kind={kind} label={`kind ${kind}`} />);
      expect(screen.getByRole('img', { name: `kind ${kind}` }).closest('.ui-kind')?.getAttribute('data-kind')).toBe(kind);
      view.unmount();
    }
  });

  it('the glyph has three sizes', () => {
    render(<StatusGlyph status="running" label="Running" size={16} />);
    expect(screen.getByRole('img', { name: 'Running' }).getAttribute('width')).toBe('16');
  });
});

describe('Chip', () => {
  it('a button when it does something, a static fact otherwise', async () => {
    const onClick = vi.fn();
    render(
      <>
        <Chip onClick={onClick} title="Asks before commands" collapsible buttonProps={{ 'aria-haspopup': 'menu', 'aria-expanded': false }}>
          Asks before commands
        </Chip>
        <Chip>smurg/checkout/cart-api</Chip>
      </>,
    );
    const button = screen.getByRole('button', { name: 'Asks before commands' });
    expect(button.getAttribute('aria-haspopup')).toBe('menu');
    expect(button.className).toContain('ui-chip--collapsible');
    await userEvent.click(button);
    expect(onClick).toHaveBeenCalledOnce();
    const fact = screen.getByText('smurg/checkout/cart-api').closest('.ui-chip') as HTMLElement;
    expect(fact.tagName).toBe('SPAN');
    expect(fact.className).toContain('ui-chip--static');
  });

  it('a collapsible static chip keeps its words as its name (in a narrow column only its icon shows)', () => {
    render(
      <Chip title="Worktree: smurg/checkout/cart-api" collapsible lead={<svg aria-hidden="true" />}>
        cart-api
      </Chip>,
    );
    expect(screen.getByRole('img', { name: 'Worktree: smurg/checkout/cart-api' })).toBeTruthy();
  });
});

describe('AvatarStack', () => {
  it('is one named image: a few avatars and how many more', () => {
    const people = ['Ian', 'Mei', 'Ken', 'Amy', 'Leo'].map((name) => ({ id: name, name }));
    render(<AvatarStack people={people} label="Voted: Ian, Mei, Ken, Amy and Leo" />);
    const stack = screen.getByRole('img', { name: 'Voted: Ian, Mei, Ken, Amy and Leo' });
    expect(stack.querySelectorAll('.ui-avatar')).toHaveLength(3);
    expect(stack.textContent).toContain('2 more');
    // The avatars inside are decoration: the stack is the name.
    expect(within(stack).queryAllByRole('img')).toHaveLength(0);
  });

  it('renders nothing for nobody', () => {
    const { container } = render(<AvatarStack people={[]} label="Voted" />);
    expect(container.firstChild).toBeNull();
  });
});

describe('ContextMenu', () => {
  const items = (onSelect = vi.fn()) => [
    { id: 'open', label: 'Open', onSelect: () => onSelect('open') },
    { id: 'side', label: 'Open to the side', onSelect: () => onSelect('side') },
    { id: 'end', label: 'End session', danger: true, disabled: true, onSelect: () => onSelect('end') },
  ];

  it('opens at a point with the focus on its first item; arrows move, a choice closes and runs', async () => {
    const onSelect = vi.fn();
    const onClose = vi.fn();
    render(<ContextMenu at={{ x: 40, y: 80 }} label="Actions for 1 · Cart API" items={items(onSelect)} onClose={onClose} />);
    const menu = screen.getByRole('menu', { name: 'Actions for 1 · Cart API' });
    expect(document.activeElement).toBe(within(menu).getByRole('menuitem', { name: 'Open' }));
    await userEvent.keyboard('{ArrowDown}');
    expect(document.activeElement).toBe(within(menu).getByRole('menuitem', { name: 'Open to the side' }));
    // The disabled item is skipped: after the last enabled one comes the first.
    await userEvent.keyboard('{ArrowDown}');
    expect(document.activeElement).toBe(within(menu).getByRole('menuitem', { name: 'Open' }));
    await userEvent.keyboard('{End}{Enter}');
    expect(onClose).toHaveBeenCalledOnce();
    expect(onSelect).toHaveBeenCalledWith('side');
    await userEvent.click(within(menu).getByRole('menuitem', { name: 'End session' }));
    expect(onSelect).toHaveBeenCalledTimes(1);
  });

  it('Escape, Tab and a press outside close it; closed or without items it renders nothing', async () => {
    const onClose = vi.fn();
    const view = render(<ContextMenu at={{ x: 1, y: 1 }} label="m" items={items()} onClose={onClose} />);
    await userEvent.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledTimes(1);
    await userEvent.keyboard('{Tab}');
    expect(onClose).toHaveBeenCalledTimes(2);
    fireEvent.pointerDown(document.body);
    expect(onClose).toHaveBeenCalledTimes(3);
    view.rerender(<ContextMenu at={null} label="m" items={items()} onClose={onClose} />);
    expect(screen.queryByRole('menu')).toBeNull();
    view.rerender(<ContextMenu at={{ x: 1, y: 1 }} label="m" items={[]} onClose={onClose} />);
    expect(screen.queryByRole('menu')).toBeNull();
  });
});

describe('SlotBoundary', () => {
  function Broken({ fail }: { fail: boolean }): null {
    if (fail) throw new Error('boom');
    return null;
  }

  it('a slot that crashes is replaced by an explanation with "Show again"; the rest of the page stays', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    let fail = true;
    function Sometimes() {
      return <Broken fail={fail} />;
    }
    render(
      <>
        <p>still here</p>
        <SlotBoundary name="1 · Cart API">
          <Sometimes />
        </SlotBoundary>
      </>,
    );
    const alert = screen.getByRole('alert');
    expect(alert.textContent).toContain('1 · Cart API cannot be shown');
    expect(screen.getByText('still here')).toBeTruthy();
    fail = false;
    await userEvent.click(within(alert).getByRole('button', { name: 'Show again' }));
    expect(screen.queryByRole('alert')).toBeNull();
    error.mockRestore();
  });

  it('silent: an overlay that crashed shows nothing', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { container } = render(
      <SlotBoundary name="conversation" silent>
        <Broken fail />
      </SlotBoundary>,
    );
    expect(container.textContent).toBe('');
    error.mockRestore();
  });
});

describe('focus helpers', () => {
  it('when one of a row goes away the focus goes to the next one, else the previous one, else nowhere', () => {
    expect(neighbourAfterRemoval(['a', 'b', 'c'], 'b')).toBe('c');
    expect(neighbourAfterRemoval(['a', 'b', 'c'], 'c')).toBe('b');
    expect(neighbourAfterRemoval(['a'], 'a')).toBeNull();
    expect(neighbourAfterRemoval(['a', 'b'], 'x')).toBeNull();
  });

  it('focusSoon focuses what exists once the render is done, and can be cancelled', async () => {
    render(<button type="button">target</button>);
    const target = screen.getByRole('button', { name: 'target' });
    focusSoon(() => target);
    expect(document.activeElement).not.toBe(target);
    await Promise.resolve();
    expect(document.activeElement).toBe(target);
    target.blur();
    const cancel = focusSoon(() => target);
    cancel();
    await Promise.resolve();
    expect(document.activeElement).not.toBe(target);
    // Nothing to focus: nothing happens.
    focusSoon(() => null);
    await Promise.resolve();
  });
});
