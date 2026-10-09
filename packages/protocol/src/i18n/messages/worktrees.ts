// Worktrees, merge requests and git: error texts (`worktree.*`, `merge.*`, `git.*`).
import { joinList, message, plural } from '../define.ts';

/** The git steps a failure can name (`git.stepFailed`, `git.outputTooLarge`, `git.objectUnreadable`; also `detail.step`). */
export const GIT_STEPS = [
  'mergeBase',
  'listChanges',
  'countLines',
  'diff',
  'readSymlinks',
  'readCommit',
  'stage',
  'checkChanges',
  'commit',
  'checkCommit',
  'createWorktree',
  'configureWorktree',
  'checkout',
  'fetchChanges',
  'trialMerge',
  'listMergeChanges',
  'checkMain',
] as const;
export type GitStep = (typeof GIT_STEPS)[number];

const GIT_STEP_NAMES: Readonly<Record<GitStep, { readonly en: string; readonly 'zh-TW': string }>> = {
  mergeBase: {
    en: 'Finding the common ancestor',
    'zh-TW': '找出共同祖先',
  },
  listChanges: {
    en: 'Listing the changed files',
    'zh-TW': '列出變更的檔案',
  },
  countLines: {
    en: 'Counting the changed lines',
    'zh-TW': '計算變更行數',
  },
  diff: {
    en: 'Making the diff',
    'zh-TW': '產生 diff',
  },
  readSymlinks: {
    en: 'Reading the symbolic links',
    'zh-TW': '讀取符號連結',
  },
  readCommit: {
    en: 'Reading the commit',
    'zh-TW': '讀取 commit',
  },
  stage: {
    en: "Staging the worktree's changes",
    'zh-TW': '暫存 worktree 的變更',
  },
  checkChanges: {
    en: "Checking the worktree's changes",
    'zh-TW': '檢查 worktree 的變更',
  },
  commit: {
    en: "Committing the worktree's changes",
    'zh-TW': '提交 worktree 的變更',
  },
  checkCommit: {
    en: 'Checking the committed content',
    'zh-TW': '檢查提交的內容',
  },
  createWorktree: {
    en: 'Creating the worktree',
    'zh-TW': '建立 worktree',
  },
  configureWorktree: {
    en: 'Setting up the worktree',
    'zh-TW': '設定 worktree',
  },
  checkout: {
    en: 'Checking out the files',
    'zh-TW': '取出檔案',
  },
  fetchChanges: {
    en: 'Fetching the changes into the main workspace',
    'zh-TW': '把變更取回主工作區',
  },
  trialMerge: {
    en: 'Trying the merge',
    'zh-TW': '試算合併',
  },
  listMergeChanges: {
    en: 'Listing the files the merge would change',
    'zh-TW': '列出合併會改的檔案',
  },
  checkMain: {
    en: 'Checking the main workspace',
    'zh-TW': '檢查主工作區',
  },
};

/** A step this version does not know: still a sentence, never "undefined". */
const UNKNOWN_STEP = {
  en: (step: string) => `The git step "${step}"`,
  'zh-TW': (step: string) => `git 步驟 ${step} `,
};

function stepName(locale: 'en' | 'zh-TW', step: string): string {
  const names = Object.hasOwn(GIT_STEP_NAMES, step) ? GIT_STEP_NAMES[step as GitStep] : undefined;
  return names ? names[locale] : UNKNOWN_STEP[locale](step);
}

