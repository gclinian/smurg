[English](README.md) | 繁體中文

# smurg

smurg 是一個多人 × 多 agent 的即時協作工作區：你在自己的電腦上執行 `smurg host`，把一個專案資料夾分享出去，
組員打開你私訊給他們的邀請連結，就能在瀏覽器裡和你一起即時編輯檔案。大家也能即時看到每一個 Claude Code session
在做什麼，對它提出建議；你完全信任的組員（「可使用 agent」）還能在你的電腦上開 agent。檔案和 agent 都留在你的
電腦上，中間轉送資料的 relay 只看得到端對端加密後的資料。產品介紹：https://smurg.ai/zh-TW/；使用說明：
https://smurg.ai/zh-TW/docs/；網頁版（公用 relay）：https://app.smurg.ai。

> **狀態：原型**。在 macOS（Apple Silicon）上開發和測試；其他平台與真實帳號的部分見下面的
> 「還沒驗證的、已知的限制」。歡迎試用，但請不要分享放了密碼、金鑰或個人資料的資料夾
> （[主人指南](docs/zh-TW/HOSTING.md) §4）。

## 現在能做什麼

- 主人一個指令分享資料夾並印出邀請連結；組員用連結加入，角色有「旁觀」「可編輯」「可使用 agent」三種。
- 瀏覽器裡的檔案樹和編輯器：多人即時共同編輯、自動存檔；拖曳上傳（斷線後可續傳）、下載檔案或整個資料夾（zip）。
- 在主人的電腦上執行真正的 Claude Code。主人和「可使用 agent」的組員都能開 agent 和終端機 session，也能在任何 session
  裡直接輸入；這些 session 都**以主人的身分**執行（主人的 Claude Code 登入、主人的電腦，沒有沙盒），所以這個角色只給
  主人完全信任的人（[主人指南](docs/zh-TW/HOSTING.md) §5.1）。每個人都即時看得到每個 session 的畫面，也可以用
  `smurg attach` 接到自己的終端機。
- 人和 agent 都有檔案鎖：有人正在打字的檔案 agent 改不了；agent 正在改的檔案，編輯器暫時唯讀。互相重疊時保留人打的
  內容，另一方的版本放進衝突面板。活動動態標示每一次修改是誰、哪個 agent 做的。
- 「可編輯」的組員對 agent 提出建議，由開 session 的人、主人或「可使用 agent」的組員採用、修改後採用或拒絕。
- agent 可以在自己的 git worktree 裡工作，完成後請主人看過完整的 diff 再合併。開 session 時可以選共享主工作區或
  一個新的 worktree。
- 主人控制台：成員、角色、邀請連結、session、操作紀錄，一鍵踢人或終止 session。
- 主人的電腦睡眠或斷線時，所有人幾秒內看到「主人已離線」。
- 介面有英文和繁體中文，每個人看到的是自己的語言（[主人指南](docs/zh-TW/HOSTING.md) §1）。

## 還沒驗證的、已知的限制

- **「可使用 agent」沒有任何隔離**：這個角色的組員開的 session 以主人的身分在主人的電腦上執行，可以執行任何指令、讀主人
  的家目錄、用主人的 Claude 帳號（費用算主人的）。smurg 不限制這些事，只把這個角色給完全信任的人
  （[主人指南](docs/zh-TW/HOSTING.md) §5.1；[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) §11 D-15、§12，英文）。
- **Linux 主人**：全部測試（包括終端機裡的 Ctrl-C 與調整視窗大小）在 Ubuntu 24.04 上通過（arm64 虛擬機，以及 GitHub
  Actions 的 x64），但還沒有人真的在 Linux 上當過主人：沒有在 Linux 上跑過真正的 Claude Code，安裝程式也還沒在全新的
  Linux 電腦上跑過。組員用什麼作業系統都可以（瀏覽器）。
- **macOS 執行檔沒有 Apple 的開發者簽章**（只有 ad-hoc 簽章）。請用下面的一行指令安裝：它先驗證 sha256，再移除
  macOS 的隔離標記（quarantine）。只有 Apple Silicon 的執行檔在開發機上測試過；Intel Mac 與 Linux 的執行檔由 GitHub
  Actions 在各自的平台上建置，並在那裡跑冒煙測試。
- **公用 relay 用 Cloudflare 的免費方案**：所有人共用每天的用量上限，用完時到台灣時間早上 8 點前都無法連線
  （[主人指南](docs/zh-TW/HOSTING.md) §2）。要避開這個限制，可以自己架設 relay
  （[`apps/relay/README.md`](apps/relay/README.md)，英文）。
- 主人只能用 macOS 或 Linux（不支援 Windows）。「上線」階段的功能還沒有做，例如主人代為執行組員的指令、操作紀錄篩選。
- 其他已知限制：[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) §12；每一條驗收標準目前的狀態：
  [`docs/ACCEPTANCE.md`](docs/ACCEPTANCE.md)（都是英文）。

## 安裝（主人）

macOS（Apple Silicon、Intel）或 Linux（x64、arm64，glibc）：

```sh
curl -fsSL https://smurg.ai/install.sh | sh
```

