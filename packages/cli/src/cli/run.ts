// The `smurg` command dispatcher (everything but the two entry points Claude Code runs, which main.ts dispatches
// before this module is even loaded). Each command lives in its own module and is imported only when it runs, so a
// command never pays for another one's dependencies (`smurg login` does not load the daemon).
import { EXIT } from './exit-codes.ts';
import { formatFailure, usageError } from './errors.ts';
import type { CliIo } from './io.ts';

export const USAGE = `smurg — 多人 × 多 agent 即時協作工作區

用法：smurg <指令> [選項]

  host <資料夾>        分享這台電腦上的專案資料夾，產生邀請連結（在前景執行）
  attach [session]     把 agent session 接到這個終端機（不指定時列出 session）
  stop                 停止分享（中斷所有連線、結束所有 session）
  status               顯示正在分享的工作區
  login                登入 relay（Google；自己架設的 relay 也可以設定 GitHub）
  logout               登出 relay
  --version            顯示版本

每個指令都可以加 --help 查看說明。狀態與金鑰存在 ~/.smurg（可用 SMURG_HOME 改變位置）。
`;

export async function runCli(argv: readonly string[], io: CliIo): Promise<number> {
  const [command, ...rest] = argv;
  try {
    switch (command) {
      case undefined:
      case 'help':
      case '--help':
      case '-h':
        io.stdout.write(USAGE);
        return EXIT.ok;
      case '--version':
      case '-v':
      case 'version': {
        const { versionBanner } = await import('../version.ts');
        io.stdout.write(`${versionBanner()}\n`);
        return EXIT.ok;
      }
      case 'host': {
        const [{ runHost }, { commandContext }] = await Promise.all([import('../commands/host.ts'), import('../commands/context.ts')]);
        return await runHost(rest, commandContext(io));
      }
      case 'attach': {
        const [{ runAttach }, { commandContext }] = await Promise.all([import('../commands/attach.ts'), import('../commands/context.ts')]);
        return await runAttach(rest, commandContext(io));
      }
      case 'stop':
      case 'status': {
        const [{ runStop, runStatus }, { commandContext }] = await Promise.all([import('../commands/stop.ts'), import('../commands/context.ts')]);
        return await (command === 'stop' ? runStop : runStatus)(rest, commandContext(io));
      }
      case 'login':
      case 'logout': {
        const [{ runLogin, runLogout }, { commandContext }] = await Promise.all([import('../commands/login.ts'), import('../commands/context.ts')]);
        return await (command === 'login' ? runLogin : runLogout)(rest, commandContext(io));
      }
      default:
        throw usageError(`不認得的指令「${command}」`, '執行 smurg --help 查看所有指令。');
    }
  } catch (err) {
    const failure = formatFailure(err);
    io.stderr.write(failure.text);
    return failure.exitCode;
  }
}

