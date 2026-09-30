import { defineStrings } from './catalog.ts';

// Accessible names and small words of the shared components (src/ui).
export const tUi = defineStrings('ui', {
  close: '關閉',
  'dialog.close': '關閉對話框',
  'toast.region': '通知',
  'toast.dismiss': '關閉這則通知',
  'split.resize': '拖曳或用方向鍵調整「{name}」的大小',
  'menu.more': '更多動作',
  'spinner.loading': '載入中',
  'drawer.expand': '展開「{name}」',
  'drawer.collapse': '收合「{name}」',
  'avatar.online': '{name}（在線上）',
  'avatar.offline': '{name}（離線）',
  'avatar.agent': '{name}（agent）',
  'avatar.more': '還有 {count} 位',
  'table.empty': '沒有資料',
  'copy.done': '已複製',
  'copy.failed': '無法複製，請手動選取文字',
});