`https://smurg.ai/install.sh` 只是轉到 `https://downloads.smurg.ai/latest/install.sh`（最新版本的安裝程式）；安裝程式從
`https://downloads.smurg.ai/v<版本>/` 下載。安裝程式會下載這台電腦的單一執行檔（不需要 Node.js），**只在 sha256 與這個
版本的 `SHA256SUMS` 相符時**安裝到 `~/.local/bin/smurg`。`~/.local/bin` 不在 `PATH` 裡時，它會印出要加到 shell 設定檔的
那一行（macOS 預設就不在）。在每個平台上都一樣：不需要 `sudo`，也不安裝任何系統套件。細節見
[主人指南](docs/zh-TW/HOSTING.md) §1。

- 要在 session 裡執行 Claude Code，這台電腦還需要已經登入的 `claude` 指令（2.1.220 以上）：每個 agent session 都用
  這個登入；要用 worktree，資料夾要是 git repository。
- 更新：`smurg update`（正在分享時先 `smurg stop`）。移除：`smurg uninstall` 會列出並移除執行檔 `~/.local/bin/smurg`、
  `~/.smurg`（登入、金鑰、工作區狀態）和快取目錄（macOS：`~/Library/Caches/smurg`；Linux：`~/.cache/smurg`），不會動專案
  資料夾裡的 `.smurg/`（[主人指南](docs/zh-TW/HOSTING.md) §9）。

## 快速開始：主人

```sh
smurg login                      # 用代碼登入公用 relay（在任何裝置的瀏覽器以 Google 帳號確認）
smurg host ~/projects/my-app     # 分享資料夾；在前景執行，按 Ctrl-C 停止
```

1. `smurg login` 在終端機印出一個網址（`https://app.smurg.ai/device`）和一組代碼。在任何裝置（電腦或手機）的瀏覽器
   打開網址、登入你的 Google 帳號、輸入代碼，確認頁上的帳號沒錯就按「允許」（有桌面時 smurg 也會自動打開這個網址；
   透過 SSH 也一樣，不需要轉接埠）。不加 `--relay` 時，smurg 使用內建的公用 relay https://app.smurg.ai（也是網頁版的網址）。
   （跳過這一步也可以：`smurg host` 發現還沒登入時會先請你登入。）
2. `smurg host` 只印出兩個連結：**你自己的連結**（在瀏覽器以主人身分打開工作區，不要給別人）和**邀請組員的連結**
   （預設角色「可編輯」、7 天內有效；`--role agent` 改成「可使用 agent」，先讀[主人指南](docs/zh-TW/HOSTING.md) §5.1）。
3. 把邀請連結**私訊**給組員：連結 `#` 之後的部分就是密鑰，不要貼在公開的地方。

分享之前請先讀[主人指南](docs/zh-TW/HOSTING.md)（尤其是 §4「分享前必讀」）。

## 快速開始：組員

1. 用電腦上的 Chrome 打開主人私訊給你的邀請連結（不需要安裝任何東西；Safari、Firefox 還沒測試過）。
2. 按「使用 Google 登入」。smurg 只用登入確認你是誰，不會取得你的程式碼；你不需要 Claude 帳號。
3. 確認畫面上的工作區和你的身分，按「加入」。

第一次使用 smurg 或 Claude Code 的人也看得懂的完整說明（角色、共同編輯、檔案鎖、建議、開 agent session、worktree、
離開）：[組員指南](docs/zh-TW/JOINING.md)。想在自己的終端機看 session：照上面的「安裝」裝好 smurg，執行
`smurg attach --invite -`，再貼上邀請連結（組員指南 §10）。

## 文件

| 文件 | 內容 |
|---|---|
| [主人指南](docs/zh-TW/HOSTING.md)（[English](docs/HOSTING.md)） | 安裝、登入、公用 relay 與自己架設、分享、分享前須知、「可使用 agent」角色與風險、停止、疑難排解、更新與移除 |
| [組員指南](docs/zh-TW/JOINING.md)（[English](docs/JOINING.md)） | 第一次使用 smurg 和 Claude Code 的人也看得懂 |
| [變更紀錄](docs/zh-TW/CHANGELOG.md)（[English](CHANGELOG.md)） | 每個版本的變更 |
| [`docs/GLOSSARY.md`](docs/GLOSSARY.md) | smurg 的用詞（英文與繁體中文對照） |
| [`SPEC.md`](SPEC.md) | 最初的需求（繁體中文） |

## 授權

smurg 是開放原始碼軟體，以 MIT 授權條款釋出：見 [`LICENSE`](LICENSE)（網頁：https://smurg.ai/zh-TW/license/），原始碼在
https://github.com/gclinian/smurg。執行檔與網頁版包含的第三方軟體，各自依照它們自己的授權：清單與授權全文是
[`packages/cli/THIRD-PARTY-NOTICES.txt`](packages/cli/THIRD-PARTY-NOTICES.txt)（執行檔；`smurg licenses` 印出的版本另外
加上 Node.js 的授權）與 [`apps/web/public/third-party-notices.txt`](apps/web/public/third-party-notices.txt)（網頁版，
https://app.smurg.ai/third-party-notices.txt）。

## 開發

從原始碼開發、專案結構、檢查、`smurg` 的每個指令、打包與發佈，以及其他給開發者和維護者的文件（架構、驗收、發佈流程、
relay 與 smurg.ai 的說明），都寫在英文版的 [README.md](README.md)（「The rest is for developers」之後）。想貢獻的話，請先讀
[`CONTRIBUTING.md`](CONTRIBUTING.md)。
