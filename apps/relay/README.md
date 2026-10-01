# @smurg/relay

smurg 的 relay：一個 Cloudflare Worker 加上三個 SQLite 型 Durable Object（`WorkspaceDO`、`TransferDO`，以及 CLI 用代碼登入的
`DeviceLoginDO`）。它負責 OAuth 登入（CLI 用代碼登入）、發放 relay session 與身分權杖（identity token），並依工作區轉送
**已經端對端加密**的訊框。
規格見 `SPEC.md` §7.1、R1–R3，架構約定見 `docs/ARCHITECTURE.md` §6，驗證過的技術細節見 `docs/research/relay.md`。

relay 看得到的只有：工作區 ID、連線 ID、訊框大小與時間，以及（因為登入經過它）每條連線的帳號身分與 IP 位址
（ARCHITECTURE §11 D-5）。它看不到任何金鑰、邀請密鑰、裝置 ID 或內容。

## 架構重點

- **只用 Hibernation API**（`ctx.acceptWebSocket`）。路由狀態全部放在 socket 標籤（`host`、`client`、`c:<conn>`）、
  socket attachment 與 `ctx.storage.kv`，不放記憶體：本機 workerd 和正式環境都會真的進入休眠。
- **訊框**：客戶端 → relay 是純密文；relay → 主人是 `<u32be conn><密文>`；主人 → relay 帶同樣的前綴，relay 依前綴轉給
  對應客戶端並拿掉前綴。控制訊息是 JSON 文字訊框，schema 在 `@smurg/protocol/relay`（`hello`、`host.online`、
  `host.offline`、`peer.open`、`peer.close`、`peer.kick`、`bye`）。文字訊框從不在兩端之間轉送；不合法的控制訊框直接丟棄。
- **心跳**：文字 `"ping"` 由 Durable Object 的 auto-response 回 `"pong"`，不會喚醒物件，並記錄時間。
  `WorkspaceDO` 的 alarm 在主人最後一次 ping 之後 6 秒（`HOST_TIMEOUT_MS`）宣告主人離線，送出
  `host.offline {reason:"timeout"}`，實測約 6.03 秒（R1 要求 10 秒內）。同一個 alarm 也會關掉 30 秒
  （`CLIENT_SWEEP_MS`）沒有 ping 的客戶端（`bye 4000` + 對主人送 `peer.close`）。
- **主人換線**：新的主人連線一律取代舊的（epoch 遞增，舊連線收到 `bye 4001`），舊 epoch 的關閉事件會被忽略。
- **relay 主動關閉前一定先送 `bye`**（Node 客戶端要到 10–16 秒後才會收到 TCP FIN）。
- **訊框上限** `MAX_RELAY_FRAME`（8 MiB + 64 KiB，含前綴），超過就 `bye 1009`。
- **上限**：每個工作區每個 Durable Object 最多 `MAX_CLIENT_SOCKETS_PER_WORKSPACE`（64）條客戶端連線，每個帳號最多
  `MAX_SOCKETS_PER_ACCOUNT`（8）條；超過回 HTTP 429。
- **擁有者**：`POST /api/workspaces` 的第一個呼叫者成為工作區擁有者；只有擁有者能開主人 socket（`/ws` 與 `/xfer`）。
  沒有被認領的工作區 ID 一律 404。
- `TransferDO` 只轉送檔案分段，和互動流量分開，避免大檔案卡住打字與終端機。擁有者由 Worker 向 `WorkspaceDO`
  查詢後帶入，`TransferDO` 再檢查一次。

## 路由

| 路由 | 用途 |
|---|---|
| `GET /healthz` | Worker 存活檢查 |
| `GET /auth/github/login`、`GET /auth/google/login` | 瀏覽器登入（可加 `?return_to=/路徑` 或允許清單內的完整網址） |
| `GET /auth/github/callback`、`GET /auth/google/callback` | OAuth 回呼（要在 OAuth app 註冊的網址） |
| `POST /auth/device/start`（JSON，可以沒有 body） | CLI 用代碼登入的第一步，不需要登入：`{ deviceCode, userCode, verificationUri, expiresIn: 600, interval: 5 }`。`userCode` 是 `XXXX-XXXX`（RFC 8628 §6.1 的 20 個子音字母），`deviceCode` 是 `<去掉「-」的 userCode>.<32 位元組亂數的 base64url>`，`verificationUri` 是 `<relay>/device`（不帶代碼）。同一個 IP 位址 10 分鐘內最多 30 次，超過回 429 `too_many_requests` 與 `Retry-After` |
| `POST /auth/device/token` `{ deviceCode }` | CLI 每 `interval` 秒問一次。允許之後回 bearer session `{ token, tokenType, expiresIn, user }`（和 `POST /auth/dev/token` 相同的格式），**只給一次**；在那之前回 400：`authorization_pending`、`slow_down`（比間隔早 1 秒以上就問；之後間隔加 5 秒）、`access_denied`（按了「拒絕」）、`expired_token`（過期、已經領過、不存在或密鑰不符，無法分辨）、`invalid_request`（格式錯誤） |
| `GET /device` | relay 自己的頁面（不是 SPA；沒有 script）：瀏覽器沒有登入時列出 relay 的登入方式（Google、有設定時 GitHub、本機開發時開發用登入），登入後回到 `/device`；登入之後是輸入代碼的表單。**網址裡的代碼一律不用**（預先填好代碼的連結正是釣魚會寄的東西） |
| `POST /device`（表單） | 只接受 `/device` 自己送出的表單：`Origin` 必須是 relay 自己（或 `ALLOWED_ORIGINS`），有 `Sec-Fetch-Site` 時必須是 `same-origin`，否則 403。`code`：代碼正確時顯示確認畫面（要登入的帳號、代碼、要求來自的 IP 位址與大概位置、時間，以及「只有你自己剛在終端機執行 smurg login 時才按「允許」；如果是別人給你這個代碼，請按「拒絕」。」）；`code`、`account`、`decision=allow\|deny`：允許或拒絕，綁定這個瀏覽器 session 的帳號（`account` 和目前的帳號不同時 409）。錯誤的代碼每個帳號 10 分鐘內 10 次、每個 IP 位址 30 次，超過顯示「輸入錯誤的次數太多」（429） |
| `GET /auth/dev/start?user=名稱[&name=顯示名稱][&return_to=…]`、`POST /auth/dev/token` `{ user, displayName? }` | **僅限開發**：`DEV_LOGIN=1` **而且**主機名稱是本機（`localhost`、`127.0.0.1`、`[::1]`、`*.localhost`），否則 404 |
| `POST /auth/logout` | 清除瀏覽器 cookie（204） |
| `GET /api/me` | `{ user: { userId, displayName, provider, avatarUrl? } }` 或 401。未登入時刻意維持 401：client SDK 用它判斷「需要重新登入」（`engine.ts` 的 `probeLogin`），CLI 用它檢查存下來的 session，relay 的測試也斷言這個狀態碼 |
| `GET /api/login-options` | 不需要登入，也不讀取 session：`{ providers: { github: 布林, google: 布林 }, dev: 布林 }`（schema 是 `@smurg/protocol/relay` 的 `relayLoginOptionsSchema`，網址用 `loginOptionsUrl()`）。某個供應商的設定完整（它的登入路由不會回 503）時為 `true`；`dev` 只有在 `DEV_LOGIN=1` **而且**這個請求的主機名稱是本機時為 `true`（和 dev login 本身的條件相同）。只有這些布林值，不會透露 client ID、端點或其他設定。`no-store`；和其他公開的 GET 路由一樣沒有任何 CORS 標頭（其他來源的網頁讀不到）。網頁用它決定要顯示哪些登入按鈕，不必再去試探登入路由 |
| `POST /api/workspaces` `[{ workspaceId? }]` | 認領工作區：201 `{ workspaceId, created: true }`、自己已擁有時 200、別人擁有時 409 |
| `POST /api/identity-token` `{ workspaceId, cnf }` | 身分權杖 `{ token, expiresIn }`（見下） |
| `GET /.well-known/jwks.json` | relay 公鑰（`kid` = RFC 7638 thumbprint，只有公鑰）；明確帶 `Date` 標頭（daemon 用它估計 relay 的時鐘來檢查身分權杖的時間；本機 workerd 不會自己加） |
| `GET /ws/<id>/host`、`GET /ws/<id>/client` | WebSocket → `WorkspaceDO` |
| `GET /xfer/<id>/host`、`GET /xfer/<id>/client` | WebSocket → `TransferDO` |
| `GET /api/debug/room?kind=ws\|xfer&workspaceId=…` | **僅限開發**（同 dev login 的條件）：測試用的房間狀態 |
| `GET /api/debug/device-login?code=…`（或 `?limit=<種類>&key=…`）、`POST …?code=…&expire=1` | **僅限開發**（同上）：測試用，`DeviceLoginDO` 存了什麼（不含密鑰的雜湊）；`expire=1` 讓那次登入立刻過期（測試不能等 10 分鐘） |

