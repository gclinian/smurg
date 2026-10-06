// The inbox and mentions: refusals (`inbox.*`, `mention.*`) and the short wording of the attention subjects
// (`attention.*`: work that stopped and has no card). The sentence of an inbox row is composed by each client.
import { message } from '../define.ts';

export const inbox = {
  'inbox.itemGone': message({}, {
    en: () => 'This item is no longer waiting.',
    'zh-TW': () => '這個項目已經不需要處理了',
  }),
  'inbox.notDismissable': message({}, {
    en: () => 'This item leaves the inbox when it is settled.',
    'zh-TW': () => '這個項目處理完才會離開收件夾',
  }),
  'mention.inboxFull': message({ name: 'string' }, {
    en: (p) => `${p.name} has too many unopened mentions. This one did not reach them.`,
    'zh-TW': (p) => `${p.name} 有太多還沒開啟的提及，這一則沒有送達`,
  }),

  // ---- attention subjects (AttentionSubject, camelCase) ---------------------------------------------------------
  'attention.itemStalled': message({}, {
    en: () => 'Stopped without a report',
    'zh-TW': () => '沒寫報告就停下了',
  }),
  'attention.itemFailed': message({}, {
    en: () => "The agent's process failed",
    'zh-TW': () => 'agent 的程序失敗了',
  }),
  'attention.itemStopped': message({}, {
    en: () => 'The session was ended',
    'zh-TW': () => 'session 已被結束',
  }),
  'attention.itemNotStarted': message({}, {
    en: () => 'Did not start',
    'zh-TW': () => '沒有開始',
  }),
  'attention.planPaused': message({}, {
    en: () => 'smurg was restarted: the plan is paused',
    'zh-TW': () => 'smurg 重新啟動了：計畫已暫停',
  }),
  'attention.discussionLost': message({}, {
    en: () => 'The discussion is closed',
    'zh-TW': () => '討論已結束',
  }),
  'attention.account': message({}, {
    en: () => "The host's Claude account stops agents",
    'zh-TW': () => '主人的 Claude 帳號讓 agent 停下了',
  }),
  'attention.projectSettings': message({}, {
    en: () => 'Claude Code project settings wait for the host',
    'zh-TW': () => 'Claude Code 專案設定等主人確認',
  }),
  'attention.hostRules': message({}, {
    en: () => 'Your own Claude Code rules apply here',
    'zh-TW': () => '你自己的 Claude Code 規則在這裡也適用',
  }),
  'attention.storage': message({}, {
    en: () => 'Conversations use more disk space than the limit',
    'zh-TW': () => '對話紀錄佔用的磁碟空間超過上限',
  }),
} as const;
