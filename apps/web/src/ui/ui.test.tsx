import { act, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { Avatar, Badge, Banner, Button, Dialog, EmptyState, IconButton, Input, Menu, Select, SplitPane, Table, Tabs, ToastProvider, Tooltip, useToast } from './index.ts';
import { IconPlus } from './icons.tsx';
import { initialsOf } from './Avatar.tsx';
import { contrastRatio, readableTextOn } from '../lib/color.ts';

describe('design system components', () => {
  it('Tabs: arrows, Home and End move and select; only the selected tab is in the tab order', async () => {
    function Harness() {
      const [value, setValue] = useState<'a' | 'b' | 'c'>('a');
      return (
        <Tabs<'a' | 'b' | 'c'>
          label="Panels"
          value={value}
          onChange={setValue}
          items={[
            { id: 'a', label: 'Activity', panel: <p>panel-a</p> },
            { id: 'b', label: 'Conflicts', panel: <p>panel-b</p> },
            { id: 'c', label: 'Transfers', panel: <p>panel-c</p> },
          ]}
        />
      );
    }
    render(<Harness />);
    const first = screen.getByRole('tab', { name: 'Activity' });
    expect(first.getAttribute('tabindex')).toBe('0');
    expect(screen.getByRole('tab', { name: 'Conflicts' }).getAttribute('tabindex')).toBe('-1');
    first.focus();
    await userEvent.keyboard('{ArrowRight}');
    expect(screen.getByRole('tab', { name: 'Conflicts' }).getAttribute('aria-selected')).toBe('true');
    expect(document.activeElement).toBe(screen.getByRole('tab', { name: 'Conflicts' }));
    expect(screen.getByRole('tabpanel').textContent).toBe('panel-b');
    await userEvent.keyboard('{End}');
    expect(screen.getByRole('tab', { name: 'Transfers' }).getAttribute('aria-selected')).toBe('true');
    await userEvent.keyboard('{ArrowRight}');
    expect(screen.getByRole('tab', { name: 'Activity' }).getAttribute('aria-selected')).toBe('true');
    await userEvent.keyboard('{ArrowLeft}');
    expect(screen.getByRole('tab', { name: 'Transfers' }).getAttribute('aria-selected')).toBe('true');
    await userEvent.keyboard('{Home}');
    expect(screen.getByRole('tab', { name: 'Activity' }).getAttribute('aria-selected')).toBe('true');
  });

  it('Dialog: moves focus in, traps Tab, closes on Escape and gives focus back', async () => {
    function Harness() {
      const [open, setOpen] = useState(false);
      return (
        <>
          <button type="button" onClick={() => setOpen(true)}>
            open
          </button>
          <Dialog open={open} onClose={() => setOpen(false)} title="Confirm" description="An explanation" footer={<Button>OK</Button>}>
            <Input label="Name" />
          </Dialog>
        </>
      );
    }
    render(<Harness />);
    const opener = screen.getByRole('button', { name: 'open' });
    await userEvent.click(opener);
    const dialog = screen.getByRole('dialog', { name: 'Confirm' });
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    expect(dialog.getAttribute('aria-describedby')).toBeTruthy();
    expect(document.activeElement).toBe(screen.getByLabelText('Name'));
    await userEvent.tab();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'OK' }));
    await userEvent.tab();
    expect(dialog.contains(document.activeElement)).toBe(true);
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(opener);
  });

  it('Dialog: a non-dismissible alert dialog ignores Escape', async () => {
    const onClose = vi.fn();
    render(<Dialog open onClose={onClose} role="alertdialog" dismissible={false} title="Careful" footer={<Button>OK</Button>} />);
    await userEvent.keyboard('{Escape}');
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole('alertdialog', { name: 'Careful' })).toBeTruthy();
  });

  it('SplitPane: a keyboard-operable separator with its value', () => {
    render(<SplitPane orientation="horizontal" fixed="start" defaultSize={200} minSize={100} maxSize={400} label="Files" start={<p>left</p>} end={<p>right</p>} />);
    const separator = screen.getByRole('separator', { name: 'Drag or use the arrow keys to resize Files' });
    expect(separator.getAttribute('aria-valuenow')).toBe('200');
    fireEvent.keyDown(separator, { key: 'ArrowRight' });
    expect(separator.getAttribute('aria-valuenow')).toBe('216');
    fireEvent.keyDown(separator, { key: 'ArrowLeft', shiftKey: true });
    expect(separator.getAttribute('aria-valuenow')).toBe('152');
    fireEvent.keyDown(separator, { key: 'Home' });
    expect(separator.getAttribute('aria-valuenow')).toBe('100');
    fireEvent.keyDown(separator, { key: 'End' });
    expect(separator.getAttribute('aria-valuenow')).toBe('400');
  });

  it('SplitPane: a collapsed pane stays mounted', () => {
    render(<SplitPane orientation="vertical" fixed="end" defaultSize={200} label="Drawer" collapsed collapsedSize={0} start={<p>top</p>} end={<p>bottom</p>} />);
    expect(screen.queryByRole('separator')).toBeNull();
    expect(screen.getByText('bottom').closest('[hidden]')).not.toBeNull();
  });

  it('Menu: opens on ArrowDown at the first item, arrows move, Escape returns focus to the trigger', async () => {
    const onA = vi.fn();
    render(
      <Menu
        label="More"
        icon={<IconPlus />}
        items={[
          { id: 'a', label: 'First', onSelect: onA },
          { id: 'b', label: 'Second', onSelect: vi.fn() },
          { id: 'c', label: 'Disabled', disabled: true, onSelect: vi.fn() },
        ]}
      />,
    );
    const trigger = screen.getByRole('button', { name: 'More' });
    expect(trigger.getAttribute('aria-haspopup')).toBe('menu');
    trigger.focus();
    await userEvent.keyboard('{ArrowDown}');
    expect(screen.getByRole('menu', { name: 'More' })).toBeTruthy();
    expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: 'First' }));
    await userEvent.keyboard('{ArrowDown}');
    expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: 'Second' }));
    await userEvent.keyboard('{ArrowDown}');
    expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: 'First' }));
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('menu')).toBeNull();
    expect(document.activeElement).toBe(trigger);
    await userEvent.click(trigger);
    await userEvent.click(screen.getByRole('menuitem', { name: 'First' }));
    expect(onA).toHaveBeenCalledOnce();
  });

  it('IconButton: the label is the accessible name (never an icon alone); pressed state for toggles', () => {
    render(<IconButton label="Show or hide files" icon={<IconPlus />} pressed />);
    const button = screen.getByRole('button', { name: 'Show or hide files' });
    expect(button.getAttribute('aria-pressed')).toBe('true');
    expect(button.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true');
  });

  it('Tooltip: shows on focus, describes the element, hides on Escape', async () => {
    render(
      <Tooltip content="More about it">
        <button type="button">Target</button>
      </Tooltip>,
    );
    const target = screen.getByRole('button', { name: 'Target' });
    act(() => target.focus());
    const tooltip = await screen.findByRole('tooltip');
    expect(tooltip.textContent).toBe('More about it');
    expect(target.getAttribute('aria-describedby')).toBe(tooltip.id);
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('tooltip')).toBeNull();
  });

  it('Input and Select: labelled, hint and error wired with aria', () => {
    render(
      <>
        <Input label="Account" hint="Letters and digits" />
        <Input label="Password hint" error="Wrong format" />
        <Select label="Role" value="editor" onChange={() => {}} options={[{ value: 'editor', label: 'Editor' }, { value: 'viewer', label: 'Viewer' }]} />
      </>,
    );
    const account = screen.getByLabelText('Account');
    expect(document.getElementById(account.getAttribute('aria-describedby') ?? '')?.textContent).toBe('Letters and digits');
    const invalid = screen.getByLabelText('Password hint');
    expect(invalid.getAttribute('aria-invalid')).toBe('true');
    expect(screen.getByRole('alert').textContent).toBe('Wrong format');
    expect((screen.getByLabelText('Role') as HTMLSelectElement).value).toBe('editor');
  });

  it('Toast: polite for information, assertive for danger, dismissible', async () => {
    function Harness() {
      const toast = useToast();
      return (
        <>
          <button type="button" onClick={() => toast.show({ title: 'Saved' })}>
            info
          </button>
          <button type="button" onClick={() => toast.show({ tone: 'danger', title: 'It failed' })}>
            danger
          </button>
        </>
      );
    }
    render(
      <ToastProvider>
        <Harness />
      </ToastProvider>,
    );
    await userEvent.click(screen.getByRole('button', { name: 'info' }));
    await userEvent.click(screen.getByRole('button', { name: 'danger' }));
    expect(screen.getByRole('status').textContent).toContain('Saved');
    expect(screen.getByRole('alert').textContent).toContain('It failed');
    await userEvent.click(screen.getAllByRole('button', { name: 'Dismiss this notification' })[0]!);
    expect(screen.getByRole('status').textContent).not.toContain('Saved');
  });

  it('Avatar: CJK initials, readable text on any member colour, status in the accessible name', () => {
    expect(initialsOf('林小明')).toBe('林');
    expect(initialsOf('Amy Chen')).toBe('AC');
    expect(initialsOf('bob')).toBe('BO');
    for (const color of ['#ffffff', '#000000', '#3b82f6', '#fde047', '#7c3aed', '#22c55e']) {
      expect(contrastRatio(color, readableTextOn(color)), color).toBeGreaterThanOrEqual(4.5);
    }
    render(<Avatar name="林小明" color="#fde047" status="online" />);
    expect(screen.getByRole('img', { name: '林小明 (online)' })).toBeTruthy();
  });

  it('Table, Banner, Badge and EmptyState render semantic markup', () => {
    render(
      <>
        <Table caption="Members" columns={[{ id: 'n', header: 'Name', cell: (row: { n: string }) => row.n }]} rows={[{ n: 'Amy' }]} rowKey={(row) => row.n} />
        <Banner tone="warning" title="Host offline">Details</Banner>
        <Badge tone="info">3</Badge>
        <EmptyState title="Nothing here" />
      </>,
    );
    expect(screen.getByRole('table', { name: 'Members' })).toBeTruthy();
    expect(screen.getByRole('columnheader', { name: 'Name' })).toBeTruthy();
    expect(screen.getByRole('status').textContent).toContain('Host offline');
    expect(screen.getByText('Nothing here')).toBeTruthy();
  });
});