其他路徑都是網頁 SPA（`wrangler.jsonc` 的 `assets`；Worker 先處理的路徑見 `RELAY_WORKER_FIRST_PATTERNS`）。

### CLI 用代碼登入（device code，2026-10-01）

`smurg login`（以及需要登入的 `smurg host`、`smurg attach`）印出 `<relay>/device` 和一組代碼，在有桌面的電腦上也打開那個
網址（不帶代碼），然後每 5 秒問一次 `POST /auth/device/token`。人在任何裝置的瀏覽器登入 relay、輸入代碼、看過確認畫面後按
「允許」：CLI 拿到的是那個瀏覽器 session 的帳號。瀏覽器不需要連回 CLI 所在的電腦，所以透過 SSH 也不需要轉接埠
（`docs/OPEN-QUESTIONS.md` Q7）。

- **狀態**：`DeviceLoginDO`（SQLite 型，`wrangler.jsonc` 的 migration `v2`）。Worker 用名稱取得兩種物件：
  `code:<代碼>` 是一次登入（代碼就是名稱，所以 `/device` 從人輸入的代碼、token 端點從 device code 都找得到它），存著
  device code 密鑰的 SHA-256（用常數時間比對）、建立時間、`CF-Connecting-IP` 與 Cloudflare 推測的國家和城市，決定之後再加上
  結果與按「允許」的帳號；CLI 領走結果時刪除，10 分鐘到了由 alarm 刪除。`limit:<種類>:<SHA-256>` 是 10 分鐘的計數器（IP
  位址和帳號只以雜湊出現在名稱裡），視窗結束時由 alarm 刪除。每個物件只在有資料時設一個 alarm，沒有週期性的 alarm。
- **費用**（Free 方案）：開始一次登入約 2 次 Durable Object 請求、3 列寫入（記錄、計數、alarm）；CLI 每次輪詢是 1 次 Worker
  請求加 1 次 Durable Object 請求，**不寫入**（上一次輪詢的時間只放在記憶體裡；物件被移出記憶體時就忘了，下一次輪詢不會被當成
  太快）；10 分鐘最多約 120 次。輸入代碼和允許／拒絕各約 3–5 次 Durable Object 請求。
- **為什麼不預先填好代碼**：`/device?code=…` 這種連結誰都能做，攻擊者會把帶著自己代碼的連結寄給別人。代碼一定要在頁面上輸入，
  確認畫面也寫出要求來自哪裡和多久以前。
- **同源表單**：`/device` 的每個狀態變更都是同源的表單 POST（`Origin` 是 relay 自己或 `ALLOWED_ORIGINS`、有
  `Sec-Fetch-Site` 時必須是 `same-origin`），CSP 有 `frame-ancestors 'none'` 並加上 `X-Frame-Options: DENY`。頁面的
  `Referrer-Policy` 是 `same-origin`：在 `no-referrer` 之下瀏覽器送出表單時的 `Origin` 是 `null`（Fetch 規格；Chrome
  實測如此），同源檢查就會把正常的要求也擋掉。
- **迴路登入已移除**（2026-10-01）：smurg 0.1.0 的 CLI 迴路登入（`/auth/cli/start`、`/auth/cli/token`，結果送到 CLI 在
  `127.0.0.1` 上的埠）沒有人在用，relay 已經拿掉；這些路徑現在回 404。
- 測試：`test/device.test.ts`（workerd）、`test/cli-login.browser.test.ts`（Chrome 與真正的 CLI）、
  `tests/e2e/test/device-login.test.ts`、`apps/web/e2e/smoke/login.smoke.test.ts`。

### Session

- relay session 是 EdDSA JWT（`typ: smurg-session+jwt`、`aud: smurg-relay`、7 天）。它是無狀態的，過期前無法撤銷；
  踢人由 daemon 負責（撤銷裝置金鑰並送 `peer.kick`）。
- 瀏覽器：`HttpOnly; SameSite=Lax` cookie（issuer 是 https 時加上 `Secure` 與 `__Host-` 前綴）。用 cookie 開
  WebSocket，或用 cookie 送出會改變狀態的請求（POST）時，`Origin` **必須**在 `ALLOWED_ORIGINS` 裡，否則 403：
  同一個 site 的其他來源也會帶著 Lax cookie，Origin 允許清單才是真正的 CSWSH / CSRF 防線。
- CLI 與 daemon：`Authorization: Bearer <token>`，不需要 Origin。Authorization 標頭格式錯誤或權杖無效時直接 401，
  不會退回去用 cookie。
- `dev:` 身分只在 dev login 開啟的 relay 上有效（縱深防禦）。

### 身分權杖（identity token）

