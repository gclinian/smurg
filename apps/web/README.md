# @smurg/web

The web front end of smurg: a single-page application built with React 19 and Vite 8. In production the relay Worker
serves it from the same origin. The specification is `SPEC.md` (R1–R3, R7, R11, §9) and, since 0.5.0, the owner's
brief and the design that came out of it (`docs/design/v0.5.0/`: `OWNER-BRIEF.md`, `DESIGN.md` §5, `UX.md` and the
mock); the conventions are in `docs/ARCHITECTURE.md` §4 and §9.

This document is for **engineers who build features inside this shell**. The shell, the routes, the connection layer,
the stores, the command bus, the slots, the strings and the design system are in place. To build a feature you only
change `src/features/<your feature>/**`. You do **not** need to touch the shell, the routes, the stores, the string
index or `package.json`.

**0.5.0 (protocol 4) changed the main screen.** A workspace has two views. The **sessions view** (`/w/:id`) is the
main screen: the inbox and the session list, grouped by topic, on the left, and up to four columns on the right (a
conversation with an agent, a terminal, a topic's spec, its plan, a result report, a merge request's changes). **Code
mode** (`/w/:id/code`) is the workbench of 0.4.0 (file tree, editor, terminal, activity) behind a switch in the top
bar. Both stay mounted.

**How to read this document** (state of 2026-10-07, after the integration of the web packages). "As built" means the
code is in `src/` and has tests: the shell with both views, every store, the commands, the slots, the UI kit, the
columns strip, the left column, the Markdown renderer, the conversation column and its cards, the terminal column, the
topic columns and dialogs, the console. Every feature has its built-app smoke under `e2e/smoke`. Where a paragraph
still says "Contract", it describes what the design fixes; the code named beside it is the place to look. Nothing of
0.4.0's panels is left in the tree: `features/suggest` and the transitional names of the shell are gone.

