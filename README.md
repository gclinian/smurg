# smurg

smurg 是一個多人 × 多 agent 的即時協作工作區：你在自己的電腦上執行 `smurg host`，把一個專案資料夾分享出去，
組員打開你私訊給他們的邀請連結，就能在瀏覽器裡和你一起即時編輯檔案。大家也能即時看到每一個 Claude Code session
在做什麼，對它提出建議；你完全信任的組員（「可使用 agent」）還能在你的電腦上開 agent。檔案和 agent 都留在你的
電腦上，中間轉送資料的 relay 只看得到端對端加密後的資料。產品介紹：https://smurg.ai；使用說明：
https://smurg.ai/docs/；網頁版（公用 relay）：https://app.smurg.ai。

> **狀態：原型（v0.1.0）**。在 macOS（Apple Silicon）上開發和測試；其他平台與真實帳號的部分見下面的
> 「還沒驗證的」。歡迎試用，但請不要分享放了密碼、金鑰或個人資料的資料夾（[`docs/HOSTING.md`](docs/HOSTING.md) §4）。

## 現在能做什麼

- 主人一個指令分享資料夾並印出邀請連結；組員用連結加入，角色有「旁觀」「可編輯」「可使用 agent」三種。
- 瀏覽器裡的檔案樹和編輯器：多人即時共同編輯、自動存檔；拖曳上傳（斷線後可續傳）、下載檔案或整個資料夾（zip）。
- 在主人的電腦上執行真正的 Claude Code。主人和「可使用 agent」的組員都能開 agent 和終端機 session，也能在任何 session
  裡直接輸入；這些 session 都**以主人的身分**執行（主人的 Claude Code 登入、主人的電腦，沒有沙盒），所以這個角色只給
  主人完全信任的人（[`docs/HOSTING.md`](docs/HOSTING.md) §5.1）。每個人都即時看得到每個 session 的畫面，也可以用
  `smurg attach` 接到自己的終端機。
- 人和 agent 都有檔案鎖：有人正在打字的檔案 agent 改不了；agent 正在改的檔案，編輯器暫時唯讀。互相重疊時保留人打的
  內容，另一方的版本放進衝突面板。活動動態標示每一次修改是誰、哪個 agent 做的。
- 「可編輯」的組員對 agent 提出建議，由開 session 的人、主人或「可使用 agent」的組員採用、修改後採用或拒絕。
- agent 可以在自己的 git worktree 裡工作，完成後請主人看過完整的 diff 再合併。開 session 時可以選共享主工作區或
  一個新的 worktree。
- 主人控制台：成員、角色、邀請連結、session、操作紀錄，一鍵踢人或終止 session。
- 主人的電腦睡眠或斷線時，所有人幾秒內看到「主人已離線」。

## 還沒驗證的、已知的限制

- **「可使用 agent」沒有任何隔離**：這個角色的組員開的 session 以主人的身分在主人的電腦上執行，可以執行任何指令、讀主人
  的家目錄、用主人的 Claude 帳號（費用算主人的）。smurg 不限制這些事，只把這個角色給完全信任的人
  （[`docs/HOSTING.md`](docs/HOSTING.md) §5.1；[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) §11 D-15、§12）。
- **Linux 主人**：全部測試（包括終端機裡的 Ctrl-C 與調整視窗大小）在 Ubuntu 24.04 上通過（arm64 虛擬機，以及 GitHub
  Actions 的 x64），但還沒有人真的在 Linux 上當過主人：沒有在 Linux 上跑過真正的 Claude Code，安裝程式也還沒在全新的
  Linux 電腦上跑過。組員用什麼作業系統都可以（瀏覽器）。
- **macOS 執行檔沒有 Apple 的開發者簽章**（只有 ad-hoc 簽章）。請用下面的一行指令安裝：它先驗證 sha256，再移除
  macOS 的隔離標記（quarantine）。只有 Apple Silicon 的執行檔在開發機上測試過；Intel Mac 與 Linux 的執行檔由 GitHub
  Actions 在各自的平台上建置，並在那裡跑冒煙測試。
