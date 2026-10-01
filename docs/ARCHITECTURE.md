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

These exist because of real incidents during the research phase (two spikes killed unrelated processes on the
host machine by scanning the process table).

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
5. **Never block the daemon's event loop** (`spawnSync`, `execSync`, long synchronous diffs): srt's network proxy and
   the hook socket live in it.
6. **Fail closed.** Sandbox, hooks, path checks and permission checks deny when anything is uncertain.

---

## 1. Repository layout

```
smurg/
├── apps/
│   ├── web/            React + Vite SPA (Monaco, Yjs, xterm.js)
│   ├── relay/          Cloudflare Worker + Durable Objects (WorkspaceDO, TransferDO); also serves the web SPA
│   └── site/           smurg.ai product page (static files + a Worker for a few redirects; www is a zone rule)
├── packages/
│   ├── protocol/       zod schemas, roles/capabilities, Noise channel, framing, invite links, client SDK
│   ├── daemon/         host-side daemon (library + hook/MCP entry points)
│   └── cli/            `smurg` binary: host / attach / stop (+ internal: hook, mcp, login)
├── tests/
│   └── e2e/            cross-package acceptance tests (relay + daemon + headless clients)
├── docs/               ARCHITECTURE.md, research/, ACCEPTANCE.md
└── scripts/            dev + packaging scripts
```

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
| daemon | `node-pty@1.2.0-beta.15` (not 1.1.0), `@anthropic-ai/sandbox-runtime@0.0.77` (exact), `@xterm/headless@6.0.0`, `@xterm/addon-serialize@0.14.0`, `@parcel/watcher@2.6.0`, `fast-diff@1.3.0`, `diff@9.0.0`, `yazl@3.3.1`, `jose@6.2.12`, `ws@8.22.0` |
| relay | `wrangler@4.142.0`, `jose@6.2.12` |
| web | `react@19.3.0`, `react-dom@19.3.0`, `vite@8.3.1`, `@vitejs/plugin-react@6.1.1`, `monaco-editor@0.57.0`, `y-monaco@0.1.6`, `@xterm/xterm@6.0.0` |
| dev | `typescript@7.0.2`, `vitest@5.0.2`, `esbuild@0.28.2`, `playwright-core@1.63.0` (drives system Chrome, no browser download) |

Rejected with evidence (do not reintroduce): `noise-handshake`, `noise-protocol`, `noise-c.wasm`, `@libp2p/noise`,
`diff-match-patch`, `node-diff3`, `chokidar`, `archiver`, `zip-stream`, `fflate` (as zip writer),
`@monaco-editor/react`, `vite-plugin-monaco-editor`, `@cloudflare/vitest-pool-workers`, bun as daemon runtime.
- Identifiers, message types and file names are English. UI strings are Traditional Chinese (zh-TW).
- `tests/e2e` is an addition to the layout in SPEC §6: acceptance tests need a home that can depend on every package.

### Dependency rules

```
protocol  ← daemon ← cli
protocol  ← web
protocol  ← cli
relay     (no dependency on protocol's crypto; may import protocol's relay-control schemas only)
```

`protocol` must run unchanged in Node ≥ 22, browsers, and must not import Node built-ins from its
browser-reachable entry points (`@smurg/protocol`, `@smurg/protocol/client`). Node-only helpers go in
`@smurg/protocol/node`.

---

## 2. Trust model in one page

| Party | Trusted for | Not trusted for |
|---|---|---|
| Daemon (host machine) | everything; sole authority for permissions | — |
| Relay | availability, asserting *who logged in* (signed identity token) | confidentiality, integrity of content, the daemon's identity |
| Client (web/cli) | nothing | every request is validated + authorised by the daemon |
| Guest processes (agent/terminal) | nothing | confined by srt; hook/MCP socket input is untrusted |

Rules that follow (and that reviewers check):

1. **Every** inbound envelope goes through `Router`: zod-validate payload → capability check by role →
   handler-level resource checks (ownership, path guard). No handler is reachable without (1) and (2).
2. **Every** filesystem path from a client, a hook, or the MCP socket goes through `PathGuard` before any `fs` call.
3. Daemon secrets/state live in `~/.smurg/` (outside the shared folder). Guests' sandboxes cannot read it.
4. Denied requests (authz or path) are written to the audit log.

---

## 3. Identity, roles, capabilities

```ts
type Role = 'host' | 'runner' | 'editor' | 'viewer';
//            主人     可執行 agent  可編輯      旁觀

type UserId = string;        // relay-issued: "github:<id>" | "google:<sub>" | "dev:<name>"

type Capability =
  | 'file.read'              // browse tree, open docs, view sessions
  | 'file.download'
  | 'file.write'             // edit, create, rename, delete, upload
  | 'session.view'
  | 'session.create.sandboxed'   // own agent session / terminal, inside srt
  | 'session.create.host'        // unsandboxed host session
  | 'suggest.create'
  | 'worktree.merge.request'
  | 'worktree.merge.decide'
  | 'lock.force-release'
  | 'admin';                 // invites, roles, kick, audit, terminate any session, settings
```

| Capability | host | runner | editor | viewer |
|---|:-:|:-:|:-:|:-:|
| file.read, file.download, session.view | ✅ | ✅ | ✅ | ✅ |
| file.write | ✅ | ✅ | ✅ | ❌ |
| suggest.create | ✅ | ✅ | ✅ | ❌ |
| session.create.sandboxed | ❌ | ✅ | ❌ | ❌ |
| session.create.host | ✅ | ❌ | ❌ | ❌ |
| worktree.merge.request | ✅ | ✅ | ❌ | ❌ |
| worktree.merge.decide, lock.force-release, admin | ✅ | ❌ | ❌ | ❌ |

This table is implemented once, in `@smurg/protocol` (`roles.ts`), and used by the daemon for enforcement
and by the web app only for hiding UI.

Resource-level rules (daemon handlers):

- `exec.input`, `exec.resize`, `session.end`, `suggest.accept/reject`: caller must **own** the session (host may `admin.session.terminate` any).
- `suggest.create`: target session must belong to **someone else**.
- `worktree.merge.request`: caller must own the worktree.
- `lock.release`: caller must be one of the human holders.

```ts
type Actor =
  | { kind: 'user'; userId: UserId; displayName: string }
  | { kind: 'agent'; sessionId: string; ownerUserId: UserId; displayName: string }  // "Claude（Ian）"
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
  - The times are checked against the **relay's** clock, not the host's (review REL-05): the daemon estimates it from
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
     channel never replays it (review REL-03); `ClientRequestError.detail.sent` says whether it had been sent, and its
     message then says the outcome is unknown. There are no idempotency keys: a person who retries such a request may
     repeat an action the daemon did carry out.
  A logical channel continues only for the device (and user) it belongs to; a non-resumed admission of a device
  discards that device's other disconnected channels; fan-out keeps queueing to disconnected channels that can still
  resume (retention 15 min). A connection closed for too many refused requests loses its logical channel (§5.8).
- **Kick**: the daemon revokes every device key of the member, sends `channel.closed{kicked}` (authenticated) and then
  `peer.kick` on the same host socket, and the core ends the member's sessions, deletes the guest dir and aborts their
  uploads (for `member.kicked`, whoever kicked). **Role change** (§11 D-8): the router reads the role per message, so it
  applies to the very next one; the member's channels get `channel.closed{role-changed}` + `peer.kick` (a client reads
  that pair as "reconnect", not as a kick) and come back with a fresh Welcome; device keys are NOT revoked; losing the
  right to own sessions ends them and deletes the guest dir. A relay `bye 4003` without an authenticated reason before it
  is a kick for the client (terminal).
- **Liveness** (all three are required):
  - host → relay text `"ping"` every 2 s, answered by the DO auto-response without waking it; a DO alarm declares the
    host offline 6 s after the last ping and broadcasts `host.offline`;
  - daemon, CLI and web each run a **pong watchdog**: 6 s without `"pong"` ⇒ terminate the socket and reconnect with jitter;
  - daemon sends encrypted `presence.heartbeat` every 3 s; the client shows 「主人已離線」 after 8 s of silence from the
    daemon even if the relay says nothing. "Relay unreachable" is a *different* UI state from "host offline".
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
  logical channel, resume, router, fan-out and audit (`auth.connect` / `auth.disconnect` with mode `local`). Host only.

### 4.1 Invite link

```
https://<web-origin>/join/<workspaceId>#k=<daemon key fingerprint>&s=<one-time secret>
```

In production `<web-origin>` is the relay's own origin (the relay Worker serves the web app, §6): for the shared relay
`https://app.smurg.ai/join/<workspaceId>#…`. SPEC's example origin `https://smurg.app` is only an example (the project
does not own that domain); the tests' fixtures use it as an arbitrary origin.

The web app copies the fragment into `sessionStorage` and immediately removes it from the address bar
(`history.replaceState`) before any navigation (including the OAuth redirect). That only rewrites the tab's own entry:
the full URL, secret included, is already in the browser's global (and synced) history before any script runs (review
SEC-E-05, a residual risk; the console shows each link's uses live so a leaked link can be revoked).

`/join/<id>` never connects on page load (review SEC-E-02): after the login it shows the workspace id and the identity
the person is logged in as, and connects only when they click 「加入」 (「不要加入」 forgets the invite). A page that
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

- Request `X` → response `X.ok` (same `id`) or `error` (same `id`, `payload: { code, message, detail? }`).
- Unsolicited daemon → client events use a fresh `id`.
- `file.*` and `exec.*` never share message types or handlers (future two-way sync mode).
- Binary fields are real bytes (`Uint8Array`), never base64.

Error codes: `bad_request`, `unauthorized`, `forbidden`, `not_found`, `conflict`, `locked`, `path_denied`,
`sandbox_unavailable`, `insufficient_disk`, `too_large`, `host_only`, `internal`. Finer distinctions travel in
`detail.reason` and never become new codes (e.g. `bad_request` + `reason: 'hash-mismatch'`, `path_denied` +
`reason: 'outside-root'`). Local client-side failures (timeout, connection lost) are `ClientRequestError`, a
`SmurgError` with code `internal` and `detail.reason` = the failure.

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
| `channel.closed` | d→c | `{ reason: 'kicked'\|'revoked'\|'stopped'\|'role-changed'\|'protocol-error', message? }` | then the socket is dropped; also on the transfer socket |
| `channel.ack` | both | `{ upTo: seq }` | lets the peer trim its outbox; always `seq: 0` (unsequenced, §4 Resume) |
| `channel.leave` (addition) [none] | c→d | `{}` → `{}` | SPEC R4 「客人離開」: ends the caller's sessions and deletes their guest dir (which logs Claude out) within 5 s, audits `member.leave`; membership and device key stay. A mere disconnect does none of this (§11 D-9). The host's own leave is a no-op. |
| `error` | d→c | `{ code, message, detail? }` | on both sockets; answers a request (same id) or a refused one-way message |

```ts
type Member = { userId; displayName; avatarUrl?; role: Role; color: string; online: boolean; joinedAt: number };
type WorkspaceInfo = { id; name; hostUserId; hostName; platform: 'darwin'|'linux'; isGitRepo: boolean };
type PublicSettings = { humanLockIdleMs; agentLockTimeoutMs; uploadChunkSize; sharedDirs: string[];
                        guestSubscriptionLogin?: boolean /* addition: §11 D-12; config.sessions.guestSubscriptionLogin,
                           always filled by this daemon (Welcome and channel.settingsUpdated); not in HostSettings, so
                           admin.settings.set refuses it; undefined only from an older daemon */;
                        guestMainWorkspace?: boolean /* addition: §11 D-14; config.sessions.guestMainWorkspace (off by
                           default on a Linux host): whether a runner's agent / terminal may use the main workspace;
                           false ⇒ worktree mode only. Filled, refused by admin.settings.set and undefined (= allowed,
                           the old behaviour) exactly like guestSubscriptionLogin */ };
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
and redirect the host's API credentials. The same list is in the guests' sandbox `denyWrite`. `isHostOnlyPath()`
matches these names at ANY depth (nested `.claude/` directories are loaded too) and after `foldPathName()`: NFKC plus
a full case fold and HFS+ ignorable code points removed, because a case-insensitive file system treats more spellings
as the same entry than `toLowerCase()` does (on APFS `.vſcode`, with U+017F, IS `.vscode`). A false "host-only" costs
a guest one refused write; a false "not host-only" can run code on the host. PathGuard also decides on the on-disk
spelling of existing entries (§7.4). `<share>/.smurg` is not even readable for non-hosts (it holds other guests'
partial uploads and the worktrees, which are reachable as their own roots).

Host-private paths (review SEC-D-03, `isHostPrivatePath()` in `@smurg/protocol`): any `.git` directory, any `.envrc`,
and the host's personal Claude Code files `.claude/settings.local.json` and `CLAUDE.local.md`, at any depth and under
every folded spelling. PathGuard refuses them to every non-host for **reads as well** (`path_denied`, reason
`host-private`, audited), so guests (viewers included) cannot read `.git/config`, a deploy key in `.envrc` or the
host's personal settings through `file.read`, `doc.open` or a download. `file.tree` does not list them for non-hosts
(like `.smurg`), a guest's zip leaves them out (skipped as `host-private`), and conflict records about them are shown
to the host only. The guests' sandbox read-denies the same files (`.envrc` and the personal files; one definition in
`@smurg/protocol`), except `.git` for a guest agent in the main workspace (git needs it; §12, docs/OPEN-QUESTIONS.md).

The daemon's own directories are refused for mutation through `file.*` even for the host (`forbidden`,
`detail.reason: 'daemon-owned'`): `.smurg`, `.smurg/worktrees`, `.smurg/worktrees/<id>`, `.smurg/uploads/**` and
`.smurg/trash/**` (moving them away under the daemon would break resume, worktrees and the delete safety). Guests meet
PathGuard's audited `hidden` denial first. A write is refused with `locked` when a lock holds the file under ANY
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
| `file.download.end` | d→c | `{ downloadId, totalBytes, skipped: { path, reason }[], zip64: boolean, error?: { code, message, detail? } }` — `error` (addition): a download that failed after `begin.ok` (disk error, file gone) ends typed |
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
  lastModifiedBy?: Actor;        // drives the tree badge ("recently changed by Claude（Ian）")
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
| `doc.rejected` | d→c | `{ docId, reason: 'agent-locked'\|'read-only'\|'forbidden'\|'file-unavailable', lock? }` — client must resync and drop local change. `file-unavailable` (addition, review REL-01): the file was moved, deleted or became unusable (binary, too large, a link out of the share) on disk; the text not yet saved is NOT lost (see below), so clients must not say it was discarded |
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
that does not clear by itself, unlike a `git checkout`) is settled (review REL-01): every subscriber gets
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
| `lock.release` [file.write] | c→d | `{ file }` → `{}` — "讓 agent 先改": caller leaves the human lock |
| `lock.forceRelease` [lock.force-release] | c→d | `{ file }` → `{}` |
| `presence.heartbeat` | d→c | `{ at }` every 3 s |
| `presence.state` | d→c | `{ members: PresenceMember[], agents: PresenceAgent[] }` |
| `presence.update` | c→d | `{ activeFile?: FileRef \| null }` |
| `activity.event` | d→c | `{ event: ActivityEvent }` |
| `activity.list` [file.read] | c→d | `{ limit? /* ≤ 500 */, before? /* epoch ms, exclusive */ }` → `{ events: ActivityEvent[] }` — `at` is strictly increasing per log, so `before` is an exact cursor |
| `activity.notify` (addition) | d→c | `{ notification: { id, at, from: Actor, text /* ≤ 2,000 */, file?: FileRef } }` — only to the notified member's channels: the coordination MCP tool 「通知某位組員」 (`notify_member`, SPEC R8) |

```ts
type PresenceMember = Member & { connections: number; activeFile?: FileRef };
type PresenceAgent  = { sessionId; ownerUserId; displayName; color; activeFile?: FileRef; status: SessionStatus };
type ActivityEvent  = { id; at; actor: Actor; kind: 'agent.edit'|'human.edit'|'file.create'|'file.delete'|'file.rename'
                        |'file.upload'|'external.change'|'conflict'|'lock.denied'|'merge'; file?: FileRef; summary: string;
                        via?: 'bash' /* addition, §11 D-13: an agent.edit attributed through the shell-command window */ };