`POST /api/identity-token { workspaceId, cnf }` 回傳 EdDSA JWT：`typ: smurg-identity+jwt`、
`iss: <relay origin>`、`aud: smurg-daemon:<workspaceId>`、5 分鐘、`sub`（userId）、`name`、`provider`、
`picture?`、`jti`，以及 `cnf: { "smurg-noise-static": <cnf> }`。

`cnf` 是**盲化的承諾**：`base64url(SHA-256("smurg-cnf" ‖ n ‖ 裝置 Noise 靜態公鑰))`，`n` 是 32 位元組亂數，
只放在加密的 msg3 裡交給 daemon。relay 因此看不到穩定的裝置 ID。daemon 驗證方式：

```ts
const jwks = createRemoteJWKSet(new URL(`${relayOrigin}/.well-known/jwks.json`));
const { payload } = await jwtVerify(token, jwks, {
  issuer: relayOrigin, audience: `smurg-daemon:${workspaceId}`,
  typ: 'smurg-identity+jwt', algorithms: ['EdDSA'], maxTokenAge: '5m',
});
// 然後：payload.cnf['smurg-noise-static'] 必須等於用 n 和這條連線已驗證的 Noise 遠端靜態公鑰算出的承諾。
```

## 設定

`wrangler.jsonc` 最上層是**正式環境**的值（公用 relay：自訂網域 app.smurg.ai、Workers Free 方案、只用 Google 登入），
`env.dev` 只放本機的值（`vars`、`durable_objects`、`secrets` 不會被繼承，所以 `env.dev` 重複列出全部；`routes` 會被繼承，
所以 `env.dev` 寫了 `"routes": []`；本機另外可以用自己的 GitHub OAuth app）。

| 名稱 | 種類 | 正式環境 | 說明 |
|---|---|---|---|
| `workers_dev`、`routes` | 設定 | `false`；`[{ "pattern": "app.smurg.ai", "custom_domain": true }]` | relay 唯一的公開網址：一個 Cloudflare 自訂網域，或（自己架設的預設）`workers_dev: true` 而且沒有 `routes`。見「部署到 Cloudflare」 |
| `RELAY_ISSUER` | var | `https://app.smurg.ai`（自訂網域：`https://<網域>`；workers.dev：第一次部署前是 `""`，之後是 `https://smurg-relay.<子網域>.workers.dev`，由 `scripts/deploy-relay.sh` 寫入） | relay 的 origin：JWT 的 `iss`，也是 OAuth 回呼網址的前綴。只能是 https（本機可用 http），不能有路徑。空的或不正確時，除了 `/healthz` 與網頁之外所有 relay 路由都回 500 |
| `ALLOWED_ORIGINS` | var | 和 `RELAY_ISSUER` 相同（同時寫入） | 逗號分隔；可以用 cookie session 的瀏覽器來源。格式錯誤或非 https 的項目會被略過 |
| `DEV_LOGIN` | var | `"0"` | `"1"` 而且主機名稱是本機時才開啟開發用登入 |
| `RELAY_TAP_URL` | var | `""` | **僅供測試**的 R3 位元組記錄（見下）；非本機網址一律視為關閉 |
| `HOST_TIMEOUT_MS`、`CLIENT_SWEEP_MS` | var | 6000、30000 | 與 `@smurg/protocol` 常數相同 |
| `MAX_CLIENT_SOCKETS_PER_WORKSPACE`、`MAX_SOCKETS_PER_ACCOUNT` | var | 64、8 | |
| `GOOGLE_CLIENT_ID` | var | 建立 Google OAuth client 後由 `scripts/deploy-relay.sh --google-client-id` 寫入 | OAuth client ID（公開資訊） |
| `GOOGLE_*_URL`、`GOOGLE_ISSUER` | var | Google 的正式端點 | 服務端點；測試時指向 mock IdP |
| `GITHUB_CLIENT_ID`、`GITHUB_*_URL` | var | **沒有**（GitHub 登入關閉） | 只在 `env.dev` |
| `RELAY_SIGNING_KEY` | secret（必要） | `wrangler secret put`（見「部署到 Cloudflare」） | Ed25519 私鑰 JWK。也可以是 `{"keys":[新私鑰, 舊公鑰…]}`：第一把簽章，全部都會公開在 JWKS 並用於驗證（換鑰匙時不會讓大家被登出） |
| `GOOGLE_CLIENT_SECRET` | secret（選用） | `wrangler secret put`（同上） | 缺少時 Google 登入關閉（回 503），不會用空的 client secret 去呼叫 Google |
| `GITHUB_CLIENT_SECRET` | secret（選用） | 不設定 | 只在本機（`.dev.vars`） |

設定有問題時一律「關閉」：issuer 無效時所有登入相關路由回 500；某個供應商的設定不完整或端點不是 https 時，
只有那個供應商被關閉。

## 本機開發

```sh
source scripts/env.sh
pnpm dev:relay          # wrangler dev --env dev，127.0.0.1:8787（SMURG_RELAY_DEV_PORT 可改）
pnpm dev:web            # Vite 在 localhost:5173，把 relay 路徑代理到 8787
```

- 第一次執行 `pnpm dev:relay` 時，若 `apps/relay/.dev.vars` 不存在，會自動建立（權限 0600）並放入新產生的開發用
  `RELAY_SIGNING_KEY`。已存在的檔案不會被修改。範本見 `.dev.vars.example`（只有預留位置）。
- 開發用登入：瀏覽器打開 `http://localhost:5173/auth/dev/start?user=amy&return_to=http://localhost:5173/`，
  或 `curl -X POST -H 'content-type: application/json' -d '{"user":"amy"}' http://localhost:8787/auth/dev/token`。
- 網頁開發伺服器和 relay 要用同一個主機名稱（都用 `localhost`），cookie 才會送出。
- 絕對不要在 `.dev.vars` 放正式環境的金鑰；測試不會讀這個檔案。


## 部署到 Cloudflare

**只有專案的維護者會部署 relay**：smurg 的原始碼（包括這個套件）不公開（2026-10-01 起，`docs/OPEN-QUESTIONS.md` Q1），
所以專案以外的人無法自己架設 relay，主人都用公用 relay https://app.smurg.ai。下面「自己架設」的兩節是維護者另外架設
一個 relay（例如測試用、另一個 Cloudflare 帳號）的步驟；`smurg login --relay <網址>` 用來連到這樣的 relay。

relay 是一個 Cloudflare 帳號上的一個 Worker（Workers **Free** 方案），登入只用 Google（部署的人自己建立的 OAuth client）。
網頁（`apps/web` 的建置結果）由同一個 Worker 提供，所以網頁、登入與 WebSocket 都在同一個 origin。relay **只有一個公開網址**，
由 `wrangler.jsonc` 最上層決定，`scripts/deploy-relay.sh` 只接受下面兩種形式，其他的一律拒絕：