- **公用 relay 用 Cloudflare 的免費方案**：所有人共用每天的用量上限，用完時到台灣時間早上 8 點前都無法連線
  （[`docs/HOSTING.md`](docs/HOSTING.md) §2）。原始碼不公開，其他人無法自己架設 relay，所以目前沒有辦法避開這個限制。
- 主人只能用 macOS 或 Linux（不支援 Windows）。「上線」階段的功能還沒有做，例如主人代為執行組員的指令、操作紀錄篩選。
- 其他已知限制：[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) §12；還沒決定的事項：
  [`docs/OPEN-QUESTIONS.md`](docs/OPEN-QUESTIONS.md)；每一條驗收標準目前的狀態：[`docs/ACCEPTANCE.md`](docs/ACCEPTANCE.md)。

## 安裝（主人）

macOS（Apple Silicon、Intel）或 Linux（x64、arm64，glibc）：

```sh
curl -fsSL https://smurg.ai/install.sh | sh
```

`https://smurg.ai/install.sh` 只是轉到 `https://downloads.smurg.ai/latest/install.sh`（最新版本的安裝程式）；安裝程式從
`https://downloads.smurg.ai/v<版本>/` 下載，特定版本：`curl -fsSL https://downloads.smurg.ai/v<版本>/install.sh | sh`。
安裝程式會下載這台電腦的單一執行檔（不需要 Node.js），**只在 sha256 與這個版本的 `SHA256SUMS` 相符時**安裝到
`~/.local/bin/smurg`。`~/.local/bin` 不在 `PATH` 裡時，它會印出要加到 shell 設定檔的那一行（macOS 預設就不在）。
在每個平台上都一樣：不需要 `sudo`，也不安裝任何系統套件。細節見 [`docs/HOSTING.md`](docs/HOSTING.md) §1。

- 要在 session 裡執行 Claude Code，這台電腦還需要已經登入的 `claude` 指令（2.1.220 以上）：每個 agent session 都用
  這個登入；要用 worktree，資料夾要是 git repository。
- 升級：再執行一次同一行指令。移除：刪除 `~/.local/bin/smurg`、`~/.smurg`（登入、金鑰、工作區狀態）和快取目錄
  （macOS：`~/Library/Caches/smurg`；Linux：`~/.cache/smurg`）。

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
   （預設角色「可編輯」、7 天內有效；`--role agent` 改成「可使用 agent」，先讀 [`docs/HOSTING.md`](docs/HOSTING.md) §5.1）。
3. 把邀請連結**私訊**給組員：連結 `#` 之後的部分就是密鑰，不要貼在公開的地方。

分享之前請先讀 [`docs/HOSTING.md`](docs/HOSTING.md)（尤其是 §4「分享前必讀」）。

## 快速開始：組員

1. 用電腦上的 Chrome 打開主人私訊給你的邀請連結（不需要安裝任何東西；Safari、Firefox 還沒測試過）。
2. 按「使用 Google 登入」。smurg 只用登入確認你是誰，不會取得你的程式碼；你不需要 Claude 帳號。
3. 確認畫面上的工作區和你的身分，按「加入」。

第一次使用 smurg 或 Claude Code 的人也看得懂的完整說明（角色、共同編輯、檔案鎖、建議、開 agent session、worktree、
離開）：[`docs/JOINING.md`](docs/JOINING.md)。想在自己的終端機看 session：照上面的「安裝」裝好 smurg，執行
`smurg attach --invite -`，再貼上邀請連結（JOINING §10）。

## 文件

