# 變更紀錄

每個發佈版本的變更都記在這裡（格式參考 [Keep a Changelog](https://keepachangelog.com/zh-TW/1.1.0/)，版本號依照
[語意化版本](https://semver.org/lang/zh-TW/)）。每個版本的段落也是那個版本的發佈說明；沒有對應段落的版本不會發佈。
英文版：[English](../../CHANGELOG.md)。

## [Unreleased]

- **主題：團隊把一個功能從討論帶到看過的成果。** 主畫面現在以主題（一個功能或一件工作）為中心；
  [組員指南](JOINING.md) §6 完整走過一次。
  - 討論：大家和同一個 agent 對話。agent 會出選擇題讓團隊決定；主人、「可使用 agent」和「可編輯」的成員可以投票和留言，
    即時看到彼此的選擇，由 session 的負責人（沒有指派時：開 session 的人）送出答案。「旁觀」的成員只能看。
  - spec 與計畫：agent 在專案裡寫出 `specs/<主題>/SPEC.md` 和 `PLAN.md`。大家可以在瀏覽器裡一起編輯這兩個檔案，或請
    agent 修改。計畫是一份工作項目的清單；agent 會建議每個項目由誰負責，大家可以改，或選「不指派：大家一起看」。
  - 執行：按下開始後，每個工作項目開一個 agent session，各自在自己的 git worktree 裡，並且先把 spec 和計畫提交到主人的
    儲存庫（對話框會事先說明）。依賴其他項目的工作項目，會在那些項目合併之後自己開始，而且只從按開始時確認過的 spec
    和計畫開始。
  - 結果報告：完成的項目有一份固定段落的報告（做了什麼、為什麼這樣做、怎麼驗證的、要注意什麼）和它的 diff。負責人可以
    追問，然後按「我已看過」；看過的變更會在主人的收件夾等待，由主人合併。每個項目都看過之後，主題就完成了。
- **agent session 是對話，不是終端機。** smurg 現在以結構化的對話執行 Claude Code：訊息、agent 的工具做了什麼、選擇題和
  權限請求，都顯示成附有卡片的對話，每個人都讀得到全部內容，之後才加入的成員也一樣。需要 shell 的人仍然可以用一般的
  終端機 session。不再有的功能：在 agent 的終端機裡打字、Claude Code 的斜線指令和 session 裡的 `/login`，以及把 agent
  接到自己的終端機（`smurg attach` 只接上終端機 session，並列出 agent session 和它們的主題與狀態）。
- **每個成員都有收件夾**：由你決定的選擇題、還開著的投票、權限請求、停下來需要有人處理的工作、建議、待看的結果報告、
  可以合併的變更，以及提及（`@名稱`）。事情處理完，項目就會離開。該回答選擇題或權限請求的人沒有回答時（預設 5 分鐘；
  主人可以設定），它也會送到主人和「可使用 agent」的成員那裡，他們可以代為回答；沒有人看過的結果報告，過了六倍的時間
  之後也一樣。
- **session 畫面與手寫 code 模式。** 收件夾和依主題分組的 session 清單在左邊；右邊最多可以並排四欄（對話、spec、計畫、
  結果報告）。檔案樹、編輯器、活動動態和終端機現在是「手寫 code 模式」，用最上面一排的開關切換；兩邊都會保留原來的狀態。
- **agent 執行指令前會先問。** 工作項目的 agent 在自己的 worktree 裡改檔案不用先問，執行指令前會先問（唯讀的指令和
  worktree 裡簡單的檔案指令除外）；只有主人和「可使用 agent」的成員可以允許請求，可以只允許一次，也可以一律允許那一類指令，範圍是一個 session 或一個主題的所有
  session。不論 Claude Code 的設定允許什麼，agent 每一次使用工具之前都會先經過 smurg 自己的檢查：討論 agent 只能讀專案、
  寫它的主題的 spec 和計畫。見[主人指南](HOSTING.md) §5.2。
- **建議現在送給 agent session**，不再送給終端機。「可編輯」的成員傳的訊息是對話裡的一張卡片，要由主人或「可使用 agent」
  的成員採用，agent 才會收到，而且收到的就是畫面上顯示的那段文字。「可編輯」的成員現在也可以投票、留言、當 session 或
  工作項目的負責人，並檢視它的報告。
- **主人自己的 Claude Code**（[主人指南](HOSTING.md) §5.3）：主人自己的 Claude Code 設定裡的允許規則對 agent session
  也有效，smurg 會告訴主人一次是哪些；主人的 MCP 伺服器預設不給 agent 用，除非主人打開；分享資料夾裡的 Claude Code 專案
  設定，要等主人確認過它們做的事之後才會使用；`CLAUDE.md` 透過 smurg 只有主人能改。
- **用的是誰的 Claude 帳號**：所有人的 agent 仍然都用主人的 Claude Code 登入。個人的 Pro 或 Max 訂閱只供主人自己使用：
  主人指南（§4）和主人控制台現在會說明哪一種帳號適合多人使用；工作區有其他成員、而 agent 用的是個人訂閱時，主人每次
  執行 `smurg host` 會收到一次提醒。
- **agent session 重新啟動後還在。** `smurg stop` 會結束終端機 session、暫停 agent session；對話保存在主人的電腦上
  （在 `~/.smurg` 裡，`smurg uninstall` 會移除）。`smurg host` 再次啟動後什麼都不會自己執行：執行到一半的計畫會暫停，直到
  主人或「可使用 agent」的成員按「全部繼續」。`smurg status` 現在也會顯示 Claude Code 的版本與登入狀態、agent session、
  主題，以及資料夾的 Claude Code 專案設定有沒有確認。
- **需求**：agent session 需要主人的電腦上有 Claude Code 2.1.288 以上（版本太舊會被拒絕）；執行工作項目需要分享的資料夾
  是至少有一個提交的 git 儲存庫，git 也要 2.42 以上。
- **這個版本不會讀取舊版本寫下的東西。** 主人、網頁版（relay 的版本）和每個 `smurg attach` 都要用這個版本：它們之間的
  通訊協定改了（第 4 版），版本不同的連線會被拒絕。舊版本的工作區狀態（成員、邀請連結、session）不會被轉換：
  `smurg host` 會說明，並指出要移開的資料夾（[主人指南](HOSTING.md) §8）。自己架設 relay 的話，更新之前請先用這個版本
  重新部署它。
- **驗證過什麼**：主題的流程是用照劇本回應的模型替身測試的，真正的 Claude Code 只對著假的 API 執行過，而且只在 macOS 上
  （沒有在 Linux 上）；沒有使用任何真正的 Claude 帳號。真正的模型在這個流程裡的表現，可能需要在之後的版本調整（[主人指南](HOSTING.md) §10.8）。

## [0.4.0] - 2026-10-02

- **英文為主，繁體中文為輔。** smurg 顯示的所有文字現在都有兩種語言，預設是英文：網頁版、`smurg` 指令、relay 的登入頁、
  安裝程式、使用說明和 smurg.ai。每個人看到的是自己的語言，在同一個工作區裡也一樣：主人用英文、組員用繁體中文也沒問題。
  - 網頁版：一開始依瀏覽器的語言（瀏覽器的語言清單裡，smurg 支援的語言中繁體中文排在最前面就用繁體中文，否則用英文），
    新的語言選單可以直接切換，不用重新載入；選擇會被記住，relay 的登入頁也跟著它。
  - `smurg` 指令與安裝程式：依這台電腦的語言設定（`LC_ALL`、`LC_MESSAGES`、`LANG`；在 macOS 上這三個都沒有設定時，
    看系統的語言），不是繁體中文就印英文。要自己指定，用 `SMURG_LANG=en` 或 `SMURG_LANG=zh-TW`。
  - 角色的英文名稱是 Host、Agent access、Editor、Viewer（中文不變：主人、可使用 agent、可編輯、旁觀）。agent 的名稱現在在
    兩種語言裡寫法相同：`Claude (Amy)`。
  - agent 讀到的文字（hook 的訊息、MCP 工具的文字）、git 的提交訊息和紀錄檔，在兩種語言裡都是英文。
  - 使用說明：英文在 https://smurg.ai/docs/，繁體中文在 https://smurg.ai/zh-TW/docs/；語言怎麼選，見
    [主人指南](HOSTING.md) §1。
- **smurg 現在是開放原始碼軟體，以 MIT 授權條款釋出。** 原始碼在 https://github.com/gclinian/smurg，授權條款在
  https://smurg.ai/zh-TW/license/。0.1.0 到 0.3.0 是專有軟體的版本，已經不再提供下載。relay 的原始碼也公開了，所以現在可以用
  自己的 Cloudflare 帳號架設自己的 relay，不必用公用的那一個（[主人指南](HOSTING.md) §2.2）。
- 主人和每個 `smurg attach` 都要用這個版本：兩者之間的通訊協定改了（第 3 版），版本不同的連線會被拒絕。網頁版一定和 relay
  是同一個版本。舊版本記下的活動，不會再顯示在活動動態裡。
- 發佈：執行檔只在 https://downloads.smurg.ai 提供；每個版本的 GitHub release 只附上發佈說明、`SHA256SUMS` 和第三方授權聲明。
- 網頁版修正：已經結束的 session，分頁現在可以關閉（分頁上的關閉按鈕、Delete 鍵或滑鼠中鍵；每個人關的是自己畫面上的
  分頁，還在執行的 session 不能這樣關）。session 結束很久之後還開著的分頁，會說明內容已經不在了，不再顯示一個不可能成功的
  「重試」。
- 網頁版修正：編輯器和 session 區中間的分隔線（以及另外三條分隔線），滑鼠只是經過時不會再自己移動。只有按住滑鼠主要按鍵
  時才會移動，線會留在你抓住它的位置，從線的兩側都抓得到；按 Escape 取消拖曳，按兩下恢復預設大小。
- 網頁版修正：檔案樹標題列的「新增檔案」、「新增資料夾」和上傳按鈕，在你還沒選取樹裡的任何項目之前，目標是最上層的資料夾。
  以前對主人來說，目標會是清單裡的第一個資料夾 `.smurg`（smurg 自己的資料夾）。

## [0.3.0] - 2026-10-02

- **`smurg update`**：把 smurg 更新到最新版本。它從 `https://downloads.smurg.ai` 下載這台電腦的執行檔，sha256 與那個版本的
  `SHA256SUMS` 相符才原地換掉目前的執行檔，並印出「舊版本 → 新版本」；`smurg update --check` 只檢查有沒有新版本。正在分享時
  請先 `smurg stop`（分享中不能更新）。有新版本時，`smurg host` 會在兩個連結下面多印一行提示；不要這個檢查可以設定
  `SMURG_NO_UPDATE_CHECK=1`。見[主人指南](HOSTING.md) §9。
- **`smurg uninstall`**：從這台電腦移除 smurg：執行檔、快取和 `~/.smurg`（登入、金鑰、工作區狀態；`--keep-data` 保留）。
  它先列出每一個要移除的路徑，確認之後才動手（`--yes` 不詢問），正在分享的工作區會先停止。專案資料夾裡的 `.smurg/`
  （worktree 和還沒合併的修改）不會動，只會列出來讓你自己決定。

## [0.2.0] - 2026-10-02

- **「可執行 agent」改成「可使用 agent」，組員不再有自己的 agent 和沙盒**：主人可以把「可使用 agent」給完全信任的組員，
  他就能在主人的電腦上開 agent 和終端機（共享主工作區或 worktree），也能直接在任何 session 裡輸入。這些 session
  **以主人的身分執行**：用主人的 Claude Code 登入（費用算主人的）、在主人的電腦上、沒有沙盒，所以這個組員能讓 agent
  執行任何指令、讀主人的家目錄。「可編輯」照舊提出建議，「旁觀」照舊只能看；worktree 照舊，「可使用 agent」的組員可以為任何 worktree 提出
  合併請求，合併仍由主人決定。
  見[主人指南](HOSTING.md) §5.1，包括收回這個角色之後要做的檢查。
- 因此移除：客人沙盒（macOS 的 Seatbelt、Linux 的 bubblewrap）、組員登入 Claude 與 API key、「匯入個人設定」、
  `--no-guest-subscription-login` 與 `--allow-main-workspace-guests` / `--no-main-workspace-guests`。安裝程式在 Linux 上
  也不再安裝 bubblewrap、socat、ripgrep 或 AppArmor 設定檔：每個平台都只安裝執行檔，不需要 sudo。
- 這台電腦上的控制 socket（`smurg attach` 在主人自己的電腦上用的）現在只能列出、接上 session 和在 session 裡輸入。
  因為每個 session 都以主人的作業系統帳號執行，有「可使用 agent」的組員也連得到它；改角色、踢人、終止 session、
  核准合併、邀請連結、設定和操作紀錄都只能在網頁上做；即時的操作紀錄和只給主人的通知也不會送到控制 socket。透過控制
  socket 做的事，操作紀錄會註明 `via: control-socket`，被拒絕的次數也另外計算，不會擠掉你在網頁上被拒絕的紀錄。
- 主人換了工作區的金鑰之後（例如收回「可使用 agent」之後把工作區狀態移走再分享，見[主人指南](HOSTING.md) §5.1），
  用 `smurg attach` 加入過的組員拿新的邀請連結加入時，`smurg attach` 會像網頁一樣說明「主人的電腦金鑰和之前不同」，
  印出上次記錄的和邀請連結的金鑰指紋，組員輸入 `y` 確認（不在終端機裡執行時加上 `--accept-new-key`）才改用新的金鑰；
  以前只會中止連線，沒有辦法繼續。`smurg attach --help` 也改正了：主人和「可使用 agent」的組員可以在任何 session 裡輸入。
- 工作區的狀態檔是別的 smurg 版本寫的（或格式不對）時，`smurg host` 說清楚是這個原因，把哪個檔案、什麼問題記在紀錄檔，
  並說明怎麼重新分享（把 `~/.smurg/workspaces/<工作區代碼>/` 移走再分享一次，組員重新加入）。smurg 不轉換其他版本的狀態。
- `smurg host` 開始分享時只印出兩個連結（你自己的、給組員的）和停止的方法。分享前須知、各項設定的意思、金鑰指紋、
  防止睡眠與紀錄檔的說明都在[主人指南](HOSTING.md)（§3 到 §7），終端機只在需要你處理時提示：無法防止睡眠，
  以及分享中的連線、登入與狀態檔問題。`smurg status` 現在也顯示 relay 的網址、daemon 金鑰指紋、agent 的 shell 指令
  通知是否開啟和紀錄檔的位置。
- **用代碼登入 relay**：`smurg login`（以及需要登入時的 `smurg host`、`smurg attach`）印出一個網址
  （公用 relay：`https://app.smurg.ai/device`）和一組 8 個英文字母的代碼（10 分鐘內有效）。在任何裝置（電腦或手機）的
  瀏覽器打開網址、用 Google 帳號登入、輸入代碼，確認頁會列出要登入的帳號、這次登入從哪裡要求（IP 位址和大概位置）和時間，
  按「允許」就完成；只有你自己剛執行 `smurg login` 時才按「允許」，別人給你的代碼請按「拒絕」。有桌面的電腦會自動打開
  這個網址（不帶代碼）；**透過 SSH 使用時不再需要 `ssh -L` 轉接埠**，用你面前的電腦或手機輸入代碼就好。等待時按 Ctrl-C
  可以取消。見[主人指南](HOSTING.md) §2。
- 舊的登入方式（瀏覽器確認頁上的確認碼，登入結果回到這台電腦的本機埠）已移除。`smurg login --provider` 也已移除：
  登入方式在瀏覽器裡選。

## [0.1.0] - 2026-10-01

（2026-10-02 起已從 downloads.smurg.ai 下架，由 0.2.0 取代。）

第一個發佈的版本：原型。一個人（主人）在自己的電腦上執行 `smurg host`，
把一個專案資料夾分享出來；組員用瀏覽器或 `smurg` 指令透過 relay 連進來，一起即時編輯檔案，一起看和指揮
Claude Code。檔案和 agent session 都留在主人的電腦上；relay 只轉送端對端加密後的資料，看不到內容。

### 安裝與登入

- 一行指令安裝單一執行檔（不需要 Node.js）：`curl -fsSL https://smurg.ai/install.sh | sh`
  （smurg.ai 只是轉到最新版本的 `https://downloads.smurg.ai/latest/install.sh`；這個版本：
  `curl -fsSL https://downloads.smurg.ai/v0.1.0/install.sh | sh`）。
  提供 macOS（Apple silicon、Intel）與 Linux（x64、arm64，glibc）四種版本；安裝程式只安裝 sha256 與發佈的
  `SHA256SUMS` 相符的執行檔，放在 `~/.local/bin/smurg`，不需要 sudo。Linux 上它會檢查客人沙盒需要的套件
  （bubblewrap、socat、ripgrep）與 Ubuntu 24.04 以上的 AppArmor 限制，**經主人同意後**才用 sudo 安裝。
- 公用 relay https://app.smurg.ai（Cloudflare Workers，也是網頁版：組員的邀請連結是
  `https://app.smurg.ai/join/<工作區>#…`）是 smurg 內建的預設 relay，主人和組員都用 Google 帳號登入：`smurg login`。
  `smurg login --relay <網址>` 可以改用維護者另外提供的 relay。
- 產品介紹頁：https://smurg.ai（英文）與 https://smurg.ai/zh-TW/（繁體中文）；使用說明（繁體中文）：
  https://smurg.ai/docs/。
- 在 **Linux** 上分享時，組員的 session 預設只能在自己的 worktree 裡執行（分享的資料夾必須是 git repository）；
  要讓組員也能在共享主工作區開 session，用 `smurg host --allow-main-workspace-guests` 分享（開始訊息會列出 Linux 上的
  限制）。macOS 預設開放，`--no-main-workspace-guests` 可以關掉。

### 授權

- smurg 是專有軟體，原始碼不公開。執行檔與網頁版在原型階段免費使用，但不能散布、修改或反組譯（法律允許的範圍除外）；
  條款見 https://smurg.ai/license/。
- 執行檔與網頁版包含的第三方軟體各自依照自己的授權：`smurg licenses` 印出 smurg 的條款與執行檔裡的第三方軟體授權聲明，
  每個版本也附上 `THIRD-PARTY-NOTICES.txt`（https://downloads.smurg.ai/v0.1.0/THIRD-PARTY-NOTICES.txt）；網頁版的在
  https://app.smurg.ai/third-party-notices.txt。

### 能做什麼

- 主人一個指令分享資料夾並印出邀請連結；組員的角色有「旁觀」「可編輯」「可執行 agent」三種。
- 瀏覽器裡的檔案樹和編輯器：多人即時共同編輯、自動存檔；拖曳上傳（斷線後可續傳）、下載檔案或整個資料夾（zip）。
- 在主人的電腦上執行真正的 Claude Code：主人的 session 不放沙盒；「可執行 agent」的組員開自己的 session，放在沙盒
  裡，用自己的 Claude 帳號登入。每個人都即時看得到每個 session 的畫面，也可以用 `smurg attach` 接到自己的終端機。
- 人和 agent 都有檔案鎖；互相重疊時保留人打的內容，另一方的版本放進衝突面板。活動動態標示每一次修改是誰、哪個
  agent 做的（包括 agent 用 shell 指令改的檔案）。
- 對別人的 agent 提出建議，由 session 的擁有者採用、修改後採用或拒絕。
- agent 可以在自己的 git worktree 裡工作，完成後由主人看過完整的 diff 再合併。組員開 session 時可以選共享主工作區
  或自己的 worktree；Linux 主人預設只開放 worktree（`--allow-main-workspace-guests` 開放主工作區），組員的網頁會
  說明原因。
- 主人控制台：成員、角色、邀請連結、session、操作紀錄，一鍵踢人或終止 session。
- 主人的電腦睡眠或斷線時，所有人幾秒內看到「主人已離線」。

### 已知限制

- **Linux 主人**：完整的測試（包括客人沙盒與 worktree）在 Ubuntu 24.04 上通過（arm64 虛擬機與 GitHub Actions 的
  x64），但還沒有人真的在 Linux 上當過主人：沒有在 Linux 沙盒裡跑過真正的 Claude Code，安裝程式的 Linux 部分也還沒在
  全新的電腦上跑過。客人沙盒需要 bubblewrap 0.8 以上（Ubuntu 24.04、Debian 12 以上內建的版本即可；Ubuntu 22.04 的
  0.6 太舊，客人 session 會被拒絕）。Linux 的沙盒有幾點做不到 macOS 的程度，所以 **Linux 主人預設不讓組員在共享
  主工作區開 session**，組員只能用自己的 worktree；分享的資料夾不是 git repository 時，組員在 Linux 主人的電腦上
  預設不能開 session（主人可以用 `--allow-main-workspace-guests` 開放）。主人開放之後，最主要的限制是：組員在主工作區
  開的 session 可以在子資料夾裡新增 `.claude`、`.mcp.json`、`.git` 這類只有主人能改的設定（最上層和已經存在的擋得住，
  前提是主人沒有在組員的程序執行中刪除、改名或取代它們），主人在那個子資料夾裡打開自己的工具時要先檢查
  （[主人指南](HOSTING.md) §5）；組員的程序執行期間，主人在分享的資料夾裡儲存、新增、刪除或
  改名（例如 `git switch`）`.envrc`、`.mcp.json`、`.claude/`（包括主人自己的 Claude Code 選「不再詢問」時寫入的
  `.claude/settings.local.json`）、`CLAUDE.local.md` 這類檔案，沙盒無法跟上：smurg 會在發現後（通常 0.1 秒內；在
  `mkdir -p`、`git checkout`、解壓縮一次建好的多層子資料夾裡要等下一次掃描，通常幾秒內）結束那個資料夾裡所有組員的
  程序，並在 `smurg host` 的終端機列出檔名，但在那之前組員的程序可能讀到新的內容或改寫它。所以要編輯這些檔案之前，
  請先請組員結束 session。組員的程序執行期間，專案（或組員的 worktree）最上層原本沒有的 `.claude`、`.git`、`.vscode`、
  `.idea` 會暫時出現為空的資料夾，`.mcp.json`、`.envrc` 為空的唯讀檔案，程序都結束後就會移除；在主人的 git
  repository 裡它們會暫時列在 `.git/info/exclude`，所以 `git status`、`git add -A`、`git stash -u` 不會動到它們
  （`git add -f`、`git clean -x`、`git stash -a` 仍會）。透過 SSH 啟動 `smurg host` 時，Ubuntu 預設不允許防止睡眠。
  組員用什麼作業系統都可以（瀏覽器）。
- 組員在共享主工作區可以寫 `.gitmodules`、`.gitconfig`、`.bashrc`、`.zshrc`、`.profile` 這類檔名（macOS 與 Linux
  都一樣：`smurg host` 一律從自己的工作目錄 `~/.smurg/cwd` 執行，沙盒不再依啟動 `smurg host` 的位置決定是否擋下這些
  檔名）。git 和 shell 不會從專案資料夾執行它們；執行 `git submodule update` 之前請看一下 `.gitmodules`。
- **macOS 執行檔沒有 Apple 簽章**：只有 ad-hoc 簽章，沒有 Developer ID 簽章與公證。用上面的 `curl` 安裝不會被
  Gatekeeper 擋下（安裝程式在驗證 sha256 之後，會移除下載檔案可能帶有的 quarantine 屬性）；用瀏覽器下載的執行檔
  會被擋下。
- **只有一個共用的 relay，而且是 Cloudflare 免費方案**：所有人共用每天的請求數與寫入次數上限。依程式推算（沒有在
  Cloudflare 上量過），大約 4–7 個整天都有人連線的工作區就會用完，大家一起看一個大量輸出的終端機用得更快；用完時到
  台灣時間早上 8 點（UTC 0 點）之前，所有人都無法連線（[主人指南](HOSTING.md) §2.1）。原始碼不公開，目前沒有辦法
  自己架設 relay 來避開這個限制。
- **客人沙盒沒有記憶體、磁碟空間與 CPU 的上限**（macOS 與 Linux）：組員的程序可以讓主人的電腦變慢、用光記憶體或
  磁碟空間；程序數在 Linux 上每個沙盒最多 4096 個，macOS 上則和主人自己共用同一個上限，所以 fork bomb 會讓主人的
  電腦開不了新程序，直到那個 session 結束。
- 組員用 Claude 訂閱帳號登入的流程還沒有用真正的帳號從頭到尾測試過（API key 登入沒有這個問題）。
- 「上線」階段的功能還沒有做，例如主人代為執行組員的指令、操作紀錄篩選。
- 執行檔需要 macOS 11 以上，或 glibc 2.28 以上的 Linux（Ubuntu 20.04 以上）；不支援 musl（Alpine）與 Windows 主人。
