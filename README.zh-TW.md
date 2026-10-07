[English](README.md) | 繁體中文

# smurg

smurg 是給團隊和它的 coding agent 用的即時協作工作區：你在自己的電腦上執行 `smurg host`，把一個專案資料夾分享出去，
組員打開你私訊給他們的邀請連結，就能在瀏覽器裡和你一起工作。團隊和一個 Claude Code agent 討論一個主題，agent 會出選擇題
讓大家決定，再寫出 spec 和計畫；每個工作項目由一個 agent 執行，最後由人閱讀每一份結果報告並標記為已看過。檔案和 agent
都留在你的電腦上，中間轉送資料的 relay 只看得到端對端加密後的資料。產品介紹：https://smurg.ai/zh-TW/；使用說明：
https://smurg.ai/zh-TW/docs/；網頁版（公用 relay）：https://app.smurg.ai。

> **狀態：原型**。在 macOS（Apple Silicon）上開發和測試。主題的流程是用照劇本回應的模型替身驗證的，沒有用真正的 Claude
> 帳號：真正的模型在這個流程裡的表現可能還需要調整（見下面的「還沒驗證的、已知的限制」）。歡迎試用，但請不要分享放了
> 密碼、金鑰或個人資料的資料夾（[主人指南](docs/zh-TW/HOSTING.md) §4）。

## 現在能做什麼

- **一個指令分享資料夾。** 主人拿到邀請連結；組員在瀏覽器加入，角色有「旁觀」「可編輯」「可使用 agent」三種。每個人看到的
  是自己的語言（英文或繁體中文）。
- **主題：從討論到看過的成果。** 一個主題就是一個功能或一件工作。
  - *討論*：大家和同一個 agent 對話。agent 會出選擇題；除了「旁觀」，每個人都可以投票和留言，即時看到彼此的選擇，由
    session 的負責人送出答案。
  - *spec*：agent 寫出 `specs/<主題>/SPEC.md`。大家可以在瀏覽器裡一起編輯，或請 agent 修改。
  - *計畫*：agent 把 spec 變成 `PLAN.md`，一份列出工作項目和先後順序的清單，並建議每個項目由誰負責。大家可以改分工，
    或選擇不指派、大家一起看。
  - *執行*：按下開始後，每個工作項目開一個 agent session，各自在自己的 git worktree 裡。agent 在裡面改檔案不用先問，
    執行指令前會先問（唯讀的指令和 worktree 裡簡單的檔案指令不用問）；「可使用 agent」的成員可以只允許一次，或一律允許
    那一類指令。
  - *檢視*：每個完成的項目都有結果報告（做了什麼、為什麼這樣做、怎麼驗證的、要注意什麼、diff）。負責人可以追問，然後按
    「我已看過」；最後由主人合併。
- **每個人有自己的收件夾**：由你決定的選擇題、還沒投的票、權限請求、停下來的工作、建議、待看的報告、合併、提及。事情
  處理完，項目就會離開。等太久的事也會送到其他能處理的人那裡。
- **並排看好幾樣東西**：右邊最多四欄（對話、spec、計畫、結果報告），左邊是收件夾和依主題分組的 session 清單。
- **角色說到做到**：主人和「可使用 agent」的成員直接傳訊息給 agent；「可編輯」的成員傳的是建議，要有「可使用 agent」的人
  採用，agent 才會收到；「旁觀」只能看。session 都**以主人的身分**執行（主人的 Claude Code 登入、主人的電腦，沒有沙盒），
  所以「可使用 agent」只給主人完全信任的人（[主人指南](docs/zh-TW/HOSTING.md) §5.1）。
- **手寫 code 模式**（切換開關的另一邊）：檔案樹和共同編輯器（多人同時打字、自動存檔）、上傳和下載、一般的終端機 session
  （也可以用 `smurg attach` 接到自己的終端機）、人和 agent 之間的檔案鎖、衝突面板，以及標示每一次修改是誰、哪個 agent
  做的活動動態。
- **主人掌握全局**：只有主人能合併；主人控制台有成員、角色、邀請連結、session、設定和操作紀錄；smurg 重新啟動之後，agent
  session 會以待命的對話留著，有人讓它繼續之前什麼都不會執行。主人的電腦睡眠或斷線時，所有人幾秒內看到「主人已離線」。

