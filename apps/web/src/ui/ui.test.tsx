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
          label="面板"
          value={value}
          onChange={setValue}
          items={[
            { id: 'a', label: '活動', panel: <p>panel-a</p> },
            { id: 'b', label: '衝突', panel: <p>panel-b</p> },
            { id: 'c', label: '傳輸', panel: <p>panel-c</p> },
          ]}
        />
      );
    }
    render(<Harness />);
    const first = screen.getByRole('tab', { name: '活動' });
    expect(first.getAttribute('tabindex')).toBe('0');
    expect(screen.getByRole('tab', { name: '衝突' }).getAttribute('tabindex')).toBe('-1');
    first.focus();
    await userEvent.keyboard('{ArrowRight}');
    expect(screen.getByRole('tab', { name: '衝突' }).getAttribute('aria-selected')).toBe('true');
    expect(document.activeElement).toBe(screen.getByRole('tab', { name: '衝突' }));
    expect(screen.getByRole('tabpanel').textContent).toBe('panel-b');
    await userEvent.keyboard('{End}');
    expect(screen.getByRole('tab', { name: '傳輸' }).getAttribute('aria-selected')).toBe('true');
    await userEvent.keyboard('{ArrowRight}');
    expect(screen.getByRole('tab', { name: '活動' }).getAttribute('aria-selected')).toBe('true');
    await userEvent.keyboard('{ArrowLeft}');
    expect(screen.getByRole('tab', { name: '傳輸' }).getAttribute('aria-selected')).toBe('true');
    await userEvent.keyboard('{Home}');
    expect(screen.getByRole('tab', { name: '活動' }).getAttribute('aria-selected')).toBe('true');
  });

  it('Dialog: moves focus in, traps Tab, closes on Escape and gives focus back', async () => {
    function Harness() {
      const [open, setOpen] = useState(false);
      return (
        <>
          <button type="button" onClick={() => setOpen(true)}>
            open
          </button>
          <Dialog open={open} onClose={() => setOpen(false)} title="確認" description="說明文字" footer={<Button>好</Button>}>
            <Input label="名稱" />
          </Dialog>
        </>
      );
    }
    render(<Harness />);
    const opener = screen.getByRole('button', { name: 'open' });
    await userEvent.click(opener);
    const dialog = screen.getByRole('dialog', { name: '確認' });
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    expect(dialog.getAttribute('aria-describedby')).toBeTruthy();
    expect(document.activeElement).toBe(screen.getByLabelText('名稱'));
    await userEvent.tab();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: '好' }));
    await userEvent.tab();
    expect(dialog.contains(document.activeElement)).toBe(true);
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(opener);
  });

  it('Dialog: a non-dismissible alert dialog ignores Escape', async () => {
    const onClose = vi.fn();
    render(<Dialog open onClose={onClose} role="alertdialog" dismissible={false} title="注意" footer={<Button>確定</Button>} />);
    await userEvent.keyboard('{Escape}');
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole('alertdialog', { name: '注意' })).toBeTruthy();
  });

  it('SplitPane: a keyboard-operable separator with its value', () => {
    render(<SplitPane orientation="horizontal" fixed="start" defaultSize={200} minSize={100} maxSize={400} label="檔案" start={<p>left</p>} end={<p>right</p>} />);
    const separator = screen.getByRole('separator', { name: /「檔案」/ });
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
    render(<SplitPane orientation="vertical" fixed="end" defaultSize={200} label="抽屜" collapsed collapsedSize={0} start={<p>top</p>} end={<p>bottom</p>} />);
    expect(screen.queryByRole('separator')).toBeNull();
    expect(screen.getByText('bottom').closest('[hidden]')).not.toBeNull();
  });

  it('Menu: opens on ArrowDown at the first item, arrows move, Escape returns focus to the trigger', async () => {
    const onA = vi.fn();
    render(
      <Menu
        label="更多"
        icon={<IconPlus />}
        items={[
          { id: 'a', label: '第一項', onSelect: onA },
          { id: 'b', label: '第二項', onSelect: vi.fn() },
          { id: 'c', label: '停用', disabled: true, onSelect: vi.fn() },
        ]}
      />,
    );
    const trigger = screen.getByRole('button', { name: '更多' });
    expect(trigger.getAttribute('aria-haspopup')).toBe('menu');
    trigger.focus();
    await userEvent.keyboard('{ArrowDown}');
    expect(screen.getByRole('menu', { name: '更多' })).toBeTruthy();
    expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: '第一項' }));
    await userEvent.keyboard('{ArrowDown}');
    expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: '第二項' }));
    await userEvent.keyboard('{ArrowDown}');
    expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: '第一項' }));
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('menu')).toBeNull();
    expect(document.activeElement).toBe(trigger);
    await userEvent.click(trigger);
    await userEvent.click(screen.getByRole('menuitem', { name: '第一項' }));
    expect(onA).toHaveBeenCalledOnce();
  });

  it('IconButton: the label is the accessible name (never an icon alone); pressed state for toggles', () => {
    render(<IconButton label="顯示或隱藏檔案" icon={<IconPlus />} pressed />);
    const button = screen.getByRole('button', { name: '顯示或隱藏檔案' });
    expect(button.getAttribute('aria-pressed')).toBe('true');
    expect(button.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true');
  });

  it('Tooltip: shows on focus, describes the element, hides on Escape', async () => {
    render(
      <Tooltip content="更多說明">
        <button type="button">目標</button>
      </Tooltip>,
    );
    const target = screen.getByRole('button', { name: '目標' });
    act(() => target.focus());
    const tooltip = await screen.findByRole('tooltip');
    expect(tooltip.textContent).toBe('更多說明');
    expect(target.getAttribute('aria-describedby')).toBe(tooltip.id);
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('tooltip')).toBeNull();
  });

  it('Input and Select: labelled, hint and error wired with aria', () => {
    render(
      <>
        <Input label="帳號" hint="英數字" />
        <Input label="密碼提示" error="格式錯誤" />
        <Select label="角色" value="editor" onChange={() => {}} options={[{ value: 'editor', label: '可編輯' }, { value: 'viewer', label: '旁觀' }]} />
      </>,
    );
    const account = screen.getByLabelText('帳號');
    expect(document.getElementById(account.getAttribute('aria-describedby') ?? '')?.textContent).toBe('英數字');
    const invalid = screen.getByLabelText('密碼提示');
    expect(invalid.getAttribute('aria-invalid')).toBe('true');
    expect(screen.getByRole('alert').textContent).toBe('格式錯誤');
    expect((screen.getByLabelText('角色') as HTMLSelectElement).value).toBe('editor');
  });

  it('Toast: polite for information, assertive for danger, dismissible', async () => {
    function Harness() {
      const toast = useToast();
      return (
        <>
          <button type="button" onClick={() => toast.show({ title: '已儲存' })}>
            info
          </button>
          <button type="button" onClick={() => toast.show({ tone: 'danger', title: '失敗了' })}>
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
    expect(screen.getByRole('status').textContent).toContain('已儲存');
    expect(screen.getByRole('alert').textContent).toContain('失敗了');
    await userEvent.click(screen.getAllByRole('button', { name: '關閉這則通知' })[0]!);
    expect(screen.getByRole('status').textContent).not.toContain('已儲存');
  });

  it('Avatar: CJK initials, readable text on any member colour, status in the accessible name', () => {
    expect(initialsOf('林小明')).toBe('林');
    expect(initialsOf('Amy Chen')).toBe('AC');
    expect(initialsOf('bob')).toBe('BO');
    for (const color of ['#ffffff', '#000000', '#3b82f6', '#fde047', '#7c3aed', '#22c55e']) {
      expect(contrastRatio(color, readableTextOn(color)), color).toBeGreaterThanOrEqual(4.5);
    }
    render(<Avatar name="林小明" color="#fde047" status="online" />);
    expect(screen.getByRole('img', { name: '林小明（在線上）' })).toBeTruthy();
  });

  it('Table, Banner, Badge and EmptyState render semantic markup', () => {
    render(
      <>
        <Table caption="成員" columns={[{ id: 'n', header: '名稱', cell: (row: { n: string }) => row.n }]} rows={[{ n: 'Amy' }]} rowKey={(row) => row.n} />
        <Banner tone="warning" title="主人已離線">內容</Banner>
        <Badge tone="info">3</Badge>
        <EmptyState title="沒有東西" />
      </>,
    );
    expect(screen.getByRole('table', { name: '成員' })).toBeTruthy();
    expect(screen.getByRole('columnheader', { name: '名稱' })).toBeTruthy();
    expect(screen.getByRole('status').textContent).toContain('主人已離線');
    expect(screen.getByText('沒有東西')).toBeTruthy();
  });
});
