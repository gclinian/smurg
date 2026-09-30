# @smurg/relay

smurg 的 relay：一個 Cloudflare Worker 加上兩個 SQLite 型 Durable Object（`WorkspaceDO`、`TransferDO`）。
它負責 OAuth 登入、發放 relay session 與身分權杖（identity token），並依工作區轉送**已經端對端加密**的訊框。
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
| `GET /auth/cli/start?port=P&state=S&code_challenge=C[&provider=github\|google\|dev][&user=名稱]` | CLI 迴路登入的**確認頁**（只顯示，不做任何事）：列出登入方式（有 `provider` 時只列那一種）與確認碼，說明只有自己剛執行 `smurg login`、且終端機顯示同一組確認碼時才繼續 |
| `POST /auth/cli/start`（表單，欄位同上） | 只接受確認頁本身送出的表單：`Origin` 必須是 relay 自己（或 `ALLOWED_ORIGINS`），有 `Sec-Fetch-Site` 時必須是 `same-origin`，否則 403。之後走供應商登入或開發用登入；結果經由 relay 的「繼續」頁（meta refresh ＋ 連結，不是 302）送到 `http://127.0.0.1:P/callback?code=…&state=S`（失敗時是 `?error=…&state=S`） |
| `POST /auth/cli/token` `{ code, codeVerifier }` | 換成 bearer session：`{ token, tokenType, expiresIn, user }` |
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

其他路徑都是網頁 SPA（`wrangler.jsonc` 的 `assets`；Worker 先處理的路徑見 `RELAY_WORKER_FIRST_PATTERNS`）。

### CLI 迴路登入為什麼這樣設計

- **連結本身不會登入任何人**（安全審查 SEC-E-03）：任何網頁都能用自己選的 port、state 與 PKCE challenge 連到
  `/auth/cli/start`。以前帶著 `provider=github` 的 GET 會直接轉到 GitHub，而 GitHub 對已授權過的 app 不再問使用者，
  於是一次點擊就把 7 天的 relay session 交給在那台電腦本機 port 上等著的程式。現在 GET 只顯示確認頁；繼續必須是確認頁
  自己的同源 POST。確認頁的 `Referrer-Policy` 是 `same-origin`：在 `no-referrer` 之下瀏覽器送出表單時的 `Origin` 是
  `null`（Fetch 規格；Chrome 實測如此），同源檢查就會把正常的登入也擋掉。
- **確認碼**：`XXXX-XXXX`，是 SHA-256(`"smurg-cli-login:" ‖ state`) 前 40 位元，用 `ABCDEFGHJKLMNPQRSTUVWXYZ23456789`
  編碼（`src/lib/validate.ts` 的 `cliConfirmCode`；測試向量在 `test/lib.test.ts`）。CLI 在終端機顯示同一組碼。它不是
  秘密（state 在網址裡），用途是讓人看出這個頁面屬於自己剛開始的那次登入。
- **不用 302 回到 127.0.0.1**（OWNER-01）：Chromium 會把送出表單那一頁的 CSP `form-action` 套用在之後每一次轉址上。
  開發用登入的表單在 relay 自己的頁面（`form-action 'self'`），GitHub / Google 的授權按鈕也是它們自己頁面上的表單，
  所以 302 到 `http://127.0.0.1:P` 會被瀏覽器擋下，CLI 永遠等不到回呼（Node 的 fetch 不執行 CSP，只有真的瀏覽器測得到：
  `test/cli-login.browser.test.ts`）。relay 改回應 200 的「繼續」頁（沒有 script、`no-referrer`、`no-store`），用 meta
  refresh 前往迴路網址，也顯示一個連結備用；確認頁之後前往 IdP 也是同樣的方式。

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

`wrangler.jsonc` 最上層是**正式環境**的值（workers.dev、Workers Free 方案、只用 Google 登入），`env.dev` 只放本機的值
（`vars`、`durable_objects`、`secrets` 不會被繼承，所以 `env.dev` 重複列出全部；本機另外可以用自己的 GitHub OAuth app）。

