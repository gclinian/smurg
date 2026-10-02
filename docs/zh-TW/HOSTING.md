# 主人指南：用 smurg 分享資料夾

這份文件寫給**主人**：在自己的電腦上執行 `smurg host`，把一個專案資料夾分享給組員的人。組員請看
[組員指南](JOINING.md)。這份指南的英文版：[English](../HOSTING.md)。

## 1. 安裝

一行指令安裝（macOS：Apple Silicon、Intel；Linux：x64、arm64，glibc）：

```sh
curl -fsSL https://smurg.ai/install.sh | sh
```

`https://smurg.ai/install.sh` 只是轉到 `https://downloads.smurg.ai/latest/install.sh`，也就是最新版本的安裝程式；
安裝程式從 `https://downloads.smurg.ai/v<版本>/` 下載那個版本的執行檔，並核對同一個版本的 `SHA256SUMS`。要安裝特定
版本，直接執行那個版本的安裝程式：`curl -fsSL https://downloads.smurg.ai/v<版本>/install.sh | sh`（`<版本>` 換成
`X.Y.Z` 形式的版本號）。

安裝程式會下載這台電腦的單一執行檔（不需要 Node.js），**只在 sha256 與這個版本的 `SHA256SUMS` 相符時**安裝到
`~/.local/bin/smurg`，並告訴你怎麼把 `~/.local/bin` 加到 `PATH`（加好之後要重新開一個終端機）。在每個平台上它都只安裝
這個執行檔：不需要 `sudo`，也不安裝任何系統套件。

- macOS 的執行檔沒有 Apple 的開發者簽章（只有 ad-hoc 簽章）。安裝程式驗證 sha256 之後，會移除 macOS 的隔離標記
  （quarantine），所以第一次執行時不會被 Gatekeeper 擋下。請用上面的指令安裝，不要用瀏覽器下載執行檔再手動執行。
- 更新：`smurg update`；移除：`smurg uninstall`（都在 §9）。`smurg --version` 顯示目前的版本。
- 要在 session 裡執行 Claude Code，這台電腦還需要 `claude` 指令（2.1.220 以上），而且要**已經登入**你的 Claude 帳號：
  每個 agent session 都用這台電腦上的這個登入，包括「可使用 agent」的組員開的（§5.1）。
- **語言**：smurg 的介面有英文和繁體中文，每個人看到的是自己的語言。`smurg` 指令依這台電腦的語言設定選擇
  （`LC_ALL`、`LC_MESSAGES`、`LANG`；在 macOS 上這三個都沒有設定時，看系統的語言），不是繁體中文就用英文；要自己指定，
  設定環境變數 `SMURG_LANG=zh-TW` 或 `SMURG_LANG=en`。網頁版依瀏覽器的語言，也可以用畫面上的語言選單切換。這份指南
  引用的是繁體中文介面的文字；你的組員用英文介面時，看到的是同一句話的英文。
- smurg 是開放原始碼軟體，以 MIT 授權條款釋出：條款見 https://smurg.ai/zh-TW/license/，原始碼在
  https://github.com/gclinian/smurg。執行檔裡的第三方軟體與它們的授權：`smurg licenses`，或
  https://smurg.ai/third-party-notices.txt。

## 2. 登入 relay

relay 是 smurg 的伺服器：負責登入，並在你的電腦和組員之間轉送**加密後**的資料。邀請連結、網頁版的工作區也都在
relay 的網址上。

```sh
smurg login          # 不加 --relay 時使用公用 relay（§2.1）
```

終端機會印出一個網址和一組代碼：

```text
在任何裝置（電腦或手機）打開：
  https://app.smurg.ai/device
輸入代碼：WDJB-MJHT   （10 分鐘內有效）
```

1. 在**任何一台裝置**（這台電腦、另一台電腦或手機都可以）的瀏覽器打開這個網址，用你的 Google 帳號登入。
2. 輸入終端機上的代碼（大小寫和「-」都可以省略），按「下一步」。
3. 頁面會列出要登入的帳號、這次登入是從哪裡要求的（IP 位址和大概的位置）和時間。**只有你自己剛在終端機執行
   `smurg login` 時才按「允許」；如果是別人給你這個代碼，請按「拒絕」。** 按「允許」之後，終端機在幾秒內顯示「已登入」。