```

`merge` (addition, review WEB-11): a worktree merge request (actor: the requester), and the host's approval,
rejection or conflict (actor: the host), in everyone's feed. `file.rename` summaries are exactly
「重新命名 {from} → {to}」: the web client reads the old path from it (§9).

The human lock has no `lock.acquire` request: it is taken by the daemon when it applies the first Yjs update
from a human to a doc, and refreshed on every later update. `lock.acquire` exists only on the hook socket (§8).

### 5.5 `session.*` and `exec.*`

```ts
type SessionStatus = 'starting' | 'running' | 'exited';
type SessionInfo = {
  id; kind: 'agent' | 'terminal' | 'login' /* addition: a guest's own login process, §7.6 / §11 D-12 */; ownerUserId; ownerName; title;
  sandboxed: boolean; root: RootRef; status: SessionStatus; exitCode?: number;
  cols: number; rows: number; createdAt; endedAt?;
  login: 'unknown' | 'logged-out' | 'logged-in';
  attached: number;
  // additions (review WEB-12), set once status is 'exited':
  endReason?: 'exit' | 'ended' | 'terminated' | 'kicked' | 'left' | 'role-changed' | 'stopped';
  endedBy?: { userId; displayName };   // who ended it on purpose: the owner (ended) or the host (terminated)
};
```

| Type | Dir | Payload |
|---|---|---|
| `session.create` [session.create.*] | c→d | `{ kind, workspace: { mode: 'main' } \| { mode: 'worktree', worktreeId?: string }, cols, rows, title?, apiKey?: string }` → `{ session }` — `apiKey` (guest's own key, sandboxed sessions only) is held in daemon memory for that session, injected only into that PTY's environment, never persisted, logged or audited |
| `session.list` [session.view] | c→d | `{}` → `{ sessions: SessionInfo[] }` |
| `session.loginStatus` (owner) | c→d | `{ sessionId }` → `{ login }` — runs `claude auth status --json` in the session's environment |
| `session.attach` [session.view] | c→d | `{ sessionId, haveOffset?: number, cols?, rows? /* both or neither */ }` → `{ session, mode: 'snapshot'\|'delta', data: bytes, cols, rows, nextOffset }` — `snapshot` is a serialized terminal state painted after a reset; `delta` is raw output since `haveOffset` (only when still buffered and no resize happened since); `cols`/`rows` (addition): the owner's viewport, which sets the PTY size before the snapshot (resize policy `owner`); ignored for others |
| `session.detach` | c→d | `{ sessionId }` |
| `session.end` (owner) | c→d | `{ sessionId, keepWorktree?: boolean }` → `{}` |
| `session.state` | d→c | `{ session: SessionInfo }` |
| `session.importConfig` [session.create.sandboxed] | c→d | `{ files: { relPath: string, content: bytes }[] }` → `{ written: string[] }` — CLAUDE.md, `commands/**`, `skills/**` only, into the caller's own guest config dir; ≤ 500 files of ≤ 1 MiB and ≤ 7 MiB in total per request (one Envelope is ≤ 8 MiB + 32 KiB): clients split bigger imports, each request is written all or none |
| `exec.output` | d→c | `{ sessionId, offset, data: bytes }` |
| `exec.input` (owner) | c→d | `{ sessionId, data: bytes }` |
| `exec.resize` (owner) | both | `{ sessionId, cols, rows }` — c→d from the owner; d→c to attached viewers, in stream order with `exec.output` (they render at exactly the PTY size) |

The role decides which create-capability is required: host → `session.create.host` (unsandboxed),
runner → `session.create.sandboxed`. A client can never choose `sandboxed`.
With `config.sessions.guestMainWorkspace` off (the default on a Linux host, §11 D-14) a sandboxed `agent` /
`terminal` session with `workspace.mode: 'main'` is refused before anything is prepared: `forbidden` with
`detail.reason: 'main-workspace-off'` and a zh-TW message that points to worktree mode and to `smurg host
--allow-main-workspace-guests` (or, on a share that is not a git repository, says there is no worktree mode either),
audited as `session.create` / `denied` / target `main` with that reason. A `login` session (mode `main`, nothing of the
share) and the host's own sessions are not affected.

`exec.request.*` (R10, run-on-behalf) is reserved for the launch phase and not implemented.

### 5.6 `suggest.*`

```ts
type Suggestion = {
  id; sessionId; author: { userId; displayName }; text: string;
  source?: { file: FileRef; startLine: number; endLine: number };
  status: 'pending' | 'accepted' | 'accepted-modified' | 'rejected' | 'withdrawn';
  createdAt; resolvedAt?; finalText?; rejectReason?;
};
```

| Type | Dir | Payload |
|---|---|---|
| `suggest.create` [suggest.create] | c→d | `{ sessionId, text, source? }` → `{ suggestion }` |
| `suggest.edit` (author, pending) | c→d | `{ suggestionId, text }` → `{ suggestion }` |
| `suggest.withdraw` (author, pending) | c→d | `{ suggestionId }` → `{ suggestion }` |
| `suggest.accept` (session owner) | c→d | `{ suggestionId, text?: string }` → `{ suggestion }` — `text` is what the owner saw (or typed) and exactly it is pasted: `accepted` when it equals the current text, `accepted-modified` otherwise. Without `text`, an accept within 10 s of the author's last `suggest.edit` is refused (`conflict`, reason `suggestion-changed`, audited as denied): the author must not swap the text between the owner's review and the accept (review SEC-D-01). The web client always sends the text on screen. |
| `suggest.reject` (session owner) | c→d | `{ suggestionId, reason? }` → `{ suggestion }` |
| `suggest.list` [session.view] | c→d | `{ sessionId? }` → `{ suggestions }` |
| `suggest.updated` | d→c | `{ suggestion }` — to owner, author and host |

There is no auto-accept code path. The only function that writes suggestion text into a PTY is called from the
`suggest.accept` handler after the ownership check.

### 5.7 `worktree.*`

| Type | Dir | Payload |
|---|---|---|
| `worktree.list` [file.read] | c→d | `{}` → `{ worktrees: WorktreeInfo[] }` |
| `worktree.remove` (owner or host) | c→d | `{ worktreeId }` → `{}` |
| `worktree.merge.request` [worktree.merge.request] | c→d | `{ worktreeId, message? }` → `{ request: MergeRequest }` |
| `worktree.merge.list` [file.read] | c→d | `{}` → `{ requests }` |
| `worktree.merge.diff` (owner or host) | c→d | `{ requestId }` → `{ diff: string /* ≤ 1 MiB UTF-8 */, truncated: boolean, files: { path, status: 'added'\|'modified'\|'deleted'\|'renamed'\|'copied'\|'type-changed'\|'unmerged'\|'unknown', additions, deletions, oldPath?, binary? }[] /* complete, ≤ 10,000 */ }` |
| `worktree.merge.fileDiff` (addition) (owner or host) | c→d | `{ requestId, path }` → `{ path, diff: string /* ≤ 1 MiB */, truncated: boolean, binary: boolean }` — one file of `files` (any other path is refused), so the whole change can be reviewed when `merge.diff` was truncated (R9 「主人看到完整 diff」); the UI does not offer 「合併」 until every truncated file was opened |
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

**What a merge request contains** (addition, contract review C6). Agents normally edit without committing, so
`worktree.merge.request` (run as the worktree owner) first commits the worktree's working tree onto
`smurg/<owner>/<id>` with `message` (nothing to commit is fine), then fetches that commit into the main repository as
`refs/smurg/merge/<requestId>` and records its id in `MergeRequest.commit`. `merge.diff`, `merge.fileDiff` and
`merge.approve` all work on exactly that commit, whatever happens in the worktree afterwards; a later change needs a
new request.

As built (worktree module): the commit is staged in a daemon-private object store and index (state dir, outside
every sandbox; the index copy keeps the clone index's mtime so git's racy-clean rule still re-hashes files changed in
the same second as the checkout). For a guest's worktree every new blob is verified against a careful re-read of the
worktree (no symlink on the way, O_NOFOLLOW, same identity, a single hard link, same bytes) before the objects are
copied into the clone; nested repositories are refused. Approval refuses (status `conflict`, audit reason
`local-changes`) local changes and untracked or ignored host files the merge would overwrite, and runs
`git merge --no-overwrite-ignore`. A request in `conflict` may be approved again. Worktree mode needs git ≥ 2.42
(`merge-tree --write-tree`, `--attr-source`: attributes come from the host's HEAD, so a guest's `.gitattributes` cannot
select the host's filter or merge drivers); otherwise it is unavailable (`conflict` / `git-too-old`). Guests cannot write
any `.git` (host-only at any depth, also the worktree's own), so an agent in a guest worktree cannot commit: the merge
request commits on the owner's behalf. Removal renames `<id>` to `<id>.removing-<hex>` first (outside every sandbox's
write set) and deletes it there; the next start finishes leftovers.

`worktree.*` and `activity.*` extend the prefix table of SPEC §7.2; nothing in them overlaps `file.*`/`exec.*`.

**Implementation of a "worktree" (see §11, deviation D-2).** Each worktree is an isolated working copy at
`<share>/.smurg/worktrees/<id>` on its own branch `smurg/<owner>/<id>`, created with
`git clone --shared --no-checkout <share> <dir>` followed by a checkout of the main workspace's `HEAD`.
Objects are shared read-only through alternates, so a sandboxed guest needs only *read* access to `<share>/.git`
and can write nothing in the main repository. Merging: the daemon (as the host) runs
`git fetch <dir> <branch>:refs/smurg/merge/<id>` in the main repository, produces the diff for review, and on approval
merges that ref; on conflict it aborts the merge and reports `conflictFiles`. Rejecting leaves the worktree untouched.
Shared directories (D12) are linked into the worktree as symlinks that the sandbox exposes read-only.
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
type HostSettings = PublicSettings & { allowedDomains: string[]; diskReserveBytes: number; diskReservePercent: number };
```

Audit `action` vocabulary: `auth.join`, `auth.connect`, `auth.disconnect`, `auth.rejected`, `authz.denied`, `path.denied`,
`file.write`, `file.create`, `file.rename`, `file.delete`, `file.upload`, `file.download`, `doc.edit`, `agent.edit`,
`external.change`, `doc.conflict`, `doc.conflict-resolve` (addition), `lock.acquire`, `lock.release`, `lock.denied`,
`lock.force-release`, `session.create`, `session.end`, `session.terminate`, `session.import-config`, `sandbox.refused`,
`suggest.create`, `suggest.edit`, `suggest.accept`, `suggest.reject`, `suggest.withdraw`,
`worktree.create`, `worktree.remove`, `worktree.merge.request`, `worktree.merge.approve`, `worktree.merge.reject`,
`member.role`, `member.kick`, `member.leave` (addition, `channel.leave`), `invite.create`, `invite.revoke`,
`device.revoke`, `settings.change`.

- `auth.connect` / `auth.disconnect` (R11 「登入登出」) are written by the core for every connection (relay or local):
  target = deviceId, detail `{ mode, purpose, resumed }` / `{ mode, purpose, reason, durationMs }`.
- `detail` is sanitised by key (bytes → sizes; `content`, `data`, `token`, `url`, `hash`, `apiKey`, `diff`, … replaced)
  and strings are cut at 2,000 characters, except top-level keys the caller lists in `fullText` (R6.3: the suggestion
  module lists `text` and `finalText`, up to 64 KiB). Never put a sensitive payload in `detail`.
- The log is bounded (security review F5; §11 D-10): `denied` entries beyond 120 per actor per minute are counted, not
  written (one entry marks the start, one summary entry gives the count); a connection with more than 60 refused
  requests in a minute is closed with `protocol-error` and loses its logical channel (no replay of the flood);
  `audit.jsonl` is rotated at 32 MiB into `audit.1.jsonl` and `audit.2.jsonl` (0600) and queries page across them.

---

## 6. Relay

Routes (Worker):

See `docs/research/relay.md` for the verified spike this is built from.

One Worker, two SQLite-backed Durable Object classes keyed by workspace id (`getByName`), sharing a `RelayRoom`
base class: `WorkspaceDO` (interactive traffic + host liveness) and `TransferDO` (file chunks).
Hibernation API only (`ctx.acceptWebSocket(ws, tags)`); all routing state lives in tags (`host`, `client`, `c:<conn>`),
socket attachments and `ctx.storage.kv` — never in memory, because local workerd really hibernates after ~10 s.
The Worker also serves the web SPA (assets + `run_worker_first`), so web app and relay share one origin. For the
shared relay that origin is `https://app.smurg.ai`, a Cloudflare Custom Domain with the Worker's workers.dev hostname
off (it was `https://smurg-relay.gclin-ian.workers.dev` until 2026-10-01); a self-hosted relay defaults to its own
account's workers.dev. `scripts/deploy-relay.sh` deploys exactly one of these two shapes (`docs/RELEASING.md` §2).

| Route | Purpose |
|---|---|
| `GET /auth/:provider/login`, `GET /auth/:provider/callback` | `github` (OAuth App, state + PKCE), `google` (OIDC, state + nonce + PKCE) |
| `GET /auth/dev/start`, `POST /auth/dev/token` | dev-only provider: requires `DEV_LOGIN=1` **and** a local hostname |
| `GET /auth/cli/start` (confirmation page only), `POST /auth/cli/start` (same-origin form), `POST /auth/cli/token` | CLI loopback login (PKCE-bound code → bearer token); see "As built" |
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
- The CLI loopback login: `GET /auth/cli/start?port&state&code_challenge[&provider][&user]` has no side effect (review
  SEC-E-03): it answers a confirmation page (relay origin, local port, a warning to continue only after running
  `smurg login`, and a confirmation code `XXXX-XXXX` = first 40 bits of SHA-256("smurg-cli-login:" ‖ state) in the
  alphabet `A–Z 2–9` without I/O/0/1, which the CLI prints too: `cliLoginConfirmCode` in `@smurg/protocol/client`), served
  with `frame-ancestors 'none'`, `form-action 'self'` and `Referrer-Policy: same-origin`. Continuing is a form `POST
  /auth/cli/start` that needs `Origin` = the relay (or an allow-listed origin) and `Sec-Fetch-Site: same-origin` when
  present (else 403; a non-form body 415). The result reaches `http://127.0.0.1:<port>/callback?code|error&state`
  through a 200 relay page (meta refresh + link, no-referrer, no-store), never a 302, and so does the step to
  GitHub/Google: Chromium applies the submitting page's CSP `form-action` to every redirect after a form submission,
  which made the dev-login button do nothing (review OWNER-01). Then `POST /auth/cli/token {code, codeVerifier}`.
  Dev-only routes (`/auth/dev/*`, `/api/debug/room`) need `DEV_LOGIN=1` AND a local hostname.
- `GET /api/login-options` (2026-09-29) answers `{ providers: { github: boolean, google: boolean }, dev: boolean }`
  without a session: a provider is `true` when its configuration is complete (its login route would not answer 503),
  `dev` when `DEV_LOGIN=1` AND the request's hostname is local (`devLoginEnabled`, the same gate as the dev routes).
  Nothing else (no client id, no endpoint); `Cache-Control: no-store`; no CORS headers, like `/healthz`, the JWKS and
  `/api/me`; GET only. It is there so that the web app stops probing `/auth/<p>/login` and `/auth/dev/start` (WEB-14,
  §9), which puts a 400 / 404 / 503 into the browser console on every page load. `/api/me` keeps its 401 for a
  logged-out caller: the client SDK's login diagnosis (`probeLogin` in `client/engine.ts`), `RelayApi.me()`, the CLI's
  stored-session check and the relay tests rely on it.
- The relay's `build` refuses to bundle a missing web build, the stand-in page that `pnpm dev:relay` and the tests put
  into `apps/web/dist`, a build without `_headers` carrying a `/*` Content-Security-Policy with `frame-ancestors 'none'`
  or without a `/*` `Strict-Transport-Security` of at least a year (lines under another rule do not count), and a build that would serve `.vite/manifest.json` (`.assetsignore` must list `.vite`) (`scripts/check-web-dist.ts`).
