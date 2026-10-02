# smurg Architecture (Prototype)

> Companion to `SPEC.md`. SPEC.md says **what**; this document says **how**, and is the contract that
> lets `protocol`, `daemon`, `relay`, `cli` and `web` be built in parallel.
> Verified technical findings live in `docs/research/*.md` — read the one for your area before coding.

**Precedence:** `SPEC.md` > this document > `docs/research/*.md`. The research reports were written before the
decisions below were taken; where a report disagrees with this document, this document wins. The reports remain the
authority for *verified facts*, exact API usage and gotchas. Deliberate departures from the wording of SPEC.md are
listed in §11 with their reason.

---

## 0. Rules for everyone who writes or runs code in this repo

These exist because of real incidents during the research phase (two spikes killed unrelated processes by scanning
the process table).

1. **Process signals.** Only ever signal a pid or process group that *your own code spawned and recorded*.
   Never `pkill`, `killall`, `kill -1`, or "every process that matches predicate X". Before `process.kill(-pgid)`
   assert `Number.isInteger(pgid) && pgid > 1 && pgid !== process.pid && pgid !== <own pgid>`.
   Tests may only kill processes started by that test.
2. **No credentials.** Never read, print, copy or enter real credentials. Automated tests use the mock Anthropic API
   (`ANTHROPIC_BASE_URL` on 127.0.0.1, dummy key, isolated `HOME` / `CLAUDE_CONFIG_DIR`) and the relay's dev-only login.
   Tests that need a real account are opt-in (`SMURG_TEST_CLAUDE=1`, `SMURG_TEST_OAUTH=1`) and are never run unprompted.
3. **No browser cookie import**, no use of logged-in browser sessions. Browsers are for localhost pages and public docs.
4. **Nothing global.** No global npm installs, no edits to `~/.claude`, `~/.ssh`, shell rc files, system settings.
   Tools that write global state get redirected (`XDG_CONFIG_HOME=<repo>/.xdg`, `WRANGLER_SEND_METRICS=false`,
   `npm_config_cache=<repo>/.tools/npm-cache`; all set by `scripts/env.sh`). Run tests through pnpm, never `npm exec` /
   `npx`. Run gstack browse from a scratch directory (it writes `.gstack/` into its cwd). Tests remove what they create:
   the relay and e2e vitest projects give their forks a private `TMPDIR` that the project's global teardown deletes
   (miniflare would otherwise leave its state behind). The daemon's socket directory is the one test directory that may
   not live below a long `TMPDIR` (Unix socket paths are limited, §7.1): tests use `createTempRunDir()` from
   `@smurg/daemon/testing` (the OS temp dir when short enough, else `/tmp`). A test worker can die hard (a native
   crash) before its cleanup: every temp dir the test helpers create and every long-lived process a test starts (a
   `nohup` job, a local relay's `workerd`, a daemon fixture) is registered with the run
   (`packages/daemon/src/testing/run-registry.ts`, a vitest globalSetup of the root and of every project), and after the
   run the registry removes what is still there AND still the same thing (directory dev/ino, a marker in the process's
   command line) — never anything selected by a name pattern — and says so on stderr. Test browsers are launched with
   `chromeLaunchOptions()` (`apps/web/e2e/chrome.ts`): no name resolves except loopback (Chrome otherwise downloads
   components from Google even with a fresh profile) and Chrome's temp files go to the test's `TMPDIR`
   (`MAC_CHROMIUM_TMPDIR`; on macOS Chrome ignores `TMPDIR`).
5. **Never block the daemon's event loop** (`spawnSync`, `execSync`, long synchronous diffs): the hook socket lives in
   it.
6. **Fail closed.** Hooks, path checks and permission checks deny when anything is uncertain.

---

## 1. Repository layout

```
smurg/
├── apps/
│   ├── web/            React + Vite SPA (Monaco, Yjs, xterm.js)
│   ├── relay/          Cloudflare Worker + Durable Objects (WorkspaceDO, TransferDO, DeviceLoginDO); also serves the web SPA
│   └── site/           smurg.ai product page in both languages (static files + a Worker for a few redirects; www is a
│                       zone rule)
├── packages/
│   ├── protocol/       zod schemas, roles/capabilities, Noise channel, framing, invite links, client SDK,
│   │                   locale detection (`/locale`) and the wire message catalog (`/i18n`)
│   ├── daemon/         host-side daemon (library + hook/MCP entry points)
│   └── cli/            `smurg` binary: host / attach / stop / update / uninstall (+ internal: hook, mcp, login)
├── tests/
│   ├── e2e/            cross-package acceptance tests (relay + daemon + headless clients)
│   └── lint/           repository-wide checks of the language rules (§10)
├── docs/               ARCHITECTURE.md, GLOSSARY.md, HOSTING.md / JOINING.md (+ zh-TW/), RELEASING.md, research/, ACCEPTANCE.md
└── scripts/            dev + packaging scripts
```

Also at the root: `README.md` / `README.zh-TW.md`, `CHANGELOG.md`, `LICENSE` (MIT), `NOTICE`, `SECURITY.md`,
`CONTRIBUTING.md`; `packages/protocol/test-vectors/README.md` names the origin and licenses of the vendored Noise test
vectors (`cacophony.txt`: Unlicense; `snow.txt`: Apache-2.0 OR MIT).

- pnpm workspaces, TypeScript (strict, ESM, `"type": "module"`), vitest for all tests.
- **Node:** `engines.node ^22.18.0 || ^24.0.0`; develop and test on **Node 22 LTS** (`.nvmrc`). Node 23 and 25 are
  outside vitest 5's supported range. `source scripts/env.sh` puts the right Node and a repo-local pnpm on `PATH`.
- **Source-first packages:** workspace packages export their TypeScript sources; `erasableSyntaxOnly` +
  `allowImportingTsExtensions` so Node runs `.ts` directly. `tsc` is type-check only. Release bundles are made with
  esbuild (CLI/daemon → CJS for Node SEA), Vite (web) and wrangler (relay).
- Package names: `@smurg/protocol`, `@smurg/daemon`, `@smurg/cli`, `@smurg/web`, `@smurg/relay`, `@smurg/e2e`.

### Pinned dependencies (verified in research)

| Area | Packages |
|---|---|
| protocol | `zod@4.6.5`, `@msgpack/msgpack@3.1.3`, `@noble/curves@2.4.0`, `@noble/ciphers@2.4.0`, `@noble/hashes@2.4.0`, `yjs@13.6.33`, `y-protocols@1.0.7`, `lib0@0.2.118` |
| daemon | `node-pty@1.2.0-beta.15` (not 1.1.0), `@xterm/headless@6.0.0`, `@xterm/addon-serialize@0.14.0`, `@parcel/watcher@2.6.0`, `fast-diff@1.3.0`, `diff@9.0.0`, `yazl@3.3.1`, `jose@6.2.12`, `ws@8.22.0` |
| relay | `wrangler@4.142.0`, `jose@6.2.12` |
| web | `react@19.3.0`, `react-dom@19.3.0`, `vite@8.3.1`, `@vitejs/plugin-react@6.1.1`, `monaco-editor@0.57.0`, `y-monaco@0.1.6`, `@xterm/xterm@6.0.0` |
| dev | `typescript@7.0.2`, `vitest@5.0.2`, `esbuild@0.28.2`, `playwright-core@1.63.0` (drives system Chrome, no browser download) |

Rejected with evidence (do not reintroduce): `noise-handshake`, `noise-protocol`, `noise-c.wasm`, `@libp2p/noise`,
`diff-match-patch`, `node-diff3`, `chokidar`, `archiver`, `zip-stream`, `fflate` (as zip writer),
`@monaco-editor/react`, `vite-plugin-monaco-editor`, `@cloudflare/vitest-pool-workers`, bun as daemon runtime.
- Identifiers, message types and file names are English. Languages: see "Languages" below.
- `tests/e2e` is an addition to the layout in SPEC §6: acceptance tests need a home that can depend on every package.

### Languages (English and Traditional Chinese)

Two locales, `en` (the default, and the source of truth for keys) and `zh-TW`. `docs/GLOSSARY.md` binds the terms.

1. **The language is the viewer's.** A process chooses a language only for text it shows to its own user: the browser
   for the web app, a CLI process for its own output, the relay Worker per request for its HTML pages, `sh` for the
   installer, the URL for smurg.ai. One detection rule, in `@smurg/protocol/locale` (`matchLanguageTag`,
   `localeFromLanguages`, `localeFromAcceptLanguage`, `localeFromEnv`; shared test table `/locale/test-table`); the
   installer's `pick_lang` is the same rule in POSIX sh. A choice a person made wins over detection: `SMURG_LANG`
   (`en` / `zh-TW`) for the CLI and the installer (§8), the web app's language menu (§9), the `?lang=` links of the
   relay's pages (§6); both of the latter write the cookie `smurg_lang`. smurg.ai never chooses: English pages at
   `/`, `/docs/…`, `/license/`, their Traditional Chinese counterparts under `/zh-TW/`, each page linking to its
   counterpart (a visible link and `<link rel="alternate" hreflang>`), and a generated `/sitemap.xml` that lists
   every page with its alternates (`apps/site/scripts/site.ts`). `/github` and `/source` there are 302s to the
   source repository, next to `/install.sh` (`apps/site/src/routes.ts`).
2. **The daemon and the relay's JSON API never choose a display language.** Everything they write for people travels
   as a `code` / `reason` + a message reference `{ id, params }` (`MessageRef`) + an English rendering as the
   fallback (§4.3, §5.4). There is no locale in `ClientHello`. A client renders
   `render(locale, ref) ?? <the English fallback>`.
3. **Text with one shared audience or a machine reader is fixed English**: PTY bytes, hook deny reasons (§7.7), MCP
   tool texts, git commit messages smurg writes (`smurg: worktree changes by {name}`, `Merge {branch} ({name})`), logs,
   audit action and reason codes, maintainer and developer scripts.
4. **Text written by a person or an agent is never translated**: a suggestion, a merge message, a reject reason, a
   session title someone typed, `notify_member` text, display names, file names.
5. **Names that are stored and shown to everyone have one language-neutral spelling**: the agent of a session is
   `Claude (Ian)` (`agentDisplayName(owner)` in `@smurg/protocol`, the only function that spells it); device names
   are `Chrome (macOS)` / `smurg CLI (<hostname>)`; the relay's fallback user name is `Google user`.
6. **No source file outside a zh-TW catalog or a zh-TW document contains CJK** (`tests/lint/no-cjk.test.ts`).

Catalogs (who owns which text):

| Catalog | Where | Holds |
|---|---|---|
| Wire catalog | `packages/protocol/src/i18n/` (`@smurg/protocol/i18n`) | every text the daemon or the client SDK originates and a client shows: error sentences, activity sentences, daemon-written notifications, client-side request failures, the default text per error code, role labels, the default session titles. Functions of typed parameters, both locales side by side; ids are `area.thing[.variant]` |
| Web catalog | `apps/web/src/strings/*.ts`, `apps/web/src/features/*/strings.ts` (+ `*.zh-TW.ts`) | everything the web app itself says |
| CLI catalog | `packages/cli/src/i18n/{en,zh-TW}.ts` | everything the CLI itself says |
| Relay pages | `apps/relay/src/lib/strings.ts` | the Worker's HTML pages |
| Installer | `scripts/install.sh` (`msg 'english' 'zh-TW'`) | the installer's messages |

Wire catalog API: `message(params, { en, 'zh-TW' })` defines a message; `msg(id, params)` makes a typed reference
(the daemon); `render(locale, ref)` returns the text or `undefined` (unknown id, a parameter of the wrong type: the
reference is untrusted wire input, so the caller shows the English fallback); `renderEnglish(ref)` is what the daemon
writes into `message` / `summary` / `fallback`. Parameters are strings, numbers, booleans and lists of at most 10
strings; the sender clips them (a path to 200 characters, at most 3 sample paths, at most 5 holder names). Byte
sizes are numbers (`formatBytes` formats them the same way in both locales). No sentence is built from fragments:
git steps are a `step` parameter with a table of names per locale inside the catalog (`GIT_STEPS`), file change
kinds a `change` parameter (`FILE_CHANGES`).

### Dependency rules

```
protocol  ← daemon ← cli
protocol  ← web
protocol  ← cli
relay     (no dependency on protocol's crypto; may import `@smurg/protocol/relay` and `@smurg/protocol/locale` only)
```

`protocol` must run unchanged in Node ≥ 22, browsers, and must not import Node built-ins from its
browser-reachable entry points (`@smurg/protocol`, `@smurg/protocol/client`, `/browser`, `/relay`, `/locale`,
`/i18n`). Node-only helpers go in `@smurg/protocol/node`. `/locale` imports nothing at all; `/i18n` imports only its
own files and `/locale` (no zod, no crypto); the barrel reaches `/i18n` because `SmurgError` renders its English
message from a reference. `packages/protocol/test/entry-boundaries.test.ts` checks all of this.

---

## 2. Trust model in one page

| Party | Trusted for | Not trusted for |
|---|---|---|
| Daemon (host machine) | everything; sole authority for permissions | — |
| Relay | availability, asserting *who logged in* (signed identity token) | confidentiality, integrity of content, the daemon's identity |
| Client (web/cli) | nothing | every request is validated + authorised by the daemon |
| Sessions (agent/terminal), whoever opened them | what the host's own OS account may do: they run as the host, unsandboxed (§11 D-15) | hook/MCP socket input is untrusted; a member who may open or drive sessions (`agent` role) is trusted by the host like the host's own account (§12) |

Rules that follow (and that reviewers check):

1. **Every** inbound envelope goes through `Router`: zod-validate payload → capability check by role →
   handler-level resource checks (ownership, path guard). No handler is reachable without (1) and (2).
2. **Every** filesystem path from a client, a hook, or the MCP socket goes through `PathGuard` before any `fs` call.
3. Daemon secrets/state live in `~/.smurg/` (outside the shared folder). No client request reaches it (PathGuard);
   sessions run as the host and can (§12: the `agent` role is for people the host fully trusts).
4. Denied requests (authz or path) are written to the audit log.

---

## 3. Identity, roles, capabilities

```ts
type Role = 'host' | 'agent' | 'editor' | 'viewer';
//            Host     Agent access  Editor      Viewer    (labels: `roleLabel(locale, role)` of @smurg/protocol/i18n)

type UserId = string;        // relay-issued: "github:<id>" | "google:<sub>" | "dev:<name>"

type Capability =
  | 'file.read'              // browse tree, open docs, view sessions
  | 'file.download'
  | 'file.write'             // edit, create, rename, delete, upload
  | 'session.view'
  | 'session.create'         // open agent / terminal sessions; they run AS THE HOST, unsandboxed (§11 D-15)
  | 'session.drive'          // type into ANY session (exec.input), accept / reject suggestions on any session
  | 'suggest.create'
  | 'worktree.merge.request'
  | 'worktree.merge.decide'
  | 'lock.force-release'
  | 'admin';                 // invites, roles, kick, audit, terminate any session, settings
```

| Capability | host | agent | editor | viewer |
|---|:-:|:-:|:-:|:-:|
| file.read, file.download, session.view | ✅ | ✅ | ✅ | ✅ |
| file.write, suggest.create | ✅ | ✅ | ✅ | ❌ |
| session.create, session.drive | ✅ | ✅ | ❌ | ❌ |
| worktree.merge.request | ✅ | ✅ | ❌ | ❌ |
| worktree.merge.decide, lock.force-release, admin | ✅ | ❌ | ❌ | ❌ |

The role `agent` ("Agent access") replaced `runner` on 2026-10-01 (§11 D-15): there are no sandboxed
guest sessions any more (`session.create.sandboxed` / `session.create.host` are gone). A session an `agent` member opens
runs exactly like the host's own (the host's OS user, environment, HOME, `~/.claude` and Claude Code login), in the
main workspace, a new worktree or their own kept worktree. `runner` is not accepted anywhere.

This table is implemented once, in `@smurg/protocol` (`roles.ts`), and used by the daemon for enforcement
and by the web app only for hiding UI.

Resource-level rules (daemon handlers):

- `exec.input`, `suggest.accept/reject`: `session.drive`, ANY session (host and `agent` members); the suggestion must be
  pending.