| 名稱 | 種類 | 正式環境 | 說明 |
|---|---|---|---|
| `RELAY_ISSUER` | var | 第一次部署前是 `""`，之後是 `https://smurg-relay.<子網域>.workers.dev`（`scripts/deploy-relay.sh` 寫入） | relay 的 origin：JWT 的 `iss`，也是 OAuth 回呼網址的前綴。只能是 https（本機可用 http），不能有路徑。空的或不正確時，除了 `/healthz` 與網頁之外所有 relay 路由都回 500 |
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

正式環境是**專案擁有者自己的 Cloudflare 帳號**上的一個 Worker（Workers **Free** 方案），網址是帳號的 workers.dev
子網域：`https://smurg-relay.<子網域>.workers.dev`，不需要自己的網域。登入只用 Google（擁有者自己建立的 OAuth
client）。網頁（`apps/web` 的建置結果）由同一個 Worker 提供，所以網頁、登入與 WebSocket 都在同一個 origin；
`preview_urls` 關閉（每個版本都會多一個公開網址，而且連到同一批 Durable Object）。

部署一律在 repo 根目錄用 `scripts/deploy-relay.sh`（它會 `source scripts/env.sh`），可以重複執行：

- 它**不會**執行 `wrangler login` 或 `wrangler secret put`，也不會讀取、顯示、寫入或傳遞任何 secret：需要時它印出指令，由你執行。
- wrangler 的登入資料留在 repo 的 `.xdg/`（`scripts/env.sh` 設定 `XDG_CONFIG_HOME`；`.xdg/` 在 `.gitignore` 裡），不會寫進家目錄。

### 第一次部署的順序

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
3. **第一次部署**：
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
7. 提交 `apps/relay/wrangler.jsonc`（網址與 client ID 都是公開資訊）。要讓 CLI 預設使用這個 relay：把
   `packages/cli/src/relay/default-relay.ts` 的 `DEFAULT_RELAY_URL` 改成這個網址（腳本會印出那一行）。

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
3. **建立 client**：APIs & Services → **Credentials → Create credentials → OAuth client ID**（新介面：**Clients → Create client**）：
   - Application type：**Web application**，名稱隨意（例如 `smurg relay`）。
   - **Authorized JavaScript origins**：`https://smurg-relay.<子網域>.workers.dev`
   - **Authorized redirect URIs**：`https://smurg-relay.<子網域>.workers.dev/auth/google/callback`
   - 按 **Create**。**Client ID** 是公開的，交給部署腳本的 `--google-client-id`；**Client secret** 是秘密，只在第 5 步貼進
     wrangler，不要放進任何檔案、聊天或 issue。
4. relay 以 state + nonce + PKCE 登入，並用 Google 的 JWKS 驗證 `id_token`（`iss` 接受 `https://accounts.google.com` 與
   `accounts.google.com`，`aud` 必須是自己的 client ID）。CLI 登入不需要另外註冊網址：relay 永遠只在自己的
   `/auth/google/callback` 接收回呼，再用自己的「繼續」頁把瀏覽器帶到 CLI 的 `http://127.0.0.1:<port>/callback`。

### `scripts/deploy-relay.sh` 做什麼

