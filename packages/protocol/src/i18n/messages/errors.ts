// Error texts that belong to no single feature: the default text per error code (`error.default.<code in camelCase>`,
// shown when an error carries no specific message), path refusals (`path.*`, one per PathDeniedReason), members and
// host administration (`member.*`, `admin.*`, `settings.*`), the control socket (`control.*`) and `daemon.stopping`.
// One id per distinct sentence (`area.thing[.variant]`); reasons (`detail.reason`) are NOT ids.
import { message } from '../define.ts';

/** What an admin change was (`admin.appliedNotSaved`). */
export const ADMIN_CHANGES = ['invite-revoke', 'role-change', 'kick', 'settings'] as const;
export type AdminChange = (typeof ADMIN_CHANGES)[number];

const ADMIN_CHANGE_NAMES: Readonly<Record<string, { readonly en: string; readonly 'zh-TW': string }>> = {
  'invite-revoke': {
    en: 'The invite was revoked',
    'zh-TW': '撤銷邀請已生效',
  },
  'role-change': {
    en: 'The role was changed',
    'zh-TW': '角色變更已生效',
  },
  kick: {
    en: 'The member was removed',
    'zh-TW': '踢出成員已生效',
  },
  settings: {
    en: 'The settings were changed',
    'zh-TW': '設定已生效',
  },
};

