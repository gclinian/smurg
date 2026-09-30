# 主人指南：用 smurg 分享資料夾

這份文件寫給**主人**：在自己的電腦上執行 `smurg host`，把一個專案資料夾分享給組員的人。組員請看
[`JOINING.md`](JOINING.md)。（原型階段：以下是目前實作的行為。）

## 1. 安裝

一行指令安裝（macOS：Apple Silicon、Intel；Linux：x64、arm64，glibc）：

```sh
curl -fsSL https://github.com/gclinian/smurg/releases/latest/download/install.sh | sh
```

安裝程式會下載這台電腦的單一執行檔（不需要 Node.js），**只在 sha256 與這個版本的 `SHA256SUMS` 相符時**安裝到
`~/.local/bin/smurg`，並告訴你怎麼把 `~/.local/bin` 加到 `PATH`（加好之後要重新開一個終端機）。在 Linux 上它還會檢查
客人沙盒需要的套件（bubblewrap、socat、ripgrep）和 Ubuntu 24.04 以上的 AppArmor 限制，**經你同意後**用 `sudo` 安裝
套件與只放寬 `/usr/bin/bwrap` 的 AppArmor 設定檔；不同意時它只印出指令。

- macOS 的執行檔沒有 Apple 的開發者簽章（只有 ad-hoc 簽章）。安裝程式驗證 sha256 之後，會移除 macOS 的隔離標記
  （quarantine），所以第一次執行時不會被 Gatekeeper 擋下。請用上面的指令安裝，不要用瀏覽器下載執行檔再手動執行。
- 升級：再執行一次同一行指令（會取代 `~/.local/bin/smurg`；正在分享時請先停止分享）。`smurg --version` 顯示目前的版本。
- 要在 session 裡執行 Claude Code，這台電腦還需要 `claude` 指令（2.1.220 以上）。
- 想從原始碼執行（例如要修改 smurg）：見 README「從原始碼開發」。

## 2. 登入 relay

relay 是 smurg 的伺服器：負責登入，並在你的電腦和組員之間轉送**加密後**的資料。邀請連結、網頁版的工作區也都在
relay 的網址上。

```sh
smurg login          # 用瀏覽器以 Google 帳號登入；不加 --relay 時使用公用 relay（§2.1）
```

- 終端機會印出一組**確認碼**（例如 `確認碼：ZX27-UPQ2`），瀏覽器裡 relay 的確認頁也會顯示一組；兩組相同時才按
  「使用 Google 繼續」。沒有執行 `smurg login` 卻出現這個確認頁（例如別人傳來的連結），請直接關掉。
- 透過 SSH 使用、或在沒有桌面的伺服器上時，smurg 不會打開瀏覽器，而是印出網址與一行 `ssh -N -L <埠>:127.0.0.1:<埠> <主機>`：
  在你面前的電腦執行它，再用那台電腦的瀏覽器打開網址（登入完成時瀏覽器會回到 127.0.0.1 上的那個埠）。
- `--no-browser` 或環境變數 `SMURG_NO_BROWSER=1`：永遠只印網址，不打開瀏覽器。
- 可以跳過這一步：`smurg host` 發現還沒登入時會先請你登入。`smurg host` 開始分享前，如果登入在 24 小時內就會過期，
  也會先請你重新登入。
- 登入資料存在 `~/.smurg/credentials.json`（權限 0600），依 relay 網址分開記錄。

### 2.1 公用 relay（預設）

smurg 的維護者在 Cloudflare 上架設了一個所有人都可以使用的 relay：https://smurg-relay.gclin-ian.workers.dev。發佈版的 smurg 預設就用它，
**你不需要部署任何東西**，只要有 Google 帳號（主人和組員都用 Google 登入）。

**relay 看得到什麼**（ARCHITECTURE §11 D-5）：

- 看不到：檔案內容、檔名、終端機畫面、你或組員輸入的指令、邀請連結的密鑰、任何金鑰。這些在你的電腦和組員的瀏覽器
  （或 CLI）之間端對端加密，relay 只轉送加密後的資料。
- 看得到：每條連線是**哪個 Google 帳號**（帳號 ID、名稱、大頭貼；登入時 Google 也會給 relay 你的 email，只有帳號沒有
  名稱時拿來當顯示名稱）、**從哪個 IP 位址連線**、連到哪個工作區代碼，以及每筆資料的大小和時間。從這些可以看出誰和誰
  在什麼時候一起工作、傳了多少資料。
- 保存：每個工作區的代碼和它的主人是哪個帳號。登入本身不保存（relay 的登入是有效 7 天的簽章權杖）。
- 架設者（smurg 的維護者）和 Cloudflare 因此也可能知道上面「看得到」的內容。不能接受的話，請自己架設 relay（§2.2）。

