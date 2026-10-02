// Sessions and suggestions: error texts (`session.*`, `suggest.*`) and the default title of a session nobody named
// (`session.title.*`: clients build it from `kind` + `ownerName`; it is not on the wire).
import { message } from '../define.ts';

export const sessions = {
  // ---- default titles (SessionInfo.title is present only when the opener typed one) -----------------------------
  'session.title.agent': message({ owner: 'string' }, {
    en: (p) => `Claude (${p.owner})`,
    'zh-TW': (p) => `Claude (${p.owner})`,
  }),
  'session.title.terminal': message({ owner: 'string' }, {
    en: (p) => `Terminal (${p.owner})`,
    'zh-TW': (p) => `終端機（${p.owner}）`,
  }),

  // ---- sessions -----------------------------------------------------------------------------------------------
  'session.notFound': message({}, {
    en: () => 'That session was not found.',
    'zh-TW': () => '找不到這個 session',
  }),
  'session.exited': message({}, {
    en: () => 'The session has ended.',
    'zh-TW': () => 'session 已結束',
  }),
  'session.limit': message({}, {
    en: () => 'The workspace has reached its session limit.',
    'zh-TW': () => 'session 數量已達上限',
  }),
  'session.limitOwner': message({}, {
    en: () => 'You have reached your session limit.',
    'zh-TW': () => '你的 session 數量已達上限',
  }),
  'session.claudeNotFound': message({}, {
    en: () => 'The claude command was not found on the host.',
    'zh-TW': () => '找不到 claude 指令',
  }),
  'session.noShell': message({}, {
    en: () => 'No usable shell was found on the host.',
    'zh-TW': () => '找不到可用的 shell',
  }),
  'session.notStarted': message({}, {
    en: () => 'Sessions are not ready yet.',
    'zh-TW': () => 'session 服務尚未啟動',
  }),
  'session.startWhileStopping': message({}, {
    en: () => 'smurg is stopping, so no session can be started.',
    'zh-TW': () => 'smurg 正在停止，無法啟動 session',
  }),
  'session.hooks.noCommand': message({}, {
    en: () => 'smurg has no hook command configured, so no agent session can be started.',
    'zh-TW': () => 'smurg 沒有設定 hook 指令，無法啟動 agent session',
  }),
  'session.hooks.notConfigured': message({}, {
    en: () => 'The smurg hook is not configured, so no agent session can be started.',
    'zh-TW': () => 'smurg hook 未設定，無法啟動 agent session',
  }),
  'session.hooks.unavailable': message({}, {
    en: () => 'The hook service is not available, so no agent session can be started.',
    'zh-TW': () => 'hook 服務無法使用，無法啟動 agent session',
  }),
  'session.hooks.settingsNotWritten': message({}, {
    en: () => 'The hook settings file could not be written, so no agent session can be started.',
    'zh-TW': () => 'hook 設定檔無法寫入，無法啟動 agent session',
  }),
  'session.hooks.settingsInvalid': message({}, {
    en: () => 'The hook settings file is not valid, so no agent session can be started.',
    'zh-TW': () => 'hook 設定檔不正確，無法啟動 agent session',
  }),

  // ---- suggestions --------------------------------------------------------------------------------------------
  'suggest.notFound': message({}, {
    en: () => 'That suggestion was not found.',
    'zh-TW': () => '找不到這則建議',
  }),
  'suggest.notPending': message({}, {
    en: () => 'This suggestion was already handled.',
    'zh-TW': () => '這則建議已經處理過了',
  }),
  'suggest.sessionEnded': message({}, {
    en: () => 'This session has ended.',
    'zh-TW': () => '這個 session 已結束',
  }),
  'suggest.invalidText': message({}, {
    en: () => 'The suggestion is not valid (it cannot be blank or contain control characters).',
    'zh-TW': () => '建議內容不正確（不能是空白，也不能包含控制字元）',
  }),
  'suggest.ownSession': message({}, {
    en: () => 'You cannot suggest to your own session. Type into it directly.',
    'zh-TW': () => '不能對自己的 session 提建議，請直接在自己的 session 輸入',
  }),
  'suggest.changed': message({}, {
    en: () => 'The author just changed this suggestion. Check the new text before you accept it.',
    'zh-TW': () => '提出者剛修改了這則建議，請確認新的內容後再採用',
  }),
  'suggest.queueFull': message({}, {
    en: () => 'Too many suggestions are waiting. Wait until some are handled before you send another.',
    'zh-TW': () => '待處理的建議太多了，請等擁有者處理後再提出',
  }),
  'suggest.decideNeedsDrive': message({}, {
    en: () => 'Only the host and members with agent access can handle suggestions.',
    'zh-TW': () => '只有主人和「可使用 agent」的成員可以處理建議',
  }),
  'suggest.authorOnly': message({}, {
    en: () => 'Only the author can change or withdraw this suggestion.',
    'zh-TW': () => '只有提出者可以修改或撤回這則建議',
  }),
  'suggest.notStarted': message({}, {
    en: () => 'Suggestions are not ready yet.',
    'zh-TW': () => '建議功能尚未就緒',
  }),
} as const;
