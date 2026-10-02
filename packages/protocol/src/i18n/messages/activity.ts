// The activity feed's sentences (`activity.*`, ActivityEvent.text). Feed lines, not full sentences: no full stop.
// Names and paths are parameters (the daemon clips them: a path to 200 characters, at most 3 sample paths, at most
// 5 holder names); counts are numbers. `change` is a file change kind (FILE_CHANGES).
import { joinList, message, plural } from '../define.ts';

/** What happened to an entry on disk (`change` parameter; the daemon's FileChangeKind). */
export const FILE_CHANGES = ['add', 'change', 'unlink', 'addDir', 'unlinkDir'] as const;
export type FileChange = (typeof FILE_CHANGES)[number];

/** Why unsaved text went to the conflict panel (`activity.conflictRecovered`). */
export const CONFLICT_RECOVERY_REASONS = ['deleted', 'unsupported', 'unwritable'] as const;
export type ConflictRecoveryReason = (typeof CONFLICT_RECOVERY_REASONS)[number];

const CHANGE_VERBS: Readonly<Record<string, { readonly en: string; readonly 'zh-TW': string }>> = {
  add: {
    en: 'created',
    'zh-TW': '新增了',
  },
  change: {
    en: 'changed',
    'zh-TW': '修改了',
  },
  unlink: {
    en: 'deleted',
    'zh-TW': '刪除了',
  },
  addDir: {
    en: 'created the folder',
    'zh-TW': '新增了資料夾',
  },
  unlinkDir: {
    en: 'deleted the folder',
    'zh-TW': '刪除了資料夾',
  },
};

/** A change kind this version does not know: still a sentence, never "undefined". */
const UNKNOWN_CHANGE = {
  en: (change: string) => `changed (${change})`,
  'zh-TW': (change: string) => `變更了（${change}）`,
};

function verb(locale: 'en' | 'zh-TW', change: string): string {
  const verbs = Object.hasOwn(CHANGE_VERBS, change) ? CHANGE_VERBS[change] : undefined;
  return verbs ? verbs[locale] : UNKNOWN_CHANGE[locale](change);
}

/** ` (e.g. a, b, c)` after a count of files; nothing for an empty sample. */
function exampleEn(sample: readonly string[] | undefined): string {
  return sample && sample.length > 0 ? ` (e.g. ${joinList('en', sample)})` : '';
}

/** `Amy, Bob and 3 more`: the listed names, then how many holders are not listed. */
function holdersEn(holders: readonly string[], count: number): string {
  const more = count - holders.length;
  return more > 0 ? `${joinList('en', holders)} and ${more} more` : joinList('en', holders);
}