**免費方案的限制**：公用 relay 用 Cloudflare 的免費方案，**所有使用公用 relay 的人共用**每天固定的用量：

- 用量的單位是連線、每幾秒一次的「主人還在嗎」檢查，以及轉送的每一筆資料。最耗用量的是**大家一起看一個正在大量輸出
  的終端機或 agent**；只是開著工作區、偶爾編輯，用得很少。
- 一天的用量用完時，**所有人**（不只你）都可能連不上：新的連線和登入會失敗，已經連著的也可能中斷，直到台灣時間
  **早上 8 點**（UTC 0 點）重新計算。這時主人的終端機會提示與 relay 的連線中斷，組員看到「無法連上伺服器」，瀏覽器也
  可能顯示 Cloudflare 的錯誤頁（Error 1027）。
- 維護者會觀察用量，必要時改用付費方案。整班同時長時間使用、或不能接受中斷時，請自己架設 relay（§2.2），用你自己的
  Cloudflare 帳號與額度。

### 2.2 自己架設 relay

你、學校或團隊也可以把 relay 部署到自己的 Cloudflare 帳號（步驟見 [`apps/relay/README.md`](../apps/relay/README.md)
「部署到 Cloudflare」與「之後」：Cloudflare 帳號，加上你自己申請的 Google OAuth client；`scripts/deploy-relay.sh`
部署的是只用 Google 登入的設定，要用 GitHub 登入得自己修改設定）。之後用 `--relay` 指定它：

```sh
smurg login --relay https://relay.example.edu      # 換成你的 relay；出現哪些登入按鈕由你的設定決定
smurg host ~/projects/my-app                        # 用上次登入的 relay
```

選擇 relay 的順序：`--relay`、環境變數 `SMURG_RELAY_URL`、上次登入的 relay，都沒有時才用公用 relay。要換回
公用 relay：`smurg login --relay https://smurg-relay.gclin-ian.workers.dev`。你印出的邀請連結會指向你的 relay，組員不需要另外設定。

## 3. 分享

```sh
smurg host ~/projects/my-app
```

`smurg host` 在前景執行，會印出：

- **你自己的連結**（主人專用，只能用一次，7 天內有效）：在瀏覽器以主人身分打開工作區。不要給別人。
- **邀請組員的連結**：預設角色是「可編輯」（editor），7 天內有效、不限次數。連結裡 `#` 之後就是密鑰：
  請用私訊傳給組員，不要貼在公開的地方。選項：`--role runner|editor|viewer`、`--expires 12h`、`--max-uses 3`、
  `--name 顯示名稱`。
- **分享前須知**（§4）與**組員的 Claude 登入、agent 的 shell 指令**這兩項設定的說明（§5）。要關掉其中一項，
  啟動時加上 `--no-guest-subscription-login` 或 `--no-bash-attribution`；關掉的項目會在這裡寫明「已關閉」。
  這兩項設定只能在啟動時決定：要改就先停止分享，再用新的選項執行 `smurg host`（同一個資料夾的工作區和成員
  都會保留，組員不用重新加入）。
- **daemon 金鑰指紋**：組員第一次加入時可以用其他管道（當面、電話）和你核對，確認沒有人（包括 relay）冒充你。
- **客人沙盒是否可用**（啟動後幾秒內印出）：runner 角色的組員在你的電腦上開的 session 會在沙盒裡執行；沙盒無法使用
  時，smurg 會說明原因與修正指令（例如 Linux 缺少套件或 AppArmor 限制），在修好之前 runner 無法開 session，
  其他功能不受影響。

角色：`viewer` 只能看；`editor` 可以編輯檔案；`runner` 還可以在你的電腦上執行 agent（在沙盒裡）。
之後可以在網頁的主人控制台管理成員、角色、邀請與 session，查看操作紀錄。

## 4. 分享前必讀（SPEC §11）

- **資料夾裡的檔案，每個成員都看得到**（旁觀者也一樣），例如 `.env`、設定檔。組員（人）看不到、也下載不到的只有：
  smurg 自己的 `.smurg/`、所有 `.git` 資料夾、`.envrc`，以及你個人的 Claude Code 設定（`.claude/settings.local.json`、
  `CLAUDE.local.md`）。但是組員在「共享主工作區」執行的 agent 仍然讀得到 `.git`（git 需要），所以不要把 token 寫在
  git 的遠端網址裡。不要分享放了密碼、金鑰或個人資料的資料夾；也不能分享整個家目錄或包含家目錄的資料夾。
