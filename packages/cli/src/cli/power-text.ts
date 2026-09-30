// The keep-awake status in zh-TW, the same words in `smurg host`'s summary and in `smurg status` (CLI-13). The
// daemon's reasons are English identifiers for its log (packages/daemon/src/workspace/power.ts).
import type { PowerStatus } from '@smurg/daemon';

const REASONS: Readonly<Record<string, string>> = {
  disabled: '已用 --no-keep-awake 關閉',
  'not started': '尚未啟動',
  stopped: '已停止',
  'systemd-inhibit not found': '找不到 systemd-inhibit',
  'the inhibitor could not be started': '無法啟動防睡眠程式',
  'the inhibitor exited': '防睡眠程式已經結束',
};

/** 「已啟用（caffeinate）」 / 「未啟用（已用 --no-keep-awake 關閉）」 */
export function powerState(status: PowerStatus): string {
  if (status.active) return `已啟用（${status.mechanism}）`;
  const reason = status.reason ?? '';
  let text = REASONS[reason];
  if (text === undefined && reason.startsWith('spawn failed')) text = '無法啟動防睡眠程式';
  if (text === undefined && reason.startsWith('unsupported platform')) text = '這個作業系統不支援';
  return `未啟用（${text ?? '原因不明'}）`;
}