| 形式 | `wrangler.jsonc` 最上層 | 網址 | 用在 |
|---|---|---|---|
| 自訂網域 | `"workers_dev": false`；`"routes"` 剛好一個 `{ "pattern": "<網域>", "custom_domain": true }`；`RELAY_ISSUER`、`ALLOWED_ORIGINS` 都是 `https://<網域>` | `https://<網域>` | **專案的公用 relay https://app.smurg.ai**（提交的 `wrangler.jsonc` 就是這個形式，2026-10-01 起；之前是 `https://smurg-relay.gclin-ian.workers.dev`，現在回 404）。網域的 zone 必須在同一個 Cloudflare 帳號 |
| workers.dev | `"workers_dev": true`；沒有 `"routes"`；`RELAY_ISSUER`、`ALLOWED_ORIGINS` 第一次部署前是 `""` | `https://smurg-relay.<子網域>.workers.dev` | **另外架設的 relay（維護者，例如測試用）的預設**：不需要自己的網域 |

兩種形式都關閉 `preview_urls`（每個版本都會多一個公開網址，而且連到同一批 Durable Object），也不會同時開著 workers.dev
與自訂網域。

部署一律在 repo 根目錄用 `scripts/deploy-relay.sh`（它會 `source scripts/env.sh`），可以重複執行：

- 它**不會**執行 `wrangler login` 或 `wrangler secret put`，也不會讀取、顯示、寫入或傳遞任何 secret：需要時它印出指令，由你執行。
- Durable Object 的 migration 由 `wrangler deploy` 依序套用，每個 tag 只套用一次：`v1`（`WorkspaceDO`、`TransferDO`，
  2026-10-01 部署）**不能再改**；`v2`（`DeviceLoginDO`，CLI 用代碼登入）在它之後的第一次部署時建立，不需要另外的指令。
  新的 class 一律用新的 tag 和 `new_sqlite_classes`（Free 方案只能用 SQLite 型）；第 3 步的檢查只接受剛好 `v1`、`v2`。
- wrangler 的登入資料留在 repo 的 `.xdg/`（`scripts/env.sh` 設定 `XDG_CONFIG_HOME`；`.xdg/` 在 `.gitignore` 裡），不會寫進家目錄。

### 共同的前兩步

以下都在 repo 根目錄、先執行過 `source scripts/env.sh` 的終端機裡。

1. **登入 Cloudflare**（會打開瀏覽器的 Cloudflare 授權頁）：
   ```sh
   CI=false pnpm --filter @smurg/relay exec wrangler login
   ```
   `CI=false`：`scripts/env.sh` 設定了 `CI=true`，wrangler 在 CI 模式下不做互動式操作。這個登入可以使用多個帳號時，
   之後的指令前面都加上 `CLOUDFLARE_ACCOUNT_ID=<帳號 ID>`（`pnpm --filter @smurg/relay exec wrangler whoami` 會列出）。
2. **放入簽章金鑰**（金鑰只經過管線交給 wrangler，不會出現在畫面上或任何檔案裡）：
   ```sh
   node apps/relay/scripts/signing-key.ts | pnpm --filter @smurg/relay exec wrangler secret put RELAY_SIGNING_KEY --env=""
   ```
   必須在第一次部署之前：`wrangler.jsonc` 的 `secrets.required` 列了 `RELAY_SIGNING_KEY`，wrangler 4.142 不接受缺少它的
   第一次部署；Worker 還不存在時，`wrangler secret put` 會先建立一個空的 `smurg-relay` Worker 再放入金鑰。
   `signing-key.ts` 印出的是一把 Ed25519 私鑰 JWK（`kty`、`crv`、`x`、`d`、`kid`＝RFC 7638 thumbprint），正是 relay 讀取的格式
   （`src/auth/keys.ts`；`test/build.test.ts` 驗證）。

### 公用 relay：自訂網域 app.smurg.ai（專案維護者）

提交的 `wrangler.jsonc` 已經是部署的樣子（`workers_dev: false`、自訂網域 `app.smurg.ai`、`RELAY_ISSUER` 與
`ALLOWED_ORIGINS` 是 `https://app.smurg.ai`、公用 relay 的 `GOOGLE_CLIENT_ID`），網址事先就知道，不需要「先部署一次」。

3. `smurg.ai` 這個 zone 在同一個 Cloudflare 帳號（Websites，狀態 Active）：部署時 wrangler 把自訂網域接到 Worker，
   Cloudflare 自動建立 DNS 記錄與憑證。這個腳本執行的 wrangler（`CI=true`）**不會詢問**：`app.smurg.ai` 已經有 DNS 記錄
   或別的 Worker 的自訂網域時，會直接被換成這個 relay（wrangler 4.142 的 `publishCustomDomains`）。所以腳本部署前先看那個
   網址現在由誰回應：還沒有 DNS 記錄，或已經是 smurg relay，才繼續；否則停下來說明（確定要接手時加 `--take-over-hostname`）。
   zone 的設定（dashboard，一次）：**SSL/TLS → Edge Certificates → Always Use HTTPS 打開**（workers.dev 在 `.dev` 底下，
   瀏覽器本來就只用 https；自訂網域沒有這個保護，沒打開時 `http://` 會直接回網頁，網路上的人可以換掉它）；**Bot Fight
   Mode 關閉、不要用 I'm Under Attack、不要有會 challenge 這個網址的 WAF 規則**（CLI 與 daemon 不是瀏覽器，過不了
   challenge）。外部檢查（第 10 步、`--check`）會檢查前者，並在 Cloudflare 擋下請求時說明（`docs/RELEASING.md` §2）。
4. **Google OAuth client**（下一節）：Authorized JavaScript origins `https://app.smurg.ai`、Authorized redirect URIs
   `https://app.smurg.ai/auth/google/callback`、Authorized domains（Branding）`smurg.ai`；然後放入 client secret：
   ```sh
   CI=false pnpm --filter @smurg/relay exec wrangler secret put GOOGLE_CLIENT_SECRET --env=""
   ```
5. **部署**：
   ```sh
   scripts/deploy-relay.sh                                 # 換 client 時：--google-client-id <client ID>，再提交 wrangler.jsonc
   scripts/deploy-relay.sh --check https://app.smurg.ai    # 之後隨時：只從外部檢查
   ```
   腳本部署一次，並確認 wrangler 的部署結果剛好是自訂網域（`app.smurg.ai (custom domain)`）而且沒有 workers.dev 網址；
   新的自訂網域（DNS 與憑證）可能要幾分鐘才連得上，外部檢查預設重試 180 秒。全部通過時印出「完成」，其中包括線上的
   網頁就是這次建置的（每次發佈新版本前都要從那個 commit 重新部署：舊的網頁會拒絕新版 daemon，`docs/RELEASING.md` §4）。
   網頁由工作目錄建置，所以從乾淨的 checkout 部署（`git status` 沒有任何輸出）。

### 自己架設：workers.dev（預設）

維護者另外架設一個 relay（例如測試用）時，不需要網域。提交的 `wrangler.jsonc` 是公用 relay 的設定，所以先在另一份
checkout 裡改成 workers.dev 的形式（只改這幾行，不要提交）：

