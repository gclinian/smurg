// The CLI's own messages in Traditional Chinese (zh-TW): the same ids and parameters as en.ts (checked by type and by
// test/i18n.test.ts). The wording is the one smurg has always used; it changes only where a sentence became false.
import type { DurationUnit, RelayAction, StateSubject, UrlSubject, en } from './en.ts';

const STATE_SUBJECT: Readonly<Record<StateSubject, string>> = {
  credentials: '登入資料檔（credentials.json）',
  workspaces: '工作區紀錄檔（workspaces.json）',
  logs: '紀錄檔目錄',
  'daemon-key': 'daemon 的金鑰或狀態目錄',
  'device-key': '這台裝置的金鑰（device.key）',
};

const URL_SUBJECT: Readonly<Record<UrlSubject, string>> = {
  flag: '--relay',
  'web-origin': '--web-origin',
  env: 'SMURG_RELAY_URL',
  credentials: 'credentials.json 裡的 relay',
  'built-in': 'smurg 內建的公用 relay',
  invite: '邀請連結',
};

const RELAY_ACTION: Readonly<Record<RelayAction, string>> = {
  claim: '建立工作區',
  login: '登入',
  'dev-login': '開發用登入',
  verify: '確認登入狀態',
};

const UNIT: Readonly<Record<DurationUnit, string>> = { day: '天', hour: '小時', minute: '分鐘', second: '秒' };

const UNCHANGED = 'smurg 沒有被更動。';