- 在有桌面的電腦上，smurg 也會自動用這台電腦的瀏覽器打開這個網址。網址裡沒有代碼：代碼一定要你自己輸入。
- **透過 SSH 使用、或在沒有桌面的伺服器上**：做法完全一樣，用你面前的電腦或手機打開網址、輸入代碼，不需要轉接埠或其他
  設定（smurg 不會在那台電腦上打開瀏覽器）。這時頁面上的 IP 位址和位置是那台遠端電腦的。
- `--no-browser` 或環境變數 `SMURG_NO_BROWSER=1`：不自動打開瀏覽器，只印網址和代碼。
- 代碼 10 分鐘內有效，只能用一次。過期了或按了「拒絕」，重新執行 `smurg login` 就好；等待時按 Ctrl-C 可以取消。
- 不要把代碼告訴別人，也不要輸入別人給你的代碼：輸入並按「允許」，就是讓執行那個 `smurg login` 的電腦用你的帳號登入
  （7 天內有效）。
- 可以跳過這一步：`smurg host` 發現還沒登入時會先請你登入（同樣是網址和代碼）。`smurg host` 開始分享前，如果登入在
  24 小時內就會過期，也會先請你重新登入。
- 登入資料存在 `~/.smurg/credentials.json`（權限 0600），依 relay 網址分開記錄。

### 2.1 公用 relay（預設）

smurg 的維護者在 Cloudflare 上架設了一個所有人都可以使用的 relay：https://app.smurg.ai（也是網頁版：組員的邀請連結
和工作區都在這個網址上）。發佈版的 smurg 預設就用它，**你不需要部署任何東西**，只要有 Google 帳號（主人和組員都用 Google 登入）。

**relay 看得到什麼**：

- 看不到：檔案內容、檔名、終端機畫面、你或組員輸入的指令、邀請連結的密鑰、任何金鑰。這些在你的電腦和組員的瀏覽器
  （或 CLI）之間端對端加密，relay 只轉送加密後的資料。
- 看得到：每條連線是**哪個 Google 帳號**（帳號 ID、名稱、大頭貼；登入時 Google 也會給 relay 你的 email，只有帳號沒有
  名稱時拿來當顯示名稱）、**從哪個 IP 位址連線**、連到哪個工作區代碼，以及每筆資料的大小和時間。從這些可以看出誰和誰
  在什麼時候一起工作、傳了多少資料。
- 保存：每個工作區的代碼和它的主人是哪個帳號。登入本身不保存（relay 的登入是有效 7 天的簽章權杖）；只有用代碼登入
  `smurg` 時，relay 會保存那次登入最多 10 分鐘（代碼、執行 `smurg login` 的電腦的 IP 位址與大概位置，顯示在確認頁上），
  完成或過期就刪除。為了擋下猜代碼和大量登入，relay 也會保存 IP 位址與帳號的雜湊值和次數，10 分鐘後刪除。
- 架設者（smurg 的維護者）和 Cloudflare 因此也可能知道上面「看得到」的內容。不能接受的話，可以自己架設 relay（§2.2）：
  那時看得到這些的是你和你的 Cloudflare 帳號。

**免費方案的限制**：公用 relay 用 Cloudflare 的免費方案，**所有使用公用 relay 的人共用**每天固定的用量：

- 用量的單位是連線、每幾秒一次的「主人還在嗎」檢查，以及轉送的每一筆資料。最耗用量的是**大家一起看一個正在大量輸出
  的終端機或 agent**；只是開著工作區、偶爾編輯，用得很少。
- 一天的用量用完時，**所有人**（不只你）都可能連不上：新的連線和登入會失敗，已經連著的也可能中斷，直到台灣時間
  **早上 8 點**（UTC 0 點）重新計算。這時主人的終端機會提示與 relay 的連線中斷，組員看到「無法連上伺服器」，瀏覽器也
  可能顯示 Cloudflare 的錯誤頁（Error 1027）。