## 還沒驗證的、已知的限制

- **主題的流程還沒有用真正的模型跑過。** 每一項測試用的都是照劇本回應的模型替身，真正的 Claude Code（2.1.288）也只對著
  假的 API 執行過，從來沒有對著真正的模型執行；開發者沒有使用任何真正的 Claude 帳號。真正的模型會不會用卡片提出選擇題、會不會用 smurg 檢查的格式寫計畫和
  報告、提出的分工合不合理，都還沒有驗證。smurg 會自己檢查這些格式、請 agent 修正，並把停下來的工作放進收件夾
  （[主人指南](docs/zh-TW/HOSTING.md) §10.8）。
- **「可使用 agent」沒有任何隔離**：這個角色的組員可以開終端機，也可以允許 agent 請求執行的任何事，都是以主人的身分在
  主人的電腦上執行；可以執行任何指令、讀主人的家目錄、用主人的 Claude 帳號（費用算主人的）。只把這個角色給完全信任的人
  （[主人指南](docs/zh-TW/HOSTING.md) §5.1；[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) §11 D-15、§12，英文）。
- **用的是誰的 Claude 帳號**：每個 agent 都用主人的 Claude Code 登入，替組員工作時也一樣。個人的 Claude 訂閱（Pro 或
  Max）只供主人自己使用：Anthropic 的條款不允許把它提供給其他人使用。多人使用時，主人應該讓 Claude Code 改用 API 金鑰、
  Team 或 Enterprise 方案，或雲端供應商登入；smurg 會提醒，但不會阻止主人（[主人指南](docs/zh-TW/HOSTING.md) §4）。
- **每個成員都讀得到每一段對話**，之後才加入的成員也一樣；agent 讀到的任何東西，它都可能說出來。常見金鑰格式的遮蔽只是
  盡力而為，移除對話裡的一則內容也是：卡片、收件夾摘錄和操作紀錄都留有自己的副本（[主人指南](docs/zh-TW/HOSTING.md) §5.4）。
- **agent 不會做的事，以及 smurg 看不到的事**：這個版本的 agent 不會啟動 subagent，訊息裡的 `@路徑` 也不會被換成檔案。
  資料夾的 Claude Code 專案設定會執行腳本時，agent 的 shell 指令只要提到這樣的腳本或它的資料夾，smurg 就會先問人；完全
  沒提到它們的程式（建置、會改寫另一個腳本的腳本），在執行之前是看不到的，所以 hook 的腳本請放在 `.claude/hooks/`
  （[主人指南](docs/zh-TW/HOSTING.md) §5.2、§5.3）。
- **agent 或成員寫的連結**，要把滑鼠停在上面、或用鍵盤移到它上面，才看得到它連到哪裡。連結的文字寫的是另一個地方時，
  smurg 會把目的地直接寫在文字旁邊，但不是每一種長得很像的寫法它都認得出來（例如 `amazon.in` 這種結尾比較少見的名稱）：
  點連結之前請先看它的目的地（[組員指南](docs/zh-TW/JOINING.md) §5）。
- **需求**：agent session 需要主人的電腦上有 Claude Code 2.1.288 以上（版本太舊會被拒絕）；執行工作項目需要分享的資料夾
  是 git 儲存庫（git 2.42 以上）。主人自己的 Claude Code 允許規則對 agent session 也有效；smurg 會告訴主人一次是哪些。
- **Linux 主人**：全部測試在 Ubuntu 24.04 上通過（arm64 虛擬機，以及 GitHub Actions 的 x64），但還沒有人真的在 Linux 上
  當過主人：沒有在 Linux 上跑過真正的 Claude Code，安裝程式也還沒在全新的 Linux 電腦上跑過。組員用什麼作業系統都可以
  （瀏覽器）。
- **macOS 執行檔沒有 Apple 的開發者簽章**（只有 ad-hoc 簽章）。請用下面的一行指令安裝：它先驗證 sha256，再移除
  macOS 的隔離標記（quarantine）。只有 Apple Silicon 的執行檔在開發機上測試過；Intel Mac 與 Linux 的執行檔由 GitHub
  Actions 在各自的平台上建置，並在那裡跑冒煙測試。