- **你自己的 Claude Code session 不在沙盒裡**，而且會讀到組員寫入或修改的檔案。檔案裡可能藏有要 agent 執行的指示
  （prompt injection）。請保留 Claude Code 的權限確認，不要自動核准，並留意最近被組員修改過的檔案。
- 組員在你的電腦上執行 agent 時，**他們的 Claude 登入憑證會存放在你的電腦上**（用訂閱帳號或 API key 登入都一樣），
  技術上你讀得到。請組員使用有花費上限的 API key；組員按「離開」或被移出時，smurg 會登出並刪除他們的暫存目錄
  （沒有連線超過 7 天的也會刪除）。
- 組員只能在 `smurg host` 執行、而且你的電腦連線時使用這個工作區。

## 5. 組員的 Claude 登入、agent 的 shell 指令

這兩項預設開啟，`smurg host` 的開始訊息會說明；不想要的話，啟動時用對應的選項關掉。

**組員用 Claude 訂閱帳號登入**（關掉：`--no-guest-subscription-login`）

「可執行 agent」（runner）的組員在你的電腦上用 Claude，要登入**他們自己的**帳號：用自己的 API key，或用自己的
Claude 訂閱帳號。組員的 agent 和終端機都在沙盒裡，不能在你的電腦上開任何網路埠，而 Claude Code 的訂閱登入需要
開一個網路埠來接收登入結果，所以在 agent session 裡輸入 `/login` 會失敗。smurg 因此另外提供一個**登入程序**：

- 由組員自己開始，一次一個。smurg 在那位組員的沙盒裡執行固定的指令 `claude auth login --claudeai`，終端機顯示
  登入網址；組員在自己的瀏覽器登入，再把授權碼貼回終端機。你的電腦上不會打開任何瀏覽器。還沒有用真正的帳號從頭到尾
  測試過（只測到顯示網址、等待授權碼）。
- 只有那位組員自己看得到、接得上這個程序；它的輸出（登入網址、授權碼）不會寫進紀錄檔或操作紀錄，操作紀錄只記下
  開始和結束（結束代碼）。
- 它只能讀寫那位組員自己的暫存目錄，讀不到分享的資料夾和任何 worktree，也連不到你電腦上的其他服務。
- **登入期間（最多 10 分鐘）它可以在你的電腦上開一個網路埠**，等待登入完成；除了它之外，組員的程式都不能開網路埠。
  macOS 的沙盒沒辦法把這個網路埠限制在只有本機（127.0.0.1）連得到，所以 smurg 同時規定這個程序只能執行
  Claude Code 本身（加上沙盒需要的 bash 與 macOS 的 `security` 指令）；Claude Code 自己只在 127.0.0.1 上等待。
  在 Linux 上，沙盒給這個程序一個獨立的網路環境，別的程式連不到它的網路埠（Linux 的部分還沒有實際執行過）。
- 登入完成、組員結束它，或 10 分鐘到了，程序就結束。組員已經開著的 agent session 會在下一次輸入時用上新的登入，
  不必重開。
- 登入憑證存在那位組員的暫存目錄，和 API key 一樣，技術上你讀得到（§4）。

關掉之後，組員開始登入程序時會看到「這個工作區的主人沒有開放 Claude 訂閱登入」，只能用自己的 API key。你自己的
Claude Code 不受影響（你的 session 不在沙盒裡，照平常的方式登入）。組員在網頁的登入說明按「用 Claude 訂閱登入」開始
登入程序；你關掉這項設定時，smurg 會告訴組員的網頁，登入說明就不再顯示這個按鈕，只提供 API key 並說明原因。

**agent 的 shell 指令通知**（關掉：`--no-bash-attribution`）

agent 用 Edit、Write 等工具改檔案時，smurg 本來就知道是哪個 agent 改的。agent 用 shell 指令（例如 `sed -i`、
格式化工具）改的檔案，smurg 原本只能在活動動態裡顯示成「外部程式」。現在：

- 每個 agent session（**包括你自己的**）執行 shell 指令時，會通知這台電腦上的 smurg 指令何時開始、何時結束。
  **不含指令內容和輸出**，也不會擋下任何指令：smurg 沒有回應時，指令照常執行，只是不會記在那個 agent 名下。
- 檔案在「只有一個 agent 正在執行 shell 指令」的期間（加上指令結束後 3 秒）被改動，而且沒有其他人認領，就記成
  那個 agent 改的，例如「Claude（Amy）透過 shell 指令修改了 src/app.ts」，操作紀錄也一樣。同時有兩個以上的 agent
  在執行 shell 指令時，仍然顯示「外部程式」。組員的 agent 只會被記上它自己能寫的範圍裡的變更。