| 文件 | 內容 |
|---|---|
| [`docs/HOSTING.md`](docs/HOSTING.md) | 主人指南：安裝、登入、公用 relay、分享、分享前須知、「可使用 agent」角色與風險、停止、疑難排解 |
| [`docs/JOINING.md`](docs/JOINING.md) | 組員指南：第一次使用 smurg 和 Claude Code 的人也看得懂 |
| [`docs/RELEASING.md`](docs/RELEASING.md) | 維護者：部署公用 relay、發佈新版本、部署產品介紹頁、回復舊版（英文） |
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) | 各套件之間的約定（寫程式前請先讀 §0 的規則）、刻意偏離 SPEC 的地方（§11）、已知限制（§12） |
| [`docs/ACCEPTANCE.md`](docs/ACCEPTANCE.md) | 每一條驗收標準、對應的自動化測試和狀態 |
| [`docs/OPEN-QUESTIONS.md`](docs/OPEN-QUESTIONS.md) | 還沒決定的事項與已經做的決定 |
| [`SPEC.md`](SPEC.md)、[`docs/research/`](docs/research/) | 需求；寫程式前做過的技術驗證 |
| [`apps/relay/README.md`](apps/relay/README.md) | relay 的路由、設定與部署（維護者） |
| [`apps/site/README.md`](apps/site/README.md) | 產品介紹頁 smurg.ai：內容、轉址與部署（英文） |

## 授權

smurg 是專有軟體（proprietary），原始碼不公開；執行檔與網頁版在原型階段免費使用。條款見 [`LICENSE`](LICENSE)
（授權條款網頁：https://smurg.ai/license/）。執行檔與網頁版包含的第三方軟體，各自依照它們自己的授權：清單與授權全文是
[`packages/cli/THIRD-PARTY-NOTICES.txt`](packages/cli/THIRD-PARTY-NOTICES.txt)（執行檔；`smurg licenses` 印出的版本另外
加上 Node.js 的授權）與 [`apps/web/public/third-party-notices.txt`](apps/web/public/third-party-notices.txt)（網頁版，
https://app.smurg.ai/third-party-notices.txt）。這兩個檔案由 `node scripts/third-party-notices.ts` 從 `pnpm-lock.yaml` 與
安裝好的套件產生，不要手動修改：相依套件改變後重新產生並提交（`pnpm check`、`scripts/build-sea.sh` 與網頁的建置都會拒絕
過時的檔案）。

---

以下是開發者需要的資訊。

## 從原始碼開發