export const zhTW: { readonly [K in keyof typeof en]: (typeof en)[K] } = {
  // ---- how a failure is printed
  'failure.line': (p) => `smurg：${p.message}\n${p.hint ? `  ${p.hint}\n` : ''}`,
  'failure.unexpected': (p) => `smurg：發生未預期的錯誤（${p.name}）。\n  若問題持續發生，請回報並附上 ~/.smurg/logs 裡的紀錄。\n`,
  'failure.unexpectedEarly': (p) => `smurg：發生未預期的錯誤（${p.name}）。\n`,

  // ---- the dispatcher
  'usage.root': () => `smurg — 多人 × 多 agent 即時協作工作區

用法：smurg <指令> [選項]

  host <資料夾>        分享這台電腦上的專案資料夾，產生邀請連結（在前景執行）
  attach [session]     把 agent session 接到這個終端機（不指定時列出 session）
  stop                 停止分享（中斷所有連線、結束所有 session）
  status               顯示正在分享的工作區
  login                登入 relay（公用 relay 用 Google）
  logout               登出 relay
  update               把 smurg 更新到最新版本（--check 只檢查）
  uninstall            從這台電腦移除 smurg
  licenses             顯示授權條款與第三方軟體的授權聲明
  --version            顯示版本

每個指令都可以加 --help 查看說明。狀態與金鑰存在 ~/.smurg（可用 SMURG_HOME 改變位置）。
語言：依照你的系統語言顯示英文或繁體中文；可用 SMURG_LANG=en 或 SMURG_LANG=zh-TW 指定。
說明文件：https://smurg.ai/zh-TW/docs/
`,
  'cli.unknownCommand': (p) => `不認得的指令「${p.command}」`,
  'cli.unknownCommand.hint': () => '執行 smurg --help 查看所有指令。',

  // ---- arguments
  'args.unknownOption': (p) => `不認得的選項 ${p.option}`,
  'args.takesNoValue': (p) => `選項 --${p.name} 不接受值`,
  'args.conflict': (p) => `選項 --${p.name} 和 --no-${p.name} 不能同時指定`,
  'args.needsValue': (p) => `選項 --${p.name} 需要一個值`,
  'args.once': (p) => `選項 --${p.name} 只能指定一次`,
  'args.missing': (p) => `缺少參數 <${p.name}>`,
  'args.surplus': (p) => `多了不認得的參數「${p.value}」`,
  'arg.folder': () => '資料夾',
  'arg.session': () => 'session',
  'arg.generic': () => '參數',

  // ---- state dir
  'state.homeNotAbsolute': () => 'SMURG_HOME 必須是絕對路徑',
  'state.insecureDirectory': (p) => `${STATE_SUBJECT[p.subject]}所在的資料夾權限不安全（其他使用者可以存取）：${p.path}`,
  'state.insecureDirectory.hint': (p) => `請執行 chmod 700 ${p.path}，或改用新的 SMURG_HOME。`,
  'state.insecurePermissions': (p) => `${STATE_SUBJECT[p.subject]}的權限不安全（其他使用者可以讀取）：${p.path}`,
  'state.insecurePermissions.hint': (p) => `請執行 chmod 600 ${p.path}。`,
  'state.notOwner': (p) => `${STATE_SUBJECT[p.subject]}屬於其他使用者：${p.path}`,
  'state.notRegularFile': (p) => `${STATE_SUBJECT[p.subject]}不是一般檔案（可能是 symlink）：${p.path}`,
  'state.damaged': (p) => `${STATE_SUBJECT[p.subject]}已損毀：${p.path}`,
  'state.unusable': (p) => `${STATE_SUBJECT[p.subject]}無法使用：${p.path}`,
  'state.noAccess': (p) => `無法存取${STATE_SUBJECT[p.subject]}（${p.code}）`,
  'state.tooLarge': (p) => `${STATE_SUBJECT[p.subject]}太大，可能已損毀：${p.path}`,
  'state.badFormat': (p) => `${STATE_SUBJECT[p.subject]}的格式不正確：${p.path}`,
  'state.badFormat.hint': () => '可以刪除這個檔案後重新執行（需要重新登入或重新分享）。',
  'state.workspaceId': (p) => `工作區 ID 不正確：${p.id}`,
  'state.socketPathTooLong': (p) => `smurg 的狀態目錄路徑太長，Unix socket 放不下：${p.path}`,
  'state.socketPathTooLong.hint': () => '請把 SMURG_HOME 設成較短的路徑。',

  // ---- relay
  'relay.badUrl': (p) => `${URL_SUBJECT[p.subject]} 的網址不正確：${p.url}`,
  'relay.badUrl.hint': () => 'relay 網址只能是 https 的網站根網址（本機開發可用 http://localhost:8787）。',
  'relay.badWebOrigin.hint': () => '網頁網址只能是 https 的網站根網址（本機開發可用 http://localhost:5173）。',
  'relay.none': () => '沒有指定 relay',
  'relay.none.hint': () =>
    '請用 --relay <網址> 指定要使用的 relay（或設定環境變數 SMURG_RELAY_URL）；登入過一次之後會記住。這個 smurg 沒有內建的公用 relay（說明：https://smurg.ai/zh-TW/docs/hosting/；本機開發：http://localhost:8787）。',
  'relay.default.none': () => '預設：SMURG_RELAY_URL，或上次登入的 relay；沒有內建的預設 relay',
  'relay.default.builtIn': (p) => `預設：SMURG_RELAY_URL、上次登入的 relay，或內建的公用 relay ${p.url}`,
  'relay.builtInNotice': (p) => `使用 smurg 內建的公用 relay：${p.origin}（要用其他 relay：--relay <網址> 或 SMURG_RELAY_URL）`,
  'relay.unreachable': (p) => `無法連線到 relay（${p.origin}），${RELAY_ACTION[p.action]}失敗`,
  'relay.unreachable.hint': () => '請確認網路連線與 relay 網址。',
  'relay.loginInvalid': (p) => `relay 的登入已失效（${p.origin}）`,
  'relay.loginInvalid.hint': () => '請執行 smurg login 重新登入。',
  'relay.refused': (p) => `relay 拒絕了請求（${p.origin}，HTTP ${p.status}，${p.code}），${RELAY_ACTION[p.action]}失敗`,
  'relay.failed': (p) => `${RELAY_ACTION[p.action]}失敗（${p.name}）`,

  // ---- login / logout
  'usage.login': (p) => `用法：smurg login [--relay 網址] [--dev-user 名稱] [--no-browser]

  登入 relay：smurg 印出一個網址和一組代碼。在任何裝置（電腦或手機）的瀏覽器打開網址，登入你的帳號
  （公用 relay 用 Google），輸入代碼並允許這次登入。透過 SSH 使用時也一樣，不需要其他設定。
  登入資料存在 ~/.smurg/credentials.json（權限 0600）。
  --relay 網址        relay 的網址（${p.relayDefault}）
  --dev-user 名稱     只限本機開發：用 relay 的開發用登入（relay 必須在 localhost）
  --no-browser        不自動用這台電腦的瀏覽器打開網址（透過 SSH 或沒有桌面時本來就不會）
`,
  'usage.logout': () => `用法：smurg logout [--relay 網址] [--all]

  忘記這台電腦上的 relay 登入資料。--all 忘記所有 relay 的登入。
`,
  'login.done': (p) => `已登入 ${p.origin}：${p.name}（${p.userId}）`,
  'logout.allAndRelay': () => '--all 和 --relay 不能同時使用',
  'logout.all': (p) => `已登出所有 relay（${p.count} 個）。`,
  'logout.allNone': () => '這台電腦上沒有任何 relay 登入資料。',
  'logout.done': (p) => `已登出 ${p.origin}。`,
  'logout.none': (p) => `沒有 ${p.origin} 的登入資料。`,
  'login.open': (p) => `在任何裝置（電腦或手機）打開：\n  ${p.page}\n輸入代碼：${p.code}   （${p.minutes} 分鐘內有效）\n`,
  'login.opened': () => '（已經用這台電腦的瀏覽器打開上面的網址）\n',
  'login.waiting': () => '等待你在瀏覽器裡允許這次登入…（按 Ctrl-C 取消）\n',
  'login.tooMany': () => '這個網路在 10 分鐘內開始了太多次登入',
  'login.tooMany.hint': () => '請過幾分鐘再執行一次。',
  'login.unsupported': (p) => `這個 relay 還不支援用代碼登入（${p.origin}）`,
  'login.unsupported.hint': () => '請提供 relay 的人更新 relay，或改用與它同時發佈的 smurg 版本。',
  'login.cancelled': () => '已取消登入',
  'login.expired': () => '代碼已過期，登入沒有完成',
  'login.expired.hint': () => '請重新執行，並在 10 分鐘內到瀏覽器輸入代碼、允許這次登入。',
  'login.denied': () => '登入被拒絕：瀏覽器裡拒絕了這次登入',
  'login.denied.hint': () => '如果不是你自己按的，可能有別人拿到了這組代碼；請重新執行，並且只在你自己的瀏覽器輸入代碼。',
  'login.retrying': (p) => `（暫時無法連線到 relay（${p.origin}），會繼續重試）\n`,
  'login.devUserLocalOnly': () => '--dev-user 只能用在本機的 relay（localhost、127.0.0.1、[::1] 或 *.localhost）',
  'login.devUserLocalOnly.hint': (p) => `目前的 relay 是 ${p.origin}；請改用 smurg login，在瀏覽器裡用這個 relay 提供的方式登入（公用 relay：Google）。`,
  'login.devUserName': () => '--dev-user 的名稱只能包含英數字、「.」「_」「-」，最多 64 個字元',
  'login.devDisabled': (p) => `這個 relay 沒有開啟開發用登入（${p.origin}）`,
  'login.devDisabled.hint': () => '開發用登入需要 relay 以 DEV_LOGIN=1 執行（pnpm dev:relay）。',
  'login.required': (p) => `尚未登入 relay（${p.origin}）`,
  'login.required.hint': (p) => `請先執行 smurg login --relay ${p.origin}`,
  'login.expiringSoon': () => 'relay 的登入快要到期，先重新登入（分享期間登入到期的話，組員會無法連線）。\n',
  'login.hasExpired': () => 'relay 的登入已過期，請重新登入。\n',
  'login.first': () => '尚未登入 relay，先進行登入。\n',

  // ---- the connection to a workspace
  'channel.closed.stopped': () => '主人已停止分享（smurg stop）。',
  'channel.closed.kicked': () => '你已被主人移出這個工作區。',
  'channel.closed.revoked': () => '這台裝置的金鑰已被撤銷。',
  'channel.closed.roleChanged': () => '你的角色已變更，請重新連線。',
  'channel.closed.protocolError': () => '連線因通訊協定錯誤被中斷。',
  'channel.closed.other': () => '連線已中斷。',
  'channel.closed.local': () => '連線已關閉。',
  'channel.keyMismatch.device': () =>
    '警告：主人電腦的金鑰和這台電腦上次記錄的不同，可能有人（例如 relay）冒充主人。已中止連線，沒有送出任何資料。' +
    '如果主人說他重新設定了工作區（換了新的金鑰），請向主人索取新的邀請連結，用 smurg attach --invite - 加入，並用其他管道向主人確認 daemon 金鑰指紋。',
  'channel.keyMismatch.invite': () => '警告：對方的金鑰和邀請連結（或上次記錄）不符，可能有人（例如 relay）冒充主人。已中止連線，沒有送出任何資料。請用其他管道向主人確認 daemon 金鑰指紋。',
  'channel.rejected.inviteInvalid': () => '邀請連結無效、已過期或已用完，請向主人索取新的連結。',
  'channel.rejected.deviceRevoked': () => '這台裝置的金鑰已被撤銷（可能被移出工作區），請向主人索取新的邀請連結。',
  'channel.rejected.deviceOtherAccount': () => '這台裝置先前用另一個帳號加入過這個工作區，不能改用現在登入的帳號連線。請用原本的帳號重新登入（smurg login），或改用另一個 SMURG_HOME。',
  'channel.rejected.identityInvalid': () => 'relay 的身分權杖驗證失敗，請重新登入後再試。',
  'channel.rejected.version': () => 'smurg 版本和主人的不相容，請更新。',
  'channel.rejected.aborted': () => '主人不認得這個邀請連結，請確認連結是否完整。',
  'channel.rejected.unknown': () => '主人拒絕了連線。',
  'channel.closed.loginRequired': () => 'relay 的登入已失效，請執行 smurg login 重新登入。',
  'channel.closed.relayRefused': () => 'relay 拒絕了連線。',
  'channel.closed.noTrust': () => '沒有這個工作區的邀請連結，也沒有記錄過主人的金鑰：請用 --invite 提供邀請連結。',
  'channel.closed.storageError': () => '無法讀寫這台裝置的金鑰或記錄的主人金鑰（~/.smurg 的權限？）。',
  'channel.hostOffline': () => '主人目前離線（smurg host 沒有在執行，或主人的電腦在睡眠）。',
  'channel.relayUnreachable': () => '無法連線到 relay。',
  'channel.timeout': () => '連線逾時，無法加入工作區。',
  'ctl.connectTimeout': () => 'smurg host 沒有回應（控制 socket 連線逾時）',
  'ctl.notRunning': () => '這個工作區沒有正在執行的 smurg host',
  'ctl.connectFailed': (p) => `無法連線到 smurg host 的控制 socket（${p.code}）`,
  'ctl.requestTimeout': () => 'smurg host 沒有回應（控制請求逾時）',
  'ctl.badResponse': () => 'smurg host 的回應格式不正確',
  'ctl.closedEarly': () => 'smurg host 在回應前關閉了連線',
  'ctl.disconnected': () => '與 smurg host 的連線中斷了。',
  'ctl.attachRefused': (p) => `smurg host 拒絕了連線：${p.reason}`,
  'ctl.noAnswer': (p) => `smurg host 沒有回應（${p.type}）`,
  'discover.notRunningFor': (p) => `工作區 ${p.workspaceId} 沒有正在執行的 smurg host`,
  'discover.notRunning': () => '沒有正在執行的 smurg host',
  'discover.several': () => '有多個工作區正在分享，請用 --workspace 指定',
  'discover.several.hint': (p) => `正在分享的工作區：${p.ids.join('、')}`,

  // ---- attach
  'usage.attach': (p) => `用法：smurg attach [session] [--workspace 工作區ID] [--invite -|邀請連結] [--relay 網址] [--no-browser] [--accept-new-key]

  把 agent session 接到這個終端機。不指定 session 時列出所有 session。
  session 可以是列表中的編號、session ID 或 ID 的開頭。
  這台電腦正在分享該工作區時（smurg host），直接以主人身分接上；否則透過 relay 以這台電腦的裝置金鑰加入。
  --invite -          第一次加入別人的工作區：執行後貼上主人給的邀請連結（不會顯示在畫面上）。
                      也可以把連結放在環境變數 SMURG_INVITE。只有第一次需要，之後用 --workspace 即可。
                      直接把連結寫在命令列（--invite 連結）也可以，但連結裡的密鑰會留在 shell 的歷史紀錄，
                      執行期間也會出現在程序列表（ps）裡。
  --workspace ID      指定工作區（預設：目前資料夾所分享的工作區，或唯一一個）
  --relay 網址        relay 的網址（預設：${p.relayDefault}）
  --no-browser        需要登入 relay 時不自動開啟瀏覽器，只顯示網址（SMURG_NO_BROWSER=1 也一樣）
  --accept-new-key    邀請連結的主人金鑰和這台電腦上次記錄的不同時（「主人的電腦金鑰和之前不同」），
                      不再詢問就改用邀請連結的金鑰。只在你已經透過其他管道向主人確認過金鑰指紋時使用。

  接上之後：按 Ctrl-] 離開（session 繼續執行）。主人和「可使用 agent」的組員可以在任何 session 裡輸入，其他角色唯讀。
  說明（組員指南）：https://smurg.ai/zh-TW/docs/joining/#10-用終端機cli加入選用
`,
  'attach.relayDefault.none': () => '邀請連結的網址或上次使用的 relay',
  'attach.relayDefault.builtIn': (p) => `邀請連結的網址、上次使用的 relay，或內建的公用 relay ${p.url}`,
  'attach.status.exited': (p) => `已結束（${p.exitCode}）`,
  'attach.status.starting': () => '啟動中',
  'attach.status.running': () => '執行中',
  'attach.kind.agent': () => 'agent',
  'attach.kind.terminal': () => '終端機',
  'attach.owner.you': (p) => `${p.name}（你）`,
  'attach.list.empty': () => '這個工作區目前沒有 session。',
  'attach.list.header': () => '編號  session ID                        類型      擁有者        狀態        標題',
  'attach.list.footer': () => '用 smurg attach <編號或 session ID> 接上。',
  'attach.list.workspace.local': (p) => `工作區「${p.name}」（${p.workspaceId}，本機）`,
  'attach.list.workspace.relay': (p) => `工作區「${p.name}」（${p.workspaceId}，透過 relay ${p.relay}）`,
  'attach.pick.ambiguous': (p) => `「${p.wanted}」符合多個 session，請輸入更長的 ID`,
  'attach.pick.notFound': (p) => `找不到 session「${p.wanted}」`,
  'attach.pick.notFound.hint': () => '不指定 session 執行 smurg attach 可以列出所有 session。',
  'attach.invite.bad': () => '邀請連結不正確',
  'attach.invite.bad.hint': () => '請完整複製主人給的連結（包含 # 之後的部分）。',
  'attach.invite.otherWorkspace': () => '--workspace 和邀請連結的工作區不一致',
  'attach.several': () => '這台電腦有多個工作區正在分享，請用 --workspace 指定',
  'attach.several.hint': (p) => `正在分享：${p.ids.join('、')}`,
  'attach.noTarget': () => '不知道要接上哪個工作區',
  'attach.noTarget.hint': () => '第一次加入請用 --invite -（執行後貼上邀請連結）；之後可以用 --workspace <工作區ID>。',
  'attach.loginOrigin': (p) =>
    [
      `注意：這台電腦登入過 ${p.others.join('、')}，但還沒有登入 ${p.origin}（登入是依網址分開記錄的）。`,
      `  如果 ${p.origin} 只是同一個 relay 的網頁（例如本機開發時的網頁伺服器），可以按 Ctrl-C，加上 --relay ${p.first} 再執行一次；`,
      `  否則請先執行  smurg login --relay ${p.origin}  。`,
    ].join('\n'),
  'attach.keyChange': (p) =>
    [
      '',
      '主人的電腦金鑰和之前不同',
      '  你之前加入過這個工作區，當時主人電腦的金鑰和這個邀請連結記載的不一樣。',
      '  這通常是因為主人重新設定了工作區（例如收回「可使用 agent」之後換了新的金鑰）或重新安裝了 smurg；',
      '  但也可能是有人想冒充主人。',
      `  上次記錄的金鑰指紋：${p.pinned}`,
      `  邀請連結的金鑰指紋：${p.invited}`,
      '  只有在你已經透過其他管道（當面、電話或你們平常使用的通訊軟體）向主人確認，這個新連結確實是主人剛剛給你的，',
      '  而且主人用 smurg status 看到的「daemon 金鑰指紋」和上面「邀請連結的金鑰指紋」相同，才繼續。',
      '',
    ].join('\n'),
  'attach.keyChange.accepted': () => '已指定 --accept-new-key：改用邀請連結的金鑰。\n',
  'attach.keyChange.question': () => '確認過了嗎？輸入 y 用新的連結加入，其他輸入取消：',
  'attach.keyChange.cancelled': () => '已取消，沒有連線；這台電腦記錄的主人金鑰沒有改變。',
  'attach.keyChange.cancelled.noTerminal': () => '不在終端機裡執行時無法詢問：向主人確認過金鑰指紋之後，加上 --accept-new-key 再執行一次。',
  'attach.keyChange.cancelled.hint': () => '向主人確認過金鑰指紋之後再執行一次。',
  'attach.invite.prompt': () => '請貼上主人給的邀請連結（不會顯示在畫面上），然後按 Enter：',
  'attach.invite.none': () => '沒有收到邀請連結',
  'attach.invite.none.hint': () => '請重新執行，貼上完整的連結（包含 # 之後的部分）後按 Enter。',
  'attach.invite.onCommandLine': () =>
    '注意：寫在命令列上的邀請連結（含密鑰）會留在 shell 的歷史紀錄，執行期間也會出現在程序列表（ps）裡。' +
    '下次請改用 --invite -（執行後貼上連結）或環境變數 SMURG_INVITE；加入過一次之後只需要 --workspace。\n',
  'attach.needsTerminal': () => 'smurg attach 需要在終端機中執行（標準輸入和輸出都必須是終端機）',
  'attach.sessionExited': (p) => `session「${p.title}」已經結束（結束代碼 ${p.exitCode}）`,
  'attach.attaching.own': (p) => `接上 session「${p.title}」（${p.owner}，你的 session）。按 Ctrl-] 離開。`,
  'attach.attaching.other': (p) => `接上 session「${p.title}」（${p.owner} 開的）。按 Ctrl-] 離開。`,
  'attach.readOnly': (p) => `唯讀模式：這個 session 是 ${p.owner} 開的，你的角色不能在 session 裡輸入（想參與可以在網頁上提出建議）。按 Ctrl-] 離開。`,
  'attach.title': (p) => `smurg：${p.title}`,
  'attach.title.readOnly': () => '唯讀',
  'attach.title.hostOffline': () => '主人已離線，等待重新連線…',
  'attach.title.reconnecting': () => '重新連線中…',
  'attach.title.enlarge': (p) => `session 視窗是 ${p.cols}×${p.rows}，請放大終端機`,
  'attach.note': (p) => `[smurg] ${p.message}`,
  'attach.exited': (p) => `session 已結束（結束代碼 ${p.exitCode}）。`,
  'attach.failed': () => '無法接上 session',
  'attach.signal': (p) => `收到 ${p.signal}，已離開 session（session 仍在執行）。`,
  'attach.rawModeFailed': () => '無法把終端機切換到原始模式。',
  'attach.detached': () => '已離開 session（session 仍在執行，可以再用 smurg attach 接上）。',

  // ---- host
  'usage.host': (p) => `用法：smurg host <資料夾> [選項]

  分享這台電腦上的一個專案資料夾，印出兩個連結：你自己的，和給組員的。smurg host 會一直在前景執行，按 Ctrl-C
  或在另一個終端機執行 smurg stop 停止分享。金鑰指紋、設定與紀錄檔的位置：smurg status。
  --relay 網址        relay 的網址（${p.relayDefault}）
  --role 角色         給組員的連結的角色：agent（可使用 agent）、editor（可編輯，預設）、viewer（旁觀）
                      可使用 agent 的組員開的 session 以你的身分在這台電腦上執行、用你的 Claude 登入，
                      也能在任何 session 裡輸入：只給你完全信任的人
  --expires 期限      給組員的連結的有效期限，例如 30m、12h、7d（預設 7d，最長 365d）
  --max-uses 次數     給組員的連結可以使用的次數（預設不限）
  --name 名稱         工作區顯示的名稱（預設：資料夾名稱）
  --web-origin 網址   連結指向的網頁（預設：relay 本身；本機開發可用 http://localhost:5173）
  --no-keep-awake     分享期間不防止電腦睡眠
  --no-browser        需要登入 relay 時不自動開啟瀏覽器，只顯示網址（SMURG_NO_BROWSER=1 也一樣）
  --no-bash-attribution
                      agent 執行 shell 指令時不通知 smurg（預設通知）

  分享前必讀：https://smurg.ai/zh-TW/docs/hosting/#4-分享前必讀
  「可使用 agent」角色與 --no-bash-attribution 的意思與風險：https://smurg.ai/zh-TW/docs/hosting/#5-可使用-agent角色與-agent-的-shell-指令
`,
  'host.folder.notFound': (p) => `找不到資料夾：${p.folder}`,
  'host.folder.notDirectory': (p) => `${p.folder} 不是資料夾`,
  'host.folder.root': () => '不能分享整個檔案系統（/），請指定專案資料夾',
  'host.folder.home': () => '不能分享整個家目錄，請指定專案資料夾',
  'host.folder.example': (p) => `例如：smurg host ${p.example}`,
  'host.folder.containsHome': () => '不能分享包含家目錄的資料夾',
  'host.folder.containsHome.hint': (p) =>
    `家目錄裡有 SSH 金鑰、登入資料等私人檔案，組員會全部看得到。請分享專案資料夾本身${p.example === undefined ? '' : `，例如：smurg host ${p.example}`}`,
  'host.folder.containsState': (p) => `不能分享這個資料夾：smurg 的狀態目錄（${p.stateDir}）在它裡面`,
  'host.folder.containsState.hint': () => '狀態目錄裡有金鑰與登入資料，不能讓組員看到。請分享專案資料夾本身。',
  'host.folder.insideState': () => '不能分享 smurg 狀態目錄裡的資料夾',
  'host.share.notFound': () => '找不到要分享的資料夾',
  'host.share.notDirectory': () => '要分享的不是資料夾',
  'host.share.root': () => '不能分享整個檔案系統',
  'host.share.home': () => '不能分享整個家目錄',
  'host.share.stateInside': () => 'smurg 的狀態目錄在要分享的資料夾裡面',
  'host.share.smurgNotDirectory': () => '資料夾裡的 .smurg 不是資料夾，請先移走它',
  'host.share.containsHomes': () => '不能分享包含使用者家目錄的資料夾',
  'host.share.other': (p) => `無法分享這個資料夾（${p.reason}）`,
  'host.locked.ancestor': () => '這個資料夾的上層資料夾已經在分享中',
  'host.locked.shared': () => '這個資料夾已經在分享中（可能是另一個 relay 或另一個 smurg 狀態目錄）',
  'host.locked.hint': () => '同一個資料夾同時只能由一個 smurg host 分享。用 smurg status 查看，或先停止另一個分享。',
  'host.stateFile': () => '這個工作區的狀態檔是別的 smurg 版本寫的，或不是預期的格式，daemon 拒絕啟動',
  'host.stateFile.hint': (p) =>
    `哪個檔案、什麼原因記在紀錄檔 ${p.logPath}。\n  ` +
    `要重新分享：先把 ${p.workspaceDir} 移到別的地方（例如 mv "${p.workspaceDir}" "${p.workspaceDir}.old"），再執行一次 smurg host。` +
    '這會建立新的工作區狀態：之前的成員和邀請連結都不再有效，組員要用新的邀請連結重新加入。\n  ' +
    'daemon 金鑰也會換新，加入過的組員會看到「主人的電腦金鑰和之前不同」：請把 smurg status 顯示的新金鑰指紋用其他管道（當面、電話）告訴他們。',
  'host.alreadyRunning': () => '這個工作區已經有 smurg host 在執行',
  'host.alreadyShared': () => '這個資料夾已經在分享中',
  'host.alreadyShared.hint': () => '用 smurg status 查看，或 smurg stop 停止。',
  'host.controlSocket': () => '無法建立 daemon 的控制 socket',
  'host.seeLog': (p) => `詳細原因請看紀錄檔 ${p.logPath}`,
  'host.daemonFailed': (p) => `daemon 無法啟動（${p.name}）`,
  'host.role.host': () => '邀請連結不能是主人角色（host）',
  'host.role.host.hint': () => '可用的角色：agent、editor、viewer。',
  'host.role.unknown': (p) => `不認得的角色「${p.role}」`,
  'host.role.unknown.hint': () => '可用的角色：agent（可使用 agent）、editor（可編輯）、viewer（旁觀）。',
  'host.name.invalid': () => '--name 必須是 1 到 80 個字元、不含控制字元',
  'host.expires.unreadable': (p) => `--expires 的期限「${p.text}」看不懂`,
  'host.expires.unreadable.hint': () => '請用數字加單位，例如 30m、12h、7d、2w（s 秒、m 分、h 小時、d 天、w 週）。',
  'host.expires.range': () => '--expires 必須在 1 分鐘到 365 天之間',
  'host.maxUses.notInteger': (p) => `--max-uses 必須是正整數（目前是「${p.text}」）`,
  'host.maxUses.range': (p) => `--max-uses 必須在 ${p.min} 到 ${p.max} 之間`,
  'host.workspaceTaken': (p) => `工作區 ID ${p.workspaceId} 已被 relay 上的其他帳號使用`,
  'host.workspaceTaken.hint': (p) => `這個資料夾之前是用別的帳號分享的；目前登入的是 ${p.name}（${p.userId}）。`,
  'host.native': (p) => `smurg 執行檔內建的原生模組無法使用（${p.reason}）`,
  'host.native.hint': () => '請確認快取目錄可以寫入（可用 SMURG_CACHE_DIR 指定），或重新下載 smurg。',
  'host.stopping.wait': () => '正在停止分享（結束 session、清理暫存目錄），請稍候…',
  'host.stopping.again': () => '\n再次收到中斷訊號，立即結束（daemon 可能沒有完整停止）。',
  'host.stopping.signal': (p) => `\n收到 ${p.signal}，正在停止分享…`,
  'host.stopping.control': () => '\n收到停止要求（smurg stop），正在停止分享…',
  'host.inviteFailed': () => '無法建立邀請連結',
  'host.noHostMember': () => '找不到主人的成員資料，無法建立邀請連結',
  'host.keepAwake.notice': (p) => `\n⚠ 防止睡眠：${p.state}。電腦睡眠時組員會看到「主人已離線」。`,
  'host.keepAwake.lost': (p) => `\n⚠ 防止睡眠已失效：${p.state}。電腦睡眠時組員會看到「主人已離線」。`,
  'host.stopped': () => '已停止分享。',
  'host.overlap.same': () => '這個資料夾已經在分享中',
  'host.overlap.ancestor': (p) => `這個資料夾的上層資料夾（${p.folder}）已經在分享中`,
  'host.overlap.inside': (p) => `這個資料夾裡的 ${p.folder} 已經在分享中`,
  'host.overlap.hint': (p) =>
    `同一份檔案同時只能由一個 smurg host 分享（工作區 ${p.workspaceId}，relay ${p.relay}）。用 smurg status 查看，或先用 smurg stop --workspace ${p.workspaceId} 停止它。`,
  'host.relay.back': () => '✓ 已重新連上 relay，組員可以再次連線。',
  'host.relay.authRejected': (p) =>
    `\n⚠ relay 拒絕了這台電腦的登入（登入已過期或已失效），組員目前無法連線。\n  請在另一個終端機執行 smurg login --relay ${p.origin}；smurg host 會自動改用新的登入並重新連線，不必重新分享。`,
  'host.relay.down': () => '\n⚠ 與 relay 的連線中斷，組員暫時無法連線；正在自動重新連線…',
  'host.state.unsaved': () =>
    '\n⚠ 無法寫入 smurg 的狀態檔（磁碟已滿或沒有權限？）。剛才的變更（例如踢人、改角色、撤銷邀請）現在有效，' + '但在寫入成功之前停止分享的話，重新啟動後會消失；smurg 會持續重試。',
  'host.state.saved': () => '✓ smurg 的狀態檔已重新寫入成功。',
  'host.login.otherAccount': (p) => `\n⚠ ${p.origin} 的新登入是另一個帳號（${p.name}），這個工作區屬於原本的帳號，smurg host 不會改用它。`,
  'host.login.renewed': () => '已改用新的 relay 登入。',
  'host.login.expiring': (p) => `\n⚠ relay 的登入將在 ${p.time} 到期，到期後組員無法連線。請在另一個終端機執行 smurg login --relay ${p.origin}；smurg host 會自動改用新的登入。`,
  'host.invite.heading': (p) =>
    `給組員的連結（用私訊傳給他們，${p.amount} ${UNIT[p.unit]}內有效${p.maxUses === undefined ? '' : `，可以使用 ${p.maxUses} 次`}${p.role === undefined ? '' : `，角色：${p.role}`}）：`,
  'host.summary': (p) =>
    ['', `smurg 正在分享「${p.name}」`, '', '你的連結（只給你自己用）：', `  ${p.hostUrl ?? '（無法建立）'}`, '', p.inviteHeading, `  ${p.inviteUrl}`, '', '按 Ctrl-C 停止分享。'].join('\n'),
  'host.update.notice': (p) => `有新版本 ${p.latest}（目前 ${p.current}）：停止分享後執行 smurg update`,

  // ---- keep-awake
  'power.on': (p) => `已啟用（${p.mechanism}）`,
  'power.off.disabled': () => '未啟用（已用 --no-keep-awake 關閉）',
  'power.off.notStarted': () => '未啟用（尚未啟動）',
  'power.off.stopped': () => '未啟用（已停止）',
  'power.off.noSystemdInhibit': () => '未啟用（找不到 systemd-inhibit）',
  'power.off.startFailed': () => '未啟用（無法啟動防睡眠程式）',
  'power.off.exited': () => '未啟用（防睡眠程式已經結束）',
  'power.off.refused': () => '未啟用（系統（polkit）不允許防止睡眠（例如透過 SSH 登入時，Ubuntu 預設如此）；請在這台電腦的桌面登入後執行 smurg host，或請系統管理員允許）',
  'power.off.unsupported': () => '未啟用（這個作業系統不支援）',
  'power.off.unknown': () => '未啟用（原因不明）',

  // ---- stop / status
  'usage.stop': () => `用法：smurg stop [--workspace 工作區ID]

  停止分享：中斷所有連線、結束所有 session。
  不指定工作區時，停止目前資料夾所分享的工作區，或唯一一個正在分享的工作區。
`,
  'usage.status': () => `用法：smurg status [--workspace 工作區ID]

  顯示正在分享的工作區狀態：資料夾、relay 與連線、daemon 金鑰指紋、防止睡眠、smurg host 的設定、紀錄檔的位置。
  各項的意思：https://smurg.ai/zh-TW/docs/hosting/#7-狀態與停止
`,
  'stop.refused': (p) => `smurg host 拒絕停止：${p.reason}`,
  'stop.timeout': (p) => `smurg host 在 ${p.seconds} 秒內沒有停止`,
  'stop.timeout.hint': () => '請查看執行 smurg host 的終端機。',
  'stop.stopping': (p) => `正在停止分享工作區 ${p.workspaceId}…`,
  'status.relay.online': () => '已連線',
  'status.relay.connecting': () => '連線中',
  'status.relay.waiting': () => '等待重新連線',
  'status.relay.authRejected': () => 'relay 拒絕了主人的登入（請執行 smurg login 重新登入）',
  'status.relay.replaced': () => '被另一個主人連線取代',
  'status.relay.stopped': () => '已停止',
  'status.relay.none': () => '未使用',
  'status.none': () => '目前沒有正在分享的工作區。',
  'status.noneFor': (p) => `工作區 ${p.workspaceId} 沒有正在執行的 smurg host。`,
  'status.workspace': (p) =>
    [
      `工作區 ${p.workspaceId}${p.stopping ? '（正在停止）' : ''}`,
      ...(p.folder === undefined ? [] : [`  資料夾：${p.folder}`]),
      `  relay：${p.relay === undefined ? '' : `${p.relay}${p.builtIn ? '（smurg 內建的公用 relay）' : ''}，`}互動連線 ${p.interactive}，檔案傳輸 ${p.transfer}`,
      `  連線數：${p.connections}，線上成員：${p.onlineMembers}`,
      ...(p.fingerprint === undefined ? [] : [`  daemon 金鑰指紋：${p.fingerprint}`]),
      `  防止睡眠：${p.power}`,
      ...(p.bashAttribution === undefined ? [] : [`  agent 的 shell 指令通知：${p.bashAttribution ? '開啟' : '已關閉（--no-bash-attribution）'}`]),
      `  紀錄檔：${p.logPath}`,
      ...(p.pid === undefined ? [] : [`  daemon 行程：${p.pid}`]),
    ].join('\n'),

  // ---- licenses
  'usage.licenses': () => `用法：smurg licenses [--third-party]

  顯示 smurg 的授權條款（LICENSE：MIT），以及 smurg 執行檔裡第三方軟體的授權與聲明（THIRD-PARTY-NOTICES）。
  授權條款網頁：https://smurg.ai/zh-TW/license/
  原始碼：https://smurg.ai/github
  --third-party       只顯示第三方軟體的授權與聲明
`,
  'licenses.missing': () => '這個 smurg 執行檔裡沒有授權文件',
  'licenses.missing.hint': (p) => `請重新安裝 smurg：${p.install}`,

  // ---- downloads (update, and the notice of smurg host)
  'downloads.notUrl': (p) => `下載位置不是網址：${p.text}`,
  'downloads.notUrl.hint': (p) => `${p.env} 必須是 https 網址（預設 ${p.default}）。`,
  'downloads.notHttps': (p) => `下載位置必須是 https 網址：${p.text}`,
  'downloads.notHttps.hint': (p) => `${p.env} 只接受 https（測試用的 http 只限 127.0.0.1 與 localhost）。`,
  'downloads.badCharacters': (p) => `下載位置含有不允許的字元：${p.text}`,

  // ---- update
  'usage.update': (p) => `用法：smurg update [--check]

  把 smurg 更新到最新版本：從 ${p.downloads} 下載這台電腦的執行檔，sha256 與那個版本的
  SHA256SUMS 相符才換掉目前的執行檔。已經是最新版本時什麼都不做，也不會換成較舊的版本。
  正在分享時不能更新：請先執行 smurg stop。
  --check             只檢查有沒有新版本，不下載也不更新

  變更紀錄：https://smurg.ai/zh-TW/docs/changelog/
  說明：https://smurg.ai/zh-TW/docs/hosting/#9-更新與移除
`,
  'update.timeout': (p) => `下載位置太久沒有回應：${p.url}`,
  'update.unchanged.checkNetwork': () => `${UNCHANGED}請確認網路連線後再執行一次。`,
  'update.http': (p) => `下載位置沒有提供這個檔案（HTTP ${p.status}）：${p.url}`,
  'update.unchanged': () => UNCHANGED,
  'update.redirect': (p) => `下載位置把請求轉到不允許的網址：${p.url}`,
  'update.redirect.hint': () => `${UNCHANGED}只接受 https（以及測試用的本機 http）。`,
  'update.incomplete': (p) => `下載不完整（連線中斷，或大小與伺服器說的不同）：${p.url}`,
  'update.unchanged.again': () => `${UNCHANGED}請再執行一次。`,
  'update.unexpectedContent': (p) => `下載位置回應的內容不是預期的格式：${p.url}`,
  'update.unreachable': (p) => `無法連線到下載位置：${p.url}`,
  'update.failed': (p) => `更新失敗（${p.code}）`,
  'update.progress.unknown': (p) => `${p.received} MB`,
  'update.progress': (p) => `${p.percent}%（${p.received} / ${p.total} MB）`,
  'update.tempCreate': (p) => `無法在 ${p.dir} 建立暫存檔（${p.code}）`,
  'update.tempWrite': (p) => `無法寫入暫存檔 ${p.temp}（${p.code}）`,
  'update.tempWrite.hint': () => `${UNCHANGED}磁碟空間夠嗎？`,
  'update.sha256': (p) => `${p.name} 的 sha256 不符（預期 ${p.expected}，實際 ${p.actual}）：檔案可能被竄改或下載不完整`,
  'update.wrongBuild.none': (p) => `下載的 ${p.name} 不是 smurg ${p.version} 的執行檔（裡面沒有版本標記）`,
  'update.wrongBuild': (p) => `下載的 ${p.name} 不是 smurg ${p.version} 的執行檔（版本標記是 ${p.markers.join('、')}）`,
  'update.quarantine': (p) => `無法移除 ${p.file} 的 ${p.attribute} 屬性`,
  'update.cannotRun': (p) => `下載的 smurg ${p.version} 無法在這台電腦上執行`,
  'update.cannotRun.hint': (p) => `${UNCHANGED}它的訊息：${p.detail}`,
  'update.wrongVersion': (p) => `下載的執行檔回報的版本不是 ${p.version}（${p.reported}）`,
  'update.fromSource': () => '這個 smurg 是從原始碼執行的，不是安裝好的單一執行檔，smurg update 無法更新它',
  'update.fromSource.hint': (p) => `請用 git 取得新版的原始碼，再執行 pnpm install。安裝單一執行檔：${p.install}`,
  'update.versionFormat': (p) => `這個 smurg 的版本（${p.current}）不是發佈版本的格式，無法和最新版本比較`,
  'update.reinstall.hint': (p) => `請重新安裝：${p.install}`,
  'update.noTarget': (p) => `smurg 沒有提供這個平台的執行檔（${p.platform}）`,
  'update.latest': (p) => `smurg ${p.current} 已經是最新版本。`,
  'update.newer': (p) => `這個 smurg（${p.current}）比目前發佈的最新版本（${p.latest}）還新，不會換成較舊的版本。`,
  'update.available': (p) => `有新版本 ${p.latest}（目前 ${p.current}）。執行 smurg update 更新。\n變更紀錄：https://smurg.ai/zh-TW/docs/changelog/`,
  'update.sharing': (p) => `這台電腦正在分享工作區（${p.ids.join('、')}），沒有更新`,
  'update.sharing.hint': (p) =>
    `有新版本 ${p.latest}（目前 ${p.current}）。請先執行 smurg stop 停止分享${p.several ? '（每個工作區各一次：smurg stop --workspace <工作區代碼>）' : ''}，再執行 smurg update。\n  ` +
    '分享中更新的話，還在執行的舊版 daemon 會和新版的 smurg 指令混在一起。',
  'update.noExecutable': (p) => `找不到目前的執行檔：${p.executable}`,
  'update.notWritable': (p) => `無法寫入 smurg 所在的資料夾：${p.dir}`,
  'update.notWritable.hint': (p) => `smurg update 要在同一個資料夾裡換掉 ${p.executable}。請用當初安裝它的方式更新，或重新執行安裝程式（安裝到 ~/.local/bin）：${p.install}`,
  'update.notInSums': (p) => `smurg ${p.latest} 的 SHA256SUMS 裡沒有 ${p.name}（這個版本沒有提供這個平台的執行檔）`,
  'update.downloading': (p) => `下載 smurg ${p.latest}（${p.name}，${p.from}）…`,
  'update.startedSharing': (p) => `下載期間有工作區開始分享（${p.ids.join('、')}），沒有更新`,
  'update.startedSharing.hint': () => '請先執行 smurg stop 停止分享，再執行一次 smurg update。',
  'update.replaceFailed': (p) => `無法換掉 ${p.executable}（${p.code}）`,
  'update.done': (p) => `已更新 smurg：${p.current} → ${p.latest}（${p.executable}）`,
  'update.quarantineRemoved': (p) => `已移除下載檔案的 ${p.attribute} 屬性（sha256 驗證相符之後）`,
  'update.changelog': () => '變更紀錄：https://smurg.ai/zh-TW/docs/changelog/',
  'update.cancelled.check': () => '\n已取消。',
  'update.cancelled': () => `\n已取消，${UNCHANGED}`,

  // ---- uninstall
  'usage.uninstall': () => `用法：smurg uninstall [--keep-data] [--yes]

  從這台電腦移除 smurg：執行檔本身、快取（執行檔解壓縮出來的原生模組），以及狀態目錄 ~/.smurg
  （登入、裝置金鑰、每個工作區的金鑰／成員／邀請連結、紀錄檔）。先列出會移除的路徑，確認之後才動手；
  正在分享的工作區會先停止（和 smurg stop 一樣）。
  專案資料夾裡的 .smurg/（worktree 和還沒合併的修改）不會動，只會列出來讓你自己決定。
  --keep-data         保留狀態目錄，只移除執行檔和快取
  --yes               不詢問，直接移除（不在終端機裡執行時必須加）

  說明：https://smurg.ai/zh-TW/docs/hosting/#9-更新與移除
`,
  'uninstall.size.bytes': (p) => `（${p.bytes} B）`,
  'uninstall.size.kb': (p) => `（${p.kb} KB）`,
  'uninstall.size.mb': (p) => `（${p.mb} MB）`,
  'uninstall.refusal.hint': (p) =>
    `沒有移除任何東西。要只移除執行檔和快取：smurg uninstall --keep-data；狀態目錄（${p.stateDir}）請確認內容後自己刪除，或把 SMURG_HOME 改回 smurg 的狀態目錄再執行一次。`,
  'uninstall.what.state': () => '狀態目錄：登入、裝置金鑰、每個工作區的金鑰／成員／邀請連結、紀錄檔',
  'uninstall.what.stateSymlink': () => '狀態目錄：登入、裝置金鑰、每個工作區的金鑰／成員／邀請連結、紀錄檔（這是一個 symlink：只移除連結本身）',
  'uninstall.what.cache': () => '快取：執行檔解壓縮出來的原生模組',
  'uninstall.what.executable': () => '執行檔',
  'uninstall.state.notDirectory': (p) => `smurg 的狀態目錄不是資料夾：${p.stateDir}`,
  'uninstall.state.topLevel': (p) => `不會移除 ${p.path}：它不是 smurg 的狀態目錄（SMURG_HOME 指向系統的頂層目錄）`,
  'uninstall.state.isHome': (p) => `不會移除 ${p.path}：它是你的家目錄（SMURG_HOME 設錯了？）`,
  'uninstall.state.containsHome': (p) => `不會移除 ${p.path}：你的家目錄在它裡面（SMURG_HOME 設錯了？）`,
  'uninstall.state.containsHomes': (p) => `不會移除 ${p.path}：使用者的家目錄在它裡面（SMURG_HOME 設錯了？）`,
  'uninstall.state.foreign': (p) => `不會移除 ${p.path}：裡面有不是 smurg 建立的東西（${p.names.join('、')}${p.total > p.names.length ? `…等 ${p.total} 項` : ''}）`,
  'uninstall.changed': (p) => `${p.path} 在確認之後被換成別的東西，沒有移除它`,
  'uninstall.fromSource': () => '這個 smurg 是從原始碼執行的，沒有安裝好的執行檔可以移除',
  'uninstall.fromSource.hint': (p) =>
    `要移除的話請自己刪除：原始碼資料夾、狀態目錄 ${p.stateDir}（登入、金鑰、工作區狀態、紀錄檔）和快取 ${p.cacheRoots.join('、')}。\n  ` +
    '分享過的專案資料夾裡的 .smurg/（worktree 在裡面）請確認不再需要後再刪除。',
  'uninstall.noExecutable': (p) => `找不到 smurg 的執行檔：${p.executable}`,
  'uninstall.notWritable': (p) => `無法移除 ${p.executable}：沒有寫入 ${p.dir} 的權限`,
  'uninstall.notWritable.hint': () => '沒有移除任何東西。請用安裝它的帳號（或系統管理員）刪除這個檔案。',
  'uninstall.plan.heading': () => 'smurg uninstall 會移除：',
  'uninstall.plan.item': (p) => `  ${p.path}${p.size}  ${p.what}`,
  'uninstall.plan.stateNote': () => '  移除狀態目錄之後，分享過的工作區的成員與邀請連結都不再有效，這台電腦加入過的工作區也要重新用邀請連結加入。',
  'uninstall.plan.stops': (p) => `會先停止正在分享的工作區（和 smurg stop 一樣：中斷所有連線、結束所有 session）：${p.ids.join('、')}`,
  'uninstall.kept.heading': () => '不會動：',
  'uninstall.kept.state': (p) => `  ${p.stateDir}  狀態目錄（--keep-data）`,
  'uninstall.kept.linkTarget': (p) => `  ${p.target}  狀態目錄的 symlink 指向的資料夾`,
  'uninstall.kept.project': (p) => `  ${p.path}  專案資料夾裡的 smurg 資料（worktree 和還沒合併的修改在這裡）`,
  'uninstall.noTerminal': () => '不在終端機裡執行，無法詢問，沒有移除任何東西',
  'uninstall.noTerminal.hint': () => '確定要移除的話，加上 --yes 再執行一次。',
  'uninstall.question': () => '確定要移除嗎？ [y/N] ',
  'uninstall.cancelled': () => '已取消，沒有移除任何東西。',
  'uninstall.removeFailed': (p) => `無法移除 ${p.path}（${p.code}）`,
  'uninstall.removeFailed.hint': (p) =>
    `${p.removed.length > 0 ? `已移除：${p.removed.join('、')}。` : ''}還沒移除：${p.rest.join('、')}。排除問題後再執行一次 smurg uninstall，或自己刪除它們。`,
  'uninstall.left.path': (p) => `  shell 設定檔裡的 PATH：安裝程式只提示過要加 export PATH="${p.dir}:$PATH"，smurg 沒有改過你的設定檔；你加過的話，請自己刪掉那一行`,
  'uninstall.done': (p) => ['', '已移除：', ...p.removed.map((path) => `  ${path}`), '', '還留著：', ...p.left, '', `smurg 已從這台電腦移除。要再安裝：${p.install}`].join('\n'),
  'uninstall.stopFailed': (p) => `無法停止正在分享的工作區 ${p.workspaceId}${p.reason === undefined ? '' : `（${p.reason}）`}，沒有移除任何東西`,
  'uninstall.stopFailed.hint': () => '請到執行 smurg host 的終端機按 Ctrl-C 停止分享，再執行一次 smurg uninstall。',
};
