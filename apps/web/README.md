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
3. **The host shares a folder.** The simplest way is `scripts/dev-stack.sh --stand-in-claude` (run it in the repo
   root). It starts the relay, Vite and `smurg host` (a sample git project, a fake HOME) in one go, prints the host's
   link and the invite link (http://localhost:5173/join/…), and Ctrl-C stops everything. With `--stand-in-claude`
   the stack's agent sessions run a scripted stand-in for Claude Code (no account, no network, nothing is billed);
   `--real-claude` runs the Claude Code of this computer with the login it finds, which is your own account. Without
   either switch and with a `claude` on `PATH`, the script says before it starts anything that agent sessions will
   run the real Claude Code with your login, and refuses (exit 2) when nobody is at a terminal.
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
cannot start. `scripts/dev-stack.sh --stand-in-claude` puts the scripted stand-in first on the stack's `PATH`
instead: it follows `<dir>/stand-in-claude/fake-claude-scenario.json`, read again at every turn (send `try write`,
`try run` or `try ask` to see an edit, a command with its permission request, or a question). No test uses a real
Claude Code account: the tests of this package drive a `FakeConnection`, and the built-app smokes run the daemon
with the same stand-in `claude` of `packages/daemon/src/testing/` ("Tests").

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
│   ├── chunks.ts            loadChunk / lazyChunk: THE way a part of the page is loaded later, and what a load that
│   │                        failed is called (ChunkLoadError: gone, offline, failed)
│   ├── page-build.ts        Is this tab the page the relay serves now? (asked after a `version` refusal)
│   ├── lazy.ts              loadMonaco() / loadXterm()
│   ├── monaco.ts xterm.ts   Heavy modules (load them only through lazy.ts)
│   ├── presence-css.ts      CSS for y-monaco's remote cursors
│   ├── drop.ts              Drag and drop -> UploadSource (call it synchronously inside the drop event)
│   └── format.ts errors.ts preferences.ts color.ts store.ts router.ts use-now.ts clock.ts agent-work.ts
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
session column and drawer) is per browser: `localStorage['smurg.layout']` (`layout.ts`; a browser that ran 0.4.0
holds this key in 0.4.0's shape and pane widths under names that are gone: `readLayout` and `carryOldPanelSettings`
carry what still means something, once, when the page starts, and remove the rest). Which columns are open, their
order, widths and pins, what was seen, the session list's folds and filter, and the session beside the editor in code
mode are per browser AND workspace: `localStorage['smurg.columns.<workspace id>']` (the `columns` store). None of it
is sent anywhere: a member's view is their own. The unsent text of a composer is kept per browser and workspace as
well (`localStorage['smurg.drafts.<workspace id>']`), and it is the one thing here that is deleted when a person's
access to the workspace ends, because it can quote project code ("A conversation column", Drafts). A deletion
leaves a mark behind, so that another tab does not write the texts back: for one workspace
`localStorage['smurg.drafts-forgotten.<workspace id>']`, after a logout `localStorage['smurg.drafts-forgotten']`
(random values; the second names no workspace).

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
| `rejected(version)` | The refusal carries no numbers, so the page asks the relay whether it still serves this tab's page (`lib/page-build.ts`: `GET /` past every cache, the entry script named there against the one this document names) and says which side has to act: **"This tab is from before an update"** (reload), **"The host's smurg is older than this page"** (the host stops sharing, runs `smurg update`, shares again; a host with their own relay deploys it again; then reload), or both steps when the relay cannot be asked. Never "nothing to do": a refusal is final until the page is reloaded | Yes |
| `closed(storage-error)` after the key store stopped at a record a NEWER page wrote | **"This browser's smurg key was written by a newer page"** (reload). The key store never replaces a record whose `v` it does not know (`@smurg/protocol/browser` `'newer-record'`); `keyStorage.newerRecord` (`lib/connection/browser-deps.ts`) is how the page knows why | Yes |
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
| `redactEvent` | `{ sessionId, seq }` | console: the host's confirmation before ONE event of a conversation is replaced by "The host removed this entry." (`admin.transcript.redact`). Dispatched by a conversation's "Remove this entry…". The dialog has three lines: what everyone sees in the entry's place; that Claude Code keeps its own record (`redact.memory`); and what else keeps the entry's words: questions, permission requests, suggestions, inbox items, a report's follow-up questions and the audit log's full text, until the topic is deleted (`redact.copies.topic`), or, for a session without a topic, that nothing removes those (`redact.copies.free`; `redact.copies` while the page does not know the session) |
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
import { lazyChunk } from '../../lib/chunks.ts';
import { defineSlots } from '../../lib/slots.ts';
export const slots = defineSlots({
  feature: 'topics',                                   // MUST equal the folder name
  columns: { plan: lazyChunk(() => import('./PlanColumn.tsx')) }, // default export: the body of a column of that kind
  overlays: [lazyChunk(() => import('./TopicOverlays.tsx'))],     // mounted once, in BOTH views
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
in with `lazyChunk` (`lib/chunks.ts`: `React.lazy` behind the one helper every `import()` of a chunk goes through, see
"A part of the page that does not load"), and Monaco, xterm and the conversation code load when a column of that kind
is first shown (`scripts/check-chunks.ts` guards the first load).

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

- **Do not draw a title.** The frame's `h2` is the column's title ("1 · Cart API", "Plan", "Result report: 3 · Receipt
  email"). Titles come from `lib/columns/describe.ts`, one wording with the session list. The region's accessible
  name is `columnName(description)` (`features/columns/ColumnFrame.tsx`): the title, and for a column whose title
  is the same word in every topic or may repeat between topics (a discussion, the spec, the plan, a result report)
  the title with its topic, "Plan · Checkout redesign". The header's buttons ("Close column: Plan · Checkout
  redesign"), the divider behind the column and the title's tooltip carry the same name, so two plans side by side
  can be told apart; the title on screen is unchanged.
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
|---|---|---|
| Session (agent) | `features/conversation` | Next section. Header strip: who is responsible (a menu), the worktree (opens code mode on that root), the permission mode with the kinds that are always allowed (each removable) and the sentence about the host's own Claude Code rules, Stop. "End session" is in "More actions", absent for a discussion |
| Session (terminal) | `features/agents` | 0.4.0's terminal with its fit rules. It attaches while the column is on screen and detaches when it is hidden. It needs 80 columns, so below its minimum it scrolls sideways inside the column. The same terminals are the tabs of code mode's "Terminal" drawer tab |
| Spec | `features/topics` + the editor's document pane | Read: the Markdown renderer on the document's text, with who changed it last. Edit: the collaborative editor on `specs/<slug>/SPEC.md` (cursors, the lock banner, the deleted-file state). The box that asks the agent to revise; "Generate plan", which opens the plan beside it; at the foot the discussion's status line; the empty state before a spec exists |
| Plan | `features/topics` | The work items of `PlanInfo` with their state, sizes and dependencies; who is responsible, with "Assigned" and "No one assigned: everyone watches"; the agent's proposed split and "Suggest again"; the kinds allowed in the topic; what waits for whom; the paused banner. Start opens the Start dialog (`plan.preflight`, then `plan.start`). The file itself: the editor on `PLAN.md` |
| Report | `features/topics` + the worktree feature's diff review | The outcome, the sections under headings from the web catalog (the file's own headings are fixed English), the checks, the changes with "edited by hand" per file, follow-ups, "I've reviewed this", then "Merge" for the host. At the foot the follow-up box; it gives way to "This item is merged and its session has ended. Ask in the discussion." (`report.closed`) only when the item is merged, reviewed AND its session has ended: while smurg keeps the session (the worktree holds changes no merge carried) the box stays |
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
  a tool call with its result (consecutive reads become one line; a subagent's events would nest under its task, and
  no session of 0.5.0 starts a subagent); a card (a pointer to the entity in the store: question, permission
  request, suggestion); a next-step card; lines and notices. Items keep their identity between folds while nothing
  in them changed, so a memoised row does not render again.
- **A row that cannot be drawn costs one row.** Every row has its own error boundary (`RowBoundary` in `rows.tsx`):
  a row that throws while rendering is the line "This entry cannot be shown." (`row.failed`) with the host's "Remove
  this entry", and the other entries, the waiting cards and the composer stay. The row is drawn again when its item
  is replaced (the entry was removed, a card was settled).
- **Cards are entities.** A question with its votes and comments, a permission request and a suggestion change
  after they appeared; the log only says where the card is. Vote and comment changes arrive as small
  `question.changed` messages, never as the whole question. Focus lands on a card, never on one of its buttons, and
  never on Allow.
- **What a person approves is what they see.** A permission card shows the command whole, an edit's diff, any other
  tool's whole input, each part in a box of its own that scrolls when the part is long; nothing scrolls sideways
  (the command wraps, and in this card the diff wraps too, where a tool line's diff scrolls). While a box does not
  show all of its part, the line under it says how many lines the part has ("{count} lines: scroll this box to read
  all of them.", `perm.more`), and "Allow once" and "Always allow this kind" stay disabled until every such box was
  scrolled to its end ("Allow is available once you have scrolled to the end of what is asked.", `perm.readFirst`);
  a box that was at its end once stays read, and "Deny" is never held back. A suggestion card shows the stored text
  CHARACTER FOR CHARACTER (`PlainText` of `features/markdown`, never as Markdown): "Accept" sends exactly that text.
  The daemon sends a card's command, address and input with every character nobody can see written out as
  `<U+202E>` (`docs/ARCHITECTURE.md` §5.9); `showControls` (`text.ts`) still marks such characters in what is sent
  as it is, a diff among it. Under what is asked the card prints why: "Claude Code's reason: …" with Claude
  Code's own English reason (`perm.reason`), or, for a request that smurg's own tool gate asked for
  (`request.gate`, ARCHITECTURE §7.7 G10), the web's sentence for that gate in the reader's language
  (`perm.gate.writes-settings-script`, `perm.gate.may-reach-settings-script`). Their English texts are the
  daemon's two sentences word for word; the daemon's `reason` is not printed beside them.
- **Streaming without re-rendering.** `session.delta` carries text at most once per 200 ms. The store keeps it
  outside its state (`streamText`, `onStream`): the row appends to a DOM text node, and React state changes only when
  the finished `text` event arrives. Deltas are volatile: they are never replayed, which is why every open session is
  watched again after every Welcome, and why a delta that does not continue what the block holds stops the block
  until its text event. A hidden column watches with `live: false` and gets no deltas.
- **Follow the end** only while the view is at the end; otherwise a "New activity" button.
- **Budget, checked by `e2e/smoke/conversation.perf.smoke.test.ts`:** a transcript of 5,000 events (1,000 of
  them tool cards with bodies) opens in under 300 ms of scripting, and a 60 s stream at 5 deltas per second keeps
  every frame under 16 ms of scripting. Measured on 2026-10-07 (macOS arm64, system Chrome): 59.1 ms to open a
  transcript of 5,007 events with 200 rows mounted; in the stream, 1.18 ms per 200 ms interval at the median and
  8.06 ms at the worst. The same file pins what a column of dear texts costs: 400 messages of the dearest text that
  stays inside its own budget (one 16 KiB paragraph, about 70 ms to format) are shown at once, as written, and
  formatted while the page has nothing more urgent to do; no task is longer than 200 ms once they are on screen
  (measured: 77 ms), and a click is answered within 500 ms meanwhile.
- **Markdown** (`features/markdown`, as built): the tokens of `marked`'s lexer rendered to React elements by smurg's
  own renderer. No HTML string is ever injected; raw HTML in the text shows as text; links are `http`, `https` and
  `mailto` only, open in a new tab with `rel="noopener noreferrer"` and show their address on hover and on keyboard
  focus; **images are not loaded** (an image is a link with its alt text: a remote image in agent text would make
  every viewer's browser contact a third party); code blocks are plain monospace; a path that resolves in the
  session's root is a button that opens the file; a member named with `@` is marked. A streaming block is parsed at
  most every 200 ms, and only its unstable tail again. The same renderer shows the spec's Read view and a report's
  sections.
  - **The lexer runs inside bounds** (`lex.ts`, the one place the app hands text to `marked`). The text of a member
    or an agent is rendered in every member's browser, so it must neither throw out of the render (a crashed column
    takes its composer and its open cards along) nor hold the page's only thread. A text over `MARKDOWN_MAX_CHARS`
    (1 MiB); one paragraph, cell or heading over `MARKDOWN_MAX_INLINE_CHARS` (16 KiB); quotes, lists or marks nested
    deeper than `MARKDOWN_MAX_DEPTH` (32); more than `MARKDOWN_MAX_STEPS` (50,000) steps of the lexer; or a parse
    over its time budget (`parseBudgetMs`: 40 ms plus 1 ms per 4 KiB of text; the longest single step is not
    counted, up to `PAUSE_MAX_MS`, 200 ms, because one step that stood still is a pause of the machine) is NOT
    formatted. It is one token of type `plain`: the text as it was written, under the note "Shown as it was written:
    this text is too long or too deeply nested to format." (`plain.note`). Whatever the lexer throws is caught the
    same way. What ran out of time or steps is remembered by a hash of its characters (the newest
    `REMEMBERED_MAX`, 1,024) and shown as written wherever it is mounted again, at the cost of the hash. What is
    remembered is the PIECE the budget ran out on: a message is one piece, a `SPEC.md` is cut at its `##` headings
    (the spec column, `<MarkdownPieces>`) and has the one budget of the whole text. Every text that holds that
    piece shows it as written and formats the rest; a text that no longer holds it is formatted whole. The pieces
    behind the one it ran out on wait and get the budget once more; a text in pieces that runs out a second time is
    over as a whole (one note, remembered as a whole), so a text costs two budgets at most. The page has a share
    too: the parses a mount waits for take at most `URGENT_PARSE_MS` (200 ms) and `URGENT_PARSE_STEPS` (50,000
    steps: texts that are parsed in no time and are tens of thousands of elements to build) in any
    `URGENT_WINDOW_MS` (1 s). A text that comes after the share is spent is shown as written for the moment,
    without a note, and formatted when the browser has nothing more urgent to do (`idle.ts`): one slice of
    `SLICE_MS` (30 ms) at a time, at least one text a slice, what is on screen first and the newest first, each
    slice a task of its own (a background-priority task; a timer where a browser has none). Not a React transition,
    which renders everything that is left in one piece once it is five seconds old, and not `requestIdleCallback`,
    which Chrome does not call while the pointer rests on a button whose menu was just closed. The lexer's
    expressions are compiled by a text of smurg's own before the first parse, so a short text is never shown as
    written because it came first.
  - **What the two budgets leave open.** "Two budgets at most" is said of one text, and a text that changed is a
    new text. Typing in a `SPEC.md` that is over its time budget can cost up to two budgets a keystroke until every
    slow section is remembered: the Read view stays mounted behind the Edit view and parses what is typed, each
    spent budget leaves one more piece remembered, and the same text again costs its hash. And what waits behind
    the piece a text ran out on comes back as ONE task of up to the text's whole budget, not in slices: a slice
    never cuts one text, and to the queue a spec is one text. Measured on a 990 KiB spec of 62 hostile sections:
    two tasks of 0.42 s for each of the first 26 keystrokes. A spec of ordinary sections does not come near its
    budget (it is about ten times what `marked` needs for ordinary text). The perf smoke's "no task over 200 ms"
    is pinned for messages, each its own piece.
  - **Nothing of a text is hidden.** What Markdown keeps out of sight is put on the page: a reference definition is
    printed as its line (and still resolves `[text][1]`); a destination that is not a link stays in the text as it
    was written; a link's or an image's title is printed after it; the whole line after a code fence stands above
    the code; a link without text shows its address; a link that contains an image is shown as written; and a link
    or an image whose words name another place than it leads to is drawn as its words followed by the destination
    as the link (`github.com (https://evil.example/)`, "Image: github.com/logo.png (https://…)"). Words are read as
    a place (`links.ts`, `namesAnotherPlace`) when they are an address (`https://…`, `www.…`, a mail address, a
    number address), a host with a path under any ending (`smurg.sh/install`), or a bare host under one of about
    fifty well-known endings (`.com`, `.org`, `.io`, `.dev`, `.tw` …). Characters that only look like ASCII are read
    as what they look like (NFKC, one character at a time: full-width letters, a one-dot leader; a Chinese full stop
    between two labels of other scripts is the dot). Characters a reader cannot see (zero width joiners and spaces,
    a soft hyphen, variation selectors, tags: Unicode's default ignorable characters) are not read, and words that
    had one beside the dot of a name are written out with the destination wherever the link leads. No list of
    look-alike letters is complete, so a dotted name with ANY letter from outside ASCII is never taken at its word:
    a link whose words hold one always has its destination written out, even when it leads to the very name it
    shows (a browser opens the name's `xn--` form). The one exception is words that are the name of the file the
    link leads to (the last part of its path, decoded): `résumé.pdf` on a link to that file is an ordinary link,
    unless a dot of the name is followed by what a host ends in or by letters from outside ASCII. Chinese, Japanese
    and Korean characters around a Latin name are the sentence it stands in, not part of the name. Words longer than
    `LABEL_MAX_CHARS` (1,024 units) are written out with the destination unread, and an address whose host part is
    longer than a host name can be (253 characters and a port, `lib/web-address.ts`) is not a link. A bare two-part
    word under any other ending is not read as a place (no spelling tells `github.lol` from `README.md` or
    `event.target`): such a link keeps its destination behind hover and keyboard focus, like every ordinary link.
    A numeric character reference never becomes a character nobody can see (`&#x202E;`, `&#8203;` and `&#27;` stay
    as typed: `entities.ts`).
  - **Which look-alikes are still an ordinary link.** Nothing more is read as a place than the bullet above says
    (whether more should be, or every link should show its host, is an open question for the owner;
    `docs/ARCHITECTURE.md` §12 has the same list). A link is drawn as an ordinary link, with its real destination
    behind hover and keyboard focus only, when
    - the "dot" is a character that looks like one and that NFKC does not turn into one: `github<U+0660>com` (the
      Arabic-Indic digit zero), U+A4F8, U+06D4, U+0702, the raised dots U+00B7, U+2219, U+22C5, U+30FB, U+2027.
      (Read as the dot: `.`, U+FF0E, U+2024, U+FE52, and U+3002 / U+FF61 between two letters of scripts written
      with spaces.);
    - a character that a browser draws with almost no width and that is NOT in Unicode's default ignorable list
      stands between a name and its dot: U+FFFC, the hair space U+200A (which NFKC reads as a space), and U+007F
      in a `SPEC.md` (the daemon takes it out of a message and of an agent's text).
      `[github<U+FFFC>.com](https://evil.example/login)` is two words that name nothing to `namesAnotherPlace`,
      and no test covers it;
    - the name is written backwards behind a right-to-left override (`<U+202E>moc.buhtig`): the daemon removes
      the override from a message and from an agent's text, so this can stand only in a `SPEC.md` or another
      document the daemon does not clean;
    - it is a bare ASCII word under an unlisted ending (`amazon.in`, `bbc.it`, `github.lol`). The same word with a
      look-alike letter IS written out, unless it is also the name of the file the link leads to:
      `[<U+0430>mazon.in](https://evil.example/<U+0430>mazon.in)` (the Cyrillic letter that looks like a Latin "a")
      is an ordinary link, a file name under an unlisted ending, because the owner of a destination writes its
      path.

    To the safe side the rule errs as well: "le café.Ensuite" (no space after the full stop, a letter from outside
    ASCII beside it) is written out with the destination although it names no place.
  - **A render has no time budget**, so whatever looks at a piece of text while rendering is a single pass over its
    characters: no regular expression that is tried again from every character of a long run, and no call of
    `normalize`, of a collator (`localeCompare`, `Intl.Collator`) or of the address parser (`new URL`) on a text
    whose length someone else chose: each of them puts a run of combining marks in order at the cost of the square
    of the run. `test/text-cost.test.tsx` walks hostile texts through every such function and keeps the lists of
    every regular expression and of every such call, by file.
  - **Path lookups are bounded.** A path is looked up when its element comes on screen, and at most
    `MAX_PATH_LOOKUPS` (32) different paths of one text are asked about, each once. Every lookup of a conversation
    and of a terminal goes through ONE gate per connection (`features/agents/path-links.ts`, `pathGateOf`): a name
    the reader's role can never open (a host-private name, the daemon's `.smurg`) is not asked about
    (`mayAskAbout`); one request is out until the host has answered one without refusing, and again after every
    refusal, else at most `MAX_LOOKUPS_IN_FLIGHT` (4); a refused path is never asked about again, while the names
    that wait are still asked (one refused name turns no other link of the page off); and a page collects at most
    `REFUSALS_PER_MINUTE` (8) refusals in any `REFUSAL_WINDOW_MS` (60 s): when that many have come back, everything
    that waits is answered without a request and nothing is asked until the oldest of them is that old. So a text
    can cost its reader a handful of refused requests, never one per name: the daemon records a refusal (a name
    through a link that leads out of the workspace, too many requests) under the asker's name and closes a
    connection that collects 60 in a minute. A lookup of a place the reader may not look at (a host-private file, a
    hard-linked file, a path through a file) answers "not found" and is neither recorded nor counted
    (`docs/ARCHITECTURE.md` §5.2).
- **Next-step cards.** Their text and buttons are the web's, from facts, never the model's prose: after the spec
  draft "Generate plan" for members with agent access and who can do it for the others; after the plan "Open plan";
  after a report "Open report" and who reviews it.
- **Composer.** `session.message.send` for the host and members with agent access; `suggest.create` for an Editor
  (the same box, with the line that says where the suggestion goes); no box for a Viewer. Enter sends, never while an
  input method is composing (`event.isComposing`). `@` opens the member picker and fills `mentions`. The placeholder
  names the session.
- **Drafts.** Unsent text is kept per session in this browser (`features/conversation/drafts.ts`,
  `localStorage['smurg.drafts.<workspace id>']`, at most `DRAFTS_MAX`, 50, sessions). A draft can quote project code
  ("Send to agent" puts a selection into it), so unlike a pane's width it must not stay in the browser of someone
  whose access has ended. It is deleted (`lib/workspace/drafts-storage.ts`) when the daemon removed the member or
  revoked the device, or finds the browser logged in as another account, whatever page shows the workspace at that
  moment; on "Leave"; on "Log out", for every workspace of this browser, once the logout has succeeded (a failed
  logout leaves the person logged in, with their texts; a successful one also closes every workspace session the
  page still held); and when a workspace is taken off the list of recent ones. A page that still shows the
  workspace stops writing at the same moment. A closed page, a host that is away, an expired login or an outdated
  client delete nothing.
  Deleted stays deleted: another tab that still shows the workspace holds its drafts in memory and would write its
  whole map at the next keystroke. So a deletion also changes a MARK in localStorage, and a store looks at the
  marks before every write (`forgottenMarks`): `smurg.drafts-forgotten.<workspace id>` for one workspace's
  deletion (a removal, a revoked device, another account's browser, "Leave", taking it off the list),
  `smurg.drafts-forgotten` for a logout,
  which takes the workspaces' marks away with the drafts. A mark is a random value: it names no time, and the
  browser's one names no workspace. A store whose workspace's mark or the browser's mark changed, or whose own
  entry is gone from the storage (a full storage takes a deletion and not its mark), writes nothing from then on;
  a deletion of ANOTHER workspace's drafts changes neither, so two tabs on one workspace go on keeping theirs.
- **The status bar** (`StatusBar.tsx`, above the composer) never cuts a sentence. The state and its age are one
  piece; the second sentence (the host's account, a refused action) stands beside them when both fit and on a line
  of its own, wrapping like text, when they do not; in a column too narrow for the state its words wrap. The
  buttons are one piece after the sentences (`.conv-status__actions`). ONE button stands beside the sentences in
  any column. With TWO (a member with agent access while Claude Code is logged out on the host: "Show it" or "Try
  again", and "Check login again"; an idle long discussion: "Write the spec now" and "Start a fresh conversation")
  the line of sentences asks for 24 em, so where the buttons do not fit beside that they go to a line of their
  own below, at the end, and the sentences have the bar's whole width; three buttons wrap there. The price: with
  two buttons and one short sentence ("Claude is idle.") the buttons go below in columns where they would have
  fitted beside it. `conversation.smoke.test.ts` pins 320, 380, 420 and 1,100 px in both languages.
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
  tab: a merge request is an inbox item and a report or Changes column. A merge row of the host's inbox opens the
  item's RESULT REPORT when that report is about the row's request (`inboxTarget` in `features/sidebar/inbox-rows.ts`:
  the report's `changes.requestId` is the row's): the outcome, the checks and "Merge…" are there, and after a
  conflict "Ask the agent to resolve" in the report's foot. Any other request opens the Changes column of that
  request: a free session's worktree, a work item nobody reported on, an archived topic, and a request somebody
  made after the report (a hand edit in the item's worktree, then "Request merge"). The report must be in the
  store to know, so the inbox asks about it when the row appears (`reportsToLoad`, `knowReport`: once per item,
  and "there is no report" is remembered) and a click opens the right column at once. A click that comes before
  the answer opens the report's column, which shows that it is loading; when the report turns out to be about
  another request, or there is none, the Changes column takes its place in the same column
  (`features/sidebar/InboxList.tsx` `useOpenInboxItem`). The Terminal tab has no header
  bar of its own: the drawer is 220 px tall until someone drags it, and "New terminal" sits at the end of the
  terminals' tabs.
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
function. Order names with `compareText` (the viewer's language; it cuts long runs of combining marks before the
collator sees them) and ids or keys with `compareIds` (their UTF-16 units): never `localeCompare` or a collator
of your own, which `test/text-cost.test.tsx` lists by file ("A conversation column", "A render has no time
budget").

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
  the app: no feature keeps a copy), `formatAnd(items)` for names or numbers inside a sentence ("Ian, Mei, and Amy";
  zh-TW sets its word for "and" apart from Latin text), `formatList(items)` for paths and commands (commas only)
  and `joinSentences([...])` for two sentences in one line (no space after a full-width full stop).
- **The clock is the host's and there is one**: `useNow` returns the browser's time corrected by the difference
  measured at the Welcome (`stores.workspace` `clockSkewMs`), because every time the daemon stamps is a time of the
  host's computer; `useLocalNow` is for a time this browser set itself (a retry countdown, an unsaved edit). All
  callers share the timer of `src/lib/clock.ts`: an age under a minute is printed to the second, so while one is on
  screen every caller that shows ages is redrawn each second and one wait reads the same on its card, its status
  bar, its inbox row and the plan. `Date.now()` is not compared with a time from the host.
- **A live region does not hold a counter**: the status bar's `role="status"` is its sentence; the age stands beside
  it (a region that changes each second is read out each second).
- **Nothing is conveyed by colour alone**: every status glyph and kind icon has a name, and the two inbox counts are
  named ("2 waiting, 4 to look at").
- Style: a calm, information-dense workbench (like a code editor, not a marketing page). No decorative gradients; the
  focus ring is always visible; everything works with the keyboard.

## A part of the page that does not load

The relay serves the app as files named after their content, and answers an address it has no file for with the page
itself. A tab that stays open across a deploy of the web app therefore asks, the first time it shows a column, a
dialog, code mode, the editor or a terminal, for a file that may be gone, and the browser refuses the HTML it gets as
a script. `lib/chunks.ts` is the one place that deals with it:

```ts
const PlanColumn = lazyChunk(() => import('./PlanColumn.tsx'));          // a component: a slot, a route, a dialog
const monaco = await loadChunk(() => import('./monaco.ts'));             // anything else
void loadChunk(() => import('./dialogs.tsx')).then(open).catch(reportChunkFailure);   // no place of its own
```

- **Every `import()` of a chunk under `src/` goes through `loadChunk` or `lazyChunk`**, and `React.lazy` is used by
  the helper alone: `src/lib/chunks.test.tsx` reads the source tree and fails for one that does not.
- A load that fails becomes one named error, `ChunkLoadError`, whose `reason` was ASKED of the server (one request for
  the file the browser named, past every cache): `'gone'` (the answer is the page itself, or "not found": the web app
  was deployed again), `'offline'` (the request fails), `'failed'` (the file is there). "smurg was updated" is said
  only for `'gone'`.
- Who shows it, with the same words (`ui/ChunkNotice.tsx`): `SlotBoundary` in the slot's place; `PageBoundary`
  (`app/PageBoundary.tsx`, around the routes) for the workspace route and code mode, instead of an empty page; the
  editor and a terminal in their own place; and the workspace's banner (`ChunkFailureBanner`) for a failure without a
  place: a `silent` slot (an overlay) and anything handed to `reportChunkFailure`.
- **The one action is "Reload the page".** A browser keeps a failed import for as long as the page lives (run in
  Chrome 155: the same `import()` fails again after the file is served fine), so nothing offers to try again.
- Unit tests never ask a network: `src/testing/setup.ts` pins the reason to `'failed'`; a test sets its own with
  `setChunkProbe`. In a real browser: `e2e/smoke/update.smoke.test.ts`.

A deploy of the relay should keep the files of the previous build beside the new ones (`docs/RELEASING.md`); this is
what a tab sees when one did not.

## Monaco, xterm and marked (lazy loaded)

Load Monaco (about 3.8 MB) and xterm only through `src/lib/lazy.ts`:

```ts
const { createEditor, createSmurgModel, monaco, monacoThemeFor } = await loadMonaco();
const { createViewerTerminal } = await loadXterm();
```

**Never** `import` `lib/monaco.ts` or `lib/xterm.ts` directly: `scripts/check-chunks.ts`, run by `pnpm build`, fails
the build when they end up in the initial load. Since 0.5.0 that matters twice: the sessions view is the first thing
a member sees and must import neither statically. Code mode (`Workbench.tsx`) is a lazy chunk of the workspace page,
and a column's body is a `lazyChunk` in its feature's `slots.tsx`, so Monaco comes with the first editor (code mode,
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
  agent session, `Discussion`, `2 · Payment form` for a work item. An agent's display name in locks, presence, its
  caret in a document and the activity feed follows its session (`Claude (Cart API)` for a work item, `Claude
  (Checkout)` for a topic's discussion, `Claude (Ian)` for a free session: `agentSessionName` of `@smurg/protocol`)
  and is never translated. In `presence.state` an agent has an `activeFile` only while it is at work (starting,
  running, or waiting inside a turn for an answer or a permission). The browser's device name is `Chrome (macOS)`,
  or `Browser` when the user agent says nothing.
- **Permission modes** of an agent session are two: asks before commands, or asks before edits and commands. A
  session's header shows the mode, the kinds that are always allowed (in this session, or in every session of its
  topic) and, for the host and members with agent access, which of the host's own Claude Code allow rules apply:
  agents run what those rules allow without asking, and the host is told about each of them once.
- **The host's side that everyone may know** (`host` store): whether the host's Claude Code is logged in or has
  reached a usage limit, and whether the main folder's Claude Code project settings are used. Until the host has
  confirmed those settings, sessions run without them and say so; the confirmation dialog is the console feature's
  and is also mounted in the sessions view for the host. The review (`ProjectSettingsReview.tsx`) says what it
  cannot show or guard: a script a command names where no file is yet is marked "named, not there yet"
  (`claudeConfig.script.absent`), with one sentence under the list that such a path is guarded like the others
  and that a file appearing there asks the host again (`claudeConfig.scripts.absentNote`); and the commands whose
  files smurg cannot follow are counted in the warning above the lists (`claudeConfig.unfollowed`), beside what
  the lists leave out or cut short.
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
   report columns by state; one zh-TW suite per feature folder; and what a text costs the page that shows it
   (`test/text-cost.test.tsx`: hostile texts at one size and at sixteen times that size through every function
   that looks at text someone else wrote, the renderer's budgets, and the pinned lists of "A render has no time
   budget"; `features/markdown/idle.test.ts`: the queue of texts that wait).
2. **The built app in system Chrome** (`e2e/smoke`, a real relay, a real daemon, headless Chrome; never a person's
   own browser). A smoke that needs an agent runs the daemon with the scripted stand-in `claude` of the daemon's test
   tools (`packages/daemon/src/testing/fake-claude.mjs`, installed with `installFakeClaude`): it speaks Claude Code's
   structured protocol and does what a scenario file says, so neither a maintainer's machine nor CI needs Claude
   Code or an account.
3. **Real Claude Code against the repository's fake Anthropic API** (`e2e/smoke/flow.claude.smoke.test.ts`; never a
   real account): one short pass through the built app on the real binary: a session without a topic, its first
   message, a tool, a command that a member with agent access allows and that really runs, a question and its
   answer. It runs only when `SMURG_TEST_CLAUDE_BIN=/absolute/path` names a Claude Code of the verified version,
   2.1.288; it never takes a `claude` from `PATH`, and skips loudly otherwise. A topic on the real binary is tested
   at the daemon (`packages/daemon/test/sessions/agent-claude-real.test.ts`), not in a browser.

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
| `update.smoke.test.ts` | A tab across a deploy of the web app (0.5.1): the relay answers a file it does not have with the page itself; with every file under `/assets/` answered so, a column whose chunk was not loaded says "smurg was updated" with "Reload the page" (English and Traditional Chinese), code mode says it for the whole page instead of going empty and the back button returns to the sessions view, and the reload brings the workspace and the terminal back; without the network the same column says offline, never "updated" |
| `version.smoke.test.ts` | A page the host's smurg refuses for its version (0.5.1): this file's daemon speaks another protocol number than the built page. The page asks the relay for `/` (once, no cache, no cookie, inside its own Content-Security-Policy) and says "The host's smurg is older than this page" with what the host does; with `/` naming another entry script it says "This tab is from before an update"; also in Traditional Chinese |

The smokes 0.5.0 added, one per feature, each against the stand-in `claude`: `columns.smoke` (the dividers of the
strip under a real mouse) and `sidebar.smoke` (the shell), `terminal.smoke` (a terminal as a column),
`conversation.smoke` and `conversation.perf.smoke` (the budget of "A conversation column"), `topics.smoke`,
`console.smoke`. `conversation.smoke.test.ts` has five tests: a session without a topic with its first message, a
tool line and a permission request; a question with votes in every browser; an Editor's message as a suggestion;
Stop; and `conversation.smoke.test.ts` › "what a person approves is what they see: every character of a suggestion,
the end of a long command, an edit that does not leave its box sideways; a text that cannot be formatted leaves the
column standing". Three cross the features:

| File | What it walks through |
|---|---|
| `flow.smoke.test.ts` | The owner's whole flow as ONE story in 23 tests, four browser contexts: Ian (Host), Mei (Agent access, on a zh-TW page), Amy (Editor), Leo (Viewer). New topic with the folder's project settings confirmed in the dialog; a question in two parts with votes, a comment, a mention, a tie and the submit; the spec, edited by two people while the agent waits its turn; a revision asked for as a suggestion; Generate plan, the proposed split, the Start dialog and its commit; three sessions side by side (T4.3); a spec edit that disarms an item; permission cards (once, never-always, always in this topic); a question nobody answers until the host submits for its decider; an agent that stops without a report; a partial report, a follow-up and "I've reviewed this"; the merge from the host's inbox, a merge conflict the agent resolves; the topic complete; the mode switch (T7.1); one more work item; a restart of the host's smurg with "Continue all"; a killed agent process and "Try again"; and at the end what the Viewer could not do, and what the flow sent through the relay. About 114 s |
| `flow.zh-TW.smoke.test.ts` | The short path of the flow by a host on a zh-TW page, with a topic named in Chinese, and an Editor on an English page (T8.2): at every stop the Chinese page holds no label nobody translated (`untranslatedTexts`), the English page no Chinese besides what people and the agent wrote (`cjkTexts`) |
| `flow.claude.smoke.test.ts` | Layer 3 above |

`e2e/smoke/flow-env.ts` is the flow's own stack: the same parts as `startSmoke`, but the daemon can restart in the
middle of the story on the same folder and state while the four browsers stay open (`restartDaemon`), one agent
process can be killed, the host's account is named, and the relay runs with its test tap so that `frames()` counts
what the whole flow sent through it. `helpers.ts` gained `launchPages` (the browser and its pages without a stack)
and `JoinEnv` (what the join helpers need of either stack) for it. `SMURG_SMOKE_SHOTS=<folder>` makes the flow
smokes (and `console.smoke`) write a numbered picture per step and person, and `flow.smoke` a `flow-measure.json`.
`SMURG_SMOKE_SCHEME=dark` runs every smoke, and takes those pictures, in the dark theme (headless Chrome prefers
light, so without it the app's default theme is never on a picture).
`docs/ACCEPTANCE.md` ("T topics flow") names the rows they prove.

Without a system Chrome these tests are skipped and the reason is printed. `e2e/chrome.ts` looks for Google Chrome
in its usual places; `SMURG_TEST_CHROME=/absolute/path` names a browser somewhere else (the Linux arm64 VM, for
which Google ships no Chrome, runs the smokes on a Chrome for Testing that way). Nothing is ever downloaded, and a
path that does not exist means "no Chrome".

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

The last measurement is 0.5.0's (2026-10-07, both languages): the initial load is 6 chunks, 980.2 KiB (298.7 KiB
gzip). It contains React, the protocol (zod, the noble cryptography, msgpack), the strings and the wire catalog in
both languages, the join flow and the stores of the sessions view. The sessions view adds 144.4 KiB (41.1 KiB gzip)
on top of it, most of it the workspace chunk (129.9 KiB, 35.7 KiB gzip). What loads only when it is needed: a
conversation column 71.9 KiB (20.4 KiB gzip), the Markdown renderer with `marked` 57.1 KiB (19.1 KiB gzip), code
mode's workbench 68.7 KiB (20.0 KiB gzip), the Monaco chunks about 3.8 MiB (977 KiB gzip) plus the editor worker,
CSS and codicon, and the xterm chunk 352 KiB (91 KiB gzip). 0.4.0's initial load was 2 chunks, 736.1 KiB (224.5 KiB
gzip), with a workspace chunk of 288 KiB (82 KiB gzip): 0.5.0 loads more at first (the catalog text of the new
features and the stores of the sessions view) and less when the workspace opens.
