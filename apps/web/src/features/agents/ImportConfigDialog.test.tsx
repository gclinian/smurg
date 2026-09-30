// 「匯入個人設定」 (SPEC R4 「客人可以上傳自己的 CLAUDE.md、自訂指令、skills 到臨時目錄」): choose them from this
// computer, see what will be sent, send them with session.importConfig split under the size cap, see what was written.
import { act, fireEvent, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { IMPORT_CONFIG_TOTAL_MAX_BYTES, SmurgError } from '@smurg/protocol';
import { makeSession } from '../../testing/fixtures.ts';
import { renderInWorkspace } from '../../testing/services.tsx';
import { ImportConfigDialog } from './ImportConfigDialog.tsx';
import { nextRequest } from './test-support.tsx';

const MiB = 1024 * 1024;

function file(name: string, content: string | Uint8Array<ArrayBuffer>, relativePath?: string): File {
  const created = new File([content], name, { type: 'text/markdown' });
  if (relativePath !== undefined) Object.defineProperty(created, 'webkitRelativePath', { value: relativePath });
  return created;
}

function pick(label: string, files: File[]): void {
  fireEvent.change(screen.getByLabelText(label), { target: { files } });
}

async function renderDialog(sessions = [] as ReturnType<typeof makeSession>[]) {
  const result = renderInWorkspace(<ImportConfigDialog open onClose={() => {}} />, { role: 'runner' });
  await act(async () => {
    result.conn.respond('session.list', { sessions });
  });
  return result;
}

const dialog = (): HTMLElement => screen.getByRole('dialog');

describe('import personal settings', () => {
  it('sends CLAUDE.md, commands/** and skills/** with session.importConfig and shows what the host wrote', async () => {
    const { conn } = await renderDialog();
    pick('選擇 CLAUDE.md', [file('CLAUDE.md', '# 我的習慣')]);
    pick('選擇 commands 資料夾', [file('review.md', 'review', 'my-commands/review.md'), file('.DS_Store', 'x', 'my-commands/.DS_Store')]);
    pick('選擇 skills 資料夾', [file('SKILL.md', 'skill', 'skills/pdf/SKILL.md')]);
    const text = dialog().textContent ?? '';
    expect(text).toContain('將匯入 3 個檔案');
    expect(text).toContain('commands/review.md');
    expect(text).toContain('skills/pdf/SKILL.md');
    expect(text).toContain('略過 1 個檔案');
    expect(text).toContain('系統檔案');

    await act(async () => {
      fireEvent.click(within(dialog()).getByRole('button', { name: '匯入' }));
    });
    const request = await nextRequest(conn, 'session.importConfig');
    const sent = request.payload.files.map((f) => [f.relPath, new TextDecoder().decode(f.content)]);
    expect(sent).toEqual([
      ['CLAUDE.md', '# 我的習慣'],
      ['commands/review.md', 'review'],
      ['skills/pdf/SKILL.md', 'skill'],
    ]);
    await act(async () => {
      conn.respond('session.importConfig', { written: ['CLAUDE.md', 'commands/review.md', 'skills/pdf/SKILL.md'] });
    });
    const result = within(dialog()).getByText('已寫入 3 個檔案').closest('[role="status"]') as HTMLElement;
    expect(result.textContent).toContain('commands/review.md');
    expect(result.textContent).toContain('skills/pdf/SKILL.md');
  });

  it('splits a big import into requests under the size cap (each written all or none)', async () => {
    const { conn } = await renderDialog();
    const big = Array.from({ length: 9 }, (_, i) => file(`s${i}.md`, new Uint8Array(MiB), `skills/big/s${i}.md`));
    pick('選擇 skills 資料夾', big);
    expect(dialog().textContent).toContain('會分成 2 次送出');
    await act(async () => {
      fireEvent.click(within(dialog()).getByRole('button', { name: '匯入' }));
    });
    const first = await nextRequest(conn, 'session.importConfig');
    const firstBytes = first.payload.files.reduce((sum, f) => sum + f.content.byteLength, 0);
    expect(firstBytes).toBeLessThanOrEqual(IMPORT_CONFIG_TOTAL_MAX_BYTES);
    await act(async () => {
      conn.respond('session.importConfig', { written: first.payload.files.map((f) => f.relPath) });
    });
    const second = await nextRequest(conn, 'session.importConfig');
    expect(first.payload.files.length + second.payload.files.length).toBe(9);
    expect(new Set([...first.payload.files, ...second.payload.files].map((f) => f.relPath)).size).toBe(9);
    await act(async () => {
      conn.respond('session.importConfig', { written: second.payload.files.map((f) => f.relPath) });
    });
    expect(within(dialog()).getByText('已寫入 9 個檔案')).toBeTruthy();
  });

  it('files the daemon would refuse are not sent, with the reason', async () => {
    await renderDialog();
    pick('選擇 commands 資料夾', [file('huge.md', new Uint8Array(MiB + 1), 'cmds/huge.md')]);
    expect(dialog().textContent).toContain('超過 1 MB');
    expect(within(dialog()).getByRole('button', { name: '匯入' })).toHaveProperty('disabled', true);
  });

  it('while the member has a running session it explains that sessions must end first (the host writes only then)', async () => {
    const mine = makeSession({ id: 'sess_amy', ownerUserId: 'dev:amy', ownerName: 'Amy', sandboxed: true });
    await renderDialog([mine]);
    pick('選擇 CLAUDE.md', [file('CLAUDE.md', 'x')]);
    expect(dialog().textContent).toContain('你還有 1 個執行中的 session');
    expect(within(dialog()).getByRole('button', { name: '匯入' })).toHaveProperty('disabled', true);
  });

  it("the daemon's refusal is shown in plain zh-TW with what to do", async () => {
    const { conn } = await renderDialog();
    pick('選擇 CLAUDE.md', [file('CLAUDE.md', 'x')]);
    await act(async () => {
      fireEvent.click(within(dialog()).getByRole('button', { name: '匯入' }));
    });
    await nextRequest(conn, 'session.importConfig');
    await act(async () => {
      conn.fail('session.importConfig', new SmurgError('conflict', '請先結束你所有的 session，再匯入個人設定', { reason: 'sessions-running' }));
    });
    const text = dialog().textContent ?? '';
    expect(text).toContain('匯入失敗');
    expect(text).toContain('請先結束你所有的 session，再匯入個人設定');
  });
});