```jsonc
"workers_dev": true,          // 原本是 false
                              // 刪掉 "routes": [{ "pattern": "app.smurg.ai", "custom_domain": true }], 這一行
"RELAY_ISSUER": "",           // vars 裡：原本是 https://app.smurg.ai
"ALLOWED_ORIGINS": "",
"GOOGLE_CLIENT_ID": "",       // 公用 relay 的 client ID 不能給你用
```

3. **第一次部署**（先做完上面共同的第 1、2 步）：
   ```sh
   scripts/deploy-relay.sh
   ```
   `RELAY_ISSUER` 還是空的，所以腳本先部署一次（這時 relay 是關閉的：除了 `/healthz` 與網頁之外都回 500，沒有人能登入），
   從部署結果得知 workers.dev 網址，寫進 `wrangler.jsonc`，再部署一次，最後印出網址與 Google 要填的兩個值並從外部檢查
   （Google 登入這時還沒開啟，是預期的）。已經知道子網域的話，用 `scripts/deploy-relay.sh --url https://smurg-relay.<子網域>.workers.dev`
   只部署一次。帳號還沒有 workers.dev 子網域時，wrangler 會失敗並印出 `https://dash.cloudflare.com/<帳號>/workers/onboarding`：
   在那裡選一個子網域，再執行一次。
4. **建立 Google OAuth client**（下一節），填入第 3 步印出的 JavaScript origin 與 redirect URI。
5. **放入 Google 的 client secret**（出現 `Enter a secret value:` 時貼上，畫面上不會顯示）：
   ```sh
   CI=false pnpm --filter @smurg/relay exec wrangler secret put GOOGLE_CLIENT_SECRET --env=""
   ```
6. **寫入 client ID 並再部署一次**：
   ```sh
   scripts/deploy-relay.sh --google-client-id <client ID>.apps.googleusercontent.com
   ```
   全部檢查通過時印出「完成」。
7. 保存你改過的 `apps/relay/wrangler.jsonc`（網址與 client ID 都是公開資訊）。主人用 `smurg login --relay <你的網址>`
   指定它（印出的邀請連結就會指向它）；要讓你自己建置的 CLI 預設使用它，把 `packages/cli/src/relay/default-relay.ts` 的 `DEFAULT_RELAY_URL` 改成這個網址
   （腳本會印出那一行）。

### 自己架設：自己的網域

網域的 zone 在同一個 Cloudflare 帳號時，也可以用自訂網域（例如 `relay.example.edu`）：`"workers_dev"` 保持 `false`，
把 `routes` 的 `pattern` 改成你的網域，`RELAY_ISSUER`、`ALLOWED_ORIGINS` 改成 `https://<你的網域>`，`GOOGLE_CLIENT_ID`
改成 `""`；然後照「公用 relay」的第 3–5 步做（Google 的 origin、redirect URI 與 authorized domain 換成你的網域，
第 5 步加上 `--google-client-id <你的 client ID>`）。`--url` 給的話必須剛好是 `https://<你的網域>`。

### Google OAuth client（Google Cloud console）

Google 的主控台偶爾改名：下面同時寫出「APIs & Services」的名稱，以及較新的「Google Auth Platform」的名稱。這些畫面沒有在
開發環境裡實際操作過。

1. 打開 https://console.cloud.google.com/ ，上方的專案選單 → **New project**（名稱例如 `smurg-relay`）→ 建立後切換到它。
2. **同意畫面**：APIs & Services → **OAuth consent screen**（新介面：**Google Auth Platform → Get started**，之後在
   **Branding** 與 **Audience**）：
   - App name（登入時使用者看到的名稱，例如 `smurg`）、User support email、Developer contact email。
   - User type／Audience：**External**。
   - Scopes（Data Access）：不用新增。relay 只要求 `openid`、`email`、`profile`，都是非敏感範圍。
   - **Testing 或 In production**：剛建立時是 Testing，只有列在 **Test users** 裡的 Google 帳號（最多 100 個）能登入，適合先
     自己試；要讓所有人登入時，在 Audience（舊介面：OAuth consent screen）按 **Publish app** 改成 In production。只用上面
     三個非敏感範圍時，Google 一般不要求送審（沒有在這裡驗證）。
   - **Authorized domains**（Branding）：relay 用自訂網域時，加上它所屬、你擁有的網域（公用 relay：`smurg.ai`）。
3. **建立 client**：APIs & Services → **Credentials → Create credentials → OAuth client ID**（新介面：**Clients → Create client**）：
   - Application type：**Web application**，名稱隨意（例如 `smurg relay`）。
   - **Authorized JavaScript origins**：relay 的網址，例如 `https://app.smurg.ai`（公用 relay）或
     `https://smurg-relay.<子網域>.workers.dev`（`scripts/deploy-relay.sh` 會印出）
   - **Authorized redirect URIs**：relay 的網址加上 `/auth/google/callback`，例如 `https://app.smurg.ai/auth/google/callback`
   - 按 **Create**。**Client ID** 是公開的，交給部署腳本的 `--google-client-id`；**Client secret** 是秘密，只用
     `wrangler secret put GOOGLE_CLIENT_SECRET` 貼進 wrangler，不要放進任何檔案、聊天或 issue。
4. relay 以 state + nonce + PKCE 登入，並用 Google 的 JWKS 驗證 `id_token`（`iss` 接受 `https://accounts.google.com` 與
   `accounts.google.com`，`aud` 必須是自己的 client ID）。CLI 登入不需要另外註冊網址：CLI 用代碼登入，
   人在 relay 的 `/device` 頁面用同一個 `/auth/google/callback` 登入。

### `scripts/deploy-relay.sh` 做什麼

