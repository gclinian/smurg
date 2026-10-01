# @smurg/web

smurg 的網頁前端：React 19 + Vite 8 的單頁應用程式，正式環境由 relay Worker 以同一個 origin 提供。
規格見 `SPEC.md`（R1–R3、R7、R11、§9），約定見 `docs/ARCHITECTURE.md` §4、§9。

這份文件寫給**在這個外殼裡開發功能的工程師**：外殼、路由、連線層、stores、指令匯流排、字串、設計系統都已經就緒，
功能工程師只需要改 `src/features/<自己的功能>/**`，**不需要**動外殼、路由、stores、字串索引或 `package.json`。

- [本機執行整個系統](#本機執行整個系統)
- [目錄結構與擁有權](#目錄結構與擁有權)
- [路由與加入流程](#路由與加入流程)
- [連線層與連線狀態](#連線層與連線狀態)
- [Stores（每個領域一個）](#stores每個領域一個)
- [權限判斷（只用來隱藏 UI）](#權限判斷只用來隱藏-ui)
- [跨功能指令匯流排](#跨功能指令匯流排)
- [功能插槽（placeholder）](#功能插槽placeholder)
- [字串（zh-TW）](#字串zh-tw)
- [設計系統](#設計系統)
- [Monaco 與 xterm（延遲載入）](#monaco-與-xterm延遲載入)
- [測試](#測試)
- [建置與 chunk 大小](#建置與-chunk-大小)

---

## 本機執行整個系統

```sh
source scripts/env.sh                 # 每個新 shell 都要（Node 22、repo 內的 pnpm）
pnpm dev:relay                        # relay：http://127.0.0.1:8787（wrangler dev --env dev，DEV_LOGIN=1）
pnpm dev:web                          # 前端：http://localhost:5173，/auth /api /ws /xfer /.well-known /healthz 轉給 relay
```

1. 打開 **http://localhost:5173/**（一定要用 `localhost`，不要用 `127.0.0.1`：relay 的 cookie 是以主機名稱區分，而且
   `ALLOWED_ORIGINS` 只允許 `http://localhost:5173`）。
2. 首頁的登入區塊會出現「開發用登入」表單——**只有**在 relay 回報開發用登入可用時才會出現（`DEV_LOGIN=1` 而且主機名稱是本機；
   正式環境的網址永遠不會顯示，也不會去探測）。輸入帳號名稱（例如 `amy`）登入。
3. **主人分享資料夾**：最簡單的是 `scripts/dev-stack.sh`（在 repo 根目錄執行）：它一次啟動 relay、Vite 與
   `smurg host`（範例 git 專案，假的 HOME），並印出主人連結與邀請連結（http://localhost:5173/join/…），Ctrl-C 全部停止。
   手動的做法：`smurg login --relay http://localhost:8787 --dev-user host`，再執行
   `smurg host <資料夾> --relay http://localhost:8787 --web-origin http://localhost:5173`；終端機印出主人自己的連結與
   邀請連結 `http://localhost:5173/join/<workspaceId>#k=…&s=…`，組員用瀏覽器開啟邀請連結。
   組員改用 CLI 時：邀請連結指向網頁（:5173），CLI 則直接連 relay，而且登入是依網址分開記錄的，所以要先
   `smurg login --no-browser --dev-user amy --relay http://localhost:8787`，再
   `smurg attach --invite - --relay http://localhost:8787`（執行後貼上邀請連結）。`scripts/dev-stack.sh` 會印出這兩行。
4. 也可以直接用 CLI 的開發登入：`curl -X POST -H 'content-type: application/json' -d '{"user":"amy"}' http://localhost:8787/auth/dev/token`。

`SMURG_RELAY_DEV_ORIGIN` 可以把 Vite 的轉送目標改到其他埠（平行的 checkout）。

要顯示哪些登入方式，只問 relay 一次：`GET /api/login-options`（200，只有布林值：GitHub、Google 是否已設定，以及開發用登入
對這個主機名稱是否開啟；正式網址永遠是 false）。不再探測 `/auth/<p>/login` 或 `/auth/dev/start`。
未登入的瀏覽器載入 `/` 或 `/join/<id>` 時主控台沒有任何錯誤、沒有失敗的請求（`e2e/smoke/login.smoke.test.ts`）：relay 對
沒有 session 的 `/api/me` 仍回 401（SDK、CLI 和 relay 的測試依賴它），而瀏覽器一定會把 4xx 印成主控台錯誤，所以 app 只在
「可能有 session」時才問（`lib/relay/session-hint.ts`：這個瀏覽器開始過登入、看過已登入的回答，或連上過工作區；401 或登出就清掉。
記在一個只寫著 1 的 cookie `smurg_hint`，和 relay 的 session cookie 一樣以主機為範圍，所以同一主機的其他埠也看得到）。
這不是安全判斷：猜錯的代價最多是多按一次登入（例如只在 relay 自己的 CLI 登入頁登入過），或一次 401（session 過期）。

## 目錄結構與擁有權

```
src/
├── main.tsx                 進入點。第一個 import 是 boot/capture-invite.ts（不要在它上面加任何東西）
├── boot/capture-invite.ts   在任何程式執行前，把邀請片段存進 sessionStorage 並從網址列移除
├── app/                     外殼（web-foundation 擁有）：App、路由、頁面、workbench 版面、連線畫面
├── lib/                     共用邏輯（web-foundation 擁有）
│   ├── connection/          WorkspaceConnection 介面、狀態 → UI 對應、瀏覽器端相依（IndexedDB 金鑰）
│   ├── stores/              每個領域一個 store（見下）
│   ├── workspace/           WorkspaceSession（連線 + stores + 指令）、manager（每個工作區一條連線）、React hooks
│   ├── invite/              邀請片段的嚴格解析
│   ├── relay/               relay 登入（OAuth、開發用登入）
│   ├── commands.ts          跨功能指令匯流排
│   ├── capabilities.ts      權限判斷（只用來隱藏 UI）
│   ├── lazy.ts              loadMonaco() / loadXterm()
│   ├── monaco.ts xterm.ts   重量級模組（只能透過 lazy.ts 載入）
│   ├── presence-css.ts      y-monaco 遠端游標的 CSS
│   ├── drop.ts              拖放 → UploadSource（在 drop 事件裡同步呼叫）
│   └── format.ts errors.ts preferences.ts color.ts store.ts router.ts
├── features/<feature>/      ★ 功能工程師的範圍：index.tsx（插槽元件）+ strings.ts（字串 namespace）+ 其他檔案
├── strings/                 字串目錄（catalog.ts 的 defineStrings / t）
├── ui/                      設計系統：tokens.css、base.css、components.css、元件、圖示
└── testing/                 FakeConnection、fixtures、render helpers、vitest setup
```

**規則**：功能之間不互相 import（`features/a` 不 import `features/b`）；跨功能的動作一律走指令匯流排。
功能只透過 hooks 讀 stores，不自己建立連線或 store。需要外殼或 stores 的新 API 時，請在交接時提出。

## 路由與加入流程

| 路由 | 頁面 |
|---|---|
| `/` | 首頁：產品說明、登入（依 `GET /api/login-options` 只顯示 relay 已設定的 GitHub / Google；開發用登入只在 relay 回報可用時顯示）、最近開啟的工作區 |
| `/join/:workspaceId` | 接受邀請（見下） |
| `/w/:workspaceId` | workbench（延遲載入的 chunk） |
| `/w/:workspaceId/console` | 主人控制台（同一個 chunk；非主人會看到說明） |

路由器是 `lib/router.ts`（History API，封閉的 `Route` union）。站內連結用 `app/navigation.tsx` 的 `<Link to>`、
`useNavigate()`、`useRoute()`。

**加入流程（ARCHITECTURE §4.1）**，實作在 `boot/capture-invite.ts` 與 `app/pages/JoinPage.tsx`：

1. `main.tsx` 的第一個 import 在任何其他模組執行之前，把 `#k=…&s=…` 複製到 sessionStorage（每個分頁各自一份，
   關閉分頁就消失，同分頁的登入轉址後仍在），並用 `history.replaceState` 從網址列移除——早於 OAuth 轉址。
   其他路徑上的片段也一律移除。
2. 用 `@smurg/protocol` 的 `parseInviteFragment` **嚴格**解析（剛好 `k`、`s` 各一次，43 字元標準 base64url）；
   格式不對就拒絕，不「修正」。
3. 需要時登入（`return_to` 是不含片段的絕對網址）。
4. **等使用者按「加入」**（review SEC-E-02）：頁面顯示工作區代碼、以哪個身分加入、加入後主人會看到什麼；按下之前
   不建立任何連線。任何網頁都能把已登入的訪客導到一個邀請連結，所以絕不在載入頁面時自動加入。
   （邀請連結整段網址在開啟時就已寫進瀏覽器的全域歷史紀錄，`replaceState` 無法移除，見 `boot/capture-invite.ts`。）
5. 用 invite 模式連線。SDK 在 msg2 用 `k` 驗證 daemon 金鑰，並在送出 msg3 **之前**把金鑰 pin 進 IndexedDB。
   若這個瀏覽器已經 pin 了**不同的**金鑰，頁面會先要求使用者確認「已透過其他管道向主人確認新連結」，確認後才以
   `preferInvite` 連線（新的金鑰取代舊的 pin）；絕不默默接受新金鑰。
6. 連線成功後刪除 sessionStorage 裡的邀請，進入 `/w/:workspaceId`——**沿用同一條連線**（manager 保證每個工作區只有一條）。

## 連線層與連線狀態

`lib/connection/types.ts` 的 `WorkspaceConnection` 是 app 使用的 SDK `Connection` 子集；正式環境是
`@smurg/protocol/client` 的 `Connection`，測試用 `src/testing/fake-connection.ts` 的 `FakeConnection`。

`lib/workspace/manager.ts` 保證**每個工作區一條連線**：加入頁、workspace 頁、控制台都 `acquire()` 同一個
`WorkspaceSession`（連線 + stores + 指令匯流排）；最後一個頁面離開 15 秒後才關閉。「離開」走 `manager.leave()`
（`channel.leave`，然後關閉）。

裝置金鑰與 pin 存在 IndexedDB（`@smurg/protocol/browser` 的 device-key-v2：可以時用不可匯出的 X25519 CryptoKeyPair，
WebKit 用 AES 包裝）。**「不可匯出」只代表網頁程式無法匯出金鑰，不是磁碟加密**，不要在 UI 或文件裡這樣描述。
IndexedDB 不能用時（部分私密視窗）改存記憶體並在 workbench 顯示橫幅。

狀態 → UI 的對應在 `lib/connection/status.ts`（`describeConnection`），全部有測試：

| SDK 狀態 | UI | 阻擋整個畫面？ |
|---|---|---|
| `idle` / `connecting` | 「連線中…」 | 否（第一次連線前顯示連線畫面） |
| `connecting` + `retryAt` | 「重新連線中…」＋原因＋倒數 | 否 |
| `connecting{cause:'role-changed'}` | 「角色已變更」，重新連線後出現 toast | 否 |
| `handshaking` | 「建立加密連線中…」 | 否 |
| `online` | 「已連線」 | 否 |
| `host-offline` | **「主人已離線」**常駐橫幅（relay 回報 / 8 秒無回應 / 停止分享），UI 照常可操作 | 否 |
| `relay-unreachable` | 「無法連上伺服器」，**和主人離線不同的訊息**，含倒數 | 否 |
| `key-mismatch` | **全畫面安全警告**（SPEC R3.2）：relay 給的主人金鑰不同、連線已拒絕、請透過其他管道向主人索取新連結；沒有「仍要重試」 | 是 |
| `rejected(…)`、`closed(kicked/revoked/no-trust/…)` | 各自的說明畫面 | 是 |
| `closed(login-required)` | 登入畫面，登入後回到原頁 | 是 |

穩定的測試掛鉤（給 Playwright / e2e）：`data-testid="key-mismatch-screen"`（`role="alertdialog"`）、
`data-testid="host-offline-banner"`、`data-testid="relay-unreachable-banner"`、`data-testid="connection-ended-screen"`、
`data-testid="login-required-screen"`、`data-testid="connecting-screen"`，以及 workbench 根元素的
`data-connection-state="<SDK 狀態>"`。

## Stores（每個領域一個）

所有 store 由 `createWorkspaceStores(conn)` 一起建立並由同一條連線餵資料（`lib/stores/index.ts`）：

- 第一次、以及每次 **非 resume** 的 Welcome：每個 store 先 `reset()` 再載入新的快照；
- resume 的 Welcome：什麼都不重新載入（daemon 會補送漏掉的事件）；
- 角色變更（Welcome 或 `channel.memberUpdated`）會通知依角色而定的 store（admin、docs）；
- 來自舊邏輯通道的回應一律丟棄（generation 檢查）；載入失敗會留在 store 的 `error`（zh-TW）並以 toast 顯示。

在元件裡：

```tsx
import { useStore } from '../../lib/store.ts';
import { useStores } from '../../lib/workspace/context.tsx';

const { sessions } = useStores();
const list = useStore(sessions, selectSessionList, shallowEqual);   // selector；回傳新陣列時傳 shallowEqual
```

每個 store 都是 `ReadableStore<State>`（`getState()`、`subscribe()`）加上動作（會呼叫 `connection.request(…)`）。
以下每個 store 一個範例（完整型別與註解在各檔案）。

**connection** — `ReadableStore<ConnectionState>`

```tsx
const state = useConnectionState();            // 等同 useStore(useStores().connection)
if (state.kind === 'host-offline') …
```

**workspace**（`workspace.ts`）— 工作區資訊、自己的成員資料、公開設定；即時更新 `channel.memberUpdated` / `channel.settingsUpdated`

```tsx
const info = useWorkspaceInfo();               // { id, name, hostName, platform, isGitRepo }
const settings = useStore(useStores().workspace, selectSettings);   // humanLockIdleMs, uploadChunkSize, sharedDirs…
const generation = useStore(useStores().workspace, (s) => s.generation);   // 每次完整重新同步 +1
```

**presence**（`presence.ts`）— 線上成員與 agent（`presence.state`），回報自己正在看的檔案

```tsx
const { presence } = useStores();
const viewers = useStore(presence, (s) => selectViewersOf(s, file), shallowEqual);
presence.setActiveFile(file);                  // docs store 在切換分頁時會自動呼叫
```

**files**（`files.ts`）— 每個根目錄（主工作區或 worktree）一棵樹，逐層 `file.tree`；`file.changed` 會合併後重新列出受影響的目錄

```tsx
const { files } = useStores();
const root = useStore(files, selectActiveRoot);
const listing = useStore(files, (s) => selectDir(s, root, 'src'));   // { status, entries, truncated, error }
await files.loadDir(root, 'src');              // 展開資料夾；收合時 files.forgetDir(root, 'src')
files.setActiveRoot({ kind: 'worktree', worktreeId });
await files.create({ root, path: 'src/new.ts' }, 'file');   // 也有 rename / delete / stat / read / write
```

**locks**（`locks.ts`）— 檔案鎖（人的編輯鎖、agent 鎖），`lock.state` 即時更新

```tsx
const lock = useStore(useStores().locks, (s) => selectLock(s, file));
if (lock?.kind === 'agent') …                  // 「Claude（Ian）正在修改」
await locks.release(file);                     // 「讓 agent 先改」；主人：locks.forceRelease(file)
```

**docs**（`docs.ts`）— 開啟中文件的登錄表（分頁順序、目前分頁），處理 `doc.*` 控制訊息並轉送 Yjs 流量

```tsx
const doc = await docs.open(file);             // doc.open；已開啟就切換過去
const off = docs.onDocMessages(doc.docId!, { sync: (data) => …, awareness: (data) => … });  // 之前收到的會先補送
docs.sendSync(docId, update);                  // y-protocols 同步訊息
const editable = isDocEditable(useStore(docs, selectActiveDoc));   // agent 鎖時為 false
// 重要：OpenDoc.generation 改變（重新同步後重新開啟，或 doc.reset）時要重新綁定；epoch 改變時要丟掉 Y.Doc 重來。
```

**sessions**（`sessions.ts`）— agent session 與終端機清單（`session.list` + `session.state`），以及終端機串流

```tsx
const mine = useStore(sessions, (s) => selectSessionsOf(s, userId), shallowEqual);
const off = sessions.stream(id, { output: (chunk) => viewer.write(chunk.data), resize: ({ cols, rows }) => viewer.resize(cols, rows) });
const attached = await sessions.attach({ sessionId: id, haveOffset, cols, rows });   // 先 stream 再 attach
sessions.input(id, bytes);                     // 主人與「可使用 agent」（session.drive，任何 session）；resize 只從開啟的人的面板送；end / loginStatus / create
```

**suggestions**（`suggestions.ts`）— 建議（R6）；沒有自動採用

```tsx
const waiting = useStore(suggestions, (s) => selectPendingForOwner(s, sessionMap, userId), shallowEqual);
await suggestions.create({ sessionId, text, source: { file, startLine, endLine } });
await suggestions.accept(id, editedText);      // 有 text 就是「修改後採用」；reject / edit / withdraw
```

**activity**（`activity.ts`）— 活動動態（新的在前）與 agent 發給自己的通知（`activity.notify`）

```tsx
const events = useStore(activity, selectActivityEvents);
await activity.loadOlder();                    // 往前翻頁
const notes = useStore(activity, selectNotifications);   // workbench 也會把新通知顯示成 toast
```

**conflicts**（`conflicts.ts`）— 衝突面板（`doc.conflict`）

```tsx
const open = useStore(conflicts, selectOpenConflicts, shallowEqual);
const { agentVersion } = await conflicts.get(id);   // agent 的完整版本（bytes）
await conflicts.resolve(id, 'dismiss');        // 或 'apply-agent-version'
```

**worktrees**（`worktrees.ts`）— worktree 與合併請求（R9）

```tsx
const list = useStore(worktrees, selectWorktreeList, shallowEqual);
const request = await worktrees.requestMerge(worktreeId, '完成登入頁');
const { diff, truncated, files } = await worktrees.diff(request.id);   // truncated 的檔案用 fileDiff 看完整內容
await worktrees.approve(request.id);           // 主人；reject(id, reason)
```

**admin**（`admin.ts`）— 主人控制台資料；只有主人（`admin`）才會載入

```tsx
const { members, invites, audit, settings, enabled } = useStore(useStores().admin);
const { url } = await admin.createInvite({ role: 'editor', expiresInSec: 86_400, maxUses: 5 });   // url 只顯示一次，不要記錄
await admin.kick(userId);                      // setRole / revokeInvite / terminateSession / loadOlderAudit / setSettings
```

**transfers**（`transfers.ts`）— 上傳與下載的進度。**不是**由互動連線餵的：傳輸功能在自己的 TransferConnection（Web Worker）
上執行，把進度回報到這裡，讓檔案樹與面板顯示

```ts
const job = transfers.add({ id, kind: 'upload', name: 'data.zip', root, path: 'data/data.zip', totalBytes, files: 1 }, () => worker.abort(id));
transfers.update(id, { status: 'running', doneBytes });   // 'done' / 'failed'（附 error）/ 'cancelled'
transfers.cancel(id);                          // 呼叫註冊的取消函式
```

**errors** — 背景失敗（載入失敗等）的清單，workbench 會顯示成 toast；功能通常不需要讀它。

## 權限判斷（只用來隱藏 UI）

建立在 `@smurg/protocol` 唯一的角色矩陣上（`can()`），**從不比較角色大小**（SPEC §8 不是單調的）。
隱藏按鈕只是外觀；daemon 會檢查每一個請求。

```tsx
const canWrite = useCan('file.write');
const caps = useCapabilities();                // caps.can('admin'), caps.canCreateSession, caps.canDrive, caps.isHost, caps.role
drivesSession(caps, session);                  // 可以在這個 session 裡輸入、處理它的建議（主人與「可使用 agent」，任何執行中的 session）
isRiskyRole(role);                             // 給出這個角色前，控制台要主人確認風險（「可使用 agent」）
<Can capability="suggest.create" fallback={null}><SuggestButton /></Can>
```

## 跨功能指令匯流排

`lib/commands.ts`。每個指令只有一個處理者（擁有該行為的功能），可以有多個觀察者。

| 指令 | payload | 處理者 |
|---|---|---|
| `openFile` | `{ file, line?, column? }` | editor |
| `sendSelectionAsSuggestion` | `{ file, startLine, endLine, text, sessionId? }` | suggest |
| `focusSession` | `{ sessionId }` | agents |
| `startUpload` | `{ root, targetDir, source: UploadSource }` | transfer |
| `download` | `{ file, zip? }` | transfer |
| `revealFile` | `{ file }` | files |
| `showPanel` | `{ panel }` | workbench 外殼（已實作） |

```tsx
// editor 功能：
useCommandHandler('openFile', async ({ file, line }) => { await docs.open(file); /* 捲到 line */ });
// 其他任何地方：
const openFile = useCommand('openFile');
await openFile({ file, line: 42 });            // 沒有處理者時會 reject NoCommandHandlerError
```

拖放上傳：在 `drop` 事件裡**同步**呼叫 `collectDrop(event.dataTransfer)`（`lib/drop.ts`），再 dispatch `startUpload`。

## 功能插槽（placeholder）

workbench（`app/workspace/Workbench.tsx`）把下列元件放在固定位置，每個都包在自己的 error boundary 裡。
功能工程師**只替換元件內容**，保留匯出名稱與 props（目前都沒有 props，資料一律從 hooks 取得）。

| 檔案 | 匯出 | 位置 |
|---|---|---|
| `features/files/index.tsx` | `FilesPanel` | 左側欄（WorktreeSwitcher 下方） |
| `features/worktree/index.tsx` | `WorktreeSwitcher`、`MergeRequestsPanel` | 左側欄頂端；下方抽屜「合併請求」分頁 |
| `features/editor/index.tsx` | `EditorArea` | 中央（分頁由 editor 自己畫） |
| `features/agents/index.tsx` | `AgentsPanel` | 右側上方 |
| `features/suggest/index.tsx` | `SuggestionsPanel` | 右側下方 |
| `features/activity/index.tsx` | `ActivityPanel`、`ConflictsPanel` | 下方抽屜「活動」「衝突」分頁 |
| `features/transfer/index.tsx` | `TransfersPanel` | 下方抽屜「傳輸」分頁 |
| `features/console/index.tsx` | `HostConsolePage` | `/w/:id/console`（只有主人會看到） |

版面（側欄、右側、抽屜的顯示與大小）由外殼負責並記在瀏覽器裡；要把某個面板帶到前面，dispatch `showPanel`。

## 字串（zh-TW）

所有使用者看得到的字都在字串目錄裡。每個功能在**自己的** `features/<feature>/strings.ts` 定義 namespace
（已經建立好），`src/strings/index.ts` 用 `import.meta.glob` 依慣例自動載入，**不需要改任何索引**：

```ts
// src/features/files/strings.ts（只能 import catalog.ts）
import { defineStrings } from '../../strings/catalog.ts';
export const t = defineStrings('files', {
  empty: '這個資料夾是空的',
  uploading: '正在上傳 {name}（{percent}%）',
});

// 元件裡
import { t } from './strings.ts';
t('uploading', { name, percent });             // key 有型別檢查
```

aria-label 也要用 zh-TW。測試會檢查每個字串都是繁體中文（允許 `agent`、`worktree`、`session` 這類 SPEC 本身使用的外來語）。

## 設計系統

`src/ui/`：`tokens.css`（CSS 自訂屬性）、`base.css`、`components.css`、元件與圖示。從 `src/ui/index.ts` 匯入。

- **主題**：預設深色；作業系統偏好淺色時自動切換；使用者可在選單選擇（`<html data-theme>`）。
- **色彩**：`--color-bg`、`--color-surface-1..3`、`--color-border(-strong)`、`--color-text(-muted/-subtle)`、
  `--color-accent(-solid)`、`--color-success|warning|danger|info(-soft)`。兩個主題的文字對比都 ≥ 4.5:1（有測試）。
- **字型**：`--font-sans`（系統 UI 字型 + PingFang TC / Noto Sans TC / Microsoft JhengHei）、`--font-mono`（程式碼與終端機）。
- **間距**：`--space-1`（2px）…`--space-10`（48px），4px 格線；圓角 `--radius-sm|md|lg`；層級 `--z-*`。
- **元件**：`Button`、`IconButton`（必填 zh-TW `label`）、`Input`、`TextArea`、`Select`、`Dialog`（焦點陷阱、Esc、焦點歸還）、
  `Drawer`、`Tabs`（方向鍵、Home/End）、`Tooltip`、`Badge`、`Avatar`（名字 + 顏色，自動選可讀的字色）、`Banner`、
  `ToastProvider`/`useToast`、`Spinner`、`EmptyState`、`Table`、`SplitPane`（鍵盤可調整大小）、`Menu`、`Panel`、
  `CopyButton`、`Kbd`，以及 `icons.tsx` 的內嵌 SVG 圖示（不要用 emoji 當圖示）。
- 風格：冷靜、資訊密集的工作台（像程式編輯器，不是行銷頁）。不要裝飾性漸層；焦點框永遠可見；一切都要能用鍵盤操作。

## Monaco 與 xterm（延遲載入）

Monaco（約 3.8 MB）與 xterm 只能透過 `src/lib/lazy.ts` 載入：

```ts
const { createEditor, createSmurgModel, monaco, monacoThemeFor } = await loadMonaco();
const { createViewerTerminal } = await loadXterm();
```

**絕對不要**直接 `import` `lib/monaco.ts` 或 `lib/xterm.ts`：`pnpm build` 的 `scripts/check-chunks.ts` 會在它們進入
初始載入時讓建置失敗。

- `lib/monaco.ts`（yjs-monaco.md Q2 驗證過的設定）：0.56+ 的精簡進入點、編輯器 worker（`?worker`）、
  `unicodeHighlight` 允許 zh-hant/zh-hans、`unusualLineTerminators: 'off'`、唯讀起始（第一次同步後才綁定 y-monaco）、
  `createSmurgModel()` 強制 LF。y-monaco 的 deep import 由 `vite.config.ts` 的 alias 對應到同一個 Monaco。
  遠端游標樣式用 `lib/presence-css.ts`。
- `lib/xterm.ts`（pty-packaging.md §6.2 驗證過）：`createViewerTerminal()` 註冊**完整**的查詢攔截
  （DA1/DA2/DA3、DSR/CPR/DECXCPR、DECRQM、DECRQSS、XTWINOPS 回報、OSC 4/10/11/12 查詢；有測試），
  依串流順序套用 resize，快照先 reset 再畫。附帶 web-links、unicode11 addon（fit addon 不再使用：`@xterm/addon-fit`
  仍在 package.json，可在下次調整相依時移除）。
- 終端機大小（review LEAD-01，`features/agents/terminal-fit.ts`）：**開啟 session 的人**（擁有者）的面板決定 PTY 大小（主人和
  「可使用 agent」的成員都可以在任何 session 裡輸入，但大小只跟著擁有者，面板之間不會互相搶）——欄和列都依可見區域計算
  （`viewer.ts` 的 `measureTerminal` 量面板，`planOwnerSize` 算大小），隨 `session.attach` 送出，之後面板大小改變、窗格或
  抽屜開關、字型載入完成、分頁重新可見時（150 ms debounce）送 `exec.resize`；daemon 的 `exec.resize` 依串流順序套用。
  下限：Claude Code（agent）80 × 24（pty-packaging.md F16/F17 驗證的大小）、一般終端機只有 daemon 的 20 × 5。面板比下限小時終端機維持下限、面板可捲動，上方一行提示說明（`data-testid="terminal-size-hint"`），不會默默裁掉。
  其他人（以及擁有者另一個不在主導大小的視窗）以 PTY 的大小顯示，比面板大時兩個方向都可捲動、捲軸一直看得到，
  「縮放以符合寬度」只縮小畫面、不重新排列。viewport 帶 `data-cols`/`data-rows`（實際大小）、`data-fit-cols`/`data-fit-rows`
  （這個面板放得下的大小）、`data-driving`，給測試用。

### 角色、session 與活動動態（as built，協定 v2，主人決定 2026-10-01）

- **沒有客人沙盒，也沒有客人自己的 agent**：每個 session 都在主人的電腦上、以主人的身分、用主人的 Claude 帳號執行。
  主人和「可使用 agent」（角色 `agent`）的成員可以開 session（`session.create`：主工作區、新的 worktree 或自己保留的
  worktree），也可以在**任何** session 裡直接輸入、採用或拒絕建議（`session.drive`）；「可編輯」只能提出建議；「旁觀」只能看。
  主人可以終止任何 session；開啟的人可以結束自己開的。
- **新增 session**（`features/agents/new-session.ts`、`NewSessionDialog.tsx`）：主人與「可使用 agent」看到同樣的選項，
  一行說明 session 在主人的電腦上、用主人的 Claude 帳號執行（`data-testid="new-session-runs-as"`）。沒有 API key、
  沒有沙盒說明、沒有登入程序。
- **session 面板**：分頁標示「{名稱}（{開啟的人} 開的）」（`plainSessionTitle` 會去掉 daemon 預設標題裡的「（Amy）」）；
  不能輸入的人看到「只能觀看」，詳細資訊裡告訴「可編輯」怎麼提建議。agent 沒有登入時（那是主人的 Claude 登入）主人看到
  「在終端機輸入 /login」，其他人看到請主人登入；可以輸入的人可以「重新檢查登入狀態」（`session.loginStatus`）。
- **建議**：可以輸入的人（主人、「可使用 agent」）看到焦點 session 的建議佇列；「可編輯」看到建議輸入框；通知不指名是誰
  採用或拒絕（`Suggestion` 沒有這個欄位）。編輯器的「送到 agent」：可以輸入的人直接貼進任何 agent session，「可編輯」提出建議。
- **控制台**：角色清單是「可使用 agent／可編輯／旁觀」。選「可使用 agent」建立邀請或變更成員角色時，先顯示風險的確認對話框
  （`features/console/RoleRiskDialog.tsx`，`data-testid="role-risk-text"`），主人按「我了解…」後才送出；取消就什麼都不送。
  拿掉成員的「可使用 agent」時，若他開的 session 還在執行，也會先確認（那些 session 會結束）。設定裡沒有沙盒網域。
- **活動動態**：agent 透過 shell 指令造成的修改（daemon 判斷後是 `agent.edit`，actor 是那個 agent，帶 `via: 'bash'`，
  ARCHITECTURE §5.4、§11 D-13）顯示為那個 agent 的修改，旁邊有小小的「透過指令」標記；標記只看 `via` 欄位，不看摘要的文字。
  「外部程式」只在 daemon 這樣說時出現（`system` actor）。

## 測試

```sh
pnpm --filter @smurg/web test                                       # 全部（jsdom + 真的瀏覽器驗收測試）
pnpm --filter @smurg/web exec vitest run src/features/files         # 只跑某個功能
pnpm --filter @smurg/web exec vitest run e2e --silent=false         # 只跑真的瀏覽器驗收測試（印出實測時間）
pnpm exec vitest run --project @smurg/web-smoke                     # 在 repo 根目錄：建置後的正式版網頁（由真的 relay 提供）
```

`e2e/smoke/` 是獨立的 vitest project：globalSetup 先把網頁建置一次（`vite build` + `scripts/check-chunks.ts`，輸出在該
project 的暫存目錄，不動 `dist/`），再由真的 relay（`startLocalRelay({ webDist })`，和正式環境一樣由 Worker 提供靜態檔）
提供，daemon 組合所有模組，用系統的 Chrome（無頭、全新 context、開發用登入；不隱藏捲軸，終端機的測試要量捲軸）走完。
共用的 harness 在 `e2e/smoke/helpers.ts`（`startSmoke`、`joinAs`、`joinAsHost`：主人自己的連結由
`daemon.internals.invites.createHostInvite()` 產生、`openSession`、終端機文字）。每個步驟都等條件，不等固定時間。

| 檔案 | 驗收標準 |
|---|---|
| `built-app.smoke.test.ts` | 邀請連結加入 → 開檔 → 輸入 → 磁碟、R7.1b 兩個瀏覽器同時編輯、R8.2b agent 鎖定的唯讀提示、「可使用 agent」開終端機（以主人的使用者執行）、CSP |
| `terminal.smoke.test.ts` | LEAD-01：擁有者的 PTY 跟著面板（窄的 420 px 與寬的面板，`stty size` 等於面板放得下的大小，終端機沒有任何部分落在可見、可捲動的容器外）；觀看者以 PTY 大小顯示，80 欄的整行可以捲動看到，「縮放以符合寬度」 |
| `login.smoke.test.ts` | 未登入載入 `/`、`/join/<id>`：零主控台錯誤、零失敗請求；CLI 的裝置代碼登入 |
| `acceptance.smoke.test.ts` | R11.1c 控制台一鍵終止與踢人、R6 建議（修改後採用、拒絕、提出者看到結果）、R9 worktree 合併（完整 diff、合併、拒絕後 worktree 不變）、R8.4 真的衝突出現在衝突面板；「可使用 agent」的成員開自己的 session（以主人的使用者執行）並直接在主人的 session 裡輸入、採用「可編輯」的建議；控制台給出「可使用 agent」前的風險確認（邀請與變更角色） |
| `transfer-resume.smoke.test.ts` | R7.3：透過 `drop-proxy.ts`（relay 前的 TCP proxy）在上傳一半時切斷傳輸 socket，上傳自己續傳完成、內容相同、只補送沒到的部分 |

沒有系統 Chrome 時會跳過並印出原因。

`src/testing/`：

- `FakeConnection`：手動驅動的連線。`conn.admit(makeWelcome({ role }))`、`conn.emit('session.state', …)`、
  `conn.handle('file.tree', () => …)`（自動回應）、`conn.respond(type, result)` / `conn.fail(type, error)`（回應最早的待處理請求）、
  `conn.requestsOf(type)`、`conn.notificationsOf(type)`、`conn.hostOffline()`、`conn.keyMismatch()`、`conn.kicked()`…
  送出與收到的 payload 都用 protocol registry 驗證，fixture 不會偏離真實格式。
- `renderInWorkspace(<FilesPanel />, { role: 'editor' })`：在一個以 FakeConnection 驅動的工作區裡 render，回傳 `{ conn, stores, session }`。
- `createTestServices()` / `renderApp()`：整個 App（記憶體路由、假的登入、記憶體 pin store）。
- `fixtures.ts`：`makeWelcome`、`makeSession`、`makeEntry`、`makeSuggestion`、`makeConflict`、`makeInvite`…
- `createManualScheduler()`：手動推進 store 的計時器（例如 `file.changed` 的合併延遲）。

```tsx
const { conn } = renderInWorkspace(<FilesPanel />);
conn.respond('file.tree', { entries: [makeEntry('README.md')], truncated: false });
expect(await screen.findByText('README.md')).toBeTruthy();
```

驗收測試（名稱引用 SPEC 的驗收標準）：

- `e2e/browser.e2e.test.ts`（**真的瀏覽器**）：真的 relay（本機 workerd）+ 真的 daemon（`tests/e2e` 的 harness）+
  這個 app（Vite dev server，和上面的開發方式相同）+ 系統的 Chrome（playwright-core、headless、全新的 context、
  沒有匯入任何 cookie）。涵蓋：用真的邀請連結加入（片段在登入轉址前就離開網址列、請求中不含祕密、pin 存進 IndexedDB）、
  「主人斷線後 10 秒內，所有客人的介面顯示離線」（實測約 4.3 秒）、以及「relay 把 daemon 公鑰替換成自己的公鑰時，
  客戶端拒絕連線並顯示警告」（首次加入與已 pin 金鑰後重新連線兩種，攻擊者用 `tests/e2e/src/mitm-relay.ts`；
  msg3 從未送出、邀請沒有被使用）。沒有安裝 Chrome 的機器會自動略過。約 15 秒。
- `app/workspace/connection-states.test.tsx`：每個連線狀態的畫面（jsdom，以 FakeConnection 驅動）。
- `app/pages/JoinPage.test.tsx`：加入流程的每個分支。

這個 vitest project 的暫存目錄（本機 relay 的 miniflare 狀態等）由 `e2e/global-setup.ts` 建立並在結束後刪除。
`e2e/` 不在 `tsc` 的範圍內（它 import `tests/e2e` 與 `apps/relay` 的原始碼，和這裡的 DOM lib 設定衝突），由 vitest 去除型別。

## 建置與 chunk 大小

```sh
pnpm --filter @smurg/web build                # vite build + scripts/check-chunks.ts
```

2026-09-29（finish-web 之後）：初始載入 2 個 chunk，628.6 KiB（194.9 KiB gzip；之前 625.0 KiB / 193.8 KiB gzip，
增加的是新字串），包含 React、protocol（zod、noble 密碼學、msgpack）、字串與加入流程；workspace chunk 298 KiB（84 KiB gzip）。
Monaco chunk 約 3.8 MiB（971 KiB gzip）＋ editor worker ＋ CSS ＋ codicon，xterm chunk 352 KiB（91 KiB gzip），
全部都在延遲載入的 chunk 裡。