export const activity = {
  // ---- agents -------------------------------------------------------------------------------------------------
  'activity.agentEdit': message({ agent: 'string', path: 'string', tool: 'string?' }, {
    en: (p) => `${p.agent} edited ${p.path}${p.tool ? ` (${p.tool})` : ''}`,
    'zh-TW': (p) => `${p.agent} 修改了 ${p.path}${p.tool ? `（${p.tool}）` : ''}`,
  }),
  'activity.agentChange': message({ agent: 'string', path: 'string', change: 'string' }, {
    en: (p) => `${p.agent} ${verb('en', p.change)} ${p.path}`,
    'zh-TW': (p) => `${p.agent} ${verb('zh-TW', p.change)} ${p.path}`,
  }),
  'activity.agentBashChange': message({ agent: 'string', path: 'string', change: 'string' }, {
    en: (p) => `${p.agent} ${verb('en', p.change)} ${p.path} with a shell command`,
    'zh-TW': (p) => `${p.agent} 透過 shell 指令${verb('zh-TW', p.change)} ${p.path}`,
  }),
  'activity.agentBashBurst': message({ agent: 'string', count: 'number', sample: 'list?' }, {
    en: (p) => `${p.agent} changed ${p.count} ${plural(p.count, 'file', 'files')} with a shell command${exampleEn(p.sample)}`,
    'zh-TW': (p) => `${p.agent} 透過 shell 指令變更了 ${p.count} 個檔案${p.sample && p.sample.length > 0 ? `（例如 ${joinList('zh-TW', p.sample)}）` : ''}`,
  }),
  'activity.lockDenied': message({ agent: 'string', path: 'string?' }, {
    en: (p) => `${p.agent} was refused a change to ${p.path ? p.path : 'a file'}`,
    'zh-TW': (p) => `${p.agent} 修改 ${p.path ? p.path : '一個檔案'} 的請求被拒絕`,
  }),
  'activity.lockDeniedHeld': message({ agent: 'string', path: 'string?', holders: 'list', holderCount: 'number', holderIsAgent: 'boolean' }, {
    en: (p) =>
      `${p.agent} wanted to change ${p.path ? p.path : 'a file'}, but ${holdersEn(p.holders, p.holderCount)} ${p.holderCount === 1 ? 'is' : 'are'} ${p.holderIsAgent ? 'changing' : 'editing'} it: blocked`,
    'zh-TW': (p) => `${p.agent} 想修改 ${p.path ? p.path : '一個檔案'}，但 ${joinList('zh-TW', p.holders)}${p.holderCount > p.holders.length ? ` 等 ${p.holderCount} 人` : ''} ${p.holderIsAgent ? '正在修改' : '正在編輯'}，已被擋下`,
  }),

  // ---- people -------------------------------------------------------------------------------------------------
  'activity.humanEdit': message({ name: 'string', path: 'string' }, {
    en: (p) => `${p.name} edited ${p.path}`,
    'zh-TW': (p) => `${p.name} 編輯了 ${p.path}`,
  }),
  'activity.fileCreate': message({ path: 'string', isDir: 'boolean' }, {
    en: (p) => `Created the ${p.isDir ? 'folder' : 'file'} ${p.path}`,
    'zh-TW': (p) => `新增${p.isDir ? '資料夾' : '檔案'} ${p.path}`,
  }),
  'activity.fileRename': message({ from: 'string', to: 'string' }, {
    en: (p) => `Renamed ${p.from} to ${p.to}`,
    'zh-TW': (p) => `重新命名 ${p.from} → ${p.to}`,
  }),
  'activity.fileDelete': message({ path: 'string' }, {
    en: (p) => `Deleted ${p.path}`,
    'zh-TW': (p) => `刪除 ${p.path}`,
  }),
  'activity.fileWrite': message({ path: 'string' }, {
    en: (p) => `Changed ${p.path}`,
    'zh-TW': (p) => `修改 ${p.path}`,
  }),
  'activity.fileUpload': message({ path: 'string' }, {
    en: (p) => `Uploaded ${p.path}`,
    'zh-TW': (p) => `上傳 ${p.path}`,
  }),

  // ---- changes nobody announced -------------------------------------------------------------------------------
  'activity.externalChange': message({ path: 'string', change: 'string' }, {
    en: (p) => `An outside program ${verb('en', p.change)} ${p.path}`,
    'zh-TW': (p) => `外部程式${verb('zh-TW', p.change)} ${p.path}`,
  }),
  'activity.externalBurst': message({ count: 'number', sample: 'list?' }, {
    en: (p) => `An outside program changed ${p.count} ${plural(p.count, 'file', 'files')}${exampleEn(p.sample)}`,
    'zh-TW': (p) => `外部程式變更了 ${p.count} 個檔案${p.sample && p.sample.length > 0 ? `（例如 ${joinList('zh-TW', p.sample)}）` : ''}`,
  }),
  'activity.worktreeChange': message({ name: 'string', path: 'string', change: 'string' }, {
    en: (p) => `A program in ${p.name}'s worktree ${verb('en', p.change)} ${p.path}`,
    'zh-TW': (p) => `${p.name} 的 worktree 中的程式${verb('zh-TW', p.change)} ${p.path}`,
  }),
  'activity.worktreeBurst': message({ name: 'string', count: 'number', sample: 'list?' }, {
    en: (p) => `${p.count} ${plural(p.count, 'file', 'files')} changed in ${p.name}'s worktree${exampleEn(p.sample)}`,
    'zh-TW': (p) => `${p.name} 的 worktree 中變更了 ${p.count} 個檔案${p.sample && p.sample.length > 0 ? `（例如 ${joinList('zh-TW', p.sample)}）` : ''}`,
  }),

  // ---- the conflict panel -------------------------------------------------------------------------------------
  'activity.conflict': message({ path: 'string', count: 'number' }, {
    en: (p) =>
      `${p.count} ${plural(p.count, 'change', 'changes')} to "${p.path}" ${plural(p.count, 'overlaps', 'overlap')} text that is being edited. The edited text was kept; the other version is in the conflict panel`,
    'zh-TW': (p) => `「${p.path}」有 ${p.count} 處修改與正在編輯的內容重疊，已保留編輯中的內容，另一個版本在衝突面板`,
  }),
  'activity.conflictRecovered': message({ path: 'string', reason: 'string' }, {
    en: (p) =>
      `"${p.path}" ${p.reason === 'deleted' ? 'was deleted or moved while it was being edited' : p.reason === 'unsupported' ? 'became something the editor cannot open' : 'can no longer be written safely'}. The unsaved text was kept in the conflict panel`,
    'zh-TW': (p) => `「${p.path}」${p.reason === 'deleted' ? '在編輯中被刪除或移走' : p.reason === 'unsupported' ? '變成無法在編輯器中開啟的內容' : '已無法安全寫入'}，尚未儲存的內容已保留在衝突面板`,
  }),

  // ---- merge requests -----------------------------------------------------------------------------------------
  'activity.mergeRequested': message({}, {
    en: () => 'Asked to merge their worktree into the main workspace',
    'zh-TW': () => '請求把自己的 worktree 合併到主工作區',
  }),
  'activity.mergeMerged': message({ requester: 'string' }, {
    en: (p) => `Merged ${p.requester}'s worktree into the main workspace`,
    'zh-TW': (p) => `把${p.requester}的 worktree 合併到主工作區`,
  }),
  'activity.mergeRejected': message({ requester: 'string' }, {
    en: (p) => `Rejected the merge of ${p.requester}'s worktree`,
    'zh-TW': (p) => `拒絕合併${p.requester}的 worktree`,
  }),
  'activity.mergeConflict': message({ requester: 'string', count: 'number' }, {
    en: (p) => `Merging ${p.requester}'s worktree hit conflicts in ${p.count} ${plural(p.count, 'file', 'files')}. The main workspace was not changed`,
    'zh-TW': (p) => `合併${p.requester}的 worktree 時發生衝突（${p.count} 個檔案），主工作區沒有改變`,
  }),
} as const;