| 步驟 | 內容 |
|---|---|
| 1 | `wrangler whoami --json`：沒有登入就印出登入指令並停止（結束代碼 3）；有多個帳號而沒有 `CLOUDFLARE_ACCOUNT_ID` 時列出帳號並停止 |
| 2 | `wrangler secret list`：Worker 還不存在或沒有 `RELAY_SIGNING_KEY` 時，印出上面第 2 步的指令並停止（結束代碼 3） |
| 3 | 檢查 `wrangler.jsonc` 最上層：兩種形式之一（自訂網域：`workers_dev: false`、剛好一個 `{ pattern, custom_domain: true }` 的 route、`RELAY_ISSUER` 是 `https://<網域>`；workers.dev：`workers_dev: true`、沒有 routes、`RELAY_ISSUER` 是空的或這個 Worker 的 workers.dev 網址；`--url` 必須符合那個形式）、`preview_urls: false`、`DEV_LOGIN` `"0"`、`RELAY_TAP_URL` 空的、沒有 `GITHUB_*`、Google 的正式端點、`ALLOWED_ORIGINS` 等於 `RELAY_ISSUER`、`secrets.required`、三個 SQLite Durable Object 與剛好 `v1`、`v2` 兩個 migration、SPA assets 與 `run_worker_first`（`test/config.test.ts` 對提交的檔案做同樣的檢查） |
| 4 | `pnpm --filter @smurg/web build`，再執行 `scripts/check-web-dist.ts`：必須是真正的建置結果，有含 `frame-ancestors 'none'` 的 CSP 與至少一年的 `Strict-Transport-Security` 的 `_headers`，不公開 `.vite/`。記下 `index.html` 載入的 `/assets/…` 檔案（檔名含內容的雜湊，第 10 步比對） |
| 5 | 網址。自訂網域：`https://<routes 的網域>`，接著查那個網址現在由誰回應（DNS 查詢，有記錄時再看 `/healthz` 與 `/api/login-options`）：還沒有 DNS 記錄或已經是 smurg relay 才繼續，否則停下來（結束代碼 3），因為這個腳本執行的 wrangler 會不經詢問接手那個網址（`--take-over-hostname` 照樣部署；`--dry-run` 不查）。workers.dev：`--url`，否則 `wrangler.jsonc` 的 `RELAY_ISSUER`，否則先部署一次（issuer 空的，relay 關閉），從 wrangler 寫在 `WRANGLER_OUTPUT_FILE_PATH` 的部署結果（`{"type":"deploy","targets":[…]}`）得知。wrangler 沒有單獨印出帳號 workers.dev 子網域的指令：`wrangler whoami` 只列出帳號 |
| 6 | 把 `RELAY_ISSUER`、`ALLOWED_ORIGINS`（workers.dev 的網址；自訂網域的已經寫好）與 `GOOGLE_CLIENT_ID`（`--google-client-id`）寫進 `wrangler.jsonc` 最上層的 `vars`：只改那幾行，註解、`workers_dev`、`routes` 與 `env.dev` 不動，寫入前重新解析比對 |
| 7 | `wrangler deploy --env ""`；部署結果必須剛好是那個網址，不同時停止並說明：workers.dev 網址等於 `RELAY_ISSUER`（不同：帳號的子網域改過），或自訂網域是 `<網域> (custom domain)`（wrangler 4.142 的寫法）而且沒有 workers.dev 網址 |
| 8 | 印出網址、Google 的 JavaScript origin 與 redirect URI（自訂網域另外提醒 authorized domain），以及 CLI 的 `DEFAULT_RELAY_URL` 和這個網址不同時該填的那一行 |
| 9 | 再看一次 secret，印出缺少的那一個的指令 |
| 10 | 從外部檢查（新的 workers.dev 網址或自訂網域可能要幾分鐘才連得上，預設重試 180 秒，`--wait` 可改）：`/healthz`；`/api/login-options` 是 `google: true, github: false, dev: false`；`/.well-known/jwks.json` 有 Ed25519 公鑰而且沒有私鑰欄位；`/` 與 SPA 深層連結是網頁的 `index.html`，並帶有 `_headers` 的 `Content-Security-Policy`（`frame-ancestors 'none'`）、`X-Frame-Options: DENY`、`X-Content-Type-Options: nosniff`，https 的 relay 還要有 `Strict-Transport-Security`（`max-age` 至少 31536000；有兩個這種 header 時只看第一個，和瀏覽器一樣；本機的 http relay 不檢查）；`/auth/google/login` 轉到 Google，`redirect_uri` 是這個 relay 的 `/auth/google/callback`、`client_id` 是設定的那一個、cookie 是 `__Host-` 開頭而且 `Secure`；線上的網頁是第 4 步的建置（`/` 載入的 `/assets/…` 檔案相同）；自訂網域的 `http://…/healthz` 回 301 或 308 轉到同一個 `https://` 網址（zone 的 Always Use HTTPS；workers.dev 不需要）。Cloudflare 自己擋下請求（回應有 `cf-mitigated`）時，那一項失敗並說明原因 |

**部署時設定的 vars**：不用 `--var`。正式環境執行的就是提交在 `wrangler.jsonc` 最上層的值；腳本只在部署前把
`RELAY_ISSUER`、`ALLOWED_ORIGINS`（workers.dev：第一次得知網址，或 `--url` 改變時）與 `GOOGLE_CLIENT_ID`（`--google-client-id`）
寫進那個檔案。唯一的例外是 workers.dev 第一次、還不知道網址時的那次部署：它照檔案原樣使用空的 issuer（relay 關閉）。`keep_vars` 沒有開啟，
所以在 Cloudflare dashboard 手動改的 vars，下一次部署時會被 `wrangler.jsonc` 的值蓋掉。secret 不受部署影響。

其他模式與結束代碼：

```sh
scripts/deploy-relay.sh --dry-run [--url …] [--google-client-id …]   # 建置網頁、檢查設定、wrangler deploy --dry-run；完全不連 Cloudflare 帳號（不查登入與 secret）、不部署、不改檔案
scripts/deploy-relay.sh --check https://app.smurg.ai   # 只做第 10 步（預期 Google 登入已開啟）；自己的 relay 換成它的網址
```

`--check` 比對網頁時用這個 checkout 的 `apps/web/dist`（或 `--web-dist <目錄>`）；裡面沒有建置結果（不存在、替代頁面、沒有 `index.html`）時不比對，並印出說明。
`scripts/check-web-dist.ts` 會拒絕、但確實是建置結果的目錄（例如 `apps/web/public/_headers` 加入 HSTS 之前的建置）照樣比對，並印出「注意：」與原因：
它可能比這個 checkout 舊，先 `pnpm --filter @smurg/web build` 再比對。

0 完成（Google 還沒設定好時會印出接下來的步驟）、1 失敗、2 參數錯誤、3 需要你先做某件事（登入、選帳號、放入簽章金鑰、
自訂網域已經有別的東西在回應）。

腳本的每一步在 `test/deploy-relay.test.ts` 裡對一個假的 wrangler（照 wrangler 4.142 原始碼的輸出格式回答）與設定成正式環境的
本機 relay 跑過完整流程，兩種形式都有（提交的自訂網域設定，與改成 workers.dev 的設定）。對真正的 Cloudflare 帳號：workers.dev
形式在 2026-10-01 公用 relay 第一次部署時執行過；同一天搬到 app.smurg.ai 時，用的是 `wrangler deploy`（從一份最上層與提交的
`wrangler.jsonc` 相同的副本；那天的腳本只接受 workers.dev），所以腳本的自訂網域形式要到下一次部署公用 relay 時，才第一次對
真正的帳號執行（`docs/RELEASING.md` §10）。

**每次部署都會中斷所有 WebSocket**（`docs/research/relay.md` gotcha 9）：主人、組員的網頁與 CLI 會自動重新連線，但正在進行的
傳輸要重來。只想確認狀態時用 `--check`，不要重新部署。

### 之後

