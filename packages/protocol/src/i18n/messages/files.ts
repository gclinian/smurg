// Error texts of files, the editor, downloads and uploads (`file.*`, `doc.*`, `download.*`, `upload.*`).
import { joinList, message } from '../define.ts';
import { formatBytes } from '../format.ts';

export const files = {
  // ---- file tree operations -----------------------------------------------------------------------------------
  'file.pathTooLong': message({}, {
    en: () => "This folder's full path is too long for the system to open.",
    'zh-TW': () => '這個資料夾的完整路徑太長，系統無法開啟',
  }),
  'file.notADirectory': message({}, {
    en: () => 'This is not a folder.',
    'zh-TW': () => '這不是資料夾',
  }),
  'file.notAFile': message({}, {
    en: () => 'This is not a regular file.',
    'zh-TW': () => '不是一般檔案',
  }),
  'file.sameName': message({}, {
    en: () => 'The new name is the same as the old one.',
    'zh-TW': () => '新名稱與原本相同',
  }),
  'file.gone': message({}, {
    en: () => 'The file no longer exists.',
    'zh-TW': () => '檔案已不存在',
  }),
  'file.changedSinceRead': message({}, {
    en: () => 'The file changed after it was read.',
    'zh-TW': () => '檔案在讀取後已被變更',
  }),
  'file.exists': message({}, {
    en: () => 'The file already exists.',
    'zh-TW': () => '檔案已存在',
  }),
  'file.nameTaken': message({}, {
    en: () => 'A file or folder with this name already exists.',
    'zh-TW': () => '已經有同名的檔案或資料夾',
  }),
  'file.nameTakenByFile': message({}, {
    en: () => 'A file with this name already exists.',
    'zh-TW': () => '已經有同名的檔案',
  }),
  'file.parentMissing': message({}, {
    en: () => 'The parent folder does not exist.',
    'zh-TW': () => '上層資料夾不存在',
  }),
  'file.cannotWriteRoot': message({}, {
    en: () => 'The root folder cannot be written as a file.',
    'zh-TW': () => '不能寫入根目錄',
  }),
  'file.daemonOwned': message({}, {
    en: () => 'smurg manages this folder. It cannot be changed directly.',
    'zh-TW': () => '這個資料夾由 smurg 管理，不能直接修改',
  }),
  'file.deleteCrossDevice': message({}, {
    en: () => 'A folder on another volume cannot be deleted.',
    'zh-TW': () => '無法刪除位於其他磁碟區的資料夾',
  }),
  'file.moveIntoItself': message({}, {
    en: () => 'A folder cannot be moved into itself.',
    'zh-TW': () => '不能把資料夾移到它自己裡面',
  }),
  'file.moveCrossDevice': message({}, {
    en: () => 'Moving between volumes is not possible.',
    'zh-TW': () => '無法在不同磁碟區之間移動',
  }),
  'file.lockedByAgent': message({ agent: 'string' }, {
    en: (p) => `${p.agent} is changing this file.`,
    'zh-TW': (p) => `${p.agent} 正在修改這個檔案`,
  }),
  'file.lockedByPeople': message({ names: 'list' }, {
    en: (p) => `${joinList('en', p.names)} ${p.names.length === 1 ? 'is' : 'are'} editing this file.`,
    'zh-TW': (p) => `${joinList('zh-TW', p.names)} 正在編輯這個檔案`,
  }),

  // ---- the editor (doc.*) -------------------------------------------------------------------------------------
  'doc.notAFile': message({}, {
    en: () => 'Only regular files can be opened in the editor.',
    'zh-TW': () => '只能在編輯器中開啟一般檔案',
  }),
  'doc.needsWrite': message({}, {
    en: () => 'You do not have permission to edit this file.',
    'zh-TW': () => '沒有編輯這個檔案的權限',
  }),
  'doc.notOpen': message({}, {
    en: () => 'This document is not open.',
    'zh-TW': () => '這份文件沒有開啟',
  }),
  'doc.paused': message({}, {
    en: () => 'The file cannot be written right now.',
    'zh-TW': () => '檔案目前無法寫入',
  }),
  'doc.busy': message({}, {
    en: () => 'The document is changing. Try again.',
    'zh-TW': () => '文件正在變動，請再試一次',
  }),
  'doc.unsupported': message({}, {
    en: () => "The file's content cannot be opened in the editor right now.",
    'zh-TW': () => '檔案內容目前無法在編輯器中開啟',
  }),
  'doc.agentLocked': message({}, {
    en: () => 'An agent is changing this file. Try again later.',
    'zh-TW': () => '此檔案正由 agent 修改中，請稍後再試',
  }),
  'doc.tooLarge': message({ maxBytes: 'number' }, {
    en: (p) => `The file is larger than ${formatBytes(p.maxBytes)} and cannot be opened in the editor.`,
    'zh-TW': (p) => `檔案超過 ${formatBytes(p.maxBytes)}，無法在編輯器中開啟`,
  }),
  'doc.utf16': message({}, {
    en: () => 'Files encoded as UTF-16 or UTF-32 are not supported.',
    'zh-TW': () => '不支援 UTF-16 或 UTF-32 編碼的檔案',
  }),
  'doc.binary': message({}, {
    en: () => 'This is a binary file and cannot be opened in the editor.',
    'zh-TW': () => '這是二進位檔案，無法在編輯器中開啟',
  }),
  'doc.invalidUtf8': message({}, {
    en: () => 'The file is not valid UTF-8 text and cannot be opened in the editor.',
    'zh-TW': () => '檔案不是有效的 UTF-8 文字，無法在編輯器中開啟',
  }),

  // ---- downloads ----------------------------------------------------------------------------------------------
  'download.pickFile': message({}, {
    en: () => 'Choose a file to download, or download the folder as a zip.',
    'zh-TW': () => '請選擇要下載的檔案，或以 zip 下載資料夾',
  }),
  'download.zipNeedsFolder': message({}, {
    en: () => 'Only a folder can be downloaded as a zip.',
    'zh-TW': () => '只有資料夾可以打包成 zip 下載',
  }),
  'download.folderNeedsZip': message({}, {
    en: () => 'Download a folder as a zip.',
    'zh-TW': () => '資料夾請以 zip 下載',
  }),
  'download.changedSinceLast': message({}, {
    en: () => 'The file changed since the last download. Download it again.',
    'zh-TW': () => '檔案在上次下載後已被修改，請重新下載',
  }),
  'download.offsetBeyondEnd': message({}, {
    en: () => 'The resume position is beyond the end of the file.',
    'zh-TW': () => '續傳位置超出檔案大小',
  }),
  'download.shrunk': message({}, {
    en: () => 'The file got shorter during the download.',
    'zh-TW': () => '檔案在下載途中被縮短了',
  }),
  'download.changedDuring': message({}, {
    en: () => 'The file changed during the download. Download it again.',
    'zh-TW': () => '檔案在下載途中被修改了，請重新下載',
  }),

  // ---- uploads ------------------------------------------------------------------------------------------------
  'upload.insufficientDisk': message(
    { requestedBytes: 'number', freeAfterBytes: 'number', reserveBytes: 'number', availableBytes: 'number', pendingBytes: 'number' },
    {
      en: (p) =>
        `The host does not have enough disk space, so the upload did not start: it needs ${formatBytes(p.requestedBytes)}, which would leave ${formatBytes(p.freeAfterBytes)}, less than the reserve of ${formatBytes(p.reserveBytes)} (${formatBytes(p.availableBytes)} available now, ${formatBytes(p.pendingBytes)} held for other uploads in progress). The host can change the reserve in the settings.`,
      'zh-TW': (p) => `主人的磁碟空間不足，上傳尚未開始：需要 ${formatBytes(p.requestedBytes)}，上傳後只剩 ${formatBytes(p.freeAfterBytes)}，低於保留空間 ${formatBytes(p.reserveBytes)}（目前可用 ${formatBytes(p.availableBytes)}，其他進行中的上傳預留 ${formatBytes(p.pendingBytes)}）。主人可以在設定中調整保留空間。`,
    },
  ),
  'upload.diskFull': message({}, {
    en: () => "The host's disk is full. The upload is paused.",
    'zh-TW': () => '主人的磁碟已滿，上傳已暫停',
  }),
  'upload.nameConflicts': message({}, {
    en: () => 'Some names in this upload are already taken. No file was created.',
    'zh-TW': () => '這批上傳有名稱衝突，沒有建立任何檔案',
  }),
  'upload.folderInTheWay': message({}, {
    en: () => 'A folder with this name is already at the destination.',
    'zh-TW': () => '目標位置已經有同名的資料夾',
  }),
  'upload.tooManyPartial': message({}, {
    en: () => 'Too many unfinished uploads. Finish or cancel some first.',
    'zh-TW': () => '未完成的上傳太多，請先完成或取消一些上傳',
  }),
  'upload.committing': message({}, {
    en: () => 'This upload is being completed.',
    'zh-TW': () => '這個上傳正在完成中',
  }),
  'upload.chunkIndex': message({}, {
    en: () => 'The chunk number is out of range.',
    'zh-TW': () => '分段編號超出範圍',
  }),
  'upload.chunkLength': message({}, {
    en: () => 'The chunk has the wrong length.',
    'zh-TW': () => '分段長度不正確',
  }),
  'upload.chunkHashMismatch': message({}, {
    en: () => "The chunk's hash does not match. Send it again.",
    'zh-TW': () => '分段的雜湊值不符，請重新傳送',
  }),
  'upload.chunkDiffers': message({}, {
    en: () => 'This chunk was received before with different content.',
    'zh-TW': () => '這個分段先前已收到不同的內容',
  }),
  'upload.cancelled': message({}, {
    en: () => 'This upload was cancelled.',
    'zh-TW': () => '這個上傳已被取消',
  }),
  'upload.incomplete': message({}, {
    en: () => 'Some chunks have not arrived yet.',
    'zh-TW': () => '還有分段沒有收到',
  }),
  'upload.fileHashMismatch': message({}, {
    en: () => 'The hash of the whole file does not match.',
    'zh-TW': () => '整個檔案的雜湊值不符',
  }),
  'upload.alreadyDone': message({}, {
    en: () => 'This upload is already complete.',
    'zh-TW': () => '這個上傳已經完成',
  }),
  'upload.boundElsewhere': message({}, {
    en: () => 'Another connection is running this upload.',
    'zh-TW': () => '這個上傳正由另一個連線進行中',
  }),
  'upload.hostStopping': message({}, {
    en: () => 'The host is stopping the share.',
    'zh-TW': () => '主人正在停止分享',
  }),
  'upload.notFound': message({}, {
    en: () => 'That upload was not found.',
    'zh-TW': () => '找不到這個上傳',
  }),
  'upload.beginFirst': message({}, {
    en: () => 'Start this upload again first (file.upload.begin).',
    'zh-TW': () => '請先重新開始這個上傳（file.upload.begin）',
  }),
  'upload.crossDevice': message({}, {
    en: () => 'Uploading here is not possible: the location is on another volume.',
    'zh-TW': () => '無法上傳到這個位置：它位於另一個磁碟區',
  }),
} as const;
