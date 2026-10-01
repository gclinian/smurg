# 變更紀錄

每個發佈版本的變更都記在這裡（格式參考 [Keep a Changelog](https://keepachangelog.com/zh-TW/1.1.0/)，版本號依照
[語意化版本](https://semver.org/lang/zh-TW/)）。每個版本的段落也是那個版本的發佈說明；沒有對應段落的版本不會發佈。

## [0.1.0] - 2026-10-01

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
  （[主人指南](docs/HOSTING.md) §5）；組員的程序執行期間，主人在分享的資料夾裡儲存、新增、刪除或
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
  台灣時間早上 8 點（UTC 0 點）之前，所有人都無法連線（[主人指南](docs/HOSTING.md) §2.1）。原始碼不公開，目前沒有辦法
  自己架設 relay 來避開這個限制。
- **客人沙盒沒有記憶體、磁碟空間與 CPU 的上限**（macOS 與 Linux）：組員的程序可以讓主人的電腦變慢、用光記憶體或
  磁碟空間；程序數在 Linux 上每個沙盒最多 4096 個，macOS 上則和主人自己共用同一個上限，所以 fork bomb 會讓主人的
  電腦開不了新程序，直到那個 session 結束。
- 組員用 Claude 訂閱帳號登入的流程還沒有用真正的帳號從頭到尾測試過（API key 登入沒有這個問題）。
- 「上線」階段的功能還沒有做，例如主人代為執行組員的指令、操作紀錄篩選。
- 執行檔需要 macOS 11 以上，或 glibc 2.28 以上的 Linux（Ubuntu 20.04 以上）；不支援 musl（Alpine）與 Windows 主人。
