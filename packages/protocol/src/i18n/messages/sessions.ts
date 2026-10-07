// Sessions and suggestions: error texts (`session.*`, `responsible.*`, `rule.*`, `suggest.*`) and the default title of
// a session nobody named (`session.title.*`: clients build it from the session's kind, purpose and opener; it is not
// on the wire).
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
  'session.title.discussion': message({}, {
    en: () => 'Discussion',
    'zh-TW': () => '討論',
  }),
  'session.title.item': message({ number: 'number', title: 'string' }, {
    en: (p) => `${p.number} · ${p.title}`,
    'zh-TW': (p) => `${p.number} · ${p.title}`,
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
    en: () => 'You have reached your limit of terminal sessions.',
    'zh-TW': () => '你的終端機 session 數量已達上限',
  }),
  'session.notAgent': message({}, {
    en: () => 'This is a terminal session. It has no conversation.',
    'zh-TW': () => '這是終端機 session，沒有對話',
  }),
  'session.notTerminal': message({}, {
    en: () => 'This is an agent conversation. Open it in the browser.',
    'zh-TW': () => '這是 agent 對話，請在瀏覽器開啟',
  }),
  'session.ended.noMessages': message({}, {
    en: () => 'This session has ended. It takes no more messages.',
    'zh-TW': () => '這個 session 已結束，不再接收訊息',
  }),
  'session.limit.agents': message({ max: 'number' }, {
    en: (p) => `This workspace already has ${p.max} agent sessions. End or archive some first.`,
    'zh-TW': (p) => `這個工作區已經有 ${p.max} 個 agent session，請先結束或封存一些`,
  }),
  'session.limit.processes': message({ max: 'number' }, {
    en: (p) => `The host's computer already runs ${p.max} agents. Try again when one is idle.`,
    'zh-TW': (p) => `主人的電腦已經在執行 ${p.max} 個 agent，請等其中一個閒置後再試`,
  }),
  'session.claude.initTimeout': message({}, {
    en: () => 'Claude Code did not answer when the session started. The host should check that `claude` runs in a terminal on their computer.',
    'zh-TW': () => 'session 啟動時 Claude Code 沒有回應。請主人在自己電腦的終端機確認 `claude` 可以執行。',
  }),
  'session.claude.tooOld': message({ found: 'string', min: 'string' }, {
    en: (p) => `Claude Code on the host's computer is version ${p.found}. Agent sessions need ${p.min} or newer. The host should update Claude Code.`,
    'zh-TW': (p) => `主人電腦上的 Claude Code 是 ${p.found} 版，agent session 需要 ${p.min} 以上的版本，請主人更新 Claude Code`,
  }),
  'session.claude.notLoggedIn': message({}, {
    en: () => "Claude Code is not logged in on the host's computer, so no agent session can be started. The host must run `claude` and log in.",
    'zh-TW': () => '主人電腦上的 Claude Code 尚未登入，無法啟動 agent session。主人需要執行 `claude` 並登入',
  }),
  'session.retry.notFailed': message({}, {
    en: () => 'This session has not failed.',
    'zh-TW': () => '這個 session 沒有失敗',
  }),
  'session.retry.hostOnly': message({}, {
    en: () => 'This session failed to start three times. Only the host can try again.',
    'zh-TW': () => '這個 session 連續三次啟動失敗，只有主人可以再試',
  }),
  'session.worktreeGone': message({}, {
    en: () => "This session's worktree was removed. It cannot continue.",
    'zh-TW': () => '這個 session 的 worktree 已被移除，無法繼續',
  }),
  'session.folderNotNameable': message({}, {
    en: () => "The path of this session's folder has a backslash or a control character in it. Claude Code's permission rules cannot name such a folder, so no agent session can be started there. The host should rename the folder.",
    'zh-TW': () => '這個 session 的資料夾路徑含有反斜線或控制字元，Claude Code 的權限規則無法表示這樣的資料夾，所以無法在這裡啟動 agent session。請主人重新命名資料夾',
  }),
  'session.mode.fixed': message({}, {
    en: () => "A discussion session's permissions are fixed: it reads the code and writes only the spec and the plan.",
    'zh-TW': () => '討論 session 的權限是固定的：只能讀程式碼，並且只能寫 spec 和計畫',
  }),
  'session.end.notAllowed': message({}, {
    en: () => 'Only the host, or a member with agent access who opened this session or is responsible for it, can end it.',
    'zh-TW': () => '只有主人，或開啟這個 session、或負責它的「可使用 agent」成員可以結束它',
  }),
  'session.end.discussion': message({}, {
    en: () => "A topic's discussion cannot be ended. Archive the topic, or restart the discussion.",
    'zh-TW': () => '主題的討論不能結束。請封存主題，或重新開始討論',
  }),
  'session.text.invalid': message({}, {
    en: () => 'The message is blank, or too long once hidden characters are removed.',
    'zh-TW': () => '訊息是空白的，或是移除隱藏字元後仍然太長',
  }),
  'responsible.notEligible': message({ name: 'string' }, {
    en: (p) => `${p.name} cannot be responsible: viewers only watch.`,
    'zh-TW': (p) => `${p.name} 不能當負責人：「旁觀」只能觀看`,
  }),
  'responsible.unknownMember': message({}, {
    en: () => 'That person is not a member of this workspace.',
    'zh-TW': () => '這個人不是這個工作區的成員',
  }),
  'rule.notAllowed': message({}, {
    en: () => 'This kind of command cannot be always allowed.',
    'zh-TW': () => '這類指令不能設為一律允許',
  }),
  'rule.limit': message({ max: 'number' }, {
    en: (p) => `There are already ${p.max} always-allowed kinds here. Remove one first.`,
    'zh-TW': (p) => `這裡已經有 ${p.max} 個一律允許的類型，請先移除一個`,
  }),
  'rule.notFound': message({}, {
    en: () => 'That always-allowed kind was not found.',
    'zh-TW': () => '找不到這個一律允許的類型',
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
    en: () => 'The suggestion is blank, or too long once hidden characters are removed.',
    'zh-TW': () => '建議內容是空白的，或是移除隱藏字元後仍然太長',
  }),
  'suggest.terminal': message({}, {
    en: () => 'Suggestions go to agent sessions, not to terminals.',
    'zh-TW': () => '建議只能送給 agent session，不能送給終端機',
  }),
  'suggest.tooManyPending': message({ max: 'number' }, {
    en: (p) => `You have ${p.max} suggestions waiting in this session. Wait for a decision or withdraw one.`,
    'zh-TW': (p) => `你在這個 session 已經有 ${p.max} 則建議等待處理，請等候決定或撤回其中一則`,
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
