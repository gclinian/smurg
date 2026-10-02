# @smurg/web

The web front end of smurg: a single-page application built with React 19 and Vite 8. In production the relay Worker
serves it from the same origin. The specification is `SPEC.md` (R1–R3, R7, R11, §9); the conventions are in
`docs/ARCHITECTURE.md` §4 and §9.

This document is for **engineers who build features inside this shell**. The shell, the routes, the connection layer,
the stores, the command bus, the strings and the design system are in place. To build a feature you only change
`src/features/<your feature>/**`. You do **not** need to touch the shell, the routes, the stores, the string index or
`package.json`.

- [Run the whole system locally](#run-the-whole-system-locally)
- [Directory layout and ownership](#directory-layout-and-ownership)
- [Routes and the join flow](#routes-and-the-join-flow)
- [Connection layer and connection states](#connection-layer-and-connection-states)
- [Stores (one per domain)](#stores-one-per-domain)
- [Capability checks (only to hide UI)](#capability-checks-only-to-hide-ui)
- [Cross-feature command bus](#cross-feature-command-bus)
- [Feature slots](#feature-slots)
- [Strings and languages](#strings-and-languages)
- [Design system](#design-system)
- [Monaco and xterm (lazy loaded)](#monaco-and-xterm-lazy-loaded)
- [Tests](#tests)
- [Build and chunk sizes](#build-and-chunk-sizes)

---

## Run the whole system locally

```sh
source scripts/env.sh                 # in every new shell (Node 22, the pnpm inside the repo)
pnpm dev:relay                        # relay: http://127.0.0.1:8787 (wrangler dev --env dev, DEV_LOGIN=1)
pnpm dev:web                          # front end: http://localhost:5173; /auth /api /ws /xfer /.well-known /healthz are proxied to the relay
```

1. Open **http://localhost:5173/**. Always use `localhost`, not `127.0.0.1`: the relay's cookies are scoped by host
   name, and `ALLOWED_ORIGINS` only allows `http://localhost:5173`.
2. The login block of the landing page shows the "Development login" form. It appears **only** when the relay
   reports that the development login is available (`DEV_LOGIN=1` and a local host name). A production address never
   shows it and never probes for it. Type an account name (for example `amy`) to log in.
3. **The host shares a folder.** The simplest way is `scripts/dev-stack.sh` (run it in the repo root). It starts the
   relay, Vite and `smurg host` (a sample git project, a fake HOME) in one go, prints the host's link and the invite
   link (http://localhost:5173/join/…), and Ctrl-C stops everything.
   By hand: `smurg login --relay http://localhost:8787 --dev-user host`, then
   `smurg host <folder> --relay http://localhost:8787 --web-origin http://localhost:5173`. The terminal prints the
   host's own link and the invite link `http://localhost:5173/join/<workspaceId>#k=…&s=…`. Teammates open the invite
   link in a browser.
   When a teammate uses the CLI instead: the invite link points at the web app (:5173), the CLI connects to the relay
   directly, and logins are recorded per address. So first run
   `smurg login --no-browser --dev-user amy --relay http://localhost:8787`, then
   `smurg attach --invite - --relay http://localhost:8787` (paste the invite link after it starts).
   `scripts/dev-stack.sh` prints these two lines.
4. You can also use the CLI's development login directly:
   `curl -X POST -H 'content-type: application/json' -d '{"user":"amy"}' http://localhost:8787/auth/dev/token`.

`SMURG_RELAY_DEV_ORIGIN` points Vite's proxy at another port (a parallel checkout).

The app asks the relay only once which login methods to show: `GET /api/login-options` (200, booleans only: whether
GitHub and Google are configured, and whether the development login is on for this host name; always false on a
production address). It no longer probes `/auth/<p>/login` or `/auth/dev/start`.
A browser that is not logged in loads `/` or `/join/<id>` with no console error and no failed request
(`e2e/smoke/login.smoke.test.ts`). The relay still answers 401 to `/api/me` without a session (the SDK, the CLI and the
relay's tests depend on it), and a browser always prints a 4xx as a console error, so the app only asks when a session
is likely (`lib/relay/session-hint.ts`: this browser started a login, saw a logged-in answer, or connected to a
workspace; a 401 or a logout clears it. The hint is a cookie `smurg_hint` that holds only `1`, scoped by host like
the relay's session cookie, so other ports of the same host see it too).
This is not a security decision. A wrong guess costs at most one more click on login (for example when you only
logged in on the relay's own CLI login page) or one 401 (an expired session).

## Directory layout and ownership

```
src/
├── main.tsx                 Entry point. The first import is boot/capture-invite.ts (put nothing above it);
│                            the second is boot/locale.ts
├── boot/capture-invite.ts   Before any other code runs: stores the invite fragment in sessionStorage and removes it from the address bar
├── boot/locale.ts           Resolves the language of this browser and sets <html lang>, before the strings and any component
├── app/                     The shell (owned by web-foundation): App, routes, pages, workbench layout, connection screens
├── lib/                     Shared logic (owned by web-foundation)
│   ├── connection/          The WorkspaceConnection interface, state -> UI mapping, browser dependencies (IndexedDB keys)
│   ├── stores/              One store per domain (see below)
│   ├── workspace/           WorkspaceSession (connection + stores + commands), manager (one connection per workspace), React hooks
│   ├── invite/              Strict parsing of the invite fragment
│   ├── relay/               Relay login (OAuth, development login)
│   ├── commands.ts          Cross-feature command bus
│   ├── capabilities.ts      Capability checks (only to hide UI)
│   ├── locale.ts            The language controller (getLocale, setLocale, subscribe)
│   ├── lazy.ts              loadMonaco() / loadXterm()
│   ├── monaco.ts xterm.ts   Heavy modules (load them only through lazy.ts)
│   ├── presence-css.ts      CSS for y-monaco's remote cursors
│   ├── drop.ts              Drag and drop -> UploadSource (call it synchronously inside the drop event)
│   └── format.ts errors.ts preferences.ts color.ts store.ts router.ts
├── features/<feature>/      The feature engineer's area: index.tsx (slot components) + strings.ts and
│                            strings.zh-TW.ts (the string namespace) + other files
├── strings/                 The string catalog (defineStrings / t in catalog.ts) and the app-wide namespaces
├── ui/                      Design system: tokens.css, base.css, components.css, components, icons
└── testing/                 FakeConnection, fixtures, render helpers, vitest setup, the test language pin
```

**Rules.** Features do not import each other (`features/a` does not import `features/b`). Every cross-feature action
goes through the command bus. A feature reads the stores only through hooks and never creates a connection or a store
itself. If you need a new API from the shell or the stores, ask for it at handover.

## Routes and the join flow

| Route | Page |
|---|---|
| `/` | Landing page: what the product is, login (per `GET /api/login-options`, only the GitHub / Google methods the relay has configured; the development login only when the relay reports it), recently opened workspaces |
| `/join/:workspaceId` | Accept an invite (see below) |
| `/w/:workspaceId` | The workbench (a lazy-loaded chunk) |
| `/w/:workspaceId/console` | The host console (same chunk; anyone who is not the host sees an explanation) |

The router is `lib/router.ts` (History API, a closed `Route` union). For links inside the app use `<Link to>`,
`useNavigate()` and `useRoute()` from `app/navigation.tsx`.

**The join flow (ARCHITECTURE §4.1)** is implemented in `boot/capture-invite.ts` and `app/pages/JoinPage.tsx`:

1. The first import of `main.tsx` runs before any other module. It copies `#k=…&s=…` into sessionStorage (one copy per
   tab, gone when the tab closes, still there after the login redirect in the same tab) and removes it from the
   address bar with `history.replaceState`, before the OAuth redirect. A fragment on any other path is removed too.
2. `parseInviteFragment` from `@smurg/protocol` parses it **strictly** (exactly one `k` and one `s`, each 43 characters
   of standard base64url). A malformed fragment is refused, never "repaired".
3. Login when needed (`return_to` is an absolute address without the fragment).
4. **The page waits until you click "Join".** It shows the workspace code, the identity you join with and what the host
   sees after you join. No connection is made before the click. Any web page can send a logged-in visitor to an invite
   link, so the app never joins on page load.
   (The whole invite address is written to the browser's global history when it is opened; `replaceState` cannot remove
   that. See `boot/capture-invite.ts`.)
5. The app connects in invite mode. In msg2 the SDK verifies the daemon's key with `k`, and it pins the key in
   IndexedDB **before** it sends msg3. If this browser has already pinned a **different** key, the page first asks you
   to confirm that you checked the new link with the host through another channel. Only then does it connect with
   `preferInvite` (the new key replaces the old pin). It never accepts a new key silently.
6. After the connection succeeds, the invite is deleted from sessionStorage and the app goes to `/w/:workspaceId`,
   **reusing the same connection** (the manager guarantees one connection per workspace).

## Connection layer and connection states

`WorkspaceConnection` in `lib/connection/types.ts` is the subset of the SDK's `Connection` that the app uses. In
production it is the `Connection` of `@smurg/protocol/client`; tests use the `FakeConnection` of
`src/testing/fake-connection.ts`.

`lib/workspace/manager.ts` guarantees **one connection per workspace**: the join page, the workspace page and the
console all `acquire()` the same `WorkspaceSession` (connection + stores + command bus). It closes 15 seconds after the
last page lets go. "Leave" goes through `manager.leave()` (`channel.leave`, then close).

The device key and the pin live in IndexedDB (device-key-v2 of `@smurg/protocol/browser`: a non-extractable X25519
CryptoKeyPair where possible, AES wrapping on WebKit). **"Non-extractable" only means that page code cannot export the
key. It is not disk encryption**; do not describe it that way in the UI or the docs. When IndexedDB is not available
(some private windows) the key is kept in memory and the workbench shows a banner.

The state -> UI mapping is in `lib/connection/status.ts` (`describeConnection`), and all of it is tested:

| SDK state | UI | Blocks the whole screen? |
|---|---|---|
| `idle` / `connecting` | "Connecting…" | No (the connecting screen is shown before the first connection) |
| `connecting` + `retryAt` | "Reconnecting…" + the reason + a countdown | No |
| `connecting{cause:'role-changed'}` | "Role changed"; a toast appears after the reconnect | No |
| `handshaking` | "Securing…" | No |
| `online` | "Connected" | No |
| `host-offline` | **"Host offline"**, a permanent banner (the relay reports it / no answer for 8 seconds / sharing stopped); the UI stays usable | No |
| `relay-unreachable` | "Server unreachable", **a different message from host offline**, with a countdown | No |
| `key-mismatch` | **Full-screen security warning** (SPEC R3.2): the relay handed over a different host key, the connection was refused, ask the host for a new link through another channel; there is no "retry anyway" | Yes |
| `rejected(…)`, `closed(kicked/revoked/no-trust/…)` | A screen that explains each case | Yes |
| `closed(login-required)` | The login screen; after login you come back to the same page | Yes |

Stable test hooks (for Playwright / e2e): `data-testid="key-mismatch-screen"` (`role="alertdialog"`),
`data-testid="host-offline-banner"`, `data-testid="relay-unreachable-banner"`, `data-testid="connection-ended-screen"`,
`data-testid="login-required-screen"`, `data-testid="connecting-screen"`, and `data-connection-state="<SDK state>"` on
the workbench's root element.

## Stores (one per domain)

`createWorkspaceStores(conn)` creates all stores together and feeds them from the same connection
(`lib/stores/index.ts`):

- on the first Welcome and on every Welcome that is **not a resume**: each store runs `reset()` and then loads a fresh
  snapshot;
- on a resume Welcome: nothing is reloaded (the daemon sends the events you missed);
- a role change (a Welcome or `channel.memberUpdated`) notifies the stores that depend on the role (admin, docs);
- answers from an old logical channel are dropped (a generation check). A failed load stays in the store's `error` (a
  sentence in the language of that moment) and is shown as a toast.

In a component:

```tsx
import { useStore } from '../../lib/store.ts';
import { useStores } from '../../lib/workspace/context.tsx';

const { sessions } = useStores();
const list = useStore(sessions, selectSessionList, shallowEqual);   // a selector; pass shallowEqual when it returns a new array
```

Every store is a `ReadableStore<State>` (`getState()`, `subscribe()`) plus actions (which call
`connection.request(…)`). Below is one example per store. The full types and comments are in each file.

**connection**: `ReadableStore<ConnectionState>`

```tsx
const state = useConnectionState();            // same as useStore(useStores().connection)
if (state.kind === 'host-offline') …
```

**workspace** (`workspace.ts`): workspace info, your own member record, public settings; live updates from
`channel.memberUpdated` / `channel.settingsUpdated`

```tsx
const info = useWorkspaceInfo();               // { id, name, hostName, platform, isGitRepo }
const settings = useStore(useStores().workspace, selectSettings);   // humanLockIdleMs, uploadChunkSize, sharedDirs…
const generation = useStore(useStores().workspace, (s) => s.generation);   // +1 on every full resync
```

**presence** (`presence.ts`): online members and agents (`presence.state`); reports the file you are looking at

```tsx
const { presence } = useStores();
const viewers = useStore(presence, (s) => selectViewersOf(s, file), shallowEqual);
presence.setActiveFile(file);                  // the docs store calls this for you when the tab changes
```

**files** (`files.ts`): one tree per root (the main workspace or a worktree), loaded level by level with `file.tree`;
`file.changed` events are merged and the affected directories are listed again

```tsx
const { files } = useStores();
const root = useStore(files, selectActiveRoot);
const listing = useStore(files, (s) => selectDir(s, root, 'src'));   // { status, entries, truncated, error }
await files.loadDir(root, 'src');              // expand a folder; on collapse files.forgetDir(root, 'src')
files.setActiveRoot({ kind: 'worktree', worktreeId });
await files.create({ root, path: 'src/new.ts' }, 'file');   // also rename / delete / stat / read / write
```

**locks** (`locks.ts`): file locks (a person's edit lock, an agent's lock), live from `lock.state`

```tsx
const lock = useStore(useStores().locks, (s) => selectLock(s, file));
if (lock?.kind === 'agent') …                  // "Claude (Ian) is editing"
await locks.release(file);                     // let the agent go first; the host: locks.forceRelease(file)
```

**docs** (`docs.ts`): the registry of open documents (tab order, current tab); handles the `doc.*` control messages and
forwards the Yjs traffic

```tsx
const doc = await docs.open(file);             // doc.open; switches to it when it is already open
const off = docs.onDocMessages(doc.docId!, { sync: (data) => …, awareness: (data) => … });  // what arrived earlier is replayed first
docs.sendSync(docId, update);                  // a y-protocols sync message
const editable = isDocEditable(useStore(docs, selectActiveDoc));   // false under an agent's lock
// Important: bind again when OpenDoc.generation changes (reopened after a resync, or doc.reset); when the epoch changes, throw the Y.Doc away and start over.
```

**sessions** (`sessions.ts`): the list of agent sessions and terminals (`session.list` + `session.state`), and the
terminal streams

```tsx
const mine = useStore(sessions, (s) => selectSessionsOf(s, userId), shallowEqual);
const off = sessions.stream(id, { output: (chunk) => viewer.write(chunk.data), resize: ({ cols, rows }) => viewer.resize(cols, rows) });
const attached = await sessions.attach({ sessionId: id, haveOffset, cols, rows });   // stream first, then attach
sessions.input(id, bytes);                     // the host and members with agent access (session.drive, any session); resize is sent only from the opener's panel; end / loginStatus / create
sessionTitle(session);                         // the title the opener typed, else "Claude (Ian)" / "Terminal (Ian)"; plainSessionTitle(session): else "Claude" / "Terminal"
```

**suggestions** (`suggestions.ts`): suggestions (R6); nothing is accepted automatically

```tsx
const waiting = useStore(suggestions, (s) => selectPendingForOwner(s, sessionMap, userId), shallowEqual);
await suggestions.create({ sessionId, text, source: { file, startLine, endLine } });
await suggestions.accept(id, editedText);      // with a text it is "accept after editing"; reject / edit / withdraw
```

**activity** (`activity.ts`): the activity feed (newest first) and the notifications agents send to you
(`activity.notify`)

```tsx
const events = useStore(activity, selectActivityEvents);
await activity.loadOlder();                    // page backwards
const notes = useStore(activity, selectNotifications);   // the workbench also shows a new notification as a toast
```

**conflicts** (`conflicts.ts`): the conflicts panel (`doc.conflict`)

```tsx
const open = useStore(conflicts, selectOpenConflicts, shallowEqual);
const { agentVersion } = await conflicts.get(id);   // the agent's full version (bytes)
await conflicts.resolve(id, 'dismiss');        // or 'apply-agent-version'
```

**worktrees** (`worktrees.ts`): worktrees and merge requests (R9)

```tsx
const list = useStore(worktrees, selectWorktreeList, shallowEqual);
const request = await worktrees.requestMerge(worktreeId, 'Finish the login page');
const { diff, truncated, files } = await worktrees.diff(request.id);   // for a truncated file, read the whole thing with fileDiff
await worktrees.approve(request.id);           // the host; reject(id, reason)
```

**admin** (`admin.ts`): the data of the host console; loaded only for the host (`admin`)

```tsx
const { members, invites, audit, settings, enabled } = useStore(useStores().admin);
const { url } = await admin.createInvite({ role: 'editor', expiresInSec: 86_400, maxUses: 5 });   // the url is shown once; do not log it
await admin.kick(userId);                      // setRole / revokeInvite / terminateSession / loadOlderAudit / setSettings
```

**transfers** (`transfers.ts`): the progress of uploads and downloads. The interactive connection does **not** feed
it: the transfer feature runs on its own TransferConnection (a Web Worker) and reports progress here, so the file tree
and the panel can show it

```ts
const job = transfers.add({ id, kind: 'upload', name: 'data.zip', root, path: 'data/data.zip', totalBytes, files: 1 }, () => worker.abort(id));
transfers.update(id, { status: 'running', doneBytes });   // 'done' / 'failed' (with error) / 'cancelled'
transfers.cancel(id);                          // calls the registered cancel function
```

**errors**: the list of background failures (a failed load and so on). The workbench shows them as toasts; a feature
usually does not need to read it.

## Capability checks (only to hide UI)

Built on the one role matrix of `@smurg/protocol` (`can()`). The code **never compares roles by rank** (SPEC §8 is not
monotonic). Hiding a button is cosmetic; the daemon checks every request.

```tsx
const canWrite = useCan('file.write');
const caps = useCapabilities();                // caps.can('admin'), caps.canCreateSession, caps.canDrive, caps.isHost, caps.role
drivesSession(caps, session);                  // may type in this session and handle its suggestions (the host and members with agent access, any running session)
isRiskyRole(role);                             // the console asks the host to confirm the risk before it gives this role (Agent access)
<Can capability="suggest.create" fallback={null}><SuggestButton /></Can>
```

## Cross-feature command bus

`lib/commands.ts`. Each command has exactly one handler (the feature that owns the behavior) and may have several
observers.

| Command | Payload | Handler |
|---|---|---|
| `openFile` | `{ file, line?, column? }` | editor |
| `sendSelectionAsSuggestion` | `{ file, startLine, endLine, text, sessionId? }` | suggest |
| `focusSession` | `{ sessionId }` | agents |
| `startUpload` | `{ root, targetDir, source: UploadSource }` | transfer |
| `download` | `{ file, zip? }` | transfer |
| `revealFile` | `{ file }` | files |
| `showPanel` | `{ panel }` | the workbench shell (implemented) |

```tsx
// the editor feature:
useCommandHandler('openFile', async ({ file, line }) => { await docs.open(file); /* scroll to line */ });
// anywhere else:
const openFile = useCommand('openFile');
await openFile({ file, line: 42 });            // rejects with NoCommandHandlerError when there is no handler
```

Drag-and-drop upload: call `collectDrop(event.dataTransfer)` (`lib/drop.ts`) **synchronously** inside the `drop` event,
then dispatch `startUpload`.

## Feature slots

The workbench (`app/workspace/Workbench.tsx`) puts the components below in fixed places, each inside its own error
boundary. As a feature engineer you **only replace the content of the component**. Keep the export names and the props
(none of them has props today; all data comes from hooks).

| File | Exports | Place |
|---|---|---|
| `features/files/index.tsx` | `FilesPanel` | Left sidebar (below the WorktreeSwitcher) |
| `features/worktree/index.tsx` | `WorktreeSwitcher`, `MergeRequestsPanel` | Top of the left sidebar; the "Merge requests" tab of the bottom drawer |
| `features/editor/index.tsx` | `EditorArea` | Center (the editor draws its own tabs) |
| `features/agents/index.tsx` | `AgentsPanel` | Right side, top |
| `features/suggest/index.tsx` | `SuggestionsPanel` | Right side, bottom |
| `features/activity/index.tsx` | `ActivityPanel`, `ConflictsPanel` | The "Activity" and "Conflicts" tabs of the bottom drawer |
| `features/transfer/index.tsx` | `TransfersPanel` | The "Transfers" tab of the bottom drawer |
| `features/console/index.tsx` | `HostConsolePage` | `/w/:id/console` (only the host sees it) |

The shell owns the layout (whether the sidebar, the right side and the drawer are shown, and their sizes) and
remembers it in the browser. To bring a panel to the front, dispatch `showPanel`.

## Strings and languages

The app has two locales: `en` (the default, and the one that defines the keys) and `zh-TW`. Every text a person can
read is in the string catalog. Each feature defines its namespace in **its own** `features/<feature>/strings.ts`
(English) with the sibling `strings.zh-TW.ts` (the same keys in Traditional Chinese). `src/strings/index.ts` loads
every `features/*/strings.ts` by convention with `import.meta.glob`, so you **never edit an index**. App-wide
namespaces live in `src/strings/<namespace>.ts` + `src/strings/<namespace>.zh-TW.ts`.

```ts
// src/features/files/strings.ts (English: defines the keys; imports only catalog.ts and its sibling)
import { defineStrings } from '../../strings/catalog.ts';
import { zhTW } from './strings.zh-TW.ts';
export const t = defineStrings(
  'files',
  {
    empty: 'This folder is empty',
    uploading: 'Uploading {name} ({percent}%)',
    'selected.count': { one: '{count} file selected', other: '{count} files selected' },
  },
  zhTW,
);

// src/features/files/strings.zh-TW.ts (the same keys; a missing key is a compile error)
export const zhTW = { empty: '...', uploading: '...', 'selected.count': '...' } as const;

// in a component
import { t } from './strings.ts';
t('uploading', { name, percent });             // the key is type-checked
t('selected.count', { count: 2 });             // "2 files selected"
```

- `defineStrings(namespace, en, zhTW)` returns the typed translator. `t(key, vars)` reads the language at call time,
  so call sites never name a language.
- A value is a template or a plural pair `{ one, other }`. The form is chosen with `Intl.PluralRules` on the variable
  named `{count}` (only that name). A key that counts two things is split into two keys. zh-TW has no plural forms and
  keeps plain strings.
- Do not build a sentence from fragments. Quote marks, colons and brackets belong to each language's template; names,
  paths and counts are parameters.
- aria-labels come from the catalog too.

**Detection.** The first hit wins: `localStorage['smurg.lang']`, then the cookie `smurg_lang`, then the first entry of
`navigator.languages` that is supported (English or Traditional Chinese), then English. `src/boot/locale.ts` is the
second import of `main.tsx` (right after `capture-invite`, before the strings and every component), so the first
render is already in the right language. `index.html` starts with `lang="en"`.

**The controller** is `src/lib/locale.ts`:

| Export | What it does |
|---|---|
| `getLocale()` | The current language (`'en'` or `'zh-TW'`) |
| `setLocale(locale)` | A person chose a language: writes `localStorage['smurg.lang']`, mirrors it into the cookie `smurg_lang` (so the relay's pages such as `/device` follow), then applies it. A browser that refuses storage or cookies still switches for this page |
| `applyLocale(locale)` | Makes it the language of the catalog, the formatters and `<html lang>` without recording a choice (boot, tests) |
| `subscribe(listener)` | Called after every change; returns the unsubscribe function |
| `localeStore` | The language as a store, for `useStore(localeStore)` |
| `initLocale()` | Boot: detects the language and applies it |

`<html lang>` is `en` or `zh-Hant-TW`.

**The language menu.** `LanguageMenu` (`src/ui/LanguageMenu.tsx`, `data-testid="language-menu"`) is a globe button
with a menu of two entries, `English` and `繁體中文`. The two names are never translated, and each carries its own
`lang` attribute, so a person who cannot read the current language still finds theirs. It is placed in the top bar
(next to the theme menu), on the landing page, and in the card corner of every full page: join, login, connecting, key
mismatch, rejected, closed, not found.

**The switch does not reload the page.** `app/App.tsx` re-mounts the route tree with the locale as React key
(`<Routes key={locale} />`). Stores, services and the connection live outside React and are kept. Component state (an
open dialog, an unsent draft, a scroll position) is lost, and terminals attach again as on any remount. A toast
already on screen and error sentences already kept in a store keep the old language; this is accepted. So do not
cache translated text in module scope or in a store.

**Formatting** goes through `src/lib/format.ts`: `formatRelativeTime`, `formatDateTime`, `formatExactTime`,
`formatTime`, `formatNumber`, `formatDuration`, `formatBytes`, `formatList`, `compareText`, `formatRole`,
`formatActor`, and `formatters()` when you need an `Intl` object. Everything uses `Intl` with the tag of the current
locale, and the formatters are built lazily, once per locale. Keep nothing language-dependent at module level: a
`const COLUMNS = [{ header: t('…') }]` or a `new Intl.DateTimeFormat(…)` at the top of a file keeps the language of
page load. Make it a function. For your own `Intl.*` call `currentIntlTag()` from `src/lib/locale.ts` inside the
function.

**Text the host originates** does not come from the web catalog. Role labels (`Host`, `Agent access`, `Editor`,
`Viewer`) and every text the host writes come from `@smurg/protocol/i18n`, so the web app and the CLI share one
wording. In `src/lib/errors.ts`:

- `renderWireText(ref, fallback)` renders a message reference in the viewer's language, or returns the English
  `fallback` when this build cannot render the reference (a newer host). Use it for activity sentences and for
  notifications the host wrote.
- `describeError(error)` gives one sentence for any error the UI may show: the error's reference in the viewer's
  language; else the English sentence it came with; else, for an error without a reference, the default sentence of
  its code.

Use `formatRole(role)` for a role label; never put one in your own catalog.

**Checks.** `src/strings/strings.test.ts` checks every namespace: both languages have the same keys and the same
`{placeholders}` (in both plural forms too); English text holds no Chinese character and no full-width punctuation;
zh-TW text is Traditional Chinese except names, loanwords (`agent`, `worktree`, `session`, and the like), addresses
and bare templates; every key renders in both languages with sample values and leaves nothing unfilled; and no key is
unused.

**Known limits.** Monaco has no language pack: its own menus and its find widget are English in both languages. xterm
has no locale.

## Design system

`src/ui/`: `tokens.css` (CSS custom properties), `base.css`, `components.css`, components and icons. Import from
`src/ui/index.ts`.

- **Theme**: dark by default; switches automatically when the operating system prefers light; you can choose in the
  menu (`<html data-theme>`).
- **Colors**: `--color-bg`, `--color-surface-1..3`, `--color-border(-strong)`, `--color-text(-muted/-subtle)`,
  `--color-accent(-solid)`, `--color-success|warning|danger|info(-soft)`. Text contrast is ≥ 4.5:1 in both themes
  (tested).
- **Fonts**: no web fonts. `--font-sans` (the system UI fonts, then PingFang TC / Noto Sans TC / Microsoft JhengHei)
  and `--font-mono` (code and terminals). Both stacks end with Traditional Chinese families, so Chinese file names
  render correctly in English mode.
- **Spacing**: `--space-1` (2px) … `--space-10` (48px), a 4px grid; radii `--radius-sm|md|lg`; layers `--z-*`.
- **Components**: `Button`, `IconButton` (a `label` from the catalog is required), `Input`, `TextArea`, `Select`,
  `Dialog` (focus trap, Esc, focus returns), `Drawer`, `Tabs` (arrow keys, Home/End), `Tooltip`, `Badge`, `Avatar`
  (name + color, picks a readable text color), `Banner`, `ToastProvider`/`useToast`, `Spinner`, `EmptyState`, `Table`,
  `SplitPane` (drag, arrow keys, double-click resets; the remembered size is a wish and the size SHOWN is that wish
  inside the limits of the container as it is now, which the component observes; the limits keep a minimum for the
  pane on the other side and never push the fixed pane below its own; the separator's `aria-valuenow` / `-min` /
  `-max` report what is on screen; logic in `src/ui/split-resize.ts`; the workbench's minimums, including what the
  file tree leaves for the editor AND the agents column, are in `src/app/workspace/layout-limits.ts`), `Menu`, `LanguageMenu`, `Panel`, `CopyButton`, `Kbd`, and the inline SVG icons of
  `icons.tsx` (do not use emoji as icons).
- Style: a calm, information-dense workbench (like a code editor, not a marketing page). No decorative gradients; the
  focus ring is always visible; everything works with the keyboard.

## Monaco and xterm (lazy loaded)

Load Monaco (about 3.8 MB) and xterm only through `src/lib/lazy.ts`:

```ts
const { createEditor, createSmurgModel, monaco, monacoThemeFor } = await loadMonaco();
const { createViewerTerminal } = await loadXterm();
```

**Never** `import` `lib/monaco.ts` or `lib/xterm.ts` directly: `scripts/check-chunks.ts`, run by `pnpm build`, fails
the build when they end up in the initial load.

- `lib/monaco.ts` (the configuration verified in yjs-monaco.md Q2): the slim entry point of 0.56+, the editor worker
  (`?worker`), `unicodeHighlight` allows zh-hant/zh-hans, `unusualLineTerminators: 'off'`, starts read-only (y-monaco
  is bound only after the first sync), `createSmurgModel()` forces LF. An alias in `vite.config.ts` maps y-monaco's
  deep imports to the same Monaco. Remote cursor styles use `lib/presence-css.ts`.
- `lib/xterm.ts` (verified in pty-packaging.md §6.2): `createViewerTerminal()` registers the **complete** query
  interception (DA1/DA2/DA3, DSR/CPR/DECXCPR, DECRQM, DECRQSS, XTWINOPS reports, OSC 4/10/11/12 queries; tested),
  applies resizes in stream order, and resets before it draws a snapshot. It comes with the web-links and unicode11
  addons (the fit addon is no longer used: `@xterm/addon-fit` is still in package.json and can be removed the next
  time the dependencies change).
- Terminal size (`features/agents/terminal-fit.ts`): the panel of **the person who opened the session** (the owner)
  decides the PTY size. The host and members with agent access may type in any session, but the size follows only the
  owner, so panels do not fight over it. Columns and rows are both computed from the visible area (`measureTerminal`
  in `viewer.ts` measures the panel, `planOwnerSize` computes the size). The size is sent with `session.attach`, and
  afterwards `exec.resize` is sent (150 ms debounce) when the panel size changes, a pane or the drawer opens or
  closes, the fonts finish loading, or the tab becomes visible again. The daemon applies `exec.resize` in stream order.
  Lower limits: 80 × 24 for Claude Code (an agent; the size verified in pty-packaging.md F16/F17), and only the
  daemon's 20 × 5 for a plain terminal. When the panel is smaller than the limit, the terminal stays at the limit, the
  panel scrolls, and one line above it explains why (`data-testid="terminal-size-hint"`); nothing is cut off silently.
  Everyone else (and another window of the owner that does not drive the size) sees the terminal at the PTY's size.
  When that is larger than the panel it scrolls in both directions with the scrollbars always visible, and "Scale to
  fit the width" only draws it smaller; it does not rearrange the content. The viewport carries
  `data-cols`/`data-rows` (the actual size), `data-fit-cols`/`data-fit-rows` (the size that fits this panel) and
  `data-driving`, for tests.

### Roles, sessions and the activity feed (as built, protocol v3)

- **There is no guest sandbox and no agent of a guest's own.** Every session runs on the host's computer, as the host,
  with the host's Claude account. The host and members with agent access (role `agent`) can open sessions
  (`session.create`: in the main workspace, in a new worktree or in a worktree they kept) and can type directly in
  **any** session and accept or reject its suggestions (`session.drive`). An Editor can only make suggestions; a
  Viewer can only watch. The host can terminate any session; the person who opened a session can end it.
- **New session** (`features/agents/new-session.ts`, `NewSessionDialog.tsx`): the host and members with agent access
  see the same options, and one line says that the session runs on the host's computer with the host's Claude account
  (`data-testid="new-session-runs-as"`). There is no API key, no sandbox explanation and no login procedure.
- **Session titles**: `SessionInfo.title` is optional; it is present only when the person who opened the session typed
  one. The client builds the default title (`src/lib/stores/sessions.ts`): `sessionTitle()` gives the typed title, or
  `Claude (Ian)` / `Terminal (Ian)` from the kind and the opener's name (the wire catalog's `session.title.*`);
  `plainSessionTitle()` gives the typed title, or the bare `Claude` / `Terminal`, for wording that already names the
  opener. The host sends no default title. Agent display names have one spelling, `Claude (Ian)`, and the browser's
  device name is `Chrome (macOS)`, or `Browser` when the user agent says nothing; neither is translated.
- **The session panel**: a tab is labeled with the session's name and the person who opened it. Someone who cannot
  type sees that they can only watch, and the details tell an Editor how to make a suggestion. When the agent is not
  logged in (it is the host's Claude login), the host is told to type `/login` in the terminal and everyone else is
  told to ask the host to log in. Anyone who can type can check the login state again (`session.loginStatus`).
- **Closing the tab of an ended session** (`features/agents/SessionTabs.tsx`, `closed-sessions.ts`; ARCHITECTURE §9):
  after a session has ended (`status: 'exited'`), everyone (a Viewer too) can close its tab in **their own** panel:
  the close button next to the tab (accessible name "Close …", one Tab press away from the selected tab), Delete on
  the tab, the middle mouse button, or "Close tab" in the session bar. Nothing is sent to the daemon, and other
  people's panels and the console are not affected. The closed ids are kept in this browser's localStorage
  (`smurg.agents.closedSessions`, per workspace). While the daemon still lists the session, it does not come back
  after a reload or a reconnect; once the daemon no longer lists it, the id is dropped. After closing, the tab to the
  right (or to the left when there is none) is shown and gets the keyboard focus; when no tab is left, the focus goes
  to "New session". A running session has none of these controls (ending it is still "End session" or the force
  terminate action).
  The panel uses its own tab bar (`SessionTabs`, the same keyboard behavior and style as `ui/Tabs`), because a tab of
  `ui/Tabs` cannot carry a second control.
  The daemon keeps an ended session for only 15 minutes (32 at most) and does not announce when it forgets one. When
  a panel that stayed open goes back to that tab, `session.attach` answers `not_found`, and the terminal says that the
  session ended a while ago and that you can close the tab (not "cannot connect" with a retry).
- **Suggestions**: anyone who can type (the host, members with agent access) sees the suggestion queue of the focused
  session. An Editor sees the suggestion input. Notifications do not name who accepted or rejected (`Suggestion` has
  no such field). The editor's "Send to agent": anyone who can type pastes straight into any agent session; an Editor
  makes a suggestion.
- **Console**: the role list is Agent access / Editor / Viewer. When the host picks Agent access for a new invite or
  for a member's role, a confirmation dialog shows the risk first (`features/console/RoleRiskDialog.tsx`,
  `data-testid="role-risk-text"`), and nothing is sent until the host clicks the "I understand, …" button; Cancel
  sends nothing. Taking agent access away from a member whose sessions are still running asks for confirmation too
  (those sessions end). The settings have no sandbox domains.
- **Activity feed**: a change an agent made through a shell command (the daemon decides it is an `agent.edit`, the
  actor is that agent, with `via: 'bash'`; ARCHITECTURE §5.4, §11 D-13) is shown as that agent's change with a small
  "via a command" mark next to it. The mark depends only on the `via` field, never on the text of the summary. An
  outside change appears only when the daemon says so (the `system` actor).

## Tests

```sh
pnpm --filter @smurg/web test                                       # everything (jsdom + the real-browser acceptance tests)
pnpm --filter @smurg/web exec vitest run src/features/files         # one feature only
pnpm --filter @smurg/web exec vitest run e2e --silent=false         # only the real-browser acceptance tests (prints measured times)
pnpm exec vitest run --project @smurg/web-smoke                     # in the repo root: the built production app (served by a real relay)
```

**Language in tests.**

- Every test starts in English: `src/testing/setup.ts` applies `en` before each test and again after it. Nothing under
  test reads `navigator.languages`, a cookie or localStorage implicitly.
- `useTestLocale('zh-TW')` (`src/testing/locale.ts`) pins a file, or one `describe`, to Traditional Chinese. Use it
  only in `*.zh-TW.test.tsx` files: one per feature panel, which renders the panel, asserts a handful of zh-TW strings
  and `document.documentElement.lang === 'zh-Hant-TW'` (the platform's own is `src/app/app.zh-TW.test.tsx`). Inside a
  single test of another file, `applyLocale('zh-TW')` from `src/lib/locale.ts` switches for that test only (the setup
  file resets it).
- Assert the English text literally, for example `screen.getByRole('button', { name: 'New session' })`. Never assert
  through the catalog (`t('key')` in an `expect`): such a test cannot catch a wrong string.
- Browser tests create every context with an explicit `locale` (`en-US` by default: `env.newPage()` of
  `e2e/smoke/helpers.ts`; `env.newPage({ locale: 'zh-TW' })` for a Chinese page). The helpers click through the app by
  its visible labels and keep those labels for both languages (`WORDS`); `chooseLanguage(page, locale)` uses the
  language menu, and `cjkTexts(page)` lists every visible text and accessible name that holds a CJK character.

`e2e/smoke/` is a separate vitest project. Its globalSetup builds the web app once (`vite build` +
`scripts/check-chunks.ts`, output in the project's temporary directory, `dist/` is not touched). A real relay serves
it (`startLocalRelay({ webDist })`; the Worker serves the static files as in production), the daemon is composed of
all modules, and the system's Chrome walks through it (headless, a fresh context, development login; scrollbars are
not hidden, because the terminal tests measure them).
The shared harness is `e2e/smoke/helpers.ts` (`startSmoke`, `joinAs`, `joinAsHost`: the host's own link comes from
`daemon.internals.invites.createHostInvite()`, `openSession`, the terminal's text). Every step waits for a condition,
never for a fixed time.

| File | Acceptance criteria |
|---|---|
| `built-app.smoke.test.ts` | Join with an invite link -> open a file -> type -> the disk; R7.1b two browsers editing at once; R8.2b the read-only notice under an agent's lock; a member with agent access opens a terminal (it runs as the host's user); CSP |
| `terminal.smoke.test.ts` | The owner's PTY follows the panel (a narrow 420 px panel and a wide one; `stty size` equals the size that fits the panel; no part of the terminal lies outside the visible, scrollable container). A watcher sees the PTY's size, can scroll to see a full 80-column line, and can use "Scale to fit the width" |
| `close-session.smoke.test.ts` | Closing the tab of an ended session (ARCHITECTURE §9): everyone (a Viewer too) closes an ended session in their own panel with the tab's close button, Delete or "Close tab"; other people's panels are not affected and the daemon still lists it; it does not come back after a reload; after closing, the neighboring tab is selected and gets the keyboard focus; when the tab bar overflows, the selected tab scrolls into view together with its close button; a running session has none of these controls. A second group uses a daemon that forgets an ended session after 2 seconds (15 minutes in production): a tab that stayed open says the content is no longer kept (no retry), can still be closed, does not come back after a reload, and the remembered id is dropped |
| `splitter.smoke.test.ts` | The dividers of the workbench under a real mouse: a hover never moves a divider; a press within 3 px on either side grabs the line without moving it and the line then follows the pointer; a drag stops on the release wherever the pointer is; a drag that loses its release ends with the button; the terminal still refits; arrow keys resize, a double click comes back to the default width and the width survives a reload; in a window too small for the remembered width the editor keeps its minimum; in a narrow window with a wide remembered file tree the agents column keeps its 260 px, its divider still moves by mouse and keys, and each separator's `aria-valuenow` / `aria-valuemax` is the size on screen |
| `login.smoke.test.ts` | Loading `/` and `/join/<id>` without a login: zero console errors, zero failed requests; the CLI's device-code login |
| `language.smoke.test.ts` | An `en-US` browser: landing, join, workbench, the activity feed (the host's own sentences), an error and the host console with its audit log, each followed by a scan of the whole document for CJK characters; the language menu switches to 繁體中文 without a navigation; `<html lang>`, the stored choice and the cookie follow; the choice survives a reload; the relay's `/device` follows the cookie; detection (`zh-HK` is Traditional Chinese, `zh-CN` and `ja` get English) and the relay's own language link is followed by the app |
| `zh-TW.smoke.test.ts` | The one smoke test in Traditional Chinese (`locale: 'zh-TW'`): join through an invite link, the workbench, a terminal session, a suggestion the host accepts, the host's sentence in the activity feed and `/device` |
| `acceptance.smoke.test.ts` | R11.1c one-click terminate and remove in the console; R6 suggestions (accept after editing, reject, the author sees the result); R9 worktree merge (the full diff, merge, the worktree is unchanged after a reject); R8.4 a real conflict appears in the conflicts panel; a member with agent access opens their own session (it runs as the host's user), types directly in the host's session and accepts an Editor's suggestion; the console's risk confirmation before it gives agent access (an invite and a role change) |
| `transfer-resume.smoke.test.ts` | R7.3: `drop-proxy.ts` (a TCP proxy in front of the relay) cuts the transfer socket in the middle of an upload; the upload resumes by itself and completes, the content is identical, and only the missing part is sent again |

Without a system Chrome these tests are skipped and the reason is printed.

`src/testing/`:

- `FakeConnection`: a connection you drive by hand. `conn.admit(makeWelcome({ role }))`,
  `conn.emit('session.state', …)`, `conn.handle('file.tree', () => …)` (answers automatically),
  `conn.respond(type, result)` / `conn.fail(type, error)` (answers the oldest pending request),
  `conn.requestsOf(type)`, `conn.notificationsOf(type)`, `conn.hostOffline()`, `conn.keyMismatch()`, `conn.kicked()`…
  Payloads sent and received are validated with the protocol registry, so fixtures cannot drift from the real format.
- `renderInWorkspace(<FilesPanel />, { role: 'editor' })`: renders inside a workspace driven by a FakeConnection and
  returns `{ conn, stores, session }`.
- `createTestServices()` / `renderApp()`: the whole App (a memory router, a fake login, a memory pin store).
- `fixtures.ts`: `makeWelcome`, `makeSession`, `makeEntry`, `makeSuggestion`, `makeConflict`, `makeInvite`…
- `createManualScheduler()`: advances a store's timers by hand (for example the merge delay of `file.changed`).
- `locale.ts`: `useTestLocale(locale)` and `TEST_LOCALE` (see above).

```tsx
const { conn } = renderInWorkspace(<FilesPanel />);
conn.respond('file.tree', { entries: [makeEntry('README.md')], truncated: false });
expect(await screen.findByText('README.md')).toBeTruthy();
```

Acceptance tests (their names quote the acceptance criteria of the SPEC):

- `e2e/browser.e2e.test.ts` (**a real browser**): a real relay (local workerd) + a real daemon (the harness of
  `tests/e2e`) + this app (the Vite dev server, the same as in development above) + the system's Chrome
  (playwright-core, headless, a fresh context, no imported cookies). It covers: joining with a real invite link (the
  fragment leaves the address bar before the login redirect, no request contains the secret, the pin is stored in
  IndexedDB); "within 10 seconds after the host disconnects, every guest's interface shows offline" (measured: about
  4.3 seconds); and "when the relay replaces the daemon's public key with its own, the client refuses the connection
  and shows a warning" (both the first join and a reconnect after the key was pinned; the attacker is
  `tests/e2e/src/mitm-relay.ts`; msg3 is never sent and the invite is not used). A machine without Chrome skips it
  automatically. About 15 seconds.
- `app/workspace/connection-states.test.tsx`: the screen of every connection state (jsdom, driven by a
  FakeConnection).
- `app/pages/JoinPage.test.tsx`: every branch of the join flow.

`e2e/global-setup.ts` creates this vitest project's temporary directory (the local relay's miniflare state and so on)
and deletes it at the end.
`e2e/` is not part of the app's `tsc` program (it imports the sources of `tests/e2e` and `apps/relay`, which do not fit
the app's Bundler resolution and JSX settings). It has its own `e2e/tsconfig.json`, and `pnpm --filter @smurg/web
typecheck` checks both programs.

## Build and chunk sizes

```sh
pnpm --filter @smurg/web build                # vite build + scripts/check-chunks.ts
```

Measured on 2026-10-02 (v0.4.0, both languages): the initial load is 2 chunks, 736.1 KiB (224.5 KiB gzip). It
contains React, the protocol (zod, the noble cryptography, msgpack), the strings and the join flow. Before the
second language it was 628.6 KiB (194.9 KiB gzip): both language tables of the web catalog and the wire catalog
(`@smurg/protocol/i18n`, every sentence the host can send, in both languages) load eagerly, which adds about 108 KiB
(30 KiB gzip). The workspace chunk is 288 KiB (82 KiB gzip). The Monaco chunks are about 3.8 MiB
(977 KiB gzip) plus the editor worker, CSS and codicon, and the xterm chunk is 352 KiB (91 KiB gzip). All of these
are in lazy-loaded chunks.