- `exec.resize` (and `session.attach`'s cols/rows), `session.end`: caller must **own** the session, i.e. have opened it
  (host may `admin.session.terminate` any).
- `suggest.create`: target session must belong to **someone else**.
- `worktree.merge.request` (and its diffs): any member with the capability, for any worktree; a session in a kept
  worktree: its owner only; `worktree.remove`: owner or host.
- `lock.release`: caller must be one of the human holders.

```ts
type Actor =
  | { kind: 'user'; userId: UserId; displayName: string }
  | { kind: 'agent'; sessionId: string; ownerUserId: UserId; displayName: string }  // "Claude (Ian)"
  | { kind: 'system' };
```

---

## 4. Connection lifecycle

```
client                          relay (WorkspaceDO)                        daemon
  │  OAuth login ─────────────────►│                                         │
  │◄── session cookie / bearer ────│                                         │
  │  POST /api/identity-token ────►│  EdDSA JWT, 5 min, aud = smurg-daemon:<ws>, sub = userId, cnf = blinded commitment
  │  WS /ws/<ws>/client ──────────►│── text: peer.open{conn} ───────────────►│
  │◄── text: hello{conn, host} ────│                                         │
  │══ HELLO  [0x01][ver][mode][noise msg1] ═════════════════════════════════►│
  │◄═ REPLY  [0x02][noise msg2] ═════════════════════════════════════════════│  client verifies daemon key (k / pin)
  │══ FINISH [0x03][noise msg3 ⟨ClientHello⟩] ══════════════════════════════►│  daemon authenticates, then admit()
  │◄═ DATA   first record = verdict: [0x00]⟨Welcome⟩ | [0x01]⟨reason⟩ ═══════│
  │══ DATA   msgpack Envelopes … ═══════════════════════════════════════════►│
```

- **First contact** (`mode = invite`): `Noise_XXpsk3_25519_ChaChaPoly_BLAKE2s`. The client aborts at msg2 unless the
  daemon static key matches fragment `k`, and **persists that pin before sending msg3**. The daemon finds the invite by
  trial-verifying msg1 against the invites on file (the invite id is never sent; it is in the prologue).
- **Later** (`mode = device`): `Noise_XX_25519_ChaChaPoly_BLAKE2s` with mutual pinning.
- **`admit()`** runs once, synchronously, *after* msg3 authenticates: re-check invite expiry and remaining uses and
  consume one use atomically (invite mode), or check the device is registered and not revoked (device mode); verify the
  identity token (issuer, audience, age, `cnf` commitment against the authenticated static key); check the token's
  `sub` equals the user the device is bound to (or the user the invite is bound to, for the host invite).
  No decision is ever taken on the unauthenticated msg3 key.
  - Identity tokens are verified synchronously (admit() may not await, and jose's `jwtVerify` is async): jose only
    decodes; `node:crypto.verify` checks the Ed25519 signature against the relay's JWKS fetched beforehand; `typ`, `alg`,
    `iss`, `aud`, `exp`/`iat`/`nbf` (60 s skew), age ≤ 5 min and the `cnf` member are checked by hand. An unknown `kid`
    answers `busy` (the client retries) and triggers a rate-limited JWKS refresh.
  - The times are checked against the **relay's** clock, not the host's: the daemon estimates it from
    the `Date` header of each JWKS response (the relay sets it explicitly; local workerd adds none by itself), with the
    offset capped at ±24 h (fail closed beyond that). A host clock that differs from the relay's is logged as a warning;
    a time failure is logged with the token's offset and triggers a rate-limited key refresh.
  - **Invites never raise a role and never add a host device.** The host's user id is admitted in invite mode only
    through the host invite (role `host`, bound to the host); an ACTIVE member is refused (`invite-invalid`) through an
    invite of another role. So a relay that lies about who logged in (or a hijacked OAuth account of the host), plus any
    leaked guest link, gets at most that link's role for a new user and nothing for an existing one.
  - A kicked member comes back only through an invite created after the kick, with a new device key: an older multi-use
    link answers `kicked`; a revoked key answers `device-revoked`, even through a fresh invite. An unknown device key in
    device mode also answers `device-revoked` (there is no device-unknown reason on the wire).
- Every pre-authentication failure is answered with the same cleartext `ABORT [0x7f, 0x00]`. Reasons are only sent
  encrypted, in the verdict record. The ABORT is unauthenticated (the relay can forge it) and, for a device the daemon
  knows, only ever means "over budget": the client therefore retries it forever in device mode (capped backoff, state
  `connecting{cause: 'aborted'}`); in invite mode three in a row end in `rejected('aborted')` (an unknown invite).
- **Handshake budget** (daemon, before any crypto): per relay user (`peer.open.userId`, the relay's claim, good enough
  for fairness) a token bucket (`handshakesPerUserPerMinute`, 30) and at most 4 handshakes in flight; then the global
  bucket (`handshakesPerMinute`, 120), and for members with a registered, unrevoked device a separate reserve
  (`memberHandshakesPerMinute`, 120) once the global one is empty; at most 32 in flight per class (members / everyone
  else). One account flooding junk HELLOs cannot lock members out. After 5 failed handshakes on one connection id the
  relay is told `peer.kick`. A connection that is not admitted within `handshakeDeadlineMs + idleConnGraceMs` (10 + 5 s)
  after `peer.open` (or after its last failed handshake, or after its channel ended without a kick) is dropped with
  `peer.kick` (reason `idle`, `PEER_KICK_REASON_IDLE`), so sockets that never handshake cannot hold the relay's
  per-account / per-workspace socket slots. A client that gets `bye 4003 idle` without an authenticated
  `channel.closed` before it reconnects instead of treating it as a kick.
- **Resume**: `ClientHello.resume = { channelId, lastSeq }`. The daemon keeps a bounded outbox per logical channel
  and replays envelopes with `seq > lastSeq`; if the gap is no longer available it answers `Welcome.resumed = false`
  and the client performs a full resync (re-open docs, re-attach sessions). The client likewise re-sends its
  unacknowledged requests; the daemon de-duplicates by `(channelId, seq)`. Precisely (executable reference:
  `packages/protocol/src/client/outbox.ts` and the client SDK's `testing/fake-daemon.ts`):
  1. every Envelope except `channel.ack` takes the next `seq` of its direction, starting at 1 per logical channel;
     seqs are strictly increasing but may have gaps (e.g. a request cancelled before it was sent);
  2. `channel.ack {upTo}` is unsequenced (`seq: 0`): never stored, replayed, acknowledged or de-duplicated;
  3. a receiver drops `seq ≤ last processed` and never treats a gap as an error;
  4. after `resumed: true` everything unacknowledged is re-sent in order with its original seq, before anything new;
  5. after `resumed: false`, requests that had reached the old channel fail with `connection-lost`, queued requests
     are renumbered from 1 and queued one-way messages are dropped (except before the very first channel);
  6. a persisted client position is `ResumeState { channelId, lastSeq, nextSeq }`; a restored client skips 1e6 seqs;
  7. a request that failed LOCALLY (timeout, cancelled) leaves the outbox even when it was already sent, so a resumed
     channel never replays it; `ClientRequestError.detail.sent` says whether it had been sent, and its
     message then says the outcome is unknown. There are no idempotency keys: a person who retries such a request may
     repeat an action the daemon did carry out.
  A logical channel continues only for the device (and user) it belongs to; a non-resumed admission of a device
  discards that device's other disconnected channels; fan-out keeps queueing to disconnected channels that can still
  resume (retention 15 min). A connection closed for too many refused requests loses its logical channel (§5.8).
- **Kick**: the daemon revokes every device key of the member, sends `channel.closed{kicked}` (authenticated) and then
  `peer.kick` on the same host socket, and the core ends the sessions the member opened and aborts their uploads (for
  `member.kicked`, whoever kicked). **Role change** (§11 D-8): the router reads the role per message, so it
  applies to the very next one; the member's channels get `channel.closed{role-changed}` + `peer.kick` (a client reads
  that pair as "reconnect", not as a kick) and come back with a fresh Welcome; device keys are NOT revoked; losing the
  right to open sessions (set to `editor` / `viewer`) ends the sessions they opened (`endReason: 'role-changed'`). A relay
  `bye 4003` without an authenticated reason before it
  is a kick for the client (terminal).
- **Liveness** (all three are required):
  - host → relay text `"ping"` every 2 s, answered by the DO auto-response without waking it; a DO alarm declares the
    host offline 6 s after the last ping and broadcasts `host.offline`;
  - daemon, CLI and web each run a **pong watchdog**: 6 s without `"pong"` ⇒ terminate the socket and reconnect with jitter;
  - daemon sends encrypted `presence.heartbeat` every 3 s; the client shows "Host offline" after 8 s of silence from the
    daemon even if the relay says nothing. Relay unreachable ("Server unreachable" in the web app) is a *different* UI state from "Host offline".
- **Client states** (`ConnectionState` of `@smurg/protocol/client`): `idle`, `connecting{cause}`, `handshaking`,
  `online{resumed}`, `host-offline{reason: 'relay' | 'silence' | 'stopped'}` (relay said so / 8 s daemon silence, a
  fresh socket after 20 s / `channel.closed{stopped}`), `relay-unreachable`, and the terminal `key-mismatch{detail:
  'fingerprint' | 'unauthenticated'}`, `rejected(reason)`, `closed(reason)`. A stage-2 `handshake-failed` is a key
  mismatch (exactly what a relay without the invite secret produces: the SPEC R3 warning). The invite is used when
  nothing is pinned, with `preferInvite` (the person accepted a fresh link after a key-mismatch warning: it re-pins), and
  once as a fallback when device mode is refused before the device was ever admitted, only if the invite's
  fingerprint equals the pinned key's. A different daemon key is never pinned silently.
- **Local connections**: the host's own `smurg attach` goes through the control socket (§7.1, §8) instead of the
  relay: no Noise (the 0600 socket inside the 0700 run dir authenticates the host's OS account), otherwise the same hub,
  logical channel, resume, router and fan-out. Host only, and only for the attach: every session
  runs as the host's OS account (§11 D-15), so the router accepts on a local channel nothing but what `smurg attach`
  sends (§8 "Control socket"), and every audit entry a local channel causes (`auth.connect` / `auth.disconnect` with
  mode `local` included) carries `detail.via: 'control-socket'`.

### 4.1 Invite link

```
https://<web-origin>/join/<workspaceId>#k=<daemon key fingerprint>&s=<one-time secret>
```

In production `<web-origin>` is the relay's own origin (the relay Worker serves the web app, §6): for the shared relay
`https://app.smurg.ai/join/<workspaceId>#…`. SPEC's example origin `https://smurg.app` is only an example (the project
does not own that domain); the tests' fixtures use it as an arbitrary origin.

The web app copies the fragment into `sessionStorage` and immediately removes it from the address bar
(`history.replaceState`) before any navigation (including the OAuth redirect). That only rewrites the tab's own entry:
the full URL, secret included, is already in the browser's global (and synced) history before any script runs (a
residual risk; the console shows each link's uses live so a leaked link can be revoked).

`/join/<id>` never connects on page load: after the login it shows the workspace id and the identity
the person is logged in as, and connects only when they click "Join" ("Do not join" forgets the invite). A page that
sends a logged-in visitor to an invite link therefore cannot make them join, or tell the inviting daemon who they are.

The host gets their own single-use invite (role `host`, bound to the host's `userId`) printed by `smurg host`. It is
valid 7 days, and making a new one revokes the previous unused one. Guest invites without `expiresInSec` expire after
7 days (a never-expiring link would be a standing credential). `InviteInfo.id` is a random id (`inv_…`) unrelated to
the Noise invite id: whoever knows the Noise invite id can forge a msg1 that passes the daemon's pre-DH filter, so it
never reaches a UI, a log or the audit. Invite mode is refused on the transfer socket (two sockets must not race for
one single-use invite).

Fragment encoding (all base64url without padding):

| Value | Definition |
|---|---|
| `k` | `BLAKE2s-256("smurg/v1 daemon static key fingerprint" ‖ daemonStaticPublicKey)` — 43 chars |
| `s` | 32 random bytes — 43 chars |
| invite id | `BLAKE2s(key = s, "smurg/v1 invite id", 16 bytes)` |
| PSK | `BLAKE2s(key = s, "smurg/v1 invite psk", 32 bytes)` |

The daemon stores `{ inviteId, psk, role, boundUserId?, expiresAt?, usesLeft? }` — never `s` itself.

### 4.2 Encrypted channel (see `docs/research/noise.md`)

- **Engine:** our own Noise rev-34 *state machine* (CipherState / SymmetricState / HandshakeState) on audited
  primitives from `@noble/*`. We implement no primitive. It passes all 1352 cacophony + snow vectors; those vectors
  are part of the protocol package's test suite. No npm Noise library supports `XXpsk3` + BLAKE2s + an async DH hook
  without native addons (evidence in the report §1.7).
- **Drivers:** port `channel-v2.ts` from the report (§V-C), not the original `channel.ts`.
- **Prologue:** `"smurg-noise/1" ‖ 0x00 ‖ u8 len(workspaceId) ‖ workspaceId ‖ u8 mode ‖ inviteId(16, invite mode only)`.
- **AEAD suite:** noble in browsers; `node:crypto` ChaCha20-Poly1305 on the daemon and CLI through the `Suite`
  interface (byte-identical, ~6× faster).
- **Framing:** one application message = one WebSocket binary message = `DATA [0x10]{u16be len, noise record}+`.
  Record plaintext is `[flags][body ≤ 65518 bytes]`; the FIN bit is inside the ciphertext. An 8 MiB payload is 129
  records (+2452 bytes). The receiver caps reassembly at `MAX_APP_MESSAGE` and treats any AEAD failure as fatal for
  that connection. Decrypt into a **fresh buffer per message** (msgpack bin fields alias the input).
- **Every WebSocket gets its own handshake** — the interactive socket and the transfer socket are separate sessions.
- **Deadlines and limits:** handshake must complete within 10 s; at most 5 failed handshakes per connection id and a
  global budget per minute on the daemon.
- **Device keys**
  - Browser: `device-key-v2` from the report. A `structuredClone` probe picks `webcrypto` (non-extractable X25519
    `CryptoKeyPair` in IndexedDB; Chromium, Firefox), `wrapped` (WebKit cannot clone X25519 keys: AES-GCM-wrapped
    PKCS#8) or `raw`. Every record read back is re-validated. "Non-extractable" only blocks `exportKey`; it is **not**
    encryption at rest and must never be described as such.
  - CLI / daemon: raw 32-byte files under `~/.smurg`, created with `open(tmp, 'wx', 0o600)` + `rename`; loading
    refuses files with any group/other permission bit.
  - CLI pins of verified daemon keys: `~/.smurg/pins/<hex(utf8(workspaceId))>.pub`. Hex, because workspace ids are
    case-sensitive (anyone can claim `victim_…` next to `Victim_…`) and APFS is not: raw ids as file names would let
    one workspace's invite overwrite another's pin. A different pin is only replaced with `{ replace: true }` (after
    an invite verified the new key).
- **Identity binding:** `cnf = SHA-256("smurg-cnf" ‖ n ‖ deviceStaticPublicKey)`, n = 32 random bytes; the client sends
  `cnf` (43-character base64url, no padding: `identityCnf()`) to the relay when asking for the identity token and `n`
  inside the encrypted `ClientHello`. The relay never sees a stable device id. The token: header `typ:
  smurg-identity+jwt`, EdDSA, `kid`; claims `iss` (relay origin), `aud: smurg-daemon:<workspaceId>`, `sub`, `name`,
  `provider`, `picture?`, `iat`, `exp` (+300 s), `jti`, `cnf: { "smurg-noise-static": <cnf> }`. The strings are
  `IDENTITY_TOKEN_TYP`, `IDENTITY_TOKEN_AUDIENCE_PREFIX`, `IDENTITY_CNF_MEMBER` and `IDENTITY_TOKEN_TTL_SECONDS` in
  `@smurg/protocol/relay` (one definition for relay and daemon).

```ts
type ClientHello = {                     // msgpack, carried as the payload of noise msg3
  protocolVersion: number;
  purpose: 'interactive' | 'transfer';
  identityToken: string;                 // relay-signed JWT
  cnfNonce: Uint8Array;                  // n
  clientKind: 'web' | 'cli';
  deviceName: string;
  resume?: { channelId: string; lastSeq: number };   // interactive only
};
type Verdict =                            // first DATA message from the daemon
  | { ok: true; welcome: Welcome }
  | { ok: false; reason: 'invite-invalid' | 'device-revoked' | 'device-other-account' | 'identity-invalid' | 'kicked' | 'version' | 'busy' };
```

`channel.hello` / `channel.welcome` in §5.1 are these two structures; they are not Envelopes. The channel driver owns
the verdict's tag byte (`[0x00]` accept / `[0x01]` reject); the codec encodes only the body (`encodeVerdict()` returns
`{ accept, payload }`, which is exactly `admit()`'s return value).

### 4.3 Envelope

Codec: **MessagePack** (`@msgpack/msgpack`), one map per Envelope, `Encoder({ ignoreUndefined: true })`, `Decoder`
with `maxBinLength = 9 MiB`, `maxStrLength = 1 MiB`, `maxArrayLength = 1e6`, `maxMapLength = 1e4`.
Byte fields are msgpack `bin` ⇄ `Uint8Array` (`z.instanceof(Uint8Array)`); nothing is ever base64-in-JSON.

```ts
type Envelope = {
  type: string;       // e.g. "file.write"
  id: string;         // request id; responses echo it
  seq: number;        // per channel, per direction, strictly increasing
  payload: unknown;   // validated by the zod schema registered for `type`
};
```

Conventions:

- Request `X` → response `X.ok` (same `id`) or `error` (same `id`, `payload: { code, message, detail?, text? }`).
  `message` is English (logs, the audit log, agents, a client that does not know the id). `text` is a message
  reference (`{ id, params? }`, `messageRefSchema`): the client shows `render(locale, text) ?? render(locale,
  defaultErrorRef(code)) ?? message`. Every error the daemon makes carries `text` (`error.default.<code>` when nothing
  more specific was said); the field is optional in the schema because an error made from a plain string has none.
  `new SmurgError(code, msg('worktree.inUse'), detail)`: `.text` is the reference, `.message` its English rendering.
- Unsolicited daemon → client events use a fresh `id`.
- `file.*` and `exec.*` never share message types or handlers (future two-way sync mode).
- Binary fields are real bytes (`Uint8Array`), never base64.

`PROTOCOL_VERSION` is 3 since 0.4.0 (message references: `error.text`, `ActivityEvent.text` / `renamedFrom`,
`MemberNotification.msg` / `fallback`, `Suggestion.closedReason`, an optional `SessionInfo.title`, no
`channel.closed.message`, the agent name `Claude (Ian)`). Nobody had installed an earlier version: there is no
compatibility code for protocol 2 anywhere.

Error codes: `bad_request`, `unauthorized`, `forbidden`, `not_found`, `conflict`, `locked`, `path_denied`,
`insufficient_disk`, `too_large`, `host_only`, `internal` (`sandbox_unavailable` is gone with the sandbox, §11 D-15).
Finer distinctions travel in `detail.reason` and never become new codes (e.g. `bad_request` + `reason: 'hash-mismatch'`, `path_denied` +
`reason: 'outside-root'`). Local client-side failures (timeout, connection lost) are `ClientRequestError`, a
`SmurgError` with code `internal`, `detail.reason` = the failure and `text` = its `client.*` message.

Every Envelope is decoded with `decodeEnvelope(bytes, { from, channel })`, which refuses (as `bad_request`, with
`detail.reason`) a type that may not flow that way or on that socket, prototype keys at any depth, extension types and
nesting deeper than 32. The daemon audits the refusals that mean "not allowed" (§7.4): an invalid path is
`path.denied`, a forged direction / channel / unknown type is `authz.denied`.

---

## 5. Message catalog

`c→d` request, `d→c` event. Rows marked **(addition)** were added after the first version of this catalog, each for
the reason given; the registry (`packages/protocol/src/schema/registry.ts`, `MESSAGE_REGISTRY`) is the executable form
of this section and `registry.test.ts` transcribes these tables to keep both in step. Every object is strict (an
unknown key is a protocol error); byte fields are `Uint8Array`; times are epoch-ms integers. All file references use:

```ts
type RootRef = { kind: 'main' } | { kind: 'worktree'; worktreeId: string };
type FileRef = { root: RootRef; path: string };   // POSIX, relative, normalised, no leading "/", "" = root
```

### 5.1 `channel.*`

| Type | Dir | Payload | Notes |
|---|---|---|---|
| `channel.hello` | c→d | `ClientHello` (§4.2) | payload of noise msg3, not an Envelope |
| `channel.welcome` | d→c | `Welcome = { channelId, resumed, member: Member, workspace: WorkspaceInfo, settings: PublicSettings, serverTime }` | inside the verdict record, not an Envelope |
| `channel.memberUpdated` | d→c | `{ member: Member }` | own record changed without a channel close (e.g. a new display name) |
| `channel.settingsUpdated` (addition) | d→c | `{ settings: PublicSettings }` | to everyone after each `admin.settings.set`: the settings otherwise reach clients only in the Welcome |
| `channel.closed` | d→c | `{ reason: 'kicked'\|'revoked'\|'stopped'\|'role-changed'\|'protocol-error' }` (only the reason: each client words it) | then the socket is dropped; also on the transfer socket |
| `channel.ack` | both | `{ upTo: seq }` | lets the peer trim its outbox; always `seq: 0` (unsequenced, §4 Resume) |
| `channel.leave` (addition) [none] | c→d | `{}` → `{}` | SPEC R4 (a guest leaves): ends the sessions the caller opened within 5 s (`endReason: 'left'`, each audited `session.terminate` by the system), audits `member.leave`; membership and device key stay. A mere disconnect does none of this (§11 D-9). The host's own leave is a no-op. |
| `error` | d→c | `{ code, message, detail?, text? }` (§4.3) | on both sockets; answers a request (same id) or a refused one-way message |

```ts
type Member = { userId; displayName; avatarUrl?; role: Role; color: string; online: boolean; joinedAt: number };
type WorkspaceInfo = { id; name; hostUserId; hostName; platform: 'darwin'|'linux'; isGitRepo: boolean };
type PublicSettings = { humanLockIdleMs; agentLockTimeoutMs; uploadChunkSize; sharedDirs: string[] };
// (Protocol 1's guestSubscriptionLogin / guestMainWorkspace are gone with the guest sandbox, §11 D-15.)
```

### 5.2 `file.*` (capability in brackets)

| Type | Dir | Payload → result |
|---|---|---|
| `file.tree` [file.read] | c→d | `{ root, path, depth? (1–32) }` → `{ entries: FileEntry[] /* ≤ 10,000 */, truncated: boolean }` |
| `file.stat` [file.read] | c→d | `FileRef` → `{ entry: FileEntry }` |
| `file.create` [file.write] | c→d | `{ file: FileRef, kind: 'file'\|'dir' }` → `{ entry }` |
| `file.rename` [file.write] | c→d | `{ root, from, to }` → `{ entry }` |
| `file.delete` [file.write] | c→d | `{ file: FileRef }` → `{}` |
| `file.read` [file.read] | c→d | `{ file: FileRef, maxBytes? /* ≤ 5 MiB */ }` → `{ content: bytes, hash /* SHA-256 hex of content */, truncated }` |
| `file.write` [file.write] | c→d | `{ file: FileRef, content: bytes, ifMatchHash?: string }` → `{ entry, hash }` |
| `file.changed` | d→c | `{ root, changes: { path, change: 'add'\|'change'\|'unlink'\|'addDir'\|'unlinkDir', by?: Actor }[] /* ≤ 10,000 */ }` |

`file.tree.ok.truncated` (addition): a directory with more than 10,000 entries is listed partially (encoding 10,000
entries already costs ~13 ms); the client asks for subdirectories one by one. `file.read.ok.hash` covers the returned
bytes; it is the whole file's hash (usable as `file.write.ifMatchHash`) only when `truncated` is false.

`file.write` is **not** how text is edited (that is `doc.*`); it exists for small non-collaborative writes and is
what the R2 forged-request test sends as a viewer. It is refused with `locked` while the file has any lock.

Host-only paths: `<share>/.claude/**`, `<share>/.mcp.json`, `<share>/.git/**`, `<share>/.smurg/**`, `.envrc`,
`.vscode/**`, `.idea/**` are writable through `file.*` / `doc.*` / upload **by the host only**. Project-level Claude
settings are hot-loaded by the host's unsandboxed agent: a collaborator who can write them can run code on the host
and redirect the host's API credentials (§11 D-15: a "Agent access" member's own sessions run as the host and are not
held to this; the rule protects the host from editors and from what any member writes through `file.*`). `isHostOnlyPath()`
matches these names at ANY depth (nested `.claude/` directories are loaded too) and after `foldPathName()`: NFKC plus
a full case fold and HFS+ ignorable code points removed, because a case-insensitive file system treats more spellings
as the same entry than `toLowerCase()` does (on APFS `.vſcode`, with U+017F, IS `.vscode`). A false "host-only" costs
a guest one refused write; a false "not host-only" can run code on the host. PathGuard also decides on the on-disk
spelling of existing entries (§7.4). `<share>/.smurg` is not even readable for non-hosts (it holds other guests'
partial uploads and the worktrees, which are reachable as their own roots).

Host-private paths (`isHostPrivatePath()` in `@smurg/protocol`): any `.git` directory, any `.envrc`,
and the host's personal Claude Code files `.claude/settings.local.json` and `CLAUDE.local.md`, at any depth and under
every folded spelling. PathGuard refuses them to every non-host for **reads as well** (`path_denied`, reason
`host-private`, audited), so guests (viewers included) cannot read `.git/config`, a deploy key in `.envrc` or the
host's personal settings through `file.read`, `doc.open` or a download. `file.tree` does not list them for non-hosts
(like `.smurg`), a guest's zip leaves them out (skipped as `host-private`), and conflict records about them are shown
to the host only (one definition in `@smurg/protocol`). This binds what members read through smurg; a session a "Agent access"
 member opens runs as the host and can read them like the host's own (§11 D-15).

The daemon's own directories are refused for mutation through `file.*` even for the host (`forbidden`,
`detail.reason: 'daemon-owned'`): `.smurg`, `.smurg/worktrees`, `.smurg/worktrees/<id>`, `.smurg/uploads/**` and
`.smurg/trash/**` (moving them away under the daemon would break resume, worktrees and the delete safety). Members
other than the host meet PathGuard's audited `hidden` denial first. A write is refused with `locked` when a lock holds the file under ANY
spelling that reaches it: the request's, the shared-link `mainRef`, and the canonical FileRef of the resolved object
(`toFileRef(realPath)`), so a link inside the share (`alias/app.ts` → `src/app.ts`) cannot write around a lock.

The file tree and activity feed hide editor/agent temp files (`NAME.tmp.<pid>.<hex>`, `.<name>.smurg-<hex>.tmp`).

#### Transfer channel (`purpose: 'transfer'`, separate socket through `TransferDO`, own Noise session)

No `seq` outbox/replay on this channel: uploads resume from the daemon's bitmap, file downloads by offset, zip
downloads restart. `begin`, `chunk`, `commit` and acks all travel on this socket (there is no ordering across sockets).
Chunks are 4 MiB by default (1–8 MiB accepted). Flow control: end-to-end ack window of 4 chunks **and**
`ws.bufferedAmount ≤ 8 MiB` polled every 5 ms in the browser. The browser side runs in a Web Worker.

| Type | Dir | Payload → result |
|---|---|---|
| `file.upload.plan` [file.write] | c→d | `{ root, entries: { path, kind: 'file'\|'dir', size? }[] /* ≤ 10,000; files have size, dirs not */, onConflict: 'fail'\|'overwrite'\|'rename' }` → `{ disk: DiskReport, renamed: { from, to }[] }` — folder drops; one disk check for the whole batch; creates directories (also empty ones); clients split bigger drops, and the daemon reserves planned bytes until their uploads begin or abort |
| `file.upload.begin` [file.write] | c→d | `{ root, path, size, chunkSize, lastModified, uploadId?, onConflict? }` → `{ uploadId, chunkCount, have: bytes /*bitmap*/, received, resumed, disk: DiskReport }` |
| `file.upload.hashes` [file.write] | c→d | `{ uploadId, from, count }` → `{ hashes: bytes }` — paged, 32 bytes per chunk |
| `file.upload.chunk` [file.write] | c→d | `{ uploadId, index, hash: bytes /*SHA-256*/, data: bytes }` → `{ index }` — rejected unless this connection began/resumed the upload |
| `file.upload.commit` [file.write] | c→d | `{ uploadId, rootHash: bytes }` → `{ entry: FileEntry }` — `rootHash = SHA-256(u64be size ‖ u32be chunkSize ‖ h0 … hn-1)` |
| `file.upload.abort` [file.write] | c→d | `{ uploadId }` → `{}` |
| `file.download.begin` [file.download] | c→d | `{ file: FileRef, zip?: boolean, offset?: number, ifMatch?: string }` → `{ downloadId, name, size?: number, etag?: string, zip: boolean }` |
| `file.download.chunk` | d→c | `{ downloadId, index, offset, data: bytes }` |
| `file.download.ack` [file.download] | c→d | `{ downloadId, index }` — grants credit |
| `file.download.end` | d→c | `{ downloadId, totalBytes, skipped: { path, reason }[], zip64: boolean, error?: { code, message, detail?, text? } }` — `error` (addition): a download that failed after `begin.ok` (disk error, file gone) ends typed |
| `file.download.cancel` [file.download] | c→d | `{ downloadId }` |

The capabilities of the upload follow-ups (`file.write`) and of ack / cancel (`file.download`) are those of the
request they belong to: a member demoted to viewer mid-upload is refused (fail closed). Upload / transfer sub-errors are
ARCH codes with `detail.reason` (`hash-mismatch`, `incomplete`, `bad-path`, …).

Upload rules the clients rely on (files module): after a new transfer socket or a daemon restart a client sends
`file.upload.begin` with the `uploadId` before any chunk (a chunk on a socket the upload is not bound to answers
`conflict` / `not-bound`); a resume may carry a new `onConflict`. The daemon remembers the ids of uploads a member
committed for 10 minutes: a `begin` with such an id from the same member (its commit answer was lost to a disconnect)
answers `conflict` / reason `committed` with `detail.entry` (the placed file), which the client treats as done. At most
1,000 unfinished uploads per member (`conflict` / `too-many-uploads`). `file.write` / `file.create` need an existing
parent (`not_found` / `parent-missing`); `plan` and commit create missing parents, each level resolved through
PathGuard. Deletes are renamed into `<share>/.smurg/trash/<id>` (same volume, checked before and after) and removed
there, so a directory swapped for a symlink mid-delete can never take files outside the share with it.

```ts
type DiskReport = { totalBytes; availableBytes; reserveBytes; pendingBytes; requestedBytes; freeAfterBytes; ok: boolean };
```

Disk rule (R7): `reserve = max(diskReserveBytes /*5 GiB*/, diskReservePercent /*5%*/ × total)`;
accept iff `available − pendingOther − remaining ≥ reserve`, where `pendingOther` excludes the upload being checked.
Refusals return `insufficient_disk` with the `DiskReport` so the UI can show the numbers.

```ts
type FileEntry = {
  name; path; kind: 'file'|'dir'|'symlink'; size; mtime;
  readOnly?: boolean;            // e.g. inside a shared read-only dir of a worktree
  lock?: LockInfo;
  lastModifiedBy?: Actor;        // drives the tree badge ("recently changed by Claude (Ian)")
};
```

### 5.3 `doc.*` (Yjs)

| Type | Dir | Payload |
|---|---|---|
| `doc.open` [file.read] | c→d | `{ file: FileRef }` → `{ docId, epoch: string, canEdit: boolean, lock?: LockInfo, meta: { eol: 'LF'\|'CRLF'\|'CR', bom: boolean, mixedEol: boolean } }`; the daemon then sends sync step 1 + an awareness snapshot as `doc.sync` / `doc.awareness`. Refused with `too_large` (> 5 MiB) or `bad_request` (binary / not UTF-8). |
| `doc.reset` | d→c | `{ docId, epoch }` — the daemon re-created the Y.Doc; the client must drop its replica and re-sync |
| `doc.sync` | both | `{ docId, data: bytes }` — y-protocols sync messages. Updates from clients without `file.write` are dropped + audited. |
| `doc.awareness` | both | `{ docId, data: bytes }` — y-protocols awareness update |
| `doc.close` | c→d | `{ docId }` |
| `doc.saved` | d→c | `{ docId, file, hash, at }` |
| `doc.rejected` | d→c | `{ docId, reason: 'agent-locked'\|'read-only'\|'forbidden'\|'file-unavailable', lock? }` — client must resync and drop local change. `file-unavailable` (addition): the file was moved, deleted or became unusable (binary, too large, a link out of the share) on disk; the text not yet saved is NOT lost (see below), so clients must not say it was discarded |
| `doc.conflict` | d→c | `{ conflict: ConflictRecord }` |
| `doc.conflict.list` [file.read] | c→d | `{}` → `{ conflicts: ConflictRecord[] }` |
| `doc.conflict.resolve` [file.write] | c→d | `{ conflictId, action: 'dismiss'\|'apply-agent-version' }` → `{ conflict }` — `apply-agent-version` writes the file: audited `doc.conflict-resolve` |
| `doc.conflict.get` (addition) [file.read] | c→d | `{ conflictId }` → `{ conflict, agentVersion: bytes /* ≤ 5 MiB */ }` — the agent's full version as bytes: a whole document exceeds msgpack's 1 MiB string limit, so it is not inline in ConflictRecord |

```ts
type ConflictRecord = {
  id; file: FileRef; createdAt; source: Actor;            // the agent (or 'system' if unknown process)
  humans: { userId; displayName }[];
  hunks: { humanText: string; agentText: string; baseText: string; startLine: number /* 1-based */; truncated?: boolean }[];
                                                          // ≤ 64 hunks; each text ≤ 64 KiB UTF-8 (truncated: cut)
  hunksOmitted?: number;                                  // hunks beyond the 64 listed
  agentVersionBytes: number;                              // UTF-8 size of the full agent version (doc.conflict.get)
  status: 'open'|'dismissed'|'applied';
};
```

An open document whose file stays missing, binary or huge, or leads out of the share for more than 1.5 s (a pause
that does not clear by itself, unlike a `git checkout`) is settled: every subscriber gets
`doc.rejected{file-unavailable}`, later human updates are reverted and refused the same way, and the text that was not
on disk yet becomes a ConflictRecord (one hunk `{ humanText: <the unsaved text>, agentText: '', baseText: '' }`, its
stored version is that text), announced with `doc.conflict` and audited `doc.conflict` (detail.kind `unsaved-text`):
`apply-agent-version` writes it back at the old path. A room that is dropped (grace expiry, stop) is settled first.
The document does not follow a rename; the web client moves its tab from the `file.rename` activity event.

### 5.4 `lock.*`, `presence.*`, `activity.*`

```ts
type LockInfo =
  | { kind: 'human'; file: FileRef; holders: { userId; displayName; lastActivityAt }[]; acquiredAt }
  | { kind: 'agent'; file: FileRef; sessionId; ownerUserId; agentName; acquiredAt; expiresAt };
```

| Type | Dir | Payload |
|---|---|---|
| `lock.state` | d→c | `{ file: FileRef, lock: LockInfo \| null }` — broadcast on every change |
| `lock.list` [file.read] | c→d | `{}` → `{ locks: LockInfo[] }` |
| `lock.release` [file.write] | c→d | `{ file }` → `{}` — "Let the agent go first": caller leaves the human lock |
| `lock.forceRelease` [lock.force-release] | c→d | `{ file }` → `{}` |
| `presence.heartbeat` | d→c | `{ at }` every 3 s |
| `presence.state` | d→c | `{ members: PresenceMember[], agents: PresenceAgent[] }` |
| `presence.update` | c→d | `{ activeFile?: FileRef \| null }` |
| `activity.event` | d→c | `{ event: ActivityEvent }` |
| `activity.list` [file.read] | c→d | `{ limit? /* ≤ 500 */, before? /* epoch ms, exclusive */ }` → `{ events: ActivityEvent[] }` — `at` is strictly increasing per log, so `before` is an exact cursor |
| `activity.notify` (addition) | d→c | `{ notification: { id, at, from: Actor, text? /* ≤ 2,000 */, msg?: MessageRef, fallback?: string, file?: FileRef } }` — only to the notified member's channels. Exactly one of `text` (an agent's own words through the coordination MCP tool `notify_member`, SPEC R8; never translated) or `msg` + `fallback` (a notification the daemon wrote, `notify.*`: the two Claude Code version warnings, `from: { kind: 'system' }`; the client shows `render(locale, msg) ?? fallback`) |

```ts
type PresenceMember = Member & { connections: number; activeFile?: FileRef };
type PresenceAgent  = { sessionId; ownerUserId; displayName; color; activeFile?: FileRef; status: SessionStatus };
type ActivityEvent  = { id; at; actor: Actor; kind: 'agent.edit'|'human.edit'|'file.create'|'file.delete'|'file.rename'
                        |'file.upload'|'external.change'|'conflict'|'lock.denied'|'merge'; file?: FileRef;
                        text: MessageRef;      // the sentence (`activity.*`): rendered by each client in the viewer's language
                        summary: string;       // the English rendering of `text` (≤ 500 characters): fallback and logs
                        via?: 'bash';          // addition, §11 D-13: an agent.edit attributed through the shell-command window
                        renamedFrom?: string;  // on `file.rename`: the path before (`file.path` is the new one)
                      };
```

A client shows `render(locale, event.text) ?? event.summary` and never parses `summary`. The daemon clips the
parameters (a path to 200 characters, at most 3 sample paths, at most 5 holder names plus `holderCount`). Lines of
`activity.jsonl` written before protocol 3 have no `text`: they fail the schema and the reader drops them.

`merge` (addition): a worktree merge request (actor: the requester), and the host's approval, rejection or conflict
(actor: the host), in everyone's feed. A `file.rename` event carries the old path in `renamedFrom`: the web client
follows a renamed file's tab from it (§9).

The human lock has no `lock.acquire` request: it is taken by the daemon when it applies the first Yjs update
from a human to a doc, and refreshed on every later update. `lock.acquire` exists only on the hook socket (§8).

### 5.5 `session.*` and `exec.*`

```ts
type SessionStatus = 'starting' | 'running' | 'exited';
type SessionInfo = {
  id; kind: 'agent' | 'terminal';
  ownerUserId; ownerName;              // the member who OPENED it (§11 D-15): attribution, `Claude (ownerName)`
  title?;                              // only a title the opener typed; clients build the default from kind + ownerName
                                       // in the viewer's language (`session.title.agent` / `session.title.terminal`)
  root: RootRef; status: SessionStatus; exitCode?: number;
  cols: number; rows: number; createdAt; endedAt?;
  login: 'unknown' | 'logged-out' | 'logged-in';   // the host's Claude login, as this session sees it
  attached: number;
  // additions, set once status is 'exited':
  endReason?: 'exit' | 'ended' | 'terminated' | 'kicked' | 'left' | 'role-changed' | 'stopped';
  endedBy?: { userId; displayName };   // who ended it on purpose: the owner (ended) or the host (terminated)
};
```

| Type | Dir | Payload |
|---|---|---|
| `session.create` [session.create] | c→d | `{ kind, workspace: { mode: 'main' } \| { mode: 'worktree', worktreeId?: string }, cols, rows, title? }` → `{ session }` — runs like the host's own whoever opens it (§11 D-15); the caller becomes its owner |
| `session.list` [session.view] | c→d | `{}` → `{ sessions: SessionInfo[] }` |
| `session.loginStatus` [session.drive] | c→d | `{ sessionId }` → `{ login }` — runs `claude auth status --json` in the session's environment (the host's) |
| `session.attach` [session.view] | c→d | `{ sessionId, haveOffset?: number, cols?, rows? /* both or neither */ }` → `{ session, mode: 'snapshot'\|'delta', data: bytes, cols, rows, nextOffset }` — `snapshot` is a serialized terminal state painted after a reset; `delta` is raw output since `haveOffset` (only when still buffered and no resize happened since); `cols`/`rows` (addition): the owner's viewport, which sets the PTY size before the snapshot (resize policy `owner`); ignored for everyone else, the other members who may type included |
| `session.detach` | c→d | `{ sessionId }` |
| `session.end` (owner) | c→d | `{ sessionId, keepWorktree?: boolean }` → `{}` — the member who opened it; the host ends anyone's with `admin.session.terminate` |
| `session.state` | d→c | `{ session: SessionInfo }` |
| `exec.output` | d→c | `{ sessionId, offset, data: bytes }` |
| `exec.input` [session.drive] | c→d | `{ sessionId, data: bytes }` — any session (the host's included) |
| `exec.resize` (owner) | both | `{ sessionId, cols, rows }` — c→d from the owner; d→c to attached viewers, in stream order with `exec.output` (they render at exactly the PTY size) |

Every session runs like the host's own (§11 D-15): the host's OS user, unsandboxed, the host's environment / HOME /
Claude Code login, whoever opened it. `session.create` needs `session.create` (host, "Agent access"); typing into a
session, accepting its suggestions and reading its login state need `session.drive` (host, "Agent access"), for ANY
session. Ending (`session.end`) and resizing stay with the member who opened it. (Protocol 1's `apiKey`, kind `login`
and `session.importConfig` are gone.)

`exec.request.*` (R10, run-on-behalf) is reserved for the launch phase and not implemented.

### 5.6 `suggest.*`

```ts
type Suggestion = {
  id; sessionId; author: { userId; displayName }; text: string;
  source?: { file: FileRef; startLine: number; endLine: number };
  status: 'pending' | 'accepted' | 'accepted-modified' | 'rejected' | 'withdrawn';
  createdAt; resolvedAt?; finalText?;
  rejectReason?;                       // a person's words only
  closedReason?: 'session-ended' | 'author-kicked' | 'author-demoted';  // the daemon closed it (status `rejected`); clients word it
};
```

| Type | Dir | Payload |
|---|---|---|
| `suggest.create` [suggest.create] | c→d | `{ sessionId, text, source? }` → `{ suggestion }` |
| `suggest.edit` (author, pending) | c→d | `{ suggestionId, text }` → `{ suggestion }` |
| `suggest.withdraw` (author, pending) | c→d | `{ suggestionId }` → `{ suggestion }` |
| `suggest.accept` [session.drive] | c→d | `{ suggestionId, text?: string }` → `{ suggestion }` — any session (§11 D-15: the host and "Agent access" may type into it anyway). `text` is what the member saw (or typed) and exactly it is pasted: `accepted` when it equals the current text, `accepted-modified` otherwise. Without `text`, an accept within 10 s of the author's last `suggest.edit` is refused (`conflict`, reason `suggestion-changed`, audited as denied): the author must not swap the text between the review and the accept. The web client always sends the text on screen. |
| `suggest.reject` [session.drive] | c→d | `{ suggestionId, reason? }` → `{ suggestion }` |
| `suggest.list` [session.view] | c→d | `{ sessionId? }` → `{ suggestions }` — the caller's own; every suggestion for a holder of `session.drive` |
| `suggest.updated` | d→c | `{ suggestion }` — to the author and every holder of `session.drive` (host, "Agent access") |

There is no auto-accept code path. The only function that writes suggestion text into a PTY is called from the
`suggest.accept` handler after the `session.drive` and pending checks.

### 5.7 `worktree.*`

| Type | Dir | Payload |
|---|---|---|
| `worktree.list` [file.read] | c→d | `{}` → `{ worktrees: WorktreeInfo[] }` |
| `worktree.remove` (owner or host) | c→d | `{ worktreeId }` → `{}` |
| `worktree.merge.request` [worktree.merge.request] | c→d | `{ worktreeId, message? }` → `{ request: MergeRequest }` — any worktree (§11 D-15) |
| `worktree.merge.list` [file.read] | c→d | `{}` → `{ requests }` |
| `worktree.merge.diff` [worktree.merge.request] | c→d | `{ requestId }` → `{ diff: string /* ≤ 1 MiB UTF-8 */, truncated: boolean, files: { path, status: 'added'\|'modified'\|'deleted'\|'renamed'\|'copied'\|'type-changed'\|'unmerged'\|'unknown', additions, deletions, oldPath?, binary? }[] /* complete, ≤ 10,000 */ }` |
| `worktree.merge.fileDiff` (addition) [worktree.merge.request] | c→d | `{ requestId, path }` → `{ path, diff: string /* ≤ 1 MiB */, truncated: boolean, binary: boolean }` — one file of `files` (any other path is refused), so the whole change can be reviewed when `merge.diff` was truncated (R9: the host sees the complete diff); the UI does not offer "Merge" until every truncated file was opened |
| `worktree.merge.approve` [worktree.merge.decide] | c→d | `{ requestId }` → `{ request }` (status `merged` or `conflict` + `conflictFiles`) |
| `worktree.merge.reject` [worktree.merge.decide] | c→d | `{ requestId, reason? }` → `{ request }` |
| `worktree.updated` / `worktree.merge.updated` | d→c | `{ worktree }` / `{ request }` |
| `worktree.removed` (addition) | d→c | `{ worktreeId }` — file trees showing it switch back to the main root (`worktree.updated` cannot express removal) |

```ts
type WorktreeInfo = { id; ownerUserId; ownerName; branch; sessionId?: string; kept: boolean; createdAt; sharedDirs: string[] };
type MergeRequest = { id; worktreeId; requestedBy: { userId; displayName }; message?; commit: string /* git object id */;
                      status: 'pending'|'merged'|'rejected'|'conflict';
                      conflictFiles?: string[]; createdAt; decidedAt?; rejectReason? };
```

**What a merge request contains** (addition). Agents normally edit without committing, so
`worktree.merge.request` (by any holder of `worktree.merge.request`: the host, "Agent access") first commits the
worktree's working tree onto `smurg/<owner>/<id>` as the requester, with `message` (nothing to commit is fine), then fetches that commit into the main repository as
`refs/smurg/merge/<requestId>` and records its id in `MergeRequest.commit`. `merge.diff`, `merge.fileDiff` and
`merge.approve` all work on exactly that commit, whatever happens in the worktree afterwards; a later change needs a
new request.

As built (worktree module): the commit is staged in a daemon-private object store and index (state dir; the index
copy keeps the clone index's mtime so git's racy-clean rule still re-hashes files changed in the same second as the
checkout). For a request not made by the host every new blob is verified against a careful re-read of the worktree
(no symlink on the way, O_NOFOLLOW, same identity, a single hard link, same bytes) before the objects are copied into
the clone; nested repositories are refused. Approval refuses (status `conflict`, audit reason
`local-changes`) local changes and untracked or ignored host files the merge would overwrite, and runs
`git merge --no-overwrite-ignore`. A request in `conflict` may be approved again. Worktree mode needs git ≥ 2.42
(`merge-tree --write-tree`, `--attr-source`: attributes come from the host's HEAD, so a worktree's `.gitattributes`
cannot select the host's filter or merge drivers); otherwise it is unavailable (`conflict` / `git-too-old`). A request
not made by the host is refused when it carries host-only paths (`host-only-paths`) or the daemon's directory. Removal
renames `<id>` to `<id>.removing-<hex>` first (a name no session works in) and deletes it there; the next start
finishes leftovers.

`worktree.*` and `activity.*` extend the prefix table of SPEC §7.2; nothing in them overlaps `file.*`/`exec.*`.

**Implementation of a "worktree" (see §11, deviation D-2).** Each worktree is an isolated working copy at
`<share>/.smurg/worktrees/<id>` on its own branch `smurg/<owner>/<id>`, created with
`git clone --shared --no-checkout <share> <dir>` followed by a checkout of the main workspace's `HEAD`.
Objects are shared read-only through alternates, so a session in the worktree writes nothing into the main
repository through git. Merging: the daemon (as the host) runs
`git fetch <dir> <branch>:refs/smurg/merge/<id>` in the main repository, produces the diff for review, and on approval
merges that ref; on conflict it aborts the merge and reports `conflictFiles`. Rejecting leaves the worktree untouched.
Shared directories (D12) are linked into the worktree as symlinks that PathGuard treats as read-only (a session,
running as the host, is not held to that, §11 D-15).
All git commands run with `execFile` (argument arrays, never a shell string), asynchronously.

### 5.8 `admin.*` (all require `admin`)

| Type | Payload |
|---|---|
| `admin.invite.create` | `{ role: Exclude<Role,'host'>, expiresInSec?: number, maxUses?: number }` → `{ invite: InviteInfo, url: string }` |
| `admin.invite.list` / `admin.invite.revoke` | `{}` → `{ invites }` / `{ inviteId }` → `{}` |
| `admin.member.list` | `{}` → `{ members: (Member & { devices: DeviceInfo[] })[] }` |
| `admin.member.setRole` | `{ userId, role: Exclude<Role,'host'> }` → `{ member }` |
| `admin.member.kick` | `{ userId }` → `{}` |
| `admin.session.terminate` | `{ sessionId }` → `{}` |
| `admin.audit.query` | `{ limit? /* ≤ 500 */, before? /* epoch ms, exclusive: `at` is strictly increasing */ }` → `{ entries: AuditEntry[] }` — newest first, across the rotated files |
| `admin.audit.entry` (d→c, host only) | `{ entry }` |
| `admin.settings.get` / `admin.settings.set` | `{}` → `{ settings: HostSettings }` / `Partial<HostSettings>` → `{ settings }` |

```ts
type InviteInfo = { id; role; createdAt; expiresAt?: number; maxUses?: number; uses: number; revoked: boolean };
type DeviceInfo = { deviceId; name; kind: 'web'|'cli'; addedAt; lastSeenAt; revoked: boolean };
type AuditEntry = { id; at; actor: Actor; action: string; target?: string; outcome: 'ok'|'denied'|'error'; detail?: Record<string, unknown> };
type HostSettings = PublicSettings & { diskReserveBytes: number; diskReservePercent: number };   // (allowedDomains: gone, §11 D-15)
```

Audit `action` vocabulary: `auth.join`, `auth.connect`, `auth.disconnect`, `auth.rejected`, `authz.denied`, `path.denied`,
`file.write`, `file.create`, `file.rename`, `file.delete`, `file.upload`, `file.download`, `doc.edit`, `agent.edit`,
`external.change`, `doc.conflict`, `doc.conflict-resolve` (addition), `lock.acquire`, `lock.release`, `lock.denied`,
`lock.force-release`, `session.create`, `session.end`, `session.terminate` (also by the system, with `detail.reason`
`kicked` / `left` / `role-changed`, when the member who opened a session goes, §11 D-15), `suggest.create`, `suggest.edit`, `suggest.accept`, `suggest.reject`, `suggest.withdraw`,
`worktree.create`, `worktree.remove`, `worktree.merge.request`, `worktree.merge.approve`, `worktree.merge.reject`,
`member.role`, `member.kick`, `member.leave` (addition, `channel.leave`), `invite.create`, `invite.revoke`,
`device.revoke`, `settings.change`.

- `auth.connect` / `auth.disconnect` (R11 logins and logouts) are written by the core for every connection (relay or local):
  target = deviceId, detail `{ mode, purpose, resumed }` / `{ mode, purpose, reason, durationMs }`.
- `detail` is sanitised by key (bytes → sizes; `content`, `data`, `token`, `url`, `hash`, `apiKey`, `diff`, … replaced)
  and strings are cut at 2,000 characters, except top-level keys the caller lists in `fullText` (R6.3: the suggestion
  module lists `text` and `finalText`, up to 64 KiB). Never put a sensitive payload in `detail`.
- The log is bounded (§11 D-10): `denied` entries beyond 120 per actor and origin per minute are
  counted, not written (one entry marks the start, one summary entry gives the count). The origin is the control socket
  (`detail.via: 'control-socket'`, §8) or the relay channels: a flood through the socket, whose actor is the host, has
  its own budget and its summary says `via: 'control-socket'`; a connection with more than 60 refused
  requests in a minute is closed with `protocol-error` and loses its logical channel (no replay of the flood);
  `audit.jsonl` is rotated at 32 MiB into `audit.1.jsonl` and `audit.2.jsonl` (0600) and queries page across them.

---

## 6. Relay

Routes (Worker):

See `docs/research/relay.md` for the verified spike this is built from.

One Worker, three SQLite-backed Durable Object classes: two keyed by workspace id (`getByName`), sharing a `RelayRoom`
base class: `WorkspaceDO` (interactive traffic + host liveness) and `TransferDO` (file chunks); and, since 2026-10-01,
`DeviceLoginDO` (the CLI's device-code login: pending logins keyed by user code, and its rate limits; wrangler migration
`v2`; see "As built").
Hibernation API only (`ctx.acceptWebSocket(ws, tags)`); all routing state lives in tags (`host`, `client`, `c:<conn>`),
socket attachments and `ctx.storage.kv` — never in memory, because local workerd really hibernates after ~10 s.
The Worker also serves the web SPA (assets + `run_worker_first`), so web app and relay share one origin. For the
shared relay that origin is `https://app.smurg.ai`, a Cloudflare Custom Domain with the Worker's workers.dev hostname
off; any other relay (a test relay, a relay someone hosts for themselves) defaults to its account's workers.dev or
uses its own domain. `scripts/deploy-relay.sh` deploys exactly one of these two shapes (`docs/RELEASING.md` §2;
self-hosting: `apps/relay/README.md`). The relay's HTML pages (`/device`, the login error pages) exist in both languages
(text: `apps/relay/src/lib/strings.ts`) and choose per request: cookie `smurg_lang` → the first supported entry of
`Accept-Language` → `en` (§1 Languages; `lib/locale.ts`). A GET page carries two plain links `<path>?lang=en|zh-TW`:
that request sets `smurg_lang=<locale>; Path=/; Max-Age=31536000; SameSite=Lax; Secure` (not HttpOnly: the web app,
same origin, reads and writes the same cookie, §9; no `Secure` on a plain-http local relay) and answers 303 to the
same path without `lang` (never to a URL from the request); `lang` on a POST or with any other value is ignored.
Pages carry `Vary: Accept-Language, Cookie`, `<html lang>` (`en` / `zh-Hant-TW`) and `<body data-state>` (which
page it is, whatever the language: tests select by it); their CSP is unchanged (no script). The JSON API never
chooses a language: errors are `{ error: <code>, message? }` with English messages. A Google account without a
name and without a verified e-mail address is called `Google user`.

| Route | Purpose |
|---|---|
| `GET /auth/:provider/login`, `GET /auth/:provider/callback` | `github` (OAuth App, state + PKCE), `google` (OIDC, state + nonce + PKCE) |
| `GET /auth/dev/start`, `POST /auth/dev/token` | dev-only provider: requires `DEV_LOGIN=1` **and** a local hostname |
| `POST /auth/device/start`, `POST /auth/device/token` | the CLI's device-code login (RFC 8628 style): a device code and a user code → polled until allowed → bearer token, once; see "As built" |
| `GET /device`, `POST /device` (same-origin form) | where a person logged in to the relay enters the CLI's user code and allows or denies the login (relay-rendered page, no script) |
| `POST /auth/logout`, `GET /api/me` | session (`/api/me` answers 401 when logged out; see "As built") |
| `GET /api/login-options` | no session: `{ providers: { github, google }, dev }`, booleans only (`relayLoginOptionsSchema`, `loginOptionsUrl()`): which login buttons to show; `dev` = the dev-login gate for this request's hostname |
| `POST /api/workspaces` | host claims a workspace id (owner = caller); only the owner may open host sockets |
| `POST /api/identity-token` | `{ workspaceId, cnf }` → EdDSA JWT (`typ: smurg-identity+jwt`, 5 min) |
| `GET /.well-known/jwks.json` | relay public keys (`kid` = RFC 7638 thumbprint), with an explicit `Date` header (the daemon's estimate of the relay clock, §4) |
| `GET /ws/:workspaceId/host`, `GET /ws/:workspaceId/client` | → `WorkspaceDO` |
| `GET /xfer/:workspaceId/host`, `GET /xfer/:workspaceId/client` | → `TransferDO` (owner check through `WorkspaceDO` RPC) |

Sessions: EdDSA JWT. Browser = `HttpOnly; Secure; SameSite=Lax` cookie **plus a mandatory Origin allow-list** on
cookie-authenticated WebSocket upgrades (Chromium sends the Lax cookie from sibling origins). CLI/daemon = bearer token.

Frames. Tunnelled traffic is **binary**; the relay reads nothing in it except the connection-id prefix on host sockets:
client → relay `ciphertext`; relay → host `<u32be conn><ciphertext>`; host → relay `<u32be conn><ciphertext>`.
Frame cap `MAX_RELAY_FRAME = 8 MiB + 64 KiB`, derived from protocol constants. Control is JSON **text**:

```ts
// relay → client
{ t: 'hello', conn: number, host: boolean }        // host = host currently online
{ t: 'host.online' } | { t: 'host.offline', reason: 'closed' | 'timeout' }
// relay → host
{ t: 'peer.open', conn: number, userId, displayName, avatarUrl? } | { t: 'peer.close', conn: number }
// host → relay
{ t: 'peer.kick', conn: number, reason: string }
// relay → anyone, always sent before a relay-initiated close
{ t: 'bye', code: 4000 /*heartbeat timeout*/ | 4001 /*host replaced*/ | 4003 /*kicked*/ | 1009 /*too big*/, reason }
// heartbeat: the literal text frames "ping" → "pong" (DO auto-response; exact strings)
```

These schemas and the route builders live in `@smurg/protocol/relay` so relay, daemon, CLI and web agree.

Rules: a new host connection replaces older host sockets (epoch) and close events from stale epochs are ignored;
the alarm also sweeps clients whose last ping is older than 30 s (→ `peer.close`); always call `ws.close()` inside
`webSocketClose`; Node clients must act on `bye` instead of waiting for the close event (FIN lags 10–16 s locally);
per-workspace and per-account socket caps.

What the relay can observe (R3): workspace id, connection id, frame sizes and timing — and, because it performs the
login, the account identity and IP address of each connection. It never sees keys, invite secrets, device ids or content.

Tests start the relay with wrangler's `createTestHarness()` on a random port (no Cloudflare account). The R3 byte
tap is a test-only hook (`RELAY_TAP_URL`, gated to local hostnames) that POSTs every frame to a local collector.

As built (relay report; details in `apps/relay/README.md`):
- `POST /api/workspaces` takes an optional `{ workspaceId }` (a daemon may choose its id); the owner may repeat the
  claim (200), anyone else gets 409. Sockets (host and client, `/ws` and `/xfer`) to an unclaimed id get 404.
- Cookie sessions need an allow-listed `Origin` on WebSocket upgrades AND on POSTs; JSON bodies must be
  `application/json`; with an https issuer the cookie is `__Host-`. An Authorization header that is present but invalid
  is 401 even when a valid cookie is present.
- The identity token requires `cnf`. `RELAY_SIGNING_KEY` may hold several keys (rotation); all are in the JWKS.
- The TransferDO also sweeps silent clients (`bye 4000`). A frame from a client while no host is connected is answered
  with `host.offline`. Caps: 64 client sockets per workspace, 8 per account (per Durable Object). A client frame may be
  `MAX_RELAY_FRAME − 4` bytes (the prefixed host frame must still fit).
- The CLI's device-code login (every CLI login, RFC 8628 style; `apps/relay/src/auth/device.ts`,
  `device-store.ts`; the shared constants and schema in `@smurg/protocol/relay` `device-login.ts`). `POST
  /auth/device/start` (no session; JSON) answers `{ deviceCode, userCode, verificationUri, expiresIn: 600, interval: 5 }`:
  the user code is 8 characters of RFC 8628 §6.1's alphabet `BCDFGHJKLMNPQRSTVWXZ` (shown `XXXX-XXXX`; typed in any
  case, with or without spaces and dashes, full-width too: NFKC), the device code `<user code>.<32 random bytes,
  base64url>`. The login is stored in the `DeviceLoginDO` instance `code:<user code>` (so /device finds it from what was
  typed, the token endpoint from the device code) with SHA-256 of the secret (compared in constant time), the creation
  time, and the client's `CF-Connecting-IP` with Cloudflare's country and city (`request.cf`); its alarm deletes it at
  expiry. `POST /auth/device/token { deviceCode }` answers 400 `authorization_pending`, `slow_down` (a poll sooner than
  the interval minus 1 s; the interval then grows by 5 s, RFC 8628 §3.5; the time of the last poll is kept in memory,
  so a poll costs one read and no write), `access_denied`, `expired_token` (also for an unknown, collected, or forged
  code: they cannot be told apart) or `invalid_request`, and once allowed the bearer session `{ token, tokenType,
  expiresIn, user }` (the shape `POST /auth/dev/token` returns too), handed out once (the record is deleted with it). `GET /device` (Worker-first, in
  `RELAY_WORKER_FIRST_PATTERNS`) shows the relay's login (Google / GitHub when configured, the dev login when
  `devLoginEnabled`), which returns to /device, or for a logged-in browser (the cookie; a bearer token is not a browser)
  the code form; it never takes a code from its URL (a prefilled link would be the phisher's). Each `POST /device` must be
  a same-origin form (`isSameOriginFormPost`: `Origin` = the relay or an allow-listed origin, `Sec-Fetch-Site:
  same-origin` when present; 403 otherwise, a non-form body 415): `code` → the confirmation screen
  (the account, the code, the IP address and approximate place and the age of the request, and the warning to press "Allow" only if you
  just ran `smurg login` in your terminal yourself); `code` + `account` + `decision=allow|deny`
  → the decision, bound to the browser session's identity, refused (409) when the account is no longer the one the
  screen named. A code that is not pending (unknown, expired, decided, also by another account) is a wrong code; wrong
  codes are limited to 10 per account and 30 per IP address per 10 minutes (checked before the lookup; 429 with
  "Too many wrong codes. Try again in N minutes."), starts to 30 per IP address per 10 minutes (429 `too_many_requests` with
  `Retry-After`); the counters are `DeviceLoginDO` instances `limit:<kind>:<SHA-256 of the address or account>` with one
  alarm at the window's end. Every /device page: the relay HTML CSP (`frame-ancestors 'none'`, `form-action 'self'`),
  `X-Frame-Options: DENY`, `Referrer-Policy: same-origin`, `no-store`. Tests: `apps/relay/test/device.test.ts` (workerd),
  `apps/relay/test/cli-login.browser.test.ts` (Chrome, the real CLI), `tests/e2e/test/device-login.test.ts`, `web/e2e/smoke/login.smoke.test.ts`;
  the dev-only `/api/debug/device-login` (like `/api/debug/room`) lets the tests expire a login.
- The CLI loopback login of smurg 0.1.0 (`GET`/`POST /auth/cli/start`, `POST /auth/cli/token`) was removed on
  2026-10-01 (no installed CLI used it); those paths answer 404 (`apps/relay/test/auth.test.ts`). What it taught
  still holds for /device: a link alone never changes a login, and /device reaches GitHub / Google
  through links, not forms, because Chromium applies the submitting page's CSP `form-action` to every redirect of a
  form submission.
- Dev-only routes (`/auth/dev/*`, `/api/debug/room`, `/api/debug/device-login`) need `DEV_LOGIN=1` AND a local hostname.
- `GET /api/login-options` (2026-09-29) answers `{ providers: { github: boolean, google: boolean }, dev: boolean }`
  without a session: a provider is `true` when its configuration is complete (its login route would not answer 503),
  `dev` when `DEV_LOGIN=1` AND the request's hostname is local (`devLoginEnabled`, the same gate as the dev routes).
  Nothing else (no client id, no endpoint); `Cache-Control: no-store`; no CORS headers, like `/healthz`, the JWKS and
  `/api/me`; GET only. It is there so that the web app stops probing `/auth/<p>/login` and `/auth/dev/start`
  (§9), which puts a 400 / 404 / 503 into the browser console on every page load. `/api/me` keeps its 401 for a
  logged-out caller: the client SDK's login diagnosis (`probeLogin` in `client/engine.ts`), `RelayApi.me()`, the CLI's
  stored-session check and the relay tests rely on it.
- The relay's `build` refuses to bundle a missing web build, the stand-in page that `pnpm dev:relay` and the tests put
  into `apps/web/dist`, a build without `_headers` carrying a `/*` Content-Security-Policy with `frame-ancestors 'none'`
  or without a `/*` `Strict-Transport-Security` of at least a year (lines under another rule do not count), and a build that would serve `.vite/manifest.json` (`.assetsignore` must list `.vite`) (`scripts/check-web-dist.ts`).
- The SPA's own security headers come from `apps/web/public/_headers`, which Workers static assets
  apply to every asset and SPA route (relay routes keep their own headers): `Content-Security-Policy: default-src
  'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; worker-src 'self' blob:; connect-src 'self'; img-src
  'self' data: https:; font-src 'self' data:; media-src 'self' blob:; object-src 'none'; base-uri 'none';
  frame-ancestors 'none'; form-action 'self'`, `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`,
  `Referrer-Policy: no-referrer`, `Cross-Origin-Opener-Policy: same-origin`, `Strict-Transport-Security:
  max-age=31536000` (since 2026-10-01: the relay is a custom domain of `smurg.ai`, which is not HSTS-preloaded like
  `*.workers.dev`; no `includeSubDomains`, no `preload`, as on smurg.ai; `scripts/deploy-relay.sh --check` requires it
  on an https relay). The built-app smoke test runs the whole app under it with zero violations. The Vite dev server does not apply `_headers`.

---

## 7. Daemon

### 7.1 State on disk (`~/.smurg/`, mode 0700; files 0600)

```
~/.smurg/
├── credentials.json                 relay session token for the CLI
├── device.key                       CLI device static key
├── workspaces.json                  folder path → workspaceId
├── run/<short>.ctl                  control socket (the host's OS account): stop, status, local attach (§8)
├── run/<short>.hook                 hook + MCP socket of the agent sessions (§7.7)
├── run/<short>.pid
├── run/<short>.<hex4>.lk            share-lock socket of a running daemon (per instance; named in the folder's marker)
├── pins/<hex(utf8(workspaceId))>.pub   CLI pins of verified daemon keys (§4.2)
├── logs/<workspaceId>.log           daemon log of `smurg host` (0600; never invite links or secrets)
├── sessions/<wsKey>/<hex(sessionId)>/  daemon-owned launch files of an agent session: settings.json (hooks), mcp.json
│                                    (wsKey: 24 hex of the workspace id; hex(sessionId): case-fold safe)
└── workspaces/<workspaceId>/
    ├── identity.key                 daemon static key
    ├── state.json                   members, devices, invites (PSK-derived keys), settings, roots
    ├── worktrees.json               worktrees and merge requests (worktree module)
    ├── audit.jsonl                  append-only; rotated at 32 MiB to audit.1.jsonl, audit.2.jsonl (§5.8)
    ├── activity.jsonl               rotated at 8 MiB into activity.1.jsonl
    ├── conflicts.json + conflicts/  conflict records and the agents' full versions (docs module)
    ├── suggestions.json
    ├── git-home/, git-template/, git-staging/   private dirs of the worktree module's git runs
    └── uploads/                     partial uploads: <id>.json manifest, <id>.log journal, <id>.part
```

`<short>` is a 12-character id (`shortRunId(workspaceId)`, from SHA-256): macOS limits Unix socket paths to 104 bytes
including the NUL, and Node does NOT fail on a longer path — it binds the socket at a silently truncated path in
another directory, outside the private run dir. The run dir is `config.runDir`
(default `<stateDir>/run`, created 0700); `resolveConfig` computes `config.runPaths` and refuses (fail closed) any
socket path over 103 bytes (`assertSocketPath`, `src/core/sockets.ts`). Tests whose state dir is deep pass a short
`runDir` (`createTempRunDir()` of `@smurg/daemon/testing`).

Every per-id path must use a case-fold-safe name (like `pins/` and `sessions/`): ids are case-sensitive, APFS is not. `workspaces/<workspaceId>/` is safe because the daemon refuses a `state.json` of another
workspace id.

Inside the shared folder the daemon only creates `.smurg/` (`worktrees/` with transient `<id>.removing-<hex>` during a
removal, `trash/` for deletes in progress (emptied at start), `uploads/` when the state dir is on a different volume,
and `daemon-lock.json`), and adds `.smurg/` to `.git/info/exclude`. It writes nothing into `.claude/` (§11, D-1).

**One daemon per folder**: `createDaemon` takes `<share>/.smurg/daemon-lock.json` (O_EXCL), which names
a Unix socket the daemon holds while it runs (`<runDir>/<short>.<hex4>.lk`). A live marker in the folder refuses the
share (`ShareLockError` reason `shared`), and so does a live marker in an ancestor folder (`ancestor-shared`), whatever
the state dir or relay; a marker whose socket answers nothing (a crashed daemon) is taken over. Not detected: a
descendant folder already hosted by a daemon of ANOTHER state dir (the CLI checks descendants of its own state dir).
`prepareShare` also refuses a folder that contains the host's home directory or `/Users`, `/home`, `/root`, `/var/root`: every member would see `~/.ssh` and the rest.

`workspaces/<id>/state.json` writes that fail (disk full, permissions) are kept and retried with backoff up to every
10 s, and every `flush()` tries again: a kick, role change, invite revocation or settings change is in
force at once in memory (fail closed) and on disk as soon as the disk takes it; admin requests meanwhile answer
`internal {reason: 'state-not-saved', applied: true}` (`invite.create`: `applied: false`, the unseen link is revoked).
`smurg stop` while a document is unsaved logs `STATE NOT SAVED`. Failed audit appends are kept (≤ 4 MiB) and written
with the next one; a torn last line of `audit.jsonl` / `activity.jsonl` (a crash mid-write) is terminated when the log
opens.

`sessions` state (`live.json`) lists every running session with its PTY child and descendants
(`procs: { [sessionId]: { pid, id: sha256(start ‖ command) }[] }`, refreshed by the 2 s scan): a daemon that starts
after a hard death ends those leftovers through killTree (env marker, or a recorded identity that still matches).

The single executable (`scripts/build-sea.sh`) extracts its native modules (node-pty, @parcel/watcher) and the docs
compute worker on first use to `~/Library/Caches/smurg/native-<id>` / `$XDG_CACHE_HOME/smurg/native-<id>`
(`SMURG_CACHE_DIR`), checked by sha256 on every start.

### 7.2 Module map

```
packages/daemon/src/
├── core/        context.ts interfaces.ts router.ts permissions.ts hub.ts state-store.ts audit.ts bus.ts config.ts
│                sockets.ts (socket path limits, run paths)
├── net/         relay-connection.ts channel-server.ts (handshake responder, resume, outbox) identity.ts (JWT verify)
├── admin/       invites.ts members.ts handlers.ts
├── workspace/   path-guard.ts roots.ts power.ts (caffeinate / systemd-inhibit)
├── files/       file-service.ts watcher.ts handlers.ts upload.ts download.ts disk.ts
├── docs/        doc-service.ts reconcile.ts (diff + 3-way) conflicts.ts handlers.ts
├── locks/       lock-manager.ts presence.ts activity.ts handlers.ts
├── sessions/    session-manager.ts pty-session.ts term-mirror.ts raw-tail.ts host-env.ts claude.ts kill-tree.ts handlers.ts
├── hooks/       hook-server.ts (Unix socket) hook-cli.ts (entry used by Claude Code) settings-writer.ts
├── mcp/         coord-server.ts (stdio MCP entry, proxies to hook socket)
├── suggest/     suggestion-service.ts handlers.ts
├── worktree/    worktree-manager.ts merge.ts handlers.ts
├── local/       protocol.ts (ctl frames + schemas, shared with the CLI) local-channel.ts (the hub's channel for a
│                local client) control-server.ts (ctl socket: stop / status / local attach) module.ts
├── testing/     test harness (`@smurg/daemon/testing`): in-memory relay, test identity issuer, temp dirs, clients
└── daemon.ts    composition root: builds DaemonContext, registers handlers, starts/stops everything
```

Every feature module exports `register(router: Router, ctx: DaemonContext): Disposable`.
Modules talk to each other **only** through the interfaces in `core/interfaces.ts` and events on `ctx.bus`.
`ctx.lifecycle` (`stop()`, `status()`, `attachLocal()`) is what only the composition root can do; the control-server
module uses it. `ctx.config.sessions` and `ctx.config.runPaths` carry the session-launch inputs (§7.6).

### 7.3 Internal events (`ctx.bus`)

`member.joined`, `member.left`, `member.kicked`, `member.role-changed`, `device.added`, `device.revoked`,
`conn.opened`, `conn.closed`, `channel.discarded` (a logical channel is gone for good: drop all per-channel state
keyed by its `channelId`), `settings.changed`,
`file.changed` (from watcher, with best-effort attribution), `doc.human-edit`, `doc.saved`,
`agent.tool.pre`, `agent.tool.post`, `agent.file-changed`, `lock.changed`,
`session.created`, `session.updated`, `session.exited`, `suggestion.changed`, `worktree.changed`, `merge.changed`,
`daemon.stopping`, `state.write` (`{ document, ok }`: a state document the disk refused, or wrote again),
`relay.link` (`{ purpose, state, reason?, status? }`: every state change of a relay link, `auth-rejected` included). Payloads: `core/interfaces.ts` (`DaemonEvents`). `smurg host` prints `state.write` and
`relay.link` on the host's terminal (§8).

Per-client state that must survive a resume (doc subscriptions, attached terminals) is keyed by the logical channel
(`conn.channelId`), never by the socket (`conn.id`); service methods say `channelId` where they mean it. The core runs
the per-member teardown (the sessions the member opened killed and audited, uploads aborted) for `member.kicked`,
`member.left` and a demotion below "Agent access" (§11 D-15); feature modules do not duplicate it. The activity module alone turns bus
events into activity entries and their audit entries (mapping in `ActivityFeed`, `core/interfaces.ts`); exceptions that
call `ActivityFeed.record` directly: the conflict panel (`conflict`) and the worktree module (`merge`).

**Relay link** (`net/relay-connection.ts`): a refused WebSocket upgrade reports its HTTP status. 401/403 (the host's
7-day relay session expired or was revoked) moves the link to `auth-rejected`: one error log that names `smurg login`,
and a retry of the same token only every `timing.relayAuthRetryMs` (5 min) instead of hammering the relay.
`Daemon.updateRelayToken(token)` (`RelayLink.setToken`) reconnects at once with a new token; `smurg host` calls it when
`credentials.json` has a renewed login for the same account. A link that drops is logged at warn with its reason, and
its recovery with the time it was offline. Heartbeat, pong watchdog and open deadline use `monotonicNow(clock)` (a
wall clock stepped back does not freeze them), and so do the lock manager's idle timeout and TTL
(§7.5).

### 7.4 PathGuard

```ts
interface PathGuard {                       // full contract: packages/daemon/src/core/interfaces.ts
  lexical(path: unknown, options?: { allowRoot?: boolean }): string;
  /** Resolve a client-supplied FileRef, or throw PathDeniedError (audited as path.denied, exactly once). */
  resolve(ref: FileRef, opts: { principal: Principal; forWrite?: boolean; mustExist?: boolean; allowRoot?: boolean;
                               finalSymlink?: 'follow' | 'self' | 'deny'; audit?: boolean }): Promise<ResolvedPath>;
  /** Convert an absolute path (from a hook / watcher) back to a FileRef, or null when outside every root. */
  toFileRef(absPath: string): Promise<FileRef | null>;
  revalidate(resolved, opts): Promise<ResolvedPath>;            // same object (dev, ino, kind) as before, or denied
  openRead(resolved, opts): Promise<GuardedFile>;               // O_NOFOLLOW + fstat check
  readFile(ref, opts & { maxBytes? }): Promise<{ bytes; identity; truncated }>;
  writeFileAtomic(ref, data, opts & { noClobber?; expect?; mode? }): Promise<FileIdentity>;
  checkPlaced(resolved, placed, opts): Promise<void>;           // post-move containment check
}
```

Every call names its `principal` (the member, an agent session's owner, or the system): host-only, hidden and
hard-link rules depend on it.

Algorithm: lexical layer first — reject NUL and control characters, bidi overrides, backslashes, drive letters,
absolute paths, empty / `.` / `..` segments and lone surrogates; normalise to NFC; enforce per-platform segment length →
join with the root → `realpath` the deepest existing ancestor → require it to be inside `realpath(root)` →
for the remaining non-existing tail, require plain names. A symlink whose target leaves the root is denied unless
the link itself is one of the daemon-created shared-dir links recorded in `state.json` (then: read-only).

**The check is repeated before every disk read and every disk write**, not only when a document or upload is opened:
a session can swap a parent directory for a symlink at any time, and the daemon acts for every member. Files are opened with
`O_NOFOLLOW` and verified with `fstat` against the `lstat` taken during resolution. After a write that moves a file
into place (autosave rename, upload commit) PathGuard performs one post-move containment check and removes the file
if it landed outside. Every denial is audited as `path.denied`, including a request the decoder refuses because its
path is lexically invalid (the hub audits it: `detail.reason: 'lexical'`, `problem`).

Additional rules (daemon-core):
- For non-hosts the host-private paths (§5.2: `.git`, `.envrc`, `.claude/settings.local.json`, `CLAUDE.local.md`, at
  any depth) are refused for reads and writes with reason `host-private` (host-only keeps precedence
  for writes).
- For non-hosts `<share>/.smurg` is hidden (not readable, however it is spelled or reached); regular files with more
  than one hard link are refused (one could alias a file outside the share); FIFOs, sockets and devices are refused.
- Host-only and hidden are decided on the request's spelling, on the symlink-resolved path, AND on the on-disk
  spelling of what exists (native `realpath` returns the canonical case: `.VScode` and `.vſcode` resolve to
  `.vscode`), each compared after `foldPathName()` (§5.2).
- `ResolvedPath.ref` keeps the request's (NFC) spelling. On a case-insensitive file system two spellings can name one
  file (`README.md` / `readme.md`): per-file state (locks, docs) must key by the resolved object (realPath from a
  native `realpath`, or dev + ino), not by the raw request path.
- `ResolvedPath.realPath`, `parentRealPath` and `name` are spelled as the file system stores them (native `realpath`;
  missing names as requested; a followed final link keeps its target), and every read, write, rename and post-move
  check works on that spelling. APFS keeps an entry's stored spelling when a file is renamed over it, so a
  request-spelled path (NFC `café` onto a stored NFD `cafe` + U+0301, `readme.md` onto `README.md`) failed the
  post-move check, which removed the file (fixed 2026-10-01). A case-only or normalisation-only move is renamed to the
  requested spelling (`files/fs-ops.ts` moveResolved). A name the caller makes up next to an existing one is built from
  the REQUEST's spelling: the upload plan numbers `readme.md` next to `README.md` as `readme (1).md`, as a single
  upload does, and counts a candidate as taken under either spelling.
- Linux (2026-10-01): ext4, btrfs, xfs and tmpfs compare names byte by byte while every request is NFC, so an entry
  stored in another normalisation (NFD) would be listed but never reachable. A segment that is not found is mapped onto
  the ONE entry of its directory whose NFC form equals it (an exact NFC twin wins; two or more other spellings count as
  not found), and it then goes through every check like any other entry. Directory listings and the zip walker leave out
  names no request can reach (an NFD twin next to its NFC name); the zip reports them as `duplicate-name`
  (`workspace/fs-util.ts` otherSpellings / unaddressableNames). Looking for the other spelling lists the directory: a
  zip download, a watcher batch, an upload plan and a `file.tree` (a folder of n Mac-made sub-directories
  cost 2n listings of it at depth 2) each keep one listing per directory for the whole operation, up to 1024
  directories at a time (an older one is listed again if needed; it never fails) (`ResolveOptions.spellings`, fs-util
  SpellingIndex; without it a folder of n Mac-made names cost n listings of n entries: a 20,000-file zip
  took 374 s instead of 26 s on ext4). A single request that misses still lists its directory once.

### 7.5 Documents, locks and reconciliation (see `docs/research/yjs-monaco.md`)

- One `Y.Doc` **and one `Awareness`** per open `(root, path)`; `DocRoom` is the only fan-out point. Each Y.Doc has a
  random `epoch`; a client whose epoch differs drops its replica (otherwise the file content is duplicated).
  Rooms stay alive for a grace period after the last subscriber leaves so short disconnects merge normally.
- Text is normalised in the Y.Text: CRLF and lone CR → LF, UTF-8 BOM stripped; `eol` and `bom` are kept in `meta`
  and re-applied on save. Files that are > 5 MiB, contain NUL, carry a UTF-16/32 BOM or are not valid UTF-8 are
  refused (`TextDecoder` with `fatal: true`; never `Buffer.toString`).
- Sync messages that carry content from a connection without `file.write` are dropped and audited.
  Awareness updates are decoded, validated (strict `RelativePosition` schema, normalised through
  `Y.createRelativePositionFromJSON`) and re-encoded; client ids are bound per connection and the `user` field is
  overwritten with the daemon's view of the member. The daemon's own awareness state is `null`.
- **Agent presence:** per `(file, agent session)` a real `Awareness` on a throwaway `Y.Doc`, forwarded into the room;
  state `{ user: { name: 'Claude (Ian)', color, kind: 'agent' }, selection }` with the caret at the end of the last
  applied change.
- **Human edit → disk:** human-origin update → `locks.touchHuman` → debounce 300 ms (max wait 2 s) → per-file
  serialized flush: re-check containment; read + SHA-256 the file (never trust equal `size/mtime/ino`); if it differs
  from the last known content, reconcile first; then atomic write (`.<name>.smurg-<hex>.tmp`, `wx`, original mode,
  fsync, rename) → `doc.saved`.
- **Disk → Yjs:** every watcher event means "re-check this path". Own echo is detected by content hash.
  - no human lock: `applyDiskChange` with `smartDiffer3` (bounded: `fast-diff` only for ≤ 4K-unit middles, otherwise
    line diff with timeout + pairwise refinement), one transaction with the agent's origin.
  - human lock held: `threeWayReconcile(base = lockBase, ours = Y.Text, theirs = disk)`, where **`lockBase` is the disk
    text at the moment the human lock was taken** (not the last autosave). Clean hunks are applied; overlapping hunks
    keep the human text and become a `ConflictRecord`; both sides are notified; the merged text is written back.
  - Diff and merge can take up to ~1 s on large files; run them off the main thread (`worker_threads`).
- **Agent lock:** requested by `PreToolUse` on the hook socket, TTL 60 s. While held, docs on that file are
  `canEdit = false` for everyone; a human update that still arrives is applied-then-reverted so every replica
  converges, and the sender gets `doc.rejected`.
  Released by `PostToolUse`, `PostToolUseFailure`, **and** by that session's next `UserPromptSubmit`, next
  `PreToolUse`, `Stop`, `SessionEnd`, or the TTL — a permission prompt that the owner rejects fires no Post event.
  Locks are capped per session and only granted for paths inside the session's root.
- **Human lock:** shared between humans, idle timeout 30 s (setting); released when the last holder closes the file
  or chooses "Let the agent go first".
- **Lock time**: idle timeouts and TTLs are durations measured on the monotonic clock (lock time = the
  wall time at start + monotonic time since, whole milliseconds), so a wall clock stepped back an hour neither keeps a
  lock alive for that hour nor expires every lock when it is stepped forward. Reported timestamps are epoch ms, off by
  at most the steps.
- Watcher: `@parcel/watcher`, one subscription per root, ignoring `.git`, `node_modules`, `.smurg` and temp files.
  **Native calls** (2026-09-29: a gate worker died with SIGTRAP, "memory corruption of free block" inside
  `FSEventStreamCreate`; evidence in `yjs-monaco.md` Q7 "Watcher crash"): @parcel/watcher 2.6.0 changes process-global
  state on its libuv pool and FSEvents threads without the JS thread's locks. So every native subscribe / unsubscribe of
  every daemon in the process goes through ONE queue (`nativeWatcherQueue()`, one call at a time); a root is stat'ed as
  the same directory right before its subscribe (a failing native subscribe releases JS references off the JS thread);
  a subscription whose root was seen gone is released only after FSEvents reported the root deleted plus 500 ms (it
  stops that stream itself, on its own thread, unlocked) or after 5 s (the native module reports nothing when the root
  is back before FSEvents delivered its move: live updates of a folder moved away and back then resume ~5 s after its
  return instead of ~0.5 s; seen once in a full gate run, gate-stability 2026-09-29); `unregisterWorktree` resolves only once the
  watcher released the root (listeners of a removal may return a promise), so the worktree manager renames the
  directory away afterwards; `stop()` releases the roots one by one and waits for every native call (a process that
  exits with live subscriptions can abort); the callback of a released subscription or a removed root does nothing.
  `WatcherOptions.native` is the seam the tests instrument (`test/files/watcher-native.test.ts`). Residual native
  races: §12.

### 7.6 Sessions (see `docs/research/pty-packaging.md`, `claude-hooks.md`)

**Who runs what (§11 D-15).** Every session runs like the host's own, whoever opened it: as the host's OS user,
unsandboxed, with the host's environment (below), `HOME` = `config.sessions.hostHome`, the host's `claude` and its
login and `~/.claude`, in the main workspace or a worktree (R9). `session.create` needs `session.create` (the host and
"Agent access", the member's CURRENT role, checked by the router and again in `SessionManager.create`); the member who
opens a session is its owner (`SessionInfo.ownerUserId` / `ownerName`): the agent is `Claude (owner)` in presence,
locks, the activity feed and the audit log, the hook registration carries the owner's id, only the owner ends it
(`session.end`) and its PTY follows the owner's viewport. Every holder of `session.drive` (the host, "Agent access")
types into any session and decides its suggestions; editors and viewers watch (and suggest, R6).

**Launch.** Every agent session is started as
`claude --settings <~/.smurg/sessions/<wsKey>/<hex(id)>/settings.json> --mcp-config <…/mcp.json>`. No permission-mode
flag, and never `--dangerously-skip-permissions`. The hooks module is the ONE writer of these files
(`HookServer.writeSessionFiles`, contract in `core/interfaces.ts`); the sessions module checks the returned flags
(fail closed without `--settings` and `--mcp-config`, or with any permission flag) and waits for `removeSessionFiles`
when the session ends.

Session settings (daemon-owned file, the same for every session):

```jsonc
{
  "disableAllHooks": false,
  "env": { "CLAUDE_CODE_SAFE_MODE": "0", "CLAUDE_CODE_SIMPLE": "0" },   // otherwise hooks can be switched off
  "disableDeepLinkRegistration": "disable",
  "permissions": { "allow": ["mcp__smurg"], "disableBypassPermissionsMode": "disable", "defaultMode": "default" },
  "hooks": { /* one exec-form command hook per event: { "type": "command", "command": "<smurg>", "args": ["hook"], "timeout": 10 } */ }
}
```

Hook events registered: `PreToolUse` (matcher `Edit|Write|MultiEdit|NotebookEdit`), `PostToolUse`,
`PostToolUseFailure`, `PermissionRequest`, `UserPromptSubmit`, `Stop`, `SessionStart`, `SessionEnd`.
`FileChanged` is registered for the activity feed only (its matcher: at most 50 plain top-level file names of the
session root); correctness never depends on it (it only watches literal file names in the cwd). The R8 fallback is
driven by the daemon's own watcher.
The lock hook never returns `permissionDecision: "allow"` (that would skip the session's permission prompt): it returns
nothing on success and a JSON deny with a reason that names the holder on failure. An agent's lock request goes through
PathGuard as its OWNER (§7.4), so a member's agent is refused Edit / Write of host-only paths (`.claude/**`, …) like
the member's own `file.*` requests; its shell is not limited (§11 D-15).
With `config.activity.attributeBashEdits` (default true; §11 D-13) `PreToolUse`, `PostToolUse` and
`PostToolUseFailure` also get a SECOND matcher group, `Bash`, with its own handler
`{ "command": "<smurg>", "args": ["hook", "bash-activity"], "timeout": 5 }`: the Bash activity hook (§7.7). The edit
tools' groups stay exactly the lock hook; with the switch off the Bash group is not written at all.

**Session environment** (`sessions/host-env.ts`) — the host's own, minus variables injected by a parent Claude session
(scrubbed by prefix: `CLAUDECODE`, `AI_AGENT`, `CLAUDE_PID`, `CLAUDE_EFFORT`, `CLAUDE_AGENT_SDK_*`, `CLAUDE_PREVIEW_*`,
`CLAUDE_CODE_*` except the host's provider variables; always drop `CLAUDE_CODE_SAFE_MODE` and `CLAUDE_CODE_SIMPLE`) and
minus every `SMURG_*` (a daemon started inside another session must not pass its identity on); then `HOME`, `TERM`,
`COLORTERM`, `SMURG_SESSION_ID` and, for agent sessions, the hook's `SMURG_HOOK_SOCKET` / `SMURG_SESSION_TOKEN`. The
host's own login and provider settings (`ANTHROPIC_API_KEY`, `CLAUDE_CODE_USE_*`, …) stay: every session uses them.

**PTY.** One `PtySession` per PTY, `encoding: null`, output coalesced (5 ms / 64 KiB) and addressed by absolute byte
offset; fan-out to a daemon-side `@xterm/headless` mirror (5000 lines), a 2 MiB raw tail and every attached viewer.
Re-attach = mirror snapshot (full scrollback) taken inside `term.write('', cb)`, then the raw gap, then live.
The snapshot keeps as much scrollback as fits the attach payload: two small trial serializations estimate it, then at
most 3 bounded passes, and an unchanged terminal reuses the last snapshot (~360 ms for the first attach
of a 31 MB colourful history, ~60 ms after). Flow control: the PTY is paused while any ready viewer's
connection has more than 1 MiB queued (`bufferedAmount`, which is the shared host uplink for relay clients) and resumes
below 256 KiB, next to the mirror's own 1 MiB lag limit, so one chatty terminal can no longer hold every member's
traffic behind tens of megabytes. Local attach reports 0.
Input from every holder of `session.drive` (the host, "Agent access"), into any session; resize only from the owner (the
member who opened it): the PTY size follows the owner's most recently active client; everyone else, the other members
who type included, renders at the PTY size. The daemon mirror is the only responder to terminal queries: web viewers
register the full set of swallow-handlers and `smurg attach` strips queries and OSC 52 from the output stream.

**Ending a session (owner ends, host terminates, its owner kicked / leaving / set below "Agent access", daemon
stops).** `killTree`: the PTY child's process group + descendants found by walking `ppid` + same-uid processes whose
environment carries this session's exact `SMURG_SESSION_ID`; `SIGSTOP`, re-scan, `SIGKILL`, in rounds (measured < 1 s).
The §0 rule applies: nothing is signalled that is not positively tied to the session. There is **no** system-wide
sweep (§11, D-3). As built, because macOS hands out freed pids again within milliseconds: every target is identified
by pid + start time + full command line (the env-marker scan is bound to the same identity); the PTY-child root counts
only while it is still the daemon's own child and not another session's PTY child or a helper; one scan only ever sends
`SIGSTOP`, `SIGKILL` goes only to the frozen tree a second scan confirms, and a pid whose identity changed gets
`SIGCONT` at once. Every session's descendants are remembered every 2 s (and recorded in `live.json`). When a
session ANOTHER member opened exits by itself (`exit`), its leftovers (a `nohup … &`) are killed too, so that removing
that member later ends everything they started; the host's own background jobs are theirs to keep, as in any terminal.
Kick / leave (`channel.leave`, §11 D-9) / a demotion below "Agent access": `SessionManager.killAllForUser` ends every
session that member opened, each audited as `session.terminate` by the system with `detail.reason` `kicked` / `left` /
`role-changed` (`SessionInfo.endReason` the same); R2's 3 s and R4's 5 s bound the whole teardown (`admin/handlers.ts`
waits for it). `smurg stop` (SessionManager.stopAll) ends every session.

**After the end.** An ended session (`status: 'exited'`, with `endReason` / `endedBy`) stays in `session.list`, with
its mirror for late viewers (≈17 MiB each), for 15 minutes (`SessionLimits.exitedRetentionMs`) and at most 32 ended
sessions at a time (the one that ended first goes first); then the daemon forgets it, without a message (a client
learns it from its next `session.list`). Nothing removes an ended session earlier, for anyone: closing its tab is each
member's own view (§9).

**Login guide.** `claude auth status --json` run in the exact session environment decides `login` (the host's Claude
login, whoever opened the session); TUI strings are version-specific hints only. The host logs in in their own
terminal (or in any session's TUI, `/login`); there is no per-member login (§11 D-15).

**Accepted suggestions** are written to the PTY as a bracketed paste followed by Enter, by the one function that the
`suggest.accept` handler calls after its `session.drive` and pending checks.

**Claude Code version.** Every session runs the host's own `claude` with the host's account, and smurg never passes
`--model`: which model a session uses is between that CLI and that account, so the model the smurg team develops with
has no bearing on smurg's minimum version. What smurg relies on is its hook setup, and that is verified end to end on
**2.1.220 and 2.1.283** (`claude-hooks.md` ran every experiment on both; its §1.7 "pin exactly 2.1.283" is about the
development team's model and does not apply to smurg's users). The session settings are written to work on both. The
behavioural differences, and what covers each:
- **Auto mode** (2.1.283): interactive sessions start in auto mode, without edit prompts → the session settings carry
  `permissions.defaultMode: "default"` (harmless on 2.1.220).
- **Deny text** (2.1.283): the model sees `PreToolUse:<Tool> hook error: <reason>` → reasons read well after that
  prefix (§7.7); tests match the reason as a substring.
- **Project settings as a kill switch:** on 2.1.220 a project `env.CLAUDE_CODE_SIMPLE` turns every hook off; 2.1.283
  hot-loads a newly created project `.claude/settings.json` → the `--settings` `env` neutralizers win on both
  (verified), and `.claude/**` is host-only writable through smurg (§5.2).
- **Dialog defaults** (2.1.283): the trust dialog preselects "No, exit", the API-key dialog "No (recommended)" → the
  host answers them in the session's TUI like in their own terminal (the trust is then kept in the host's own Claude
  Code config, for that folder).
- **`PermissionRequest`** also fires for a `-p` auto-deny on 2.1.283 only → informational; no lock depends on it.
- **Login screens** differ → `claude auth status --json` (the same on both) decides `login`; TUI strings are hints.

Policy (`config.sessions`; `claudeVersionVerdict()` in `core/config.ts`): `claudeMinVersion` is `2.1.220`, the oldest
verified version, and `claudeVerifiedVersions` is `[2.1.220, 2.1.283]`. Before an agent session starts, the daemon runs
`--version` of the `claude` it will launch: below the minimum, output that does not start with a plain
`MAJOR.MINOR.PATCH`, newer than the newest verified version, or a version between two verified ones that is not listed
→ **warn, never refuse** (it is the host's own CLI; Claude Code updates itself and an update must not lock anyone
out): logged for the host and shown to the member who opened the session.

Adding a version to the verified list means re-running the `claude-hooks` spike on it (mock Anthropic API only, §0).
Tests that start the real `claude` accept any verified version.

**Launch inputs are configuration, never ambient** (`config.sessions`, `core/config.ts`):
- `hostHome`: the host's home, every session's `HOME`. `createDaemon` fills it from its `homeDir` option (default
  `os.homedir()`); tests pass a temporary fake home, so a session never reads the developer's rc files or `~/.ssh` in a
  test.
- `claudePath` (default: looked up on PATH at session start), `claudeMinVersion` and `claudeVerifiedVersions`
  (policy: "Claude Code version" above).
- `selfCommand: { file, args }`: how a session runs `smurg hook` / `smurg mcp` (the daemon cannot import the CLI):
  the CLI passes `process.execPath` + `[<cli>/src/main.ts]` in dev and the SEA binary in production. Without it the
  hooks module refuses to start sessions.
- The sessions module's test seams (`SessionsModuleOptions`: `hostEnv`, `hostShell`, …) replace the host's environment
  in tests (a mock Anthropic API through `ANTHROPIC_BASE_URL`, an isolated `CLAUDE_CONFIG_DIR`).
- `config.activity.attributeBashEdits` (default true, `ActivityConfig` in `core/config.ts`): the Bash activity hook and
  the attribution of Bash windows (§11 D-13); false ⇒ the Bash hook is not registered and Bash events are ignored.
- The hook socket path is `config.runPaths.hook` (§7.1).

### 7.7 Hook socket protocol

Newline-delimited JSON over `run/<short>.hook` (`config.runPaths.hook`). Every request carries the per-session token that the daemon put in
the session's environment (`SMURG_SESSION_TOKEN`); the daemon derives `sessionId` and owner from the token, never from
the payload.

```ts
{ id, token, op: 'hook', hookInput: <the JSON Claude Code wrote to the hook's stdin, including hook_event_name> }
   → { id, hookOutput: <JSON to print on stdout> | null }        // null ⇒ print nothing, exit 0
{ id, token, op: 'mcp', tool: 'who_is_editing'|'lock_status'|'wait_for_lock'|'list_sessions'|'notify_member', args }
   → { id, ok: true, result } | { id, ok: false, error }
```

`smurg hook` (hook-cli) and `smurg mcp` (coord-server, a stdio MCP server named `smurg`) are thin clients of this socket.
A malformed request is answered `{ id | null, error: { code, message } }` and the socket is closed. The hook forwards a
PROJECTION of Claude Code's input (event and tool names, ids, cwd, `file_path` / `notebook_path`, and the lifecycle
fields): file contents, prompts and transcripts never leave the hook process, and a request line is at most 64 KiB.
`smurg mcp` is a hand-written JSON-RPC 2.0 stdio server (the MCP SDK and zod would slow every start); neither entry may
load the daemon (a composition test enforces the import graph).

A `PreToolUse` for a path outside the session's root is denied, for host sessions too (no lock can be granted there,
and an unlocked edit of another root's file would bypass its locks): a host's agent cannot Edit/Write files outside the
share through smurg (Bash still can). §11 D-11 (approved).

**Everything that arrives on this socket is a claim, not a fact.** The agent can read its own token from its
environment and forge events for its own session. The daemon therefore: `realpath`s `tool_input.file_path` (or
`notebook_path`) and runs it through PathGuard; grants locks only inside the session's root; caps locks per session;
rate-limits requests per token; and bounds line length.

**Claude Code lets the tool run when a hook times out, crashes, exits 1 or is missing.** The hook must therefore fail
closed by itself: internal deadline of 5 s (shorter than the configured `timeout`), and on *any* error during
`PreToolUse` — socket unreachable, malformed reply, deadline — it prints a JSON deny and exits 0. The deny reason
reaches the model prefixed with `PreToolUse:<Tool> hook error:` on current versions, so reasons are written to read
well after that prefix, e.g. "This file is being edited by Amy. Work on other files first, or try again later."
These texts are fixed English (`packages/daemon/src/hooks/deny-text.ts`, §1 Languages): the reader is the model.

**Two hooks, two code paths** (2026-09-29, §11 D-13). `hook-cli.ts` chooses by the argument the DAEMON wrote after
`hook` in the session settings (never by anything a session sends), and any argument other than exactly
`bash-activity` selects the lock hook, so a typo can only make a hook stricter:
- `smurg hook` — `runLockHook`, the lock hook above: fails CLOSED;
- `smurg hook bash-activity` — `runBashActivityHook`, the Bash ACTIVITY hook, registered for `Bash` PreToolUse /
  PostToolUse / PostToolUseFailure only when `config.activity.attributeBashEdits` is on. It only tells the daemon
  "this session started / finished a shell command" (the same projection: never the command or its output), never
  takes a lock, never prints anything for a Bash event (it does not even read the daemon's reply), and FAILS OPEN:
  daemon unreachable, slow (its own deadline: 1 s) or answering nonsense ⇒ exit 0, no output, the command runs and
  nothing is attributed. The one thing it refuses is to let an EDIT tool's PreToolUse through (routed to it by a
  misconfiguration, it would otherwise run without its lock): that gets the lock hook's deny. Cost, measured on the
  development machine with the dev entry (node + TypeScript sources): ~52 ms per invocation, two per Bash tool call
  (the lock hook's full round trip is the same ~52 ms); the SEA binary starts faster (`smurg hook` without a daemon:
  31–32 ms, `packages/cli/test/sea.test.ts`, finish-gate).
On the socket a Bash event is `{ op: 'hook', hookInput: { hook_event_name, tool_name: 'Bash', tool_use_id, … } }`,
answered `hookOutput: null` whatever happens. The daemon pairs Pre and Post by `tool_use_id` (a forged Post cannot close
another command's window), keeps at most 8 open per session (10 minutes at most each), closes them on
`UserPromptSubmit`, `Stop`, `SessionEnd` and when the session ends, rate-limits them per session (240 per minute,
burst 60; beyond that they are ignored, on top of the per-token budget) and ignores them when the switch is off. The
windows reach the activity module as `agent.tool.pre` / `agent.tool.post` with `tool: 'Bash'` and `file: null`
(`outcome: 'granted'` means "the command runs": no lock exists), which every other listener ignores (they act on a
file). Attribution: §11 D-13.

---

## 8. CLI

Language (§1 Languages): `SMURG_LANG` (`en` / `zh-TW`; anything else is ignored) → the first non-empty of `LC_ALL`,
`LC_MESSAGES`, `LANG` (zh-TW when it is Traditional Chinese with a UTF-8 or no codeset) → on macOS, when all three are
unset, the system language (`defaults read -g AppleLanguages`, cached; a failure is English) → `en`. Resolved once in
`runCli` (`resolveLang(io.env, io.systemLanguages)`, over `localeFromEnv`) and carried in the command context
(`CommandContext.lang`); messages are lazy `Text` values (`m(id, params)`, `packages/cli/src/i18n/`) rendered only
where they are printed, so no throw site needs the language: `CliError.text` is what the person reads,
`CliError.message` its English rendering (logs). The installer follows the same order (`pick_lang` in
`scripts/install.sh`). English output is ASCII only. What the daemon refuses is rendered from the wire:
`render(lang, error.text) ?? render(lang, defaultErrorRef(error.code)) ?? error.message` (the control socket's error
replies are full error payloads, `{ ok: false, error: { code, message, detail?, text? } }`). What the daemon reports
in process is a code the CLI words itself: `ShareError.reason` (`SHARE_ERROR_REASONS`: why a folder cannot be shared),
`ShareLockError.reason`, `ControlSocketError.code`, and keep-awake's `PowerStatus.reason` (`POWER_REASONS`). The quoted
outputs below are the English ones; the zh-TW catalog has the same messages.

| Command | Behaviour |
|---|---|
| `smurg host <folder> [--relay URL] [--role R] [--expires D] [--max-uses N] [--name N] [--web-origin URL] [--no-keep-awake] [--no-browser] [--no-bash-attribution]` | refuse a folder that is already shared, that overlaps a folder a running host of this state dir shares (inside or around it, whatever the relay) or that contains a home directory, all before any login; login if needed (a stored login with less than 24 h left counts as missing); start daemon in the foreground, keep machine awake. `--role` is `agent` (Agent access, §11 D-15), `editor` (default) or `viewer`; anything else (`host`, the removed `runner`) is a usage error. **The start prints only the two links**: `smurg is sharing "<name>"`, the host link, the invite link (on `--web-origin`, e.g. the Vite dev server) under a line that names its expiry, and its use limit and role only when the host chose them, and `Press Ctrl-C to stop sharing.` Nothing else is printed at the start unless the host must act on it: keep-awake refused at the start (not when `--no-keep-awake` switched it off; a later loss is printed too). The explanations (SPEC §11's warnings, what "Agent access" means, the switch, the fingerprint, keep-awake, the log file, the relay) are in `docs/HOSTING.md` (named in `--help`) and the state of this machine in `smurg status`. `--no-bash-attribution` sets `config.activity.attributeBashEdits` to false (§11 D-13; default true). (Removed with the guest sandbox, §11 D-15: `--no-guest-subscription-login`, `--allow-main-workspace-guests`, `--no-main-workspace-guests`: unknown options now; and the daemon no longer runs from `~/.smurg/cwd`.) |
| `smurg attach [session] [--workspace W] [--invite -\|URL] [--relay URL] [--no-browser] [--accept-new-key]` | local daemon running → attach through the control socket as host; otherwise join through the relay with the CLI device key. The invite (its `#` part is the secret) comes from a no-echo prompt (`--invite -`) or `SMURG_INVITE`; a link in argv still works, with a warning (it is visible in `ps` and lands in shell history). An invite whose `k` differs from the key pinned for the workspace (the host started over with new workspace keys, `docs/HOSTING.md` §5.1 / §8, or someone poses as the host) is never used silently: the CLI prints the same explanation as the web (the host's computer key differs from before) with the pinned and the invite's fingerprints (`formatFingerprintForDisplay`, the form `smurg status` shows) and continues only on an explicit `y` at a terminal (`CliIo.readLine`; never from a pipe) or with `--accept-new-key`; then it connects with `preferInvite` (the invite verifies the new key, which replaces the pin). Otherwise nothing is sent and the pin stays |
| `smurg stop [--workspace W]` | ask the daemon (control socket) to stop: closes all channels, ends sessions; returns when the daemon is fully stopped |
| `smurg status [--workspace W]` | every running daemon of this state dir: folder, relay (marked when it is the built-in one) and link states, connections, the daemon key fingerprint, keep-awake (the same wording as `host`'s notices), the switch of §11 D-13 as the daemon runs with it, the log file. Fields a daemon of an older build does not send are left out |
| `smurg login [--relay URL] [--dev-user NAME] [--no-browser]` / `smurg logout [--relay URL] [--all]` | relay session for the CLI through the device-code login (§6; `packages/cli/src/relay/login.ts`): prints `On any device (a computer or a phone), open:`, `<relay>/device` and `Enter the code: XXXX-XXXX   (valid for 10 minutes)`, opens the page (never the code) when the browser rule below allows, then polls every `interval` s (+5 s after each `slow_down`; network and 5xx errors are retried until the code expires) until allowed (the session is saved), denied or expiry (exit 4); Ctrl-C ends it (exit 130). `smurg host` and `smurg attach` log in the same way when they need to. `--dev-user` only for a relay on a local hostname. (`--provider` is gone: the login method is chosen in the browser.) |
| `smurg update [--check]` | (`commands/update.ts`, `update/*.ts`) replaces THIS single executable with the newest published one. Reads `<downloads>/latest/VERSION` and compares it with the executable's version as semver: the same → says so; older than this one → says so (never a downgrade; a `-dev` build is older than its release); `--check` only reports (exit 0). A newer one: refuses while a `smurg host` of this state dir runs (it says to run `smurg stop` first; nothing is stopped from here: a share that keeps running would mix the old daemon with the new `smurg hook` / `smurg attach`), then streams `v<X.Y.Z>/smurg-<platform>-<arch>` into a temp file in the executable's own directory and installs it only when the announced size, the sha256 of that version's `SHA256SUMS`, the build marker (exactly one, naming that version) and the file's own `--version` all agree; macOS: `com.apple.quarantine` is removed after the sha256 matched (`/usr/bin/xattr`, as the installer); then one `rename` over `process.execPath` (0755; the bytes are never touched, so the ad-hoc signature stays valid). Prints `Updated smurg: old -> new` and the changelog's URL. Nothing is replaced on any failure and the temp file goes on every way out (error, Ctrl-C → exit 130, `process.exit`); a progress line only on a terminal; timeouts (15 s for the two small files, 30 s without a byte for the download). Refused: not the single executable (a source checkout: exit 2, it says to use git and pnpm), a directory that cannot be written (names it and the installer), a downloads site that is not https. `<downloads>` is `https://downloads.smurg.ai`, or `SMURG_INSTALL_BASE_URL` (tests, mirrors; the installer's variable and rule: https, or http only for 127.0.0.1 / localhost; a trailing `/v<X.Y.Z>` or `/latest` is dropped, so the installer's value works); redirects never leave that scheme |
| `smurg uninstall [--keep-data] [--yes]` | (`commands/uninstall.ts`) removes the executable itself (`process.execPath`), the cache (every `native-<id>` dir of every build in the cache root in force and in the platform's default one; an emptied root too) and the state dir (`--keep-data` keeps it). Everything is looked at and every refusal happens before anything changes; then it prints each path with its size and what stays, and asks `Remove these? [y/N]` through `CliIo.readLine` (`--yes` skips it; without a terminal and without `--yes` it refuses, exit 2; any answer but y / yes cancels, exit 1). Every running `smurg host` of this state dir is then stopped as `smurg stop` does and waited for; one that refuses or does not end aborts with nothing removed. Removal order: cache, state dir, the executable last. Never touched, only listed: the `.smurg/` of shared project folders (the folders of `workspaces.json` that still have one, and one around the current directory that holds the daemon's own entries), and shell profiles (it names the `PATH` line the installer suggested). Guards (fail closed): only the single executable uninstalls itself (a source checkout is told what to delete by hand); the state dir is removed only when its real path is not `/`, a top-level directory, the home directory or a folder around it or around `/Users`, `/home`; a `SMURG_HOME` other than `~/.smurg` must hold nothing but smurg's own entries (§7.1); a state dir that is a symlink is unlinked, not followed; a cache root or cache entry that is a symlink is skipped; `rm` never follows a symlink out of what it removes, and each path is removed only while it is still the file or directory that was listed (device and inode) |
| `smurg hook`, `smurg mcp` | internal entry points used by Claude Code inside sessions (the hook event is in the stdin JSON); dispatched before anything else is loaded |

**Arguments** (`cli/args.ts`): unknown options, a string option given twice, a boolean together with its `--no-` form
(`--bash-attribution --no-bash-attribution`) and surplus positionals are usage errors (exit 2), before anything else runs.

**Relay choice.** `--relay`, else `SMURG_RELAY_URL`, else the relay of the last login, else the built-in default: the
shared relay the project operates on Cloudflare Workers, `https://app.smurg.ai`
(`packages/cli/src/relay/default-relay.ts`, `docs/RELEASING.md` §3; it was the workers.dev URL of the first deploy
until 2026-10-01, before any release); `smurg attach` first takes the invite link's origin, or the relay a remembered
join used. Before
the release plan of 2026-09-30 there was no default (a guessed domain would have received the host's
login and every invite printed for it); an operated relay does not have that problem. Logins are stored per origin:
an invite link carries the WEB origin, which is the relay in production but not in development (Vite on :5173 in front
of the relay on :8787), so a CLI guest in the dev stack uses `--relay http://localhost:8787` (the CLI says so when it
finds a login for another origin).

**While `smurg host` runs** the host's terminal is told: the relay link
dropping (after 3 s without recovery, so blips stay quiet) and coming back; the relay refusing the host's login
(`auth-rejected`: members cannot connect) with the command to run; a stored login that expires within 24 h; and a state
file the disk refuses (the change is in force but would not survive a restart) and its recovery. `credentials.json` is
re-read every 5 s: a newer login of the SAME account for that relay (`smurg login` in another terminal) is handed to the
daemon (`Daemon.updateRelayToken`) without a restart; another account's login is refused with a notice (the workspace
belongs to the account that claimed it). A second Ctrl-C within 2 s of the first is ignored while the stop runs (it is
usually one impatient key press, and leaving mid-teardown can leave session processes stopped); a later one leaves at
once (exit 130). `smurg status` shows the link state `auth-rejected` as "the relay refused the host's login (run smurg login to log in again)".

**Update notice** (`update/notice.ts`). After `smurg host` printed its two links it asks
`<downloads>/latest/VERSION` once, in the background (never awaited; ended by a stop), with a 2 s timeout, and prints
ONE more line only when that version is newer than the executable: `Version 0.4.1 is available (this is 0.4.0): stop sharing, then run smurg update`. Nothing is printed when it is the newest, on any failure or timeout; no request is made with
`SMURG_NO_UPDATE_CHECK` set, in an automated run (`CI`, or stdin / stdout not a terminal: the rule of `browserBlock`) or
from source (where `smurg update` could not do what the line says). The request carries nothing about the machine. The
CLI's vitest setup and `isolatedEnv()` set `SMURG_NO_UPDATE_CHECK=1`; the tests of the notice use a local server.

**Browser.** A login opens the person's browser only through `CliIo.openUrl`, and the real implementation
(`cli/io.ts` `browserBlock`) never opens one when `SMURG_NO_BROWSER` or `CI` is set, over SSH (`SSH_CONNECTION` /
`SSH_CLIENT` / `SSH_TTY`), when stdin or stdout is not a terminal, or on a Linux without a display; the URL is printed
instead, with the code: the person opens it on any device (the device-code login needs nothing from this machine, so
SSH needs no port-forward). `--no-browser` does the same per command. The page is opened without the code; the person
types it. `scripts/env.sh`, `scripts/dev-stack.ts`, the CLI's vitest setup and every test helper that spawns the CLI
set `SMURG_NO_BROWSER=1`.

**`smurg attach` output.** Session output passes an allow-list filter (`attach/output-filter.ts`) before it reaches
the person's terminal: a VT parser state machine over the decoded UTF-8 (C1 controls U+0080–U+009F treated as their
7-bit ESC forms; ESC, CAN, SUB end a string as terminals do), which emits text, harmless C0 controls and only COMPLETE
allow-listed sequences, re-encoded (SGR, cursor movement, erase, scroll region, DEC private modes, kitty keyboard
push/pop, title stack, OSC 0/1/2 titles, OSC 8 http(s) links, colour sets). Queries, OSC 52, every DCS / APC / PM /
SOS, window operations and anything unknown are dropped whole; nothing is ever emitted half-way, and memory is bounded.
With a non-UTF-8 locale only ASCII text passes (UTF-8 continuation bytes would be C1 controls there).

**Control socket** (`run/<short>.ctl`, 0600 in the 0700 run dir; protocol in `packages/daemon/src/local/protocol.ts`,
exported by `@smurg/daemon` for the CLI). Frames on the stream: `[u32be length][u8 kind][body]`, kind `0x01` CONTROL
(UTF-8 JSON, ≤ 64 KiB) or `0x02` ENVELOPE (one msgpack Envelope). The client's first frame is one CONTROL request
`{ v: 1, op: 'status' }` | `{ v: 1, op: 'stop' }` | `{ v: 1, op: 'attach', deviceName, resume? }`; the daemon
answers one CONTROL response `{ ok: true, op, status | welcome }` or `{ ok: false, error }`. `status` is the
`DaemonStatus`; its `fingerprint`, `relayUrl`, `switches` (`{ attributeBashEdits }`) and `isGitRepo` came after 0.1.0
and are optional in the wire schema, so a newer `smurg status` still reads an older running daemon.
status / stop: the daemon then closes the socket (stop: and stops). attach: ENVELOPE frames both ways afterwards, on a logical channel of the
host admitted through `ctx.lifecycle.attachLocal()` (§4 Local connections). No Noise: the file mode authenticates —
the host's OS ACCOUNT, not the host: every session runs as that account (§11 D-15), so whoever drives a session can
connect here. On a local channel the router therefore accepts only what `smurg attach` sends: `session.list`,
`session.attach`, `session.detach`, `exec.input`, `exec.resize` and `channel.ack` (`LOCAL_CHANNEL_TYPES`,
`packages/daemon/src/local/local-channel.ts`; checked before the capability). Everything else — `admin.*` (invites,
roles, kicks, terminations, settings, the audit log), merge decisions, `lock.forceRelease`, `session.create` /
`session.end`, suggestions, files, documents, `channel.leave` — is refused `forbidden` {reason: `control-socket`} and
audited; every audit entry a local channel causes carries `detail.via: 'control-socket'`. What
it RECEIVES unasked is limited the same way, in the hub (`send` / `broadcast`, per logical channel, so nothing else is
queued for a resume either): only what `smurg attach` consumes, `exec.output`, `exec.resize`, `session.state`,
`channel.closed`, `channel.ack`, `presence.heartbeat` and `error` (`LOCAL_CHANNEL_RECEIVES`) — no live audit log
(`admin.audit.entry`), no host notices, presence, members, settings, suggestions, merges, documents or files
(verification F-1, 2026-10-02); answers to its own requests are not affected. The host decides on the host's relay
channels (the web console); `status` and `stop` are control requests, not channel messages, and are not affected. A
`stop` names no reason (a request with one is refused `bad_request`): the daemon's stop reason is always `smurg stop`
(`CTL_STOP_REASON`), and `smurg host` tells its own stops (a failed start, a failed summary) apart by what it did
itself, never by that text, so every other stop is told on the host's terminal.
The socket stays open until every other module stopped (it answers status with `stopped: true` and refuses attach
meanwhile), so `smurg stop` sees it go only when the daemon is done.

**Distribution.** `scripts/build-sea.sh --version X.Y.Z` builds the single executable for the current platform (the
version is injected at build time; other builds say `<package version>-dev`); `scripts/release-assets.sh` writes a
release's `SHA256SUMS` and an `install.sh` with the release URL filled in; `scripts/install.sh` installs only a
sha256-verified executable into `~/.local/bin` (macOS: it removes the quarantine attribute after the check); there is
no sandbox to set up on Linux any more (§11 D-15). The executable's extracted
native dir of an older build is removed after 30 days unused. Releases: `.github/workflows/release.yml` builds the four
executables on a tag `v*` (`macos-15`, `macos-15-intel`, `ubuntu-24.04`, `ubuntu-24.04-arm`; macOS signed ad hoc only);
from 0.4.0 the GitHub release carries the notes, `SHA256SUMS` and the notices only (no executables): the executables, the
installer and those two files are the workflow artifact `release-X.Y.Z` (kept 30 days). A person then runs
`scripts/publish-downloads.sh --version X.Y.Z --from-release`, which takes the files from that artifact of the tag's
successful run (`gh run download`), requires the release's `SHA256SUMS` and notices to be byte-identical to the
artifact's, verifies the files and uploads
them to Cloudflare R2 behind `https://downloads.smurg.ai` (`v<X.Y.Z>/`, immutable, then `latest/`); the one-line install
`curl -fsSL https://smurg.ai/install.sh | sh` is a 302 from the product page `apps/site` to
`https://downloads.smurg.ai/latest/install.sh`, with no GitHub fallback. An installed executable updates itself from the same
place (`smurg update`: `latest/VERSION`, then the version's `SHA256SUMS` and executable) and removes itself with
`smurg uninstall` (the table above). Every executable carries a build marker
(`smurg-build-version=X.Y.Z;`, a comment build-sea puts at the top of the bundle) and, as any Node.js release build, the
download URL of its Node.js release; `scripts/release-assets.sh` and `scripts/publish-downloads.sh` read both from all
four executables (`scripts/release-markers.ts`), so a release cannot mix in an executable of another version or another
Node.js than the one whose LICENSE its notices carry. Runbook: `docs/RELEASING.md`.

**Licenses.** smurg is MIT-licensed since 0.4.0 (`LICENSE`, Copyright (c) 2026 Guan-Chen, Lin; every `package.json`
says `"license": "MIT"` and stays `"private": true`: nothing is published to npm); 0.1.0 to 0.3.0 were released
before the license. The third-party notices are generated, never written by hand: `scripts/third-party-notices.ts` walks
`pnpm-lock.yaml`'s production closure of `@smurg/cli` (with the daemon and protocol, for the four release targets) and of
`@smurg/web`, and reproduces every package's license and notice files from `node_modules` into
`packages/cli/THIRD-PARTY-NOTICES.txt` and `apps/web/public/third-party-notices.txt` (a package without one fails the
generation; `pnpm check` fails while a committed file is stale). `scripts/build-sea.ts` refuses a stale file or a bundled
package it does not list (esbuild's metafile and the native assets), fills in the Node.js section from the LICENSE of the
Node distribution the executable is copied from, and embeds the result with `LICENSE` as SEA assets: `smurg licenses
[--third-party]` prints them, and the same notices are written next to the executable for the release. The web build
(`apps/web/vite.config.ts`) refuses the same way and serves the file as `/third-party-notices.txt`.

---

## 9. Web

Routes: `/` (landing + login), `/join/:workspaceId` (invite acceptance), `/w/:workspaceId` (workspace), `/w/:workspaceId/console` (host console).

```
apps/web/src/
├── boot/        capture-invite, locale (resolves the language before anything renders)
├── strings/     the catalog (`defineStrings(ns, en, zhTW)`) and the app-wide namespaces (+ `*.zh-TW.ts`)
├── app/         routes, providers, layout shell
├── lib/         connection (client SDK wrapper, reconnect, offline detection), device-key store (IndexedDB), stores,
│                locale (the language controller)
├── features/
│   ├── auth/        login, join flow, key-mismatch warning
│   ├── files/       file tree, root switcher, drag-drop upload, download
│   ├── editor/      Monaco + Yjs provider, presence cursors, lock banner, selection → suggestion
│   ├── agents/      session tabs, xterm panel, clickable paths, new-session dialog
│   ├── suggest/     suggestion composer + the deciders' queue
│   ├── activity/    activity feed, conflict panel
│   ├── worktree/    merge request + diff review
│   └── console/     members, sessions, invites, audit log, settings
└── ui/          shared components + design tokens
```

State lives in small stores keyed by message type; every store is fed by the single `Connection` object.
Role-based hiding in the UI is cosmetic; the daemon enforces.

Language (§1 Languages): `localStorage['smurg.lang']` → cookie `smurg_lang` → the first entry of
`navigator.languages` that is English or Traditional Chinese → `en`; `<html lang>` is `en` / `zh-Hant-TW`.
`src/boot/locale.ts` is the second import of `main.tsx` (after `capture-invite`, before the catalog and every
component), so the first render is already in the right language. `src/lib/locale.ts` is the one controller: the
catalog and the `Intl` formatters read the language at call time (`t('key')` takes no locale). The switch
(`LanguageMenu`, a globe button on the landing page, the join / login / connection screens, the not-found page and
the workspace's top bar; each language named in itself) records the choice in localStorage, mirrors it into the
cookie `smurg_lang` (the relay's attributes, §6), so the relay's `/device` page follows, and re-mounts the route tree,
which `app/App.tsx` keys by the locale: no reload; the stores, the services and the connection are kept, component
state is lost, and a toast on screen or an error sentence already in a store keeps the old language. Monaco and
xterm.js are not localised.

Strings: `defineStrings(namespace, en, zhTW)` (`src/strings/catalog.ts`); the English table (`strings.ts`) defines
the keys and its sibling `strings.zh-TW.ts` must have exactly them (a missing key is a compile error, an extra one
an error at load). A value is a template with `{placeholders}`, or in English the plural pair `{ one, other }`
chosen by `count`; a key that counts two things is two keys. `src/strings/strings.test.ts` checks the parity of the
two tables (keys, placeholders, plural forms), that English text holds no CJK and zh-TW text is Traditional Chinese,
and that no key is unused.

Wire texts: What the daemon says is rendered here: errors as
`render(locale, error.text) ?? render(locale, defaultErrorRef(error.code)) ?? error.message`, activity lines as
`render(locale, event.text) ?? event.summary`, daemon-written notifications as `render(locale, n.msg) ?? n.fallback`,
role labels with `roleLabel(locale, role)`. `summary` is never parsed. The web's own code-based wordings (connection states, session end reasons,
reason hints, transfer failures, audit labels) stay in the web catalog. A selection sent to an agent is headed by the
fixed `path:12-20` (one line: `path:12`).

As built after the review round (details in `apps/web/README.md`):
- `/join/:id` waits for an explicit "Join" before any connection (§4.1).
- Documents: a tab whose file is deleted turns read-only with who did it and "Create again from this content"; a renamed file's tab
  follows it (the renamer's) or offers "Open the new location" (everyone else), read from the `file.rename` activity event's `renamedFrom`
  (§5.4). Text typed while the host was unreachable is kept across a new epoch: re-applied when the
  host's text did not change meanwhile, otherwise offered back in a recovery notice (replace with my version / copy / discard);
  there is no automatic 3-way merge. `doc.rejected{file-unavailable}` says the unsaved text is in the
  conflict panel.
- Agent panel: the owner's panel (the member who opened the session) drives the PTY size: columns and
  rows are fitted to the visible area (`features/agents/terminal-fit.ts`, sent with `session.attach` and then as
  `exec.resize` on every panel, font or visibility change), with a floor of 80 × 24 for Claude Code (plain terminal
  20 × 5); below the floor the panel scrolls and a one-line hint says so. Everyone else, other drivers included, renders
  at the PTY size with visible scrollbars and "Scale to fit the width" (a CSS scale, nothing reflowed or sent; the daemon
  refuses another driver's resize). A maximize button; a session that ended without its owner says why (`endReason` /
  `endedBy`, e.g. that the host ended it); "Attach from your own terminal" shows the `smurg attach` commands.
- Closing an ended session's tab (2026-10-02: until then an ended session could not be closed;
  `features/agents/SessionTabs.tsx`, `closed-sessions.ts`). The tab of a session whose status is `exited` (whatever
  its `endReason`) has a close button (accessible name "Close <tab label>"; a sibling of the tab, in the tab order right
  after the selected tab), Delete on the tab and a middle click do the same, and the session's bar offers "Close tab"
  where "End session" was. Every member may close it, a viewer too, and only in their OWN panel: nothing is sent to the
  daemon (no message, no capability, nothing audited), the other members keep the tab and the console keeps its row. A
  RUNNING session has none of these controls (ending one stays the explicit `session.end` of the member who opened it
  and the host's `admin.session.terminate`), and a stored id never hides a session that is not `exited`. The closed
  ids are kept in this browser's localStorage (`smurg.agents.closedSessions`: workspace id → session ids, at most 16
  workspaces × 128 ids), so the tab does not come back on a reload or a reconnect while the daemon still lists the
  session; an id is dropped as soon as a loaded `session.list` no longer has that session as an ended one. After a
  close the neighbour to the right (else the one to the left) is shown and has the keyboard focus (no tab left:
  "New session"); the selected tab is scrolled into view together with its close button; a closed session that is
  focused by name afterwards (`focusSession`) is shown again; when every session is hidden this way, the empty
  panel says so ("N ended sessions are hidden because you closed their tabs.") and "Show ended sessions" brings them
  back (nothing is sent). **Deliberately not removed for everyone** when its
  opener or the host closes it: an ended tab is a read-only record that others may still be reading (why it ended, the
  last screen; the end dialog promises that the terminal's content can still be viewed), closing is a view action like closing an editor tab,
  and the shared list cleans itself: the daemon keeps an ended session for 15 minutes, at most 32 of them, then forgets
  it (§7.6; without a message, so a panel that stays connected keeps such a tab until its person closes it or reloads;
  showing that tab again finds nothing to attach to, and the terminal then says that the host's computer no longer
  keeps the content and that the tab can be closed, instead of a failure with a retry). Hence no `session.remove` and
  no protocol change.
- Roles and sessions (§11 D-15, 2026-10-01; `lib/capabilities.ts`: `canCreateSession`, `canDrive`, `drivesSession()`,
  `isRiskyRole()`): the host and `agent` members ("Agent access") open sessions with the new-session dialog
  ("Agent (Claude Code)" / "Plain terminal"; "Shared main workspace", "A new worktree of my own", continue a kept worktree), which
  says on top that the session runs on the host's computer with the host's Claude account; an editor or viewer gets
  the dialog's explanation instead and cannot submit. Drivers (host, `agent`) type into ANY running session and see
  the queue of pending suggestions on any session; editors and viewers see "Watch only" and editors suggest through the
  composer. Tabs name who opened a session (the default title is built in the viewer's language from `kind` + `ownerName`; the
  daemon sends a title only when the opener typed one). "Send to agent" in the editor
  pastes into any agent session for a driver and makes a suggestion for an editor. A merge request's diff is readable
  by every holder of `worktree.merge.request`. There is no login guide, login process, API key field or settings import
  any more: a logged-out agent (the host's Claude login) shows one line (drivers also get "Check login again"). The
  console shows the risk in an alert dialog (`RoleRiskDialog`) before an `agent` invite is created or a member is set
  to `agent`, and asks before taking the role from a member whose sessions would end; it has no sandbox column and no
  allowed-domains setting, and its kick / demote / leave texts name the sessions that end.
- The activity feed shows an agent's shell edit (§11 D-13) as that agent's, with a small "via a command" marker taken from
  `ActivityEvent.via === 'bash'` (never from the wording); "an outside program" appears only for the daemon's `system`
  actor. Every line is `render(locale, event.text) ?? event.summary` (§5.4).
- The suggestion queue (the host and `agent` members, any session) always sends the text on screen with
  `suggest.accept` (§5.6); "Send as a suggestion to ..."
  in the editor creates the suggestion in one click.
- The host can force-release a lock from the editor banner and the tree's context menu; the console's invite
  list refreshes on joins; the audit log shows each entry's details; merge decisions reach the
  requester as a notice and everyone's activity feed.
- Workbench layout (`app/workspace/layout-limits.ts`, `ui/SplitPane.tsx`): the file tree's separator leaves
  `minRightOfFiles()` to its right: the editor's minimum alone, or, while the agents column is shown beside it, that
  plus the column's own minimum and its separator, so a wide remembered file tree in a narrow window cannot squeeze
  the agents column below its minimum and freeze its separator. `SplitPane` shows the remembered size clamped to the
  container it observes (`ResizeObserver`) and reports the size shown (`aria-valuenow`); a drag starts from the size
  on screen and moves only while the primary button is held.
- Login buttons ("Log in with Google" / GitHub) come from one `GET /api/login-options` (§6; strict schema, `redirect: 'error'`; on any failure GitHub
  and Google are offered and the dev login never is). `/api/me` is asked only while the host-scoped cookie
  `smurg_hint=1` says a relay session may exist (set when a login starts, on a 200 and when a workspace connects;
  cleared on 401 or logout), so a logged-out page load has a clean console (the relay keeps `/api/me`'s 401: the SDK,
  the CLI and its tests rely on it). The cookie carries no identity and grants nothing.

---

## 10. Testing

| Layer | Where | What |
|---|---|---|
| Unit | each package `src/**/*.test.ts` | schemas, path guard, lock manager, reconcile, invites, permissions matrix, framing |
| Crypto vectors | `packages/protocol` | Noise test vectors, tamper/replay/wrong-PSK/wrong-key |
| Integration | `packages/daemon/test` | daemon + in-memory transport + headless client |
| Module integration | `packages/daemon/test/integration` | the REAL modules together (`createTestDaemon` without `modules` = DEFAULT_FEATURE_MODULES): docs + locks + hooks through the real `smurg hook` entry; sessions + worktree; suggest + sessions (real PTY); files + locks + docs; the real CLI's status / attach / stop on the control socket |
| Acceptance (E2E) | `tests/e2e` | real relay (local workerd) + daemon + headless clients; one file per requirement `r1.*.test.ts` … `r11.*.test.ts`, plus `r2.agent-role.test.ts` (the `agent` role: its session runs as the host, drivers type into each other's sessions, an editor may not, a kick ends it) |
| Claude-in-the-loop | `tests/e2e/claude.*` | opt-in (`SMURG_TEST_CLAUDE=1`): real `claude` with hooks (PreToolUse deny blocks Edit) |
| Browser | `apps/web/e2e` (playwright-core + system Chrome) | join flow, "Host offline", key-mismatch warning (Vite dev server) |
| Built app | `apps/web/e2e/smoke` (own vitest project; at most 2 files at once, in the full gate after every other project) | `vite build` once, served by the real relay's Worker assets (`startLocalRelay({ webDist })`), a daemon with every module, system Chrome: join → type → disk, two-browser co-editing, agent-lock banner, an `agent` member's terminal running as the host; the "Agent access" role (an `agent` member opens a session and types into the host's, an editor's suggestion accepted by the member; the console's risk confirmation); the console's one-click terminate / kick (R11.1c), suggestions (R6), worktree merge by an `agent` member (R9), a real conflict (R8.4), an upload resumed after a dropped transfer socket (R7.3, through a TCP proxy in front of the relay), a logged-out page load with a clean console, the terminal size, closing an ended session's tab (per viewer, with the button, Delete and "Close tab"; closed after a reload; never a running session; with a daemon that forgets ended sessions after 2 s: what the tab says then, and that a reload no longer has it); the two languages (`language.smoke.test.ts`: the English pages hold no CJK character; `zh-TW.smoke.test.ts`); the separators of the workbench (`splitter.smoke.test.ts`) |

Languages in tests: every package asserts English by default and has a small zh-TW suite; every test names its
language and nothing under test reads `LANG`, the system language or `navigator.languages` implicitly (a spawned CLI
or installer gets `SMURG_LANG=en`, the web setup pins `en`, browser contexts set `locale`, fetches of the relay's
pages send an explicit `accept-language`). The daemon and the protocol have nothing
to pin: their tests assert codes, reasons and message references (`toMatchObject({ code, detail: { reason }, text:
{ id, params } })`, activity `{ kind, text: { id, params } }`), hook denies against `hooks/deny-text.ts`, and
`packages/daemon/test/wire-texts.test.ts` checks statically that no wire error in the daemon is made from a string
literal, that the daemon's source has no CJK and that every catalog id is used. Catalog parity (both locales render
for every id and sample, every parameter is used, every enumerated value has its own wording) is
`packages/protocol/src/i18n/catalog.test.ts`. Enforcement across the repository is the root vitest project
`tests/lint` (a folder with a vitest config and no package of its own; the root `tsc` checks it), one file per rule:
`no-cjk.test.ts` (§1 Languages, rule 6: the zh-TW files and the mixed files with the rule their Chinese lines follow
are listed there; test files may hold Chinese data but no Chinese title), `catalog-parity.test.ts` (across packages:
every catalog has the two locales key for key; words two packages show for one thing are the same words, such as the
language names, the role labels, "Host offline" and the key-change title the CLI quotes from the web app, the login
button of the relay page and the web app; English says "log in", never "sign in"), `docs-parity.test.ts` (every user
document has its zh-TW counterpart with the same numbered sections; both changelogs carry the same sections with as
many entries each, `[Unreleased]` included), `docs-quotes.test.ts` (a list of catalog messages the guides and the
product page must quote as rendered, and the reverse: every quoted text of a guide is catalog text or a listed
exception), `pinned-locale.test.ts` (a test that starts the CLI or the installer, opens a browser context or fetches
a relay page names its language; only `*.zh-TW.test.tsx` pins zh-TW in the web unit tests) and
`acceptance-refs.test.ts` (every `file` › "title" reference of `docs/ACCEPTANCE.md` is a test that exists).

R3's acceptance criteria are the hard gate: each criterion has a named automated test, listed in `docs/ACCEPTANCE.md`.
(R5, the guest sandbox, was the other one until it was withdrawn on 2026-10-01, §11 D-15.)

Harnesses: `@smurg/daemon/testing` (`createTestDaemon`: in-memory relay with a byte tap, test identity issuer, temp
project optionally a git repo, real SDK clients; `createTempRunDir`, `isolatedGitEnv`, …) and `tests/e2e/src/harness.ts`
(`startStack`: real relay + daemon + clients; `git: true` shares a git repository; the host gets a fake home and a short
socket dir). `tests/e2e` also depends on yjs / y-protocols / lib0 and `@xterm/headless` + `@xterm/addon-serialize` for
the R7.1 (two Y.Docs) and R4.1 (terminal state) acceptance tests. Roles in both harnesses are `agent`, `editor` and
`viewer` (`createInvite(role)`, `join({ role })`).

---

## 11. Deliberate departures from the wording of SPEC.md

Each of these keeps the intent of the requirement and is backed by a verified finding.

**Status: D-1 to D-11 were reviewed and approved by the maintainers on 2026-09-28.** A departure added after that
is marked in its row until it is confirmed. D-15 (2026-10-01) removed the guest sandbox and with it D-12 and D-14
(both withdrawn) and the guests' half of D-4 and D-9.

| # | SPEC says | We do | Why (evidence) |
|---|---|---|---|
| D-1 | R4: guest hooks are written to `settings.json` in the temp dir; host hooks to `<project>/.claude/settings.local.json` | Hooks are passed to every session with `claude --settings <daemon-owned file>`. Nothing is written into the project's `.claude/`. | Both SPEC locations work but are writable by other people: a guest's own agent can edit its config dir, and collaborators can write project files. A project-level `disableAllHooks: true` silently turns off hooks from the other locations, which would bypass file locks. The host's global settings are still never touched. (`claude-hooks.md`) |
| D-2 | D6 / R9: agents work in a **git worktree** | The user-facing concept and the location `.smurg/worktrees/<id>` are unchanged, but each one is created with `git clone --shared --no-checkout` instead of `git worktree add`. | A real `git worktree` forces the sandbox to grant the guest write access inside the main repository's `.git` (objects, `worktrees/<name>`, refs), which contradicts R9's "cannot read or write the main workspace". A shared clone needs read access only. (`sandbox.md`, verification section) Kept after D-15 (no sandbox any more): a session in a worktree still writes nothing into the main repository through git, and every merge goes through the host's review. |
| D-3 | R2: a kicked user's session processes are terminated | Terminated: the PTY's process group, all descendants, and every process carrying the session's id in its environment. **Not** covered: a process that deliberately detaches (`setsid`) *and* scrubs its environment, on macOS and (since D-15: no sandbox, no PID namespace) on Linux. Such a process keeps running as the host's user. | The only way to find such a process on macOS is to scan every process on the machine with a private API and kill what matches. Two research spikes that tried this killed unrelated processes of the host user. The risk of harming the host outweighs the benefit for a prototype. Measured since: macOS reuses freed pids within milliseconds (so kills are identity-checked, §7.6), and `ps -E` hides the environment of Apple platform binaries (`/bin/sleep`, `/bin/sh`), so a platform-binary job orphaned before the first 2 s descendant scan also escapes a natural exit. |
| D-4 **(withdrawn 2026-10-01, D-15)** | R5: "read: deny the host's home by default" | Was: srt's read model (everything readable, then broad `denyRead` regions, then `allowRead` carve-outs). There is no guest sandbox any more (D-15). | — |
| D-5 | R3: the relay can only see workspace id, connection id, message size and timing | Also true for content, keys and device ids. But the relay performs the login, so it additionally knows the **account identity and IP address** of each connection. | Inherent to R2 (login at the relay). Stated openly rather than hidden. (`relay.md`) |
| D-6 | R8: `FileChanged` hook as the basis of the fallback | The fallback is driven by the daemon's own file watcher; `FileChanged` only feeds the activity feed. | `FileChanged` watches literal file names in the cwd only and misses the first moments of a session. (`claude-hooks.md`) |
| D-7 | §6: packages `web`, `relay`, `daemon`, `cli`, `protocol` | Adds `tests/e2e`. | Acceptance tests must depend on every package. |
| D-8 | R3: on a kick or a role change the daemon revokes the member's device keys | A **kick** revokes every device key of the member. A **role change** does not revoke keys: it closes the member's channels (`channel.closed{role-changed}`), the router applies the new role to the very next message, and the client reconnects with the same key and a fresh Welcome. Losing the right to open sessions (a role below "Agent access", D-15) ends the sessions the member opened. | Revoking the keys on a role change would lock the member out: they could only come back through a new invite, which makes "change a role" the same as "kick". What the requirement protects against — the old role still being usable — is achieved by the per-message role check and the channel close. |
| D-9 | R4: guests are logged out and their temp dir deleted when the guest leaves | "Leaving" is the explicit "Leave" (`channel.leave`): the sessions the member opened end within 5 s. A disconnect (closed tab, sleeping laptop) keeps them, because R4 also requires sessions to survive disconnects. (Until D-15 leaving also deleted the guest dir with the guest's Claude login, and guest dirs of members not connected for 7 days were removed; there are no guest dirs any more.) | A disconnect is indistinguishable from a network blip; ending sessions on every blip would break R4's rule that a session keeps running on the host when its client disconnects. |
| D-10 | R1: every refused request is refused and recorded | Every refusal is recorded, but a flood is recorded in bounded form: beyond 120 refused requests per actor and origin (the relay channels; the control socket, §8) per minute the audit log writes one "rate limited" entry and one summary with the count instead of one line per request, and a connection with more than 60 refusals in a minute is closed. | Without a bound, the lowest role (a viewer) could grow `audit.jsonl` on the host's disk without limit and push real entries out of every page. The fact of every refusal and its count stay in the log. |
| D-11 | D3: the host's session is not sandboxed | The host's agent is still refused (PreToolUse deny) an Edit / Write / NotebookEdit of a file outside the shared folder; Bash is unaffected. | The lock hook can grant locks only inside the session's root; allowing unlocked edits elsewhere would also let a main-root agent edit a worktree's files around their locks. The maintainers chose to keep this fail-closed behaviour (the alternative considered: outside every root → no decision, host sessions only). The deny reason tells the agent's owner that the file is outside the shared folder. |
| D-12 **(withdrawn 2026-10-01, D-15)** | R4 login guide; §13 (the Claude Code login flow in a remote PTY) | Was: a guest's own Claude subscription login as a dedicated, sandboxed login process (session kind `login`). Gone with the guest sandbox: every session uses the host's Claude login (D-15). | — |
| D-13 **(implemented 2026-09-29; switchable, on by default)** | R8 acceptance: every agent edit appears in the activity feed, saying which agent and whose it is; R11: the audit log covers agent edits | Edit / Write / MultiEdit / NotebookEdit changes (PostToolUse) and FileChanged-hook reports are attributed to the agent as before. NEW: **non-blocking Bash attribution.** A separate Bash ACTIVITY hook (`smurg hook bash-activity`, PreToolUse / PostToolUse / PostToolUseFailure of `Bash`, §7.7) only tells the daemon when a session starts and finishes a shell command; it never takes a lock, never decides, and fails OPEN (daemon unreachable ⇒ the command runs, nothing attributed), while the lock hook of the edit tools still fails closed. A disk change that nobody claimed (no agent lock, no Post echo, no announced writer) and that falls inside the Bash window of EXACTLY ONE session (every session runs unsandboxed since D-15, so any of them could have written anywhere), with 3 s of grace after the command ended (watcher latency), and whose root contains the file, is that agent's: `agent.edit`, `activity.agentBashChange` ("Claude (owner) changed ... with a shell command"), marked `via: 'bash'` in the feed entry (§5.4) and
the audit entry; two or more such windows, none, or a writer of another root: "an outside program" as before — and then not even the worktree rule below names anyone. In a worktree without a Bash window an unannounced change is still attributed to the one agent session running there, else to the worktree's owner. The decision is announced as `agent.tool.post` (tool `Bash`, the file), so the file tree badge and the R8 fallback's conflict record (whose source) follow the same rule; the fallback itself (human text kept, conflict record) is unchanged. Switch: `config.activity.attributeBashEdits` (default true; false ⇒ the Bash hooks are not registered and Bash events are ignored). Explained in `docs/HOSTING.md` §5, not on the host's terminal; `smurg status` shows whether it is on. | A session can forge Bash windows with its own token: they only ever attribute changes inside that session's own root, and only to that session (an agent can claim unannounced changes of its own root, never frame another agent or a person; while its window is open, an unclaimed change elsewhere is "an outside program" instead of anyone's); forged windows are paired by `tool_use_id`, capped (8 open, 10 min each) and rate-limited (240 / min, burst 60). Known limits: a change the host's own tools (an editor outside smurg, a terminal) make during an agent's Bash window in the same root is attributed to that agent; for 5 s after a person's autosave the file module attributes any change of that file to that person (not part of this rule). Cost: ~52 ms per hook invocation with the dev entry (two per Bash call). Tests: `daemon/hooks/hook-cli.test.ts` (Bash hook exits 0 with no output within its deadline in every error case while the Edit hook denies), `hook-server.test.ts`, `settings-writer.test.ts`, `claude-bash.test.ts` (real claude: a scripted Bash edit in the activity feed as the agent), `daemon/locks/activity.test.ts`, `bash-attribution.real-modules.test.ts` (the conflict record's source). |
| D-14 **(withdrawn 2026-10-01, D-15)** | R9: opening an agent session offers the shared main workspace or a worktree of one's own | Was: guests' sandboxed sessions kept out of the main workspace by default on a Linux host (`--allow-main-workspace-guests`, `PublicSettings.guestMainWorkspace`). Gone with the guest sandbox: R9's choice is open to everyone who may open sessions. | — |
| D-15 **(decided 2026-10-01; replaces SPEC R5, the guests' half of R4, D-4, D-12 and D-14)** | D3: the host's sessions are not sandboxed, and what guests cannot do they ask the host to run; R4 guest sessions (own temp `HOME`, credentials stripped, sandbox, logout on leave, imported config); R5 the guest sandbox; §8: the role that could run agents opened its own agent sessions and terminals inside the sandbox, and unsandboxed sessions were the host's only | **No guest sandbox and no guest agents.** The role "Agent access" (wire id `agent`; it replaces `runner`, which no longer exists anywhere) opens agent and terminal sessions (`session.create`) that run exactly like the host's own: the host's OS user, unsandboxed, the host's environment / `HOME` / `~/.claude` and Claude Code login, in the main workspace or a new / own kept worktree (R9 unchanged). Every holder of `session.drive` (the host, "Agent access") types into ANY session, the host's included, and accepts / rejects suggestions on any session (`suggest.updated` reaches them all); editors keep R6 suggestions and cannot type, viewers watch. The member who opens a session is its owner (`SessionInfo.ownerUserId` / `ownerName`): the agent is `Claude (<owner>)` in presence, locks, the activity feed and the audit log; only the owner ends it (`session.end`; the host terminates any session), and its PTY follows the owner's viewport. A kick, a leave (`channel.leave`) or a role below "Agent access" ends every session that member opened, each audited `session.terminate` by the system with `detail.reason` `kicked` / `left` / `role-changed` (R2's 3 s); a session another member opened loses its background jobs when it exits by itself. Merge requests: any holder of `worktree.merge.request` (the host, "Agent access"), for any worktree, and the same members review its diff; the host approves or rejects (unchanged); a request not made by the host is still verified blob by blob and refused when it carries host-only paths. Protocol version 2, 3 since 0.4.0 (§4.3) (the role id, `SessionInfo`, `session.create`, `PublicSettings` / `HostSettings` changed shape and every object is strict); a peer of another version is refused with the verdict `version`; no compatibility with protocol 1 or with 0.1.0 state files (nobody had installed 0.1.0). Removed: session kind `login`, `session.importConfig`, `session.create.apiKey`, guest dirs (`~/.smurg/guests`) and their 7-day retention, `PublicSettings.guestSubscriptionLogin` / `guestMainWorkspace`, `HostSettings.allowedDomains`, the error code `sandbox_unavailable`, the audit actions `sandbox.refused` / `session.import-config`, the `sandbox` module and `@anthropic-ai/sandbox-runtime`, the in-sandbox hook self-test (`SmurgProbe`), the guest variant of the session settings (`--strict-mcp-config`, `claudeMdExcludes`, `disabledMcpjsonServers`, the seeded `.claude.json`), the watcher's hand-off to the sandbox guard, `smurg host --no-guest-subscription-login` / `--allow-main-workspace-guests` / `--no-main-workspace-guests` (unknown options now) and the daemon's working directory `~/.smurg/cwd`. Kept: hooks / locks (R8) for every agent session, Bash attribution (D-13), worktrees and merge requests (R9), PathGuard and the host-only / host-private rules for what members do through smurg. | The maintainers chose usability over confinement (2026-10-01): one guest sandbox for macOS and Linux cost far more than a class group needs (§12 of earlier revisions: Linux mount residuals, the guard, placeholders, the login process) and still left members without their own Claude account outside. **Consequence, stated to the host in plain words** (`docs/HOSTING.md`, the console's confirmation): a "Agent access" member has the host's OS account in practice — through any session they can read and write everything the host can (`~/.ssh`, other projects, `~/.smurg` with the daemon key and `state.json`, so they could even change their own role), use and bill the host's Claude account and answer the host's own Claude Code prompts; the role is for people the host trusts completely. The control socket, which authenticates that OS account, accepts only what `smurg attach` sends (§8 "Control socket"), so such a member cannot make the host's decisions in the host's name through smurg (roles, kicks, terminations, merges, invites, settings, the audit log); what a local channel does is audited `via: 'control-socket'`. Revoking the role ends their sessions, not what they did as the host's OS user: `docs/HOSTING.md` §5.1 (after taking the role back) is the host's checklist (new workspace keys and invites, a new relay login, other credentials, persistence points). smurg's own checks still bind what members do through smurg (`file.*`, `doc.*`, uploads, PathGuard; a member's agent is refused Edit / Write of host-only paths by the lock hook because it acts as its owner), and editors / viewers keep the old boundaries (no PTY input, no sessions). Tests: protocol `roles.test.ts`, `schema/registry.test.ts`, `schema/session-info.test.ts`; daemon `authorization.test.ts` (every request × every role), `sessions/launch.test.ts` › the permission matrix, › every session runs like the host's own, › an agent an Agent access member opens…, › the sessions a member opened end when the member goes; `sessions/real-modules.test.ts`, `sessions/r4.test.ts`, `sessions/claude-real.test.ts`, `suggest/suggestions.test.ts` › who accepts, › suggest.updated reaches…, `worktree/merge.test.ts` › anyone with worktree.merge.request…, `settings.test.ts` › no guest switches, `local-control.test.ts` (› the local channel sends only what smurg attach sends: every client message of the registry over a local channel and over the host's relay channel; › what the local channel receives (verification F-1): every other daemon message of the registry neither sent nor queued, no `admin.audit.entry`; › a refusal flood through the socket leaves the host's own refusals on the web their audit budget (F-3)), `local/control-server.test.ts` › a stop request names no reason (F-2), `audit.test.ts` › the control socket has a budget of its own (F-3); cli `host-relay.test.ts` (`--role agent`, removed flags, attach typing; › a stop request names no reason … whatever its reason (F-2); › a start that fails is reported as the failure it is), `attach-args.test.ts` › the control socket carries only what smurg attach sends, › --help says who may type, `host-state-file.test.ts` › a CLI member after the host started over with new workspace keys (M1), `stop-status.test.ts`; e2e `r2.agent-role.test.ts`, `r11.console.test.ts`. |

## 12. Known limits of the prototype

- **Sessions opened by members run unsandboxed, as the host** (§11 D-15, 2026-10-01). A member with the
  role `agent` ("Agent access") opens agent and terminal sessions that run as the host's OS user, with the host's
  environment, HOME, `~/.claude` and Claude Code login, on the host's computer, and types into any session, the
  host's included. Nothing confines such a session: through it the member can run any command the host could, read
  and write everything the host's account can (the home folder, `~/.ssh`, other projects, the state dir `~/.smurg`,
  `.git` and `.envrc` of the share, which `file.*` hides from people), reach any network address, use and bill the
  host's Claude account, and answer the host's own Claude Code permission prompts. Worktree mode keeps work apart from
  the main workspace; it does not confine it (R9.1 / R9.2 are withdrawn for agents). There is no resource limit beyond
  the host's own (memory, disk, processes). What smurg does: the role is the host's explicit choice (an invite of that
  role, or a role change in the console after a confirmation that states the risk), editors and viewers cannot open or
  type into a session, every member sees every session live, the audit log records who opened which session, and the
  sessions a member opened end when the member is kicked, leaves or is set to editor / viewer. The user docs say it in
  plain words (`docs/HOSTING.md` §4 / §5.1, `docs/JOINING.md` §2 / §6, the product page): only for people the host
  fully trusts. Until D-15 (from the start to 2026-10-01) guests' own agents ran in a sandbox (srt: Seatbelt /
  bubblewrap) with their own Claude login; that design, its residuals and its tests are gone (`docs/research/sandbox.md`,
  historical).
- **Linux** was developed on macOS arm64. Since 2026-10-01 the whole gate runs on Linux and is green: in an Ubuntu
  24.04 arm64 VM and on CI's ubuntu-24.04 x64 (`.github/workflows/ci.yml`; counts in `docs/ACCEPTANCE.md` "Linux
  verification"; to be re-run after D-15). Not run on Linux: a real `claude`, keep-awake through `systemd-inhibit`
  from a local desktop session (from an SSH session polkit refuses it on Ubuntu: verified, and `smurg host` says so),
  the installer on a fresh machine. A single request that misses its NFC name on Linux
  (a create, an upload's commit) still lists its directory once, so an upload of n new non-ASCII names into a folder of
  m entries costs n listings of m entries.
- **Real accounts are not exercised by the tests.** Real Google / GitHub OAuth and a real Cloudflare deployment need
  credentials. They were first exercised by hand on 2026-10-01: the shared relay deployed to Cloudflare
  (`docs/RELEASING.md` §2, now at `https://app.smurg.ai`) and a maintainer's Google login in the browser there; the CLI
  login and a second account joining are still to do. GitHub login is not configured on the shared relay and stays
  untested against the real provider.
- **Browser device keys are not encrypted at rest** (see §4.2).
- Zip downloads are not resumable; archives that need ZIP64 for sizes/offsets cannot be opened by Apple's `ditto`
  (files ≥ 4 GiB are placed last and flagged).

Left after the review round of 2026-09-29, and the decisions that stand until changed:

- **Releases and downloads**: built by GitHub Actions on a tag `v*` for macOS arm64 / x64 and Linux x64 / arm64, each
  on its own runner (`macos-15`, `macos-15-intel`, `ubuntu-24.04`, `ubuntu-24.04-arm`), uploaded by a person to
  Cloudflare R2 behind `https://downloads.smurg.ai` (`v<X.Y.Z>/` never overwritten, then `latest/`); no Cloudflare
  credential lives in GitHub. The install line is `curl -fsSL https://smurg.ai/install.sh | sh` (a 302 to
  `latest/install.sh`). From 0.4.0 the GitHub release carries the notes, `SHA256SUMS` and the notices only. The
  workflows cannot run locally, and R1.1 (fresh machine to invite link in 3 minutes) is measured by hand. macOS
  executables carry an ad-hoc signature only (no Developer ID, not notarized); the installer relies on `curl` setting
  no quarantine attribute and removes one after the sha256 check. `SHA256SUMS` is not signed (open: minisign /
  Sigstore with a key pinned in `install.sh`), so it does not protect against a compromised GitHub account or
  workflow, or a compromised Cloudflare account that holds the bucket. `smurg update` (§8) has exactly the installer's
  trust: https, `downloads.smurg.ai` and the same unsigned `SHA256SUMS` (its checks of the build marker and of
  `--version` catch a mixed-up or broken file, not a forged one). It is all-or-nothing per file but not per machine: a
  `smurg host` of ANOTHER state dir (`SMURG_HOME`) that runs from the same executable is not seen and keeps its old
  daemon; and the update notice of `smurg host` tells `downloads.smurg.ai` (Cloudflare) the host's IP address at each
  start (`SMURG_NO_UPDATE_CHECK=1` switches it off). `smurg uninstall` removes what smurg wrote on this machine only:
  the relay keeps the account's sessions until they expire, and `.smurg/` in shared folders stays (listed). Intel
  Macs after August 2027 (GitHub's last x86_64 macOS runner image) are open. Runbook: `docs/RELEASING.md`.
- **License**: MIT since 0.4.0 (Copyright (c) 2026 Guan-Chen, Lin); the source is public at
  `github.com/gclinian/smurg`; 0.1.0 to 0.3.0 were released before the license. The third-party components keep their own
  licenses: their notices travel with every copy (§8 "Licenses").
- **The shared relay** (one relay at `https://app.smurg.ai`, the CLI's built-in default `DEFAULT_RELAY_URL`, Google
  login only; a release keeps its default relay forever; Cloudflare Workers free plan): the plan's daily limits are
  shared by everyone who uses it; when one is used up, connections and messages of that kind fail for every workspace
  until 00:00 UTC. An estimate from the code (not measured on Cloudflare): the WorkspaceDO alarm alone costs ~720
  requests and ~720 rows written per workspace-hour while anyone is connected, and a busy terminal watched by several
  members costs far more. The free plan's 10 ms CPU limit per request was not measured against the login routes.
  Every deploy disconnects every socket (clients reconnect). The operator of the shared relay (and Cloudflare) can
  see what D-5 says a relay sees, for every workspace on it. Hosts who cannot accept that deploy a relay of their
  own (`apps/relay/README.md`) and pass `--relay`; `docs/HOSTING.md` §2.1 / §2.2 say what the shared relay sees. Its
  web app is one build for every host's daemon, and it decodes the daemon's messages with strict objects (§5), so it
  refuses a daemon newer than itself (a field the daemon added is an unknown key to it; the reverse works, additions
  are optional): the shared relay is redeployed from each release's commit before the release is published
  (`docs/RELEASING.md` §4), and a host running a build ahead of it (for example from `main`) cannot be joined through
  it until the next deploy.
- **Linux verification**: GitHub Actions on ubuntu-24.04 runs the whole gate; still manual on a real Ubuntu machine:
  a real `claude`, keep-awake through `systemd-inhibit` from a desktop session, the R1.1 timing.
- **Decisions that stand until changed**: `.env` files are ordinary project files that every member reads; the
  default invite has no use limit and expires after 7 days; a kick takes effect in memory at once and is retried
  until the disk takes it; no operation updates a worktree from main (the host merges in a terminal).
- **Bash edits** (D-13): implemented 2026-09-29, switchable, on by default (§11). (D-12, the guests' subscription
  login, is gone with D-15.)
- **Attribution after an autosave** (files module): for 5 s after a person's autosave, any change of that file is
  attributed to that person (`EXPECT_CHANGE_TTL_MS`), so an agent's shell write in that window is shown as the
  person's and a conflict then names the person as the other side. Recognising the autosave's own echo by content hash
  (the docs module knows it) would remove this; not done (a change to the files and docs modules' event flow).
- **Relay sessions** are stateless 7-day tokens and cannot be revoked before they expire.
  The CLI's device-code login (2026-10-01) has the flow's known residual: a person can be talked into
  entering someone else's code (phishing); the confirmation screen names the account, where the request came from and
  when, and warns, but cannot prevent it.
- **The invite URL stays in the browser's history**; guest links from `smurg host` are multi-use for
  7 days unless `--max-uses` / `--expires` say otherwise.
- **Backpressure**: the hub has no priority queue in front of `ws.send` (a reply or heartbeat
  can wait behind up to 1 MiB of one viewer's terminal output, ≈ 0.9 s at 1 MiB/s); the relay's Durable Objects apply no
  backpressure toward a slow browser; exec.output queued for a disconnected channel is bounded only by the channel's
  outbox limits. The first attach of a very large colourful scrollback still blocks the daemon for ~360 ms (no
  worker thread).
- **Requests with an unknown outcome**: a request that timed out is never replayed, but there are no
  idempotency keys, so the person's own retry can repeat an action the daemon did carry out.
- **Clocks**: the relay link and the lock manager use the monotonic clock; the hub, the channel server
  and the rate limits still use the wall clock, and after a backward step audit `at` stays strictly increasing (entries
  can look up to the step size in the future).
- **State written late**: a change made while the disk refuses writes is in force and retried, but lost
  if the daemon stops or crashes before the disk takes it (`STATE NOT SAVED` in the log, a warning on the host terminal).
- **Documents**: an open document does not follow a rename on disk (the web tab does, from the
  `file.rename` activity event's `renamedFrom`); text typed while the host was down is merged back only when the host's text did not change
  meanwhile (otherwise it is offered back); this was tested with the web's in-test document room, not a real daemon
  restart.
- **Share lock**: a descendant folder already hosted by a daemon of another state dir is not detected.
- **Worktrees**: there is no operation to bring the main workspace's changes into a worktree; a
  conflicting merge is resolved by the host in their own terminal (`git merge refs/smurg/merge/<id>`) or rejected.
- **Hook reachability**: sessions run as the host, and a host agent runs no self-test of the hook
  before it starts (until D-15 a guest's sandboxed agent did). When `smurg hook` cannot reach the daemon, the lock hook
  denies Edit / Write / NotebookEdit (fail closed) and the Bash activity hook lets the command run (§11 D-13).
- **Keep-awake** is reported active once the inhibitor has run for 250 ms; one that ends at once is reported with its
  reason code (`PowerStatus.reason`, `POWER_REASONS`; `refused` when its stderr says it was refused: `systemd-inhibit` from an SSH session, where
  polkit's `org.freedesktop.login1.inhibit-block-sleep` is `allow_any=no` on Ubuntu, verified there only; any other
  polkit refusal, a site rule for a local session included, gets the same code, which the CLI words as a polkit refusal with SSH on
  Ubuntu as the example; its first stderr line goes to the log). A later loss is printed within 2 s.
- **Native file watcher** (macOS, @parcel/watcher 2.6.0; 2026-09-29, §7.5): the daemon no longer makes overlapping or
  failing native calls, but three races are inside the native module and cannot be closed from JS: FSEvents stops the
  stream of a root that is deleted or moved away on its own thread while an unsubscribe of that root may be running
  (reachable now only by an outside deletion in the same millisecond as the daemon's own unsubscribe: worktree removal,
  `smurg stop`); an event that arrives while a subscribe is still starting dereferences a null tree (`startStream` sets
  it after `FSEventStreamStart`); an unsubscribe while the FSEvents thread is inside the callback. Measured with stress
  children under load: every flow the daemon performs itself (worktree removal, a root moved away and back, roots that
  vanish, stop and exit) 0 crashes in 271 runs; an outside rename issued in the same tick as the unsubscribe 9 crashes
  in 63 runs; subscribe / unsubscribe churn during continuous writes 2 in 120 runs (≈ 1 per 250k–500k native calls).
  Such a crash still ends the whole daemon and every session. Follow-up: a supervised child process that owns the
  native watcher (a crash then costs a watcher restart and a re-list), or a patched @parcel/watcher.
- **Native file watcher on Linux** (@parcel/watcher 2.6.0, inotify, 2026-10-01): a new directory gets a
  watch only when the backend handles that directory's own creation, so the subdirectories made in the same burst
  (`mkdir -p`, a `git checkout`, an unpack) or moved in with their parent are never watched (measured: of a `mkdir -p
  one/two/three` and three files only `one` and its own file were reported; FSEvents reports all), and an inotify
  queue overflow is dropped without an error (319,496 of 320,001 creates reported, no error). Changes there reach
  neither the file tree's live updates nor the activity feed; a client sees them at its next listing. Follow-up: a
  patched @parcel/watcher that scans a
  newly watched directory (adding watches and reporting what it holds) and reports IN_Q_OVERFLOW as an error, or a
  periodic re-subscribe of a root that reported a new directory.
- **`smurg attach` output** assumes a UTF-8 terminal unless the locale says otherwise.