需求：macOS 或 Linux、[Node.js](https://nodejs.org/) 22 LTS（22.18 以上）或 24 LTS、git。建議用 nvm 安裝
（`nvm install 22`）；Node 25 不在 vitest 支援範圍內，不支援。要在 session 裡執行 Claude Code 的話，還需要 `claude`
指令（2.1.220 以上）。

```sh
gh repo clone gclinian/smurg && cd smurg       # 私人 repository：需要成員權限
scripts/bootstrap-tools.sh                      # 第一次：把固定版本的 pnpm 安裝到 .tools/（不做全域安裝）
source scripts/env.sh                           # 每個新的 shell 都要執行（bash、zsh 皆可）
scripts/with-install-lock.sh pnpm install       # 安裝相依套件（約佔 1 GB 磁碟空間，全部放在 repo 裡）
scripts/dev-stack.sh --role agent               # 在這台電腦上啟動整個系統試用（不需要任何帳號）；Ctrl-C 全部停止
```

`scripts/env.sh` 會把 Node 22 與 repo 內的 pnpm 放到 `PATH` 最前面，並把工具狀態留在 repo 裡
（`XDG_CONFIG_HOME=.xdg`、pnpm store 在 `.tools/`、`WRANGLER_SEND_METRICS=false`、`CI=true`），並設定
`SMURG_NO_BROWSER=1`：從這個 shell 執行的 `smurg` 不會打開你的瀏覽器（見「不要讓 smurg 打開瀏覽器」）。
找不到支援的 Node 時會直接報錯。新增相依套件時請寫入自己套件的 `package.json`（固定版本），再執行
`scripts/with-install-lock.sh pnpm install`。從原始碼執行 CLI：`node packages/cli/src/main.ts <指令>`（或在這個終端機
`alias smurg="node $SMURG_ROOT/packages/cli/src/main.ts"`；`SMURG_ROOT` 由 `scripts/env.sh` 設定）。

## 專案結構

```
apps/
  web/         React + Vite 前端（Monaco、Yjs、xterm.js）
  relay/       Cloudflare Worker + Durable Objects（WorkspaceDO、TransferDO），也負責提供前端頁面（app.smurg.ai）
  site/        產品介紹頁 smurg.ai（靜態頁面，加上 /install.sh 等轉址的小 Worker）
packages/
  protocol/    訊息 schema（zod）、常數、角色、Noise 加密通道、relay 控制訊框與路由
  daemon/      主人端 daemon（檔案、文件、檔案鎖、PTY session、worktree、hooks）
  cli/         `smurg` 指令
tests/
  e2e/         跨套件的驗收測試（真的 relay + daemon + 無頭客戶端）
scripts/       開發環境、單一執行檔、發佈檔案與安裝腳本
docs/          規格、架構與調查報告
```

所有套件都是「原始碼優先」：`exports` 直接指向 `.ts` 原始碼，開發和測試都不需要建置步驟
（Node ≥ 22.18 直接執行 TypeScript）。

## 檢查與常用指令

```sh
pnpm check                                  # 全部套件的型別檢查 + 測試（提交前必跑）
pnpm typecheck                              # 只做型別檢查（TypeScript 7）
pnpm test                                   # 只跑測試（vitest，每個套件一個 project）
pnpm --filter @smurg/protocol test          # 只跑單一套件
pnpm build                                  # 建置前端（Vite）與 relay（wrangler dry-run）
pnpm dev:relay                              # relay 開發伺服器 http://127.0.0.1:8787（本機 workerd，不需 Cloudflare 帳號）
pnpm dev:web                                # 前端開發伺服器 http://localhost:5173（/auth /api /ws /xfer 轉給 relay）
node packages/cli/src/main.ts --version     # 直接從原始碼執行 CLI
```

測試不會連到 127.0.0.1 以外的網路，也不會使用任何真實帳號或憑證。

**檢查（gate）**：`source scripts/env.sh && pnpm check`，不要改 `TMPDIR`，一次只跑一個。綠燈時應該看到的測試檔與
測試數量、花費的時間和驗證過的環境，都寫在 [`docs/ACCEPTANCE.md`](docs/ACCEPTANCE.md)「How to run the gate」（數字隨功能
增加而改變，只記在那裡）。預設略過的是
`packages/cli/test/sea.test.ts`（要先建出單一執行檔，`SMURG_SEA_BINARY`）與 `packages/cli/test/dev-stack.test.ts`
（`SMURG_TEST_DEV_STACK=1`）；沒有系統 Chrome 或驗證過版本的 `claude` 時，相關測試也會略過，數字會不同。
測試沒清掉的暫存目錄與程序（例如 worker 當掉）會在整輪結束後被移除，並在 stderr 印出
`[smurg test run] removed N leftover(s)`：綠燈時不會出現這行，出現了就要找出是哪個測試。

## 本機開發

一個指令在這台電腦上啟動整個系統（relay、網頁開發伺服器、`smurg host` 分享一個範例資料夾），不需要任何帳號：

```sh
scripts/dev-stack.sh                        # 會自己 source scripts/env.sh；按 Ctrl-C 全部停止
scripts/dev-stack.sh --help                 # 選項：--dir、--relay-port、--web-port、--host-user、--role
```

它依序做這些事：

1. 啟動 relay（`apps/relay` 的 `pnpm run dev`，開發用登入開啟）在 `http://localhost:8787`，以及網頁開發伺服器（Vite）
   在 `http://localhost:5173`（`/auth /api /ws /xfer` 轉給 relay）。換埠號時 relay 的 `RELAY_ISSUER`、`ALLOWED_ORIGINS`
   和 Vite 的轉送目標會一起調整。relay 與 Vite 的輸出寫在 `<dir>/logs/`。
2. 在 `<dir>/project` 建立範例專案（有 git 時是一個 git repository），用開發用登入以 `dev:host` 身分
   `smurg login --relay http://localhost:8787 --dev-user host`，再執行
   `smurg host <dir>/project --relay http://localhost:8787 --web-origin http://localhost:5173 --role editor --no-keep-awake`
   （開發環境不防止睡眠；`--role` 來自 dev-stack 的 `--role`）。
3. 印出主人自己的連結和邀請組員的連結（`http://localhost:5173/join/…#k=…&s=…`，只印在終端機）。用瀏覽器打開主人的
   連結，在「開發用登入」的帳號名稱填 `host`；在另一個瀏覽器設定檔或無痕視窗打開邀請連結，用別的名字（例如 `amy`）
   加入。**網址一定要用 `localhost`**，不要用 `127.0.0.1`：relay 的 cookie 和 Origin 檢查都以 `localhost` 為準。
   組員也可以用 CLI 加入，dev-stack 會印出完整指令（組員有自己的假 `HOME` / `SMURG_HOME`）：
   `smurg login --no-browser --dev-user amy --relay http://localhost:8787`，再
   `smurg attach --invite - --relay http://localhost:8787`（執行後貼上邀請連結）。邀請連結指向網頁的 origin（:5173），
   CLI 則要直接連 relay（:8787）：登入是依網址分開記錄的，沒有 `--relay` 時 CLI 會要求另外登入 :5173，並提示改用 `--relay`。
4. 按 Ctrl-C：先讓 `smurg host` 正常停止（中斷所有連線、結束 session），再停止網頁伺服器與 relay。
   每個子程式都在自己的 process group 裡，腳本只會對它自己啟動並記錄下來的 process group 送訊號。

`<dir>` 預設是 `$TMPDIR/smurg-dev-stack`。`smurg` 在這裡用假的 `HOME`（`<dir>/home`）和自己的 `SMURG_HOME`，
所以不會碰到你的 `~/.smurg`、`~/.claude` 或 shell 設定；`SMURG_HOME` 的路徑太長、放不下 Unix socket
（macOS 上限 104 位元組）時，改用 `/tmp/smurg-dev-<uid>-<雜湊>`。腳本結束前會印出主人在這台電腦上接上 session 的指令
（`HOME=… SMURG_HOME=… node packages/cli/src/main.ts attach`）。

### 不要讓 smurg 打開瀏覽器

`smurg login`、`smurg host`、`smurg attach` 在沒有 relay 登入時會用代碼登入，並在有桌面時打開 relay 的 `/device` 頁面。
在自動化執行、測試、審查、SSH 或沒有終端機的情況下，**CLI 不會自己打開瀏覽器**，只把網址和代碼印出來：`SMURG_NO_BROWSER=1`（`scripts/env.sh` 已經設定）、
`CI`、`SSH_CONNECTION`、標準輸入或輸出不是終端機、Linux 沒有顯示器，任何一個成立就不開。每個會登入的指令也都有
`--no-browser`。自動化時請一律先用 `smurg login --no-browser --dev-user 名稱 --relay <下一個指令要用的那個網址>` 登入。
真的要讓 CLI 打開瀏覽器登入真實的 relay 時，對那一個指令設定 `SMURG_NO_BROWSER=0 CI=false`。

## `smurg` 指令

每個指令都有 `--help`。

| 指令 | 用途 |
|---|---|
| `smurg host <資料夾> [--relay 網址] [--role agent\|editor\|viewer] [--expires 期限] [--max-uses 次數] [--name 名稱] [--web-origin 網址] [--no-keep-awake] [--no-browser] [--no-bash-attribution]` | 分享資料夾（前景執行），只印出兩個連結：你自己的和給組員的（`--role agent` 是「可使用 agent」：拿到連結的人以你的身分在你的電腦上開 agent，先讀 `docs/HOSTING.md` §5.1）。agent 的 shell 指令通知預設開啟（`--no-bash-attribution` 關閉）；分享前須知與各項設定的意思在 `docs/HOSTING.md` §4、§5，終端機不重複。只在需要你處理時提示：無法防止睡眠或防止睡眠失效、relay 連線中斷／恢復、relay 拒絕登入（在另一個終端機 `smurg login` 後自動改用新登入）、狀態檔寫不進磁碟 |
| `smurg attach [session] [--workspace ID] [--invite -\|連結] [--relay 網址] [--no-browser] [--accept-new-key]` | 把 session 接到終端機（不指定 session 時列出）；本機正在分享時直接以主人身分接上，否則用這台電腦的裝置金鑰透過 relay 加入。主人和「可使用 agent」的組員可以輸入，其他角色唯讀。`--invite -` 會提示貼上邀請連結（不顯示、不進 shell 歷史）；也可用 `SMURG_INVITE`。只有第一次需要邀請連結。邀請連結的主人金鑰和上次記錄的不同時，先說明「主人的電腦金鑰和之前不同」並問過你（不在終端機裡執行時要加 `--accept-new-key`）才繼續。Ctrl-] 離開 |
| `smurg status [--workspace ID]` / `smurg stop [--workspace ID]` | 查看／停止這台電腦上正在分享的工作區（透過 daemon 的控制 socket）。`status` 顯示 `smurg host` 啟動時不印的資訊：資料夾、relay 與連線、daemon 金鑰指紋、防止睡眠、agent 的 shell 指令通知、紀錄檔的位置 |
| `smurg login [--relay 網址] [--dev-user 名稱] [--no-browser]` | 用代碼登入 relay：印出 relay 的 `/device` 網址和一組代碼，在任何裝置的瀏覽器登入、輸入代碼並按「允許」（透過 SSH 也一樣；登入方式在瀏覽器裡選，公用 relay 只提供 Google）。登入資料存在 `$SMURG_HOME/credentials.json`，權限 0600，依網址分開記錄；`--dev-user` 只能用在本機的 relay |
| `smurg logout [--relay 網址] [--all]` | 忘記 relay 的登入資料 |
| `smurg licenses [--third-party]` | 印出 smurg 的授權條款（`LICENSE`）與執行檔裡第三方軟體的授權聲明（建置時嵌入執行檔；`--third-party` 只印後者，和發佈的 `THIRD-PARTY-NOTICES.txt` 相同） |

