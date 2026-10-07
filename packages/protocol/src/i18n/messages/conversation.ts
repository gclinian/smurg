// The conversation of an agent session: system lines (`conversation.*`), notices (`notice.*`, and the `session.*`
// notices about a session's own state), and the refusals of questions and permission requests (`question.*`,
// `permission.*`). A line or notice travels as a reference with its English rendering (`fallback`).
// Enumerated values with their own wording: the permission modes (`permissionMode.*`).
import { joinList, message } from '../define.ts';

/** English names in front of a verb: `Amy`, `Amy and Mei`, `Amy, Mei and Leo`. */
function namesEn(names: readonly string[]): string {
  const last = names.at(-1);
  return names.length < 2 || last === undefined ? joinList('en', names) : `${joinList('en', names.slice(0, -1))} and ${last}`;
}

/** `PermissionMode` values, worded as they read inside a sentence. */
const MODE_PHRASES: Readonly<Record<string, { readonly en: string; readonly 'zh-TW': string }>> = {
  'ask-commands': {
    en: 'asks before commands',
    'zh-TW': '執行指令前先問',
  },
  'ask-all': {
    en: 'asks before edits and commands',
    'zh-TW': '編輯和執行指令前都先問',
  },
};

export const conversation = {
  // ---- how a session began ------------------------------------------------------------------------------------
  'conversation.started.discussion': message({ name: 'string' }, {
    en: (p) => `${p.name} started the discussion`,
    'zh-TW': (p) => `${p.name} 開始了討論`,
  }),
  'conversation.discussion.restarted': message({ name: 'string' }, {
    en: (p) => `${p.name} started a new discussion for this topic`,
    'zh-TW': (p) => `${p.name} 為這個主題重新開始了討論`,
  }),
  'conversation.discussion.replaced': message({}, {
    en: () => 'A new discussion was started for this topic. This one is closed',
    'zh-TW': () => '這個主題已經開始新的討論，這一段已結束',
  }),
  'conversation.started.free': message({ name: 'string' }, {
    en: (p) => `${p.name} opened this session`,
    'zh-TW': (p) => `${p.name} 開啟了這個 session`,
  }),
  'conversation.started.item': message({ number: 'number', branch: 'string' }, {
    en: (p) => `Started from plan item ${p.number} in the worktree ${p.branch}`,
    'zh-TW': (p) => `從計畫項目 ${p.number} 開始，worktree：${p.branch}`,
  }),
  'conversation.retry': message({ name: 'string', attempt: 'number' }, {
    en: (p) => `${p.name} started this item again (attempt ${p.attempt})`,
    'zh-TW': (p) => `${p.name} 重新開始這個項目（第 ${p.attempt} 次）`,
  }),
  'conversation.retry.resumed': message({ name: 'string' }, {
    en: (p) => `${p.name} started this session again`,
    'zh-TW': (p) => `${p.name} 重新啟動了這個 session`,
  }),

  // ---- what smurg was asked to tell the agent -------------------------------------------------------------------
  'conversation.specRequested': message({ name: 'string' }, {
    en: (p) => `${p.name} asked for the first draft of the spec`,
    'zh-TW': (p) => `${p.name} 請 agent 寫 spec 初版`,
  }),
  'conversation.planRequested': message({ name: 'string' }, {
    en: (p) => `${p.name} asked for the plan`,
    'zh-TW': (p) => `${p.name} 請 agent 產生計畫`,
  }),
  'conversation.planUpdateRequested': message({ name: 'string' }, {
    en: (p) => `${p.name} asked to update the plan`,
    'zh-TW': (p) => `${p.name} 請 agent 更新計畫`,
  }),
  'conversation.continueRequested': message({ name: 'string' }, {
    en: (p) => `${p.name} asked the agent to continue`,
    'zh-TW': (p) => `${p.name} 請 agent 繼續`,
  }),
  'conversation.resolveRequested': message({ name: 'string' }, {
    en: (p) => `${p.name} asked the agent to resolve the merge conflict`,
    'zh-TW': (p) => `${p.name} 請 agent 解決合併衝突`,
  }),
  'conversation.conflict.merged': message({ count: 'number' }, {
    en: (p) => `smurg merged the main workspace into this worktree: ${p.count} ${p.count === 1 ? 'file has' : 'files have'} conflicts`,
    'zh-TW': (p) => `smurg 已把主工作區合併進這個 worktree：${p.count} 個檔案有衝突`,
  }),
  'conversation.fix.plan': message({}, {
    en: () => 'smurg asked Claude to fix the work items in PLAN.md',
    'zh-TW': () => 'smurg 請 Claude 修正 PLAN.md 裡的工作項目',
  }),
  'conversation.fix.report': message({}, {
    en: () => 'smurg asked Claude to fix the format of the result report',
    'zh-TW': () => 'smurg 請 Claude 修正結果報告的格式',
  }),
  'conversation.nudge.report': message({}, {
    en: () => 'smurg asked Claude for the result report',
    'zh-TW': () => 'smurg 請 Claude 寫結果報告',
  }),

  // ---- stops, ends, people -------------------------------------------------------------------------------------
  'conversation.stopped': message({ name: 'string' }, {
    en: (p) => `${p.name} stopped the agent`,
    'zh-TW': (p) => `${p.name} 停止了 agent`,
  }),
  'conversation.ended': message({ name: 'string' }, {
    en: (p) => `${p.name} ended this session`,
    'zh-TW': (p) => `${p.name} 結束了這個 session`,
  }),
  'conversation.interrupted.restart': message({}, {
    en: () => "smurg was restarted on the host's computer. The agent's turn was interrupted",
    'zh-TW': () => '主人電腦上的 smurg 重新啟動了，agent 的這一輪被中斷',
  }),
  'conversation.responsible.changed': message({ by: 'string', name: 'string' }, {
    en: (p) => `${p.by} made ${p.name} responsible for this session`,
    'zh-TW': (p) => `${p.by} 將 ${p.name} 設為這個 session 的負責人`,
  }),
  'conversation.responsible.cleared': message({ by: 'string' }, {
    en: (p) => `${p.by} left this session without a responsible person`,
    'zh-TW': (p) => `${p.by} 將這個 session 設為不指派負責人`,
  }),
  'conversation.responsible.fallback': message({ name: 'string' }, {
    en: (p) => `${p.name} can no longer be responsible. The host decides now`,
    'zh-TW': (p) => `${p.name} 已無法擔任負責人，改由主人決定`,
  }),
  'conversation.submittedFor': message({ by: 'string', name: 'string' }, {
    en: (p) => `${p.by} submitted the answer: ${p.name} was away`,
    'zh-TW': (p) => `${p.by} 代為送出答案：${p.name} 不在`,
  }),
  'conversation.owner.handover': message({ name: 'string' }, {
    en: (p) => `${p.name} left. This session now runs for the host`,
    'zh-TW': (p) => `${p.name} 已離開，這個 session 改由主人接手`,
  }),
  'conversation.owner.handover.kicked': message({ name: 'string' }, {
    en: (p) => `${p.name} was removed. This session was stopped and now runs for the host`,
    'zh-TW': (p) => `${p.name} 已被移出，這個 session 已停止，改由主人接手`,
  }),

  // ---- permission mode and always-allowed kinds -----------------------------------------------------------------
  'conversation.mode.changed': message({ by: 'string', mode: 'string' }, {
    en: (p) => `${p.by} changed the permission mode: ${MODE_PHRASES[p.mode]?.en ?? p.mode}`,
    'zh-TW': (p) => `${p.by} 變更了權限模式：${MODE_PHRASES[p.mode]?.['zh-TW'] ?? p.mode}`,
  }),
  'conversation.mode.reset': message({ name: 'string' }, {
    en: (p) => `The permission mode is back to its default: ${p.name}, who changed it, was removed or lost agent access`,
    'zh-TW': (p) => `權限模式已恢復預設：變更它的 ${p.name} 已被移出或失去 agent 使用權`,
  }),
  'conversation.rule.added': message({ by: 'string', rule: 'string' }, {
    en: (p) => `${p.by} always allows ${p.rule} in this session`,
    'zh-TW': (p) => `${p.by} 在這個 session 一律允許 ${p.rule}`,
  }),
  'conversation.rule.added.topic': message({ by: 'string', rule: 'string' }, {
    en: (p) => `${p.by} always allows ${p.rule} in every session of this topic`,
    'zh-TW': (p) => `${p.by} 在這個主題的所有 session 一律允許 ${p.rule}`,
  }),
  'conversation.rule.removed': message({ by: 'string', rule: 'string' }, {
    en: (p) => `${p.by} removed the always-allowed kind ${p.rule}`,
    'zh-TW': (p) => `${p.by} 移除了一律允許的類型 ${p.rule}`,
  }),
  'conversation.rule.removed.member': message({ name: 'string', rule: 'string' }, {
    en: (p) => `${p.rule} is no longer always allowed: ${p.name}, who allowed it, was removed or lost agent access`,
    'zh-TW': (p) => `${p.rule} 不再一律允許：允許它的 ${p.name} 已被移出或失去 agent 使用權`,
  }),
  'conversation.agent.restarting': message({}, {
    en: () => 'The agent starts again with the new settings at its next message',
    'zh-TW': () => 'agent 會在下一則訊息時以新設定重新啟動',
  }),
  'conversation.locked.spec': message({ path: 'string', holders: 'list' }, {
    en: (p) => `Claude waits to edit ${p.path}: ${namesEn(p.holders)} ${p.holders.length === 1 ? 'is' : 'are'} typing in it.`,
    'zh-TW': (p) => `Claude 正在等待編輯 ${p.path}：${joinList('zh-TW', p.holders)} 正在輸入`,
  }),
  'conversation.redacted': message({}, {
    en: () => 'The host removed this entry.',
    'zh-TW': () => '主人已移除這則內容',
  }),

  // ---- notices about the session itself -------------------------------------------------------------------------
  'session.resume.lost': message({}, {
    en: () => 'Claude Code no longer keeps the earlier conversation. Claude starts again from the files.',
    'zh-TW': () => 'Claude Code 已不再保留先前的對話，Claude 會從檔案重新開始',
  }),
  'session.projectSettings.untrusted': message({}, {
    en: () => "The host has not confirmed this folder's Claude Code project settings. This session runs without them and without the project's CLAUDE.md.",
    'zh-TW': () => '主人尚未確認這個資料夾的 Claude Code 專案設定，這個 session 不會載入它們，也不會載入專案的 CLAUDE.md。',
  }),
  'session.projectSettings.changed': message({}, {
    en: () => "This folder's Claude Code project settings changed. The agent was stopped until the host confirms them.",
    'zh-TW': () => '這個資料夾的 Claude Code 專案設定有變動，agent 已停止，等主人確認',
  }),
  'notice.apiRetry': message({ error: 'string', attempt: 'number', max: 'number' }, {
    en: (p) => `The Claude API did not answer (${p.error}). Claude Code is trying again (${p.attempt} of ${p.max}).`,
    'zh-TW': (p) => `Claude API 沒有回應（${p.error}），Claude Code 正在重試（第 ${p.attempt} 次，共 ${p.max} 次）。`,
  }),
  'notice.authRejected': message({}, {
    en: () => "Anthropic rejected the host's Claude Code login. The host must log in again in their own terminal.",
    'zh-TW': () => 'Anthropic 拒絕了主人的 Claude Code 登入，主人需要在自己的終端機重新登入。',
  }),
  'notice.notLoggedIn': message({}, {
    en: () => "Claude Code is not logged in on the host's computer. The host must run `claude` and log in.",
    'zh-TW': () => '主人電腦上的 Claude Code 尚未登入，主人需要執行 `claude` 並登入。',
  }),
  'notice.rateLimit': message({}, {
    en: () => "The host's Claude account has reached a usage limit.",
    'zh-TW': () => '主人的 Claude 帳號已達用量上限。',
  }),
  'notice.compacted': message({}, {
    en: () => 'Claude Code shortened the earlier conversation to make room.',
    'zh-TW': () => 'Claude Code 為了騰出空間，縮短了較早的對話內容。',
  }),
  'notice.processExited': message({ code: 'number' }, {
    en: (p) => `The agent's process ended unexpectedly (exit code ${p.code}).`,
    'zh-TW': (p) => `agent 的程序意外結束（結束代碼 ${p.code}）。`,
  }),
  'notice.unattended': message({}, {
    en: () => 'smurg stopped while this agent was working. The agent may have gone on for a moment by itself: check its changes.',
    'zh-TW': () => 'smurg 在這個 agent 工作時停止了。agent 可能自己又繼續了一會兒，請檢查它的變更。',
  }),
  'notice.turnError': message({}, {
    en: () => "The agent's turn ended with an error.",
    'zh-TW': () => 'agent 的這一輪因錯誤而結束。',
  }),
  'notice.transcriptTrimmed': message({}, {
    en: () => 'The oldest part of this conversation is no longer kept.',
    'zh-TW': () => '這段對話最早的部分已不再保留。',
  }),
  'notice.personalSubscription': message({}, {
    en: () =>
      "Agents here use your personal Claude subscription. Anthropic's terms do not allow making a personal account available to other people; for a group, use an API key, a Team or Enterprise plan, or a cloud provider.",
    'zh-TW': () => '這裡的 agent 使用你個人的 Claude 訂閱。Anthropic 的條款不允許把個人帳號提供給其他人使用；多人使用請改用 API 金鑰、Team 或 Enterprise 方案，或雲端供應商。',
  }),

  // ---- questions ----------------------------------------------------------------------------------------------
  'question.notFound': message({}, {
    en: () => 'That question was not found.',
    'zh-TW': () => '找不到這個選擇題',
  }),
  'question.notOpen': message({}, {
    en: () => 'This question was already answered or withdrawn.',
    'zh-TW': () => '這個選擇題已經回答或撤回了',
  }),
  'question.notDecider': message({ name: 'string' }, {
    en: (p) => `${p.name} decides this question.`,
    'zh-TW': (p) => `這個選擇題由 ${p.name} 決定`,
  }),
  'question.otherNeedsAgentAccess': message({}, {
    en: () => 'Only the host or a member with agent access can submit an answer or a note in their own words.',
    'zh-TW': () => '只有主人或「可使用 agent」的成員可以送出自行輸入的答案或備註',
  }),
  'question.incomplete': message({}, {
    en: () => 'Every question needs an answer before you submit.',
    'zh-TW': () => '每一題都要有答案才能送出',
  }),
  'question.unknownOption': message({}, {
    en: () => 'That option is not part of this question.',
    'zh-TW': () => '這個選項不在這一題裡',
  }),
  'question.tooManyComments': message({ max: 'number' }, {
    en: (p) => `This question already has ${p.max} comments.`,
    'zh-TW': (p) => `這個選擇題已經有 ${p.max} 則留言`,
  }),
  'question.tooManyVoters': message({ max: 'number' }, {
    en: (p) => `This question already has votes from ${p.max} members.`,
    'zh-TW': (p) => `這個選擇題已經有 ${p.max} 位成員投票`,
  }),
  'question.remind.tooSoon': message({}, {
    en: () => 'You reminded them a moment ago.',
    'zh-TW': () => '你剛剛才提醒過',
  }),

  // ---- permission requests ------------------------------------------------------------------------------------
  'permission.notFound': message({}, {
    en: () => 'That permission request was not found.',
    'zh-TW': () => '找不到這個權限請求',
  }),
  'permission.notOpen': message({}, {
    en: () => 'This permission request was already answered or withdrawn.',
    'zh-TW': () => '這個權限請求已經回答或撤回了',
  }),
  'permission.hostOnly': message({}, {
    en: () => 'Only the host can allow this: it reaches beyond the shared project.',
    'zh-TW': () => '只有主人可以允許：它會動到共用專案以外的地方',
  }),
  'permission.noAlways': message({}, {
    en: () => 'This kind of request cannot be always allowed.',
    'zh-TW': () => '這類請求不能設為一律允許',
  }),
  'permission.topicScope': message({}, {
    en: () => 'You cannot allow this for the whole topic.',
    'zh-TW': () => '你不能為整個主題設定一律允許',
  }),
  'permission.fileBusy': message({ holders: 'list' }, {
    en: (p) => `Not allowed yet: ${joinList('en', p.holders)} ${p.holders.length === 1 ? 'is' : 'are'} typing in that file.`,
    'zh-TW': (p) => `還不能允許：${joinList('zh-TW', p.holders)} 正在那個檔案輸入`,
  }),

  // ---- the two permission modes, as labels ----------------------------------------------------------------------
  'permissionMode.askCommands': message({}, {
    en: () => 'Asks before commands',
    'zh-TW': () => '執行指令前先問',
  }),
  'permissionMode.askAll': message({}, {
    en: () => 'Asks before edits and commands',
    'zh-TW': () => '編輯和執行指令前都先問',
  }),
} as const;