| 步驟 | 內容 |
|---|---|
| 1 | `wrangler whoami --json`：沒有登入就印出登入指令並停止（結束代碼 3）；有多個帳號而沒有 `CLOUDFLARE_ACCOUNT_ID` 時列出帳號並停止 |
| 2 | `wrangler secret list`：Worker 還不存在或沒有 `RELAY_SIGNING_KEY` 時，印出上面第 2 步的指令並停止（結束代碼 3） |
| 3 | 檢查 `wrangler.jsonc` 最上層：`workers_dev: true`、`preview_urls: false`、`DEV_LOGIN` `"0"`、`RELAY_TAP_URL` 空的、沒有 `GITHUB_*`、Google 的正式端點、`ALLOWED_ORIGINS` 等於 `RELAY_ISSUER`、`secrets.required`、兩個 SQLite Durable Object 與 migration、SPA assets 與 `run_worker_first`（`test/config.test.ts` 對提交的檔案做同樣的檢查） |
| 4 | `pnpm --filter @smurg/web build`，再執行 `scripts/check-web-dist.ts`：必須是真正的建置結果，有含 `frame-ancestors 'none'` 的 CSP `_headers`，不公開 `.vite/` |
| 5 | 網址：`--url`，否則 `wrangler.jsonc` 的 `RELAY_ISSUER`，否則先部署一次（issuer 空的，relay 關閉），從 wrangler 寫在 `WRANGLER_OUTPUT_FILE_PATH` 的部署結果（`{"type":"deploy","targets":[…]}`）得知。wrangler 沒有單獨印出帳號 workers.dev 子網域的指令：`wrangler whoami` 只列出帳號 |
| 6 | 把 `RELAY_ISSUER`、`ALLOWED_ORIGINS`（網址）與 `GOOGLE_CLIENT_ID`（`--google-client-id`）寫進 `wrangler.jsonc` 最上層的 `vars`：只改那幾行，註解與 `env.dev` 不動，寫入前重新解析比對 |
| 7 | `wrangler deploy --env ""`；部署結果的 workers.dev 網址必須等於 `RELAY_ISSUER`，不同時停止並說明（帳號的子網域改過） |
| 8 | 印出網址、Google 的 JavaScript origin 與 redirect URI，以及 CLI 的 `DEFAULT_RELAY_URL` 該填的那一行 |
| 9 | 再看一次 secret，印出缺少的那一個的指令 |
| 10 | 從外部檢查（新的 workers.dev 網址可能要幾分鐘才連得上，預設重試 180 秒，`--wait` 可改）：`/healthz`；`/api/login-options` 是 `google: true, github: false, dev: false`；`/.well-known/jwks.json` 有 Ed25519 公鑰而且沒有私鑰欄位；`/` 與 SPA 深層連結是網頁的 `index.html`，並帶有 `_headers` 的 `Content-Security-Policy`（`frame-ancestors 'none'`）、`X-Frame-Options: DENY`、`X-Content-Type-Options: nosniff`；`/auth/google/login` 轉到 Google，`redirect_uri` 是這個 relay 的 `/auth/google/callback`、`client_id` 是設定的那一個、cookie 是 `__Host-` 開頭而且 `Secure` |

**部署時設定的 vars**：不用 `--var`。正式環境執行的就是提交在 `wrangler.jsonc` 最上層的值；腳本只在部署前把
`RELAY_ISSUER`、`ALLOWED_ORIGINS`（第一次得知網址，或 `--url` 改變時）與 `GOOGLE_CLIENT_ID`（`--google-client-id`）寫進
那個檔案。唯一的例外是第一次、還不知道網址時的那次部署：它照檔案原樣使用空的 issuer（relay 關閉）。`keep_vars` 沒有開啟，
所以在 Cloudflare dashboard 手動改的 vars，下一次部署時會被 `wrangler.jsonc` 的值蓋掉。secret 不受部署影響。

其他模式與結束代碼：

```sh
scripts/deploy-relay.sh --dry-run [--url …] [--google-client-id …]   # 建置網頁、檢查設定、wrangler deploy --dry-run；完全不連 Cloudflare 帳號（不查登入與 secret）、不部署、不改檔案
scripts/deploy-relay.sh --check https://smurg-relay.<子網域>.workers.dev   # 只做第 10 步（預期 Google 登入已開啟）
```

0 完成（Google 還沒設定好時會印出接下來的步驟）、1 失敗、2 參數錯誤、3 需要你先做某件事（登入、選帳號、放入簽章金鑰）。

腳本的每一步在 `test/deploy-relay.test.ts` 裡對一個假的 wrangler（照 wrangler 4.142 原始碼的輸出格式回答）與設定成正式環境的
本機 relay 跑過完整流程；對真正的 Cloudflare 帳號從來沒有在開發環境執行過。