export const errors = {
  'error.default.badRequest': message({}, {
    en: () => 'The request is not valid.',
    'zh-TW': () => '請求格式不正確',
  }),
  'error.default.unauthorized': message({}, {
    en: () => 'Your identity has not been verified yet.',
    'zh-TW': () => '尚未通過身分驗證',
  }),
  'error.default.forbidden': message({}, {
    en: () => 'You do not have permission to do this.',
    'zh-TW': () => '你沒有權限執行這個動作',
  }),
  'error.default.notFound': message({}, {
    en: () => 'That item was not found.',
    'zh-TW': () => '找不到指定的項目',
  }),
  'error.default.conflict': message({}, {
    en: () => 'This conflicts with the current state. Reload and try again.',
    'zh-TW': () => '與目前的狀態衝突，請重新整理後再試',
  }),
  'error.default.locked': message({}, {
    en: () => 'This file is locked right now.',
    'zh-TW': () => '這個檔案目前被鎖定',
  }),
  'error.default.pathDenied': message({}, {
    en: () => 'Access to this path is not allowed.',
    'zh-TW': () => '不允許存取這個路徑',
  }),
  'error.default.insufficientDisk': message({}, {
    en: () => 'The host does not have enough disk space.',
    'zh-TW': () => '主人的磁碟空間不足',
  }),
  'error.default.tooLarge': message({}, {
    en: () => 'The content is too large.',
    'zh-TW': () => '內容太大',
  }),
  'error.default.hostOnly': message({}, {
    en: () => 'Only the host can do this.',
    'zh-TW': () => '只有主人可以執行這個動作',
  }),
  'error.default.internal': message({}, {
    en: () => 'Something went wrong on the host.',
    'zh-TW': () => '主人端發生內部錯誤',
  }),

  // ---- daemon -------------------------------------------------------------------------------------------------
  'daemon.stopping': message({}, {
    en: () => 'smurg is stopping on the host.',
    'zh-TW': () => 'daemon 正在停止',
  }),

  // ---- path refusals (PathGuard; detail.reason = the PathDeniedReason) ------------------------------------------
  'path.lexical': message({}, {
    en: () => 'The path is not valid.',
    'zh-TW': () => '路徑格式不正確',
  }),
  'path.tooLong': message({}, {
    en: () => 'The path is too long.',
    'zh-TW': () => '路徑太長',
  }),
  'path.unknownRoot': message({}, {
    en: () => 'That workspace or worktree was not found.',
    'zh-TW': () => '找不到這個工作區或 worktree',
  }),
  'path.rootChanged': message({}, {
    en: () => 'The workspace folder was moved or replaced.',
    'zh-TW': () => '工作區資料夾已被移動或替換',
  }),
  'path.outsideRoot': message({}, {
    en: () => 'Paths outside the shared folder are not allowed.',
    'zh-TW': () => '不允許存取分享資料夾以外的路徑',
  }),
  'path.symlink': message({}, {
    en: () => 'Writing through a symbolic link is not allowed.',
    'zh-TW': () => '不允許透過符號連結寫入',
  }),
  'path.sharedLinkTampered': message({}, {
    en: () => 'The link to a shared directory was tampered with.',
    'zh-TW': () => '共享資料夾的連結已被竄改',
  }),
  'path.readOnly': message({}, {
    en: () => 'This shared directory is read-only.',
    'zh-TW': () => '這個共享資料夾是唯讀的',
  }),
  'path.hostOnly': message({}, {
    en: () => 'Only the host can change this path.',
    'zh-TW': () => '只有主人可以修改這個路徑',
  }),
  'path.hidden': message({}, {
    en: () => 'Access to this path is not allowed.',
    'zh-TW': () => '不允許存取這個路徑',
  }),
  'path.hostPrivate': message({}, {
    en: () => "This is the host's private file. Only the host can open it.",
    'zh-TW': () => '這是主人的私人檔案，只有主人可以存取',
  }),
  'path.hardLink': message({}, {
    en: () => 'Files with more than one hard link are not allowed.',
    'zh-TW': () => '不允許存取有多個硬連結的檔案',
  }),
  'path.specialFile': message({}, {
    en: () => 'This kind of special file is not supported.',
    'zh-TW': () => '不支援這種特殊檔案',
  }),
  'path.changed': message({}, {
    en: () => 'The file changed while it was being checked. Try again.',
    'zh-TW': () => '檔案在檢查後被變更，請再試一次',
  }),
  'path.notDirectory': message({}, {
    en: () => 'Part of the path is not a folder.',
    'zh-TW': () => '路徑中有不是資料夾的項目',
  }),

  // ---- members, invites, settings (the host's console) --------------------------------------------------------
  'member.notFound': message({}, {
    en: () => 'That member was not found.',
    'zh-TW': () => '找不到這位成員',
  }),
  'member.hostRoleFixed': message({}, {
    en: () => "The host's role cannot be changed.",
    'zh-TW': () => '不能變更主人的角色',
  }),
  'member.hostNotRemovable': message({}, {
    en: () => 'The host cannot be removed.',
    'zh-TW': () => '不能踢掉主人',
  }),
  'member.notificationInvalid': message({}, {
    en: () => 'The notification is not valid.',
    'zh-TW': () => '通知內容不正確',
  }),
  'admin.appliedNotSaved': message({ change: 'string' }, {
    en: (p) =>
      `${ADMIN_CHANGE_NAMES[p.change]?.en ?? `The change (${p.change}) was applied`}, but the state file could not be written (disk full, or no write permission?). smurg keeps retrying; if smurg stops before it succeeds, the change is lost after a restart.`,
    'zh-TW': (p) => `${ADMIN_CHANGE_NAMES[p.change]?.['zh-TW'] ?? `變更（${p.change}）已生效`}，但無法寫入狀態檔（磁碟已滿或沒有寫入權限？）。smurg 會持續重試；在寫入成功前停止 smurg，重新啟動後這個變更會消失。`,
  }),
  'admin.inviteNotSaved': message({}, {
    en: () => 'The state file could not be written (disk full, or no write permission?), so no invite link was created.',
    'zh-TW': () => '無法寫入狀態檔（磁碟已滿或沒有寫入權限？），邀請連結沒有建立。',
  }),
  'settings.invalid': message({}, {
    en: () => 'The settings are not valid.',
    'zh-TW': () => '設定格式不正確',
  }),
  'settings.sharedDirInvalid': message({}, {
    en: () => 'A shared directory must be an ordinary folder inside the shared folder.',
    'zh-TW': () => '共享資料夾必須是分享資料夾內一般的資料夾',
  }),

  // ---- the control socket (smurg stop / status / attach on the host's machine) ---------------------------------
  'control.badRequest': message({}, {
    en: () => 'The control request is not valid.',
    'zh-TW': () => '控制請求格式不正確',
  }),
  'control.onlySessions': message({}, {
    en: () => 'The control socket on this computer (smurg attach) can only list sessions, attach to one and type into it. Do everything else in the web app.',
    'zh-TW': () => '透過這台電腦的控制 socket（smurg attach）只能列出、接上 session 和在 session 裡輸入；其他操作請在網頁上進行。',
  }),
} as const;