- **更新 relay**：取得新程式後，在乾淨的 checkout 執行 `scripts/deploy-relay.sh`（網址與 client ID 已經在
  `wrangler.jsonc` 裡；自己架設的人要保留自己改過的那幾行）。relay 的網頁要至少和使用它的主人的 smurg 一樣新：網頁用嚴格的
  格式解讀 daemon 的訊息，舊的網頁會拒絕新版 daemon 多出的欄位（新的網頁接受舊版 daemon）。
- **換簽章金鑰**：直接換掉會讓所有人的登入失效。要不影響登入，先把 `RELAY_SIGNING_KEY` 放成 `{"keys":[新私鑰, 舊公鑰]}`
  （見「設定」），7 天（session 期限）後再只放新私鑰。
- **換 Google client secret**：在 Google Cloud console 新增一個 secret，再用 `wrangler secret put GOOGLE_CLIENT_SECRET` 放入。
- **只用 Google 登入**：這個腳本部署的 relay 只用 Google 登入；要用 GitHub 登入得自己改 `wrangler.jsonc` 最上層的 vars，
  而腳本的檢查會拒絕（它只部署專案決定的 Google-only 設定）。
- **換網址**（workers.dev 與自訂網域互換，或換網域）：改 `wrangler.jsonc` 的形式（上面的表）與 `RELAY_ISSUER`、
  `ALLOWED_ORIGINS`，Google OAuth client 的 origin 與 redirect URI 也要改；舊網址的邀請連結失效，CLI 的預設 relay 是編譯進
  執行檔的。用 CLI 登入過舊網址的人，CLI 會繼續選上次登入的 relay（它排在內建的預設之前）：請他們執行
  `smurg login --relay <新網址>`（或先 `smurg logout --relay <舊網址>`）。公用 relay 在 2026-10-01、第一個版本發佈之前從
  workers.dev 換到 app.smurg.ai，之後不再換。

### Workers Free 方案的限制

限制的數字來自 Cloudflare 的文件（2026 年 8–9 月版，`docs/research/relay.md` 的調查留下的副本）；relay 的用量是依程式推算，
**沒有在 Cloudflare 上量過**。

| 限制（Free） | 值 | 超過時 |
|---|---|---|
| Worker 請求 | 整個帳號每天 100,000 次，00:00 UTC 重置 | 回 Cloudflare 錯誤 1027，直到重置 |
| 每個請求的 CPU 時間 | 10 ms | 錯誤 1102。relay 的請求會做 Ed25519 簽章或驗證，Google 登入回呼還要驗 RS256；是否都在 10 ms 內沒有量過 |
| Durable Object 請求 | 每天 100,000 次：HTTP 請求、RPC、**alarm 的每一次執行**，以及收到的 WebSocket 訊息（20 則算 1 次） | 之後這類操作都會失敗，直到 00:00 UTC |
| Durable Object 執行時間 | 每天 13,000 GB-s（relay 只用 Hibernation API，閒置的物件不計） | 同上 |
| SQLite 寫入 | 每天 100,000 列：**每次 `setAlarm()` 算 1 列**，`storage.kv` 的寫入也算 | 同上 |
| SQLite 讀取、儲存 | 每天 500 萬列、總共 5 GB | 同上 |
| 靜態檔案 | 每個版本 20,000 個檔案、每個 25 MiB、`_headers` 100 條規則 | 部署失敗 |

relay 的用量（推算）：

- 主人在線、而且至少有一位組員連著時，`WorkspaceDO` 的 alarm 在主人最後一次 ping 之後 6 秒觸發（主人每 2 秒 ping 一次），也就是
  大約每 4–6 秒一次：每個工作區每天約 **14,000–22,000 次 alarm（＝請求），以及同樣多列的 SQLite 寫入**。只算這一項，Free 方案
  大約撐 **4–7 個整天都有人連著的工作區**。`TransferDO` 在有檔案傳輸連線時約每 30 秒一次。沒有組員連著時不設 alarm。
- 每條 WebSocket 連線建立時是 1 次 Worker 請求加 1 次 Durable Object 請求；登入、建立工作區、身分權杖等 API 各是 1 次 Worker 請求。
- CLI 用代碼登入：見上面「CLI 用代碼登入」的費用（一次登入最多約 120 次輪詢，每次 1 次 Worker 請求和 1 次 Durable Object
  請求，不寫入）。
- 心跳（文字 `"ping"`）由 auto-response 回應，不計費。打字、終端機輸出、檔案傳輸的每一則訊息（送進 Durable Object 的方向，
  包括主人送給組員的）以 1/20 次請求計算：一個持續輸出的終端機一天就可能用掉數萬次。
- 網頁的靜態檔案不經過 Worker（`run_worker_first` 只列 relay 的路徑）；它們是否計入每天 100,000 次，這裡沒有驗證。

結論：Free 方案適合試用、上課示範與少數團隊。整天有多個工作區在用時會碰到上限，當天之後所有人都連不上，這時改用
Workers Paid 方案即可，程式與 `wrangler.jsonc` 都不用改（SQLite Durable Object 兩種方案都能用）。每天的用量可以在
Cloudflare dashboard 的 Workers & Pages → smurg-relay → Metrics 看到。

### 疑難排解