export const worktrees = {
  // ---- git ----------------------------------------------------------------------------------------------------
  'git.stepFailed': message({ step: 'string' }, {
    en: (p) => `${stepName('en', p.step)} failed.`,
    'zh-TW': (p) => `${stepName('zh-TW', p.step)}失敗`,
  }),
  'git.outputTooLarge': message({ step: 'string' }, {
    en: (p) => `${stepName('en', p.step)} failed: git printed too much output.`,
    'zh-TW': (p) => `${stepName('zh-TW', p.step)}：git 輸出過大`,
  }),
  'git.objectUnreadable': message({ step: 'string' }, {
    en: (p) => `${stepName('en', p.step)} failed: a git object could not be read.`,
    'zh-TW': (p) => `${stepName('zh-TW', p.step)}：無法讀取 git 物件`,
  }),
  'git.outputUnparsable': message({}, {
    en: () => "git's output could not be read.",
    'zh-TW': () => '無法解析 git 的輸出',
  }),
  'git.timeout': message({}, {
    en: () => 'git took too long.',
    'zh-TW': () => 'git 執行逾時',
  }),
  'git.failed': message({}, {
    en: () => 'git could not be run.',
    'zh-TW': () => 'git 執行失敗',
  }),

  // ---- why worktrees cannot be used (detail.reason says which) ------------------------------------------------
  // One message per reason, what is wrong, then what the host can do (0.5.2): the Start dialog's git blocker, worktree
  // refusals, the plan column and the new-session dialog all show these. The folder and its .git are looked at again
  // while sharing (a first commit or `git init` counts at once); git itself and the .smurg/worktrees folder only when
  // sharing starts, so only their sentences say to share again. zh-TW ends with a full stop: other words may follow.
  'worktree.unavailable.starting': message({}, {
    en: () => 'Worktrees are not ready yet.',
    'zh-TW': () => 'worktree 功能尚未就緒。',
  }),
  'worktree.unavailable.notAGitRepo': message({}, {
    en: () => 'The shared folder is not a git repository, so worktrees cannot be used. The host can run `git init` in it and commit once, without sharing again.',
    'zh-TW': () => '分享的資料夾不是 git 儲存庫，無法使用 worktree。主人可以在資料夾裡執行 `git init` 並提交一次，不必重新分享。',
  }),
  // The folder is no repository, and worktrees or merge requests still open (draft, pending, conflict) are on record:
  // its `.git` went while they exist. Never "run git init" here: a new repository cannot merge those requests.
  'worktree.unavailable.gitDirGone': message({}, {
    en: () => "The shared folder's .git is gone, so worktrees cannot be used. The host can put it back: the worktrees and merge requests here belong to that repository.",
    'zh-TW': () => '分享資料夾的 .git 不見了，無法使用 worktree。主人可以把它放回去：這裡的 worktree 和合併請求都屬於那個儲存庫。',
  }),
  'worktree.unavailable.noCommit': message({}, {
    en: () => "The shared folder's git repository has no commit yet, so no worktree can be created. The host can commit once, without sharing again.",
    'zh-TW': () => '分享資料夾的 git 儲存庫還沒有任何提交，無法建立 worktree。主人可以提交一次，不必重新分享。',
  }),
  'worktree.unavailable.gitDirNotDirectory': message({}, {
    en: () => "The shared folder's .git is not an ordinary folder (the folder is a git worktree or a submodule, for example), so worktrees cannot be used. The host can share the repository's main folder instead.",
    'zh-TW': () => '分享資料夾的 .git 不是一般的資料夾（例如這個資料夾本身是 git worktree 或 submodule），無法使用 worktree。主人可以改為分享儲存庫的主資料夾。',
  }),
  'worktree.unavailable.gitNotFound': message({ minVersion: 'string' }, {
    en: (p) => `git was not found on the host's computer, so worktrees cannot be used. The host can install git ${p.minVersion} or later, stop sharing, and share again from a new terminal.`,
    'zh-TW': (p) => `主人的電腦上找不到 git，無法使用 worktree。主人可以安裝 git ${p.minVersion} 以上，停止分享，再從新的終端機重新分享。`,
  }),
  'worktree.unavailable.gitTooOld': message({ version: 'string', minVersion: 'string' }, {
    en: (p) => `The host's git is version ${p.version}, and worktrees need ${p.minVersion} or later. The host can update git, stop sharing, and share again from a new terminal.`,
    'zh-TW': (p) => `主人電腦上的 git 是 ${p.version} 版，worktree 需要 ${p.minVersion} 以上。主人可以更新 git，停止分享，再從新的終端機重新分享。`,
  }),
  'worktree.unavailable.gitCannotRun': message({}, {
    en: () => "git does not run on the host's computer, so worktrees cannot be used. The host can make `git version` work in a terminal, stop sharing, and share again from that terminal.",
    'zh-TW': () => '主人電腦上的 git 無法執行，無法使用 worktree。主人可以先讓 `git version` 在終端機裡正常執行，停止分享，再從那個終端機重新分享。',
  }),
  'worktree.unavailable.worktreesDirUnusable': message({}, {
    en: () => '.smurg/worktrees in the shared folder is not an ordinary folder, so worktrees cannot be used. The host can move it out of the shared folder, stop sharing, and share again.',
    'zh-TW': () => '分享資料夾裡的 .smurg/worktrees 不是一般的資料夾，無法使用 worktree。主人可以把它移出分享的資料夾，停止分享，再重新分享。',
  }),
  'worktree.unavailable.checkFailed': message({}, {
    en: () => "smurg could not look at the shared folder's git repository just now. Try again in a moment.",
    'zh-TW': () => 'smurg 暫時無法查看分享資料夾的 git 儲存庫。請稍後再試。',
  }),

  // ---- worktrees ----------------------------------------------------------------------------------------------
  'worktree.notFound': message({}, {
    en: () => 'That worktree was not found.',
    'zh-TW': () => '找不到這個 worktree',
  }),
  'worktree.notStarted': message({}, {
    en: () => 'Worktrees are not ready yet.',
    'zh-TW': () => 'worktree 功能尚未就緒',
  }),
  'worktree.ownerOnlySessions': message({}, {
    en: () => 'Only the owner of a worktree can open sessions in it.',
    'zh-TW': () => '只有 worktree 的擁有者可以在裡面開 session',
  }),
  'worktree.usedByAnotherSession': message({}, {
    en: () => 'Another session is using this worktree.',
    'zh-TW': () => '這個 worktree 正被另一個 session 使用',
  }),
  'worktree.inUse': message({}, {
    en: () => 'A session is using this worktree. End the session first.',
    'zh-TW': () => '這個 worktree 正被 session 使用中，請先結束 session',
  }),
  'worktree.limit': message({}, {
    en: () => 'The workspace has reached its worktree limit. Delete worktrees you no longer need.',
    'zh-TW': () => 'worktree 數量已達上限，請先刪除不用的 worktree',
  }),
  'worktree.limitOwner': message({}, {
    en: () => 'You have reached your worktree limit. Delete worktrees you no longer need.',
    'zh-TW': () => '你的 worktree 數量已達上限，請先刪除不用的 worktree',
  }),
  'worktree.createFailed': message({}, {
    en: () => 'The worktree could not be created.',
    'zh-TW': () => '無法建立 worktree',
  }),
  'worktree.removeOwnerOrHost': message({}, {
    en: () => 'Only the owner of a worktree or the host can delete it.',
    'zh-TW': () => '只有 worktree 的擁有者或主人可以刪除它',
  }),
  'worktree.tampered': message({}, {
    en: () => "The worktree's git folder was changed, so smurg refused the operation to stay safe. Ask the host to check or delete this worktree.",
    'zh-TW': () => 'worktree 的 git 資料夾已被變更，為了安全已拒絕操作；請主人檢查或刪除這個 worktree',
  }),
  'worktree.changedDuringCommit': message({}, {
    en: () => 'The worktree changed again while its changes were being committed. Request the merge again in a moment.',
    'zh-TW': () => 'worktree 在提交變更時又被修改了，請稍後再提出一次合併請求',
  }),
  'worktree.changedDuringRequest': message({}, {
    en: () => 'The worktree changed while the request was being made. Try again.',
    'zh-TW': () => 'worktree 在提出請求時被變更了，請再試一次',
  }),
  'worktree.hardLink': message({ path: 'string' }, {
    en: (p) => `A file in the worktree has more than one hard link, so it cannot be committed safely: ${p.path}`,
    'zh-TW': (p) => `worktree 中的檔案有多個硬連結，為了安全無法提交：${p.path}`,
  }),
  'worktree.commitTooManyFiles': message({ max: 'number' }, {
    en: (p) => `One commit would change more than ${p.max} ${plural(p.max, 'file', 'files')}. Split it into several.`,
    'zh-TW': (p) => `一次提交的變更超過 ${p.max} 個檔案，請分成幾次`,
  }),

  // ---- merge requests -----------------------------------------------------------------------------------------
  'merge.notFound': message({}, {
    en: () => 'That merge request was not found.',
    'zh-TW': () => '找不到這個合併請求',
  }),
  'merge.notPending': message({}, {
    en: () => 'This merge request was already handled.',
    'zh-TW': () => '這個合併請求已經處理過了',
  }),
  'merge.commitGone': message({}, {
    en: () => "This merge request's commit was not found.",
    'zh-TW': () => '找不到這個合併請求的 commit',
  }),
  'merge.mainNoCommits': message({}, {
    en: () => 'The main workspace has no commit yet.',
    'zh-TW': () => '主工作區還沒有任何 commit',
  }),
  'merge.tooManyOpen': message({}, {
    en: () => 'This worktree has too many open merge requests.',
    'zh-TW': () => '這個 worktree 待處理的合併請求太多了',
  }),
  'merge.pathNotInDiff': message({}, {
    en: () => "This file is not among the merge request's changes.",
    'zh-TW': () => '這個檔案不在合併請求的變更清單中',
  }),
  'merge.mainBusy': message({}, {
    en: () => 'Another git operation (a merge, a rebase or similar) is in progress in the main workspace. Finish it, then merge.',
    'zh-TW': () => '主工作區正在進行其他 git 操作（merge、rebase 等），請先完成再合併',
  }),
  'merge.failed': message({}, {
    en: () => 'The merge failed and the main workspace was not changed. Check the state of the main workspace, then try again.',
    'zh-TW': () => '合併失敗，主工作區沒有被修改；請檢查主工作區的狀態後再試',
  }),
  'merge.unrelatedHistories': message({}, {
    en: () => 'This worktree shares no history with the main workspace, so it cannot be merged.',
    'zh-TW': () => '這個 worktree 與主工作區沒有共同的歷史，無法合併',
  }),
  'merge.unsupportedPath': message({}, {
    en: () => 'A changed file has a name that cannot be shown, so this merge request cannot be reviewed.',
    'zh-TW': () => '變更中有無法顯示的檔名，無法審核這個合併請求',
  }),
  'merge.tooManyFiles': message({ max: 'number' }, {
    en: (p) => `More than ${p.max} ${plural(p.max, 'file', 'files')} changed, too many to review completely. Split the merge into several.`,
    'zh-TW': (p) => `變更的檔案超過 ${p.max} 個，無法完整審核，請分成幾次合併`,
  }),
  'merge.fileListTooLarge': message({}, {
    en: () => 'The names of the changed files are too long in total to review completely.',
    'zh-TW': () => '變更的檔名總長度過大，無法完整審核',
  }),
  'merge.tooManySymlinks': message({}, {
    en: () => 'The changes contain too many symbolic links to review.',
    'zh-TW': () => '變更中的符號連結過多，無法審核',
  }),
  'merge.containsSmurgDir': message({ paths: 'list' }, {
    en: (p) => `A merge cannot contain the .smurg folder: ${joinList('en', p.paths)}`,
    'zh-TW': (p) => `合併內容不可以包含 .smurg 資料夾：${joinList('zh-TW', p.paths)}`,
  }),
  'merge.containsHostOnly': message({ paths: 'list' }, {
    en: (p) => `The merge contains files only the host can change. Remove them first: ${joinList('en', p.paths)}`,
    'zh-TW': (p) => `合併內容包含只有主人可以修改的檔案，請先移除：${joinList('zh-TW', p.paths)}`,
  }),
  'merge.unsafeSymlinks': message({ paths: 'list' }, {
    en: (p) => `The merge contains symbolic links that point outside the project. Remove them first: ${joinList('en', p.paths)}`,
    'zh-TW': (p) => `合併內容包含指向專案外的符號連結，請先移除：${joinList('zh-TW', p.paths)}`,
  }),
  'merge.nestedRepos': message({ paths: 'list' }, {
    en: (p) => `A merge cannot contain nested git repositories (submodules): ${joinList('en', p.paths)}`,
    'zh-TW': (p) => `合併內容不可以包含巢狀的 git 儲存庫（submodule）：${joinList('zh-TW', p.paths)}`,
  }),
  'merge.lockedFiles': message({ paths: 'list' }, {
    en: (p) => `The merge would change files that are being edited or are locked. Wait until they are released, then try again: ${joinList('en', p.paths)}`,
    'zh-TW': (p) => `合併會修改正被編輯或鎖定的檔案，請等它們釋放後再試：${joinList('zh-TW', p.paths)}`,
  }),
} as const;