選擇 relay 的順序：`--relay`、環境變數 `SMURG_RELAY_URL`、上次登入的 relay，都沒有時使用內建的公用 relay
https://app.smurg.ai（`smurg attach` 先用邀請連結的網址，或上次加入那個工作區時用的 relay）。所有狀態都放在
`SMURG_HOME`（預設 `~/.smurg`）。在這個 repo 裡開發或測試時請一律設定 `SMURG_HOME` 和假的 `HOME`，並用
`--relay http://localhost:8787` 連本機的 relay。

## 打包與發佈

單一執行檔（Node SEA，含 node-pty 等原生模組）：`scripts/build-sea.sh [--node <node>] [--version X.Y.Z] [--target 平台-架構]`
（說明見 `scripts/build-sea.ts` 開頭）。它為這台電腦的平台建出 `packages/cli/dist/smurg-<平台>-<架構>`，再跑
`packages/cli/test/sea.test.ts` 冒煙測試；沒有 `--version` 時版本是 `<套件版本>-dev`。執行檔第一次需要原生模組時
（`smurg host`）會把它們解壓縮到快取目錄 `~/Library/Caches/smurg/native-<id>`（Linux：`$XDG_CACHE_HOME/smurg`），
每次啟動都用 sha256 驗證；`SMURG_CACHE_DIR` 可以改變位置；其他版本的目錄超過 30 天沒用會被刪除。

正式版本由 GitHub Actions 在推送 `v*` 標籤時（`.github/workflows/release.yml`）為四個平台各自建置、跑冒煙測試，
再用 `scripts/release-assets.sh` 產生 `SHA256SUMS`、`install.sh` 與 `THIRD-PARTY-NOTICES.txt`，在這個私人 repository 留一份
GitHub release 作為內部紀錄。公開的下載位置是 Cloudflare R2 的 https://downloads.smurg.ai（`v<版本>/` 與 `latest/`），由
維護者在自己的電腦上驗證後上傳（不經過 CI）；推送到 `main` 與 pull request 由 `.github/workflows/ci.yml` 在 macOS 與
Ubuntu 上跑 `pnpm check`。公用 relay 由維護者用 `scripts/deploy-relay.sh` 部署到 Cloudflare Workers 的自訂網域
app.smurg.ai（每次發佈新版本前，從那個 commit 重新部署）；產品介紹頁與使用說明 smurg.ai（`apps/site`，含
https://smurg.ai/docs/ 與 https://smurg.ai/license/）也由維護者部署。步驟見 [`docs/RELEASING.md`](docs/RELEASING.md)；
每個版本的變更見 [`CHANGELOG.md`](CHANGELOG.md)。
