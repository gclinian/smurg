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
  // Linux: logind / polkit refused systemd-inhibit's sleep block (power.ts REFUSED: any access-denied text). Verified
  // on Ubuntu 24.04, where `org.freedesktop.login1.inhibit-block-sleep` is allow_any=no for a session that is not a
  // local one (SSH); other distributions and site polkit rules can refuse a local session too (review RV-6).
  'the inhibitor was refused': '系統（polkit）不允許防止睡眠（例如透過 SSH 登入時，Ubuntu 預設如此）；請在這台電腦的桌面登入後執行 smurg host，或請系統管理員允許',
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