- 已知限制：agent 執行 shell 指令的期間，你用 smurg 以外的工具（別的編輯器、自己的終端機）改了同一個範圍裡的檔案，
  也會被記成那個 agent 改的。
- 代價：每個 shell 指令多執行兩次小程式，在開發用的電腦上量到每次約 0.05 秒。

關掉之後，agent 用 shell 指令改的檔案在活動動態裡顯示為「外部程式」。檔案鎖與衝突處理不受這項設定影響。

## 6. 防止睡眠

分享期間 smurg 會防止電腦**閒置時**進入睡眠（macOS：`caffeinate`；Linux：`systemd-inhibit`）。
**闔上筆電螢幕仍然會睡眠**，這時組員會看到「主人已離線」。沒有防止睡眠（`--no-keep-awake`、Linux 找不到
`systemd-inhibit`）或之後失效時，`smurg host` 會在終端機提示。

## 7. 狀態與停止

```sh
smurg status          # 這台電腦上正在分享的工作區：relay 連線、連線數、防止睡眠
smurg stop            # 停止分享：中斷所有連線、結束所有 session、刪除客人的暫存目錄
```

在 `smurg host` 的終端機按 Ctrl-C 也一樣（停止需要幾秒鐘；2 秒內再按一次不會中斷它，之後再按一次會立即結束，但可能
沒有完整停止）。

分享期間 `smurg host` 會在終端機告訴你：與 relay 的連線中斷與恢復、relay 拒絕了你的登入（登入過期，組員無法連線）、
登入快要到期（24 小時內），以及 smurg 的狀態檔寫不進磁碟。登入過期或快到期時，在**另一個終端機**執行
`smurg login`（用同一個帳號；分享用的 relay 不是你最後一次登入的那個時，加上 `--relay <那個網址>`），`smurg host` 會在
幾秒內自動改用新的登入，不必重新分享。

你自己要在終端機裡接上 agent session：`smurg attach`（列出）、`smurg attach <編號>`，按 Ctrl-] 離開。

## 8. 疑難排解

| 看到 | 原因與處理 |
|---|---|
| 「無法連線到 relay」／「relay 拒絕了請求」，組員看到「無法連上伺服器」 | 先確認網路。使用公用 relay 時，也可能是今天的免費用量用完了（§2.1）：台灣時間早上 8 點後恢復。 |
| 「這個資料夾已經在分享中」／「上層資料夾已經在分享中」 | 同一份檔案同時只能由一個 `smurg host` 分享（不論 relay）。用 `smurg status` 查看，或 `smurg stop` 停止。 |
| 「relay 拒絕了這台電腦的登入」 | 你的 relay 登入過期或失效。在另一個終端機執行 `smurg login`（§7），`smurg host` 會自動重新連線。 |
| 「無法寫入 smurg 的狀態檔」 | 磁碟已滿或沒有權限。剛才的變更（踢人、改角色、撤銷邀請）現在有效，但寫入成功前停止分享的話，重新啟動後會消失。 |
| 「客人沙盒：無法使用（dependency-missing）」 | Linux：`sudo apt-get install bubblewrap socat ripgrep`，重新執行 `smurg host`。 |
| 「客人沙盒：無法使用（apparmor-userns）」 | Ubuntu 24.04 以上：照 smurg 印出的指令安裝 `/etc/apparmor.d/smurg-bwrap`（只放寬 bubblewrap）。 |
| 「smurg 狀態目錄的路徑太長」 | 把 `SMURG_HOME` 設成較短的路徑（Unix socket 路徑有長度上限）。 |
| 組員看到「主人已離線」 | `smurg host` 沒有在執行，或電腦在睡眠 / 沒有網路。 |
| 組員說「這個工作區的主人沒有開放 Claude 訂閱登入」 | 你用 `--no-guest-subscription-login` 啟動了分享。要開放的話，停止分享後不加這個選項重新執行；否則請組員用自己的 API key。 |
| 組員在 agent session 裡輸入 `/login` 出現「Failed to start OAuth callback server」 | 組員的 agent session 在沙盒裡不能開網路埠，這是預期的。請組員改用 smurg 的登入程序（§5），或用 API key。 |
| 活動動態裡 agent 用 shell 指令改的檔案顯示為「外部程式」 | 你用 `--no-bash-attribution` 啟動了分享，或同一段時間有兩個以上的 agent 在執行 shell 指令，smurg 無法確定是誰（§5）。 |

所有狀態（金鑰、登入、工作區、紀錄檔）都在 `~/.smurg`（可用 `SMURG_HOME` 改變位置），紀錄檔在 `~/.smurg/logs/`，
不含邀請連結。
