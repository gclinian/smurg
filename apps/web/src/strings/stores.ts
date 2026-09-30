import { defineStrings } from './catalog.ts';

// Messages produced by the shared stores (src/lib/stores) rather than by a feature.
export const tStores = defineStrings('stores', {
  'docs.bufferOverflow': '這個檔案累積了太多尚未處理的同步資料，請關閉後重新開啟。',
  'load.failed': '無法載入{area}：{reason}',
  'area.files': '檔案',
  'area.locks': '檔案鎖',
  'area.docs': '開啟中的檔案',
  'area.sessions': 'agent session',
  'area.suggestions': '建議',
  'area.activity': '活動動態',
  'area.conflicts': '衝突',
  'area.worktrees': 'worktree',
  'area.admin': '主人控制台資料',
  'area.presence': '在線成員',
  'area.workspace': '工作區',
  'area.transfers': '傳輸',
  'notify.from': '{name} 通知你',
  'worktree.mine': '我的 worktree',
  'worktree.of': '{owner}的 worktree',
  'worktree.named': '{who}（{name}）',
  'worktree.since': '{who}（{time} 建立）',
});