- [Run the whole system locally](#run-the-whole-system-locally)
- [Directory layout and ownership](#directory-layout-and-ownership)
- [Routes and the join flow](#routes-and-the-join-flow)
- [The two views of a workspace](#the-two-views-of-a-workspace)
- [Connection layer and connection states](#connection-layer-and-connection-states)
- [Stores (one per domain)](#stores-one-per-domain)
- [Capability checks (only to hide UI)](#capability-checks-only-to-hide-ui)
- [Cross-feature command bus](#cross-feature-command-bus)
- [Feature slots](#feature-slots)
- [Columns](#columns)
- [A conversation column](#a-conversation-column)
- [Code mode](#code-mode)
- [How the features of 0.4.0 map](#how-the-features-of-040-map)
- [Strings and languages](#strings-and-languages)
- [Design system](#design-system)
- [Monaco, xterm and marked (lazy loaded)](#monaco-xterm-and-marked-lazy-loaded)
- [Roles, sessions and the activity feed (as built, protocol 4)](#roles-sessions-and-the-activity-feed-as-built-protocol-4)
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

**Agent sessions on a development machine.** An agent session is the host's own `claude` in its structured mode
(ARCHITECTURE §7.6): the daemon runs the first `claude` on the host's `PATH`, needs Claude Code 2.1.288 or newer and
a login. Without one, terminals, files, the editor and every screen still work, and an agent session says why it
cannot start. No test uses a real Claude Code account: the tests of this package drive a `FakeConnection`, and the
built-app smokes run the daemon with the scripted stand-in `claude` of `packages/daemon/src/testing/` ("Tests").

## Directory layout and ownership

```
src/
├── main.tsx                 Entry point. The first import is boot/capture-invite.ts (put nothing above it);
│                            the second is boot/locale.ts
├── boot/capture-invite.ts   Before any other code runs: stores the invite fragment in sessionStorage and removes it from the address bar
├── boot/locale.ts           Resolves the language of this browser and sets <html lang>, before the strings and any component
├── app/                     The shell: App, routes, pages, connection screens
│   └── workspace/           WorkspaceRoute, WorkspaceShell (both views mounted), SessionsView (the main screen),
│                            Workbench (code mode, a lazy chunk), TopBar (the mode switch), EmptyColumns, the notices,
│                            feature-slots.ts (finds every features/*/slots.tsx), layout.ts and layout-limits.ts
├── lib/                     Shared logic
│   ├── connection/          The WorkspaceConnection interface, state -> UI mapping, browser dependencies (IndexedDB keys)
│   ├── stores/              One store per domain (see below)
│   ├── workspace/           WorkspaceSession (connection + stores + commands), manager (one connection per workspace),
│   │                        React hooks, the slot registry's provider
│   ├── columns/             What a column shows (target.ts), what its body knows about its frame (context.tsx), its name (describe.ts)
│   ├── slots.ts             defineSlots: how a feature contributes columns, overlays, menu items and inbox rows
│   ├── session-status.ts    One wording and one glyph for a session's, an item's and a topic's state
│   ├── invite/              Strict parsing of the invite fragment
│   ├── relay/               Relay login (OAuth, development login)
│   ├── commands.ts          Cross-feature command bus
│   ├── capabilities.ts      Capability checks (only to hide UI)
│   ├── locale.ts            The language controller (getLocale, setLocale, subscribe)
│   ├── lazy.ts              loadMonaco() / loadXterm()
│   ├── monaco.ts xterm.ts   Heavy modules (load them only through lazy.ts)
│   ├── presence-css.ts      CSS for y-monaco's remote cursors
│   ├── drop.ts              Drag and drop -> UploadSource (call it synchronously inside the drop event)
│   └── format.ts errors.ts preferences.ts color.ts store.ts router.ts use-now.ts
├── features/<feature>/      A feature's area: slots.tsx (what it contributes to the sessions view), index.tsx (its
│                            fixed places in code mode and the console), strings.ts and strings.zh-TW.ts, other files
│   ├── columns/             (shell) the strip of up to four columns: frame, header, pin, dividers, focus, the side column of code mode
│   ├── sidebar/             (shell) the left column: inbox list, session list by topic, filter, rail, banners and notices
│   ├── conversation/        a session's conversation: header strip, event list, tool cards, question / permission /
│   │                        suggestion / next-step cards, status bar, composer with mentions
│   ├── markdown/            the Markdown renderer (agent text, the spec's Read view, a report's sections)
│   ├── topics/              New topic dialog, spec column, plan column, Start dialog, report column, Changes column
│   ├── agents/              plain terminals: the terminal column, the Terminal tab of code mode, the feed and fit rules, path links, New session / End session / Attach dialogs
│   ├── editor/              the editor of code mode; its DocumentPane is also mounted by the spec and plan columns
│   ├── worktree/            the worktree switcher, merge requests and the diff review (also mounted by the report column)
│   ├── console/             the host console; the Claude Code project settings and the host's own rules (also reached from the sessions view)
│   └── activity/ files/ transfer/      the panels of code mode
├── strings/                 The string catalog (defineStrings / t in catalog.ts) and the app-wide namespaces
├── ui/                      Design system: tokens.css, base.css, components.css, components, icons
└── testing/                 FakeConnection, fixtures, render helpers (workspace, column), vitest setup, the test language pin
```

**Rules.** Features do not import each other (`features/a` does not import `features/b`), with the few parts that
are shared on purpose because one feature MOUNTS a piece another one owns, each imported through one file: the
Markdown renderer (`features/markdown/index.ts`), the editor's document pane for a column
(`features/editor/standalone.tsx`), the worktree feature's diff review (`features/worktree/index.tsx`: the changed
files of a report, the review of a merge request, `UnifiedDiff` for a diff that stands alone), the terminal's path
links (`features/agents/path-links.ts`), the file tree's force-release confirmation
(`features/files/ForceReleaseDialog.tsx`) and the console's review of a folder's Claude Code project settings
(`features/console/ProjectSettingsReview.tsx` with its rules in `claude-config.ts`: the ONE review of the app, mounted
by the console's section, by the host's dialog in the sessions view and inside the New topic dialog). The whole list is
pinned by a test (`app/workspace/feature-slots.test.ts` "features and each other"): a new line there is a decision.
A feature never opens another feature's dialog or reads its state: it dispatches a command. The two shell folders
`features/columns` and `features/sidebar` are imported by `app/workspace` only. Every cross-feature action goes
through the command bus, and a feature shows itself in the sessions view through its `slots.tsx`, never by being
imported. A feature reads the stores only through hooks and never creates a connection or a store itself. Two stores
are written by the feature that knows their wire best and are still created with the others: `lib/stores/conversations.ts`
and `lib/stores/suggestions.ts` belong to the conversation feature. If you need a new API from the shell or the
stores, ask for it at handover.

## Routes and the join flow

| Route | Page |
|---|---|
| `/` | Landing page: what the product is, login (per `GET /api/login-options`, only the GitHub / Google methods the relay has configured; the development login only when the relay reports it), recently opened workspaces |
| `/join/:workspaceId` | Accept an invite (see below) |
| `/w/:workspaceId` | The workspace in the **sessions view**, the main screen (a lazy-loaded chunk) |
| `/w/:workspaceId/code` | The same workspace in **code mode** (the workbench; its own lazy chunk inside the workspace chunk) |
| `/w/:workspaceId/console` | The host console (anyone who is not the host sees an explanation) |
| `/w/:workspaceId/console/:section` | The host console at one of its sections (`CONSOLE_SECTIONS` of `@smurg/protocol`): what an inbox item of the host opens |

The router is `lib/router.ts` (History API, a closed `Route` union: `landing`, `join`, `workspace`, `code`,
`console`, `not-found`). An invalid workspace id or an unknown console section is `not-found`, never "repaired". For
links inside the app use `<Link to>`, `useNavigate()` and `useRoute()` from `app/navigation.tsx`.

The mode of a workspace is a route on purpose (the design's AD-12): a reload, the back button and a shared address
keep it. `WorkspaceRoute` renders ONE `WorkspaceShell` for `workspace` and `code`; the console is a page of its own.

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

## The two views of a workspace

As built (`app/workspace/`, `features/columns`, `features/sidebar`).

**The shell.** `WorkspaceShell.tsx` mounts BOTH views and shows one; the other is `hidden` and `inert`. So unsent
composer text, open columns, editor tabs and scroll positions survive the switch, and nothing reconnects. Its root
element is `.app-shell` with `data-mode="sessions|code"`; the two views are `data-view="sessions"` and
`data-view="code"`. Code mode's module (`Workbench.tsx`, with Monaco and xterm behind it) is a lazy chunk loaded when
code mode is first shown. The shell also owns what belongs to neither view: the top bar, the connection banners, the
commands that move between the views (`openColumn`, `setMode`, `openInCodeMode`), the overlays the features
registered, the notices, and the browser tab's title, which carries the number of waiting items ("(2 waiting) …").

**The sessions view** (`SessionsView.tsx`):

```
┌ left column ─────────┬ column ───────┬ column ───────┬ column ───────┐
│ Inbox                │ a session's   │ the plan      │ a result      │
│ Sessions, by topic   │ conversation  │               │ report        │
└──────────────────────┴───────────────┴───────────────┴───────────────┘
```

- The **left column** (`features/sidebar`) is 288 px by default, 220 to 420 px by its separator, or a 44 px rail.
  It holds the inbox (two groups: what an agent or a plan is stopped on, and the rest; two counts everywhere a count
  shows) and the session list grouped by topic, a real `tree` with roving focus. Each topic has fixed rows from its
  creation (Discussion, Spec, Plan, then one row per work item); sessions without a topic are under "No topic". Both
  sections fold. A row is bold when something a reader cares about happened since this browser last showed it.
- The **strip** (`features/columns` on `ui/Columns`) shows up to four columns, each at least 320 px, with draggable
  dividers that also take the arrow keys. A fifth column is refused with "Four columns are open. Close one first."
  While nothing is open, `EmptyColumns.tsx` says how to start.
- Landmarks: `complementary` "Inbox and sessions", `main` "Open columns"; each column is a `region` named by its
  title. F6 and Shift+F6 move between the regions: inbox, session list, each column in order.
- Above the columns (`features/sidebar/Notices.tsx`): a banner after the host's smurg was restarted (the plans are
  paused until a member with agent access continues them) and the state of the host's Claude account. A new item
  that an agent waits on is announced politely and, when what it is about is on no visible column, shown as a toast
  with "Open". Nothing moves the focus.

**Code mode** (`Workbench.tsx`) is described in [Code mode](#code-mode).

**The top bar** (`TopBar.tsx`) is the same in both views and in the console: workspace name and host, connection
status, member avatars with presence, your own role, the console link (host), the mode switch, the layout toggles of
the view on screen, language, theme and "Leave". The mode switch is two links, "Sessions" and "Code mode" (the mode
is a route); the current one has `aria-current`. While code mode is on screen the "Sessions" segment carries the two
inbox counts, so a question is not missed while hand-coding; the "Code mode" segment carries the number of open
conflicts, because a conflict can hold a person's unsaved text.

**What is remembered where.** What a person folded (the left column and its two sections; code mode's file tree,
session column and drawer) is per browser: `localStorage['smurg.layout']` (`layout.ts`). Which columns are open, their
order, widths and pins, what was seen, the session list's folds and filter, and the session beside the editor in code
mode are per browser AND workspace: `localStorage['smurg.columns.<workspace id>']` (the `columns` store). None of it
is sent anywhere: a member's view is their own.

## Connection layer and connection states

`WorkspaceConnection` in `lib/connection/types.ts` is the subset of the SDK's `Connection` that the app uses. In
production it is the `Connection` of `@smurg/protocol/client`; tests use the `FakeConnection` of
`src/testing/fake-connection.ts`.

`lib/workspace/manager.ts` guarantees **one connection per workspace**: the join page, the workspace page (both
views) and the console all `acquire()` the same `WorkspaceSession` (connection + stores + command bus). It closes 15 seconds after the
last page lets go. "Leave" goes through `manager.leave()` (`channel.leave`, then close).

The device key and the pin live in IndexedDB (device-key-v2 of `@smurg/protocol/browser`: a non-extractable X25519
CryptoKeyPair where possible, AES wrapping on WebKit). **"Non-extractable" only means that page code cannot export the
key. It is not disk encryption**; do not describe it that way in the UI or the docs. When IndexedDB is not available
(some private windows) the key is kept in memory and the workspace shows a banner.

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
the root element of the workspace shell (`.app-shell`, which also carries `data-mode`) and of the console page.

## Stores (one per domain)

`createWorkspaceStores(conn)` creates all stores together and feeds them from the same connection
(`lib/stores/index.ts`):

- on the first Welcome and on every Welcome that is **not a resume**: each store runs `reset()` and then loads a fresh
  snapshot;
- on a resume Welcome: nothing is reloaded (the daemon sends the events you missed). A store with `onResumed()` is
  told all the same: `conversations` watches its open sessions again after EVERY Welcome, because an agent's streaming
  text is volatile and is never replayed;
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
`connection.request(…)`). Below is one example per store. The full types and comments are in each file. Every list
request reads all its pages (`collectPages` of `@smurg/protocol`), and a reply that carries an entity is put into the
store before the promise resolves.

| Store | Fed by | Holds |
|---|---|---|
| `sessions` | `session.list`, `session.state` | every session of both kinds; for terminals also the stream and attach plumbing |
| `topics` | `topic.list`, `topic.updated` / `topic.removed`, `plan.get`, `plan.updated`, `report.get`, `report.updated` | topics, their plans, loaded result reports, the notices a change of phase tells everyone |
| `inbox` | `inbox.list`, `inbox.changed` | the member's own items and the two counts |
| `conversations` | `session.watch` / `session.history` / `session.cards.get`, `session.events`, `session.delta`, the card updates | per watched session: the folded list React renders, the cards by id, the streaming text |
| `host` | `session.host.get`, `session.host` | the state of the host's Claude account and of the main folder's Claude Code project settings |
| `columns` | nothing from the daemon | the member's own view (see "What is remembered where") |
| `suggestions` | `suggest.list`, `suggest.updated` | suggestions, by session |

The other stores (`workspace`, `presence`, `files`, `locks`, `docs`, `activity`, `conflicts`, `worktrees`, `admin`,
`transfers`) are as in 0.4.0.

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

**sessions** (`sessions.ts`): every session of the workspace. `SessionInfo` is a union: an agent session (a
conversation, no PTY) or a terminal (a PTY). The list holds the sessions of every topic that is not archived and the
sessions without a topic; `ofTopic()` reads all sessions of one topic, archived or not (earlier attempts, earlier
discussions). The conversation itself is the `conversations` store's.

```tsx
const agents = useStore(sessions, selectAgentList, shallowEqual);      // selectTerminalList, selectTopicSessions, selectSession
isAgentSession(session); isTerminalSession(session);                   // never assume a session has cols / rows
sessionTitle(session);                         // THE name of a session, the same in the list, a column's header and the console
await sessions.setResponsible(id, userId);     // also: rename, end, terminate, interrupt ("Stop"), retry, restart, setMode, rules, removeRule, loginStatus, create
// terminals only:
const off = sessions.stream(id, { output: (chunk) => viewer.write(chunk.data), resize: ({ cols, rows }) => viewer.resize(cols, rows) });
const attached = await sessions.attach({ sessionId: id, haveOffset, cols, rows });   // stream first, then attach
sessions.input(id, bytes);                     // the host and members with agent access (session.drive, any terminal); resize is sent only from the opener's column
```

**topics** (`topics.ts`): topics, their plans and result reports. Every request of the `topic.*`, `plan.*` and
`report.*` families is a method here

```tsx
const list = useStore(topics, selectTopicList, shallowEqual);          // not archived; loadArchived() for the others
topics.ensurePlan(topicId);                    // safe on every render; plan.updated keeps it current, a resync fetches it again
const plan = useStore(topics, (s) => selectPlan(s, topicId));          // PlanInfo: the work items with their state
await topics.preflight(topicId, itemIds);      // what a Start will do; then topics.start(…)
await topics.loadReport(topicId, itemId);      // report.updated keeps it current; read it with selectReport(s, topicId, itemId)
// also: create, rename, archive, remove, restartDiscussion, revise, requestSpec, addRule, removeRule, generatePlan,
// reloadPlan, setPlanMode, assign, suggestSplit, changes, resume, retryItem, continueItem, resolveItem, followUp, review
```

**inbox** (`inbox.ts`): the member's own inbox, derived by the daemon. An item leaves when the thing is settled, for
everyone at the same moment; looking at one only clears "unread"

```tsx
const groups = useStore(inbox, (s) => selectInboxGroups(s, selfUserId));   // waiting (what an agent or a plan is stopped on) and the rest
const counts = useStore(inbox, selectInboxCounts);                          // the two numbers of the header, the rail, the mode switch and the tab title
inbox.seen(keys);                              // optimistic, then inbox.seen; dismiss(key) for a mention or a result
```

**conversations** (`conversations.ts`, the conversation feature's): the conversations of the agent sessions this
browser has in a column, each read as a window of the log, never the whole log ("A conversation column")

```tsx
const release = conversations.watch(sessionId, { live: column.visible });   // ref-counted; a hidden column: live false
const conversation = useStore(conversations, (s) => selectConversation(s, sessionId));
conversation.items;                            // the FOLDED list: messages, agent text, tools, cards, lines
conversations.onStream(sessionId, (blockId) => node.textContent = conversations.streamText(sessionId, blockId));   // outside React state
await conversations.send(sessionId, text, { mentions });   // also: vote, comment, submit, remind, seen, decide, loadEarlier, showAnchor
release();                                     // closing the column unwatches
```

**host** (`host.ts`): what every member may know about the host's side of agent sessions

```tsx
const account = useStore(host, selectAccount);   // logged out, a usage limit: the banner and the line above a composer
```

**columns** (`columns.ts`): the member's own view of the sessions view. Prefer the `openColumn` command to
`columns.open()`: the command also handles a console target, the mode and the default pin of a plan

```tsx
const open = useStore(columns, (s) => s.columns);      // in order; s.focusedId; isUnseen(s, 'session', id, at) is "bold in the list"
columns.setPinned(id, true);                           // close, closeOthers, focus, setWeights, equalize, setFilter, setCodeSession
```

**suggestions** (`suggestions.ts`, the conversation feature's): suggestions (R6), made to agent sessions only;
nothing is accepted automatically. A suggestion shows as a card in its session's conversation and in the inbox of the
members who may accept it

```tsx
const ofSession = useStore(suggestions, (s) => selectSuggestionsForSession(s, sessionId), shallowEqual);
await suggestions.create({ sessionId, text, source: { file, startLine, endLine } });
await suggestions.accept(id, editedText);      // with a text it is "accept after editing"; reject / edit / withdraw
```

**activity** (`activity.ts`): the activity feed (newest first) and the notifications agents send to you
(`activity.notify`)

```tsx
const events = useStore(activity, selectActivityEvents);
await activity.loadOlder();                    // page backwards
const notes = useStore(activity, selectNotifications);   // the shell also shows a new notification as a toast
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

**errors**: the list of background failures (a failed load and so on). The shell shows them as toasts; a feature
usually does not need to read it.

## Capability checks (only to hide UI)

Built on the one role matrix of `@smurg/protocol` (`can()`). The code **never compares roles by rank** (SPEC §8 is not
monotonic). Hiding a button is cosmetic; the daemon checks every request.

```tsx
const canWrite = useCan('file.write');
const caps = useCapabilities();                // caps.can('admin'), caps.canCreateSession, caps.canDrive, caps.isHost, caps.role
caps.can('discuss');                           // vote, comment, mention, be responsible, review a report: everyone but a Viewer
drivesSession(caps, session);                  // types into this terminal / messages this agent and decides its suggestions (the host and members with agent access)
isRiskyRole(role);                             // the console asks the host to confirm the risk before it gives this role (Agent access)
<Can capability="suggest.create" fallback={null}><SuggestButton /></Can>
```

A capability says what a ROLE may do. Who decides a particular question, who may answer a particular permission
request, who reviews a particular report and who may end a particular session also depend on who is responsible for
the session and whether the thing has waited too long. Those rules are functions of `@smurg/protocol` shared with
the daemon (`maySubmit`, `mayAnswerInOwnWords`, `mayDecidePermission`, `mayAllowForTopic`, `mayReview`,
`mayBeResponsible`, `mayEndSession`): call them, never rebuild them from roles. The counts on a question card and its
prefilled answer come from the protocol's vote functions (`questionTally`, `leadingAnswer`), never from a tally of
your own. A control a member cannot use is absent, with the sentence that says who can.

## Cross-feature command bus

`lib/commands.ts`. Each command has exactly one handler (the feature that owns the behavior) and may have several
observers.

| Command | Payload | Handler |
|---|---|---|
| `openColumn` | `{ target: ColumnTarget, side?, from?: 'row' \| 'inbox', anchor?: { cardId?, seq? } }` | the shell. A click on a row replaces what the focused column shows; a link INSIDE a column passes `side: true`, so the column one is reading stays; `from: 'inbox'` opens to the side while the strip has room. A `console` target navigates to `/w/:id/console/:section`. Switches to the sessions view. Pins a plan column by default while its topic is executing |
| `setMode` | `{ mode: 'sessions' \| 'code' }` | the shell (a route change) |
| `openInCodeMode` | `{ root, file?, line?, sessionId? }` | the shell: the file tree shows that root, the file opens at the line, the session is shown beside the editor, and a line above the editor offers the way back |
| `newTopic` | `{}` | topics (an overlay) |
| `newSession` | `{ kind: 'agent' \| 'terminal' }` | agents (an overlay): a session without a topic, or a plain terminal |
| `sendSelectionAsSuggestion` | `{ file, startLine, endLine, text, sessionId?, mode?: 'send' \| 'draft' }` | conversation: "Send to agent" from an editor selection. It is a message from a member with agent access and a suggestion from anyone else; `draft` (the default) puts the quote into the composer to complete first |
| `openFile` | `{ file, line?, column? }` | editor |
| `revealFile` | `{ file }` | files |
| `startUpload` | `{ root, targetDir, source: UploadSource }` | transfer |
| `download` | `{ file, zip? }` | transfer |
| `showPanel` | `{ panel: 'files' \| 'editor' \| 'session' \| 'activity' \| 'conflicts' \| 'transfers' \| 'terminal' }` | code mode's layout (`Workbench.tsx`) |
| `redactEvent` | `{ sessionId, seq }` | console: the host's confirmation before ONE event of a conversation is replaced by "The host removed this entry." (`admin.transcript.redact`). Dispatched by a conversation's "Remove this entry…" |
| `reviewProjectSettings` | `{ root? }` | console: the host's review of the Claude Code project settings of that root, or of every root that has such files. Dispatched by the notice of a session that runs without them |
| `showHostRules` | `{}` | console: which of the host's own Claude Code allow rules apply to agents here. Dispatched by the permission dialog of a session |

```tsx
// the editor feature:
useCommandHandler('openFile', async ({ file, line }) => { await docs.open(file); /* scroll to line */ });
// anywhere else:
const openColumn = useCommand('openColumn');
await openColumn({ target: { kind: 'plan', topicId }, side: true });
```

A command without a handler rejects with `NoCommandHandlerError`; `commands.whenHandled(name)` resolves once a
handler exists (the shell uses it to open a file after code mode's chunk has loaded). A handler that a person can
reach from the first moment (`newSession`, the three commands of the console) is registered in the feature's
`slots.tsx` itself, which loads with the page; the dialog behind it is a lazy chunk. The three commands of the console
do nothing for anyone but the host.

Drag-and-drop upload: call `collectDrop(event.dataTransfer)` (`lib/drop.ts`) **synchronously** inside the `drop` event,
then dispatch `startUpload`.

## Feature slots

A feature never imports another feature, and the shell never imports a feature's column. There are two kinds of slot.

**In the sessions view: `features/<feature>/slots.tsx`** (as built: `lib/slots.ts`). A feature folder that
contributes something has ONE small file that exports `slots = defineSlots({ … })`. The shell finds every such file
by itself (`app/workspace/feature-slots.ts`, `import.meta.glob`), so adding a column kind never means editing a
shared file.

```tsx
import { lazy } from 'react';
import { defineSlots } from '../../lib/slots.ts';
export const slots = defineSlots({
  feature: 'topics',                                   // MUST equal the folder name
  columns: { plan: lazy(() => import('./PlanColumn.tsx')) },      // default export: the body of a column of that kind
  overlays: [lazy(() => import('./TopicOverlays.tsx'))],          // mounted once, in BOTH views
  menus: { topic: (topic, env) => [{ id: 'topic-rename', label: t('menu.rename'), onSelect: () => … }] },
  inboxRows: { attention: (item, base, env) => ({ ...base, action: { id: 'start-again', label: …, run: … } }) },
});
```

| Slot | What | Registered by (2026-10-07) |
|---|---|---|
| `columns.conversation` `{ sessionId }` | an agent session's conversation | `conversation` |
| `columns.terminal` `{ sessionId }` | a plain terminal | `agents` |
| `columns.spec` `{ topicId }`, `columns.plan` `{ topicId }`, `columns.report` `{ topicId, itemId }`, `columns.changes` `{ requestId }` | a topic's spec, its plan, a work item's result report, a merge request without a report | `topics` |
| `overlays` | components mounted once in the shell for as long as the workspace is open, in both views (not in the console page): dialogs, toasts, command handlers. Each in its own silent error boundary and `Suspense` | `agents` (New session), `conversation`, `topics` (New topic, the Start dialog), `console` (the handlers of `reviewProjectSettings`, `showHostRules` and `redactEvent`, and their three dialogs), `worktree` |
| `menus.session(session, env)` | extra items of a session row's context menu, after the shell's "Open" and "Open to the side" | `conversation` (an agent session: rename, end), `agents` (a terminal: attach, end, terminate) |
| `menus.topic(topic, env)` | a topic's "More actions", after the shell's "Watch its running sessions side by side" | `topics` (rename, restart the discussion, archive, restore, delete) |
| `inboxRows[kind](item, base, env)` | returns the row to show instead of the shell's default (`{ title, mono?, where, action? }`) for an inbox item of that kind | `topics` (`attention`) |

`env` is `{ stores, commands, capabilities, member }`. A column kind and an inbox kind belong to ONE feature: a second
claim throws `SlotConflictError` when the registry is built. A kind nobody registered shows the shell's placeholder,
so the shell works before a feature lands. Keep `slots.tsx` light: it loads with the workspace page, so components go
in with `React.lazy`, and Monaco, xterm and the conversation code load when a column of that kind is first shown
(`scripts/check-chunks.ts` guards the first load).

**In code mode and the console: fixed places.** `Workbench.tsx` puts the components below in fixed places, each
inside its own error boundary (`SlotBoundary` of `ui/`). Keep the export names and the props (none of them has props;
all data comes from hooks).

| File | Exports | Place |
|---|---|---|
| `features/files/index.tsx` | `FilesPanel` | Left pane (below the WorktreeSwitcher) |
| `features/worktree/index.tsx` | `WorktreeSwitcher` | Top of the left pane |
| `features/editor/index.tsx` | `EditorArea` | Center (the editor draws its own tabs) |
| `features/columns/index.tsx` | `SideColumn` | Right pane: ONE session column, the same body as in the sessions view, with a selector for which session |
| `features/activity/index.tsx` | `ActivityPanel`, `ConflictsPanel` | The "Activity" and "Conflicts" tabs of the bottom drawer |
| `features/transfer/index.tsx` | `TransfersPanel` | The "Transfers" tab of the bottom drawer |
| `features/agents/index.tsx` | `TerminalPanel` | The "Terminal" tab of the bottom drawer (plain terminals) |
| `features/console/index.tsx` | `HostConsolePage` (`section?`) | `/w/:id/console[/:section]` (only the host sees it) |

The shell owns the layout (which panes and the drawer are shown, and their sizes) and remembers it in the browser.
To bring a panel of code mode to the front, dispatch `showPanel`.

## Columns

As built: the frame, the strip and the rules (`features/columns`, `lib/columns/`, the `columns` store). The bodies
are the features' and are being finished; the table at the end of this section is the contract each is built to. The
frame works before a body lands: a kind nobody registered shows a placeholder.

A column shows one thing, and a thing is open at most once, so a column is identified by its target
(`lib/columns/target.ts`: the wire's `ColumnTarget` without the console; `columnId({ kind: 'report', topicId, itemId })`
is `report:<topic>:<item>`). A session column is a conversation or a terminal: which one is decided from the
session's kind when it is rendered.

**The rules** (the `columns` store's `open()`; UX §2 with the pin):

- a click on a row of the left column replaces what the focused column shows; "Open to the side" adds a column right
  of it;
- a pinned column is never replaced: the click then opens to the side, or replaces the nearest column that is not
  pinned. The plan is pinned by default while its topic is executing;
- an inbox item opens to the side while fewer columns are open than fit the window, and replaces only when the strip
  is full; it scrolls to its `anchor` (a card, or an event of the conversation);
- at most four columns; a fifth is refused with a notice.

**The frame is the shell's, the body is the feature's.** The frame (`ColumnFrame`) draws the region, the header (a
picture, the title as the region's `h2`, the topic's name, the pin, "More actions", close), the focus and the "seen"
mark. The body is the component a feature registered, and reads what it needs to know with `useColumn()`
(`lib/columns/context.tsx`):

```tsx
export default function PlanColumn({ topicId }: ColumnBodyProps['plan']) {
  const column = useColumn();                 // id, target, place ('strip' | 'code'), focused, visible, anchor, anchorShown()
  return (<>
    <ColumnMenuItems items={items} />                                     {/* into the header's "More actions" */}
    <ColumnHeaderExtra><Badge>Attempt 2 of 2</Badge></ColumnHeaderExtra>  {/* into the header, after the title */}
    <div className="col-toolbar">…</div>
    <div className="col-scroll"><div className="col-measure">…</div></div>
    <div className="col-foot">…</div>
  </>);
}
```

- **Do not draw a title.** The frame's `h2` is the region's name ("1 · Cart API", "Plan", "Result report: 3 · Receipt
  email"). Titles come from `lib/columns/describe.ts`, one wording with the session list.
- `column.visible`: the column's view is the one on screen and the column is not scrolled out of the strip. Hidden
  columns stay mounted and current; a conversation watches with `live: column.visible`, so a hidden column costs the
  relay no streaming frames.
- `column.focused`: the focused column, where a click on the left opens. Only its composer has the accent border.
- `column.anchor`: where an inbox item or a link led. Scroll there, focus the CARD (never one of its buttons),
  outline it for a moment, then call `column.anchorShown()`.
- Layout classes (`features/columns/columns.css`, loaded with the shell): `col-meta`, `col-toolbar`, `col-scroll`,
  `col-measure` (a readable measure, centred), `col-foot`. Every scrolling part of a column is `position: relative`
  (`col-scroll` is): a visually hidden label inside it otherwise makes the page taller than the window. The frame is
  a container (`container: column / inline-size`); use `@container column (max-width: 620px)` and `(max-width: 430px)`,
  the mock's two widths.
- The same body is mounted in code mode's side column (`place: 'code'`) through the same registry.

| Column | Built from | What it shows (contract: DESIGN §5.4, §5.12) |
 |
| Session (agent) | `features/conversation` | Next section. Header strip: who is responsible (a menu), the worktree (opens code mode on that root), the permission mode with the kinds that are always allowed (each removable) and the sentence about the host's own Claude Code rules, Stop. "End session" is in "More actions", absent for a discussion |
| Session (terminal) | `features/agents` | 0.4.0's terminal with its fit rules. It attaches while the column is on screen and detaches when it is hidden. It needs 80 columns, so below its minimum it scrolls sideways inside the column. The same terminals are the tabs of code mode's "Terminal" drawer tab |
| Spec | `features/topics` + the editor's document pane | Read: the Markdown renderer on the document's text, with who changed it last. Edit: the collaborative editor on `specs/<slug>/SPEC.md` (cursors, the lock banner, the deleted-file state). The box that asks the agent to revise; "Generate plan", which opens the plan beside it; at the foot the discussion's status line; the empty state before a spec exists |
| Plan | `features/topics` | The work items of `PlanInfo` with their state, sizes and dependencies; who is responsible, with "Assigned" and "No one assigned: everyone watches"; the agent's proposed split and "Suggest again"; the kinds allowed in the topic; what waits for whom; the paused banner. Start opens the Start dialog (`plan.preflight`, then `plan.start`). The file itself: the editor on `PLAN.md` |
| Report | `features/topics` + the worktree feature's diff review | The outcome, the sections under headings from the web catalog (the file's own headings are fixed English), the checks, the changes with "edited by hand" per file, follow-ups, "I've reviewed this", then "Merge" for the host |
| Changes | the worktree feature's diff review | A merge request without a report (a free session's worktree) |

## A conversation column

The store is as built (`lib/stores/conversations.ts`, `features/conversation/conversations-store.test.ts`), and so is
the Markdown renderer (`features/markdown`). The column's components (the event list, the cards, the header strip,
the status bar, the composer) are in the tree with their unit tests and are being finished; what follows is the
contract they are built to (DESIGN §5.5 and §5.12 items 10 to 17).

- **A window, not the whole log.** A conversation is an append-only log of events with a sequence number.
  `session.watch` gives the newest page (at most 500 events and 2 MiB); scrolling to the top loads earlier pages
  with `session.history`; after a reconnect the store continues from the last sequence number it has, or takes the
  newest page when it is too far behind. An event beyond a gap waits until the missing ones were read. An event that
  arrives again under a sequence number the window has REPLACES the old one (the host removed something). The list
  mounts the newest items plus what was paged in; leaving the top for the end drops the paged-in items again.
- **Folding.** The store folds events into the short list React renders, as they arrive: a person's message with its
  delivery state; a message smurg sent by itself (one line); the consecutive text blocks of one turn between tools;
  a tool call with its result (consecutive reads become one line; a subagent's events nest under its task); a card
  (a pointer to the entity in the store: question, permission request, suggestion); a next-step card; lines and
  notices. Items keep their identity between folds while nothing in them changed, so a memoised row does not render
  again.
- **Cards are entities.** A question with its votes and comments, a permission request and a suggestion change
  after they appeared; the log only says where the card is. Vote and comment changes arrive as small
  `question.changed` messages, never as the whole question. Focus lands on a card, never on one of its buttons, and
  never on Allow. A permission card shows the command whole, an edit's diff, any other tool's whole input.
- **Streaming without re-rendering.** `session.delta` carries text at most once per 200 ms. The store keeps it
  outside its state (`streamText`, `onStream`): the row appends to a DOM text node, and React state changes only when
  the finished `text` event arrives. Deltas are volatile: they are never replayed, which is why every open session is
  watched again after every Welcome, and why a delta that does not continue what the block holds stops the block
  until its text event. A hidden column watches with `live: false` and gets no deltas.
- **Follow the end** only while the view is at the end; otherwise a "New activity" button.
- **Budget, to be checked by the conversation feature's performance smoke:** a transcript of 5,000 events (1,000 of
  them tool cards with bodies) opens in under 300 ms of scripting, and a 60 s stream at 5 deltas per second keeps
  every frame under 16 ms of scripting.
- **Markdown** (`features/markdown`, as built): the tokens of `marked`'s lexer rendered to React elements by smurg's
  own renderer. No HTML string is ever injected; raw HTML in the text shows as text; links are `http`, `https` and
  `mailto` only, open in a new tab with `rel="noopener noreferrer"` and show their address; **images are not
  loaded** (an image is a link with its alt text: a remote image in agent text would make every viewer's browser
  contact a third party); code blocks are plain monospace; a path that resolves in the session's root is a button
  that opens the file; a member named with `@` is marked. A streaming block is parsed at most every 200 ms, and only
  its unstable tail again. The same renderer shows the spec's Read view and a report's sections.
- **Next-step cards.** Their text and buttons are the web's, from facts, never the model's prose: after the spec
  draft "Generate plan" for members with agent access and who can do it for the others; after the plan "Open plan";
  after a report "Open report" and who reviews it.
- **Composer.** `session.message.send` for the host and members with agent access; `suggest.create` for an Editor
  (the same box, with the line that says where the suggestion goes); no box for a Viewer. Enter sends, never while an
  input method is composing (`event.isComposing`). `@` opens the member picker and fills `mentions`. Unsent text is
  kept per session in this browser. The placeholder names the session.
- **Accessibility.** The conversation is a `log` region with `aria-live="off"`; the status bar above the composer is
  the `status` that speaks; streaming text is not announced delta by delta; every card is a `section` with an `h3`.

## Code mode

As built (`app/workspace/Workbench.tsx`, a lazy chunk; `features/columns/SideColumn.tsx`): 0.4.0's workbench with
three changes.

```
┌──────────┬─────────────────────────┬───────────────┐
│ worktree │                         │  one session  │
│ files    │  editor (tabs)          │  column       │
├──────────┴─────────────────────────┴───────────────┤
│ activity · conflicts · transfers · terminal        │  (bottom drawer)
└────────────────────────────────────────────────────┘
```

- The right pane is ONE session column: the same body as in the sessions view, with a selector for which session
  (remembered per browser and workspace).
- The drawer's tabs are Activity, Conflicts, Transfers and Terminal (plain terminals). There is no "Merge requests"
  tab: a merge request is an inbox item and a report or Changes column. The Terminal tab has no header bar of its
  own: the drawer is 220 px tall until someone drags it, and "New terminal" sits at the end of the terminals' tabs.
- The suggestions panel is gone.

`openInCodeMode { root, file?, line?, sessionId? }` switches the route, sets the file tree's root, opens the file and
shows that session in the side column; the line above the editor says where you came from and offers the way back.
The inbox stays one click away: the counts on the "Sessions" segment, and a toast with "Open" for a new item an
agent waits on. Contract, with the features that own it: a "Changed by this session" list above the file tree (from
the conversation's edit tool cards), and "Send to agent" from a selection filling the side column's composer. In a
work item's worktree the folder `specs/<topic>/` is read-only for everyone; the editor's read-only banner says why.

Panes are resizable (keyboard too). The minimums are in `layout-limits.ts`: the editor keeps 160 px beside the
session column and 240 px beside the file tree, the session column 320 px (never narrower than a column of the
sessions view), and what the file tree must leave to its right is the sum of what is shown there, so a wide
remembered file tree in a narrow window cannot squeeze the session column below its minimum.

## How the features of 0.4.0 map

| 0.4.0 | 0.5.0 |
|---|---|
| Agents panel with session tabs and terminals | The terminal pieces stay, for plain terminals; the tabs become the session list on the left and the columns |
| Closing an ended session's tab per browser | Dropped by the design: sessions belong to topics, and closing a column is the view action. Ended terminals still leave the list after 15 minutes |
| Suggestions panel and queue | Cards in the conversation and items in the inbox |
| Suggestions on a plain terminal | Dropped: a terminal takes no suggestion |
| Merge requests tab in the drawer | An inbox item, and a report column (or a Changes column) |
| "Attach from your own terminal" dialog | Kept, for terminal sessions only |
| The login line and "Check login again" | Kept: in the status bar above the composer and on a failed start |
| The Claude Code version warning | Kept for versions newer than the verified one; a Claude Code older than 2.1.288 refuses agent sessions with its own sentence |
| Activity feed, conflicts panel, transfers, worktree switcher, file tree, editor, lock banners, force release | Kept, in code mode. Lock banners also show in the spec and plan columns (they come with the editor's document pane) |
| The toast of an agent's notification to a member | Kept, and also a mention in the inbox |
| Host console | Kept, at its route. Its sessions section shows topic, purpose, status and who is responsible; new: the Claude Code project settings confirmation and the host's own Claude Code rules, each reached from the host's inbox item |
| Role risk dialog, invites, removing a member, audit log | Kept; the texts about removing, leaving and changing a role name what ends, what passes to the host and what is removed |

## Strings and languages

The app has two locales: `en` (the default, and the one that defines the keys) and `zh-TW`. Every text a person can
read is in the string catalog. Each feature defines its namespace in **its own** `features/<feature>/strings.ts`
(English) with the sibling `strings.zh-TW.ts` (the same keys in Traditional Chinese). `src/strings/index.ts` loads
every `features/*/strings.ts` by convention with `import.meta.glob`, so you **never edit an index**; a feature's
namespace is its folder's name. App-wide namespaces live in `src/strings/<namespace>.ts` +
`src/strings/<namespace>.zh-TW.ts` (`app`, `conn`, `join`, `stores`, `ui`, `workbench`).

Write the two files of a feature **in the same step**. The package is one TypeScript program and the index loads
every `features/*/strings.ts` eagerly: a `strings.ts` whose `strings.zh-TW.ts` does not exist yet makes every test
file of the package fail to load.

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
open dialog, a scroll position) is lost, terminals attach again and conversations are watched again as on any
remount. What lives in a store survives: the open columns, and the unsent text of a composer, which is kept per
session in this browser. A toast already on screen and error sentences already kept in a store keep the old language;
this is accepted. So do not cache translated text in module scope or in a store.

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

**What is never translated, and what is composed here.** Text that people or agents wrote (messages, questions and
their options, the spec, a plan's items, a report's sections) is shown as written. The lines and notices of a
conversation are message references of the host, rendered with `renderWireText`. An inbox row, a card's sentences, a
next-step card and a plan's badges are composed in the WEB catalog from structured fields (who, how many, which item,
how long): nothing parses an English fallback to find out what happened. A session's default name ("Discussion",
"2 · Payment form", "Claude (Ian)", "Terminal (Ian)") comes from the wire catalog through `sessionTitle()`.

**Checks.** `src/strings/strings.test.ts` checks every namespace: both languages have the same keys and the same
`{placeholders}` (in both plural forms too); English text holds no Chinese character and no full-width punctuation;
zh-TW text is Traditional Chinese except names, loanwords (`agent`, `worktree`, `session`, and the like), addresses
and bare templates; every key renders in both languages with sample values and leaves nothing unfilled; and no key is
unused (a feature's keys are looked for in the code of its own folder, so a deleted panel takes its strings along).
Features are found by convention: adding or deleting a feature folder needs no edit of the test.

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
  `-max` report what is on screen; logic in `src/ui/split-resize.ts`; the minimums of both views, including what the
  file tree leaves for the editor AND the session column, are in `src/app/workspace/layout-limits.ts`), `Menu`,
  `ContextMenu` (a menu at a point), `LanguageMenu`, `Panel`, `CopyButton`, `Kbd`, and the inline SVG icons of
  `icons.tsx` (do not use emoji as icons).
- **Added for the sessions view** (0.5.0): `Segmented` (`variant: 'radio' | 'links'`: the mode switch is the links
  form), `Collapsible`, `Card` (a `section` with an `h3`, focusable itself, `flash` to outline it for a moment,
  `settled`, `tone`, `footer`), `StatusGlyph` (`status`, and a `label` that is required), `KindIcon` (`kind`,
  `label`), `Chip`, `AvatarStack`, `Tree` (a real `tree` with roving focus; row actions through the context menu and
  the keys, no buttons nested in a row), `Columns` (the strip of resizable columns, on the arithmetic of
  `src/ui/columns-layout.ts`), `SlotBoundary` (the error boundary around a feature's component), `Avatar size="xs"`,
  and the focus helpers `focusSoon` and `neighbourAfterRemoval` ("focus the neighbour when this goes"). CSS:
  `ui-count` / `ui-count--waiting` (a count on a segment or a header).
- **Shared wording, do not write your own**: `src/lib/session-status.ts` (`sessionGlyph(session)`,
  `itemGlyph(item)`, `statusLabel(glyph)`, `phaseLabel(phase)`, `kindLabel(inboxKind)`: the session list, a column's
  header, the plan and the console say "Waiting for an answer" with the same words and glyph),
  `src/lib/columns/describe.ts` (`describeColumn`, `itemLabel({ number, title })`), `formatAge(at, now)` of
  `src/lib/format.ts` ("6 min") with `useNow(intervalMs, enabled?)` of `src/lib/use-now.ts` (the one clock hook of
  the app: no feature keeps a copy), `formatAnd(items)` for names or numbers inside a sentence ("Ian, Mei, and Amy")
  and `formatList(items)` for paths and commands (commas only).
- **Nothing is conveyed by colour alone**: every status glyph and kind icon has a name, and the two inbox counts are
  named ("2 waiting, 4 to look at").
- Style: a calm, information-dense workbench (like a code editor, not a marketing page). No decorative gradients; the
  focus ring is always visible; everything works with the keyboard.

## Monaco, xterm and marked (lazy loaded)

Load Monaco (about 3.8 MB) and xterm only through `src/lib/lazy.ts`:

```ts
const { createEditor, createSmurgModel, monaco, monacoThemeFor } = await loadMonaco();
const { createViewerTerminal } = await loadXterm();
```

**Never** `import` `lib/monaco.ts` or `lib/xterm.ts` directly: `scripts/check-chunks.ts`, run by `pnpm build`, fails
the build when they end up in the initial load. Since 0.5.0 that matters twice: the sessions view is the first thing
a member sees and must import neither statically. Code mode (`Workbench.tsx`) is a lazy chunk of the workspace page,
and a column's body is `React.lazy` in its feature's `slots.tsx`, so Monaco comes with the first editor (code mode,
or the Edit view of a spec or plan column), xterm with the first terminal, and the Markdown lexer `marked` (MIT, no
dependencies, pinned exactly, listed in the web app's third-party notices) with the first column that renders
Markdown.

- `lib/monaco.ts` (the configuration verified in yjs-monaco.md Q2): the slim entry point of 0.56+, the editor worker
  (`?worker`), `unicodeHighlight` allows zh-hant/zh-hans, `unusualLineTerminators: 'off'`, starts read-only (y-monaco
  is bound only after the first sync), `createSmurgModel()` forces LF. An alias in `vite.config.ts` maps y-monaco's
  deep imports to the same Monaco. Remote cursor styles use `lib/presence-css.ts`.
- `lib/xterm.ts` (verified in pty-packaging.md §6.2): `createViewerTerminal()` registers the **complete** query
  interception (DA1/DA2/DA3, DSR/CPR/DECXCPR, DECRQM, DECRQSS, XTWINOPS reports, OSC 4/10/11/12 queries; tested),
  applies resizes in stream order, and resets before it draws a snapshot. It comes with the web-links and unicode11
  addons (the fit addon is no longer used: `@xterm/addon-fit` is still in package.json and can be removed the next
  time the dependencies change).
- Terminal size (`features/agents/terminal-fit.ts`; terminal sessions only: an agent session has no PTY since
  0.5.0): the panel of **the person who opened the terminal** (the owner) decides the PTY size. The host and members
  with agent access may type in any terminal, but the size follows only the owner, so panels do not fight over it. Columns and rows are both computed from the visible area (`measureTerminal`
  in `viewer.ts` measures the panel, `planOwnerSize` computes the size). The size is sent with `session.attach`, and
  afterwards `exec.resize` is sent (150 ms debounce) when the panel size changes, a pane or the drawer opens or
  closes, the fonts finish loading, or the tab becomes visible again. The daemon applies `exec.resize` in stream order.
  Lower limit: the daemon's 20 × 5 for a terminal (the 80 × 24 floor that `terminal-fit.ts` still carries for
  Claude Code is a leftover of 0.4.0, when an agent was a program in a PTY; nothing uses it). When the panel is
  smaller than the limit, the terminal stays at the limit, the
  panel scrolls, and one line above it explains why (`data-testid="terminal-size-hint"`); nothing is cut off silently.
  Everyone else (and another window of the owner that does not drive the size) sees the terminal at the PTY's size.
  When that is larger than the panel it scrolls in both directions with the scrollbars always visible, and "Scale to
  fit the width" only draws it smaller; it does not rearrange the content. The viewport carries
  `data-cols`/`data-rows` (the actual size), `data-fit-cols`/`data-fit-rows` (the size that fits this panel) and
  `data-driving`, for tests.

## Roles, sessions and the activity feed (as built, protocol 4)

What protocol 4 means for everything a feature draws. The wire is `docs/ARCHITECTURE.md` §3 and §5; the stores above
carry all of it. Where a sentence is about a screen that a feature is still finishing, it is the contract that
screen is built to.

- **Protocol 4, no compatibility with 3.** Every payload is decoded with strict schemas, so the app and the host's
  smurg must speak the same protocol version; otherwise the page says "Incompatible versions". The shared relay
  serves one build of this app for every host (`docs/RELEASING.md` §4 step 3).
- **Two kinds of session.** `SessionInfo` is a union. A `TerminalSession` is a shell in a PTY (it has `cols` and
  `rows`, a stream, `exec.input`). An `AgentSession` is a conversation with Claude Code in its structured mode: no
  PTY, no size, nothing to type into; it has a `purpose` (`free`, a topic's `discussion`, a work item's `item`), a
  status, who is `responsible` (possibly nobody), a permission mode. Both carry `openedBy`. Use `isAgentSession` /
  `isTerminalSession` and `isSessionOver(session)`; never read a field of the other kind.
- **There is no guest sandbox and no agent of a guest's own.** Every session runs on the host's computer, as the host,
  with the host's Claude account. The dialogs that open one say so in one line.
- **Who may do what** (hide UI by these; the daemon enforces each):

  | | Host | Agent access | Editor | Viewer |
  |---|---|---|---|---|
  | Open a session, create a topic, generate and start a plan | yes | yes | no | no |
  | Type into a terminal (any terminal) | yes | yes | no | no |
  | Send a message to an agent (any agent session) | yes | yes | as a suggestion | no |
  | Accept or reject a suggestion | yes | yes | no | no |
  | Allow or deny a permission request | yes | yes, except the ones only the host can allow | no | no |
  | Vote and comment on a question, mention someone, be responsible, review a result report | yes | yes | yes | no |
  | Submit the answer to a question | the decider; the host at any time | the decider; anyone with agent access once it has waited too long | the decider, among the agent's options only | no |
  | Merge a request, confirm the project's Claude Code settings, remove one event of a conversation | yes | no | no | no |
  | Watch every conversation, earlier ones included | yes | yes | yes | yes |

  The decider of a question is the session's responsible person, or the member who opened the session when nobody is
  assigned (`deciderOf` and the `may*` functions of `@smurg/protocol`; "Capability checks"). Being responsible routes
  questions and reports to a person's inbox; it adds no right: a responsible Editor still cannot message the agent,
  and the composer says so.
- **Suggestions** go to agent sessions only (a terminal refuses one). A suggestion is a card in the conversation and
  one inbox row per author and session for the members who may accept it. What the accepting member sees is exactly
  what is sent; the card says when hidden characters were removed. Its author gets a result in the inbox when it was
  rejected or accepted after an edit.
- **The inbox** is derived by the daemon and is the member's own (`inbox.list` answers the caller's items). Kinds:
  a question to decide, an open vote, a permission request, work that stopped and needs someone ("attention": an
  agent that stopped without a report, a failed or unstarted item, plans paused by a restart, the host's account), a
  suggestion, a report to review, a merge (the host), a mention, a result. An item opens its `target` in a column and
  scrolls to its `anchor`; a console target navigates to the console's section. Rows are composed by
  `features/sidebar/inbox-rows.ts`; a feature overrides a kind through `inboxRows` only where it knows better.
- **Topics.** A topic has one discussion session, the files `specs/<slug>/SPEC.md` and `PLAN.md` in the project, and
  one execution session per work item, each in its own worktree. The plan's state (who is responsible, what runs,
  what is reviewed) is `PlanInfo`; the file only defines the items. A Start goes through `plan.preflight` (what it
  will do, who edited the files by hand, the commit it makes) and `plan.start`, which echoes the pins the dialog
  showed. Toasts for everyone on a change of phase come from the `topics` store's `notices`; they are not inbox items.
- **Session names**: `title` is only what a person typed (or the first words of a free session's first message).
  Without one, `sessionTitle()` renders the wire catalog's reference: `Terminal (Ian)`, `Claude (Ian)` for a free
  agent session, `Discussion`, `2 · Payment form` for a work item. An agent's display name in locks, presence and
  the activity feed follows its session (`Claude (Checkout)`, `Claude (Cart API)`, `Claude (Ian)`) and is never
  translated; the browser's device name is `Chrome (macOS)`, or `Browser` when the user agent says nothing.
- **Permission modes** of an agent session are two: asks before commands, or asks before edits and commands. A
  session's header shows the mode, the kinds that are always allowed (in this session, or in every session of its
  topic) and, for the host and members with agent access, which of the host's own Claude Code allow rules apply:
  agents run what those rules allow without asking, and the host is told once which ones they are.
- **The host's side that everyone may know** (`host` store): whether the host's Claude Code is logged in or has
  reached a usage limit, and whether the main folder's Claude Code project settings are used. Until the host has
  confirmed those settings, sessions run without them and say so; the confirmation dialog is the console feature's
  and is also mounted in the sessions view for the host.
- **After a restart of the host's smurg** nothing runs by itself: conversations are readable, sessions are idle,
  every plan is paused, and the banner offers "Continue all" to members with agent access. A session whose agent
  process ended is `failed` until the next message or "Try again".
- **New session** (`features/agents/new-session.ts`, `NewSessionDialog.tsx`): the host and members with agent access
  see the same options (the main workspace, a new worktree, a worktree they kept), and one line says that the session
  runs on the host's computer with the host's Claude account (`data-testid="new-session-runs-as"`).
- **Terminals in two places.** In the sessions view a terminal is a column; in code mode the same terminals are the
  tabs of the drawer's "Terminal" tab (`TerminalPanel`). 0.4.0's per-browser closing of an ended session's tab is
  gone with the session tabs: closing a column is the view action, and an ended terminal leaves the list by itself.
- **Console**: the role list is Agent access / Editor / Viewer. When the host picks Agent access for a new invite or
  for a member's role, a confirmation dialog shows the risk first (`features/console/RoleRiskDialog.tsx`,
  `data-testid="role-risk-text"`), and nothing is sent until the host clicks the "I understand, …" button; Cancel
  sends nothing. Removing a member, a member leaving and a role change say what ends (terminals and sessions without
  a topic), what passes to the host (the sessions of a topic) and what is removed with the member.
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

**Three layers** (DESIGN §5.11).

1. **Unit** (vitest + jsdom, a `FakeConnection` that validates every payload against the protocol registry): each
   store's folding and lifecycle; the columns (open, replace, to the side, pin, a fifth refused, close, focus,
   widths, persistence); the left column (tree keys, fixed rows, filter, inbox groups and the two counts, unread);
   each card by role (decider, voter, an Editor who decides, Viewer; host-only; escalated; the note); the composer by
   role and the input-method guard; Markdown (no HTML, no image request, link schemes); the plan, Start dialog and
   report columns by state; one zh-TW suite per feature folder.
2. **The built app in system Chrome** (`e2e/smoke`, a real relay, a real daemon, headless Chrome; never a person's
   own browser). A smoke that needs an agent runs the daemon with the scripted stand-in `claude` of the daemon's test
   tools (`packages/daemon/src/testing/fake-claude.mjs`, installed with `installFakeClaude`): it speaks Claude Code's
   structured protocol and does what a scenario file says, so neither a maintainer's machine nor CI needs Claude
   Code or an account.
3. **Real Claude Code against the repository's fake Anthropic API** (only when the verified version, 2.1.288, is
   there; never a real account): one pass of discussion, question, spec, plan, one work item and its report through
   the built app.

**Language in tests.**

- Every test starts in English: `src/testing/setup.ts` applies `en` before each test and again after it (and clears
  `localStorage`, where the columns store keeps a member's view). Nothing under test reads `navigator.languages`, a
  cookie or localStorage implicitly.
- `useTestLocale('zh-TW')` (`src/testing/locale.ts`) pins a file, or one `describe`, to Traditional Chinese. Use it
  only in `*.zh-TW.test.tsx` files: one per feature folder, which renders the feature, asserts a handful of zh-TW
  strings and `document.documentElement.lang === 'zh-Hant-TW'` (the platform's own is `src/app/app.zh-TW.test.tsx`).
  Inside a single test of another file, `applyLocale('zh-TW')` from `src/lib/locale.ts` switches for that test only
  (the setup file resets it).
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
The shared harness is `e2e/smoke/helpers.ts`: `startSmoke`, `joinAs`, `joinAsHost` (the host's own link comes from
`daemon.internals.invites.createHostInvite()`); a member lands in the SESSIONS VIEW, so `toCodeMode(page)` /
`toSessionsView(page)` use the top bar's mode switch (both views stay mounted: the helpers that read a terminal look
only in the view on screen), `openDrawer(page)` unfolds code mode's drawer; `columnOf(page, title)` is a column's
region, `rowOf(page, title)` a row of the session list, `openFromList(page, title, { side })` opens one;
`openTerminal(page, title, { worktree })` and `openAgentSession(page, { title, first, worktree })` go through the
session list's "New" control and resolve with the session's id; `terminalOf`, `typeInTerminal`,
`waitForTerminalText`, `terminalShows`. Every step waits for a condition, never for a fixed time. A smoke that needs
an agent passes `stack.sessions: { claudePath: (await installFakeClaude(dir, scenario)).path, selfCommand }` and never
a `modules` list: the daemon's default list is the release's.

The smokes that came from 0.4.0, as they are in the new shell:

| File | Acceptance criteria |
|---|---|
| `built-app.smoke.test.ts` | Join with an invite link -> the sessions view -> code mode -> open a file -> type -> the disk; R7.1b two browsers editing at once; R8.2b the read-only notice under an agent's lock; a member with agent access opens a terminal from the session list (a column; it runs as the host's user); CSP |
| `splitter.smoke.test.ts` | The three dividers of code mode under a real mouse (file tree \| editor \| session column, and the drawer): a hover never moves a divider; a press within 3 px on either side grabs the line without moving it and the line then follows the pointer; a drag stops on the release wherever the pointer is; a drag that loses its release ends with the button; the terminal in the drawer still refits (a taller drawer, more rows); arrow keys resize, a double click comes back to the default width and the width survives a reload; in a window too small for the remembered width every pane keeps its minimum, and each separator's `aria-valuenow` / `aria-valuemax` is the size on screen |
| `login.smoke.test.ts` | Loading `/` and `/join/<id>` without a login: zero console errors, zero failed requests; the CLI's device-code login |
| `language.smoke.test.ts` | An `en-US` browser: landing, join, the sessions view, code mode with the activity feed (the host's own sentences), an error and the host console with its audit log, each followed by a scan of the whole document for CJK characters; the language menu switches to 繁體中文 without a navigation; `<html lang>`, the stored choice and the cookie follow; the choice survives a reload; the relay's `/device` follows the cookie; detection (`zh-HK` is Traditional Chinese, `zh-CN` and `ja` get English) and the relay's own language link is followed by the app |
| `zh-TW.smoke.test.ts` | The old path in Traditional Chinese (`locale: 'zh-TW'`): join through an invite link, the sessions view, a terminal in a column (an editor watches it read-only), code mode with the host's sentence in the activity feed, and `/device`. A suggestion accepted on a zh-TW page is `conversation.smoke` |
| `acceptance.smoke.test.ts` | R11.1c one-click terminate and remove in the console; R9 worktree merge (asked for from code mode's worktree switcher; the host's inbox item opens the full diff in a Changes column; merge; the worktree is unchanged after a reject); R8.4 a real conflict appears in the conflicts panel of code mode; a member with agent access opens their own terminal (it runs as the host's user) and types directly in the host's terminal, an editor only watches; the console's risk confirmation before it gives agent access (an invite and a role change). 0.4.0's R6 test and suggestion steps typed into a terminal and are deleted: `conversation.smoke` has the suggestion flow |
| `transfer-resume.smoke.test.ts` | R7.3: `drop-proxy.ts` (a TCP proxy in front of the relay) cuts the transfer socket in the middle of an upload; the upload resumes by itself and completes, the content is identical, and only the missing part is sent again |

The smokes 0.5.0 added, one per feature, each against the stand-in `claude`: `columns.smoke` (the dividers of the
strip under a real mouse) and `sidebar.smoke` (the shell), `terminal.smoke` (a terminal as a column),
`conversation.smoke` and `conversation.perf.smoke` (the budget of "A conversation column"), `topics.smoke`,
`console.smoke`. The ones that cross features are the integration's: `flow.smoke` (the whole flow with four browser
contexts: a host, a member with agent access, an Editor, a Viewer), `flow.zh-TW.smoke` (the same path in Traditional
Chinese, with a topic named in Chinese) and `flow.claude.smoke` (layer 3 above). `docs/ACCEPTANCE.md` ("T topics
flow") names the rows they prove.

Without a system Chrome these tests are skipped and the reason is printed.

`src/testing/`:

- `FakeConnection`: a connection you drive by hand. `conn.admit(makeWelcome({ role }))`,
  `conn.emit('session.state', …)`, `conn.handle('file.tree', () => …)` (answers automatically),
  `conn.respond(type, result)` / `conn.fail(type, error)` (answers the oldest pending request),
  `conn.requestsOf(type)`, `conn.notificationsOf(type)`, `conn.hostOffline()`, `conn.keyMismatch()`, `conn.kicked()`…
  Payloads sent and received are validated with the protocol registry, so fixtures cannot drift from the real format.
- `renderInWorkspace(<FilesPanel />, { role: 'editor' })`: renders inside a workspace driven by a FakeConnection and
  returns `{ conn, stores, session }`. Options: `role`, `userId`, `displayName`, and `slots` (what the features
  registered, for this test: `slots: [{ feature: 'x', columns: { plan: Fake } }]`; the default is nothing, so every
  column shows the frame's placeholder).
- `renderInColumn(<YourColumn … />, { target, focused?, visible?, place? })` (`columns.tsx`): renders a column's body
  the way the frame would. `view.column.set({ visible: false })` (the other view is shown: the body should stop
  watching live), `view.column.anchor({ cardId })` (an inbox item was opened), `view.column.anchorsShown()`,
  `view.column.menuItems()`, `view.column.header`.
- `setupStores({ role })` (`stores.ts`): a set of workspace stores on a FakeConnection, without React, for the tests
  of the stores themselves.
- `createTestServices()` / `renderApp()`: the whole App (a memory router, a fake login, a memory pin store).
- `fixtures.ts`: `makeWelcome`, `makeSession` (a terminal), `makeAgentSession`, `makeEntry`, `makeSuggestion`,
  `makeConflict`, `makeInvite`… Entities of protocol 4 (a question, a permission request, a topic, a plan, a report,
  an inbox item) come from the protocol's own builders, `@smurg/protocol/testing`, which every package shares.
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

`scripts/check-chunks.ts` follows the entry chunk's static imports and fails the build when code that only Monaco or
xterm contain is reachable from the first page load. In 0.5.0 the first thing a member sees after joining is the
sessions view, so the rule now guards three steps: the landing and join pages, the workspace page with the sessions
view (no Monaco, no xterm), and only then code mode and the columns that need an editor or a terminal.

The last measurement is 0.4.0's (2026-10-02, both languages): the initial load is 2 chunks, 736.1 KiB (224.5 KiB
gzip). It contains React, the protocol (zod, the noble cryptography, msgpack), the strings and the join flow. Before
the second language it was 628.6 KiB (194.9 KiB gzip): both language tables of the web catalog and the wire catalog
(`@smurg/protocol/i18n`, every sentence the host can send, in both languages) load eagerly, which adds about 108 KiB
(30 KiB gzip). The workspace chunk was 288 KiB (82 KiB gzip). The Monaco chunks are about 3.8 MiB (977 KiB gzip)
plus the editor worker, CSS and codicon, and the xterm chunk is 352 KiB (91 KiB gzip). All of these are in
lazy-loaded chunks. 0.5.0 adds catalog text, the stores of the sessions view and one dependency (`marked`); its
numbers are measured when the release is verified and replace these.