- The SPA's own security headers (review SEC-E-04) come from `apps/web/public/_headers`, which Workers static assets
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
├── run/<short>.ctl                  control socket (host only): stop, local attach, status (§8)
├── run/<short>.hook                 hook + MCP socket (the only socket exposed into guest sandboxes)
├── run/<short>.pid
├── run/<short>.<hex4>.lk            share-lock socket of a running daemon (per instance; named in the folder's marker)
├── pins/<hex(utf8(workspaceId))>.pub   CLI pins of verified daemon keys (§4.2)
├── logs/<workspaceId>.log           daemon log of `smurg host` (0600; never invite links or secrets)
├── cwd/                             empty (0700): `smurg host` runs its daemon from here (§7.6, srt reads the cwd)
├── sessions/<wsKey>/<hex(sessionId)>/  daemon-owned launch files of an agent session: settings.json (hooks), mcp.json
│                                    (wsKey: 24 hex of the workspace id; hex(sessionId): case-fold safe)
├── guests/<wsKey16>/<userKey16>/    per-guest dir (16 hex of sha256 of the workspace / user id): home/ (HOME),
│                                    cfg/ (CLAUDE_CONFIG_DIR), tmp/ (TMPDIR); short, because guest tools bind sockets there
└── workspaces/<workspaceId>/
    ├── identity.key                 daemon static key
    ├── state.json                   members, devices, invites (PSK-derived keys), settings, roots
    ├── worktrees.json               worktrees and merge requests (worktree module)
    ├── audit.jsonl                  append-only; rotated at 32 MiB to audit.1.jsonl, audit.2.jsonl (§5.8)
    ├── activity.jsonl               rotated at 8 MiB into activity.1.jsonl
    ├── conflicts.json + conflicts/  conflict records and the agents' full versions (docs module)
    ├── suggestions.json
    ├── sandbox-placeholders.json    Linux: host-only names the guest sandbox holds in a root while it runs (§7.6)
    ├── git-home/, git-template/, git-staging/   private dirs of the worktree module's git runs
    └── uploads/                     partial uploads: <id>.json manifest, <id>.log journal, <id>.part
```

`<short>` is a 12-character id (`shortRunId(workspaceId)`, from SHA-256): macOS limits Unix socket paths to 104 bytes
including the NUL, and Node does NOT fail on a longer path — it binds the socket at a silently truncated path in
another directory, outside the private run dir and outside the sandbox allow-list. The run dir is `config.runDir`
(default `<stateDir>/run`, created 0700); `resolveConfig` computes `config.runPaths` and refuses (fail closed) any
socket path over 103 bytes (`assertSocketPath`, `src/core/sockets.ts`). Tests whose state dir is deep pass a short
`runDir` (`createTempRunDir()` of `@smurg/daemon/testing`).

`guests/<workspaceId>/<userKey>/` and every other per-id path must use a case-fold-safe name (like `pins/`): ids are
case-sensitive, APFS is not. `workspaces/<workspaceId>/` is safe because the daemon refuses a `state.json` of another
workspace id.

Inside the shared folder the daemon only creates `.smurg/` (`worktrees/` with transient `<id>.removing-<hex>` during a
removal, `trash/` for deletes in progress (emptied at start), `uploads/` when the state dir is on a different volume,
and `daemon-lock.json`), and adds `.smurg/` to `.git/info/exclude`. It writes nothing into `.claude/` (§11, D-1).

**One daemon per folder** (review CLI-05): `createDaemon` takes `<share>/.smurg/daemon-lock.json` (O_EXCL), which names
a Unix socket the daemon holds while it runs (`<runDir>/<short>.<hex4>.lk`). A live marker in the folder refuses the
share (`ShareLockError` reason `shared`), and so does a live marker in an ancestor folder (`ancestor-shared`), whatever
the state dir or relay; a marker whose socket answers nothing (a crashed daemon) is taken over. Not detected: a
descendant folder already hosted by a daemon of ANOTHER state dir (the CLI checks descendants of its own state dir).
`prepareShare` also refuses a folder that contains the host's home directory or `/Users`, `/home`, `/root`, `/var/root`
(review CLI-04): every guest would see `~/.ssh` and the rest.

`workspaces/<id>/state.json` writes that fail (disk full, permissions) are kept and retried with backoff up to every
10 s, and every `flush()` tries again (review REL-14): a kick, role change, invite revocation or settings change is in
force at once in memory (fail closed) and on disk as soon as the disk takes it; admin requests meanwhile answer
`internal {reason: 'state-not-saved', applied: true}` (`invite.create`: `applied: false`, the unseen link is revoked).
`smurg stop` while a document is unsaved logs `STATE NOT SAVED`. Failed audit appends are kept (≤ 4 MiB) and written
with the next one; a torn last line of `audit.jsonl` / `activity.jsonl` (a crash mid-write) is terminated when the log
opens (review REL-02).

`sessions` state (`live.json`) lists every running session with its PTY child and descendants
(`procs: { [sessionId]: { pid, id: sha256(start ‖ command) }[] }`, refreshed by the 2 s scan): a daemon that starts
after a hard death ends those leftovers through killTree (env marker, or a recorded identity that still matches; review
REL-09).

The single executable (`scripts/build-sea.sh`) extracts its native modules (node-pty, @parcel/watcher), srt's files and
the docs compute worker on first use to `~/Library/Caches/smurg/native-<id>` / `$XDG_CACHE_HOME/smurg/native-<id>`
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
├── sessions/    session-manager.ts pty.ts scrollback.ts guest-env.ts login-detect.ts handlers.ts
├── sandbox/     policy.ts harden.ts runtime.ts checks.ts selftest.ts service.ts refusal.ts
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
`daemon.stopping`, `state.write` (`{ document, ok }`: a state document the disk refused, or wrote again; review REL-14),
`relay.link` (`{ purpose, state, reason?, status? }`: every state change of a relay link, `auth-rejected` included;
reviews CLI-10, REL-08), `sandbox.protected-changed` (`{ root, paths, more, revoked }`: Linux, a host-only or
host-private entry changed while guest processes ran in that root, §7.6; reviews RV-1, RV-2). Payloads:
`core/interfaces.ts` (`DaemonEvents`). `smurg host` prints `state.write`, `relay.link` and
`sandbox.protected-changed` on the host's terminal (§8).

Per-client state that must survive a resume (doc subscriptions, attached terminals) is keyed by the logical channel
(`conn.channelId`), never by the socket (`conn.id`); service methods say `channelId` where they mean it. The core runs
the per-member teardown (sessions killed, guest dir removed, uploads aborted) for `member.kicked`, `member.left` and a
demotion that loses session capabilities; feature modules do not duplicate it. The activity module alone turns bus
events into activity entries and their audit entries (mapping in `ActivityFeed`, `core/interfaces.ts`); exceptions that
call `ActivityFeed.record` directly: the conflict panel (`conflict`) and the worktree module (`merge`).

**Relay link** (`net/relay-connection.ts`): a refused WebSocket upgrade reports its HTTP status. 401/403 (the host's
7-day relay session expired or was revoked) moves the link to `auth-rejected`: one error log that names `smurg login`,
and a retry of the same token only every `timing.relayAuthRetryMs` (5 min) instead of hammering the relay.
`Daemon.updateRelayToken(token)` (`RelayLink.setToken`) reconnects at once with a new token; `smurg host` calls it when
`credentials.json` has a renewed login for the same account. A link that drops is logged at warn with its reason, and
its recovery with the time it was offline. Heartbeat, pong watchdog and open deadline use `monotonicNow(clock)` (a
wall clock stepped back does not freeze them; review REL-04), and so do the lock manager's idle timeout and TTL
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
a guest can swap a parent directory for a symlink at any time, and the daemon is not sandboxed. Files are opened with
`O_NOFOLLOW` and verified with `fstat` against the `lstat` taken during resolution. After a write that moves a file
into place (autosave rename, upload commit) PathGuard performs one post-move containment check and removes the file
if it landed outside. Every denial is audited as `path.denied`, including a request the decoder refuses because its
path is lexically invalid (the hub audits it: `detail.reason: 'lexical'`, `problem`).

Additional rules (daemon-core; security review F1):
- For non-hosts the host-private paths (§5.2: `.git`, `.envrc`, `.claude/settings.local.json`, `CLAUDE.local.md`, at
  any depth) are refused for reads and writes with reason `host-private` (review SEC-D-03; host-only keeps precedence
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
  upload does, and counts a candidate as taken under either spelling (review RCR-3).
- Linux (2026-10-01): ext4, btrfs, xfs and tmpfs compare names byte by byte while every request is NFC, so an entry
  stored in another normalisation (NFD) would be listed but never reachable. A segment that is not found is mapped onto
  the ONE entry of its directory whose NFC form equals it (an exact NFC twin wins; two or more other spellings count as
  not found), and it then goes through every check like any other entry. Directory listings and the zip walker leave out
  names no request can reach (an NFD twin next to its NFC name); the zip reports them as `duplicate-name`
  (`workspace/fs-util.ts` otherSpellings / unaddressableNames). Looking for the other spelling lists the directory: a
  zip download, a watcher batch, an upload plan and a `file.tree` (review RV-7: a folder of n Mac-made sub-directories
  cost 2n listings of it at depth 2) each keep one listing per directory for the whole operation, up to 1024
  directories at a time (an older one is listed again if needed; it never fails) (`ResolveOptions.spellings`, fs-util
  SpellingIndex, review RCR-2; without it a folder of n Mac-made names cost n listings of n entries: a 20,000-file zip
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
  state `{ user: { name: 'Claude（Ian）', color, kind: 'agent' }, selection }` with the caret at the end of the last
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
  or chooses 「讓 agent 先改」.
- **Lock time** (review REL-04): idle timeouts and TTLs are durations measured on the monotonic clock (lock time = the
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

### 7.6 Sessions (see `docs/research/pty-packaging.md`, `sandbox.md`, `claude-hooks.md`)

**Launch.** Every agent session is started as
`claude --settings <~/.smurg/sessions/<wsKey>/<hex(id)>/settings.json> --mcp-config <…/mcp.json>` (guests also
`--strict-mcp-config`). No permission-mode flag, and never `--dangerously-skip-permissions`. The hooks module is the
ONE writer of these files (`HookServer.writeSessionFiles`, contract in `core/interfaces.ts`); the sessions module
checks the returned flags (fail closed without `--settings`, `--mcp-config`, and `--strict-mcp-config` for guests, or
with any permission flag) and waits for `removeSessionFiles` when the session ends.

Session settings (daemon-owned file, not writable from inside the sandbox):

```jsonc
{
  "disableAllHooks": false,
  "env": { "CLAUDE_CODE_SAFE_MODE": "0", "CLAUDE_CODE_SIMPLE": "0" },   // otherwise hooks can be switched off
  "disableDeepLinkRegistration": "disable",
  "permissions": { "allow": ["mcp__smurg"], "disableBypassPermissionsMode": "disable" /* host: + "defaultMode": "default" */ },
  "hooks": { /* one exec-form command hook per event: { "type": "command", "command": "<smurg>", "args": ["hook"], "timeout": 10 } */ }
  // guests: + "claudeMdExcludes" for every ancestor directory of the session root
}
```

Hook events registered: `PreToolUse` (matcher `Edit|Write|MultiEdit|NotebookEdit`), `PostToolUse`,
`PostToolUseFailure`, `PermissionRequest`, `UserPromptSubmit`, `Stop`, `SessionStart`, `SessionEnd`.
`FileChanged` is registered for the activity feed only (its matcher: at most 50 plain top-level file names of the
session root); correctness never depends on it (it only watches literal file names in the cwd). The R8 fallback is
driven by the daemon's own watcher. Guests' settings also list every server name of `<root>/.mcp.json` in
`disabledMcpjsonServers`.
The lock hook never returns `permissionDecision: "allow"` (that would skip the owner's permission prompt): it returns
nothing on success and a JSON deny with a reason that names the holder on failure.
With `config.activity.attributeBashEdits` (default true; §11 D-13) `PreToolUse`, `PostToolUse` and
`PostToolUseFailure` also get a SECOND matcher group, `Bash`, with its own handler
`{ "command": "<smurg>", "args": ["hook", "bash-activity"], "timeout": 5 }`: the Bash activity hook (§7.7). The edit
tools' groups stay exactly the lock hook; with the switch off the Bash group is not written at all.

**Guest subscription login (session kind `login`, §11 D-12;** implemented 2026-09-29 as recommended by the project
lead; switchable with `config.sessions.guestSubscriptionLogin`, default true; the owner's confirmation of the default
is pending). The guests' sandbox forbids listening on any port, so Claude Code's subscription login ("Failed to start
OAuth callback server") cannot run in a guest's agent session. Instead the guest starts a dedicated process with
`session.create { kind: 'login', workspace: { mode: 'main' }, cols, rows }` (`sessions/login.ts`):
- the daemon runs the FIXED command `<claude> --setting-sources project --settings
  '{"disableAllHooks":true,"env":{"BROWSER":"<no-op>"}}' auth login --claudeai` (the subcommand and flags exist on
  2.1.220 and 2.1.283), from a daemon-owned empty directory (`<stateDir>/sessions/<id>`, read-only inside). Nothing
  of it comes from the request: `apiKey` and worktree mode are refused (`bad_request`), `title` is ignored, only the
  terminal size is used. `--setting-sources project` keeps the guest's own `<cfg>/settings.json` out: `claude auth
  login` applies a user settings `env` block and then RUNS `$BROWSER` (verified on both versions: a planted script
  ran), which would give a guest's own program the login's extra right; the inline `--settings` pins `BROWSER` too;
- in that guest's sandbox (same guest dir as `HOME` / `CLAUDE_CONFIG_DIR`, the guest allow-list environment without
  a hook token, `BROWSER` a no-op, the hardened profile: the credential lands in `<guest>/cfg/.credentials.json`,
  never in the host's keychain), in sandbox mode `login`: read / write the guest dir only (the share and every
  worktree are denied explicitly, and so are the ancestor memory files an agent session may not read: it reads and
  writes nothing an agent session of the same guest cannot), read the settings dir and the claude binary. ONE extra
  right, added by the hardening step: `(allow network-bind (local tcp "localhost:*"))` + `(allow network-inbound (local
  tcp "localhost:*"))` right after srt's network header (TCP only: no UDP socket), and NO outbound rule (it cannot
  connect to the host's localhost services). Checked rule by rule against the agent session profile of the same guest
  by `test/sessions/login-profile.real.test.ts` (finish-gate): the same network section plus these two lines, the same
  srt environment words, an exec allow-list more, and no read or write carve-out the agent session does not have.
  Measured on macOS 26.5: Seatbelt's `localhost` admits every local address (0.0.0.0 and the LAN address too) and no
  Seatbelt filter narrows a listen to the loopback interface, so the login process also gets an exec allow-list
  appended last: `(deny process-exec)` + `(allow process-exec <the sandbox's /bin/bash> <claude> <no-op BROWSER>
  /usr/bin/security)` (Seatbelt checks an interpreter too). Claude Code's own callback server listens on 127.0.0.1
  (measured with lsof on both versions). srt's `allowLocalBinding` is never used: it is workspace-wide and grants
  bind / accept on every address AND connect to every localhost port. Linux (verified 2026-10-01): srt gives every
  sandboxed process its own network namespace (`--unshare-net`), so whatever the login process listens on, on any
  address, is reachable from that namespace only (measured: the host connects neither on 127.0.0.1 nor on its LAN
  address to a listener on 0.0.0.0 inside it, `test/sessions/login.real.test.ts`); the hardening refuses every guest
  command without `--unshare-net`, and the login needs no exec allow-list there;
- private to its owner: `session.list` shows it to its owner only (`SessionManager.listFor`), `session.state` goes to
  the owner only, only the owner attaches (anyone else: `not_found`), no other module sees it (`list()` / `get()` leave
  it out, no bus event names it), no suggestion can target it. The sandbox learns it is a login process from
  `SandboxSpec.loginProcess` / `loginPrograms` (`core/interfaces.ts`). Its output (the login URL, the pasted code) is never logged or audited;
  `session.create` (kind `login`) and `session.end` (kind, reason, exit code) are. One at a time per guest
  (`conflict` / `login-running`); it ends when the command exits or after 10 minutes (`terminated`); a kick, a leave
  or `smurg stop` end it like any session. The host is refused (`forbidden` / `login-guests-only`: the host's Claude
  is not sandboxed); with the switch off every guest is refused (`forbidden` / `guest-subscription-login-off`, 「這個
  工作區的主人沒有開放 Claude 訂閱登入：客人請在建立 agent session 時使用自己的 API key 登入…」, audited). The switch is
  published to every member as `PublicSettings.guestSubscriptionLogin` (`admin/settings.ts` `publicSettingsOf`: in the
  Welcome and in every `channel.settingsUpdated`), so the web offers only the API key when it is off;
- after it exited, the guest's running agent sessions check their login again (`session.state` with `login:
  'logged-in'` once the credential is there). A running Claude Code picks the new credential up on its NEXT prompt
  (verified with the mock API on 2.1.220 and 2.1.283: nothing to restart; 2.1.220 keeps showing 「Not logged in · Run
  /login」 in its status line until the session is restarted, cosmetic). Tests: `test/sessions/login.test.ts`,
  `login.real.test.ts`, `claude-login-pickup.test.ts`, `test/sandbox/login-policy.real.test.ts`.

**Guest environment** — built from an allow-list, never inherited: `HOME`, `CLAUDE_CONFIG_DIR`, `TMPDIR` under the
guest dir; `USER`, `LOGNAME`, `SHELL`, `TERM`, `COLORTERM`, `LANG`; `PATH` = claude's directory + system paths;
`BROWSER` = a no-op (otherwise Claude opens the login URL *on the host*); `DISABLE_AUTOUPDATER=1`;
`CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1`; `SMURG_HOOK_SOCKET`, `SMURG_SESSION_TOKEN`, `SMURG_SESSION_ID`.
Then assert that nothing matching the deny patterns is present (`ANTHROPIC_*`, `CLAUDE*`, `AWS_*`, `*_TOKEN`,
proxies, `NODE_OPTIONS`, `SSH_AUTH_SOCK`, …) — except the guest's own `apiKey` when supplied in `session.create`.
`<guest>/cfg/.claude.json` is pre-seeded with `projects[realpath(cwd)].hasTrustDialogAccepted = true`; without it the
trust dialog withholds every hook. Nothing is written into a guest's dir by path while any of that guest's processes can
run (a sandboxed process can swap any entry, the dir itself included, for a symlink to a host file): the trust seed and
`session.importConfig` write only while the guest has no running session, inside a quarantine (the dir is renamed out
of every sandbox's reach, lstat-checked, written and renamed back). `session.importConfig` is therefore refused while
the guest has a running session (`conflict` / `sessions-running`). `claude auth status` / `auth logout` for a guest run
inside that guest's own sandbox (the guest controls its config, e.g. `apiKeyHelper`).

**Host environment** — the host's own, minus variables injected by a parent Claude session (scrubbed by prefix:
`CLAUDECODE`, `AI_AGENT`, `CLAUDE_PID`, `CLAUDE_EFFORT`, `CLAUDE_AGENT_SDK_*`, `CLAUDE_PREVIEW_*`, `CLAUDE_CODE_*`
except the user's provider variables; always drop `CLAUDE_CODE_SAFE_MODE` and `CLAUDE_CODE_SIMPLE`).

**Sandbox (guests).** The srt *library*, pinned exactly.
- `SandboxManager.initialize(base)` once per daemon; per process `wrapWithSandbox(cmd, shell, perSession)` and spawn
  the result through node-pty.
- srt's read model is "allow everything, then `denyRead` regions, then `allowRead` carve-outs" (allow wins). SPEC's
  "deny the host home by default" is expressed as `denyRead` = home, `/Users`, `/Volumes`, `/private/tmp`,
  `/private/var/folders` (Linux: `/home`, `/root`, `/tmp`, `/var/tmp`, `/run`, `/var/run`, `/mnt`, `/media`,
  `/var/snap`, `/var/lib/lxd`, `/var/lib/incus`: the last three hold container-manager sockets the host user's groups
  may drive) and
  `allowRead` = session root, the guest dir, the claude binary, the session's settings dir, shared read-only dirs.
- `allowWrite` = session root + guest dir; `denyWrite` = shared read-only dirs + the host-only paths of §5.2.
  In main-workspace mode `<share>/.smurg` is denied for reading and writing.
- **Main-workspace mode for guests is a host switch** (§11 D-14, owner decision 2026-10-01):
  `config.sessions.guestMainWorkspace`, default `platform !== 'linux'` (`defaultGuestMainWorkspace` in
  `core/config.ts`; the platform is the daemon's own, `createDaemon` passes it to `resolveConfig`), set by `smurg host
  --allow-main-workspace-guests` / `--no-main-workspace-guests`, published as `PublicSettings.guestMainWorkspace`.
  Off ⇒ `SessionManager.create` refuses a sandboxed agent / terminal session in mode `main` (`forbidden`,
  `main-workspace-off`, audited) before the preflight, and guests work in their own worktree (a git share), which the
  main-workspace residuals below cannot reach: the main workspace is denied to a worktree session as a whole. On Linux
  everything below about guests in the main workspace ("protected entries while a guest runs" in the share, the nested
  host-only names of §12) therefore only applies when the host opened it.
- **Worktree mode (R9.1)** must deny the main workspace and every sibling worktree explicitly, wherever the share
  lives: the broad deny regions only cover it when the share happens to be under a home or temp dir (a share at
  `/srv/proj` would stay readable). `denyRead` and `denyWrite` get `<share>` and `<share>/.smurg/worktrees`, with
  `allowRead` carve-outs for the session's worktree, `<share>/.git` (read-only: the shared clone's objects) and the
  shared read-only dirs, and `allowWrite` only for the worktree and the guest dir (`SandboxSpec` in
  `core/interfaces.ts`). The sandbox module tests the generated policy with a share outside the broad regions.
- The host-only `denyWrite` entries must hold against every spelling a case-insensitive file system folds onto them
  (`.vſcode`, `.MCP.json`, §5.2): verify srt / seatbelt path matching with such spellings before relying on it, and
  add the folded variants explicitly if it matches byte-wise.
- Network: `strictAllowlist`, allow-list = Anthropic/Claude domains + common package registries + host additions;
  private address ranges denied; `allowUnixSockets` = exactly the hook socket. Linux: srt ignores `allowUnixSockets`
  (its seccomp filter blocks every AF_UNIX socket or none), so `allowAllUnixSockets` is on (srt then applies no
  seccomp filter at all) and the directories holding the host session's sockets are read-denied (above); the hook
  socket is a read-only file carve-out, abstract sockets belong to the guest's own network namespace (measured), and
  srt's network bridge sockets (bound in before the file-system mounts, so the `/tmp` tmpfs would hide them and every
  guest would be offline) are carved out too (`proxySocketPaths`).
- macOS profile hardening (all fail closed if the expected lines are not found in srt's output):
  strip the `com.apple.SecurityServer` / `com.apple.securityd.xpc` mach-lookups (keychain enumeration), restrict
  `allowPty` to the session's own tty, and (2026-09-29) accept in srt's network section only the proxy port's rules
  and the hook socket, and no network rule anywhere else (so srt's `allowLocalBinding` rules could never slip in). Of
  the proxy port's rules only the OUTBOUND one is kept (finish-gate, 2026-09-29): srt also writes bind + inbound on
  `localhost:<proxy port>`, which a sandboxed process never needs (the proxy lives in the daemon) and which, since
  Seatbelt's `localhost` matches every local address while the proxy listens on 127.0.0.1 only, let ANY guest
  process listen on `<LAN address>:<proxy port>` (or `0.0.0.0` with SO_REUSEADDR) and accept connections from the
  network (measured; `test/sandbox/network-listen.real.test.ts`). The login process only: the TCP listen rules and
  the exec allow-list (above).
- Linux hardening (2026-10-01, verified on Ubuntu 24.04 with the AppArmor user-namespace restriction on and the
  `smurg-bwrap` profile; `harden.ts` "Linux", `docs/research/sandbox.md` "Linux, verified 2026-10-01"): every bwrap
  argument srt writes (the arguments file's included) is checked against the options srt 0.0.77 uses, and bwrap must
  be exec'd by its absolute path with `--die-with-parent`, its own user / pid / network namespaces, `--cap-drop ALL`,
  a fresh `/proc` and `/dev` and `--ro-bind / /` (else fail closed). Appended before bwrap's `--`:
  `--disable-userns` (the sandbox runs under the unconfined `smurg-bwrap` profile, and a nested user namespace would
  get `CAP_DAC_READ_SEARCH` over its own files), `--chmod 0111` on every directory on a read-deny tmpfs (bubblewrap
  creates the directories leading to each carve-out there, so the host home, the state dir and the guests dir were
  LISTABLE: the self-test's first Linux failure) and `--remount-ro` on every such tmpfs (they were writable). A
  writable bind the policy does not name (srt's own `/tmp/claude`, shared by every guest, whenever it exists) gets a
  tmpfs of its own on top. `--new-session` is decided by the outer shell at run time: dropped only for a session
  leader with a controlling terminal and a terminal on stdin (node-pty's fresh pty; with it a resize sent no SIGWINCH
  and Ctrl-C ended bwrap and the whole session), kept for everything else. srt drops write-deny globs on Linux, so
  every EXISTING host-only entry below the top of the root becomes a literal deny (more than 1000: refused; the walk
  runs on every `wrap()`, skips only `node_modules` and lists 16 directories at a time, review RCR-7). srt also drops
  a Linux write deny whose PATH holds a glob character (`*`, `?`, `[`, `]` anywhere in it), and no string names a path
  that is not UTF-8: such an entry is left out and named in the daemon's log instead (warn `guests can write this
  host-only entry`, once per daemon; review attack F1, 2026-10-01: a guest who made `ev*il/.git` in the share refused
  every later guest session there, `sandbox_unavailable`, until the host found the directory). The path is
  JSON-quoted with DEL, the C1 controls and the bidirectional controls escaped as well (`core/logger.ts`
  `quoteForLog`, every logged value), so a name cannot act on the host's terminal. Control characters, a newline
  included, are no obstacle on Linux (nothing there is a Seatbelt string):
  srt and the hardening keep their bytes on bubblewrap's command line and in its arguments file, so such an entry is
  bound read-only like any other (`SessionPolicyInput.nestedHostOnlyPaths`; every other policy path still refuses
  them). macOS needs no list: Seatbelt's `<root>/**/<name>` patterns match whatever the directories on the way are
  called (measured with the same names, `test/sandbox/odd-names.real.test.ts`).
- Linux mount points on the host: bubblewrap can block an ABSENT write-denied name only by mounting something on it,
  and the mount point stays in the host's project while the sandbox runs. srt mounts `/dev/null` on an absent leaf
  (an empty 0444 FILE on the host) and removes its mount points once its count of running wraps is back to zero (never
  earlier: removing one under a running sandbox detaches its mount and lifts the deny); it decides the form on each
  wrap from whether the name exists at that moment. So the service makes every absent host-only DIRECTORY name at the
  top of a root (`.claude` / `.git` / `.vscode` / `.idea`, and `.smurg` in a worktree) exist as an empty directory of
  its own before it wraps, and bubblewrap binds it read-only: no mount point for these names, and one policy for the
  canary, the hook probe and the session (`holdPlaceholderDirs`, review RCR-1: another guest's process ending during a
  `wrap()` turned them into 0444 files in the host's project for a whole session, and a start in one root while a guest
  ran in another aborted in bubblewrap). The service keeps them while any `wrap()` is in flight or any WrappedCommand
  it handed out is unreleased, then removes those still empty and still the same directory (dev / ino), at once and
  synchronously. It holds an `O_PATH` descriptor on each meanwhile (review RV-3: ext4 hands a freed inode number
  straight back, so a directory the host made in its place, `rmdir` + `mkdir`, carried the same dev / ino 5 times of 5
  and was removed; a held inode cannot be freed, so the host's directory now always has another number and is kept).
  `.mcp.json` / `.envrc` keep srt's file form; the service makes that empty 0444 file itself when it hands a command
  out, exactly as bubblewrap would make its mount point a moment later (srt chose its binds while the name was absent
  or its own mount point, so srt tracks the path and removes the file with its others), so that the guard below sees
  it before anyone could remove it. In the share of a git repository the placeholders about to be made are listed in
  `.git/info/exclude` first, in one block of the service's own (`sandbox/git-exclude.ts`, review GR-4: the host's `git
  add -A` committed srt's files and srt's cleanup later deleted the tracked files from the working tree; `git stash -u`
  / `git clean -fd` removed the placeholders, which ends the guests); the block goes with the placeholders, and one a
  crashed daemon left goes with its sweep. `git add -f`, `git clean -x` and `git stash -a` still reach them (HOSTING
  §4). srt's cleanup removes every empty regular file it tracked, whatever its mode: a top-level `.mcp.json` / `.envrc`
  that is empty but has a write bit or a second link (the host's own file, e.g. a `git checkout` put a tracked empty
  `.envrc` there while a guest ran) is moved aside for that call and put back at once (`SandboxServiceImpl.srtCleanup`).
  The placeholders and srt's files are announced to the files module as the system's changes when they are made or
  removed (`FileService.expectChange`, 10 s; `announceOwn`), so the watcher reports them with `by: system` and the
  activity feed and the audit log do not say 「外部程式」 changed `.claude`, `.mcp.json`, … at every guest start and end
  (the file tree still shows them; the guard gets every watcher batch before any attribution).
  The sessions module calls `SandboxService.release(wrapped)`
  when a guest process exits or never starts (the self-tests release their own). Both forms are recorded in the
  workspace state (`sandbox-placeholders`) before either can exist and the record is emptied once nothing runs
  (review RCR-5: a record kept after a clean stop made the next start remove the host's own empty `.vscode`); a daemon
  that starts after a crash removes the recorded directories that are still empty and the recorded files that still
  look exactly like srt's leftovers (empty, no write bit, one link) before its first sandbox. `worktree/stage-commit.ts`
  keeps the file ones out of a merge.
- Linux, the daemon's working directory (review linux-binary F1): srt resolves its own mandatory write denies against
  `process.cwd()` on every wrap (`.bashrc`, `.gitconfig`, `.gitmodules`, `.profile`, `.ripgreprc`, `.zshrc`, …,
  `.vscode`, `.idea`, `.claude/commands`, `.claude/agents`, and a depth-3 ripgrep scan below it). A daemon started with
  its cwd in the share (`cd project && smurg host .`) got eight more empty 0444 files in the host's project while a
  guest ran; a project with a `.claude/` of its own refused every guest session, any other project every second guest
  process while one ran ("Can't create file at <share>/.claude/commands: Read-only file system", reported as a failed
  self-test while the start said 「可用」).
  `smurg host` therefore runs its daemon from `<stateDir>/cwd` (empty, 0700; `CliIo.chdir`), and the service refuses
  a wrap, and fails the preflight, with reason `daemon-cwd` when the cwd is at or below a write root (the share, a
  worktree, a guest dir). An ancestor of the share is harmless (srt skips denies outside the write roots). The denies
  srt derived from a cwd inside the share (`<share>/.gitmodules`, …) applied only by that accident and no longer do;
  guests may write those names in the share like any other file (macOS: srt's rules there are patterns, no mount
  points; the check is Linux-only). The chdir is made on macOS too, so there as well srt's mandatory write denies
  (`.gitmodules`, `.gitconfig`, `.bashrc`, `.zshrc`, `.profile`, `.ripgreprc` at any depth) no longer reach the share
  from wherever `smurg host` was typed (review GR-12, measured with real Seatbelt: all 7 writes denied with the cwd in
  the share, allowed from `<stateDir>/cwd`). Kept on purpose: the protection depended on the directory the host
  happened to type the command in, git and shells run nothing from these names in a project folder, and `.claude/**`
  stays host-only (§5.2); CHANGELOG 0.1.0 and HOSTING §4 say so. A working directory that cannot be resolved (`<stateDir>/cwd` removed while the
  daemon ran) is refused with `daemon-cwd` too, with its own text (「…工作目錄已經不存在…請主人重新執行 smurg host」,
  review RV-4); `smurg host`'s sandbox report adds the fix (run `smurg host` again) to either.
- **Linux, protected entries while a guest runs** (reviews RV-1, RV-2, 2026-10-01; `sandbox/guard.ts`). bubblewrap
  protects a host-only or host-private name by a mount on the entry as it is when the guest process starts: a
  read-only bind of `.claude/`, `.git`, `.vscode`, `.idea`, `.mcp.json`, `.envrc` and of every existing nested host-only
  entry, `/dev/null` over the read-denied `.envrc`, `.claude/settings.local.json` and `CLAUDE.local.md` that existed
  when srt expanded its globs, srt's mount point over an absent `.mcp.json` / `.envrc`. A mount sits on a directory
  entry. When the HOST replaces such an entry while the guest runs (an editor's atomic save; Claude Code's "don't ask
  again" writing `.claude/settings.local.json`), removes it (`git clean -fd` of an empty placeholder) or renames it
  (`git switch` to a branch without `.claude/`), the kernel detaches the guest's mount; a read-denied file the host
  creates after the start was never covered. Measured (diff-review E1–E7, on the reviewed tree and on b97cdee): the
  guest read the new `.envrc` and `settings.local.json`, read a `sub/.envrc` and a `CLAUDE.local.md` made after its
  start, planted `.claude/settings.json` once the placeholder was removed or the host's `.claude` renamed, and rewrote
  `.mcp.json` after an atomic save. No mount can follow that, so the service watches for it:
  - for every root with a guest process running or being wrapped, it records the state of each protected entry as the
    latest `wrap()` saw it (with the placeholders in place, before srt expands its globs): the top-level names
    (`.claude`, `.git`, `.smurg`, `.vscode`, `.idea`, `.mcp.json`, `.envrc`, `CLAUDE.local.md`,
    `.claude/settings.local.json`) and the existing nested entries the walk found (with `settings.local.json` inside
    each nested `.claude`, and nested `CLAUDE.local.md`), holding an `O_PATH` descriptor on each existing one so that a
    replacement always has another inode number (above; a probe: inode reused 20 of 20 times without, 0 of 20 with);
  - it compares again on every file-watcher batch of that root as it arrives (`SandboxService.fileEvents`, called by
    `files/watcher.ts` from the native callback with the batch as reported, not after the files module's debounce and
    recheck; review GR-3: behind a build's 20,000 files that took ~11 s): a protected name at any depth (checked apart
    from the scans, so a scan never holds it up), and the subtree of every directory that appeared, made or moved in,
    since inotify reports the directory only (at most 10,000 listings per round in all, the rest is the walk's); every
    2 s for the recorded entries (`GUARD_POLL_MS`: the watcher ignores `.git`); every `GUARD_WALK_MS` (2 s) at most,
    spaced to ten times the walk's own duration, a walk of the whole root outside `node_modules` (the wrap's own walk,
    `guardWalk`) for protected names the record does not have (review GR-1: @parcel/watcher 2.6.0's inotify backend
    adds a watch to a new directory only when it handles that directory's own creation, so in directories made in one
    burst with their parent, `mkdir -p`, a checkout, an unpack, a folder moved in, later changes produce no event at
    all, and it drops an inotify queue overflow without an error; measured: a guest's two-step plant and the host's
    new secret in a `mkdir -p` directory went unnoticed); at once when the watcher reports an error
    (`SandboxService.fileWatchGap`); on every later `wrap()` in the root (its fresh view against the record; an entry
    the record has and the walk did not name is looked at, never assumed gone, review GR-6); and when the root's last
    process is released, the top-level names synchronously, then the rest of the record and one more walk without
    blocking (a guest that planted a name and exited at once; the host is told, nothing is left to revoke);
  - a difference (an entry replaced or removed, a protected name that appeared) revokes every WrappedCommand handed out
    for that root (`SandboxService.onRevoked`): the sessions module ends those sessions (`terminated`, audited as
    `session.terminate` by the system with `reason: 'sandbox-protected-changed'` and the paths; the owner is told in the
    activity feed) and kills a helper process (`claude auth status`, logout); a `wrap()` in flight there is refused
    (`protected-changed`: 「…請再試一次」); the log and the host's terminal name the paths and say to stop guest
    sessions before editing them (`sandbox.protected-changed`, §7.3). Not a change: the same entry edited in place (the
    mount holds), srt's 0444 mount point appearing when a process starts or going (or made again) while nothing runs,
    the same file with another mode (a `chmod` of the host's own empty `.envrc`, review GR-11; only while the guard
    holds that inode, since an inode nobody holds can come back as another file's), the service's own placeholders. A
    NEW nested `.git` is not looked for, by the walk either (a guest's `git clone` makes one: §12). srt's `.mcp.json` /
    `.envrc` are made at the hand-out from what is on disk: made again when the record says absent or srt's own file
    and nothing else of that root runs (the canary's own mount point, recorded by a look during the `wrap()`, is gone
    by then: srt removed it when the canary ended), held as they are when there; while other commands of the root run,
    srt's file is left as recorded (srt removes nothing then, so a file gone or replaced is the host's doing and is
    reported). Readings are asynchronous while the record changes under them (a hand-out makes srt's files, a later
    `wrap()` rewrites the record, and whether a process runs is decided when the reading is compared): one taken
    before the record of its path was last written is checked again synchronously before it counts (review GR-5: a
    stale reading revoked guests started after the real change and wrote the old state back; CI run 36810877157, R9 in
    the browser smoke on ubuntu-24.04: a look that recorded the canary's mount point, or read `.mcp.json` as absent
    just before the hand-out made it, revoked a runner's worktree terminal ~0.1 s after it started; reproduced in the
    VM with the canary's cleanup held 150 ms and bubblewrap started 400 ms late). A breach names at most 100 paths
    and counts the rest, and re-pins at most 256 entries (review GR-2: one batch of 60,000 changed paths, which a
    guest could build in `node_modules` and move into the share with one rename, held the event loop for 5.6 s); a
    root whose every command is revoked is not scanned any further. A `wrap()` whose entries cannot be held open
    (`EMFILE`, `ENFILE`, `ENOMEM`) is refused (review GR-7), and more than 1000 nested `CLAUDE.local.md` refuse it
    like more than 1000 host-only entries (GR-6).
  It is a detection, not a prevention: until the change is noticed and the processes are ended the guest sees it
  (measured with bubblewrap and the real watcher in the VM: revoked 50–110 ms after the host's change, also right after
  a build wrote 20,000 files; `.git` through the poll, ~0.2 s; a name in a directory the watcher never watched through
  the walk, 0.1–2 s on a small tree, longer on a large one). A protected name a guest makes (a new `sub/.vscode/`, a
  `CLAUDE.local.md` its own Claude Code writes) ends that root's guest processes the same way: the daemon cannot tell
  who made it, and the host should look at it (the guest's notice says neutrally that a host-only file of the folder
  changed, review GR-13). Tests: `test/sandbox/guard.test.ts`, `guard-races.test.ts`, `placeholders.real.test.ts`
  (real bubblewrap and watcher: E1, E2, E3, E5, E6, E7, srt's file removed, `.git` replaced, a wrap in flight, other
  guests coming and going; GR-1, GR-3, GR-4), `service.test.ts`, `nested-walk.test.ts`, `test/sessions/launch.test.ts`,
  `test/files/watcher-native.test.ts`.
- Inner `export TMPDIR=<guest>/tmp` and `CLAUDE_CODE_TMPDIR=<guest>/tmp` (srt forces its own TMPDIR; Claude Code
  2.1.283 otherwise writes to `/tmp/claude-<uid>`, the host user's own dir, and fails).
- Linux, tasks (review attack F2, 2026-10-01): before that, the sandboxed shell runs `ulimit -u 4096`
  (`LINUX_GUEST_TASK_LIMIT`, soft and hard: nothing inside can raise it). bubblewrap has made the guest's user
  namespace by then, and since Linux 5.14 RLIMIT_NPROC is counted per user namespace, so the limit counts that
  sandbox's processes and threads only, whatever the host user runs (measured on 6.8: with the host user at 141 tasks,
  a sandbox limited to 32 started 27 processes; `test/sandbox/odd-names.real.test.ts`). On an older kernel (decided
  from `os.release()`) it would count the host user's tasks too, and is left out with one warning in the log. It is
  the only resource limit of a guest sandbox (§12 "Resource limits"); macOS sets none.
- As built (sandbox module, verified with srt 0.0.77 on macOS): worktree mode carves out only `<share>/.git/objects`
  (the host's `.git/config` can hold tokens and stays hidden; an `extraReadPaths` entry equal to `<share>/.git` is
  replaced by that carve-out); host-only denyWrite covers every `.git` at any depth, the worktree's own included; the
  wrapper pins `/usr/bin/env`, validates srt's env words and refuses outer-shell variables such as `BASH_ENV`,
  `DYLD_*`; a write-surface check of the generated profile allows writes only to the policy's roots and srt's own
  stdio and `/tmp/claude` paths (srt otherwise makes the real home's `.npm/_logs` and `.claude/debug` writable); the
  state dir is denied explicitly (carve-outs: the guest dir, the settings dir, the hook socket); CLAUDE.md,
  CLAUDE.local.md and `.claude` are denied in every ancestor of the root; srt's proxy sockets live in `os.tmpdir()`,
  and when that path is too long for a Unix socket they go into `config.runDir` during `initialize()` (else refuse).
  Guests cannot bind TCP ports (dev servers do not listen), cannot create Unix sockets of their own, and srt's
  `NO_PROXY` makes direct loopback connections fail (macOS; on Linux a guest process can bind and listen inside its
  own network namespace, where nothing outside reaches it, and direct loopback connections fail the same way). Consequence (review SPEC-04, verified with claude 2.1.220 and
  2.1.283): the subscription (OAuth) login inside a guest's AGENT session still fails ("Failed to start OAuth callback
  server"); guests log in through the separate login process above (§11 D-12). The guests' sandbox also
  read-denies `.envrc` at any depth (review SEC-D-03), and an AGENT session is refused (`sandbox_unavailable`, reason
  `hook-unreachable`) when `smurg hook` cannot be exposed inside its sandbox (installed under the share or the state
  dir): its file locks would otherwise not exist (review SEC-D-05). **In-sandbox hook self-test** (SEC-D-05 follow-up,
  2026-09-29): every `wrap()` of an agent session (its environment carries the hook token) then runs the real `smurg
  hook` through exactly that session's policy and hardening, with the session's environment, fed a probe event
  (`SmurgProbe` with a fresh nonce, §7.7), and requires the daemon's answer for THIS session on the hook's stdout;
  it fails when the hook cannot start (an entry point, its interpreter or a module it loads the guest cannot read),
  cannot reach the socket, or answers anything else ⇒ `sandbox_unavailable`, reason `hook-self-test-failed`, audit
  `sandbox.refused`, and a zh-TW message that tells the host what to check. Nothing is cached: every agent launch runs
  it (~200–600 ms with the dev entry, node + TypeScript sources; the helper processes of a session, e.g. `claude auth
  status`, are wrapped without the hook token and run no probe). A `WrappedCommand` must be spawned on a fresh pty or
  with a stdin that is not a terminal (then no tty at all), and released (`SandboxService.release`) once its process
  exited or if it never starts. Every `wrap()` runs a canary self-test with that session's
  own policy (~100–300 ms). srt itself runs `spawnSync('which')` once per wrap (bounded, inside srt 0.0.77).
- **Preflight before every guest session:** platform supported, sandboxing enabled, dependencies present
  (`sandbox-exec` executable on macOS; `bwrap` 0.8 or later (it must know `--disable-userns`, `--chmod`,
  `--remount-ro`), `socat`, `rg` and srt's network bridge socket on Linux), the wrapped command really contains the
  sandbox launcher, Linux: the daemon's working directory outside the share (`daemon-cwd`, above), and a functional
  self-test (a canary file in the denied home is unreadable and unwritable from inside). Any failure ⇒
  `sandbox_unavailable`, audit `sandbox.refused`, **no** fallback. A failed self-test on Linux
  is reported as `apparmor-userns` (with the fix) only when the restriction is on AND a bare `bwrap --unshare-user
  --unshare-net` fails with "Permission denied" / "Operation not permitted" (verified by unloading the profile);
  otherwise it keeps its own reason.

**PTY.** One `PtySession` per PTY, `encoding: null`, output coalesced (5 ms / 64 KiB) and addressed by absolute byte
offset; fan-out to a daemon-side `@xterm/headless` mirror (5000 lines), a 2 MiB raw tail and every attached viewer.
Re-attach = mirror snapshot (full scrollback) taken inside `term.write('', cb)`, then the raw gap, then live.
The snapshot keeps as much scrollback as fits the attach payload: two small trial serializations estimate it, then at
most 3 bounded passes, and an unchanged terminal reuses the last snapshot (review REL-12: ~360 ms for the first attach
of a 31 MB colourful history, ~60 ms after). Flow control (review REL-06): the PTY is paused while any ready viewer's
connection has more than 1 MiB queued (`bufferedAmount`, which is the shared host uplink for relay clients) and resumes
below 256 KiB, next to the mirror's own 1 MiB lag limit, so one chatty terminal can no longer hold every member's
traffic behind tens of megabytes. Local attach reports 0.
Input and resize only from the owner; the PTY size follows the owner's most recently active client; viewers render
at the PTY size. The daemon mirror is the only responder to terminal queries: web viewers register the full set of
swallow-handlers and `smurg attach` strips queries and OSC 52 from the output stream.

**Ending a session (owner ends, host terminates, member kicked, daemon stops).** `killTree`:
the PTY child's process group + descendants found by walking `ppid` + same-uid processes whose environment carries
this session's exact `SMURG_SESSION_ID`; `SIGSTOP`, re-scan, `SIGKILL`, in rounds (measured < 1 s).
The §0 rule applies: nothing is signalled that is not positively tied to the session. There is **no** system-wide
"looks sandboxed" sweep (§11, D-3). As built, because macOS hands out freed pids again within milliseconds: every
target is identified by pid + start time + full command line (the env-marker scan is bound to the same identity); the
PTY-child root counts only while it is still the daemon's own child and not another session's PTY child or a helper;
one scan only ever sends `SIGSTOP`, `SIGKILL` goes only to the frozen tree a second scan confirms, and a pid whose
identity changed gets `SIGCONT` at once. A guest's descendants are remembered every 2 s so a `nohup … &` left behind
by a natural `exit` is killed too.
Guest leave (`channel.leave`, §11 D-9) / kick / `smurg stop` (SessionManager.stopAll also removes every guest dir):
kill sessions → best-effort `claude auth logout` (1 s, inside the guest's sandbox, only when a credential file exists:
after the removal it would have nothing to act on and could re-create the dir) → rename the guest dir out of reach and
`rm -rf` it (this is what removes the credential) → host-side deletion of the two keychain entries derived from the
config dir, only when claude ran with that config dir (`.claude.json` or `.credentials.json` was there: otherwise it
cannot have created them, and the host's keychain is not touched).

**Login guide.** `claude auth status --json` run in the exact session environment decides `login`; TUI strings are
version-specific hints only. The host's subscription login works through the manual-code flow in their own terminal;
a guest's through the login process (kind `login`, above: the URL is shown, the guest pastes the code; while
`PublicSettings.guestSubscriptionLogin` is true); API-key login uses `session.create.apiKey`. The UI tells guests that
the host can technically read their credentials and recommends a key with a spending limit (SPEC §11).

**Accepted suggestions** are written to the PTY as a bracketed paste followed by Enter, by the one function that the
`suggest.accept` handler calls after the ownership check.

**Claude Code version.** Every session runs its owner's own `claude` with their own account, and smurg never passes
`--model`: which model a session uses is between that CLI and that account, so the model the smurg team develops with
has no bearing on smurg's minimum version. What smurg relies on is its hook and sandbox setup, and that is verified end
to end on **2.1.220 and 2.1.283** (`claude-hooks.md` ran every experiment on both; its §1.7 "pin exactly 2.1.283" is
about the development team's model and does not apply to smurg's users). The session settings are written to work on
both. The behavioural differences, and what covers each:
- **`.mcp.json` dialog** (2.1.220 only): "New MCP server found" appears even with `--strict-mcp-config` and swallows
  typed input → guest settings list every server name of `<share>/.mcp.json` in `disabledMcpjsonServers` (harmless on
  2.1.283).
- **Auto mode** (2.1.283): interactive sessions start in auto mode, without edit prompts → the host's settings carry
  `permissions.defaultMode: "default"` (harmless on 2.1.220).
- **Deny text** (2.1.283): the model sees `PreToolUse:<Tool> hook error: <reason>` → reasons read well after that
  prefix (§7.7); tests match the reason as a substring.
- **Project settings as a kill switch:** on 2.1.220 a project `env.CLAUDE_CODE_SIMPLE` turns every hook off; 2.1.283
  hot-loads a newly created project `.claude/settings.json` → the `--settings` `env` neutralizers win on both
  (verified), and `.claude/**` is host-only writable (§5.2).
- **Dialog defaults** (2.1.283): the trust dialog preselects "No, exit", the API-key dialog "No (recommended)" → the
  pre-seeded `<guest>/cfg/.claude.json` (trust; key approval when `session.create.apiKey` is used) answers both, on
  either version.
- **`PermissionRequest`** also fires for a `-p` auto-deny on 2.1.283 only → informational; no lock depends on it.
- **Login screens** differ → `claude auth status --json` (the same on both) decides `login`; TUI strings are hints.

Policy (`config.sessions`; `claudeVersionVerdict()` in `core/config.ts`): `claudeMinVersion` is `2.1.220`, the oldest
verified version, and `claudeVerifiedVersions` is `[2.1.220, 2.1.283]`. Before a session starts, the daemon runs
`--version` of the `claude` it will launch:
- below the minimum, or output that does not start with a plain `MAJOR.MINOR.PATCH` → the **guest** session is refused
  (fail closed), like a failed sandbox preflight: `sandbox_unavailable` with `detail.reason: 'claude-version'`, audit
  `sandbox.refused`;
- newer than the newest verified version → **warn, never refuse** (Claude Code updates itself; an update must not lock
  anyone out): logged for the host and shown to the session owner. A version between two verified ones that is not
  listed warns the same way;
- a **host** session is never refused for its version (the host's own, unsandboxed CLI) but gets the same warning.

Adding a version to the verified list means re-running the `claude-hooks` spike on it (mock Anthropic API only, §0).
Tests that start the real `claude` accept any verified version.

**Launch inputs are configuration, never ambient** (contract review C5; `config.sessions`, `core/config.ts`):
- `hostHome`: the host's home (the sandbox's denied region and the preflight canary). `createDaemon` fills it from
  its `homeDir` option (default `os.homedir()`); tests pass a temporary fake home, so a broken sandbox can never read
  the developer's real `~/.ssh` in a test. The preflight canary lives under `stateDir`.
- `claudePath` (default: looked up on PATH at session start), `claudeMinVersion` and `claudeVerifiedVersions`
  (policy: "Claude Code version" above).
- `selfCommand: { file, args }`: how a session runs `smurg hook` / `smurg mcp` (the daemon cannot import the CLI):
  the CLI passes `process.execPath` + `[<cli>/src/main.ts]` in dev and the SEA binary in production. Without it the
  hooks module refuses to start sessions.
- `testGuestEnv`: TEST ONLY, extra guest environment such as `ANTHROPIC_BASE_URL=http://127.0.0.1:<port>` of the mock
  Anthropic API (`claude-hooks.md`); `resolveConfig` refuses it unless the daemon has no relay or a local one.
- `guestSubscriptionLogin` (default true): guests may start their login process (§11 D-12).
- `guestMainWorkspace` (default: false on a Linux host, true on macOS): guests' sandboxed agent / terminal sessions may
  use the main workspace (§11 D-14); the default needs the platform, so `resolveConfig(input, { platform })` takes it.
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
well after that prefix, e.g. 「此檔案正由 Amy 編輯中，請先處理其他檔案或稍後再試」.

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

**Hook self-test event** (SEC-D-05 follow-up): `{ op: 'hook', hookInput: { hook_event_name: 'SmurgProbe',
smurg_probe: <32 hex> } }` is answered `hookOutput: { smurgProbe: { nonce, sessionId } }` for the token's own session
(null without a nonce; an unknown token gets nothing). Claude Code never sends it; the sandbox sends it through the real
hook before an agent session starts (§7.6). A session that forges it only learns its own session id.

---

## 8. CLI

| Command | Behaviour |
|---|---|
| `smurg host <folder> [--relay URL] [--role R] [--expires D] [--max-uses N] [--name N] [--web-origin URL] [--no-keep-awake] [--no-browser] [--no-guest-subscription-login] [--no-bash-attribution] [--allow-main-workspace-guests \| --no-main-workspace-guests]` | refuse a folder that is already shared, that overlaps a folder a running host of this state dir shares (inside or around it, whatever the relay; CLI-05) or that contains a home directory (CLI-04), all before any login; login if needed (a stored login with less than 24 h left counts as missing); change to `<stateDir>/cwd` (empty, 0700: srt resolves the guest sandbox's own denies against the cwd, §7.6); start daemon in the foreground, print host link + invite link (on `--web-origin`, e.g. the Vite dev server), keep machine awake (a later loss is printed); then report whether the guest sandbox works here (the daemon's sandbox preflight, with Linux fix commands). The two `--no-…` switches set `config.sessions.guestSubscriptionLogin` and `config.activity.attributeBashEdits` to false (§11 D-12, D-13; both default true); the start summary explains each switch that is on (the guest's separate login process may listen on a local port while it runs, nothing else of a guest may; agents' Bash commands are reported to the daemon, not their content) and echoes each one that is off. `--allow-main-workspace-guests` / `--no-main-workspace-guests` set `config.sessions.guestMainWorkspace` (§11 D-14; without either the daemon's platform default: off on Linux, on on macOS); the summary's line 「客人的主工作區 session」 says 未開放 or 已開放 and why (「Linux 預設」, 「macOS 預設」 or the flag), what guests get instead when it is closed (their worktree; on a share that is not git, no session at all), and, when it is open on Linux, the residual limits of §12 |
| `smurg attach [session] [--workspace W] [--invite -\|URL] [--relay URL] [--no-browser]` | local daemon running → attach through the control socket as host; otherwise join through the relay with the CLI device key. The invite (its `#` part is the secret) comes from a no-echo prompt (`--invite -`) or `SMURG_INVITE`; a link in argv still works, with a warning (it is visible in `ps` and lands in shell history) |
| `smurg stop [--workspace W]` | ask the daemon (control socket) to stop: closes all channels, ends sessions, removes guest temp dirs; returns when the daemon is fully stopped |
| `smurg status [--workspace W]` | every running daemon of this state dir: relay, connections, keep-awake (same zh-TW wording as `host`) |
| `smurg login [--relay URL] [--provider github\|google] [--dev-user NAME] [--no-browser]` / `smurg logout [--relay URL] [--all]` | relay session for the CLI (`--dev-user` only for a relay on a local hostname) |
| `smurg hook`, `smurg mcp` | internal entry points used by Claude Code inside sessions (the hook event is in the stdin JSON); dispatched before anything else is loaded |

**Arguments** (`cli/args.ts`): unknown options, a string option given twice, a boolean together with its `--no-` form
(`--bash-attribution --no-bash-attribution`) and surplus positionals are usage errors (exit 2), before anything else runs.
A boolean may name its true form differently (`OptionSpec.positive`): `--allow-main-workspace-guests` /
`--no-main-workspace-guests` are the only spellings of that switch (`--main-workspace-guests` and
`--no-allow-main-workspace-guests` are unknown options), and the two together are refused like any flag and its negation.

**Relay choice.** `--relay`, else `SMURG_RELAY_URL`, else the relay of the last login, else the built-in default: the
shared relay the project operates on Cloudflare Workers, `https://app.smurg.ai`
(`packages/cli/src/relay/default-relay.ts`, `docs/RELEASING.md` §3; it was the workers.dev URL of the first deploy
until 2026-10-01, before any release); `smurg attach` first takes the invite link's origin, or the relay a remembered
join used. Before
the release plan of 2026-09-30 there was no default (review CLI-12: a guessed domain would have received the host's
login and every invite printed for it); an operated relay does not have that problem. Logins are stored per origin:
an invite link carries the WEB origin, which is the relay in production but not in development (Vite on :5173 in front
of the relay on :8787), so a CLI guest in the dev stack uses `--relay http://localhost:8787` (the CLI says so when it
finds a login for another origin).

**While `smurg host` runs** (reviews REL-08, CLI-03, CLI-10, REL-14, CLI-06) the host's terminal is told: the relay link
dropping (after 3 s without recovery, so blips stay quiet) and coming back; the relay refusing the host's login
(`auth-rejected`: members cannot connect) with the command to run; a stored login that expires within 24 h; and a state
file the disk refuses (the change is in force but would not survive a restart) and its recovery. `credentials.json` is
re-read every 5 s: a newer login of the SAME account for that relay (`smurg login` in another terminal) is handed to the
daemon (`Daemon.updateRelayToken`) without a restart; another account's login is refused with a notice (the workspace
belongs to the account that claimed it). A second Ctrl-C within 2 s of the first is ignored while the stop runs (it is
usually one impatient key press, and leaving mid-teardown can leave session processes stopped); a later one leaves at
once (exit 130). `smurg status` shows the link state `auth-rejected` as 「relay 拒絕了主人的登入（請執行 smurg login 重新登入）」.

**Browser.** A login opens the person's browser only through `CliIo.openUrl`, and the real implementation
(`cli/io.ts` `browserBlock`) never opens one when `SMURG_NO_BROWSER` or `CI` is set, over SSH (`SSH_CONNECTION` /
`SSH_CLIENT` / `SSH_TTY`), when stdin or stdout is not a terminal, or on a Linux without a display; the URL is printed
instead (over SSH with the `ssh -L` port-forward that makes the loopback callback work). `--no-browser` does the same
per command. Next to the URL the CLI prints the login's confirmation code (`確認碼：XXXX-XXXX`), which the relay's
confirmation page shows too (§6): the person continues only when they match. `scripts/env.sh`, `scripts/dev-stack.ts`, the CLI's vitest setup and every test helper that spawns the CLI
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
`{ v: 1, op: 'status' }` | `{ v: 1, op: 'stop', reason? }` | `{ v: 1, op: 'attach', deviceName, resume? }`; the daemon
answers one CONTROL response `{ ok: true, op, status | welcome }` or `{ ok: false, error }`. status / stop: the daemon
then closes the socket (stop: and stops). attach: ENVELOPE frames both ways afterwards, on a logical channel of the
host admitted through `ctx.lifecycle.attachLocal()` (§4 Local connections). No Noise: the file mode authenticates.
The socket stays open until every other module stopped (it answers status with `stopped: true` and refuses attach
meanwhile), so `smurg stop` sees it go only when the daemon is done.

**Distribution.** `scripts/build-sea.sh --version X.Y.Z` builds the single executable for the current platform (the
version is injected at build time; other builds say `<package version>-dev`); `scripts/release-assets.sh` writes a
release's `SHA256SUMS` and an `install.sh` with the release URL filled in; `scripts/install.sh` installs only a
sha256-verified executable into `~/.local/bin` (macOS: it removes the quarantine attribute after the check) and, on
Linux, sets up the sandbox dependencies and the AppArmor profile with the host's consent. The executable's extracted
native dir of an older build is removed after 30 days unused. Releases (decided 2026-09-30, `docs/OPEN-QUESTIONS.md`
Q1): GitHub Releases of `gclinian/smurg`, built by `.github/workflows/release.yml` on a tag `v*` on `macos-15`,
`macos-15-intel`, `ubuntu-24.04` and `ubuntu-24.04-arm`, macOS signed ad hoc only; the one-line install is
`curl -fsSL https://smurg.ai/install.sh | sh` (since 2026-10-01; the product page `apps/site`, live since that day,
answers it with a 302 to `https://github.com/gclinian/smurg/releases/latest/download/install.sh`, the same file, which
is also the fallback). Runbook: `docs/RELEASING.md`.

---

## 9. Web

Routes: `/` (landing + login), `/join/:workspaceId` (invite acceptance), `/w/:workspaceId` (workspace), `/w/:workspaceId/console` (host console).

```
apps/web/src/
├── app/         routes, providers, layout shell, i18n strings (zh-TW)
├── lib/         connection (client SDK wrapper, reconnect, offline detection), device-key store (IndexedDB), stores
├── features/
│   ├── auth/        login, join flow, key-mismatch warning
│   ├── files/       file tree, root switcher, drag-drop upload, download
│   ├── editor/      Monaco + Yjs provider, presence cursors, lock banner, selection → suggestion
│   ├── agents/      session tabs, xterm panel, clickable paths, new-session dialog, login guide, import config
│   ├── suggest/     suggestion composer + owner queue
│   ├── activity/    activity feed, conflict panel
│   ├── worktree/    merge request + diff review
│   └── console/     members, sessions, invites, audit log, settings
└── ui/          shared components + design tokens
```

State lives in small stores keyed by message type; every store is fed by the single `Connection` object.
Role-based hiding in the UI is cosmetic; the daemon enforces.

As built after the review round (details in `apps/web/README.md`):
- `/join/:id` waits for an explicit 「加入」 before any connection (§4.1, SEC-E-02).
- Documents: a tab whose file is deleted turns read-only with who did it and 「用這些內容重新建立」; a renamed file's tab
  follows it (the renamer's) or offers 「開啟新位置」 (everyone else), read from the `file.rename` activity summary
  (§5.4; review WEB-01). Text typed while the host was unreachable is kept across a new epoch: re-applied when the
  host's text did not change meanwhile, otherwise offered back in a recovery notice (用我的版本取代 / 複製 / 捨棄);
  there is no automatic 3-way merge (review REL-07). `doc.rejected{file-unavailable}` says the unsaved text is in the
  conflict panel (REL-01).
- Agent panel: the owner's panel drives the PTY size (review LEAD-01): columns and rows are fitted to the visible area
  (`features/agents/terminal-fit.ts`, sent with `session.attach` and then as `exec.resize` on every panel, font or
  visibility change), with a floor of 80 × 24 for Claude Code (login process 80 × 12, plain terminal 20 × 5); below the
  floor the panel scrolls and a one-line hint says so. Watchers (and the owner's other windows) render at the PTY size
  with visible scrollbars and 「縮放以符合寬度」 (a CSS scale, nothing reflowed or sent). The login guide is stacked
  above the terminal; a maximize button; a session that ended without its owner says why (`endReason` / `endedBy`:
  「已被主人（…）終止」; review WEB-12); 「在自己的終端機接上」 shows the `smurg attach` commands (SPEC-09).
- Guests log in with their Claude subscription through the login process (session kind `login`, §7.6): 「用 Claude
  訂閱登入」 in the login guide or in the agents panel's 「更多動作」 sends `session.create { kind: 'login', workspace:
  { mode: 'main' }, cols, rows }` and shows that process's terminal (`LoginProcess.tsx`) with the steps and the notice
  that the host can technically read the credential; after it exits, the web re-checks `session.loginStatus` of the
  guest's running agents. With `PublicSettings.guestSubscriptionLogin === false` only the API key is offered.
- The new-session dialog (`features/agents/new-session.ts`) follows `PublicSettings.guestMainWorkspace` (§11 D-14): when
  it is `false`, a sandboxed member (runner) gets 「共享主工作區」 disabled with the reason and 「我的 worktree」
  preselected; on a share that is not a git repository it says that guest sessions are not available on this host and
  how the host opens them (`smurg host --allow-main-workspace-guests`). The login process (kind `login`, mode `main`)
  and the host's own dialog are unchanged; the daemon refuses a main-mode request either way.
- The activity feed shows an agent's shell edit (§11 D-13) as that agent's, with a small 「透過指令」 marker taken from
  `ActivityEvent.via === 'bash'` (never from the summary's wording); 「外部程式」 appears only for the daemon's `system`
  actor.
- The suggestion owner queue always sends the text on screen with `suggest.accept` (§5.6, SEC-D-01); 「作為建議送給…」
  in the editor creates the suggestion in one click (SPEC-08).
- The host can force-release a lock from the editor banner and the tree's context menu (WEB-04); the console's invite
  list refreshes on joins (WEB-05); the audit log shows each entry's details (SPEC-07); merge decisions reach the
  requester as a notice and everyone's activity feed (WEB-11).
- Login buttons come from one `GET /api/login-options` (§6; strict schema, `redirect: 'error'`; on any failure GitHub
  and Google are offered and the dev login never is; WEB-14). `/api/me` is asked only while the host-scoped cookie
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
| Module integration | `packages/daemon/test/integration` | the REAL modules together (`createTestDaemon` without `modules` = DEFAULT_FEATURE_MODULES): docs + locks + hooks through the real `smurg hook` entry; sessions + sandbox (real srt) + worktree; suggest + sessions (real PTY); files + locks + docs; the real CLI's status / attach / stop on the control socket |
| Acceptance (E2E) | `tests/e2e` | real relay (local workerd) + daemon + headless clients; one file per requirement `r1.*.test.ts` … `r11.*.test.ts` |
| Sandbox | `tests/e2e/r5.*` | real srt on the current OS; tests that need Linux/AppArmor are skipped on macOS and documented |
| Claude-in-the-loop | `tests/e2e/claude.*` | opt-in (`SMURG_TEST_CLAUDE=1`): real `claude` with hooks (PreToolUse deny blocks Edit) |
| Browser | `apps/web/e2e` (playwright-core + system Chrome) | join flow, 「主人已離線」, key-mismatch warning (Vite dev server) |
| Built app | `apps/web/e2e/smoke` (own vitest project; at most 2 files at once, in the full gate after every other project) | `vite build` once, served by the real relay's Worker assets (`startLocalRelay({ webDist })`), a daemon with every module, system Chrome: join → type → disk, two-browser co-editing, agent-lock banner, a runner's terminal; the console's one-click terminate / kick (R11.1c), suggestions (R6), worktree merge (R9), a real conflict (R8.4), an upload resumed after a dropped transfer socket (R7.3, through a TCP proxy in front of the relay), a logged-out page load with a clean console, a guest's subscription login up to the code prompt (D-12), the terminal size (LEAD-01), a runner kept out of the main workspace (§11 D-14, `main-workspace.smoke.test.ts`: the dialog offers their own worktree, the terminal runs there, the daemon refuses a main-mode request) |

R3 and R5 acceptance criteria are hard gates: each criterion has a named automated test, listed in `docs/ACCEPTANCE.md`.

Harnesses: `@smurg/daemon/testing` (`createTestDaemon`: in-memory relay with a byte tap, test identity issuer, temp
project optionally a git repo, real SDK clients; `createTempRunDir`, `isolatedGitEnv`, …) and `tests/e2e/src/harness.ts`
(`startStack`: real relay + daemon + clients; `git: true` shares a git repository; the host gets a fake home and a short
socket dir). `tests/e2e` also depends on yjs / y-protocols / lib0 and `@xterm/headless` + `@xterm/addon-serialize` for
the R7.1 (two Y.Docs) and R4.1 (terminal state) acceptance tests. Neither harness sets `config.sessions.guestMainWorkspace`
(the platform default: off on Linux, §11 D-14): a test that runs a guest's session in the main workspace opens it
explicitly (`sessions: { guestMainWorkspace: true }`; the daemon's session-test stacks `test/sessions/setup.ts` and
`real-stack.ts` do so by default), so the same test runs on macOS and on Linux.

---

## 11. Deliberate departures from the wording of SPEC.md

Each of these keeps the intent of the requirement and is backed by a verified finding.

**Status: D-1 to D-11 were reviewed and approved by the project owner on 2026-09-28** (D-1 to D-10 together, D-11
separately the same evening). A departure added after that is not covered by this approval: mark it "pending approval"
in its row until the owner has confirmed it. D-14 is the owner's own decision (2026-10-01, `docs/OPEN-QUESTIONS.md` Q2).

| # | SPEC says | We do | Why (evidence) |
|---|---|---|---|
| D-1 | R4: guest hooks are written to `settings.json` in the temp dir; host hooks to `<project>/.claude/settings.local.json` | Hooks are passed to every session with `claude --settings <daemon-owned file>`. Nothing is written into the project's `.claude/`. | Both SPEC locations work but are writable by other people: a guest's own agent can edit its config dir, and collaborators can write project files. A project-level `disableAllHooks: true` silently turns off hooks from the other locations, which would bypass file locks. The host's global settings are still never touched. (`claude-hooks.md`) |
| D-2 | D6 / R9: agents work in a **git worktree** | The user-facing concept and the location `.smurg/worktrees/<id>` are unchanged, but each one is created with `git clone --shared --no-checkout` instead of `git worktree add`. | A real `git worktree` forces the sandbox to grant the guest write access inside the main repository's `.git` (objects, `worktrees/<name>`, refs), which contradicts R9's "cannot read or write the main workspace". A shared clone needs read access only. (`sandbox.md`, verification section) |
| D-3 | R2: a kicked user's session processes are terminated | Terminated: the PTY's process group, all descendants, and every process carrying the session's id in its environment. **Not** covered on macOS: a process that deliberately detaches (`setsid`) *and* scrubs its environment. Such a process stays inside the sandbox (no access outside the project) but keeps running. On Linux, srt's PID namespace (`--unshare-pid --die-with-parent`) closes this gap. | The only way to find such a process on macOS is to scan every process on the machine with a private API and kill what matches. Two research spikes that tried this killed unrelated processes of the host user. The risk of harming the host outweighs the benefit for a prototype. Measured since: macOS reuses freed pids within milliseconds (so kills are identity-checked, §7.6), and `ps -E` hides the environment of Apple platform binaries (`/bin/sleep`, `/bin/sh`), so a platform-binary job orphaned before the first 2 s descendant scan also escapes a natural exit (it stays sandboxed). |
| D-4 | R5: "read: deny the host's home by default" | Expressed with srt's actual model: everything readable, then broad `denyRead` regions (home, other users, temp), then `allowRead` carve-outs. | srt has no default-deny read mode; this is the verified equivalent. (`sandbox.md`) |
| D-5 | R3: the relay can only see workspace id, connection id, message size and timing | Also true for content, keys and device ids. But the relay performs the login, so it additionally knows the **account identity and IP address** of each connection. | Inherent to R2 (login at the relay). Stated openly rather than hidden. (`relay.md`) |
| D-6 | R8: `FileChanged` hook as the basis of the fallback | The fallback is driven by the daemon's own file watcher; `FileChanged` only feeds the activity feed. | `FileChanged` watches literal file names in the cwd only and misses the first moments of a session. (`claude-hooks.md`) |
| D-7 | §6: packages `web`, `relay`, `daemon`, `cli`, `protocol` | Adds `tests/e2e`. | Acceptance tests must depend on every package. |
| D-8 | R3: 「踢人或改角色時，daemon 撤銷對應的裝置金鑰」 | A **kick** revokes every device key of the member. A **role change** does not revoke keys: it closes the member's channels (`channel.closed{role-changed}`), the router applies the new role to the very next message, and the client reconnects with the same key and a fresh Welcome. Losing the right to own sessions ends them and deletes the guest dir. | Revoking the keys on a role change would lock the member out: they could only come back through a new invite, which makes "change a role" the same as "kick". What the requirement protects against — the old role still being usable — is achieved by the per-message role check and the channel close. |
| D-9 | R4: guests are logged out and their temp dir deleted 「客人離開…時」 | "Leaving" is the explicit 「離開」 (`channel.leave`): sessions end, the guest dir (and with it the Claude login) is deleted within 5 s. A disconnect (closed tab, sleeping laptop) keeps both, because R4 also requires sessions to survive disconnects. Guest dirs of members who have not been connected for 7 days (counted from the end of their last connection: a disconnect updates `lastSeenAt` as a connect does) are removed by the sessions module (at daemon start and daily), and on `smurg stop`. | A disconnect is indistinguishable from a network blip; deleting the login on every blip would break R4's 「客戶端斷線時 session 繼續在主人端執行」. The retention limit bounds how long a forgotten credential stays on the host (SPEC §11 host → guest risk). |
| D-10 | R1: every refused request 「拒絕並記錄」 | Every refusal is recorded, but a flood is recorded in bounded form: beyond 120 refused requests per actor per minute the audit log writes one "rate limited" entry and one summary with the count instead of one line per request, and a connection with more than 60 refusals in a minute is closed. | Without a bound, the lowest role (a viewer) could grow `audit.jsonl` on the host's disk without limit and push real entries out of every page (security review F5). The fact of every refusal and its count stay in the log. |
| D-11 | D3: the host's session is not sandboxed | The host's agent is still refused (PreToolUse deny) an Edit / Write / NotebookEdit of a file outside the shared folder; Bash is unaffected. | The lock hook can grant locks only inside the session's root; allowing unlocked edits elsewhere would also let a main-root agent edit a worktree's files around their locks. The owner chose to keep this fail-closed behaviour (the alternative considered: outside every root → no decision, host sessions only). The deny reason tells the agent's owner that the file is outside the shared folder. |
| D-12 **(implemented 2026-09-29 as recommended by the project lead; switchable; the owner's confirmation of the default is pending; review SPEC-04)** | R4 登入引導 and §13 「Claude Code 在遠端 PTY 中的登入流程（顯示網址、貼上代碼）能順利完成」; §9 「有 Claude 訂閱的組員：用跟平常一樣的 Claude Code 操作方式」 | A guest logs in with their Claude subscription through a **dedicated login process** (session kind `login`, §7.6): the daemon itself runs the fixed `claude --setting-sources project --settings <inline> auth login --claudeai` in a PTY, in that guest's sandbox (same guest dir as `HOME` / `CLAUDE_CONFIG_DIR`, same environment allow-list, `BROWSER` a no-op, hardened profile: the credential lands in `<guest>/cfg/.credentials.json`), in sandbox mode `login` (the guest dir only, nothing of the share). Its one extra right: listen and accept TCP on "localhost" (Seatbelt; no UDP), no outbound connection; because Seatbelt's `localhost` admits every local address, it also may exec only `/bin/bash`, claude, the no-op `BROWSER` and `/usr/bin/security`. Only the guest themself starts it (one at a time), nobody else sees or attaches to it, its output is never logged; start and outcome (exit code) are audited; it ends when the command exits or after 10 minutes. The URL is shown and the guest pastes the code; afterwards the guest's running agent sessions report logged-in and a running Claude Code uses the new credential from its next prompt. The guest's AGENT sessions still cannot listen at all. Switch: `config.sessions.guestSubscriptionLogin` (default true; false ⇒ refused with 「…客人請…使用自己的 API key 登入」), published as `PublicSettings.guestSubscriptionLogin`. The host's own sessions are unaffected. | Verified with the real claude 2.1.220 and 2.1.283 in the real guest sandbox (mock API, no account, never completed): the login URL and 「Paste code here if prompted >」 appear and the callback server listens on 127.0.0.1 only; a probe inside the login process cannot connect to a TCP server on 127.0.0.1, read the fake host home or the share, write outside the guest dir or start another program; an ordinary guest session still cannot listen; a planted `env.BROWSER` in the guest's settings does not run (it did before `--setting-sources project`: `claude auth login` applies the user settings `env` and runs `$BROWSER`). srt's `allowLocalBinding` was rejected: workspace-wide, and it grants bind / accept on every address and connect to every localhost port. Independent security check (finish-gate, 2026-09-29): the login profile compared rule by rule with the agent session profile of the same guest; three findings fixed — srt's own bind / inbound rules on its proxy port let EVERY guest process (agent sessions too) listen on the LAN address at that port (now removed from every guest profile), the login listen covered UDP (now TCP only), and the login could read ancestor memory files of the share that an agent session cannot (now denied); attacks from inside the real sandbox (a host service on 127.0.0.1, the daemon's control socket, the fake host home, writes outside the guest dir) and through the daemon (another member's guest dir, attach / input / resize by others, request fields, a second login, the time limit) all fail. Residual: while it runs (≤ 10 min) the login process could listen on the LAN interfaces too, if a program other than Claude Code could run in it (the exec allow-list and the switched-off guest settings are what prevent that). Tests: `daemon/sessions/login.test.ts` (incl. › attacks on the login process), `login.real.test.ts`, `login-profile.real.test.ts`, `claude-login-pickup.test.ts`, `claude-real.test.ts` › SPEC §13 item 5 (the agent session itself still fails), `daemon/sandbox/login-policy.real.test.ts`, `network-listen.real.test.ts`, `harden.test.ts`, `policy.test.ts`. |
| D-13 **(implemented 2026-09-29 as recommended by the project lead; switchable; the owner's confirmation of the default is pending; review SPEC-01)** | R8 acceptance 「每一次 agent 的修改都出現在活動動態中，標示是哪個 agent、屬於誰」; R11 「操作紀錄涵蓋…agent 修改」 | Edit / Write / MultiEdit / NotebookEdit changes (PostToolUse) and FileChanged-hook reports are attributed to the agent as before. NEW: **non-blocking Bash attribution.** A separate Bash ACTIVITY hook (`smurg hook bash-activity`, PreToolUse / PostToolUse / PostToolUseFailure of `Bash`, §7.7) only tells the daemon when a session starts and finishes a shell command; it never takes a lock, never decides, and fails OPEN (daemon unreachable ⇒ the command runs, nothing attributed), while the lock hook of the edit tools still fails closed. A disk change that nobody claimed (no agent lock, no Post echo, no announced writer) and that falls inside the Bash window of EXACTLY ONE session that could have written it (an unsandboxed host session anywhere, a sandboxed one only in its own root), with 3 s of grace after the command ended (watcher latency), and whose root contains the file, is that agent's: `agent.edit`, 「Claude（owner）透過 shell 指令修改了…」, marked `via: 'bash'` in the feed entry (§5.4) and
the audit entry; two or more such windows, none, or a writer of another root: 「外部程式」 as before — and then not even the worktree rule below names anyone. In a worktree without a Bash window an unannounced change is still attributed to the one agent session running there, else to the worktree's owner. The decision is announced as `agent.tool.post` (tool `Bash`, the file), so the file tree badge and the R8 fallback's conflict record (whose source) follow the same rule; the fallback itself (human text kept, conflict record) is unchanged. Switch: `config.activity.attributeBashEdits` (default true; false ⇒ the Bash hooks are not registered and Bash events are ignored). | A session can forge Bash windows with its own token: they only ever attribute changes inside that session's own root, and only to that session (an agent can claim unannounced changes of its own root, never frame another agent or a person); forged windows are paired by `tool_use_id`, capped (8 open, 10 min each) and rate-limited (240 / min, burst 60). Known limits: a change the host's own tools (an editor outside smurg, a terminal) make during an agent's Bash window in the same root is attributed to that agent; for 5 s after a person's autosave the file module attributes any change of that file to that person (not part of this rule). Cost: ~52 ms per hook invocation with the dev entry (two per Bash call). Tests: `daemon/hooks/hook-cli.test.ts` (Bash hook exits 0 with no output within its deadline in every error case while the Edit hook denies), `hook-server.test.ts`, `settings-writer.test.ts`, `claude-bash.test.ts` (real claude: a scripted Bash edit in the activity feed as the agent), `daemon/locks/activity.test.ts`, `bash-attribution.real-modules.test.ts` (the conflict record's source). |
| D-14 **(owner decision 2026-10-01, `docs/OPEN-QUESTIONS.md` Q2)** | R9 「開 agent session 時可以選擇「共享主工作區」或「我的 worktree」」 | On a **Linux** host, guests' (sandboxed) agent and terminal sessions in the MAIN workspace are **off by default**: guests get worktree mode only, which needs the share to be a git repository (on a share that is not git, guests have no sessions until the host opens the main workspace). The host opens it with `smurg host --allow-main-workspace-guests` (`config.sessions.guestMainWorkspace`); the start summary then lists the Linux residual limits (§12 "Linux, in more detail"). macOS is unchanged: open by default (`--no-main-workspace-guests` closes it on either platform). The daemon refuses a guest's main-mode `session.create` whatever a client sends (`forbidden` / `main-workspace-off`, a zh-TW message that points to worktree mode and to the host's flag, audited as a denied `session.create`) and publishes the switch (`PublicSettings.guestMainWorkspace`), so the web's new-session dialog does not offer 「共享主工作區」 to a guest while it is off, preselects 「我的 worktree」 and says why. A guest's login process (§11 D-12, mode `main` but nothing of the share) and the host's own sessions are not affected. | bubblewrap protects host-only names with mounts of concrete paths and cannot deny by pattern (macOS Seatbelt can): in the main workspace a guest can create NEW nested `.claude/settings.json`, `.mcp.json` or `.git` that the host's unsandboxed tools may run later, and the host's own edits of protected entries during a guest session reach the guest until the guard ends it (§7.6 "Linux, protected entries while a guest runs", §12; reviews RV-1, RV-2, attack F1). In worktree mode none of this reaches the host's project: the guest never sees the main workspace (R9.1), and what it writes there arrives only through a merge the host reviews, which refuses host-only paths (`host-only-paths`). The cost: on Linux a share that is not git has no guest sessions by default, and R9's choice is narrowed to the worktree unless the host opens the main workspace. Tests: `daemon/test/workspace.test.ts` › resolveConfig (the default per platform), `settings.test.ts` (published, not a console setting), `sessions/launch.test.ts` › guests in the main workspace, `sessions/login.test.ts` (the login process is unaffected), `cli/test/host-relay.test.ts` (flags, summary), `args-state.test.ts`, `tests/e2e/test/r9.main-workspace.test.ts`, the web's new-session dialog tests and `apps/web/e2e/smoke/main-workspace.smoke.test.ts`. |

## 12. Known limits of the prototype

- **Linux** was developed on macOS arm64. Since 2026-10-01 the whole gate runs on Linux and is green: in an Ubuntu
  24.04 arm64 VM and on CI's ubuntu-24.04 x64 (`.github/workflows/ci.yml`; counts in `docs/ACCEPTANCE.md` "Linux
  verification"). The guest sandbox (bubblewrap under Ubuntu 24.04's AppArmor user-namespace restriction, with the
  `smurg-bwrap` profile) is verified there: R5 and R9 at the sandbox level, guest terminals, the login process with a
  stand-in `claude`, the hook self-test (§7.6, "Linux, in more detail" below). Not run on Linux: a real `claude`,
  keep-awake through `systemd-inhibit` from a local desktop session (from an SSH session polkit refuses it on Ubuntu:
  verified, and `smurg host` says so), the installer on a fresh machine (`docs/OPEN-QUESTIONS.md` Q2).
- **Real accounts are not exercised by the tests.** Claude login inside a guest sandbox, real Google / GitHub OAuth
  and a real Cloudflare deployment need credentials. They were first exercised by hand on 2026-10-01: the shared relay
  deployed to Cloudflare (`docs/RELEASING.md` §2, now at `https://app.smurg.ai`) and the owner's Google login in the
  browser there; the CLI login and a second account joining are still to do. GitHub login is not configured on the
  shared relay and stays untested against the real provider.
- **Browser device keys are not encrypted at rest** (see §4.2).
- The network allow-list is global to the daemon, not per guest (srt limitation).
- Zip downloads are not resumable; archives that need ZIP64 for sizes/offsets cannot be opened by Apple's `ditto`
  (files ≥ 4 GiB are placed last and flagged).

Left after the review round of 2026-09-29 (owner questions with options and recommendations: `docs/OPEN-QUESTIONS.md`):

- **Releases** (review CLI-01, SPEC R1 「一行指令安裝」; decided 2026-09-30, `docs/OPEN-QUESTIONS.md` Q1,
  `docs/RELEASING.md`): GitHub Releases, built by GitHub Actions on a tag `v*` for macOS arm64 / x64 and Linux x64 /
  arm64, each on its own runner (`macos-15`, `macos-15-intel`, `ubuntu-24.04`, `ubuntu-24.04-arm`). The workflows
  cannot run locally; until the first tag only macOS arm64 was ever built, and R1.1 (fresh machine to invite link in 3 minutes) is measured by hand after it. macOS
  executables carry an ad-hoc signature only (no Developer ID, not notarized); the installer relies on `curl` setting no
  quarantine attribute and removes one after the sha256 check. `SHA256SUMS` is not signed,
  so it does not protect against a compromised GitHub account or workflow.
- **The shared relay** (Cloudflare Workers free plan, the custom domain `https://app.smurg.ai` (workers.dev until
  2026-10-01), Google login only; the CLI's default): the free
  plan's daily limits (100,000 requests, 100,000 Durable Object rows written, … `docs/RELEASING.md` §8) are shared by
  everyone who uses it; when one is used up, connections and messages of that kind fail for every workspace until
  00:00 UTC. An estimate from the code (not measured on Cloudflare): the WorkspaceDO alarm alone costs ~720 requests and
  ~720 rows written per workspace-hour while anyone is connected, and a busy terminal watched by several members costs
  far more. The free plan's 10 ms CPU limit per request was not measured against the login routes. Every deploy
  disconnects every socket (clients reconnect). The operator of the shared relay (and Cloudflare) can see what D-5 says
  a relay sees, for every workspace on it; hosts who cannot accept that deploy their own relay (`--relay`). Its web
  app is one build for every host's daemon, and it decodes the daemon's messages with strict objects (§5), so it
  refuses a daemon newer than itself (a field the daemon added is an unknown key to it; the reverse works, additions
  are optional): the shared relay is redeployed from each release's commit before the release is published
  (`docs/RELEASING.md` §4 step 3), and a host running a build ahead of it (for example from `main`) cannot be joined
  through it until the next deploy.
- **Linux, in more detail** (reviews SPEC-05, CLI-09; verified 2026-10-01 on Ubuntu 24.04 arm64, kernel 6.8,
  bubblewrap 0.9.0, `docs/research/sandbox.md` "Linux, verified 2026-10-01"). The real-sandbox tests (R5, R9, the
  hook self-test, the login process, the network namespace, guest terminals: resize reaches the program as SIGWINCH
  and Ctrl-C interrupts the foreground program, not the session) run on Linux; the Seatbelt profile-text tests stay
  macOS-only. srt's `apply-seccomp` never runs (`allowAllUnixSockets` skips srt's seccomp filter), so it needs no
  AppArmor profile. The consequence (review attack F4): a guest has no seccomp filter at all (`Seccomp: 0`), i.e.
  every system call the kernel and its sysctls leave to an unprivileged user (io_uring, `keyctl`, `userfaultfd`,
  `perf_event_open`, `ptrace` of its own processes, …). The sandbox rests on namespaces, `--cap-drop ALL`,
  `--disable-userns` (no nested user namespace, the usual way into the kernel's privileged code) and the mounts, so a
  kernel privilege escalation through an unprivileged system call defeats it; keeping the host's kernel updated is
  part of hosting guests. A guest also reads its own `/proc/self/mountinfo` (review attack F3; measured): the
  host-side path of every mount of its sandbox and every mount point of the host system (`--ro-bind / /` is
  recursive: `/run/user/<uid>`, removable media under `/media/<user>`, …). Most of it a guest knows anyway (its `HOME`
  is `<stateDir>/guests/<workspace id>/<its own key>`, below the host home and the host's user name; its session's
  settings path is on Claude Code's command line); mountinfo adds the install paths of srt and `smurg` (on the VM
  `/home/<host user>/…/node_modules/.pnpm/@anthropic-ai+sandbox-runtime@0.0.77/…`), the names of srt's bridge sockets,
  and the host's own mounts. Contents stay as the policy says. bubblewrap cannot hide it cheaply: procfs makes the
  file per process (a mount over `/proc/self/mountinfo` would cover one process's file, and a guest cannot mount),
  srt binds every path at its own name (the share must keep its path), and no `/proc` at all breaks ordinary tools.
  macOS has no mount table of this kind. bubblewrap 0.8 or later is required for `--disable-userns` (older: refused
  with an upgrade hint; Ubuntu 22.04 ships 0.6.1, so guest sessions are refused there; Debian 12 and Ubuntu 24.04 ship
  0.8 / 0.9). **Guests in the main workspace are off by default on Linux** (owner decision 2026-10-01, §11 D-14):
  guests work in their own worktree (a git share) unless the host starts `smurg host --allow-main-workspace-guests`,
  whose start summary lists the first, third, fourth and fifth items below; the first and fourth (and the third for
  the share) arise only then. What bubblewrap cannot express, by design of a mount-based sandbox (macOS Seatbelt denies
  these by pattern):
  - a NEW host-only name below the top of the root (`sub/.claude/settings.json`, `sub/.mcp.json`, `sub/.git/config`)
    can be created by a guest; existing ones at any depth and every name at the top are protected while the host does
    not remove, rename or replace them (next item: the daemon then ends the guest's processes; a guest's new name
    other than `.git` ends them too, and the host is told the path: at once through the watcher, in a directory made
    in one burst with its parent, which inotify never watches, through the guard's walk within seconds (review GR-1),
    and once more after the guest's last process ended; never inside `node_modules`). Such a file can
    run code in the host's UNSANDBOXED tools opened in that subfolder (a Claude Code started there, git hooks or
    `core.fsmonitor` of a nested repository, a VS Code task). A worktree merge refuses such paths (`host-only-paths`)
    and `file.*` refuses them to guests, so this is a residual of main-workspace guest sessions. An EXISTING entry
    whose path holds a glob character (`app/[slug]/.claude`, a guest's `ev*il/.git`) or is not UTF-8 is not protected
    either (§7.6): the daemon names each such path in its log once. Below a directory whose name is not UTF-8 the
    host-private files are readable too (`.envrc`, `CLAUDE.local.md`: measured; srt cannot name them either).
    Guest-made entries count toward the walk's limit: a guest who makes more than 1000 host-only entries below the
    top of the share refuses every later guest session in the main workspace until the host removes them (fail
    closed on purpose: denying only some would let decoys unprotect the host's own nested repository; the log says
    why);
  - a read-only shared link in a guest's worktree (R9.2) can be removed or re-pointed by the guest (bubblewrap mounts
    on what a link points at, never on the link); the target stays read-only and the daemon refuses a re-pointed link
    (`shared-link-tampered`);
  - a Unix socket in a directory the guest can read (the share, its guest dir) is connectable (`allowUnixSockets` is
    ignored on Linux; the host session's socket directories are hidden instead, abstract sockets are cut off by the
    network namespace);
  - while a guest process runs, a protected entry the HOST replaces, removes or creates in that root is not covered by
    the guest's sandbox any more (§7.6 "Linux, protected entries while a guest runs"; reviews RV-1, RV-2): an atomic
    save of `.envrc` or `.mcp.json`, the host's own Claude Code answering 「don't ask again」 (it writes
    `.claude/settings.local.json`), `git switch` or `git clean -fd` taking `.claude/` or an empty placeholder, a
    `CLAUDE.local.md` or a nested `.envrc` made after the guest started. The daemon notices the change and ends every
    guest process of that root, and `smurg host` names the paths; until then (measured 50–110 ms, also behind a
    build's 20,000 files; `.git`, which the watcher ignores, within the 2 s check; in a directory made in one burst
    with its parent, which inotify never watches, within the walk's interval: 2 s, ten times the walk's own duration
    on a large tree; reviews GR-1, GR-3) the guest can read the new content (a secret in `.envrc`, an `env` block of
    `settings.local.json`) or write the name (plant `.claude/settings.json` hooks or a `.mcp.json` server that the
    host's unsandboxed tools run later). So: stop guest sessions before editing `.envrc`, `.mcp.json`, `.claude/` or
    `CLAUDE.local.md` in the share, and look at a path `smurg host` names. Not covered at all: inside `node_modules`
    (the watcher and the walk skip it; srt's read-deny globs do reach it), an ancestor's `CLAUDE.md`, a new nested
    `.git`. Without the file watcher (its native module missing) the 2 s check of the record, the walk and the next
    `wrap()` remain. An
    in-place edit of a read-denied file the walk does not record (inside a host-only directory: it does not enter them)
    ends the guests' processes although their mount held (fail closed);
  - while a guest process runs, the names that hold absent host-only names are visible in the host's project: empty
    directories `.claude` / `.git` / `.vscode` / `.idea` (the service's own, bound read-only) and srt's empty
    read-only files `.mcp.json` / `.envrc` (in a git share they are listed in `.git/info/exclude` while they exist, so
    the host's `git status`, `git add -A`, `git stash -u` and `git clean -fd` leave them alone; `git add -f`, `git clean
    -x` and `git stash -a` do not: they commit or remove them, which ends the guests; review GR-4). They are removed
    once no guest process runs, or, after a crash, at the next start before its first sandbox (review F6; an empty
    directory the host makes at one of those names between the crash and that start is taken for a leftover). A
    leftover empty `.git` is not taken for a repository: `workspace/share.ts` needs a `.git` directory with a `HEAD`
    file or a `HEAD` symlink into `refs/` (git's own rule; review RCR-4), or a `gitdir:` file, and writes
    `info/exclude` only into a real one.
  Decided by the owner on 2026-10-01 (`docs/OPEN-QUESTIONS.md` Q2, §11 D-14): a mount-based sandbox cannot do better,
  so main-workspace guest sessions are off by default on Linux, and a host who opens them is told these limits at the
  start (the guard of §7.6 still ends the session and names such a path while it runs, and names it once more after
  the session ended; `.git` and `node_modules` excepted). In worktree
  mode the second item and the fifth (inside the guest's own worktree) remain, and the third for the guest's own dir.
  The installer's Linux branch on a fresh machine is unverified; its AppArmor step decides by a bare bubblewrap run
  (the daemon's own probe), so a profile file that is there but not loaded is offered again (review F4). Run as root
  (`sudo sh install.sh`) the probe runs as the user sudo came from, else as `nobody` (`runuser`): root's own bubblewrap
  passes whether or not the profile is loaded, since the restriction applies to unprivileged users only (review RV-5,
  measured in the VM with a copy of bwrap the profile does not cover).
  Costs and leftovers of the Linux sandbox that are not fixed in this release (reviews RCR-7, RCR-2, F6):
  - every guest process start (and each `claude auth status` / logout helper of a guest) walks the session root
    outside `node_modules` for existing host-only names (~0.2 s per 50,000 directories, not blocking), and srt then
    expands smurg's three read-deny globs (`<root>/**/.claude/settings.local.json`, `**/CLAUDE.local.md`, `**/.envrc`)
    with a SYNCHRONOUS walk of the whole root, `node_modules` included, on each of its 2–3 wraps per start: measured
    0.2 s of blocked event loop per wrap on a pnpm project, ~1 s per 50,000 directories. Meanwhile other guests' hook
    round trips (5 s deadline), terminals and the network proxy wait: a departure from §0 rule 5 inside srt. Handing
    srt literal paths from smurg's own walk instead would have to reproduce srt's handling of symlinked and
    unlistable directories (not done);
  - a single request that misses its NFC name (a create, an upload's commit) still lists its directory once, so an
    upload of n new non-ASCII names into a folder of m entries costs n listings of m entries;
  - while guest processes run in a root, the guard (§7.6) costs one `lstat` per path of every watcher batch there and
    a listing of each directory that appeared (at most 10,000 listings per round), an `lstat` of every recorded entry
    every 2 s, a walk of the root every 2 s or ten times its own duration (the same walk as each `wrap()`: ~0.2 s per
    50,000 directories, not blocking; review GR-1), and one open descriptor per existing protected entry (at most about
    3,000 per root: the walk's limit of 1000 entries, a `settings.local.json` inside each nested `.claude`, at most 1000
    nested `CLAUDE.local.md`; review GR-15). A batch of tens of thousands of changed protected paths costs ~20 ms of
    event loop (review GR-2);
  - a daemon killed hard (SIGKILL, OOM) leaves srt's network bridge (`socat UNIX-LISTEN:/tmp/claude-http-*.sock`, ~3 MB,
    idle, reachable by the host user only, never by guests) and its sockets in `/tmp` until reboot; srt starts it
    without a parent-death signal and exposes no pid.
- **Resource limits** (review attack F2, 2026-10-01; owner question `docs/OPEN-QUESTIONS.md` Q13). A guest sandbox
  limits no memory, disk space, CPU time or file size, on either platform, and puts the guest in no cgroup of its own.
  A guest can therefore slow the host's machine down or exhaust its memory or the disk that holds the share and the
  state dir (the daemon's state writes then fail: "State written late" below). No fork bomb was run (shared machines):
  the limits were read with `ulimit` inside real guest sandboxes, and the task limit was checked with a few dozen
  `sleep`s.
  - Linux: the one limit is 4096 tasks (processes and threads) per sandbox, counted inside its own user namespace
    (§7.6). Without it a guest's fork bomb could take every process slot of the host user (RLIMIT_NPROC counts the
    real user, the daemon included: 31414 on the 8 GB test VM), after which the daemon can start no process, its `ps`
    for ending a session included. A guest with its 8 sessions (`SessionLimits.maxSessionsPerUser`) can still hold
    8 × 4096, more than that VM's 31414. Guest processes stay in the daemon's own cgroup (measured in the VM, a daemon
    started over SSH: `0::/user.slice/user-501.slice/session-2.scope`), so when memory runs out the kernel's OOM
    killer chooses among all of them, the daemon included. A kernel older than 5.14 counts tasks per user, so there
    the limit is left out (logged).
  - macOS: Seatbelt has no resource control. Inside a guest sandbox the host user's own limits apply (measured:
    `ulimit -u` 2666, which is `kern.maxprocperuid` and counts every process of the host user; memory, file size and
    CPU time unlimited), so a fork bomb in a guest session can take the host user's last process slot (the daemon
    and the host's own apps then start nothing) until the session ends. macOS counts processes per user with no namespace:
    a limit per sandbox does not exist there.
  - Not built (Q13): an address-space or file-size limit in the session prelude (Node / V8, the JVM and sanitizer
    builds reserve far more address space than they use, so a limit they survive does not stop an out-of-memory
    machine, and `RLIMIT_FSIZE` caps one file, not the disk); a cgroup per guest on Linux (`systemd-run --user
    --scope -p MemoryMax=… -p TasksMax=…` around bubblewrap: needs the host user's systemd instance with the memory
    controller delegated, as Ubuntu 24.04's `user@.service` does; not tried); on macOS a per-user `ulimit -u` below
    the host's limit that keeps a reserve of process slots for the daemon (how much a guest gets then depends on what
    else the host runs); a daemon-side watchdog that ends the guest session that is growing when memory or disk runs
    short.
- **Subscription login of guests** (D-12) and **Bash edits** (D-13): implemented 2026-09-29 as recommended by the
  project lead, both switchable, the owner's confirmation of the defaults is pending (§11). A real account's login was
  never completed in a test (URL shown, code never pasted); on Linux the login process has its own network namespace
  like every guest process (verified 2026-10-01: its listener is unreachable from the host). On
  macOS the login process's TCP listen is not limited to the loopback interface (Seatbelt's `localhost` admits every
  local address); the exec allow-list is what keeps any program but Claude Code from listening in it.
- **Attribution after an autosave** (files module): for 5 s after a person's autosave, any change of that file is
  attributed to that person (`EXPECT_CHANGE_TTL_MS`), so an agent's shell write in that window is shown as the
  person's and a conflict then names the person as the other side. Recognising the autosave's own echo by content hash
  (the docs module knows it) would remove this; not done (a change to the files and docs modules' event flow).
- **Guest agents in the main workspace can read `<share>/.git`** (on Linux only when the host opened the main
  workspace to guests, §11 D-14) (incl. `.git/config`) through the sandbox, because
  git needs it; guest people cannot (§5.2). They can also create symlinks in the share that point outside it: the
  daemon never follows them for anyone and a worktree merge refuses them, but the host's own unsandboxed tools could
  (review SEC-D-04). Both are owner questions.
- **Relay sessions** are stateless 7-day tokens and cannot be revoked before they expire (review SEC-E-03 residual).
  There is no device-code login for a host on a headless machine (the `ssh -L` port-forward is the workaround; CLI-07).
- **The invite URL stays in the browser's history** (review SEC-E-05); guest links from `smurg host` are multi-use for
  7 days unless `--max-uses` / `--expires` say otherwise.
- **Backpressure** (review REL-06 remainder): the hub has no priority queue in front of `ws.send` (a reply or heartbeat
  can wait behind up to 1 MiB of one viewer's terminal output, ≈ 0.9 s at 1 MiB/s); the relay's Durable Objects apply no
  backpressure toward a slow browser; exec.output queued for a disconnected channel is bounded only by the channel's
  outbox limits. The first attach of a very large colourful scrollback still blocks the daemon for ~360 ms (REL-12; no
  worker thread).
- **Requests with an unknown outcome** (review REL-03): a request that timed out is never replayed, but there are no
  idempotency keys, so the person's own retry can repeat an action the daemon did carry out.
- **Clocks** (review REL-04): the relay link and the lock manager use the monotonic clock; the hub, the channel server
  and the rate limits still use the wall clock, and after a backward step audit `at` stays strictly increasing (entries
  can look up to the step size in the future; owner question).
- **State written late** (review REL-14): a change made while the disk refuses writes is in force and retried, but lost
  if the daemon stops or crashes before the disk takes it (`STATE NOT SAVED` in the log, a warning on the host terminal).
- **Documents** (reviews REL-01, REL-07): an open document does not follow a rename on disk (the web tab does, from the
  activity summary); text typed while the host was down is merged back only when the host's text did not change
  meanwhile (otherwise it is offered back); this was tested with the web's in-test document room, not a real daemon
  restart.
- **Share lock** (review CLI-05): a descendant folder already hosted by a daemon of another state dir is not detected.
- **Worktrees** (review SPEC-03): there is no operation to bring the main workspace's changes into a worktree; a
  conflicting merge is resolved by the host in their own terminal (`git merge refs/smurg/merge/<id>`) or rejected.
- **Hook reachability** (review SEC-D-05): a guest agent is refused when `smurg hook` cannot be exposed in its sandbox,
  and (since 2026-09-29) when the real hook, run inside that session's own sandbox with a probe event, does not bring
  back the daemon's answer (§7.6). A host's (unsandboxed) agent runs no such self-test.
- **Keep-awake** is reported active once the inhibitor has run for 250 ms; one that ends at once is reported with its
  reason (`the inhibitor was refused` when its stderr says it was refused: `systemd-inhibit` from an SSH session, where
  polkit's `org.freedesktop.login1.inhibit-block-sleep` is `allow_any=no` on Ubuntu, verified there only; any other
  polkit refusal, a site rule for a local session included, gets the same text, which says polkit and gives SSH on
  Ubuntu as the example, review RV-6; its first stderr line goes to the log). A later loss is printed within 2 s
  (CLI-13).
- **Native file watcher** (macOS, @parcel/watcher 2.6.0; 2026-09-29, §7.5): the daemon no longer makes overlapping or
  failing native calls, but three races are inside the native module and cannot be closed from JS: FSEvents stops the
  stream of a root that is deleted or moved away on its own thread while an unsubscribe of that root may be running
  (reachable now only by an outside deletion in the same millisecond as the daemon's own unsubscribe: worktree removal,
  `smurg stop`); an event that arrives while a subscribe is still starting dereferences a null tree (`startStream` sets
  it after `FSEventStreamStart`); an unsubscribe while the FSEvents thread is inside the callback. Measured with stress
  children under load: every flow the daemon performs itself (worktree removal, REL-10 move and return, roots that
  vanish, stop and exit) 0 crashes in 271 runs; an outside rename issued in the same tick as the unsubscribe 9 crashes
  in 63 runs; subscribe / unsubscribe churn during continuous writes 2 in 120 runs (≈ 1 per 250k–500k native calls).
  Such a crash still ends the whole daemon and every session. Follow-up: a supervised child process that owns the
  native watcher (a crash then costs a watcher restart and a re-list), or a patched @parcel/watcher.
- **Native file watcher on Linux** (@parcel/watcher 2.6.0, inotify; review GR-1, 2026-10-01): a new directory gets a
  watch only when the backend handles that directory's own creation, so the subdirectories made in the same burst
  (`mkdir -p`, a `git checkout`, an unpack) or moved in with their parent are never watched (measured: of a `mkdir -p
  one/two/three` and three files only `one` and its own file were reported; FSEvents reports all), and an inotify
  queue overflow is dropped without an error (319,496 of 320,001 creates reported, no error). Changes there reach
  neither the file tree's live updates nor the activity feed; a client sees them at its next listing. The guest
  sandbox does not rely on it (§7.6: the guard walks its roots). Follow-up: a patched @parcel/watcher that scans a
  newly watched directory (adding watches and reporting what it holds) and reports IN_Q_OVERFLOW as an error, or a
  periodic re-subscribe of a root that reported a new directory.
- **`smurg attach` output** assumes a UTF-8 terminal unless the locale says otherwise.