- **公用 relay 用 Cloudflare 的免費方案**：所有人共用每天的用量上限，用完時到 UTC 0 點（台灣時間早上 8 點）前都無法連線
  （[主人指南](docs/zh-TW/HOSTING.md) §2）。要避開這個限制，可以自己架設 relay
  （[`apps/relay/README.md`](apps/relay/README.md)，英文）。
- 主人只能用 macOS 或 Linux（不支援 Windows）。還沒有做的：agent 對話的終端機介面（`smurg attach` 只能接上終端機
  session）、針對 spec 某一段的留言、費用或 token 數字。
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

- 要執行 agent，這台電腦還需要已經登入的 `claude` 指令（Claude Code 2.1.288 以上）：每個 agent session 都用這個登入。
  要執行工作項目，資料夾要是至少有一個提交的 git 儲存庫。
- 更新：`smurg update`（正在分享時先 `smurg stop`；更新前先讀變更紀錄：這個版本不會讀取舊版本的工作區狀態）。移除：
  `smurg uninstall` 會列出並移除執行檔 `~/.local/bin/smurg`、`~/.smurg`（登入、金鑰、工作區狀態、對話）和快取目錄
  （macOS：`~/Library/Caches/smurg`；Linux：`~/.cache/smurg`），不會動專案資料夾裡的 `.smurg/`
  （[主人指南](docs/zh-TW/HOSTING.md) §9）。

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
4. 打開你自己的連結，按「新增主題」：寫下這個功能或這件工作的名稱，就會開始和 agent 討論。

分享之前請先讀[主人指南](docs/zh-TW/HOSTING.md)（尤其是 §4「分享前必讀」，以及 §5：agent 在你的電腦上能做什麼）。

## 快速開始：組員

1. 用電腦上的 Chrome 打開主人私訊給你的邀請連結（不需要安裝任何東西；Safari、Firefox 還沒測試過）。
2. 按「使用 Google 登入」。smurg 只用登入確認你是誰，不會取得你的程式碼；你不需要 Claude 帳號。
3. 確認畫面上的工作區和你的身分，按「加入」。左邊的收件夾會顯示等你處理的事：一張還沒投的票、一題要你決定的選擇題、
   一份待看的報告。

第一次使用 smurg 或 Claude Code 的人也看得懂的完整說明（角色、收件夾與欄、和 agent 對話、投票、主題從討論到看過結果、
共同編輯、worktree、離開）：[組員指南](docs/zh-TW/JOINING.md)。想把終端機 session 接到自己的終端機：照上面的「安裝」
裝好 smurg，執行 `smurg attach --invite -`，再貼上邀請連結（組員指南 §10）。

## 文件

| 文件 | 內容 |
|---|---|
| [主人指南](docs/zh-TW/HOSTING.md)（[English](docs/HOSTING.md)） | 安裝、登入、公用 relay 與自己架設、分享、分享前須知、「可使用 agent」角色與風險、agent 能做什麼與你自己的 Claude Code 設定、停止、疑難排解、更新與移除、主題裡主人要做的事 |
| [組員指南](docs/zh-TW/JOINING.md)（[English](docs/JOINING.md)） | 第一次使用 smurg 和 Claude Code 的人也看得懂：角色、收件夾、和 agent 對話、主題從討論到看過結果 |
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

想在自己的電腦上把整套系統跑起來試試（relay、網頁、`smurg host`），用 `scripts/dev-stack.sh --stand-in-claude`：agent
session 會由一個照劇本回應的 Claude Code 替身執行，不需要帳號、不連網路，也不會產生費用。改用 `--real-claude` 的話，
agent session 執行的是這台電腦上安裝的 Claude Code，用的是它找到的登入，也就是你自己的帳號。兩個都不加時：電腦上沒有
`claude` 的話，agent session 會回答找不到 Claude Code（終端機、檔案和其他功能照常）；有 `claude` 的話，它會在啟動前先
說清楚 agent session 將使用真正的 Claude Code 和你的登入；如果不是在終端機裡執行（例如由腳本或測試執行），它什麼都不
啟動，並請你從這兩個選項裡選一個。