- 維護者會觀察用量，必要時改用付費方案。整班同時長時間使用、或不能接受中斷時，請自己架設 relay（§2.2）：它有自己的
  用量，不受其他人影響。

### 2.2 其他 relay（`--relay`）

relay 的原始碼是公開的（MIT），所以**你可以自己架設 relay**：它是一個 Cloudflare Worker，用自己的 Cloudflare 帳號（免費方案
即可）和自己的 Google OAuth client 就能部署，網頁版也由它提供。步驟在 relay 的說明文件
[`apps/relay/README.md`](../../apps/relay/README.md#self-hosting-on-workersdev)（英文）。架設好之後，用 `--relay` 指定它：

```sh
smurg login --relay https://relay.example.org      # 換成你的 relay 的網址；出現哪些登入按鈕由那個 relay 決定
smurg host ~/projects/my-app                        # 用上次登入的 relay
```

選擇 relay 的順序：`--relay`、環境變數 `SMURG_RELAY_URL`、上次登入的 relay，都沒有時才用公用 relay。要換回
公用 relay：`smurg login --relay https://app.smurg.ai`。你印出的邀請連結會指向你用的 relay，組員不需要另外設定。

## 3. 分享

```sh
smurg host ~/projects/my-app
```

`smurg host` 在前景執行，終端機只印出兩個連結：

```
smurg 正在分享「my-app」

你的連結（只給你自己用）：
  https://app.smurg.ai/join/ws_…#k=…&s=…

給組員的連結（用私訊傳給他們，7 天內有效）：
  https://app.smurg.ai/join/ws_…#k=…&s=…

按 Ctrl-C 停止分享。
```

- **你的連結**：在瀏覽器以主人身分打開工作區。只能用一次，7 天內有效；不要給別人。
- **給組員的連結**：預設角色是「可編輯」（editor），7 天內有效、不限次數。連結裡 `#` 之後就是密鑰：
  請用私訊傳給組員，不要貼在公開的地方。選項：`--role agent|editor|viewer`、`--expires 12h`、`--max-uses 3`、
  `--name 顯示名稱`；你用了別的角色或次數上限時，這一行也會寫出來。**`--role agent`（「可使用 agent」）之前請先讀
  §5.1**：拿到這個連結的人可以用你的電腦和你的 Claude 帳號執行任何指令。

終端機不會重複這份指南的說明：**第一次分享之前請先讀 §4**，「可使用 agent」角色和 agent 的 shell 指令通知見 §5。
分享中的詳細狀態用 `smurg status` 查看（§7）：daemon 金鑰指紋、shell 指令通知是否開啟、防止睡眠、紀錄檔的位置。
終端機只在你需要處理的時候提示：**無法防止睡眠**（§6）、與 relay 的連線中斷、relay 拒絕你的登入、狀態檔寫不進
磁碟（§7）；有新版本時，連結下面會多一行「有新版本…」（§9.1）。

**daemon 金鑰指紋**：組員第一次加入時，可以用其他管道（當面、電話）和你核對這組指紋，確認沒有人（包括 relay）冒充你。
指紋用 `smurg status` 查看（「daemon 金鑰指紋：」那一行）。

角色：「旁觀」（`viewer`）只能看；「可編輯」（`editor`）可以編輯檔案、對 agent 提出建議；「可使用 agent」（`agent`）
還可以**以你的身分**在你的電腦上開 agent 和終端機，並在任何 session 裡直接輸入（§5.1）。之後可以在網頁的主人控制台
管理成員、角色、邀請與 session，查看操作紀錄。

## 4. 分享前必讀

`smurg host` 不會在終端機提醒這些事，請在第一次分享之前讀完。

- **資料夾裡的檔案，每個成員都看得到**（旁觀者也一樣），例如 `.env`、設定檔。組員在網頁和 CLI 裡看不到、也下載不到的
  只有：smurg 自己的 `.smurg/`、所有 `.git` 資料夾、`.envrc`，以及你個人的 Claude Code 設定（`.claude/settings.local.json`、
  `CLAUDE.local.md`）。這只限制人看到的：每個 agent 和終端機 session 都以你的身分執行，讀得到它們，也讀得到你電腦上的
  其他檔案（§5.1）。不要分享放了密碼、金鑰或個人資料的資料夾；也不能分享整個家目錄或包含家目錄的資料夾。
- **所有 agent session 都不在沙盒裡**：你自己開的，和「可使用 agent」的組員開的都一樣，都以你的作業系統帳號執行，
  而且會讀到組員寫入或修改的檔案。檔案裡可能藏有要 agent 執行的指示（prompt injection）。請保留 Claude Code 的權限
  確認，不要自動核准，並留意最近被組員修改過的檔案。「可使用 agent」的組員也能在 session 裡替你回答這些確認。
- **只把「可使用 agent」給你完全信任的人**（§5.1）：這個角色可以讓 agent 在你的電腦上執行任何指令、讀你的家目錄、
  用你的 Claude 帳號。其他組員用「可編輯」就能一起編輯、對 agent 提出建議。
- 組員只能在 `smurg host` 執行、而且你的電腦連線時使用這個工作區。
- 可編輯以上的組員可以在分享的資料夾裡新增或修改 `.gitmodules`、`.gitconfig`、`.bashrc`、`.zshrc`、`.profile` 這類
  檔案（git 和 shell 不會從專案資料夾執行它們）。執行 `git submodule update` 之前，請看一下 `.gitmodules` 是否被改過。

## 5. 「可使用 agent」角色與 agent 的 shell 指令

### 5.1 「可使用 agent」角色（請先讀）

「可使用 agent」（`agent`）是你能給組員的最高角色。有這個角色的組員可以：

- 在你的電腦上開 **agent（Claude Code）和終端機 session**，在共享主工作區或 worktree 裡工作；
- 在**任何** session 裡直接輸入，包括你自己開的和其他組員開的；
- 採用或拒絕任何 session 收到的建議，並請你合併任何一個 worktree（合併仍然只有你能決定）。

這些 session **以你的身分在你的電腦上執行**，和你自己在終端機裡開的沒有差別：

- **沒有沙盒**：用你的作業系統帳號、你的家目錄（包括 `~/.claude` 裡你的設定、`CLAUDE.md` 和記憶）和你的環境變數。
- **用你自己的 Claude Code 登入**：每個 agent 都用這台電腦上 `claude` 目前登入的帳號（你的訂閱或你的 API key），
  **用量和費用都算在你身上**。組員不需要、也沒有辦法改用他們自己的 Claude 帳號或 API key。
- worktree 只是工作的位置，不是保護：在 worktree 裡開的 session 一樣以你的身分執行。

**風險**：給某人「可使用 agent」，等於讓他在你的電腦上使用你的帳號。他可以：

- 讓 agent 或終端機**在你的電腦上執行任何指令**：安裝或刪除程式、修改或刪除分享資料夾以外的檔案、連到任何網路位置；
- **讀取你的家目錄**：例如 `~/.ssh` 的金鑰、其他專案、各種程式和雲端服務的登入資料，以及分享資料夾裡組員本來看不到
  的 `.git`、`.envrc`；
- **使用你的 Claude 帳號**：用掉你的訂閱額度，或讓你的 API key 產生費用。

smurg 沒有辦法限制這些事。工作區裡每個人都即時看得到每個 session 的畫面，操作紀錄記下每個 session 是誰開的，但這些
只能讓你事後知道發生了什麼。**只把這個角色給你完全信任的人**，例如你願意把自己已經登入的電腦交給他使用的人。其他組員
請用「可編輯」：他們可以一起編輯檔案，並對 agent 提出建議，由你或有「可使用 agent」的人決定要不要採用。

- **給**：分享時用 `smurg host <資料夾> --role agent`，印出的組員連結就是「可使用 agent」的連結；或在分享中從網頁的
  主人控制台建立這個角色的邀請連結、把成員的角色改成「可使用 agent」（控制台會先顯示同樣的風險提醒，按「我了解…」
  才會建立或變更）。
- **收回**：在主人控制台把角色改回「可編輯」或「旁觀」，或移出那位成員；他開的 session 會立刻結束，他也不能再開
  session 或在 session 裡輸入。**這只收回他在 smurg 裡的權限**，他之前以你的身分做過的事不會跟著消失：請看下面
  「收回之後」的清單。
- 開始之前請確認 `claude` 已經在這台電腦上登入（在你自己的終端機執行 `claude`，需要時輸入 `/login`）。沒有登入時，
  組員開的 agent 會顯示還沒登入：請你自己登入，不要讓組員在 session 裡用他們的帳號 `/login`（那會把他們的登入資料
  存到你的電腦上，之後所有 agent 都用它）。

**收回之後**：他有「可使用 agent」的期間，可以用你的帳號讀過、複製過你讀得到的任何東西，也可以在電腦上留下之後會
自動執行的東西。如果你不再信任他，或不確定他做過什麼，請做完這些事：

1. **換掉工作區的金鑰和邀請連結**：先用 `smurg status` 記下工作區代碼（停止之後 `smurg status` 就不會再列出它），再
   `smurg stop` 停止分享，把 `~/.smurg/workspaces/<工作區代碼>/` 移到別的地方（例如在名稱後面加上 `.old`），然後用
   `smurg host` 重新分享。daemon 金鑰和邀請連結的密鑰都會換新（他可能讀過舊的）；其他組員要用新的邀請連結重新加入。
   - 加入過的組員用新連結時會看到「**主人的電腦金鑰和之前不同**」（網頁和 `smurg attach` 都會先問過才繼續）。請用
     `smurg status` 查看新的 **daemon 金鑰指紋**，用其他管道（當面、電話）告訴他們，讓他們比對過再繼續。
   - 舊的 worktree 還留在 `<資料夾>/.smurg/worktrees/`：新的工作區狀態不認得它們，組員看不到，smurg 也不能再合併或
     移除它們。裡面還要的修改請你自己檢查後合併到主工作區，再刪掉這些資料夾。
   - 只停止再重新分享、不移走這個資料夾的話，金鑰和還沒過期的邀請連結都不會變。
2. **換掉 relay 的登入**：`smurg logout`，再 `smurg login`。relay 的登入沒有辦法提前作廢：他如果複製了舊的登入資料
   （`~/.smurg/credentials.json`），在它到期之前（登入後最多 7 天）仍然可以用。
3. **換掉其他登入資料**：Claude Code 的登入（在你的終端機執行 `claude`，`/logout` 再 `/login`；用 API key 的話換一把
   新的）、`~/.ssh` 的金鑰，以及家目錄裡其他程式和雲端服務的登入資料。
4. **檢查會自動執行的地方**，有你不認得的內容就移除：
   - shell 設定檔：`~/.zshrc`、`~/.zprofile`、`~/.bashrc`、`~/.bash_profile`、`~/.profile`；
   - 排程：`crontab -l`；
   - 登入時自動啟動的程式：macOS 的 `~/Library/LaunchAgents/`，Linux 的 systemd 使用者服務（`~/.config/systemd/user/`，
     `systemctl --user list-unit-files`）和 `~/.config/autostart/`；
   - `~/.ssh/authorized_keys`：多出來的金鑰能讓人不經過 smurg 直接登入你的電腦；
   - Claude Code 的設定：`~/.claude/settings.json` 的 `hooks`，和 `~/.claude/CLAUDE.md`（之後每個 agent 都會照著做）；
   - 你的 git 專案（分享的和其他的）：`.git/hooks/` 裡的腳本，以及會執行程式的 git 設定，例如
     `git config --show-origin --get-regexp 'core\.(fsmonitor|hooksPath|sshCommand)'`（也看 `~/.gitconfig`）；
   - 還在執行的程式：session 結束時 smurg 會結束它找得到的程式，但刻意脫離 session 的程式可能繼續以你的帳號執行，
     也可以透過這台電腦上的控制 socket（`smurg attach` 用的）在任何 session 裡輸入，包括你自己的。不確定的話，做完
     上面的檢查之後重新開機。
5. **紀錄分不出是他還是你**：他透過 session 用你的作業系統帳號做的事，在系統和其他程式的紀錄裡都和你自己做的一樣；
   smurg 的操作紀錄記下 session 是誰開的、誰從網頁做了什麼，但不記 session 裡的指令和輸出。這台電腦上的控制
   socket（`smurg attach` 用的）只能用來列出、接上 session 和在 session 裡輸入，不能拿來以你的名義改角色、核准合併、
   踢人或變更設定；可是在收回之前，他仍然可以用你的作業系統帳號做任何你能做的事。

### 5.2 agent 的 shell 指令通知

預設開啟；關掉：`--no-bash-attribution`。這項設定只能在啟動時決定：要改就先停止分享，再用新的選項執行 `smurg host`
（同一個資料夾的工作區和成員都會保留，組員不用重新加入）。分享中目前是開啟還是關閉，用 `smurg status` 查看（§7）。

agent 用 Edit、Write 等工具改檔案時，smurg 本來就知道是哪個 agent 改的。agent 用 shell 指令（例如 `sed -i`、
格式化工具）改的檔案，smurg 原本只能在活動動態裡顯示成「外部程式」。現在：

- 每個 agent session 執行 shell 指令時，會通知這台電腦上的 smurg 指令何時開始、何時結束。
  **不含指令內容和輸出**，也不會擋下任何指令：smurg 沒有回應時，指令照常執行，只是不會記在那個 agent 名下。
- 檔案在「只有一個 agent 正在執行 shell 指令」的期間（加上指令結束後 3 秒）被改動，而且沒有其他人認領，就記成
  那個 agent 改的，例如「Claude (Amy) 透過 shell 指令修改了 src/app.ts」，操作紀錄也一樣。同時有兩個以上的 agent
  在執行 shell 指令時，仍然顯示「外部程式」。
- 已知限制：agent 執行 shell 指令的期間，你用 smurg 以外的工具（別的編輯器、自己的終端機）改了同一個範圍裡的檔案，
  也會被記成那個 agent 改的。
- 代價：每個 shell 指令多執行兩次小程式，在開發用的電腦上量到每次約 0.05 秒。

關掉之後，agent 用 shell 指令改的檔案在活動動態裡顯示為「外部程式」。檔案鎖與衝突處理不受這項設定影響。

## 6. 防止睡眠

分享期間 smurg 會防止電腦**閒置時**進入睡眠（macOS：`caffeinate`；Linux：`systemd-inhibit`）。
**闔上筆電螢幕仍然會睡眠**，這時組員會看到「主人已離線」。無法防止睡眠（例如 Linux 找不到 `systemd-inhibit`）或
之後失效時，`smurg host` 會在終端機提示一行；用 `--no-keep-awake` 關掉時不提示。目前的狀態用 `smurg status` 查看
（「防止睡眠：」那一行）。

在 Ubuntu 上透過 SSH 啟動 `smurg host` 時，系統（polkit）預設不允許防止睡眠，`smurg host` 會提示「⚠ 防止睡眠：未啟用
（系統（polkit）不允許防止睡眠…）」（在 Ubuntu 24.04 上驗證過；其他發行版或公司自訂的 polkit 規則也可能拒絕，訊息相同）。要防止睡眠，請在這台電腦的桌面登入後啟動 `smurg host`；沒有桌面的伺服器通常本來就
不會自動睡眠。

## 7. 狀態與停止

```sh
smurg status          # 這台電腦上正在分享的工作區（見下面）
smurg stop            # 停止分享：中斷所有連線、結束所有 session
```

`smurg status` 列出每個正在分享的工作區（`smurg host` 啟動時不印的資訊都在這裡）：

- 工作區代碼、分享的資料夾、relay 的網址（公用 relay 會註明）與連線狀態、連線數與線上成員；
- **daemon 金鑰指紋**（§3）；
- 防止睡眠（§6）；
- agent 的 shell 指令通知（開啟／已關閉，§5.2）；
- daemon 紀錄檔的位置：`~/.smurg/logs/<工作區代碼>.log`（權限 0600，不含邀請連結）。出問題時，詳細原因在這裡。

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
| 「這個資料夾已經在分享中」／「這個資料夾的上層資料夾已經在分享中」 | 同一份檔案同時只能由一個 `smurg host` 分享（不論 relay）。用 `smurg status` 查看，或 `smurg stop` 停止。 |
| 「relay 拒絕了這台電腦的登入」 | 你的 relay 登入過期或失效。在另一個終端機執行 `smurg login`（§7），`smurg host` 會自動重新連線。 |
| 登入時「代碼已過期，登入沒有完成」 | 10 分鐘內沒有在瀏覽器輸入代碼並按「允許」。重新執行一次（§2）。 |
| 輸入代碼的頁面說「代碼不正確或已失效」／「輸入錯誤的次數太多」 | 確認是終端機上**最新**的那組代碼（8 個英文字母，沒有數字）。代碼用過、被拒絕或過期就失效了；輸入錯太多次要等幾分鐘（頁面會寫多久）。 |
| 「這個 relay 還不支援用代碼登入」 | 你用 `--relay` 指定的 relay 比你的 smurg 舊。請架設那個 relay 的人更新它。 |
| 「無法寫入 smurg 的狀態檔」 | 磁碟已滿或沒有權限。剛才的變更（踢人、改角色、撤銷邀請）現在有效，但寫入成功前停止分享的話，重新啟動後會消失。 |
| 「這個工作區的狀態檔是別的 smurg 版本寫的，或不是預期的格式，daemon 拒絕啟動」 | 這個資料夾的工作區狀態（`~/.smurg/workspaces/<工作區代碼>/`）讀不了：通常是別的版本的 smurg 寫的（smurg 不會轉換其他版本的狀態），也可能被別的程式改過或權限不對。哪個檔案、什麼原因，記在終端機提到的紀錄檔裡。處理：把這個資料夾移到別的地方（例如在名稱後面加上 `.old`），再執行一次 `smurg host`。這會建立新的工作區狀態：之前的成員和邀請連結都不再有效，組員要用新的邀請連結重新加入。daemon 金鑰也會換新：加入過的組員會看到「主人的電腦金鑰和之前不同」，請把 `smurg status` 顯示的新金鑰指紋用其他管道告訴他們（§5.1「收回之後」第 1 步，舊的 worktree 也在那裡說明）。 |
| 組員說他看到「主人的電腦金鑰和之前不同」 | 你換過工作區的金鑰（§5.1「收回之後」第 1 步，或上一列的處理）：用 `smurg status` 查看新的 daemon 金鑰指紋，用其他管道（當面、電話）告訴他，讓他比對過再繼續。你沒有換過的話，請他不要繼續：可能有人冒充你。 |
| 「smurg 的狀態目錄路徑太長」 | 把 `SMURG_HOME` 設成較短的路徑（Unix socket 路徑有長度上限）。 |
| 組員看到「主人已離線」 | `smurg host` 沒有在執行，或電腦在睡眠 / 沒有網路。 |
| 「你的 Claude Code 還沒有登入」（組員看到「主人的 Claude Code 還沒有登入，這個 agent 暫時無法工作」） | 每個 agent 都用你在這台電腦上的 Claude Code 登入（§5.1）。點一下那個 agent 的終端機，輸入 `/login` 照畫面登入（或在你自己的終端機執行 `claude` 登入），再回到 session 輸入下一個指令。 |
| 組員開不了 session（「新增 session」說他的角色不能開 session） | 只有「可使用 agent」能開 session（§5.1）。要給的話，在主人控制台改他的角色；先讀 §5.1 的風險。 |
| 活動動態裡 agent 用 shell 指令改的檔案顯示為「外部程式」 | 你用 `--no-bash-attribution` 啟動了分享，或同一段時間有兩個以上的 agent 在執行 shell 指令，smurg 無法確定是誰（§5.2）。 |

所有狀態（金鑰、登入、工作區、紀錄檔）都在 `~/.smurg`（可用 `SMURG_HOME` 改變位置），紀錄檔在 `~/.smurg/logs/`，
不含邀請連結。

## 9. 更新與移除

### 9.1 更新：`smurg update`

```sh
smurg update --check    # 只檢查有沒有新版本，不下載
smurg update            # 更新到最新版本
```

- `smurg update` 先讀 `https://downloads.smurg.ai/latest/VERSION`。有比目前新的版本時，從
  `https://downloads.smurg.ai/v<版本>/` 下載這台電腦的執行檔和那個版本的 `SHA256SUMS`，**sha256 相符**、檔案確實是那個
  版本、而且在這台電腦上能執行，才把目前的執行檔原地換掉，然後印出舊版本、新版本和變更紀錄的網址
  （https://smurg.ai/zh-TW/docs/changelog/）。已經是最新版本時什麼都不做，也不會換成較舊的版本。
- **正在分享時不能更新**：`smurg update` 會請你先執行 `smurg stop`，它不會自己停止分享。原因：還在執行的 daemon 是舊版，
  而 agent session 每次呼叫的 `smurg` 指令已經是新版，兩個版本混在一起可能出錯。
- 下載失敗、sha256 不符，或你按了 Ctrl-C：目前的執行檔不會被更動，下載到一半的暫存檔會刪除。
- 執行檔所在的資料夾不能寫入時（例如不是用安裝程式裝的），它會說是哪個資料夾：請用當初安裝的方式更新，或重新執行 §1 的
  安裝指令。
- 信任的範圍和安裝程式相同：`SHA256SUMS` 沒有數位簽章，靠的是 https 和 downloads.smurg.ai 本身。
- 環境變數 `SMURG_INSTALL_BASE_URL`（測試或鏡像站用）：改從這個網址下載。只接受 https。

**新版本提示**：`smurg host` 印出兩個連結之後，會在背景向 `https://downloads.smurg.ai` 查一次最新版本（只有這一個請求，
不附帶任何資料，最多等 2 秒）。有新版本時，在連結下面多印一行：

```text
有新版本 0.4.1（目前 0.4.0）：停止分享後執行 smurg update
```

沒有新版本、查不到或逾時時什麼都不印，也不影響分享。不要這個檢查：設定環境變數 `SMURG_NO_UPDATE_CHECK=1`。自動化環境
（設定了 `CI`，或不是在終端機裡執行）不會檢查。

### 9.2 移除：`smurg uninstall`

```sh
smurg uninstall               # 列出會移除的東西，確認之後移除
smurg uninstall --keep-data   # 保留 ~/.smurg，只移除執行檔和快取
```

會移除：

- 執行檔本身（用安裝程式裝的是 `~/.local/bin/smurg`）；
- 快取：執行檔解壓縮出來的原生模組（macOS：`~/Library/Caches/smurg`；Linux：`~/.cache/smurg`；設定過 `SMURG_CACHE_DIR`
  的話是那個資料夾裡的 `native-…`）；
- 狀態目錄 `~/.smurg`（或 `SMURG_HOME`）：登入、裝置金鑰、每個工作區的金鑰、成員和邀請連結、紀錄檔。移除之後，分享過的
  工作區的成員和邀請連結都不再有效。`--keep-data` 會保留它。

不會動：

- **專案資料夾裡的 `.smurg/`**：worktree 和還沒合併的修改都在裡面。`smurg uninstall` 只把它知道的這些資料夾列出來，
  要不要刪由你決定。
- shell 設定檔：安裝程式只提示過要把 `~/.local/bin` 加到 `PATH`，沒有改過你的設定檔。你自己加過的那一行，請自己刪掉。

動手之前，它會列出每一個要移除的路徑和大小，並問「確定要移除嗎？ [y/N]」，輸入 `y` 才移除。`--yes` 不詢問；不在終端機裡
執行時必須加 `--yes`，否則它只列出內容就結束。正在分享的工作區會先停止（和 `smurg stop` 一樣）；停不下來就中止，什麼都
不移除。`SMURG_HOME` 指向不該刪的地方時（`/`、家目錄，或裡面有不是 smurg 建立的東西的資料夾），它會拒絕：這時用
`--keep-data`，再自己處理那個資料夾。

從原始碼執行 smurg 時：自己刪除上面三個位置。
