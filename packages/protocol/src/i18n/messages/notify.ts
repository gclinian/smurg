// Notifications the daemon itself writes to one member (`notify.*`, MemberNotification.msg). An agent's own words
// (the `notify_member` tool) travel as `text` and are never translated.
import { joinList, message } from '../define.ts';

export const notify = {
  'notify.claudeVersionTooOld': message({ version: 'string?', minVersion: 'string' }, {
    en: (p) =>
      `Note: Claude Code ${p.version ? p.version : '(unknown version)'} is older than ${p.minVersion}, the oldest version smurg is verified with. File locks and hooks may not work properly.`,
    'zh-TW': (p) => `注意：Claude Code ${p.version ? p.version : '（版本不明）'} 低於 smurg 驗證過的最低版本 ${p.minVersion}，檔案鎖與 hooks 可能無法正常運作。`,
  }),
  'notify.claudeVersionUnverified': message({ version: 'string?', verified: 'list' }, {
    en: (p) =>
      `Note: Claude Code ${p.version ? `${p.version} ` : ''}has not been verified with smurg yet (verified: ${joinList('en', p.verified)}). Report any problem you run into.`,
    'zh-TW': (p) => `注意：Claude Code ${p.version ? `${p.version} ` : ''}尚未經過 smurg 驗證（已驗證：${joinList('zh-TW', p.verified)}），如遇問題請回報。`,
  }),
} as const;
