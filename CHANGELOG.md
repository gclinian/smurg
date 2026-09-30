# 變更紀錄

每個發佈版本的變更都記在這裡（格式參考 [Keep a Changelog](https://keepachangelog.com/zh-TW/1.1.0/)，版本號依照
[語意化版本](https://semver.org/lang/zh-TW/)）。推送 `v*` 標籤時，發佈流程（`.github/workflows/release.yml`）會把
該版本的段落放進 GitHub Release 的說明（`scripts/release-assets.sh --notes`）；沒有對應段落的版本不會發佈。

## [0.1.0] - Unreleased

第一個公開版本：原型（[`SPEC.md`](SPEC.md) 的 [Prototype] 範圍）。一個人（主人）在自己的電腦上執行 `smurg host`，
把一個專案資料夾分享出來；組員用瀏覽器或 `smurg` 指令透過 relay 連進來，一起即時編輯檔案，一起看和指揮
Claude Code。檔案和 agent session 都留在主人的電腦上；relay 只轉送端對端加密後的資料，看不到內容。

### 安裝與登入

- 一行指令安裝單一執行檔（不需要 Node.js）：
  `curl -fsSL https://github.com/gclinian/smurg/releases/latest/download/install.sh | sh`。
  提供 macOS（Apple silicon、Intel）與 Linux（x64、arm64，glibc）四種版本；安裝程式只安裝 sha256 與發佈的
  `SHA256SUMS` 相符的執行檔，放在 `~/.local/bin/smurg`，不需要 sudo。Linux 上它會檢查客人沙盒需要的套件
  （bubblewrap、socat、ripgrep）與 Ubuntu 24.04 以上的 AppArmor 限制，**經主人同意後**才用 sudo 安裝。
- 公用 relay https://smurg-relay.gclin-ian.workers.dev（Cloudflare Workers）是 smurg 內建的預設 relay，主人和組員都用 Google 帳號登入：`smurg login`。
  也可以照 [`apps/relay/README.md`](apps/relay/README.md) 部署自己的 relay，再用 `smurg login --relay <網址>` 指定。

### 能做什麼

- 主人一個指令分享資料夾並印出邀請連結；組員的角色有「旁觀」「可編輯」「可執行 agent」三種。
- 瀏覽器裡的檔案樹和編輯器：多人即時共同編輯、自動存檔；拖曳上傳（斷線後可續傳）、下載檔案或整個資料夾（zip）。
- 在主人的電腦上執行真正的 Claude Code：主人的 session 不放沙盒；「可執行 agent」的組員開自己的 session，放在沙盒
  裡，用自己的 Claude 帳號登入。每個人都即時看得到每個 session 的畫面，也可以用 `smurg attach` 接到自己的終端機。
- 人和 agent 都有檔案鎖；互相重疊時保留人打的內容，另一方的版本放進衝突面板。活動動態標示每一次修改是誰、哪個
  agent 做的（包括 agent 用 shell 指令改的檔案）。
- 對別人的 agent 提出建議，由 session 的擁有者採用、修改後採用或拒絕。
- agent 可以在自己的 git worktree 裡工作，完成後由主人看過完整的 diff 再合併。
- 主人控制台：成員、角色、邀請連結、session、操作紀錄，一鍵踢人或終止 session。
- 主人的電腦睡眠或斷線時，所有人幾秒內看到「主人已離線」。

### 已知限制

- **Linux 主人**：完整的測試（包括客人沙盒 R5、worktree R9）在 Ubuntu 24.04 上通過（arm64 虛擬機與 GitHub Actions 的
  x64），但還沒有人真的在 Linux 上當過主人：沒有在 Linux 沙盒裡跑過真正的 Claude Code，安裝程式的 Linux 部分也還沒在
  全新的電腦上跑過。客人沙盒需要 bubblewrap 0.8 以上（Ubuntu 24.04、Debian 12 以上內建的版本即可；Ubuntu 22.04 的
  0.6 太舊，客人 session 會被拒絕）。Linux 的沙盒有幾點做不到 macOS 的程度，最主要的是：組員在**主工作區**開的
  session 可以在子資料夾裡新增 `.claude`、`.mcp.json`、`.git` 這類只有主人能改的設定（最上層和已經存在的都擋得住），
  主人在那個子資料夾裡打開自己的工具時要先檢查（[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) §12）。組員用什麼
  作業系統都可以（瀏覽器）。
- **macOS 執行檔沒有 Apple 簽章**：只有 ad-hoc 簽章，沒有 Developer ID 簽章與公證。用上面的 `curl` 安裝不會被
  Gatekeeper 擋下（安裝程式在驗證 sha256 之後，會移除下載檔案可能帶有的 quarantine 屬性）；用瀏覽器下載的執行檔
  會被擋下。
- **只有一個共用的 relay，而且是 Cloudflare 免費方案**：所有人共用每天的請求數與寫入次數上限。依程式推算（沒有在
  Cloudflare 上量過，[`docs/RELEASING.md`](docs/RELEASING.md) §8），大約 4–7 個整天都有人連線的工作區就會用完，大家一起
  看一個大量輸出的終端機用得更快；用完時到台灣時間早上 8 點（UTC 0 點）之前，所有人都無法連線。重度使用請部署自己的
  relay。
- 組員用 Claude 訂閱帳號登入的流程還沒有用真正的帳號從頭到尾測試過（API key 登入沒有這個問題）。
- 「上線」階段的功能還沒有做，例如主人代為執行組員的指令、操作紀錄篩選。其他已知限制見
  [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) §12。
- 執行檔需要 macOS 11 以上，或 glibc 2.28 以上的 Linux（Ubuntu 20.04 以上）；不支援 musl（Alpine）與 Windows 主人。