| 看到 | 原因與處理 |
|---|---|
| 「wrangler 還沒有登入 Cloudflare」 | 共同的第 1 步。一定要先 `source scripts/env.sh`，登入資料才會放在 repo 的 `.xdg/`（腳本只看那裡） |
| 「這個帳號還沒有 smurg-relay 這個 Worker」、`required secrets have not been set: RELAY_SIGNING_KEY` | 共同的第 2 步 |
| 「wrangler.jsonc 不適合正式環境」，提到 `workers_dev`、`routes` 或 `RELAY_ISSUER` | 設定不是上面兩種形式之一：自訂網域要 `workers_dev: false`、剛好一個 custom domain route、`RELAY_ISSUER` 是 `https://<那個網域>`；workers.dev 要 `workers_dev: true`、刪掉 `routes`、`RELAY_ISSUER` 是 `""` 或這個 Worker 的 workers.dev 網址 |
| 「--url … 不是 wrangler.jsonc 的自訂網域」或「不是 https://smurg-relay.<子網域>.workers.dev」 | `--url` 和設定的形式不同：照錯誤訊息改 `wrangler.jsonc`（自己架設在 workers.dev：「自己架設：workers.dev」），或拿掉 `--url` |
| `You need to register a workers.dev subdomain` | 打開 wrangler 印出的 `https://dash.cloudflare.com/<帳號>/workers/onboarding` 選一個子網域，再執行一次 |
| `Could not find zone for …`、「部署結果裡沒有自訂網域 … (custom domain)」 | 網域的 zone 不在這個 Cloudflare 帳號（或 DNS 不是由 Cloudflare 代管）：在 dashboard 確認後再執行一次 |
| 「… 已經有東西在回應，而且不是 smurg relay」 | 那個網址已經有 DNS 記錄或別的 Worker 的自訂網域。這個腳本執行的 wrangler 不會詢問，會直接把它換成這個 relay，所以腳本先停下來。要保留它：改用別的網域；確定要接手：在 dashboard 移除舊的記錄，或加上 `--take-over-hostname` |
| ✗ 「GET /（網頁是這個 checkout 的建置）」 | 線上的網頁不是這個 checkout 建置的版本：從要用的 commit 的乾淨 checkout 重新部署。只是 `apps/web/dist` 舊了（或含有沒提交的修改）時，`pnpm --filter @smurg/web build` 後再 `--check` |
| ✗ 「http:// 轉到 https://」 | 自訂網域的 zone 沒有打開 SSL/TLS → Edge Certificates → Always Use HTTPS |
| ✗ 「GET /（網頁與 CSP）」說沒有 `Strict-Transport-Security` | 線上的網頁是 `apps/web/public/_headers` 加入 HSTS 之前的建置（2026-10-01 的 `app.smurg.ai` 就是）：從要發佈的 commit 重新部署 |
| `cf-mitigated` | Cloudflare 的 Bot Fight Mode、I'm Under Attack 或 WAF 規則擋下了請求：對 relay 的網址關掉（CLI 與 daemon 過不了 challenge） |
| `wrangler secret put` 或 `wrangler login` 在互動前就失敗 | 指令前面要加 `CI=false`（`scripts/env.sh` 設定了 `CI=true`） |
| `--check` 的 `/api/login-options` 是 HTTP 500 | `RELAY_ISSUER` 是空的，或 `RELAY_SIGNING_KEY` 不對：重新執行 `scripts/deploy-relay.sh` |
| `google=false` | 缺少 `GOOGLE_CLIENT_SECRET`（`wrangler secret put GOOGLE_CLIENT_SECRET`）或 `GOOGLE_CLIENT_ID`（`--google-client-id`） |
| Google 顯示 `redirect_uri_mismatch` | OAuth client 的 Authorized redirect URIs 必須剛好是 `<relay 網址>/auth/google/callback`（公用 relay：`https://app.smurg.ai/auth/google/callback`）；自訂網域另外要在 Branding 的 Authorized domains 加上它的網域 |
| Google 說這個應用程式只開放給測試使用者 | 同意畫面還在 Testing，而這個帳號不在 Test users：加入它，或 Publish app |
| Cloudflare 錯誤 1027 | 今天的 Free 方案請求用完了（見上表） |

## 本機開發用的 OAuth app（GitHub / Google）

正式環境只用 Google（上一節）。本機開發想測真正的 OAuth 時，另外建立開發用的 app（回呼網址不同）：

- **GitHub**（OAuth App，不是 GitHub App）：GitHub → Settings → Developer settings → OAuth Apps → **New OAuth App**。Homepage URL
  `http://localhost:8787`，Authorization callback URL（只能填一個）`http://localhost:8787/auth/github/callback`；建立後複製
  **Client ID**，按 **Generate a new client secret**。relay 不要求任何 scope（只讀公開的 id、login、name、頭像），使用 PKCE（S256）。
- **Google**：同上一節，但 JavaScript origin 是 `http://localhost:8787`，redirect URI 是 `http://localhost:8787/auth/google/callback`。
- 寫進 `apps/relay/.dev.vars`（見 `.dev.vars.example`；client ID 也可以寫在那裡），不要放正式環境的 secret。

## 建置、部署與測試

```sh
pnpm --filter @smurg/relay typecheck   # wrangler types --check + tsc（Worker 與 Node 測試各一次）
pnpm --filter @smurg/relay test        # vitest：真的在本機 workerd 上跑
pnpm --filter @smurg/relay build       # wrangler deploy --dry-run（不會部署）
scripts/deploy-relay.sh                # 正式部署（需要 Cloudflare 帳號，見「部署到 Cloudflare」；自動化流程與測試都不執行）
```

改了 `wrangler.jsonc` 的結構（新增或刪除 var、binding）之後要執行 `pnpm --filter @smurg/relay types` 重新產生
`worker-configuration.d.ts`；只改 var 的值（例如部署腳本寫入網址）不需要，型別以 `--strict-vars=false` 產生，與值無關。

`build` 會先執行 `scripts/check-web-dist.ts`：`apps/web/dist` 不存在，或只是 `pnpm dev:relay` 與測試放進去的替代頁面（有
`.smurg-stand-in` 標記）時就拒絕打包，請先 `pnpm --filter @smurg/web build`（或直接 `pnpm build`）。真正部署前也要先建置網頁
（`scripts/deploy-relay.sh` 會做）。建置結果還必須有 `_headers`（`/*` 規則的 Content-Security-Policy 含 `frame-ancestors 'none'`，以及
`Strict-Transport-Security: max-age=31536000` 或更長；這兩行都要在 `/*` 規則底下，放在別的規則（例如 `/assets/*`）不算。不加 `includeSubDomains`、`preload`，與 `apps/site` 相同：這是約定，檢查只要求 `max-age` 至少一年），
而且有 `.vite/` 時 `.assetsignore` 必須列出 `.vite`（不公開建置 manifest）；兩個檔案都來自 `apps/web/public/`。

測試會把 miniflare 的暫存資料放在每次執行專用的 `TMPDIR`（`test/test-tmp.ts`），全部測試結束後由 global teardown 刪除。

## 在其他套件的測試裡使用 relay：`@smurg/relay/testing`

```ts
import { wsClientUrl, wsHostUrl } from '@smurg/protocol/relay';
import { connectRelaySocket, startLocalRelay } from '@smurg/relay/testing';

const relay = await startLocalRelay({ tap: true });          // 127.0.0.1 隨機埠、每次新的簽章金鑰
const alice = await relay.devLogin('alice', { displayName: 'Alice' });
const workspaceId = await relay.createWorkspace(alice.token);
const host = connectRelaySocket(wsHostUrl(relay.origin, workspaceId), { token: alice.token });
await host.opened;
// …daemon / client 走 relay.origin；需要時 relay.identityToken(token, workspaceId, cnf)
// relay.tap?.frames() 是 relay 看到的每一個位元組；findPlaintext(frames, marker) 搜尋明文
await relay.stop();
```

- 完全隔離：所有 var 與 secret 都明確傳入（`.dev.vars` 和行程環境變數都會被覆蓋），預設沒有任何 OAuth 供應商。
- `relay.evictDurableObjects()` 強制休眠（socket 保持連線、記憶體狀態清空）；`relay.inspect(kind, id)` 讀房間狀態。
- `connectRelaySocket` 預設每 2 秒送 `"ping"`；測試客戶端不送 ping 會在 `CLIENT_SWEEP_MS` 後被關掉。
- R3 的 tap（`RELAY_TAP_URL`）只會送到本機的收集器，記錄 Worker 看到的每個請求（請求列與標頭）以及兩種 Durable Object
  收到與送出的每個訊框。auto-response 回應的 `"ping"` 不會經過 relay 的程式碼，所以不會出現在記錄裡。
