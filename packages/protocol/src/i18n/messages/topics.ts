// Topics, the plan, result reports and the host's Claude Code settings: refusals and the lines of a file check
// (`topic.*`, `plan.*`, `report.*`, `claudeConfig.*`, `hostRules.*`). `plan.error.*` / `plan.warning.*` /
// `report.error.*` say what is wrong in PLAN.md or a report for PEOPLE; the same finding for the model is a separate
// fixed English sentence in the daemon. Enumerated values with their own wording: the report outcomes.
import { joinList, message } from '../define.ts';

export const topics = {
  // ---- topics -------------------------------------------------------------------------------------------------
  'topic.notFound': message({}, {
    en: () => 'That topic was not found.',
    'zh-TW': () => '找不到這個主題',
  }),
  'topic.slugTaken': message({}, {
    en: () => 'Another topic already uses this folder.',
    'zh-TW': () => '已經有主題使用這個資料夾',
  }),
  'topic.folderExists': message({ path: 'string' }, {
    en: (p) => `The folder ${p.path} already exists. Choose another name.`,
    'zh-TW': (p) => `資料夾 ${p.path} 已經存在，請換一個名稱`,
  }),
  'topic.badSlug': message({}, {
    en: () => 'Use lower-case letters, digits and hyphens for the folder name.',
    'zh-TW': () => '資料夾名稱請使用小寫英文字母、數字和連字號',
  }),
  'topic.limit': message({ max: 'number' }, {
    en: (p) => `This workspace already has ${p.max} topics. Archive or delete some first.`,
    'zh-TW': (p) => `這個工作區已經有 ${p.max} 個主題，請先封存或刪除一些`,
  }),
  'topic.archived': message({}, {
    en: () => 'This topic is archived. Restore it to continue.',
    'zh-TW': () => '這個主題已封存，還原後才能繼續',
  }),
  'topic.archive.unmerged': message({ count: 'number' }, {
    en: (p) => `${p.count} ${p.count === 1 ? 'work item has' : 'work items have'} changes that were never merged. Choose whether to keep or delete them.`,
    'zh-TW': (p) => `有 ${p.count} 個工作項目的變更還沒合併，請選擇要保留還是刪除`,
  }),
  'topic.delete.notArchived': message({}, {
    en: () => 'Archive the topic before you delete it.',
    'zh-TW': () => '刪除前請先封存主題',
  }),
  'topic.delete.openMerge': message({}, {
    en: () => 'A merge request of this topic is still waiting. Decide it first.',
    'zh-TW': () => '這個主題還有合併請求在等待，請先處理',
  }),
  'topic.noSpec': message({}, {
    en: () => 'There is no spec yet. Discuss with the agent first, or ask it to write the spec.',
    'zh-TW': () => '還沒有 spec。請先和 agent 討論，或請它寫 spec',
  }),
  'topic.noDiscussion': message({}, {
    en: () => "This topic's discussion is closed. Restart the discussion to go on.",
    'zh-TW': () => '這個主題的討論已結束，請重新開始討論才能繼續',
  }),
  'topic.notStarted': message({}, {
    en: () => 'Topics are not ready yet.',
    'zh-TW': () => '主題功能尚未就緒',
  }),

  // ---- the plan: what is wrong in PLAN.md -----------------------------------------------------------------------
  'plan.none': message({}, {
    en: () => 'There is no plan yet.',
    'zh-TW': () => '還沒有計畫',
  }),
  'plan.error.noBlock': message({}, {
    en: () => 'PLAN.md has no work item block (the two smurg:plan marker lines).',
    'zh-TW': () => 'PLAN.md 裡沒有工作項目區塊（兩行 smurg:plan 標記）',
  }),
  'plan.error.unclosed': message({ line: 'number' }, {
    en: (p) => `The work item block that starts at line ${p.line} is not closed.`,
    'zh-TW': (p) => `從第 ${p.line} 行開始的工作項目區塊沒有結束`,
  }),
  'plan.error.heading': message({ line: 'number' }, {
    en: (p) => `Line ${p.line}: a work item starts with a heading like "### 1. Title".`,
    'zh-TW': (p) => `第 ${p.line} 行：工作項目要以「### 1. 標題」這樣的標題開始`,
  }),
  'plan.error.field': message({ line: 'number' }, {
    en: (p) => `Line ${p.line}: this is not a field of a work item. The fields are id, depends on, size and touches.`,
    'zh-TW': (p) => `第 ${p.line} 行：這不是工作項目的欄位。欄位有 id、depends on、size 和 touches`,
  }),
  'plan.error.missingId': message({ line: 'number' }, {
    en: (p) => `Line ${p.line}: this work item has no id.`,
    'zh-TW': (p) => `第 ${p.line} 行：這個工作項目沒有 id`,
  }),
  'plan.error.badId': message({ line: 'number' }, {
    en: (p) => `Line ${p.line}: an id uses lower-case letters, digits and hyphens.`,
    'zh-TW': (p) => `第 ${p.line} 行：id 請使用小寫英文字母、數字和連字號`,
  }),
  'plan.error.duplicateId': message({ line: 'number', id: 'string' }, {
    en: (p) => `Line ${p.line}: the id "${p.id}" is used twice.`,
    'zh-TW': (p) => `第 ${p.line} 行：id「${p.id}」重複了`,
  }),
  'plan.error.unknownDependency': message({ line: 'number' }, {
    en: (p) => `Line ${p.line}: "depends on" names something that is not a work item of this plan.`,
    'zh-TW': (p) => `第 ${p.line} 行：「depends on」寫了不在這份計畫裡的工作項目`,
  }),
  'plan.error.cycle': message({ ids: 'list' }, {
    en: (p) => `Work items depend on each other in a circle: ${joinList('en', p.ids)}.`,
    'zh-TW': (p) => `工作項目互相依賴成一個循環：${joinList('zh-TW', p.ids)}`,
  }),
  'plan.error.size': message({ line: 'number' }, {
    en: (p) => `Line ${p.line}: size is s, m or l.`,
    'zh-TW': (p) => `第 ${p.line} 行：size 只能是 s、m 或 l`,
  }),
  'plan.error.tooMany': message({ max: 'number' }, {
    en: (p) => `A plan has at most ${p.max} work items.`,
    'zh-TW': (p) => `一份計畫最多 ${p.max} 個工作項目`,
  }),
  'plan.error.empty': message({}, {
    en: () => 'The plan has no work items.',
    'zh-TW': () => '計畫裡沒有工作項目',
  }),
  'plan.warning.overlap': message({ first: 'number', second: 'number' }, {
    en: (p) => `Items ${p.first} and ${p.second} may change the same files and neither waits for the other.`,
    'zh-TW': (p) => `項目 ${p.first} 和 ${p.second} 可能會改到相同的檔案，而且彼此沒有先後順序`,
  }),
  'plan.warning.noSummary': message({ number: 'number' }, {
    en: (p) => `Item ${p.number} has no description.`,
    'zh-TW': (p) => `項目 ${p.number} 沒有說明`,
  }),

  // ---- the plan: starting --------------------------------------------------------------------------------------
  'plan.start.invalid': message({}, {
    en: () => 'Fix PLAN.md before you start.',
    'zh-TW': () => '開始前請先修正 PLAN.md',
  }),
  'plan.start.nothing': message({}, {
    en: () => 'No work item can start now.',
    'zh-TW': () => '目前沒有可以開始的工作項目',
  }),
  'plan.start.changed': message({}, {
    en: () => 'The spec or the plan changed since you opened this. Look at it again before you start.',
    'zh-TW': () => 'spec 或計畫在你開啟之後有變動，開始前請再看一次',
  }),
  'plan.start.noGit': message({}, {
    en: () => 'Work items run in git worktrees, and this folder is not a git repository yet. The host can make it one: run `git init`, then commit once.',
    'zh-TW': () => '工作項目在 git worktree 裡執行，而這個資料夾還不是 git 儲存庫。主人可以執行 `git init` 並提交一次',
  }),
  'plan.start.worktreeLimit': message({ max: 'number' }, {
    en: (p) => `There is no room for more worktrees (${p.max}). Merge or archive finished work first.`,
    'zh-TW': (p) => `worktree 數量已達上限（${p.max}），請先合併或封存已完成的工作`,
  }),
  'plan.start.commit.busy': message({}, {
    en: () => 'The spec and the plan could not be committed: git is in the middle of another operation in the main workspace.',
    'zh-TW': () => '無法提交 spec 和計畫：主工作區的 git 正在進行其他操作',
  }),
  'plan.start.commit.ignored': message({ path: 'string' }, {
    en: (p) => `The spec and the plan could not be committed: git ignores ${p.path}.`,
    'zh-TW': (p) => `無法提交 spec 和計畫：git 忽略了 ${p.path}`,
  }),
  'plan.start.commit.failed': message({ step: 'string' }, {
    en: (p) => `The spec and the plan could not be committed (${p.step}).`,
    'zh-TW': (p) => `無法提交 spec 和計畫（${p.step}）`,
  }),
  'plan.paused': message({}, {
    en: () => "smurg was restarted on the host's computer. This plan is paused.",
    'zh-TW': () => '主人電腦上的 smurg 重新啟動了，這份計畫已暫停',
  }),
  'plan.item.disarmed.changed': message({}, {
    en: () => 'The spec or the plan changed since Start. This item did not start.',
    'zh-TW': () => 'spec 或計畫在開始之後有變動，這個項目沒有開始',
  }),
  'plan.item.disarmed.starter': message({ name: 'string' }, {
    en: (p) => `${p.name}, who started this plan, was removed. This item did not start.`,
    'zh-TW': (p) => `開始這份計畫的 ${p.name} 已被移出，這個項目沒有開始`,
  }),
  'plan.item.unknown': message({}, {
    en: () => 'This work item is not in the plan.',
    'zh-TW': () => '計畫裡沒有這個工作項目',
  }),
  'plan.item.started': message({}, {
    en: () => 'This work item was already started.',
    'zh-TW': () => '這個工作項目已經開始了',
  }),
  'plan.item.notRetryable': message({}, {
    en: () => 'Only a failed or stopped work item can be tried again.',
    'zh-TW': () => '只有失敗或已停止的工作項目可以再試一次',
  }),
  'plan.item.noSession': message({}, {
    en: () => 'This work item has no session to continue.',
    'zh-TW': () => '這個工作項目沒有可以繼續的 session',
  }),
  'plan.item.noConflict': message({}, {
    en: () => 'This work item has no merge conflict to resolve.',
    'zh-TW': () => '這個工作項目沒有需要解決的合併衝突',
  }),

  // ---- result reports ------------------------------------------------------------------------------------------
  'report.none': message({}, {
    en: () => 'This work item has no result report yet.',
    'zh-TW': () => '這個工作項目還沒有結果報告',
  }),
  'report.changed': message({}, {
    en: () => 'The report changed since you opened it. Read the new version first.',
    'zh-TW': () => '報告在你開啟之後有變動，請先閱讀新版本',
  }),
  'report.notReviewer': message({ name: 'string' }, {
    en: (p) => `${p.name} reviews this report.`,
    'zh-TW': (p) => `這份報告由 ${p.name} 檢視`,
  }),
  'report.unfinished': message({}, {
    en: () => 'This work item is not finished. Confirm that you want to mark it reviewed anyway.',
    'zh-TW': () => '這個工作項目還沒完成。請確認仍要標記為已看過',
  }),
  'report.closed': message({}, {
    en: () => "This item is merged and reviewed. Ask in the topic's discussion.",
    'zh-TW': () => '這個項目已合併並看過，請到主題的討論裡提問',
  }),
  'report.error.format': message({ line: 'number' }, {
    en: (p) => `The result report does not follow the fixed format (line ${p.line}).`,
    'zh-TW': (p) => `結果報告不符合固定格式（第 ${p.line} 行）`,
  }),
  'report.error.outcome': message({ line: 'number' }, {
    en: (p) => `Line ${p.line}: the outcome is complete, partial or blocked.`,
    'zh-TW': (p) => `第 ${p.line} 行：outcome 只能是 complete、partial 或 blocked`,
  }),
  'report.changes.hostOnly': message({}, {
    en: () => 'The changes cannot be shown: the worktree contains files only the host may change.',
    'zh-TW': () => '無法顯示變更：worktree 裡有只有主人可以修改的檔案',
  }),
  'report.changes.specFiles': message({}, {
    en: () => "The changes cannot be shown: they touch the topic's SPEC.md or PLAN.md.",
    'zh-TW': () => '無法顯示變更：變更動到了主題的 SPEC.md 或 PLAN.md',
  }),
  'report.changes.markers': message({ files: 'list' }, {
    en: (p) => `The changes cannot be recorded yet: conflict markers remain in ${joinList('en', p.files)}.`,
    'zh-TW': (p) => `還不能記錄變更：${joinList('zh-TW', p.files)} 裡還有衝突標記`,
  }),
  'report.outcome.complete': message({}, {
    en: () => 'Complete',
    'zh-TW': () => '完成',
  }),
  'report.outcome.partial': message({}, {
    en: () => 'Partial',
    'zh-TW': () => '部分完成',
  }),
  'report.outcome.blocked': message({}, {
    en: () => 'Blocked',
    'zh-TW': () => '受阻',
  }),

  // ---- Claude Code on the host ---------------------------------------------------------------------------------
  'claudeConfig.confirmNeeded': message({}, {
    en: () => "The host must first confirm this folder's Claude Code project settings.",
    'zh-TW': () => '主人需要先確認這個資料夾的 Claude Code 專案設定',
  }),
  'claudeConfig.changed': message({}, {
    en: () => 'The Claude Code project settings changed since they were confirmed.',
    'zh-TW': () => 'Claude Code 專案設定在確認之後有變動',
  }),
  'claudeConfig.ackNeeded': message({}, {
    en: () => 'Tick what these settings do before you use them.',
    'zh-TW': () => '使用前請先勾選這些設定會做的事',
  }),
  'hostRules.found': message({ count: 'number' }, {
    en: (p) => `Your own Claude Code settings allow ${p.count} ${p.count === 1 ? 'kind' : 'kinds'} of commands without asking. Agents here run them without asking too.`,
    'zh-TW': (p) => `你自己的 Claude Code 設定允許 ${p.count} 類指令不經詢問就執行，這裡的 agent 也會直接執行`,
  }),
} as const;