**每次部署都會中斷所有 WebSocket**（`docs/research/relay.md` gotcha 9）：主人、組員的網頁與 CLI 會自動重新連線，但正在進行的
傳輸要重來。只想確認狀態時用 `--check`，不要重新部署。

### 之後

- **更新 relay**：取得新程式後執行 `scripts/deploy-relay.sh`（網址與 client ID 已經在 `wrangler.jsonc` 裡）。
- **換簽章金鑰**：直接換掉會讓所有人的登入失效。要不影響登入，先把 `RELAY_SIGNING_KEY` 放成 `{"keys":[新私鑰, 舊公鑰]}`
  （見「設定」），7 天（session 期限）後再只放新私鑰。
- **換 Google client secret**：在 Google Cloud console 新增一個 secret，再執行第 5 步。
- **在自己的 Cloudflare 帳號架設**（學校、團隊）：`wrangler.jsonc` 裡是專案公用 relay 的網址與 client ID，所以第一次要
  指定自己的：`scripts/deploy-relay.sh --url https://smurg-relay.<你的子網域>.workers.dev --google-client-id <你的 client ID>`
  （第 1、2、4、5 步照做）。這個腳本部署的 relay 只用 Google 登入；要用 GitHub 登入得自己改 `wrangler.jsonc` 最上層的 vars，
  而腳本的檢查會拒絕（它只部署專案決定的 Google-only 設定）。
- **自己的網域**：這個腳本只部署 workers.dev。改用自己的網域時，`RELAY_ISSUER`、`ALLOWED_ORIGINS`、Google OAuth client 與 CLI 的
  預設 relay 都要一起改，已經登入的人要重新登入。

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
- 心跳（文字 `"ping"`）由 auto-response 回應，不計費。打字、終端機輸出、檔案傳輸的每一則訊息（送進 Durable Object 的方向，
  包括主人送給組員的）以 1/20 次請求計算：一個持續輸出的終端機一天就可能用掉數萬次。
- 網頁的靜態檔案不經過 Worker（`run_worker_first` 只列 relay 的路徑）；它們是否計入每天 100,000 次，這裡沒有驗證。

結論：Free 方案適合試用、上課示範與少數團隊。整天有多個工作區在用時會碰到上限，當天之後所有人都連不上，這時改用
Workers Paid 方案即可，程式與 `wrangler.jsonc` 都不用改（SQLite Durable Object 兩種方案都能用）。每天的用量可以在
Cloudflare dashboard 的 Workers & Pages → smurg-relay → Metrics 看到。

### 疑難排解

| 看到 | 原因與處理 |
|---|---|
| 「wrangler 還沒有登入 Cloudflare」 | 第 1 步。一定要先 `source scripts/env.sh`，登入資料才會放在 repo 的 `.xdg/`（腳本只看那裡） |
| 「這個帳號還沒有 smurg-relay 這個 Worker」、`required secrets have not been set: RELAY_SIGNING_KEY` | 第 2 步 |
| `You need to register a workers.dev subdomain` | 打開 wrangler 印出的 `https://dash.cloudflare.com/<帳號>/workers/onboarding` 選一個子網域，再執行一次 |
| `wrangler secret put` 或 `wrangler login` 在互動前就失敗 | 指令前面要加 `CI=false`（`scripts/env.sh` 設定了 `CI=true`） |
| `--check` 的 `/api/login-options` 是 HTTP 500 | `RELAY_ISSUER` 是空的，或 `RELAY_SIGNING_KEY` 不對：重新執行 `scripts/deploy-relay.sh` |
| `google=false` | 缺少 `GOOGLE_CLIENT_SECRET`（第 5 步）或 `GOOGLE_CLIENT_ID`（第 6 步） |
| Google 顯示 `redirect_uri_mismatch` | OAuth client 的 Authorized redirect URIs 必須剛好是 `https://smurg-relay.<子網域>.workers.dev/auth/google/callback` |
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
（`scripts/deploy-relay.sh` 會做）。建置結果還必須有 `_headers`（`/*` 規則的 Content-Security-Policy 含 `frame-ancestors 'none'`），
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
