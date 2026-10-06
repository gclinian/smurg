// The zh-TW suite: every other test of this package runs in English (SMURG_LANG=en is pinned in the setup, in testIo
// and in isolatedEnv); these few run the CLI as a Traditional Chinese terminal would and read what it says. The
// catalog itself (same ids, same parameters, every message renders) is checked in i18n.test.ts; the host's start
// summary in host-relay.test.ts, the uninstall question in uninstall.test.ts, the installer in install-script.test.ts.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { runCli } from '../src/cli/run.ts';
import { CLI_MAIN, isolatedEnv, makeDirs, testIo, type Dirs, type TestIo } from './helpers.ts';

const run = promisify(execFile);
let dirs: Dirs | undefined;
afterEach(async () => {
  await dirs?.cleanup();
  dirs = undefined;
});

/** A terminal whose language comes from `env` alone (SMURG_LANG is not pinned unless `env` sets it). */
const terminal = (env: Record<string, string>): TestIo => testIo({ env: { SMURG_LANG: '', HOME: '/nonexistent', ...env } });

describe('smurg in zh-TW', () => {
  it('LANG=zh_TW.UTF-8: --help of the command and of each subcommand is Chinese, with the zh-TW guide links', async () => {
    const io = terminal({ LANG: 'zh_TW.UTF-8' });
    expect(await runCli(['--help'], io)).toBe(0);
    expect(io.out()).toContain('用法：smurg <指令> [選項]');
    expect(io.out()).toContain('  host <資料夾>        分享這台電腦上的專案資料夾');
    expect(io.out()).toContain('說明文件：https://smurg.ai/zh-TW/docs/\n');
    expect(io.out()).toContain('SMURG_LANG=en');
    for (const [command, firstLine] of [
      ['host', '用法：smurg host <資料夾> [選項]'],
      ['attach', '用法：smurg attach [session]'],
      ['stop', '用法：smurg stop [--workspace 工作區ID]'],
      ['status', '用法：smurg status [--workspace 工作區ID]'],
      ['login', '用法：smurg login [--relay 網址]'],
      ['logout', '用法：smurg logout [--relay 網址] [--all]'],
      ['update', '用法：smurg update [--check]'],
      ['uninstall', '用法：smurg uninstall [--keep-data] [--yes]'],
      ['licenses', '用法：smurg licenses [--third-party]'],
    ] as const) {
      const help = terminal({ LANG: 'zh_TW.UTF-8' });
      expect(await runCli([command, '--help'], help), command).toBe(0);
      expect(help.out().startsWith(firstLine), command).toBe(true);
      expect(help.out(), command).not.toMatch(/Usage:/);
    }
    // What v0.5.0 changed: attach is for terminal sessions, a stop pauses agent sessions.
    expect(io.out()).toContain('  attach [session]     把終端機 session 接到這個終端機（不指定時列出 session）\n');
    expect(io.out()).toContain('  stop                 停止分享（中斷所有連線、結束終端機 session、暫停 agent session）\n');
    const attach = terminal({ LANG: 'zh_TW.UTF-8' });
    await runCli(['attach', '--help'], attach);
    expect(attach.out()).toContain('  agent session 是對話：列表會顯示它的主題和狀態，要在瀏覽器開啟，不是在終端機裡。\n');
    const stop = terminal({ LANG: 'zh_TW.UTF-8' });
    await runCli(['stop', '--help'], stop);
    expect(stop.out()).toContain('agent session 會暫停：agent 停止執行，對話會保留，\n  下次分享這個資料夾時繼續。\n');
    const host = terminal({ LANG: 'zh_TW.UTF-8' });
    await runCli(['host', '--help'], host);
    expect(host.out()).toContain('分享前必讀：https://smurg.ai/zh-TW/docs/hosting/#4-分享前必讀\n');
    expect(host.out()).toContain('agent（可使用 agent）、editor（可編輯，預設）、viewer（旁觀）');
  });

  it('a usage error is Chinese, with the Chinese prefix and exit code 2', async () => {
    const io = terminal({ LANG: 'zh_TW.UTF-8' });
    expect(await runCli(['no-such-command'], io)).toBe(2);
    expect(io.err()).toBe('smurg：不認得的指令「no-such-command」\n  執行 smurg --help 查看所有指令。\n');
    const missing = terminal({ LANG: 'zh_TW.UTF-8' });
    expect(await runCli(['host'], missing)).toBe(2);
    expect(missing.err()).toBe('smurg：缺少參數 <資料夾>\n');
    const option = terminal({ LC_MESSAGES: 'zh_HK.utf8' });
    expect(await runCli(['stop', '--force'], option)).toBe(2);
    expect(option.err()).toBe('smurg：不認得的選項 --force\n');
  });

  it('LC_ALL wins over LANG (POSIX): LC_ALL=C is English; a Big5 or Simplified Chinese locale is English too', async () => {
    for (const env of [{ LC_ALL: 'C', LANG: 'zh_TW.UTF-8' }, { LANG: 'zh_TW.Big5' }, { LANG: 'zh_CN.UTF-8' }, { LANG: 'ja_JP.UTF-8' }, {}] as Record<string, string>[]) {
      const io = terminal(env);
      expect(await runCli(['no-such-command'], io), JSON.stringify(env)).toBe(2);
      expect(io.err(), JSON.stringify(env)).toBe('smurg: Unknown command "no-such-command"\n  Run smurg --help to see every command.\n');
    }
  });

  it('SMURG_LANG wins both ways, in any spelling; a value that is not a language is ignored', async () => {
    const cases: [Record<string, string>, boolean][] = [
      [{ SMURG_LANG: 'zh-TW', LANG: 'en_US.UTF-8' }, true],
      [{ SMURG_LANG: 'ZH_tw', LC_ALL: 'C' }, true],
      [{ SMURG_LANG: 'en', LANG: 'zh_TW.UTF-8' }, false],
      [{ SMURG_LANG: 'EN', LC_ALL: 'zh_TW.UTF-8' }, false],
      [{ SMURG_LANG: 'klingon', LANG: 'zh_TW.UTF-8' }, true],
      [{ SMURG_LANG: 'klingon', LANG: 'en_US.UTF-8' }, false],
    ];
    for (const [env, chinese] of cases) {
      const io = testIo({ env: { HOME: '/nonexistent', ...env } });
      expect(await runCli(['status', '--workspace', 'not a workspace'], io), JSON.stringify(env)).toBe(2);
      expect(io.err(), JSON.stringify(env)).toBe(chinese ? 'smurg：工作區 ID 不正確：not a workspace\n' : 'smurg: Not a workspace ID: not a workspace\n');
    }
  });

  it('the real process: the language of `node main.ts` follows the environment it is started with', async () => {
    dirs = await makeDirs();
    const zh = isolatedEnv(dirs, { SMURG_LANG: '', LANG: 'zh_TW.UTF-8' });
    const help = await run(process.execPath, [CLI_MAIN, '--help'], { env: zh, timeout: 20_000 });
    expect(help.stdout).toContain('用法：smurg <指令> [選項]');
    const status = await run(process.execPath, [CLI_MAIN, 'status'], { env: zh, timeout: 20_000 }).catch((err: { code: number; stdout: string }) => err);
    expect(status).toMatchObject({ code: 3, stdout: '目前沒有正在分享的工作區。\n' });
    await expect(run(process.execPath, [CLI_MAIN, 'update'], { env: { ...zh, SMURG_INSTALL_BASE_URL: 'http://127.0.0.1:9' }, timeout: 20_000 })).rejects.toMatchObject({
      code: 2,
      stderr: expect.stringContaining('smurg：這個 smurg 是從原始碼執行的，不是安裝好的單一執行檔，smurg update 無法更新它\n'),
    });
    // The same process in English: --version is the same line in every language.
    const en = isolatedEnv(dirs);
    const version = await run(process.execPath, [CLI_MAIN, '--version'], { env: en, timeout: 20_000 });
    const versionZh = await run(process.execPath, [CLI_MAIN, '--version'], { env: zh, timeout: 20_000 });
    expect(versionZh.stdout).toBe(version.stdout);
    expect(version.stdout).toMatch(/^smurg \d+\.\d+\.\d+\S* \(/);
  });
});
